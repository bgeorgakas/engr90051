"use strict";

// Run with: node --test tests/flood-data.test.js
// These fixtures exercise the data contract; they are not real flood extents.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fetchJSON, validateManifest, validateExtent, SOURCE } = require("../js/flood-data.js");

const STUDY = "ELIZABETH ST DRAIN (CITY)";
const repoRoot = path.resolve(__dirname, "..");

function dataset(id = "baseline") {
  const future = id === "future_2100";
  return {
    id,
    file: `data/official/${id}.geojson`,
    study_name: STUDY,
    aep: "1PCT",
    synthetic: false,
    modelling_scenario: future ? "Yr 2100, RCP 8.5" : "Existing Condition",
    study_date: future ? "2017-08-31" : "2020-08-13",
    feature_count: future ? 3 : 1,
    source_url: SOURCE,
    object_ids: future ? [101, 102, 103] : [100],
  };
}

function manifest() {
  return { schema_version: 1, source_url: SOURCE, datasets: [dataset(), dataset("future_2100")] };
}

function square(x = 144.96, y = -37.81, size = 0.001) {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

function extent(metadata = dataset()) {
  return {
    type: "FeatureCollection",
    features: metadata.object_ids.map((id) => ({
      type: "Feature",
      properties: {
        OBJECTID: id,
        STUDY_NAME: STUDY,
        FLOOD_EVENT: "1PCT",
        MODELLING_SCENARIO: metadata.modelling_scenario,
        STUDY_DATE: Date.parse(`${metadata.study_date}T00:00:00Z`),
      },
      geometry: { type: "Polygon", coordinates: [square()] },
    })),
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("manifest accepts the two exact official datasets without changing them", () => {
  const input = deepFreeze(manifest());
  assert.strictEqual(validateManifest(input), input);
});

for (const [name, mutate] of [
  ["schema", (m) => { m.schema_version = 2; }],
  ["source", (m) => { m.source_url = "https://example.test/another-layer"; }],
  ["missing dataset", (m) => { m.datasets.pop(); }],
  ["extra dataset", (m) => { m.datasets.push(dataset()); }],
  ["duplicate dataset ID", (m) => { m.datasets[1] = dataset(); }],
  ["unknown dataset ID", (m) => { m.datasets[0].id = "observed_2010"; }],
  ["wrong study", (m) => { m.datasets[0].study_name = "ELIZABETH ST M.D. (COBURG)"; }],
  ["wrong AEP", (m) => { m.datasets[0].aep = "5PCT"; }],
  ["synthetic data", (m) => { m.datasets[0].synthetic = true; }],
  ["wrong scenario", (m) => { m.datasets[0].modelling_scenario = "Current day"; }],
  ["wrong study date", (m) => { m.datasets[0].study_date = "2026-10-08"; }],
  ["wrong feature count", (m) => { m.datasets[0].feature_count = 2; }],
  ["different dataset source", (m) => { m.datasets[0].source_url += "/12"; }],
  ["path traversal", (m) => { m.datasets[0].file = "data/official/../../untrusted.geojson"; }],
  ["remote file", (m) => { m.datasets[0].file = "https://example.test/baseline.geojson"; }],
]) {
  test(`manifest rejects ${name}`, () => {
    const input = manifest();
    mutate(input);
    assert.throws(() => validateManifest(input));
  });
}

test("manifest rejects null and an absent datasets array", () => {
  assert.throws(() => validateManifest(null));
  assert.throws(() => validateManifest({ schema_version: 1, source_url: SOURCE }));
});

test("baseline and future snapshots pass their separate contracts", () => {
  for (const id of ["baseline", "future_2100"]) {
    const metadata = dataset(id);
    const input = deepFreeze(extent(metadata));
    assert.strictEqual(validateExtent(input, metadata), input);
  }
});

test("validation preserves holes, tiny polygons, coordinate precision and every feature", () => {
  const metadata = dataset("future_2100");
  const input = extent(metadata);
  const outer = square(144.96, -37.81, 0.01);
  const hole = square(144.962, -37.808, 0.001).reverse();
  const tiny = square(144.963123456789, -37.807123456789, 0.0000001);
  input.features[0].geometry = { type: "MultiPolygon", coordinates: [[outer, hole], [tiny]] };
  const before = JSON.stringify(input);
  deepFreeze(input);
  const result = validateExtent(input, metadata);
  assert.strictEqual(result, input);
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.features.length, 3);
  assert.equal(result.features[0].geometry.coordinates.length, 2);
  assert.equal(result.features[0].geometry.coordinates[0].length, 2);
  assert.strictEqual(result.features[0].geometry.coordinates[1][0], tiny);
});

for (const [name, mutate] of [
  ["wrong collection type", (g) => { g.type = "Feature"; }],
  ["missing features", (g) => { delete g.features; }],
  ["wrong count", (g) => { g.features = []; }],
  ["wrong study", (g) => { g.features[0].properties.STUDY_NAME = "COBURG"; }],
  ["wrong AEP", (g) => { g.features[0].properties.FLOOD_EVENT = "5PCT"; }],
  ["wrong scenario", (g) => { g.features[0].properties.MODELLING_SCENARIO = "Yr 2100, RCP 8.5"; }],
  ["wrong date", (g) => { g.features[0].properties.STUDY_DATE = Date.parse("2017-08-31"); }],
  ["string timestamp", (g) => { g.features[0].properties.STUDY_DATE = "2020-08-13"; }],
  ["non-finite timestamp", (g) => { g.features[0].properties.STUDY_DATE = NaN; }],
  ["missing properties", (g) => { delete g.features[0].properties; }],
  ["missing object ID", (g) => { delete g.features[0].properties.OBJECTID; }],
  ["unlisted object ID", (g) => { g.features[0].properties.OBJECTID = 999; }],
  ["missing geometry", (g) => { delete g.features[0].geometry; }],
  ["line geometry", (g) => { g.features[0].geometry.type = "LineString"; }],
  ["empty polygon", (g) => { g.features[0].geometry.coordinates = []; }],
  ["empty multipolygon", (g) => { g.features[0].geometry = { type: "MultiPolygon", coordinates: [] }; }],
  ["empty polygon inside multipolygon", (g) => { g.features[0].geometry = { type: "MultiPolygon", coordinates: [[]] }; }],
  ["short ring", (g) => { g.features[0].geometry.coordinates[0].pop(); g.features[0].geometry.coordinates[0].pop(); }],
  ["open ring", (g) => { g.features[0].geometry.coordinates[0][4] = [144.97, -37.81]; }],
  ["projected coordinates", (g) => { g.features[0].geometry.coordinates[0][1] = [320000, 5810000]; }],
  ["out-of-range longitude", (g) => { g.features[0].geometry.coordinates[0][1][0] = 181; }],
  ["out-of-range latitude", (g) => { g.features[0].geometry.coordinates[0][1][1] = -91; }],
  ["string coordinate", (g) => { g.features[0].geometry.coordinates[0][1][0] = "144.96"; }],
  ["infinite coordinate", (g) => { g.features[0].geometry.coordinates[0][1][0] = Infinity; }],
  ["third coordinate", (g) => { g.features[0].geometry.coordinates[0][1].push(12); }],
  ["top-level transfer limit", (g) => { g.exceededTransferLimit = true; }],
  ["nested transfer limit", (g) => { g.properties = { exceededTransferLimit: true }; }],
]) {
  test(`extent rejects ${name}`, () => {
    const metadata = dataset();
    const input = extent(metadata);
    mutate(input);
    assert.throws(() => validateExtent(input, metadata));
  });
}

test("extent rejects duplicate source IDs even when the feature count is right", () => {
  const metadata = dataset("future_2100");
  const input = extent(metadata);
  input.features[2].properties.OBJECTID = input.features[0].properties.OBJECTID;
  assert.throws(() => validateExtent(input, metadata), /scenario metadata/);
});

test("extent rejects unknown dataset, absent expected IDs and wrong expected-ID count", () => {
  const input = extent();
  assert.throws(() => validateExtent(input, { ...dataset(), id: "unknown" }));
  assert.throws(() => validateExtent(input, { ...dataset(), object_ids: undefined }));
  assert.throws(() => validateExtent(input, { ...dataset(), object_ids: [100, 101] }));
});

test("extent rejects a duplicate expected-ID list that omits an actual source record", () => {
  const metadata = dataset("future_2100");
  const input = extent(metadata);
  metadata.object_ids = [101, 101, 102];
  assert.throws(() => validateExtent(input, metadata), /source records/);
});

test("an explicit false transfer-limit flag is accepted", () => {
  const metadata = dataset();
  const input = extent(metadata);
  input.exceededTransferLimit = false;
  input.properties = { exceededTransferLimit: false };
  assert.strictEqual(validateExtent(input, metadata), input);
});

test("fetchJSON returns parsed data and passes through the requested URL", async (t) => {
  const payload = { type: "FeatureCollection", features: [] };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return { ok: true, json: async () => payload };
  });
  assert.strictEqual(await fetchJSON("data/official/test.geojson"), payload);
  assert.deepEqual(requests, ["data/official/test.geojson"]);
});

test("fetchJSON rejects HTTP errors before attempting to parse a body", async (t) => {
  let parsed = false;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 503,
    json: async () => { parsed = true; return {}; },
  }));
  await assert.rejects(fetchJSON("test"), /HTTP 503/);
  assert.equal(parsed, false);
});

test("fetchJSON propagates malformed JSON errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => { throw new SyntaxError("Unexpected token"); },
  }));
  await assert.rejects(fetchJSON("test"), SyntaxError);
});

test("fetchJSON rejects a service-level error even after HTTP 200", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ error: { code: 400, message: "Invalid query" } }),
  }));
  await assert.rejects(fetchJSON("test"), /data service returned an error/);
});

test("fetchJSON propagates a network failure", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Network unavailable"); });
  await assert.rejects(fetchJSON("test"), /Network unavailable/);
});

test("checked-in official snapshots satisfy their manifest when present", (t) => {
  const candidates = ["manifest.json", "sources.json", "source-manifest.json"];
  const manifestPath = candidates.map((name) => path.join(repoRoot, "data", "official", name)).find(fs.existsSync);
  if (!manifestPath) {
    t.skip("Official snapshots have not been imported yet; synthetic contract tests still run.");
    return;
  }
  const metadata = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateManifest(metadata);
  for (const entry of metadata.datasets) {
    const input = JSON.parse(fs.readFileSync(path.join(repoRoot, entry.file), "utf8"));
    assert.strictEqual(validateExtent(input, entry), input);
  }
});
