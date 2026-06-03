const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH = ':memory:';
process.env.PORT = '3001';
const { initDb, saveSetting, closeDb, getDb } = require('../db');
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
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].device_uuid, 'mock-device-uuid');
  assert.strictEqual(devices[0].name, 'Mock Logger');
  assert.strictEqual(devices[0].serial_no, 'MOCK123');
});

test('GET /api/testo/devices returns 400 when no API key configured', async () => {
  saveSetting('api_key', '');
  const res = await fetch('http://localhost:3001/api/testo/devices');
  assert.strictEqual(res.status, 400);
});

test('POST /api/stations update preserves measurements and telemetry (no cascade wipe)', async () => {
  saveSetting('api_key', ''); // skip background sync for a deterministic test
  const db = getDb();

  // Create the station via the same endpoint the UI uses for "add"
  await fetch('http://localhost:3001/api/stations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'edittest', name: 'Original', location: 'Loc', mo_uuid: null, device_uuid: 'dev-1' })
  });

  // Simulate live device telemetry + a measurement the scheduler has stored
  db.prepare("UPDATE stations SET battery = 88, signal = 77, online = 1 WHERE id = 'edittest'").run();
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-edit-1','edittest',1000,21.5,'Temperature','°C')").run();

  // EDIT the station (rename) via the same POST endpoint the UI uses for "edit"
  await fetch('http://localhost:3001/api/stations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'edittest', name: 'Renamed', location: 'Loc', mo_uuid: null, device_uuid: 'dev-1' })
  });

  const station = db.prepare("SELECT * FROM stations WHERE id = 'edittest'").get();
  const measCount = db.prepare("SELECT count(*) c FROM measurements WHERE station_id = 'edittest'").get().c;

  assert.strictEqual(station.name, 'Renamed', 'edit should update the name');
  assert.strictEqual(measCount, 1, 'edit must NOT cascade-delete the station\'s measurements');
  assert.strictEqual(station.battery, 88, 'edit must preserve battery telemetry');
  assert.strictEqual(station.signal, 77, 'edit must preserve signal telemetry');
});

after(() => {
  server.close();
  stopScheduler();
  closeDb();
});
