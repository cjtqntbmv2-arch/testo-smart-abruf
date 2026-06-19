// Main app: dashboard grid, drag/resize handling, add-tile flow, metric editor.

const { useState: aState, useRef: aRef, useEffect: aEff, useMemo: aMemo } = React;

// Fresh installs / clean browsers start with no tiles and see the onboarding
// empty-state instead. Tiles are user-configured and persisted to localStorage
// (STORAGE_KEY). Seeding demo tiles here would reference station IDs that don't
// exist in a real install, rendering a wall of "Messstelle gelöscht".
const DEFAULT_LAYOUT = [];

const STORAGE_KEY = "dash-layout-v3";

function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return DEFAULT_LAYOUT;
      // Keep only well-formed entries. Unknown types would make TILE_BODIES[t.type]
      // undefined and crash React, so we filter them out rather than blow up.
      return parsed.filter((t) =>
        t !== null &&
        typeof t === "object" &&
        typeof t.id === "string" &&
        typeof t.type === "string" && t.type in TILE_TYPES &&
        typeof t.x === "number" && typeof t.y === "number" &&
        typeof t.w === "number" && typeof t.h === "number"
      ).map((t) => ({ ...t, metrics: Array.isArray(t.metrics) ? t.metrics : [] }));
    }
  } catch (e) {}
  return DEFAULT_LAYOUT;
}

// Per-tile error boundary: one failing tile degrades to an inline error card
// while the rest of the dashboard keeps working. Class components are the only
// way to catch render-phase errors — function components cannot do this.
class TileErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("[TileErrorBoundary] Tile render error:", error, info);
  }
  render() {
    if (this.state.hasError) {
      const title = this.props.tileTitle || "Kachel";
      return (
        <div className="tile-error-card" title={this.state.error?.message}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--alarm)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.8rem" }}>{title}</div>
            <div style={{ fontSize: "0.75rem", opacity: 0.75 }}>Diese Kachel konnte nicht angezeigt werden.</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [layout, setLayout] = aState(loadLayout);
  const [editMode, setEditMode] = aState(true);
  const [addOpen, setAddOpen] = aState(false);
  const [editing, setEditing] = aState(null); // tile id being edited
  const [drag, setDrag] = aState(null);  // {id, origin, offset, ghost: {x,y,w,h}}
  const [resize, setResize] = aState(null); // {id, origin, start, ghost}
  const [stationPickerOpen, setStationPickerOpen] = aState(false);
  const [view, setView] = aState("dashboard"); // 'dashboard' | 'settings'
  const [, forceTick] = aState(0);
  const gridRef = aRef(null);
  const [gridW, setGridW] = aState(1200);

  // Subscribe to data changes (station switch, polling refresh)
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
  function addTile(type, stationId, metrics, title, limitFlags) {
    const cfg = TILE_TYPES[type];
    const { w, h } = cfg.defaultSize;
    const slot = findFreeSlot(layout, w, h);
    const id = "t" + Math.random().toString(36).slice(2, 8);
    const tile = { id, type, stationId, title, metrics, x: slot.x, y: slot.y, w, h };
    if (cfg.supportsLimitFlags && limitFlags === false) tile.limitFlags = false;
    setLayout((L) => [...L, tile]);
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

      {/* K2: offline / stale-data banner — only shown in dashboard view */}
      {view !== "settings" && window.DASH_DATA.connectionError && (
        <div className="offline-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span>
            Backend nicht erreichbar — Anzeige ist möglicherweise veraltet
            {window.DASH_DATA.lastUpdated
              ? ` (zuletzt aktualisiert ${window.DASH_DATA.formatRelative(window.DASH_DATA.lastUpdated)})`
              : ""}
          </span>
        </div>
      )}

      {view === "settings" ? (
        <SettingsPage onClose={() => setView("dashboard")} />
      ) : layout.length === 0 ? (
        <div className="grid-shell">
          <div className="empty-dash">
            <div className="empty-dash-card">
              <div className="empty-dash-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5"/>
                  <rect x="14" y="3" width="7" height="7" rx="1.5"/>
                  <rect x="3" y="14" width="7" height="7" rx="1.5"/>
                  <path d="M17.5 14.5 V20.5 M14.5 17.5 H20.5"/>
                </svg>
              </div>
              <div className="empty-dash-title">Noch keine Kacheln</div>
              <div className="empty-dash-sub">Füge deine erste Kachel hinzu, um Messwerte deiner Messstellen anzuzeigen.</div>
              <button className="btn primary" onClick={() => setAddOpen(true)}>+ Kachel hinzufügen</button>
            </div>
          </div>
        </div>
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
                  <TileErrorBoundary tileTitle={t.title}>
                    <Body {...bodyProps} />
                  </TileErrorBoundary>
                </TileFrame>
              </div>
            );
          })}
        </div>
      </div>
      )}

      {addOpen && (
        <AddTileDialog
          onClose={() => setAddOpen(false)}
          onAdd={addTile}
          onGoToSettings={() => { setAddOpen(false); setView("settings"); }}
        />
      )}
      {editing && (
        <EditTileDialog
          tile={layout.find((t) => t.id === editing)}
          onClose={() => setEditing(null)}
          onSave={(patch) => { updateTile(editing, patch); setEditing(null); }}
        />
      )}
    </div>
  );
}

// ---------- Add tile dialog ----------
function AddTileDialog({ onClose, onAdd, onGoToSettings }) {
  const [step, setStep] = aState(1);
  const [type, setType] = aState("chart");
  const [stationId, setStationId] = aState(window.DASH_DATA.stationOrder[0]);
  const [metrics, setMetrics] = aState([]);
  const [title, setTitle] = aState("");
  const [limitFlags, setLimitFlags] = aState(true);

  const D = window.DASH_DATA;
  const cfg = TILE_TYPES[type];
  // Guard: station may be undefined when stationOrder is empty or during a race
  const station = stationId ? D.stations[stationId] : undefined;

  // H6: no stations at all — render guidance state instead of the stepper
  const noStations = D.stationOrder.length === 0;

  function pickType(t) {
    setType(t);
    setMetrics([]);
    setTitle("");
    setLimitFlags(true);
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
    // Defensive: station or metrics may be unavailable during a race
    if (!station) return cfg.label;
    if (!metrics.length) return `${station.name} · ${cfg.label}`;
    if (type === "alerts") return `${station.name} · Meldungen`;
    const labels = metrics.map((id) => station.metrics[id]?.short ?? id).join(" · ");
    return `${station.name} · ${labels}`;
  }

  function commit() {
    onAdd(type, stationId, metrics, title.trim() || suggestTitle(), limitFlags);
  }

  // H6: early-return guidance when there are no stations yet
  if (noStations) {
    return (
      <Modal onClose={onClose} title="Neue Kachel">
        <div className="dialog">
          <div className="empty-dash" style={{ padding: "1.5rem 0" }}>
            <div className="empty-dash-card" style={{ boxShadow: "none", border: "none", background: "transparent" }}>
              <div className="empty-dash-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>
                </svg>
              </div>
              <div className="empty-dash-title">Noch keine Messstellen vorhanden</div>
              <div className="empty-dash-sub">
                Lege zuerst in den Einstellungen unter &ldquo;Messstellen&rdquo; eine Messstelle an,
                bevor du Kacheln hinzufügst.
              </div>
              {onGoToSettings && (
                <button className="btn primary" onClick={onGoToSettings}>Zu den Einstellungen</button>
              )}
            </div>
          </div>
        </div>
      </Modal>
    );
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
            {cfg.supportsLimitFlags && (
              <label className="dialog-check">
                <input type="checkbox" checked={limitFlags} onChange={(e) => setLimitFlags(e.target.checked)} />
                <span>Grenzwert-Status an den Messwerten anzeigen</span>
              </label>
            )}
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
                  {React.createElement(TILE_BODIES[type], { tile: { type, stationId, metrics, title: title || suggestTitle(), limitFlags } })}
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

  // Guard: the tile's station may have been deleted — fall back to first available
  const noStations = D.stationOrder.length === 0;
  const initialStationId = D.stations[tile.stationId]
    ? tile.stationId
    : (D.stationOrder[0] || tile.stationId);

  const [stationId, setStationId] = aState(initialStationId);
  const [metrics, setMetrics] = aState(tile.metrics);
  const [title, setTitle] = aState(tile.title);
  const [limitFlags, setLimitFlags] = aState(tile.limitFlags !== false);

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

  // No stations at all — render a notice instead of the edit form
  if (noStations) {
    return (
      <Modal onClose={onClose} title={`Kachel bearbeiten · ${cfg.label}`}>
        <div className="dialog">
          <div className="empty-dash" style={{ padding: "1.5rem 0" }}>
            <div className="empty-dash-card" style={{ boxShadow: "none", border: "none", background: "transparent" }}>
              <div className="empty-dash-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>
                </svg>
              </div>
              <div className="empty-dash-title">Messstelle nicht mehr vorhanden</div>
              <div className="empty-dash-sub">
                Die Messstelle dieser Kachel existiert nicht mehr und es sind keine Messstellen vorhanden.
              </div>
              <button className="btn ghost" onClick={onClose}>Schließen</button>
            </div>
          </div>
        </div>
      </Modal>
    );
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

        {station && (
          <>
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
            {cfg.supportsLimitFlags && (
              <label className="dialog-check">
                <input type="checkbox" checked={limitFlags} onChange={(e) => setLimitFlags(e.target.checked)} />
                <span>Grenzwert-Status an den Messwerten anzeigen</span>
              </label>
            )}
          </>
        )}
        <div className="dialog-foot">
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={!metrics.length}
                  onClick={() => onSave({ stationId, metrics, title: title.trim() || cfg.label, ...(cfg.supportsLimitFlags ? { limitFlags } : {}) })}>
            Speichern
          </button>
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
