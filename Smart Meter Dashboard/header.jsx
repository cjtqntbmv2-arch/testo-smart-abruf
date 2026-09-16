// Topbar / header cluster: the dashboard top bar.
// Extracted from app.jsx to keep the GUI entry file small — no behaviour change.
// Loaded as a plain <script type="text/babel"> BEFORE summary-panel.jsx and app.jsx
// (app.jsx mounts the root), so these global function declarations resolve at render time.
// Header renders SystemSummaryTrigger (summary-panel.jsx) and summary-panel.jsx reuses
// SummaryDot from here — all cross-file globals, resolved at call time.

function Header({ editMode, onToggleEdit, onAdd, onReset, tileCount, view, onOpenSettings, onLeaveSettings }) {
  const D = window.DASH_DATA;
  const totals = D.totalActive();
  const inSettings = view === "settings";
  return (
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
      {!inSettings && <SystemSummaryTrigger totals={totals} />}
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
  );
}

function SummaryDot({ severity, count }) {
  return (
    <span className={`top-sum-dot sev-${severity} ${count > 0 ? "has" : ""}`} title={`${count} ${severity}`}>
      <span className="top-sum-count">{count}</span>
    </span>
  );
}
