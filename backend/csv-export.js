// backend/csv-export.js
// Pure CSV table builders (measurements wide-pivot + events). No DB access.
const { formatNumber, escapeField, joinRow, formatTimestamps, BOM } = require('./csv-format');

const METRIC_LABELS = {
  temperature: 'Temperatur', humidity: 'Feuchte', pressure: 'Druck',
  dewpoint: 'Taupunkt', abshumid: 'Absolute Feuchte',
};
const METRIC_ORDER = ['temperature', 'humidity', 'pressure', 'dewpoint', 'abshumid'];
const MEASURED_METRICS = new Set(METRIC_ORDER);

function labelFor(key) { return METRIC_LABELS[key] || key; }

// Pivot long rows ({timestamp, value, physical_property, unit}) into wide form.
function pivotMeasurements(rows, metricKeys) {
  const unitByKey = new Map();
  for (const r of rows) if (!unitByKey.has(r.physical_property)) unitByKey.set(r.physical_property, r.unit);

  let keys;
  if (Array.isArray(metricKeys) && metricKeys.length) {
    keys = metricKeys.slice();
  } else {
    const present = new Set(rows.map(r => r.physical_property));
    keys = [...METRIC_ORDER.filter(k => present.has(k)), ...[...present].filter(k => !MEASURED_METRICS.has(k)).sort()];
  }
  const columns = keys.map(k => ({ key: k, label: labelFor(k), unit: unitByKey.get(k) || '' }));

  const byTs = new Map();
  for (const r of rows) {
    if (!keys.includes(r.physical_property)) continue;
    if (!byTs.has(r.timestamp)) byTs.set(r.timestamp, new Map());
    byTs.get(r.timestamp).set(r.physical_property, r.value);
  }
  const data = [...byTs.keys()].sort((a, b) => a - b).map(ts => ({ ts, values: byTs.get(ts) }));
  return { columns, data };
}

function classifyEventArt(event) {
  // Classify on the authoritative `severity` column, NOT on `metric` membership:
  // system events (connection/battery) ALSO carry a measured metric like 'temperature'
  // (scheduler.js stores mapPhysicalProperty() unconditionally; ~193 such rows live),
  // so a metric-based test would mislabel them 'Alarm'. severity==='system' is set by
  // both event write paths (applySystemEvents + classifyAlarm).
  return (event && event.severity === 'system') ? 'Meldung' : 'Alarm';
}

function headerBlock(lines, dialect) {
  // lines: [[key, value], …] — values escaped (may contain delimiter).
  return lines.map(([k, v]) => joinRow([escapeField(k, dialect), escapeField(String(v), dialect)], dialect)).join('');
}

function buildMeasurementsCsv({ station, rows, metricKeys, fromTs, toTs, dialect, appVersion, nowMs }) {
  const { columns, data } = pivotMeasurements(rows, metricKeys);
  const created = formatTimestamps(nowMs);
  const from = formatTimestamps(fromTs), to = formatTimestamps(toTs);
  const channelList = columns.map(c => `${c.label} [${c.unit}]`).join(' · ');

  let out = BOM;
  out += headerBlock([
    ['testo Smart Abruf', 'Messwert-Export'],
    ['Anwendung', `testo-smart-abruf ${appVersion}`],
    ['Erstellt am', `${created.iso} (${created.local})`],
    ['Messstelle', station.name || ''],
    ['Standort', station.location || ''],
    ['Seriennummer', station.serial_no || ''],
    ['Modell', station.model_code || ''],
    ['Zeitraum von', from.iso],
    ['Zeitraum bis', to.iso],
    ['Kanäle', channelList],
    ['Datensätze', String(data.length)],
    ['CSV-Format', `${dialect.label}: Trennzeichen '${dialect.delimiter}', Dezimal '${dialect.decimal}'`],
  ], dialect);
  out += joinRow([''], dialect); // blank separator line

  const head = ['Zeitpunkt (ISO)', 'Zeitpunkt (lokal)', ...columns.map(c => `${c.label} [${c.unit}]`)];
  out += joinRow(head.map(h => escapeField(h, dialect)), dialect);

  if (data.length === 0) {
    out += joinRow([escapeField('# Keine Daten im gewählten Zeitraum', dialect)], dialect);
    return out;
  }
  for (const row of data) {
    const ts = formatTimestamps(row.ts);
    const cells = [escapeField(ts.iso, dialect), escapeField(ts.local, dialect)];
    for (const c of columns) cells.push(formatNumber(row.values.has(c.key) ? row.values.get(c.key) : null, dialect));
    out += joinRow(cells, dialect);
  }
  return out;
}

function buildEventsCsv({ station, events, fromTs, toTs, dialect, appVersion, nowMs }) {
  const created = formatTimestamps(nowMs);
  const from = formatTimestamps(fromTs), to = formatTimestamps(toTs);

  let out = BOM;
  out += headerBlock([
    ['testo Smart Abruf', 'Meldungen & Alarme'],
    ['Anwendung', `testo-smart-abruf ${appVersion}`],
    ['Erstellt am', `${created.iso} (${created.local})`],
    ['Messstelle', station.name || ''],
    ['Standort', station.location || ''],
    ['Seriennummer', station.serial_no || ''],
    ['Zeitraum von', from.iso],
    ['Zeitraum bis', to.iso],
    ['Anzahl', String(events.length)],
    ['CSV-Format', `${dialect.label}: Trennzeichen '${dialect.delimiter}', Dezimal '${dialect.decimal}'`],
  ], dialect);
  out += joinRow([''], dialect);

  const head = ['Start (ISO)', 'Start (lokal)', 'Ende (ISO)', 'Ende (lokal)', 'Art', 'Schweregrad',
    'Messgröße', 'Status', 'Grund', 'Auslösewert', 'Schwelle', 'Extremwert', 'Meldungstext', 'Detail'];
  out += joinRow(head.map(h => escapeField(h, dialect)), dialect);

  if (events.length === 0) {
    out += joinRow([escapeField('# Keine Meldungen im gewählten Zeitraum', dialect)], dialect);
    return out;
  }
  const sorted = events.slice().sort((a, b) => a.start_ts - b.start_ts);
  for (const e of sorted) {
    const s = formatTimestamps(e.start_ts);
    const en = (e.end_ts === null || e.end_ts === undefined) ? { iso: '', local: '' } : formatTimestamps(e.end_ts);
    out += joinRow([
      escapeField(s.iso, dialect), escapeField(s.local, dialect),
      escapeField(en.iso, dialect), escapeField(en.local, dialect),
      escapeField(classifyEventArt(e), dialect),
      escapeField(e.severity || '', dialect),
      escapeField(e.metric ? labelFor(e.metric) : '', dialect),
      escapeField(e.alarm_status || '', dialect),
      escapeField(e.alarm_reason || '', dialect),
      formatNumber(typeof e.alarm_value === 'number' ? e.alarm_value : null, dialect),
      formatNumber(typeof e.threshold === 'number' ? e.threshold : null, dialect),
      formatNumber(typeof e.extreme === 'number' ? e.extreme : null, dialect),
      escapeField(e.message || '', dialect),
      escapeField(e.detail || '', dialect),
    ], dialect);
  }
  return out;
}

module.exports = { METRIC_LABELS, METRIC_ORDER, pivotMeasurements, classifyEventArt, buildMeasurementsCsv, buildEventsCsv };
