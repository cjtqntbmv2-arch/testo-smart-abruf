const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

let db = null;

function initDb() {
  if (db) return;
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../klima.db');
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  // 1. Settings Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // 2. Stations Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT,
      mo_uuid TEXT,
      device_uuid TEXT,
      serial_no TEXT,
      online INTEGER DEFAULT 1,
      battery INTEGER,
      signal INTEGER,
      connection_type TEXT,
      is_powersupply_on INTEGER,
      fw_version TEXT,
      model_code TEXT,
      last_communication INTEGER,
      last_measurement_time INTEGER,
      next_communication INTEGER
    )
  `);

  // 3. Measurements Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS measurements (
      uuid TEXT PRIMARY KEY,
      station_id TEXT,
      timestamp INTEGER,
      timestamp_local TEXT,
      value REAL,
      physical_property TEXT,
      unit TEXT,
      channel_no INTEGER,
      sensor_uuid TEXT,
      serial_no TEXT,
      model_code TEXT,
      processed_at TEXT,
      FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_meas_timestamp ON measurements(station_id, timestamp)`);

  // 4. Events / Alarms Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      uuid TEXT PRIMARY KEY,
      station_id TEXT,
      severity TEXT NOT NULL,
      alarm_status TEXT,
      alarm_reason TEXT,
      alarm_condition_type TEXT,
      alarm_value REAL,
      metric TEXT,
      threshold REAL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER,
      extreme REAL,
      active INTEGER DEFAULT 1,
      message TEXT,
      detail TEXT,
      FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
    )
  `);

  // Seed default settings and stations if empty and not in memory (test) mode
  if (dbPath !== ':memory:') {
    const count = db.prepare("SELECT count(*) as count FROM settings").get().count;
    if (count === 0) {
      const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
      stmt.run('api_key', process.env.TESTO_API_KEY || '');
      stmt.run('api_region', process.env.TESTO_API_REGION || 'eu');
      stmt.run('poll_interval_sec', process.env.POLL_INTERVAL_SEC || '900');
      stmt.run('retention_days', process.env.RETENTION_DAYS || '365');
    }

    // Stations are created by the user via the assignment UI and bound to real
    // testo devices; no placeholder seed.
  }
}

function getDb() {
  if (!db) initDb();
  return db;
}

function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function saveSetting(key, value) {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDb,
  getDb,
  getSetting,
  saveSetting,
  closeDb
};
