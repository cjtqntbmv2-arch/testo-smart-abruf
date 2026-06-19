// Pure, side-effect-free station-overview helper shared by the dashboard UI and Node unit tests.
// Browser: loaded as a plain <script> before data.js, attaches to window.
// Node: require()d directly by tests via module.exports. No DOM / fetch / timers / Date here.
(function () {
  // Lower rank = more severe. Unknown severities sort last.
  const SEV_RANK = { alarm: 0, warning: 1, system: 2 };
  function rank(sev) { return SEV_RANK[sev] != null ? SEV_RANK[sev] : 99; }

  // Build the full station overview for the header detail panel.
  // stations: map id -> { id, name, code, location, online, events: [...] }
  // stationOrder: array of station ids (stable tie-break order)
  // Returns: [{ station, activeEvents, activeCount }] for EVERY station whose object exists.
  //   Stations with active events sort first (by worst severity asc, then newest active startTs
  //   desc, then stationOrder); quiet stations follow in stationOrder.
  //   activeEvents per station are sorted severity asc, then startTs desc (newest first).
  function buildStationOverview(stations, stationOrder) {
    if (!stations || !Array.isArray(stationOrder)) return [];
    const rows = [];
    for (let i = 0; i < stationOrder.length; i++) {
      const station = stations[stationOrder[i]];
      if (!station) continue;
      const activeEvents = (station.events || []).filter((e) => e && e.active);
      activeEvents.sort((a, b) => {
        const r = rank(a.severity) - rank(b.severity);
        if (r !== 0) return r;
        return (b.startTs || 0) - (a.startTs || 0);
      });
      let newest = -Infinity, worst = 99;
      for (const e of activeEvents) {
        if ((e.startTs || 0) > newest) newest = e.startTs || 0;
        const r = rank(e.severity);
        if (r < worst) worst = r;
      }
      rows.push({
        station, activeEvents, activeCount: activeEvents.length,
        _quiet: activeEvents.length > 0 ? 0 : 1, // active group sorts first
        _worst: worst, _newest: newest, _order: i,
      });
    }
    rows.sort((a, b) => {
      if (a._quiet !== b._quiet) return a._quiet - b._quiet;
      if (a._quiet === 0) {
        if (a._worst !== b._worst) return a._worst - b._worst;
        if (a._newest !== b._newest) return b._newest - a._newest;
      }
      return a._order - b._order;
    });
    return rows.map((r) => ({ station: r.station, activeEvents: r.activeEvents, activeCount: r.activeCount }));
  }

  const api = { buildStationOverview };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.buildStationOverview = buildStationOverview;
  }
})();
