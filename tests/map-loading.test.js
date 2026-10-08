"use strict";

// Integration tests execute the real browser scripts with small DOM/Leaflet
// stand-ins. No browser, CDN, geocoder or other network request is made.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = "https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11";
const MANIFEST = "data/official/manifest.json";
const BASELINE = "data/official/baseline.geojson";
const FUTURE = "data/official/future_2100.geojson";
const clone = (value) => structuredClone(value);

function sourceManifest() {
  return {
    schema_version: 1,
    source_url: SOURCE,
    publisher: "Test publisher",
    retrieved_at_utc: "2026-10-08T00:00:00Z",
    datasets: [
      { id: "baseline", file: BASELINE, modelling_scenario: "Existing Condition", study_date: "2020-08-13", feature_count: 1, object_ids: [100], label: "Official baseline (2020 study)" },
      { id: "future_2100", file: FUTURE, modelling_scenario: "Yr 2100, RCP 8.5", study_date: "2017-08-31", feature_count: 3, object_ids: [101, 102, 103], label: "Official 2100 (2017 study)" },
    ].map((entry) => ({
      ...entry,
      study_name: "ELIZABETH ST DRAIN (CITY)",
      aep: "1PCT",
      synthetic: false,
      source_url: SOURCE,
      records_url: `${SOURCE}/query?where=OBJECTID%3D${entry.object_ids[0]}`,
      upstream_limits: ["Test study boundary"],
    })),
  };
}

function extent(metadata) {
  return {
    type: "FeatureCollection",
    features: metadata.object_ids.map((OBJECTID) => ({
      type: "Feature",
      properties: {
        OBJECTID,
        STUDY_NAME: metadata.study_name,
        FLOOD_EVENT: metadata.aep,
        MODELLING_SCENARIO: metadata.modelling_scenario,
        STUDY_DATE: Date.parse(`${metadata.study_date}T00:00:00Z`),
      },
      geometry: {
        type: "Polygon",
        coordinates: [[[144.96, -37.81], [144.97, -37.81], [144.97, -37.80], [144.96, -37.81]]],
      },
    })),
  };
}

function ok(body) { return { ok: true, status: 200, json: async () => clone(body) }; }
function httpError(status = 503) { return { ok: false, status, json: async () => ({}) }; }

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.hidden = false;
    this.value = "";
    this.events = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    };
    this._text = "";
  }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(value) { this.textContent = value; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener(type, callback) { this.events.set(type, callback); }
  dispatch(type, event = {}) { return this.events.get(type)?.({ preventDefault() {}, ...event }); }
}

function harness(overrides = {}) {
  const manifest = sourceManifest();
  const smallLayer = extent(manifest.datasets[0]);
  const routes = new Map([
    [MANIFEST, () => ok(manifest)],
    [BASELINE, () => ok(extent(manifest.datasets[0]))],
    [FUTURE, () => ok(extent(manifest.datasets[1]))],
    ["data/catchment.json", () => ok(smallLayer)],
    ["data/flood_extent_2100.json", () => ok(smallLayer)],
    ["data/flood_extent_2010.json", () => ok(smallLayer)],
    ["data/flood_stories.json", () => ok([])],
    ...Object.entries(overrides),
  ]);
  const requests = [];
  const errors = [];
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  element("map-load-warning").hidden = true;
  element("retry-official-data").hidden = true;
  const map = {
    layers: new Set(), panes: new Map(), events: new Map(), views: [],
    setView(center, zoom) { this.views.push({ center: Array.from(center), zoom }); return this; },
    fitBounds(bounds) { this.bounds = bounds; return this; },
    hasLayer(layer) { return this.layers.has(layer); },
    removeLayer(layer) { this.layers.delete(layer); return this; },
    createPane(name) { const pane = { style: {} }; this.panes.set(name, pane); return pane; },
    getPane(name) { return this.panes.get(name); },
    on(names, callback) { names.split(" ").forEach((name) => this.events.set(name, callback)); return this; },
    fire(name) { this.events.get(name)?.(); },
  };
  const control = {
    overlays: [],
    addTo() { return this; },
    addOverlay(layer, name) { this.overlays.push({ layer, name }); return this; },
  };
  const createdGeoJSON = [];
  const bounds = { getWest: () => 144.95, getEast: () => 144.98, getNorth: () => -37.79, getSouth: () => -37.82 };
  function layer(kind, data) {
    return {
      kind, data, events: new Map(),
      addTo(target) { target.layers.add(this); return this; },
      addLayer(child) { (this.children ||= []).push(child); return this; },
      bindPopup(content) { this.popup = content; return this; },
      openPopup() { return this; },
      getBounds() { return bounds; },
      on(name, callback) { this.events.set(name, callback); return this; },
    };
  }
  const L = {
    map: () => map,
    tileLayer: () => layer("base"),
    control: { layers: () => control },
    geoJSON(data, options) {
      const result = layer("geojson", data);
      result.options = options;
      createdGeoJSON.push(result);
      data.features.forEach((feature) => options.onEachFeature?.(feature, layer("feature", feature)));
      return result;
    },
    divIcon: (options) => options,
    marker: (position) => layer("marker", position),
    markerClusterGroup: () => layer("stories"),
  };
  const context = vm.createContext({
    L,
    URLSearchParams,
    document: {
      getElementById: element,
      createElement: (tag) => new Element(tag),
      createTextNode: (text) => { const node = new Element("#text"); node.textContent = text; return node; },
    },
    console: { error: (...args) => errors.push(args), log() {} },
    fetch: async (url) => {
      requests.push(url);
      if (!routes.has(url)) throw new Error(`Unexpected stubbed request: ${url}`);
      return routes.get(url)();
    },
  });
  for (const script of ["js/flood-data.js", "js/map.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, script), "utf8"), context, { filename: script });
  }
  return {
    map, control, routes, requests, errors, element, createdGeoJSON, manifest,
    evaluate: (expression) => vm.runInContext(expression, context),
    settle: () => new Promise(setImmediate),
    retry: () => element("retry-official-data").dispatch("click"),
    official(id) { return vm.runInContext(`officialLayers.get(${JSON.stringify(id)})`, context); },
    state(id) { return vm.runInContext(`officialStates.get(${JSON.stringify(id)})`, context); },
    countRequests(url) { return requests.filter((request) => request === url).length; },
  };
}

test("startup shows loading, then only the official baseline is enabled by default", async () => {
  const h = harness();
  assert.match(h.element("official-status").textContent, /loading/);
  assert.equal(h.element("retry-official-data").hidden, true);
  await h.settle();
  assert.equal(h.state("baseline"), "loaded");
  assert.equal(h.state("future_2100"), "loaded");
  assert.equal(h.map.hasLayer(h.official("baseline")), true);
  assert.equal(h.map.hasLayer(h.official("future_2100")), false);
  for (const entry of h.control.overlays.filter(({ name }) => /Planning boundaries|Synthetic demo/.test(name))) {
    assert.equal(h.map.hasLayer(entry.layer), false);
  }
  assert.equal(h.control.overlays.filter(({ name }) => /Planning boundaries|Synthetic demo/.test(name)).length, 2);
  assert.equal(h.requests.includes("data/flood_extent_current.json"), false);
  assert.match(h.element("official-status").textContent, /Baseline \(blue fill\): loaded · shown/);
  assert.match(h.element("official-status").textContent, /2100 scenario \(orange outline\): loaded · hidden/);
  assert.equal(h.errors.length, 0);
});

test("a failed baseline does not display data or prevent the future layer loading", async () => {
  const h = harness({ [BASELINE]: () => httpError(404) });
  await h.settle();
  assert.equal(h.official("baseline"), undefined);
  assert.equal(h.state("baseline"), "failed");
  assert.equal(h.state("future_2100"), "loaded");
  assert.equal(h.map.hasLayer(h.official("future_2100")), false);
  assert.equal(h.element("retry-official-data").hidden, false);
  assert.match(h.element("official-status").textContent, /not evidence of no flooding/);
});

test("future HTTP failure and retry preserve the loaded baseline without duplicate controls", async () => {
  const h = harness({ [FUTURE]: () => httpError() });
  await h.settle();
  const baseline = h.official("baseline");
  assert.equal(h.map.hasLayer(baseline), true);
  assert.equal(h.state("future_2100"), "failed");
  h.routes.set(FUTURE, () => ok(extent(h.manifest.datasets[1])));
  await h.retry();
  assert.strictEqual(h.official("baseline"), baseline);
  assert.equal(h.state("future_2100"), "loaded");
  assert.equal(h.map.hasLayer(h.official("future_2100")), false);
  assert.equal(h.element("retry-official-data").hidden, true);
  assert.equal(h.countRequests(BASELINE), 1);
  assert.equal(h.countRequests(FUTURE), 2);
  assert.equal(h.control.overlays.filter(({ name }) => name === h.manifest.datasets[0].label).length, 1);
  assert.equal(h.control.overlays.filter(({ name }) => name === h.manifest.datasets[1].label).length, 1);
  await h.evaluate("loadOfficialData()");
  assert.equal(h.countRequests(BASELINE), 1);
  assert.equal(h.countRequests(FUTURE), 2);
});

test("manifest HTTP failure prevents official requests and recovers on retry", async () => {
  const h = harness({ [MANIFEST]: () => httpError() });
  await h.settle();
  assert.equal(h.official("baseline"), undefined);
  assert.equal(h.official("future_2100"), undefined);
  assert.equal(h.state("baseline"), "failed");
  assert.equal(h.state("future_2100"), "failed");
  assert.equal(h.countRequests(BASELINE), 0);
  assert.equal(h.countRequests(FUTURE), 0);
  assert.equal(h.element("retry-official-data").hidden, false);
  h.routes.set(MANIFEST, () => ok(h.manifest));
  await h.retry();
  assert.equal(h.state("baseline"), "loaded");
  assert.equal(h.state("future_2100"), "loaded");
  assert.equal(h.countRequests(BASELINE), 1);
  assert.equal(h.countRequests(FUTURE), 1);
});

test("a manifest from another source is not used to request or display official layers", async () => {
  const manifest = sourceManifest();
  manifest.source_url = "https://example.test/unverified";
  const h = harness({ [MANIFEST]: () => ok(manifest) });
  await h.settle();
  assert.equal(h.countRequests(BASELINE), 0);
  assert.equal(h.countRequests(FUTURE), 0);
  assert.equal(h.evaluate("officialLayers.size"), 0);
  assert.equal(h.state("baseline"), "failed");
});

for (const [description, mutate] of [
  ["another scenario", (data) => { data.features[0].properties.MODELLING_SCENARIO = "Existing Condition"; }],
  ["another study", (data) => { data.features[0].properties.STUDY_NAME = "UNRELATED CATCHMENT"; }],
  ["truncated features", (data) => { data.exceededTransferLimit = true; }],
  ["missing geometry", (data) => { data.features[0].geometry = null; }],
]) {
  test(`future data with ${description} is rejected before reaching Leaflet`, async () => {
    const badData = extent(sourceManifest().datasets[1]);
    mutate(badData);
    const h = harness({ [FUTURE]: () => ok(badData) });
    await h.settle();
    assert.equal(h.state("future_2100"), "failed");
    assert.equal(h.official("future_2100"), undefined);
    assert.equal(h.createdGeoJSON.some(({ options }) => options.pane === "officialFuture"), false);
    assert.equal(h.state("baseline"), "loaded");
  });
}

test("a malformed JSON snapshot fails visibly rather than appearing as an empty valid layer", async () => {
  const h = harness({ [BASELINE]: () => ({ ok: true, json: async () => { throw new SyntaxError("Bad JSON"); } }) });
  await h.settle();
  assert.equal(h.state("baseline"), "failed");
  assert.equal(h.official("baseline"), undefined);
  assert.match(h.element("official-status").textContent, /Baseline \(blue fill\): failed to load/);
});

test("overlapping retries while loading do not create duplicate requests or layers", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = harness({ [MANIFEST]: () => pending });
  await h.retry();
  await h.retry();
  assert.equal(h.countRequests(MANIFEST), 1);
  release(ok(h.manifest));
  await h.settle();
  assert.equal(h.countRequests(BASELINE), 1);
  assert.equal(h.countRequests(FUTURE), 1);
  assert.equal(h.evaluate("officialLayers.size"), 2);
});

test("official shown/hidden status follows layer control events", async () => {
  const h = harness();
  await h.settle();
  h.official("future_2100").addTo(h.map);
  h.map.fire("overlayadd");
  assert.match(h.element("official-status").textContent, /2100 scenario \(orange outline\): loaded · shown/);
  h.map.removeLayer(h.official("baseline"));
  h.map.fire("overlayremove");
  assert.match(h.element("official-status").textContent, /Baseline \(blue fill\): loaded · hidden/);
});

test("catchment failure retains a fallback map view and does not hide official data", async () => {
  const h = harness({ "data/catchment.json": () => httpError() });
  await h.settle();
  assert.deepEqual(h.map.views[0], { center: [-37.811, 144.962], zoom: 15 });
  assert.equal(h.map.bounds, undefined);
  assert.equal(h.state("baseline"), "loaded");
  assert.equal(h.element("map-load-warning").hidden, false);
  assert.match(h.element("map-load-warning").textContent, /Elizabeth Street catchment/);
  assert.match(h.element("map-load-warning").textContent, /Missing data does not mean no flooding/);
});

test("historic-story failure is separate from successful official-layer loading", async () => {
  const h = harness({ "data/flood_stories.json": () => httpError() });
  await h.settle();
  assert.equal(h.state("baseline"), "loaded");
  assert.equal(h.state("future_2100"), "loaded");
  assert.match(h.element("map-load-warning").textContent, /Historic flood stories/);
});

test("source panel retains each study date, scenario and local snapshot date", async () => {
  const h = harness();
  await h.settle();
  const content = h.element("dataset-sources").textContent;
  for (const expected of ["2020-08-13", "2017-08-31", "Existing Condition", "Yr 2100, RCP 8.5", "2026-10-08", "Not automatically updated"]) {
    assert.ok(content.includes(expected), `Expected source explanation: ${expected}`);
  }
});
