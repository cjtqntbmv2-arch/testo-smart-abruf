// Pure helpers for the export panel. Browser: attaches to window. Node: module.exports.
// No DOM / fetch / timers. Dual-export IIFE (same pattern as metrics-logic.js).
(function () {
  function endOfDay(ms)   { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); }

  function presetRange(key, nowMs) {
    const d = new Date(nowMs);
    // Kalendertage zurueck, nicht n × 24 h: ueber eine Zeitumstellung hinweg traf das in
    // der Stunde um Mitternacht den Nachbartag (8 bzw. 6 statt 7 Tage).
    const daysAgo = n => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
    if (key === 'last7')  return { fromTs: daysAgo(6), toTs: endOfDay(nowMs) };
    if (key === 'last30') return { fromTs: daysAgo(29), toTs: endOfDay(nowMs) };
    if (key === 'thisMonth') {
      const from = new Date(d.getFullYear(), d.getMonth(), 1);
      return { fromTs: from.getTime(), toTs: endOfDay(nowMs) };
    }
    if (key === 'lastMonth') {
      const from = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const to   = new Date(d.getFullYear(), d.getMonth(), 1);
      return { fromTs: from.getTime(), toTs: to.getTime() - 1 };
    }
    return { fromTs: nowMs, toTs: nowMs };
  }

  function unionMetrics(stations, selectedIds) {
    const sel = new Set(selectedIds);
    const seen = new Map();
    for (const s of stations) {
      if (!sel.has(s.id)) continue;
      for (const m of (s.metrics || [])) if (!seen.has(m.key)) seen.set(m.key, m);
    }
    return [...seen.values()];
  }

  function buildExportPayload(state) {
    return {
      stationIds: state.stationIds,
      metrics: state.metricKeys && state.metricKeys.length ? state.metricKeys : null,
      from: state.fromTs, to: state.toTs,
      includeEvents: !!state.includeEvents,
      dialect: state.dialect,
    };
  }

  function parseFilename(cd) {
    if (!cd) return null;
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) { const raw = star[1].trim(); try { return decodeURIComponent(raw); } catch (_) { return raw; } }
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    return plain ? plain[1].trim() : null;
  }

  // Umstellen des DAUERFORMATS der automatischen Monats-Backups (Einstellung
  // `csv_format`). Der Dialekt des manuellen Export-Dialogs ist nur eine Vorauswahl
  // daraus, also entscheidet diese Funktion beides: was gespeichert wird und ob der
  // Dialog mitgezogen wird.
  //   next           – angeklickter Wert
  //   archiveFormat  – aktuell gespeichertes Dauerformat
  //   dialectTouched – hat der Bediener den Dialekt des Dialogs schon selbst gesetzt?
  // Rueckgabe: save = POST noetig; dialect = neuer Wert fuer die Dialog-Vorauswahl,
  // null heisst ausdruecklich "unveraendert lassen" — eine bewusst getroffene Auswahl
  // fuer den naechsten Export wird nie ueberschrieben.
  function applyCsvFormatChange(next, state) {
    const cur = (state || {}).archiveFormat;
    if (next !== 'de' && next !== 'rfc') return { save: false, archiveFormat: cur, dialect: null };
    if (next === cur) return { save: false, archiveFormat: cur, dialect: null };
    return { save: true, archiveFormat: next, dialect: (state || {}).dialectTouched ? null : next };
  }

  // Epoch-ms → 'JJJJ-MM-TT' des ORTSTAGS, das Wertformat von <input type="date">.
  // Nie toISOString(): das ist UTC — in Europa zeigte das Von-Feld den Vortag, in Amerika
  // das Bis-Feld den Folgetag, und der Export rechnet aus genau diesen Feldern zurueck (V25).
  function localDateKey(ms) {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Werte der Datumsfelder → { fromTs, toTs }: Beginn des Von-Tags bis Ende des Bis-Tags,
  // beides Ortszeit (Datum MIT Uhrzeit ohne Versatz liest JS als Ortszeit, ein reines Datum
  // dagegen als UTC). Wirft mit der Meldung fuer den Dialog.
  function parseDateRange(fromStr, toStr) {
    const fromTs = new Date(fromStr + 'T00:00:00').getTime();
    const toTs = new Date(toStr + 'T23:59:59.999').getTime();
    // Ein leeres oder unvollstaendig getipptes Feld liefert '' → NaN (V16).
    if (Number.isNaN(fromTs) || Number.isNaN(toTs)) throw new Error('Bitte Von- und Bis-Datum angeben');
    if (fromTs > toTs) throw new Error('Zeitraum ungültig (von > bis)');
    return { fromTs, toTs };
  }

  const api = { presetRange, unionMetrics, buildExportPayload, parseFilename, applyCsvFormatChange, localDateKey, parseDateRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') Object.assign(window, api);
})();
