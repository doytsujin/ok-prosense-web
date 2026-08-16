# Trace

Drop a FIT, TCX or GPX file and read it: route, pace, heart rate, elevation,
splits.

**→ https://doytsujin.github.io/ok-prosense-web/**

Your file is parsed by JavaScript in your own tab. There is no upload, no
backend, no account and no analytics. The page is static; you can save it and
use it offline.

```
index.html  app.js  chart.js  map.js  style.css
parse/      model.js  fit.js  xmlfmt.js
vendor/     leaflet 1.9.4
selftest.html
```

No build step, no framework, no package manager. Open `index.html` and it
works.

## What it reads

| Format | Notes |
|---|---|
| **FIT** | record, lap, session, sport and file_id messages; both endiannesses; invalid-value handling; developer fields skipped without losing alignment |
| **TCX** | trackpoints, laps, calories, TPX speed/power extensions |
| **GPX** | trackpoints, Garmin `TrackPointExtension` hr/cad/atemp |
| **JSON** | the normalized schema written by the `prosense` CLI — see [below](#where-this-came-from) |

Format is detected from the content, not the extension, so a renamed export
still works.

## Numbers are derived, not copied

Distance, pace, ascent and moving time come from the samples rather than from
the file's own summary block, so two exports of the same activity agree instead
of differing by whatever each writer rounded.

Two derivations worth knowing about:

- **Ascent** smooths the elevation trace before accumulating past a 3 m
  threshold. A threshold alone does not work: oscillation whose amplitude sits
  near the threshold crosses it on every sample, so the filter passes
  everything. Un-smoothed, a flat activity with ±1.5 m of sensor jitter
  accumulates hundreds of metres of climb that never happened. There is a test
  for exactly this.
- **Moving time** excludes samples under 0.5 m/s, so waiting at a light does
  not inflate average pace.

Pace is derived from speed — from distance over time where the file has no
speed channel — and smoothed over ~15 samples. Instantaneous pace off a GPS fix
every few seconds is mostly sensor noise; unsmoothed it renders as a solid band
with no readable shape.

## Privacy

The file never leaves the tab. That claim is worth being precise about, because
one feature could break it:

**Map tiles are off by default.** A basemap is fetched from OpenStreetMap tile
by tile, and those requests carry the tile coordinates — enough to say roughly
where you were. On a page whose whole premise is that nothing leaves your
browser, turning that on has to be your decision, so it is a toggle that starts
off. With tiles off the route still renders on a blank surface with its
geometry and scale intact.

Leaflet is vendored rather than loaded from a CDN, so the page works offline
and no third-party host can change it under you.

## Charts

Each chart carries a **single series** and its title names it. No dual axes, no
legend to decode, no categorical palette to get wrong — one blue hue
throughout, validated for contrast against both the light and dark chart
surfaces. Every chart has a hover crosshair, and hovering any chart moves the
marker on the map, so a spike in heart rate can be located on the route. Splits
carry a table view for what colour and shape cannot convey.

Dark mode is a selected set of steps from the same ramps, checked against the
dark surface — not an automatic inversion.

## Tests

Open [`selftest.html`](selftest.html). It generates a FIT, a TCX, a GPX and a
JSON file in the page, reads each back, and checks them against each other —
30 assertions, no fixtures on disk and no real location data. The title reads
`PASS` or `FAIL (n)`.

The interesting assertion is the cross-format one: FIT, TCX and JSON all
*state* a distance and must agree exactly, while GPX carries no distance field,
so its figure is measured off the track and only has to land within 10%. A
single-format test would not have caught a namespace bug that silently dropped
heart rate from GPX files while everything else still parsed.

## Where this came from

Written to read the output of `prosense`, a separate command-line tool that
pulls activities off an Epson ProSense GPS watch over Bluetooth — Epson shut its
sync service down on 2025-03-31, stranding the data on-device. That watch's own
record format is decoded locally by the CLI, because doing it needs Epson's own
decoder library and that is not something this page can ship. The CLI is not
part of this repository; the JSON it emits is just one of the four formats
listed above, and nothing here depends on having it.

Everything here is format-agnostic, so it is just as useful for a Garmin,
Coros, Suunto or Strava export.

## Licence

MIT. Leaflet in `vendor/` is BSD-2-Clause, © Volodymyr Agafonkin and
CloudMade.
