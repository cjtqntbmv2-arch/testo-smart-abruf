const test = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH = ':memory:';
const { initDb, getDb, saveSetting, closeDb } = require('../db');

// Mock client consistent with the device-bridge model: device 'dev-1' (serial SN123)
// owns sensor 'sensor-1' (serial SN123-S1, Temperature).
class MockTestoClient {
  constructor(alarms = [], moRows = []) {
    this.alarms = alarms;
    this.moRows = moRows;
    this.lastMeasurementParams = null;
  }
  async fetchDeviceProperties() {
    return [
      { device_uuid: 'dev-1', device_serial_no: 'SN123', device_display_name: 'Logger 1', device_model_code: 'testo-160-THE',
        sensor_uuid: 'sensor-1', sensor_serial_no: 'SN123-S1', channel_no: 1, channel_physical_property_name: 'Temperature', channel_physical_unit: '°C' }
    ];
  }
  async fetchDeviceStatus() {
    return [{ device_uuid: 'dev-1', serial_no: 'SN123', battery_level_percent: 85, radio_level_percent: 90, connection_type: 'WIFI', is_powersupply_on: true }];
  }
  async fetchMeasurements(params) {
    this.lastMeasurementParams = params;
    return [{ uuid: 'meas-123', sensor_uuid: 'sensor-1', timestamp: '2026-05-29T06:00:00Z', measurement: 22.4, physical_property_name: 'Temperature', physical_unit: 'CELSIUS', serial_no: 'SN123-S1' }];
  }
  async fetchMeasuringObjects() { return this.moRows; }
  async fetchAlarms() { return this.alarms; }
}

const schedulerModule = require('../scheduler');

test('Sync resolves devices via bridge, distributes measurements, links alarms, and cleans up', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');
  saveSetting('retention_days', '30');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, location, mo_uuid, device_uuid) VALUES (?, ?, ?, ?, ?)`)
    .run('living', 'Wohnzimmer', '1. OG', 'mo-123', 'dev-1');

  const oldTs = Date.now() - 31 * 24 * 3600 * 1000;
  const newTs = Date.now() - 10 * 24 * 3600 * 1000;
  db.prepare(`INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property) VALUES (?, ?, ?, ?, ?)`)
    .run('meas-old', 'living', oldTs, 19.5, 'temperature');
  db.prepare(`INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property) VALUES (?, ?, ?, ?, ?)`)
    .run('meas-new', 'living', newTs, 20.5, 'temperature');
  db.prepare(`INSERT INTO events (uuid, station_id, severity, alarm_status, start_ts) VALUES (?, ?, ?, ?, ?)`)
    .run('event-old', 'living', 'warning', 'Cleared', oldTs);

  const mockAlarms = [{
    uuid: 'alarm-123', serial_no: 'SN123', alarm_source_uuid: 'sensor-1', alarm_type: 'measurement alarm', alarm_severity: 'Alarm', alarm_status: 'Alarm',
    alarm_reason: 'Temperatur zu hoch', alarm_condition_type: 'Upper limit', alarm_value: '28.5',
    physical_property_name: 'Temperature', physical_extension: 'Unknown',
    alarm_time: '2026-05-29T06:10:00Z', last_status_change_time: '2026-05-29T06:10:00Z'
  }];

  const client = new MockTestoClient(mockAlarms);
  await schedulerModule.runSyncCycle(client);

  const station = db.prepare("SELECT battery, signal, connection_type, serial_no FROM stations WHERE id = ?").get('living');
  assert.strictEqual(station.battery, 85);
  assert.strictEqual(station.signal, 90);
  assert.strictEqual(station.connection_type, 'WIFI');
  assert.strictEqual(station.serial_no, 'SN123');

  assert.strictEqual(client.lastMeasurementParams.odata.$filter, "sensor_uuid eq 'sensor-1'");

  const meas = db.prepare("SELECT station_id, value, physical_property, sensor_uuid FROM measurements WHERE uuid = ?").get('meas-123');
  assert.ok(meas);
  assert.strictEqual(meas.station_id, 'living');
  assert.strictEqual(meas.value, 22.4);
  assert.strictEqual(meas.physical_property, 'temperature');
  assert.strictEqual(meas.sensor_uuid, 'sensor-1');

  const event = db.prepare("SELECT station_id, severity, metric, active FROM events WHERE uuid = ?").get('alarm-123');
  assert.ok(event);
  assert.strictEqual(event.station_id, 'living');
  assert.strictEqual(event.severity, 'alarm');
  assert.strictEqual(event.metric, 'temperature');
  // alarm_status 'Alarm' is the live API's "currently in alarm" state -> active.
  assert.strictEqual(event.active, 1);

  const st = schedulerModule.getSchedulerStatus();
  assert.strictEqual(st.diagnostics.devicesSeen, 1);
  assert.strictEqual(st.diagnostics.sensorsSeen, 1);
  assert.strictEqual(st.diagnostics.measurementsFetched, 1);

  const meas2 = db.prepare("SELECT uuid FROM measurements WHERE uuid IN ('meas-old','meas-new')").all().map(m => m.uuid);
  assert.ok(!meas2.includes('meas-old'));
  assert.ok(meas2.includes('meas-new'));
  const ev2 = db.prepare("SELECT uuid FROM events WHERE uuid = 'event-old'").all();
  assert.strictEqual(ev2.length, 0);

  closeDb();
});

test('Sync ingests a testo connection-timeout system alarm as an active system event', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // testo reports the connection loss through its alarm feed as a device system alarm,
  // currently in the 'Alarm' state. It must land as an ACTIVE system event with the
  // 'connection' subtype the frontend renders, not as an inactive warning.
  const systemAlarm = [{
    uuid: 'alarm-conn-1', serial_no: 'SN123', alarm_source_uuid: 'dev-1',
    alarm_type: 'device system alarm', alarm_severity: 'Warning', alarm_status: 'Alarm',
    alarm_reason: 'Alarm condition is violated',
    alarm_condition_type: 'Connection timeout, device did not communicated in expected time',
    alarm_value: null, physical_value: null,
    alarm_time: '2026-05-29T06:10:00Z', last_status_change_time: '2026-05-29T06:10:00Z'
  }];

  await schedulerModule.runSyncCycle(new MockTestoClient(systemAlarm));

  const ev = db.prepare("SELECT severity, alarm_condition_type, active, message, detail FROM events WHERE uuid = ?").get('alarm-conn-1');
  assert.ok(ev, 'the connection-timeout alarm must be stored');
  assert.strictEqual(ev.severity, 'system');
  assert.strictEqual(ev.alarm_condition_type, 'connection');
  assert.strictEqual(ev.active, 1);
  // Verständlicher deutscher Text statt API-Rohtext / "Wert von null".
  assert.strictEqual(ev.message, 'Verbindung verloren');
  assert.strictEqual(ev.detail, 'Gerät hat sich nicht im erwarteten Intervall gemeldet.');
  assert.ok(!/null/.test(ev.detail), 'detail darf kein wörtliches "null" enthalten');

  closeDb();
});

test('Sync reconciles violated/adhered transitions so only the latest unresolved alarm stays active', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // testo's alarm feed is a transition log: a connection loss is one 'Alarm' row,
  // its recovery a separate 'Ok' row with a later timestamp. Per (station, condition)
  // the newest transition wins — a recovery must close the matching violated alarm.
  const base = Date.parse('2026-05-29T06:00:00Z');
  const mk = (uuid, status, reason, offsetMin) => ({
    uuid, serial_no: 'SN123', alarm_source_uuid: 'dev-1',
    alarm_type: 'device system alarm', alarm_severity: 'Warning', alarm_status: status,
    alarm_reason: reason,
    alarm_condition_type: 'Connection timeout, device did not communicated in expected time',
    alarm_value: null, physical_value: null,
    alarm_time: new Date(base + offsetMin * 60000).toISOString(),
    last_status_change_time: new Date(base + offsetMin * 60000).toISOString()
  });

  // violated -> adhered -> violated: the latest (violated) is the only active one.
  await schedulerModule.runSyncCycle(new MockTestoClient([
    mk('conn-violated-1', 'Alarm', 'Alarm condition is violated', 0),
    mk('conn-adhered-1', 'Ok', 'Alarm condition is adhered', 20),
    mk('conn-violated-2', 'Alarm', 'Alarm condition is violated', 40),
  ]));

  const rows = db.prepare("SELECT uuid, severity, active FROM events WHERE station_id = 'emc' ORDER BY start_ts").all();
  const byUuid = Object.fromEntries(rows.map(r => [r.uuid, r]));
  assert.strictEqual(byUuid['conn-violated-1'].active, 0, 'an earlier, since-resolved violation is not active');
  assert.strictEqual(byUuid['conn-adhered-1'].active, 0, 'a recovery transition is never active');
  assert.strictEqual(byUuid['conn-violated-2'].active, 1, 'the latest unresolved violation is active');
  // All three remain classified as system messages.
  for (const r of rows) assert.strictEqual(r.severity, 'system');

  closeDb();
});

test('Sync completes without throwing when device properties fail', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('s1', 'S1', 'dev-x');

  const badClient = {
    async fetchDeviceProperties() { throw new Error('props down'); },
    async fetchDeviceStatus() { return []; },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements() { throw new Error('should not be called'); },
    async fetchAlarms() { return []; }
  };

  await schedulerModule.runSyncCycle(badClient);
  const status = schedulerModule.getSchedulerStatus();
  assert.strictEqual(status.lastSyncStatus, 'error');
  closeDb();
});

test('Multi-sensor device: OR filter covers all sensors and both metrics are distributed', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('living', 'Wohnzimmer', 'dev-1');

  const client = {
    lastMeasurementParams: null,
    async fetchDeviceProperties() {
      return [
        { device_uuid: 'dev-1', device_serial_no: 'SN1', sensor_uuid: 's-temp', sensor_serial_no: 'SN1-A', channel_physical_property_name: 'Temperature' },
        { device_uuid: 'dev-1', device_serial_no: 'SN1', sensor_uuid: 's-hum',  sensor_serial_no: 'SN1-B', channel_physical_property_name: 'Humidity' }
      ];
    },
    async fetchDeviceStatus() { return []; },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements(params) {
      this.lastMeasurementParams = params;
      return [
        { uuid: 'm-t', sensor_uuid: 's-temp', timestamp: '2026-05-29T06:00:00Z', measurement: 21.0, physical_property_name: 'Temperature', physical_unit: '°C' },
        { uuid: 'm-h', sensor_uuid: 's-hum',  timestamp: '2026-05-29T06:00:00Z', measurement: 48.0, physical_property_name: 'Humidity', physical_unit: '%' }
      ];
    },
    async fetchAlarms() { return []; }
  };

  await schedulerModule.runSyncCycle(client);

  const f = client.lastMeasurementParams.odata.$filter;
  assert.ok(f.includes("sensor_uuid eq 's-temp'"));
  assert.ok(f.includes("sensor_uuid eq 's-hum'"));
  assert.ok(f.includes(' or '));

  const t = db.prepare("SELECT station_id, physical_property FROM measurements WHERE uuid = 'm-t'").get();
  const h = db.prepare("SELECT station_id, physical_property FROM measurements WHERE uuid = 'm-h'").get();
  assert.strictEqual(t.station_id, 'living');
  assert.strictEqual(t.physical_property, 'temperature');
  assert.strictEqual(h.station_id, 'living');
  assert.strictEqual(h.physical_property, 'humidity');
  closeDb();
});

test('Measurement fetch is bounded with date_time_until (~now) so the Testo report returns the full range, not its default page cap', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('living', 'Wohnzimmer', 'dev-1');

  const client = {
    captured: null,
    async fetchDeviceProperties() {
      return [{ device_uuid: 'dev-1', device_serial_no: 'SN1', sensor_uuid: 's-1', sensor_serial_no: 'SN1-A', channel_physical_property_name: 'Temperature' }];
    },
    async fetchDeviceStatus() { return []; },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements(params) { this.captured = params; return []; },
    async fetchAlarms() { return []; }
  };

  const before = Date.now();
  await schedulerModule.runSyncCycle(client);
  const after = Date.now();

  assert.ok(client.captured.date_time_until, 'date_time_until must be set to bound the report window');
  const until = new Date(client.captured.date_time_until).getTime();
  assert.ok(!isNaN(until), 'date_time_until must be a valid ISO timestamp');
  assert.ok(until >= before && until <= after + 1000, 'date_time_until should be approximately now');
  closeDb();
});

test('Unmatched alarm is counted and not inserted', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('living', 'Wohnzimmer', 'dev-1');

  const client = {
    async fetchDeviceProperties() {
      return [{ device_uuid: 'dev-1', device_serial_no: 'SN1', sensor_uuid: 's-1', sensor_serial_no: 'SN1-A', channel_physical_property_name: 'Temperature' }];
    },
    async fetchDeviceStatus() { return []; },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements() { return []; },
    async fetchAlarms() {
      return [{ uuid: 'alarm-orphan', serial_no: 'UNKNOWN-SERIAL', alarm_source_uuid: 'unknown-uuid', alarm_type: 'measurement alarm', alarm_severity: 'Alarm', alarm_status: 'Alarm', alarm_value: '28.5', physical_property_name: 'Temperature', physical_extension: 'Unknown', alarm_time: '2026-05-29T06:00:00Z', last_status_change_time: '2026-05-29T06:00:00Z' }];
    }
  };

  await schedulerModule.runSyncCycle(client);

  const row = db.prepare("SELECT uuid FROM events WHERE uuid = 'alarm-orphan'").get();
  assert.strictEqual(row, undefined, 'orphan alarm should not be inserted');
  const st = schedulerModule.getSchedulerStatus();
  assert.strictEqual(st.diagnostics.alarmsUnmatched, 1);
  closeDb();
});

test('Device status sync derives online state and opens/closes system events', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('living', 'Wohnzimmer', 'dev-1');

  const lowBatteryClient = {
    async fetchDeviceProperties() { return []; },
    async fetchDeviceStatus() {
      return [{
        device_uuid: 'dev-1', serial_no: 'SN1', battery_level_percent: 8, radio_level_percent: 50,
        last_communication: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        next_communication: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      }];
    },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements() { return []; },
    async fetchAlarms() { return []; }
  };

  await schedulerModule.runSyncCycle(lowBatteryClient);

  const station = db.prepare("SELECT online FROM stations WHERE id = 'living'").get();
  assert.strictEqual(station.online, 1, 'a fresh next_communication keeps the device online');

  const batteryEvent = db.prepare("SELECT severity, alarm_condition_type, active FROM events WHERE uuid = 'sys-battery-living'").get();
  assert.ok(batteryEvent, 'a low battery must open a system event');
  assert.strictEqual(batteryEvent.severity, 'system');
  assert.strictEqual(batteryEvent.alarm_condition_type, 'battery');
  assert.strictEqual(batteryEvent.active, 1);
  // no connection event while the device is online
  assert.strictEqual(db.prepare("SELECT 1 FROM events WHERE uuid = 'sys-connection-living'").get(), undefined);

  // Battery recovers -> the open system event auto-closes.
  const recoveredClient = {
    async fetchDeviceProperties() { return []; },
    async fetchDeviceStatus() {
      return [{
        device_uuid: 'dev-1', serial_no: 'SN1', battery_level_percent: 90, radio_level_percent: 50,
        last_communication: new Date().toISOString(),
        next_communication: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      }];
    },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements() { return []; },
    async fetchAlarms() { return []; }
  };
  await schedulerModule.runSyncCycle(recoveredClient);

  const closed = db.prepare("SELECT active, end_ts FROM events WHERE uuid = 'sys-battery-living'").get();
  assert.strictEqual(closed.active, 0, 'a recovered battery closes the system event');
  assert.ok(closed.end_ts, 'a closed system event carries an end timestamp');
  closeDb();
});

// ── M5: Retention must not delete active events ───────────────────────────
test('Retention deletes old inactive events but preserves old active events', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('retention_days', '30');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('ret-st', 'Retention Test', 'dev-ret');

  const oldTs = Date.now() - 40 * 24 * 3600 * 1000; // 40 days ago — older than retention window

  // Old but ACTIVE event — must survive
  db.prepare(`INSERT INTO events (uuid, station_id, severity, start_ts, active) VALUES (?, ?, 'alarm', ?, 1)`)
    .run('old-active-evt', 'ret-st', oldTs);

  // Old and INACTIVE event — must be deleted
  db.prepare(`INSERT INTO events (uuid, station_id, severity, start_ts, active) VALUES (?, ?, 'alarm', ?, 0)`)
    .run('old-inactive-evt', 'ret-st', oldTs);

  const noopClient = {
    async fetchDeviceProperties() { return []; },
    async fetchDeviceStatus() { return []; },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements() { return []; },
    async fetchAlarms() { return []; }
  };

  await schedulerModule.runSyncCycle(noopClient);

  const active = db.prepare("SELECT uuid FROM events WHERE uuid = 'old-active-evt'").get();
  const inactive = db.prepare("SELECT uuid FROM events WHERE uuid = 'old-inactive-evt'").get();

  assert.ok(active, 'old but active event must NOT be deleted by retention');
  assert.strictEqual(inactive, undefined, 'old inactive event must be deleted by retention');

  closeDb();
});

// ── M8: Alarm insert must not churn rowid ─────────────────────────────────
test('Alarm re-fetch preserves rowid (ON CONFLICT DO UPDATE, not INSERT OR REPLACE)', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('rowid-st', 'Rowid Test', 'dev-1');

  const alarm = {
    uuid: 'alarm-rowid-1', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
    alarm_type: 'measurement alarm', alarm_severity: 'Alarm', alarm_status: 'Alarm',
    alarm_reason: 'Too high', alarm_condition_type: 'Upper limit', alarm_value: '28.5',
    physical_property_name: 'Temperature', physical_extension: 'Unknown',
    alarm_time: '2026-05-29T06:10:00Z', last_status_change_time: '2026-05-29T06:10:00Z'
  };

  // First sync — inserts the alarm
  await schedulerModule.runSyncCycle(new MockTestoClient([alarm]));
  const before = db.prepare("SELECT rowid FROM events WHERE uuid = 'alarm-rowid-1'").get();
  assert.ok(before, 'alarm must be inserted on first sync');

  // Second sync with same alarm uuid — must UPDATE in place, not delete+reinsert
  await schedulerModule.runSyncCycle(new MockTestoClient([alarm]));
  const after = db.prepare("SELECT rowid FROM events WHERE uuid = 'alarm-rowid-1'").get();
  assert.ok(after, 'alarm must still exist after second sync');
  assert.strictEqual(after.rowid, before.rowid, 'rowid must be stable across re-fetches (ON CONFLICT DO UPDATE)');

  closeDb();
});

test('Device status sync opens a connection system event when offline and closes it on recovery', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('hall', 'Flur', 'dev-2');

  const offlineClient = {
    async fetchDeviceProperties() { return []; },
    async fetchDeviceStatus() {
      return [{
        device_uuid: 'dev-2', serial_no: 'SN2', battery_level_percent: 90, radio_level_percent: 40,
        last_communication: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
        next_communication: new Date(Date.now() - 4 * 3600 * 1000).toISOString()
      }];
    },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements() { return []; },
    async fetchAlarms() { return []; }
  };
  await schedulerModule.runSyncCycle(offlineClient);

  let station = db.prepare("SELECT online FROM stations WHERE id = 'hall'").get();
  assert.strictEqual(station.online, 0, 'an overdue next_communication marks the device offline');
  const conn = db.prepare("SELECT alarm_condition_type, active FROM events WHERE uuid = 'sys-connection-hall'").get();
  assert.ok(conn, 'offline opens a connection system event');
  assert.strictEqual(conn.active, 1);
  assert.strictEqual(conn.alarm_condition_type, 'connection');
  // healthy battery -> no battery event
  assert.strictEqual(db.prepare("SELECT 1 FROM events WHERE uuid = 'sys-battery-hall'").get(), undefined);

  const onlineClient = {
    async fetchDeviceProperties() { return []; },
    async fetchDeviceStatus() {
      return [{
        device_uuid: 'dev-2', serial_no: 'SN2', battery_level_percent: 90, radio_level_percent: 40,
        last_communication: new Date().toISOString(),
        next_communication: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      }];
    },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements() { return []; },
    async fetchAlarms() { return []; }
  };
  await schedulerModule.runSyncCycle(onlineClient);

  station = db.prepare("SELECT online FROM stations WHERE id = 'hall'").get();
  assert.strictEqual(station.online, 1, 'a fresh next_communication brings the device back online');
  const closed = db.prepare("SELECT active, end_ts FROM events WHERE uuid = 'sys-connection-hall'").get();
  assert.strictEqual(closed.active, 0, 'recovery closes the connection event');
  assert.ok(closed.end_ts, 'closed connection event has an end timestamp');
  closeDb();
});

// ── B3: Full sync with live-shaped MO rows + alarm → threshold populated ─────
// Live-shaped MO fixture helper (same 8-condition structure as the real tenant).
function makeLiveMoRows() {
  const config = {
    measurementAlarmConditionSet: [{
      measurementAlarmConditions: [
        { measurementAlarmConditionTypeId: 'Lower limit', alarmSeverityId: 'Warning',  physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 20, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' },
        { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Warning',  physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 26, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' },
        { measurementAlarmConditionTypeId: 'Lower limit', alarmSeverityId: 'Alarm',    physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 18, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' },
        { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Alarm',    physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 28, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' },
        { measurementAlarmConditionTypeId: 'Lower limit', alarmSeverityId: 'Warning',  physicalProperty: { physicalValueId: 'Humidity' },    limitValue: 35, limitHysteresis: 0, delay: 600000, physicalUnitId: '%rF' },
        { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Warning',  physicalProperty: { physicalValueId: 'Humidity' },    limitValue: 55, limitHysteresis: 0, delay: 600000, physicalUnitId: '%rF' },
        { measurementAlarmConditionTypeId: 'Lower limit', alarmSeverityId: 'Alarm',    physicalProperty: { physicalValueId: 'Humidity' },    limitValue: 30, limitHysteresis: 0, delay: 600000, physicalUnitId: '%rF' },
        { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Alarm',    physicalProperty: { physicalValueId: 'Humidity' },    limitValue: 60, limitHysteresis: 0, delay: 600000, physicalUnitId: '%rF' },
      ]
    }]
  };
  return [{ measuring_object_uuid: 'mo-1', measurement_alarm_configuration: JSON.stringify(config), channel_assignments: null }];
}

test('Sync with live-shaped MO rows stores 8 limits and populates threshold on alarm insert', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('living', 'Wohnzimmer', 'dev-1');

  // Temperature upper-alarm — matches limit: temperature:high:alarm = 28 °C
  const alarms = [{
    uuid: 'alarm-thresh-1', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
    alarm_type: 'measurement alarm', alarm_severity: 'Alarm', alarm_status: 'Alarm',
    alarm_reason: 'Temperatur zu hoch', alarm_condition_type: 'Upper limit', alarm_value: '29.1',
    physical_property_name: 'Temperature', physical_extension: 'Unknown',
    alarm_time: '2026-06-11T08:00:00Z', last_status_change_time: '2026-06-11T08:00:00Z'
  }];

  await schedulerModule.runSyncCycle(new MockTestoClient(alarms, makeLiveMoRows()));

  // Limits table must have 8 rows (2 metrics × 2 directions × 2 severities)
  const limitCount = db.prepare("SELECT count(*) as cnt FROM limits").get().cnt;
  assert.strictEqual(limitCount, 8, 'limits table must have exactly 8 rows after sync');

  // The stored alarm must carry the correct threshold from the limits table
  const event = db.prepare("SELECT metric, threshold, severity FROM events WHERE uuid = 'alarm-thresh-1'").get();
  assert.ok(event, 'alarm must be stored');
  assert.strictEqual(event.metric, 'temperature');
  assert.strictEqual(event.severity, 'alarm');
  assert.strictEqual(event.threshold, 28, 'threshold must be 28 (from limits: temperature:high:alarm)');

  closeDb();
});

test('Backfill fills threshold for existing alarm rows that had null threshold before limits were synced', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('living', 'Wohnzimmer', 'dev-1');

  // Pre-insert an alarm row with null threshold (simulates a row from before limits existed)
  db.prepare(`
    INSERT INTO events (uuid, station_id, severity, alarm_status, alarm_condition_type, metric, threshold, start_ts, active, message)
    VALUES (?, ?, 'warning', 'Alarm', 'Lower limit', 'temperature', NULL, ?, 1, 'test')
  `).run('alarm-backfill-1', 'living', Date.now() - 3600000);

  // Sync with MO rows that define temperature:low:warning = 20 °C
  const noopClient = {
    async fetchDeviceProperties() { return []; },
    async fetchDeviceStatus() { return []; },
    async fetchMeasuringObjects() { return makeLiveMoRows(); },
    async fetchMeasurements() { return []; },
    async fetchAlarms() { return []; }
  };
  await schedulerModule.runSyncCycle(noopClient);

  const event = db.prepare("SELECT threshold FROM events WHERE uuid = 'alarm-backfill-1'").get();
  assert.ok(event, 'pre-existing alarm must still exist');
  assert.strictEqual(event.threshold, 20, 'backfill must set threshold to 20 (temperature:low:warning)');

  closeDb();
});

// ── A1: Mapping fix — physical_property_name + physical_extension, not physical_value ──
test('Alarm with live-API shape stores correct metric via physical_property_name / physical_extension', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('a1-st', 'A1 Station', 'dev-1');

  // Live-shaped alarm row: physical_property_name + physical_extension (no physical_value).
  // alarm_value is a string just like the real API sends it.
  const liveAlarm = {
    uuid: 'alarm-a1-hum', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
    alarm_type: 'measurement alarm',       // live API uses a space, not underscore
    alarm_severity: 'Warning', alarm_status: 'Alarm',
    alarm_reason: 'Alarm condition is violated',
    alarm_condition_type: 'Lower limit',
    alarm_value: '35.6',                   // string, as sent by the live API
    physical_property_name: 'Humidity', physical_extension: 'Unknown',
    alarm_time: '2026-06-10T11:00:00Z', last_status_change_time: '2026-06-10T11:00:00Z'
  };

  await schedulerModule.runSyncCycle(new MockTestoClient([liveAlarm]));

  const ev = db.prepare("SELECT metric, alarm_value FROM events WHERE uuid = 'alarm-a1-hum'").get();
  assert.ok(ev, 'live-shaped alarm must be stored');
  // Before the fix, mapPhysicalProperty(a.physical_value) → NULL because physical_value
  // does not exist in the live response.  After the fix it must be 'humidity'.
  assert.strictEqual(ev.metric, 'humidity', 'metric must be derived from physical_property_name + physical_extension');

  closeDb();
});

// ── A2: serial_no stored on alarm rows ────────────────────────────────────
test('Alarm insert stores serial_no from the live API row', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('a2-st', 'A2 Station', 'dev-1');

  const alarm = {
    uuid: 'alarm-a2-sn', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
    alarm_type: 'measurement alarm', alarm_severity: 'Warning', alarm_status: 'Alarm',
    alarm_reason: 'Alarm condition is violated',
    alarm_condition_type: 'Upper limit',
    alarm_value: '28.5',
    physical_property_name: 'Temperature', physical_extension: 'Unknown',
    alarm_time: '2026-06-10T10:00:00Z', last_status_change_time: '2026-06-10T10:00:00Z'
  };

  await schedulerModule.runSyncCycle(new MockTestoClient([alarm]));

  const ev = db.prepare("SELECT serial_no FROM events WHERE uuid = 'alarm-a2-sn'").get();
  assert.ok(ev, 'alarm must be stored');
  assert.strictEqual(ev.serial_no, 'SN123', 'serial_no must be persisted on the event row');

  closeDb();
});

// ── A3a: Reconciliation partition — severity must be part of the group key ─
test('A3a: Warning violation and later Alarm-severity recovery share NO group — warning stays active', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('a3-st', 'A3 Station', 'dev-1');

  const base = Date.parse('2026-06-10T08:00:00Z');
  // Same station, same sensor, same metric, same direction — but DIFFERENT severity.
  // Under the old partition (no severity), the 'Alarm' recovery would mark the
  // 'Warning' violation inactive.  They must be treated as separate groups.
  const alarms = [
    {
      uuid: 'a3a-warn-viol', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
      alarm_type: 'measurement alarm', alarm_severity: 'Warning', alarm_status: 'Alarm',
      alarm_reason: 'Alarm condition is violated',
      alarm_condition_type: 'Lower limit', alarm_value: '34.0',
      physical_property_name: 'Humidity', physical_extension: 'Unknown',
      alarm_time: new Date(base).toISOString(),
      last_status_change_time: new Date(base).toISOString()
    },
    {
      uuid: 'a3a-alarm-recov', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
      alarm_type: 'measurement alarm', alarm_severity: 'Alarm', alarm_status: 'Ok',
      alarm_reason: 'Alarm condition is adhered',
      alarm_condition_type: 'Lower limit', alarm_value: '38.0',
      physical_property_name: 'Humidity', physical_extension: 'Unknown',
      alarm_time: new Date(base + 30 * 60000).toISOString(),   // later
      last_status_change_time: new Date(base + 30 * 60000).toISOString()
    }
  ];

  await schedulerModule.runSyncCycle(new MockTestoClient(alarms));

  const viol = db.prepare("SELECT active FROM events WHERE uuid = 'a3a-warn-viol'").get();
  const recov = db.prepare("SELECT active FROM events WHERE uuid = 'a3a-alarm-recov'").get();
  assert.ok(viol, 'warning violation must be stored');
  assert.ok(recov, 'alarm-severity recovery must be stored');
  // The warning violation must remain active — a recovery from a DIFFERENT severity
  // group must not close it.
  assert.strictEqual(viol.active, 1, 'Warning violation must remain active (different severity group from the Alarm recovery)');
  assert.strictEqual(recov.active, 0, 'a recovery (Ok) is never active');

  closeDb();
});

// ── A3b: Reconciliation partition — serial_no must be part of the group key ─
test('A3b: Two sensors same station/metric/direction — one recovery must not close the other sensor', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('a3b-st', 'A3b Station', 'dev-1');

  const base = Date.parse('2026-06-10T09:00:00Z');
  // Sensor 1 goes into alarm; sensor 2 recovers later.
  // Under the old partition (no serial_no), sensor 2's recovery would close sensor 1's alarm.
  // Two sensors: MockTestoClient routes via serial_no; we need sensor-2 also routable.
  // Use a client with explicit two-sensor device properties.
  const twoSensorClient = {
    async fetchDeviceProperties() {
      return [
        { device_uuid: 'dev-1', device_serial_no: 'SN123', device_display_name: 'Logger', device_model_code: 'testo-160',
          sensor_uuid: 'sensor-1', sensor_serial_no: 'SN123-S1', channel_no: 1,
          channel_physical_property_name: 'Temperature', channel_physical_unit: '°C' },
        { device_uuid: 'dev-1', device_serial_no: 'SN123', device_display_name: 'Logger', device_model_code: 'testo-160',
          sensor_uuid: 'sensor-2', sensor_serial_no: 'SN123-S2', channel_no: 2,
          channel_physical_property_name: 'Temperature', channel_physical_unit: '°C' }
      ];
    },
    async fetchDeviceStatus() { return []; },
    async fetchMeasuringObjects() { return []; },
    async fetchMeasurements() { return []; },
    async fetchAlarms() {
      return [
        {
          uuid: 'a3b-s1-viol', serial_no: 'SN123-S1', alarm_source_uuid: 'sensor-1',
          alarm_type: 'measurement alarm', alarm_severity: 'Warning', alarm_status: 'Alarm',
          alarm_reason: 'Alarm condition is violated',
          alarm_condition_type: 'Upper limit', alarm_value: '26.0',
          physical_property_name: 'Temperature', physical_extension: 'Unknown',
          alarm_time: new Date(base).toISOString(),
          last_status_change_time: new Date(base).toISOString()
        },
        {
          uuid: 'a3b-s2-recov', serial_no: 'SN123-S2', alarm_source_uuid: 'sensor-2',
          alarm_type: 'measurement alarm', alarm_severity: 'Warning', alarm_status: 'Ok',
          alarm_reason: 'Alarm condition is adhered',
          alarm_condition_type: 'Upper limit', alarm_value: '24.0',
          physical_property_name: 'Temperature', physical_extension: 'Unknown',
          alarm_time: new Date(base + 60 * 60000).toISOString(),   // later
          last_status_change_time: new Date(base + 60 * 60000).toISOString()
        }
      ];
    }
  };

  await schedulerModule.runSyncCycle(twoSensorClient);

  const s1Viol = db.prepare("SELECT active FROM events WHERE uuid = 'a3b-s1-viol'").get();
  const s2Recov = db.prepare("SELECT active FROM events WHERE uuid = 'a3b-s2-recov'").get();
  assert.ok(s1Viol, 'sensor-1 violation must be stored');
  assert.ok(s2Recov, 'sensor-2 recovery must be stored');
  // sensor-1's alarm must stay active — sensor-2's recovery is a different sensor
  assert.strictEqual(s1Viol.active, 1, 'sensor-1 violation must remain active (different serial_no group)');
  assert.strictEqual(s2Recov.active, 0, 'a recovery (Ok) is never active');

  closeDb();
});

// ── A4: Alarm-fetch window must overlap so late-arriving transitions aren't lost ─
// Repro of the Büro phantom-alarm bug: a violation is stored in an earlier cycle and
// the watermark advances to wall-clock "now". The matching recovery's server-side
// availability (processed_at) lags, so its alarm_time ends up BEFORE the watermark by
// the time it is queryable. A window that starts exactly at the watermark filters that
// recovery out forever, leaving the violation active=1 (a phantom alarm at a healthy
// value). The fetch window must start a buffer BEFORE the watermark; ON CONFLICT(uuid)
// makes the re-fetch idempotent.
class WindowAwareAlarmClient extends MockTestoClient {
  constructor(allAlarms, moRows = []) {
    super([], moRows);
    this.allAlarms = allAlarms;
    this.alarmRequests = [];
  }
  // Simulate the server-side date filter on alarm_time.
  async fetchAlarms(params) {
    this.alarmRequests.push(params);
    const from = params && params.date_time_from ? new Date(params.date_time_from).getTime() : -Infinity;
    const until = params && params.date_time_until ? new Date(params.date_time_until).getTime() : Infinity;
    return this.allAlarms.filter(a => {
      const t = new Date(a.alarm_time).getTime();
      return t >= from && t <= until;
    });
  }
}

test('A4: late recovery whose alarm_time precedes the watermark is re-fetched via window overlap and clears the violation', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('late-st', 'Late Station', 'dev-1');

  const now = Date.now();
  const tViol = now - 90 * 60000;   // violation 90 min ago (stored in an earlier cycle)
  const tRecov = now - 70 * 60000;  // recovery 70 min ago — but only queryable now
  const watermark = now - 60 * 60000; // we already advanced PAST the recovery's alarm_time
  saveSetting('last_alarm_sync_time', String(watermark));

  // Violation already in the DB and active, exactly as a prior cycle would have left it.
  db.prepare(`INSERT INTO events (uuid, station_id, severity, alarm_status, alarm_condition_type,
                                  alarm_value, metric, serial_no, start_ts, active, message)
              VALUES (?, ?, 'alarm', 'Alarm', 'Lower limit', 17.0, 'temperature', 'SN123', ?, 1, 'viol')`)
    .run('a4-viol', 'late-st', tViol);

  // The recovery is available at the API but its alarm_time sits before the watermark.
  const recovery = {
    uuid: 'a4-recov', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
    alarm_type: 'measurement alarm', alarm_severity: 'Alarm', alarm_status: 'Ok',
    alarm_reason: 'Alarm condition is adhered',
    alarm_condition_type: 'Lower limit', alarm_value: '20.5',
    physical_property_name: 'Temperature', physical_extension: 'Unknown',
    alarm_time: new Date(tRecov).toISOString(),
    last_status_change_time: new Date(tRecov).toISOString()
  };

  const client = new WindowAwareAlarmClient([recovery]);
  await schedulerModule.runSyncCycle(client);

  // Mechanism: the window must start before the watermark (overlap), not exactly at it.
  const req = client.alarmRequests[0];
  assert.ok(req && req.date_time_from, 'an alarm request must have been made');
  assert.ok(new Date(req.date_time_from).getTime() < watermark,
    'fetch window must start before the watermark so late-arriving transitions are re-scanned');

  // Behaviour: the late recovery is ingested and the phantom violation is cleared.
  const recov = db.prepare("SELECT active FROM events WHERE uuid = 'a4-recov'").get();
  assert.ok(recov, 'late recovery must be re-fetched and stored');
  const viol = db.prepare("SELECT active FROM events WHERE uuid = 'a4-viol'").get();
  assert.strictEqual(viol.active, 0, 'violation must clear once its (late) recovery is ingested');

  closeDb();
});

test('Measurement alarm with a non-numeric value gets a generic detail, never "Wert von null"', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // alarm_value is null (or a non-numeric string) → alarmValue coerces to null.
  // The old code emitted "Sensor SN123 hat einen Wert von null gemeldet." — guard must prevent that.
  const alarm = [{
    uuid: 'alarm-null-1', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
    alarm_type: 'measurement alarm', alarm_severity: 'Warning', alarm_status: 'Alarm',
    alarm_reason: 'Alarm condition is violated',
    alarm_condition_type: 'Upper limit',
    alarm_value: null, physical_value: null,
    physical_property_name: 'Temperature', physical_extension: 'Unknown',
    alarm_time: '2026-05-29T06:10:00Z', last_status_change_time: '2026-05-29T06:10:00Z'
  }];

  await schedulerModule.runSyncCycle(new MockTestoClient(alarm));

  const ev = db.prepare("SELECT severity, detail FROM events WHERE uuid = ?").get('alarm-null-1');
  assert.ok(ev, 'the measurement alarm must be stored');
  assert.strictEqual(ev.severity, 'warning');
  assert.strictEqual(ev.detail, 'Sensor SN123 hat einen Grenzwert verletzt.');
  assert.ok(!/null/.test(ev.detail), 'detail darf kein wörtliches "null" enthalten');

  closeDb();
});

test('Measurement alarm headline is German (metric + direction), not the raw English alarm_reason', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // testo delivers the generic English headline "Alarm condition is violated"/"… adhered".
  // The dashboard must show a German metric+direction headline instead.
  const alarms = [
    {
      uuid: 'meas-viol-1', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
      alarm_type: 'measurement alarm', alarm_severity: 'Warning', alarm_status: 'Alarm',
      alarm_reason: 'Alarm condition is violated', alarm_condition_type: 'Upper limit',
      alarm_value: '28.5', physical_property_name: 'Temperature', physical_extension: 'Air Temperature',
      alarm_time: '2026-05-29T06:10:00Z', last_status_change_time: '2026-05-29T06:10:00Z'
    },
    {
      uuid: 'meas-rec-1', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
      alarm_type: 'measurement alarm', alarm_severity: 'Warning', alarm_status: 'Ok',
      alarm_reason: 'Alarm condition is adhered', alarm_condition_type: 'Upper limit',
      alarm_value: '24.1', physical_property_name: 'Temperature', physical_extension: 'Air Temperature',
      alarm_time: '2026-05-29T07:10:00Z', last_status_change_time: '2026-05-29T07:10:00Z'
    },
  ];

  await schedulerModule.runSyncCycle(new MockTestoClient(alarms));

  const viol = db.prepare("SELECT message, detail FROM events WHERE uuid = ?").get('meas-viol-1');
  assert.strictEqual(viol.message, 'Temperatur zu hoch');
  assert.strictEqual(viol.detail, 'Sensor SN123 hat einen Wert von 28.5 gemeldet.');
  assert.ok(!/Alarm condition/.test(viol.message), 'headline darf kein englisches "Alarm condition" enthalten');

  const rec = db.prepare("SELECT message FROM events WHERE uuid = ?").get('meas-rec-1');
  assert.strictEqual(rec.message, 'Temperatur wieder im Normbereich');

  closeDb();
});

test('Sync ingests a non-connection/non-battery system alarm with the maintenance fallback text', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // alarm_type enthält "system" → System-Alarm; condition nennt weder Verbindung noch
  // Batterie → classifyAlarm.subtypeOf() liefert 'maintenance'.
  const alarm = [{
    uuid: 'alarm-maint-1', serial_no: 'SN123', alarm_source_uuid: 'dev-1',
    alarm_type: 'device system alarm', alarm_severity: 'Warning', alarm_status: 'Alarm',
    alarm_reason: 'Alarm condition is violated', alarm_condition_type: 'Sensor maintenance required',
    alarm_value: null, physical_value: null,
    alarm_time: '2026-05-29T06:10:00Z', last_status_change_time: '2026-05-29T06:10:00Z'
  }];

  await schedulerModule.runSyncCycle(new MockTestoClient(alarm));

  const ev = db.prepare("SELECT severity, alarm_condition_type, message, detail FROM events WHERE uuid = ?").get('alarm-maint-1');
  assert.ok(ev, 'the maintenance system alarm must be stored');
  assert.strictEqual(ev.severity, 'system');
  assert.strictEqual(ev.alarm_condition_type, 'maintenance');
  assert.strictEqual(ev.message, 'Gerätehinweis');
  assert.strictEqual(ev.detail, 'Das Gerät meldet einen Geräte- oder Wartungshinweis.');

  closeDb();
});

test('Sync derives episode end_ts from the next transition in the same group', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  const base = Date.parse('2026-05-29T06:00:00Z');
  const mk = (uuid, status, offsetMin) => ({
    uuid, serial_no: 'SN123', alarm_source_uuid: 'dev-1',
    alarm_type: 'device system alarm', alarm_severity: 'Warning', alarm_status: status,
    alarm_reason: status === 'Alarm' ? 'Alarm condition is violated' : 'Alarm condition is adhered',
    alarm_condition_type: 'Connection timeout, device did not communicated in expected time',
    alarm_value: null,
    alarm_time: new Date(base + offsetMin * 60000).toISOString(),
    last_status_change_time: new Date(base + offsetMin * 60000).toISOString(),
  });

  // violated(0) -> adhered(20) -> violated(40), one logical group
  await schedulerModule.runSyncCycle(new MockTestoClient([
    mk('v1', 'Alarm', 0),
    mk('a1', 'Ok', 20),
    mk('v2', 'Alarm', 40),
  ]));

  const by = Object.fromEntries(
    db.prepare("SELECT uuid, start_ts, end_ts, active FROM events WHERE station_id='emc'")
      .all().map(r => [r.uuid, r])
  );
  assert.strictEqual(by['v1'].end_ts, base + 20 * 60000, 'violation end_ts = its recovery start');
  assert.strictEqual(by['v1'].end_ts - by['v1'].start_ts, 20 * 60000, 'episode duration = 20 min');
  assert.strictEqual(by['a1'].end_ts, base + 40 * 60000, 'recovery end_ts = following violation start');
  assert.strictEqual(by['v2'].end_ts, null, 'latest (active) transition has null end_ts');
  assert.strictEqual(by['v2'].active, 1, 'latest unresolved violation stays active');

  closeDb();
});

test('end_ts pairs only within a group — interleaved groups do not cross-pair', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // Insert two logical groups directly, timestamps interleaved across groups.
  // group A: alarm_condition_type 'connection', group B: 'battery' (distinct partitions).
  const base = Date.parse('2026-05-29T06:00:00Z');
  const ins = db.prepare(`INSERT INTO events
    (uuid, station_id, severity, alarm_status, alarm_condition_type, serial_no, metric, start_ts, end_ts, active)
    VALUES (?, 'emc', 'system', ?, ?, 'SN123', NULL, ?, ?, 0)`);
  ins.run('A-v',  'Alarm', 'connection', base + 0 * 60000,  base + 0 * 60000);
  ins.run('B-v',  'Alarm', 'battery',    base + 10 * 60000, base + 10 * 60000);
  ins.run('A-ok', 'Ok',    'connection', base + 30 * 60000, base + 30 * 60000);
  ins.run('B-ok', 'Ok',    'battery',    base + 50 * 60000, base + 50 * 60000);

  // Empty alarm feed: no inserts, but reconciliation still recomputes end_ts over all rows.
  await schedulerModule.runSyncCycle(new MockTestoClient([]));

  const by = Object.fromEntries(
    db.prepare("SELECT uuid, end_ts FROM events WHERE station_id='emc'")
      .all().map(r => [r.uuid, r])
  );
  assert.strictEqual(by['A-v'].end_ts, base + 30 * 60000, 'connection violation pairs with connection recovery');
  assert.strictEqual(by['B-v'].end_ts, base + 50 * 60000, 'battery violation pairs with battery recovery');

  closeDb();
});

// ── Task 7: retention prune clamped by backup floor ───────────────────────────
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('retention prune protects an un-backed-up month, deletes a backed-up one', () => {
  process.env.DB_PATH = ':memory:';
  const { getDb, saveSetting } = require('../db');
  const { computePruneFloor } = require('../backup-runner');
  const { stationBase } = require('../export-service');
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-'));
  saveSetting('backup_dir', dir); saveSetting('backup_enabled', '1'); saveSetting('retention_days', '30');
  db.prepare("INSERT INTO stations (id,name) VALUES ('s1','S')").run();
  const aprTs = Date.UTC(2026, 3, 15); // April — pretend already archived
  const mayTs = Date.UTC(2026, 4, 15); // May  — NOT archived
  const ins = db.prepare("INSERT INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES (?,?,?,1,'temperature','°C')");
  ins.run('a', 's1', aprTs); ins.run('m', 's1', mayTs);
  // Simulate April's ZIP existing so computePruneFloor treats April as backed up (May stays un-backed).
  fs.writeFileSync(path.join(dir, `${stationBase({ id: 's1', name: 'S' })}_2026-04.zip`), 'x');
  const now = Date.UTC(2026, 5, 20);
  const effectiveCutoff = Math.min(now - 30 * 86400000, computePruneFloor(now)); // floor = May 1
  db.prepare("DELETE FROM measurements WHERE timestamp < ?").run(effectiveCutoff);
  assert.strictEqual(db.prepare("SELECT count(*) c FROM measurements WHERE uuid='m'").get().c, 1); // un-backed May survives
  assert.strictEqual(db.prepare("SELECT count(*) c FROM measurements WHERE uuid='a'").get().c, 0); // backed-up April pruned
});
