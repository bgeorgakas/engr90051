const map = L.map("map");

const stadiaBase = L.tileLayer("https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=b73e5bd5-ccb6-4b14-92c5-69cd89becd8b", {
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; OpenStreetMap contributors',
}).addTo(map);

const baseLayers = {
  "Stadia Alidade Smooth": stadiaBase,
};

const layerControl = L.control.layers(baseLayers, {}, { collapsed: false }).addTo(map);

function loadOverlay(url, name, style) {
  return fetch(url)
    .then((res) => res.json())
    .then((geojson) => {
      const layer = L.geoJSON(geojson, { style }).addTo(map);
      layerControl.addOverlay(layer, name);
      return layer;
    })
    .catch((err) => console.error(`Failed to load overlay "${name}" from ${url}`, err));
}

const catchmentLayer = loadOverlay("data/elizabeth_street_catchment.geojson", "Elizabeth Street catchment", {
  color: "#111827",
  weight: 2,
  fill: false,
  dashArray: "6 4",
});

loadOverlay("data/sbo.geojson", "SBO", {
  color: "#0284c7",
  weight: 1,
  fillColor: "#7dd3fc",
  fillOpacity: 0.35,
});

let catchmentBounds = null;

catchmentLayer.then((layer) => {
  if (layer) {
    catchmentBounds = layer.getBounds();
    map.fitBounds(catchmentBounds);
  }
});

let searchMarker = null;
const addressSearchMessage = document.getElementById("address-search-message");

function showSearchMessage(text) {
  addressSearchMessage.textContent = text;
  addressSearchMessage.classList.add("visible");
}

function hideSearchMessage() {
  addressSearchMessage.classList.remove("visible");
}

document.getElementById("address-search").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.getElementById("address-search-input").value.trim();
  if (!query) return;

  hideSearchMessage();

  const params = new URLSearchParams({
    format: "json",
    limit: "1",
    countrycodes: "au",
    q: query,
  });
  if (catchmentBounds) {
    params.set(
      "viewbox",
      [
        catchmentBounds.getWest(),
        catchmentBounds.getNorth(),
        catchmentBounds.getEast(),
        catchmentBounds.getSouth(),
      ].join(",")
    );
  }

  fetch(`https://nominatim.openstreetmap.org/search?${params}`)
    .then((res) => res.json())
    .then((results) => {
      if (!results.length) {
        showSearchMessage(`No results found for "${query}"`);
        return;
      }

      const { lat, lon, display_name } = results[0];
      if (searchMarker) {
        map.removeLayer(searchMarker);
      }
      searchMarker = L.marker([lat, lon]).addTo(map).bindPopup(display_name).openPopup();
      map.setView([lat, lon], 17);
    })
    .catch(() => showSearchMessage("Address search failed — try again."));
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

fetch("data/flood_stories.json")
  .then((res) => res.json())
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
  .catch((err) => console.error("Failed to load flood stories", err));
