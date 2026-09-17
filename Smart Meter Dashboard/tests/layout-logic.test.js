const { test } = require('node:test');
const assert = require('node:assert');
const { rectsOverlap, compactLayout, findFreeSlot, COLS } = require('../layout-logic');

// Zaehlt die verbliebenen Ueberlappungen eines Layouts. 0 = aufgeloest.
function ueberlappungen(items) {
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (rectsOverlap(items[i], items[j])) n++;
    }
  }
  return n;
}

const stapel = (n) => Array.from({ length: n }, (_, i) => ({ id: 't' + i, x: 0, y: 0, w: 3, h: 3 }));

// ---------- rectsOverlap ----------

test('rectsOverlap: echte Ueberschneidung', () => {
  assert.strictEqual(rectsOverlap({ x: 0, y: 0, w: 3, h: 3 }, { x: 2, y: 2, w: 3, h: 3 }), true);
});

test('rectsOverlap: Kante an Kante ueberlappt nicht', () => {
  assert.strictEqual(rectsOverlap({ x: 0, y: 0, w: 3, h: 3 }, { x: 3, y: 0, w: 3, h: 3 }), false);
  assert.strictEqual(rectsOverlap({ x: 0, y: 0, w: 3, h: 3 }, { x: 0, y: 3, w: 3, h: 3 }), false);
});

test('rectsOverlap: vollstaendig enthalten ueberlappt', () => {
  assert.strictEqual(rectsOverlap({ x: 0, y: 0, w: 6, h: 6 }, { x: 1, y: 1, w: 2, h: 2 }), true);
});

test('rectsOverlap: diagonal getrennt ueberlappt nicht', () => {
  assert.strictEqual(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 2, h: 2 }), false);
});

// ---------- compactLayout ----------

test('compactLayout: die verschobene Kachel landet auf dem Ziel', () => {
  const out = compactLayout([{ id: 'm', x: 0, y: 0, w: 3, h: 3 }], 'm', { x: 6, y: 2, w: 4, h: 2 });
  assert.deepStrictEqual(out[0], { id: 'm', x: 6, y: 2, w: 4, h: 2 });
});

test('compactLayout: eine kollidierende Kachel wird unter die verschobene geschoben', () => {
  const out = compactLayout(
    [{ id: 'm', x: 0, y: 4, w: 3, h: 3 }, { id: 'a', x: 0, y: 0, w: 3, h: 3 }],
    'm',
    { x: 0, y: 0, w: 3, h: 3 }
  );
  assert.deepStrictEqual(out[1], { id: 'a', x: 0, y: 3, w: 3, h: 3 });
});

test('compactLayout: die Verschiebung kaskadiert ueber mehrere Reihen', () => {
  const out = compactLayout(
    [
      { id: 'm', x: 0, y: 0, w: 3, h: 2 },
      { id: 'a', x: 0, y: 1, w: 3, h: 2 },
      { id: 'b', x: 0, y: 3, w: 3, h: 2 },
      { id: 'c', x: 0, y: 5, w: 3, h: 2 },
    ],
    'm',
    { x: 0, y: 0, w: 3, h: 2 }
  );
  assert.deepStrictEqual(out.map((t) => t.y), [0, 2, 4, 6]);
  assert.strictEqual(ueberlappungen(out), 0);
});

test('compactLayout: konvergiert auch bei vielen deckungsgleichen Kacheln (safety reicht)', () => {
  // Laeuft der safety-Zaehler (200) je aus? Gemessen: nein - die innere Kaskade
  // loest alles in zwei Durchlaeufen, unabhaengig von der Kachelzahl. Waere er
  // ausgelaufen, blieben hier Ueberlappungen stehen.
  for (const n of [5, 12, 24, 80]) {
    const out = compactLayout(stapel(n), 't0', { x: 0, y: 0, w: 3, h: 3 });
    assert.strictEqual(ueberlappungen(out), 0, `bei ${n} Kacheln blieben Ueberlappungen stehen`);
    assert.strictEqual(out.length, n);
  }
});

test('compactLayout: die Rueckgabe behaelt die Reihenfolge der Eingabe', () => {
  const out = compactLayout(stapel(4), 't0', { x: 0, y: 0, w: 3, h: 3 });
  assert.deepStrictEqual(out.map((t) => t.id), ['t0', 't1', 't2', 't3']);
});

test('compactLayout: bei gleicher Hoehe gewinnt der fruehere Listenplatz', () => {
  const ziel = { x: 6, y: 0, w: 3, h: 3 };
  const ab = compactLayout(
    [{ id: 'm', x: 6, y: 0, w: 3, h: 3 }, { id: 'a', x: 0, y: 0, w: 3, h: 3 }, { id: 'b', x: 0, y: 0, w: 3, h: 3 }],
    'm', ziel
  );
  assert.deepStrictEqual(ab.map((t) => [t.id, t.y]), [['m', 0], ['a', 0], ['b', 3]]);

  const ba = compactLayout(
    [{ id: 'm', x: 6, y: 0, w: 3, h: 3 }, { id: 'b', x: 0, y: 0, w: 3, h: 3 }, { id: 'a', x: 0, y: 0, w: 3, h: 3 }],
    'm', ziel
  );
  assert.deepStrictEqual(ba.map((t) => [t.id, t.y]), [['m', 0], ['b', 0], ['a', 3]]);
});

test('compactLayout: die uebergebenen Objekte werden nicht veraendert', () => {
  const eingabe = [{ id: 'm', x: 0, y: 4, w: 3, h: 3 }, { id: 'a', x: 0, y: 0, w: 3, h: 3 }];
  const kopie = JSON.parse(JSON.stringify(eingabe));
  compactLayout(eingabe, 'm', { x: 0, y: 0, w: 3, h: 3 });
  assert.deepStrictEqual(eingabe, kopie);
});

test('compactLayout: vollstaendig belegte Reihe wird komplett nach unten geschoben', () => {
  const voll = Array.from({ length: COLS }, (_, i) => ({ id: 'c' + i, x: i, y: 0, w: 1, h: 2 }));
  const out = compactLayout([{ id: 'm', x: 0, y: 8, w: COLS, h: 2 }, ...voll], 'm', { x: 0, y: 0, w: COLS, h: 2 });
  assert.strictEqual(ueberlappungen(out), 0);
  assert.deepStrictEqual(out.filter((t) => t.id !== 'm').map((t) => t.y), new Array(COLS).fill(2));
});

// ---------- findFreeSlot ----------

test('findFreeSlot: leeres Layout liefert die linke obere Ecke', () => {
  assert.deepStrictEqual(findFreeSlot([], 3, 3), { x: 0, y: 0 });
});

test('findFreeSlot: erste freie Spalte in derselben Reihe', () => {
  assert.deepStrictEqual(findFreeSlot([{ id: 'a', x: 0, y: 0, w: 6, h: 3 }], 6, 3), { x: 6, y: 0 });
});

test('findFreeSlot: weicht in die naechste Reihe aus, wenn die Reihe voll ist', () => {
  assert.deepStrictEqual(findFreeSlot([{ id: 'a', x: 0, y: 0, w: COLS, h: 1 }], 3, 1), { x: 0, y: 1 });
});

test('findFreeSlot: volles Raster faellt auf {0,0} zurueck (dokumentiert, nicht repariert)', () => {
  // 12 Spalten x 60 Reihen sind praktisch unerreichbar; der Rueckfall liefert
  // dann bewusst eine ueberlappende Position statt gar keiner.
  assert.deepStrictEqual(findFreeSlot([{ id: 'voll', x: 0, y: 0, w: COLS, h: 60 }], 1, 1), { x: 0, y: 0 });
});

test('findFreeSlot: eine breitere Kachel als das Raster faellt ebenfalls auf {0,0} zurueck', () => {
  assert.deepStrictEqual(findFreeSlot([], COLS + 1, 1), { x: 0, y: 0 });
});

test('COLS ist die Rastertopologie, die die Layout-Mathematik braucht', () => {
  assert.strictEqual(COLS, 12);
});
