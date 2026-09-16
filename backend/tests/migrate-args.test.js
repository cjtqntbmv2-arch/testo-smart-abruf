const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Argumentauswertung aller Migrationsskripte.
//
// Die Skripte werden NIE aus dem Projektverzeichnis heraus gestartet: ohne --db
// wuerde `path.join(__dirname, '..', 'klima.db')` die echte Produktionsdatenbank
// oeffnen. Stattdessen liegt eine Attrappe der Projektwurzel in $TMPDIR — Skripte
// als Kopie, backend/ und node_modules/ als Symlink. Ein Fehlgriff legt dort eine
// Datenbank an, nicht im Repo, und genau das prueft der erste Test.

const REPO = path.join(__dirname, '..', '..');
const SCRIPTS = fs
  .readdirSync(path.join(REPO, 'scripts'))
  .filter((f) => f.startsWith('migrate-') && f.endsWith('.js'))
  .sort();

function fakeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testo-args-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.cpSync(path.join(REPO, 'scripts'), path.join(proj, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'backend'), path.join(proj, 'backend'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(proj, 'node_modules'));
  return { root, proj };
}

function cleanup(root, proj) {
  // Symlinks zuerst einzeln entfernen — nichts soll je in die echten Ordner laufen.
  for (const link of ['backend', 'node_modules']) {
    try {
      fs.unlinkSync(path.join(proj, link));
    } catch { /* schon weg */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function run(proj, script, args) {
  return spawnSync(process.execPath, [path.join(proj, 'scripts', script), ...args], {
    encoding: 'utf8',
  });
}

for (const script of SCRIPTS) {
  test(`${script}: ohne --db bricht ab, schreibt nichts und nennt DB_PATH`, () => {
    const { root, proj } = fakeProject();
    try {
      const r = run(proj, script, []);
      assert.notStrictEqual(r.status, 0, 'muss mit Fehlercode abbrechen');
      assert.match(r.stderr, /DB_PATH/, 'Meldung muss DB_PATH als Fundort der Produktions-DB nennen');
      assert.ok(
        !fs.existsSync(path.join(proj, 'klima.db')),
        'darf keine Datenbank anlegen — auch keine leere'
      );
    } finally {
      cleanup(root, proj);
    }
  });

  test(`${script}: --db ohne Wert bricht verstaendlich ab, ohne Stacktrace`, () => {
    const { root, proj } = fakeProject();
    try {
      const r = run(proj, script, ['--db']);
      assert.notStrictEqual(r.status, 0, 'muss mit Fehlercode abbrechen');
      assert.match(r.stderr, /--db/, 'Meldung muss das fehlende Argument benennen');
      assert.doesNotMatch(r.stderr, /\n\s+at /, 'kein Stacktrace in der Meldung');
      assert.ok(!fs.existsSync(path.join(proj, 'klima.db')), 'darf keine Datenbank anlegen');
    } finally {
      cleanup(root, proj);
    }
  });

  test(`${script}: --db auf einen Tippfehler-Pfad legt keine Datei an`, () => {
    const { root, proj } = fakeProject();
    const missing = path.join(root, 'gibtsnicht.db');
    try {
      const r = run(proj, script, ['--db', missing]);
      assert.notStrictEqual(r.status, 0, 'muss mit Fehlercode abbrechen');
      assert.ok(r.stderr.includes(missing), 'Meldung muss den angegebenen Pfad nennen');
      assert.match(r.stderr, /DB_PATH/, 'Meldung muss DB_PATH als Fundort nennen');
      assert.doesNotMatch(r.stderr, /\n\s+at /, 'kein Stacktrace in der Meldung');
      assert.ok(!fs.existsSync(missing), 'darf am falschen Pfad keine 0-Byte-Datei hinterlassen');
    } finally {
      cleanup(root, proj);
    }
  });

  test(`${script}: --db auf eine Datei, die keine SQLite-Datenbank ist`, () => {
    const { root, proj } = fakeProject();
    const fremd = path.join(root, 'fremd.db');
    fs.writeFileSync(fremd, 'Das hier ist eine Textdatei, keine Datenbank.\n');
    try {
      const r = run(proj, script, ['--db', fremd]);
      assert.notStrictEqual(r.status, 0, 'muss mit Fehlercode abbrechen');
      assert.ok(r.stderr.includes(fremd), 'Meldung muss den angegebenen Pfad nennen');
      assert.match(r.stderr, /SQLite/i, 'Meldung muss sagen, dass das keine SQLite-Datenbank ist');
      assert.doesNotMatch(r.stderr, /\n\s+at /, 'kein Stacktrace in der Meldung');
    } finally {
      cleanup(root, proj);
    }
  });
}

// SQLite erzwingt Fremdschluessel nur PRO VERBINDUNG (backend/db.js setzt das Pragma
// beim Oeffnen, aber jedes Migrationsskript oeffnet seine eigene Verbindung). Aktuell
// schreibt keines der sechs Skripte eine Fremdschluesselspalte (station_id) um und
// loescht keine Elternzeile aus stations/measurements/events — ein Verhaltenstest
// (Skript gegen eine DB mit verwaister Zeile laufen lassen) waere deshalb vor UND nach
// dem Fix gruen und koennte den Fix nicht nachweisen. Die Quelltextpruefung ist die
// einzige, die rot (Pragma fehlt) von gruen (Pragma gesetzt) unterscheidet.
for (const script of SCRIPTS) {
  test(`${script}: aktiviert foreign_keys vor jeder Transaktion`, () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', script), 'utf8');
    assert.match(
      src,
      /db\.pragma\(\s*['"]foreign_keys\s*=\s*ON['"]\s*\)/,
      'Skript muss auf seiner eigenen Verbindung foreign_keys = ON setzen (SQLite: pro Verbindung, nicht pro Datei)'
    );
    const pragmaIdx = src.search(/db\.pragma\(\s*['"]foreign_keys\s*=\s*ON['"]\s*\)/);
    const txIdx = src.indexOf('db.transaction(');
    if (txIdx !== -1) {
      assert.ok(
        pragmaIdx < txIdx,
        'Pragma muss vor dem ersten db.transaction(...) stehen — SQLite ignoriert PRAGMA foreign_keys innerhalb einer offenen Transaktion'
      );
    }
  });
}

// --- Trockenlauf mit gueltigem --db ---------------------------------------

const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testo-args-seed-'));
const seedDb = path.join(seedRoot, 'klima.db');
process.env.DB_PATH = seedDb; // muss VOR dem require gesetzt sein
const { initDb, getDb, closeDb } = require('../db');

function seed() {
  initDb();
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, location) VALUES ('st1', 'Labor', 'EG')`).run();

  // Kanal 2 fuehrt exakt den Taupunkt zu (20 C / 50 %) -> Kandidat fuer dewpoint-relabel.
  const m = db.prepare(`
    INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit, channel_no)
    VALUES (@uuid, 'st1', @ts, @val, @prop, @unit, @ch)`);
  const T = Date.UTC(2026, 4, 1, 8, 0, 0);
  for (let i = 0; i < 3; i++) {
    const ts = T + i * 60000;
    m.run({ uuid: `t1-${i}`, ts, val: 20.0, prop: 'temperature', unit: '°C', ch: 1 });
    m.run({ uuid: `t2-${i}`, ts, val: 9.26, prop: 'temperature', unit: '°C', ch: 2 });
    m.run({ uuid: `h-${i}`, ts, val: 50.0, prop: 'humidity', unit: '%', ch: 3 });
    // Druckkanal faelschlich als abshumid -> Kandidat fuer pressure-relabel.
    m.run({ uuid: `p-${i}`, ts, val: 1013.2, prop: 'abshumid', unit: 'hPa', ch: 4 });
  }

  const e = db.prepare(`
    INSERT INTO events (uuid, station_id, severity, alarm_status, alarm_condition_type,
                        metric, serial_no, start_ts, active, message, detail)
    VALUES (@uuid, 'st1', @sev, @status, @cond, @metric, @serial, @ts, 0, @msg, @detail)`);
  // Kandidat fuer system-alarm-relabel (Systemzeile noch als 'warning' abgelegt).
  e.run({ uuid: 'ev-sys-raw', sev: 'warning', status: 'Alarm',
    cond: 'Connection timeout, device did not communicated in expected time',
    metric: null, serial: 'SN-A', ts: T, msg: 'Alarm condition is violated',
    detail: 'Sensor SN-A hat einen Wert von null gemeldet.' });
  // Kandidat fuer system-alarm-text (bereits 'system', aber alter Text).
  e.run({ uuid: 'ev-sys-text', sev: 'system', status: 'Alarm', cond: 'connection',
    metric: null, serial: 'SN-B', ts: T + 60000, msg: 'Alarm condition is violated',
    detail: 'Sensor SN-B hat einen Wert von null gemeldet.' });
  // Kandidat fuer measurement-alarm-text (englische Ueberschrift).
  e.run({ uuid: 'ev-meas', sev: 'alarm', status: 'Alarm', cond: 'Upper limit',
    metric: 'temperature', serial: 'SN-C', ts: T + 120000,
    msg: 'Alarm condition is violated', detail: 'Sensor SN-C hat einen Grenzwert verletzt.' });

  // Kandidat fuer alarm-resync.
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('last_alarm_sync_time', '2026-05-01T00:00:00Z')`).run();
  closeDb();
}

const Database = require('better-sqlite3');

function snapshot(file) {
  const db = new Database(file, { readonly: true });
  const dump = {};
  for (const t of ['stations', 'measurements', 'events', 'settings']) {
    dump[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  }
  db.close();
  return JSON.stringify(dump);
}

seed();
const seedState = snapshot(seedDb);

for (const script of SCRIPTS) {
  test(`${script}: Trockenlauf mit gueltigem --db laeuft durch und schreibt nichts`, () => {
    const { root, proj } = fakeProject();
    const work = path.join(root, 'work.db');
    fs.copyFileSync(seedDb, work);
    try {
      const r = run(proj, script, ['--db', work]);
      assert.strictEqual(r.status, 0, `Trockenlauf muss sauber enden, stderr: ${r.stderr}`);
      assert.strictEqual(snapshot(work), seedState, 'Trockenlauf darf nichts aendern');
    } finally {
      cleanup(root, proj);
    }
  });
}

test('migrate-dewpoint-relabel: --apply schreibt den Taupunktkanal um', () => {
  const { root, proj } = fakeProject();
  const work = path.join(root, 'work.db');
  fs.copyFileSync(seedDb, work);
  try {
    const r = run(proj, 'migrate-dewpoint-relabel.js', ['--db', work, '--apply']);
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const db = new Database(work, { readonly: true });
    const props = db
      .prepare(`SELECT channel_no, physical_property, count(*) AS n FROM measurements
                GROUP BY channel_no, physical_property ORDER BY channel_no`)
      .all();
    db.close();
    const byCh = Object.fromEntries(props.map((p) => [p.channel_no, p.physical_property]));
    assert.strictEqual(byCh[2], 'dewpoint', 'Kanal 2 wird zum Taupunkt');
    assert.strictEqual(byCh[1], 'temperature', 'die echte Lufttemperatur bleibt');
  } finally {
    cleanup(root, proj);
  }
});

test.after(() => fs.rmSync(seedRoot, { recursive: true, force: true }));
