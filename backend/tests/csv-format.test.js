// backend/tests/csv-format.test.js
const test = require('node:test');
const assert = require('node:assert');
const { DIALECTS, getDialect, formatNumber, escapeField, joinRow, formatTimestamps, BOM, CRLF } = require('../csv-format');

test('getDialect: default de for unknown/empty', () => {
  assert.strictEqual(getDialect('').key, 'de');
  assert.strictEqual(getDialect('xx').key, 'de');
  assert.strictEqual(getDialect('rfc').key, 'rfc');
});

test('formatNumber: shortest round-trip, decimal per dialect, no thousands sep', () => {
  assert.strictEqual(formatNumber(21.3, DIALECTS.de), '21,3');
  assert.strictEqual(formatNumber(21.3, DIALECTS.rfc), '21.3');
  assert.strictEqual(formatNumber(1234.5, DIALECTS.de), '1234,5');
  assert.strictEqual(formatNumber(-5, DIALECTS.de), '-5');
  assert.strictEqual(formatNumber(null, DIALECTS.de), '');
  assert.strictEqual(formatNumber(NaN, DIALECTS.de), '');
});

test('escapeField: quotes fields containing delimiter, quote or newline; doubles quotes', () => {
  assert.strictEqual(escapeField('plain', DIALECTS.de), 'plain');
  assert.strictEqual(escapeField('a;b', DIALECTS.de), '"a;b"');
  assert.strictEqual(escapeField('a,b', DIALECTS.de), 'a,b'); // comma not a delimiter in de
  assert.strictEqual(escapeField('a,b', DIALECTS.rfc), '"a,b"');
  assert.strictEqual(escapeField('he said "hi"', DIALECTS.de), '"he said ""hi"""');
  assert.strictEqual(escapeField('line1\nline2', DIALECTS.de), '"line1\nline2"');
});

test('escapeField: CSV-injection guard prefixes risky leading chars', () => {
  assert.strictEqual(escapeField('=1+2', DIALECTS.de), "'=1+2");
  assert.strictEqual(escapeField('+49', DIALECTS.de), "'+49");
  assert.strictEqual(escapeField('-cmd', DIALECTS.de), "'-cmd");
  assert.strictEqual(escapeField('@x', DIALECTS.de), "'@x");
  assert.strictEqual(escapeField('safe-=', DIALECTS.de), 'safe-='); // only LEADING char matters
});

test('joinRow: joins escaped cells with delimiter + CRLF', () => {
  assert.strictEqual(joinRow(['a', 'b'], DIALECTS.de), 'a;b\r\n');
  assert.strictEqual(joinRow(['a', 'b'], DIALECTS.rfc), 'a,b\r\n');
});

test('formatTimestamps: ISO with offset + local Excel form from same epoch', () => {
  const { iso, local } = formatTimestamps(Date.UTC(2026, 4, 1, 12, 30, 0)); // 2026-05-01T12:30Z
  // Offset depends on the host TZ; assert structure not absolute value.
  assert.match(iso, /^2026-05-01T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.match(local, /^2026-05-01 \d{2}:\d{2}:\d{2}$/);
});

test('constants', () => {
  assert.strictEqual(BOM, '﻿');
  assert.strictEqual(CRLF, '\r\n');
});
