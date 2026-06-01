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

after(() => {
  server.close();
  stopScheduler();
  closeDb();
});
