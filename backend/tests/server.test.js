const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH = ':memory:';
process.env.PORT = '3001';
const { initDb, saveSetting, getSetting, closeDb, getDb } = require('../db');
const { stopScheduler } = require('../scheduler');

initDb();
// Backup-Ziel auf ein Wegwerf-Verzeichnis: ohne das faellt resolveBackupDir bei
// DB_PATH=':memory:' auf <repo>/backups zurueck, und ein ueber POST /api/sync
// angestossener Zyklus legt das Verzeichnis im Arbeitsbaum an.
saveSetting('backup_dir', require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'srv-bkp-')));
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

// ── DELETE /api/stations/:id (destructive route, was untested) ────────────
test('DELETE /api/stations/:id removes the station and cascades its measurements and events', async () => {
  const db = getDb();
  db.prepare("INSERT INTO stations (id, name) VALUES ('deltest', 'Delete Me')").run();
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-del-1','deltest',1000,21.5,'temperature','°C')").run();
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-del-2','deltest',2000,22.0,'temperature','°C')").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, active) VALUES ('ev-del-1','deltest','alarm',1000,1)").run();

  // Vorbedingung: die Zeilen, deren Verschwinden wir gleich nachweisen, existieren wirklich.
  assert.strictEqual(db.prepare("SELECT count(*) c FROM measurements WHERE station_id = 'deltest'").get().c, 2);
  assert.strictEqual(db.prepare("SELECT count(*) c FROM events WHERE station_id = 'deltest'").get().c, 1);

  const res = await fetch('http://localhost:3001/api/stations/deltest', { method: 'DELETE' });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.success, true);

  assert.strictEqual(db.prepare("SELECT * FROM stations WHERE id = 'deltest'").get(), undefined, 'Station muss entfernt sein');
  assert.strictEqual(db.prepare("SELECT count(*) c FROM measurements WHERE station_id = 'deltest'").get().c, 0, 'Messwerte müssen kaskadiert gelöscht sein');
  assert.strictEqual(db.prepare("SELECT count(*) c FROM events WHERE station_id = 'deltest'").get().c, 0, 'Meldungen müssen kaskadiert gelöscht sein');
});

test('DELETE /api/stations/:id on a non-existent id returns 404 with an error message', async () => {
  const res = await fetch('http://localhost:3001/api/stations/does-not-exist', { method: 'DELETE' });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.ok(body.error, 'response must contain an error message');
});

test('DELETE /api/stations/:id does not cascade into another station\'s data', async () => {
  const db = getDb();
  db.prepare("INSERT INTO stations (id, name) VALUES ('delvictim', 'Delete Me Too')").run();
  db.prepare("INSERT INTO stations (id, name) VALUES ('delkeep', 'Keep Me')").run();
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-delv-1','delvictim',1000,20.0,'temperature','°C')").run();
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-keep-1','delkeep',1000,19.0,'temperature','°C')").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, active) VALUES ('ev-keep-1','delkeep','warning',1000,1)").run();

  const res = await fetch('http://localhost:3001/api/stations/delvictim', { method: 'DELETE' });
  assert.strictEqual(res.status, 200);

  assert.ok(db.prepare("SELECT * FROM stations WHERE id = 'delkeep'").get(), 'andere Station darf nicht verschwinden');
  assert.strictEqual(db.prepare("SELECT count(*) c FROM measurements WHERE station_id = 'delkeep'").get().c, 1, 'Messwerte der anderen Station bleiben erhalten');
  assert.strictEqual(db.prepare("SELECT count(*) c FROM events WHERE station_id = 'delkeep'").get().c, 1, 'Meldungen der anderen Station bleiben erhalten');
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

test('POST /api/settings accepts valid api_region eu', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_region: 'eu' })
  });
  assert.strictEqual(res.status, 200);
});

test('POST /api/settings accepts valid api_region am', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_region: 'am' })
  });
  assert.strictEqual(res.status, 200);
});

test('POST /api/settings accepts valid api_region ap', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_region: 'ap' })
  });
  assert.strictEqual(res.status, 200);
});

// testo Smart Connect regions are eu/am/ap only (testo-smart-connect-api/02-authentication.md);
// 'us' was offered in the UI but never a real region and is now rejected like any other value.
test('POST /api/settings rejects api_region us (not a real testo region)', async () => {
  const res = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_region: 'us' })
  });
  assert.strictEqual(res.status, 400);
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
// Placed last so a throw in the test-only route does not interfere with other tests.
// The route /api/_test/throw is only registered when NODE_ENV === 'test'.
test('Error middleware returns 500 JSON on thrown handler error', async () => {
  const res = await fetch('http://localhost:3001/api/_test/throw');
  assert.strictEqual(res.status, 500, 'error middleware must return HTTP 500');
  const ct = res.headers.get('content-type');
  assert.ok(ct && ct.includes('application/json'), 'error response must be JSON');
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0,
    'response body must have a non-empty error string');
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

// ── Update-Hinweis: Ordner als Einstellung, Ergebnis im Systemstatus ──────
test('GET /api/system/status carries the update check result; empty update_dir means disabled', async () => {
  saveSetting('update_dir', '');
  const res = await fetch('http://localhost:3001/api/system/status');
  const body = await res.json();
  assert.ok(body.hasOwnProperty('update'), 'response must include update');
  assert.strictEqual(body.update.enabled, false, 'no update_dir configured -> check disabled');
  assert.strictEqual(body.update.updateAvailable, false);
});

test('POST /api/settings stores update_dir and re-runs the check without a restart', async () => {
  const os = require('node:os'), fsx = require('node:fs'), pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'updsrv-'));
  fsx.writeFileSync(pathx.join(dir, 'testo-smart-abruf-99.0.0-win-x64.zip'), 'PKstub');

  const post = await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_dir: dir })
  });
  assert.strictEqual(post.status, 200);
  assert.strictEqual((await (await fetch('http://localhost:3001/api/settings')).json()).update_dir, dir);

  // runUpdateCheck läuft asynchron an — kurz auf das Ergebnis warten.
  let body;
  for (let i = 0; i < 20; i++) {
    body = await (await fetch('http://localhost:3001/api/system/status')).json();
    if (body.update.updateAvailable) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.strictEqual(body.update.enabled, true);
  assert.strictEqual(body.update.updateAvailable, true, 'newer zip in the folder must be reported');
  assert.strictEqual(body.update.latestVersion, '99.0.0');

  saveSetting('update_dir', '');
  fsx.rmSync(dir, { recursive: true, force: true });
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

// ── #10: GET /api/system/status exposes limit-configuration conflicts ─────
test('GET /api/system/status reports conflicting limit metrics from limits_conflict', async () => {
  saveSetting('limits_conflict', JSON.stringify({ metrics: ['temperature'], updatedAt: '2026-01-01T00:00:00.000Z' }));
  const res = await fetch('http://localhost:3001/api/system/status');
  const body = await res.json();
  assert.ok(body.hasOwnProperty('limitsConflict'), 'response must include limitsConflict');
  assert.deepStrictEqual(body.limitsConflict.metrics, ['temperature']);
  assert.strictEqual(body.limitsConflict.updatedAt, '2026-01-01T00:00:00.000Z');
});

test('GET /api/system/status reports an empty limitsConflict once resolved', async () => {
  saveSetting('limits_conflict', JSON.stringify({ metrics: [], updatedAt: '2026-01-02T00:00:00.000Z' }));
  const res = await fetch('http://localhost:3001/api/system/status');
  const body = await res.json();
  assert.deepStrictEqual(body.limitsConflict.metrics, [], 'resolved conflict must report an empty metrics list');
});

// ── B4: GET /api/limits ────────────────────────────────────────────────────
test('GET /api/limits returns empty array when no limits have been synced', async () => {
  const res = await fetch('http://localhost:3001/api/limits');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body), 'response must be a bare array');
  assert.strictEqual(body.length, 0, 'no limits synced yet — array must be empty');
});

test('GET /api/limits returns stored limit rows with correct camelCase fields', async () => {
  const db = getDb();
  const now = Date.now();
  // Insert two representative rows directly (the scheduler normally writes these)
  db.prepare(`INSERT OR REPLACE INTO limits (metric, direction, severity, limit_value, hysteresis, delay_ms, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('temperature', 'high', 'alarm', 28, 0, 600000, '°C', now);
  db.prepare(`INSERT OR REPLACE INTO limits (metric, direction, severity, limit_value, hysteresis, delay_ms, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('humidity', 'low', 'warning', 35, 0, 600000, '%rF', now);

  const res = await fetch('http://localhost:3001/api/limits');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body), 'response must be a bare array');

  const tempLimit = body.find(l => l.metric === 'temperature' && l.direction === 'high' && l.severity === 'alarm');
  assert.ok(tempLimit, 'temperature:high:alarm limit must be present');
  assert.strictEqual(tempLimit.limitValue, 28);
  assert.strictEqual(tempLimit.unit, '°C');
  assert.strictEqual(tempLimit.delayMs, 600000);
  assert.strictEqual(tempLimit.hysteresis, 0);
  assert.strictEqual(typeof tempLimit.updatedAt, 'number', 'updatedAt must be a number (ms epoch)');

  const humLimit = body.find(l => l.metric === 'humidity' && l.direction === 'low' && l.severity === 'warning');
  assert.ok(humLimit, 'humidity:low:warning limit must be present');
  assert.strictEqual(humLimit.limitValue, 35);
  assert.strictEqual(humLimit.unit, '%rF');
});

test('POST /api/sync startet einen Sync und respektiert den laufenden-Sync-Guard', async () => {
  saveSetting('api_key', 'mock-api-key');
  saveSetting('api_region', 'eu');

  // Vorbedingung: sicherstellen, dass kein Sync mehr läuft.
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch('http://localhost:3001/api/system/status')).json();
    if (!s.scheduler.isSyncing) break;
    await new Promise(r => setTimeout(r, 20));
  }

  // Zwei gleichzeitige Aufrufe: höchstens einer darf den Sync starten, ein
  // zweiter muss am isSyncing-Guard scheitern. Statt nur die Objektform zu
  // prüfen, verifizieren wir den Vertrag JEDES Zweigs:
  //   started === true  -> 202
  //   started === false -> 200 + reason 'already-running'
  const [r1, r2] = await Promise.all([
    fetch('http://localhost:3001/api/sync', { method: 'POST' }),
    fetch('http://localhost:3001/api/sync', { method: 'POST' }),
  ]);
  const [b1, b2] = await Promise.all([r1.json(), r2.json()]);

  for (const [res, body] of [[r1, b1], [r2, b2]]) {
    assert.strictEqual(typeof body.started, 'boolean');
    if (body.started === true) {
      assert.strictEqual(res.status, 202);
    } else {
      assert.strictEqual(body.started, false);
      assert.strictEqual(body.reason, 'already-running');
      assert.strictEqual(res.status, 200);
    }
  }

  // Vor Testende auf Ruhezustand warten, damit after()/closeDb() nicht gegen
  // einen noch laufenden fire-and-forget-Sync läuft.
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch('http://localhost:3001/api/system/status')).json();
    if (!s.scheduler.isSyncing) break;
    await new Promise(r => setTimeout(r, 20));
  }
});

test('GET /api/stations/:id/events supports limit, active and compound (start_ts,rowid) cursor', async () => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id, name) VALUES ('evpag', 'Pagination Test')").run();
  db.prepare("DELETE FROM events WHERE station_id = 'evpag'").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-act','evpag','alarm',400,420,1)").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-r3','evpag','warning',300,350,0)").run();
  // two resolved events that SHARE start_ts=200 (realistic tie); e-r2a inserted first => lower rowid
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-r2a','evpag','warning',200,250,0)").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-r2b','evpag','alarm',200,250,0)").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-r1','evpag','warning',100,150,0)").run();

  const base = 'http://localhost:3001/api/stations/evpag/events';
  const ids = (arr) => arr.map((e) => e.uuid);

  // no params => all 5; active first, then start_ts desc, then rowid desc (e-r2b before e-r2a)
  assert.deepStrictEqual(ids(await (await fetch(base)).json()), ['e-act', 'e-r3', 'e-r2b', 'e-r2a', 'e-r1']);
  // active=1 => only active
  assert.deepStrictEqual(ids(await (await fetch(base + '?active=1')).json()), ['e-act']);
  // active=0 => only resolved, newest first; rowid breaks the start_ts=200 tie
  assert.deepStrictEqual(ids(await (await fetch(base + '?active=0')).json()), ['e-r3', 'e-r2b', 'e-r2a', 'e-r1']);
  // rowid is exposed in the payload for the cursor
  const first = (await (await fetch(base + '?active=0&limit=1')).json())[0];
  assert.strictEqual(first.uuid, 'e-r3');
  assert.ok(Number.isInteger(first._rowid));

  // walk the compound cursor at limit=1 — MUST NOT skip the start_ts=200 tie
  const collected = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    let url = base + '?active=0&limit=1';
    if (cursor) url += `&before_ts=${cursor.start_ts}&before_rowid=${cursor._rowid}`;
    const page = await (await fetch(url)).json();
    if (page.length === 0) break;
    collected.push(page[0].uuid);
    cursor = { start_ts: page[0].start_ts, _rowid: page[0]._rowid };
  }
  assert.deepStrictEqual(collected, ['e-r3', 'e-r2b', 'e-r2a', 'e-r1']); // both start_ts=200 rows present

  // invalid params ignored => same as no params
  assert.deepStrictEqual(ids(await (await fetch(base + '?limit=abc&before_ts=xyz&active=2')).json()), ['e-act', 'e-r3', 'e-r2b', 'e-r2a', 'e-r1']);
  // before_ts beyond all data => empty
  assert.deepStrictEqual(await (await fetch(base + '?active=0&before_ts=100')).json(), []);
});

test('GET /api/stations/:id/events hides recovery (Ok) rows, keeps Alarm and sys-* rows', async () => {
  const db = getDb();
  db.prepare("INSERT INTO stations (id, name) VALUES ('evfilt','EvFilt')").run();
  const t = Date.now() - 3600000;
  db.prepare("INSERT INTO events (uuid, station_id, severity, alarm_status, start_ts, active) VALUES ('ev-alarm','evfilt','warning','Alarm',?,0)").run(t);
  db.prepare("INSERT INTO events (uuid, station_id, severity, alarm_status, start_ts, active) VALUES ('ev-ok','evfilt','warning','Ok',?,0)").run(t + 60000);
  db.prepare("INSERT INTO events (uuid, station_id, severity, alarm_status, start_ts, active) VALUES ('ev-sys','evfilt','system',NULL,?,0)").run(t + 120000);

  const res = await fetch('http://localhost:3001/api/stations/evfilt/events?active=0');
  assert.strictEqual(res.status, 200);
  const uuids = (await res.json()).map(e => e.uuid);
  assert.ok(uuids.includes('ev-alarm'), 'violation rows are shown');
  assert.ok(uuids.includes('ev-sys'), 'self-derived sys-* rows are shown');
  assert.ok(!uuids.includes('ev-ok'), 'recovery (Ok) rows are hidden');
});

// ── Export endpoints (Task 8) ────────────────────────────────────────────────
// Seed station s1 with temperature + humidity measurements for export tests
{
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id, name) VALUES ('s1', 'S')").run();
  db.prepare("INSERT OR IGNORE INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-exp-t','s1',1000,21.5,'temperature','°C')").run();
  db.prepare("INSERT OR IGNORE INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-exp-h','s1',1000,55.0,'humidity','%rF')").run();
}

test('GET /api/export/metadata returns a stations array', async () => {
  const res = await fetch('http://localhost:3001/api/export/metadata');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test('POST /api/export single station returns text/csv attachment', async () => {
  const res = await fetch('http://localhost:3001/api/export', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stationIds: ['s1'], metrics: null, from: 0, to: 9e15, includeEvents: false }),
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition') || '', /attachment/);
});

test('POST /api/export metrics filter limits the columns', async () => {
  // Re-seed in case an earlier test wiped the measurements table
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-exp-t','s1',1000,21.5,'temperature','°C')").run();
  db.prepare("INSERT OR IGNORE INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m-exp-h','s1',1000,55.0,'humidity','%rF')").run();
  const res = await fetch('http://localhost:3001/api/export', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stationIds: ['s1'], metrics: ['temperature'], from: 0, to: 9e15, includeEvents: false }),
  });
  const text = await res.text();
  assert.ok(text.includes('Temperatur [°C]'));
  assert.ok(!text.includes('Feuchte [%rF]'));
});

test('POST /api/export empty stationIds => 400', async () => {
  const res = await fetch('http://localhost:3001/api/export', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stationIds: [], from: 0, to: 1 }),
  });
  assert.strictEqual(res.status, 400);
});

test('settings round-trip persists backup keys (stored as 0/1 strings)', async () => {
  await fetch('http://localhost:3001/api/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csv_format: 'rfc', backup_enabled: false }),
  });
  const get = await (await fetch('http://localhost:3001/api/settings')).json();
  assert.strictEqual(get.csv_format, 'rfc');
  assert.strictEqual(get.backup_enabled, false);
  const { getSetting: gs } = require('../db');
  assert.strictEqual(gs('backup_enabled'), '0'); // stored '0', not 'false'
});

test('POST /api/settings: string "false" backup_enabled stored as 0', async () => {
  await fetch('http://localhost:3001/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backup_enabled: 'false' }) });
  const { getSetting } = require('../db');
  assert.strictEqual(getSetting('backup_enabled'), '0');
});

test('POST /api/settings: invalid csv_format => 400', async () => {
  const res = await fetch('http://localhost:3001/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv_format: 'xml' }) });
  assert.strictEqual(res.status, 400);
});

test('POST /api/export: from > to => 400', async () => {
  const res = await fetch('http://localhost:3001/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stationIds: ['s1'], from: 100, to: 1 }) });
  assert.strictEqual(res.status, 400);
});

// ── Log-Flut: identische Route-Fehler dürfen app.log nicht linear aufblähen ──
// Der Dienst läuft monatelang durch, app.log wird nur beim Dienststart rotiert.
// Das Dashboard pollt alle 5 s (3 + 2×Messstellen Requests) — eine dauerhaft
// werfende Route ergab pro Vorkommnis einen vollen Stacktrace (~0,5-1 KB).
test('Error middleware logs a stack once per signature, not per occurrence', async () => {
  const { format } = require('node:util');
  const STACK_FRAME = /\n\s+at /; // echter Stackframe, nicht die Zählzeile
  const captured = [];
  const origError = console.error;
  console.error = (...args) => { captured.push(format(...args)); };
  try {
    for (let i = 0; i < 12; i++) {
      const res = await fetch('http://localhost:3001/api/_test/throw?msg=flood-a');
      assert.strictEqual(res.status, 500, 'Antwort an den Client bleibt 500');
      assert.strictEqual((await res.json()).error, 'flood-a', 'Antwortkörper bleibt unverändert');
    }
    const resB = await fetch('http://localhost:3001/api/_test/throw?msg=flood-b');
    await resB.json();
  } finally {
    console.error = origError;
  }

  const a = captured.filter((l) => l.includes('flood-a'));
  const aStacks = a.filter((l) => STACK_FRAME.test(l));
  assert.strictEqual(aStacks.length, 1,
    `Stacktrace nur beim ersten Auftreten erwartet, geloggt: ${aStacks.length}`);
  const aBytes = a.join('\n').length;
  assert.ok(aBytes < aStacks[0].length * 2,
    `Log darf mit den Wiederholungen nicht linear mitwachsen (${a.length} Zeilen, ${aBytes} Bytes)`);

  const bStacks = captured.filter((l) => l.includes('flood-b') && STACK_FRAME.test(l));
  assert.strictEqual(bStacks.length, 1,
    'ein anderer Fehler muss trotzdem seinen eigenen Stacktrace bekommen');
});

// ── Startup migration: legacy stored api_region self-heals to eu ──────────
// This file requires ../server exactly once, at module load (top of this file) — a value
// seeded into ITS database after that point can never reach the migration in server.js,
// it already ran. The only way to exercise it is a fresh process: seed a throwaway DB with
// the no-longer-valid 'us', boot backend/server.js as a child process against that
// DB_PATH, and check the row once the migration has had a chance to run. PORT=0 lets the
// OS pick a free port so this can never collide with the 3001 this file itself binds.
test('server.js startup: invalid stored api_region (legacy "us") is reset to eu', async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Database = require('better-sqlite3');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testo-region-'));
  const dbPath = path.join(tmpDir, 'klima.db');

  // Seed a throwaway DB mimicking an existing install stuck on the retired 'us' region.
  const seedDb = new Database(dbPath);
  seedDb.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
  seedDb.prepare("INSERT INTO settings (key, value) VALUES ('api_region', 'us')").run();
  seedDb.close();

  const childEnv = { ...process.env, DB_PATH: dbPath, PORT: '0' };
  delete childEnv._KLIMA_SHUTDOWN_REGISTERED; // let the child register its own graceful shutdown

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: childEnv });

  let stdout = '', stderr = '';
  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await Promise.race([
      new Promise((resolve) => {
        const check = () => { if (/running on http/.test(stdout)) resolve(); };
        child.stdout.on('data', check);
        check();
      }),
      exitPromise.then(({ code, signal }) => {
        throw new Error(`Server-Kindprozess beendete sich vorzeitig (code=${code}, signal=${signal}).\nstdout=${stdout}\nstderr=${stderr}`);
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Timeout beim Warten auf Serverstart.\nstdout=${stdout}\nstderr=${stderr}`)), 8000)),
    ]);
  } finally {
    if (!exited) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 3000);
      await exitPromise;
      clearTimeout(killTimer);
    }
  }

  const checkDb = new Database(dbPath, { readonly: true });
  const row = checkDb.prepare("SELECT value FROM settings WHERE key = 'api_region'").get();
  checkDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.strictEqual(row.value, 'eu', 'ungültig gespeicherte Region muss beim Start auf eu zurückgesetzt werden');
});

after(() => {
  server.close();
  stopScheduler();
  closeDb();
});
