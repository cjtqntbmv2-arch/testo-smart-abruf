// Fully functional data.js connecting the React frontend to the Node.js REST API.
// Exposes the window.DASH_DATA interface and polls the local Express endpoints.

(function () {
  const POINTS = 144;
  const STEP_MS = 10 * 60 * 1000;

  // Dew point & absolute humidity formulas
  function dewPoint(T, RH) {
    const a = 17.625, b = 243.04;
    const alpha = Math.log(Math.max(1, RH) / 100) + (a * T) / (b + T);
    return (b * alpha) / (a - alpha);
  }
  function absHumidity(T, RH) {
    return (6.112 * Math.exp((17.67 * T) / (T + 243.5)) * RH * 2.1674) / (273.15 + T);
  }

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

  // Main API Polling function
  async function refresh() {
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

        // Compute derived metrics: dewpoint and abshumid
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

        // Apply calibration offsets
        let dashSettings = {};
        try {
          const raw = localStorage.getItem("dash-settings-v1");
          if (raw) dashSettings = JSON.parse(raw);
        } catch (e) {}
        const calRaw = (dashSettings.calibration && dashSettings.calibration[s.id]) || {};
        const calT = calRaw.temperature ?? 0;
        const calH = calRaw.humidity ?? 0;
        
        seriesT = seriesT.map(v => typeof v === 'number' && !Number.isNaN(v) ? v + calT : NaN);
        seriesH = seriesH.map(v => typeof v === 'number' && !Number.isNaN(v) ? v + calH : NaN);
        seriesP = seriesP.map(v => typeof v === 'number' && !Number.isNaN(v) ? v : NaN);

        const seriesD = seriesT.map((t, i) => {
          const h = seriesH[i];
          return (Number.isNaN(t) || Number.isNaN(h)) ? NaN : dewPoint(t, h);
        });
        const seriesA = seriesT.map((t, i) => {
          const h = seriesH[i];
          return (Number.isNaN(t) || Number.isNaN(h)) ? NaN : absHumidity(t, h);
        });

        // Prefer the device's MEASURED dewpoint / abs. humidity when the backend
        // delivers that channel; fall back to the locally computed value per
        // timestamp wherever the device reports no such channel.
        const measuredD = (stationMetrics.dewpoint && stationMetrics.dewpoint.series) || [];
        const measuredA = (stationMetrics.abshumid && stationMetrics.abshumid.series) || [];
        const finalD = seriesD.map((computed, i) => {
          const m = measuredD[i];
          return (typeof m === 'number' && !Number.isNaN(m)) ? m : computed;
        });
        const finalA = seriesA.map((computed, i) => {
          const m = measuredA[i];
          return (typeof m === 'number' && !Number.isNaN(m)) ? m : computed;
        });

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
          const resEvents = await fetch(`/api/stations/${s.id}/events`);
          if (resEvents.ok) {
            const rawEvents = await resEvents.json();
            backendEvents = rawEvents.map(e => ({
              id: e.uuid,
              severity: e.severity,
              system: e.severity === 'system' ? (e.alarm_condition_type || 'maintenance') : null,
              message: e.message || e.alarm_reason || 'Grenzwert verletzt',
              detail: e.detail || `Sensorwert: ${e.alarm_value}`,
              metric: e.metric ? e.metric.toLowerCase() : null,
              condition: e.alarm_condition_type ? (e.alarm_condition_type.includes('UPPER') ? 'high' : 'low') : 'high',
              threshold: e.threshold,
              startTs: e.start_ts,
              endTs: e.end_ts,
              extreme: e.extreme || e.alarm_value,
              active: !!e.active
            }));
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

      emit();
    } catch (e) {
      console.error('Error refreshing dashboard data:', e);
    }
  }

  // Initialize
  // Seed local placeholders before the async fetch finishes to avoid startup errors
  STATION_ORDER = ['living', 'bedroom', 'outdoor', 'basement'];
  activeStationId = 'living';
  timestamps = new Array(POINTS).fill(0).map((_, i) => Date.now() - (POINTS - 1 - i) * STEP_MS);

  for (const sid of STATION_ORDER) {
    const sName = sid === 'living' ? 'Wohnzimmer' : sid === 'bedroom' ? 'Schlafzimmer' : sid === 'outdoor' ? 'Außensensor' : 'Keller';
    const sLoc = sid === 'living' ? '1. OG · Süd' : sid === 'bedroom' ? '1. OG · Nord' : sid === 'outdoor' ? 'Garten' : 'UG';

    const metrics = {};
    for (const mid of METRIC_IDS) {
      metrics[mid] = {
        ...META[mid],
        series: new Array(POINTS).fill(mid === 'temperature' ? 20.0 : mid === 'humidity' ? 50.0 : 1013.0),
        domain: META[mid].domain || [0, 100]
      };
    }

    STATIONS[sid] = {
      id: sid,
      name: sName,
      code: sid.substring(0, 3).toUpperCase(),
      location: sLoc,
      online: true,
      battery: 100,
      signal: 100,
      lastSeen: Date.now(),
      metrics,
      events: []
    };
  }

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

    // Extra helpers to allow external calls from components (Zuweisungsmanager / Settings)
    async forceApiRefresh() {
      await refresh();
    }
  };
})();
