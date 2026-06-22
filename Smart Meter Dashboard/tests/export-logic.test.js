const test = require('node:test');
const assert = require('node:assert');
const { presetRange, unionMetrics, buildExportPayload, parseFilename } = require('../export-logic.js');

test('presetRange: lastMonth spans the previous calendar month', () => {
  const now = Date.UTC(2026, 5, 10, 9, 0, 0); // June 10
  const { fromTs, toTs } = presetRange('lastMonth', now);
  assert.strictEqual(new Date(fromTs).getMonth(), 4); // May local — logic uses local date math, assert local month
  assert.ok(toTs > fromTs);
});

test('presetRange: last7 is ~7 days wide', () => {
  const now = Date.UTC(2026, 5, 10);
  const { fromTs, toTs } = presetRange('last7', now);
  assert.ok(toTs - fromTs >= 6 * 86400000 && toTs - fromTs <= 7 * 86400000 + 1000);
});

test('unionMetrics: dedupes across stations, keeps label/unit', () => {
  const stations = [
    { id: 's1', metrics: [{ key: 'temperature', unit: '°C' }] },
    { id: 's2', metrics: [{ key: 'temperature', unit: '°C' }, { key: 'humidity', unit: '%rF' }] },
  ];
  const u = unionMetrics(stations, ['s1', 's2']);
  assert.deepStrictEqual(u.map(m => m.key).sort(), ['humidity', 'temperature']);
});

test('buildExportPayload: maps UI state to API body', () => {
  const p = buildExportPayload({ stationIds: ['s1'], metricKeys: ['temperature'], fromTs: 1, toTs: 2, includeEvents: true, dialect: 'rfc' });
  assert.deepStrictEqual(p, { stationIds: ['s1'], metrics: ['temperature'], from: 1, to: 2, includeEvents: true, dialect: 'rfc' });
});

test('parseFilename: extracts filename* then filename', () => {
  assert.strictEqual(parseFilename("attachment; filename=\"a.csv\"; filename*=UTF-8''Serverraum_messwerte.csv"), 'Serverraum_messwerte.csv');
  assert.strictEqual(parseFilename('attachment; filename="x.zip"'), 'x.zip');
  assert.strictEqual(parseFilename(null), null);
});
