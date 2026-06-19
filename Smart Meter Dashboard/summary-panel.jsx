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

const PAGE_SIZE = 20;

// Safe wrapper around the pure view-model (summary-logic.js). This panel renders
// OUTSIDE the per-tile error boundary, so a throw whites out the whole app. During a
// version-skew reload a stale summary-logic.js may lack historySectionView — degrade
// to an inert view instead of crashing; the next poll re-render recovers once the
// assets are consistent. (See dashboard-runtime-gotchas.)
function historyView(state) {
  const fn = window.historySectionView;
  if (typeof fn === "function") return fn(state);
  return {
    showLoadButton: false, showToggle: false, showItems: false, showLoadMore: false,
    showCollapseFoot: false, showEmptyHint: false, showLoading: false, showError: false,
    count: 0, countSuffix: "",
  };
}

function SystemSummaryPanel() {
  const D = window.DASH_DATA;
  // Defensive: this panel renders OUTSIDE the per-tile error boundary, so any throw
  // here whites out the whole app. During a version-skew reload (new summary-panel.jsx
  // paired with a momentarily-stale data.js that predates stationOverview) the accessor
  // may be missing — degrade to the empty state instead of crashing; the next poll
  // re-render recovers once the data layer is consistent.
  const overview = (D && typeof D.stationOverview === "function") ? D.stationOverview() : [];
  return (
    <div className="top-summary-pop">
      <div className="station-pop-head">Meldungen · alle Messstellen</div>
      {overview.length === 0 ? (
        <div className="alerts-empty">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="11" cy="11" r="8"/><path d="M7 11l3 3 5-6"/>
          </svg>
          <span>Keine Messstellen vorhanden.</span>
        </div>
      ) : (
        overview.map((g) => (
          <StationHistoryGroup key={g.station.id} station={g.station}
                               activeEvents={g.activeEvents} activeCount={g.activeCount} />
        ))
      )}
    </div>
  );
}

function StationHistoryGroup({ station, activeEvents, activeCount }) {
  const D = window.DASH_DATA;
  const [expanded, setExpanded] = ssState(activeCount > 0);
  const [histOpen, setHistOpen] = ssState(false);
  const [history, setHistory] = ssState([]);
  const [loading, setLoading] = ssState(false);
  const [loaded, setLoaded] = ssState(false);
  const [done, setDone] = ssState(false);
  const [error, setError] = ssState(null);
  const inflight = ssRef(false);
  const headRef = ssRef(null);
  const scrollOnCollapse = ssRef(false);

  // Collapsing a long history from the bottom button removes the rows above the
  // viewport, leaving the scroll position dangling past the end. Pull the station
  // head back into view so the user lands at the top of this group, not in limbo.
  ssEff(() => {
    if (!histOpen && scrollOnCollapse.current) {
      scrollOnCollapse.current = false;
      if (headRef.current) headRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [histOpen]);

  async function loadPage() {
    if (inflight.current || done) return;
    inflight.current = true;
    setLoading(true);
    setError(null);
    try {
      const last = history[history.length - 1];
      const cursor = last ? { beforeTs: last.startTs, beforeRowid: last._rowid } : {};
      const page = await D.fetchStationHistory(station.id, { ...cursor, limit: PAGE_SIZE });
      setHistory((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return prev.concat(page.filter((e) => !seen.has(e.id)));
      });
      setLoaded(true);
      if (page.length < PAGE_SIZE) setDone(true);
    } catch (e) {
      setError((e && e.message) || 'Historie konnte nicht geladen werden');
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }

  // History is opt-in — there is NO auto-load effect. loadFirst() fetches the first page
  // AND reveals the section; later loadPage() calls (load-more) leave histOpen untouched.
  // Quiet stations are only ever opened to read history, so expanding one loads+opens
  // immediately; active stations show their active glance and wait for an explicit click.
  function loadFirst() { setHistOpen(true); loadPage(); }

  // Independent collapse: hides the loaded rows but keeps them in state (no refetch on
  // re-open). fromBottom requests the scroll-head-into-view nicety above.
  function collapseHistory(fromBottom) {
    if (fromBottom) scrollOnCollapse.current = true;
    setHistOpen(false);
  }

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && activeCount === 0 && !loaded && !inflight.current) loadFirst();
  }

  const evKey = (e) => e.id ?? `${e.startTs}-${e.severity}-${e.metric || 'sys'}`;
  const v = historyView({ loaded, loading, error, done, histOpen, historyCount: history.length });

  return (
    <div className={`tsp-group ${expanded ? "open" : ""}`}>
      <button ref={headRef} className="tsp-group-head" aria-expanded={expanded} onClick={toggle}>
        <span className={`station-dot ${station.online ? "on" : "off"}`} />
        <span className="tsp-group-title">{station.name}</span>
        <span className="station-code">{station.code}</span>
        <span className="tsp-group-loc">{station.location}{station.online ? "" : " · offline"}</span>
        {activeCount > 0
          ? <span className="tsp-count">{activeCount}</span>
          : <span className="tsp-quiet-hint">keine aktiven</span>}
        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"
             stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
      </button>
      {expanded && (
        <div className="tsp-group-body">
          {activeEvents.map((e) => <EventRow event={e} key={evKey(e)} station={station} />)}

          {!v.showToggle && (
            <React.Fragment>
              {v.showLoadButton && (
                <button className="tsp-loadmore" onClick={loadFirst}>Historie laden…</button>
              )}
              {v.showLoading && <div className="tsp-loading">Historie wird geladen…</div>}
              {v.showError && (
                <button className="tsp-error" onClick={loadFirst}>{error} — erneut versuchen</button>
              )}
            </React.Fragment>
          )}

          {v.showToggle && (
            <React.Fragment>
              <button className="tsp-history-toggle" aria-expanded={histOpen}
                      onClick={() => (histOpen ? collapseHistory(false) : setHistOpen(true))}>
                <span className="tsp-th-label">Historie</span>
                {v.count > 0 && <span className="tsp-hist-count">{v.count}{v.countSuffix}</span>}
                <span className="tsp-th-rule" />
                <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"
                     stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
              </button>

              {v.showItems && (
                <div className="tsp-history">
                  {history.map((e) => <EventRow event={e} key={evKey(e)} station={station} />)}
                </div>
              )}
              {v.showEmptyHint && <div className="tsp-empty-hist">Keine Meldungen vorhanden.</div>}
              {v.showLoading && <div className="tsp-loading">Historie wird geladen…</div>}
              {v.showError && (
                <button className="tsp-error" onClick={loadPage}>{error} — erneut versuchen</button>
              )}
              {v.showLoadMore && (
                <button className="tsp-loadmore" onClick={loadPage}>
                  <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
                  weitere Einträge laden…
                </button>
              )}
              {v.showCollapseFoot && (
                <button className="tsp-collapse-foot" onClick={() => collapseHistory(true)}>
                  <svg className="chev" width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
                  Historie einklappen
                </button>
              )}
            </React.Fragment>
          )}
        </div>
      )}
    </div>
  );
}
