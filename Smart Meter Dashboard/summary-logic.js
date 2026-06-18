// Pure, side-effect-free grouping helper shared by the dashboard UI and Node unit tests.
// Browser: loaded as a plain <script> before data.js, attaches to window.
// Node: require()d directly by tests via module.exports. No DOM / fetch / timers / Date here.
(function () {
  // Lower rank = more severe. Unknown severities sort last.
  const SEV_RANK = { alarm: 0, warning: 1, system: 2 };
  function rank(sev) { return SEV_RANK[sev] != null ? SEV_RANK[sev] : 99; }

  // Group active events by station for the header detail panel.
  // stations: map id -> { id, name, code, location, online, events: [...] }
  // stationOrder: array of station ids (defines stable tie-break order)
  // Returns: [{ station, events }] — only stations with >= 1 active event.
  //   groups sorted by worst severity asc, then newest active startTs desc, then stationOrder.
  //   events within a group sorted by severity asc, then startTs desc (newest first).
  function groupActiveEventsByStation(stations, stationOrder) {
    if (!stations || !Array.isArray(stationOrder)) return [];
    const groups = [];
    for (let i = 0; i < stationOrder.length; i++) {
      const station = stations[stationOrder[i]];
      if (!station) continue;
      const active = (station.events || []).filter((e) => e && e.active);
      if (active.length === 0) continue;
      active.sort((a, b) => {
        const r = rank(a.severity) - rank(b.severity);
        if (r !== 0) return r;
        return (b.startTs || 0) - (a.startTs || 0);
      });
      let newest = -Infinity;
      for (const e of active) { if ((e.startTs || 0) > newest) newest = e.startTs || 0; }
      groups.push({ station, events: active, _worst: rank(active[0].severity), _newest: newest, _order: i });
    }
    groups.sort((a, b) => {
      if (a._worst !== b._worst) return a._worst - b._worst;
      if (a._newest !== b._newest) return b._newest - a._newest;
      return a._order - b._order;
    });
    return groups.map((g) => ({ station: g.station, events: g.events }));
  }

  const api = { groupActiveEventsByStation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.groupActiveEventsByStation = groupActiveEventsByStation;
  }
})();
