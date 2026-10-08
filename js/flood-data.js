/* Shared validation for official snapshots. Usable in the browser and Node tests. */
(function (root) {
  "use strict";
  const STUDY = "ELIZABETH ST DRAIN (CITY)";
  const SOURCE = "https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11";
  const EXPECTED = {
    baseline: { scenario: "Existing Condition", date: "2020-08-13", count: 1 },
    future_2100: { scenario: "Yr 2100, RCP 8.5", date: "2017-08-31", count: 3 },
  };

  async function fetchJSON(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error("The data service returned an error");
    return data;
  }

  function validateManifest(manifest) {
    if (!manifest || manifest.schema_version !== 1 || manifest.source_url !== SOURCE || !Array.isArray(manifest.datasets)) {
      throw new Error("Unrecognised source manifest");
    }
    if (manifest.datasets.length !== Object.keys(EXPECTED).length) throw new Error("Missing or unexpected official datasets");
    const seen = new Set();
    manifest.datasets.forEach((dataset) => {
      const expected = EXPECTED[dataset.id];
      if (!expected || seen.has(dataset.id) || dataset.study_name !== STUDY || dataset.aep !== "1PCT" || dataset.synthetic !== false ||
          dataset.modelling_scenario !== expected.scenario || dataset.study_date !== expected.date || dataset.feature_count !== expected.count ||
          dataset.source_url !== SOURCE || !/^data\/official\/[a-z0-9_]+\.geojson$/.test(dataset.file)) {
        throw new Error("Unexpected official dataset metadata; check the source snapshot");
      }
      seen.add(dataset.id);
    });
    return manifest;
  }

  function validateExtent(data, dataset) {
    const expected = EXPECTED[dataset.id];
    if (!expected || data.type !== "FeatureCollection" || !Array.isArray(data.features) || data.features.length !== expected.count) {
      throw new Error("Incomplete official flood layer");
    }
    if (data.exceededTransferLimit || data.properties?.exceededTransferLimit) throw new Error("Truncated official flood layer");
    const ids = new Set();
    data.features.forEach((feature) => {
      const p = feature.properties || {};
      if (p.STUDY_NAME !== STUDY || p.FLOOD_EVENT !== "1PCT" || p.MODELLING_SCENARIO !== expected.scenario ||
          typeof p.STUDY_DATE !== "number" || new Date(p.STUDY_DATE).toISOString().slice(0, 10) !== expected.date || ids.has(p.OBJECTID)) {
        throw new Error("Flood layer does not match its scenario metadata");
      }
      ids.add(p.OBJECTID);
      const g = feature.geometry;
      if (!g || !["Polygon", "MultiPolygon"].includes(g.type)) throw new Error("Unsupported flood geometry");
      const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      if (!Array.isArray(polygons) || !polygons.length) throw new Error("Empty geometry");
      polygons.forEach((polygon) => {
        if (!Array.isArray(polygon) || !polygon.length) throw new Error("Empty polygon");
        polygon.forEach((ring) => {
          if (!Array.isArray(ring) || ring.length < 4) throw new Error("Incomplete polygon ring");
          ring.forEach((point) => {
            if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
                Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new Error("Invalid longitude/latitude");
          });
          if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) throw new Error("Unclosed polygon ring");
        });
      });
    });
    if (!Array.isArray(dataset.object_ids) || dataset.object_ids.length !== ids.size ||
        new Set(dataset.object_ids).size !== dataset.object_ids.length || dataset.object_ids.some((id) => !ids.has(id))) {
      throw new Error("Unexpected source records");
    }
    return data;
  }

  const api = { fetchJSON, validateManifest, validateExtent, SOURCE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FloodData = api;
})(typeof window === "undefined" ? globalThis : window);
