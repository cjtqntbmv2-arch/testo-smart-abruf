# Real-API Device Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Klima Dashboard pull real measurements, device status, and alarms from the testo Smart Connect API by modelling one dashboard station as one device and resolving device↔sensor↔serial via Device Properties.

**Architecture:** A new pure-function module (`device-bridge.js`) turns Device Properties rows into lookup maps. The scheduler fetches Device Properties once per cycle, updates device status by `device_uuid`, fetches measurements filtered to the assigned devices' `sensor_uuid`s (distributing rows back to stations via the bridge), and attaches real alarms to devices by serial/source uuid. A new `/api/testo/devices` proxy feeds a device picker in the settings UI.

**Tech Stack:** Node.js, Express, better-sqlite3, native `fetch`, `node:test`. Frontend is in-browser-Babel React (no unit-test harness — verified via Chrome MCP).

---

### Task 1: Device-bridge pure helpers

**Files:**
- Create: `backend/device-bridge.js`
- Test: `backend/tests/device-bridge.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/device-bridge.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter } = require('../device-bridge');

test('mapPhysicalProperty maps testo property names to dashboard metrics', () => {
  assert.strictEqual(mapPhysicalProperty('Temperature'), 'temperature');
  assert.strictEqual(mapPhysicalProperty('PV_TEMPERATURE'), 'temperature');
  assert.strictEqual(mapPhysicalProperty('Relative Humidity'), 'humidity');
  assert.strictEqual(mapPhysicalProperty('Luftfeuchte'), 'humidity');
  assert.strictEqual(mapPhysicalProperty('Pressure'), 'pressure');
  assert.strictEqual(mapPhysicalProperty('Luftdruck'), 'pressure');
  assert.strictEqual(mapPhysicalProperty('CO2'), null);
  assert.strictEqual(mapPhysicalProperty(''), null);
  assert.strictEqual(mapPhysicalProperty(undefined), null);
});

test('buildDeviceBridge builds sensor/device/serial maps from device properties', () => {
  const props = [
    { device_uuid: 'dev-1', device_serial_no: 'SN1', sensor_uuid: 's-temp', sensor_serial_no: 'SN1-A', channel_physical_property_name: 'Temperature' },
    { device_uuid: 'dev-1', device_serial_no: 'SN1', sensor_uuid: 's-hum',  sensor_serial_no: 'SN1-B', channel_physical_property_name: 'Humidity' },
    { device_uuid: 'dev-2', device_serial_no: 'SN2', sensor_uuid: 's-out',  sensor_serial_no: 'SN2-A', channel_physical_property_name: 'Temperature' }
  ];
  const b = buildDeviceBridge(props);
  assert.strictEqual(b.sensorToDevice.get('s-temp'), 'dev-1');
  assert.strictEqual(b.sensorToDevice.get('s-out'), 'dev-2');
  assert.deepStrictEqual([...b.deviceSensors.get('dev-1')].sort(), ['s-hum', 's-temp']);
  assert.strictEqual(b.serialToDevice.get('SN1-A'), 'dev-1'); // sensor serial
  assert.strictEqual(b.serialToDevice.get('SN1'), 'dev-1');   // device serial
  assert.strictEqual(b.devices.size, 2);
});

test('buildSensorFilter joins sensor uuids into an OData filter, null when empty', () => {
  assert.strictEqual(buildSensorFilter(['a', 'b']), "sensor_uuid eq 'a' or sensor_uuid eq 'b'");
  assert.strictEqual(buildSensorFilter(new Set(['x'])), "sensor_uuid eq 'x'");
  assert.strictEqual(buildSensorFilter([]), null);
  assert.strictEqual(buildSensorFilter(null), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test backend/tests/device-bridge.test.js`
Expected: FAIL with `Cannot find module '../device-bridge'`.

- [ ] **Step 3: Implement the module**

Create `backend/device-bridge.js`:

```javascript
// Pure helpers mapping the testo identifier model (device <-> sensor <-> serial <-> property)
// into the lookups the scheduler needs. No I/O — unit-testable in isolation.

// Map a testo physical_property_name to one of the dashboard's three metrics.
// Returns null for properties the dashboard has no tile for (e.g. CO2).
function mapPhysicalProperty(name) {
  const p = (name || '').toLowerCase();
  if (p.includes('temp')) return 'temperature';
  if (p.includes('humid') || p.includes('feucht')) return 'humidity';
  if (p.includes('press') || p.includes('druck')) return 'pressure';
  return null;
}

// Build lookup maps from Device Properties rows (one row per channel).
function buildDeviceBridge(properties) {
  const sensorToDevice = new Map();
  const deviceSensors = new Map();
  const serialToDevice = new Map();
  const devices = new Set();

  for (const row of (properties || [])) {
    const dev = row.device_uuid;
    if (!dev) continue;
    devices.add(dev);

    const sensor = row.sensor_uuid;
    if (sensor) {
      sensorToDevice.set(sensor, dev);
      if (!deviceSensors.has(dev)) deviceSensors.set(dev, new Set());
      deviceSensors.get(dev).add(sensor);
    }
    if (row.sensor_serial_no) serialToDevice.set(row.sensor_serial_no, dev);
    if (row.device_serial_no) serialToDevice.set(row.device_serial_no, dev);
  }

  return { sensorToDevice, deviceSensors, serialToDevice, devices };
}

// Build an OData $filter matching any of the given sensor uuids.
// Returns null when there are no sensors (caller should skip the request).
function buildSensorFilter(sensorUuids) {
  const list = Array.from(sensorUuids || []).filter(Boolean);
  if (list.length === 0) return null;
  return list.map((s) => `sensor_uuid eq '${s}'`).join(' or ');
}

module.exports = { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test backend/tests/device-bridge.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/device-bridge.js backend/tests/device-bridge.test.js
git commit -m "feat(backend): add device-bridge helpers for testo identifier model"
```

---

### Task 2: Device Properties client method + consistent mock

**Files:**
- Modify: `backend/testo-client.js`
- Test: `backend/tests/testo-client.test.js`

- [ ] **Step 1: Add the failing test**

Append to `backend/tests/testo-client.test.js`, BEFORE the final `after(() => {...})` block:

```javascript
test('Testo API Client fetches device properties via async flow', async () => {
  const client = new TestoClient('test-key', 'eu');

  mockResponses['/v3/devices/properties'] = { status: 'Submitted', request_uuid: 'props-req' };
  mockResponses['/v3/devices/properties/props-req'] = {
    status: 'Completed',
    data_urls: ['https://s3.example.com/props.json']
  };
  mockResponses['s3.example.com/props.json'] = [
    { device_uuid: 'dev-1', sensor_uuid: 's-1', channel_physical_property_name: 'Temperature' }
  ];

  const data = await client.fetchDeviceProperties();
  assert.strictEqual(data.length, 1);
  assert.strictEqual(data[0].device_uuid, 'dev-1');
  assert.strictEqual(data[0].sensor_uuid, 's-1');
});

test('Mock mode returns consistent device properties, measurements and status', async () => {
  const mockClient = new TestoClient('mock-api-key', 'eu');
  const props = await mockClient.fetchDeviceProperties();
  const meas = await mockClient.fetchMeasurements({ date_time_from: new Date().toISOString() });
  const status = await mockClient.fetchDeviceStatus();

  // Sensor uuids in measurements must resolve to a device via device properties
  const sensorToDevice = new Map(props.map(p => [p.sensor_uuid, p.device_uuid]));
  for (const m of meas) {
    assert.ok(sensorToDevice.has(m.sensor_uuid), `measurement sensor ${m.sensor_uuid} must be in device properties`);
  }
  // Device uuid in status must match a device in properties (and NOT equal a sensor uuid)
  assert.ok(props.some(p => p.device_uuid === status[0].device_uuid));
  assert.ok(!sensorToDevice.has(status[0].device_uuid), 'device_uuid must be distinct from sensor uuids');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/tests/testo-client.test.js`
Expected: FAIL — `fetchDeviceProperties is not a function`, and the mock consistency test fails because current mock measurements use `sensor_uuid: 'mock-device-uuid'`.

- [ ] **Step 3: Add the method**

In `backend/testo-client.js`, add this method after `fetchMeasuringObjects()`:

```javascript
  async fetchDeviceProperties() {
    return this._executeAsyncFlow('/v3/devices/properties', '/v3/devices/properties', {
      options: { result_file_format: 'JSON' }
    });
  }
```

- [ ] **Step 4: Add mock submit/poll routes**

In `backend/testo-client.js`, inside `_request`, in the `if (this.apiKey === 'mock-api-key')` block, add these two lines next to the other mock routes:

```javascript
      if (path === '/v3/devices/properties' && method === 'POST') return { request_uuid: 'mock-props-req' };
      if (path === '/v3/devices/properties/mock-props-req') return { status: 'Completed', data_urls: ['mock://properties'] };
```

- [ ] **Step 5: Add the mock properties payload and fix mock measurements**

In `backend/testo-client.js`, inside `_downloadFiles`, add a new branch handling `mock://properties` (place it next to the other `mock://` branches):

```javascript
        } else if (url === 'mock://properties') {
          allRecords = allRecords.concat([
            { device_uuid: 'mock-device-uuid', device_serial_no: 'MOCK123', device_display_name: 'Mock Logger', device_model_code: 'testo-160-THE', sensor_uuid: 'mock-sensor-temp', sensor_serial_no: 'MOCK123-S1', channel_no: 1, channel_physical_property_name: 'Temperature', channel_physical_unit: '°C' },
            { device_uuid: 'mock-device-uuid', device_serial_no: 'MOCK123', device_display_name: 'Mock Logger', device_model_code: 'testo-160-THE', sensor_uuid: 'mock-sensor-hum', sensor_serial_no: 'MOCK123-S2', channel_no: 2, channel_physical_property_name: 'Humidity', channel_physical_unit: '%' }
          ]);
          continue;
```

Then REPLACE the existing `mock://meas` branch body so measurement rows use the distinct sensor uuids:

```javascript
        } else if (url === 'mock://meas') {
          const rand = Math.random().toString(36).substring(2, 7);
          allRecords = allRecords.concat([
            { uuid: `meas-${Date.now()}-${rand}-1`, sensor_uuid: 'mock-sensor-temp', timestamp: new Date().toISOString(), timestamp_local: new Date().toLocaleString(), measurement: 23.5, physical_property_name: 'Temperature', physical_unit: '°C', channel_no: 1, serial_no: 'MOCK123-S1', model_code: 'testo-160-THE', processed_at: new Date().toISOString() },
            { uuid: `meas-${Date.now()}-${rand}-2`, sensor_uuid: 'mock-sensor-hum', timestamp: new Date().toISOString(), timestamp_local: new Date().toLocaleString(), measurement: 45.2, physical_property_name: 'Humidity', physical_unit: '%', channel_no: 2, serial_no: 'MOCK123-S2', model_code: 'testo-160-THE', processed_at: new Date().toISOString() }
          ]);
          continue;
```

Finally REPLACE the existing `mock://alarms` branch body so the alarm references a sensor serial of the mock device:

```javascript
        } else if (url === 'mock://alarms') {
          allRecords = allRecords.concat([
            { uuid: `alarm-${Date.now()}`, serial_no: 'MOCK123-S1', alarm_source_uuid: 'mock-sensor-temp', alarm_severity: 'Warning', alarm_status: 'Active', alarm_reason: 'High temperature', alarm_condition_type: 'Threshold', alarm_value: 23.5, physical_value: 'Temperature', alarm_time: new Date(Date.now() - 3600000).toISOString(), last_status_change_time: new Date().toISOString() }
          ]);
          continue;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test backend/tests/testo-client.test.js`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 7: Commit**

```bash
git add backend/testo-client.js backend/tests/testo-client.test.js
git commit -m "feat(backend): add fetchDeviceProperties and make mock identifiers consistent"
```

---

### Task 3: Rewrite scheduler to use the device bridge

**Files:**
- Modify: `backend/scheduler.js` (full rewrite of `runSyncCycle`; add diagnostics to `getSchedulerStatus`)
- Test: `backend/tests/scheduler.test.js` (full rewrite for the new flow)

- [ ] **Step 1: Replace the test file**

Replace the ENTIRE contents of `backend/tests/scheduler.test.js` with:

```javascript
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

  // Status join by device_uuid
  const station = db.prepare("SELECT battery, signal, connection_type, serial_no FROM stations WHERE id = ?").get('living');
  assert.strictEqual(station.battery, 85);
  assert.strictEqual(station.signal, 90);
  assert.strictEqual(station.connection_type, 'WIFI');
  assert.strictEqual(station.serial_no, 'SN123');

  // Measurement filtered by the device's sensor uuid
  assert.strictEqual(client.lastMeasurementParams.odata.$filter, "sensor_uuid eq 'sensor-1'");

  // Measurement distributed to the right station via the bridge
  const meas = db.prepare("SELECT station_id, value, physical_property, sensor_uuid FROM measurements WHERE uuid = ?").get('meas-123');
  assert.ok(meas);
  assert.strictEqual(meas.station_id, 'living');
  assert.strictEqual(meas.value, 22.4);
  assert.strictEqual(meas.physical_property, 'temperature');
  assert.strictEqual(meas.sensor_uuid, 'sensor-1');

  // Alarm linked to the device's station via serial bridge
  const event = db.prepare("SELECT station_id, severity, metric FROM events WHERE uuid = ?").get('alarm-123');
  assert.ok(event);
  assert.strictEqual(event.station_id, 'living');
  assert.strictEqual(event.severity, 'alarm');
  assert.strictEqual(event.metric, 'temperature');

  // Diagnostics populated
  const st = schedulerModule.getSchedulerStatus();
  assert.strictEqual(st.diagnostics.devicesSeen, 1);
  assert.strictEqual(st.diagnostics.sensorsSeen, 1);
  assert.strictEqual(st.diagnostics.measurementsFetched, 1);

  // Retention cleanup
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/tests/scheduler.test.js`
Expected: FAIL — current scheduler has no bridge, no diagnostics, and filters per-station, so the `$filter`, distribution, and `diagnostics` assertions fail.

- [ ] **Step 3: Rewrite the scheduler**

Replace the ENTIRE contents of `backend/scheduler.js` with:

```javascript
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
    for (const s of stationRows) deviceToStation.set(s.device_uuid, s.id);

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
        const latest = db.prepare("SELECT max(timestamp) as max_ts FROM measurements").get();
        const fromDate = (latest && latest.max_ts)
          ? new Date(latest.max_ts + 1000)
          : new Date(Date.now() - 24 * 3600 * 1000);

        const measurements = await client.fetchMeasurements({
          date_time_from: fromDate.toISOString(),
          odata: { $filter: filter }
        });
        diag.measurementsFetched = measurements.length;

        db.transaction(() => {
          for (const m of measurements) {
            const dev = bridge.sensorToDevice.get(m.sensor_uuid);
            const stationId = dev ? deviceToStation.get(dev) : null;
            const prop = mapPhysicalProperty(m.physical_property_name);
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

      const alarms = await client.fetchAlarms({ date_time_from: lastSync.toISOString() });

      db.transaction(() => {
        for (const a of alarms) {
          const dev = bridge.serialToDevice.get(a.serial_no)
            || bridge.sensorToDevice.get(a.alarm_source_uuid)
            || (bridge.deviceSensors.has(a.alarm_source_uuid) ? a.alarm_source_uuid : null);
          const stationId = dev ? deviceToStation.get(dev) : null;
          if (!stationId) diag.alarmsUnmatched++;

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

      saveSetting('last_alarm_sync_time', String(Date.now()));
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
```

- [ ] **Step 4: Run the scheduler tests to verify they pass**

Run: `node --test backend/tests/scheduler.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/scheduler.js backend/tests/scheduler.test.js
git commit -m "feat(backend): drive sync via device bridge (status by device, measurements by sensor, alarms by serial)"
```

---

### Task 4: Device list proxy endpoint + diagnostics surfaced

**Files:**
- Modify: `backend/server.js`
- Test: `backend/tests/server.test.js` (full rewrite to add coverage and a clean teardown)

Note: scheduler diagnostics already flow into `/api/system/status` via `getSchedulerStatus().diagnostics` (added in Task 3). This task adds the `/api/testo/devices` proxy and asserts both.

- [ ] **Step 1: Replace the test file**

Replace the ENTIRE contents of `backend/tests/server.test.js` with:

```javascript
const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH = ':memory:';
process.env.PORT = '3001';
const { initDb, saveSetting, closeDb } = require('../db');
const { stopScheduler } = require('../scheduler');

initDb();
const server = require('../server');

test('Core REST endpoints respond with expected shape', async () => {
  const resSettings = await fetch('http://localhost:3001/api/settings');
  assert.strictEqual(resSettings.status, 200);
  const settings = await resSettings.json();
  assert.ok(settings.hasOwnProperty('poll_interval_sec'));

  const resStatus = await fetch('http://localhost:3001/api/system/status');
  assert.strictEqual(resStatus.status, 200);
  const status = await resStatus.json();
  assert.ok(status.hasOwnProperty('database'));
  assert.ok(status.hasOwnProperty('scheduler'));
  assert.ok(status.scheduler.hasOwnProperty('diagnostics'));
  assert.ok(status.scheduler.diagnostics.hasOwnProperty('devicesSeen'));
  assert.ok(status.scheduler.diagnostics.hasOwnProperty('measurementsUnmatched'));
});

test('GET /api/testo/devices returns a deduplicated device list (mock mode)', async () => {
  saveSetting('api_key', 'mock-api-key');
  saveSetting('api_region', 'eu');

  const res = await fetch('http://localhost:3001/api/testo/devices');
  assert.strictEqual(res.status, 200);
  const devices = await res.json();
  assert.ok(Array.isArray(devices));
  assert.strictEqual(devices.length, 1); // two channels of one mock device -> one device
  assert.strictEqual(devices[0].device_uuid, 'mock-device-uuid');
  assert.strictEqual(devices[0].name, 'Mock Logger');
  assert.strictEqual(devices[0].serial_no, 'MOCK123');
});

test('GET /api/testo/devices returns 400 when no API key configured', async () => {
  saveSetting('api_key', '');
  const res = await fetch('http://localhost:3001/api/testo/devices');
  assert.strictEqual(res.status, 400);
});

after(() => {
  server.close();
  stopScheduler();
  closeDb();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/tests/server.test.js`
Expected: FAIL — `/api/testo/devices` returns 404 (route not defined).

- [ ] **Step 3: Add the endpoint**

In `backend/server.js`, add this route immediately after the existing `GET /api/testo/measuring-objects` handler:

```javascript
// GET /api/testo/devices (deduplicated device list for the assignment picker)
app.get('/api/testo/devices', async (req, res) => {
  try {
    const apiKey = getSetting('api_key');
    const region = getSetting('api_region') || 'eu';
    if (!apiKey) return res.status(400).json({ error: 'API key not configured' });

    const client = new TestoClient(apiKey, region);
    const props = await client.fetchDeviceProperties();
    const byDevice = new Map();
    for (const r of props) {
      if (!r.device_uuid || byDevice.has(r.device_uuid)) continue;
      byDevice.set(r.device_uuid, {
        device_uuid: r.device_uuid,
        name: r.device_display_name || r.device_uuid,
        serial_no: r.device_serial_no || '',
        model_code: r.device_model_code || ''
      });
    }
    res.json(Array.from(byDevice.values()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/tests/server.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/server.js backend/tests/server.test.js
git commit -m "feat(backend): add /api/testo/devices proxy and surface sync diagnostics"
```

---

### Task 5: Device picker in the settings UI

**Files:**
- Modify: `Smart Meter Dashboard/settings.jsx`

No JS unit-test harness exists for the in-browser-Babel frontend; this task is verified live in Chrome in Task 6.

- [ ] **Step 1: Switch the data source from measuring-objects to devices**

In `StationsSection`, REPLACE the state declarations and the fetch effect:

```javascript
  // API Objects list
  const [moList, setMoList] = sState([]);
  const [loadingMO, setLoadingMO] = sState(false);
  const [moError, setMoError] = sState(null);

  // Fetch measuring objects from local backend proxy
  sEff(() => {
    if (!editingId && !adding) return;
    setLoadingMO(true);
    setMoError(null);
    fetch('/api/testo/measuring-objects')
      .then(res => {
        if (!res.ok) throw new Error('API-Fehler oder API-Schlüssel nicht konfiguriert');
        return res.json();
      })
      .then(data => {
        setMoList(data || []);
        setLoadingMO(false);
      })
      .catch(err => {
        setMoError(err.message);
        setLoadingMO(false);
      });
  }, [editingId, adding]);
```

with:

```javascript
  // Device list from local backend proxy (one entry per physical logger)
  const [deviceList, setDeviceList] = sState([]);
  const [loadingDevices, setLoadingDevices] = sState(false);
  const [deviceError, setDeviceError] = sState(null);

  sEff(() => {
    if (!editingId && !adding) return;
    setLoadingDevices(true);
    setDeviceError(null);
    fetch('/api/testo/devices')
      .then(res => {
        if (!res.ok) throw new Error('API-Fehler oder API-Schlüssel nicht konfiguriert');
        return res.json();
      })
      .then(data => {
        setDeviceList(data || []);
        setLoadingDevices(false);
      })
      .catch(err => {
        setDeviceError(err.message);
        setLoadingDevices(false);
      });
  }, [editingId, adding]);
```

- [ ] **Step 2: Remove the obsolete channel-assignments extractor**

In `StationsSection`, DELETE the entire `extractDeviceUuid` helper function:

```javascript
  // Helper to extract device UUID from channel assignments
  function extractDeviceUuid(mo) {
    try {
      if (mo.channel_assignments) {
        const channels = typeof mo.channel_assignments === 'string'
          ? JSON.parse(mo.channel_assignments)
          : mo.channel_assignments;
        if (channels && channels[0]) {
          return channels[0].sensor_uuid || channels[0].device_uuid || '';
        }
      }
    } catch (e) {
      console.error('Error parsing channel assignments:', e);
    }
    return '';
  }
```

- [ ] **Step 3: Replace the dropdown field**

In `StationsSection`'s edit form, REPLACE the entire "Testo Cloud Messobjekt" `<Field>` block (the one that renders `loadingMO ? ... : moError ? ... : <select value={formMoUuid} ...>`) with a device picker:

```javascript
          <Field label="Testo Gerät (Logger)" hint="Verbindet diese Messstelle mit einem physikalischen Logger aus Ihrem testo Account. Alle Sensoren/Kanäle des Geräts fließen in die Metriken.">
            {loadingDevices ? (
              <div style={{ padding: '8px 0' }}><Spinner /> Lade Geräte aus testo Cloud...</div>
            ) : deviceError ? (
              <div style={{ color: 'var(--alarm)', fontSize: '12px', padding: '8px 0' }}>
                ⚠️ {deviceError}
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Bitte stellen Sie sicher, dass Ihr API-Schlüssel in der Rubrik 'API & Verbindung' korrekt eingetragen ist.
                </div>
              </div>
            ) : (
              <select
                value={formDeviceUuid}
                onChange={(e) => setFormDeviceUuid(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 11px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  outline: 'none',
                  fontSize: '13px'
                }}
              >
                <option value="">-- Kein Gerät zugewiesen (statische Simulation) --</option>
                {deviceList.map(dev => (
                  <option key={dev.device_uuid} value={dev.device_uuid}>
                    {dev.name}{dev.serial_no ? ` · ${dev.serial_no}` : ''} ({dev.device_uuid.substring(0, 8)}...)
                  </option>
                ))}
              </select>
            )}
          </Field>
```

- [ ] **Step 4: Relabel the manual override field**

In `StationsSection`, REPLACE the "Sensor / Device UUID" `<Field>` label/hint so it clearly refers to the device:

```javascript
          <Field label="Geräte-UUID (manuell)" hint="Die device_uuid des Loggers. Wird bei Geräteauswahl automatisch befüllt; nur für manuelle Overrides ändern.">
            <input
              type="text"
              value={formDeviceUuid}
              onChange={(e) => setFormDeviceUuid(e.target.value)}
              placeholder="Wird automatisch befüllt oder manuell eingeben"
            />
          </Field>
```

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/settings.jsx"
git commit -m "feat(ui): replace measuring-object picker with device picker in assignment manager"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: ALL tests pass (`device-bridge`, `testo-client`, `scheduler`, `server`, `init`, `db`).

- [ ] **Step 2: Start from a clean mock DB**

The existing `klima.db` has all 5 stations sharing `device_uuid='mock-device-uuid'`. Because one device maps to one station (see Notes), reset to the freshly-seeded 4 default stations (which have NO device assigned), then run the server:

```bash
rm -f klima.db
node backend/server.js   # leave running in a separate shell
```

Wait ~5 seconds. With no station assigned, the initial sync logs "Skipping measurement sync: no sensors resolved" — expected.

- [ ] **Step 3: Assign a device and verify the full flow in Chrome (mock mode)**

Using the Chrome MCP: navigate to `http://localhost:3000/`, then:
- Open Settings → Messstellen → "Wohnzimmer" Bearbeiten → "Testo Gerät" dropdown: confirm it lists "Mock Logger · MOCK123". Select it, save.
- Wait ~5 s (assignment triggers an immediate sync via `runSyncCycle`).
- Back on the dashboard, confirm the **Wohnzimmer** tiles fill (temperature ~23.5 °C, humidity ~45.2 %), `rootChildCount > 0`, zero console errors. (Other stations stay empty — they have no device assigned; that is correct.)

Evidence command (run while server is up):
```bash
curl -s http://localhost:3000/api/system/status | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log(JSON.stringify(s.scheduler.diagnostics))})'
```
Expected after assignment: `{"devicesSeen":1,"sensorsSeen":2,"measurementsFetched":2,"measurementsUnmatched":0,"alarmsUnmatched":0}`

- [ ] **Step 4: Stop the server**

Stop the `node backend/server.js` process. No code commit needed if Tasks 1–5 were committed.

- [ ] **Step 5: Real-key validation (user-performed)**

Hand back to the user: in Settings → API & Verbindung enter the real API key + region; in Messstellen assign a real device to a station; confirm tiles fill and `scheduler.diagnostics` shows non-zero `measurementsFetched` with `measurementsUnmatched: 0`. If `measurementsUnmatched` is high, the property mapping (`mapPhysicalProperty`) or the device→sensor resolution needs the real payload to refine — the diagnostics pinpoint which boundary.

---

## Notes for the implementer

- **One device → one station (1:1).** `measurements.uuid` is the primary key, so a measurement row can belong to exactly one station; `deviceToStation` is therefore a plain `Map` (last write wins if two stations share a `device_uuid` — don't do that). The real-world model is one logger per dashboard station.
- **DB schema is unchanged** — `stations` already has `serial_no`; sensors are resolved at runtime, no new column.
- **Local threshold logic in the dashboard is untouched** — real API alarms are added alongside it.
- **Metrics other than temperature/humidity/pressure are intentionally ignored** (`mapPhysicalProperty` returns `null`); they are counted in `measurementsUnmatched` for visibility.
- **`mo_uuid` stays on stations** for a possible future limit-value sync but is not used by this plan.
