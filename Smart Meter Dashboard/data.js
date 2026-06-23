// Fully functional data.js connecting the React frontend to the Node.js REST API.
// Exposes the window.DASH_DATA interface and polls the local Express endpoints.

(function () {
  const POINTS = 144;
  const STEP_MS = 10 * 60 * 1000;
  const POLL_EVENT_LIMIT = 50; // bound the 5s poll's per-station history fetch

  // Metric metadata definition (identical to static prototype)
  const META = {
    temperature: { id: "temperature", label: "Temperatur",      short: "Temp.",         unit: "°C",   color: "oklch(0.70 0.13 55)",  colorSoft: "oklch(0.70 0.13 55 / 0.18)",  decimals: 1, icon: "thermo" },
    humidity:    { id: "humidity",    label: "Rel. Luftfeuchte", short: "rel. Feuchte",  unit: "%",    color: "oklch(0.62 0.12 230)", colorSoft: "oklch(0.62 0.12 230 / 0.18)", decimals: 0, icon: "drop" },
    pressure:    { id: "pressure",    label: "Luftdruck",        short: "Druck",         unit: "hPa",  color: "oklch(0.55 0.11 300)", colorSoft: "oklch(0.55 0.11 300 / 0.18)", decimals: 1, icon: "gauge" },
    dewpoint:    { id: "dewpoint",    label: "Taupunkt",         short: "Taupunkt",      unit: "°C",   color: "oklch(0.65 0.09 200)", colorSoft: "oklch(0.65 0.09 200 / 0.18)", decimals: 1, icon: "snow" },
    abshumid:    { id: "abshumid",    label: "Abs. Luftfeuchte", short: "abs. Feuchte",  unit: "g/m³", color: "oklch(0.60 0.10 165)", colorSoft: "oklch(0.60 0.10 165 / 0.18)", decimals: 2, icon: "vapor" },
  };
  const METRIC_IDS = ["temperature", "humidity", "pressure", "dewpoint", "abshumid"];

  // Internal reactive cache
  let STATIONS = {};
  let STATION_ORDER = [];
  let activeStationId = null;
  let timestamps = [];
  let totals = { alarm: 0, warning: 0, system: 0 };
  let limits = []; // B5: flat array from /api/limits; keyed lookup built on demand
  let connectionError = null;
  let lastUpdated = null;
  let isRefreshing = false;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  // Statistics helper
  function stats(arr) {
    // Ignore null/undefined/NaN gaps — metrics a sensor doesn't report (e.g. pressure
    // on an outdoor probe) arrive as null and must not poison the aggregates.
    const nums = (arr || []).filter((v) => typeof v === "number" && !Number.isNaN(v));
    if (nums.length === 0) return { min: NaN, max: NaN, avg: NaN, last: NaN, first: NaN };
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of nums) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, avg: sum / nums.length, last: nums[nums.length - 1], first: nums[0] };
  }

  // Alarm direction helper — case-insensitive, covers English + German terms (M2)
  function alarmDirection(conditionType) {
    if (!conditionType) return 'high';
    const c = conditionType.toLowerCase();
    if (c.includes('upper') || c.includes('high') || c.includes('max') || c.includes('ober') || c.includes('hoch')) return 'high';
    if (c.includes('lower') || c.includes('low')  || c.includes('min') || c.includes('unter') || c.includes('niedrig')) return 'low';
    return 'high';
  }

  // Map one backend events-row to the frontend event shape. Single source of truth
  // for both the 5s poll and on-demand history fetches.
  function mapBackendEvent(e) {
    return {
      id: e.uuid,
      severity: e.severity,
      system: e.severity === 'system' ? (e.alarm_condition_type || 'maintenance') : null,
      message: e.message || e.alarm_reason || 'Grenzwert verletzt',
      detail: e.detail || `Sensorwert: ${e.alarm_value}`,
      metric: e.metric ? e.metric.toLowerCase() : null,
      condition: alarmDirection(e.alarm_condition_type),
      threshold: e.threshold,
      startTs: e.start_ts,
      endTs: e.end_ts,
      extreme: e.extreme || e.alarm_value,
      active: !!e.active,
      _rowid: e._rowid, // compound-cursor tiebreak (route always returns rowid AS _rowid)
    };
  }

  // Main API Polling function
  async function refresh() {
    if (isRefreshing) return; // M7: skip tick if a refresh is already in flight
    isRefreshing = true;
    try {
      // 1. Fetch stations list
      const resStations = await fetch('/api/stations');
      if (!resStations.ok) throw new Error('Failed to fetch stations');
      const stationsList = await resStations.json();

      // 2. Fetch totals
      const resTotals = await fetch('/api/totals');
      if (resTotals.ok) {
        totals = await resTotals.json();
      }

      // 3. Fetch alarm limits (B5: threshold units for event display)
      try {
        const resLimits = await fetch('/api/limits');
        if (resLimits.ok) {
          limits = await resLimits.json();
        }
      } catch (e) {
        console.error('Error fetching limits:', e);
      }

      const tempOrder = [];
      const nextStations = {};

      for (const s of stationsList) {
        tempOrder.push(s.id);

        // Fetch metrics for this station (last 24h)
        let stationTimestamps = [];
        let stationMetrics = {
          temperature: { series: [], unit: '°C' },
          humidity: { series: [], unit: '%' },
          pressure: { series: [], unit: 'hPa' },
          dewpoint: { series: [], unit: '°C' },
          abshumid: { series: [], unit: 'g/m³' }
        };

        try {
          const resMetrics = await fetch(`/api/stations/${s.id}/metrics`);
          if (resMetrics.ok) {
            const data = await resMetrics.json();
            stationTimestamps = data.timestamps || [];
            if (data.metrics) {
              if (data.metrics.temperature) stationMetrics.temperature = data.metrics.temperature;
              if (data.metrics.humidity) stationMetrics.humidity = data.metrics.humidity;
              if (data.metrics.pressure) stationMetrics.pressure = data.metrics.pressure;
              if (data.metrics.dewpoint) stationMetrics.dewpoint = data.metrics.dewpoint;
              if (data.metrics.abshumid) stationMetrics.abshumid = data.metrics.abshumid;
            }
          }
        } catch (e) {
          console.error(`Error fetching metrics for ${s.id}:`, e);
        }

        // If there are no timestamps returned, use default points
        if (stationTimestamps.length === 0) {
          const now = Date.now();
          stationTimestamps = new Array(POINTS).fill(0).map((_, i) => now - (POINTS - 1 - i) * STEP_MS);
          stationMetrics.temperature.series = new Array(POINTS).fill(NaN);
          stationMetrics.humidity.series = new Array(POINTS).fill(NaN);
          stationMetrics.pressure.series = new Array(POINTS).fill(NaN);
        }

        // Keep global timestamps aligned to active station
        if (s.id === activeStationId || !activeStationId) {
          timestamps = stationTimestamps;
        }

        // Resolve all displayed series. Dewpoint and abs. humidity are MIRRORED from the
        // device's stored channel — never recomputed from temperature/humidity — so the
        // dashboard shows exactly what is archived and matches the CSV export. A device
        // that does not store these channels shows a gap, not a fabricated value.
        let seriesT = stationMetrics.temperature.series || [];
        let seriesH = stationMetrics.humidity.series || [];
        let seriesP = stationMetrics.pressure.series || [];

        if (seriesT.length === 0) {
          const now = Date.now();
          stationTimestamps = new Array(POINTS).fill(0).map((_, i) => now - (POINTS - 1 - i) * STEP_MS);
          seriesT = new Array(POINTS).fill(NaN);
          seriesH = new Array(POINTS).fill(NaN);
          seriesP = new Array(POINTS).fill(NaN);

          if (s.id === activeStationId || !activeStationId) {
            timestamps = stationTimestamps;
          }
        }

        const len = seriesT.length;
        seriesT = storedSeries(seriesT, len);
        seriesH = storedSeries(seriesH, len);
        seriesP = storedSeries(seriesP, len);
        const finalD = storedSeries(stationMetrics.dewpoint && stationMetrics.dewpoint.series, len);
        const finalA = storedSeries(stationMetrics.abshumid && stationMetrics.abshumid.series, len);

        const allSeries = {
          temperature: seriesT,
          humidity:    seriesH,
          pressure:    seriesP,
          dewpoint:    finalD,
          abshumid:    finalA,
        };

        const metrics = {};
        for (const mid of METRIC_IDS) {
          const mMeta = META[mid];
          const mData = stationMetrics[mid] || {};
          const validNums = (allSeries[mid] || []).filter(v => typeof v === 'number' && !Number.isNaN(v));
          let lo = validNums.length > 0 ? Math.min(...validNums) : 0;
          let hi = validNums.length > 0 ? Math.max(...validNums) : 100;
          
          if (lo === hi) {
            // Provide a default span if all values are identical to prevent division by zero
            lo = lo - 1;
            hi = hi + 1;
          }

          metrics[mid] = {
            ...mMeta,
            series: allSeries[mid],
            unit: mData.unit || mMeta.unit,
            domain: mMeta.domain || [lo, hi]
          };

          // Adjust bounds slightly for derived metrics domain
          if (mid === 'dewpoint' || mid === 'abshumid') {
            const margin = mid === 'dewpoint' ? 2 : 1;
            metrics[mid].domain = [Math.floor(lo - margin), Math.ceil(hi + margin)];
          }
        }

        // Fetch backend events (alarms & system messages)
        let backendEvents = [];
        try {
          const resEvents = await fetch(`/api/stations/${s.id}/events?limit=${POLL_EVENT_LIMIT}`);
          if (resEvents.ok) {
            const rawEvents = await resEvents.json();
            backendEvents = rawEvents.map(mapBackendEvent);
          }
        } catch (e) {
          console.error(`Error fetching events for ${s.id}:`, e);
        }

        const stationObj = {
          id: s.id,
          name: s.name,
          code: s.device_uuid ? s.device_uuid.substring(0, 4).toUpperCase() : 'M01',
          location: s.location || 'Unbekannt',
          online: s.online === 1,
          battery: s.battery !== null ? s.battery : 100,
          signal: s.signal !== null ? s.signal : 100,
          lastSeen: s.last_communication || Date.now(),
          mo_uuid: s.mo_uuid,
          device_uuid: s.device_uuid,
          metrics,
          timestamps: stationTimestamps,
          events: []
        };

        // Events come solely from the API (Testo alarm feed + system events).
        stationObj.events = backendEvents;
        stationObj.events.sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          return b.startTs - a.startTs;
        });

        nextStations[s.id] = stationObj;
      }

      STATIONS = nextStations;
      STATION_ORDER = tempOrder;

      // Handle active station tracking
      if (STATION_ORDER.length > 0) {
        if (!activeStationId || !STATIONS[activeStationId]) {
          activeStationId = STATION_ORDER[0];
        }
      } else {
        activeStationId = null;
      }

      // K2: mark successful cycle
      lastUpdated = Date.now();
      connectionError = null;

      emit();
    } catch (e) {
      // K2: flag connection error; keep existing STATIONS so last real data stays visible
      connectionError = e.message || 'Backend nicht erreichbar';
      console.error('Error refreshing dashboard data:', e);
    } finally {
      isRefreshing = false; // M7: always release the lock
    }
  }

  // Initialize — empty state; first refresh() populates STATIONS
  // Trigger immediate refresh and spin up polling interval
  refresh();
  setInterval(refresh, 5000);

  // Expose the global API client object
  window.DASH_DATA = {
    POINTS,
    STEP_MS,
    get timestamps() { return timestamps; },
    metricIds: METRIC_IDS,
    stats,
    get NOW() { return Date.now(); },

    // Connection state (K2)
    get connectionError() { return connectionError; },
    get lastUpdated()     { return lastUpdated; },

    // Stations
    get stations() { return STATIONS; },
    get stationOrder() { return STATION_ORDER; },
    get activeStationId() { return activeStationId; },
    get activeStation() { return STATIONS[activeStationId]; },
    setActiveStation(id) {
      if (!STATIONS[id] || id === activeStationId) return;
      activeStationId = id;
      refresh();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Active-station shortcuts
    get metrics()    { return STATIONS[activeStationId]?.metrics; },
    get events()     { return STATIONS[activeStationId]?.events; },

    formatValue(metric, v) {
      if (v == null || Number.isNaN(v)) return "—";
      return v.toFixed(metric.decimals) + " " + metric.unit;
    },
    formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    },
    formatRelative(ts) {
      const diff = Date.now() - ts;
      const abs = Math.abs(diff);
      const m = Math.round(abs / 60000);
      if (m < 1) return "gerade eben";
      if (m < 60) return `vor ${m} min`;
      const h = Math.floor(m / 60);
      const rm = m % 60;
      if (h < 24) return rm ? `vor ${h} h ${rm} min` : `vor ${h} h`;
      const d = Math.floor(h / 24);
      return `vor ${d} d`;
    },
    formatDuration(ms) {
      if (!Number.isFinite(ms)) return "—";
      const m = Math.round(ms / 60000);
      if (m < 1) return "< 1 min";
      if (m < 60) return `${m} min`;
      const h = Math.floor(m / 60);
      const rm = m % 60;
      return rm ? `${h} h ${rm} min` : `${h} h`;
    },

    totalActive() {
      return totals;
    },

    // B5: alarm limits from /api/limits
    get limits() { return limits; },

    // B5: look up the unit for a given metric/direction/severity from the limits table.
    // direction: 'high'|'low', severity: 'alarm'|'warning'.
    // Falls back to the static META unit, then to empty string.
    limitUnit(metric, direction, severity) {
      const dir = direction === 'high' ? 'high' : 'low';
      const row = limits.find(l =>
        l.metric === metric && l.direction === dir && l.severity === severity
      );
      if (row && row.unit) return row.unit;
      // fallback to static META
      return (META[metric] && META[metric].unit) || '';
    },

    // Pure metric helpers (defined in metrics-logic.js, attached to window).
    metricAlertState(events, metricId) { return metricAlertState(events, metricId); },
    metricAlertStatus(events, metricId) { return metricAlertStatus(events, metricId); },
    metricTrend(series, timestamps, windowMs) { return metricTrend(series, timestamps, windowMs); },
    // All stations (incl. quiet), sorted, with their active events (summary-logic.js).
    stationOverview() { return buildStationOverview(STATIONS, STATION_ORDER); },

    // Lazy, paginated resolved-event history for one station. Rejects on failure —
    // callers (StationHistoryGroup) catch and render an inline error.
    async fetchStationHistory(stationId, opts) {
      const limit = (opts && opts.limit) || 20;
      let url = `/api/stations/${stationId}/events?active=0&limit=${limit}`;
      if (opts && opts.beforeTs != null) url += `&before_ts=${opts.beforeTs}`;
      if (opts && opts.beforeRowid != null) url += `&before_rowid=${opts.beforeRowid}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Historie konnte nicht geladen werden');
      const rows = await res.json();
      return rows.map(mapBackendEvent);
    },

    async fetchExportMetadata() {
      const res = await fetch('/api/export/metadata');
      if (!res.ok) throw new Error('Export-Metadaten konnten nicht geladen werden');
      return res.json();
    },

    async postExport(payload) {
      const res = await fetch('/api/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = 'Export fehlgeschlagen';
        try { msg = (await res.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const cd = res.headers.get('content-disposition');
      const name = (typeof window.parseFilename === 'function' && window.parseFilename(cd)) || 'export.csv';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
      return { ok: true };
    },

    // Extra helpers to allow external calls from components (Zuweisungsmanager / Settings)
    async forceApiRefresh() {
      await refresh();
    }
  };
})();
