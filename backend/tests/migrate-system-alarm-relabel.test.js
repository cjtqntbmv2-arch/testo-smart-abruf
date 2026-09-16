const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Eigene Wegwerf-DB in $TMPDIR — klima.db im Projekt wird nie angefasst.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testo-relabel-'));
const dbPath = path.join(tmpRoot, 'klima.db');
process.env.DB_PATH = dbPath; // muss VOR dem require gesetzt sein

const { initDb, getDb, closeDb } = require('../db');
const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'migrate-system-alarm-relabel.js');

const T = Date.UTC(2026, 4, 1, 8, 0, 0); // Basiszeit, +n Minuten je Zeile

function seed() {
  initDb();
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, location) VALUES (?, ?, ?)`).run('st1', 'Labor', 'EG');

  const ins = db.prepare(`
    INSERT INTO events (uuid, station_id, severity, alarm_status, alarm_condition_type,
                        metric, serial_no, start_ts, active)
    VALUES (@uuid, 'st1', @severity, @status, @cond, @metric, @serial, @ts, @active)`);

  // (a) Ausloeser: ohne einen Relabel-Kandidaten steigt das Skript vor der
  //     Reconciliation aus ("nothing to relabel"). Eigene Partition.
  ins.run({ uuid: 'relabel-1', severity: 'warning', status: 'Alarm',
    cond: 'Connection timeout, device did not communicated in expected time',
    metric: null, serial: 'SN-X', ts: T, active: 0 });

  // (b) serial_no trennt: gleiche Station/Bedingung/Metrik/Schwere, zwei Sensoren.
  //     Aelterer offener Alarm an SN-A, spaetere Entwarnung an SN-B.
  ins.run({ uuid: 'ser-a-alarm', severity: 'alarm', status: 'Alarm', cond: 'Upper limit',
    metric: 'temperature', serial: 'SN-A', ts: T + 60000, active: 1 });
  ins.run({ uuid: 'ser-b-ok', severity: 'alarm', status: 'Ok', cond: 'Upper limit',
    metric: 'temperature', serial: 'SN-B', ts: T + 120000, active: 0 });

  // (c) severity trennt: selber Sensor, selbe Bedingung/Metrik, zwei Grenzwertbaender.
  //     Offener Warning-Alarm, danach eine Entwarnung des Alarm-Bandes.
  ins.run({ uuid: 'sev-warn-alarm', severity: 'warning', status: 'Alarm', cond: 'Lower limit',
    metric: 'humidity', serial: 'SN-C', ts: T + 180000, active: 1 });
  ins.run({ uuid: 'sev-alarm-ok', severity: 'alarm', status: 'Ok', cond: 'Lower limit',
    metric: 'humidity', serial: 'SN-C', ts: T + 240000, active: 0 });

  closeDb();
}

function runMigration() {
  return execFileSync(process.execPath, [scriptPath, '--db', dbPath, '--apply'], { encoding: 'utf8' });
}

function eventsByUuid() {
  initDb();
  const rows = getDb().prepare(`SELECT uuid, active, severity, alarm_condition_type FROM events`).all();
  closeDb();
  return Object.fromEntries(rows.map((r) => [r.uuid, r]));
}

test('migrate-system-alarm-relabel partitioniert wie der Scheduler (serial_no + severity)', () => {
  seed();
  runMigration();
  const ev = eventsByUuid();

  // Der eigentliche Relabel-Job bleibt intakt.
  assert.strictEqual(ev['relabel-1'].severity, 'system');
  assert.strictEqual(ev['relabel-1'].alarm_condition_type, 'connection');
  assert.strictEqual(ev['relabel-1'].active, 1, 'offener Systemalarm bleibt aktiv');

  // Ein anderer Sensor darf den offenen Alarm nicht mit entwarnen.
  assert.strictEqual(ev['ser-a-alarm'].active, 1,
    'offener Alarm an SN-A bleibt aktiv, obwohl SN-B spaeter entwarnt wurde');
  assert.strictEqual(ev['ser-b-ok'].active, 0, 'Entwarnung ist nie aktiv');

  // Eine andere Schwere darf den offenen Alarm nicht mit entwarnen.
  assert.strictEqual(ev['sev-warn-alarm'].active, 1,
    'offener Warning-Alarm bleibt aktiv, obwohl das Alarm-Band spaeter entwarnt wurde');
  assert.strictEqual(ev['sev-alarm-ok'].active, 0, 'Entwarnung ist nie aktiv');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
