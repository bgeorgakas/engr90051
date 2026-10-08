"use strict";

// Run with: node --test tests/address-search.test.js. All requests and clocks are offline fixtures.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createClient, normaliseResults, DEFAULT_ENDPOINT } = require("../js/address-search.js");

function fixture(overrides = {}) {
  return { place_id: 123, display_name: "Melbourne Town Hall, Melbourne, Victoria, Australia", lat: "-37.814", lon: "144.966", type: "townhall", address: { city: "Melbourne", country: "Australia" }, ...overrides };
}

function response(data = [fixture()]) {
  return { ok: true, json: async () => data };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(fetchImpl = async () => response(), options = {}) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const calls = [];
  const client = createClient({
    ...options,
    fetchImpl: (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    nowImpl: () => now,
    setTimeoutImpl: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeoutImpl: (id) => timers.delete(id),
  });
  return {
    client, calls, timers,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}

test("browser global and CommonJS expose the same public API without issuing a request", () => {
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/address-search.js"), "utf8"), { window: browser });
  assert.deepEqual(Object.keys(browser.AddressSearch), ["createClient", "normaliseResults", "DEFAULT_ENDPOINT"]);
  const harness = setup();
  assert.deepEqual(Object.keys(harness.client), ["search", "cancel"]);
  assert.equal(harness.calls.length, 0);
});

test("only an explicit search submits a trimmed Australian query with safe request options", async () => {
  const { client, calls, timers } = setup();
  await client.search("  Melbourne Town Hall  ");
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, DEFAULT_ENDPOINT);
  assert.deepEqual(Object.fromEntries(url.searchParams), { q: "Melbourne Town Hall", format: "jsonv2", addressdetails: "1", limit: "5", countrycodes: "au" });
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.referrerPolicy, "strict-origin-when-cross-origin");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].init.signal.aborted, false);
  assert.equal(timers.size, 0);
});

for (const query of [null, undefined, 123, "", "  ", "ab", " x ", "x".repeat(201)]) {
  test(`invalid query ${JSON.stringify(query)} is never sent`, async () => {
    const { client, calls } = setup();
    await rejectsCode(client.search(query), "INVALID_QUERY");
    assert.equal(calls.length, 0);
  });
}

test("query boundary lengths are accepted", async () => {
  const { client, advance } = setup();
  await client.search("abc");
  advance(1100);
  await client.search("x".repeat(200));
});

test("viewbox is only a boost, canonicalised for cache identity, never bounded", async () => {
  const { client, calls, advance } = setup();
  await client.search("Melbourne", { viewbox: [144.9, -37.8, 145, -37.9] });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("viewbox"), "144.9,-37.8,145,-37.9");
  assert.equal(url.searchParams.has("bounded"), false);
  await client.search("Melbourne", { viewbox: "144.900,-37.800,145.0,-37.9" });
  assert.equal(calls.length, 1);
  advance(1100);
  await client.search("Melbourne");
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.has("viewbox"), false);
});

test("invalid viewboxes are never sent", async () => {
  const { client, calls } = setup();
  for (const viewbox of [[], [144, -38, 145], [181, -38, 145, -37], [144, -91, 145, -37], "144,,145,-37", {}, [null, -38, 145, -37]]) {
    await rejectsCode(client.search("Melbourne", { viewbox }), "INVALID_VIEWBOX");
  }
  assert.equal(calls.length, 0);
});

test("normalisation preserves every valid match including duplicate labels and fallback labels", () => {
  const input = [fixture(), fixture({ place_id: 124 }), fixture({ place_id: undefined, osm_type: "way", osm_id: 10, display_name: " ", name: " State Library ", addresstype: "amenity" }), fixture({ place_id: undefined, display_name: "", name: "", address: { suburb: "Carlton", city: "Melbourne", country: "Australia" } })];
  const output = normaliseResults(input);
  assert.equal(output.length, 4);
  assert.deepEqual(output[0], { id: "123", label: fixture().display_name, lat: -37.814, lon: 144.966, kind: "townhall", address: fixture().address });
  assert.equal(output[2].id, "way:10");
  assert.equal(output[2].label, "State Library");
  assert.equal(output[2].kind, "amenity");
  assert.equal(output[3].label, "Carlton, Melbourne, Australia");
});

test("invalid rows are omitted without dropping valid rows or changing their order", () => {
  const invalid = [null, {}, fixture({ lat: "" }), fixture({ lat: null }), fixture({ lat: true }), fixture({ lat: "NaN" }), fixture({ lon: Infinity }), fixture({ lon: "181" }), fixture({ lat: "-91" }), fixture({ lat: "1junk" }), fixture({ display_name: "", address: {} })];
  assert.deepEqual(normaliseResults([fixture(), ...invalid, fixture({ place_id: 999, lat: 0, lon: 0 })]).map((item) => item.id), ["123", "999"]);
  for (const value of [null, {}, { error: "upstream failure" }, invalid]) {
    assert.throws(() => normaliseResults(value), (error) => error.code === "REQUEST_FAILED");
  }
  assert.deepEqual(normaliseResults([]), []);
});

test("malformed address objects never become fabricated labels", () => {
  for (const address of ["Melbourne", ["Melbourne"], 123]) {
    assert.throws(() => normaliseResults([fixture({ display_name: "", address })]), (error) => error.code === "REQUEST_FAILED");
    assert.deepEqual(normaliseResults([fixture({ address })])[0].address, {});
  }
});

test("successful and empty results are cached in memory and returned as independent copies", async () => {
  const { client, calls, advance } = setup(async (url) => response(new URL(url).searchParams.get("q") === "Unknown" ? [] : [fixture()]));
  const first = await client.search(" Melbourne ");
  first[0].label = "modified";
  first[0].address.city = "modified";
  first.push({});
  const cached = await client.search("Melbourne");
  assert.equal(cached.length, 1);
  assert.equal(cached[0].label, fixture().display_name);
  assert.equal(cached[0].address.city, "Melbourne");
  advance(1100);
  assert.deepEqual(await client.search("Unknown"), []);
  assert.deepEqual(await client.search("Unknown"), []);
  assert.equal(calls.length, 2);
  const other = setup();
  await other.client.search("Melbourne");
  assert.equal(other.calls.length, 1);
});

test("requests have a start-to-start cooldown and are not queued or retried automatically", async () => {
  const { client, calls, advance, timers } = setup();
  await client.search("Melbourne");
  advance(1099);
  await assert.rejects(client.search("Carlton"), (error) => error.code === "RATE_LIMIT" && error.retryAfterMs === 1);
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 0);
  advance(1);
  await client.search("Carlton");
  assert.equal(calls.length, 2);
});

test("configured cooldown cannot weaken the one-second minimum", async () => {
  const { client, advance } = setup(undefined, { minIntervalMs: 0 });
  await client.search("Melbourne");
  advance(999);
  await rejectsCode(client.search("Carlton"), "RATE_LIMIT");
  advance(1);
  await client.search("Carlton");
});

test("a new search cancels the old request even when fetch ignores AbortSignal", async () => {
  const old = deferred();
  const { client, calls, advance } = setup(() => calls.length === 1 ? old.promise : Promise.resolve(response([fixture({ place_id: 456 })])));
  const first = client.search("Melbourne");
  const rejected = rejectsCode(first, "CANCELLED");
  advance(1100);
  assert.equal((await client.search("Carlton"))[0].id, "456");
  await rejected;
  assert.equal(calls[0].init.signal.aborted, true);
  old.resolve(response());
  await Promise.resolve();
  await Promise.resolve();
  advance(1100);
  assert.equal((await client.search("Melbourne"))[0].id, "456");
  assert.equal(calls.length, 3, "the stale response was not cached");
});

test("cancel settles promptly, aborts transport and ignores late rejection", async () => {
  const fetchResult = deferred();
  const { client, calls, timers } = setup(() => fetchResult.promise);
  const searched = client.search("Melbourne");
  const rejected = rejectsCode(searched, "CANCELLED");
  client.cancel();
  client.cancel();
  await rejected;
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(timers.size, 0);
  fetchResult.reject(new Error("late failure"));
  await Promise.resolve();
});

test("a too-fast newer search cancels stale work before rejecting the new request", async () => {
  const { client, calls } = setup(() => new Promise(() => {}));
  const first = client.search("Melbourne");
  const rejected = rejectsCode(first, "CANCELLED");
  await rejectsCode(client.search("Carlton"), "RATE_LIMIT");
  await rejected;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
});

test("cached newer searches also cancel pending work", async () => {
  const { client, calls, advance } = setup(() => calls.length === 1 ? Promise.resolve(response()) : new Promise(() => {}));
  await client.search("Melbourne");
  advance(1100);
  const pending = client.search("Carlton");
  const rejected = rejectsCode(pending, "CANCELLED");
  assert.equal((await client.search("Melbourne"))[0].id, "123");
  await rejected;
  assert.equal(calls.length, 2);
});

test("cancellation during response parsing cannot publish or cache a stale result", async () => {
  const body = deferred();
  const { client, advance, calls } = setup(() => calls.length === 1 ? Promise.resolve({ ok: true, json: () => body.promise }) : Promise.resolve(response()));
  const first = client.search("Melbourne");
  const rejected = rejectsCode(first, "CANCELLED");
  await Promise.resolve();
  client.cancel();
  await rejected;
  body.resolve([fixture({ place_id: 999 })]);
  await Promise.resolve();
  await Promise.resolve();
  advance(1100);
  assert.equal((await client.search("Melbourne"))[0].id, "123");
  assert.equal(calls.length, 2);
});

test("timeout settles even when fetch ignores abort and does not cache late results", async () => {
  const delayed = deferred();
  const { client, advance, calls, timers } = setup(() => calls.length === 1 ? delayed.promise : Promise.resolve(response()));
  const first = client.search("Melbourne");
  const rejected = rejectsCode(first, "TIMEOUT");
  advance(11999);
  assert.equal(calls[0].init.signal.aborted, false);
  advance(1);
  await rejected;
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(timers.size, 0);
  delayed.resolve(response([fixture({ place_id: 999 })]));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((await client.search("Melbourne"))[0].id, "123");
  assert.equal(calls.length, 2);
});

for (const [name, fetchImpl] of [
  ["HTTP rejection", async () => ({ ok: false, status: 429 })],
  ["network rejection", async () => { throw new Error("secret entered address"); }],
  ["synchronous rejection", () => { throw new Error("secret entered address"); }],
  ["JSON rejection", async () => ({ ok: true, json: async () => { throw new Error("secret entered address"); } })],
  ["invalid response", async () => response({ error: "secret entered address" })],
  ["no valid matches", async () => response([fixture({ lat: "invalid" })])],
]) {
  test(`${name} is a sanitised REQUEST_FAILED and is not cached`, async () => {
    const { client, advance, calls, timers } = setup(fetchImpl);
    await assert.rejects(client.search("secret entered address"), (error) => error.code === "REQUEST_FAILED" && !error.message.includes("secret"));
    assert.equal(timers.size, 0);
    advance(1100);
    await rejectsCode(client.search("secret entered address"), "REQUEST_FAILED");
    assert.equal(calls.length, 2);
  });
}

test("a Nominatim-compatible endpoint is configurable without weakening query constraints", async () => {
  const { client, calls } = setup(undefined, { endpoint: "https://geo.example.test/search?bounded=1&viewbox=1,2,3,4&countrycodes=us" });
  await client.search("Melbourne");
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://geo.example.test");
  assert.equal(url.searchParams.get("countrycodes"), "au");
  assert.equal(url.searchParams.has("bounded"), false);
  assert.equal(url.searchParams.has("viewbox"), false);
});

test("invalid service configuration fails without disclosing URL credentials", () => {
  for (const endpoint of ["javascript:alert(1)", "file:///tmp/private", "/relative", "https://user:secret@example.test/search", "https://example.test/search#fragment"]) {
    assert.throws(() => setup(undefined, { endpoint }), (error) => error.code === "INVALID_CONFIG" && !error.message.includes("secret"));
  }
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { minIntervalMs: -1 }, { minIntervalMs: "1000" }]) {
    assert.throws(() => setup(undefined, options), (error) => error.code === "INVALID_CONFIG");
  }
});
