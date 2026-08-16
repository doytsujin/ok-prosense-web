// Trace — read your own activity files, in the browser.
//
// Every file is parsed in this tab with FileReader. There is no upload, no
// backend, and no analytics: the page is static and the only network request
// it can make is for map tiles, which are off until you turn them on.

import { chart, barChart, HoverGroup } from "./chart.js";
import { routeMap, setTiles, tilesOn } from "./map.js";
import { fromJSON, smooth } from "./parse/model.js";
import { parse as parseFit, looksLikeFit } from "./parse/fit.js";
import { parseTcx, parseGpx, looksLikeTcx, looksLikeGpx } from "./parse/xmlfmt.js";

const view = document.getElementById("view");
const activities = [];               // everything loaded this session
let current = null;

/* -- formatting ------------------------------------------------------- */

const km = m => (m == null ? "—" : (m / 1000).toFixed(2));
const m0 = v => (v == null ? "—" : Math.round(v).toLocaleString());

function hms(s) {
  if (s == null) return "—";
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
    : `${m}:${String(t % 60).padStart(2, "0")}`;
}

function pace(sPerKm) {
  if (!sPerKm || !Number.isFinite(sPerKm)) return "—";
  const t = Math.round(sPerKm);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function when(d) {
  if (!d) return "undated";
  return d.toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const tile = (label, value, unit) =>
  `<div class="tile"><div class="label">${label}</div>
   <div class="value">${value}${unit ? `<span class="unit">${unit}</span>` : ""}</div></div>`;

// Keeps array length and steps over gaps, so a smoothed series still lines up
// index-for-index with the map and the other charts.
function smoothSparse(vals, window) {
  const half = (window | 1) >> 1;
  return vals.map((v, i) => {
    if (v == null) return null;
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j < Math.min(vals.length, i + half + 1); j++) {
      if (vals[j] != null) { sum += vals[j]; n++; }
    }
    return n ? sum / n : null;
  });
}

/* -- reading files ---------------------------------------------------- */

const readText = file => file.text();
const readBytes = file => file.arrayBuffer();

async function parseFile(file) {
  const name = file.name;
  const ext = name.toLowerCase().split(".").pop();

  // Sniff the content rather than trusting the extension: exports get renamed,
  // and a .txt holding a GPX should still work.
  if (ext === "fit") return parseFit(await readBytes(file), name);

  if (ext === "json") return fromJSON(JSON.parse(await readText(file)), name);

  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (looksLikeFit(head)) return parseFit(await readBytes(file), name);

  const text = await readText(file);
  if (looksLikeTcx(text)) return parseTcx(text, name);
  if (looksLikeGpx(text)) return parseGpx(text, name);
  if (text.trimStart().startsWith("{")) return fromJSON(JSON.parse(text), name);

  throw new Error("unrecognised format — expected FIT, TCX, GPX or prosense JSON");
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const failures = [];
  for (const file of files) {
    try {
      const act = await parseFile(file);
      // Re-dropping the same export should replace it, not double the totals.
      const i = activities.findIndex(a => a.id === act.id);
      if (i >= 0) activities[i] = act; else activities.push(act);
    } catch (e) {
      failures.push(`${file.name}: ${e.message}`);
    }
  }
  activities.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  current = null;
  render(failures);
}

/* -- views ------------------------------------------------------------ */

function dropZone(compact) {
  return `<div class="drop ${compact ? "compact" : ""}" id="drop">
      <p class="big">Drop activity files here</p>
      <p class="hint">FIT, TCX, GPX, or JSON written by <code>prosense</code>.
        Read in this tab — nothing is uploaded.</p>
      <label class="btn">Choose files
        <input type="file" id="picker" multiple accept=".fit,.tcx,.gpx,.json,application/gpx+xml" hidden>
      </label>
    </div>`;
}

function render(failures = []) {
  if (current) renderActivity(current, failures);
  else if (activities.length) renderList(failures);
  else renderEmpty(failures);
  wireDrop();
}

function problems(failures) {
  if (!failures.length) return "";
  return `<div class="banner warn"><strong>${failures.length} file${failures.length > 1 ? "s" : ""}
    could not be read.</strong><ul>${failures.map(f => `<li>${esc(f)}</li>`).join("")}</ul></div>`;
}

function renderEmpty(failures) {
  view.innerHTML = `${problems(failures)}${dropZone(false)}
    <div class="panel about">
      <h3>What this does</h3>
      <p>Reads an activity file and shows you what is in it: the route, pace,
        heart rate, elevation and splits. It is a static page — your file is
        parsed by JavaScript in this tab and never sent anywhere.</p>
      <p class="hint">Distance, pace, ascent and moving time are derived from
        the samples rather than copied from the file's own summary, so two
        exports of the same run agree. Ascent is smoothed before it is
        accumulated: a threshold alone lets sensor jitter through, and a flat
        run can otherwise report hundreds of metres of climb that never
        happened.</p>
    </div>`;
}

function renderList(failures) {
  const rows = activities.map((a, i) => {
    const s = a.summary();
    return `<tr class="clickable" data-i="${i}">
      <td style="text-align:left">${when(a.startTime)}</td>
      <td style="text-align:left">${esc(a.sport)}</td>
      <td>${km(s.distance_m)}</td>
      <td>${hms(s.duration_s)}</td>
      <td>${pace(s.pace_s_per_km)}</td>
      <td>${s.avg_hr ?? "—"}</td>
      <td>${m0(s.ascent_m)}</td>
      <td style="text-align:left" class="dim">${esc(a.sourceFormat)}</td>
    </tr>`;
  }).join("");

  const totals = activities.reduce((acc, a) => {
    const s = a.summary();
    acc.d += s.distance_m || 0; acc.t += s.duration_s || 0; acc.up += s.ascent_m || 0;
    return acc;
  }, { d: 0, t: 0, up: 0 });

  view.innerHTML = `${problems(failures)}
    <div class="kpi">
      ${tile("Activities", activities.length, "")}
      ${tile("Distance", km(totals.d), "km")}
      ${tile("Time", hms(totals.t), "")}
      ${tile("Elevation", m0(totals.up), "m")}
    </div>
    <div class="panel">
      <h3>Loaded this session</h3>
      <p class="hint">Nothing is stored — reloading the page clears it</p>
      <div id="tbl"></div>
    </div>
    ${dropZone(true)}`;

  document.getElementById("tbl").innerHTML = `<table>
    <thead><tr><th style="text-align:left">Date</th><th style="text-align:left">Sport</th>
      <th>km</th><th>Time</th><th>Pace /km</th><th>Avg HR</th><th>Ascent m</th>
      <th style="text-align:left">From</th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  document.querySelectorAll("tr.clickable").forEach(tr => {
    tr.addEventListener("click", () => { current = activities[+tr.dataset.i]; render(); });
  });
}

function renderActivity(a, failures) {
  const s = a.summary();
  view.innerHTML = `${problems(failures)}
    <a class="back" href="#" id="back">← all files</a>
    <h2>${esc(a.sport)} · ${km(s.distance_m)} km</h2>
    <div class="when">${when(a.startTime)}${a.device ? ` · ${esc(a.device)}` : ""}
      ${a.sourceFile ? ` · <span class="dim">${esc(a.sourceFile)}</span>` : ""}</div>
    <div class="kpi">
      ${tile("Distance", km(s.distance_m), "km")}
      ${tile("Time", hms(s.duration_s), "")}
      ${tile("Pace", pace(s.pace_s_per_km), "/km")}
      ${tile("Avg HR", s.avg_hr ?? "—", s.avg_hr ? "bpm" : "")}
      ${tile("Ascent", m0(s.ascent_m), "m")}
    </div>
    <div class="panel"><h3>Route</h3><div id="mapbox"></div></div>
    <div class="panel" id="charts"><h3>Along the route</h3>
      <p class="hint">Hover to read a point — the crosshair and the map marker follow together</p>
    </div>
    <div class="panel" id="laps"></div>`;

  document.getElementById("back").addEventListener("click", ev => {
    ev.preventDefault(); current = null; render();
  });

  const map = routeMap(document.getElementById("mapbox"), a);
  const group = new HoverGroup();
  group.add(i => map.highlight(i));

  const box = document.getElementById("charts");
  const sm = a.samples;
  const dist = sm.d.map(v => (v == null ? null : v / 1000));
  const xFormat = v => `${v.toFixed(1)} km`;

  // Pace comes from speed where the file has it, and from distance over time
  // where it does not, then is smoothed. Instantaneous pace off a GPS fix every
  // few seconds is mostly sensor noise; unsmoothed it renders as a solid band
  // with no readable shape.
  const speed = a.has("speed") ? sm.speed : derivedSpeed(sm.t, sm.d);
  const paceSeries = smoothSparse(speed.map(v => (v && v > 0.4 ? 1000 / v : null)), 15);

  const panels = [
    { key: "pace", label: "Pace", y: paceSeries, invert: true,
      yFormat: v => `${pace(v)} /km`, yTicks: v => pace(v) },
    { key: "hr", label: "Heart rate", y: sm.hr, yFormat: v => `${Math.round(v)} bpm` },
    { key: "ele", label: "Elevation", y: sm.ele, type: "area", yFormat: v => `${Math.round(v)} m` },
    { key: "cad", label: "Cadence", y: sm.cad, yFormat: v => `${Math.round(v)} spm` },
    { key: "power", label: "Power", y: sm.power, yFormat: v => `${Math.round(v)} W` },
  ];

  for (const p of panels) {
    if (!p.y || !p.y.some(v => v != null)) continue;
    const h = document.createElement("h3");
    h.textContent = p.label;
    h.style.marginTop = "18px";
    box.appendChild(h);
    chart(box, {
      x: dist, y: p.y, type: p.type || "line", title: p.label,
      height: 150, xFormat, yFormat: p.yFormat, yTicksFormat: p.yTicks,
      group, invert: p.invert,
    });
  }

  renderLaps(document.getElementById("laps"), a);
}

function derivedSpeed(t, d) {
  return t.map((_, i) => {
    if (i === 0 || t[i] == null || t[i - 1] == null || d[i] == null || d[i - 1] == null) return null;
    const dt = t[i] - t[i - 1];
    return dt > 0 ? (d[i] - d[i - 1]) / dt : null;
  });
}

function renderLaps(node, a) {
  if (!a.laps.length) { node.remove(); return; }
  node.innerHTML = `<h3>Splits</h3>
    <p class="hint">Pace per lap — shorter bars are faster</p><div id="lapchart"></div>`;

  const paced = a.laps.filter(l => l.paceSPerKm);
  if (paced.length) {
    barChart(document.getElementById("lapchart"), {
      labels: paced.map(l => String(l.index)),
      values: paced.map(l => l.paceSPerKm),
      height: 150,
      yFormat: v => pace(v),
      tipFormat: i => `<span class="k">lap ${paced[i].index}</span>
        <span class="v">${pace(paced[i].paceSPerKm)} /km · ${km(paced[i].distanceM)} km</span>`,
    });
  }

  const rows = a.laps.map(l => `<tr>
    <td>${l.index}</td><td>${km(l.distanceM)}</td><td>${hms(l.durationS)}</td>
    <td>${pace(l.paceSPerKm)}</td><td>${l.avgHr ?? "—"}</td>
    <td>${l.avgCadence ?? "—"}</td></tr>`).join("");

  node.insertAdjacentHTML("beforeend", `
    <details class="tableview">
      <summary>Table view</summary>
      <table><thead><tr><th>Lap</th><th>km</th><th>Time</th><th>Pace /km</th>
        <th>Avg HR</th><th>Cadence</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </details>`);
}

/* -- input wiring ----------------------------------------------------- */

function wireDrop() {
  const zone = document.getElementById("drop");
  const picker = document.getElementById("picker");
  if (picker) picker.addEventListener("change", () => addFiles(picker.files));
  if (!zone) return;
  zone.addEventListener("dragover", ev => { ev.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", ev => {
    ev.preventDefault();
    zone.classList.remove("over");
    addFiles(ev.dataTransfer.files);
  });
}

// Dropping anywhere on the page works, not only on the box.
document.addEventListener("dragover", ev => ev.preventDefault());
document.addEventListener("drop", ev => {
  if (document.getElementById("drop")?.contains(ev.target)) return;
  ev.preventDefault();
  addFiles(ev.dataTransfer.files);
});

/* -- tiles and theme -------------------------------------------------- */

const tilesBtn = document.getElementById("tiles");
tilesBtn.hidden = false;
const TILE_KEY = "trace-tiles";
setTiles(localStorage.getItem(TILE_KEY) === "on");
const paintTiles = () => { tilesBtn.textContent = `Map tiles: ${tilesOn() ? "on" : "off"}`; };
paintTiles();
tilesBtn.addEventListener("click", () => {
  setTiles(!tilesOn());
  localStorage.setItem(TILE_KEY, tilesOn() ? "on" : "off");
  paintTiles();
  render();
});

const THEME_KEY = "trace-theme";
const saved = localStorage.getItem(THEME_KEY);
if (saved) document.documentElement.setAttribute("data-theme", saved);
document.getElementById("theme").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme")
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
  render();     // re-render so the map polyline picks up the new hue
});

render();
