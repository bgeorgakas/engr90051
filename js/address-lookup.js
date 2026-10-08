/* Point membership in unsimplified GeoJSON polygons. No network or map dependency. */
(function (root) {
  "use strict";

  // Prepared coordinates are private snapshots: later edits to input GeoJSON cannot
  // invalidate the bounds or bypass validation. Only prepareCollection creates handles.
  const preparedCollections = new WeakMap();
  const ROUNDING_FACTOR = 8 * Number.EPSILON;

  function fail(message) {
    throw new TypeError(`Invalid address lookup geometry: ${message}`);
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function validatePoint(point, label) {
    if (!Array.isArray(point) || point.length !== 2 ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      fail(`${label} must be a finite [longitude, latitude] pair in WGS84 ranges`);
    }
  }

  function emptyBounds() {
    return [Infinity, Infinity, -Infinity, -Infinity];
  }

  function extendBounds(target, source) {
    target[0] = Math.min(target[0], source[0]);
    target[1] = Math.min(target[1], source[1]);
    target[2] = Math.max(target[2], source[2]);
    target[3] = Math.max(target[3], source[3]);
  }

  function prepareRing(input, label) {
    if (!Array.isArray(input) || input.length < 4) fail(`${label} needs at least four positions`);
    const points = [];
    const bounds = emptyBounds();
    for (let index = 0; index < input.length; index += 1) {
      validatePoint(input[index], `${label} position ${index}`);
      const point = [input[index][0], input[index][1]];
      points.push(point);
      extendBounds(bounds, [point[0], point[1], point[0], point[1]]);
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) fail(`${label} must be closed`);

    // Reject collapsed rings without rounding coordinates or imposing a minimum
    // area, which would otherwise discard valid tiny polygon components.
    const second = points.find((point) => point[0] !== first[0] || point[1] !== first[1]);
    if (!second || !points.some((point) =>
      (second[0] - first[0]) * (point[1] - first[1]) !==
      (second[1] - first[1]) * (point[0] - first[0]))) {
      fail(`${label} must have at least three non-collinear vertices`);
    }
    return { points, bounds };
  }

  function preparePolygon(input, label) {
    if (!Array.isArray(input) || input.length === 0) fail(`${label} needs an exterior ring`);
    const rings = [];
    for (let index = 0; index < input.length; index += 1) {
      rings.push(prepareRing(input[index], `${label} ring ${index}`));
    }
    return { rings, bounds: rings[0].bounds };
  }

  function featureId(feature, index) {
    const id = feature.properties?.OBJECTID ?? feature.id ?? index;
    if (typeof id !== "string" && !Number.isFinite(id)) fail(`feature ${index} has an invalid ID`);
    return id;
  }

  /** Validate Polygon/MultiPolygon features once and prepare bounds for reuse.
   * Ring winding does not matter; the first ring is exterior and the rest holes.
   * Edges follow GeoJSON's straight longitude/latitude segments. Antimeridian
   * geometries should be split at the antimeridian, as recommended by GeoJSON.
   * This validates structure, not polygon topology (such as self-intersections).
   */
  function prepareCollection(collection) {
    if (!isObject(collection) || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
      fail("expected a FeatureCollection with a features array");
    }
    const features = [];
    const bounds = emptyBounds();
    for (let index = 0; index < collection.features.length; index += 1) {
      const feature = collection.features[index];
      if (!isObject(feature) || feature.type !== "Feature") fail(`feature ${index} must be a Feature`);
      if (feature.properties !== undefined && feature.properties !== null && !isObject(feature.properties)) {
        fail(`feature ${index} properties must be an object or null`);
      }
      const geometry = feature.geometry;
      if (!isObject(geometry) || !["Polygon", "MultiPolygon"].includes(geometry.type)) {
        fail(`feature ${index} must have Polygon or MultiPolygon geometry`);
      }
      const inputPolygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      if (!Array.isArray(inputPolygons) || inputPolygons.length === 0) fail(`feature ${index} needs polygon coordinates`);
      const polygons = [];
      const featureBounds = emptyBounds();
      for (let polygonIndex = 0; polygonIndex < inputPolygons.length; polygonIndex += 1) {
        const polygon = preparePolygon(inputPolygons[polygonIndex], `feature ${index} polygon ${polygonIndex}`);
        polygons.push(polygon);
        extendBounds(featureBounds, polygon.bounds);
      }
      features.push({ id: featureId(feature, index), polygons, bounds: featureBounds });
      extendBounds(bounds, featureBounds);
    }
    const prepared = Object.freeze({});
    preparedCollections.set(prepared, { features, bounds });
    return prepared;
  }

  // Only a few floating-point ULPs at this coordinate scale. This is numerical
  // rounding tolerance, not a distance buffer or flood-risk safety margin.
  function tolerance(point, bounds) {
    return ROUNDING_FACTOR * Math.max(1, Math.abs(point[0]), Math.abs(point[1]),
      Math.abs(bounds[0]), Math.abs(bounds[1]), Math.abs(bounds[2]), Math.abs(bounds[3]));
  }

  function withinBounds(point, bounds) {
    const epsilon = tolerance(point, bounds);
    return point[0] >= bounds[0] - epsilon && point[0] <= bounds[2] + epsilon &&
      point[1] >= bounds[1] - epsilon && point[1] <= bounds[3] + epsilon;
  }

  function onSegment(point, start, end, epsilon) {
    if (point[0] < Math.min(start[0], end[0]) - epsilon || point[0] > Math.max(start[0], end[0]) + epsilon ||
        point[1] < Math.min(start[1], end[1]) - epsilon || point[1] > Math.max(start[1], end[1]) + epsilon) return false;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]) <= epsilon;
    const cross = dx * (point[1] - start[1]) - dy * (point[0] - start[0]);
    return Math.abs(cross) <= epsilon * Math.hypot(dx, dy);
  }

  function ringRelation(point, ring) {
    if (!withinBounds(point, ring.bounds)) return "outside";
    const epsilon = tolerance(point, ring.bounds);
    let inside = false;
    for (let index = 1; index < ring.points.length; index += 1) {
      const start = ring.points[index - 1];
      const end = ring.points[index];
      if (onSegment(point, start, end, epsilon)) return "boundary";
      // The strict comparison counts each ray/vertex crossing only once and
      // excludes horizontal edges (already checked above for exact membership).
      if ((start[1] > point[1]) !== (end[1] > point[1]) &&
          point[0] < start[0] + (point[1] - start[1]) * (end[0] - start[0]) / (end[1] - start[1])) {
        inside = !inside;
      }
    }
    return inside ? "inside" : "outside";
  }

  function polygonRelation(point, polygon) {
    if (!withinBounds(point, polygon.bounds)) return "outside";
    const exterior = ringRelation(point, polygon.rings[0]);
    if (exterior !== "inside") return exterior;
    for (let index = 1; index < polygon.rings.length; index += 1) {
      const hole = ringRelation(point, polygon.rings[index]);
      if (hole === "inside") return "outside";
      if (hole === "boundary") return "boundary";
    }
    return "inside";
  }

  /** Return membership in the union, plus every touching/containing feature ID.
   * An interior match takes precedence over a boundary match. IDs are unique and
   * retain feature order. "Outside" means outside these geometries only; this
   * module cannot determine safety, flood risk, or study coverage.
   */
  function lookupPoint(point, prepared) {
    validatePoint(point, "lookup point");
    if (!prepared || !preparedCollections.has(prepared)) throw new TypeError("Expected a prepared address lookup collection");
    const collection = preparedCollections.get(prepared);
    const result = { relation: "outside", featureIds: [] };
    if (collection.features.length === 0 || !withinBounds(point, collection.bounds)) return result;
    const ids = new Set();
    for (const feature of collection.features) {
      if (!withinBounds(point, feature.bounds)) continue;
      let featureRelation = "outside";
      for (const polygon of feature.polygons) {
        const relation = polygonRelation(point, polygon);
        if (relation === "inside") {
          featureRelation = "inside";
          break;
        }
        if (relation === "boundary") featureRelation = "boundary";
      }
      if (featureRelation !== "outside") {
        if (!ids.has(feature.id)) {
          ids.add(feature.id);
          result.featureIds.push(feature.id);
        }
        if (featureRelation === "inside" || result.relation === "outside") result.relation = featureRelation;
      }
    }
    return result;
  }

  const api = { prepareCollection, lookupPoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AddressLookup = api;
})(typeof window === "undefined" ? globalThis : window);
