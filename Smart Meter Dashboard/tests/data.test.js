// Pure, side-effect-free pieces of data.js (formatting, derivation, error normalisation).
// data.js is otherwise a fetch/DOM/timer-driven IIFE — see the require() below and the
// dual-export block at the bottom of data.js for how these stay reachable from Node
// without starting the poll loop. Nothing here touches fetch, DOM or timers.
const test = require('node:test');
const assert = require('node:assert');
const {
  alarmDirection, mapBackendEvent, friendlyError, formatNumber, stats, formatValue, formatTime, formatDuration,
} = require('../data.js');

// ---------- formatNumber ----------

test('formatNumber: formats to the metric\'s decimal count', () => {
  assert.strictEqual(formatNumber({ decimals: 1 }, 21.456), '21.5');
  assert.strictEqual(formatNumber({ decimals: 0 }, 55.4), '55');
  assert.strictEqual(formatNumber({ decimals: 2 }, 12.3), '12.30');
});

test('formatNumber: null/undefined/NaN render as an em dash', () => {
  assert.strictEqual(formatNumber({ decimals: 1 }, null), '—');
  assert.strictEqual(formatNumber({ decimals: 1 }, undefined), '—');
  assert.strictEqual(formatNumber({ decimals: 1 }, NaN), '—');
});

test('formatNumber: zero is a real value, not treated as missing', () => {
  assert.strictEqual(formatNumber({ decimals: 1 }, 0), '0.0');
});

test('formatNumber: negative values', () => {
  assert.strictEqual(formatNumber({ decimals: 1 }, -5.26), '-5.3');
});

// ---------- formatValue ----------

test('formatValue: appends the metric unit', () => {
  assert.strictEqual(formatValue({ decimals: 1, unit: '°C' }, 21.456), '21.5 °C');
  assert.strictEqual(formatValue({ decimals: 0, unit: '%' }, 55.4), '55 %');
});

test('formatValue: a missing value stays an em dash without a unit', () => {
  assert.strictEqual(formatValue({ decimals: 1, unit: '°C' }, null), '—');
});

// ---------- formatTime ----------
// Constructed with the local-time Date(...) form (not Date.UTC), so both the input
// and toLocaleTimeString's output use the same timezone regardless of which one the
// test machine runs in.

test('formatTime: formats as 24h HH:MM (de-DE)', () => {
  const ts = new Date(2026, 0, 15, 14, 5, 0).getTime();
  assert.strictEqual(formatTime(ts), '14:05');
});

test('formatTime: pads a single-digit hour and minute', () => {
  const ts = new Date(2026, 0, 15, 9, 3, 0).getTime();
  assert.strictEqual(formatTime(ts), '09:03');
});

// ---------- alarmDirection ----------

test('alarmDirection: recognizes upper/high/max/ober/hoch tokens as high', () => {
  for (const c of ['UpperLimit', 'HighLimit', 'MaxAlarm', 'Oberer Grenzwert', 'zu hoch']) {
    assert.strictEqual(alarmDirection(c), 'high', c);
  }
});

test('alarmDirection: recognizes lower/low/min/unter/niedrig tokens as low', () => {
  for (const c of ['LowerLimit', 'low limit', 'MinAlarm', 'Unterer Grenzwert', 'zu niedrig']) {
    assert.strictEqual(alarmDirection(c), 'low', c);
  }
});

test('alarmDirection: case-insensitive', () => {
  assert.strictEqual(alarmDirection('UPPERLIMIT'), 'high');
  assert.strictEqual(alarmDirection('LOWERLIMIT'), 'low');
});

test('alarmDirection: falsy input defaults to high — intentionally diverges from the ' +
  'backend\'s alarmConditionDirection(), which returns null there (see the comment ' +
  'above the function in data.js)', () => {
  assert.strictEqual(alarmDirection(null), 'high');
  assert.strictEqual(alarmDirection(undefined), 'high');
  assert.strictEqual(alarmDirection(''), 'high');
});

test('alarmDirection: unrecognized text also falls back to high (same documented ' +
  'fallback, reached through the other branch — the string is truthy but matches ' +
  'neither token list)', () => {
  assert.strictEqual(alarmDirection('firmware_update'), 'high');
});

// ---------- stats ----------

test('stats: min/max/avg/first/last over a plain array', () => {
  assert.deepStrictEqual(stats([1, 2, 3]), { min: 1, max: 3, avg: 2, last: 3, first: 1 });
});

test('stats: ignores null/undefined/NaN gaps', () => {
  const r = stats([5, NaN, 3, null, undefined, 8]);
  assert.strictEqual(r.min, 3);
  assert.strictEqual(r.max, 8);
  assert.strictEqual(r.avg, (5 + 3 + 8) / 3);
  assert.strictEqual(r.first, 5);
  assert.strictEqual(r.last, 8);
});

test('stats: empty array returns all NaN', () => {
  assert.deepStrictEqual(stats([]), { min: NaN, max: NaN, avg: NaN, last: NaN, first: NaN });
});

test('stats: null/undefined input is treated as empty', () => {
  assert.deepStrictEqual(stats(null), { min: NaN, max: NaN, avg: NaN, last: NaN, first: NaN });
  assert.deepStrictEqual(stats(undefined), { min: NaN, max: NaN, avg: NaN, last: NaN, first: NaN });
});

test('stats: single-element array', () => {
  assert.deepStrictEqual(stats([7]), { min: 7, max: 7, avg: 7, last: 7, first: 7 });
});

// ---------- formatDuration ----------

test('formatDuration: non-finite input renders an em dash', () => {
  assert.strictEqual(formatDuration(NaN), '—');
  assert.strictEqual(formatDuration(Infinity), '—');
  assert.strictEqual(formatDuration(null), '—');
});

test('formatDuration: under 30s rounds down to "< 1 min"', () => {
  assert.strictEqual(formatDuration(0), '< 1 min');
  assert.strictEqual(formatDuration(29999), '< 1 min');
});

test('formatDuration: rounds to whole minutes under an hour', () => {
  assert.strictEqual(formatDuration(30000), '1 min');
  assert.strictEqual(formatDuration(45 * 60000), '45 min');
});

test('formatDuration: hours and minutes', () => {
  assert.strictEqual(formatDuration(90 * 60000), '1 h 30 min');
});

test('formatDuration: an exact hour omits the minutes part', () => {
  assert.strictEqual(formatDuration(120 * 60000), '2 h');
});

// ---------- mapBackendEvent ----------

test('mapBackendEvent: maps a full alarm row to the frontend shape', () => {
  const row = {
    uuid: 'abc-1', severity: 'alarm', alarm_condition_type: 'UpperLimit',
    detail: 'custom detail', metric: 'Temperature', threshold: 30,
    start_ts: 1000, end_ts: 2000, extreme: 45.1, active: 1, _rowid: 7,
  };
  assert.deepStrictEqual(mapBackendEvent(row), {
    id: 'abc-1', severity: 'alarm', system: null,
    message: 'Grenzwert verletzt', detail: 'custom detail',
    metric: 'temperature', condition: 'high', threshold: 30,
    startTs: 1000, endTs: 2000, extreme: 45.1, active: true, _rowid: 7,
  });
});

test('mapBackendEvent: system severity without a condition type defaults to maintenance', () => {
  assert.strictEqual(mapBackendEvent({ severity: 'system', active: 1 }).system, 'maintenance');
});

test('mapBackendEvent: system severity keeps a given condition type', () => {
  assert.strictEqual(mapBackendEvent({ severity: 'system', alarm_condition_type: 'battery_low' }).system, 'battery_low');
});

test('mapBackendEvent: non-system severity never sets system', () => {
  assert.strictEqual(mapBackendEvent({ severity: 'alarm', alarm_condition_type: 'UpperLimit' }).system, null);
});

test('mapBackendEvent: message falls back message -> alarm_reason -> default text', () => {
  assert.strictEqual(mapBackendEvent({ severity: 'alarm', message: 'Custom', alarm_reason: 'reason' }).message, 'Custom');
  assert.strictEqual(mapBackendEvent({ severity: 'alarm', alarm_reason: 'Sensor kaputt' }).message, 'Sensor kaputt');
  assert.strictEqual(mapBackendEvent({ severity: 'alarm' }).message, 'Grenzwert verletzt');
});

test('mapBackendEvent: metric is lowercased, missing metric stays null', () => {
  assert.strictEqual(mapBackendEvent({ severity: 'alarm', metric: 'PRESSURE' }).metric, 'pressure');
  assert.strictEqual(mapBackendEvent({ severity: 'alarm' }).metric, null);
});

test('mapBackendEvent: extreme falls back to alarm_value', () => {
  assert.strictEqual(mapBackendEvent({ severity: 'alarm', alarm_value: 99.9 }).extreme, 99.9);
  assert.strictEqual(mapBackendEvent({ severity: 'alarm', extreme: 12.3, alarm_value: 99.9 }).extreme, 12.3);
});

test('mapBackendEvent: active is coerced to a boolean', () => {
  assert.strictEqual(mapBackendEvent({ severity: 'alarm', active: 1 }).active, true);
  assert.strictEqual(mapBackendEvent({ severity: 'alarm', active: 0 }).active, false);
  assert.strictEqual(mapBackendEvent({ severity: 'alarm' }).active, false);
});

// ---------- friendlyError (#17: German error text for every failure mode) ----------

test('friendlyError: a network TypeError becomes a German message, cause preserved', () => {
  const original = new TypeError('Failed to fetch');
  const err = friendlyError(original, 'X konnte nicht geladen werden');
  assert.match(err.message, /nicht erreichbar/);
  assert.strictEqual(err.cause, original);
});

test('friendlyError: a JSON SyntaxError becomes a German message, cause preserved', () => {
  const original = new SyntaxError('Unexpected token < in JSON at position 0');
  const err = friendlyError(original, 'X konnte nicht geladen werden');
  assert.match(err.message, /nicht gelesen werden/);
  assert.strictEqual(err.cause, original);
});

test('friendlyError: an Error we threw ourselves passes through unchanged', () => {
  const original = new Error('Einstellungen konnten nicht geladen werden');
  assert.strictEqual(friendlyError(original, 'fallback'), original);
});

test('friendlyError: a non-Error value is wrapped in the fallback message, value kept as cause', () => {
  const err = friendlyError('boom', 'Etwas ist schiefgelaufen');
  assert.strictEqual(err.message, 'Etwas ist schiefgelaufen');
  assert.strictEqual(err.cause, 'boom');
});
