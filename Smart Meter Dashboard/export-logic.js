// Pure helpers for the export panel. Browser: attaches to window. Node: module.exports.
// No DOM / fetch / timers. Dual-export IIFE (same pattern as metrics-logic.js).
(function () {
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function endOfDay(ms)   { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); }

  function presetRange(key, nowMs) {
    const d = new Date(nowMs);
    if (key === 'last7')  return { fromTs: startOfDay(nowMs - 6 * 86400000), toTs: endOfDay(nowMs) };
    if (key === 'last30') return { fromTs: startOfDay(nowMs - 29 * 86400000), toTs: endOfDay(nowMs) };
    if (key === 'thisMonth') {
      const from = new Date(d.getFullYear(), d.getMonth(), 1);
      return { fromTs: from.getTime(), toTs: endOfDay(nowMs) };
    }
    if (key === 'lastMonth') {
      const from = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const to   = new Date(d.getFullYear(), d.getMonth(), 1);
      return { fromTs: from.getTime(), toTs: to.getTime() - 1 };
    }
    return { fromTs: nowMs, toTs: nowMs };
  }

  function unionMetrics(stations, selectedIds) {
    const sel = new Set(selectedIds);
    const seen = new Map();
    for (const s of stations) {
      if (!sel.has(s.id)) continue;
      for (const m of (s.metrics || [])) if (!seen.has(m.key)) seen.set(m.key, m);
    }
    return [...seen.values()];
  }

  function buildExportPayload(state) {
    return {
      stationIds: state.stationIds,
      metrics: state.metricKeys && state.metricKeys.length ? state.metricKeys : null,
      from: state.fromTs, to: state.toTs,
      includeEvents: !!state.includeEvents,
      dialect: state.dialect,
    };
  }

  function parseFilename(cd) {
    if (!cd) return null;
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) { const raw = star[1].trim(); try { return decodeURIComponent(raw); } catch (_) { return raw; } }
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    return plain ? plain[1].trim() : null;
  }

  const api = { presetRange, unionMetrics, buildExportPayload, parseFilename };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') Object.assign(window, api);
})();
