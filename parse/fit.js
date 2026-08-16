// FIT parser — enough of the format to reconstruct an activity.
//
// Ported from prosense/fit.py. FIT is Garmin's format but is used well beyond
// Garmin hardware, which is why it is worth supporting for a tool that started
// with an Epson watch. The file is self-identifying: bytes 8..12 are ".FIT".
//
// A deliberate subset: record, lap, session, sport and file_id messages.
// Developer field definitions are parsed only so their bytes can be skipped
// without losing alignment for everything after them.

import { Activity, Lap } from "./model.js";

const FIT_EPOCH_OFFSET = 631065600;          // 1989-12-31T00:00:00Z, in Unix seconds
const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

// base type (low 5 bits) -> [reader, width, invalid]
const BASE_TYPES = {
  0x00: ["Uint8", 1, 0xff], 0x01: ["Int8", 1, 0x7f], 0x02: ["Uint8", 1, 0xff],
  0x03: ["Int16", 2, 0x7fff], 0x04: ["Uint16", 2, 0xffff],
  0x05: ["Int32", 4, 0x7fffffff], 0x06: ["Uint32", 4, 0xffffffff],
  0x07: ["string", 1, 0], 0x08: ["Float32", 4, 0xffffffff],
  0x09: ["Float64", 8, null], 0x0a: ["Uint8", 1, 0], 0x0b: ["Uint16", 2, 0],
  0x0c: ["Uint32", 4, 0], 0x0d: ["Uint8", 1, 0xff],
  0x0e: ["BigInt64", 8, null], 0x0f: ["BigUint64", 8, null],
  0x10: ["BigUint64", 8, null],
};

const MSG_FILE_ID = 0, MSG_SPORT = 12, MSG_SESSION = 18, MSG_LAP = 19, MSG_RECORD = 20;

const SPORTS = {
  0: "generic", 1: "running", 2: "cycling", 3: "transition",
  4: "fitness-equipment", 5: "swimming", 6: "basketball", 7: "soccer",
  8: "tennis", 9: "american-football", 10: "training", 11: "walking",
  12: "cross-country-skiing", 13: "alpine-skiing", 14: "snowboarding",
  15: "rowing", 16: "mountaineering", 17: "hiking", 18: "multisport",
  19: "paddling",
};

// A handful of the manufacturer ids that turn up in consumer files. An
// unknown id is reported as a number rather than guessed at.
const MANUFACTURERS = {
  1: "Garmin", 2: "Garmin (FR405)", 3: "Zephyr", 4: "Dayton", 5: "IDT",
  6: "SRM", 7: "Quarq", 8: "iBike", 9: "Saris", 13: "Suunto", 15: "Wahoo",
  23: "Suunto", 32: "Wahoo Fitness", 38: "Epson", 41: "Bkool", 54: "Lezyne",
  63: "Zwift", 68: "Stages", 69: "Sigma", 89: "Tacx", 95: "Elite",
  260: "Zwift", 263: "Bryton", 265: "Polar", 267: "Coros", 269: "Suunto",
  294: "Amazfit", 302: "COROS", 306: "Xiaomi",
};

export class FitError extends Error {}

export function looksLikeFit(bytes) {
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === ".FIT";
}

export function parse(buffer, sourceFile = "") {
  const bytes = new Uint8Array(buffer);
  if (!looksLikeFit(bytes)) throw new FitError("not a FIT file (no .FIT signature at offset 8)");

  const view = new DataView(buffer);
  const headerSize = bytes[0];
  if (headerSize !== 12 && headerSize !== 14) {
    throw new FitError(`unexpected FIT header size ${headerSize}`);
  }
  const dataSize = view.getUint32(4, true);
  let pos = headerSize;
  const end = Math.min(bytes.length, headerSize + dataSize);

  const act = new Activity({ sourceFormat: "fit", sourceFile });
  const defs = new Map();
  const lapsRaw = [];
  let manufacturer = null, product = null;

  while (pos < end) {
    const header = bytes[pos];
    pos += 1;

    if (header & 0x80) {                       // compressed timestamp, data message
      const d = defs.get((header >> 5) & 0x03);
      if (!d) throw new FitError("data for an undefined local message");
      const [values, next] = readData(view, bytes, pos, d);
      pos = next;
      consume(act, lapsRaw, d.globalNum, values);
      continue;
    }
    if (header & 0x40) {                       // definition message
      const [d, next] = readDefinition(view, bytes, pos, Boolean(header & 0x20));
      defs.set(header & 0x0f, d);
      pos = next;
      continue;
    }
    const d = defs.get(header & 0x0f);
    if (!d) throw new FitError("data for an undefined local message");
    const [values, next] = readData(view, bytes, pos, d);
    pos = next;
    if (d.globalNum === MSG_FILE_ID) {
      manufacturer = values.get(1) ?? manufacturer;
      product = values.get(2) ?? product;
    }
    consume(act, lapsRaw, d.globalNum, values);
  }

  if (manufacturer != null) {
    act.device = MANUFACTURERS[manufacturer] ?? `manufacturer ${manufacturer}`;
    if (product != null) act.device += ` (product ${product})`;
  }
  act.finalize();
  attachLaps(act, lapsRaw);
  if (!act.count) throw new FitError("no record messages — nothing to plot");
  return act;
}

function readDefinition(view, bytes, pos, hasDev) {
  const little = bytes[pos + 1] === 0;
  const globalNum = view.getUint16(pos + 2, little);
  const numFields = bytes[pos + 4];
  pos += 5;
  const fields = [];
  for (let i = 0; i < numFields; i++) {
    fields.push({ num: bytes[pos], size: bytes[pos + 1], base: bytes[pos + 2] });
    pos += 3;
  }
  if (hasDev) {
    const numDev = bytes[pos];
    pos += 1;
    for (let i = 0; i < numDev; i++) {
      // Parsed only to keep alignment. Field number 255 never collides with a
      // real one, so these are dropped when read.
      fields.push({ num: 255, size: bytes[pos + 1], base: 0x0d });
      pos += 3;
    }
  }
  return [{ globalNum, little, fields }, pos];
}

function readData(view, bytes, pos, d) {
  const values = new Map();
  for (const f of d.fields) {
    const base = BASE_TYPES[f.base & 0x1f];
    const start = pos;
    pos += f.size;
    if (!base || f.num === 255) continue;
    const [kind, width, invalid] = base;

    if (kind === "string") {
      let s = "";
      for (let i = start; i < start + f.size && bytes[i]; i++) s += String.fromCharCode(bytes[i]);
      if (s) values.set(f.num, s);
      continue;
    }
    const n = Math.floor(f.size / width);
    if (n < 1) continue;
    const out = [];
    for (let i = 0; i < n; i++) {
      let v;
      try {
        v = view[`get${kind}`](start + i * width, d.little);
      } catch { break; }
      if (typeof v === "bigint") v = Number(v);
      if (invalid != null && v === invalid) continue;
      out.push(v);
    }
    if (out.length) values.set(f.num, out.length === 1 ? out[0] : out);
  }
  return [values, pos];
}

function consume(act, lapsRaw, globalNum, v) {
  if (globalNum === MSG_RECORD) consumeRecord(act, v);
  else if (globalNum === MSG_LAP) lapsRaw.push(v);
  else if (globalNum === MSG_SESSION) consumeSession(act, v);
  else if (globalNum === MSG_SPORT && v.has(0)) act.sport = SPORTS[v.get(0)] ?? act.sport;
}

function consumeRecord(act, v) {
  const ts = v.get(253);
  if (ts == null) return;
  const rawSpeed = v.get(73) ?? v.get(6);            // enhanced_speed, else speed
  const rawEle = v.get(78) ?? v.get(2);              // enhanced_altitude, else altitude
  act.add({
    t: fitTime(ts),
    d: v.has(5) ? v.get(5) / 100 : null,
    lat: v.has(0) ? v.get(0) * SEMICIRCLE_TO_DEG : null,
    lon: v.has(1) ? v.get(1) * SEMICIRCLE_TO_DEG : null,
    ele: rawEle != null ? rawEle / 5 - 500 : null,
    hr: v.get(3) ?? null,
    cad: v.get(4) ?? null,
    speed: rawSpeed != null ? rawSpeed / 1000 : null,
    power: v.get(7) ?? null,
    temp: v.get(13) ?? null,
  });
}

function consumeSession(act, v) {
  if (v.has(5)) act.sport = SPORTS[v.get(5)] ?? act.sport;
  const dec = act.declared;
  if (v.has(7)) dec.duration_s ??= v.get(7) / 1000;
  if (v.has(9)) dec.distance_m ??= v.get(9) / 100;
  if (v.has(11)) dec.calories ??= v.get(11);
  if (v.has(22)) dec.ascent_m ??= v.get(22);
  if (v.has(23)) dec.descent_m ??= v.get(23);
}

// Lap messages carry an end timestamp and an elapsed time; the start is the
// difference. Per-lap heart rate and cadence are recomputed from the samples
// rather than trusting field numbers that vary between writers.
function attachLaps(act, lapsRaw) {
  if (!lapsRaw.length || act.startTime == null) return;
  const startMs = act.startTime.getTime();
  lapsRaw.forEach((v, i) => {
    const endTs = v.get(253), dur = v.get(7), dist = v.get(9);
    if (endTs == null || dur == null) return;
    const durS = dur / 1000;
    const endOff = (fitTime(endTs).getTime() - startMs) / 1000;
    const lap = new Lap({
      index: i + 1,
      startOffsetS: Math.max(0, endOff - durS),
      durationS: durS,
      distanceM: dist != null ? dist / 100 : 0,
    });
    lapAverages(act, lap);
    act.laps.push(lap);
  });
}

function lapAverages(act, lap) {
  const { t, hr, cad } = act.samples;
  const lo = lap.startOffsetS, hi = lo + lap.durationS;
  const hrs = [], cads = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] == null || t[i] < lo || t[i] > hi) continue;
    if (hr[i] != null) hrs.push(hr[i]);
    if (cad[i] != null) cads.push(cad[i]);
  }
  if (hrs.length) lap.avgHr = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
  if (cads.length) lap.avgCadence = Math.round(cads.reduce((a, b) => a + b, 0) / cads.length);
}

function fitTime(raw) {
  return new Date((raw + FIT_EPOCH_OFFSET) * 1000);
}
