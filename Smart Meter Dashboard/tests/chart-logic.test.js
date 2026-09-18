const { test } = require('node:test');
const assert = require('node:assert');
const { buildPath, buildAreaPath, xPositions, gaugeScale } = require('../chart-logic');

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

// ---------- gaugeScale ----------

// Die sechs Grenzwerte der echten Installation (GET /api/limits, Stand 17.09.2026).
const LIMITS = [
  { metric: 'temperature', direction: 'low',  severity: 'alarm', limitValue: 18 },
  { metric: 'temperature', direction: 'high', severity: 'alarm', limitValue: 28 },
  { metric: 'humidity',    direction: 'low',  severity: 'alarm', limitValue: 30 },
  { metric: 'humidity',    direction: 'high', severity: 'alarm', limitValue: 60 },
  { metric: 'pressure',    direction: 'low',  severity: 'alarm', limitValue: 860 },
  { metric: 'pressure',    direction: 'high', severity: 'alarm', limitValue: 1060 },
];

// Was jede Skala erfuellen muss: endlich, lo < hi, der angezeigte (letzte) Wert
// innen, und beide Enden ohne Rest in den Dezimalstellen der Messgroesse darstellbar.
function assertSkala(s, series, decimals) {
  assert.ok(Number.isFinite(s.lo) && Number.isFinite(s.hi), `nicht endlich: ${JSON.stringify(s)}`);
  assert.ok(s.lo < s.hi, `lo < hi verletzt: ${JSON.stringify(s)}`);
  const v = series[series.length - 1];
  if (Number.isFinite(v)) assert.ok(s.lo <= v && v <= s.hi, `Wert ${v} ausserhalb ${s.lo}..${s.hi}`);
  assert.strictEqual(Number(s.lo.toFixed(decimals)), s.lo, `lo ${s.lo} nicht rund`);
  assert.strictEqual(Number(s.hi.toFixed(decimals)), s.hi, `hi ${s.hi} nicht rund`);
}

test('gaugeScale: Beobachtung 17.09. - UWL-Fenster ohne Grenzwerte ergibt gerundete Enden statt Rohwerte', () => {
  // Rekonstruiert aus der DB: 24-h-Minimum 21.461187, -Maximum 23.110783, letzter Wert 22.856598 ("22.9").
  const series = [21.461187, 23.110783, 22.856598];
  const s = gaugeScale(series, [], 'temperature', 1);
  assert.deepStrictEqual(s, { lo: 21.2, hi: 23.4 });
  assertSkala(s, series, 1);
});

test('gaugeScale: mit Grenzwerten spannt die Skala die Grenzwerte mit Rand auf', () => {
  assert.deepStrictEqual(gaugeScale([21.461187, 22.856598], LIMITS, 'temperature', 1), { lo: 16, hi: 30 });
  assert.deepStrictEqual(gaugeScale([41.2, 42], LIMITS, 'humidity', 0), { lo: 25, hi: 65 });
  assert.deepStrictEqual(gaugeScale([1002.2], LIMITS, 'pressure', 1), { lo: 840, hi: 1080 });
});

test('gaugeScale: Grenzwerte anderer Messgroessen zaehlen nicht, dann gilt die Datenskala', () => {
  const series = [8.636381, 12.636017, 9.092839];
  assert.deepStrictEqual(gaugeScale(series, LIMITS, 'dewpoint', 1), gaugeScale(series, [], 'dewpoint', 1));
  assert.deepStrictEqual(gaugeScale(series, LIMITS, 'dewpoint', 1), { lo: 8, hi: 13.5 });
});

test('gaugeScale: Wert ueber bzw. unter den Grenzwerten liegt trotzdem innerhalb der Skala', () => {
  const hoch = [24, 35];
  assert.deepStrictEqual(gaugeScale(hoch, LIMITS, 'temperature', 1), { lo: 16, hi: 38 });
  assertSkala(gaugeScale(hoch, LIMITS, 'temperature', 1), hoch, 1);
  const tief = [20, 12];
  assert.deepStrictEqual(gaugeScale(tief, LIMITS, 'temperature', 1), { lo: 10, hi: 30 });
  assertSkala(gaugeScale(tief, LIMITS, 'temperature', 1), tief, 1);
});

test('gaugeScale: Schrittweite nie feiner als die Dezimalstellen der Messgroesse', () => {
  // rel. Feuchte (0 Dezimalstellen), fast konstante Reihe: ganze Zahlen, nicht 41.15/41.65.
  const series = [41.2, 41.6];
  assert.deepStrictEqual(gaugeScale(series, [], 'humidity', 0), { lo: 41, hi: 42 });
  // abs. Feuchte (2 Dezimalstellen)
  const abs = [8.204598, 10.724339];
  assert.deepStrictEqual(gaugeScale(abs, [], 'abshumid', 2), { lo: 7.5, hi: 11 });
  assertSkala(gaugeScale(abs, [], 'abshumid', 2), abs, 2);
});

test('gaugeScale: min == max ergibt eine echte Spanne', () => {
  const series = [22.5, 22.5, 22.5];
  const s = gaugeScale(series, [], 'temperature', 1);
  assert.deepStrictEqual(s, { lo: 21.2, hi: 23.8 });
  assertSkala(s, series, 1);
});

test('gaugeScale: Luecke (NaN) am Ende - Skala aus den gueltigen Werten, ohne NaN', () => {
  const s = gaugeScale([21.5, 22, NaN], [], 'temperature', 1);
  assert.deepStrictEqual(s, { lo: 21.4, hi: 22.1 });
});

test('gaugeScale: leere oder reine NaN-Reihe ohne Grenzwerte faellt auf 0..100 zurueck', () => {
  assert.deepStrictEqual(gaugeScale([], [], 'temperature', 1), { lo: 0, hi: 100 });
  assert.deepStrictEqual(gaugeScale([NaN, NaN], [], 'temperature', 1), { lo: 0, hi: 100 });
  assert.deepStrictEqual(gaugeScale(undefined, undefined, 'temperature', 1), { lo: 0, hi: 100 });
});

test('gaugeScale: ohne Messwerte, aber mit Grenzwerten zeigt die Skala die Grenzwerte', () => {
  assert.deepStrictEqual(gaugeScale([NaN], LIMITS, 'temperature', 1), { lo: 16, hi: 30 });
});
