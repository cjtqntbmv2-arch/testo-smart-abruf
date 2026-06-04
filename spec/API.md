# API — routes the server defines

All routes are defined in `backend/server.js` on an Express app with `express.json()` body parsing. No auth, no CORS config (same-origin). Base: `http://localhost:<PORT>` (default 3000). Content type is JSON unless noted.

The proxy routes (`/api/testo/*`) consume the **external** testo Smart Connect API via `TestoClient`; for the shapes they fetch upstream, see `API_DOCS` (`05-endpoints/`). Documented here is only what *this server* exposes.

## Static / root

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | Sends `Smart Meter Dashboard/Klima Dashboard.html` |
| GET | `/*` (static) | `express.static('Smart Meter Dashboard')` serves `data.js`, `*.jsx`, `uploads/*`, etc. |

## Settings

### GET `/api/settings`
Response:
```json
{ "api_key": "", "api_region": "eu", "poll_interval_sec": 900, "retention_days": 365 }
```
`poll_interval_sec` and `retention_days` are parsed to integers; `api_key`/`api_region` default to `''`/`'eu'`.

### POST `/api/settings`
Request (all fields optional; only provided fields are saved):
```json
{ "api_key": "...", "api_region": "eu", "poll_interval_sec": 900, "retention_days": 365 }
```
Side effect: calls `startScheduler()` (restarts the interval timer with the new interval). Response: `{ "success": true }`.

## Stations

### GET `/api/stations`
Response: `stations.*` rows as-is — `SELECT * FROM stations` (array of full station rows, see DATA_MODEL.md).

### POST `/api/stations`  (create or update / "Zuweisungsmanager")
Request:
```json
{ "id": "kitchen", "name": "Küche", "location": "EG · Nord", "mo_uuid": null, "device_uuid": "..." }
```
Upsert via `INSERT … ON CONFLICT(id) DO UPDATE SET name, location, mo_uuid, device_uuid` — **must not** delete-then-insert (preserves measurements/events/telemetry). Side effect: `runSyncCycle()` fired (fire-and-forget). Response: `{ "success": true }`.

### DELETE `/api/stations/:id`
`DELETE FROM stations WHERE id = ?` (cascades to measurements/events). Response: `{ "success": true }`.

### GET `/api/stations/:id/metrics`
Last 24h (`since = now − 86400000`). Response shape in DATA_MODEL.md (`timestamps` + `metrics.{temperature,humidity,pressure}` with forward-filled aligned series). Empty data → empty series with default units. **Does not** return dewpoint/abshumid.

### GET `/api/stations/:id/events`
`SELECT * FROM events WHERE station_id = ? ORDER BY active DESC, start_ts DESC` — array of full event rows.

## Aggregate

### GET `/api/totals`
Counts active events by severity across **all** stations:
```json
{ "alarm": 0, "warning": 0, "system": 0 }
```
SQL: `SUM(CASE WHEN severity='alarm' AND active=1 …)` etc. (`system` is always 0 in practice — no system events are ever inserted).

## testo cloud proxies (require configured `api_key`)

### GET `/api/testo/measuring-objects`
Reads `api_key`/`api_region` settings; if no key → `400 {"error":"API key not configured"}`. Else `new TestoClient(apiKey, region).fetchMeasuringObjects()` and returns the raw array. On exception → `500 {"error": e.message}`. Used by the settings "Verbindung testen" button.

### GET `/api/testo/devices`
Like above; calls `fetchDeviceProperties()`, then **deduplicates to one entry per `device_uuid`**:
```json
[ { "device_uuid": "...", "name": "Mock Logger", "serial_no": "MOCK123", "model_code": "testo-160-THE" } ]
```
`name = device_display_name || device_uuid`. `400` if no key, `500` on error. Used by the station-assignment device picker.

## System status

### GET `/api/system/status`
Aggregates DB stats, scheduler status, and host storage. Response shape:
```json
{
  "database": {
    "status": "ok",
    "sizeBytes": 0,
    "rowCount": 0,                      // measurements+events+stations+settings
    "lastWrite": 0,                     // max(measurements.timestamp, events.start_ts) || now
    "oldestRecord": 0,                  // min(measurements.timestamp, events.start_ts) || now-30d
    "engine": "SQLite 3",
    "tableRows": { "measurements":0, "events":0, "stations":0, "settings":0 }
  },
  "scheduler": {
    "isActive": true, "isSyncing": false, "lastSyncTime": 0,
    "lastSyncStatus": "never|skipped|success|error", "lastSyncError": null,
    "pollIntervalSec": 900, "diagnostics": { "devicesSeen":0,"sensorsSeen":0,"measurementsFetched":0,"measurementsUnmatched":0,"alarmsUnmatched":0 }
  },
  "storage": { "usedGb": 0.1, "totalGb": 16.0, "status": "ok|warn" },
  "api": { "status": "ok|warn|err", "apiKeyConfigured": false, "region": "eu" }
}
```
Storage uses `fs.statfsSync(dirname(dbPath))`; for `:memory:` returns `{usedGb:0.1,totalGb:16.0}`; on error falls back to `{usedGb:10.0,totalGb:50.0}`. `status:'warn'` if free < 1 GB. `api.status` = `'err'` if last sync errored, else `'ok'` if key configured else `'warn'`. Polled by the settings page every 10 s.

> Note: `database.status` is hardcoded `"ok"`, and the `:memory:`/error storage numbers are fabricated placeholders. Reproduce as-is.

## Error conventions

- Validation/missing-key on proxy routes: HTTP `400`, body `{ "error": "<message>" }`.
- Upstream/exception on proxy routes: HTTP `500`, body `{ "error": e.message }`.
- All other routes assume valid input (no input validation) and return `200` with `{success:true}` or the data. (Lack of input validation on `POST /api/stations`/`/api/settings` is a known gap.)

## Open Questions

- `POST /api/settings` accepts and persists arbitrary values without validation/whitelisting beyond the four named fields; a rebuild may add validation, but current behavior is permissive.
