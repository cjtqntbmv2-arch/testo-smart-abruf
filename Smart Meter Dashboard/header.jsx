// Topbar / header cluster: the dashboard top bar plus the station-picker UI.
// Extracted from app.jsx to keep the GUI entry file small — no behaviour change.
// Loaded as a plain <script type="text/babel"> BEFORE summary-panel.jsx and app.jsx
// (app.jsx mounts the root), so these global function declarations resolve at render time.
// Header renders SystemSummaryTrigger (summary-panel.jsx) and summary-panel.jsx reuses
// SummaryDot from here — all cross-file globals, resolved at call time.
// Unique hook aliases (h*) avoid global const collisions with the other JSX files.

const { useRef: hRef, useEffect: hEff } = React;

function Header({ editMode, onToggleEdit, onAdd, onReset, tileCount, stationPickerOpen, onToggleStationPicker, onCloseStationPicker, view, onOpenSettings, onLeaveSettings }) {
  const D = window.DASH_DATA;
  const station = D.activeStation;
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

function StationSelector({ station, open, onToggle, onClose }) {
  const D = window.DASH_DATA;
  const ref = hRef(null);
  hEff(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const stationActive = countActive(D.stations[station.id]);

  return (
    <div className="station-wrap" ref={ref}>
      <button className={`station-trigger ${open ? "open" : ""}`} onClick={onToggle}>
        <span className={`station-dot ${station.online ? "on" : "off"}`} />
        <div className="station-meta">
          <div className="station-name">
            <span>{station.name}</span>
            <span className="station-code">{station.code}</span>
          </div>
          <div className="station-sub">
            {station.location} · {station.online
              ? <>online · Batterie {station.battery} %</>
              : <>offline · zuletzt {D.formatRelative(station.lastSeen)}</>}
            {stationActive > 0 && <> · <span className="station-alerts">{stationActive} Meldung{stationActive === 1 ? "" : "en"}</span></>}
          </div>
        </div>
        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
      </button>
      {open && (
        <div className="station-pop">
          <div className="station-pop-head">Messstelle auswählen</div>
          {D.stationOrder.map((sid) => {
            const s = D.stations[sid];
            const active = countActive(s);
            const isCurrent = sid === station.id;
            return (
              <button key={sid} className={`station-item ${isCurrent ? "current" : ""}`}
                      onClick={() => { D.setActiveStation(sid); onClose(); }}>
                <span className={`station-dot ${s.online ? "on" : "off"}`} />
                <div className="si-text">
                  <div className="si-line">
                    <span className="si-name">{s.name}</span>
                    <span className="station-code">{s.code}</span>
                    {isCurrent && <span className="si-check">✓</span>}
                  </div>
                  <div className="si-sub">
                    {s.location} · {s.online ? "online" : "offline"}
                    <span className="si-stat"><BatteryIcon level={s.battery} /> {s.battery} %</span>
                    <span className="si-stat"><SignalIcon level={s.signal} /> {s.online ? `${s.signal} %` : "—"}</span>
                  </div>
                </div>
                {active > 0 && (
                  <span className="si-count">{active}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function countActive(s) {
  return s.events.filter((e) => e.active).length;
}

function BatteryIcon({ level }) {
  const low = level <= 20;
  return (
    <svg width="14" height="10" viewBox="0 0 14 10" fill="none" style={{ verticalAlign: "-1px" }}>
      <rect x="0.5" y="0.5" width="11" height="9" rx="1.5" stroke={low ? "var(--alarm)" : "currentColor"} strokeWidth="1"/>
      <rect x="12" y="3" width="1.5" height="4" fill={low ? "var(--alarm)" : "currentColor"}/>
      <rect x="2" y="2" width={Math.max(1, (level / 100) * 8)} height="6" fill={low ? "var(--alarm)" : "currentColor"}/>
    </svg>
  );
}
function SignalIcon({ level }) {
  const bars = level === 0 ? 0 : level < 30 ? 1 : level < 60 ? 2 : level < 85 ? 3 : 4;
  return (
    <svg width="14" height="10" viewBox="0 0 14 10" fill="none" style={{ verticalAlign: "-1px" }}>
      {[0,1,2,3].map((i) => (
        <rect key={i} x={0.5 + i * 3.2} y={9 - (i + 1) * 2} width="2.2" height={(i + 1) * 2} rx="0.4"
              fill={i < bars ? "currentColor" : "var(--border-strong)"}/>
      ))}
    </svg>
  );
}
