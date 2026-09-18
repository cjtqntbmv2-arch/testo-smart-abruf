const { test, after } = require('node:test');
const assert = require('node:assert');

// Keine Anfrage an die testo-Cloud. Jedes gespeicherte Setting startet den Scheduler neu, und
// dessen Sofortlauf fragte mit den Wegwerf-Schlüsseln dieser Datei ('preserved-key', 'new-key')
// die echte Cloud an: vier 401 je Lauf, auch in der CI. Alles außer dem eigenen Server bekommt
// jetzt sofort eine 401 — derselbe Fehlerweg wie bisher, nur ohne Netz. Ablehnen statt antworten
// löste die Wiederholungen samt Wartezeit in _fetchWithRetry aus.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => String(url).startsWith('http://localhost:3001/')
  ? realFetch(url, opts)
  : Promise.resolve(new Response('{"message":"Test-Stub: keine Cloud im Test"}', { status: 401 }));
// Was trotzdem hinausginge, zählt undici unterhalb von fetch; der letzte Test verlangt die Liste
// leer. So fiele auch ein umgangener Stub auf. localRequests belegt, dass der Zähler überhaupt
// etwas sieht; ohne das bestünde der Test auch unter einem Node, das den Kanal nicht meldet.
let localRequests = 0;
const cloudRequests = [];
require('node:diagnostics_channel').subscribe('undici:request:create', ({ request }) => {
  if (request.origin === 'http://localhost:3001') localRequests++;
  else cloudRequests.push(`${request.method} ${request.origin}${request.path}`);
});

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

// ── Aufgabe 7 (V28): ein Gerät gehört zu höchstens einer Messstelle ───────
// Vorher speicherte die API eine zweite Messstelle auf derselben device_uuid; der Scheduler
// schrieb die echten Daten dann unter nur eine, und das Löschen der anderen nahm sie per Kaskade mit.
const postStation = (body) => fetch('http://localhost:3001/api/stations', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const uuidOf = (id) => getDb().prepare('SELECT device_uuid FROM stations WHERE id = ?').get(id)?.device_uuid;

test('POST /api/stations: device_uuid einer anderen Messstelle → 409 mit deren Name und ID, nichts gespeichert; Umbenennen mit eigener UUID bleibt erlaubt', async () => {
  saveSetting('api_key', ''); // kein Hintergrund-Sync
  const db = getDb();
  try {
    assert.strictEqual((await postStation({ id: 'a7-besitz', name: 'Besitzer', device_uuid: 'dev-a7' })).status, 200);

    for (const uuid of ['dev-a7', '  dev-a7\t']) { // getrimmt verglichen
      const res = await postStation({ id: 'a7-zweit', name: 'Zweite', device_uuid: uuid });
      const body = await res.json();
      assert.strictEqual(res.status, 409, `${JSON.stringify(uuid)}: ${JSON.stringify(body)}`);
      assert.match(body.error, /„Besitzer“ \(a7-besitz\)/, body.error);
      assert.match(body.error, /dev-a7/, body.error);
    }
    assert.strictEqual(db.prepare("SELECT count(*) c FROM stations WHERE id = 'a7-zweit'").get().c, 0, 'nichts gespeichert');

    // Umbenennen = dieselbe Messstelle mit ihrer eigenen UUID erneut speichern.
    assert.strictEqual((await postStation({ id: 'a7-besitz', name: 'Umbenannt', device_uuid: 'dev-a7' })).status, 200);
    assert.strictEqual(db.prepare("SELECT name FROM stations WHERE id = 'a7-besitz'").get().name, 'Umbenannt');

    // Eine bestehende Messstelle auf ein vergebenes Gerät umstellen: ebenfalls 409, ihre Zuordnung bleibt.
    assert.strictEqual((await postStation({ id: 'a7-andere', name: 'Andere', device_uuid: 'dev-a7-b' })).status, 200);
    const res = await postStation({ id: 'a7-andere', name: 'Andere', device_uuid: 'dev-a7' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(uuidOf('a7-andere'), 'dev-a7-b');
  } finally {
    db.prepare("DELETE FROM stations WHERE id LIKE 'a7-%'").run();
  }
});

test('POST /api/stations: "kein Gerät" ("", nur Leerzeichen, null, fehlend) wird NULL und ist beliebig oft erlaubt; UUID getrimmt; kein Text → 400', async () => {
  saveSetting('api_key', '');
  const db = getDb();
  try {
    for (const [id, uuid] of [['a7-leer1', ''], ['a7-leer2', ''], ['a7-blank', ' \t '], ['a7-null', null], ['a7-ohne', undefined]]) {
      const res = await postStation({ id, name: id, device_uuid: uuid });
      assert.strictEqual(res.status, 200, `${id}: ${await res.text()}`);
      assert.strictEqual(uuidOf(id), null, `${id}: als NULL gespeichert`);
    }
    assert.strictEqual((await postStation({ id: 'a7-trim', name: 'Trim', device_uuid: '  dev-a7-trim \n' })).status, 200);
    assert.strictEqual(uuidOf('a7-trim'), 'dev-a7-trim');

    for (const bad of [123, true, {}, ['dev-a7-trim']]) {
      const res = await postStation({ id: 'a7-typ', name: 'Typ', device_uuid: bad });
      const body = await res.json();
      assert.strictEqual(res.status, 400, `${JSON.stringify(bad)}: ${res.status} ${JSON.stringify(body)}`);
      assert.match(body.error, /device_uuid/);
    }
    assert.strictEqual(uuidOf('a7-typ'), undefined, 'nichts gespeichert');
  } finally {
    db.prepare("DELETE FROM stations WHERE id LIKE 'a7-%'").run();
  }
});

test('POST /api/stations: greift der UNIQUE-Index trotz Vorprüfung, antwortet die API mit derselben 409 statt 500', async () => {
  saveSetting('api_key', '');
  const db = getDb();
  db.prepare("INSERT INTO stations (id, name) VALUES ('a7-rivale', 'Rivale')").run();
  // Ein Schreiber, der zwischen Vorprüfung und Speichern dieselbe UUID vergibt. Im Betrieb nur
  // über eine zweite Verbindung denkbar; hier stellt ein Temp-Trigger das nach.
  db.exec(`CREATE TEMP TRIGGER a7_rennen BEFORE INSERT ON stations WHEN NEW.id = 'a7-spaet'
           BEGIN UPDATE stations SET device_uuid = NEW.device_uuid WHERE id = 'a7-rivale'; END`);
  try {
    const res = await postStation({ id: 'a7-spaet', name: 'Später', device_uuid: 'dev-a7-rennen' });
    const body = await res.json();
    assert.strictEqual(res.status, 409, JSON.stringify(body));
    assert.match(body.error, /Das Gerät dev-a7-rennen ist bereits .* zugewiesen/, body.error);
    assert.strictEqual(uuidOf('a7-spaet'), undefined, 'nichts gespeichert');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS temp.a7_rennen');
    db.prepare("DELETE FROM stations WHERE id LIKE 'a7-%'").run();
  }
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

// ── #16: GET /api/system/status surfaces whether the dashboard is currently showing
// fabricated mock data. Must mirror TestoClient._mockModeActive() exactly: the stored
// api_key must be the literal 'mock-api-key' AND (NODE_ENV==='test' OR TESTO_MOCK==='1').
// This suite itself runs under NODE_ENV=test (see top of file), which alone satisfies the
// second half of that condition once the key matches -- so testing the TESTO_MOCK/api_key
// interaction the way it actually behaves in a real deployment (env.example tells operators
// never to set NODE_ENV there) requires pinning process.env.NODE_ENV to a non-test value for
// the duration of the assertions below. try/finally restores every env var and the stored
// api_key so later tests are not poisoned.
test('GET /api/system/status reports mockActive only when both the mock key and the opt-in env var are set', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestoMock = process.env.TESTO_MOCK;
  const originalApiKey = getSetting('api_key');
  try {
    process.env.NODE_ENV = 'production'; // field-like: a real deployment never sets NODE_ENV=test

    // Neither condition: real key, no opt-in -> inactive
    delete process.env.TESTO_MOCK;
    saveSetting('api_key', 'a-real-testo-key');
    let body = await (await fetch('http://localhost:3001/api/system/status')).json();
    assert.strictEqual(body.api.mockActive, false, 'real key + no opt-in must not report mock');

    // Only the env var set, key does not match -> inactive
    process.env.TESTO_MOCK = '1';
    body = await (await fetch('http://localhost:3001/api/system/status')).json();
    assert.strictEqual(body.api.mockActive, false, 'TESTO_MOCK=1 alone with a non-mock key must not report mock');

    // Only the key matches, opt-in not set -> inactive
    delete process.env.TESTO_MOCK;
    saveSetting('api_key', 'mock-api-key');
    body = await (await fetch('http://localhost:3001/api/system/status')).json();
    assert.strictEqual(body.api.mockActive, false, 'mock key alone without TESTO_MOCK must not report mock');

    // Both conditions -> active. This is the "accidentally left on in production" case.
    process.env.TESTO_MOCK = '1';
    body = await (await fetch('http://localhost:3001/api/system/status')).json();
    assert.strictEqual(body.api.mockActive, true, 'mock key + TESTO_MOCK=1 must report mock active');
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
    if (originalTestoMock === undefined) delete process.env.TESTO_MOCK; else process.env.TESTO_MOCK = originalTestoMock;
    saveSetting('api_key', originalApiKey || '');
  }
});

// Documents the NODE_ENV=test shortcut itself (the branch that lets mock mode work during
// automated runs / local dev without a real key, see testo-client.js) so a future change to
// that branch fails a test instead of only surfacing as a silently wrong dashboard banner.
test('GET /api/system/status reports mockActive under the ambient NODE_ENV=test shortcut once the mock key is stored', async () => {
  const originalApiKey = getSetting('api_key');
  try {
    assert.strictEqual(process.env.NODE_ENV, 'test', 'this test only makes sense while the suite runs under NODE_ENV=test');
    saveSetting('api_key', 'mock-api-key');
    const body = await (await fetch('http://localhost:3001/api/system/status')).json();
    assert.strictEqual(body.api.mockActive, true, 'NODE_ENV=test + mock key must report mock active, matching _mockModeActive()');
  } finally {
    saveSetting('api_key', originalApiKey || '');
  }
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

// ── Aufgabe 5: Eingabeprüfung POST /api/settings (V4, V15, V21, V22, C2, C15) ──
// Jede Ablehnung ist ein 400 mit Klartext, der das Feld unverändert lässt. api_key bleibt
// leer, wo gespeichert wird: der dadurch angestoßene Zyklus bricht dann sofort ab und
// erreicht keine Cloud.
const postSettings = (body, raw) => fetch('http://localhost:3001/api/settings', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body),
});
async function expect400(body, field, pattern) {
  const before = getSetting(field);
  const res = await postSettings(body);
  const json = await res.json();
  assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${JSON.stringify(json)}`);
  assert.match(json.error, pattern);
  assert.strictEqual(getSetting(field), before, `${JSON.stringify(body)} darf ${field} nicht ändern`);
}
async function waitSchedulerIdle() {
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch('http://localhost:3001/api/system/status')).json();
    if (!s.scheduler.isSyncing) return;
    await new Promise(r => setTimeout(r, 20));
  }
}
// Leerer api_key für die Testdauer, danach die angefassten Einstellungen zurück und den
// Scheduler angehalten — auch wenn der Test scheitert. Sonst schlüge eine Regression in
// fremde Tests durch: ein übernommenes 999999999 s liefe als 1-ms-Takt weiter, ein
// übernommenes retention_days prunte deren Fixtures.
async function withSettings(keys, fn) {
  const saved = ['api_key', ...keys].map((k) => [k, getSetting(k)]);
  saveSetting('api_key', '');
  try { await fn(); } finally {
    await waitSchedulerIdle();
    stopScheduler();
    for (const [k, v] of saved) saveSetting(k, v ?? '');
  }
}

test('POST /api/settings: poll_interval_sec nur als ganze Zahl von 60 bis 3600', () => withSettings(['poll_interval_sec'], async () => {
  saveSetting('poll_interval_sec', '900');
  // 999999999 s lief als setInterval-Überlauf auf 1 ms: ein Anfragesturm gegen die Cloud.
  for (const v of [999999999, 3601, 59, 1.5, '900abc', '', null, true]) {
    await expect400({ poll_interval_sec: v }, 'poll_interval_sec', /60 bis 3600/);
  }
  for (const [v, stored] of [[60, '60'], [3600, '3600'], ['3600', '3600']]) {
    const res = await postSettings({ poll_interval_sec: v });
    assert.strictEqual(res.status, 200, JSON.stringify(v));
    assert.strictEqual(getSetting('poll_interval_sec'), stored);
  }
}));

test('POST /api/settings: retention_days ohne Teilparse, 1e21 wird nicht zu 1 Tag', () => withSettings(['retention_days'], async () => {
  saveSetting('retention_days', '365');
  // parseInt(1e21) liest "1e+21" als 1: aus riesigen Aufbewahrungstagen wurde 1 Tag.
  for (const v of ['30abc', 1.5, 0, -5, 1e21, '99999999999999999999', '', null]) {
    await expect400({ retention_days: v }, 'retention_days', /ganze Zahl von 1 bis 3650/);
  }
  const res = await postSettings({ retention_days: '730' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(getSetting('retention_days'), '730');
}));

// Ohne Obergrenze lief candidateMonths() (backup-runner.js) für ein riesiges retention_days
// synchron über Millionen Monate: der Dienst stand. Das Dashboard bietet 30 bis 730 Tage an.
test('POST /api/settings: retention_days höchstens 3650 Tage', () => withSettings(['retention_days'], async () => {
  saveSetting('retention_days', '365');
  for (const v of [3651, '3651', 100000, Number.MAX_SAFE_INTEGER]) {
    await expect400({ retention_days: v }, 'retention_days', /ganze Zahl von 1 bis 3650/);
  }
  for (const v of [3650, '3650']) {
    const res = await postSettings({ retention_days: v });
    assert.strictEqual(res.status, 200, JSON.stringify(v));
    assert.strictEqual(getSetting('retention_days'), '3650');
  }
}));

test('POST /api/settings: api_key nur als Text, getrimmt; nur Leerzeichen, null oder Zahl -> 400', () => withSettings([], async () => {
  saveSetting('api_key', 'bisheriger-schluessel');
  for (const v of ['   ', '\t\n', null, 12345, true]) {
    await expect400({ api_key: v }, 'api_key', /API-Schlüssel/);
  }
  // Getrimmt gespeichert. Erst getrimmt ist es der Mock-Schlüssel: der angestoßene Zyklus
  // läuft im Mock-Modus (NODE_ENV=test) und erreicht keine Cloud.
  const res = await postSettings({ api_key: '  mock-api-key \n' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(getSetting('api_key'), 'mock-api-key');
}));

test('POST mit kaputtem JSON: 400 mit allgemeiner Meldung an allen POST-Endpunkten, keine Parser-Interna', () => withSettings([], async () => {
  for (const p of ['/api/settings', '/api/export', '/api/stations', '/api/sync', '/api/backup']) {
    const res = await fetch(`http://localhost:3001${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"poll_interval_sec": 60,',
    });
    const body = await res.json();
    assert.strictEqual(res.status, 400, `${p}: ${res.status} ${JSON.stringify(body)}`);
    assert.strictEqual(body.error, 'Ungültige Anfrage: Der Inhalt ist kein gültiges JSON.');
  }
}));

test('POST /api/settings ohne bekanntes Feld: 400 und kein Scheduler-Neustart', () => withSettings([], async () => {
  const { format } = require('node:util');
  for (const raw of ['{}', '{"unbekannt":1}', '[]']) {
    const lines = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(format(...a));
    let res, body;
    try {
      res = await postSettings(null, raw);
      body = await res.json();
    } finally { Object.assign(console, orig); }
    assert.strictEqual(res.status, 400, `${raw}: ${JSON.stringify(body)}`);
    assert.match(body.error, /Keine bekannte Einstellung/);
    assert.ok(!lines.some((l) => l.includes('Scheduler started')), `${raw} darf den Scheduler nicht neu starten:\n${lines.join('\n')}`);
  }
}));

test('POST /api/settings: backup_enabled nur true/false, 1/0, "1"/"0", "true"/"false"', () => withSettings(['backup_enabled'], async () => {
  for (const [v, stored] of [[true, '1'], [1, '1'], ['1', '1'], ['true', '1'], [false, '0'], [0, '0'], ['0', '0'], ['false', '0']]) {
    saveSetting('backup_enabled', stored === '1' ? '0' : '1');
    const res = await postSettings({ backup_enabled: v });
    assert.strictEqual(res.status, 200, JSON.stringify(v));
    assert.strictEqual(getSetting('backup_enabled'), stored, JSON.stringify(v));
  }
  for (const v of [null, 123, 2, 'nein', 'yes', '']) {
    await expect400({ backup_enabled: v }, 'backup_enabled', /backup_enabled/);
  }
}));

test('POST /api/settings: backup_dir/update_dir erst typgeprüft, relativer backup_dir -> 400, kein Ordner', () => withSettings(['backup_dir', 'update_dir'], async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-cwd-'));
  process.chdir(tmp); // fiele die Prüfung zurück, entstünde ./12345 hier und nicht im Repo
  try {
    for (const v of [12345, null, true, { pfad: 'D:\\Sicherung' }]) {
      await expect400({ backup_dir: v }, 'backup_dir', /backup_dir/);
    }
    // Relativ hieße: relativ zum Arbeitsverzeichnis des Dienstes (fremd, oft C:\Windows\system32).
    await expect400({ backup_dir: '12345' }, 'backup_dir', /absolut/);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], 'es darf kein Ordner angelegt werden');
    for (const v of [12345, null]) {
      await expect400({ update_dir: v }, 'update_dir', /update_dir/);
    }

    // Gültiges bleibt gültig: ein absoluter Pfad wird angelegt, leer heißt Standardordner.
    const target = path.join(tmp, 'neu', 'sicherung');
    let res = await postSettings({ backup_dir: target });
    assert.strictEqual(res.status, 200);
    assert.ok(fs.statSync(target).isDirectory());
    res = await postSettings({ backup_dir: '  ' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(getSetting('backup_dir'), '');
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}));

// Update-Weg: relativ hieße relativ zum Arbeitsverzeichnis des Dienstes. Kein Speicherweg des
// Dashboards schickt update_dir zusammen mit anderen Feldern, die Regel blockiert also kein
// anderes Speichern. path.win32.isAbsolute nimmt UNC, D:\… und die POSIX-Pfade der Tests an.
test('POST /api/settings: update_dir nur leer oder absolut; relativ -> 400 mit Beispiel, UNC wird angenommen', () => withSettings(['update_dir'], async () => {
  saveSetting('update_dir', '');
  for (const v of ['Updates', 'relativ\\ordner', '.\\ablage', 'C:ablage']) {
    await expect400({ update_dir: v }, 'update_dir',
      /absolut.*\\\\fileserver\\Software\\TestoSmartAbruf.*leer = Prüfung aus/);
  }
  for (const v of ['\\\\srv\\freigabe', '  \\\\srv\\freigabe\\Klima  ', 'D:\\Ablage', '']) {
    const res = await postSettings({ update_dir: v });
    assert.strictEqual(res.status, 200, `${JSON.stringify(v)} -> ${res.status}`);
    assert.strictEqual(getSetting('update_dir'), v.trim());
  }
}));

test('POST /api/settings: ein ungültiges Feld lässt auch die gültigen ungespeichert', () => withSettings(['poll_interval_sec', 'backup_enabled'], async () => {
  saveSetting('poll_interval_sec', '900');
  await expect400({ poll_interval_sec: 120, csv_format: 'xml' }, 'poll_interval_sec', /csv_format/);
  await expect400({ backup_enabled: false, retention_days: 'x' }, 'backup_enabled', /retention_days/);
}));

// Das Dashboard schickt das geladene Intervall bei jedem automatischen Speichern mit. Meldete
// GET einen Wert außerhalb 60-3600 (direkt in der DB, POLL_INTERVAL_SEC beim Erststart),
// scheiterte jedes Speichern der Seite am neuen 400 — wie früher an der Region 'us'.
test('GET /api/settings meldet das wirksame Intervall, auch wenn die DB einen Wert außerhalb 60-3600 hält', () => withSettings(['poll_interval_sec'], async () => {
  for (const [stored, effective] of [['999999999', 3600], ['5', 60], ['900', 900]]) {
    saveSetting('poll_interval_sec', stored);
    const body = await (await fetch('http://localhost:3001/api/settings')).json();
    assert.strictEqual(body.poll_interval_sec, effective, `gespeichert ${stored}`);
  }
}));

// Ebenso die Aufbewahrung: ein Wert außerhalb 1-3650 in der DB (direkt geschrieben,
// RETENTION_DAYS beim Erststart, vor der Obergrenze per API gesetzt) ließe sonst jedes
// Speichern am 400 scheitern. SQLite speichert eine direkt geschriebene Zahl 1e21 als Text
// "1.0e+21" — parseInt las das als 1 Tag.
test('GET /api/settings meldet die wirksame Aufbewahrung, auch wenn die DB einen Wert außerhalb 1-3650 hält', () => withSettings(['retention_days'], async () => {
  for (const [stored, effective] of [['100000', 3650], ['1.0e+21', 3650], ['0', 365], ['-5', 365], ['abc', 365], ['730', 730]]) {
    saveSetting('retention_days', stored);
    const body = await (await fetch('http://localhost:3001/api/settings')).json();
    assert.strictEqual(body.retention_days, effective, `gespeichert ${stored}`);
  }
}));

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

// ── „Jetzt sichern": POST /api/backup ────────────────────────────────────
// Sofortlauf (ZIPs + Datenbank-Abzug) an der Tagesdrossel vorbei; genau eine Logzeile.
// api_key leer und Leerlauf abwarten: kein Sync-Zyklus darf in das Log-Fenster schreiben.
async function backupFixture(dir) {
  saveSetting('api_key', '');
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch('http://localhost:3001/api/system/status')).json();
    if (!s.scheduler.isSyncing) break;
    await new Promise(r => setTimeout(r, 20));
  }
  saveSetting('backup_dir', dir);
  saveSetting('backup_health', '');
}
async function postBackupCapturingLog() {
  const { format } = require('node:util');
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(format(...a));
  try {
    const res = await fetch('http://localhost:3001/api/backup', { method: 'POST' });
    return { res, body: await res.json(), lines };
  } finally { Object.assign(console, orig); }
}
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('POST /api/backup: sichert sofort - an Tagesdrossel und ausgeschaltetem Automatik-Backup vorbei - mit genau einer Logzeile', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-jetzt-'));
  await backupFixture(dir);
  saveSetting('last_backup_scan_date', todayKey()); // Tageslauf schon gelaufen: die Drossel sperrt
  saveSetting('backup_enabled', '0');                // Automatik aus: Einmal-Lauf trotzdem

  const { res, body, lines } = await postBackupCapturingLog();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.snapshot, `klima-${todayKey()}.db`);
  assert.strictEqual(typeof body.written, 'number');
  assert.ok(fs.existsSync(path.join(dir, 'datenbank', body.snapshot)), 'Abzug liegt im Zielordner');
  assert.strictEqual(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^\S+ Sicherung \(manuell\) ok: Abzug klima-\d{4}-\d\d-\d\d\.db, \d+ ZIP neu$/);
  const status = await (await fetch('http://localhost:3001/api/system/status')).json();
  assert.strictEqual(status.backup.health.status, 'ok');
  saveSetting('backup_enabled', '1');
});

test('POST /api/backup: scheitert der Lauf - 500 mit Klartext, Tagesversuch bleibt offen, genau eine Logzeile', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srv-jetzt-')), 'datei-statt-ordner');
  fs.writeFileSync(file, 'x');
  await backupFixture(file);
  saveSetting('backup_enabled', '1');
  saveSetting('last_backup_scan_date', '');

  const { res, body, lines } = await postBackupCapturingLog();
  assert.strictEqual(res.status, 500);
  assert.match(body.error, /^backup_dir nicht beschreibbar: /);
  assert.strictEqual(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^\S+ Sicherung \(manuell\) fehlgeschlagen: backup_dir nicht beschreibbar: /);
  assert.strictEqual(getSetting('last_backup_scan_date'), '', 'der naechste Zyklus versucht es erneut');
  const status = await (await fetch('http://localhost:3001/api/system/status')).json();
  assert.strictEqual(status.backup.health.status, 'error');
  assert.strictEqual(status.backup.health.lastError, body.error);
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

// Gegenprobe zum fetch-Stub am Dateianfang.
test('keine Anfrage dieser Datei verlässt den Rechner', async () => {
  await waitSchedulerIdle();
  assert.ok(localRequests > 0, 'Zähler blind: undici meldet keine Anfragen, die Gegenprobe prüfte nichts');
  assert.deepStrictEqual(cloudRequests, []);
});

after(() => {
  server.close();
  stopScheduler();
  closeDb();
});
