const { getDb, getSetting, saveSetting } = require('./db');
const TestoClient = require('./testo-client');
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions, classifyAlarm, alarmConditionDirection, parseAlarmConfiguration, systemAlarmText, measurementAlarmText } = require('./device-bridge');
const { maybeRunBackupScan, computePruneFloor } = require('./backup-runner');

let isSyncing = false;
let lastSyncTime = null;
let lastSyncStatus = 'never';
let lastSyncError = null;
let lastSyncDiag = { devicesSeen: 0, sensorsSeen: 0, measurementsFetched: 0, measurementsUnmatched: 0, alarmsUnmatched: 0 };

const parseTimestamp = (str) => {
  if (!str) return null;
  const ts = new Date(str).getTime();
  return isNaN(ts) ? null : ts;
};

const SYSTEM_EVENT_TYPES = ['connection', 'battery'];

// Alarm-fetch window overlap (see runSyncCycle step 3): each alarm fetch pulls its lower
// bound back by this buffer so transitions whose server-side availability (processed_at)
// lags their alarm_time — or that a device backfills after being offline — are re-scanned
// instead of being skipped once the watermark has advanced past them. ON CONFLICT(uuid) on
// the insert makes the redundant re-fetch idempotent. Without this overlap a late recovery
// is filtered out forever, leaving its violation permanently active (the phantom-alarm bug).
const ALARM_WINDOW_OVERLAP_MS = 26 * 3600 * 1000;

// Reconcile a station's open system events against its current status snapshot.
// One stable synthetic row per (station, type) — opened on first detection (start_ts
// preserved across repeats), reopened if it had cleared, and closed (active=0,end_ts)
// when the condition no longer holds. /api/totals counts the active ones.
function applySystemEvents(db, stationId, snapshot, now) {
  const active = new Map(); // type -> { message, detail }
  for (const c of deriveSystemConditions(snapshot)) active.set(c.type, c);

  for (const type of SYSTEM_EVENT_TYPES) {
    const uuid = `sys-${type}-${stationId}`;
    const existing = db.prepare("SELECT active FROM events WHERE uuid = ?").get(uuid);

    if (active.has(type)) {
      const { message, detail } = active.get(type);
      if (!existing) {
        // Synthetic system rows have no testo alarm payload: alarm_status/alarm_value
        // stay NULL and alarm_reason reuses `message`. Statements are re-prepared per
        // call by design — better-sqlite3 caches them by SQL text, so this is cheap.
        db.prepare(`
          INSERT INTO events (uuid, station_id, severity, alarm_condition_type, alarm_reason,
                              start_ts, end_ts, active, message, detail)
          VALUES (?, ?, 'system', ?, ?, ?, NULL, 1, ?, ?)
        `).run(uuid, stationId, type, message, now, message, detail);
      } else if (existing.active === 0) {
        // Reopen as a NEW episode: start_ts is deliberately reset to now.
        db.prepare("UPDATE events SET active = 1, start_ts = ?, end_ts = NULL, message = ?, detail = ? WHERE uuid = ?")
          .run(now, message, detail, uuid);
      } else {
        // still active — refresh the detail (e.g. battery % changed)
        db.prepare("UPDATE events SET message = ?, detail = ? WHERE uuid = ?")
          .run(message, detail, uuid);
      }
    } else if (existing && existing.active === 1) {
      db.prepare("UPDATE events SET active = 0, end_ts = ? WHERE uuid = ?").run(now, uuid);
    }
  }
}

async function runSyncCycle(customClient = null) {
  if (isSyncing) return;
  isSyncing = true;
  let hasError = false;
  let errorMsg = null;
  const diag = { devicesSeen: 0, sensorsSeen: 0, measurementsFetched: 0, measurementsUnmatched: 0, alarmsUnmatched: 0 };

  try {
    const apiKey = getSetting('api_key');
    const region = getSetting('api_region') || 'eu';
    if (!apiKey) {
      console.log('Skipping sync: No API Key configured.');
      lastSyncTime = Date.now();
      lastSyncStatus = 'skipped';
      lastSyncError = 'No API Key configured';
      lastSyncDiag = diag;
      return;
    }

    const client = customClient || new TestoClient(apiKey, region);
    const db = getDb();

    // Station lookup by device_uuid
    const stationRows = db.prepare("SELECT id, device_uuid FROM stations WHERE device_uuid IS NOT NULL AND device_uuid != ''").all();
    const deviceToStation = new Map();
    for (const s of stationRows) {
      if (deviceToStation.has(s.device_uuid)) {
        console.warn(`Multiple stations share device_uuid ${s.device_uuid}; station '${s.id}' overrides '${deviceToStation.get(s.device_uuid)}'. One device maps to one station.`);
      }
      deviceToStation.set(s.device_uuid, s.id);
    }

    // 0. Device Properties -> bridge maps
    let bridge = { sensorToDevice: new Map(), deviceSensors: new Map(), serialToDevice: new Map(), devices: new Set() };
    try {
      const properties = await client.fetchDeviceProperties();
      bridge = buildDeviceBridge(properties);
      diag.devicesSeen = bridge.devices.size;
      diag.sensorsSeen = bridge.sensorToDevice.size;
    } catch (e) {
      console.error('Error fetching device properties:', e.message);
      hasError = true; errorMsg = e.message;
    }

    // 1. Device Status — join by device_uuid
    const updateStatusStmt = db.prepare(`
      UPDATE stations
      SET battery = ?, signal = ?, connection_type = ?, is_powersupply_on = ?,
          fw_version = ?, model_code = ?, last_communication = ?,
          last_measurement_time = ?, next_communication = ?, serial_no = ?, online = ?
      WHERE device_uuid = ?
    `);
    try {
      const statuses = await client.fetchDeviceStatus();
      const now = Date.now();
      db.transaction(() => {
        for (const s of statuses) {
          const lastComm = parseTimestamp(s.last_communication);
          const nextComm = parseTimestamp(s.next_communication);
          const online = deriveOnline(lastComm, nextComm, now);
          updateStatusStmt.run(
            s.battery_level_percent, s.radio_level_percent, s.connection_type,
            s.is_powersupply_on ? 1 : 0, s.fw_version, s.model_code,
            lastComm, parseTimestamp(s.last_measurement_time),
            nextComm, s.serial_no, online, s.device_uuid);

          const stationId = deviceToStation.get(s.device_uuid);
          if (stationId) {
            applySystemEvents(db, stationId, { online, battery: s.battery_level_percent }, now);
          }
        }
      })();
    } catch (e) {
      console.error('Error syncing device status:', e.message);
      hasError = true; errorMsg = e.message;
    }

    // 2. Measurements — one filtered request over all assigned sensors, distribute via bridge
    const insertMeasurementStmt = db.prepare(`
      INSERT OR IGNORE INTO measurements (
        uuid, station_id, timestamp, timestamp_local, value,
        physical_property, unit, channel_no, sensor_uuid, serial_no,
        model_code, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      const assignedSensors = new Set();
      for (const s of stationRows) {
        const sensors = bridge.deviceSensors.get(s.device_uuid);
        if (sensors) for (const su of sensors) assignedSensors.add(su);
      }
      const filter = buildSensorFilter(assignedSensors);
      if (!filter) {
        console.log('Skipping measurement sync: no sensors resolved for assigned devices.');
      } else {
        // Window starts at the most-lagging assigned station so none is under-fetched.
        // INSERT OR IGNORE dedupes rows re-fetched for fresher stations.
        const dayAgo = Date.now() - 24 * 3600 * 1000;
        const maxTsStmt = db.prepare("SELECT max(timestamp) as max_ts FROM measurements WHERE station_id = ?");
        let windowStart = Date.now();
        for (const s of stationRows) {
          if (!bridge.deviceSensors.has(s.device_uuid)) continue;
          const row = maxTsStmt.get(s.id);
          const stationStart = (row && row.max_ts) ? row.max_ts + 1000 : dayAgo;
          if (stationStart < windowStart) windowStart = stationStart;
        }
        const fromDate = new Date(windowStart);

        // The Testo measurements report caps an open-ended request at a small
        // default page (~16 records). Without date_time_until the window never
        // advances past the stored high-water mark and sync freezes. Bounding
        // the request with an explicit until makes the API return the full range.
        const measurements = await client.fetchMeasurements({
          date_time_from: fromDate.toISOString(),
          date_time_until: new Date().toISOString(),
          odata: { $filter: filter }
        });
        diag.measurementsFetched = measurements.length;

        db.transaction(() => {
          for (const m of measurements) {
            const dev = bridge.sensorToDevice.get(m.sensor_uuid);
            const stationId = dev ? deviceToStation.get(dev) : null;
            const prop = mapPhysicalProperty(m.physical_property_name, m.physical_extension);
            if (!stationId || !prop) { diag.measurementsUnmatched++; continue; }
            insertMeasurementStmt.run(
              m.uuid, stationId, parseTimestamp(m.timestamp), m.timestamp_local, m.measurement,
              prop, m.physical_unit, m.channel_no, m.sensor_uuid, m.serial_no, m.model_code, m.processed_at);
          }
        })();
      }
    } catch (e) {
      console.error('Error syncing measurements:', e.message);
      hasError = true; errorMsg = e.message;
    }

    // 3a. Measuring Objects — fetch alarm threshold configuration and sync limits table.
    // Must run BEFORE the alarm step so fresh limits are available for the threshold join.
    // On failure: log the error (same pattern as other steps), keep existing limits intact
    // (don't wipe the table on transient API errors or parse failures).
    try {
      const moRows = await client.fetchMeasuringObjects();
      const limits = parseAlarmConfiguration(moRows);
      if (limits.length > 0) {
        db.transaction(() => {
          db.prepare("DELETE FROM limits").run();
          const upsert = db.prepare(`
            INSERT INTO limits (metric, direction, severity, limit_value, hysteresis, delay_ms, unit, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const now = Date.now();
          for (const l of limits) {
            upsert.run(l.metric, l.direction, l.severity, l.limitValue, l.hysteresis, l.delayMs, l.unit, now);
          }
        })();
      }
      // If limits.length === 0 (parse returned nothing / all keys conflicted) we keep
      // whatever was already in the table — an empty result from the parser is not a
      // reliable signal that no limits are configured on the tenant.
    } catch (e) {
      console.error('Error syncing measuring-object limits:', e.message);
      hasError = true; errorMsg = e.message;
    }

    // 3. Alarms — resolve device via sensor serial / source uuid, attach to its station
    // ON CONFLICT DO UPDATE instead of INSERT OR REPLACE so the rowid is stable
    // across re-fetches. The reconciliation window (rowid DESC tiebreaker) depends
    // on stable rowids; INSERT OR REPLACE would delete+reinsert, churning them.

    // Pre-load the limits table into a Map for O(1) threshold lookup at insert time.
    // Key: "metric:direction:severity" — the same triple that identifies a limit row.
    const limitsCache = new Map();
    try {
      const limitRows = db.prepare("SELECT metric, direction, severity, limit_value FROM limits").all();
      for (const r of limitRows) limitsCache.set(`${r.metric}:${r.direction}:${r.severity}`, r.limit_value);
    } catch (e) { console.error('Could not load limits cache:', e.message); }

    const insertAlarmStmt = db.prepare(`
      INSERT INTO events (
        uuid, station_id, severity, alarm_status, alarm_reason,
        alarm_condition_type, alarm_value, metric, threshold, start_ts,
        end_ts, extreme, active, message, detail, serial_no
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        station_id = excluded.station_id,
        severity = excluded.severity,
        alarm_status = excluded.alarm_status,
        alarm_reason = excluded.alarm_reason,
        alarm_condition_type = excluded.alarm_condition_type,
        alarm_value = excluded.alarm_value,
        metric = excluded.metric,
        threshold = excluded.threshold,
        start_ts = excluded.start_ts,
        end_ts = excluded.end_ts,
        extreme = excluded.extreme,
        active = excluded.active,
        message = excluded.message,
        detail = excluded.detail,
        serial_no = excluded.serial_no
    `);
    try {
      const lastSyncSetting = getSetting('last_alarm_sync_time');
      const parsedLastSync = lastSyncSetting ? parseInt(lastSyncSetting, 10) : NaN;
      const watermarkMs = !isNaN(parsedLastSync) && parsedLastSync > 0
        ? parsedLastSync
        : Date.now() - 7 * 24 * 3600 * 1000;

      // Bound with an explicit until for the same reason as measurements: an
      // open-ended alarm report is capped at a small default page. Reuse this
      // instant for the watermark so catch-up after downtime resumes exactly here.
      const alarmUntil = Date.now();
      // Overlap the lower bound back from the watermark (see ALARM_WINDOW_OVERLAP_MS)
      // so a transition that only became queryable after the previous cycle's `until`
      // — processed_at lag, or an offline-backfilled row — is still re-scanned rather
      // than skipped forever. Long-downtime catch-up still uses the older watermark via
      // min(); ON CONFLICT(uuid) dedupes the redundant rows.
      const lastSync = new Date(Math.min(watermarkMs, alarmUntil - ALARM_WINDOW_OVERLAP_MS));
      const alarms = await client.fetchAlarms({
        date_time_from: lastSync.toISOString(),
        date_time_until: new Date(alarmUntil).toISOString()
      });

      db.transaction(() => {
        for (const a of alarms) {
          const dev = bridge.serialToDevice.get(a.serial_no)
            || bridge.sensorToDevice.get(a.alarm_source_uuid)
            || (bridge.devices.has(a.alarm_source_uuid) ? a.alarm_source_uuid : null);
          const stationId = dev ? deviceToStation.get(dev) : null;
          if (!stationId) { diag.alarmsUnmatched++; continue; }

          // testo connection/battery problems arrive in this same feed as system
          // alarms; classifyAlarm routes them to severity 'system' with a normalized
          // subtype. For system alarms store that subtype in alarm_condition_type so
          // the frontend renders the matching icon (mirrors applySystemEvents); for
          // measurement alarms keep the raw condition string.
          const { severity, systemType } = classifyAlarm(a);
          const conditionForFrontend = systemType || a.alarm_condition_type;
          // The live API's alarm_status enum is 'Alarm' (currently in alarm) / 'Ok'
          // (resolved). It never sends 'Active' — that value only existed in the mock
          // client, which is why every real alarm used to be stored inactive.
          const isActive = a.alarm_status === 'Alarm' ? 1 : 0;
          // The live API sends alarm_value as a string (e.g. "35.6").
          // events.alarm_value and events.extreme are REAL columns, so coerce
          // to number or null if non-numeric.
          const alarmValue = Number.isFinite(Number.parseFloat(a.alarm_value))
            ? Number.parseFloat(a.alarm_value)
            : null;

          const metric = mapPhysicalProperty(a.physical_property_name, a.physical_extension);
          // Threshold direction from the condition type string ("Upper limit"/"Lower
          // limit"); also drives the German headline below. System alarms carry no
          // measurement threshold or direction.
          const direction = severity !== 'system' ? alarmConditionDirection(a.alarm_condition_type) : null;
          // Threshold lookup: for measurement alarms look up the pre-loaded limits cache.
          // Falls back to null when no matching limit was synced (e.g. first run before
          // measuring-objects are fetched, or a conflict dropped the key from the cache).
          let threshold = null;
          if (severity !== 'system' && metric && direction) {
            threshold = limitsCache.get(`${metric}:${direction}:${severity}`) ?? null;
          }

          // Headline/detail: system alarms get systemAlarmText; measurement alarms get a
          // German metric+direction headline (never the raw English alarm_reason).
          let message, detail;
          if (severity === 'system') {
            ({ message, detail } = systemAlarmText(systemType));
          } else {
            ({ message, detail } = measurementAlarmText({
              isViolation: a.alarm_status === 'Alarm',
              direction,
              metric,
              serialNo: a.serial_no,
              alarmValue,
            }));
          }

          insertAlarmStmt.run(
            a.uuid, stationId,
            severity,
            a.alarm_status, a.alarm_reason, conditionForFrontend, alarmValue,
            metric, threshold,
            parseTimestamp(a.alarm_time), parseTimestamp(a.last_status_change_time), alarmValue,
            isActive, message,
            detail,
            a.serial_no || null);
        }
      })();

      // Reconcile the transition-log feed. testo emits a violation and its recovery as
      // separate rows (distinct uuids, ascending timestamps), so "currently active" is
      // a property of a logical alarm group — not of a single row: only the most recent
      // transition is live, and only when it is a violation ('Alarm'). A later 'Ok'
      // recovery closes the whole group.
      // Partition key must include serial_no so multi-sensor devices don't cross-close
      // each other, and severity so a Warning violation isn't extinguished by an
      // Alarm-severity recovery (they are separate limit bands on the same channel).
      // Synthetic system rows (sys-*, alarm_status IS NULL) are owned by
      // applySystemEvents and are excluded here. Runs over all stored feed rows so
      // historical pairs settle even when only one side was fetched this cycle.
      db.transaction(() => {
        db.prepare("UPDATE events SET active = 0 WHERE alarm_status IS NOT NULL").run();
        db.prepare(`
          UPDATE events SET active = 1 WHERE uuid IN (
            SELECT uuid FROM (
              SELECT uuid,
                ROW_NUMBER() OVER (
                  PARTITION BY station_id, COALESCE(serial_no,''), alarm_condition_type, severity, COALESCE(metric,'')
                  ORDER BY start_ts DESC, rowid DESC
                ) AS rn,
                alarm_status
              FROM events
              WHERE alarm_status IS NOT NULL
            ) WHERE rn = 1 AND alarm_status = 'Alarm'
          )
        `).run();

        // Episode end_ts = start of the NEXT transition in the same logical group.
        // The feed is a transition log; a violation's real end is its recovery's start
        // (or the next violation if no recovery was recorded). LEAD over the SAME
        // partition as the active reconciliation, ordered ascending, yields that next
        // start. The newest row in a group (the active violation, or a trailing
        // recovery) gets NULL — the frontend shows "läuft" for active rows via the
        // active flag, not via end_ts. This runs over ALL stored feed rows every cycle,
        // so historical durations settle even when only one side was fetched this cycle.
        db.prepare(`
          UPDATE events AS e
          SET end_ts = nxt.next_start
          FROM (
            SELECT rowid AS rid,
              LEAD(start_ts) OVER (
                PARTITION BY station_id, COALESCE(serial_no,''), alarm_condition_type, severity, COALESCE(metric,'')
                ORDER BY start_ts ASC, rowid ASC
              ) AS next_start
            FROM events
            WHERE alarm_status IS NOT NULL
          ) AS nxt
          WHERE e.rowid = nxt.rid AND e.alarm_status IS NOT NULL
        `).run();
      })();

      // Only advance the watermark when the bridge was available, otherwise alarms
      // fetched now could not be routed and would be lost on the next cycle.
      if (bridge.devices.size > 0) {
        saveSetting('last_alarm_sync_time', String(alarmUntil));
      }
    } catch (e) {
      console.error('Error syncing alarms:', e.message);
      hasError = true; errorMsg = e.message;
    }

    // 3b. Threshold backfill — fill `threshold` for existing measurement-alarm rows
    // where it is still NULL and a matching limit now exists in the cache.
    // This repairs rows that were inserted before measuring-objects were ever synced,
    // or before a limits-sync failure was later recovered. Only runs when the cache
    // has data (no point iterating when the limits table is empty).
    if (limitsCache.size > 0) {
      try {
        // Fetch only measurement-alarm rows with a null threshold and a known metric+direction.
        // alarm_condition_type carries the direction; severity is already stored.
        const nullThresholdRows = db.prepare(`
          SELECT uuid, metric, severity, alarm_condition_type
          FROM events
          WHERE alarm_status IS NOT NULL AND threshold IS NULL AND metric IS NOT NULL
        `).all();
        const updateThreshold = db.prepare("UPDATE events SET threshold = ? WHERE uuid = ?");
        db.transaction(() => {
          for (const row of nullThresholdRows) {
            const direction = alarmConditionDirection(row.alarm_condition_type);
            if (!direction) continue;
            const val = limitsCache.get(`${row.metric}:${direction}:${row.severity}`);
            if (val != null) updateThreshold.run(val, row.uuid);
          }
        })();
      } catch (e) {
        console.error('Error backfilling thresholds:', e.message);
        // Non-fatal: a backfill failure does not affect this cycle's primary data.
      }
    }

    // 3b. Monthly CSV backup (throttled once per local day; catches up missed months).
    try {
      maybeRunBackupScan(Date.now());
    } catch (e) {
      console.error('Error running monthly backup scan:', e.message);
      // Do NOT set hasError — a backup failure must not mark the data sync failed; surfaced via backup_health.
    }

    // 4. Data retention cleanup (clamped so un-backed-up months are never deleted)
    try {
      const daysSetting = getSetting('retention_days') || '365';
      const days = parseInt(daysSetting, 10);
      const validDays = isNaN(days) || days <= 0 ? 365 : days;
      const now = Date.now();
      const retentionCutoff = now - validDays * 24 * 3600 * 1000;
      const backupFloor = computePruneFloor(now); // Infinity if backups disabled; window-bounded
      const effectiveCutoff = Math.min(retentionCutoff, backupFloor);
      db.prepare("DELETE FROM measurements WHERE timestamp < ?").run(effectiveCutoff);
      // Only purge closed (inactive) events; active alarms must survive regardless of age.
      db.prepare("DELETE FROM events WHERE start_ts < ? AND active = 0").run(effectiveCutoff);
    } catch (e) {
      console.error('Error executing database retention cleanup:', e.message);
      hasError = true; errorMsg = e.message;
    }

    lastSyncTime = Date.now();
    lastSyncStatus = hasError ? 'error' : 'success';
    lastSyncError = hasError ? errorMsg : null;
    lastSyncDiag = diag;
  } catch (outerError) {
    console.error('Unhandled error in sync cycle:', outerError.message);
    lastSyncTime = Date.now();
    lastSyncStatus = 'error';
    lastSyncError = outerError.message;
    lastSyncDiag = diag;
  } finally {
    isSyncing = false;
  }
}

let timer = null;
function startScheduler() {
  if (timer) clearInterval(timer);
  const intervalSetting = getSetting('poll_interval_sec') || '900';
  const intervalSec = parseInt(intervalSetting, 10);
  const validIntervalSec = isNaN(intervalSec) || intervalSec <= 0 ? 900 : intervalSec;
  console.log(`Scheduler started. Syncing every ${validIntervalSec} seconds.`);
  runSyncCycle().catch(console.error);
  timer = setInterval(() => {
    runSyncCycle().catch(console.error);
  }, validIntervalSec * 1000);
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getSchedulerStatus() {
  return {
    isActive: timer !== null,
    isSyncing,
    lastSyncTime,
    lastSyncStatus,
    lastSyncError,
    pollIntervalSec: parseInt(getSetting('poll_interval_sec') || '900', 10),
    diagnostics: lastSyncDiag
  };
}

module.exports = {
  runSyncCycle,
  startScheduler,
  stopScheduler,
  getSchedulerStatus
};
