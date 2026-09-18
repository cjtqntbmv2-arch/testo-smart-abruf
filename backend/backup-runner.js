// backend/backup-runner.js
// Monthly per-station ZIP backups + daily snapshot of the whole DB + retention prune-floor.
// DB + filesystem.
const fs = require('node:fs');
const path = require('node:path');
const { getDb, getSetting, saveSetting } = require('./db');
const { getDialect, pad2 } = require('./csv-format');
const { createZip } = require('./zip-writer');
const { stationFiles, stationBase } = require('./export-service');

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveBackupDir() {
  const configured = (getSetting('backup_dir') || '').trim();
  if (configured) return configured;
  const dbPath = process.env.DB_PATH && process.env.DB_PATH !== ':memory:'
    ? process.env.DB_PATH
    : path.join(__dirname, '../klima.db');
  return path.join(path.dirname(dbPath), 'backups');
}

function monthStartMs(year, monthIdx0) { return new Date(year, monthIdx0, 1, 0, 0, 0, 0).getTime(); }
function localDateKey(epochMs) { const d = new Date(epochMs); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function retentionDays() {
  const n = parseInt(getSetting('retention_days') || '365', 10);
  return (Number.isNaN(n) || n <= 0) ? 365 : n; // same guard as scheduler.js — never 0/NaN (else window/prune break)
}
function lookbackMs() { return (retentionDays() + 62) * DAY_MS; }

// List of {year, monthIdx0, startMs} for complete months within the lookback window.
function candidateMonths(nowMs) {
  const now = new Date(nowMs);
  const out = [];
  // start at the month of (now - lookback), end at last complete month (= month before current).
  let cur = new Date(nowMs - lookbackMs());
  cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const lastComplete = new Date(now.getFullYear(), now.getMonth(), 1); // exclusive upper bound (current month)
  while (cur < lastComplete) {
    out.push({ year: cur.getFullYear(), monthIdx0: cur.getMonth(), startMs: cur.getTime() });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return out;
}

function stationHasData(stationId, startMs, endMs) {
  const db = getDb();
  const m = db.prepare("SELECT 1 FROM measurements WHERE station_id=? AND timestamp>=? AND timestamp<? LIMIT 1").get(stationId, startMs, endMs);
  if (m) return true;
  const e = db.prepare("SELECT 1 FROM events WHERE station_id=? AND start_ts>=? AND start_ts<? LIMIT 1").get(stationId, startMs, endMs);
  return !!e;
}

function zipPathFor(dir, station, year, monthIdx0) {
  // stationBase = safeName + station id → no cross-station filename collisions
  return path.join(dir, `${stationBase(station)}_${year}-${pad2(monthIdx0 + 1)}.zip`);
}

function readHealth() {
  try { return JSON.parse(getSetting('backup_health') || '{}') || {}; } catch (_) { return {}; }
}

function writeHealth(status, extra) {
  // Der letzte gelungene Datenbank-Abzug bleibt stehen, bis ein neuer gelingt: auch nach
  // einem gescheiterten Lauf ist so sichtbar, wie alt der neueste zurueckspielbare Stand ist,
  // und computePruneFloor weiss, bis wohin die Aufbewahrung loeschen darf.
  const prev = readHealth();
  saveSetting('backup_health', JSON.stringify(Object.assign({
    status, lastScan: new Date().toISOString(),
    lastDbSnapshot: prev.lastDbSnapshot || null, lastDbSnapshotAt: prev.lastDbSnapshotAt || null,
  }, extra || {})));
}

// Taeglicher Abzug der ganzen Datenbank (alle Tabellen, settings samt API-Schluessel) in
// <backup_dir>/datenbank/klima-JJJJ-MM-TT.db. Anders als die Monats-ZIPs ist er direkt
// zurueckspielbar (deploy/windows/README.md, "Datenbank zuruecksichern"). VACUUM INTO liest
// ueber diese Verbindung, sieht also auch Zeilen, die erst im WAL stehen, und schreibt eine
// eigenstaendige Datei ohne -wal.
const SNAPSHOT_KEEP = 7;
const SNAPSHOT_NAME = /^klima-\d{4}-\d{2}-\d{2}\.db$/;
const SNAPSHOT_LEFTOVER = /^klima-\d{4}-\d{2}-\d{2}\.db\.tmp(-journal)?$/; // Reste abgebrochener Laeufe

function writeDbSnapshot(dir, nowMs) {
  const snapDir = path.join(dir, 'datenbank');
  fs.mkdirSync(snapDir, { recursive: true });
  const name = `klima-${localDateKey(nowMs)}.db`; // Ortsdatum; toISOString() waere UTC
  const target = path.join(snapDir, name);
  const tmp = `${target}.tmp`;
  // VACUUM INTO scheitert an einem vorhandenen Ziel und hinterliesse bei einem Abbruch eine
  // halbe Datei: darum in .tmp, dann umbenennen. Ein harter Abbruch (Stop-ScheduledTask)
  // laesst die .tmp und das -journal der Ausgabe liegen, womoeglich von einem anderen Tag:
  // alle solchen Reste vorher weg, nichts sonst.
  // rename ersetzt den Abzug desselben Tages, unter Windows per MoveFileEx(REPLACE_EXISTING).
  // ponytail: synchron, 0,06 s fuer 45 MB auf lokaler SSD; auf einer langsamen Netzfreigabe
  // steht der Server einmal am Tag fuer die Schreibdauer. Stoert das: db.backup() (asynchron).
  for (const f of fs.readdirSync(snapDir)) {
    if (SNAPSHOT_LEFTOVER.test(f)) fs.rmSync(path.join(snapDir, f), { force: true });
  }
  try {
    getDb().prepare('VACUUM INTO ?').run(tmp); // Pfad als Parameter, nie im SQL-Text
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {} // der urspruengliche Fehler zaehlt
    throw e;
  }
  // Aufbewahrung erst nach gelungenem Abzug, nur fuer genau dieses Namensmuster, je Datei
  // einzeln: ein gesperrter Altabzug haelt die uebrigen nicht auf. Ein nicht loeschbarer
  // Altabzug ist kein Sicherungsfehler (sonst liefe der Abzug jeden Zyklus neu).
  const pruneErrors = [];
  const old = fs.readdirSync(snapDir).filter(f => SNAPSHOT_NAME.test(f)).sort().slice(0, -SNAPSHOT_KEEP);
  for (const f of old) {
    try { fs.rmSync(path.join(snapDir, f)); } catch (e) { pruneErrors.push(`${f}: ${e.message}`); }
  }
  return { name, pruneError: pruneErrors.join('; ') || null };
}

function runBackupScan(nowMs) {
  const result = { written: [], skipped: 0, errors: [] };
  const dir = resolveBackupDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    const msg = `backup_dir nicht beschreibbar: ${e.message}`;
    writeHealth('error', { lastError: msg, dbSnapshotError: msg });
    result.errors.push(msg); // wie in jedem Zweig: errors[0] === health.lastError
    return result;
  }

  const db = getDb();
  const stations = db.prepare("SELECT id, name, location, serial_no, model_code FROM stations").all();
  const dialect = getDialect(getSetting('csv_format'));
  const months = candidateMonths(nowMs);

  for (const st of stations) {
    for (const mth of months) {
      const endMs = monthStartMs(mth.year, mth.monthIdx0 + 1);
      const zipPath = zipPathFor(dir, st, mth.year, mth.monthIdx0);
      if (fs.existsSync(zipPath)) { result.skipped++; continue; }
      if (!stationHasData(st.id, mth.startMs, endMs)) continue;
      try {
        const files = stationFiles(st, { metricKeys: null, fromTs: mth.startMs, toTs: endMs - 1, includeEvents: true, dialect, nowMs });
        const buf = createZip(files.map(f => ({ name: f.name, data: f.data, mtime: new Date(nowMs) })));
        const tmp = zipPath + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, zipPath); // atomic on same volume
        result.written.push(path.basename(zipPath));
      } catch (e) {
        result.errors.push(`${st.name} ${mth.year}-${mth.monthIdx0 + 1}: ${e.message}`);
      }
    }
  }

  // Ein gescheiterter Abzug zaehlt wie ein ZIP-Fehler: status 'error', und maybeRunBackupScan
  // versucht es im naechsten Zyklus erneut.
  let snapshot = null, snapshotError = null;
  try {
    snapshot = writeDbSnapshot(dir, nowMs);
  } catch (e) {
    snapshotError = e.message;
    result.errors.push(`Datenbank-Abzug: ${e.message}`);
  }

  // Health is 'ok' or 'error'. (A post-scan un-backed data-month only occurs when a write
  // errored — already covered by errors.length — so an 'overdue' status is unreachable here.)
  writeHealth(result.errors.length ? 'error' : 'ok', {
    lastZip: result.written[result.written.length - 1] || null,
    lastError: result.errors[0] || null,
    written: result.written.length,
    ...(snapshot && { lastDbSnapshot: snapshot.name, lastDbSnapshotAt: new Date(nowMs).toISOString() }),
    dbSnapshotError: snapshotError,
    dbSnapshotPruneError: snapshot ? snapshot.pruneError : null,
  });
  return result;
}

// Ein Lauf samt Tagesvermerk, ohne Drossel: "Jetzt sichern" (POST /api/backup) ruft ihn direkt.
// Nur ein fehlerfreier Lauf verbraucht den Tagesversuch, nach einem Fehler versucht es der
// naechste Sync-Zyklus erneut. Durchgehend synchron (fs.*Sync, better-sqlite3, deflateRawSync):
// innerhalb des Prozesses kann ein Knopf-Lauf nie mit dem eines Zyklus ueberlappen.
function runBackupNow(nowMs) {
  const res = runBackupScan(nowMs);
  if (res.errors.length === 0) saveSetting('last_backup_scan_date', localDateKey(nowMs));
  return res;
}

// Der Tag gilt als gesichert, wenn heute ein Lauf gelang UND seither keiner scheiterte:
// nach einem gescheiterten Knopf-Lauf steht der Tagesvermerk schon auf heute, trotzdem soll
// jeder Zyklus es bis zur Behebung erneut versuchen, statt den Fehler bis morgen zu zeigen.
function maybeRunBackupScan(nowMs) {
  if ((getSetting('backup_enabled') || '1') !== '1') return false;
  if ((getSetting('last_backup_scan_date') || '') === localDateKey(nowMs) && readHealth().status !== 'error') return false;
  runBackupNow(nowMs);
  return true;
}

// Ergebnis des letzten Laufs in einer Zeile fuer app.log (Herzschlag und "Jetzt sichern").
function backupSummary(h) {
  return h.status === 'ok' ? `Abzug ${h.lastDbSnapshot}, ${h.written || 0} ZIP neu` : (h.lastError || 'unbekannter Fehler');
}

// Zeitpunkt, ab dem die Aufbewahrung nichts loeschen darf (scheduler.js Schritt 4 loescht nur
// unterhalb von min(retentionCutoff, floor)). Bei eingeschalteter Sicherung gilt: nichts, was
// in keiner Sicherung steht. Also hoechstens der letzte gelungene Datenbank-Abzug (was
// juenger ist, steht in keinem Abzug; gab es noch keinen, -Infinity = gar nichts loeschen)
// und hoechstens der Beginn des aeltesten Datenmonats ohne ZIP. Sicherung aus: Infinity,
// dann gilt nur retention_days.
function computePruneFloor(nowMs) {
  if ((getSetting('backup_enabled') || '1') !== '1') return Infinity;
  const lastSnapshotMs = Date.parse(readHealth().lastDbSnapshotAt);
  if (Number.isNaN(lastSnapshotMs)) return -Infinity;
  const dir = resolveBackupDir();
  const db = getDb();
  const stations = db.prepare("SELECT id, name FROM stations").all();
  const months = candidateMonths(nowMs);
  let floor = lastSnapshotMs;
  for (const mth of months) {
    const endMs = monthStartMs(mth.year, mth.monthIdx0 + 1);
    for (const st of stations) {
      if (!stationHasData(st.id, mth.startMs, endMs)) continue;
      const zp = zipPathFor(dir, st, mth.year, mth.monthIdx0);
      if (!fs.existsSync(zp)) { floor = Math.min(floor, mth.startMs); break; }
    }
  }
  return floor;
}

module.exports = { resolveBackupDir, monthStartMs, runBackupScan, runBackupNow, maybeRunBackupScan, computePruneFloor, readHealth, backupSummary };
