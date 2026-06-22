// backend/tests/csv-export.test.js
const test = require('node:test');
const assert = require('node:assert');
const { pivotMeasurements, classifyEventArt, buildMeasurementsCsv, buildEventsCsv } = require('../csv-export');
const { getDialect } = require('../csv-format');

const STATION = { name: 'Serverraum EG', location: 'Geb A', serial_no: '12345678', model_code: '0572 2620' };
const DE = getDialect('de');

test('pivotMeasurements: groups by timestamp, one column per metric, blanks for gaps', () => {
  const rows = [
    { timestamp: 1000, value: 21.0, physical_property: 'temperature', unit: '°C' },
    { timestamp: 1000, value: 45.0, physical_property: 'humidity', unit: '%rF' },
    { timestamp: 2000, value: 21.5, physical_property: 'temperature', unit: '°C' },
    // no humidity at 2000 → blank
  ];
  const { columns, data } = pivotMeasurements(rows, ['temperature', 'humidity']);
  assert.deepStrictEqual(columns.map(c => c.key), ['temperature', 'humidity']);
  assert.strictEqual(data.length, 2);
  assert.strictEqual(data[0].ts, 1000);
  assert.strictEqual(data[0].values.get('humidity'), 45.0);
  assert.strictEqual(data[1].values.has('humidity'), false);
});

test('classifyEventArt: classifies on severity, not metric', () => {
  assert.strictEqual(classifyEventArt({ severity: 'alarm', metric: 'temperature' }), 'Alarm');
  assert.strictEqual(classifyEventArt({ severity: 'warning', metric: 'humidity' }), 'Alarm');
  // regression: a SYSTEM event that carries a measured metric must NOT be 'Alarm'
  assert.strictEqual(classifyEventArt({ severity: 'system', metric: 'temperature' }), 'Meldung');
  assert.strictEqual(classifyEventArt({ severity: 'system', metric: null }), 'Meldung');
});

test('buildMeasurementsCsv: BOM, header block, CRLF table, decimal per dialect', () => {
  const rows = [{ timestamp: Date.UTC(2026,4,1,10,0,0), value: 21.3, physical_property: 'temperature', unit: '°C' }];
  const csv = buildMeasurementsCsv({ station: STATION, rows, metricKeys: ['temperature'], fromTs: 0, toTs: 9e15, dialect: DE, appVersion: '0.11.0', nowMs: Date.UTC(2026,5,1,1,0,0) });
  assert.ok(csv.startsWith('﻿'), 'has BOM');
  assert.ok(csv.includes('Messstelle;Serverraum EG'), 'header block has station');
  assert.ok(csv.includes('Temperatur [°C]'), 'column label');
  assert.ok(csv.includes('21,3'), 'decimal comma');
  assert.ok(csv.includes('\r\n'), 'CRLF');
});

test('buildMeasurementsCsv: empty data => header-only + note', () => {
  const csv = buildMeasurementsCsv({ station: STATION, rows: [], metricKeys: ['temperature'], fromTs: 0, toTs: 1, dialect: DE, appVersion: '0.11.0', nowMs: 0 });
  assert.ok(csv.includes('# Keine Daten im gewählten Zeitraum'));
});

test('buildMeasurementsCsv: CSV-injection guard neutralizes a malicious station name (end-to-end)', () => {
  const evil = { name: '=HYPERLINK("http://x")', location: '+x', serial_no: '1', model_code: 'M' };
  const csv = buildMeasurementsCsv({ station: evil, rows: [], metricKeys: ['temperature'], fromTs: 0, toTs: 1, dialect: DE, appVersion: '0.11.0', nowMs: 0 });
  assert.ok(csv.includes("'=HYPERLINK"), "leading '=' prefixed with an apostrophe in the header block");
});

test('buildEventsCsv: columns + Art + open end empty', () => {
  const events = [
    { start_ts: Date.UTC(2026,4,2,8,0,0), end_ts: null, severity: 'alarm', metric: 'temperature', threshold: 8, alarm_status: 'Alarm', alarm_reason: 'Upper limit', alarm_value: 9.1, extreme: 9.4, message: 'Temp zu hoch', detail: '' },
  ];
  const csv = buildEventsCsv({ station: STATION, events, fromTs: 0, toTs: 9e15, dialect: DE, appVersion: '0.11.0', nowMs: 0 });
  assert.ok(csv.includes('Start (ISO);Start (lokal);Ende (ISO);Ende (lokal);Art;'));
  assert.ok(csv.includes(';Alarm;'), 'Art column = Alarm');
  assert.ok(csv.includes('Temp zu hoch'));
});
