// One normalized activity, and everything derived from it.
//
// Ported from prosense/model.py so the browser and the CLI agree on what a
// number means. Summary figures are derived from the samples, not copied from
// the file: a device's own rounded totals are used only to fill a gap the
// samples cannot.

export const CHANNELS = ["t", "d", "lat", "lon", "ele", "hr", "cad", "speed", "power", "temp"];

const EARTH_RADIUS_M = 6371008.8;

export function haversine(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function smooth(vals, window) {
  // Centred moving average. Used before accumulating ascent, and for pace.
  if (window < 2 || vals.length < window) return vals.slice();
  const half = Math.floor(window / 2);
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(vals.length, i + half + 1);
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += vals[k];
    out.push(sum / (hi - lo));
  }
  return out;
}

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const present = a => a.filter(v => v != null);

export class Lap {
  constructor({ index, startOffsetS, durationS, distanceM, avgHr = null, avgCadence = null }) {
    Object.assign(this, { index, startOffsetS, durationS, distanceM, avgHr, avgCadence });
  }

  get paceSPerKm() {
    return this.distanceM > 0 ? this.durationS / (this.distanceM / 1000) : null;
  }
}

export class Activity {
  constructor(init = {}) {
    this.startTime = init.startTime ?? null;      // Date
    this.sport = init.sport ?? "unknown";
    this.device = init.device ?? "";
    this.sourceFormat = init.sourceFormat ?? "";
    this.sourceFile = init.sourceFile ?? "";
    this.samples = Object.fromEntries(CHANNELS.map(c => [c, []]));
    this.laps = [];
    this.declared = {};                            // only fills gaps
  }

  add(sample) {
    for (const c of CHANNELS) this.samples[c].push(sample[c] ?? null);
  }

  get count() { return this.samples.t.length; }

  has(channel) { return (this.samples[channel] ?? []).some(v => v != null); }

  finalize() {
    this.#fillElapsed();
    this.#fillDistance();
    return this;
  }

  // Samples arrive carrying absolute instants; charts want seconds from the
  // start, so convert once here rather than at every use.
  #fillElapsed() {
    const ts = this.samples.t;
    const base = ts.find(t => t != null);
    if (base == null) return;

    // Many samples sharing one instant is not a zero-second activity, it is a
    // file whose clock never ran — writers stamp every point with the same
    // value, often the INT_MIN sentinel that reads as 1901. Taken at face value
    // that yields a confident 0:00 duration and a 0:00/km pace over a real
    // distance, so treat the channel as absent and let the route still draw.
    const ms = t => (t instanceof Date ? t.getTime() : t);
    const stamped = ts.filter(t => t != null);
    if (stamped.length > 1 && ms(stamped[stamped.length - 1]) === ms(stamped[0])
        && stamped.every(t => ms(t) === ms(base))) {
      this.samples.t = ts.map(() => null);
      return;
    }

    if (this.startTime == null) this.startTime = base;
    const baseMs = base instanceof Date ? base.getTime() : base;
    this.samples.t = ts.map(t => {
      if (t == null) return null;
      return ((t instanceof Date ? t.getTime() : t) - baseMs) / 1000;
    });
  }

  #fillDistance() {
    if (this.samples.d.some(v => v != null)) return;   // source supplied it
    const { lat, lon } = this.samples;
    let total = 0, prev = null;
    this.samples.d = lat.map((_, i) => {
      if (lat[i] == null || lon[i] == null) return null;
      if (prev) total += haversine(prev[0], prev[1], lat[i], lon[i]);
      prev = [lat[i], lon[i]];
      return total;
    });
  }

  // Smooth first, then accumulate past a threshold.
  //
  // A threshold alone does not work. Oscillation whose amplitude sits near the
  // threshold crosses it on every single sample, so the filter passes
  // everything: a flat run with +/-1.5 m of sensor jitter accumulated 300 m of
  // phantom climb before this was smoothed.
  #ascentDescent(thresholdM = 3, window = 5) {
    const ele = smooth(present(this.samples.ele), window);
    if (ele.length < 2) return [null, null];
    let up = 0, down = 0, ref = ele[0];
    for (const e of ele) {
      const delta = e - ref;
      if (delta >= thresholdM) { up += delta; ref = e; }
      else if (delta <= -thresholdM) { down -= delta; ref = e; }
    }
    return [up, down];
  }

  // Below 0.5 m/s is a stop, not slow running; counting it would flatten the
  // average pace of anyone who waits at traffic lights.
  #movingSeconds() {
    const { t, d } = this.samples;
    let moving = 0;
    for (let i = 1; i < t.length; i++) {
      if (t[i] == null || t[i - 1] == null || d[i] == null || d[i - 1] == null) continue;
      const dt = t[i] - t[i - 1];
      if (dt <= 0) continue;
      if ((d[i] - d[i - 1]) / dt >= 0.5) moving += dt;
    }
    return moving;
  }

  summary() {
    const t = present(this.samples.t);
    const d = present(this.samples.d);
    const duration = t.length ? t[t.length - 1] - t[0] : this.declared.duration_s ?? null;
    const distance = d.length ? d[d.length - 1] - d[0] : this.declared.distance_m ?? null;
    const moving = this.#movingSeconds() || duration;
    let [ascent, descent] = this.#ascentDescent();
    if (ascent == null) { ascent = this.declared.ascent_m ?? null; descent = this.declared.descent_m ?? null; }
    const hr = present(this.samples.hr);
    const cad = present(this.samples.cad);
    const power = present(this.samples.power);
    return {
      duration_s: duration,
      moving_s: moving,
      distance_m: distance,
      pace_s_per_km: distance > 0 && moving > 0 ? moving / (distance / 1000) : null,
      ascent_m: ascent,
      descent_m: descent,
      avg_hr: hr.length ? Math.round(avg(hr)) : null,
      max_hr: hr.length ? Math.max(...hr) : null,
      avg_cadence: cad.length ? Math.round(avg(cad)) : null,
      avg_power: power.length ? Math.round(avg(power)) : null,
      calories: this.declared.calories ?? null,
      steps: this.declared.steps ?? null,
    };
  }

  bounds() {
    const lat = present(this.samples.lat), lon = present(this.samples.lon);
    if (!lat.length) return null;
    return {
      minLat: Math.min(...lat), maxLat: Math.max(...lat),
      minLon: Math.min(...lon), maxLon: Math.max(...lon),
    };
  }

  get id() {
    const when = this.startTime
      ? this.startTime.toISOString().slice(0, 19).replace(/[:]/g, "-")
      : "undated";
    return `${when}Z-${this.sport}`;
  }
}

// Read back an activity written by `prosense decode` / `prosense ingest`.
export function fromJSON(obj, sourceFile = "") {
  const act = new Activity({
    startTime: obj.start_time ? new Date(obj.start_time) : null,
    sport: obj.sport ?? "unknown",
    device: obj.device ?? "",
    sourceFormat: obj.source?.format ?? "json",
    sourceFile: sourceFile || obj.source?.file || "",
  });
  const s = obj.samples ?? {};
  for (const c of CHANNELS) act.samples[c] = s[c] ?? [];
  const n = act.samples.t.length;
  for (const c of CHANNELS) if (act.samples[c].length !== n) act.samples[c] = new Array(n).fill(null);
  act.laps = (obj.laps ?? []).map(l => new Lap({
    index: l.index, startOffsetS: l.start_offset_s, durationS: l.duration_s,
    distanceM: l.distance_m, avgHr: l.avg_hr ?? null, avgCadence: l.avg_cadence ?? null,
  }));
  act.declared = obj.summary ?? {};
  return act;                      // already normalized; no finalize()
}
