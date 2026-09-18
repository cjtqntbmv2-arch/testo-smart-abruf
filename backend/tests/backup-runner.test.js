// backend/tests/backup-runner.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DB_PATH = ':memory:';
const { getDb, getSetting, saveSetting } = require('../db');
const runner = require('../backup-runner');

function tmpDir() {
  getDb().exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;"); // reset shared :memory: state
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-'));
  saveSetting('backup_dir', d);
  saveSetting('backup_enabled', '1');
  saveSetting('last_backup_scan_date', '');
  saveSetting('backup_health', '');
  saveSetting('retention_days', '365');
  return d;
}
function seedMonth(stationId, name, year, monthIdx0, value) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id,name) VALUES (?,?)").run(stationId, name);
  const ts = Date.UTC(year, monthIdx0, 15, 12, 0, 0);
  db.prepare("INSERT INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES (?,?,?,?,?,?)")
    .run(`${stationId}-${year}-${monthIdx0}`, stationId, ts, value, 'temperature', '°C');
}

test('runBackupScan: writes one zip per (station,complete-month) with data', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  const dir = tmpDir();
  // "now" = 2026-06-10 → May 2026 is the last complete month.
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0); // May 2026
  const res = runner.runBackupScan(now);
  assert.ok(res.written.some(f => f.includes('2026-05')), 'wrote May zip');
  assert.ok(fs.existsSync(path.join(dir, fs.readdirSync(dir).find(f => f.includes('2026-05')))));
});

test('runBackupScan: idempotent — second run skips existing zip', () => {
  const dir = tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0);
  runner.runBackupScan(now);
  const before = fs.readdirSync(dir).length;
  const res2 = runner.runBackupScan(now);
  assert.strictEqual(fs.readdirSync(dir).length, before);
  assert.ok(res2.skipped >= 1);
});

test('runBackupScan: leaves no .tmp file behind on success', () => {
  const dir = tmpDir();
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0);
  runner.runBackupScan(Date.UTC(2026, 5, 10, 9, 0, 0));
  assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0);
});

test('runBackupScan: skips (station,month) with no data — no empty zip', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  const dir = tmpDir();
  db.prepare("INSERT INTO stations (id,name) VALUES (?,?)").run('s9', 'Leer');
  const res = runner.runBackupScan(Date.UTC(2026, 5, 10));
  assert.strictEqual(res.written.length, 0);
  // Einziger Eintrag: der Ordner des taeglichen Datenbank-Abzugs (entsteht auch ohne Messdaten).
  assert.deepStrictEqual(fs.readdirSync(dir), ['datenbank']);
});

test('computePruneFloor: returns start of oldest un-backed-up data month', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0); // May 2026, not yet backed up
  // Gelungener Datenbank-Abzug am 20. Mai, als der Mai noch lief (also ohne Mai-ZIP):
  // ohne ihn loescht die Aufbewahrung gar nichts (siehe Tests unten).
  assert.deepStrictEqual(runner.runBackupScan(Date.UTC(2026, 4, 20, 12, 0, 0)).errors, []);
  const floor = runner.computePruneFloor(now);
  assert.strictEqual(floor, runner.monthStartMs(2026, 4)); // May 1 (local) — compare to the production helper, TZ-independent
});

test('computePruneFloor: nie juenger als der letzte gelungene Datenbank-Abzug', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  tmpDir();
  const snapAt = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0); // Mai: bekommt beim Lauf am 10. Juni sein ZIP
  assert.deepStrictEqual(runner.runBackupScan(snapAt).errors, []);
  // Alle Monate haben ihr ZIP; was nach dem Abzug entstand, steht aber in keinem Abzug.
  assert.strictEqual(runner.computePruneFloor(Date.UTC(2026, 5, 20)), snapAt);
});

test('computePruneFloor: ohne gelungenen Datenbank-Abzug -Infinity, die Aufbewahrung loescht nichts', () => {
  tmpDir(); // backup_health leer = noch kein Abzug
  assert.strictEqual(runner.computePruneFloor(Date.UTC(2026, 5, 20)), -Infinity);
});

test('computePruneFloor: Infinity when backups disabled', () => {
  saveSetting('backup_enabled', '0');
  assert.strictEqual(runner.computePruneFloor(Date.UTC(2026, 5, 10)), Infinity);
  saveSetting('backup_enabled', '1');
});

test('maybeRunBackupScan: throttled to once per local day', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0);
  assert.strictEqual(runner.maybeRunBackupScan(now), true);
  assert.strictEqual(runner.maybeRunBackupScan(now + 3600000), false); // same local day
});

test('runBackupScan: unwritable dir => health error, scan-date not advanced', () => {
  saveSetting('backup_dir', path.join(os.tmpdir(), 'no', 'such', 'parent-' + process.pid, 'x'));
  saveSetting('backup_enabled', '1');
  saveSetting('last_backup_scan_date', '');
  // make resolveBackupDir point somewhere unwritable: use a file as the dir
  const f = path.join(os.tmpdir(), 'file-as-dir-' + process.pid);
  fs.writeFileSync(f, 'x');
  saveSetting('backup_dir', f);
  const ran = runner.maybeRunBackupScan(Date.UTC(2026, 5, 10));
  assert.strictEqual(getSetting('last_backup_scan_date') || '', ''); // not advanced
  const health = JSON.parse(getSetting('backup_health') || '{}');
  assert.strictEqual(health.status, 'error');
});

// V27 (Funktionstest 2026-09-17: "Fehler bleibt bis zum Folgetag stehen") - widerlegt. Nur ein
// fehlerfreier Lauf verbraucht den Tagesversuch; nach behobener Ursache heilt schon der naechste
// Zyklus desselben Tages backup_health. Datei statt Ordner 'datenbank': scheitert ueberall.
test('maybeRunBackupScan: ein gescheiterter Lauf verbraucht den Tagesversuch nicht, der naechste Zyklus heilt', () => {
  const dir = tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  const blocker = path.join(dir, 'datenbank');
  fs.writeFileSync(blocker, 'kein Ordner');
  assert.strictEqual(runner.maybeRunBackupScan(now), true);
  assert.strictEqual(JSON.parse(getSetting('backup_health')).status, 'error');
  assert.strictEqual(getSetting('last_backup_scan_date'), '');

  fs.rmSync(blocker); // Ursache behoben
  assert.strictEqual(runner.maybeRunBackupScan(now + 15 * 60 * 1000), true); // naechster Zyklus, selber Tag
  assert.strictEqual(JSON.parse(getSetting('backup_health')).status, 'ok');
  assert.strictEqual(runner.maybeRunBackupScan(now + 30 * 60 * 1000), false); // erst jetzt ist der Tag verbraucht
});

// Neu mit "Jetzt sichern": scheitert ein Knopf-Lauf NACH dem gelungenen Tageslauf, steht der
// Tagesvermerk schon auf heute. Ohne Sonderregel versuchte es kein Zyklus mehr, der Fehler
// bliebe nach Behebung bis zum Folgetag stehen (V27 auf neuem Weg).
test('maybeRunBackupScan: nach einem gescheiterten Knopf-Lauf versucht es der naechste Zyklus erneut, auch wenn der Tag schon gesichert war', () => {
  const dir = tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  const HOUR = 3600 * 1000;
  assert.strictEqual(runner.maybeRunBackupScan(now), true); // Tageslauf gelingt
  fs.renameSync(path.join(dir, 'datenbank'), path.join(dir, 'datenbank-alt'));
  const blocker = path.join(dir, 'datenbank');
  fs.writeFileSync(blocker, 'kein Ordner');
  assert.strictEqual(runner.runBackupNow(now + HOUR).errors.length, 1); // Knopf-Lauf scheitert
  assert.strictEqual(runner.maybeRunBackupScan(now + 2 * HOUR), true, 'Fehlerzustand: Zyklus versucht es erneut');

  fs.rmSync(blocker); // Ursache behoben
  assert.strictEqual(runner.maybeRunBackupScan(now + 3 * HOUR), true);
  assert.strictEqual(JSON.parse(getSetting('backup_health')).status, 'ok');
  assert.strictEqual(runner.maybeRunBackupScan(now + 4 * HOUR), false);
});
