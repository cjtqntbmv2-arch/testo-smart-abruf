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
  assert.strictEqual(fs.readdirSync(dir).length, 0);
});

test('computePruneFloor: returns start of oldest un-backed-up data month', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0); // May 2026, not yet backed up
  const floor = runner.computePruneFloor(now);
  assert.strictEqual(floor, runner.monthStartMs(2026, 4)); // May 1 (local) — compare to the production helper, TZ-independent
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
