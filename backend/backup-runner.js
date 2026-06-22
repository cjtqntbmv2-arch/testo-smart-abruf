// backend/backup-runner.js
// Monthly per-station ZIP backups + retention prune-floor. DB + filesystem.
const fs = require('node:fs');
const path = require('node:path');
const { getDb, getSetting, saveSetting } = require('./db');
const { getDialect } = require('./csv-format');
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

function pad2(n) { return String(n).padStart(2, '0'); }
function monthKey(epochMs) { const d = new Date(epochMs); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
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

function writeHealth(status, extra) {
  saveSetting('backup_health', JSON.stringify(Object.assign({ status, lastScan: new Date().toISOString() }, extra || {})));
}

function runBackupScan(nowMs) {
  const result = { written: [], skipped: 0, errors: [] };
  const dir = resolveBackupDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    writeHealth('error', { lastError: `backup_dir nicht beschreibbar: ${e.message}` });
    result.errors.push(e.message);
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

  // Health is 'ok' or 'error'. (A post-scan un-backed data-month only occurs when a write
  // errored — already covered by errors.length — so an 'overdue' status is unreachable here.)
  writeHealth(result.errors.length ? 'error' : 'ok', {
    lastZip: result.written[result.written.length - 1] || null,
    lastError: result.errors[0] || null,
    written: result.written.length,
  });
  return result;
}

function maybeRunBackupScan(nowMs) {
  if ((getSetting('backup_enabled') || '1') !== '1') return false;
  const today = localDateKey(nowMs);
  if ((getSetting('last_backup_scan_date') || '') === today) return false;
  const res = runBackupScan(nowMs);
  if (res.errors.length === 0) saveSetting('last_backup_scan_date', today); // retry next cycle on error
  return true;
}

// Oldest start-of-month that has data but no backup zip (or Infinity if none / disabled).
function computePruneFloor(nowMs) {
  if ((getSetting('backup_enabled') || '1') !== '1') return Infinity;
  const dir = resolveBackupDir();
  const db = getDb();
  const stations = db.prepare("SELECT id, name FROM stations").all();
  const months = candidateMonths(nowMs);
  let floor = Infinity;
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

module.exports = { resolveBackupDir, monthKey, monthStartMs, candidateMonths, runBackupScan, maybeRunBackupScan, computePruneFloor, lookbackMs };
