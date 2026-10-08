/* Address lookup UI. Geometry-only checks against the three prototype layers. */
(function (root) {
  "use strict";
  const LAYERS = {
    legacy_2100: {
      label: "2100 — 1% AEP (climate change)",
      file: "data/flood_extent_2100.json",
      badge: "Planning boundaries · not a verified 2100 model",
      explanation: "These are planning flood-control boundaries reused under the original prototype title, not a verified 2100 climate-change flood model. The geometry does not establish the title’s date or AEP.",
      kind: "planning_overlay",
    },
    demo_2010: {
      label: "2010 flood event (indicative)",
      file: "data/flood_extent_2010.json",
      badge: "Synthetic demo · not observed/modelled flooding",
      explanation: "This is illustrative synthetic demo geometry, not observations of an actual flood event or outputs of a flood model. The title’s date and any AEP are not verified by these polygons.",
      kind: "synthetic_demo",
    },
    demo_current: {
      label: "Current day — 1% AEP (indicative)",
      file: "data/flood_extent_current.json",
      badge: "Synthetic demo · not observed/modelled flooding",
      explanation: "This is illustrative synthetic demo geometry, not observations of an actual flood event or outputs of a flood model. The title’s date and any AEP are not verified by these polygons.",
      kind: "synthetic_demo",
    },
  };

  function create(options) {
    const doc = options.document || root.document;
    const lookup = options.lookupPoint || root.AddressLookup.lookupPoint;
    const node = (id) => doc.getElementById(id);
    const panel = node("address-panel");
    const input = node("address-search-input");
    const submit = node("address-search-submit");
    const status = node("address-search-status");
    const candidatesNode = node("address-candidates");
    const candidateList = node("address-candidate-list");
    const selectionNode = node("address-selection");
    const scenarios = node("address-scenarios");
    let selection = null;
    let candidates = [];
    let generation = 0;
    let searching = false;
    const expandedScenarios = new Set();

    function element(tag, text, className) {
      const el = doc.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (className) el.className = className;
      return el;
    }

    function busy(value) {
      searching = value;
      panel.setAttribute("aria-busy", String(value));
      submit.textContent = value ? "Searching…" : "Search";
    }

    function open() {
      panel.hidden = false;
      panel.scrollTop = 0;
      node("map-layout").classList.add("address-open");
      options.onOpen?.();
    }

    function resetSelection() {
      selection = null;
      selectionNode.hidden = true;
      scenarios.replaceChildren();
      options.onClear?.();
    }

    function close() {
      generation += 1;
      options.searchClient.cancel();
      busy(false);
      resetSelection();
      candidates = [];
      candidateList.replaceChildren();
      candidatesNode.hidden = true;
      panel.hidden = true;
      node("map-layout").classList.remove("address-open");
      input.focus();
    }

    function localLink(text, href) {
      const link = element("a", text);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }

    function refresh() {
      if (!selection || panel.hidden) return;
      const context = options.getData();
      const point = [selection.lon, selection.lat];
      node("selected-address").textContent = selection.label;
      node("selected-coordinate").textContent = `Mapped point: ${selection.lat.toFixed(5)}, ${selection.lon.toFixed(5)} (latitude, longitude)`;
      const broadMatch = ["road", "street", "suburb", "neighbourhood", "quarter", "city", "town", "village", "municipality", "county", "state", "country", "postcode", "administrative"].includes(selection.kind);
      node("address-precision-note").textContent = broadMatch
        ? "Street/area-level match, not a specific property. Try a numbered address for a more specific match, and verify the pin."
        : "Approximate mapped point, not the whole property or a confirmed entrance. Verify the pin.";
      const scope = node("address-catchment");
      scope.className = "scope-neutral";
      if (context.catchment?.state === "loaded" && context.catchment.prepared) {
        try {
          const relation = lookup(point, context.catchment.prepared).relation;
          scope.textContent = relation === "inside"
            ? "Within the Elizabeth Street project catchment. The catchment boundary does not establish model-study coverage."
            : relation === "boundary"
              ? "On the project catchment boundary. Check the pin location; this is not a model-study coverage boundary."
              : "Outside the Elizabeth Street project catchment. This prototype only contains the Elizabeth Street datasets, not flood information for all of Melbourne.";
          if (relation !== "inside") scope.className = "scope-warning";
        } catch (_) {
          scope.textContent = "Project catchment check unavailable. Do not infer study coverage from these results.";
          scope.className = "scope-warning";
        }
      } else {
        scope.textContent = context.catchment?.state === "loading"
          ? "Checking the project catchment boundary…"
          : "Project catchment boundary unavailable. Do not infer study coverage from these results.";
      }

      scenarios.replaceChildren();
      let hasFailedData = false;
      for (const id of Object.keys(LAYERS)) {
        const layer = LAYERS[id];
        const dataset = context.datasets.find((entry) => entry.id === id) || { id, state: "failed" };
        const metadata = dataset.metadata;
        const card = element("section", undefined, "scenario-card");
        card.appendChild(element("h4", metadata?.label || layer.label));
        // Keep provenance visible even while explanation details are collapsed.
        card.appendChild(element("p", layer.badge, `scenario-data-kind ${layer.kind}`));
        let relation = dataset.state === "loading" ? "loading" : "unavailable";
        if (dataset.state === "loaded" && dataset.prepared) {
          try {
            const result = lookup(point, dataset.prepared);
            relation = result.relation;
          } catch (_) { relation = "unavailable"; }
        }
        const messages = {
          inside: ["Within displayed area", "The approximate mapped point is inside this displayed geometry only. This is not a flood-risk, property, or climate-change assessment."],
          boundary: ["On displayed boundary", "The approximate mapped point is on this displayed geometry’s edge. A small change in the pin location could change the result; verify the location carefully. This is a geometry-only check, not a flood-risk assessment."],
          outside: ["Not within displayed area", "No intersection with this displayed geometry. This does not establish assessment coverage or confirm that the location is safe."],
          unavailable: ["Layer data unavailable", "No geometry check could be made. Missing or invalid data does not mean there is no flood risk."],
          loading: ["Waiting for layer data", "This result will update when this prototype layer finishes loading."],
        };
        if (!messages[relation]) relation = "unavailable";
        const [heading, description] = messages[relation];
        card.appendChild(element("p", heading, `scenario-status ${relation}`));
        const details = element("details", undefined, "scenario-details");
        details.open = expandedScenarios.has(id);
        details.addEventListener("toggle", () => {
          if (details.open) expandedScenarios.add(id);
          else expandedScenarios.delete(id);
        });
        details.appendChild(element("summary", "Explanation & source"));
        details.appendChild(element("p", description, "scenario-description"));
        details.appendChild(element("p", layer.explanation, "scenario-metadata"));
        if (metadata?.description) {
          details.appendChild(element("p", metadata.description, "scenario-metadata"));
        }
        // Use exact local allowlisted paths, never metadata URLs or official-model links.
        details.appendChild(localLink("Displayed layer data", layer.file));
        details.appendChild(localLink("How this layer was made", "scripts/transform.py"));
        card.appendChild(details);
        const actions = element("div", undefined, "scenario-actions");
        if (["inside", "boundary", "outside"].includes(relation)) {
          const show = element("button", dataset.visible ? "Layer shown on map" : "Show layer on map");
          show.type = "button";
          show.disabled = Boolean(dataset.visible);
          show.addEventListener("click", () => { options.onShowLayer?.(id); refresh(); });
          actions.appendChild(show);
        }
        card.appendChild(actions);
        scenarios.appendChild(card);
        if (relation === "unavailable") hasFailedData = true;
      }
      node("address-retry-data").hidden = !hasFailedData;
      node("address-snapshot").textContent = "One approximate mapped point is checked against all three prototype layers, even when hidden. These are geometry-only results, not evidence of flooding, safety, or climate-change effects.";
    }

    function select(result) {
      selection = result;
      candidatesNode.hidden = true;
      selectionNode.hidden = false;
      status.textContent = "Location selected. Checking one approximate mapped point against the three prototype layers.";
      refresh();
      options.onSelect?.(result);
      node("selected-address").focus({ preventScroll: true });
      panel.scrollTop = 0;
    }

    function showCandidates() {
      candidateList.replaceChildren();
      candidatesNode.hidden = candidates.length === 0;
      for (const result of candidates) {
        const item = element("li");
        const button = element("button", undefined, "address-candidate");
        button.type = "button";
        button.appendChild(element("span", result.label));
        button.appendChild(element("span", `${result.kind || "location"} · ${result.lat.toFixed(5)}, ${result.lon.toFixed(5)} · Select →`, "candidate-kind"));
        button.addEventListener("click", () => select(result));
        item.appendChild(button);
        candidateList.appendChild(item);
      }
    }

    async function search(event) {
      event?.preventDefault();
      const request = ++generation;
      options.searchClient.cancel();
      resetSelection();
      candidates = [];
      showCandidates();
      open();
      busy(true);
      status.textContent = "Finding matching addresses and places…";
      try {
        const results = await options.searchClient.search(input.value, { viewbox: options.getViewbox?.() });
        if (request !== generation) return;
        candidates = results;
        showCandidates();
        status.textContent = results.length
          ? `${results.length} match${results.length === 1 ? "" : "es"} found. Choose a location below to check its mapped point.`
          : "No matching location found. Try a street number, street name and Melbourne, or a nearby public landmark.";
      } catch (error) {
        if (request !== generation || error.code === "CANCELLED") return;
        const messages = {
          RATE_LIMIT: "Please wait a moment before searching again. The shared address service has a limited request rate.",
          TIMEOUT: "Address search timed out. Check your connection and try again.",
          INVALID_QUERY: "Enter between 3 and 200 characters, such as a public address or landmark in Melbourne.",
        };
        status.textContent = messages[error.code] || "Address search is unavailable. Please try again later; no flood result has been calculated.";
      } finally {
        if (request === generation) busy(false);
      }
    }

    node("address-search").addEventListener("submit", search);
    input.addEventListener("input", () => {
      if (panel.hidden && !searching) return;
      generation += 1;
      options.searchClient.cancel();
      busy(false);
      resetSelection();
      candidates = [];
      showCandidates();
      status.textContent = "Location changed. Press Search to look up the new address.";
    });
    node("address-panel-close").addEventListener("click", close);
    panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); close(); } });
    node("address-change-location").addEventListener("click", () => {
      resetSelection();
      showCandidates();
      status.textContent = "Choose another matching location below, or enter a new search.";
      candidateList.querySelector("button")?.focus({ preventScroll: true });
      panel.scrollTop = 0;
    });
    node("address-recentre").addEventListener("click", () => { if (selection) options.onRecenter?.(selection); });
    node("address-retry-data").addEventListener("click", () => { options.onRetry?.(); });
    return { refresh, close };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AddressPanel = api;
})(typeof window === "undefined" ? globalThis : window);
