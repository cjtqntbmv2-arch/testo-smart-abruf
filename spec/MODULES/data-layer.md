# Module: `Smart Meter Dashboard/data.js` — `window.DASH_DATA`

Browser-side reactive data layer. An IIFE that builds and exposes `window.DASH_DATA`. No imports; talks to the local REST API by `fetch`. Drives the entire UI.

## Lifecycle

1. On load: seeds **four placeholder stations** synchronously so the UI renders before the first fetch resolves (avoids startup null errors). Seed ids/names/locations:
   - `living` → "Wohnzimmer" / "1. OG · Süd"
   - `bedroom` → "Schlafzimmer" / "1. OG · Nord"
   - `outdoor` → "Außensensor" / "Garten"
   - `basement` → "Keller" / "UG"
   Each seeded station has all 5 metrics filled with flat placeholder series (temperature 20.0, humidity 50.0, else 1013.0) of length `POINTS=144`. `activeStationId='living'`.
2. Calls `refresh()` immediately, then `setInterval(refresh, 5000)`.

## `refresh()` (async, no re-entrancy guard)

1. `GET /api/stations` → list. `GET /api/totals` → `totals`.
2. For each station: `GET /api/stations/:id/metrics` and `GET /api/stations/:id/events`.
3. If no timestamps returned, synthesize `POINTS` timestamps (`now − (POINTS-1-i)·STEP_MS`) and NaN series.
4. Keep global `timestamps` aligned to the active station (or first station if none active).
5. Apply per-station **calibration offsets** from `localStorage['dash-settings-v1'].calibration[stationId]` (`calT` added to every numeric temperature value, `calH` to humidity; NaN preserved).
6. Compute derived series `dewpoint` (`dewPoint(t,h)`) and `abshumid` (`absHumidity(t,h)`) from the calibrated T/RH (NaN where either input NaN). See DATA_MODEL.md for formulas.
7. Build each metric object: `{...META[id], series, unit: mData.unit||META.unit, domain:[lo,hi]}` where `[lo,hi]` is min/max of valid values (±1 if all equal); dewpoint/abshumid domain padded by margin (2 / 1) and floored/ceiled.
8. Normalize backend events to the merged event shape (id=uuid, condition from `alarm_condition_type.includes('UPPER')?'high':'low'`, etc.).
9. `getThresholdsForStation(id)` from `localStorage['dash-thresholds-<id>']` or defaults.
10. `generateLocalThresholdEvents(stationObj)` → merge with backend events, sort active-first then `startTs` desc.
11. Replace `STATIONS`/`STATION_ORDER`, fix up `activeStationId`, `emit()`.

## Local threshold event generation

`classify(thresholds, metricId, v)` → `'normal'|'warn-low'|'warn-high'|'alarm-low'|'alarm-high'` (alarm bounds checked before warn). `generateLocalThresholdEvents(station)` walks each metric's series over `timestamps`, opening an event when state leaves `'normal'`, tracking the extreme, and closing it on state change (or leaving it `active` at series end). Event id pattern: `${station.id}-local-e-${n}`. Severity = `alarm`/`warning` from state prefix; `condition` = `high`/`low` from suffix. These exist only in the browser (not persisted).

## Public surface (`window.DASH_DATA`)

| Member | Description |
|---|---|
| `POINTS`, `STEP_MS` | constants (144, 600000) |
| `timestamps` (getter) | active-aligned timestamp array |
| `metricIds` | `["temperature","humidity","pressure","dewpoint","abshumid"]` |
| `NOW` (getter) | `Date.now()` |
| `stats(arr)` | `{min,max,avg,last,first}` over numeric (non-NaN) values; all NaN if none |
| `stations`, `stationOrder`, `activeStationId`, `activeStation` (getters) | station cache |
| `setActiveStation(id)` | switch + `refresh()` (no-op if same/unknown) |
| `subscribe(fn)` | observer; returns unsubscribe |
| `metrics`, `thresholds`, `events` (getters) | active station shortcuts |
| `setThreshold(metricId, level, bound, value)` | mutate active station threshold, persist, recompute local events, emit |
| `recomputeStationEvents(stationId)` | recompute + re-merge + emit for one station |
| `classify(metricId, v)` | classify against active station thresholds |
| `formatValue(metric, v)` | `v.toFixed(decimals)+" "+unit`; `"—"` for null/NaN |
| `formatTime(ts)` | `de-DE` `HH:MM` |
| `formatRelative(ts)` | "gerade eben" / "vor N min" / "vor N h [N min]" / "vor N d" |
| `formatDuration(ms)` | "< 1 min" / "N min" / "N h [N min]" |
| `totalActive()` | returns `totals` `{alarm,warning,system}` |
| `forceApiRefresh()` | `await refresh()` (called by settings after station save/delete) |

## Open Questions

- `refresh()` re-entrancy (see ARCHITECTURE.md). The seeded placeholder stations (`living/bedroom/...`) are immediately replaced by real `/api/stations` data on first successful refresh; on an empty/fresh install the dashboard's `DEFAULT_LAYOUT` (app.jsx) references those seed ids — so on a clean DB the default tiles show placeholder/empty stations until the user creates stations with those ids. This coupling between seed ids and `DEFAULT_LAYOUT` is intentional-looking but fragile; reproduce as-is.
