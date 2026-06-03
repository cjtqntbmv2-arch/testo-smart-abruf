// Chart primitives: SVG line chart with overlay support, sparkline, gauge.
// All charts size to their container via ResizeObserver -> width/height state.

const { useRef, useEffect, useState, useMemo } = React;

function useSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// Build SVG path from x/y arrays.
function buildPath(xs, ys) {
  let d = "";
  let started = false;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isNaN(ys[i]) || ys[i] == null) {
      started = false;
      continue;
    }
    d += (!started ? "M" : "L") + xs[i].toFixed(2) + " " + ys[i].toFixed(2) + " ";
    started = true;
  }
  return d;
}
function buildAreaPath(xs, ys, baseY) {
  let d = "";
  let started = false;
  let lastValidX = null;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isNaN(ys[i]) || ys[i] == null) {
      if (started) {
        d += "L" + lastValidX.toFixed(2) + " " + baseY.toFixed(2) + " Z ";
        started = false;
      }
      continue;
    }
    if (!started) {
      d += "M" + xs[i].toFixed(2) + " " + baseY.toFixed(2) + " L" + xs[i].toFixed(2) + " " + ys[i].toFixed(2) + " ";
      started = true;
    } else {
      d += "L" + xs[i].toFixed(2) + " " + ys[i].toFixed(2) + " ";
    }
    lastValidX = xs[i];
  }
  if (started) {
    d += "L" + lastValidX.toFixed(2) + " " + baseY.toFixed(2) + " Z";
  }
  return d;
}

// Tiny inline sparkline (no axes).
function Sparkline({ series, color, height = 36 }) {
  const ref = useRef(null);
  const { w } = useSize(ref);
  const path = useMemo(() => {
    if (!w || !series?.length) return { line: "", area: "" };
    const validSeries = series.filter(v => typeof v === 'number' && !Number.isNaN(v));
    const min = validSeries.length ? validSeries.reduce((a, b) => Math.min(a, b), Infinity) : 0;
    const max = validSeries.length ? validSeries.reduce((a, b) => Math.max(a, b), -Infinity) : 100;
    const pad = 4;
    const yRange = max - min || 1;
    const xs = series.map((_, i) => (i / (series.length - 1)) * (w - 2) + 1);
    const ys = series.map((v) => (typeof v !== 'number' || Number.isNaN(v)) ? NaN : (1 - (v - min) / yRange) * (height - pad * 2) + pad);
    return { line: buildPath(xs, ys), area: buildAreaPath(xs, ys, height - 1) };
  }, [w, series, height]);

  return (
    <div ref={ref} className="sparkline" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`}>
          <path d={path.area} fill={color} fillOpacity="0.14" />
          <path d={path.line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

// Multi-metric line chart with shared time axis, dual Y axes when 2+ metrics.
function LineChart({ metricIds, stationId, timestamps, showGrid = true, showAxes = true }) {
  const ref = useRef(null);
  const { w, h } = useSize(ref);
  const [hover, setHover] = useState(null);

  const station = stationId ? window.DASH_DATA.stations[stationId] : window.DASH_DATA.activeStation;
  const M = station.metrics;
  const metrics = metricIds.map((id) => M[id]).filter(Boolean);

  const padL = showAxes ? 38 : 8;
  const padR = showAxes && metrics.length >= 2 ? 42 : 12;
  const padT = 12;
  const padB = showAxes ? 22 : 8;
  const plotW = Math.max(0, w - padL - padR);
  const plotH = Math.max(0, h - padT - padB);

  // For each metric compute its own scale (we draw them all in one plot, normalized to its own domain).
  // To keep curves visually comparable but each on its own scale, we use auto-fit on actual series min/max.
  const scaled = useMemo(() => {
    return metrics.map((m) => {
      const s = m.series;
      const validS = s.filter(v => typeof v === 'number' && !Number.isNaN(v));
      const lo = validS.length ? validS.reduce((a, b) => Math.min(a, b), Infinity) : 0;
      const hi = validS.length ? validS.reduce((a, b) => Math.max(a, b), -Infinity) : 100;
      const span = hi - lo || 1;
      const margin = span * 0.12;
      const yLo = lo - margin, yHi = hi + margin;
      const plotH = h - padT - padB;
      const xs = s.map((_, i) => padL + (i / (s.length - 1)) * (w - padL - padR));
      const ys = s.map((v) => (typeof v !== 'number' || Number.isNaN(v)) ? NaN : padT + (1 - (v - yLo) / (yHi - yLo)) * plotH);
      return { m, xs, ys, yLo, yHi };
    });
  }, [metrics.map((m) => m.id).join(","), metrics.map((m) => m.series).join("|").length, metrics[0]?.series, plotW, plotH, padL, padT]);

  const onMove = (e) => {
    if (!w) return;
    const rect = ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < padL || x > padL + plotW) { setHover(null); return; }
    const series = metrics[0]?.series;
    if (!series) return;
    const idx = Math.round(((x - padL) / plotW) * (series.length - 1));
    setHover(Math.max(0, Math.min(series.length - 1, idx)));
  };

  // X axis ticks: every 4h
  const xTicks = useMemo(() => {
    if (!timestamps?.length || !plotW) return [];
    const out = [];
    const first = timestamps[0], last = timestamps[timestamps.length - 1];
    const totalH = (last - first) / 3600000;
    const stepH = totalH >= 18 ? 4 : 2;
    const startDate = new Date(first);
    startDate.setMinutes(0, 0, 0);
    let t = startDate.getTime();
    while (t < first) t += stepH * 3600000;
    while (t <= last) {
      const frac = (t - first) / (last - first);
      out.push({ x: padL + frac * plotW, label: new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) });
      t += stepH * 3600000;
    }
    return out;
  }, [timestamps, plotW, padL]);

  return (
    <div ref={ref} className="linechart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {w > 0 && h > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          {/* Grid */}
          {showGrid && (
            <g className="grid">
              {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
                <line key={i} x1={padL} x2={padL + plotW} y1={padT + f * plotH} y2={padT + f * plotH} />
              ))}
              {xTicks.map((t, i) => (
                <line key={i} x1={t.x} x2={t.x} y1={padT} y2={padT + plotH} className="vgrid" />
              ))}
            </g>
          )}

          {/* Areas (only when single metric, makes overlay readable) */}
          {scaled.length === 1 && (
            <path d={buildAreaPath(scaled[0].xs, scaled[0].ys, padT + plotH)} fill={scaled[0].m.color} fillOpacity="0.10" />
          )}

          {/* Lines */}
          {scaled.map((s, i) => (
            <path key={s.m.id} d={buildPath(s.xs, s.ys)} fill="none"
                  stroke={s.m.color} strokeWidth={scaled.length === 1 ? 1.8 : 1.6}
                  strokeLinejoin="round" strokeLinecap="round" />
          ))}

          {/* Hover crosshair */}
          {hover != null && scaled[0] && (
            <g className="hover">
              <line x1={scaled[0].xs[hover]} x2={scaled[0].xs[hover]} y1={padT} y2={padT + plotH} />
              {scaled.map((s) => (
                <circle key={s.m.id} cx={s.xs[hover]} cy={s.ys[hover]} r="3.5" fill={s.m.color} stroke="#fff" strokeWidth="1.5" />
              ))}
            </g>
          )}

          {/* X axis labels */}
          {showAxes && (
            <g className="axis">
              {xTicks.map((t, i) => (
                <text key={i} x={t.x} y={h - 6} textAnchor="middle">{t.label}</text>
              ))}
            </g>
          )}

          {/* Y axis labels — left for first metric, right for second */}
          {showAxes && scaled[0] && (
            <g className="axis yaxis" style={{ fill: scaled[0].m.color }}>
              {[0, 0.5, 1].map((f, i) => {
                const v = scaled[0].yHi - f * (scaled[0].yHi - scaled[0].yLo);
                return (
                  <text key={i} x={padL - 6} y={padT + f * plotH + 3} textAnchor="end">
                    {v.toFixed(scaled[0].m.decimals)}
                  </text>
                );
              })}
            </g>
          )}
          {showAxes && scaled[1] && (
            <g className="axis yaxis" style={{ fill: scaled[1].m.color }}>
              {[0, 0.5, 1].map((f, i) => {
                const v = scaled[1].yHi - f * (scaled[1].yHi - scaled[1].yLo);
                return (
                  <text key={i} x={w - padR + 6} y={padT + f * plotH + 3} textAnchor="start">
                    {v.toFixed(scaled[1].m.decimals)}
                  </text>
                );
              })}
            </g>
          )}
        </svg>
      )}

      {/* Tooltip */}
      {hover != null && scaled[0] && (
        <div className="tooltip" style={{
          left: Math.min(w - 160, Math.max(0, scaled[0].xs[hover] + 10)),
          top: padT,
        }}>
          <div className="tt-time">{window.DASH_DATA.formatTime(timestamps[hover])}</div>
          {scaled.map((s) => (
            <div key={s.m.id} className="tt-row">
              <span className="tt-swatch" style={{ background: s.m.color }} />
              <span className="tt-label">{s.m.short}</span>
              <span className="tt-val">{window.DASH_DATA.formatValue(s.m, s.m.series[hover])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Radial gauge for current value within a domain.
function Gauge({ metricId, stationId, size }) {
  const station = stationId ? window.DASH_DATA.stations[stationId] : window.DASH_DATA.activeStation;
  const m = station.metrics[metricId];
  if (!m) return null;
  const v = m.series[m.series.length - 1];
  const [lo, hi] = m.domain;
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

  const W = size?.w || 220;
  const H = size?.h || 180;
  const cx = W / 2;
  const cy = H * 0.78;
  const r = Math.min(W * 0.42, H * 0.62);
  const stroke = Math.max(8, r * 0.14);

  // Arc from 180° to 360° (semi-circle)
  const startA = Math.PI;
  const endA = Math.PI * 2;
  const valA = startA + t * (endA - startA);

  function arcPath(a0, a1) {
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  // Tick marks
  const ticks = [];
  const tickCount = 9;
  for (let i = 0; i <= tickCount; i++) {
    const a = startA + (i / tickCount) * (endA - startA);
    const r1 = r + stroke * 0.6;
    const r2 = r + stroke * 0.95;
    ticks.push({
      x1: cx + r1 * Math.cos(a), y1: cy + r1 * Math.sin(a),
      x2: cx + r2 * Math.cos(a), y2: cy + r2 * Math.sin(a),
      major: i === 0 || i === tickCount || i === Math.round(tickCount / 2),
    });
  }

  return (
    <div className="gauge">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <path d={arcPath(startA, endA)} fill="none" stroke="var(--border)" strokeWidth={stroke} strokeLinecap="round" />
        <path d={arcPath(startA, valA)} fill="none" stroke={m.color} strokeWidth={stroke} strokeLinecap="round" />
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
                stroke={t.major ? "var(--text-muted)" : "var(--text-faint)"}
                strokeWidth={t.major ? 1.4 : 1} />
        ))}
        <text x={cx} y={cy - r * 0.25} textAnchor="middle" className="g-value">
          {v.toFixed(m.decimals)}
        </text>
        <text x={cx} y={cy - r * 0.25 + 18} textAnchor="middle" className="g-unit">{m.unit}</text>
        <text x={cx - r} y={cy + 16} textAnchor="middle" className="g-bound">{lo}</text>
        <text x={cx + r} y={cy + 16} textAnchor="middle" className="g-bound">{hi}</text>
      </svg>
    </div>
  );
}

Object.assign(window, { Sparkline, LineChart, Gauge, useSize });
