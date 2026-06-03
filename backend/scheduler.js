const { getDb, getSetting, saveSetting } = require('./db');
const TestoClient = require('./testo-client');
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter } = require('./device-bridge');

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
          last_measurement_time = ?, next_communication = ?, serial_no = ?
      WHERE device_uuid = ?
    `);
    try {
      const statuses = await client.fetchDeviceStatus();
      db.transaction(() => {
        for (const s of statuses) {
          updateStatusStmt.run(
            s.battery_level_percent, s.radio_level_percent, s.connection_type,
            s.is_powersupply_on ? 1 : 0, s.fw_version, s.model_code,
            parseTimestamp(s.last_communication), parseTimestamp(s.last_measurement_time),
            parseTimestamp(s.next_communication), s.serial_no, s.device_uuid);
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

    // 3. Alarms — resolve device via sensor serial / source uuid, attach to its station
    const insertAlarmStmt = db.prepare(`
      INSERT OR REPLACE INTO events (
        uuid, station_id, severity, alarm_status, alarm_reason,
        alarm_condition_type, alarm_value, metric, threshold, start_ts,
        end_ts, extreme, active, message, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      const lastSyncSetting = getSetting('last_alarm_sync_time');
      const parsedLastSync = lastSyncSetting ? parseInt(lastSyncSetting, 10) : NaN;
      const lastSync = !isNaN(parsedLastSync) && parsedLastSync > 0
        ? new Date(parsedLastSync)
        : new Date(Date.now() - 7 * 24 * 3600 * 1000);

      // Bound with an explicit until for the same reason as measurements: an
      // open-ended alarm report is capped at a small default page. Reuse this
      // instant for the watermark so the next window starts exactly where this
      // one ended, with no gap.
      const alarmUntil = Date.now();
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

          insertAlarmStmt.run(
            a.uuid, stationId,
            (a.alarm_severity || 'Warning').toLowerCase() === 'alarm' ? 'alarm' : 'warning',
            a.alarm_status, a.alarm_reason, a.alarm_condition_type, a.alarm_value,
            mapPhysicalProperty(a.physical_value), null,
            parseTimestamp(a.alarm_time), parseTimestamp(a.last_status_change_time), a.alarm_value,
            a.alarm_status === 'Active' ? 1 : 0, a.alarm_reason || 'Grenzwert verletzt',
            `Sensor ${a.serial_no} hat einen Wert von ${a.alarm_value} gemeldet.`);
        }
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

    // 4. Data retention cleanup
    try {
      const daysSetting = getSetting('retention_days') || '365';
      const days = parseInt(daysSetting, 10);
      const validDays = isNaN(days) || days <= 0 ? 365 : days;
      const limit = Date.now() - validDays * 24 * 3600 * 1000;
      db.prepare("DELETE FROM measurements WHERE timestamp < ?").run(limit);
      db.prepare("DELETE FROM events WHERE start_ts < ?").run(limit);
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
