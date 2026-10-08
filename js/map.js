const map = L.map("map").setView([-37.811, 144.962], 15);

const stadiaBase = L.tileLayer("https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=b73e5bd5-ccb6-4b14-92c5-69cd89becd8b", {
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; OpenStreetMap contributors',
}).addTo(map);

const baseLayers = {
  "Stadia Alidade Smooth": stadiaBase,
};

const layerControl = L.control.layers(baseLayers, {}, { collapsed: true }).addTo(map);
if (map.getSize().x > 640) layerControl.expand();

let addressPanel = null;
let selectedLocation = null;
let searchMarker = null;
let catchmentBounds = null;
let catchmentPrepared = null;
let catchmentState = "loading";
const officialPrepared = new Map();
const officialMetadata = new Map();
let officialSnapshotDate = null;

const mapLoadWarning = document.getElementById("map-load-warning");
const failedOptionalLayers = new Set();

function reportLayerFailure(name) {
  failedOptionalLayers.add(name);
  mapLoadWarning.textContent = `Could not load: ${[...failedOptionalLayers].join(", ")}. Missing data does not mean no flooding.`;
  mapLoadWarning.hidden = false;
}

function fetchOverlay(url, name, style) {
  return FloodData.fetchJSON(url)
    .then((geojson) => {
      if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features) || !geojson.features.length) {
        throw new Error("Empty or invalid map layer");
      }
      return geojson;
    })
    .then((geojson) => ({ name, geojson, layer: L.geoJSON(geojson, { style }) }))
    .catch((err) => {
      console.error(`Failed to load overlay "${name}" from ${url}`, err);
      reportLayerFailure(name);
      return null;
    });
}

function addOverlay(overlay, enabled = true) {
  if (!overlay) return null;
  if (enabled) overlay.layer.addTo(map);
  layerControl.addOverlay(overlay.layer, overlay.name);
  return overlay.layer;
}

const catchmentLayer = fetchOverlay("data/catchment.json", "Elizabeth Street catchment", {
  color: "#111827",
  weight: 2,
  fill: false,
  dashArray: "6 4",
}).then((overlay) => {
  if (!overlay) {
    catchmentState = "failed";
    addressPanel?.refresh();
    return null;
  }
  try {
    catchmentPrepared = AddressLookup.prepareCollection(overlay.geojson);
    catchmentState = "loaded";
  } catch (err) {
    catchmentState = "failed";
    console.error("Catchment geometry cannot be used for address lookup", err);
  }
  addressPanel?.refresh();
  return addOverlay(overlay);
});

// Legacy files remain available for prototype comparison only. They are NOT
// the official model snapshots and are off by default. The filename is kept
// so existing extraction/transform workflows are not broken.
fetchOverlay("data/flood_extent_2100.json", "Planning boundaries (SBO/LSIO; not a 2100 model)", {
    color: "#0284c7",
    weight: 1,
    fillColor: "#7dd3fc",
    fillOpacity: 0.12,
  }).then((overlay) => addOverlay(overlay, false));
fetchOverlay("data/flood_extent_2010.json", "Synthetic demo (not observed 2010 flooding)", {
    color: "#7c3aed",
    weight: 1,
    fillColor: "#a78bfa",
    fillOpacity: 0.2,
  }).then((overlay) => addOverlay(overlay, false));

// A separate pane makes the optional future outline readable on top of the
// baseline. It does NOT assert that either scenario contains the other.
map.createPane("officialFuture");
map.getPane("officialFuture").style.zIndex = 450;

const officialStatus = document.getElementById("official-status");
const retryOfficialData = document.getElementById("retry-official-data");
const datasetSources = document.getElementById("dataset-sources");
const officialLayers = new Map();
const officialStates = new Map();
let loadingOfficialData = false;

function sourceLink(label, href) {
  const a = document.createElement("a");
  a.textContent = label;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function updateOfficialStatus() {
  const names = { baseline: "Baseline (blue fill)", future_2100: "2100 scenario (orange outline)" };
  officialStatus.replaceChildren();
  for (const [id, name] of Object.entries(names)) {
    const line = document.createElement("p");
    const state = officialStates.get(id) || "loading";
    const layer = officialLayers.get(id);
    line.textContent = `${name}: ${state === "loaded" ? (map.hasLayer(layer) ? "loaded · shown" : "loaded · hidden") : state === "failed" ? "failed to load — not evidence of no flooding" : "loading…"}`;
    line.className = state === "failed" ? "data-error" : "data-state";
    officialStatus.appendChild(line);
  }
  addressPanel?.refresh();
}

function renderSources(manifest) {
  datasetSources.replaceChildren();
  manifest.datasets.forEach((dataset) => {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = dataset.label;
    section.appendChild(heading);
    const text = document.createElement("p");
    text.textContent = `${manifest.publisher}. Study date: ${dataset.study_date}. Scenario: ${dataset.modelling_scenario}. Recorded upstream limit: ${dataset.upstream_limits.join(", ") || "not provided"}.`;
    section.appendChild(text);
    section.appendChild(sourceLink("Official source", dataset.source_url));
    section.appendChild(document.createTextNode(" · "));
    section.appendChild(sourceLink("Source records", dataset.records_url));
    datasetSources.appendChild(section);
  });
  const snapshot = document.createElement("p");
  snapshot.textContent = `Local snapshot retrieved ${manifest.retrieved_at_utc.slice(0, 10)} (UTC). Not automatically updated.`;
  datasetSources.appendChild(snapshot);
}

function featureDetails(feature, dataset) {
  const container = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = dataset.label;
  container.appendChild(heading);
  const p = document.createElement("p");
  p.textContent = `Modelled extent · study ${dataset.study_date} · record ${feature.properties.OBJECTID}. Not a live warning or an address risk rating.`;
  container.appendChild(p);
  container.appendChild(sourceLink("Melbourne Water source record", dataset.records_url));
  return container;
}

async function loadOfficialData() {
  if (loadingOfficialData) return;
  loadingOfficialData = true;
  retryOfficialData.hidden = true;
  for (const id of ["baseline", "future_2100"]) {
    if (!officialLayers.has(id)) officialStates.set(id, "loading");
  }
  updateOfficialStatus();
  try {
    const manifest = FloodData.validateManifest(await FloodData.fetchJSON("data/official/manifest.json"));
    officialSnapshotDate = manifest.retrieved_at_utc;
    manifest.datasets.forEach((dataset) => officialMetadata.set(dataset.id, dataset));
    renderSources(manifest);
    await Promise.all(manifest.datasets.map(async (dataset) => {
      if (officialLayers.has(dataset.id)) return;
      try {
        const geojson = FloodData.validateExtent(await FloodData.fetchJSON(dataset.file), dataset);
        const prepared = AddressLookup.prepareCollection(geojson);
        const isBaseline = dataset.id === "baseline";
        const layer = L.geoJSON(geojson, {
          pane: isBaseline ? "overlayPane" : "officialFuture",
          style: isBaseline
            ? { color: "#1e40af", weight: 1.5, fillColor: "#2563eb", fillOpacity: 0.32 }
            : { color: "#b45309", weight: 2.5, dashArray: "7 4", fill: false },
          onEachFeature: (feature, featureLayer) => featureLayer.bindPopup(featureDetails(feature, dataset)),
        });
        officialLayers.set(dataset.id, layer);
        officialPrepared.set(dataset.id, prepared);
        officialStates.set(dataset.id, "loaded");
        layerControl.addOverlay(layer, dataset.label);
        if (isBaseline) layer.addTo(map);
      } catch (err) {
        console.error(`Official layer ${dataset.id} failed`, err);
        officialStates.set(dataset.id, "failed");
      }
      updateOfficialStatus();
    }));
  } catch (err) {
    console.error("Official source manifest failed", err);
    for (const id of ["baseline", "future_2100"]) {
      if (!officialLayers.has(id)) officialStates.set(id, "failed");
    }
    updateOfficialStatus();
  } finally {
    loadingOfficialData = false;
    retryOfficialData.hidden = ![...officialStates.values()].includes("failed");
  }
}

map.on("overlayadd overlayremove", updateOfficialStatus);
retryOfficialData.addEventListener("click", loadOfficialData);
loadOfficialData();

catchmentLayer.then((layer) => {
  if (layer) {
    catchmentBounds = layer.getBounds();
    if (!selectedLocation) map.fitBounds(catchmentBounds);
  }
});

// The endpoint is server-hosted configuration, so it can be replaced/disabled
// without changing the browser module. No geocoding occurs until submission.
let searchClient = null;
let searchGeneration = 0;
const searchClientReady = FloodData.fetchJSON("data/search-config.json")
  .then((config) => {
    if (config.enabled !== true) return null;
    if (typeof config.endpoint !== "string" || !config.endpoint.trim()) return null;
    searchClient = AddressSearch.createClient({
      endpoint: config.endpoint,
      minIntervalMs: config.minIntervalMs,
      timeoutMs: config.timeoutMs,
    });
    return searchClient;
  })
  .catch(() => null);

function recenterAddress(result) {
  map.setView([result.lat, result.lon], 17, { animate: false });
  // Keep the pin in the unobscured map area, including the mobile bottom sheet.
  const size = map.getSize();
  const panel = document.getElementById("address-panel");
  if (!panel.hidden) {
    if (size.x <= 640) map.panBy([0, panel.offsetHeight / 2], { animate: false });
    else map.panBy([panel.offsetWidth / 2, 0], { animate: false });
  }
}

addressPanel = AddressPanel.create({
  searchClient: {
    cancel() { searchGeneration += 1; searchClient?.cancel(); },
    async search(query, options) {
      const request = ++searchGeneration;
      const client = await searchClientReady;
      if (request !== searchGeneration) throw Object.assign(new Error("Search cancelled"), { code: "CANCELLED" });
      if (!client) throw Object.assign(new Error("Search unavailable"), { code: "REQUEST_FAILED" });
      return client.search(query, options);
    },
  },
  getViewbox: () => catchmentBounds
    ? [catchmentBounds.getWest(), catchmentBounds.getNorth(), catchmentBounds.getEast(), catchmentBounds.getSouth()]
    : undefined,
  getData: () => ({
    catchment: { state: catchmentState, prepared: catchmentPrepared },
    datasets: ["baseline", "future_2100"].map((id) => ({
      id,
      state: officialStates.get(id) || "loading",
      metadata: officialMetadata.get(id),
      prepared: officialPrepared.get(id),
      visible: officialLayers.has(id) && map.hasLayer(officialLayers.get(id)),
    })),
    retrievedAt: officialSnapshotDate,
  }),
  onOpen() {
    closeStoryPanel();
    if (map.getSize().x <= 640) layerControl.collapse();
  },
  onClear() {
    selectedLocation = null;
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = null;
  },
  onSelect(result) {
    selectedLocation = result;
    if (searchMarker) map.removeLayer(searchMarker);
    const popup = document.createElement("div");
    popup.textContent = "Selected geocoded point. See Address lookup for model matches and limitations.";
    searchMarker = L.marker([result.lat, result.lon], { title: "Selected address point" }).addTo(map).bindPopup(popup);
    recenterAddress(result);
  },
  onRecenter: recenterAddress,
  onShowLayer(id) {
    const layer = officialLayers.get(id);
    if (layer && !map.hasLayer(layer)) layer.addTo(map);
    updateOfficialStatus();
  },
  onRetry: loadOfficialData,
});

map.on("resize", () => {
  if (map.getSize().x <= 640) layerControl.collapse();
  else layerControl.expand();
  if (selectedLocation) recenterAddress(selectedLocation);
});

const cameraIcon = L.divIcon({
  className: "flood-marker",
  html:
    '<div class="flood-marker-badge flood-story-badge"><svg viewBox="0 0 24 24"><path d="M9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg></div>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const videoIcon = L.divIcon({
  className: "flood-marker",
  html: '<div class="flood-marker-badge flood-video-badge"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const storyPanel = document.getElementById("story-panel");
const storyPanelImage = document.getElementById("story-panel-image");
const storyPanelVideoWrapper = document.getElementById("story-panel-video-wrapper");
const storyPanelVideo = document.getElementById("story-panel-video");
const storyPanelTitle = document.getElementById("story-panel-title");
const storyPanelDescription = document.getElementById("story-panel-description");
const storyPanelCredit = document.getElementById("story-panel-credit");
const storyPanelLinks = document.getElementById("story-panel-links");

function openStoryPanel(story) {
  addressPanel?.close();
  storyPanelImage.style.display = story.image ? "" : "none";
  if (story.image) {
    storyPanelImage.src = story.image;
    storyPanelImage.alt = story.title;
  }

  storyPanelVideoWrapper.style.display = story.video ? "" : "none";
  storyPanelVideo.src = story.video
    ? `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(story.video.url)}&show_text=false`
    : "";

  storyPanelTitle.textContent = story.title;
  storyPanelDescription.textContent = story.description || "";

  storyPanelCredit.style.display = story.credit ? "" : "none";
  storyPanelCredit.textContent = story.credit || "";

  storyPanelLinks.innerHTML = "";
  (story.links || []).forEach(({ label, url }) => {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${label} →`;
    storyPanelLinks.appendChild(a);
  });

  storyPanel.classList.add("visible");
}

function closeStoryPanel() {
  storyPanel.classList.remove("visible");
  storyPanelVideo.src = "";
}

document.getElementById("story-panel-close").addEventListener("click", closeStoryPanel);

FloodData.fetchJSON("data/flood_stories.json")
  .then((stories) => {
    const floodStoriesLayer = L.markerClusterGroup();
    stories.forEach((story) => {
      floodStoriesLayer.addLayer(
        L.marker([story.lat, story.lng], { icon: story.video ? videoIcon : cameraIcon }).on("click", () =>
          openStoryPanel(story)
        )
      );
    });
    floodStoriesLayer.addTo(map);
    layerControl.addOverlay(floodStoriesLayer, "Historic flood stories");
  })
  .catch((err) => {
    console.error("Failed to load flood stories", err);
    reportLayerFailure("Historic flood stories");
  });
