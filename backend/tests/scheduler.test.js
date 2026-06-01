const test = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH = ':memory:';
const { initDb, getDb, saveSetting, closeDb } = require('../db');

// Mock client consistent with the device-bridge model: device 'dev-1' (serial SN123)
// owns sensor 'sensor-1' (serial SN123-S1, Temperature).
class MockTestoClient {
  constructor(alarms = []) {
    this.alarms = alarms;
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
    uuid: 'alarm-123', serial_no: 'SN123', alarm_source_uuid: 'sensor-1', alarm_severity: 'Alarm', alarm_status: 'Active',
    alarm_reason: 'Temperatur zu hoch', alarm_condition_type: 'HighLimit', alarm_value: 28.5, physical_value: 'Temperature',
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

  const event = db.prepare("SELECT station_id, severity, metric FROM events WHERE uuid = ?").get('alarm-123');
  assert.ok(event);
  assert.strictEqual(event.station_id, 'living');
  assert.strictEqual(event.severity, 'alarm');
  assert.strictEqual(event.metric, 'temperature');

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

test('Sync completes without throwing when device properties fail', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('s1', 'S1', 'dev-x');

  const badClient = {
    async fetchDeviceProperties() { throw new Error('props down'); },
    async fetchDeviceStatus() { return []; },
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
    async fetchMeasurements() { return []; },
    async fetchAlarms() {
      return [{ uuid: 'alarm-orphan', serial_no: 'UNKNOWN-SERIAL', alarm_source_uuid: 'unknown-uuid', alarm_severity: 'Alarm', alarm_status: 'Active', alarm_value: 1, physical_value: 'Temperature', alarm_time: '2026-05-29T06:00:00Z' }];
    }
  };

  await schedulerModule.runSyncCycle(client);

  const row = db.prepare("SELECT uuid FROM events WHERE uuid = 'alarm-orphan'").get();
  assert.strictEqual(row, undefined, 'orphan alarm should not be inserted');
  const st = schedulerModule.getSchedulerStatus();
  assert.strictEqual(st.diagnostics.alarmsUnmatched, 1);
  closeDb();
});
