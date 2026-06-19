// Pure, side-effect-free Übersetzung roher Sync-Fehler in Klartext.
// Browser: als <script> vor settings.jsx geladen, hängt an window.
// Node: per require() in Tests genutzt. Kein DOM / fetch / timer / Date.
(function () {
  // Übersetzt scheduler.lastSyncError in eine verständliche Erklärung.
  // Reihenfolge: spezifischste Treffer zuerst.
  // Rückgabe: { plain: Klartext, showRaw: ob die Rohmeldung zusätzlich angezeigt werden soll }
  function explainSyncError(raw) {
    const s = raw == null ? '' : String(raw);
    const l = s.toLowerCase();
    if (/no api key/.test(l)) return { plain: 'Kein API-Schlüssel hinterlegt.', showRaw: false };
    if (/\b401\b|unauthorized|invalid_token/.test(l)) return { plain: 'Zugangsschlüssel wurde abgelehnt.', showRaw: true };
    if (/\b403\b|forbidden/.test(l)) return { plain: 'Zugriff verweigert — Berechtigung prüfen.', showRaw: true };
    if (/fetch failed|enotfound|econnrefused|econnreset|network/.test(l)) return { plain: 'Keine Verbindung zur testo-Cloud.', showRaw: true };
    if (/timeout|etimedout/.test(l)) return { plain: 'Zeitüberschreitung bei der Anfrage.', showRaw: true };
    if (/\b429\b|rate limit|too many requests/.test(l)) return { plain: 'Zu viele Anfragen (Rate-Limit erreicht).', showRaw: true };
    if (/\b5\d\d\b|server error|internal server/.test(l)) return { plain: 'testo-Cloud meldet einen Serverfehler.', showRaw: true };
    return { plain: 'Synchronisation fehlgeschlagen.', showRaw: s.length > 0 };
  }

  const api = { explainSyncError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.explainSyncError = explainSyncError; }
})();
