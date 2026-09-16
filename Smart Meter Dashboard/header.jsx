// Topbar / header cluster: the dashboard top bar.
// Extracted from app.jsx to keep the GUI entry file small — no behaviour change.
// Loaded as a plain <script type="text/babel"> BEFORE summary-panel.jsx and app.jsx
// (app.jsx mounts the root), so these global function declarations resolve at render time.
// Header renders SystemSummaryTrigger (summary-panel.jsx) and summary-panel.jsx reuses
// SummaryDot from here — all cross-file globals, resolved at call time.
//
// #16: the mock-data banner below is this file's first use of hooks, so it needs its own
// alias line. 'h*' is free — the other files already claim: bare (charts.jsx, the actual
// collision trap), a* (app.jsx), s* (settings.jsx), ss* (summary-panel.jsx), t* (tiles.jsx),
// *E suffix (export-panel.jsx). dashboard-load.test.js fails the whole page on a clash.
const { useState: hState, useEffect: hEff } = React;

function Header({ editMode, onToggleEdit, onAdd, onReset, tileCount, view, onOpenSettings, onLeaveSettings }) {
  const D = window.DASH_DATA;
  const totals = D.totalActive();
  const inSettings = view === "settings";

  // #16: is the backend currently serving fabricated data instead of real testo
  // measurements (TESTO_MOCK=1 left on by accident — see backend/testo-client.js)?
  // Polled like settings.jsx's system status (10s) rather than fetched once, so a
  // dashboard left open on a wall display picks up the change without a reload.
  // Shown on every view, not just the dashboard grid: unlike the offline-banner
  // (app.jsx, dashboard view only), mock mode is a fact about the whole session,
  // not about one screen.
  const [mockActive, setMockActive] = hState(false);
  hEff(() => {
    let cancelled = false;
    function loadMockStatus() {
      fetch('/api/system/status')
        .then((res) => res.json())
        .then((data) => { if (!cancelled) setMockActive(!!(data && data.api && data.api.mockActive)); })
        .catch(() => {}); // transient fetch failure: keep the last known state, don't flicker
    }
    loadMockStatus();
    const intervalId = setInterval(loadMockStatus, 10000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          {inSettings ? (
            <button className="icon-btn back-btn" onClick={onLeaveSettings} title="Zurück zum Dashboard">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3 5 8l5 5"/></svg>
            </button>
          ) : (
            <div className="brand-mark">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <circle cx="11" cy="11" r="9" stroke="var(--accent)" strokeWidth="1.5"/>
                <path d="M11 4 V11 L15 14" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
          )}
          <div className="brand-text">
            <div className="brand-title">{inSettings ? "Einstellungen" : "Klima · Dashboard"}</div>
            <div className="brand-sub">
              {inSettings
                ? "System prüfen, Anbindungen verwalten"
                : <>{D.stationOrder.length} Messstellen · {totals.alarm + totals.warning} Meldung{(totals.alarm + totals.warning) === 1 ? "" : "en"} aktiv</>}
            </div>
          </div>
        </div>
        {/* Engere Grenze um die Meldungsübersicht: das Aufklapp-Panel lädt Historie
            nach und rendert Backend-Daten — wirft es, soll nur die Pille ausfallen,
            nicht die Navigation daneben. ErrorBoundary stammt aus app.jsx, das erst
            danach geladen wird; zur Renderzeit ist es definiert (gleiches Muster wie
            SystemSummaryTrigger aus summary-panel.jsx hier). */}
        {!inSettings && (
          <ErrorBoundary label="Meldungsübersicht" message="Meldungsübersicht nicht verfügbar.">
            <SystemSummaryTrigger totals={totals} />
          </ErrorBoundary>
        )}
        <div className="top-actions">
          {!inSettings && <>
            <span className="tile-count">{tileCount} Kacheln</span>
            <button className="btn" onClick={onAdd} disabled={!editMode}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M7 2v10M2 7h10"/></svg>
              Kachel hinzufügen
            </button>
            <button className="btn ghost" onClick={onReset}>Zurücksetzen</button>
            <button className={`btn ${editMode ? "primary" : ""}`} onClick={onToggleEdit}>
              {editMode ? "Layout sperren" : "Layout bearbeiten"}
            </button>
            <button className="btn" onClick={onOpenSettings} title="Einstellungen">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
              <span>Einstellungen</span>
            </button>
          </>}
        </div>
      </header>
      {/* #16: reuses the offline-banner class for layout (full-width strip under the topbar,
          icon + text) — Klima Dashboard.html's stylesheet is out of scope for this change, so
          there is no new CSS class to reach for. The extra mock-data-banner class carries no
          rules of its own; it only keeps this element from reading as a copy-pasted offline
          banner in devtools. Colours are pushed inline from warn to alarm: fabricated data is
          a worse problem than stale data, and the two must not look the same at a glance. */}
      {mockActive && (
        <div className="offline-banner mock-data-banner" style={{ background: 'var(--alarm-tint)', borderBottomColor: 'color-mix(in oklch, var(--alarm) 35%, transparent)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--alarm)' }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span>Mock-Modus aktiv — alle angezeigten Messwerte sind frei erfunden, keine echten testo-Daten.</span>
        </div>
      )}
    </>
  );
}

function SummaryDot({ severity, count }) {
  return (
    <span className={`top-sum-dot sev-${severity} ${count > 0 ? "has" : ""}`} title={`${count} ${severity}`}>
      <span className="top-sum-count">{count}</span>
    </span>
  );
}
