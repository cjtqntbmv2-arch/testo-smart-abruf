const { test } = require('node:test');
const assert = require('node:assert');
const { buildPath, buildAreaPath, xPositions } = require('../chart-logic');

// ---------- buildPath ----------

test('buildPath: zwei Punkte ergeben M…L…', () => {
  assert.strictEqual(buildPath([0, 10], [5, 6]), 'M0.00 5.00 L10.00 6.00 ');
});

test('buildPath: ein einzelner Punkt ergibt genau ein M', () => {
  assert.strictEqual(buildPath([138], [32]), 'M138.00 32.00 ');
});

test('buildPath: leeres Array ergibt einen leeren Pfad', () => {
  assert.strictEqual(buildPath([], []), '');
});

test('buildPath: NaN mitten in der Reihe bricht den Pfad und startet neu', () => {
  assert.strictEqual(buildPath([0, 10, 20], [1, NaN, 3]), 'M0.00 1.00 M20.00 3.00 ');
});

test('buildPath: NaN am Anfang wird uebersprungen', () => {
  assert.strictEqual(buildPath([0, 10], [NaN, 2]), 'M10.00 2.00 ');
});

test('buildPath: NaN am Ende wird uebersprungen', () => {
  assert.strictEqual(buildPath([0, 10], [2, NaN]), 'M0.00 2.00 ');
});

test('buildPath: nur NaN ergibt einen leeren Pfad', () => {
  assert.strictEqual(buildPath([0, 10], [NaN, NaN]), '');
});

test('buildPath: null zaehlt wie eine Luecke', () => {
  assert.strictEqual(buildPath([0, 10], [null, 2]), 'M10.00 2.00 ');
});

// ---------- buildAreaPath ----------

test('buildAreaPath: zwei Punkte ergeben eine geschlossene Flaeche', () => {
  assert.strictEqual(
    buildAreaPath([0, 10], [5, 6], 20),
    'M0.00 20.00 L0.00 5.00 L10.00 6.00 L10.00 20.00 Z'
  );
});

test('buildAreaPath: ein einzelner Punkt ergibt eine geschlossene Flaeche ohne NaN', () => {
  assert.strictEqual(
    buildAreaPath([138], [32], 35),
    'M138.00 35.00 L138.00 32.00 L138.00 35.00 Z'
  );
});

test('buildAreaPath: leeres Array ergibt einen leeren Pfad', () => {
  assert.strictEqual(buildAreaPath([], [], 10), '');
});

test('buildAreaPath: NaN mitten in der Reihe schliesst die Flaeche und oeffnet eine zweite', () => {
  assert.strictEqual(
    buildAreaPath([0, 10, 20], [1, NaN, 3], 10),
    'M0.00 10.00 L0.00 1.00 L0.00 10.00 Z M20.00 10.00 L20.00 3.00 L20.00 10.00 Z'
  );
});

test('buildAreaPath: NaN am Anfang wird uebersprungen', () => {
  assert.strictEqual(
    buildAreaPath([0, 10], [NaN, 2], 10),
    'M10.00 10.00 L10.00 2.00 L10.00 10.00 Z'
  );
});

test('buildAreaPath: NaN am Ende schliesst die Flaeche am letzten gueltigen x', () => {
  assert.strictEqual(
    buildAreaPath([0, 10], [2, NaN], 10),
    'M0.00 10.00 L0.00 2.00 L0.00 10.00 Z '
  );
});

test('buildAreaPath: nur NaN ergibt einen leeren Pfad', () => {
  assert.strictEqual(buildAreaPath([0, 10], [NaN, NaN], 10), '');
});

// ---------- xPositions ----------

test('xPositions: leere Reihe ergibt keine Positionen', () => {
  assert.deepStrictEqual(xPositions(0, 10, 100), []);
});

test('xPositions: zwei Punkte spannen die volle Breite', () => {
  assert.deepStrictEqual(xPositions(2, 0, 100), [0, 100]);
});

test('xPositions: drei Punkte liegen gleichmaessig', () => {
  assert.deepStrictEqual(xPositions(3, 1, 10), [1, 6, 11]);
});

test('xPositions: Sparkline-Geometrie bleibt unveraendert', () => {
  // Sparkline: x0 = 1, span = w - 2 (hier w = 100)
  assert.deepStrictEqual(xPositions(5, 1, 98), [1, 25.5, 50, 74.5, 99]);
});

test('xPositions: ein einzelner Punkt liegt in der Bildmitte, nicht bei NaN', () => {
  // LineChart-Geometrie: x0 = padL = 38, span = w - padL - padR = 200
  const xs = xPositions(1, 38, 200);
  assert.strictEqual(xs.length, 1);
  assert.ok(Number.isFinite(xs[0]), `erwartete eine endliche Position, bekam ${xs[0]}`);
  assert.strictEqual(xs[0], 138);
});

test('Regression: eine Reihe mit genau einem Punkt erzeugt kein NaN im Pfad', () => {
  const xs = xPositions(1, 38, 200);
  const ys = [32];
  const line = buildPath(xs, ys);
  const area = buildAreaPath(xs, ys, 35);
  assert.ok(!line.includes('NaN'), `Linienpfad enthaelt NaN: ${line}`);
  assert.ok(!area.includes('NaN'), `Flaechenpfad enthaelt NaN: ${area}`);
  assert.strictEqual(line, 'M138.00 32.00 ');
  assert.strictEqual(area, 'M138.00 35.00 L138.00 32.00 L138.00 35.00 Z');
});
