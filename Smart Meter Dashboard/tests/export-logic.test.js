const test = require('node:test');
const assert = require('node:assert');
const { presetRange, unionMetrics, buildExportPayload, parseFilename, applyCsvFormatChange, localDateKey, parseDateRange } = require('../export-logic.js');

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

test('parseFilename: trims trailing whitespace from the capture', () => {
  assert.strictEqual(parseFilename("attachment; filename*=UTF-8''report.csv  "), 'report.csv');
  assert.strictEqual(parseFilename('attachment; filename="x.zip" '), 'x.zip');
});

// ── Dauerformat der Monats-Backups (csv_format) ──────────────────────────────
// Zwei Bedienelemente, ein Wert: das Dauerformat des Archivs wird gespeichert,
// der Dialekt des manuellen Exports ist nur eine Vorauswahl daraus.

test('applyCsvFormatChange: Umstellen speichert und zieht die unberuehrte Dialog-Vorauswahl mit', () => {
  const d = applyCsvFormatChange('rfc', { archiveFormat: 'de', dialectTouched: false });
  assert.deepStrictEqual(d, { save: true, archiveFormat: 'rfc', dialect: 'rfc' });
});

test('applyCsvFormatChange: eine selbst gesetzte Dialog-Auswahl wird nicht ueberschrieben', () => {
  const d = applyCsvFormatChange('rfc', { archiveFormat: 'de', dialectTouched: true });
  assert.deepStrictEqual(d, { save: true, archiveFormat: 'rfc', dialect: null });
});

test('applyCsvFormatChange: derselbe Wert speichert nicht erneut', () => {
  // SegmentedControl feuert onChange auch beim Klick auf die bereits aktive Schaltflaeche.
  const d = applyCsvFormatChange('de', { archiveFormat: 'de', dialectTouched: false });
  assert.deepStrictEqual(d, { save: false, archiveFormat: 'de', dialect: null });
});

test('applyCsvFormatChange: unbekannter Wert aendert nichts', () => {
  const d = applyCsvFormatChange('xml', { archiveFormat: 'de', dialectTouched: false });
  assert.deepStrictEqual(d, { save: false, archiveFormat: 'de', dialect: null });
});

// ── Datumsfelder des Export-Dialogs (V25, V16) ───────────────────────────────
// presetRange rechnet in Ortszeit; die Felder muessen denselben Ortstag zeigen, und aus
// ihnen muss beim Export exakt derselbe Zeitraum zurueckkommen. Per toISOString (UTC)
// formatiert kippte bei positivem Versatz (Europa) das Von-Feld auf den Vortag, bei
// negativem (Amerika) das Bis-Feld auf den Folgetag. Deshalb zwei feste Zonen — die Zone
// des Rechners (CI: UTC) ist fuer beide Fehler blind. TZ gilt nur je Test.
function inTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}
const NOW = Date.UTC(2026, 8, 17, 10, 0); // 17.09.2026 — 12:00 in Berlin, 06:00 in New York
const shown = (key, now) => { const r = presetRange(key, now); return [localDateKey(r.fromTs), localDateKey(r.toTs)]; };

for (const tz of ['Europe/Berlin', 'America/New_York']) {
  test(`Datumsfelder zeigen den Ortstag der Voreinstellung (${tz})`, () => inTZ(tz, () => {
    assert.deepStrictEqual(shown('last7', NOW),     ['2026-09-11', '2026-09-17']);
    assert.deepStrictEqual(shown('last30', NOW),    ['2026-08-19', '2026-09-17']);
    assert.deepStrictEqual(shown('thisMonth', NOW), ['2026-09-01', '2026-09-17']);
    assert.deepStrictEqual(shown('lastMonth', NOW), ['2026-08-01', '2026-08-31']);
  }));

  // Kein reiner Anzeigefehler: der Export rechnet aus den Feldern zurueck.
  test(`Export sendet exakt den Zeitraum der Voreinstellung (${tz})`, () => inTZ(tz, () => {
    for (const key of ['last7', 'last30', 'thisMonth', 'lastMonth']) {
      const r = presetRange(key, NOW);
      assert.deepStrictEqual({ key, ...parseDateRange(localDateKey(r.fromTs), localDateKey(r.toTs)) }, { key, ...r });
    }
  }));
}

test('parseDateRange: leeres Datumsfeld meldet das fehlende Datum, nicht "von > bis" (V16)', () => {
  assert.throws(() => parseDateRange('', '2026-08-31'), /^Error: Bitte Von- und Bis-Datum angeben$/);
  assert.throws(() => parseDateRange('2026-08-01', ''), /^Error: Bitte Von- und Bis-Datum angeben$/);
  assert.throws(() => parseDateRange('2026-09-01', '2026-08-31'), /^Error: Zeitraum ungültig \(von > bis\)$/);
});

// n × 24 h ab jetzt traf ueber eine Zeitumstellung hinweg in der Stunde um Mitternacht
// den Nachbartag: 8 statt 7 Tage nach dem Sommerzeit-, 6 statt 7 nach dem Winterzeitbeginn.
test('presetRange: letzte 7/30 Tage zaehlen Kalendertage, auch ueber die Zeitumstellung', () => inTZ('Europe/Berlin', () => {
  const spring = Date.UTC(2026, 2, 30, 22, 30); // 31.03.2026 00:30 MESZ, Umstellung am 29.03.
  const autumn = Date.UTC(2026, 9, 30, 22, 30); // 30.10.2026 23:30 MEZ, Umstellung am 25.10.
  assert.deepStrictEqual(shown('last7', spring),  ['2026-03-25', '2026-03-31']);
  assert.deepStrictEqual(shown('last30', spring), ['2026-03-02', '2026-03-31']);
  assert.deepStrictEqual(shown('last7', autumn),  ['2026-10-24', '2026-10-30']);
  assert.deepStrictEqual(shown('last30', autumn), ['2026-10-01', '2026-10-30']);
}));
