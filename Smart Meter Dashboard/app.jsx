// Main app: dashboard grid, drag/resize handling, add-tile flow, metric editor.

const { useState: aState, useRef: aRef, useEffect: aEff, useMemo: aMemo } = React;

const DEFAULT_LAYOUT = [
  // Top row: KPIs across all four stations — at-a-glance overview
  { id: "t-l-temp", type: "kpi", stationId: "living",   title: "Temperatur",   metrics: ["temperature"], x: 0, y: 0, w: 3, h: 3 },
  { id: "t-b-temp", type: "kpi", stationId: "bedroom",  title: "Temperatur",   metrics: ["temperature"], x: 3, y: 0, w: 3, h: 3 },
  { id: "t-o-temp", type: "kpi", stationId: "outdoor",  title: "Temperatur",   metrics: ["temperature"], x: 6, y: 0, w: 3, h: 3 },
  { id: "t-c-temp", type: "kpi", stationId: "basement", title: "Temperatur",   metrics: ["temperature"], x: 9, y: 0, w: 3, h: 3 },

  // Comparison charts: temperature inside vs. outside
  { id: "t-chart-temp", type: "chart", stationId: "living",  title: "Wohnzimmer · Temperatur & Taupunkt", metrics: ["temperature", "dewpoint"],  x: 0, y: 3, w: 6, h: 4 },
  { id: "t-chart-out",  type: "chart", stationId: "outdoor", title: "Garten · Temperatur & Feuchte",       metrics: ["temperature", "humidity"],  x: 6, y: 3, w: 6, h: 4 },

  // Humidity gauges
  { id: "t-l-hum", type: "gauge", stationId: "living",   title: "Rel. Feuchte", metrics: ["humidity"], x: 0, y: 7, w: 3, h: 4 },
  { id: "t-b-hum", type: "gauge", stationId: "bedroom",  title: "Rel. Feuchte", metrics: ["humidity"], x: 3, y: 7, w: 3, h: 4 },
  { id: "t-c-hum", type: "gauge", stationId: "basement", title: "Rel. Feuchte", metrics: ["humidity"], x: 6, y: 7, w: 3, h: 4 },

  // Outdoor stats + pressure KPI
  { id: "t-o-stats", type: "stats", stationId: "outdoor", title: "Außen — Tageswerte", metrics: ["temperature", "humidity", "pressure", "abshumid"], x: 9, y: 7, w: 3, h: 4 },

  // Alerts per station, side by side
  { id: "t-alerts-out", type: "alerts", stationId: "outdoor", title: "Außensensor",  metrics: ["temperature", "humidity", "pressure", "dewpoint", "abshumid"], x: 0, y: 11, w: 6, h: 5 },
  { id: "t-alerts-bed", type: "alerts", stationId: "bedroom", title: "Schlafzimmer", metrics: ["temperature", "humidity", "pressure", "dewpoint", "abshumid"], x: 6, y: 11, w: 6, h: 5 },
];

const STORAGE_KEY = "dash-layout-v3";

function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return DEFAULT_LAYOUT;
}

function App() {
  const [layout, setLayout] = aState(loadLayout);
  const [editMode, setEditMode] = aState(true);
  const [addOpen, setAddOpen] = aState(false);
  const [editing, setEditing] = aState(null); // tile id being edited
  const [drag, setDrag] = aState(null);  // {id, origin, offset, ghost: {x,y,w,h}}
  const [resize, setResize] = aState(null); // {id, origin, start, ghost}
  const [thresholdOpen, setThresholdOpen] = aState(null); // stationId | null
  const [stationPickerOpen, setStationPickerOpen] = aState(false);
  const [view, setView] = aState("dashboard"); // 'dashboard' | 'settings'
  const [, forceTick] = aState(0);
  const gridRef = aRef(null);
  const [gridW, setGridW] = aState(1200);

  // Subscribe to data changes (station switch, threshold edits)
  aEff(() => window.DASH_DATA.subscribe(() => forceTick((v) => v + 1)), []);

  aEff(() => {
    if (!gridRef.current) return;
    const ro = new ResizeObserver(() => setGridW(gridRef.current.clientWidth));
    ro.observe(gridRef.current);
    setGridW(gridRef.current.clientWidth);
    return () => ro.disconnect();
  }, []);

  aEff(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch (e) {}
  }, [layout]);

  const cellW = (gridW - GAP * (COLS - 1)) / COLS;

  const totalRows = aMemo(() => layout.reduce((m, t) => Math.max(m, t.y + t.h), 0), [layout]);

  // ---- Drag handlers ----
  function startDrag(e, tile) {
    if (!editMode) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setDrag({
      id: tile.id,
      startMouse: { x: e.clientX, y: e.clientY },
      offsetInTile: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      ghost: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    });
  }
  function startResize(e, tile) {
    if (!editMode) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setResize({
      id: tile.id,
      startMouse: { x: e.clientX, y: e.clientY },
      start: { w: tile.w, h: tile.h },
      ghost: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    });
  }

  aEff(() => {
    if (!drag && !resize) return;
    function onMove(e) {
      if (drag) {
        const gridRect = gridRef.current.getBoundingClientRect();
        const px = e.clientX - gridRect.left - drag.offsetInTile.x;
        const py = e.clientY - gridRect.top - drag.offsetInTile.y;
        const x = Math.max(0, Math.round(px / (cellW + GAP)));
        const y = Math.max(0, Math.round(py / (ROW_H + GAP)));
        const t = layout.find((t) => t.id === drag.id);
        const clampedX = Math.min(COLS - t.w, x);
        setDrag({ ...drag, ghost: { x: clampedX, y, w: t.w, h: t.h } });
      } else if (resize) {
        const dx = e.clientX - resize.startMouse.x;
        const dy = e.clientY - resize.startMouse.y;
        const t = layout.find((t) => t.id === resize.id);
        const type = TILE_TYPES[t.type];
        const dw = Math.round(dx / (cellW + GAP));
        const dh = Math.round(dy / (ROW_H + GAP));
        const w = Math.max(type.minSize.w, Math.min(COLS - t.x, resize.start.w + dw));
        const h = Math.max(type.minSize.h, resize.start.h + dh);
        setResize({ ...resize, ghost: { x: t.x, y: t.y, w, h } });
      }
    }
    function onUp() {
      if (drag) {
        setLayout((L) => compactLayout(L, drag.id, drag.ghost));
        setDrag(null);
      } else if (resize) {
        setLayout((L) => compactLayout(L, resize.id, resize.ghost));
        setResize(null);
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, resize, layout, cellW]);

  // ---- Tile ops ----
  function addTile(type, stationId, metrics, title) {
    const cfg = TILE_TYPES[type];
    const { w, h } = cfg.defaultSize;
    const slot = findFreeSlot(layout, w, h);
    const id = "t" + Math.random().toString(36).slice(2, 8);
    setLayout((L) => [...L, { id, type, stationId, title, metrics, x: slot.x, y: slot.y, w, h }]);
    setAddOpen(false);
  }
  function removeTile(id) {
    setLayout((L) => L.filter((t) => t.id !== id));
  }
  function updateTile(id, patch) {
    setLayout((L) => L.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  function resetLayout() {
    if (confirm("Layout auf Standard zurücksetzen?")) setLayout(DEFAULT_LAYOUT);
  }

  // ---- Pixel positions ----
  function tilePos(t, ghost) {
    const r = ghost || t;
    return {
      left: r.x * (cellW + GAP),
      top: r.y * (ROW_H + GAP),
      width: r.w * cellW + (r.w - 1) * GAP,
      height: r.h * ROW_H + (r.h - 1) * GAP,
    };
  }

  const ghostFor = drag?.id || resize?.id;
  const ghostBox = drag?.ghost || resize?.ghost;

  return (
    <div className={`app ${editMode ? "edit-mode" : ""} ${view === "settings" ? "in-settings" : ""}`}>
      <Header
        editMode={editMode}
        onToggleEdit={() => setEditMode((v) => !v)}
        onAdd={() => setAddOpen(true)}
        onReset={resetLayout}
        tileCount={layout.length}
        stationPickerOpen={stationPickerOpen}
        onToggleStationPicker={() => setStationPickerOpen((v) => !v)}
        onCloseStationPicker={() => setStationPickerOpen(false)}
        view={view}
        onOpenSettings={() => setView("settings")}
        onLeaveSettings={() => setView("dashboard")}
      />

      {view === "settings" ? (
        <SettingsPage onClose={() => setView("dashboard")} />
      ) : (
        <div className="grid-shell">
        <div className="grid" ref={gridRef}
             style={{ height: Math.max(totalRows, 12) * (ROW_H + GAP) + 40 }}>
          {/* Background grid (edit mode only) */}
          {editMode && (
            <div className="grid-bg">
              {Array.from({ length: COLS }).map((_, i) => (
                <div key={i} className="grid-col" style={{ left: i * (cellW + GAP), width: cellW }} />
              ))}
            </div>
          )}

          {/* Ghost placeholder during drag/resize */}
          {ghostBox && (
            <div className="tile-ghost" style={tilePos(null, ghostBox)} />
          )}

          {layout.map((t) => {
            const isDragging = drag?.id === t.id;
            const isResizing = resize?.id === t.id;
            const pos = isDragging || isResizing ? tilePos(null, (drag || resize).ghost) : tilePos(t);
            const Body = TILE_BODIES[t.type];
            const bodyProps = { tile: t };
            if (t.type === "alerts") bodyProps.onOpenSettings = () => setThresholdOpen(t.stationId || window.DASH_DATA.activeStationId);
            return (
              <div className="tile-pos" key={t.id} style={pos}>
                <TileFrame
                  tile={t}
                  editMode={editMode}
                  dragging={isDragging}
                  resizing={isResizing}
                  onMouseDownDrag={(e) => startDrag(e, t)}
                  onMouseDownResize={(e) => startResize(e, t)}
                  onRemove={() => removeTile(t.id)}
                  onEdit={() => setEditing(t.id)}
                >
                  <Body {...bodyProps} />
                </TileFrame>
              </div>
            );
          })}
        </div>
      </div>
      )}

      {addOpen && <AddTileDialog onClose={() => setAddOpen(false)} onAdd={addTile} />}
      {editing && (
        <EditTileDialog
          tile={layout.find((t) => t.id === editing)}
          onClose={() => setEditing(null)}
          onSave={(patch) => { updateTile(editing, patch); setEditing(null); }}
        />
      )}
      {thresholdOpen && (
        <ThresholdDialog
          stationId={thresholdOpen}
          onClose={() => setThresholdOpen(null)}
          onChange={() => forceTick((v) => v + 1)}
        />
      )}
    </div>
  );
}

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
      {!inSettings && (
        <div className="top-summary" title="System-Überblick">
          <SummaryDot severity="alarm"   count={totals.alarm} />
          <SummaryDot severity="warning" count={totals.warning} />
          <SummaryDot severity="system"  count={totals.system} />
          <span className="top-summary-label">über alle Messstellen</span>
        </div>
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
  const ref = aRef(null);
  aEff(() => {
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
              ? <>online · Batterie {station.battery} %</>
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
                    <span className="si-stat"><BatteryIcon level={s.battery} /> {s.battery} %</span>
                    <span className="si-stat"><SignalIcon level={s.signal} /> {s.online ? `${s.signal} %` : "—"}</span>
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

// ---------- Add tile dialog ----------
function AddTileDialog({ onClose, onAdd }) {
  const [step, setStep] = aState(1);
  const [type, setType] = aState("chart");
  const [stationId, setStationId] = aState(window.DASH_DATA.stationOrder[0]);
  const [metrics, setMetrics] = aState([]);
  const [title, setTitle] = aState("");

  const D = window.DASH_DATA;
  const cfg = TILE_TYPES[type];
  const station = D.stations[stationId];

  function pickType(t) {
    setType(t);
    setMetrics([]);
    setTitle("");
    setStep(2);
  }
  function pickStation(sid) {
    setStationId(sid);
    setStep(3);
  }

  function toggleMetric(id) {
    setMetrics((cur) => {
      if (cur.includes(id)) return cur.filter((m) => m !== id);
      if (cur.length >= cfg.maxMetrics) {
        if (cfg.maxMetrics === 1) return [id];
        return cur;
      }
      return [...cur, id];
    });
  }

  function suggestTitle() {
    if (!metrics.length) return `${station.name} · ${cfg.label}`;
    if (type === "alerts") return `${station.name} · Meldungen`;
    const labels = metrics.map((id) => station.metrics[id].short).join(" · ");
    return `${station.name} · ${labels}`;
  }

  function commit() {
    onAdd(type, stationId, metrics, title.trim() || suggestTitle());
  }

  return (
    <Modal onClose={onClose} title="Neue Kachel">
      <div className="dialog">
        <div className="steps">
          <span className={step === 1 ? "active" : "done"}>1 · Typ</span>
          <span className={step === 2 ? "active" : (step > 2 ? "done" : "")}>2 · Messstelle</span>
          <span className={step === 3 ? "active" : (step > 3 ? "done" : "")}>3 · Messwerte</span>
          <span className={step === 4 ? "active" : ""}>4 · Bezeichnung</span>
        </div>

        {step === 1 && (
          <div className="type-grid">
            {Object.values(TILE_TYPES).map((t) => (
              <button key={t.id} className={`type-card ${type === t.id ? "sel" : ""}`} onClick={() => pickType(t.id)}>
                <TilePreview type={t.id} />
                <div className="tc-label">{t.label}</div>
                <div className="tc-desc">{t.desc}</div>
              </button>
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="station-pick">
            <div className="hint">Aus welcher Messstelle stammen die Daten dieser Kachel?</div>
            <div className="station-grid">
              {D.stationOrder.map((sid) => {
                const s = D.stations[sid];
                return (
                  <button key={sid}
                    className={`station-card ${stationId === sid ? "sel" : ""} ${s.online ? "on" : "off"}`}
                    onClick={() => pickStation(sid)}>
                    <span className={`station-dot ${s.online ? "on" : "off"}`} />
                    <div className="sc-text">
                      <div className="sc-name">{s.name}<span className="station-code">{s.code}</span></div>
                      <div className="sc-sub">{s.location} · {s.online ? `online · Batterie ${s.battery} %` : `offline · zuletzt ${D.formatRelative(s.lastSeen)}`}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="dialog-foot">
              <button className="btn ghost" onClick={() => setStep(1)}>Zurück</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="metric-pick">
            <div className="hint">
              Messgrößen aus <strong>{station.name}</strong> — {cfg.maxMetrics === 1 ? "eine auswählen" : `bis zu ${cfg.maxMetrics} kombinierbar`}.
            </div>
            <div className="metric-grid">
              {D.metricIds.map((id) => {
                const M = station.metrics[id];
                const on = metrics.includes(id);
                return (
                  <button key={id} className={`metric-card ${on ? "sel" : ""}`} onClick={() => toggleMetric(id)}>
                    <span className="mc-dot" style={{ background: M.color }} />
                    <span className="mc-label">{M.label}</span>
                    <span className="mc-unit">{M.unit}</span>
                    <span className="mc-val">{Number.isNaN(M.series[M.series.length - 1]) || M.series[M.series.length - 1] == null ? "—" : M.series[M.series.length - 1].toFixed(M.decimals)}</span>
                  </button>
                );
              })}
            </div>
            <div className="dialog-foot">
              <button className="btn ghost" onClick={() => setStep(2)}>Zurück</button>
              <button className="btn primary" disabled={!metrics.length} onClick={() => { setTitle(suggestTitle()); setStep(4); }}>Weiter</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="title-step">
            <label className="field">
              <span>Bezeichnung der Kachel</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={suggestTitle()} autoFocus />
            </label>
            <div className="preview-pane">
              <div className="pp-label">Vorschau</div>
              <div className="pp-tile">
                <div className="tile-head">
                  <div className="tile-title">
                    <span className="tile-name">{title || suggestTitle()}</span>
                    <span className={`tile-station ${station.online ? "on" : "off"}`}>
                      <span className="tile-station-dot" />
                      <span className="tile-station-name">{station.name}</span>
                      <span className="tile-station-code">{station.code}</span>
                    </span>
                  </div>
                </div>
                <div className="tile-body">
                  {React.createElement(TILE_BODIES[type], { tile: { type, stationId, metrics, title: title || suggestTitle() } })}
                </div>
              </div>
            </div>
            <div className="dialog-foot">
              <button className="btn ghost" onClick={() => setStep(3)}>Zurück</button>
              <button className="btn primary" onClick={commit}>Hinzufügen</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- Edit tile dialog ----------
function EditTileDialog({ tile, onClose, onSave }) {
  const cfg = TILE_TYPES[tile.type];
  const D = window.DASH_DATA;
  const [stationId, setStationId] = aState(tile.stationId || D.stationOrder[0]);
  const [metrics, setMetrics] = aState(tile.metrics);
  const [title, setTitle] = aState(tile.title);

  const station = D.stations[stationId];

  function toggleMetric(id) {
    setMetrics((cur) => {
      if (cur.includes(id)) return cur.filter((m) => m !== id);
      if (cur.length >= cfg.maxMetrics) {
        if (cfg.maxMetrics === 1) return [id];
        return cur;
      }
      return [...cur, id];
    });
  }

  return (
    <Modal onClose={onClose} title={`Kachel bearbeiten · ${cfg.label}`}>
      <div className="dialog">
        <label className="field">
          <span>Bezeichnung</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <div className="field">
          <span>Messstelle</span>
          <div className="station-grid compact">
            {D.stationOrder.map((sid) => {
              const s = D.stations[sid];
              return (
                <button key={sid}
                  className={`station-card ${stationId === sid ? "sel" : ""} ${s.online ? "on" : "off"}`}
                  onClick={() => setStationId(sid)}>
                  <span className={`station-dot ${s.online ? "on" : "off"}`} />
                  <div className="sc-text">
                    <div className="sc-name">{s.name}<span className="station-code">{s.code}</span></div>
                    <div className="sc-sub">{s.location}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="hint">
          Messgrößen aus <strong>{station.name}</strong> — {cfg.maxMetrics === 1 ? "eine auswählen" : `bis zu ${cfg.maxMetrics}`}.
        </div>
        <div className="metric-grid">
          {D.metricIds.map((id) => {
            const M = station.metrics[id];
            const on = metrics.includes(id);
            return (
              <button key={id} className={`metric-card ${on ? "sel" : ""}`} onClick={() => toggleMetric(id)}>
                <span className="mc-dot" style={{ background: M.color }} />
                <span className="mc-label">{M.label}</span>
                <span className="mc-unit">{M.unit}</span>
                <span className="mc-val">{Number.isNaN(M.series[M.series.length - 1]) || M.series[M.series.length - 1] == null ? "—" : M.series[M.series.length - 1].toFixed(M.decimals)}</span>
              </button>
            );
          })}
        </div>
        <div className="dialog-foot">
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={!metrics.length}
                  onClick={() => onSave({ stationId, metrics, title: title.trim() || cfg.label })}>
            Speichern
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ThresholdDialog({ stationId, onClose, onChange }) {
  const D = window.DASH_DATA;
  const station = D.stations[stationId] || D.activeStation;
  const [, tick] = aState(0);
  function setBound(mid, level, idx, v) {
    const num = parseFloat(v);
    if (Number.isNaN(num)) return;
    // Threshold edits target THIS station, not the global active one.
    station.thresholds[mid][level][idx] = num;
    // recompute events for this station
    if (window.DASH_DATA.recomputeStationEvents) {
      window.DASH_DATA.recomputeStationEvents(station.id);
    } else {
      // fallback: use setThreshold via temporary active swap
      const prev = D.activeStationId;
      D.setActiveStation(station.id);
      D.setThreshold(mid, level, idx, num);
      if (prev !== station.id) D.setActiveStation(prev);
    }
    tick((x) => x + 1);
    onChange?.();
  }
  return (
    <Modal onClose={onClose} title={`Schwellwerte · ${station.name}`}>
      <div className="dialog">
        <div className="hint">
          Für jede Messgröße ein Warn- und ein Alarmbereich. Werte außerhalb lösen automatisch eine Meldung aus; die Rückkehr in den Normalbereich beendet sie. <strong>Diese Werte gelten nur für {station.name} ({station.code}).</strong>
        </div>
        <div className="thr-table">
          <div className="thr-head">
            <span>Messgröße</span>
            <span className="thr-col warn">Warnung (von – bis)</span>
            <span className="thr-col alarm">Alarm (von – bis)</span>
          </div>
          {D.metricIds.map((mid) => {
            const M = station.metrics[mid];
            const t = station.thresholds[mid];
            return (
              <div className="thr-row" key={mid}>
                <span className="thr-name"><span className="legend-dot" style={{ background: M.color }} />{M.label}<span className="thr-unit">{M.unit}</span></span>
                <span className="thr-col">
                  <input type="number" step={M.decimals ? "0.1" : "1"} value={t.warn[0]} onChange={(e) => setBound(mid, "warn", 0, e.target.value)} />
                  <span className="thr-sep">–</span>
                  <input type="number" step={M.decimals ? "0.1" : "1"} value={t.warn[1]} onChange={(e) => setBound(mid, "warn", 1, e.target.value)} />
                </span>
                <span className="thr-col">
                  <input type="number" step={M.decimals ? "0.1" : "1"} value={t.alarm[0]} onChange={(e) => setBound(mid, "alarm", 0, e.target.value)} />
                  <span className="thr-sep">–</span>
                  <input type="number" step={M.decimals ? "0.1" : "1"} value={t.alarm[1]} onChange={(e) => setBound(mid, "alarm", 1, e.target.value)} />
                </span>
              </div>
            );
          })}
        </div>
        <div className="dialog-foot">
          <button className="btn primary" onClick={onClose}>Fertig</button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({ children, onClose, title }) {
  aEff(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn lg" onClick={onClose} title="Schließen">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 3l10 10M13 3 3 13"/></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Mini SVG preview of a tile type for the "add" picker.
function TilePreview({ type }) {
  if (type === "kpi") return (
    <svg viewBox="0 0 80 40" className="tp">
      <rect x="6" y="8" width="22" height="3" rx="1.5" fill="var(--border-strong)"/>
      <rect x="6" y="14" width="34" height="8" rx="1.5" fill="var(--accent)"/>
      <path d="M6 36 Q20 28 36 30 T74 26" stroke="var(--accent)" strokeWidth="1.4" fill="none"/>
    </svg>
  );
  if (type === "chart") return (
    <svg viewBox="0 0 80 40" className="tp">
      <path d="M6 32 Q20 12 36 18 T74 10" stroke="var(--accent)" strokeWidth="1.6" fill="none"/>
      <path d="M6 26 Q22 32 36 22 T74 30" stroke="oklch(0.62 0.12 230)" strokeWidth="1.6" fill="none"/>
    </svg>
  );
  if (type === "gauge") return (
    <svg viewBox="0 0 80 40" className="tp">
      <path d="M14 36 A26 26 0 0 1 66 36" stroke="var(--border-strong)" strokeWidth="4" fill="none"/>
      <path d="M14 36 A26 26 0 0 1 50 13" stroke="var(--accent)" strokeWidth="4" fill="none" strokeLinecap="round"/>
    </svg>
  );
  if (type === "stats") return (
    <svg viewBox="0 0 80 40" className="tp">
      <rect x="6" y="8" width="68" height="3" rx="1" fill="var(--border-strong)"/>
      <rect x="6" y="16" width="68" height="3" rx="1" fill="var(--border)"/>
      <rect x="6" y="24" width="68" height="3" rx="1" fill="var(--border)"/>
      <rect x="6" y="32" width="68" height="3" rx="1" fill="var(--border)"/>
    </svg>
  );
  if (type === "alerts") return (
    <svg viewBox="0 0 80 40" className="tp">
      <rect x="6" y="6" width="14" height="8" rx="2" fill="var(--alarm)"/>
      <rect x="22" y="6" width="14" height="8" rx="2" fill="var(--warn)"/>
      <rect x="38" y="6" width="14" height="8" rx="2" fill="var(--border-strong)"/>
      <rect x="6" y="18" width="68" height="2" rx="1" fill="var(--border)"/>
      <circle cx="14" cy="19" r="2" fill="var(--alarm)"/>
      <circle cx="40" cy="19" r="2" fill="var(--warn)"/>
      <circle cx="58" cy="19" r="2" fill="var(--border-strong)"/>
      <rect x="6" y="26" width="68" height="4" rx="1.5" fill="var(--surface-2)" stroke="var(--border)"/>
      <rect x="6" y="32" width="68" height="4" rx="1.5" fill="var(--surface-2)" stroke="var(--border)"/>
    </svg>
  );
  return null;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
