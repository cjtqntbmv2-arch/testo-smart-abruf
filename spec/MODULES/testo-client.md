# Module: `backend/testo-client.js`

Client for the testo Smart Connect API. Implements the upstream async submit→poll→download pattern (see `API_DOCS` `03-async-pattern.md`), with retry/backoff, gzip handling, and a deterministic mock mode. Exports the class:

```js
module.exports = TestoClient;
```

## Constructor

```js
new TestoClient(apiKey, region = 'eu', opts = {})
```
- `baseUrl = https://data-api.${region}.smartconnect.testo.com`
- `retryAttempts = opts.retryAttempts ?? 3`
- `retryBaseMs = opts.retryBaseMs ?? 500`

## Public methods (all async, all use the async flow)

| Method | POST path | GET poll prefix | Body |
|---|---|---|---|
| `fetchDeviceStatus()` | `/v3/devices/status` | `/v3/devices/status` | `{options:{result_file_format:'JSON'}}` |
| `fetchMeasuringObjects()` | `/v1/measuring-objects` | `/v1/measuring-objects` | `{options:{result_file_format:'JSON'}}` |
| `fetchDeviceProperties()` | `/v3/devices/properties` | `/v3/devices/properties` | `{options:{result_file_format:'JSON'}}` |
| `fetchMeasurements(params)` | `/v2/measurements` | `/v2/measurements` | `{date_time_from, date_time_until, options:{result_file_format:'JSON'}, odata}` |
| `fetchAlarms(params)` | `/v3/alarms` | `/v3/alarms` | `{date_time_from, date_time_until, options:{result_file_format:'JSON'}, odata}` |

Each returns the **flattened array of downloaded records** (all data files concatenated). `params.odata` is passed straight through (the scheduler sends `{ $filter: "sensor_uuid eq '…' or …" }`). For exact upstream request/response field names, see `API_DOCS` `05-endpoints/`.

## Internal flow

### `_executeAsyncFlow(postPath, getPathPrefix, requestBody)`
1. `POST` the body → expects `{ request_uuid }`; throws `No request_uuid returned by POST <path>` if absent.
2. `_poll(`${getPathPrefix}/${uuid}`)` → returns `data_urls`.
3. `_downloadFiles(dataUrls)` → returns concatenated records.

### `_request(path, method='GET', body=null)`
- **Mock mode**: if `apiKey === 'mock-api-key'`, returns canned responses for the submit/poll path pairs (status → `{request_uuid:'mock-…-req'}` on POST; the poll path → `{status:'Completed', data_urls:['mock://…']}`). Pairs covered: devices/status, measuring-objects, measurements, alarms, devices/properties.
- Real: `fetch(baseUrl+path, {method, headers:{'x-custom-api-key':apiKey,'Content-Type':'application/json'}, body?})` via `_fetchWithRetry`.
- On non-ok response: reads body (gunzips if magic bytes `0x1f 0x8b`), tries to extract `message`/`error` from JSON, throws `HTTP error! status: <code> on <path>[: <msg>]`.
- Returns `response.json()`.

### `_fetchWithRetry(url, options)`
Retries **transport-level** rejections only (`fetch` throwing `TypeError`, real reason in `err.cause`). Exponential backoff `retryBaseMs * 2^i` between attempts, up to `retryAttempts`. On final failure throws `Error("fetch failed for <url> after N attempt(s) (<code/name>: <msg>)")` with `.cause` set. **A returned HTTP response (even 4xx/5xx) is NOT retried** — that is the caller's concern.

### `_poll(pollPath, maxBudgetSec=300)`
Polls `_request(pollPath)` until `status === 'Completed'` (returns `data_urls`). Throws on `status === 'Failed' || 'Error'`. Delay starts 2000 ms, doubles to max 30000 ms each loop. Throws `Polling timeout` after `maxBudgetSec`.

### `_downloadFiles(urls)`
For each url:
- `mock://…` → returns the matching canned fixture array (status/mo/meas/alarms/properties). The `mock://meas` fixture returns 2 records (Temperature, Humidity) with randomized uuids; `mock://properties` returns 2 channel rows.
- Real url → `_fetchWithRetry(url)`; gunzip if magic bytes; parse as JSON array, or if that fails, parse as **NDJSON** (one JSON object per line). Concatenate all records.

## Mock fixtures (deterministic, for tests/offline) — shapes

Reproduce these so tests pass. Representative `mock://meas` record:
```js
{ uuid:`meas-<ts>-<rand>-1`, sensor_uuid:'mock-sensor-temp', timestamp:<ISO>, timestamp_local:<locale>,
  measurement:23.5, physical_property_name:'Temperature', physical_unit:'°C', channel_no:1,
  serial_no:'MOCK123-S1', model_code:'testo-160-THE', processed_at:<ISO> }
```
`mock://properties` rows include `device_uuid:'mock-device-uuid'`, `sensor_uuid`, `sensor_serial_no`, `channel_no`, `channel_physical_property_name`. `mock://status` includes `battery_level_percent`, `radio_level_percent`, `connection_type`, `is_powersupply_on`, `fw_version`, `model_code`, and ISO `last_communication`/`last_measurement_time`/`next_communication`. (Note: mock data lacks `physical_extension`, so derived-channel classification isn't exercised by mock measurements.)

## Error handling summary

| Situation | Result |
|---|---|
| Transient transport failure | retried w/ backoff, then thrown with cause |
| HTTP 4xx/5xx | thrown immediately (not retried), message extracted from (possibly gzipped) body |
| Poll returns Failed/Error | thrown |
| Poll exceeds budget | thrown (timeout) |
| Missing `request_uuid` | thrown |

## Dependencies / side effects

- Node global `fetch`; `zlib` for gunzip; `setTimeout` for backoff. `require('dotenv').config()` at load. No DB access.

## Open Questions

- Upstream status enum has a known doc/spec mismatch (`Error` vs `Failed`); this client treats both `Failed` and `Error` as failure and only `Completed` as success — consistent with `API_DOCS` guidance.
