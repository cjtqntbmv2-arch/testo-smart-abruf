const test = require('node:test');
const assert = require('node:assert');

process.env.DB_PATH = ':memory:'; // muss VOR dem require von ../db gesetzt sein

const { initDb, getDb, closeDb } = require('../db');
const { reconcileEvents, reconcileActiveFlags, reconcileEpisodeEnds } = require('../event-reconcile');

const T = Date.UTC(2026, 4, 1, 8, 0, 0); // Basiszeit, +n Minuten je Zeile
const min = (n) => T + n * 60000;

// Frische Wegwerf-DB je Test. Kein runSyncCycle, keine Netzwerk-Mocks — die
// Reconciliation arbeitet ausschliesslich auf gespeicherten Zeilen.
function seed(rows) {
  initDb();
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, location) VALUES (?, ?, ?)`).run('st1', 'Labor', 'EG');
  const ins = db.prepare(`
    INSERT INTO events (uuid, station_id, severity, alarm_status, alarm_condition_type,
                        metric, serial_no, start_ts, end_ts, active)
    VALUES (@uuid, 'st1', @severity, @status, @cond, @metric, @serial, @ts, @end_ts, @active)`);
  for (const r of rows) {
    ins.run({
      metric: null, serial: 'SN-A', cond: 'Upper limit', severity: 'alarm',
      end_ts: null, active: 0, ...r,
    });
  }
  return db;
}

const row = (uuid) => getDb().prepare('SELECT active, end_ts FROM events WHERE uuid = ?').get(uuid);

test('neueste Transition je Gruppe gewinnt: nur eine offene Verletzung bleibt aktiv', () => {
  const db = seed([
    // Gruppe 1: Verletzung, danach Entwarnung -> beide inaktiv.
    // active-Flags absichtlich falsch vorbelegt, damit der Reset nachweisbar greift.
    { uuid: 'g1-viol', status: 'Alarm', ts: min(0), active: 0 },
    { uuid: 'g1-ok', status: 'Ok', ts: min(10), active: 1 },
    // Gruppe 2 (andere Metrik): nur eine Verletzung -> aktiv.
    { uuid: 'g2-viol', status: 'Alarm', metric: 'temperature', ts: min(5), active: 0 },
  ]);

  reconcileEvents(db);

  assert.strictEqual(row('g1-viol').active, 0, 'geschlossene Verletzung darf nicht aktiv sein');
  assert.strictEqual(row('g1-ok').active, 0, 'eine Entwarnung (Ok) ist nie aktiv');
  assert.strictEqual(row('g2-viol').active, 1, 'unbeantwortete Verletzung bleibt aktiv');

  closeDb();
});

test('severity trennt die Gruppen: Alarm-Entwarnung schliesst keine Warning-Verletzung', () => {
  const db = seed([
    { uuid: 'sev-warn-viol', severity: 'warning', status: 'Alarm', cond: 'Lower limit', metric: 'humidity', ts: min(0) },
    { uuid: 'sev-alarm-ok', severity: 'alarm', status: 'Ok', cond: 'Lower limit', metric: 'humidity', ts: min(30) },
  ]);

  reconcileEvents(db);

  assert.strictEqual(row('sev-warn-viol').active, 1, 'Warning-Verletzung gehoert in eine eigene Gruppe');
  assert.strictEqual(row('sev-warn-viol').end_ts, null, 'und hat damit keine naechste Transition');
  assert.strictEqual(row('sev-alarm-ok').active, 0);

  closeDb();
});

test('serial_no trennt die Gruppen: Entwarnung von Sensor B schliesst Sensor A nicht', () => {
  const db = seed([
    { uuid: 'ser-a-viol', status: 'Alarm', serial: 'SN-A', metric: 'temperature', ts: min(0) },
    { uuid: 'ser-b-ok', status: 'Ok', serial: 'SN-B', metric: 'temperature', ts: min(60) },
  ]);

  reconcileEvents(db);

  assert.strictEqual(row('ser-a-viol').active, 1, 'Sensor A bleibt offen');
  assert.strictEqual(row('ser-a-viol').end_ts, null, 'und bekommt kein end_ts von Sensor B');
  assert.strictEqual(row('ser-b-ok').active, 0);

  closeDb();
});

test('end_ts ist der Start der naechsten Transition; die neueste Zeile wird auf NULL zurueckgesetzt', () => {
  const db = seed([
    { uuid: 'e-viol-1', status: 'Alarm', ts: min(0) },
    { uuid: 'e-ok-1', status: 'Ok', ts: min(10) },
    // Veraltetes end_ts auf der neuesten Zeile: muss geloescht werden, nicht stehenbleiben.
    { uuid: 'e-viol-2', status: 'Alarm', ts: min(20), end_ts: min(999), active: 1 },
  ]);

  reconcileEpisodeEnds(db);

  assert.strictEqual(row('e-viol-1').end_ts, min(10), 'Ende der Verletzung = Start der Entwarnung');
  assert.strictEqual(row('e-ok-1').end_ts, min(20), 'Ende der Entwarnung = Start der naechsten Verletzung');
  assert.strictEqual(row('e-viol-2').end_ts, null, 'die neueste Zeile der Gruppe hat kein Ende');
  // Die beiden Haelften sind getrennt: end_ts-Rechnung fasst active nicht an.
  assert.strictEqual(row('e-viol-1').active, 0, 'reconcileEpisodeEnds veraendert keine active-Flags');
  assert.strictEqual(row('e-viol-2').active, 1, 'reconcileEpisodeEnds veraendert keine active-Flags');

  closeDb();
});

test('synthetische sys-*-Zeilen (alarm_status IS NULL) bleiben unangetastet', () => {
  const db = seed([
    { uuid: 'sys-connection-st1', severity: 'system', status: null, cond: 'connection', ts: min(0), end_ts: min(5), active: 1 },
    { uuid: 'feed-viol', status: 'Alarm', ts: min(1) },
  ]);

  reconcileEvents(db);

  const sys = row('sys-connection-st1');
  assert.strictEqual(sys.active, 1, 'applySystemEvents besitzt diese Zeile — active bleibt');
  assert.strictEqual(sys.end_ts, min(5), 'und end_ts ebenso');
  assert.strictEqual(row('feed-viol').active, 1);

  closeDb();
});

test('reconcileActiveFlags rechnet keine end_ts — die Haelften sind einzeln aufrufbar', () => {
  const db = seed([
    { uuid: 'half-viol', status: 'Alarm', ts: min(0) },
    { uuid: 'half-ok', status: 'Ok', ts: min(10) },
  ]);

  reconcileActiveFlags(db);

  assert.strictEqual(row('half-viol').active, 0, 'active wird gerechnet');
  assert.strictEqual(row('half-viol').end_ts, null, 'end_ts aber nicht — dafuer ist reconcileEpisodeEnds da');

  closeDb();
});
