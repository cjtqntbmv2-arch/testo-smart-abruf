// System summary detail panel: click the topbar summary pill to see every active
// alarm/warning/system message across all stations, grouped by device.
// Loaded as a plain <script type="text/babel"> before app.jsx (which mounts the root).
// Reuses EventRow (tiles.jsx) and SummaryDot (app.jsx) — both global function declarations,
// resolved at render time. Unique hook aliases (ss*) avoid global const collisions.

const { useState: ssState, useRef: ssRef, useEffect: ssEff } = React;

function SystemSummaryTrigger({ totals }) {
  const [open, setOpen] = ssState(false);
  const ref = ssRef(null);

  ssEff(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="top-summary-wrap" ref={ref}>
      <button className="top-summary" aria-haspopup="true" aria-expanded={open}
              onClick={() => setOpen((o) => !o)} title="Aktive Meldungen anzeigen">
        <SummaryDot severity="alarm"   count={totals.alarm} />
        <SummaryDot severity="warning" count={totals.warning} />
        <SummaryDot severity="system"  count={totals.system} />
        <span className="top-summary-label">über alle Messstellen</span>
        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"
             stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
      </button>
      {open && <SystemSummaryPanel />}
    </div>
  );
}

function SystemSummaryPanel() {
  const D = window.DASH_DATA;
  const groups = D.activeEventGroups();
  return (
    <div className="top-summary-pop">
      <div className="station-pop-head">Aktive Meldungen · alle Messstellen</div>
      {groups.length === 0 ? (
        <div className="alerts-empty">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="11" cy="11" r="8"/><path d="M7 11l3 3 5-6"/>
          </svg>
          <span>Keine aktiven Meldungen.</span>
        </div>
      ) : (
        groups.map(({ station, events }) => (
          <div className="tsp-group" key={station.id}>
            <div className="tsp-group-head">
              <span className={`station-dot ${station.online ? "on" : "off"}`} />
              <span className="tsp-group-title">{station.name}</span>
              <span className="station-code">{station.code}</span>
              <span className="tsp-group-loc">{station.location}</span>
              <span className="tsp-count">{events.length}</span>
            </div>
            {events.map((e) => <EventRow event={e} key={e.id ?? `${e.startTs}-${e.severity}-${e.metric || 'sys'}`} station={station} />)}
          </div>
        ))
      )}
    </div>
  );
}
