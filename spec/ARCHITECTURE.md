# Architecture

## Process & deployment model

Single Node.js process (`backend/server.js`). On startup it:

1. `dns.setDefaultResultOrder('ipv4first')` — forces IPv4 resolution first (avoids slow/failing IPv6 first-hop to the testo cloud).
2. `require('dotenv').config()` — loads `.env`.
3. `initDb()` — opens SQLite, creates tables if missing, seeds default settings on first run.
4. `startScheduler()` — runs one sync cycle immediately, then on an interval.
5. Builds the Express app, mounts JSON body parsing, static file serving for `Smart Meter Dashboard/`, and the REST routes.
6. Listens on `PORT` (default `3000`).

The browser loads `Klima Dashboard.html`, which pulls React/ReactDOM/Babel from CDNs and the four local JSX/JS files. All rendering, layout persistence, threshold evaluation, and most "settings" state live in the browser (localStorage). The server is a thin data/sync layer.

```
┌─────────── Browser (SPA) ───────────┐        ┌──────── Node process ────────┐        ┌─ testo cloud ─┐
│ app.jsx / settings.jsx / tiles.jsx  │  HTTP  │ express routes (server.js)   │  HTTPS │ Smart Connect │
│ charts.jsx                          │ ◀────▶ │   /api/*                     │ ◀────▶ │ async REST API│
│ data.js  → window.DASH_DATA         │  JSON  │ scheduler.js (setInterval)   │  (poll)│ (API_DOCS)    │
│   - polls /api/* every 5 s          │        │   runSyncCycle()             │        └───────────────┘
│   - localStorage: layout, settings, │        │ testo-client.js              │
│     thresholds, calibration         │        │ device-bridge.js (pure)      │
│   - derives dewpoint/abshumid       │        │ db.js → better-sqlite3       │
│   - generates local threshold events│        │   klima.db (SQLite)          │
└─────────────────────────────────────┘        └──────────────────────────────┘
```

## Module responsibilities

| Module | Responsibility | Detail |
|---|---|---|
| `server.js` | HTTP surface + entry point | Express routes, static serving, system-status aggregation, process bootstrap |
| `db.js` | Persistence | Singleton SQLite connection, schema DDL, `getSetting`/`saveSetting`, first-run seed |
| `scheduler.js` | Sync orchestration | `runSyncCycle` (4 phases), `startScheduler`/`stopScheduler`, status/diagnostics |
| `testo-client.js` | Upstream API client | Async submit→poll→download flow, retry w/ backoff, gzip decode, mock mode |
| `device-bridge.js` | Pure mapping helpers | `mapPhysicalProperty`, `buildDeviceBridge`, `buildSensorFilter` (no I/O, unit-tested) |
| `data.js` (frontend) | Reactive data layer | `window.DASH_DATA`: polling, station cache, derived metrics, local event generation, formatters |
| `charts.jsx` | SVG chart primitives | `Sparkline`, `LineChart`, `Gauge`, `useSize` |
| `tiles.jsx` | Tile system | Tile type registry, collision layout math, per-type tile bodies, alerts list + timeline |
| `app.jsx` | App shell | Grid render, drag/resize engine, add/edit/threshold dialogs, header, station selector, routing between dashboard/settings |
| `settings.jsx` | Settings page | Section router + sections (overview/api/database/stations/notifications/advanced) + UI primitives |

GUI entry files exceed the project's 400-line guideline (`app.jsx` 776, `settings.jsx` 1076). This is a known debt; the rebuild may legitimately split them but must preserve behavior. See GUI.md.

## The sync pipeline (`scheduler.runSyncCycle`)

Guarded by a module-level `isSyncing` boolean (re-entrancy lock): if a cycle is already running, a new call returns immediately. Each cycle:

**Phase 0 — Device Properties → bridge.** `client.fetchDeviceProperties()` returns one row per channel. `buildDeviceBridge()` turns these into four lookups: `sensorToDevice`, `deviceSensors`, `serialToDevice`, `devices`. If this fails, the cycle continues with empty maps (and marks `hasError`), but later phases that need the bridge will no-op or skip watermark advancement.

**Phase 1 — Device Status.** `client.fetchDeviceStatus()` → for each record, `UPDATE stations … WHERE device_uuid = ?` (battery, signal, connection_type, is_powersupply_on, fw_version, model_code, last_communication, last_measurement_time, next_communication, serial_no). Wrapped in a single `db.transaction`.

**Phase 2 — Measurements.** Build the set of assigned sensor UUIDs (sensors belonging to devices that stations point at). `buildSensorFilter()` → OData `$filter` of `sensor_uuid eq '…' or …`. If no sensors resolve, skip. Otherwise compute `windowStart` = the **minimum** over assigned stations of `max(timestamp)+1000ms` (falling back to 24h ago for stations with no data) — i.e. start from the most-lagging station so none is under-fetched. Fetch `client.fetchMeasurements({date_time_from, date_time_until: now, odata:{$filter}})`. **`date_time_until` is mandatory**: an open-ended measurements request is capped by the API at a small default page (~16 rows) and sync would freeze. Each returned row is routed sensor→device→station via the bridge, its property classified by `mapPhysicalProperty(name, extension)`, and inserted with `INSERT OR IGNORE` (dedupe on row `uuid`). Rows that don't resolve to a station or a known metric are counted in `diag.measurementsUnmatched`.

**Phase 3 — Alarms.** Watermark stored in setting `last_alarm_sync_time` (epoch ms); default window = last 7 days. Fetch `client.fetchAlarms({date_time_from, date_time_until: now})` (bounded for the same default-page reason). Resolve each alarm's device via `serialToDevice[serial_no]` → `sensorToDevice[alarm_source_uuid]` → (alarm_source_uuid if it is itself a device). Insert with `INSERT OR REPLACE` into `events` (severity normalized to `'alarm'`/`'warning'`, German message strings). Unrouted alarms counted in `diag.alarmsUnmatched`. **Advance the watermark only if the bridge had ≥1 device** (otherwise alarms fetched now couldn't be routed and would be lost).

**Phase 4 — Retention cleanup.** `DELETE FROM measurements WHERE timestamp < limit` and `DELETE FROM events WHERE start_ts < limit`, where `limit = now − retention_days·86400000` (retention_days defaults to 365, guarded against ≤0/NaN).

After all phases: set `lastSyncTime`, `lastSyncStatus` (`success`/`error`), `lastSyncError`, `lastSyncDiag`. The `finally` always clears `isSyncing`.

`mapPhysicalProperty` is also called for alarm `physical_value` (single-arg form) to populate `events.metric`.

## Scheduler lifecycle

- `startScheduler()` clears any existing `setInterval`, reads `poll_interval_sec` (default 900, guarded), logs, runs one cycle immediately, then sets an interval. It is called at boot **and** after every `POST /api/settings` (to apply a changed interval) **and** indirectly each cycle is also kicked by `POST /api/stations` via `runSyncCycle()`.
- `stopScheduler()` clears the interval.
- `getSchedulerStatus()` returns `{isActive, isSyncing, lastSyncTime, lastSyncStatus, lastSyncError, pollIntervalSec, diagnostics}`.

## Concurrency / async model

- Backend is single-threaded Node; `better-sqlite3` is **synchronous** (no await on DB calls). Only network I/O (`fetch`) is async.
- The only shared mutable state guarded against overlap is `isSyncing`. `POST /api/stations` calls `runSyncCycle().catch(console.error)` fire-and-forget; if a cycle is already running it is a no-op.
- Frontend: a single `setInterval(refresh, 5000)` in `data.js` plus event-driven `refresh()` on station switch / station save. `refresh()` has **no re-entrancy guard** (a known issue) — overlapping slow fetches can interleave; the last writer to `STATIONS` wins.

## Two parallel event/alarm systems (important design fact)

There are **two** sources of "events" the dashboard shows, merged per station in `data.js`:

1. **Backend alarms** — fetched from testo, stored in the `events` table, returned by `GET /api/stations/:id/events`. IDs are the testo row `uuid`.
2. **Frontend local threshold events** — generated in the browser by `generateLocalThresholdEvents()` from the last-24h series against the station's localStorage thresholds. IDs match `…-local-e-N`. These are **not persisted** and exist only while the dashboard is open.

Consequence: **threshold breach alerting only works while a browser has the dashboard open.** There is no server-side threshold evaluation or background notification. The Notifications settings section is non-functional UI (see GUI.md / Open Questions).

## Derived metrics (where computed)

The server's `/api/stations/:id/metrics` returns only `temperature`, `humidity`, `pressure`. `dewpoint` and `abshumid` **are stored** in the `measurements` table (the scheduler classifies and inserts them) but are **not returned** by that endpoint. The frontend (`data.js`) **recomputes** dewpoint and absolute humidity from temperature + relative humidity using formulas, after applying per-station calibration offsets. So stored dewpoint/abshumid rows are effectively write-only via the live API path. (See DATA_MODEL.md Open Questions.)

## Design patterns in play

- **Singleton DB connection** (`db.js` module-level `db`).
- **Module-singleton mutable status** (`scheduler.js` `lastSync*`).
- **Pure-core / impure-shell**: `device-bridge.js` is pure and unit-tested in isolation; `scheduler.js` does the I/O.
- **Async polling client with retry/backoff** (`testo-client.js`); transport errors retried with exponential backoff, HTTP error responses **not** retried.
- **Observer**: `window.DASH_DATA.subscribe(fn)` → React components call `forceTick` on emit.
- **Computed reactive cache**: `DASH_DATA` rebuilds the whole `STATIONS` map each refresh and emits.
- **Mock mode**: `testo-client.js` short-circuits all network calls when `apiKey === 'mock-api-key'`, returning deterministic fixtures (used by tests).

## Tests (`backend/tests/`, `node:test`)

| File | Asserts |
|---|---|
| `db.test.js` | Schema setup + settings get/save; FK `ON DELETE CASCADE` from stations to measurements/events |
| `device-bridge.test.js` | `mapPhysicalProperty` name mapping; extension disambiguation of derived channels; `buildDeviceBridge` maps; `buildSensorFilter` OR-join + null-when-empty |
| `init.test.js` | Required env vars + package deps present |
| `scheduler.test.js` | Full cycle resolves devices/measurements/alarms + cleanup; survives property-fetch failure; multi-sensor OR filter; **measurement fetch is bounded with `date_time_until`**; unmatched alarms counted not inserted |
| `server.test.js` | Core REST shapes; `/api/testo/devices` dedup + 400 w/o key; **`POST /api/stations` update preserves measurements/telemetry (no cascade wipe)** |
| `testo-client.test.js` | Async submit/poll; device-properties flow; mock-mode consistency; retry transient then succeed; surface cause after exhaustion; do **not** retry HTTP errors; download retry |

Tests run against `:memory:` SQLite (`DB_PATH=':memory:'`) and `mock-api-key`.

## Open Questions

- The frontend `refresh()` has no in-flight guard; under slow networks concurrent refreshes can interleave. Whether the rebuild should add one is a design decision; current behavior is "no guard."
- `last_alarm_sync_time` is the only setting written by the scheduler (not exposed via `/api/settings`); the rebuild must keep it as an internal settings row.
