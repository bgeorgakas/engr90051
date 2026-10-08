/* Original prototype layers. Display names are legacy labels, not provenance. */
(function (root) {
  "use strict";
  const DATASETS = Object.freeze([
    Object.freeze({
      id: "legacy_2100", label: "2100 — 1% AEP (climate change)",
      file: "data/flood_extent_2100.json", scenario: "planning_overlay_union",
      data_kind: "planning_overlay", synthetic: false,
      description: "SBO/LSIO planning boundaries merged for the prototype. The original 2100 label is retained, but this is not a verified 2100 flood model or a uniform 1% AEP scenario.",
      source_url: "scripts/transform.py",
    }),
    Object.freeze({
      id: "demo_2010", label: "2010 flood event (indicative)",
      file: "data/flood_extent_2010.json", scenario: "synthetic_demo_2010",
      data_kind: "synthetic_demo", synthetic: true,
      description: "Synthetic demonstration: the planning area was reduced towards 85% and partially restored within randomly placed storm cells. This is not observed or modelled 2010 flooding.",
      source_url: "scripts/transform.py",
    }),
    Object.freeze({
      id: "demo_current", label: "Current day — 1% AEP (indicative)",
      file: "data/flood_extent_current.json", scenario: "synthetic_demo_current",
      data_kind: "synthetic_demo", synthetic: true,
      description: "Synthetic demonstration: the planning area was reduced towards 70%. This is not a verified current-day flood model or a 1% AEP result.",
      source_url: "scripts/transform.py",
    }),
  ]);

  function validateExtent(data, dataset) {
    const expected = DATASETS.find((entry) => entry.id === dataset?.id);
    if (!expected || ["file", "scenario", "data_kind", "synthetic"].some((field) => dataset[field] !== expected[field])) {
      throw new Error("Unknown or inconsistent prototype dataset");
    }
    if (!data || data.error || data.exceededTransferLimit === true || data.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
      throw new Error("Missing or incomplete prototype features");
    }
    for (const feature of data.features) {
      if (feature?.type !== "Feature" || !feature.geometry || !feature.properties ||
          ["scenario", "data_kind", "synthetic"].some((field) => feature.properties[field] !== expected[field])) {
        throw new Error("Prototype layer provenance does not match its catalogue entry");
      }
    }
    return data;
  }

  const api = { DATASETS, validateExtent };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PrototypeData = api;
})(typeof window === "undefined" ? globalThis : window);
