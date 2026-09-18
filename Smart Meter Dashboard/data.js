// Fully functional data.js connecting the React frontend to the Node.js REST API.
// Exposes the window.DASH_DATA interface and polls the local Express endpoints.

(function () {
  const POINTS = 144;
  const STEP_MS = 10 * 60 * 1000;
  const POLL_EVENT_LIMIT = 50; // bound the 5s poll's per-station history fetch

  // Metric metadata definition (identical to static prototype).
  // label ist wortgleich mit METRIC_LABELS in backend/csv-export.js (CSV-Spaltenköpfe) —
  // beide nur gemeinsam ändern. Die Alarmtexte (device-bridge.js) weichen bewusst ab.
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
  // Teilausfall-Erkennung: Fehlversuche je Abrufgruppe, Logik in partial-failure-logic.js.
  let failCounts = {};
  let partialFailure = null;
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

  // Alarm direction helper — case-insensitive, covers English + German terms (M2).
  //
  // Fallback intentionally differs from the backend's alarmConditionDirection() in
  // backend/device-bridge.js, which returns null for an unrecognized condition string
  // instead of defaulting to 'high'. Not an oversight — the two can't share code (no
  // bundler; that one runs in Node, this one as a <script> in the browser) and each
  // fallback is right for its own layer:
  //   - The backend's null skips its threshold lookup, so an unrecognized direction
  //     never gets a fabricated limit value written to the stored/exported event.
  //   - Every UI consumer of this result (LimitFlag, EventRow's arrow + wording in
  //     tiles.jsx, metricAlertState in metrics-logic.js) is a binary high/low ternary
  //     with no "unknown" rendering state, so this must resolve to something displayable.
  // Because the backend leaves `threshold` null exactly when direction was unrecognized,
  // this fallback only ever produces a cosmetic wrong arrow/wording guess (the
  // `e.threshold == null` branch of tiles.jsx EventRow's headline) — never a fabricated
  // number. That lower stake is why 'high' here is fine even though null is right there.
  function alarmDirection(conditionType) {
    if (!conditionType) return 'high';
    const c = conditionType.toLowerCase();
    if (c.includes('upper') || c.includes('high') || c.includes('max') || c.includes('ober') || c.includes('hoch')) return 'high';
    if (c.includes('lower') || c.includes('low')  || c.includes('min') || c.includes('unter') || c.includes('niedrig')) return 'low';
    return 'high';
  }

  // Value-only half of formatValue() below: "—" for null/NaN, else toFixed(decimals),
  // WITHOUT the unit suffix. Factored out because every current duplicate of
  // formatValue's logic (tiles.jsx KpiBody/MetricValue/StatsBody/EventRow, app.jsx's
  // two metric-pick steps) renders the unit in its own adjacent span for separate
  // styling — reusing formatValue there would merge value+unit into one string and
  // change that layout. Exposed on DASH_DATA as formatNumber for exactly that reuse.
  function formatNumber(metric, v) {
    if (v == null || Number.isNaN(v)) return "—";
    return v.toFixed(metric.decimals);
  }

  // Normalises an error caught around fetch()/res.json() into one the UI can show
  // directly, without losing the technical cause (err.cause — visible in devtools,
  // not rendered). fetch() itself rejects with a plain TypeError on a network abort
  // (offline, DNS, CORS — the browser's own wording, always English); res.json()
  // rejects with a SyntaxError when the body isn't valid JSON. Both would otherwise
  // reach the UI unmodified (M9 / #17). An Error we threw ourselves (the `!res.ok`
  // branches below) already carries a German message, so it passes through unchanged.
  function friendlyError(err, fallbackMsg) {
    // .name (not instanceof TypeError/SyntaxError): dashboard-load.test.js statically
    // whitelists which bare globals every dashboard file may reference, and SyntaxError
    // isn't on that list — a name check reaches the same native errors without adding
    // a free identifier to this file.
    const kind = err && err.name;
    if (kind === 'TypeError') return new Error('Server nicht erreichbar (Netzwerkfehler).', { cause: err });
    if (kind === 'SyntaxError') return new Error('Antwort vom Server konnte nicht gelesen werden.', { cause: err });
    if (err instanceof Error) return err;
    return new Error(fallbackMsg, { cause: err });
  }

  // Shared GET+parse helper for the simple read endpoints below: fetch, reject with
  // a German message on a non-2xx status (status/statusText kept as cause), parse
  // JSON. Every failure path funnels through friendlyError() so callers always catch
  // a German Error with the original cause attached.
  async function fetchJson(url, errorMsg) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(errorMsg, { cause: { status: res.status, statusText: res.statusText } });
      return await res.json();
    } catch (e) {
      throw friendlyError(e, errorMsg);
    }
  }

  // Gegenstück für POST mit JSON-Body: bei einem Nicht-2xx gewinnt der Klartext des
  // Backends ({ error }), sonst errorMsg. Antwort: geparstes JSON, bei leerem Body {}.
  async function postJson(url, body, errorMsg) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw friendlyError(e, errorMsg);
    }
    if (!res.ok) {
      let msg = errorMsg;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      throw new Error(msg, { cause: { status: res.status, statusText: res.statusText } });
    }
    return res.json().catch(() => ({}));
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
      let totalsOk = false;
      try {
        const resTotals = await fetch('/api/totals');
        if (resTotals.ok) {
          totals = await resTotals.json();
          totalsOk = true;
        }
      } catch (e) {
        console.error('Error fetching totals:', e);
      }
      failCounts = recordOutcome(failCounts, 'totals', totalsOk);

      // 3. Fetch alarm limits (B5: threshold units for event display)
      let limitsOk = false;
      try {
        const resLimits = await fetch('/api/limits');
        if (resLimits.ok) {
          limits = await resLimits.json();
          limitsOk = true;
        }
      } catch (e) {
        console.error('Error fetching limits:', e);
      }
      failCounts = recordOutcome(failCounts, 'limits', limitsOk);

      const tempOrder = [];
      const nextStations = {};
      // Je Gruppe gilt der Zyklus als gescheitert, sobald EINE Messstelle nicht lädt.
      let metricsOk = true;
      let eventsOk = true;

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
          if (!resMetrics.ok) metricsOk = false;
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
          metricsOk = false;
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
          if (!resEvents.ok) eventsOk = false;
          if (resEvents.ok) {
            const rawEvents = await resEvents.json();
            backendEvents = rawEvents.map(mapBackendEvent);
          }
        } catch (e) {
          eventsOk = false;
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

      failCounts = recordOutcome(failCounts, 'metrics', metricsOk);
      failCounts = recordOutcome(failCounts, 'events', eventsOk);
      partialFailure = partialFailureNotice(failCounts);

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

  // Expose the global API client object
  const DASH_DATA = {
    POINTS,
    STEP_MS,
    get timestamps() { return timestamps; },
    metricIds: METRIC_IDS,
    stats,
    get NOW() { return Date.now(); },

    // Connection state (K2)
    get connectionError() { return connectionError; },
    get lastUpdated()     { return lastUpdated; },
    // Dauerhafter Teilausfall einzelner Endpunkte — null, solange alles läuft.
    get partialFailure()  { return partialFailure; },

    // Stations
    get stations() { return STATIONS; },
    get stationOrder() { return STATION_ORDER; },
    get activeStationId() { return activeStationId; },
    get activeStation() { return STATIONS[activeStationId]; },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Active-station shortcuts
    get metrics()    { return STATIONS[activeStationId]?.metrics; },
    get events()     { return STATIONS[activeStationId]?.events; },

    formatNumber(metric, v) { return formatNumber(metric, v); },
    formatValue(metric, v) {
      const n = formatNumber(metric, v);
      return n === "—" ? n : n + " " + metric.unit;
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
      const rows = await fetchJson(url, 'Historie konnte nicht geladen werden');
      return rows.map(mapBackendEvent);
    },

    async fetchExportMetadata() {
      return fetchJson('/api/export/metadata', 'Export-Metadaten konnten nicht geladen werden');
    },

    async postExport(payload) {
      let res;
      try {
        res = await fetch('/api/export', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        throw friendlyError(e, 'Export fehlgeschlagen');
      }
      if (!res.ok) {
        let msg = 'Export fehlgeschlagen';
        try { msg = (await res.json()).error || msg; } catch (_) {}
        throw new Error(msg, { cause: { status: res.status, statusText: res.statusText } });
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

    async fetchSettings() {
      return fetchJson('/api/settings', 'Einstellungen konnten nicht geladen werden');
    },

    async saveSettings(patch) {
      return postJson('/api/settings', patch, 'Speichern fehlgeschlagen');
    },

    // "Jetzt sichern": { ok, snapshot, written }; wirft mit dem Klartext des Backends.
    async runBackup() {
      return postJson('/api/backup', {}, 'Sicherung fehlgeschlagen');
    },

    // Extra helpers to allow external calls from components (Zuweisungsmanager / Settings)
    async forceApiRefresh() {
      await refresh();
    }
  };

  // Browser: publish the global and start polling — refresh() immediately, then every
  // 5s, exactly as before. Node (tests, via require('../data.js')): neither must
  // happen — there is no window to publish to, and a live fetch()/setInterval would
  // fire a real network request and leave a timer running that `node --test` never
  // exits. `typeof window` is the standard cross-environment check (same one
  // metrics-logic.js etc. use); nothing else in this file touches window before this
  // point, so this is the only guard the module needs.
  if (typeof module !== 'undefined' && module.exports) {
    // Pure helpers for Node tests (see tests/data.test.js). Everything else on
    // DASH_DATA touches fetch/DOM/timers and is deliberately left untested here.
    module.exports = {
      alarmDirection,
      mapBackendEvent,
      friendlyError,
      formatNumber,
      stats,
      formatValue: DASH_DATA.formatValue,
      formatTime: DASH_DATA.formatTime,
      formatDuration: DASH_DATA.formatDuration,
    };
  }
  if (typeof window !== 'undefined') {
    window.DASH_DATA = DASH_DATA;
    refresh();
    setInterval(refresh, 5000);
  }
})();
