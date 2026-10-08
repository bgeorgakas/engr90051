/* Address lookup UI. Geometry checks use local model snapshots only. */
(function (root) {
  "use strict";
  const SOURCE = "https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11";
  const FALLBACK_LABELS = {
    baseline: "Baseline · 1% AEP · 2020 study",
    future_2100: "2100 RCP 8.5 · 1% AEP · 2017 study",
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

    function sourceLink(metadata) {
      const link = element("a", "Official source ↗");
      let href = SOURCE;
      try {
        const url = new URL(metadata?.records_url || SOURCE);
        const source = new URL(SOURCE);
        if (url.origin === source.origin && url.pathname === source.pathname + "/query" && !url.username && !url.password) href = url.href;
      } catch (_) { /* Fall back to the verified source URL. */ }
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
      for (const id of ["baseline", "future_2100"]) {
        const dataset = context.datasets.find((entry) => entry.id === id) || { id, state: "failed" };
        const metadata = dataset.metadata;
        const card = element("section", undefined, "scenario-card");
        card.appendChild(element("h4", metadata?.label || FALLBACK_LABELS[id]));
        let relation = dataset.state === "loading" ? "loading" : "unavailable";
        let featureIds = [];
        if (dataset.state === "loaded" && dataset.prepared) {
          try {
            const result = lookup(point, dataset.prepared);
            relation = result.relation;
            featureIds = result.featureIds;
          } catch (_) { relation = "unavailable"; }
        }
        const messages = {
          inside: ["Within modelled extent", "The selected point intersects this scenario’s flood polygon. This is not a forecast or a property-level risk assessment."],
          boundary: ["On model boundary", "The selected point is on a polygon edge. A small change in the pin location could change the result; verify the location carefully."],
          outside: ["Not within displayed extent", "No intersection with this snapshot. We do not have the model-study coverage boundary, so this does not confirm the location was assessed or is safe."],
          unavailable: ["Model data unavailable", "No comparison could be made. Missing or invalid data does not mean there is no flood risk."],
          loading: ["Waiting for model data", "This result will update when the official snapshot finishes loading."],
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
        if (metadata) {
          details.appendChild(element("p", `Melbourne Water · study ${metadata.study_date} · ${metadata.modelling_scenario}`, "scenario-metadata"));
        }
        if (featureIds.length) {
          details.appendChild(element("p", `Intersecting source record${featureIds.length === 1 ? "" : "s"}: ${featureIds.join(", ")}`, "scenario-metadata"));
        }
        details.appendChild(sourceLink(metadata));
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
      node("address-snapshot").textContent = context.retrievedAt
        ? `Snapshot retrieved ${context.retrievedAt.slice(0, 10)} (UTC). Results use both official scenarios even when a layer is hidden; planning and synthetic demo layers are not used.`
        : "Results use the official model snapshots only, not planning or synthetic demo layers.";
    }

    function select(result) {
      selection = result;
      candidatesNode.hidden = true;
      selectionNode.hidden = false;
      status.textContent = "Location selected. Comparing the mapped point with both official scenarios.";
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
