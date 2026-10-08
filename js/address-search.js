/* Submit-only, in-memory address lookup. Usable in the browser and Node tests. */
(function (root) {
  "use strict";

  const DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org/search";

  function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function coordinate(value, limit) {
    if (typeof value !== "number" && (typeof value !== "string" ||
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
  }

  function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normaliseResults(data) {
    if (!Array.isArray(data)) throw failure("REQUEST_FAILED", "The address service returned an invalid response.");
    const results = [];
    data.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const lat = coordinate(item.lat, 90);
      const lon = coordinate(item.lon, 180);
      if (lat === null || lon === null) return;
      const rawAddress = item.address && typeof item.address === "object" && !Array.isArray(item.address) ? item.address : {};
      const address = Object.fromEntries(Object.entries(rawAddress)
        .filter((entry) => cleanText(entry[1]))
        .map(([key, value]) => [key, cleanText(value)]));
      const label = cleanText(item.display_name) || cleanText(item.name) ||
        [...new Set(Object.values(address))].join(", ");
      if (!label) return;
      const placeId = typeof item.place_id === "number" && Number.isFinite(item.place_id)
        ? String(item.place_id) : cleanText(item.place_id);
      const osmId = typeof item.osm_id === "number" && Number.isFinite(item.osm_id)
        ? String(item.osm_id) : cleanText(item.osm_id);
      results.push({
        id: placeId || (osmId ? `${cleanText(item.osm_type) || "osm"}:${osmId}` : `${lat},${lon}:${index}`),
        label,
        lat,
        lon,
        kind: cleanText(item.addresstype) || cleanText(item.type) || cleanText(item.class) || "place",
        address,
      });
    });
    if (data.length && !results.length) throw failure("REQUEST_FAILED", "The address service returned no usable locations.");
    return results;
  }

  function normaliseViewbox(viewbox) {
    if (viewbox === undefined || viewbox === null || viewbox === "") return "";
    const parts = Array.isArray(viewbox) ? viewbox : typeof viewbox === "string" ? viewbox.split(",") : [];
    const values = parts.map((value, index) => coordinate(value, index % 2 ? 90 : 180));
    if (values.length !== 4 || values.some((value) => value === null)) {
      throw failure("INVALID_VIEWBOX", "The map search area is invalid.");
    }
    return values.join(",");
  }

  function cloneResults(results) {
    return results.map((result) => ({ ...result, address: { ...result.address } }));
  }

  // endpoint must implement Nominatim's search contract. The injected clock functions
  // make pacing and cancellation tests deterministic; production uses browser clocks.
  function createClient(options = {}) {
    const fetchImpl = options.fetchImpl || (typeof root.fetch === "function" ? root.fetch.bind(root) : null);
    if (typeof fetchImpl !== "function") throw failure("INVALID_CONFIG", "Address lookup is unavailable in this browser.");
    let endpoint;
    try {
      endpoint = new URL(options.endpoint === undefined ? DEFAULT_ENDPOINT : options.endpoint);
      if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
    } catch (_) {
      throw failure("INVALID_CONFIG", "The address service URL is invalid.");
    }
    const requestedInterval = options.minIntervalMs === undefined ? 1100 : options.minIntervalMs;
    const timeoutMs = options.timeoutMs === undefined ? 12000 : options.timeoutMs;
    if (!Number.isFinite(requestedInterval) || requestedInterval < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw failure("INVALID_CONFIG", "The address service timing settings are invalid.");
    }
    // This limit is per client. Multi-user deployments need a shared, server-side limiter.
    const minIntervalMs = Math.max(1000, requestedInterval);
    const now = options.nowImpl || (() => root.performance ? root.performance.now() : Date.now());
    const schedule = options.setTimeoutImpl || root.setTimeout.bind(root);
    const unschedule = options.clearTimeoutImpl || root.clearTimeout.bind(root);
    const cache = new Map();
    let lastStartedAt = -Infinity;
    let pending = null;

    function cancel() {
      if (pending) pending.stop("CANCELLED", "The address search was cancelled.");
    }

    async function search(query, { viewbox } = {}) {
      // Every newer user intent invalidates the old result, including cached searches.
      cancel();
      if (typeof query !== "string" || query.trim().length < 3 || query.trim().length > 200) {
        throw failure("INVALID_QUERY", "Enter an address or place name between 3 and 200 characters.");
      }
      const text = query.trim();
      const box = normaliseViewbox(viewbox);
      const key = JSON.stringify([text, box]);
      if (cache.has(key)) return cloneResults(cache.get(key));
      const startedAt = now();
      const remaining = minIntervalMs - (startedAt - lastStartedAt);
      if (remaining > 0) {
        const error = failure("RATE_LIMIT", "Please wait a moment before searching again.");
        error.retryAfterMs = Math.ceil(remaining);
        throw error;
      }
      const url = new URL(endpoint.href);
      url.searchParams.set("q", text);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("limit", "5");
      url.searchParams.set("countrycodes", "au");
      // The current map is a ranking hint, not a restriction on Australian matches.
      url.searchParams.delete("bounded");
      if (box) url.searchParams.set("viewbox", box);
      else url.searchParams.delete("viewbox");
      const controller = new AbortController();
      lastStartedAt = startedAt;

      return new Promise((resolve, reject) => {
        const request = { done: false, timer: null, stop: null };
        function finish(error, results) {
          if (request.done) return;
          request.done = true;
          if (request.timer !== null) unschedule(request.timer);
          if (pending === request) pending = null;
          if (error) reject(error);
          else {
            cache.set(key, cloneResults(results));
            resolve(cloneResults(results));
          }
        }
        request.stop = (code, message) => {
          // Reject explicitly: even a fetch implementation ignoring abort cannot win a late race.
          finish(failure(code, message));
          controller.abort();
        };
        pending = request;
        request.timer = schedule(() => request.stop("TIMEOUT", "The address service took too long to respond."), timeoutMs);
        try {
          Promise.resolve(fetchImpl(url.href, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "strict-origin-when-cross-origin",
          })).then((response) => {
            if (request.done) return null;
            if (!response || !response.ok || typeof response.json !== "function") throw new Error();
            return response.json();
          }).then((data) => {
            if (!request.done) finish(null, normaliseResults(data));
          }).catch(() => {
            if (!request.done) finish(failure("REQUEST_FAILED", "The address service is unavailable. Please try again later."));
          });
        } catch (_) {
          finish(failure("REQUEST_FAILED", "The address service is unavailable. Please try again later."));
        }
      });
    }

    return { search, cancel };
  }

  const api = { createClient, normaliseResults, DEFAULT_ENDPOINT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AddressSearch = api;
})(typeof window === "undefined" ? globalThis : window);
