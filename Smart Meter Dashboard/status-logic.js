// Pure, side-effect-free Übersetzung roher Sync-Fehler und Zustände in Klartext.
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

  // #11: Entscheidet, ob ein fehlgeschlagener Schreibvorgang des Kachel-Layouts
  // gemeldet wird. Rückgabe: Meldungstext oder null (nichts zu melden).
  // Ein fester Satz, keine Fallunterscheidung: ob der Speicher voll oder vom
  // Browser gesperrt ist (privater Modus, Gruppenrichtlinie), ändert nichts daran,
  // was der Bediener tun kann — beide Ursachen stehen deshalb im selben Satz.
  function explainLayoutSaveError(error) {
    if (!error) return null;
    return 'Kachel-Anordnung konnte nicht gespeichert werden — Änderungen gehen beim '
      + 'Neuladen der Seite verloren (Browser-Speicher voll oder gesperrt).';
  }

  // Zustand der Datensicherung aus dem backup-Block von GET /api/system/status
  // ({ enabled, health }) — eine Abbildung fuer Systemuebersicht, Kopfzeile und
  // Sicherungskasten, damit die drei nie Verschiedenes zeigen.
  // Rueckgabe: { status: 'ok'|'warn'|'err'|'unknown' (HealthCard/StatusPill), label, cause }.
  function explainBackupStatus(backup) {
    if (!backup) return { status: 'unknown', label: 'Unbekannt', cause: null };
    // Aus schlaegt einen Fehler: ein gescheiterter Einmal-Lauf ("Jetzt sichern") ist dann
    // keine laufende Stoerung — gemeldet wird, dass gar nicht automatisch gesichert wird.
    if (backup.enabled === false) {
      return { status: 'warn', label: 'Aus', cause: 'Automatische Sicherung ist ausgeschaltet — es entsteht kein täglicher Datenbank-Abzug.' };
    }
    const h = backup.health || {};
    if (h.status === 'error') return { status: 'err', label: 'Fehler', cause: h.lastError || 'Sicherung fehlgeschlagen (ohne Meldung).' };
    if (h.status === 'ok') return { status: 'ok', label: 'Aktiv', cause: null };
    return { status: 'unknown', label: 'Noch kein Lauf', cause: null };
  }

  const api = { explainSyncError, explainLayoutSaveError, explainBackupStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.explainSyncError = explainSyncError;
    window.explainLayoutSaveError = explainLayoutSaveError;
    window.explainBackupStatus = explainBackupStatus;
  }
})();
