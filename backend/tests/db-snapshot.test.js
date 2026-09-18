// backend/tests/db-snapshot.test.js
// Taeglicher Abzug der ganzen Datenbank (VACUUM INTO) neben den Monats-ZIPs.
// Eigene Datei aus zwei Gruenden: Die Datenbank ist hier eine echte Datei im WAL-Modus wie
// im Dienst (nur so laesst sich zeigen, dass der Abzug auch Zeilen enthaelt, die noch nicht
// in die Hauptdatei zurueckgeschrieben sind), und die Zeitzone steht fest auf Berlin, damit
// der Namens-Test Ortsdatum und UTC-Datum auch auf dem UTC-Runner der CI unterscheidet.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

process.env.TZ = 'Europe/Berlin';
// dotenv ueberschreibt vorhandene Variablen nicht: so landet kein echter Schluessel aus der
// .env des Repos in der Wegwerf-DB (initDb uebernimmt ihn sonst in die leere settings-Tabelle).
process.env.TESTO_API_KEY = '';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
process.env.DB_PATH = path.join(ROOT, 'klima.db');
const { getDb, getSetting, saveSetting, closeDb } = require('../db');
const runner = require('../backup-runner');

// 2026-09-17 23:30 UTC ist in Berlin schon der 18.09., 01:30 Uhr.
const NOW = Date.UTC(2026, 8, 17, 23, 30);
const DAY = 24 * 3600 * 1000;
const TODAY = 'klima-2026-09-18.db';

function freshBackupDir() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'bkp-'));
  saveSetting('backup_dir', dir);
  saveSetting('backup_enabled', '1');
  saveSetting('last_backup_scan_date', '');
  saveSetting('backup_health', '');
  return dir;
}
const snapDir = (dir) => path.join(dir, 'datenbank');
const health = () => JSON.parse(getSetting('backup_health') || '{}');
const touch = (dir, names) => { for (const f of names) fs.writeFileSync(path.join(dir, f), 'x'); };

after(() => {
  closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('Abzug: Ortsdatum im Namen, alle fuenf Tabellen, auch Zeilen, die nur im WAL stehen', () => {
  const dir = freshBackupDir();
  const db = getDb();
  db.pragma('wal_checkpoint(TRUNCATE)'); // Schema und Einstellungen in die Hauptdatei
  db.pragma('wal_autocheckpoint = 0');   // ab hier bleibt alles Neue im WAL
  saveSetting('api_key', 'schluessel-123');
  db.prepare("INSERT INTO stations (id, name, device_uuid) VALUES ('s1', 'Lager', 'dev-1')").run();
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('m1', 's1', ?, 21.5, 'temperature', '°C')").run(NOW);
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts) VALUES ('e1', 's1', 'alarm', ?)").run(NOW);
  db.prepare("INSERT INTO limits (metric, direction, severity, limit_value) VALUES ('temperature', 'upper', 'alarm', 30)").run();

  // Gegenprobe: die Hauptdatei allein kennt die neuen Zeilen nicht, sie stehen nur im WAL.
  assert.ok(fs.statSync(`${process.env.DB_PATH}-wal`).size > 0);
  const mainOnly = path.join(fs.mkdtempSync(path.join(ROOT, 'main-')), 'klima.db');
  fs.copyFileSync(process.env.DB_PATH, mainOnly);
  const m = new Database(mainOnly);
  assert.strictEqual(m.prepare('SELECT count(*) n FROM measurements').get().n, 0);
  m.close();

  const res = runner.runBackupScan(NOW);
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(fs.readdirSync(snapDir(dir)), [TODAY]); // UTC-Datum waere 2026-09-17

  // Eigenstaendig: allein in einen leeren Ordner kopiert, ohne -wal/-shm, vollstaendig.
  const alone = path.join(fs.mkdtempSync(path.join(ROOT, 'alone-')), 'klima.db');
  fs.copyFileSync(path.join(snapDir(dir), TODAY), alone);
  const s = new Database(alone, { readonly: true });
  try {
    assert.strictEqual(s.pragma('integrity_check', { simple: true }), 'ok');
    // Schluessel bewusst mit gesichert: zurueckgespielt laeuft der Dienst ohne Nacharbeit.
    assert.strictEqual(s.prepare("SELECT value FROM settings WHERE key = 'api_key'").get().value, 'schluessel-123');
    assert.strictEqual(s.prepare("SELECT device_uuid FROM stations WHERE id = 's1'").get().device_uuid, 'dev-1');
    assert.deepStrictEqual(s.prepare('SELECT uuid FROM measurements').all(), [{ uuid: 'm1' }]);
    assert.strictEqual(s.prepare('SELECT count(*) n FROM events').get().n, 1);
    assert.strictEqual(s.prepare('SELECT count(*) n FROM limits').get().n, 1);
  } finally { s.close(); }

  const h = health();
  assert.strictEqual(h.status, 'ok');
  assert.strictEqual(h.lastDbSnapshot, TODAY);
  assert.strictEqual(h.lastDbSnapshotAt, new Date(NOW).toISOString());
  assert.strictEqual(h.dbSnapshotError, null);
  assert.strictEqual(h.dbSnapshotPruneError, null);
  db.pragma('wal_autocheckpoint = 1000');
});

test('Aufbewahrung: die sieben neuesten bleiben, fremde Dateien und ZIPs bleiben unberuehrt', () => {
  const dir = freshBackupDir();
  fs.mkdirSync(snapDir(dir));
  const old = Array.from({ length: 9 }, (_, i) => `klima-2026-09-0${i + 1}.db`);
  const foreign = ['klima.db', 'klima-2026-8-1.db', 'klima-2026-08-01.db.bak', 'notiz.txt', 'Lager_s1_2026-08.zip'];
  touch(snapDir(dir), [...old, ...foreign]);
  touch(dir, ['Lager_s1_2026-08.zip']);

  assert.deepStrictEqual(runner.runBackupScan(NOW).errors, []);
  const left = fs.readdirSync(snapDir(dir)).sort();
  assert.deepStrictEqual(left.filter((f) => /^klima-\d{4}-\d{2}-\d{2}\.db$/.test(f)),
    ['klima-2026-09-04.db', 'klima-2026-09-05.db', 'klima-2026-09-06.db', 'klima-2026-09-07.db',
      'klima-2026-09-08.db', 'klima-2026-09-09.db', TODAY]);
  for (const f of foreign) assert.ok(left.includes(f), `${f} muss bleiben`);
  assert.ok(fs.existsSync(path.join(dir, 'Lager_s1_2026-08.zip')));
});

test('Zweiter Lauf am selben Tag ersetzt nur den Abzug dieses Tages', () => {
  const dir = freshBackupDir();
  fs.mkdirSync(snapDir(dir));
  const older = Array.from({ length: 6 }, (_, i) => `klima-2026-09-1${i}.db`);
  touch(snapDir(dir), older);

  runner.runBackupScan(NOW);
  saveSetting('marker', 'zweiter-lauf');
  assert.deepStrictEqual(runner.runBackupScan(NOW + 3600 * 1000).errors, []); // eine Stunde spaeter
  // Sieben Dateien, keine verdraengt: mehrfaches Sichern an einem Tag kostet keine Historie.
  assert.deepStrictEqual(fs.readdirSync(snapDir(dir)).sort(), [...older, TODAY]);
  const s = new Database(path.join(snapDir(dir), TODAY), { readonly: true });
  assert.strictEqual(s.prepare("SELECT value FROM settings WHERE key = 'marker'").get().value, 'zweiter-lauf');
  s.close();
});

test('Abzug scheitert (Ordner nicht beschreibbar): Fehler sichtbar, Altabzug unberuehrt, keine .tmp, Tagesversuch nicht verbraucht',
  { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'chmod sperrt hier nicht' : false }, () => {
    const dir = freshBackupDir();
    runner.runBackupScan(NOW - DAY); // Vortag gelingt: klima-2026-09-17.db
    const before = fs.readdirSync(snapDir(dir));
    assert.deepStrictEqual(before, ['klima-2026-09-17.db']);
    fs.chmodSync(snapDir(dir), 0o555);
    try {
      const res = runner.runBackupScan(NOW);
      assert.strictEqual(res.errors.length, 1);
      assert.match(res.errors[0], /^Datenbank-Abzug: /);
      assert.strictEqual(runner.maybeRunBackupScan(NOW), true);
      assert.strictEqual(getSetting('last_backup_scan_date'), ''); // naechster Zyklus versucht es erneut
      assert.deepStrictEqual(fs.readdirSync(snapDir(dir)), before);
      const h = health();
      assert.strictEqual(h.status, 'error');
      assert.ok(h.dbSnapshotError, 'dbSnapshotError gesetzt');
      assert.match(h.lastError, /^Datenbank-Abzug: /);
      // Der letzte gelungene Abzug bleibt sichtbar, damit klar ist, wie alt der neueste ist.
      assert.strictEqual(h.lastDbSnapshot, 'klima-2026-09-17.db');
      assert.strictEqual(h.lastDbSnapshotAt, new Date(NOW - DAY).toISOString());
    } finally { fs.chmodSync(snapDir(dir), 0o755); }
  });

test('Abzug scheitert beim Umbenennen: die halbe .tmp wird weggeraeumt, der Fehler bleibt sichtbar', () => {
  const dir = freshBackupDir();
  fs.mkdirSync(path.join(snapDir(dir), TODAY), { recursive: true }); // Verzeichnis unter dem Zielnamen
  const res = runner.runBackupScan(NOW);
  assert.strictEqual(res.errors.length, 1);
  assert.deepStrictEqual(fs.readdirSync(snapDir(dir)), [TODAY]);
  assert.ok(health().dbSnapshotError);
});

test('backup_enabled aus: kein Abzug', () => {
  const dir = freshBackupDir();
  saveSetting('backup_enabled', '0');
  assert.strictEqual(runner.maybeRunBackupScan(NOW), false);
  assert.strictEqual(fs.existsSync(snapDir(dir)), false);
});
