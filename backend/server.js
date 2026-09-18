const express = require('express');
const path = require('path');
// quiet: dotenv 17 schreibt sonst bei jedem Start eine Zeile ohne Zeitstempel ins Log.
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { initDb, getDb, getSetting, saveSetting, closeDb } = require('./db');
const { startScheduler, runSyncCycle, getSchedulerStatus, stopScheduler, pollIntervalSec, POLL_INTERVAL_MIN_SEC, POLL_INTERVAL_MAX_SEC } = require('./scheduler');
const TestoClient = require('./testo-client');
const { handleListenError } = require('./listen-error');
const { getExportMetadata, exportStations } = require('./export-service');
const { resolveBackupDir, runBackupNow, readHealth, backupSummary, retentionDays, RETENTION_DAYS_MAX } = require('./backup-runner');
const { startUpdateCheck, runUpdateCheck, getUpdateStatus } = require('./update-check');
const { info, error, logThrottled } = require('./log');

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

// testo Smart Connect regions (testo-smart-connect-api/02-authentication.md,
// testo-smart-connect-api/_assets/glossary.md): eu / am / ap. 'us' was offered in the settings
// UI through v0.15.x but is not a real region and is rejected by POST /api/settings below.
const VALID_API_REGIONS = ['eu', 'am', 'ap'];

initDb();

// Legacy migration: an install that already has the no-longer-valid 'us' stored would
// otherwise be stuck — GET /api/settings would keep returning 'us', the settings-page
// SegmentedControl highlights nothing for a value outside its options, and the dashboard
// resends api_region on every autosave, which POST would now 400 on, blocking ALL settings
// saves (not just the region). Falling back to 'eu' here, before the scheduler's first sync,
// self-heals existing databases without touching anything outside this process.
const storedApiRegion = getSetting('api_region');
if (storedApiRegion && !VALID_API_REGIONS.includes(storedApiRegion)) {
  saveSetting('api_region', 'eu');
}

const app = express();
app.use(express.json());

// Fehler auf Request-Pfaden wiederholen sich mit dem Poll des Dashboards (alle 5 s,
// 3 + 2×Messstellen Requests; die Systemansicht zusätzlich alle 10 s) — sie laufen
// deshalb über logThrottled() (backend/log.js), das auch der Scheduler nutzt.

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
    // Das wirksame (geklemmte) Intervall, nicht der Rohwert: das Dashboard schickt es bei
    // jedem automatischen Speichern mit, ein Rohwert ausserhalb 60-3600 s liesse daher
    // jedes Speichern der Seite am 400 unten scheitern (wie frueher die Region 'us').
    poll_interval_sec: pollIntervalSec(),
    // Ebenso die wirksame Aufbewahrung (1-3650 Tage) statt des Rohwerts.
    retention_days: retentionDays(),
    backup_enabled: (getSetting('backup_enabled') || '1') === '1',
    backup_dir: getSetting('backup_dir') || '',
    update_dir: getSetting('update_dir') || '',
    csv_format: getSetting('csv_format') || 'de'
  });
});

// POST /api/settings — Eingabepruefung je Feld. Eine Regel gibt den zu speichernden Text
// zurueck, undefined fuer "nichts aendern", oder wirft den Klartext der 400-Antwort (das
// Dashboard zeigt ihn an). Gespeichert wird erst, wenn JEDES Feld gueltig ist — vorher
// blieben bei einem ungueltigen Feld die davor stehenden schon gespeichert zurueck.
const invalid = (msg) => { throw new Error(msg); };

// Ganze Zahl als JSON-Zahl oder reine Ziffernfolge; "900abc", "1.5", "", null nicht (parseInt
// las "900abc" als 900). isSafeInteger, weil String() ab 1e21 "1e+21" schreibt und parseInt
// das als 1 liest: aus riesigen Aufbewahrungstagen wurde 1 Tag.
function wholeNumber(v, min, max, msg) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n >= min && n <= max ? String(n) : invalid(msg);
}
const trimmedText = (v, msg) => (typeof v === 'string' ? v.trim() : invalid(msg));
// Die einzigen Schreibweisen fuer Ein/Aus — vorher galt alles ausser vier Aus-Werten als Ein.
const ON_OFF = new Map([[true, '1'], [1, '1'], ['1', '1'], ['true', '1'],
  [false, '0'], [0, '0'], ['0', '0'], ['false', '0']]);

const SETTING_RULES = {
  // Leer = gespeicherten Schluessel behalten: beabsichtigt und am Feld im Dashboard erklaert.
  api_key: (v) => {
    const key = trimmedText(v, 'API-Schlüssel (api_key) muss Text sein.');
    if (v === '') return undefined;
    return key || invalid('API-Schlüssel (api_key) besteht nur aus Leerzeichen.');
  },
  api_region: (v) => (VALID_API_REGIONS.includes(v) ? v
    : invalid(`api_region must be one of: ${VALID_API_REGIONS.join(', ')}`)),
  poll_interval_sec: (v) => wholeNumber(v, POLL_INTERVAL_MIN_SEC, POLL_INTERVAL_MAX_SEC,
    `Abfrage-Intervall (poll_interval_sec) muss eine ganze Zahl von ${POLL_INTERVAL_MIN_SEC} bis ${POLL_INTERVAL_MAX_SEC} Sekunden sein.`),
  retention_days: (v) => wholeNumber(v, 1, RETENTION_DAYS_MAX,
    `Aufbewahrungszeit (retention_days) muss eine ganze Zahl von 1 bis ${RETENTION_DAYS_MAX} Tagen sein.`),
  csv_format: (v) => {
    const s = String(v);
    return s === 'de' || s === 'rfc' ? s : invalid("csv_format must be 'de' or 'rfc'");
  },
  backup_enabled: (v) => ON_OFF.get(v)
    ?? invalid('Automatisches Backup (backup_enabled) muss true/false, 1/0, "1"/"0" oder "true"/"false" sein.'),
  // Relativ hiesse: relativ zum Arbeitsverzeichnis des Dienstes, einem fremden Ordner.
  // Leer = Standardordner. Schreibtest erst im Handler, nach der Pruefung ALLER Felder.
  backup_dir: (v) => {
    const dir = trimmedText(v, 'Speicherpfad (backup_dir) muss Text sein.');
    return !dir || path.isAbsolute(dir) ? dir
      : invalid('Speicherpfad (backup_dir) muss ein absoluter Pfad sein, z. B. D:\\Sicherung (leer = Standardordner).');
  },
  // Ablageordner fuer den Update-Hinweis. Bewusst OHNE mkdir/Schreibtest: das ist eine
  // fremde, oft nur lesbare Netzfreigabe. Leer = Pruefung aus. Ein nicht erreichbarer
  // Pfad wird angenommen und fuehrt nur zu "kein Update bekannt" — er darf das
  // Speichern der uebrigen Einstellungen nicht scheitern lassen.
  update_dir: (v) => trimmedText(v, 'Ablageordner (update_dir) muss Text sein.'),
};

app.post('/api/settings', (req, res) => {
  const updates = {};
  let known = false;
  try {
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
      if (req.body[key] === undefined) continue;
      known = true;
      const value = rule(req.body[key]);
      if (value !== undefined) updates[key] = value;
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // Vorher: {"success":true} ohne gespeicherten Wert, dazu ein Scheduler-Neustart.
  if (!known) {
    return res.status(400).json({ error: `Keine bekannte Einstellung in der Anfrage (erwartet: ${Object.keys(SETTING_RULES).join(', ')}).` });
  }

  if (updates.backup_dir) {
    try {
      fs.mkdirSync(updates.backup_dir, { recursive: true });
      fs.accessSync(updates.backup_dir, fs.constants.W_OK);
    } catch (e) {
      return res.status(400).json({ error: `backup_dir nicht beschreibbar: ${e.message}` });
    }
  }

  for (const [key, value] of Object.entries(updates)) saveSetting(key, value);
  // Sofort neu pruefen, damit ein neuer Ablageordner ohne Dienstneustart sichtbar wird.
  if ('update_dir' in updates) runUpdateCheck(appVersion);
  // Nur bei echtem Speichern: uebernimmt ein neues Intervall und gibt nach einem
  // Schluesselwechsel sofort Rueckmeldung (Sofortlauf).
  if (Object.keys(updates).length) startScheduler();
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

  // Ein Geraet gehoert zu hoechstens einer Messstelle (Funktionstest 2026-09-17, V28): bei
  // zweien schrieb der Scheduler die Daten unter nur eine, und das Loeschen der anderen nahm
  // echte Messwerte und Alarme per Kaskade mit. Getrimmt; leer oder nur Leerzeichen = kein
  // Geraet (NULL). Dieselbe Messstelle mit ihrer eigenen UUID erneut speichern (Umbenennen)
  // bleibt erlaubt. Die Pruefung traegt auch Installationen, auf denen db.js den UNIQUE-Index
  // wegen einer Alt-Dublette nicht anlegen konnte.
  if (device_uuid != null && typeof device_uuid !== 'string') {
    return res.status(400).json({ error: 'Geräte-UUID (device_uuid) muss Text sein.' });
  }
  const deviceUuid = device_uuid?.trim() || null;
  const db = getDb();
  const ownerOf = () => db.prepare('SELECT id, name FROM stations WHERE device_uuid = ? AND id != ?').get(deviceUuid, id);
  const deviceTaken = (other) => res.status(409).json({
    error: `Das Gerät ${deviceUuid} ist bereits ${other ? `der Messstelle „${other.name}“ (${other.id})` : 'einer anderen Messstelle'} zugewiesen. Ein Gerät kann nur zu einer Messstelle gehören – dort zuerst die Zuweisung entfernen oder ein anderes Gerät wählen.`
  });
  const owner = deviceUuid && ownerOf();
  if (owner) return deviceTaken(owner);

  // Upsert via ON CONFLICT so an edit UPDATEs only the user-editable fields.
  // INSERT OR REPLACE would DELETE the existing row first, which (with foreign
  // keys ON and ON DELETE CASCADE) would wipe the station's measurements/events
  // and reset its live telemetry columns. ON CONFLICT updates in place instead.
  try {
    db.prepare(`
      INSERT INTO stations (id, name, location, mo_uuid, device_uuid)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        location = excluded.location,
        mo_uuid = excluded.mo_uuid,
        device_uuid = excluded.device_uuid
    `).run(id, name, location ?? null, mo_uuid ?? null, deviceUuid);
  } catch (e) {
    // Die id faengt das Upsert ab; eine UNIQUE-Verletzung kann nur der Geraete-Index sein. Er
    // greift erst, wenn zwischen Pruefung und Speichern ein anderer Schreiber (eine zweite
    // Verbindung) dieselbe UUID vergab — dann dieselbe Antwort statt 500.
    if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
    return deviceTaken(ownerOf());
  }

  // Trigger immediate sync for the new station
  runSyncCycle().catch(error);
  res.json({ success: true });
});

// DELETE /api/stations/:id
// The only destructive route in the API — foreign_keys=ON plus ON DELETE CASCADE on
// measurements/events.station_id (db.js) means this wipes the station's entire history.
// That cascade is intentional; what was unguarded is silently reporting success when
// nothing existed to delete. 404 (not 200) on a miss: settings.jsx's deleteStation()
// already branches on res.ok and shows body.error — the same {error} shape every other
// route here uses for a problem — so this needs no frontend change and no new response
// shape for the frontend to learn. A bare id (no format check): any id that couldn't
// have passed POST's validation can never match a row either, so "not found" already
// covers it — a separate 400 would be dead code.
app.delete('/api/stations/:id', (req, res) => {
  const result = getDb().prepare("DELETE FROM stations WHERE id = ?").run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'station not found' });
  }
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
    logThrottled(`Error reading database file size: ${e.message}`);
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
    logThrottled(`Error querying database stats: ${e.message}`);
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
      logThrottled(`Error retrieving partition storage statistics: ${e.message}`);
      // storageStats stays null/unknown — do not fabricate values
    }
  }

  const schedulerStatus = getSchedulerStatus();
  const apiKey = getSetting('api_key');

  res.json({
    appVersion,
    // Zwischengespeichertes Ergebnis der Update-Pruefung — hier wird NICHT auf die
    // Netzfreigabe zugegriffen (dieser Endpunkt wird alle 10 s abgefragt).
    update: getUpdateStatus(),
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
      region: getSetting('api_region') || 'eu',
      // #16: is the running instance currently serving fabricated data instead of real testo
      // measurements? Reuses TestoClient's own condition (see testo-client.js) verbatim so
      // this can never silently drift from what _mockModeActive() actually decides.
      mockActive: TestoClient.isMockCondition(apiKey)
    },
    backup: {
      enabled: (getSetting('backup_enabled') || '1') === '1',
      dir: resolveBackupDir(),
      lastScanDate: getSetting('last_backup_scan_date') || null,
      health: readHealth()
    },
    // #10: which metrics currently have a conflicting threshold configuration across
    // measuring objects (dropped from `limits`, see parseAlarmConfiguration) — empty
    // metrics array once resolved. Same getSetting/JSON.parse shape as readHealth() (backup-runner.js).
    limitsConflict: (() => {
      let info = {};
      try { info = JSON.parse(getSetting('limits_conflict') || '{}'); } catch (_) {}
      return { metrics: info.metrics || [], updatedAt: info.updatedAt || null };
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
  runSyncCycle().catch(error);
  res.status(202).json({ started: true });
});

// POST /api/backup — "Jetzt sichern" (Datenexport → Datensicherung): ZIPs und Datenbank-Abzug
// sofort, an der Tagesdrossel vorbei. Bewusst auch bei ausgeschaltetem backup_enabled: der
// Schalter gilt dem taeglichen Automatik-Lauf, ein Knopfdruck ist eine ausdrueckliche
// Einzelhandlung (z. B. vor einem Update). Synchron, also keine Ueberlappung mit dem Lauf
// eines Sync-Zyklus (runBackupNow); genau eine Logzeile je Knopfdruck.
app.post('/api/backup', (req, res) => {
  const failed = runBackupNow(Date.now()).errors.length > 0;
  const h = readHealth();
  if (failed) {
    error(`Sicherung (manuell) fehlgeschlagen: ${backupSummary(h)}`);
    return res.status(500).json({ error: backupSummary(h) });
  }
  info(`Sicherung (manuell) ok: ${backupSummary(h)}`);
  res.json({ ok: true, snapshot: h.lastDbSnapshot, written: h.written || 0 });
});

// Test-only route: lets the test suite prove the 4-arg error middleware works.
// Guarded by NODE_ENV so it is unreachable in production.
if (process.env.NODE_ENV === 'test') {
  // ?msg=… erlaubt dem Test mehrere unterschiedliche Fehlersignaturen.
  app.get('/api/_test/throw', (req) => { throw new Error(req.query.msg || 'test-boom'); });
}

// Central error-handling middleware (4-arg form) — catches thrown errors from
// route handlers and returns a JSON 500 instead of hanging or leaking stack traces.
// Must be registered AFTER all routes.
//
// Beim ersten Auftreten den vollen Stack — ohne ihn ist ein Fehler auf einer
// Kundenmaschine nicht diagnostizierbar. Jede Wiederholung derselben Signatur
// läuft über logThrottled() und erzeugt keine erneute volle Ausgabe.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // Ein unlesbarer Body (kaputtes JSON, zu gross, fremder Zeichensatz) scheitert schon in
  // express.json(), vor jeder Route: ein Fehler des Aufrufers, kein Serverfehler. Solche
  // Fehler tragen err.type und einen 4xx-Status. Die Parser-Meldung ("Expected property
  // name ... at position 1") ist Interna und gehoert weder in die Antwort noch ins Log.
  if (err.type && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.type === 'entity.parse.failed'
      ? 'Ungültige Anfrage: Der Inhalt ist kein gültiges JSON.'
      : 'Ungültige Anfrage: Der Inhalt konnte nicht gelesen werden.' });
  }
  // `|| err` fängt geworfene Nicht-Error-Werte (String, Objekt) ab.
  logThrottled(
    `Unhandled route error: ${err.name || 'Error'}: ${err.message || err}`,
    `Unhandled route error: ${err.stack || err}`
  );
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
// HOST defaults to 127.0.0.1 (local-only) — the secure default per CLAUDE.md.
// Set HOST=0.0.0.0 (e.g. in .env) for opt-in LAN/tablet access (+ firewall rule).
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  info(`Klima Dashboard ${appVersion} server running on http://${HOST}:${PORT}`);
  // Hintergrundjobs erst nach erfolgreichem Bind: eine zweite Instanz, die am belegten
  // Port scheitert (Windows-Task-Neustart, doppelter Start), darf vorher weder einen
  // Sync-Zyklus gegen die testo-Cloud noch Schreibzugriffe auf die gemeinsame DB anstoßen.
  startScheduler();
  startUpdateCheck(appVersion);
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
