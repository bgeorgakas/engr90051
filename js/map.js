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
const prototypePrepared = new Map();

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

// Restore the original three prototype layers, in their original draw order.
// Their legacy names are retained; the persistent notices explain their data types.
const prototypeDatasets = PrototypeData.DATASETS;
const prototypeStyles = [
  { color: "#0284c7", weight: 1, fillColor: "#7dd3fc", fillOpacity: 0.35 },
  { color: "#7c3aed", weight: 1, fillColor: "#a78bfa", fillOpacity: 0.4 },
  { color: "#1e3a8a", weight: 1, fillColor: "#1d4ed8", fillOpacity: 0.45 },
];
prototypeDatasets.forEach((dataset, index) => {
  map.createPane(dataset.id);
  map.getPane(dataset.id).style.zIndex = 410 + index * 10;
});

const layerStatus = document.getElementById("layer-status");
const retryLayerData = document.getElementById("retry-layer-data");
const datasetSources = document.getElementById("dataset-sources");
const prototypeLayers = new Map();
const prototypeStates = new Map();
let loadingPrototypeData = false;

function sourceLink(label, href) {
  const a = document.createElement("a");
  a.textContent = label;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function updateLayerStatus() {
  layerStatus.replaceChildren();
  for (const { id, label } of prototypeDatasets) {
    const line = document.createElement("p");
    const state = prototypeStates.get(id) || "loading";
    const layer = prototypeLayers.get(id);
    line.textContent = `${label}: ${state === "loaded" ? (map.hasLayer(layer) ? "loaded · shown" : "loaded · hidden") : state === "failed" ? "failed to load — not evidence of no flooding" : "loading…"}`;
    line.className = state === "failed" ? "data-error" : "data-state";
    layerStatus.appendChild(line);
  }
  addressPanel?.refresh();
}

function renderSources() {
  datasetSources.replaceChildren();
  prototypeDatasets.forEach((dataset) => {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = dataset.label;
    section.appendChild(heading);
    const text = document.createElement("p");
    text.textContent = dataset.description;
    section.appendChild(text);
    section.appendChild(sourceLink("Layer data", dataset.file));
    section.appendChild(document.createTextNode(" · "));
    section.appendChild(sourceLink("How this layer was made", dataset.source_url));
    datasetSources.appendChild(section);
  });
}

function featureDetails(dataset) {
  const container = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = dataset.label;
  container.appendChild(heading);
  const p = document.createElement("p");
  p.textContent = dataset.description;
  container.appendChild(p);
  container.appendChild(sourceLink("How this layer was made", dataset.source_url));
  return container;
}

function syncPrototypeControls() {
  for (const layer of prototypeLayers.values()) layerControl.removeLayer(layer);
  for (const dataset of prototypeDatasets) {
    const layer = prototypeLayers.get(dataset.id);
    if (layer) layerControl.addOverlay(layer, dataset.label);
  }
}

async function loadPrototypeData() {
  if (loadingPrototypeData) return;
  loadingPrototypeData = true;
  retryLayerData.hidden = true;
  for (const { id } of prototypeDatasets) {
    if (!prototypeLayers.has(id)) prototypeStates.set(id, "loading");
  }
  updateLayerStatus();
  try {
    await Promise.all(prototypeDatasets.map(async (dataset, index) => {
      if (prototypeLayers.has(dataset.id)) return;
      try {
        const geojson = PrototypeData.validateExtent(await FloodData.fetchJSON(dataset.file), dataset);
        const prepared = AddressLookup.prepareCollection(geojson);
        const layer = L.geoJSON(geojson, {
          pane: dataset.id,
          style: prototypeStyles[index],
          onEachFeature: (_feature, featureLayer) => featureLayer.bindPopup(featureDetails(dataset)),
        });
        prototypeLayers.set(dataset.id, layer);
        prototypePrepared.set(dataset.id, prepared);
        prototypeStates.set(dataset.id, "loaded");
        syncPrototypeControls();
        layer.addTo(map);
      } catch (err) {
        console.error(`Prototype layer ${dataset.id} failed`, err);
        prototypeStates.set(dataset.id, "failed");
      }
      updateLayerStatus();
    }));
  } finally {
    loadingPrototypeData = false;
    retryLayerData.hidden = ![...prototypeStates.values()].includes("failed");
  }
}

renderSources();
map.on("overlayadd overlayremove", updateLayerStatus);
retryLayerData.addEventListener("click", loadPrototypeData);
loadPrototypeData();

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
    datasets: prototypeDatasets.map((metadata) => ({
      id: metadata.id,
      state: prototypeStates.get(metadata.id) || "loading",
      metadata,
      prepared: prototypePrepared.get(metadata.id),
      visible: prototypeLayers.has(metadata.id) && map.hasLayer(prototypeLayers.get(metadata.id)),
    })),
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
    popup.textContent = "Selected geocoded point. See Address lookup for prototype layer matches, not a flood-risk assessment.";
    searchMarker = L.marker([result.lat, result.lon], { title: "Selected address point" }).addTo(map).bindPopup(popup);
    recenterAddress(result);
  },
  onRecenter: recenterAddress,
  onShowLayer(id) {
    const layer = prototypeLayers.get(id);
    if (layer && !map.hasLayer(layer)) layer.addTo(map);
    updateLayerStatus();
  },
  onRetry: loadPrototypeData,
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
