// backend/tests/export-service.test.js
const test = require('node:test');
const assert = require('node:assert');
process.env.DB_PATH = ':memory:';
const { getDb } = require('../db');
const svc = require('../export-service');

function seed() {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  db.prepare("INSERT INTO stations (id,name,location,serial_no,model_code) VALUES (?,?,?,?,?)")
    .run('s1', 'Serverraum', 'A', '111', 'M1');
  db.prepare("INSERT INTO stations (id,name,location,serial_no,model_code) VALUES (?,?,?,?,?)")
    .run('s2', 'Lager', 'B', '222', 'M2');
  const m = db.prepare("INSERT INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES (?,?,?,?,?,?)");
  m.run('m1', 's1', 1000, 21.0, 'temperature', '°C');
  m.run('m2', 's1', 1000, 45.0, 'humidity', '%rF');
  m.run('m3', 's2', 2000, 19.0, 'temperature', '°C');
}

test('safeFileName: strips illegal chars, keeps umlauts', () => {
  // original regex maps space, '/', ':' to '_' (no collapse) → ': ' becomes '__'
  assert.strictEqual(svc.safeFileName('Büro 1/OG: A'), 'Büro_1_OG__A');
  assert.strictEqual(svc.safeFileName('a*b?c'), 'a_b_c');
  assert.strictEqual(svc.safeFileName('Büro'), 'Büro');
});

test('stationBase: appends station id so same-name stations cannot collide', () => {
  assert.strictEqual(svc.stationBase({ name: 'Halle', id: 's1' }), 'Halle_s1');
  assert.notStrictEqual(svc.stationBase({ name: 'Halle', id: 's1' }), svc.stationBase({ name: 'Halle', id: 's2' }));
});

test('exportStations: single station, no events => single CSV', () => {
  seed();
  const res = svc.exportStations({ stationIds: ['s1'], metricKeys: null, fromTs: 0, toTs: 9e15, includeEvents: false, dialectName: 'de', nowMs: 0 });
  assert.strictEqual(res.kind, 'csv');
  assert.strictEqual(res.mime, 'text/csv; charset=utf-8');
  assert.ok(res.filename.endsWith('.csv'));
  assert.ok(res.buffer.toString('utf8').includes('Temperatur [°C]'));
});

test('exportStations: multiple stations => zip with one csv per station', () => {
  seed();
  const res = svc.exportStations({ stationIds: ['s1','s2'], metricKeys: null, fromTs: 0, toTs: 9e15, includeEvents: false, dialectName: 'de', nowMs: 0 });
  assert.strictEqual(res.kind, 'zip');
  assert.strictEqual(res.mime, 'application/zip');
  assert.strictEqual(res.buffer.readUInt32LE(0), 0x04034b50);
});

test('exportStations: includeEvents forces zip with 2 files even for one station', () => {
  seed();
  const res = svc.exportStations({ stationIds: ['s1'], metricKeys: null, fromTs: 0, toTs: 9e15, includeEvents: true, dialectName: 'de', nowMs: 0 });
  assert.strictEqual(res.kind, 'zip');
  // ZIP stores entry names literally (uncompressed) in local headers → cheap presence check for both files.
  assert.ok(res.buffer.includes(Buffer.from('_messwerte.csv')), 'has measurements csv');
  assert.ok(res.buffer.includes(Buffer.from('_meldungen.csv')), 'has events csv');
});

test('getExportMetadata: stations carry key+label+unit and range; empty station => [] + null', () => {
  seed();
  const meta = svc.getExportMetadata();
  const s1 = meta.find(x => x.id === 's1');
  assert.deepStrictEqual(s1.metrics.map(m => m.key).sort(), ['humidity','temperature']);
  assert.strictEqual(s1.metrics.find(m => m.key === 'temperature').label, 'Temperatur');
  assert.strictEqual(s1.earliest_ts, 1000);
  getDb().prepare("INSERT INTO stations (id,name) VALUES ('s3','Leer')").run();
  const s3 = svc.getExportMetadata().find(x => x.id === 's3');
  assert.deepStrictEqual(s3.metrics, []);
  assert.strictEqual(s3.earliest_ts, null);
});
