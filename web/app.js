const config = window.SAFE_CROSSING || { region: "us-east-1", apiKey: "" };

const COLORS = {
  amber: "#e6a23c",
  rust: "#e36a2c",
  red: "#d7263d",
  safe: "#74c69d",
  paper: "#f4f2ed",
  ink: "#0f1013",
};

// Only used if the Amazon Location style or its tiles cannot load (for example on a
// local preview, where the referrer-locked key is refused). OpenStreetMap tiles,
// inverted and desaturated to sit under the dark theme.
const FALLBACK_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#141519" } },
    {
      id: "osm",
      type: "raster",
      source: "osm",
      paint: {
        "raster-brightness-min": 0.92,
        "raster-brightness-max": 0.08,
        "raster-saturation": -1,
        "raster-hue-rotate": 180,
        "raster-contrast": 0.15,
        "raster-opacity": 0.85,
      },
    },
  ],
};

// A walk out along one side of a road and back along the other overlaps itself exactly;
// offsetting the line to the right of travel separates the two legs.
const ROUTE_OFFSET = ["interpolate", ["linear"], ["zoom"], 11, 1.5, 15, 4, 18, 6];
const CITY_BOUNDS = [[77.39, 12.77], [77.79, 13.27]];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmt = new Intl.NumberFormat("en-IN");

const state = {
  crossings: [],
  routes: new Map(),
  walks: [],
  rank: new Map(),
  selected: null,
  walkId: null,
  minArrivals: 400,
  namedOnly: false,
  query: "",
  layers: { gaps: true, blackspots: true, corridors: true },
  data: null,
};

const params = new URLSearchParams(location.search);
if (["400", "1000", "2000"].includes(params.get("arrivals"))) state.minArrivals = Number(params.get("arrivals"));
state.namedOnly = params.get("named") === "1";

const $ = (selector) => document.querySelector(selector);
const rankList = $("#rank");
const walkList = $("#walk-list");
const card = $("#card");
const namedOnly = $("#named-only");
const search = $("#search");
const mapMsg = $("#map-msg");
namedOnly.checked = state.namedOnly;
document.querySelectorAll("#min-arrivals button").forEach((button) => {
  button.classList.toggle("is-on", Number(button.dataset.value) === state.minArrivals);
});

// ---------- Formatting helpers ----------

function minutes(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function metres(value) {
  const m = Math.round(value);
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${fmt.format(m)} m`;
}

function cleanName(name) {
  return String(name || "").replace(/\bFLY\b/g, "Flyover");
}

function severity(extraMin) {
  const stops = [[3, [230, 162, 60]], [8, [227, 106, 44]], [15, [215, 38, 61]]];
  if (extraMin <= stops[0][0]) return rgb(stops[0][1]);
  for (let i = 1; i < stops.length; i += 1) {
    const [x1, c1] = stops[i];
    const [x0, c0] = stops[i - 1];
    if (extraMin <= x1) {
      const t = (extraMin - x0) / (x1 - x0);
      return rgb(c0.map((v, k) => v + (c1[k] - v) * t));
    }
  }
  return rgb(stops[stops.length - 1][1]);
}

function rgb(values) {
  return `rgb(${values.map((v) => Math.round(v)).join(",")})`;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

// ---------- Map ----------

let map = null;
let styleLoaded = false;
let usingFallback = !config.apiKey;
let routeAnim = 0;
let markers = [];
const popup = window.maplibregl
  ? new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip", offset: 12, maxWidth: "260px" })
  : null;

function styleUrl() {
  if (!config.apiKey) return null;
  return `https://maps.geo.${config.region}.amazonaws.com/v2/styles/Standard/descriptor?key=${config.apiKey}&color-scheme=Dark`;
}

function useFallbackStyle() {
  if (usingFallback || !map) return;
  usingFallback = true;
  console.warn("Safe Crossing: Amazon Location style did not load, using fallback basemap.");
  map.setStyle(FALLBACK_STYLE, { diff: false });
}

try {
  map = new maplibregl.Map({
    container: "map",
    style: styleUrl() || FALLBACK_STYLE,
    bounds: CITY_BOUNDS,
    fitBoundsOptions: { padding: 30 },
    attributionControl: { compact: true },
    maxZoom: 18,
    minZoom: 9,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
  map.addControl(new maplibregl.FullscreenControl(), "top-right");

  // Fall back if the Amazon style fails, or if its tiles are refused (for example a
  // referrer-locked key opened from another host) before any tile has loaded.
  let refusedTiles = 0;
  let tileLoaded = false;
  map.on("sourcedata", (event) => {
    if (event.tile && !["crossings", "blackspots", "corridors", "walks", "route", "gap"].includes(event.sourceId)) tileLoaded = true;
  });
  map.on("error", (event) => {
    const status = event && event.error && event.error.status;
    if (!styleLoaded && !usingFallback) {
      useFallbackStyle();
    } else if ((status === 401 || status === 403) && !tileLoaded && !usingFallback) {
      refusedTiles += 1;
      if (refusedTiles >= 3) useFallbackStyle();
    } else if (status !== 401 && status !== 403 && event && event.error) {
      console.warn("Map:", event.error.message || event.error);
    }
  });
  setTimeout(() => { if (!styleLoaded) useFallbackStyle(); }, 9000);

  map.on("style.load", () => {
    styleLoaded = true;
    ensureLayers();
  });
} catch (error) {
  console.error("Safe Crossing: the map could not start", error);
  mapMsg.hidden = false;
  mapMsg.replaceChildren(make("span", "loader", "This browser could not start the map (WebGL is off). The list still works."));
  mapMsg.querySelector(".loader").classList.remove("loader");
  map = null;
}

function padding() {
  const el = map.getContainer();
  const w = el.clientWidth;
  const h = el.clientHeight;
  const cardOpen = !card.hidden;
  let pad;
  if (window.matchMedia("(max-width: 860px)").matches) {
    // Stacked layout: the card is below the map, the legend is a small pill top-left.
    pad = { top: 56, bottom: 30, left: 30, right: 56 };
  } else {
    const legendBox = document.querySelector("#legend");
    const legendH = legendBox ? legendBox.offsetHeight : 0;
    pad = { top: 60, bottom: legendH + 40, left: 60, right: cardOpen ? card.offsetWidth + 70 : 70 };
  }
  // Keep at least a small window for the route.
  if (pad.top + pad.bottom > h - 80) pad.bottom = Math.max(20, h - 80 - pad.top);
  if (pad.left + pad.right > w - 80) pad.right = Math.max(20, w - 80 - pad.left);
  return pad;
}

function ensureLayers() {
  if (!map || !styleLoaded || !state.data || map.getSource("crossings")) return;
  const { crossings, blackspots, corridors } = state.data;

  map.addSource("corridors", { type: "geojson", data: corridors });
  map.addSource("crossings", { type: "geojson", data: crossings, promoteId: "id" });
  map.addSource("blackspots", { type: "geojson", data: blackspots });
  map.addSource("walks", { type: "geojson", data: emptyCollection() });
  map.addSource("route", { type: "geojson", data: emptyCollection(), lineMetrics: true });
  map.addSource("gap", { type: "geojson", data: emptyCollection() });

  const sev = ["interpolate", ["linear"], ["get", "extraMin"], 3, COLORS.amber, 8, COLORS.rust, 15, COLORS.red];
  const radius = (k) => [
    "interpolate", ["linear"], ["zoom"],
    10, ["interpolate", ["linear"], ["get", "arrivals"], 400, 3.5 * k, 1500, 6 * k, 5000, 11 * k],
    15, ["interpolate", ["linear"], ["get", "arrivals"], 400, 7 * k, 1500, 11 * k, 5000, 19 * k],
  ];

  map.addLayer({
    id: "corridors-glow", type: "line", source: "corridors",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.red, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 8, 15, 18], "line-opacity": 0.22, "line-blur": 6 },
  });
  map.addLayer({
    id: "corridors", type: "line", source: "corridors",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ff5a6e", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 4], "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "crossings-halo", type: "circle", source: "crossings",
    paint: { "circle-radius": radius(2.1), "circle-color": sev, "circle-opacity": 0.16, "circle-blur": 0.6 },
  });
  map.addLayer({
    id: "crossings", type: "circle", source: "crossings",
    paint: {
      "circle-radius": radius(1),
      "circle-color": sev,
      "circle-stroke-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.5, 1.2],
      "circle-stroke-color": ["case", ["boolean", ["feature-state", "hover"], false], COLORS.paper, COLORS.ink],
      "circle-opacity": 0.95,
    },
  });
  map.addLayer({
    id: "walk-avoid", type: "line", source: "walks",
    filter: ["==", ["get", "variant"], "avoid"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.safe, "line-width": 5 },
  });
  map.addLayer({
    id: "walk-short", type: "line", source: "walks",
    filter: ["==", ["get", "variant"], "shortest"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.red, "line-width": 4, "line-dasharray": [1, 1.4] },
  });
  map.addLayer({
    id: "route-casing", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.ink, "line-width": 10, "line-opacity": 0.85, "line-offset": ROUTE_OFFSET },
  });
  map.addLayer({
    id: "route-line", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-width": 5,
      "line-offset": ROUTE_OFFSET,
      "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, COLORS.amber, 1, COLORS.red],
    },
  });
  map.addLayer({
    id: "gap-line", type: "line", source: "gap",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": COLORS.paper, "line-width": 2.5, "line-dasharray": [1, 1.5] },
  });
  map.addLayer({
    id: "blackspots-ring", type: "circle", source: "blackspots",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 6, 15, 11],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 2.5,
      "circle-stroke-color": COLORS.red,
    },
  });
  map.addLayer({
    id: "blackspots", type: "circle", source: "blackspots",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 4.5], "circle-color": COLORS.paper },
  });

  applyFilter();
  applyLayerVisibility();
  const firstTime = !map.__safeCrossingReady;
  if (firstTime) {
    map.__safeCrossingReady = true;
    bindMapEvents();
  }
  // Draw a selection made before the layers existed (a shared link), or redraw after a style swap.
  if (state.selected) drawCrossingRoute(state.selected, firstTime);
  if (state.walkId) drawWalk(state.walkId, firstTime);
  mapMsg.hidden = true;
}

function bindMapEvents() {
  let hovered = null;
  const setHover = (id) => {
    if (hovered !== null) map.setFeatureState({ source: "crossings", id: hovered }, { hover: false });
    hovered = id;
    if (id !== null) map.setFeatureState({ source: "crossings", id }, { hover: true });
  };

  map.on("mousemove", "crossings", (event) => {
    const feature = event.features && event.features[0];
    if (!feature) return;
    map.getCanvas().style.cursor = "pointer";
    setHover(feature.properties.id);
    const p = feature.properties;
    const box = make("div");
    box.append(
      make("b", "", `#${state.rank.get(p.id)} ${cleanName(p.name)}`),
      make("span", "", `${Math.round(p.straightM)} m apart → ${metres(p.walkM)} on foot`),
      make("span", "hot", `+${minutes(p.extraMin)} min · ${fmt.format(p.arrivals)} buses a day`),
    );
    popup.setLngLat(feature.geometry.coordinates).setDOMContent(box).addTo(map);
  });
  map.on("mouseleave", "crossings", () => {
    map.getCanvas().style.cursor = "";
    setHover(null);
    popup.remove();
  });
  map.on("click", "crossings", (event) => {
    const feature = event.features && event.features[0];
    if (feature) {
      popup.remove();
      showCrossing(feature.properties.id, { fly: true });
    }
  });

  const placeTip = (layer, describe) => {
    const show = (event) => {
      if (map.queryRenderedFeatures(event.point, { layers: ["crossings"] }).length) return;
      const feature = event.features && event.features[0];
      if (!feature) return;
      map.getCanvas().style.cursor = "help";
      popup.setLngLat(event.lngLat).setDOMContent(describe(feature.properties)).addTo(map);
    };
    map.on("mousemove", layer, show);
    map.on("click", layer, show);
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });
  };
  map.on("click", (event) => {
    const hit = map.queryRenderedFeatures(event.point, { layers: ["crossings", "blackspots-ring", "corridors-glow"] });
    if (!hit.length) popup.remove();
  });

  placeTip("blackspots-ring", (p) => {
    const box = make("div");
    box.append(
      make("b", "", p.name),
      make("span", "", `Police-named high-risk location · ${p.road}`),
    );
    if (p.fatalities) box.append(make("span", "hot", `${p.fatalities} fatalities, 2021–2023`));
    return box;
  });
  placeTip("corridors-glow", (p) => {
    const box = make("div");
    box.append(
      make("b", "", p.name),
      make("span", "", `High-risk corridor · ${p.road}${p.length_km ? ` · ${p.length_km} km` : ""}`),
    );
    if (p.fatalities) box.append(make("span", "hot", `${p.fatalities} fatalities, 2021–2023`));
    return box;
  });
}

function applyLayerVisibility() {
  if (!map || !map.getLayer("crossings")) return;
  const groups = {
    gaps: ["crossings-halo", "crossings"],
    blackspots: ["blackspots-ring", "blackspots"],
    corridors: ["corridors-glow", "corridors"],
  };
  for (const [key, ids] of Object.entries(groups)) {
    for (const id of ids) map.setLayoutProperty(id, "visibility", state.layers[key] ? "visible" : "none");
  }
}

function dimOthers(activeId) {
  if (!map || !map.getLayer("crossings")) return;
  const opacity = activeId ? ["case", ["==", ["get", "id"], activeId], 1, 0.35] : 0.95;
  map.setPaintProperty("crossings", "circle-opacity", opacity);
  map.setPaintProperty("crossings-halo", "circle-opacity", activeId ? ["case", ["==", ["get", "id"], activeId], 0.3, 0.06] : 0.16);
}

function clearMarkers() {
  for (const marker of markers) marker.remove();
  markers = [];
}

function addPins(a, b, label) {
  clearMarkers();
  if (!map) return;
  const pin = (text, cls, lngLat, offset) => {
    const el = make("div", `stop-pin ${cls}`, text);
    el.setAttribute("aria-hidden", "true");
    markers.push(new maplibregl.Marker({ element: el, offset }).setLngLat(lngLat).addTo(map));
  };
  pin("A", "a", a, [-14, -14]);
  pin("B", "b", b, [14, 14]);
  if (label) {
    const el = make("div", "gap-label", label);
    markers.push(
      new maplibregl.Marker({ element: el, anchor: "bottom-left", offset: [20, -20] })
        .setLngLat([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
        .addTo(map),
    );
  }
}

function setGap(a, b) {
  map.getSource("gap").setData({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [a, b] } }],
  });
}

function animateRoute(coords) {
  cancelAnimationFrame(routeAnim);
  const source = map.getSource("route");
  const total = coords.length;
  const duration = reduceMotion ? 0 : Math.min(1800, 500 + total * 10);
  const set = (list) => source.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: list } });
  if (!duration) { set(coords); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    set(coords.slice(0, Math.max(2, Math.ceil(eased * total))));
    if (t < 1) routeAnim = requestAnimationFrame(step);
  };
  routeAnim = requestAnimationFrame(step);
}

function afterMove(callback) {
  let done = false;
  const run = () => { if (!done) { done = true; callback(); } };
  map.once("moveend", run);
  setTimeout(run, 1600);
}

function clearMapSelection() {
  if (!map || !map.getSource("route")) return;
  cancelAnimationFrame(routeAnim);
  map.getSource("route").setData(emptyCollection());
  map.getSource("gap").setData(emptyCollection());
  map.getSource("walks").setData(emptyCollection());
  clearMarkers();
  dimOthers(null);
}

function drawCrossingRoute(id, fly) {
  if (!map || !map.getSource("route")) return;
  const feature = state.crossings.find((item) => item.properties.id === id);
  if (!feature) return;
  const route = state.routes.get(id);
  map.getSource("walks").setData(emptyCollection());
  cancelAnimationFrame(routeAnim);
  map.getSource("route").setData(emptyCollection());
  dimOthers(id);
  const p = feature.properties;
  const a = route ? route.properties.a : feature.geometry.coordinates;
  const b = route ? route.properties.b : feature.geometry.coordinates;
  setGap(a, b);
  addPins(a, b, `${Math.round(p.straightM)} m across`);
  if (!route) {
    if (fly) map.flyTo({ center: feature.geometry.coordinates, zoom: 16, padding: padding() });
    return;
  }
  const coords = route.geometry.coordinates;
  if (fly) {
    const bounds = new maplibregl.LngLatBounds();
    for (const c of coords) bounds.extend(c);
    bounds.extend(a).extend(b);
    map.fitBounds(bounds, { padding: padding(), maxZoom: 17, duration: reduceMotion ? 0 : 1400 });
    afterMove(() => { if (state.selected === id) animateRoute(coords); });
  } else {
    animateRoute(coords);
  }
}

function drawWalk(id, fly) {
  if (!map || !map.getSource("walks")) return;
  const walk = state.walks.find((item) => item.id === id);
  if (!walk) return;
  cancelAnimationFrame(routeAnim);
  map.getSource("route").setData(emptyCollection());
  map.getSource("gap").setData(emptyCollection());
  dimOthers("__none__");
  const features = [walk.lines.shortest, walk.lines.avoid].filter(Boolean);
  map.getSource("walks").setData({ type: "FeatureCollection", features });
  const short = walk.lines.shortest.properties;
  const a = short.origin || walk.lines.shortest.geometry.coordinates[0];
  const b = short.destination || walk.lines.shortest.geometry.coordinates.at(-1);
  addPins(a, b, null);
  if (fly) {
    const bounds = new maplibregl.LngLatBounds();
    for (const feature of features) for (const coord of feature.geometry.coordinates) bounds.extend(coord);
    map.fitBounds(bounds, { padding: padding(), maxZoom: 17, duration: reduceMotion ? 0 : 1400 });
  }
}

// ---------- Data ----------

const getJSON = (url) => fetch(url).then((response) => {
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
});

Promise.all([
  getJSON("data/crossings.geojson"),
  getJSON("data/blackspots.geojson"),
  getJSON("data/corridors.geojson"),
  getJSON("data/walks.geojson"),
  getJSON("data/summary.json").catch(() => ({})),
  getJSON("data/routes.geojson").catch(() => emptyCollection()),
])
  .then(([crossings, blackspots, corridors, walks, summary, routes]) => {
    const sorted = [...crossings.features].sort((x, y) => y.properties.impact - x.properties.impact);
    sorted.forEach((feature, index) => state.rank.set(feature.properties.id, index + 1));
    state.crossings = sorted;
    state.routes = new Map(routes.features.map((feature) => [feature.properties.id, feature]));
    state.walks = groupWalks(walks);
    state.data = { crossings, blackspots, corridors };
    renderStats(summary);
    renderList();
    renderWalks();
    openFromUrl();
    ensureLayers();
  })
  .catch((error) => {
    console.error("Safe Crossing: data failed to load", error);
    rankList.replaceChildren(make("li", "empty", "The crossings could not be loaded. Try reloading the page."));
  });

function openFromUrl() {
  const requestedWalk = params.get("walk");
  const requested = params.get("crossing");
  if (requestedWalk) showWalk(requestedWalk);
  else if (requested) showCrossing(requested, { fly: true, scrollList: true });
}

function groupWalks(collection) {
  const groups = new Map();
  for (const feature of collection.features || []) {
    const id = feature.properties.walk_id;
    if (!groups.has(id)) groups.set(id, { id, props: feature.properties, lines: {} });
    groups.get(id).lines[feature.properties.variant] = feature;
  }
  return [...groups.values()].filter((walk) => walk.lines.shortest && walk.lines.avoid);
}

function renderStats(summary) {
  const values = [
    [summary.gaps, "stop pairs with a long crossing"],
    [summary.namedGaps, "near a police blackspot"],
    [summary.pedestrians2023, "pedestrians killed, 2023"],
  ];
  document.querySelectorAll("#stats .stat").forEach((node, index) => {
    const [value] = values[index];
    if (value !== undefined && value !== null) node.querySelector("b").textContent = fmt.format(value);
  });
}

// ---------- Sidebar ----------

function matches(props) {
  if (props.arrivals < state.minArrivals) return false;
  if (state.namedOnly && !props.blackspot) return false;
  if (state.query) {
    // Ignore "(Towards X)" in stop descriptions, or a search for X matches every stop facing it.
    const desc = (text) => String(text || "").replace(/\(towards[^)]*\)/gi, "");
    const haystack = [props.name, desc(props.descA), desc(props.descB), props.blackspot, props.blackspotRoad].join(" ").toLowerCase();
    if (!haystack.includes(state.query)) return false;
  }
  return true;
}

function filtered() {
  return state.crossings.filter((feature) => matches(feature.properties));
}

function renderList() {
  const rows = filtered();
  rankList.replaceChildren();
  $("#count-list").textContent = rows.length;
  $("#list-count").textContent = `${rows.length} of ${state.crossings.length}`;
  for (const feature of rows) {
    const p = feature.properties;
    const color = severity(p.extraMin);
    const item = make("li");
    const button = make("button", "row" + (p.id === state.selected ? " is-on" : ""));
    button.type = "button";
    button.dataset.id = p.id;
    button.style.setProperty("--sev", color);
    const rank = make("span", "rank", String(state.rank.get(p.id)));
    const main = make("span", "row-main");
    const top = make("span", "row-top");
    top.append(make("b", "", cleanName(p.name)), make("span", "plus", `+${minutes(p.extraMin)} min`));
    const meta = make("small");
    meta.append(
      make("b", "", `${Math.round(p.straightM)} m`), " apart → ",
      make("b", "", metres(p.walkM)), ` walk · ${fmt.format(p.arrivals)} buses`,
    );
    main.append(top, meta);
    if (p.blackspot) main.append(make("span", "tag danger", p.blackspot));
    button.append(rank, main);
    button.addEventListener("click", () => showCrossing(p.id, { fly: true }));
    item.append(button);
    rankList.append(item);
  }
  if (!rows.length) {
    rankList.append(make("li", "empty", "No stops match these filters."));
  }
}

function miniWalkSvg(walk) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 54 54");
  svg.setAttribute("aria-hidden", "true");
  const all = [...walk.lines.shortest.geometry.coordinates, ...walk.lines.avoid.geometry.coordinates];
  const lat0 = all.reduce((sum, c) => sum + c[1], 0) / all.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = all.map((c) => c[0] * k);
  const ys = all.map((c) => c[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(42 / Math.max(maxX - minX, 1e-6), 42 / Math.max(maxY - minY, 1e-6));
  const ox = (54 - (maxX - minX) * scale) / 2;
  const oy = (54 - (maxY - minY) * scale) / 2;
  const d = (coords) => coords.map((c, i) => `${i ? "L" : "M"}${(ox + (c[0] * k - minX) * scale).toFixed(1)} ${(oy + (maxY - c[1]) * scale).toFixed(1)}`).join("");
  const add = (attrs) => {
    const path = document.createElementNS(ns, "path");
    for (const [key, value] of Object.entries(attrs)) path.setAttribute(key, value);
    svg.append(path);
  };
  add({ d: d(walk.lines.avoid.geometry.coordinates), fill: "none", stroke: COLORS.safe, "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" });
  add({ d: d(walk.lines.shortest.geometry.coordinates), fill: "none", stroke: COLORS.red, "stroke-width": 2.2, "stroke-dasharray": "2 2" });
  return svg;
}

function renderWalks() {
  walkList.replaceChildren();
  if (!state.walks.length) {
    walkList.append(make("li", "empty", "No corridor walks were precomputed."));
    return;
  }
  for (const walk of state.walks) {
    const short = walk.lines.shortest.properties;
    const avoid = walk.lines.avoid.properties;
    const extra = Math.max(0, avoid.duration_s - short.duration_s);
    const item = make("li");
    const button = make("button", "walk" + (walk.id === state.walkId ? " is-on" : ""));
    button.type = "button";
    const thumb = make("span", "walk-mini");
    thumb.append(miniWalkSvg(walk));
    const text = make("span");
    text.append(
      make("b", "", short.title),
      make("small", "", `${Math.round(short.distance_m)} m direct · ${fmt.format(Math.round(avoid.distance_m))} m staying off ${short.road} · +${minutes(extra / 60)} min`),
    );
    button.append(thumb, text);
    button.addEventListener("click", () => showWalk(walk.id));
    item.append(button);
    walkList.append(item);
  }
}

function markActiveRow() {
  rankList.querySelectorAll(".row").forEach((row) => row.classList.toggle("is-on", row.dataset.id === state.selected));
}

// ---------- Selection ----------

function showCrossing(id, { fly = true, scrollList = false } = {}) {
  const feature = state.crossings.find((item) => item.properties.id === id);
  if (!feature) return;
  state.selected = id;
  state.walkId = null;
  writeCard(feature.properties);
  setQuery({ crossing: id });
  markActiveRow();
  renderWalks();
  if (scrollList) {
    const row = rankList.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: "center" });
  }
  if (window.innerWidth <= 860) window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  drawCrossingRoute(id, fly);
}

function showWalk(id) {
  const walk = state.walks.find((item) => item.id === id);
  if (!walk) return;
  state.walkId = id;
  state.selected = null;
  selectTab("walks");
  writeWalkCard(walk);
  setQuery({ walk: id });
  markActiveRow();
  renderWalks();
  if (window.innerWidth <= 860) window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  drawWalk(id, true);
}

function closeCard() {
  state.selected = null;
  state.walkId = null;
  card.hidden = true;
  card.replaceChildren();
  clearMapSelection();
  setQuery({});
  markActiveRow();
  renderWalks();
}

function cardTop(tags) {
  const top = make("div", "card-top");
  const left = make("div");
  left.style.display = "flex";
  left.style.gap = "6px";
  left.style.flexWrap = "wrap";
  left.append(...tags);
  const close = make("button", "card-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closeCard);
  top.append(left, close);
  return top;
}

function cardActions(zoom) {
  const actions = make("div", "card-actions");
  const share = make("button", "primary", "Copy link");
  share.type = "button";
  share.addEventListener("click", () => copyLink(share));
  const zoomButton = make("button", "", "Zoom to walk");
  zoomButton.type = "button";
  zoomButton.addEventListener("click", zoom);
  actions.append(share, zoomButton);
  return actions;
}

function copyLink(button) {
  const done = () => {
    button.textContent = "Link copied";
    toast("Link copied. It reopens this exact view.");
    setTimeout(() => { button.textContent = "Copy link"; }, 1800);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(location.href).then(done, () => toast(location.href));
  } else {
    toast(location.href);
  }
}

let toastTimer = 0;
function toast(text) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = make("div", "toast");
    node.setAttribute("role", "status");
    document.querySelector(".page-map main").append(node);
  }
  node.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2400);
}

function compareRow(label, value, pct, color) {
  const row = make("div", "compare-row");
  const bar = make("div", "bar");
  const fill = make("i");
  fill.style.width = `${Math.max(1.5, pct)}%`;
  fill.style.background = color;
  bar.append(fill);
  row.append(make("span", "", label), bar, make("b", "", value));
  return row;
}

function fact(value, label) {
  const node = make("div", "fact");
  node.append(make("b", "", value), make("span", "", label));
  return node;
}

function writeCard(p) {
  card.hidden = false;
  card.replaceChildren();
  const color = severity(p.extraMin);
  const rankTag = make("span", "tag", `#${state.rank.get(p.id)} of ${state.crossings.length}`);
  const tags = [rankTag];
  if (p.blackspot) tags.push(make("span", "tag danger", "Near a blackspot"));
  const title = make("h2", "", cleanName(p.name));
  const sub = make("p", "sub", `${fmt.format(p.arrivals)} scheduled bus arrivals a day`);

  const compare = make("div", "compare");
  compare.append(
    compareRow("Across the road", `${Math.round(p.straightM)} m`, (p.straightM / p.walkM) * 100, COLORS.amber),
    compareRow("Walking route", metres(p.walkM), 100, color),
  );

  const facts = make("div", "facts");
  facts.append(
    fact(`+${minutes(p.extraMin)}`, "minutes on foot"),
    fact(`${Math.round(p.walkM / Math.max(p.straightM, 1))}×`, "the straight line"),
    fact(fmt.format(p.arrivals), "buses a day"),
  );

  card.append(cardTop(tags), title, sub, compare, facts);

  if (p.blackspot) {
    const alert = make("div", "alert");
    alert.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
    const text = make("div");
    text.append("Within 500 m of ", make("b", "", p.blackspot), ` on ${p.blackspotRoad || "a named high-risk road"}.`);
    if (p.blackspotFatalities) text.append(` ${p.blackspotFatalities} fatalities, 2021–2023.`);
    alert.append(text);
    card.append(alert);
  }

  const sides = make("ul", "sides");
  [["A", "a", p.descA], ["B", "b", p.descB]].forEach(([label, cls, desc]) => {
    if (!desc) return;
    const li = make("li");
    li.append(make("span", `ab ${cls}`, label), make("span", "", desc));
    sides.append(li);
  });
  card.append(sides);
  card.append(cardActions(() => drawCrossingRoute(p.id, true)));
  const note = state.routes.has(p.id)
    ? "Pedestrian route from Amazon Location Routes. A long walk can also mean the walking map is missing a crossing that exists."
    : "A long walk can also mean the walking map is missing a crossing that exists.";
  card.append(make("p", "card-note", note));
}

function writeWalkCard(walk) {
  const short = walk.lines.shortest.properties;
  const avoid = walk.lines.avoid.properties;
  card.hidden = false;
  card.replaceChildren();
  const tags = [make("span", "tag", `Corridor walk · ${short.road}`)];
  if (short.fatalities) tags.push(make("span", "tag danger", `${short.fatalities} fatalities, 2021–23`));
  const title = make("h2", "", short.title);
  const sub = make("p", "sub", short.corridor);

  const keys = make("div", "walk-keys");
  const key = (cls, label, value) => {
    const row = make("div", "walk-key");
    const line = make("i", cls);
    row.append(line, make("span", "", label), make("b", "", value));
    return row;
  };
  keys.append(
    key("key-line direct", "Direct walk", `${fmt.format(Math.round(short.distance_m))} m`),
    key("key-line", `Stays off ${short.road}`, `${fmt.format(Math.round(avoid.distance_m))} m`),
  );

  const extra = Math.max(0, avoid.duration_s - short.duration_s);
  const facts = make("div", "facts");
  facts.append(
    fact(`+${minutes(extra / 60)}`, "minutes to stay safe"),
    fact(`${(avoid.distance_m / Math.max(short.distance_m, 1)).toFixed(1)}×`, "the direct walk"),
    fact(fmt.format(short.arrivals), "buses a day"),
  );

  const sides = make("ul", "sides");
  [["A", "a", short.desc_a], ["B", "b", short.desc_b]].forEach(([label, cls, desc]) => {
    if (!desc) return;
    const li = make("li");
    li.append(make("span", `ab ${cls}`, label), make("span", "", desc));
    sides.append(li);
  });

  card.append(cardTop(tags), title, sub, keys, facts, sides, cardActions(() => drawWalk(walk.id, true)));
  card.append(make("p", "card-note", "Both walks from Amazon Location Routes. The green one passes the corridor as an avoid area."));
}

function setQuery(entries) {
  const next = new URLSearchParams();
  if (state.minArrivals !== 400) next.set("arrivals", String(state.minArrivals));
  if (state.namedOnly) next.set("named", "1");
  for (const [key, value] of Object.entries(entries)) next.set(key, value);
  const query = next.toString();
  history.replaceState(null, "", query ? `${location.pathname}?${query}` : location.pathname);
}

function currentEntry() {
  if (state.selected) return { crossing: state.selected };
  if (state.walkId) return { walk: state.walkId };
  return {};
}

function applyFilter() {
  renderList();
  if (!map || !map.getLayer("crossings")) return;
  const ids = filtered().map((feature) => feature.properties.id);
  if (state.selected && !ids.includes(state.selected)) ids.push(state.selected);
  const expression = ["in", ["get", "id"], ["literal", ids]];
  map.setFilter("crossings", expression);
  map.setFilter("crossings-halo", expression);
}

// ---------- Controls ----------

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((item) => {
    const on = item.dataset.tab === name;
    item.classList.toggle("is-on", on);
    item.setAttribute("aria-selected", on ? "true" : "false");
  });
  $("#panel-list").hidden = name !== "list";
  $("#panel-walks").hidden = name !== "walks";
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

document.querySelectorAll("#min-arrivals button").forEach((button) => {
  button.addEventListener("click", () => {
    state.minArrivals = Number(button.dataset.value);
    document.querySelectorAll("#min-arrivals button").forEach((item) => item.classList.toggle("is-on", item === button));
    applyFilter();
    setQuery(currentEntry());
  });
});

namedOnly.addEventListener("change", () => {
  state.namedOnly = namedOnly.checked;
  applyFilter();
  setQuery(currentEntry());
});

let searchTimer = 0;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = search.value.trim().toLowerCase();
    applyFilter();
  }, 120);
});

document.querySelectorAll("[data-layer]").forEach((input) => {
  input.addEventListener("change", () => {
    state.layers[input.dataset.layer] = input.checked;
    applyLayerVisibility();
  });
});

const legend = $("#legend");
legend.querySelector(".legend-toggle").addEventListener("click", (event) => {
  const open = legend.classList.toggle("is-open");
  event.currentTarget.setAttribute("aria-expanded", open ? "true" : "false");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !card.hidden) closeCard();
});
