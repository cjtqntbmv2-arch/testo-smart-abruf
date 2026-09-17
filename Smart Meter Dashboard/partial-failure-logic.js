// Reine, seiteneffektfreie Entscheidung: ab wann gilt ein Teilausfall des 5s-Polls
// als meldenswert, und welcher Text steht dann im Banner?
// Browser: als <script> VOR data.js geladen, hängt an window.
// Node: per require() in Tests genutzt. Kein DOM / fetch / timer / Date.
(function () {
  // 3 aufeinanderfolgende Fehlversuche ~ 15 s bei 5 s Poll. Kurz genug, um einen
  // echten Dauerausfall zeitnah zu zeigen; lang genug, dass ein Serverneustart
  // oder ein einzelner Aussetzer das Banner nicht aufblinken lässt.
  const FAIL_THRESHOLD = 3;

  // Gruppen statt Einzelabrufe: die Messwert- und Meldungsabrufe laufen je Messstelle,
  // 20 Messstellen sollen aber eine Zeile ergeben, nicht 20.
  const GROUP_LABELS = {
    limits:  'Grenzwerte',
    metrics: 'Messwerte',
    events:  'Meldungen',
    totals:  'Meldungszähler',
  };

  // Zählt aufeinanderfolgende Fehlversuche je Gruppe hoch; ein Erfolg setzt zurück.
  // Gibt ein neues Objekt zurück, verändert das übergebene nicht.
  function recordOutcome(counts, group, ok) {
    const next = Object.assign({}, counts);
    next[group] = ok ? 0 : ((counts && counts[group]) || 0) + 1;
    return next;
  }

  // null, solange keine Gruppe den Schwellwert erreicht — sonst der Bannertext.
  function partialFailureNotice(counts, threshold) {
    const t = threshold || FAIL_THRESHOLD;
    const names = Object.keys(GROUP_LABELS)
      .filter((g) => ((counts && counts[g]) || 0) >= t)
      .map((g) => GROUP_LABELS[g]);
    if (names.length === 0) return null;
    const list = names.length === 1
      ? names[0]
      : names.slice(0, -1).join(', ') + ' und ' + names[names.length - 1];
    return `Teilausfall — ${list} werden nicht mehr geladen; die Anzeige ist unvollständig`;
  }

  const api = { recordOutcome, partialFailureNotice, FAIL_THRESHOLD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.recordOutcome = recordOutcome;
    window.partialFailureNotice = partialFailureNotice;
  }
})();
