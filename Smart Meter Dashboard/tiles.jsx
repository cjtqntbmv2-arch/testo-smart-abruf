// Tile system: a grid layout with drag-to-move and corner-resize handles.
// Layout: COLS columns, variable rows. Each tile has {id, type, metrics, x, y, w, h}.
// Collision-on-drop: if dropped tile would overlap others, push them down.

const { useRef: tRef, useEffect: tEff, useState: tState, useCallback } = React;

const COLS = 12;
const ROW_H = 72;
const GAP = 14;

// Tile type registry
const TILE_TYPES = {
  kpi: {
    id: "kpi",
    label: "Kennzahl",
    desc: "Großer Live-Wert mit Sparkline & Trend.",
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
    maxMetrics: 1,
  },
  chart: {
    id: "chart",
    label: "Linien-Diagramm",
    desc: "1–4 Messwerte über 24 h, frei kombinierbar.",
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    maxMetrics: 4,
  },
  gauge: {
    id: "gauge",
    label: "Tachometer",
    desc: "Halbkreis-Anzeige des aktuellen Wertes.",
    defaultSize: { w: 3, h: 4 },
    minSize: { w: 3, h: 3 },
    maxMetrics: 1,
  },
  stats: {
    id: "stats",
    label: "Statistik",
    desc: "Min, Max, Mittelwert & Spannweite.",
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxMetrics: 4,
  },
  alerts: {
    id: "alerts",
    label: "Meldungen & Grenzwerte",
    desc: "Alarm-/Warnverletzungen plus Systemmeldungen \u2014 mit Timeline.",
    defaultSize: { w: 8, h: 5 },
    minSize: { w: 4, h: 3 },
    maxMetrics: 5,
    hasSettings: true,
  },
};

// ---------- Layout math ----------
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Move tile to (x,y) with size (w,h); push colliding tiles downward.
function compactLayout(layout, movedId, target) {
  const items = layout.map((t) => (t.id === movedId ? { ...t, ...target } : { ...t }));
  // Iterative push-down until no overlaps
  let safety = 200;
  while (safety-- > 0) {
    let changed = false;
    const moved = items.find((t) => t.id === movedId);
    for (const t of items) {
      if (t.id === movedId) continue;
      if (rectsOverlap(moved, t)) {
        // push t below moved
        const newY = moved.y + moved.h;
        if (t.y < newY) {
          t.y = newY;
          changed = true;
        }
      }
    }
    // Cascade between non-moved
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const A = items[i], B = items[j];
        if (A.id === movedId || B.id === movedId) continue;
        if (rectsOverlap(A, B)) {
          // push B below A if A is higher
          if (A.y <= B.y) {
            const newY = A.y + A.h;
            if (B.y < newY) {
              B.y = newY;
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) break;
  }
  return items;
}

// Find first non-overlapping position for a new tile of given size.
function findFreeSlot(layout, w, h) {
  // try rows from 0 down
  for (let y = 0; y < 60; y++) {
    for (let x = 0; x <= COLS - w; x++) {
      const cand = { x, y, w, h };
      if (!layout.some((t) => rectsOverlap(cand, t))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

// ---------- Tile chrome ----------
function TileFrame({ tile, onMouseDownDrag, onMouseDownResize, onRemove, onEdit, children, dragging, resizing, editMode }) {
  const station = tile.stationId ? window.DASH_DATA.stations[tile.stationId] : null;
  return (
    <div className={`tile ${dragging ? "is-dragging" : ""} ${resizing ? "is-resizing" : ""}`}>
      <div className="tile-head" onMouseDown={editMode ? onMouseDownDrag : undefined}>
        <div className="tile-title">
          <span className="tile-grip" aria-hidden="true">
            <svg width="10" height="14" viewBox="0 0 10 14"><circle cx="2" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="8" cy="2" r="1.2"/><circle cx="8" cy="7" r="1.2"/><circle cx="8" cy="12" r="1.2"/></svg>
          </span>
          <span className="tile-name">{tile.title}</span>
          {station && (
            <span className={`tile-station ${station.online ? "on" : "off"}`} title={`${station.name} · ${station.location}`}>
              <span className="tile-station-dot" />
              <span className="tile-station-name">{station.name}</span>
              <span className="tile-station-code">{station.code}</span>
            </span>
          )}
        </div>
        {editMode && (
          <div className="tile-actions">
            <button className="icon-btn" title="Messwerte bearbeiten" onClick={onEdit}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 10.5V12h1.5L11 4.5 9.5 3 2 10.5z"/></svg>
            </button>
            <button className="icon-btn" title="Entfernen" onClick={onRemove}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 3l8 8M11 3l-8 8"/></svg>
            </button>
          </div>
        )}
      </div>
      <div className="tile-body">{children}</div>
      {editMode && (
        <div className="tile-resize" onMouseDown={onMouseDownResize} title="Größe ändern">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M14 5v9H5M14 9v5H9M14 13h1" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
        </div>
      )}
    </div>
  );
}

// Helper: resolve a tile's station (falls back to active station for legacy tiles).
function tileStation(tile) {
  if (tile.stationId) return window.DASH_DATA.stations[tile.stationId];
  return window.DASH_DATA.activeStation;
}

function EmptyDeleted() {
  return <div className="tile-empty" style={{color: "var(--alarm)"}}>Messstelle gelöscht.<br/>Kachel bitte entfernen.</div>;
}

// ---------- Tile bodies ----------
function KpiBody({ tile }) {
  const station = tileStation(tile);
  if (!station) return <EmptyDeleted />;
  const M = station.metrics[tile.metrics[0]];
  if (!M) return <Empty />;
  const s = window.DASH_DATA.stats(M.series);
  const trend = s.last - s.first;
  const trendPct = (trend / (s.first || 1)) * 100;
  const trendUp = trend > 0;
  return (
    <div className="kpi">
      <div className="kpi-meta">
        <span className="kpi-label">{M.label}</span>
        <span className="kpi-dot" style={{ background: M.color }} />
      </div>
      <div className="kpi-value">
        <span className="num">{Number.isNaN(s.last) || s.last == null ? "—" : s.last.toFixed(M.decimals)}</span>
        <span className="unit">{M.unit}</span>
      </div>
      <div className="kpi-trend">
        {(Number.isNaN(s.last) || Number.isNaN(s.first)) ? (
          <span className="trend down">— {M.unit}</span>
        ) : (
          <span className={`trend ${trendUp ? "up" : "down"}`}>
            {trendUp ? "▲" : "▼"} {Math.abs(trend).toFixed(M.decimals)} {M.unit}
            <span className="trend-pct">({trendPct >= 0 ? "+" : ""}{trendPct.toFixed(1)} %)</span>
          </span>
        )}
        <span className="kpi-range">24 h</span>
      </div>
      <Sparkline series={M.series} color={M.color} height={44} />
    </div>
  );
}

function AlertFlag({ status }) {
  const label = status === "alarm" ? "Alarm aktiv" : "Warnung aktiv";
  return (
    <span className={`cv-flag is-${status}`} role="img" aria-label={label} title={label}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <path d="M7 2l6 10H1z"/><path d="M7 6v3M7 10.5v.5" strokeLinecap="round"/>
      </svg>
    </span>
  );
}

function MetricValue({ metric, status, trend, hidePct, hideTrend }) {
  const last = trend.last;
  const valStr = (last == null || Number.isNaN(last)) ? "—" : last.toFixed(metric.decimals);
  const up = trend.delta > 0;
  return (
    <div className="cv-item">
      <span className="cv-label">
        <span className="legend-dot" style={{ background: metric.color }} />
        {metric.short}
      </span>
      <span className="cv-value-row">
        <span className={`cv-value ${status === "alarm" ? "is-alarm" : ""}`}>
          {valStr}<span className="cv-unit">{metric.unit}</span>
        </span>
        {status && <AlertFlag status={status} />}
      </span>
      {!hideTrend && trend.hasTrend && (
        <span className={`cv-trend trend ${up ? "up" : "down"}`}>
          {up ? "▲" : "▼"} {Math.abs(trend.delta).toFixed(metric.decimals)} {metric.unit}
          {!hidePct && (
            <span className="trend-pct">({trend.pct >= 0 ? "+" : ""}{trend.pct.toFixed(1)} %)</span>
          )}
          <span className="cv-range">1 h</span>
        </span>
      )}
    </div>
  );
}

function ChartBody({ tile }) {
  // Hooks must run before any early return (Rules of Hooks) — same order as AlertsBody.
  const ref = tRef(null);
  const size = useSize(ref);
  if (!tile.metrics.length) return <Empty />;
  const station = tileStation(tile);
  if (!station) return <EmptyDeleted />;
  // Responsive staircase. A 3x3 chart tile = 3*72 + 2*14 = 244px tall, minus tile head
  // (~36) + body padding (~18) => ~190px for .chart-wrap, and ~240-290px wide. So the % is
  // dropped on a narrow tile (always true at the 3-col minimum), while the whole trend line
  // is only dropped on a genuinely tiny tile below the 3x3 minimum (defensive).
  const hidePct = size.w > 0 && size.w < 360;
  const hideTrend = (size.h > 0 && size.h < 120) || (size.w > 0 && size.w < 220);
  const D = window.DASH_DATA;
  const ts = station.timestamps || D.timestamps;
  return (
    <div className="chart-wrap" ref={ref}>
      <div className="chart-values">
        {tile.metrics.map((id) => {
          const M = station.metrics[id];
          if (!M) return null;
          const status = D.metricAlertStatus(station.events, id);
          const trend = D.metricTrend(M.series, ts, 3600000);
          return <MetricValue key={id} metric={M} status={status} trend={trend} hidePct={hidePct} hideTrend={hideTrend} />;
        })}
      </div>
      <div className="chart-area">
        <LineChart metricIds={tile.metrics} stationId={station.id} timestamps={ts} />
      </div>
    </div>
  );
}

function GaugeBody({ tile }) {
  // Hooks must run before any early return (Rules of Hooks) — same order as ChartBody/AlertsBody.
  const ref = tRef(null);
  const size = useSize(ref);
  const id = tile.metrics[0];
  if (!id) return <Empty />;
  const station = tileStation(tile);
  if (!station) return <EmptyDeleted />;
  const M = station.metrics[id];
  return (
    <div className="gauge-wrap" ref={ref}>
      <div className="gauge-label">{M.label}</div>
      <Gauge metricId={id} stationId={station.id} size={size} />
    </div>
  );
}

function StatsBody({ tile }) {
  if (!tile.metrics.length) return <Empty />;
  const station = tileStation(tile);
  if (!station) return <EmptyDeleted />;
  return (
    <div className="stats">
      <div className="stats-grid">
        <div className="stats-head">
          <span>Messgröße</span><span>Aktuell</span><span>Min</span><span>Max</span><span>Ø</span>
        </div>
        {tile.metrics.map((id) => {
          const M = station.metrics[id];
          const s = window.DASH_DATA.stats(M.series);
          const fmt = (v) => (v == null || Number.isNaN(v)) ? "—" : v.toFixed(M.decimals);
          return (
            <div className="stats-row" key={id}>
              <span className="srow-name"><span className="legend-dot" style={{ background: M.color }} />{M.short}</span>
              <span className="srow-v current">{fmt(s.last)}<span className="srow-u">{M.unit}</span></span>
              <span className="srow-v">{fmt(s.min)}</span>
              <span className="srow-v">{fmt(s.max)}</span>
              <span className="srow-v">{fmt(s.avg)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Empty() {
  return <div className="tile-empty">Keine Messwerte zugewiesen.<br/>Stiftsymbol oben rechts anklicken.</div>;
}

// ---------- Alerts body ----------
function AlertsBody({ tile }) {
  const [filter, setFilter] = tState("all");
  const ref = tRef(null);
  const size = useSize(ref);
  const compact = size.h > 0 && size.h < 240;
  const veryCompact = size.h > 0 && size.h < 180;
  const narrow = size.w > 0 && size.w < 380;

  const station = tileStation(tile);
  if (!station) return <EmptyDeleted />;
  const allowed = tile.metrics && tile.metrics.length ? new Set(tile.metrics) : null;
  const events = station.events.filter((e) => {
    if (e.severity === "system") return true; // always show system
    if (!allowed) return true;
    return allowed.has(e.metric);
  });

  const filtered = events.filter((e) => {
    if (filter === "all") return true;
    if (filter === "active") return e.active;
    if (filter === "alarm") return e.severity === "alarm";
    if (filter === "warning") return e.severity === "warning";
    if (filter === "system") return e.severity === "system";
    return true;
  });

  const counts = {
    alarm: events.filter((e) => e.active && e.severity === "alarm").length,
    warning: events.filter((e) => e.active && e.severity === "warning").length,
    system: events.filter((e) => e.active && e.severity === "system").length,
  };

  return (
    <div className="alerts" ref={ref}>
      <div className="alerts-summary">
        <SummaryPill severity="alarm" count={counts.alarm} label="Alarm" active={filter === "alarm"} onClick={() => setFilter(filter === "alarm" ? "all" : "alarm")} />
        <SummaryPill severity="warning" count={counts.warning} label="Warnung" active={filter === "warning"} onClick={() => setFilter(filter === "warning" ? "all" : "warning")} />
        <SummaryPill severity="system" count={counts.system} label="System" active={filter === "system"} onClick={() => setFilter(filter === "system" ? "all" : "system")} />
        <button className={`mini-chip ${filter === "active" ? "sel" : ""}`} onClick={() => setFilter(filter === "active" ? "all" : "active")} title="Nur aktive Meldungen">
          <span className="pulse-dot" />
          {!narrow && "Aktiv"}
        </button>
      </div>

      {!veryCompact && <AlertTimeline events={events} />}

      <div className="alerts-list">
        {filtered.length === 0 && (
          <div className="alerts-empty">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="11" cy="11" r="8"/><path d="M7 11l3 3 5-6"/></svg>
            <span>Keine Meldungen in dieser Auswahl.</span>
          </div>
        )}
        {filtered.map((e) => <EventRow event={e} key={e.id} compact={compact} station={station} />)}
      </div>
    </div>
  );
}

function SummaryPill({ severity, count, label, active, onClick }) {
  return (
    <button className={`sum-pill sev-${severity} ${active ? "sel" : ""} ${count > 0 ? "has" : ""}`} onClick={onClick}>
      <span className="sp-count">{count}</span>
      <span className="sp-label">{label}</span>
      {count > 0 && severity !== "system" && <span className="pulse-dot small" />}
    </button>
  );
}

function AlertTimeline({ events }) {
  const NOW = window.DASH_DATA.NOW;
  const SPAN = 24 * 3600000;
  const start = NOW - SPAN;
  const ref = tRef(null);
  const size = useSize(ref);

  const ticks = [];
  for (let h = 24; h >= 0; h -= 6) {
    const ts = NOW - h * 3600000;
    ticks.push({ ts, label: h === 0 ? "jetzt" : `−${h} h`, frac: 1 - h / 24 });
  }

  return (
    <div className="timeline" ref={ref}>
      <div className="tl-axis">
        {ticks.map((t, i) => (
          <span key={i} className="tl-tick" style={{ left: `${t.frac * 100}%` }}>{t.label}</span>
        ))}
      </div>
      <div className="tl-track">
        {ticks.map((t, i) => (
          <span key={i} className="tl-gridline" style={{ left: `${t.frac * 100}%` }} />
        ))}
        {events.map((e) => {
          const eStart = Math.max(start, e.startTs);
          const eEnd = e.endTs == null ? NOW : Math.min(NOW, e.endTs);
          if (eEnd < start) return null;
          const left = ((eStart - start) / SPAN) * 100;
          const width = Math.max(0.6, ((eEnd - eStart) / SPAN) * 100);
          return (
            <span key={e.id}
              className={`tl-mark sev-${e.severity} ${e.active ? "active" : ""}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={eventTitle(e)} />
          );
        })}
      </div>
    </div>
  );
}

function eventTitle(e) {
  if (e.severity === "system") return e.message;
  const fromMetrics = window.DASH_DATA.metrics && window.DASH_DATA.metrics[e.metric];
  const unit = fromMetrics ? fromMetrics.unit
    : window.DASH_DATA.limitUnit(e.metric, e.condition, e.severity);
  const M = fromMetrics || { short: e.metric || "—", unit };
  const dir = e.condition === "high" ? "über" : "unter";
  // When threshold is absent, use a natural description instead of showing an empty number.
  if (e.threshold != null && !Number.isNaN(e.threshold)) {
    const unitStr = unit ? ` ${unit}` : "";
    return `${M.short} ${dir} ${e.threshold}${unitStr}`;
  }
  const fallback = e.condition === "high" ? "zu hoch" : "zu niedrig";
  return e.message || `${M.short} ${fallback}`;
}

function EventRow({ event: e, compact, station }) {
  const D = window.DASH_DATA;
  if (e.severity === "system") {
    return (
      <div className={`evrow sev-system ${e.active ? "active" : ""}`}>
        <span className="ev-bar" />
        <span className="ev-icon">
          {e.system === "battery" && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1" y="4" width="10" height="6" rx="1"/><path d="M11 6v2h1.5V6z" fill="currentColor" stroke="none"/><rect x="2.5" y="5.5" width="2" height="3" fill="currentColor" stroke="none"/></svg>
          )}
          {e.system === "connection" && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M1.5 5.5a8 8 0 0 1 11 0M3.5 8a5 5 0 0 1 7 0M5.5 10.5a2 2 0 0 1 3 0"/><path d="M2 12l10-10" strokeWidth="1.4"/></svg>
          )}
          {e.system === "maintenance" && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M7 4.5v2.5l1.6 1"/></svg>
          )}
        </span>
        <div className="ev-main">
          <div className="ev-title">
            <span className="ev-sev-tag">System</span>
            <span className="ev-headline">{e.message}</span>
            {e.active && <span className="ev-active-tag">aktiv<span className="pulse-dot small"/></span>}
          </div>
          <div className="ev-sub">{e.detail}</div>
        </div>
        <div className="ev-meta">
          <div className="ev-when">{D.formatRelative(e.startTs)}</div>
          <div className="ev-dur">{e.active ? "läuft" : D.formatDuration(e.endTs - e.startTs)}</div>
        </div>
      </div>
    );
  }

  // B5: when the station doesn't carry a metric entry (e.g. pressure on humidity-only probe),
  // fall back to the limits table for the unit so threshold display shows "über 25 °C" not "über 25".
  const metricEntry = station.metrics[e.metric];
  const fallbackUnit = metricEntry ? metricEntry.unit
    : D.limitUnit(e.metric, e.condition, e.severity);
  const M = metricEntry || { color: "var(--text-faint)", label: e.metric || "—", short: e.metric || "—", unit: fallbackUnit, decimals: 1 };
  const dir = e.condition === "high" ? "über" : "unter";
  const arrow = e.condition === "high" ? "▲" : "▼";
  const fmtExtreme = (e.extreme == null || Number.isNaN(e.extreme)) ? "—" : e.extreme.toFixed(M.decimals);

  return (
    <div className={`evrow sev-${e.severity} ${e.active ? "active" : ""}`}>
      <span className="ev-bar" style={{ background: M.color }} />
      <span className="ev-icon sev-icon">
        {e.severity === "alarm"
          ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M7 2l6 10H1z"/><path d="M7 6v3M7 10.5v.5" strokeLinecap="round"/></svg>
          : <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="7" cy="7" r="5.5"/><path d="M7 4v3.5M7 9.5v.5" strokeLinecap="round"/></svg>}
      </span>
      <div className="ev-main">
        <div className="ev-title">
          <span className="ev-sev-tag">{e.severity === "alarm" ? "Alarm" : "Warnung"}</span>
          <span className="ev-headline">
            {M.label} <span className="ev-arrow">{arrow}</span>{" "}
            {(e.threshold != null && !Number.isNaN(e.threshold))
              ? <>{dir} {e.threshold}<span className="ev-unit">{M.unit}</span></>
              : (e.condition === "high" ? "zu hoch" : "zu niedrig")}
          </span>
          {e.active && <span className="ev-active-tag">aktiv<span className="pulse-dot small"/></span>}
        </div>
        {!compact && (
          <div className="ev-sub">
            {fmtExtreme !== "—" && <>Spitze {fmtExtreme} {M.unit}</>}
            {(e.threshold != null && !Number.isNaN(e.threshold)) && (
              <>{fmtExtreme !== "—" ? " · " : ""}Schwelle {e.threshold} {M.unit}</>
            )}
            {e.message && fmtExtreme === "—" && (e.threshold == null || Number.isNaN(e.threshold)) && (
              <>{e.message}</>
            )}
          </div>
        )}
      </div>
      <div className="ev-meta">
        <div className="ev-when">{D.formatRelative(e.startTs)}</div>
        <div className="ev-dur">{e.active ? "läuft" : D.formatDuration(e.endTs - e.startTs)}</div>
      </div>
    </div>
  );
}

const TILE_BODIES = { kpi: KpiBody, chart: ChartBody, gauge: GaugeBody, stats: StatsBody, alerts: AlertsBody };

Object.assign(window, { TILE_TYPES, TILE_BODIES, TileFrame, COLS, ROW_H, GAP, compactLayout, findFreeSlot, rectsOverlap });
