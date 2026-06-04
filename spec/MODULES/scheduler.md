# Module: `backend/scheduler.js`

Periodic sync orchestration. Pulls from testo via `TestoClient`, routes via `device-bridge`, persists via `db`.

```js
module.exports = { runSyncCycle, startScheduler, stopScheduler, getSchedulerStatus };
```

Module-level mutable state: `isSyncing`, `lastSyncTime`, `lastSyncStatus` (`'never'` initial), `lastSyncError`, `lastSyncDiag`, `timer`.

## `runSyncCycle(customClient = null) → Promise<void>`

Re-entrancy guarded by `isSyncing` (returns immediately if a cycle is in flight). Reads `api_key`/`api_region`; if no key → sets status `'skipped'`, error `'No API Key configured'`, returns. Otherwise runs four phases (details in ARCHITECTURE.md §sync pipeline). `customClient` lets tests inject a client. Each phase has its own try/catch that sets `hasError`/`errorMsg` without aborting the cycle; an outer try/catch handles unexpected failures; `finally` clears `isSyncing`.

Key implementation literals to preserve:

```js
const parseTimestamp = (str) => { if(!str) return null; const ts=new Date(str).getTime(); return isNaN(ts)?null:ts; };
```

**Phase 0 (properties→bridge):** `buildDeviceBridge(await client.fetchDeviceProperties())`; set `diag.devicesSeen/sensorsSeen`. On failure: keep empty bridge, mark error.

**Phase 1 (status):** `UPDATE stations SET battery, signal, connection_type, is_powersupply_on, fw_version, model_code, last_communication, last_measurement_time, next_communication, serial_no WHERE device_uuid=?` for each status record (`is_powersupply_on ? 1 : 0`; timestamps via `parseTimestamp`). One `db.transaction`.

**Phase 2 (measurements):**
- Build `deviceToStation: Map<device_uuid, station_id>` from stations where `device_uuid` non-empty (warn on duplicates; last wins).
- `assignedSensors` = union of `bridge.deviceSensors.get(device_uuid)` over stations. `filter = buildSensorFilter(assignedSensors)`; if `null`, skip.
- `windowStart` = min over stations (that have sensors) of `max(timestamp)+1000` (`SELECT max(timestamp)…WHERE station_id=?`), falling back to `now − 86400000`.
- `client.fetchMeasurements({ date_time_from: new Date(windowStart).toISOString(), date_time_until: new Date().toISOString(), odata:{$filter:filter} })`. **`date_time_until` is required** (open-ended request is page-capped → sync freezes).
- For each row: `dev = sensorToDevice.get(sensor_uuid)`; `stationId = deviceToStation.get(dev)`; `prop = mapPhysicalProperty(physical_property_name, physical_extension)`. If no station or no prop → `diag.measurementsUnmatched++`, skip. Else `INSERT OR IGNORE INTO measurements(uuid, station_id, timestamp, timestamp_local, value, physical_property, unit, channel_no, sensor_uuid, serial_no, model_code, processed_at)`. One transaction. `diag.measurementsFetched = measurements.length`.

**Phase 3 (alarms):**
- Watermark `last_alarm_sync_time` (epoch ms via setting); default `now − 7·86400000`. `alarmUntil = now`.
- `client.fetchAlarms({date_time_from: lastSync.toISOString(), date_time_until: new Date(alarmUntil).toISOString()})`.
- Resolve device: `serialToDevice.get(serial_no) || sensorToDevice.get(alarm_source_uuid) || (devices.has(alarm_source_uuid) ? alarm_source_uuid : null)` → station. If none → `diag.alarmsUnmatched++`, skip.
- `INSERT OR REPLACE INTO events(uuid, station_id, severity, alarm_status, alarm_reason, alarm_condition_type, alarm_value, metric, threshold, start_ts, end_ts, extreme, active, message, detail)` with: severity normalization (`'alarm'` if `alarm_severity` lowercases to `'alarm'` else `'warning'`), `metric = mapPhysicalProperty(physical_value)`, `threshold = null`, `start_ts = parseTimestamp(alarm_time)`, `end_ts = parseTimestamp(last_status_change_time)`, `extreme = alarm_value`, `active = alarm_status==='Active'?1:0`, `message = alarm_reason || 'Grenzwert verletzt'`, `detail = `Sensor ${serial_no} hat einen Wert von ${alarm_value} gemeldet.``.
- Advance watermark `saveSetting('last_alarm_sync_time', String(alarmUntil))` **only if `bridge.devices.size > 0`**.

**Phase 4 (retention):** `days = parseInt(retention_days||'365')` guarded to 365 if NaN/≤0. `limit = now − days·86400000`. `DELETE FROM measurements WHERE timestamp<?`; `DELETE FROM events WHERE start_ts<?`.

Finalize: `lastSyncTime=now`, `lastSyncStatus = hasError?'error':'success'`, `lastSyncError`, `lastSyncDiag=diag`.

## `startScheduler()`
Clears existing `timer`. `intervalSec = parseInt(poll_interval_sec||'900')` guarded to 900 if NaN/≤0. Logs. Runs one `runSyncCycle().catch(console.error)` immediately, then `setInterval(runSyncCycle, intervalSec*1000)`.

## `stopScheduler()`
Clears + nulls `timer`.

## `getSchedulerStatus()`
Returns `{ isActive: timer!==null, isSyncing, lastSyncTime, lastSyncStatus, lastSyncError, pollIntervalSec: parseInt(poll_interval_sec||'900'), diagnostics: lastSyncDiag }`.

## Dependencies / side effects

- `db` (sync reads/writes/transactions), `TestoClient` (network), `device-bridge` (pure).
- Module-level singleton status + interval timer. `console.warn/error/log` for diagnostics.

## Open Questions

None beyond those in ARCHITECTURE.md (dead dewpoint/abshumid storage; system severity never produced).
