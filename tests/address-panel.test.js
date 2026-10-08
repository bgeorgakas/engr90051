"use strict";

// Run the real controller and geometry with DOM/geocoder stand-ins. No network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../js/address-panel.js");
const { prepareCollection, lookupPoint } = require("../js/address-lookup.js");

const SOURCE = "https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11";

class BasicElement {
  constructor(tagName, document) {
    this.tagName = tagName.toLowerCase();
    this.document = document;
    this.children = [];
    this.events = new Map();
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.scrollTop = 0;
    this.value = "";
    this.className = "";
    this._text = "";
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(" "); },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("Panel must build safe text nodes, not assign innerHTML"); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener(type, callback) {
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(callback);
  }
  dispatch(type, details = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...details };
    let result;
    for (const callback of this.events.get(type) || []) result = callback(event);
    return result;
  }
  click() { if (!this.disabled) return this.dispatch("click"); }
  focus(options) { this.document.activeElement = this; this.focusOptions = options; }
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith(".")
      ? node.classList.contains(selector.slice(1))
      : node.tagName === selector.toLowerCase();
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function square(x = 0, y = 0, size = 10) {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

function prepared(rings = [square()], id = 1) {
  return prepareCollection({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { OBJECTID: id }, geometry: { type: "Polygon", coordinates: rings } }],
  });
}

function dataContext() {
  return {
    catchment: { state: "loaded", prepared: prepared([square(-20, -20, 40)]) },
    datasets: [
      {
        id: "baseline", state: "loaded", prepared: prepared(), visible: true,
        metadata: { label: "Baseline · 1% AEP · 2020 study", study_date: "2020-08-13", modelling_scenario: "Existing Condition", records_url: `${SOURCE}/query?where=OBJECTID%3D1` },
      },
      {
        id: "future_2100", state: "loaded", prepared: prepared([square(2, 2, 10)], 2), visible: false,
        metadata: { label: "2100 RCP 8.5 · 1% AEP · 2017 study", study_date: "2017-08-31", modelling_scenario: "Yr 2100, RCP 8.5", records_url: `${SOURCE}/query?where=OBJECTID%3D2` },
      },
    ],
    retrievedAt: "2026-10-08T02:15:01Z",
  };
}

function candidate(overrides = {}) {
  return { label: "Example public landmark, Melbourne", lon: 5, lat: 5, kind: "landmark", ...overrides };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ context = dataContext(), results = [candidate()], search } = {}) {
  const nodes = new Map();
  const document = {
    activeElement: null,
    createElement: (tag) => new BasicElement(tag, document),
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new BasicElement("div", document));
      return nodes.get(id);
    },
  };
  const node = (id) => document.getElementById(id);
  for (const id of ["address-panel", "address-candidates", "address-selection", "address-retry-data"]) node(id).hidden = true;
  const calls = { search: [], cancel: 0, selected: [], clear: 0, showLayer: [], retry: 0, recenter: [], open: 0 };
  const viewbox = [144.94, -37.79, 144.99, -37.84];
  const searchClient = {
    cancel() { calls.cancel += 1; },
    search(query, options) {
      calls.search.push({ query, options });
      return search ? search(query, options) : Promise.resolve(results);
    },
  };
  const controller = create({
    document, lookupPoint, searchClient,
    getViewbox: () => viewbox,
    getData: () => context,
    onSelect: (result) => calls.selected.push(result),
    onClear: () => { calls.clear += 1; },
    onShowLayer: (id) => {
      calls.showLayer.push(id);
      context.datasets.find((entry) => entry.id === id).visible = true;
    },
    onRetry: () => { calls.retry += 1; },
    onRecenter: (result) => calls.recenter.push(result),
    onOpen: () => { calls.open += 1; },
  });
  return {
    document, node, calls, controller, context, viewbox,
    search(value = "Example landmark Melbourne") {
      node("address-search-input").value = value;
      return node("address-search").dispatch("submit");
    },
    choose(index = 0) { node("address-candidate-list").children[index].querySelector("button").click(); },
    card(index) { return node("address-scenarios").children[index]; },
  };
}

test("a search requires explicit candidate choice even for one result", async () => {
  const result = candidate();
  const h = harness({ results: [result] });
  await h.search("Public landmark Melbourne");
  assert.deepEqual(h.calls.search, [{ query: "Public landmark Melbourne", options: { viewbox: h.viewbox } }]);
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.calls.open, 1);
  assert.equal(h.node("address-panel").hidden, false);
  assert.equal(h.node("map-layout").classList.contains("address-open"), true);
  assert.equal(h.node("address-candidates").hidden, false);
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-scenarios").children.length, 0);
  assert.deepEqual(h.calls.selected, []);
  assert.match(h.node("address-search-status").textContent, /1 match found.*Choose/);
  h.choose();
  assert.deepEqual(h.calls.selected, [result]);
  assert.equal(h.node("address-candidates").hidden, true);
  assert.equal(h.node("address-selection").hidden, false);
  assert.equal(h.node("selected-address").textContent, result.label);
  assert.equal(h.document.activeElement, h.node("selected-address"));
  assert.equal(h.node("address-scenarios").children.length, 2);
});

test("loading state announces activity and prevents premature results", async () => {
  const pending = deferred();
  const h = harness({ search: () => pending.promise });
  const searching = h.search();
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "true");
  assert.equal(h.node("address-search-submit").textContent, "Searching…");
  assert.match(h.node("address-search-status").textContent, /Finding matching/);
  assert.equal(h.node("address-candidates").hidden, true);
  assert.equal(h.node("address-selection").hidden, true);
  pending.resolve([candidate()]);
  await searching;
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "false");
  assert.equal(h.node("address-search-submit").textContent, "Search");
});

test("no-result search gives useful guidance and makes no flood assertion", async () => {
  const h = harness({ results: [] });
  await h.search();
  assert.match(h.node("address-search-status").textContent, /No matching location found.*street number/);
  assert.equal(h.node("address-candidates").hidden, true);
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-scenarios").children.length, 0);
  assert.deepEqual(h.calls.selected, []);
});

for (const [code, pattern] of [
  ["RATE_LIMIT", /limited request rate/],
  ["TIMEOUT", /timed out/],
  ["INVALID_QUERY", /between 3 and 200 characters/],
  ["NETWORK", /unavailable.*no flood result has been calculated/],
]) {
  test(`search ${code} error remains separate from model results`, async () => {
    const h = harness({ search: async () => { throw Object.assign(new Error("raw error <img>"), { code }); } });
    await h.search();
    assert.match(h.node("address-search-status").textContent, pattern);
    assert.doesNotMatch(h.node("address-search-status").textContent, /raw error/);
    assert.equal(h.node("address-panel").getAttribute("aria-busy"), "false");
    assert.equal(h.node("address-selection").hidden, true);
    assert.equal(h.node("address-scenarios").children.length, 0);
  });
}

test("a newer search wins when an older geocoder response arrives last", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness({ search: (query) => query === "first query" ? first.promise : second.promise });
  const firstSearch = h.search("first query");
  const secondSearch = h.search("second query");
  second.resolve([candidate({ label: "New result" })]);
  await secondSearch;
  first.resolve([candidate({ label: "Stale result" })]);
  await firstSearch;
  assert.match(h.node("address-candidate-list").textContent, /New result/);
  assert.doesNotMatch(h.node("address-candidate-list").textContent, /Stale result/);
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "false");
});

test("an older completion cannot clear the busy state of a newer search", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness({ search: (query) => query === "first query" ? first.promise : second.promise });
  const firstSearch = h.search("first query");
  const secondSearch = h.search("second query");
  first.resolve([candidate({ label: "Old result" })]);
  await firstSearch;
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "true");
  assert.equal(h.node("address-candidate-list").children.length, 0);
  second.resolve([candidate()]);
  await secondSearch;
});

test("an obsolete rejection cannot replace a newer successful result", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness({ search: (query) => query === "first query" ? first.promise : second.promise });
  const firstSearch = h.search("first query");
  const secondSearch = h.search("second query");
  second.resolve([candidate()]);
  await secondSearch;
  first.reject(Object.assign(new Error("late failure"), { code: "TIMEOUT" }));
  await firstSearch;
  assert.match(h.node("address-search-status").textContent, /1 match found/);
});

test("editing the query cancels pending work and prevents stale candidates", async () => {
  const pending = deferred();
  const h = harness({ search: () => pending.promise });
  const searching = h.search();
  h.node("address-search-input").value = "A different address";
  h.node("address-search-input").dispatch("input");
  assert.equal(h.calls.cancel, 2);
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "false");
  assert.match(h.node("address-search-status").textContent, /Location changed.*Press Search/);
  pending.resolve([candidate({ label: "Stale result" })]);
  await searching;
  assert.equal(h.node("address-candidate-list").children.length, 0);
  assert.equal(h.node("address-selection").hidden, true);
  assert.match(h.node("address-search-status").textContent, /Location changed/);
});

test("editing an already-selected address clears the pin and scenario results", async () => {
  const h = harness();
  await h.search();
  h.choose();
  const priorClears = h.calls.clear;
  h.node("address-search-input").dispatch("input");
  assert.equal(h.calls.clear, priorClears + 1);
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-scenarios").children.length, 0);
  assert.equal(h.node("address-candidate-list").children.length, 0);
  h.node("address-recentre").click();
  assert.deepEqual(h.calls.recenter, []);
});

test("typing with the panel closed does not open or cancel an idle search", () => {
  const h = harness();
  h.node("address-search-input").dispatch("input");
  assert.equal(h.node("address-panel").hidden, true);
  assert.equal(h.calls.cancel, 0);
  assert.equal(h.calls.clear, 0);
});

test("close cancels pending search and its later result cannot reopen the panel", async () => {
  const pending = deferred();
  const h = harness({ search: () => pending.promise });
  const searching = h.search();
  h.node("address-panel-close").click();
  assert.equal(h.calls.cancel, 2);
  assert.equal(h.node("address-panel").hidden, true);
  assert.equal(h.node("map-layout").classList.contains("address-open"), false);
  assert.equal(h.document.activeElement, h.node("address-search-input"));
  pending.resolve([candidate()]);
  await searching;
  assert.equal(h.node("address-panel").hidden, true);
  assert.equal(h.node("address-candidate-list").children.length, 0);
  assert.equal(h.node("address-scenarios").children.length, 0);
});

test("Escape closes from either the panel or search input and clears selected state", async () => {
  for (const origin of ["address-panel", "address-search-input"]) {
    const h = harness();
    await h.search();
    h.choose();
    let prevented = false;
    h.node(origin).dispatch("keydown", { key: "Escape", preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(h.node("address-panel").hidden, true);
    assert.equal(h.node("address-selection").hidden, true);
    assert.equal(h.node("address-scenarios").children.length, 0);
    h.controller.refresh();
    assert.equal(h.node("address-scenarios").children.length, 0);
  }
});

test("candidate labels, kinds, metadata and selected address use literal text", async () => {
  const hostileText = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const context = dataContext();
  context.datasets[0].metadata.label = hostileText;
  context.datasets[0].metadata.modelling_scenario = hostileText;
  const h = harness({ context, results: [candidate({ label: hostileText, kind: hostileText })] });
  await h.search();
  assert.ok(h.node("address-candidate-list").textContent.includes(hostileText));
  assert.equal(h.node("address-candidate-list").querySelectorAll("img").length, 0);
  assert.equal(h.node("address-candidate-list").querySelectorAll("script").length, 0);
  h.choose();
  assert.equal(h.node("selected-address").textContent, hostileText);
  assert.equal(h.card(0).querySelector("h4").textContent, hostileText);
  assert.ok(h.card(0).textContent.includes(hostileText));
  assert.equal(h.card(0).querySelectorAll("script").length, 0);
});

test("both scenarios independently report inside, boundary or outside", async () => {
  for (const [point, baseline, future] of [
    [[1, 1], "inside", "outside"],
    [[2, 5], "inside", "boundary"],
    [[0, 5], "boundary", "outside"],
    [[11, 5], "outside", "inside"],
    [[15, 15], "outside", "outside"],
  ]) {
    const h = harness({ results: [candidate({ lon: point[0], lat: point[1] })] });
    await h.search();
    h.choose();
    assert.equal(h.card(0).querySelector(".scenario-status").classList.contains(baseline), true);
    assert.equal(h.card(1).querySelector(".scenario-status").classList.contains(future), true);
  }
});

test("inside and boundary descriptions are qualified, and matching record IDs are visible", async () => {
  const h = harness({ results: [candidate({ lon: 2, lat: 5 })] });
  await h.search();
  h.choose();
  assert.match(h.card(0).textContent, /Within modelled extent/);
  assert.match(h.card(0).textContent, /not a forecast or a property-level risk assessment/);
  assert.match(h.card(0).textContent, /Intersecting source record: 1/);
  assert.match(h.card(1).textContent, /On model boundary/);
  assert.match(h.card(1).textContent, /small change in the pin location/);
  assert.match(h.card(1).textContent, /Intersecting source record: 2/);
  assert.match(h.node("selected-coordinate").textContent, /5\.00000, 2\.00000 \(latitude, longitude\)/);
});

test("a polygon hole reports no intersection without claiming safety or known coverage", async () => {
  const context = dataContext();
  context.datasets[0].prepared = prepared([square(), square(2, 2, 4)]);
  const h = harness({ context, results: [candidate({ lon: 3, lat: 3 })] });
  await h.search();
  h.choose();
  assert.match(h.card(0).textContent, /Not within displayed extent/);
  assert.match(h.card(0).textContent, /do not have the model-study coverage boundary/);
  assert.match(h.card(0).textContent, /does not confirm the location was assessed or is safe/);
  assert.match(h.node("address-catchment").textContent, /Within.*project catchment.*does not establish model-study coverage/);
});

test("outside project catchment is a separate warning and does not suppress scenario calculations", async () => {
  const context = dataContext();
  context.catchment.prepared = prepared([square(-10, -10, 1)]);
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.match(h.node("address-catchment").textContent, /Outside.*project catchment/);
  assert.match(h.node("address-catchment").textContent, /not flood information for all of Melbourne/);
  assert.equal(h.node("address-catchment").className, "scope-warning");
  assert.match(h.card(0).textContent, /Within modelled extent/);
  assert.match(h.card(1).textContent, /Within modelled extent/);
});

test("catchment boundary is explicitly not a model-study coverage boundary", async () => {
  const context = dataContext();
  context.catchment.prepared = prepared([square()]);
  const h = harness({ context, results: [candidate({ lon: 0, lat: 5 })] });
  await h.search();
  h.choose();
  assert.match(h.node("address-catchment").textContent, /On the project catchment boundary/);
  assert.match(h.node("address-catchment").textContent, /not a model-study coverage boundary/);
  assert.equal(h.node("address-catchment").className, "scope-warning");
});

test("loading, absent and invalid catchment data do not invent coverage", async () => {
  for (const [catchment, pattern] of [
    [{ state: "loading" }, /Checking the project catchment/],
    [undefined, /boundary unavailable.*Do not infer study coverage/],
    [{ state: "loaded", prepared: {} }, /check unavailable.*Do not infer study coverage/],
  ]) {
    const context = dataContext();
    context.catchment = catchment;
    const h = harness({ context });
    await h.search();
    h.choose();
    assert.match(h.node("address-catchment").textContent, pattern);
    assert.match(h.card(0).textContent, /Within modelled extent/);
  }
});

test("missing and invalid model states show unavailable, not outside", async () => {
  for (const dataset of [undefined, { id: "baseline", state: "failed" }, { id: "baseline", state: "loaded" }, { id: "baseline", state: "loaded", prepared: {} }]) {
    const context = dataContext();
    context.datasets = [context.datasets[1], ...(dataset ? [dataset] : [])];
    const h = harness({ context });
    await h.search();
    h.choose();
    assert.match(h.card(0).textContent, /Model data unavailable/);
    assert.match(h.card(0).textContent, /Missing or invalid data does not mean there is no flood risk/);
    assert.doesNotMatch(h.card(0).textContent, /Not within displayed extent/);
    assert.equal(h.node("address-retry-data").hidden, false);
    assert.match(h.card(1).textContent, /Within modelled extent/);
  }
});

test("loading model results refresh after preparation without another address search", async () => {
  const context = dataContext();
  context.datasets[0].state = "loading";
  context.datasets[0].prepared = undefined;
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.match(h.card(0).textContent, /Waiting for model data/);
  assert.equal(h.node("address-retry-data").hidden, true);
  context.datasets[0].state = "loaded";
  context.datasets[0].prepared = prepared();
  h.controller.refresh();
  assert.match(h.card(0).textContent, /Within modelled extent/);
  assert.equal(h.calls.search.length, 1);
  assert.equal(h.calls.selected.length, 1);
});

test("retry delegates loading and refresh replaces unavailable results", async () => {
  const context = dataContext();
  context.datasets[1].state = "failed";
  context.datasets[1].prepared = undefined;
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.match(h.card(1).textContent, /Model data unavailable/);
  h.node("address-retry-data").click();
  assert.equal(h.calls.retry, 1);
  context.datasets[1].state = "loading";
  h.controller.refresh();
  assert.match(h.card(1).textContent, /Waiting for model data/);
  context.datasets[1].state = "loaded";
  context.datasets[1].prepared = prepared([square(2, 2, 10)], 2);
  h.controller.refresh();
  assert.match(h.card(1).textContent, /Within modelled extent/);
  assert.equal(h.node("address-retry-data").hidden, true);
  assert.equal(h.calls.search.length, 1);
});

test("both official scenarios are checked when hidden and legacy data is ignored", async () => {
  const context = dataContext();
  for (const dataset of context.datasets) dataset.visible = false;
  context.datasets.push({
    id: "synthetic_legacy", state: "loaded", visible: true,
    get prepared() { throw new Error("Legacy geometry must not be read"); },
  });
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.equal(h.node("address-scenarios").children.length, 2);
  assert.match(h.card(0).textContent, /Within modelled extent/);
  assert.match(h.card(1).textContent, /Within modelled extent/);
  assert.match(h.node("address-snapshot").textContent, /2026-10-08 \(UTC\)/);
  assert.match(h.node("address-snapshot").textContent, /both official scenarios even when a layer is hidden/);
  assert.match(h.node("address-snapshot").textContent, /planning and synthetic demo layers are not used/);
});

test("missing snapshot date uses a qualified official-only statement", async () => {
  const context = dataContext();
  delete context.retrievedAt;
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.equal(h.node("address-snapshot").textContent, "Results use the official model snapshots only, not planning or synthetic demo layers.");
});

test("source links allow only the verified official query endpoint", async () => {
  for (const recordsURL of [
    "javascript:alert(1)",
    "https://untrusted.example/query",
    "https://spatial.planning.vic.gov.au.evil.example/server/rest/services/planning_flood_control/MapServer/11/query",
    `${SOURCE}/unverified`,
    `${SOURCE}/query/extra`,
    "http://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/11/query",
    "not a URL",
    undefined,
  ]) {
    const context = dataContext();
    context.datasets[0].metadata.records_url = recordsURL;
    const h = harness({ context });
    await h.search();
    h.choose();
    const link = h.card(0).querySelector("a");
    assert.equal(link.href, SOURCE);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
  const h = harness();
  await h.search();
  h.choose();
  assert.equal(h.card(0).querySelector("a").href, `${SOURCE}/query?where=OBJECTID%3D1`);
});

test("choosing another candidate clears prior selection and restores candidate focus", async () => {
  const first = candidate({ label: "First result" });
  const second = candidate({ label: "Second result", lon: 11 });
  const h = harness({ results: [first, second] });
  await h.search();
  h.choose();
  h.node("address-change-location").click();
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-candidates").hidden, false);
  assert.equal(h.node("address-scenarios").children.length, 0);
  assert.equal(h.document.activeElement, h.node("address-candidate-list").querySelector("button"));
  assert.match(h.node("address-search-status").textContent, /Choose another matching location/);
  h.choose(1);
  assert.deepEqual(h.calls.selected, [first, second]);
  assert.equal(h.node("selected-address").textContent, "Second result");
  assert.match(h.card(0).textContent, /Not within displayed extent/);
  assert.match(h.card(1).textContent, /Within modelled extent/);
});

test("recenter and show-layer actions call map callbacks for the correct selection/scenario", async () => {
  const result = candidate();
  const h = harness({ results: [result] });
  h.node("address-recentre").click();
  assert.deepEqual(h.calls.recenter, []);
  await h.search();
  h.choose();
  h.node("address-recentre").click();
  assert.deepEqual(h.calls.recenter, [result]);
  const shown = h.card(0).querySelector("button");
  assert.equal(shown.disabled, true);
  assert.equal(shown.textContent, "Layer shown on map");
  shown.click();
  assert.deepEqual(h.calls.showLayer, []);
  const hidden = h.card(1).querySelector("button");
  assert.equal(hidden.disabled, false);
  assert.equal(hidden.textContent, "Show layer on map");
  hidden.click();
  assert.deepEqual(h.calls.showLayer, ["future_2100"]);
  assert.equal(h.card(1).querySelector("button").disabled, true);
  assert.match(h.card(1).textContent, /Within modelled extent/);
});

test("a new search clears old selection and map pin before results arrive", async () => {
  const pending = deferred();
  let number = 0;
  const h = harness({ search: () => ++number === 1 ? Promise.resolve([candidate()]) : pending.promise });
  await h.search();
  h.choose();
  const priorClears = h.calls.clear;
  const searching = h.search("New public landmark");
  assert.equal(h.calls.clear, priorClears + 1);
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.node("address-scenarios").children.length, 0);
  pending.resolve([candidate({ label: "New candidate" })]);
  await searching;
  assert.equal(h.node("address-selection").hidden, true);
  assert.equal(h.calls.selected.length, 1);
});

test("road and city candidates warn that the match is street/area-level, not a property", async () => {
  for (const kind of ["road", "street", "city", "suburb", "postcode", "administrative"]) {
    const h = harness({ results: [candidate({ kind })] });
    await h.search();
    h.choose();
    assert.match(h.node("address-precision-note").textContent, /Street\/area-level match, not a specific property/);
    assert.match(h.node("address-precision-note").textContent, /Try a numbered address/);
    assert.match(h.node("address-precision-note").textContent, /verify the pin/);
    assert.match(h.card(0).textContent, /Within modelled extent/);
  }
});

test("a building candidate retains the point-not-property precision qualification", async () => {
  const h = harness({ results: [candidate({ kind: "building" })] });
  await h.search();
  h.choose();
  assert.match(h.node("address-precision-note").textContent, /Approximate mapped point, not the whole property or a confirmed entrance/);
  assert.match(h.node("address-precision-note").textContent, /Verify the pin/);
  assert.doesNotMatch(h.node("address-precision-note").textContent, /Street\/area-level/);
});

test("same-name candidates include distinct coordinates and retain their distinct selection points", async () => {
  const first = candidate({ label: "Same place name", kind: "building", lat: -37.815123, lon: 144.963456 });
  const second = candidate({ label: "Same place name", kind: "building", lat: -37.811234, lon: 144.971234 });
  const h = harness({ results: [first, second] });
  await h.search();
  const candidates = h.node("address-candidate-list").children;
  assert.match(candidates[0].textContent, /Same place name/);
  assert.match(candidates[1].textContent, /Same place name/);
  assert.match(candidates[0].textContent, /building · -37\.81512, 144\.96346 · Select/);
  assert.match(candidates[1].textContent, /building · -37\.81123, 144\.97123 · Select/);
  assert.notEqual(candidates[0].textContent, candidates[1].textContent);
  h.choose(1);
  assert.deepEqual(h.calls.selected, [second]);
  assert.match(h.node("selected-coordinate").textContent, /-37\.81123, 144\.97123/);
});

test("scenario explanation details preserve their independent open state across refreshes", async () => {
  const h = harness();
  await h.search();
  h.choose();
  const baseline = h.card(0).querySelector("details");
  const future = h.card(1).querySelector("details");
  assert.equal(baseline.open, false);
  assert.equal(future.open, false);
  assert.equal(baseline.querySelector("summary").textContent, "Explanation & source");
  baseline.open = true;
  baseline.dispatch("toggle");
  h.controller.refresh();
  assert.notEqual(h.card(0).querySelector("details"), baseline);
  assert.equal(h.card(0).querySelector("details").open, true);
  assert.equal(h.card(1).querySelector("details").open, false);

  const refreshedBaseline = h.card(0).querySelector("details");
  const refreshedFuture = h.card(1).querySelector("details");
  refreshedBaseline.open = false;
  refreshedBaseline.dispatch("toggle");
  refreshedFuture.open = true;
  refreshedFuture.dispatch("toggle");
  h.controller.refresh();
  assert.equal(h.card(0).querySelector("details").open, false);
  assert.equal(h.card(1).querySelector("details").open, true);

  // Showing a layer also refreshes both cards without collapsing explanations.
  h.card(1).querySelector("button").click();
  assert.equal(h.card(0).querySelector("details").open, false);
  assert.equal(h.card(1).querySelector("details").open, true);
});

test("an invalid prepared model handle cannot offer a show-layer action", async () => {
  const context = dataContext();
  context.datasets[0].prepared = {};
  context.datasets[0].visible = false;
  const h = harness({ context });
  await h.search();
  h.choose();
  assert.match(h.card(0).textContent, /Model data unavailable/);
  assert.equal(h.card(0).querySelector("button"), null);
  assert.doesNotMatch(h.card(0).textContent, /Show layer on map|Layer shown on map/);
  assert.equal(h.node("address-retry-data").hidden, false);
  assert.equal(h.card(1).querySelector("button").textContent, "Show layer on map");
});

test("official-origin source links with embedded credentials fall back to the verified source", async () => {
  for (const credentials of ["username:password", "username", ":password", "user%3Aname:pass%40word"]) {
    const context = dataContext();
    context.datasets[0].metadata.records_url = SOURCE.replace("https://", `https://${credentials}@`) + "/query?where=OBJECTID%3D1";
    const h = harness({ context });
    await h.search();
    h.choose();
    const link = h.card(0).querySelector("a");
    assert.equal(link.href, SOURCE);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
});

test("a fresh search resets stale panel scroll as soon as the panel opens", async () => {
  const pending = deferred();
  const h = harness({ search: () => pending.promise });
  h.node("address-panel").scrollTop = 420;
  const searching = h.search();
  assert.equal(h.node("address-panel").hidden, false);
  assert.equal(h.node("address-panel").scrollTop, 0);
  assert.equal(h.node("address-panel").getAttribute("aria-busy"), "true");
  pending.resolve([candidate()]);
  await searching;
  assert.equal(h.node("address-panel").scrollTop, 0);
});

test("selecting a candidate resets stale panel scroll and focuses without scrolling", async () => {
  const h = harness();
  await h.search();
  h.node("address-panel").scrollTop = 300;
  h.choose();
  assert.equal(h.node("address-panel").scrollTop, 0);
  assert.equal(h.document.activeElement, h.node("selected-address"));
  assert.deepEqual(h.node("selected-address").focusOptions, { preventScroll: true });
});

test("choosing another result resets stale panel scroll and preserves non-scrolling focus", async () => {
  const h = harness({ results: [candidate(), candidate({ label: "Second result", lon: 11 })] });
  await h.search();
  h.choose();
  h.node("address-panel").scrollTop = 510;
  h.node("address-change-location").click();
  const firstCandidate = h.node("address-candidate-list").querySelector("button");
  assert.equal(h.node("address-panel").scrollTop, 0);
  assert.equal(h.node("address-candidates").hidden, false);
  assert.equal(h.document.activeElement, firstCandidate);
  assert.deepEqual(firstCandidate.focusOptions, { preventScroll: true });
});

test("refresh alone preserves the user's current panel scroll position", async () => {
  const h = harness();
  await h.search();
  h.choose();
  h.node("address-panel").scrollTop = 275;
  const activeElement = h.document.activeElement;
  h.controller.refresh();
  assert.equal(h.node("address-panel").scrollTop, 275);
  assert.equal(h.document.activeElement, activeElement);
  assert.match(h.card(0).textContent, /Within modelled extent/);
});
