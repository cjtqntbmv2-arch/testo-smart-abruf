// backend/export-service.js
// DB-bound orchestration: queries + builds CSV or ZIP. Shared by manual export and backup.
const { getDb } = require('./db');
const { getDialect } = require('./csv-format');
const { buildMeasurementsCsv, buildEventsCsv, METRIC_ORDER, METRIC_LABELS } = require('./csv-export');
const { createZip } = require('./zip-writer');
const APP_VERSION = require('../package.json').version || '0.0.0';

function safeFileName(name) {
  return String(name || 'Messstelle')
    .replace(/[<>:"/\\|?* ]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || 'Messstelle';
}

function queryMeasurements(stationId, fromTs, toTs, metricKeys) {
  const db = getDb();
  let sql = "SELECT timestamp, value, physical_property, unit FROM measurements WHERE station_id = ? AND timestamp >= ? AND timestamp <= ?";
  const args = [stationId, fromTs, toTs];
  if (Array.isArray(metricKeys) && metricKeys.length) {
    sql += ` AND physical_property IN (${metricKeys.map(() => '?').join(',')})`;
    args.push(...metricKeys);
  }
  sql += " ORDER BY timestamp ASC";
  return db.prepare(sql).all(...args);
}

function queryEvents(stationId, fromTs, toTs) {
  return getDb().prepare(
    "SELECT start_ts, end_ts, severity, metric, threshold, alarm_status, alarm_reason, alarm_value, extreme, message, detail FROM events WHERE station_id = ? AND start_ts >= ? AND start_ts <= ? ORDER BY start_ts ASC"
  ).all(stationId, fromTs, toTs);
}

function getStation(stationId) {
  return getDb().prepare("SELECT id, name, location, serial_no, model_code FROM stations WHERE id = ?").get(stationId);
}

// Filename base unique per station: name PLUS station id, so two stations whose names
// sanitize to the same string cannot collide (collision = silent data loss via the prune floor).
function stationBase(station) {
  return `${safeFileName(station.name)}_${safeFileName(String(station.id))}`;
}

function getExportMetadata() {
  const db = getDb();
  const stations = db.prepare("SELECT id, name FROM stations ORDER BY name").all();
  return stations.map(s => {
    const metrics = db.prepare("SELECT DISTINCT physical_property AS key, unit FROM measurements WHERE station_id = ?").all(s.id)
      .map(r => ({ key: r.key, label: METRIC_LABELS[r.key] || r.key, unit: r.unit }))
      .sort((a, b) => METRIC_ORDER.indexOf(a.key) - METRIC_ORDER.indexOf(b.key));
    const range = db.prepare("SELECT MIN(timestamp) AS earliest_ts, MAX(timestamp) AS latest_ts FROM measurements WHERE station_id = ?").get(s.id);
    return { id: s.id, name: s.name, metrics, earliest_ts: range.earliest_ts, latest_ts: range.latest_ts };
  });
}

// Build the per-station CSV file objects ({name, data}) for the ZIP / single download.
function stationFiles(station, { metricKeys, fromTs, toTs, includeEvents, dialect, nowMs }) {
  const base = stationBase(station);
  const files = [];
  const rows = queryMeasurements(station.id, fromTs, toTs, metricKeys);
  files.push({ name: `${base}_messwerte.csv`, data: buildMeasurementsCsv({ station, rows, metricKeys, fromTs, toTs, dialect, appVersion: APP_VERSION, nowMs }) });
  if (includeEvents) {
    const events = queryEvents(station.id, fromTs, toTs);
    files.push({ name: `${base}_meldungen.csv`, data: buildEventsCsv({ station, events, fromTs, toTs, dialect, appVersion: APP_VERSION, nowMs }) });
  }
  return files;
}

function exportStations({ stationIds, metricKeys, fromTs, toTs, includeEvents, dialectName, nowMs }) {
  const dialect = getDialect(dialectName);
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const opts = { metricKeys, fromTs, toTs, includeEvents, dialect, nowMs: now };

  const stations = stationIds.map(getStation).filter(Boolean);
  if (stations.length === 0) throw new Error('Keine gültige Messstelle ausgewählt');

  // Single CSV only when exactly one station and no events file.
  if (stations.length === 1 && !includeEvents) {
    const files = stationFiles(stations[0], opts);
    return {
      kind: 'csv', mime: 'text/csv; charset=utf-8',
      filename: files[0].name, // already `${stationBase}_messwerte.csv`
      buffer: Buffer.from(files[0].data, 'utf8'),
    };
  }

  const entries = [];
  for (const st of stations) for (const f of stationFiles(st, opts)) entries.push({ name: f.name, data: f.data, mtime: new Date(now) });
  return {
    kind: 'zip', mime: 'application/zip',
    filename: stations.length === 1 ? `${stationBase(stations[0])}_export.zip` : `messwert-export.zip`,
    buffer: createZip(entries),
  };
}

module.exports = { safeFileName, stationBase, queryMeasurements, queryEvents, getExportMetadata, exportStations, stationFiles };
