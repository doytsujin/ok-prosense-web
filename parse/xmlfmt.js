// TCX and GPX parsers.
//
// Ported from prosense/xmlfmt.py. Both formats namespace their elements, so
// every lookup matches on the local tag name and ignores the namespace URI:
// files in the wild disagree about namespace versions often enough that
// matching on the full URI is a reliable way to parse nothing at all.

import { Activity, Lap } from "./model.js";

const TCX_SPORTS = { running: "running", biking: "cycling", other: "generic" };

export class XmlError extends Error {}

// Match on the local name and ignore the namespace. The prefix is stripped from
// localName as well as nodeName: a conforming XML parser leaves localName
// prefix-free so the strip is a no-op there, but not every parser splits the
// qualified name, and trusting it to be prefix-free silently loses every
// namespaced field — <gpxtpx:hr> stops matching "hr" and heart rate vanishes
// from GPX files while everything else still parses.
const local = el => (el.localName ?? el.nodeName).replace(/^.*:/, "");

function child(el, name) {
  for (const c of el.children) if (local(c) === name) return c;
  return null;
}

function children(el, name) {
  return [...el.children].filter(c => local(c) === name);
}

function deep(el, name) {
  // querySelector cannot be trusted with namespaced documents, so walk.
  const stack = [...el.children];
  while (stack.length) {
    const c = stack.shift();
    if (local(c) === name) return c;
    stack.push(...c.children);
  }
  return null;
}

// Every match, not just the first. A GPX file routinely carries several <trk>
// elements and the first one is often empty — GPSBabel and Garmin handhelds
// both emit that shape — so taking one track and calling it the track reports
// "nothing to plot" on a file holding a complete log.
function allDeep(el, name) {
  const out = [], stack = [...el.children];
  while (stack.length) {
    const c = stack.shift();
    if (local(c) === name) out.push(c); else stack.push(...c.children);
  }
  return out;
}

function num(el, name) {
  const c = el && child(el, name);
  if (!c) return null;
  const v = Number.parseFloat(c.textContent.trim());
  return Number.isFinite(v) ? v : null;
}

function time(text) {
  if (!text) return null;
  const d = new Date(text.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new XmlError("file is not well-formed XML");
  return doc.documentElement;
}

export function looksLikeTcx(text) { return /<TrainingCenterDatabase/i.test(text.slice(0, 2000)); }
export function looksLikeGpx(text) { return /<gpx[\s>]/i.test(text.slice(0, 2000)); }

export function parseTcx(text, sourceFile = "") {
  const root = parseXml(text);
  const act = new Activity({ sourceFormat: "tcx", sourceFile });

  const activity = deep(root, "Activity");
  if (!activity) throw new XmlError("no <Activity> element");
  const sport = (activity.getAttribute("Sport") || "").toLowerCase();
  act.sport = TCX_SPORTS[sport] ?? (sport || "unknown");

  const creator = deep(activity, "Creator");
  if (creator) act.device = child(creator, "Name")?.textContent.trim() ?? "";

  let calories = 0;
  const lapsRaw = [];
  for (const lap of children(activity, "Lap")) {
    const startedAt = time(lap.getAttribute("StartTime"));
    const seconds = num(lap, "TotalTimeSeconds");
    const metres = num(lap, "DistanceMeters");
    calories += num(lap, "Calories") ?? 0;
    lapsRaw.push({ startedAt, seconds, metres });

    for (const track of children(lap, "Track")) {
      for (const pt of children(track, "Trackpoint")) {
        const when = time(child(pt, "Time")?.textContent);
        if (!when) continue;
        const pos = child(pt, "Position");
        const hrEl = child(pt, "HeartRateBpm");
        const ext = child(pt, "Extensions");
        const tpx = ext && deep(ext, "TPX");
        act.add({
          t: when,
          d: num(pt, "DistanceMeters"),
          lat: pos ? num(pos, "LatitudeDegrees") : null,
          lon: pos ? num(pos, "LongitudeDegrees") : null,
          ele: num(pt, "AltitudeMeters"),
          hr: hrEl ? num(hrEl, "Value") : null,
          cad: num(pt, "Cadence"),
          speed: tpx ? num(tpx, "Speed") : null,
          power: tpx ? num(tpx, "Watts") : null,
        });
      }
    }
  }
  if (calories) act.declared.calories = calories;
  act.finalize();
  attachLaps(act, lapsRaw);
  if (!act.count) throw new XmlError("no trackpoints — nothing to plot");
  return act;
}

export function parseGpx(text, sourceFile = "") {
  const root = parseXml(text);
  const act = new Activity({ sourceFormat: "gpx", sourceFile });

  const trks = allDeep(root, "trk");
  if (!trks.length) throw new XmlError("no <trk> element");
  // Name and type come from the first track that states them; an empty leading
  // track usually states neither.
  const named = trks.find(t => child(t, "name") || child(t, "type")) ?? trks[0];
  const name = child(named, "name")?.textContent.trim();
  const type = child(named, "type")?.textContent.trim().toLowerCase();
  if (type) act.sport = type;
  if (name) act.sourceFile ||= name;

  for (const seg of trks.flatMap(t => children(t, "trkseg"))) {
    for (const pt of children(seg, "trkpt")) {
      const when = time(child(pt, "time")?.textContent);
      if (!when) continue;
      const ext = child(pt, "extensions");
      // Garmin's TrackPointExtension is the de-facto place for hr/cad/temp.
      const tpe = ext ? deep(ext, "TrackPointExtension") ?? ext : null;
      act.add({
        t: when,
        lat: Number.parseFloat(pt.getAttribute("lat")),
        lon: Number.parseFloat(pt.getAttribute("lon")),
        ele: num(pt, "ele"),
        hr: tpe ? num(tpe, "hr") : null,
        cad: tpe ? num(tpe, "cad") : null,
        temp: tpe ? num(tpe, "atemp") : null,
      });
    }
  }
  act.finalize();
  if (!act.count) throw new XmlError("no trackpoints with timestamps — nothing to plot");
  return act;
}

function attachLaps(act, lapsRaw) {
  if (act.startTime == null) return;
  const startMs = act.startTime.getTime();
  lapsRaw.forEach((l, i) => {
    if (l.startedAt == null || l.seconds == null) return;
    act.laps.push(new Lap({
      index: i + 1,
      startOffsetS: Math.max(0, (l.startedAt.getTime() - startMs) / 1000),
      durationS: l.seconds,
      distanceM: l.metres ?? 0,
    }));
  });
}
