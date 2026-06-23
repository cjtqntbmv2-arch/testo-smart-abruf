// Pure, side-effect-free metric helpers shared by the dashboard UI and Node unit tests.
// Browser: loaded as a plain <script> before data.js, attaches functions to window.
// Node: require()d directly by tests via module.exports. No DOM / fetch / timers here.
(function () {
  function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

  // Worst active alert for one metric, plus the direction of the breached limit.
  // events: array of { active, severity, metric, condition }; condition is 'high'|'low' (alarmDirection()).
  // Returns { severity: 'alarm'|'warning'|null, direction: 'high'|'low'|null }. Alarm outranks warning;
  // 'system' events are ignored (no metric value).
  function metricAlertState(events, metricId) {
    if (!Array.isArray(events) || !metricId) return { severity: null, direction: null };
    let warnDir = null;
    for (const e of events) {
      if (!e || !e.active) continue;
      if (e.severity === 'system') continue;
      if (e.metric !== metricId) continue;
      const dir = e.condition === 'low' ? 'low' : 'high';
      if (e.severity === 'alarm') return { severity: 'alarm', direction: dir };
      if (e.severity === 'warning' && warnDir === null) warnDir = dir;
    }
    return warnDir ? { severity: 'warning', direction: warnDir } : { severity: null, direction: null };
  }

  // Backward-compatible severity-only accessor (delegates to metricAlertState).
  function metricAlertStatus(events, metricId) {
    return metricAlertState(events, metricId).severity;
  }

  // Trend of a numeric series over a trailing time window (default 1 h).
  // series + timestamps are parallel arrays; timestamps in ms. Returns
  // { delta, pct, hasTrend, ref, last }.
  // last = newest finite value; ref = newest finite sample whose timestamp is at least
  // windowMs old, else the earliest finite value (graceful fallback for short series).
  // hasTrend=false when last or ref is missing (caller renders "—", no arrow).
  // pct uses the magnitude of the baseline (|ref|) so its sign follows delta even when
  // ref is negative (e.g. sub-zero temperatures). When ref === 0 the denominator falls
  // back to 1, so pct for a zero baseline is indicative only.
  function metricTrend(series, timestamps, windowMs) {
    if (windowMs == null) windowMs = 3600000;
    if (!Array.isArray(series) || series.length === 0) {
      return { delta: NaN, pct: NaN, hasTrend: false, ref: NaN, last: NaN };
    }
    let lastIdx = -1;
    for (let i = series.length - 1; i >= 0; i--) { if (isNum(series[i])) { lastIdx = i; break; } }
    if (lastIdx === -1) return { delta: NaN, pct: NaN, hasTrend: false, ref: NaN, last: NaN };
    const last = series[lastIdx];

    const hasTimestamps = Array.isArray(timestamps) && timestamps.length === series.length;
    let refIdx = -1;
    if (hasTimestamps) {
      const cutoff = timestamps[lastIdx] - windowMs;
      let bestBefore = -1, earliest = -1;
      for (let i = 0; i < lastIdx; i++) {
        if (!isNum(series[i])) continue;
        if (earliest === -1) earliest = i;
        if (timestamps[i] <= cutoff) bestBefore = i;
      }
      refIdx = bestBefore !== -1 ? bestBefore : earliest;
    } else {
      for (let i = 0; i < lastIdx; i++) { if (isNum(series[i])) { refIdx = i; break; } }
    }
    if (refIdx === -1) return { delta: NaN, pct: NaN, hasTrend: false, ref: NaN, last };
    const ref = series[refIdx];
    const delta = last - ref;
    const pct = (delta / (Math.abs(ref) || 1)) * 100;
    return { delta, pct, hasTrend: true, ref, last };
  }

  // Mirror a device's stored channel into a numeric series aligned to `length`.
  // Derived metrics (dewpoint, abshumid) are MIRRORED from the stored channel, never
  // recomputed — the dashboard must match the CSV export's faithful archive. A slot the
  // device does not report (null/undefined/non-number, or a channel that is absent or
  // shorter than `length`) becomes NaN, which the UI renders as a gap rather than a
  // fabricated value.
  function storedSeries(series, length) {
    const out = new Array(length);
    for (let i = 0; i < length; i++) {
      const v = series && series[i];
      out[i] = isNum(v) ? v : NaN;
    }
    return out;
  }

  const api = { metricAlertState, metricAlertStatus, metricTrend, storedSeries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.metricAlertState = metricAlertState;
    window.metricAlertStatus = metricAlertStatus;
    window.metricTrend = metricTrend;
    window.storedSeries = storedSeries;
  }
})();
