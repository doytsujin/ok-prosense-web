/* Minimal SVG charts, built to the data-viz rules:
   thin marks (2px lines, 4px rounded bar ends), recessive hairline grid,
   crosshair + tooltip by default, a table view alongside every chart, and one
   hue throughout — each chart carries a single series whose title names it, so
   no legend is needed and no categorical palette is in play. */

const NS = "http://www.w3.org/2000/svg";
const M = { top: 8, right: 12, bottom: 24, left: 46 };

function el(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/** Nice round tick values covering [lo, hi]. */
function ticks(lo, hi, count = 4) {
  if (!isFinite(lo) || !isFinite(hi)) return [0];
  if (lo === hi) return [lo];
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out.length ? out : [lo, hi];
}

/* Charts share a hover index so a crosshair in one moves the others and the
   map marker together — the linked view is the point of showing them stacked. */
export class HoverGroup {
  constructor() { this.subs = []; }
  add(fn) { this.subs.push(fn); }
  emit(i) { for (const fn of this.subs) fn(i); }
}

/**
 * spec: { x, y, type: 'line'|'area', title, hint, height,
 *         xFormat, yFormat, yTicksFormat, group, invert }
 * `invert` flips the y axis, for pace where lower is better.
 */
export function chart(container, spec) {
  const {
    x, y, type = "line", height = 150, xFormat = String, yFormat = String,
    yTicksFormat, group, invert = false,
  } = spec;

  const wrap = document.createElement("div");
  wrap.className = "chart";
  container.appendChild(wrap);

  const tip = document.createElement("div");
  tip.className = "tooltip";
  wrap.appendChild(tip);

  const pts = [];
  for (let i = 0; i < x.length; i++) {
    if (y[i] === null || y[i] === undefined || !isFinite(y[i])) continue;
    pts.push([x[i], y[i], i]);
  }
  if (pts.length < 2) {
    wrap.innerHTML = '<div class="map-empty">no data for this channel</div>';
    return { destroy() {} };
  }

  let svg, scaleX, scaleY, W = 0, H = height;

  function draw() {
    const width = wrap.clientWidth || 600;
    if (width === W) return;
    W = width;
    if (svg) svg.remove();

    svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", spec.title || "chart");

    const iw = W - M.left - M.right;
    const ih = H - M.top - M.bottom;

    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = (y1 - y0) * 0.08 || 1;
    y0 -= pad; y1 += pad;
    if (type === "area") y0 = Math.min(y0, Math.min(...ys) - pad);

    scaleX = v => M.left + ((v - x0) / (x1 - x0 || 1)) * iw;
    scaleY = v => invert
      ? M.top + ((v - y0) / (y1 - y0 || 1)) * ih
      : M.top + ih - ((v - y0) / (y1 - y0 || 1)) * ih;

    // grid + y ticks (recessive: hairline, muted labels)
    for (const t of ticks(y0, y1)) {
      const yy = scaleY(t);
      if (yy < M.top - 1 || yy > M.top + ih + 1) continue;
      svg.appendChild(el("line", {
        class: "gridline", x1: M.left, x2: M.left + iw, y1: yy, y2: yy,
      }));
      const label = el("text", { class: "tick", x: M.left - 8, y: yy + 4, "text-anchor": "end" });
      label.textContent = (yTicksFormat || yFormat)(t);
      svg.appendChild(label);
    }

    // x ticks
    for (const t of ticks(x0, x1, 5)) {
      const xx = scaleX(t);
      if (xx < M.left - 1 || xx > M.left + iw + 1) continue;
      const label = el("text", { class: "tick", x: xx, y: H - 6, "text-anchor": "middle" });
      label.textContent = xFormat(t);
      svg.appendChild(label);
    }

    svg.appendChild(el("line", {
      class: "baseline", x1: M.left, x2: M.left + iw,
      y1: M.top + ih, y2: M.top + ih,
    }));

    const d = pts.map((p, i) => `${i ? "L" : "M"}${scaleX(p[0]).toFixed(1)},${scaleY(p[1]).toFixed(1)}`).join("");
    if (type === "area") {
      const base = M.top + ih;
      svg.appendChild(el("path", {
        class: "area",
        d: `${d}L${scaleX(pts.at(-1)[0]).toFixed(1)},${base}L${scaleX(pts[0][0]).toFixed(1)},${base}Z`,
      }));
    }
    svg.appendChild(el("path", { class: "series", d }));

    const cross = el("line", { class: "crosshair", y1: M.top, y2: M.top + ih, opacity: 0 });
    const dot = el("circle", { class: "marker", r: 4.5, opacity: 0 });
    svg.appendChild(cross);
    svg.appendChild(dot);
    wrap.appendChild(svg);

    wrap._show = (idx) => {
      const p = nearestByIndex(idx);
      if (!p) return hide();
      const px = scaleX(p[0]), py = scaleY(p[1]);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px);
      cross.setAttribute("opacity", 1);
      dot.setAttribute("cx", px); dot.setAttribute("cy", py);
      dot.setAttribute("opacity", 1);
      tip.innerHTML = `<span class="k">${xFormat(p[0])}</span><span class="v">${yFormat(p[1])}</span>`;
      tip.classList.add("on");
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(px - tw / 2, 0), W - tw)}px`;
      tip.style.top = `${Math.max(py - 38, 0)}px`;
    };
    const hide = () => {
      cross.setAttribute("opacity", 0);
      dot.setAttribute("opacity", 0);
      tip.classList.remove("on");
    };
    wrap._hide = hide;

    function nearestByIndex(idx) {
      let best = null, bd = Infinity;
      for (const p of pts) {
        const d2 = Math.abs(p[2] - idx);
        if (d2 < bd) { bd = d2; best = p; }
      }
      return best;
    }

    // hit target spans the full plot height, not just the 2px line
    svg.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      let best = null, bd = Infinity;
      for (const p of pts) {
        const d2 = Math.abs(scaleX(p[0]) - mx);
        if (d2 < bd) { bd = d2; best = p; }
      }
      if (best) (group ? group.emit(best[2]) : wrap._show(best[2]));
    });
    svg.addEventListener("pointerleave", () => (group ? group.emit(null) : hide()));
  }

  draw();
  const ro = new ResizeObserver(draw);
  ro.observe(wrap);

  if (group) {
    group.add(i => (i === null ? wrap._hide?.() : wrap._show?.(i)));
  }
  return { destroy() { ro.disconnect(); } };
}

/** Horizontal-baseline bar chart: 4px rounded data-ends, 2px gaps. */
export function barChart(container, spec) {
  const { labels, values, height = 150, yFormat = String, tipFormat } = spec;
  const wrap = document.createElement("div");
  wrap.className = "chart";
  container.appendChild(wrap);

  const tip = document.createElement("div");
  tip.className = "tooltip";
  wrap.appendChild(tip);

  let svg, W = 0;
  const H = height;

  function draw() {
    const width = wrap.clientWidth || 600;
    if (width === W) return;
    W = width;
    if (svg) svg.remove();

    svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    const iw = W - M.left - M.right;
    const ih = H - M.top - M.bottom;

    const vmax = Math.max(...values);
    const vmin = Math.min(...values);
    // bars start at a baseline just below the smallest value so differences
    // between similar splits stay visible without truncating to zero
    const base = Math.max(0, vmin - (vmax - vmin) * 0.6 - 1);
    const scaleY = v => M.top + ih - ((v - base) / ((vmax - base) || 1)) * ih;

    for (const t of ticks(base, vmax)) {
      const yy = scaleY(t);
      if (yy < M.top - 1 || yy > M.top + ih + 1) continue;
      svg.appendChild(el("line", { class: "gridline", x1: M.left, x2: M.left + iw, y1: yy, y2: yy }));
      const label = el("text", { class: "tick", x: M.left - 8, y: yy + 4, "text-anchor": "end" });
      label.textContent = yFormat(t);
      svg.appendChild(label);
    }

    const slot = iw / values.length;
    // 2px surface gap between bars, and a cap so a handful of bars do not
    // stretch into slabs that read as blocks of colour rather than as marks
    const bw = Math.max(2, Math.min(slot - 2, 56));

    values.forEach((v, i) => {
      const x = M.left + i * slot + (slot - bw) / 2;
      const y = scaleY(v);
      const h = M.top + ih - y;
      const r = Math.min(4, bw / 2, h);        // rounded data-end only
      const bar = el("path", {
        class: "bar",
        d: `M${x},${M.top + ih} L${x},${y + r} Q${x},${y} ${x + r},${y} `
         + `L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} `
         + `L${x + bw},${M.top + ih} Z`,
      });
      bar.addEventListener("pointerenter", () => {
        tip.innerHTML = tipFormat ? tipFormat(i) : `<span class="v">${yFormat(v)}</span>`;
        tip.classList.add("on");
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(x + bw / 2 - tw / 2, 0), W - tw)}px`;
        tip.style.top = `${Math.max(y - 40, 0)}px`;
      });
      bar.addEventListener("pointerleave", () => tip.classList.remove("on"));
      svg.appendChild(bar);
    });

    // label every few bars only — never a number on every mark
    const stride = Math.ceil(values.length / 12);
    labels.forEach((lab, i) => {
      if (i % stride) return;
      const t = el("text", {
        class: "tick", x: M.left + i * slot + slot / 2, y: H - 6, "text-anchor": "middle",
      });
      t.textContent = lab;
      svg.appendChild(t);
    });

    svg.appendChild(el("line", {
      class: "baseline", x1: M.left, x2: M.left + iw, y1: M.top + ih, y2: M.top + ih,
    }));
    wrap.appendChild(svg);
  }

  draw();
  new ResizeObserver(draw).observe(wrap);
}
