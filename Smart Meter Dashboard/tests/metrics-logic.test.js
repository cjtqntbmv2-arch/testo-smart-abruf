const test = require('node:test');
const assert = require('node:assert');
const { metricAlertState, metricAlertStatus, metricTrend } = require('../metrics-logic.js');

test('metricAlertStatus: active alarm outranks warning', () => {
  const events = [
    { active: true, severity: 'warning', metric: 'temperature' },
    { active: true, severity: 'alarm', metric: 'temperature' },
  ];
  assert.strictEqual(metricAlertStatus(events, 'temperature'), 'alarm');
  assert.strictEqual(metricAlertStatus([
    { active: true, severity: 'alarm', metric: 'temperature' },
    { active: true, severity: 'warning', metric: 'temperature' },
  ], 'temperature'), 'alarm');
});

test('metricAlertStatus: only active warning -> warning', () => {
  assert.strictEqual(
    metricAlertStatus([{ active: true, severity: 'warning', metric: 'humidity' }], 'humidity'),
    'warning'
  );
});

test('metricAlertStatus: inactive events ignored', () => {
  assert.strictEqual(
    metricAlertStatus([{ active: false, severity: 'alarm', metric: 'temperature' }], 'temperature'),
    null
  );
});

test('metricAlertStatus: system events ignored', () => {
  assert.strictEqual(
    metricAlertStatus([{ active: true, severity: 'system', metric: 'temperature' }], 'temperature'),
    null
  );
});

test('metricAlertStatus: other metric ignored', () => {
  assert.strictEqual(
    metricAlertStatus([{ active: true, severity: 'alarm', metric: 'pressure' }], 'temperature'),
    null
  );
});

test('metricAlertStatus: non-array / missing id -> null', () => {
  assert.strictEqual(metricAlertStatus(null, 'temperature'), null);
  assert.strictEqual(metricAlertStatus([{ active: true, severity: 'alarm', metric: 'temperature' }], null), null);
});

test('metricTrend: 1h window delta and pct', () => {
  const H = 3600000, t0 = 1_000_000_000_000;
  const r = metricTrend([18, 20, 23], [t0, t0 + H, t0 + 2 * H], H);
  assert.strictEqual(r.hasTrend, true);
  assert.strictEqual(r.last, 23);
  assert.strictEqual(r.ref, 20);
  assert.strictEqual(r.delta, 3);
  assert.ok(Math.abs(r.pct - 15) < 1e-9);
});

test('metricTrend: falls back to earliest when series shorter than window', () => {
  const H = 3600000, t0 = 1_000_000_000_000;
  const r = metricTrend([10, 12], [t0, t0 + 10 * 60000], H);
  assert.strictEqual(r.hasTrend, true);
  assert.strictEqual(r.ref, 10);
  assert.strictEqual(r.delta, 2);
});

test('metricTrend: all NaN -> no trend', () => {
  assert.strictEqual(metricTrend([NaN, NaN], [1, 2], 3600000).hasTrend, false);
});

test('metricTrend: empty series -> no trend', () => {
  assert.strictEqual(metricTrend([], [], 3600000).hasTrend, false);
});

test('metricTrend: ref 0 uses ||1 to avoid divide-by-zero', () => {
  const H = 3600000, t0 = 1e12;
  const r = metricTrend([0, 5], [t0, t0 + H], H);
  assert.strictEqual(r.ref, 0);
  assert.strictEqual(r.delta, 5);
  assert.strictEqual(r.pct, 500);
});

test('metricTrend: mismatched timestamps length -> earliest-value fallback', () => {
  // timestamps.length !== series.length => time window unusable; ref = earliest finite value.
  const r = metricTrend([10, 14, 17], [1, 2], 3600000);
  assert.strictEqual(r.hasTrend, true);
  assert.strictEqual(r.ref, 10);
  assert.strictEqual(r.delta, 7);
});

test('metricTrend: negative ref -> pct sign follows delta (magnitude baseline)', () => {
  const H = 3600000, t0 = 1e12;
  const r = metricTrend([-10, -5], [t0, t0 + H], H);
  assert.strictEqual(r.ref, -10);
  assert.strictEqual(r.delta, 5);
  assert.strictEqual(r.pct, 50); // 5 / |−10| * 100, positive like delta
});

test('metricTrend: single-element series -> no trend', () => {
  assert.strictEqual(metricTrend([5], [1e12], 3600000).hasTrend, false);
});

test('metricTrend: null gap in series is skipped', () => {
  const H = 3600000, t0 = 1e12;
  const r = metricTrend([10, null, 14], [t0, t0 + H, t0 + 2 * H], H);
  assert.strictEqual(r.hasTrend, true);
  assert.strictEqual(r.ref, 10);
  assert.strictEqual(r.last, 14);
});

test('metricAlertState: high alarm -> severity alarm, direction high', () => {
  const events = [{ active: true, severity: 'alarm', metric: 'temperature', condition: 'high' }];
  assert.deepStrictEqual(metricAlertState(events, 'temperature'), { severity: 'alarm', direction: 'high' });
});

test('metricAlertState: low warning -> severity warning, direction low', () => {
  const events = [{ active: true, severity: 'warning', metric: 'humidity', condition: 'low' }];
  assert.deepStrictEqual(metricAlertState(events, 'humidity'), { severity: 'warning', direction: 'low' });
});

test('metricAlertState: alarm outranks warning and keeps the alarm direction', () => {
  const events = [
    { active: true, severity: 'warning', metric: 'temperature', condition: 'high' },
    { active: true, severity: 'alarm', metric: 'temperature', condition: 'low' },
  ];
  assert.deepStrictEqual(metricAlertState(events, 'temperature'), { severity: 'alarm', direction: 'low' });
});

test('metricAlertState: first active warning wins its direction', () => {
  const events = [
    { active: true, severity: 'warning', metric: 'temperature', condition: 'high' },
    { active: true, severity: 'warning', metric: 'temperature', condition: 'low' },
  ];
  assert.deepStrictEqual(metricAlertState(events, 'temperature'), { severity: 'warning', direction: 'high' });
});

test('metricAlertState: missing condition defaults to high', () => {
  const events = [{ active: true, severity: 'warning', metric: 'pressure' }];
  assert.deepStrictEqual(metricAlertState(events, 'pressure'), { severity: 'warning', direction: 'high' });
});

test('metricAlertState: inactive / system / other-metric -> {null,null}', () => {
  assert.deepStrictEqual(metricAlertState([{ active: false, severity: 'alarm', metric: 'temperature', condition: 'high' }], 'temperature'), { severity: null, direction: null });
  assert.deepStrictEqual(metricAlertState([{ active: true, severity: 'system', metric: 'temperature' }], 'temperature'), { severity: null, direction: null });
  assert.deepStrictEqual(metricAlertState([{ active: true, severity: 'alarm', metric: 'pressure', condition: 'high' }], 'temperature'), { severity: null, direction: null });
});

test('metricAlertState: non-array / missing id -> {null,null}', () => {
  assert.deepStrictEqual(metricAlertState(null, 'temperature'), { severity: null, direction: null });
  assert.deepStrictEqual(metricAlertState([{ active: true, severity: 'alarm', metric: 'temperature', condition: 'high' }], null), { severity: null, direction: null });
});
