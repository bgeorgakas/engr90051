"use strict";

// Synthetic fixtures exercise geometry semantics, not real-world flood risk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { prepareCollection, lookupPoint } = require("../js/address-lookup.js");

function square(x = 0, y = 0, size = 10) {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

function polygon(rings = [square()], properties = { OBJECTID: 17 }) {
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: rings } };
}

function collection(features = [polygon()]) {
  return { type: "FeatureCollection", features };
}

function check(point, prepared, relation, featureIds = relation === "outside" ? [] : [17]) {
  assert.deepEqual(lookupPoint(point, prepared), { relation, featureIds });
}

test("polygon interior, exterior and bounding-box-only exterior are distinguished", () => {
  const prepared = prepareCollection(collection([polygon([[[0, 0], [10, 0], [0, 10], [0, 0]]])]));
  check([2, 2], prepared, "inside");
  check([9, 9], prepared, "outside");
  check([20, 2], prepared, "outside");
});

test("all vertices, horizontal edges and vertical edges are boundaries", () => {
  const prepared = prepareCollection(collection());
  for (const point of [[0, 0], [10, 0], [10, 10], [0, 10], [5, 0], [5, 10], [0, 5], [10, 5]]) {
    check(point, prepared, "boundary");
  }
});

test("diagonal edges use only floating-point-scale rounding tolerance", () => {
  const x = 144.96;
  const y = -37.82;
  const ring = [[x, y], [x + 0.01, y + 0.01], [x, y + 0.01], [x, y]];
  const prepared = prepareCollection(collection([polygon([ring])]));
  check([x + 0.005, y + 0.005], prepared, "boundary");
  check([x + 0.005, y + 0.005 + 1e-9], prepared, "inside");
  check([x + 0.005, y + 0.005 - 1e-9], prepared, "outside");
});

test("points a tiny distance from a horizontal edge are not buffered", () => {
  const prepared = prepareCollection(collection([polygon([square(144.96, -37.82, 0.01)])]));
  check([144.965, -37.82 + 1e-10], prepared, "inside");
  check([144.965, -37.82 - 1e-10], prepared, "outside");
});

test("holes exclude their interiors but include their edges and vertices as boundaries", () => {
  const prepared = prepareCollection(collection([polygon([square(), square(2, 2, 2), square(6, 6, 2)])]));
  check([1, 1], prepared, "inside");
  check([3, 3], prepared, "outside");
  check([7, 7], prepared, "outside");
  check([3, 2], prepared, "boundary");
  check([2, 2], prepared, "boundary");
  check([8, 7], prepared, "boundary");
});

test("ring orientation does not change polygon or hole results", () => {
  for (const reverseOuter of [false, true]) {
    for (const reverseHole of [false, true]) {
      const outer = square();
      const hole = square(2, 2, 2);
      const prepared = prepareCollection(collection([polygon([
        reverseOuter ? outer.reverse() : outer,
        reverseHole ? hole.reverse() : hole,
      ])]));
      check([1, 1], prepared, "inside");
      check([3, 3], prepared, "outside");
      check([2, 3], prepared, "boundary");
    }
  }
});

test("ray intersections through vertices work for concave polygons", () => {
  const ring = [[0, 0], [8, 0], [8, 8], [4, 4], [0, 8], [0, 0]];
  const prepared = prepareCollection(collection([polygon([ring])]));
  check([2, 4], prepared, "inside");
  check([6, 4], prepared, "inside");
  check([4, 6], prepared, "outside");
  check([4, 4], prepared, "boundary");
});

test("MultiPolygon keeps separate components, holes, and a tiny component", () => {
  const feature = polygon();
  feature.geometry = { type: "MultiPolygon", coordinates: [
    [square(), square(2, 2, 2)],
    [square(20, 20, 1)],
    [square(144.963123456789, -37.807123456789, 1e-7)],
  ] };
  const prepared = prepareCollection(collection([feature]));
  check([1, 1], prepared, "inside");
  check([3, 3], prepared, "outside");
  check([20.5, 20.5], prepared, "inside");
  check([20, 20.5], prepared, "boundary");
  check([15, 15], prepared, "outside");
  check([144.963123506789, -37.807123406789], prepared, "inside");
});

test("interior takes priority over boundary across components of one MultiPolygon", () => {
  for (const coordinates of [[[square()], [square(5, 0, 10)]], [[square(5, 0, 10)], [square()]]]) {
    const feature = polygon();
    feature.geometry = { type: "MultiPolygon", coordinates };
    check([5, 5], prepareCollection(collection([feature])), "inside");
  }
});

test("overlapping feature union prefers interior and returns all matching IDs in order", () => {
  const features = [polygon([square()], { OBJECTID: "first" }), polygon([square(5, 0, 10)], { OBJECTID: "second" })];
  check([5, 5], prepareCollection(collection(features)), "inside", ["first", "second"]);
  check([5, 5], prepareCollection(collection(features.slice().reverse())), "inside", ["second", "first"]);
  check([7, 5], prepareCollection(collection(features)), "inside", ["first", "second"]);
  check([5, 0], prepareCollection(collection(features)), "boundary", ["first", "second"]);
});

test("a separate feature can fill a polygon hole", () => {
  const prepared = prepareCollection(collection([
    polygon([square(), square(2, 2, 4)], { OBJECTID: 1 }),
    polygon([square(2, 2, 4)], { OBJECTID: 2 }),
  ]));
  check([3, 3], prepared, "inside", [2]);
  check([2, 3], prepared, "boundary", [1, 2]);
});

test("IDs prefer OBJECTID including zero, then feature.id, then source index", () => {
  const features = [
    { ...polygon([square()], { OBJECTID: 0 }), id: "ignored" },
    { ...polygon([square()], {}), id: "feature-id" },
    polygon([square()], null),
    { ...polygon([square()], { OBJECTID: null }), id: 8 },
    polygon([square()], { OBJECTID: 0 }),
  ];
  check([5, 5], prepareCollection(collection(features)), "inside", [0, "feature-id", 2, 8]);
});

test("longitude is first and latitude second, including negative coordinates", () => {
  const prepared = prepareCollection(collection([polygon([square(144.96, -37.82, 0.01)])]));
  check([144.965, -37.815], prepared, "inside");
  assert.throws(() => lookupPoint([-37.815, 144.965], prepared), /longitude, latitude/);
  check([37.815, -37.815], prepared, "outside");
});

test("repeated adjacent vertices do not make unrelated points boundaries", () => {
  const ring = [[0, 0], [0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const prepared = prepareCollection(collection([polygon([ring])]));
  check([5, 5], prepared, "inside");
  check([0, 0], prepared, "boundary");
  check([-1, 0], prepared, "outside");
});

test("empty FeatureCollection is accepted and contains no matching features", () => {
  check([0, 0], prepareCollection(collection([])), "outside");
});

test("preparation does not mutate input and creates an independent opaque snapshot", () => {
  const input = collection();
  const before = JSON.stringify(input);
  const prepared = prepareCollection(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(prepared), true);
  assert.deepEqual(Object.keys(prepared), []);
  input.features[0].geometry.coordinates[0][0][0] = Infinity;
  input.features[0].properties.OBJECTID = "changed";
  input.features.length = 0;
  check([5, 5], prepared, "inside");
  const firstResult = lookupPoint([5, 5], prepared);
  firstResult.featureIds.push("changed");
  check([5, 5], prepared, "inside");
});

for (const [name, mutate] of [
  ["wrong collection type", (input) => { input.type = "Polygon"; }],
  ["absent features", (input) => { delete input.features; }],
  ["non-array features", (input) => { input.features = {}; }],
  ["sparse features", (input) => { input.features = Array(1); }],
  ["null feature", (input) => { input.features[0] = null; }],
  ["wrong feature type", (input) => { input.features[0].type = "Polygon"; }],
  ["non-object properties", (input) => { input.features[0].properties = []; }],
  ["boolean ID", (input) => { input.features[0].properties.OBJECTID = true; }],
  ["nonfinite ID", (input) => { input.features[0].properties.OBJECTID = Infinity; }],
  ["null geometry", (input) => { input.features[0].geometry = null; }],
  ["missing geometry", (input) => { delete input.features[0].geometry; }],
  ["unsupported geometry", (input) => { input.features[0].geometry.type = "LineString"; }],
  ["geometry collection", (input) => { input.features[0].geometry = { type: "GeometryCollection", geometries: [] }; }],
  ["empty polygon", (input) => { input.features[0].geometry.coordinates = []; }],
  ["empty multipolygon", (input) => { input.features[0].geometry = { type: "MultiPolygon", coordinates: [] }; }],
  ["empty multipolygon member", (input) => { input.features[0].geometry = { type: "MultiPolygon", coordinates: [[]] }; }],
  ["missing coordinates", (input) => { delete input.features[0].geometry.coordinates; }],
  ["sparse ring", (input) => { input.features[0].geometry.coordinates[0] = Array(5); }],
  ["short ring", (input) => { input.features[0].geometry.coordinates[0] = [[0, 0], [1, 1], [0, 0]]; }],
  ["unclosed ring", (input) => { input.features[0].geometry.coordinates[0][4] = [0, 1]; }],
  ["unclosed hole", (input) => { input.features[0].geometry.coordinates.push([[2, 2], [3, 2], [3, 3], [2, 3]]); }],
  ["collapsed ring", (input) => { input.features[0].geometry.coordinates[0] = [[0, 0], [0, 0], [0, 0], [0, 0]]; }],
  ["collinear ring", (input) => { input.features[0].geometry.coordinates[0] = [[0, 0], [1, 1], [2, 2], [0, 0]]; }],
  ["out-of-range longitude", (input) => { input.features[0].geometry.coordinates[0][1][0] = 181; }],
  ["out-of-range latitude", (input) => { input.features[0].geometry.coordinates[0][1][1] = -91; }],
  ["string coordinate", (input) => { input.features[0].geometry.coordinates[0][1][0] = "10"; }],
  ["boolean coordinate", (input) => { input.features[0].geometry.coordinates[0][1][0] = false; }],
  ["null coordinate", (input) => { input.features[0].geometry.coordinates[0][1][0] = null; }],
  ["NaN coordinate", (input) => { input.features[0].geometry.coordinates[0][1][0] = NaN; }],
  ["infinite coordinate", (input) => { input.features[0].geometry.coordinates[0][1][0] = Infinity; }],
  ["altitude coordinate", (input) => { input.features[0].geometry.coordinates[0][1].push(0); }],
]) {
  test(`preparation rejects ${name}`, () => {
    const input = collection();
    mutate(input);
    assert.throws(() => prepareCollection(input), TypeError);
  });
}

test("preparation rejects null, undefined, arrays and primitive inputs", () => {
  for (const input of [null, undefined, [], true, 1, "FeatureCollection"]) {
    assert.throws(() => prepareCollection(input), TypeError);
  }
});

test("lookup rejects malformed points rather than treating them as outside", () => {
  const prepared = prepareCollection(collection());
  for (const point of [undefined, null, [], [0], [0, 0, 0], [181, 0], [0, 91], [NaN, 0],
    [0, Infinity], [false, 0], [0, true], ["0", 0], [null, 0], { lng: 0, lat: 0 }]) {
    assert.throws(() => lookupPoint(point, prepared), TypeError);
  }
});

test("lookup rejects raw or forged prepared collections", () => {
  for (const prepared of [null, undefined, {}, collection(), 0, true, "prepared"]) {
    assert.throws(() => lookupPoint([0, 0], prepared), TypeError);
  }
});

test("WGS84 range endpoints are accepted without coordinate coercion", () => {
  const prepared = prepareCollection(collection([polygon([square(179, 89, 1)])]));
  check([180, 90], prepared, "boundary");
  check([-180, -90], prepared, "outside");
});

test("browser script exposes the same AddressLookup API without CommonJS", () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/address-lookup.js"), "utf8"), context);
  const api = context.window.AddressLookup;
  assert.equal(typeof api.prepareCollection, "function");
  assert.equal(typeof api.lookupPoint, "function");
  assert.equal(api.lookupPoint([5, 5], api.prepareCollection(collection())).relation, "inside");
});

test("checked-in official snapshots prepare without losing any component vertices", () => {
  for (const filename of ["flood_extent_baseline.geojson", "flood_extent_2100.geojson"]) {
    const input = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/official", filename), "utf8"));
    const before = JSON.stringify(input);
    const prepared = prepareCollection(input);
    assert.equal(JSON.stringify(input), before);
    let verticesChecked = 0;
    for (const feature of input.features) {
      const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      for (const rings of polygons) {
        for (const ring of rings) {
          const result = lookupPoint(ring[0], prepared);
          assert.notEqual(result.relation, "outside", `${filename}: an original ring vertex should touch the union`);
          assert.ok(result.featureIds.includes(feature.properties.OBJECTID));
          verticesChecked += 1;
        }
      }
    }
    assert.ok(verticesChecked > 0);
    check([0, 0], prepared, "outside");
  }
});
