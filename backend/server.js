const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { initDb, getDb, getSetting, saveSetting, closeDb } = require('./db');
const { startScheduler, runSyncCycle, getSchedulerStatus, stopScheduler } = require('./scheduler');
const TestoClient = require('./testo-client');
const { handleListenError } = require('./listen-error');
const { getExportMetadata, exportStations } = require('./export-service');
const { resolveBackupDir } = require('./backup-runner');

// Read application version from VERSION file; fall back to package.json
const fs = require('fs');
let appVersion = '0.0.0';
try {
  appVersion = fs.readFileSync(path.join(__dirname, '../VERSION'), 'utf8').trim();
} catch (_e) {
  try {
    appVersion = require('../package.json').version || '0.0.0';
  } catch (_e2) { /* ignore */ }
}

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
// Returns api_key_set (boolean) instead of the cleartext api_key to prevent leaking secrets.
app.get('/api/settings', (req, res) => {
  const storedKey = getSetting('api_key') || '';
  res.json({
    api_key_set: storedKey.length > 0,
    api_region: getSetting('api_region') || 'eu',
    poll_interval_sec: parseInt(getSetting('poll_interval_sec') || '900', 10),
    retention_days: parseInt(getSetting('retention_days') || '365', 10),
    backup_enabled: (getSetting('backup_enabled') || '1') === '1',
    backup_dir: getSetting('backup_dir') || '',
    csv_format: getSetting('csv_format') || 'de'
  });
});

// POST /api/settings
app.post('/api/settings', (req, res) => {
  const { api_key, api_region, poll_interval_sec, retention_days } = req.body;

  // Validate poll_interval_sec when present
  if (poll_interval_sec !== undefined) {
    const v = parseInt(poll_interval_sec, 10);
    if (isNaN(v) || v <= 0) {
      return res.status(400).json({ error: 'poll_interval_sec must be a positive integer' });
    }
  }

  // Validate retention_days when present
  if (retention_days !== undefined) {
    const v = parseInt(retention_days, 10);
    if (isNaN(v) || v <= 0) {
      return res.status(400).json({ error: 'retention_days must be a positive integer' });
    }
  }

  // Validate api_region when present
  if (api_region !== undefined && !['eu', 'us'].includes(api_region)) {
    return res.status(400).json({ error: "api_region must be 'eu' or 'us'" });
  }

  // Only overwrite the stored api_key when a non-empty string is supplied;
  // an absent or empty-string value leaves the key unchanged so it is never wiped.
  if (api_key !== undefined && api_key !== '') {
    saveSetting('api_key', api_key);
  }
  if (api_region !== undefined) saveSetting('api_region', api_region);
  if (poll_interval_sec !== undefined) saveSetting('poll_interval_sec', String(parseInt(poll_interval_sec, 10)));
  if (retention_days !== undefined) saveSetting('retention_days', String(parseInt(retention_days, 10)));

  // csv_format, backup_enabled, backup_dir
  if (req.body.csv_format !== undefined) {
    const v = String(req.body.csv_format);
    if (v !== 'de' && v !== 'rfc') return res.status(400).json({ error: "csv_format must be 'de' or 'rfc'" });
    saveSetting('csv_format', v);
  }
  if (req.body.backup_enabled !== undefined) {
    const be = req.body.backup_enabled;
    const disabled = be === false || be === 0 || be === '0' || be === 'false';
    saveSetting('backup_enabled', disabled ? '0' : '1');
  }
  if (req.body.backup_dir !== undefined) {
    const dir = String(req.body.backup_dir || '').trim();
    if (dir) {
      try {
        require('fs').mkdirSync(dir, { recursive: true });
        require('fs').accessSync(dir, require('fs').constants.W_OK);
      } catch (e) {
        return res.status(400).json({ error: `backup_dir nicht beschreibbar: ${e.message}` });
      }
    }
    saveSetting('backup_dir', dir);
  }

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

  // Validate required fields
  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({ error: 'id must be a non-empty string' });
  }
  if (!/^[a-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'id must match /^[a-z0-9_-]+$/ (lowercase letters, digits, hyphens, underscores)' });
  }
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }

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
  `).run(id, name, location ?? null, mo_uuid ?? null, device_uuid ?? null);

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
// Optional query params:
//   limit       — max rows (positive int); omitted/invalid => no limit (backward compatible)
//   active      — '0' (resolved only) | '1' (active only); anything else => both
//   before_ts   — compound cursor anchor (int ms); omitted/invalid => ignored
//   before_rowid— compound cursor tiebreak (int); only used together with before_ts
// Cursor (robust against equal start_ts): (start_ts < before_ts) OR (start_ts = before_ts AND rowid < before_rowid).
app.get('/api/stations/:id/events', (req, res) => {
  const clauses = ['station_id = ?'];
  const params = [req.params.id];

  // Recovery transitions ('Ok') are the closing edge of an episode, not standalone
  // events — their timestamp is folded into the violation's duration (end_ts), so they
  // must never render as their own card. Self-derived sys-* rows (alarm_status NULL)
  // and active rows (never 'Ok') are unaffected.
  clauses.push("(alarm_status IS NULL OR alarm_status <> 'Ok')");

  if (req.query.active === '0' || req.query.active === '1') {
    clauses.push('active = ?');
    params.push(Number(req.query.active));
  }

  const beforeTs = Number.parseInt(req.query.before_ts, 10);
  if (Number.isFinite(beforeTs)) {
    const beforeRowid = Number.parseInt(req.query.before_rowid, 10);
    if (Number.isFinite(beforeRowid)) {
      clauses.push('(start_ts < ? OR (start_ts = ? AND rowid < ?))');
      params.push(beforeTs, beforeTs, beforeRowid);
    } else {
      clauses.push('start_ts < ?');
      params.push(beforeTs);
    }
  }

  let sql = `SELECT *, rowid AS _rowid FROM events WHERE ${clauses.join(' AND ')} ORDER BY active DESC, start_ts DESC, rowid DESC`;

  const limit = Number.parseInt(req.query.limit, 10);
  if (Number.isFinite(limit) && limit > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const events = getDb().prepare(sql).all(...params);
  res.json(events);
});

// GET /api/limits
// Returns the current alarm threshold configuration as synced from the testo
// measuring-objects endpoint. Empty array when no sync has run yet.
// Returns a bare array (consistent with every other collection endpoint in this API).
app.get('/api/limits', (req, res) => {
  const rows = getDb().prepare(`
    SELECT metric, direction, severity, limit_value AS limitValue,
           hysteresis, delay_ms AS delayMs, unit, updated_at AS updatedAt
    FROM limits
    ORDER BY metric, direction, severity
  `).all();
  res.json(rows);
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
  // lastWrite and oldestRecord remain null when there are genuinely no rows.
  let oldestRecord = null;
  let lastWrite = null;

  try {
    tables.measurements = db.prepare("SELECT count(*) as count FROM measurements").get().count || 0;
    tables.events = db.prepare("SELECT count(*) as count FROM events").get().count || 0;
    tables.stations = db.prepare("SELECT count(*) as count FROM stations").get().count || 0;
    tables.settings = db.prepare("SELECT count(*) as count FROM settings").get().count || 0;

    // Get oldest and newest record timestamp — null when the tables are empty.
    const oldestMeas = db.prepare("SELECT min(timestamp) as min_ts FROM measurements").get();
    const newestMeas = db.prepare("SELECT max(timestamp) as max_ts FROM measurements").get();
    const oldestEvent = db.prepare("SELECT min(start_ts) as min_ts FROM events").get();
    const newestEvent = db.prepare("SELECT max(start_ts) as max_ts FROM events").get();

    const times = [];
    if (oldestMeas && oldestMeas.min_ts != null) times.push(oldestMeas.min_ts);
    if (oldestEvent && oldestEvent.min_ts != null) times.push(oldestEvent.min_ts);
    if (times.length > 0) oldestRecord = Math.min(...times);

    const writeTimes = [];
    if (newestMeas && newestMeas.max_ts != null) writeTimes.push(newestMeas.max_ts);
    if (newestEvent && newestEvent.max_ts != null) writeTimes.push(newestEvent.max_ts);
    if (writeTimes.length > 0) lastWrite = Math.max(...writeTimes);
  } catch (e) {
    console.error("Error querying database stats:", e);
  }

  // Get disk storage partition statistics using fs.statfsSync.
  // Return null fields when the path is :memory: or statfs fails — never fabricate values.
  let storageStats = {
    usedGb: null,
    totalGb: null,
    status: 'unknown'
  };

  if (dbPath !== ':memory:') {
    try {
      const stats = fs.statfsSync(path.dirname(dbPath));
      const totalGb = (stats.blocks * stats.bsize) / (1024 ** 3);
      const freeGb = (stats.bavail * stats.bsize) / (1024 ** 3);
      storageStats.totalGb = Math.round(totalGb * 10) / 10;
      storageStats.usedGb = Math.round((totalGb - freeGb) * 10) / 10;
      storageStats.status = freeGb < 1.0 ? 'warn' : 'ok';
    } catch (e) {
      console.error("Error retrieving partition storage statistics:", e);
      // storageStats stays null/unknown — do not fabricate values
    }
  }

  const schedulerStatus = getSchedulerStatus();
  const apiKey = getSetting('api_key');

  res.json({
    appVersion,
    database: {
      status: "ok",
      sizeBytes: dbSize,
      rowCount: tables.measurements + tables.events + tables.stations + tables.settings,
      lastWrite,
      oldestRecord,
      engine: "SQLite 3",
      tableRows: tables
    },
    scheduler: schedulerStatus,
    storage: storageStats,
    api: {
      status: schedulerStatus.lastSyncStatus === 'error' ? 'err' : (apiKey ? 'ok' : 'warn'),
      apiKeyConfigured: !!apiKey,
      region: getSetting('api_region') || 'eu'
    },
    backup: (() => {
      let health = {};
      try { health = JSON.parse(getSetting('backup_health') || '{}'); } catch (_) {}
      return {
        enabled: (getSetting('backup_enabled') || '1') === '1',
        dir: resolveBackupDir(),
        lastScanDate: getSetting('last_backup_scan_date') || null,
        health
      };
    })()
  });
});

// GET /api/export/metadata — returns per-station available metric keys and date range
app.get('/api/export/metadata', (req, res) => {
  try { res.json(getExportMetadata()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/export — streams a CSV (or ZIP) export for one or more stations
app.post('/api/export', (req, res) => {
  const { stationIds, metrics, from, to, includeEvents, dialect } = req.body || {};
  if (!Array.isArray(stationIds) || stationIds.length === 0) return res.status(400).json({ error: 'stationIds required' });
  const fromTs = Number(from), toTs = Number(to);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || fromTs > toTs) return res.status(400).json({ error: 'invalid time range' });
  try {
    const out = exportStations({
      stationIds,
      metricKeys: Array.isArray(metrics) ? metrics : null,
      fromTs,
      toTs,
      includeEvents: !!includeEvents,
      dialectName: dialect || getSetting('csv_format') || 'de',
      nowMs: Date.now(),
    });
    const asciiName = out.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
    res.send(out.buffer);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/sync — stößt sofort einen Sync-Zyklus an (Resync-Button der Systemübersicht).
// No-op, wenn bereits ein Sync läuft — runSyncCycle() ist zusätzlich selbst idempotent.
app.post('/api/sync', (req, res) => {
  if (getSchedulerStatus().isSyncing) {
    return res.json({ started: false, reason: 'already-running' });
  }
  runSyncCycle().catch(console.error);
  res.status(202).json({ started: true });
});

// Test-only route: lets the test suite prove the 4-arg error middleware works.
// Guarded by NODE_ENV so it is unreachable in production.
if (process.env.NODE_ENV === 'test') {
  app.get('/api/_test/throw', () => { throw new Error('test-boom'); });
}

// Central error-handling middleware (4-arg form) — catches thrown errors from
// route handlers and returns a JSON 500 instead of hanging or leaking stack traces.
// Must be registered AFTER all routes.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('Unhandled route error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
// Bind to HOST env var when set (e.g. 127.0.0.1 for local-only),
// otherwise omit the host so Express binds to all interfaces (LAN/tablet access).
const server = process.env.HOST
  ? app.listen(PORT, process.env.HOST, () => {
      console.log(`Klima Dashboard server running on http://${process.env.HOST}:${PORT}`);
    })
  : app.listen(PORT, () => {
      console.log(`Klima Dashboard server running on http://localhost:${PORT}`);
    });

// Nur außerhalb der Tests anhängen: backend/tests/server.test.js importiert dieses
// Modul und bindet real Port 3001 (process.env.PORT). Ein process.exit(1) im
// 'error'-Handler würde sonst bei einem Port-Konflikt den Test-Worker hart beenden.
// Gleiches NODE_ENV-Guard-Muster wie die Test-Route in server.js (Zeile ~408).
if (process.env.NODE_ENV !== 'test') {
  server.on('error', (e) => handleListenError(e));
}

// Graceful shutdown on SIGINT / SIGTERM.
// Guard with a flag in case the module cache is cleared / the module is loaded more than once.
if (!process.env._KLIMA_SHUTDOWN_REGISTERED) {
  process.env._KLIMA_SHUTDOWN_REGISTERED = '1';
  const shutdown = () => {
    server.close();
    stopScheduler();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = server;
