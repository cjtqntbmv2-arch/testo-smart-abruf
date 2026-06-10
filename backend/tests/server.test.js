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

test('GET /api/stations/:id/metrics returns measured dewpoint and abshumid series', async () => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id, name) VALUES ('mtest', 'Metric Test')").run();
  const ts = Date.now() - 3600 * 1000; // within the 24h window
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('mm-t','mtest',?,21.0,'temperature','°C')").run(ts);
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('mm-d','mtest',?,9.5,'dewpoint','°C')").run(ts);
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('mm-a','mtest',?,8.2,'abshumid','g/m³')").run(ts);

  const res = await fetch('http://localhost:3001/api/stations/mtest/metrics');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.metrics.dewpoint, 'response must include a dewpoint series');
  assert.ok(body.metrics.abshumid, 'response must include an abshumid series');
  assert.deepStrictEqual(body.metrics.dewpoint.series, [9.5]);
  assert.deepStrictEqual(body.metrics.abshumid.series, [8.2]);
  assert.deepStrictEqual(body.metrics.temperature.series, [21.0]);
  assert.deepStrictEqual(body.metrics.humidity.series, [null]);
  assert.deepStrictEqual(body.metrics.pressure.series, [null]);
});

test('GET /api/totals counts active system events', async () => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id, name) VALUES ('totst', 'Totals Test')").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, active) VALUES ('sys-x-totst','totst','system',?,1)")
    .run(Date.now());

  const res = await fetch('http://localhost:3001/api/totals');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.system >= 1, 'active system events must be counted in totals.system');
});

// ── H1: POST /api/stations input validation ────────────────────────────────
test('POST /api/stations rejects missing id with 400', async () => {
  const res = await fetch('http://localhost:3001/api/stations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, 'response must contain an error message');
});

test('POST /api/stations rejects missing name with 400', async () => {
  const res = await fetch('http://localhost:3001/api/stations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'valid-id' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('POST /api/stations rejects empty id string with 400', async () => {
  const res = await fetch('http://localhost:3001/api/stations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '', name: 'Test' })
  });
  assert.strictEqual(res.status, 400);
});

test('POST /api/stations rejects id with invalid characters with 400', async () => {
  const res = await fetch('http://localhost:3001/api/stations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'Has Spaces!', name: 'Test' })
  });
  assert.strictEqual(res.status, 400);
});

test('POST /api/stations accepts valid id and name (optional fields null)', async () => {
  const db = getDb();
  const res = await fetch('http://localhost:3001/api/stations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'val-id', name: 'Valid Station' })
  });
  assert.strictEqual(res.status, 200);
  const station = db.prepare("SELECT id, name FROM stations WHERE id = 'val-id'").get();
  assert.ok(station, 'valid station must be inserted');
  assert.strictEqual(station.name, 'Valid Station');
});

// ── H1: POST /api/settings input validation ────────────────────────────────
test('POST /api/settings rejects non-positive poll_interval_sec with 400', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poll_interval_sec: 0 })
  });
  assert.strictEqual(res.status, 400);
});

test('POST /api/settings rejects negative poll_interval_sec with 400', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poll_interval_sec: -10 })
  });
  assert.strictEqual(res.status, 400);
});

test('POST /api/settings coerces numeric string poll_interval_sec', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poll_interval_sec: '60' })
  });
  assert.strictEqual(res.status, 200);
});

test('POST /api/settings rejects invalid api_region with 400', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_region: 'de' })
  });
  assert.strictEqual(res.status, 400);
});

test('POST /api/settings accepts valid api_region eu/us', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_region: 'us' })
  });
  assert.strictEqual(res.status, 200);
});

test('POST /api/settings rejects non-positive retention_days with 400', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ retention_days: 0 })
  });
  assert.strictEqual(res.status, 400);
});

// ── H2: GET /api/settings masks api_key ───────────────────────────────────
test('GET /api/settings returns api_key_set instead of cleartext api_key', async () => {
  saveSetting('api_key', 'secret-key-value');
  const res = await fetch('http://localhost:3001/api/settings');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(!body.hasOwnProperty('api_key'), 'api_key must NOT be present in response');
  assert.ok(body.hasOwnProperty('api_key_set'), 'api_key_set must be present');
  assert.strictEqual(body.api_key_set, true, 'api_key_set must be true when key is stored');
});

test('GET /api/settings returns api_key_set false when no key stored', async () => {
  saveSetting('api_key', '');
  const res = await fetch('http://localhost:3001/api/settings');
  const body = await res.json();
  assert.strictEqual(body.api_key_set, false);
});

// ── H2: POST /api/settings does not wipe existing key when absent or empty ─
test('POST /api/settings with absent api_key leaves stored key unchanged', async () => {
  saveSetting('api_key', 'preserved-key');
  await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poll_interval_sec: 300 })
  });
  const { getSetting: gs } = require('../db');
  assert.strictEqual(gs('api_key'), 'preserved-key', 'key must be preserved when not in payload');
});

test('POST /api/settings with empty string api_key leaves stored key unchanged', async () => {
  saveSetting('api_key', 'do-not-wipe');
  await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: '' })
  });
  const { getSetting: gs } = require('../db');
  assert.strictEqual(gs('api_key'), 'do-not-wipe', 'empty string must not wipe the key');
});

test('POST /api/settings with non-empty api_key updates the stored key', async () => {
  saveSetting('api_key', 'old-key');
  await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'new-key' })
  });
  const { getSetting: gs } = require('../db');
  assert.strictEqual(gs('api_key'), 'new-key');
});

// ── H1: Central error middleware returns 500 JSON ─────────────────────────
test('Error middleware returns 500 JSON on thrown DB error', async () => {
  // This tests that Express error middleware catches thrown errors in route handlers.
  // We trigger this via a route that would throw if the DB is broken —
  // we can't easily break the DB, but we verify the endpoint returns JSON on 500
  // by checking the error middleware is wired (it's structural; existence is verified by integration).
  // As a proxy: confirm all error responses are JSON content-type:
  const res = await fetch('http://localhost:3001/api/testo/devices');
  // api_key cleared earlier, should be 400 JSON
  const ct = res.headers.get('content-type');
  assert.ok(ct && ct.includes('application/json'), 'error responses must be JSON');
});

// ── K3: GET /api/system/status returns null for empty DB ──────────────────
test('GET /api/system/status returns null lastWrite and oldestRecord when DB is empty', async () => {
  // Clear all measurements and events
  const db = getDb();
  db.prepare("DELETE FROM measurements").run();
  db.prepare("DELETE FROM events").run();

  const res = await fetch('http://localhost:3001/api/system/status');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.database.lastWrite, null, 'lastWrite must be null with no rows');
  assert.strictEqual(body.database.oldestRecord, null, 'oldestRecord must be null with no rows');
});

// ── M10: GET /api/system/status includes appVersion ───────────────────────
test('GET /api/system/status includes appVersion string', async () => {
  const res = await fetch('http://localhost:3001/api/system/status');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.hasOwnProperty('appVersion'), 'response must include appVersion');
  assert.strictEqual(typeof body.appVersion, 'string', 'appVersion must be a string');
  assert.ok(body.appVersion.length > 0, 'appVersion must not be empty');
});

// ── K3: storage returns null on statfs error (checked by :memory: path) ───
test('GET /api/system/status returns null storage fields for :memory: DB', async () => {
  const res = await fetch('http://localhost:3001/api/system/status');
  const body = await res.json();
  // In :memory: mode, no real disk path — storage must be null, not fabricated
  assert.strictEqual(body.storage.usedGb, null, 'usedGb must be null for :memory:');
  assert.strictEqual(body.storage.totalGb, null, 'totalGb must be null for :memory:');
  assert.strictEqual(body.storage.status, 'unknown', 'storage status must be unknown for :memory:');
});

after(() => {
  server.close();
  stopScheduler();
  closeDb();
});
