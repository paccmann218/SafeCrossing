// Landing page: draws real route geometry as SVG. No map tiles, no API calls.

const SVG_NS = "http://www.w3.org/2000/svg";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmt = new Intl.NumberFormat("en-IN");

const nav = document.querySelector("#nav");
const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

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

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.append(node);
  return node;
}

// Equirectangular projection of a set of lon/lat points into a box, aspect preserved.
function projector(points, width, height, pad) {
  const lat0 = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [lon, lat] of points) {
    const x = lon * k;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, lat); maxY = Math.max(maxY, lat);
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const ox = (width - spanX * scale) / 2;
  const oy = (height - spanY * scale) / 2;
  return ([lon, lat]) => [ox + (lon * k - minX) * scale, oy + (maxY - lat) * scale];
}

function pathData(coords, project) {
  return coords
    .map((c, i) => {
      const [x, y] = project(c);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("");
}

// Thin a projected polyline so pixel-level noise does not create spurious joins.
function thin(points, minGap) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= minGap) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// Offset a pixel-space polyline to the right of its direction of travel. A walk that goes
// out along one side of a road and back along the other becomes a visible hairpin.
function offsetLine(points, d) {
  const n = points.length;
  if (n < 2) return points;
  const normals = [];
  const tangents = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const len = Math.hypot(dx, dy) || 1;
    tangents.push([dx / len, dy / len]);
    normals.push([-dy / len, dx / len]);
  }
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const [x, y] = points[i];
    if (i === 0 || i === n - 1) {
      const nm = normals[i === 0 ? 0 : n - 2];
      out.push([x + nm[0] * d, y + nm[1] * d]);
      continue;
    }
    const n1 = normals[i - 1];
    const n2 = normals[i];
    const dot = n1[0] * n2[0] + n1[1] * n2[1];
    if (dot < -0.2) {
      // Sharp turn: sweep an arc around the vertex through the incoming direction.
      const t1 = tangents[i - 1];
      const a1 = Math.atan2(n1[1], n1[0]);
      const a2 = Math.atan2(n2[1], n2[0]);
      const dir = n1[0] * t1[1] - n1[1] * t1[0] > 0 ? 1 : -1;
      let sweep = a2 - a1;
      if (dir > 0) { while (sweep <= 0) sweep += Math.PI * 2; } else { while (sweep >= 0) sweep -= Math.PI * 2; }
      if (Math.abs(sweep) <= Math.PI + 0.35) {
        for (let k = 0; k <= 8; k += 1) {
          const a = a1 + (sweep * k) / 8;
          out.push([x + Math.cos(a) * d, y + Math.sin(a) * d]);
        }
      } else {
        out.push([x + n1[0] * d, y + n1[1] * d], [x + n2[0] * d, y + n2[1] * d]);
      }
      continue;
    }
    const mx = n1[0] + n2[0];
    const my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my) || 1;
    const cos = Math.max(0.5, (mx / ml) * n1[0] + (my / ml) * n1[1]);
    out.push([x + (mx / ml) * (d / cos), y + (my / ml) * (d / cos)]);
  }
  return out;
}

// Project, thin and offset a route; returns the SVG path and its offset end points.
function hairpin(coords, project, d) {
  const pts = offsetLine(thin(coords.map(project), Math.max(1.2, d * 0.5)), d);
  const dAttr = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  return { d: dAttr, start: pts[0], end: pts[pts.length - 1] };
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function stopDot(svg, [x, y], label, fill, textFill, r = 9) {
  const g = el("g", {}, svg);
  el("circle", { cx: x, cy: y, r, fill, stroke: "#0f1013", "stroke-width": 3 }, g);
  if (label) {
    const t = el("text", {
      x, y: y + r * 0.42, "text-anchor": "middle", "font-size": r * 1.15,
      "font-weight": 700, fill: textFill, "font-family": "Outfit, sans-serif",
    }, g);
    t.textContent = label;
  }
  return g;
}

function prepareDraw(svg, duration) {
  svg.classList.add("draw");
  svg.style.setProperty("--dur", `${duration}s`);
  for (const path of svg.querySelectorAll(".route-path")) {
    const len = Math.ceil(path.getTotalLength());
    path.style.setProperty("--len", len);
  }
  if (reduceMotion) svg.classList.add("is-drawn");
}

const drawObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-drawn");
          drawObserver.unobserve(entry.target);
        }
      }
    }, { threshold: 0.35 })
  : null;

function observeDraw(svg) {
  if (drawObserver && !reduceMotion) drawObserver.observe(svg);
  else svg.classList.add("is-drawn");
}

// ---------- Hero: the Byatarayanapura detour ----------

function drawHero(route, crossing) {
  const host = document.querySelector("#hero-detour");
  if (!host || !route) return;
  const W = 400, H = 300;
  const coords = route.geometry.coordinates;
  const project = projector(coords, W, H, 34);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const defs = el("defs", {}, svg);
  const grad = el("linearGradient", { id: "hero-grad", gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: W, y2: H }, defs);
  el("stop", { offset: 0, "stop-color": "#e6a23c" }, grad);
  el("stop", { offset: 1, "stop-color": "#d7263d" }, grad);
  const glow = el("filter", { id: "hero-glow", x: "-20%", y: "-20%", width: "140%", height: "140%" }, defs);
  el("feGaussianBlur", { stdDeviation: 5 }, glow);
  const pattern = el("pattern", { id: "hero-grid", width: 24, height: 24, patternUnits: "userSpaceOnUse" }, defs);
  el("path", { d: "M24 0H0V24", fill: "none", stroke: "rgba(255, 255, 255,0.05)", "stroke-width": 1 }, pattern);
  el("rect", { width: W, height: H, fill: "url(#hero-grid)" }, svg);

  const shape = hairpin(coords, project, 7);
  const d = shape.d;
  el("path", { d, class: "route-path", stroke: "#d7263d", "stroke-width": 10, opacity: 0.32, filter: "url(#hero-glow)" }, svg);
  el("path", { d, id: "hero-route", class: "route-path", stroke: "url(#hero-grad)", "stroke-width": 3.5 }, svg);

  const a = shape.start;
  const b = shape.end;

  // A walker that travels the route once the line is drawn.
  if (!reduceMotion) {
    const walker = el("circle", { r: 5, fill: "#f4f2ed", opacity: 0 }, svg);
    const motion = el("animateMotion", { dur: "7s", begin: "2.6s", repeatCount: "indefinite", rotate: "auto" }, walker);
    el("mpath", { href: "#hero-route" }, motion);
    el("animate", { attributeName: "opacity", values: "0;1;1;0", keyTimes: "0;0.04;0.96;1", dur: "7s", begin: "2.6s", repeatCount: "indefinite" }, walker);
  }

  stopDot(svg, a, "A", "#e6a23c", "#0f1013", 10);
  stopDot(svg, b, "B", "#d7263d", "#ffffff", 10);

  // Callout for the 25 m gap.
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const right = mid[0] < W * 0.6;
  const lx = right ? mid[0] + 26 : mid[0] - 26;
  const ly = Math.min(Math.max(mid[1] - 34, 22), H - 22);
  el("line", { x1: mid[0], y1: mid[1], x2: lx, y2: ly, stroke: "#f4f2ed", "stroke-width": 1.2, "stroke-dasharray": "2 3" }, svg);
  const tagW = 112;
  const tx = right ? lx : lx - tagW;
  el("rect", { x: tx, y: ly - 12, width: tagW, height: 24, rx: 12, fill: "#f4f2ed" }, svg);
  const label = el("text", { x: tx + tagW / 2, y: ly + 4.5, "text-anchor": "middle", class: "svg-label", "font-size": 12, fill: "#0f1013", style: "fill:#0f1013" }, svg);
  label.textContent = `${Math.round(crossing.straightM)} m across`;

  // Label the turnaround: the point of the walk farthest from the start.
  const start = route.properties.a;
  let farIndex = 0, farDist = -1;
  coords.forEach((c, i) => {
    const dist = haversine(start, c);
    if (dist > farDist) { farDist = dist; farIndex = i; }
  });
  let along = 0;
  for (let i = 1; i <= farIndex; i += 1) along += haversine(coords[i - 1], coords[i]);
  const [fx, fy] = project(coords[farIndex]);
  const below = fy > H / 2;
  el("circle", { cx: fx, cy: fy, r: 4, fill: "#f4f2ed" }, svg);
  const farText = el("text", {
    x: Math.min(Math.max(fx, 70), W - 70), y: below ? fy + 24 : fy - 16,
    "text-anchor": "middle", class: "svg-label", "font-size": 12.5, style: "fill:#ff8a8a",
  }, svg);
  farText.textContent = `turns back after ${(along / 1000).toFixed(1)} km`;

  host.append(svg);
  prepareDraw(svg, 2.4);
  setTimeout(() => svg.classList.add("is-drawn"), 300);
}

// ---------- Background: every gap in the city ----------

function drawConstellation(crossings, corridors) {
  const svg = document.querySelector("#constellation");
  if (!svg) return;
  const points = crossings.map((f) => f.geometry.coordinates);
  const W = 600, H = 760;
  const project = projector(points, W, H, 20);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMaxYMid meet");
  for (const corridor of corridors) {
    el("path", {
      d: pathData(corridor.geometry.coordinates, project),
      fill: "none", stroke: "#d7263d", "stroke-width": 3, "stroke-opacity": 0.55, "stroke-linecap": "round",
    }, svg);
  }
  const sorted = [...crossings].sort((x, y) => x.properties.extraMin - y.properties.extraMin);
  for (const f of sorted) {
    const [x, y] = project(f.geometry.coordinates);
    const p = f.properties;
    const r = 2 + Math.min(6, Math.sqrt(p.arrivals) / 12);
    el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: (r * 2.6).toFixed(1), fill: severity(p.extraMin), opacity: 0.12 }, svg);
    el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(1), fill: severity(p.extraMin), opacity: 0.9 }, svg);
  }
}

// ---------- Gallery: the worst gaps ----------

function placeKey(name) {
  return name.split(" / ")[0].replace(/\b(FLY|Flyover)\b/gi, "").trim().toLowerCase();
}

function cleanName(name) {
  return name.replace(/\bFLY\b/g, "Flyover").split(" / ")[0];
}

function drawGallery(crossings, routes) {
  const host = document.querySelector("#gallery");
  if (!host) return;
  const seen = new Set();
  const picks = [];
  const ranked = [...crossings].sort((x, y) => y.properties.impact - x.properties.impact);
  ranked.forEach((f, index) => {
    const key = placeKey(f.properties.name);
    if (picks.length < 6 && !seen.has(key) && routes.has(f.properties.id)) {
      seen.add(key);
      picks.push({ feature: f, rank: index + 1 });
    }
  });
  host.replaceChildren();
  for (const { feature, rank } of picks) {
    const p = feature.properties;
    const route = routes.get(p.id);
    const color = severity(p.extraMin);
    const card = document.createElement("a");
    card.className = "gap-card reveal";
    card.href = `map.html?crossing=${encodeURIComponent(p.id)}`;
    card.style.setProperty("--sev", color);

    const thumb = document.createElement("div");
    thumb.className = "gap-thumb";
    const W = 320, H = 200;
    const project = projector(route.geometry.coordinates, W, H, 22);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
    const shape = hairpin(route.geometry.coordinates, project, 4.5);
    el("path", { d: shape.d, class: "route-path", stroke: color, "stroke-width": 9, opacity: 0.16 }, svg);
    el("path", { d: shape.d, class: "route-path", stroke: color, "stroke-width": 2.6 }, svg);
    stopDot(svg, shape.start, "", "#e6a23c", "", 5.5);
    stopDot(svg, shape.end, "", "#d7263d", "", 5.5);
    thumb.append(svg);
    const rankBadge = document.createElement("span");
    rankBadge.className = "gap-rank";
    rankBadge.textContent = `#${rank}`;
    const ratio = document.createElement("span");
    ratio.className = "gap-ratio";
    ratio.textContent = `${Math.round(p.walkM / Math.max(p.straightM, 1))}× longer`;
    thumb.append(rankBadge, ratio);

    const body = document.createElement("div");
    body.className = "gap-body";
    const title = document.createElement("h3");
    title.textContent = cleanName(p.name);
    const nums = document.createElement("div");
    nums.className = "gap-nums";
    nums.innerHTML = `<b>${Math.round(p.straightM)} m</b> apart <span aria-hidden="true">→</span> <b class="walked">${fmt.format(Math.round(p.walkM))} m</b> walk`;
    const meta = document.createElement("div");
    meta.className = "gap-meta";
    const busTag = document.createElement("span");
    busTag.className = "tag";
    busTag.textContent = `${fmt.format(p.arrivals)} buses a day`;
    const minTag = document.createElement("span");
    minTag.className = "tag";
    minTag.textContent = `+${Math.round(p.extraMin)} min`;
    meta.append(busTag, minTag);
    if (p.blackspot) {
      const spot = document.createElement("span");
      spot.className = "tag danger";
      spot.textContent = p.blackspot;
      meta.append(spot);
    }
    body.append(title, nums, meta);
    card.append(thumb, body);
    host.append(card);
    prepareDraw(svg, 1.8);
    observeDraw(svg);
    revealObserve(card);
  }
}

// ---------- Corridor walks ----------

function drawWalks(walkCollection) {
  const groups = new Map();
  for (const f of walkCollection.features || []) {
    const id = f.properties.walk_id;
    if (!groups.has(id)) groups.set(id, {});
    groups.get(id)[f.properties.variant] = f;
  }
  for (const card of document.querySelectorAll("[data-walk]")) {
    const group = groups.get(card.dataset.walk);
    const host = card.querySelector(".walk-thumb");
    if (!group || !group.shortest || !group.avoid || !host) continue;
    const all = [...group.shortest.geometry.coordinates, ...group.avoid.geometry.coordinates];
    const W = 200, H = 200;
    const project = projector(all, W, H, 22);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", preserveAspectRatio: "xMidYMid meet" });
    el("path", { d: pathData(group.avoid.geometry.coordinates, project), class: "route-path", stroke: "#74c69d", "stroke-width": 7, opacity: 0.18 }, svg);
    el("path", { d: pathData(group.avoid.geometry.coordinates, project), class: "route-path", stroke: "#74c69d", "stroke-width": 3 }, svg);
    el("path", { d: pathData(group.shortest.geometry.coordinates, project), fill: "none", stroke: "#d7263d", "stroke-width": 3, "stroke-dasharray": "4 4", "stroke-linecap": "round" }, svg);
    const coords = group.shortest.geometry.coordinates;
    stopDot(svg, project(coords[0]), "", "#e6a23c", "", 6);
    stopDot(svg, project(coords[coords.length - 1]), "", "#d7263d", "", 6);
    host.append(svg);
    prepareDraw(svg, 1.6);
    observeDraw(svg);
  }
}

// ---------- Reveal on scroll ----------

const revealObserver = "IntersectionObserver" in window && !reduceMotion
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        }
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" })
  : null;

function revealObserve(node) {
  if (revealObserver) revealObserver.observe(node);
  else node.classList.add("is-in");
}

document.querySelectorAll(".reveal").forEach(revealObserve);

// ---------- Load ----------

const getJSON = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
});

Promise.all([
  getJSON("data/crossings.geojson"),
  getJSON("data/routes.geojson"),
  getJSON("data/walks.geojson"),
  getJSON("data/corridors.geojson"),
])
  .then(([crossings, routes, walks, corridors]) => {
    const routeMap = new Map(routes.features.map((f) => [f.properties.id, f]));
    const top = crossings.features.find((f) => f.properties.id === "39269-39270") || crossings.features[0];
    drawHero(routeMap.get(top.properties.id), top.properties);
    drawConstellation(crossings.features, corridors.features);
    drawGallery(crossings.features, routeMap);
    drawWalks(walks);
  })
  .catch((error) => {
    console.error("Safe Crossing: could not load map data", error);
    const gallery = document.querySelector("#gallery");
    if (gallery) {
      gallery.innerHTML = '<p class="lede">The previews did not load. <a href="map.html">Open the map</a> to see every gap.</p>';
    }
  });
