const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

// Set DB_PATH to memory for testing
process.env.DB_PATH = ':memory:';
const { initDb, getDb, saveSetting, getSetting, closeDb } = require('../db');

test('SQLite schema setup and settings operations', () => {
  initDb();
  const db = getDb();
  
  // Check tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  assert.ok(tables.includes('settings'), 'settings table should exist');
  assert.ok(tables.includes('stations'), 'stations table should exist');
  assert.ok(tables.includes('measurements'), 'measurements table should exist');
  assert.ok(tables.includes('events'), 'events table should exist');

  // Save and load settings
  saveSetting('test_key', 'test_value');
  assert.strictEqual(getSetting('test_key'), 'test_value');
  
  closeDb();
});

test('initDb seeds CSV-export/backup settings defaults (fresh file DB)', () => {
  // The seed block only runs for a NON-:memory: fresh DB (db.js gates it), so exercise it via a temp file.
  const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
  const { getDb, getSetting, closeDb } = require('../db');
  const prev = process.env.DB_PATH;
  closeDb(); // drop any cached singleton from earlier tests in this file
  process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbseed-')), 'seed.db');
  try {
    getDb(); // fresh file DB → seed runs
    assert.strictEqual(getSetting('backup_enabled'), '1');
    assert.strictEqual(getSetting('csv_format'), 'de');
    assert.strictEqual(getSetting('backup_dir'), '');
  } finally {
    closeDb();
    process.env.DB_PATH = prev; // restore for other tests in this file
  }
});

test('Cascade delete testing', () => {
  initDb();
  const db = getDb();

  // Insert a station
  db.prepare("INSERT INTO stations (id, name) VALUES (?, ?)").run('station-1', 'Test Station');

  // Insert a measurement referencing the station
  db.prepare(`
    INSERT INTO measurements (uuid, station_id, timestamp, timestamp_local, value, physical_property, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('meas-uuid-1', 'station-1', 1600000000, '2020-09-13T12:26:40', 23.5, 'temperature', 'C');

  // Verify measurement is present
  const beforeDelete = db.prepare("SELECT count(*) as count FROM measurements WHERE station_id = ?").get('station-1');
  assert.strictEqual(beforeDelete.count, 1);

  // Delete the station
  db.prepare("DELETE FROM stations WHERE id = ?").run('station-1');

  // Verify measurement was deleted by cascade
  const afterDelete = db.prepare("SELECT count(*) as count FROM measurements WHERE station_id = ?").get('station-1');
  assert.strictEqual(afterDelete.count, 0);

  closeDb();
});

// ── Aufgabe 7 (V28): ein Gerät gehört zu höchstens einer Messstelle ─────────
// Eine Installation von vor dem UNIQUE-Index kann schon eine Dublette tragen; der Dienst muss
// trotzdem starten. Datei-DB, damit ein zweiter Start dieselben Daten sieht. Die settings-Zeile
// vorab verhindert den Erststart-Seed (er schriebe TESTO_API_KEY aus der Umgebung hinein).
const UNIQ_INDEX = 'idx_stations_device_uuid';
function withFileDb(fn) {
  const os = require('node:os');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbuniq-'));
  const file = path.join(dir, 'alt.db');
  const raw = new Database(file);
  raw.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('api_key', '')");
  raw.close();
  const prev = process.env.DB_PATH;
  closeDb();
  process.env.DB_PATH = file;
  try { return fn(); } finally {
    closeDb();
    process.env.DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Ein Dienststart: initDb() auf der Datei, Warnzeilen mitgeschnitten.
function start() {
  closeDb();
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try { initDb(); } finally { console.warn = orig; }
  return warned;
}
const hasIndex = () => !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(UNIQ_INDEX);

test('initDb: Bestand mit doppelter device_uuid startet trotzdem – Warnung nennt UUID und Messstellen, Index fehlt; nach Bereinigung entsteht er beim nächsten Start', () => withFileDb(() => {
  start();
  const db = getDb();
  db.exec(`DROP INDEX IF EXISTS ${UNIQ_INDEX}`); // Stand vor diesem Index
  const ins = db.prepare('INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)');
  ins.run('uwl', 'UWL', 'dev-dup');
  ins.run('pruef-06', 'Teststelle', 'dev-dup');
  ins.run('essbro', 'Büro', 'dev-solo');

  let warned;
  assert.doesNotThrow(() => { warned = start(); }, 'eine Alt-Dublette darf den Dienststart nicht verhindern');
  assert.strictEqual(hasIndex(), false, 'mit Dublette kein Index');
  const line = warned.find((l) => l.includes('dev-dup'));
  assert.ok(line, `Warnzeile mit der UUID erwartet, bekommen: ${JSON.stringify(warned)}`);
  assert.match(line, /uwl \(UWL\), pruef-06 \(Teststelle\)/, 'nennt beide Messstellen, zuerst angelegte vorn');
  assert.ok(!line.includes('essbro'), line);

  // Bereinigt (Teststelle vom Gerät gelöst) → der nächste Start legt den Index an.
  getDb().prepare("UPDATE stations SET device_uuid = NULL WHERE id = 'pruef-06'").run();
  assert.deepStrictEqual(start(), []);
  assert.strictEqual(hasIndex(), true);
}));

test('initDb: ohne Dublette entsteht der Teil-UNIQUE-Index, ein zweiter Start ist idempotent; "kein Gerät" (NULL, "", Leerzeichen) bleibt mehrfach erlaubt', () => withFileDb(() => {
  assert.deepStrictEqual(start(), []);
  assert.strictEqual(hasIndex(), true, 'Index nach dem ersten Start');
  const ins = getDb().prepare('INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)');
  ins.run('a', 'A', 'dev-1');
  // Altbestände tragen für "kein Gerät" teils '' statt NULL: nichts davon darf kollidieren.
  for (const [id, uuid] of [['n1', null], ['n2', null], ['e1', ''], ['e2', ''], ['w1', '  '], ['w2', '  ']]) {
    assert.doesNotThrow(() => ins.run(id, id, uuid), `${id}: ${JSON.stringify(uuid)}`);
  }
  assert.throws(() => ins.run('b', 'B', 'dev-1'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });

  assert.deepStrictEqual(start(), [], 'zweiter Start: keine Warnung');
  assert.strictEqual(hasIndex(), true, 'Index nach dem zweiten Start');
  assert.strictEqual(getDb().prepare('SELECT count(*) c FROM stations').get().c, 7);
}));
