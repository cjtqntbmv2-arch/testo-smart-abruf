const { test } = require('node:test');
const assert = require('node:assert');
const { recordOutcome, partialFailureNotice, FAIL_THRESHOLD } = require('../partial-failure-logic');

test('recordOutcome: Erfolg setzt den Zähler auf 0', () => {
  const counts = recordOutcome(recordOutcome({}, 'limits', false), 'limits', true);
  assert.strictEqual(counts.limits, 0);
});

test('recordOutcome: aufeinanderfolgende Fehler zählen hoch', () => {
  let c = {};
  c = recordOutcome(c, 'limits', false);
  c = recordOutcome(c, 'limits', false);
  assert.strictEqual(c.limits, 2);
});

test('recordOutcome: verändert das übergebene Objekt nicht', () => {
  const before = {};
  recordOutcome(before, 'limits', false);
  assert.deepStrictEqual(before, {});
});

test('recordOutcome: Gruppen sind voneinander unabhängig', () => {
  let c = recordOutcome({}, 'limits', false);
  c = recordOutcome(c, 'events', true);
  assert.strictEqual(c.limits, 1);
  assert.strictEqual(c.events, 0);
});

test('partialFailureNotice: einzelner Aussetzer meldet nichts', () => {
  assert.strictEqual(partialFailureNotice(recordOutcome({}, 'limits', false)), null);
});

test('partialFailureNotice: leerer Zustand meldet nichts', () => {
  assert.strictEqual(partialFailureNotice({}), null);
  assert.strictEqual(partialFailureNotice(null), null);
});

test('partialFailureNotice: Schwellwert ist 3 Zyklen', () => {
  assert.strictEqual(FAIL_THRESHOLD, 3);
  let c = {};
  for (let i = 0; i < 2; i++) c = recordOutcome(c, 'limits', false);
  assert.strictEqual(partialFailureNotice(c), null, 'zwei Fehlversuche sind noch kein Dauerausfall');
  c = recordOutcome(c, 'limits', false);
  assert.match(partialFailureNotice(c), /Grenzwerte/);
});

test('partialFailureNotice: Hinweis verschwindet nach einem Erfolg wieder', () => {
  let c = {};
  for (let i = 0; i < 4; i++) c = recordOutcome(c, 'limits', false);
  assert.notStrictEqual(partialFailureNotice(c), null);
  c = recordOutcome(c, 'limits', true);
  assert.strictEqual(partialFailureNotice(c), null);
});

test('partialFailureNotice: mehrere Gruppen werden zusammengefasst', () => {
  let c = {};
  for (let i = 0; i < 3; i++) {
    c = recordOutcome(c, 'limits', false);
    c = recordOutcome(c, 'events', false);
  }
  const msg = partialFailureNotice(c);
  assert.match(msg, /Grenzwerte/);
  assert.match(msg, /Meldungen/);
  assert.match(msg, / und /);
});

test('partialFailureNotice: nur Gruppen über dem Schwellwert werden genannt', () => {
  let c = {};
  for (let i = 0; i < 3; i++) c = recordOutcome(c, 'limits', false);
  c = recordOutcome(c, 'events', false); // erst 1 Fehlversuch
  const msg = partialFailureNotice(c);
  assert.match(msg, /Grenzwerte/);
  assert.doesNotMatch(msg, /Meldungen/);
});

test('partialFailureNotice: unbekannte Gruppen werden ignoriert', () => {
  assert.strictEqual(partialFailureNotice({ quatsch: 99 }), null);
});

test('partialFailureNotice: Schwellwert ist überschreibbar', () => {
  const c = recordOutcome({}, 'metrics', false);
  assert.match(partialFailureNotice(c, 1), /Messwerte/);
});
