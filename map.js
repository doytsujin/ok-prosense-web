/* Leaflet map with the activity route drawn on it.

   Tiles are OFF by default, and that is the whole point of the default.

   Your file is never uploaded — but a basemap is not free of that promise.
   Fetching tiles sends their coordinates to an external server, which is
   enough to say roughly where you were and when you asked. On a page whose
   entire premise is "nothing leaves this tab", turning that on has to be your
   decision, so it is a toggle that starts off. With tiles off the route still
   renders on a blank surface with its geometry and scale intact. */

const TILES = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
};

let tilesEnabled = false;

export function setTiles(on) { tilesEnabled = Boolean(on); }
export function tilesOn() { return tilesEnabled; }

export function routeMap(container, activity) {
  const s = activity.samples;
  const pts = [];
  for (let i = 0; i < (s.lat || []).length; i++) {
    if (s.lat[i] == null || s.lon[i] == null) continue;
    pts.push([s.lat[i], s.lon[i], i]);
  }

  if (pts.length < 2 || typeof L === "undefined") {
    const box = document.createElement("div");
    box.className = "map-empty";
    box.textContent = pts.length < 2
      ? "no GPS track recorded for this activity"
      : "map library unavailable offline";
    container.appendChild(box);
    return { highlight() {} };
  }

  const node = document.createElement("div");
  node.id = "map";
  container.appendChild(node);

  const latlngs = pts.map(p => [p[0], p[1]]);
  let map = null, cursor = null, route = null, casing = null;

  /* Leaflet measures its container exactly once, when the map is constructed.
     This container is created and appended in the same tick as the rest of the
     panel, so that measurement is 0×0 — and vectors then project into a
     zero-width viewport, producing the literal path "M0 0": present in the
     DOM, invisible on screen.

     Repairing it afterwards is unreliable. invalidateSize resizes the renderer
     without reprojecting existing paths, and a follow-up fitBounds is a no-op
     whenever it resolves to the view the map already has — so the paths keep
     their zero-width projection and the map stays blank.

     So: wait for a real width before constructing anything. */
  function build() {
    map = L.map(node, { scrollWheelZoom: false, attributionControl: true });
    if (tilesEnabled) {
      L.tileLayer(TILES.url, { attribution: TILES.attribution, maxZoom: TILES.maxZoom })
        .addTo(map);
    }

    const style = getComputedStyle(document.documentElement);
    const hue = style.getPropertyValue("--series-1").trim() || "#2a78d6";
    const surface = style.getPropertyValue("--surface-1").trim() || "#fcfcfb";

    // a surface-coloured casing under the route keeps it legible over any tile
    casing = L.polyline(latlngs, { color: surface, weight: 6, opacity: 0.9 }).addTo(map);
    route = L.polyline(latlngs, { color: hue, weight: 3, opacity: 1 }).addTo(map);

    L.circleMarker(latlngs[0], {
      radius: 5, color: surface, weight: 2, fillColor: hue, fillOpacity: 1,
    }).addTo(map).bindTooltip("start");

    cursor = L.circleMarker(latlngs[0], {
      radius: 6, color: surface, weight: 2, fillColor: hue, fillOpacity: 1,
    });

    map.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24] });
  }

  if (node.clientWidth) {
    build();
  } else {
    const once = new ResizeObserver(() => {
      if (!node.clientWidth) return;
      once.disconnect();
      build();
    });
    once.observe(node);
  }

  // later resizes: the renderer needs both a new size and a redraw, since
  // resizing on its own leaves the paths projected for the old viewport
  new ResizeObserver(() => {
    if (!map || !node.clientWidth) return;
    map.invalidateSize(false);
    casing?.redraw();
    route?.redraw();
  }).observe(node);

  return {
    /** Move the map cursor to the sample the charts are hovering. */
    highlight(i) {
      if (!map || !cursor) return;
      if (i === null || i === undefined) { cursor.remove(); return; }
      let best = null, bd = Infinity;
      for (const p of pts) {
        const d = Math.abs(p[2] - i);
        if (d < bd) { bd = d; best = p; }
      }
      if (!best) return;
      cursor.setLatLng([best[0], best[1]]);
      if (!map.hasLayer(cursor)) cursor.addTo(map);
    },
  };
}
