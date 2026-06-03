const express = require('express');
const path = require('path');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { initDb, getDb, getSetting, saveSetting } = require('./db');
const { startScheduler, runSyncCycle, getSchedulerStatus } = require('./scheduler');
const TestoClient = require('./testo-client');
require('dotenv').config();

initDb();
startScheduler();

const app = express();
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../Smart Meter Dashboard')));

// Redirect root to the dashboard file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../Smart Meter Dashboard/Klima Dashboard.html'));
});

// GET /api/settings
app.get('/api/settings', (req, res) => {
  res.json({
    api_key: getSetting('api_key') || '',
    api_region: getSetting('api_region') || 'eu',
    poll_interval_sec: parseInt(getSetting('poll_interval_sec') || '900', 10),
    retention_days: parseInt(getSetting('retention_days') || '365', 10)
  });
});

// POST /api/settings
app.post('/api/settings', (req, res) => {
  const { api_key, api_region, poll_interval_sec, retention_days } = req.body;
  if (api_key !== undefined) saveSetting('api_key', api_key);
  if (api_region !== undefined) saveSetting('api_region', api_region);
  if (poll_interval_sec !== undefined) saveSetting('poll_interval_sec', poll_interval_sec);
  if (retention_days !== undefined) saveSetting('retention_days', retention_days);
  
  // Restart scheduler with new interval
  startScheduler();
  res.json({ success: true });
});

// GET /api/stations
app.get('/api/stations', (req, res) => {
  const stations = getDb().prepare("SELECT * FROM stations").all();
  res.json(stations);
});

// POST /api/stations (Zuweisungsmanager create/update)
app.post('/api/stations', (req, res) => {
  const { id, name, location, mo_uuid, device_uuid } = req.body;

  // Upsert via ON CONFLICT so an edit UPDATEs only the user-editable fields.
  // INSERT OR REPLACE would DELETE the existing row first, which (with foreign
  // keys ON and ON DELETE CASCADE) would wipe the station's measurements/events
  // and reset its live telemetry columns. ON CONFLICT updates in place instead.
  getDb().prepare(`
    INSERT INTO stations (id, name, location, mo_uuid, device_uuid)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      location = excluded.location,
      mo_uuid = excluded.mo_uuid,
      device_uuid = excluded.device_uuid
  `).run(id, name, location, mo_uuid, device_uuid);
  
  // Trigger immediate sync for the new station
  runSyncCycle().catch(console.error);
  res.json({ success: true });
});

// DELETE /api/stations/:id
app.delete('/api/stations/:id', (req, res) => {
  getDb().prepare("DELETE FROM stations WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// GET /api/stations/:id/metrics
// Every dashboard metric the backend can store, with its default unit. The handler
// forward-fills one aligned series per property so the frontend gets stable arrays.
const METRIC_PROPS = [
  { key: 'temperature', unit: '°C' },
  { key: 'humidity',    unit: '%' },
  { key: 'pressure',    unit: 'hPa' },
  { key: 'dewpoint',    unit: '°C' },
  { key: 'abshumid',    unit: 'g/m³' },
];

app.get('/api/stations/:id/metrics', (req, res) => {
  const db = getDb();
  const stationId = req.params.id;
  const since = Date.now() - 24 * 3600 * 1000; // last 24h

  const rows = db.prepare(`
    SELECT timestamp, value, physical_property, unit
    FROM measurements
    WHERE station_id = ? AND timestamp > ?
    ORDER BY timestamp ASC
  `).all(stationId, since);

  // Unique, ordered timestamps across all properties.
  const sortedTimestamps = [...new Set(rows.map((r) => r.timestamp))].sort((a, b) => a - b);

  // timestamp -> { property -> value }
  const timeMap = new Map(sortedTimestamps.map((ts) => [ts, {}]));
  const units = {};
  for (const r of rows) {
    const slot = timeMap.get(r.timestamp);
    if (slot) slot[r.physical_property] = r.value;
    units[r.physical_property] = r.unit;
  }

  // One forward-filled series per known metric. A property the sensor never reports
  // stays null (the frontend renders that as a gap, not a fabricated value).
  const metrics = {};
  for (const { key, unit } of METRIC_PROPS) {
    metrics[key] = { series: [], unit: units[key] ?? unit };
  }
  const last = {};
  for (const ts of sortedTimestamps) {
    const slot = timeMap.get(ts);
    for (const { key } of METRIC_PROPS) {
      if (slot[key] != null) last[key] = slot[key];
      metrics[key].series.push(last[key] ?? null);
    }
  }

  res.json({ timestamps: sortedTimestamps, metrics });
});

// GET /api/stations/:id/events
app.get('/api/stations/:id/events', (req, res) => {
  const events = getDb().prepare(`
    SELECT * FROM events
    WHERE station_id = ?
    ORDER BY active DESC, start_ts DESC
  `).all(req.params.id);
  res.json(events);
});

// GET /api/totals
app.get('/api/totals', (req, res) => {
  const totals = getDb().prepare(`
    SELECT 
      SUM(CASE WHEN severity = 'alarm' AND active = 1 THEN 1 ELSE 0 END) as alarm,
      SUM(CASE WHEN severity = 'warning' AND active = 1 THEN 1 ELSE 0 END) as warning,
      SUM(CASE WHEN severity = 'system' AND active = 1 THEN 1 ELSE 0 END) as system
    FROM events
  `).get();
  res.json({
    alarm: totals.alarm || 0,
    warning: totals.warning || 0,
    system: totals.system || 0
  });
});

// GET /api/testo/measuring-objects (Proxy to load dropdown options)
app.get('/api/testo/measuring-objects', async (req, res) => {
  try {
    const apiKey = getSetting('api_key');
    const region = getSetting('api_region') || 'eu';
    if (!apiKey) return res.status(400).json({ error: 'API key not configured' });

    const client = new TestoClient(apiKey, region);
    const objects = await client.fetchMeasuringObjects();
    res.json(objects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/testo/devices (deduplicated device list for the assignment picker)
app.get('/api/testo/devices', async (req, res) => {
  try {
    const apiKey = getSetting('api_key');
    const region = getSetting('api_region') || 'eu';
    if (!apiKey) return res.status(400).json({ error: 'API key not configured' });

    const client = new TestoClient(apiKey, region);
    const props = await client.fetchDeviceProperties();
    const byDevice = new Map();
    for (const r of props) {
      if (!r.device_uuid || byDevice.has(r.device_uuid)) continue;
      byDevice.set(r.device_uuid, {
        device_uuid: r.device_uuid,
        name: r.device_display_name || r.device_uuid,
        serial_no: r.device_serial_no || '',
        model_code: r.device_model_code || ''
      });
    }
    res.json(Array.from(byDevice.values()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/system/status
const fs = require('fs');
app.get('/api/system/status', (req, res) => {
  const db = getDb();
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../klima.db');

  let dbSize = 0;
  try {
    if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
      dbSize = fs.statSync(dbPath).size;
    }
  } catch (e) {
    console.error("Error reading database file size:", e);
  }

  let tables = {
    measurements: 0,
    events: 0,
    stations: 0,
    settings: 0
  };
  let oldestRecord = null;
  let lastWrite = null;

  try {
    tables.measurements = db.prepare("SELECT count(*) as count FROM measurements").get().count || 0;
    tables.events = db.prepare("SELECT count(*) as count FROM events").get().count || 0;
    tables.stations = db.prepare("SELECT count(*) as count FROM stations").get().count || 0;
    tables.settings = db.prepare("SELECT count(*) as count FROM settings").get().count || 0;

    // Get oldest and newest record timestamp
    const oldestMeas = db.prepare("SELECT min(timestamp) as min_ts FROM measurements").get();
    const newestMeas = db.prepare("SELECT max(timestamp) as max_ts FROM measurements").get();
    const oldestEvent = db.prepare("SELECT min(start_ts) as min_ts FROM events").get();
    const newestEvent = db.prepare("SELECT max(start_ts) as max_ts FROM events").get();

    const times = [];
    if (oldestMeas && oldestMeas.min_ts) times.push(oldestMeas.min_ts);
    if (oldestEvent && oldestEvent.min_ts) times.push(oldestEvent.min_ts);
    if (times.length > 0) oldestRecord = Math.min(...times);

    const writeTimes = [];
    if (newestMeas && newestMeas.max_ts) writeTimes.push(newestMeas.max_ts);
    if (newestEvent && newestEvent.max_ts) writeTimes.push(newestEvent.max_ts);
    if (writeTimes.length > 0) lastWrite = Math.max(...writeTimes);
  } catch (e) {
    console.error("Error querying database stats:", e);
  }

  // Get disk storage partition statistics using fs.statfsSync
  let storageStats = {
    usedGb: 0,
    totalGb: 0,
    status: 'ok'
  };

  try {
    if (dbPath !== ':memory:') {
      const stats = fs.statfsSync(path.dirname(dbPath));
      const totalGb = (stats.blocks * stats.bsize) / (1024 ** 3);
      const freeGb = (stats.bavail * stats.bsize) / (1024 ** 3);
      storageStats.totalGb = Math.round(totalGb * 10) / 10;
      storageStats.usedGb = Math.round((totalGb - freeGb) * 10) / 10;
      if (freeGb < 1.0) {
        storageStats.status = 'warn';
      }
    } else {
      storageStats.totalGb = 16.0;
      storageStats.usedGb = 0.1;
    }
  } catch (e) {
    console.error("Error retrieving partition storage statistics:", e);
    storageStats.totalGb = 50.0;
    storageStats.usedGb = 10.0;
  }

  const schedulerStatus = getSchedulerStatus();
  const apiKey = getSetting('api_key');

  res.json({
    database: {
      status: "ok",
      sizeBytes: dbSize,
      rowCount: tables.measurements + tables.events + tables.stations + tables.settings,
      lastWrite: lastWrite || Date.now(),
      oldestRecord: oldestRecord || (Date.now() - 30 * 24 * 3600 * 1000),
      engine: "SQLite 3",
      tableRows: tables
    },
    scheduler: schedulerStatus,
    storage: storageStats,
    api: {
      status: schedulerStatus.lastSyncStatus === 'error' ? 'err' : (apiKey ? 'ok' : 'warn'),
      apiKeyConfigured: !!apiKey,
      region: getSetting('api_region') || 'eu'
    }
  });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Klima Dashboard server running on http://localhost:${PORT}`);
});

module.exports = server;
