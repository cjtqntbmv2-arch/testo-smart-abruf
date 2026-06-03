# testo Smart Connect API Integration & Dashboard Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the static Klima Dashboard draft into a fully working, local Node.js web application on a Windows PC that periodically pulls data from the testo Smart Connect API, stores it in SQLite, and displays it via the dashboard.

**Architecture:** A single-process Node.js monolith hosting an Express server for the dashboard assets and local REST API, alongside a background interval-based scheduler that syncs measurement data, device status, and alarms from the testo API into SQLite.

**Tech Stack:** Node.js (v18+), Express, `better-sqlite3` (SQLite driver), Native `fetch` (Node 18+), `dotenv` (configuration). Built-in `node:test` runner for TDD tests.

---

### Task 1: Project Initialization & package.json

**Files:**
- Create: `package.json`
- Create: `.env`
- Modify: `.gitignore`
- Test: `backend/tests/init.test.js`

- [ ] **Step 1: Write the initialization test**
  Create `backend/tests/init.test.js` with the following test logic using native `node:test`:
  ```javascript
  const test = require('node:test');
  const assert = require('node:assert');
  const fs = require('node:fs');

  test('Check that environment variables and package dependencies are defined', () => {
    assert.ok(fs.existsSync('.env'), '.env file should exist');
    assert.ok(fs.existsSync('package.json'), 'package.json file should exist');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.ok(pkg.dependencies.express, 'express should be in dependencies');
    assert.ok(pkg.dependencies['better-sqlite3'], 'better-sqlite3 should be in dependencies');
    assert.ok(pkg.dependencies.dotenv, 'dotenv should be in dependencies');
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**
  Run: `node --test backend/tests/init.test.js`
  Expected: FAIL (modules not found or files do not exist)

- [ ] **Step 3: Create package.json, install dependencies, and setup .env**
  Create `package.json`:
  ```json
  {
    "name": "testo-smart-abruf",
    "version": "1.0.0",
    "description": "Local server and dashboard for testo Smart Connect API data sync",
    "main": "backend/server.js",
    "scripts": {
      "start": "node backend/server.js",
      "test": "node --test backend/tests/*.test.js"
    },
    "dependencies": {
      "better-sqlite3": "^9.4.3",
      "dotenv": "^16.4.5",
      "express": "^4.19.2"
    }
  }
  ```
  Create `.env`:
  ```env
  PORT=3000
  DB_PATH=./klima.db
  # Set default settings for the database sync
  TESTO_API_KEY=your-api-key-here
  TESTO_API_REGION=eu
  POLL_INTERVAL_SEC=900
  RETENTION_DAYS=365
  ```
  Append these lines to `.gitignore`:
  ```
  node_modules/
  klima.db
  .env
  ```
  Run package installer:
  Run: `npm install`

- [ ] **Step 4: Run the test to verify it passes**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 5: Commit (if auto_commit enabled)**
  Check `.agent/config.yml` for `auto_commit`. Since it is `false` in this project, print: "Skipping commit (auto_commit: false)."

---

### Task 2: Database Module & Schema Setup

**Files:**
- Create: `backend/db.js`
- Test: `backend/tests/db.test.js`

- [ ] **Step 1: Write DB schema tests**
  Create `backend/tests/db.test.js` to assert SQLite schema initialization:
  ```javascript
  const test = require('node:test');
  const assert = require('node:assert');
  const fs = require('node:fs');
  const path = require('path');

  // Set DB_PATH to memory for testing
  process.env.DB_PATH = ':memory:';
  const { initDb, getDb, saveSetting, getSetting } = require('../db');

  test('SQLite schema setup and settings operations', () => {
    initDb();
    const db = getDb();
    
    // Check tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    assert.ok(tables.includes('settings'), 'settings table should exist');
    assert.ok(tables.includes('stations'), 'stations table should exist');
    assert.ok(tables.includes('measurements'), 'measurements table should exist');
    assert.ok(tables.includes('events'), 'events table should exist');

    // Save and load settings
    saveSetting('test_key', 'test_value');
    assert.strictEqual(getSetting('test_key'), 'test_value');
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test backend/tests/db.test.js`
  Expected: FAIL (Cannot find module '../db')

- [ ] **Step 3: Implement database initialization & helper methods**
  Create `backend/db.js`:
  ```javascript
  const Database = require('better-sqlite3');
  const path = require('path');
  require('dotenv').config();

  let db = null;

  function initDb() {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../klima.db');
    db = new Database(dbPath);

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

    // Seed default settings if empty
    const count = db.prepare("SELECT count(*) as count FROM settings").get().count;
    if (count === 0) {
      const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
      stmt.run('api_key', process.env.TESTO_API_KEY || '');
      stmt.run('api_region', process.env.TESTO_API_REGION || 'eu');
      stmt.run('poll_interval_sec', process.env.POLL_INTERVAL_SEC || '900');
      stmt.run('retention_days', process.env.RETENTION_DAYS || '365');
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

  module.exports = {
    initDb,
    getDb,
    getSetting,
    saveSetting
  };
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `node --test backend/tests/db.test.js`
  Expected: PASS

- [ ] **Step 5: Commit (if auto_commit enabled)**
  Check `.agent/config.yml` for `auto_commit`. Since it is `false` in this project, print: "Skipping commit (auto_commit: false)."

---

### Task 3: Testo API Client

**Files:**
- Create: `backend/testo-client.js`
- Test: `backend/tests/testo-client.test.js`

- [ ] **Step 1: Write Testo API Client tests**
  Create `backend/tests/testo-client.test.js`. We will mock the external HTTP requests using a mock server or mocking standard `fetch`.
  ```javascript
  const test = require('node:test');
  const assert = require('node:assert');

  // Mock global.fetch
  const mockResponses = {};
  global.fetch = async (url, options) => {
    const matched = Object.keys(mockResponses).find(pattern => url.includes(pattern));
    if (matched) {
      return {
        ok: true,
        json: async () => mockResponses[matched]
      };
    }
    throw new Error(`Fetch not mocked for ${url}`);
  };

  const TestoClient = require('../testo-client');

  test('Testo API Client async submit and polling', async () => {
    const apiKey = 'test-key';
    const region = 'eu';
    const client = new TestoClient(apiKey, region);

    // Mock POST measurements submission
    mockResponses['/v2/measurements'] = { status: 'Submitted', request_uuid: 'req-123' };
    
    // Mock GET polling
    mockResponses['/v2/measurements/req-123'] = {
      status: 'Completed',
      data_urls: ['https://s3.example.com/file.json']
    };

    // Mock file download
    mockResponses['s3.example.com/file.json'] = [
      { uuid: 'row-1', measurement: 21.5, timestamp: '2026-05-29T06:00:00Z' }
    ];

    const data = await client.fetchMeasurements({
      date_time_from: '2026-05-29T00:00:00Z'
    });

    assert.strictEqual(data.length, 1);
    assert.strictEqual(data[0].uuid, 'row-1');
    assert.strictEqual(data[0].measurement, 21.5);
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test backend/tests/testo-client.test.js`
  Expected: FAIL (Cannot find module '../testo-client')

- [ ] **Step 3: Implement Testo API Client with Submit-Poll-Download**
  Create `backend/testo-client.js`:
  ```javascript
  class TestoClient {
    constructor(apiKey, region = 'eu') {
      this.apiKey = apiKey;
      this.region = region;
      this.baseUrl = `https://data-api.${region}.smartconnect.testo.com`;
    }

    async _request(path, method = 'GET', body = null) {
      const url = `${this.baseUrl}${path}`;
      const headers = {
        'x-custom-api-key': this.apiKey,
        'Content-Type': 'application/json'
      };

      const options = { method, headers };
      if (body) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} on ${path}`);
      }
      return response.json();
    }

    async _poll(pollPath, maxBudgetSec = 300) {
      let delay = 2000; // start with 2s delay
      const maxDelay = 30000;
      const deadline = Date.now() + maxBudgetSec * 1000;

      while (Date.now() < deadline) {
        const result = await this._request(pollPath);
        if (result.status === 'Completed') {
          return result.data_urls;
        }
        if (result.status === 'Failed' || result.status === 'Error') {
          throw new Error(`Testo API report failed for ${pollPath}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, maxDelay);
      }
      throw new Error(`Polling timeout for ${pollPath}`);
    }

    async _downloadFiles(urls) {
      let allRecords = [];
      for (const url of urls) {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Download failed for file: ${url}`);
        }
        const data = await response.json();
        allRecords = allRecords.concat(data);
      }
      return allRecords;
    }

    async _executeAsyncFlow(postPath, getPathPrefix, requestBody) {
      const submitRes = await this._request(postPath, 'POST', requestBody);
      const uuid = submitRes.request_uuid;
      if (!uuid) {
        throw new Error(`No request_uuid returned by POST ${postPath}`);
      }
      const dataUrls = await this._poll(`${getPathPrefix}/${uuid}`);
      return this._downloadFiles(dataUrls);
    }

    async fetchDeviceStatus() {
      return this._executeAsyncFlow('/v3/devices/status', '/v3/devices/status', {
        options: { result_file_format: 'JSON' }
      });
    }

    async fetchMeasuringObjects() {
      return this._executeAsyncFlow('/v1/measuring-objects', '/v1/measuring-objects', {
        options: { result_file_format: 'JSON' }
      });
    }

    async fetchMeasurements(params) {
      return this._executeAsyncFlow('/v2/measurements', '/v2/measurements', {
        date_time_from: params.date_time_from,
        date_time_until: params.date_time_until,
        options: { result_file_format: 'JSON' },
        odata: params.odata
      });
    }

    async fetchAlarms(params) {
      return this._executeAsyncFlow('/v3/alarms', '/v3/alarms', {
        date_time_from: params.date_time_from,
        date_time_until: params.date_time_until,
        options: { result_file_format: 'JSON' },
        odata: params.odata
      });
    }
  }

  module.exports = TestoClient;
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `node --test backend/tests/testo-client.test.js`
  Expected: PASS

- [ ] **Step 5: Commit (if auto_commit enabled)**
  Check `.agent/config.yml` for `auto_commit`. Since it is `false` in this project, print: "Skipping commit (auto_commit: false)."

---

### Task 4: Background Sync Scheduler

**Files:**
- Create: `backend/scheduler.js`
- Test: `backend/tests/scheduler.test.js`

- [ ] **Step 1: Write Sync Scheduler tests**
  Create `backend/tests/scheduler.test.js` to verify synchronization inserts logic:
  ```javascript
  const test = require('node:test');
  const assert = require('node:assert');

  process.env.DB_PATH = ':memory:';
  const { initDb, getDb, saveSetting } = require('../db');

  // Mock TestoClient
  class MockTestoClient {
    async fetchDeviceStatus() {
      return [{
        device_uuid: 'dev-1', serial_no: 'SN123', battery_level_percent: 85,
        radio_level_percent: 90, connection_type: 'WIFI', is_powersupply_on: true
      }];
    }
    async fetchMeasurements() {
      return [{
        uuid: 'meas-123', timestamp: '2026-05-29T06:00:00Z', measurement: 22.4,
        physical_property_name: 'Temperature', physical_unit: 'CELSIUS'
      }];
    }
    async fetchAlarms() { return []; }
  }

  const schedulerModule = require('../scheduler');

  test('Sync logic populates sqlite database', async () => {
    initDb();
    saveSetting('api_key', 'mock-key');
    saveSetting('api_region', 'eu');

    const db = getDb();
    // Setup a mock station mapping in DB
    db.prepare(`
      INSERT INTO stations (id, name, location, mo_uuid, device_uuid)
      VALUES (?, ?, ?, ?, ?)
    `).run('living', 'Wohnzimmer', '1. OG', 'mo-123', 'dev-1');

    const client = new MockTestoClient();
    await schedulerModule.runSyncCycle(client);

    // Verify station status updated
    const station = db.prepare("SELECT battery, signal, connection_type FROM stations WHERE id = ?").get('living');
    assert.strictEqual(station.battery, 85);
    assert.strictEqual(station.signal, 90);
    assert.strictEqual(station.connection_type, 'WIFI');

    // Verify measurements table has record
    const meas = db.prepare("SELECT value, physical_property FROM measurements WHERE uuid = ?").get('meas-123');
    assert.ok(meas);
    assert.strictEqual(meas.value, 22.4);
    assert.strictEqual(meas.physical_property, 'temperature');
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test backend/tests/scheduler.test.js`
  Expected: FAIL (Cannot find module '../scheduler')

- [ ] **Step 3: Implement Synchronization & Scheduler logic**
  Create `backend/scheduler.js`:
  ```javascript
  const { getDb, getSetting } = require('./db');
  const TestoClient = require('./testo-client');

  async function runSyncCycle(customClient = null) {
    const apiKey = getSetting('api_key');
    const region = getSetting('api_region') || 'eu';

    if (!apiKey) {
      console.log('Skipping sync: No API Key configured.');
      return;
    }

    const client = customClient || new TestoClient(apiKey, region);
    const db = getDb();

    // 1. Fetch & Sync Device Statuses
    try {
      const statuses = await client.fetchDeviceStatus();
      const updateStmt = db.prepare(`
        UPDATE stations
        SET battery = ?, signal = ?, connection_type = ?, is_powersupply_on = ?,
            fw_version = ?, model_code = ?, last_communication = ?,
            last_measurement_time = ?, next_communication = ?
        WHERE device_uuid = ? OR id = (SELECT id FROM stations WHERE device_uuid = ?)
      `);
      
      db.transaction(() => {
        for (const s of statuses) {
          const lastComm = s.last_communication ? new Date(s.last_communication).getTime() : null;
          const lastMeas = s.last_measurement_time ? new Date(s.last_measurement_time).getTime() : null;
          const nextComm = s.next_communication ? new Date(s.next_communication).getTime() : null;
          updateStmt.run(
            s.battery_level_percent,
            s.radio_level_percent,
            s.connection_type,
            s.is_powersupply_on ? 1 : 0,
            s.fw_version,
            s.model_code,
            lastComm,
            lastMeas,
            nextComm,
            s.device_uuid,
            s.device_uuid
          );
        }
      })();
    } catch (e) {
      console.error('Error syncing device status:', e.message);
    }

    // 2. Fetch & Sync Measurements
    try {
      const stations = db.prepare("SELECT id, mo_uuid, device_uuid FROM stations WHERE mo_uuid IS NOT NULL").all();
      for (const station of stations) {
        // Find latest timestamp
        const latest = db.prepare("SELECT max(timestamp) as max_ts FROM measurements WHERE station_id = ?").get(station.id);
        let fromDate = new Date(Date.now() - 24 * 3600 * 1000); // default last 24h
        if (latest && latest.max_ts) {
          fromDate = new Date(latest.max_ts + 1000); // 1s after last measurement
        }

        const measurements = await client.fetchMeasurements({
          date_time_from: fromDate.toISOString(),
          odata: {
            $filter: `sensor_uuid eq '${station.device_uuid}'` // Adjust depending on mappings
          }
        });

        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO measurements (
            uuid, station_id, timestamp, timestamp_local, value,
            physical_property, unit, channel_no, sensor_uuid, serial_no,
            model_code, processed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        db.transaction(() => {
          for (const m of measurements) {
            // Map PV_TEMPERATURE, PV_HUMIDITY etc. to lowercase shorthand
            let prop = (m.physical_property_name || '').toLowerCase();
            if (prop.includes('temp')) prop = 'temperature';
            else if (prop.includes('humid') || prop.includes('feucht')) prop = 'humidity';
            else if (prop.includes('press') || prop.includes('druck')) prop = 'pressure';

            insertStmt.run(
              m.uuid,
              station.id,
              new Date(m.timestamp).getTime(),
              m.timestamp_local,
              m.measurement,
              prop,
              m.physical_unit,
              m.channel_no,
              m.sensor_uuid,
              m.serial_no,
              m.model_code,
              m.processed_at
            );
          }
        })();
      }
    } catch (e) {
      console.error('Error syncing measurements:', e.message);
    }

    // 3. Fetch & Sync Alarms
    try {
      const lastSync = getSetting('last_alarm_sync_time') 
        ? new Date(parseInt(getSetting('last_alarm_sync_time'))) 
        : new Date(Date.now() - 7 * 24 * 3600 * 1000);

      const alarms = await client.fetchAlarms({
        date_time_from: lastSync.toISOString()
      });

      const alarmStmt = db.prepare(`
        INSERT OR REPLACE INTO events (
          uuid, station_id, severity, alarm_status, alarm_reason,
          alarm_condition_type, alarm_value, metric, threshold, start_ts,
          end_ts, extreme, active, message, detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      db.transaction(() => {
        for (const a of alarms) {
          // Find matching station via serial number
          const station = db.prepare("SELECT id FROM stations WHERE device_uuid = ?").get(a.serial_no);
          const stationId = station ? station.id : null;

          let prop = (a.physical_value || '').toLowerCase();
          if (prop.includes('temp')) prop = 'temperature';
          else if (prop.includes('humid')) prop = 'humidity';

          alarmStmt.run(
            a.uuid,
            stationId,
            (a.alarm_severity || 'Warning').toLowerCase() === 'alarm' ? 'alarm' : 'warning',
            a.alarm_status,
            a.alarm_reason,
            a.alarm_condition_type,
            a.alarm_value,
            prop,
            null, // threshold (fetch from limits if needed)
            new Date(a.alarm_time).getTime(),
            a.last_status_change_time ? new Date(a.last_status_change_time).getTime() : null,
            a.alarm_value,
            a.alarm_status === 'Active' ? 1 : 0,
            a.alarm_reason || 'Grenzwert verletzt',
            `Sensor ${a.serial_no} hat einen Wert von ${a.alarm_value} gemeldet.`
          );
        }
      })();

      saveSetting('last_alarm_sync_time', Date.now());
    } catch (e) {
      console.error('Error syncing alarms:', e.message);
    }

    // 4. Data retention cleanup
    try {
      const days = parseInt(getSetting('retention_days') || '365');
      const limit = Date.now() - days * 24 * 3600 * 1000;
      db.prepare("DELETE FROM measurements WHERE timestamp < ?").run(limit);
    } catch (e) {
      console.error('Error executing database retention cleanup:', e.message);
    }
  }

  let timer = null;
  function startScheduler() {
    if (timer) clearInterval(timer);
    
    const intervalSec = parseInt(getSetting('poll_interval_sec') || '900');
    console.log(`Scheduler started. Syncing every ${intervalSec} seconds.`);
    
    // Initial run
    runSyncCycle().catch(console.error);

    timer = setInterval(() => {
      runSyncCycle().catch(console.error);
    }, intervalSec * 1000);
  }

  module.exports = {
    runSyncCycle,
    startScheduler
  };
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `node --test backend/tests/scheduler.test.js`
  Expected: PASS

- [ ] **Step 5: Commit (if auto_commit enabled)**
  Check `.agent/config.yml` for `auto_commit`. Since it is `false` in this project, print: "Skipping commit (auto_commit: false)."

---

### Task 5: Express API Server

**Files:**
- Create: `backend/server.js`
- Test: `backend/tests/server.test.js`

- [ ] **Step 1: Write Express API route tests**
  Create `backend/tests/server.test.js` to ensure REST endpoints return JSON structure:
  ```javascript
  const test = require('node:test');
  const assert = require('node:assert');

  process.env.DB_PATH = ':memory:';
  process.env.PORT = '3001';
  const { initDb } = require('../db');
  initDb();

  const server = require('../server');

  test('REST API Endpoint checks', async () => {
    // Test GET /api/settings
    const resSettings = await fetch('http://localhost:3001/api/settings');
    assert.strictEqual(resSettings.status, 200);
    const settings = await resSettings.json();
    assert.ok(settings.hasOwnProperty('poll_interval_sec'));

    // Shutdown test server
    server.close();
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test backend/tests/server.test.js`
  Expected: FAIL (Cannot find module '../server')

- [ ] **Step 3: Implement Express Server & API routing**
  Create `backend/server.js`:
  ```javascript
  const express = require('express');
  const path = require('path');
  const { initDb, getDb, getSetting, saveSetting } = require('./db');
  const { startScheduler, runSyncCycle } = require('./scheduler');
  const TestoClient = require('./testo-client');
  require('dotenv').config();

  initDb();
  startScheduler();

  const app = express();
  app.use(express.json());

  // Serve static frontend files
  app.use(express.static(path.join(__dirname, '../Smart Meter Dashboard')));

  // GET /api/settings
  app.get('/api/settings', (req, res) => {
    res.json({
      api_key: getSetting('api_key') || '',
      api_region: getSetting('api_region') || 'eu',
      poll_interval_sec: parseInt(getSetting('poll_interval_sec') || '900'),
      retention_days: parseInt(getSetting('retention_days') || '365')
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
    getDb().prepare(`
      INSERT OR REPLACE INTO stations (id, name, location, mo_uuid, device_uuid)
      VALUES (?, ?, ?, ?, ?)
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
  app.get('/api/stations/:id/metrics', (req, res) => {
    const db = getDb();
    const stationId = req.params.id;
    const since = Date.now() - 24 * 3600 * 1000; // last 24h

    // Retrieve all metrics series for this station
    const rows = db.prepare(`
      SELECT timestamp, value, physical_property, unit
      FROM measurements
      WHERE station_id = ? AND timestamp > ?
      ORDER BY timestamp ASC
    `).all(stationId, since);

    // Group by physical property (temperature, humidity, pressure)
    const metrics = {};
    for (const r of rows) {
      if (!metrics[r.physical_property]) {
        metrics[r.physical_property] = {
          series: [],
          unit: r.unit
        };
      }
      metrics[r.physical_property].series.push(r.value);
    }

    res.json({
      timestamps: rows.filter(r => r.physical_property === 'temperature').map(r => r.timestamp),
      metrics
    });
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

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`Klima Dashboard server running on http://localhost:${PORT}`);
  });

  module.exports = server;
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm test`
  Expected: ALL PASS

- [ ] **Step 5: Commit (if auto_commit enabled)**
  Check `.agent/config.yml` for `auto_commit`. Since it is `false` in this project, print: "Skipping commit (auto_commit: false)."

---

### Task 6: Frontend REST API Integration & Zuweisungsmanager

**Files:**
- Modify: `Smart Meter Dashboard/data.js`
- Modify: `Smart Meter Dashboard/settings.jsx`
- Modify: `Smart Meter Dashboard/app.jsx`
- Modify: `Smart Meter Dashboard/Klima Dashboard.html`

- [ ] **Step 1: Rewrite data.js to query backend API**
  Replace the contents of `Smart Meter Dashboard/data.js` to fetch dashboard values from local API:
  ```javascript
  (function () {
    const listeners = new Set();
    function emit() { for (const fn of listeners) try { fn(); } catch (e) {} }

    let stations = {};
    let stationOrder = [];
    let activeStationId = '';
    let totals = { alarm: 0, warning: 0, system: 0 };

    async function loadData() {
      try {
        const res = await fetch('/api/stations');
        const stList = await res.json();
        
        stations = {};
        stationOrder = [];
        
        for (const s of stList) {
          stations[s.id] = {
            id: s.id,
            name: s.name,
            location: s.location,
            online: !!s.online,
            battery: s.battery,
            signal: s.signal,
            metrics: {},
            events: []
          };
          stationOrder.push(s.id);
        }

        if (!activeStationId && stationOrder.length) {
          activeStationId = stationOrder[0];
        }

        // Fetch metrics and events for active station
        if (activeStationId) {
          const resMetrics = await fetch(`/api/stations/${activeStationId}/metrics`);
          const metricsData = await resMetrics.json();
          window.DASH_DATA.timestamps = metricsData.timestamps || [];
          
          if (stations[activeStationId]) {
            // Map loaded properties
            for (const prop of Object.keys(metricsData.metrics)) {
              stations[activeStationId].metrics[prop] = {
                label: prop === 'temperature' ? 'Temperatur' : prop === 'humidity' ? 'Rel. Luftfeuchte' : 'Luftdruck',
                short: prop === 'temperature' ? 'Temp.' : prop === 'humidity' ? 'Feuchte' : 'Druck',
                unit: metricsData.metrics[prop].unit === 'CELSIUS' ? '°C' : '%',
                decimals: prop === 'temperature' ? 1 : 0,
                color: prop === 'temperature' ? 'oklch(0.70 0.13 55)' : 'oklch(0.62 0.12 230)',
                series: metricsData.metrics[prop].series
              };
            }

            const resEvents = await fetch(`/api/stations/${activeStationId}/events`);
            stations[activeStationId].events = await resEvents.json();
          }
        }

        // Fetch totals
        const resTotals = await fetch('/api/totals');
        totals = await resTotals.json();

        emit();
      } catch (e) {
        console.error('Error fetching REST data in frontend:', e);
      }
    }

    // Poll server for new measurements every 30s
    setInterval(loadData, 30000);
    loadData();

    window.DASH_DATA = {
      timestamps: [],
      get stations() { return stations; },
      get stationOrder() { return stationOrder; },
      get activeStationId() { return activeStationId; },
      get activeStation() { return stations[activeStationId]; },
      setActiveStation(id) {
        activeStationId = id;
        loadData();
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      get metrics() { return stations[activeStationId]?.metrics || {}; },
      get events() { return stations[activeStationId]?.events || []; },
      totalActive() { return totals; },
      reload: loadData,
      stats(series) {
        if (!series || !series.length) return { min: 0, max: 0, avg: 0, last: 0, first: 0 };
        let min = Infinity, max = -Infinity, sum = 0;
        for (const v of series) {
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        return { min, max, avg: sum / series.length, last: series[series.length - 1], first: series[0] };
      },
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
        return `vor ${h} h`;
      },
      formatDuration(ms) {
        const m = Math.round(ms / 60000);
        if (m < 1) return "< 1 min";
        return `${m} min`;
      }
    };
  })();
  ```

- [ ] **Step 2: Add Zuweisungs-Manager UI to settings.jsx**
  Modify `Smart Meter Dashboard/settings.jsx` to fetch active settings from `/api/settings` and render the dropdowns for measuring objects:
  ```javascript
  // In settings.jsx: Load available measuring objects from backend and render the Zuweisungs-Manager tab.
  // Add state to settings.jsx to hold testo measuring objects list:
  const [measuringObjects, setMeasuringObjects] = sState([]);
  sEff(() => {
    fetch('/api/testo/measuring-objects')
      .then(res => res.json())
      .then(data => setMeasuringObjects(data || []))
      .catch(console.error);
  }, [settings.api.apiKey]);

  // Extend StationsSection component to map local tiles:
  function StationsSection({ settings, update }) {
    const D = window.DASH_DATA;
    const [newName, setNewName] = sState('');
    const [newLoc, setNewLoc] = sState('');
    const [selectedMo, setSelectedMo] = sState('');

    async function addStation() {
      if (!newName.trim() || !selectedMo) return;
      const match = measuringObjects.find(o => o.measuring_object_uuid === selectedMo);
      // Retrieve assigned device UUID from channel_assignments string
      let deviceUuid = '';
      try {
        const channels = JSON.parse(match.channel_assignments);
        deviceUuid = channels[0]?.device_uuid || '';
      } catch(e){}

      await fetch('/api/stations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'station_' + Math.random().toString(36).substring(2, 7),
          name: newName,
          location: newLoc,
          mo_uuid: selectedMo,
          device_uuid: deviceUuid
        })
      });
      setNewName('');
      setNewLoc('');
      setSelectedMo('');
      D.reload();
    }

    return (
      <>
        <SectionHead title="Zuweisungs-Manager" sub="Kacheln mit den physikalischen testo-Sensoren verknüpfen." />
        <Card>
          <div className="card-title">Neue Kachel zuweisen</div>
          <div className="field-row">
            <Field label="Raumname">
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="z.B. Wohnzimmer" />
            </Field>
            <Field label="Beschreibung">
              <input value={newLoc} onChange={e => setNewLoc(e.target.value)} placeholder="z.B. 1. OG" />
            </Field>
            <Field label="testo Messstelle">
              <select value={selectedMo} onChange={e => setSelectedMo(e.target.value)} style={{ padding: '8px', borderRadius: '4px' }}>
                <option value="">-- Messstelle wählen --</option>
                {measuringObjects.map(mo => (
                  <option key={mo.measuring_object_uuid} value={mo.measuring_object_uuid}>
                    {mo.customer_site} - Object ({mo.measuring_object_uuid.substring(0,6)})
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button className="btn primary" onClick={addStation} disabled={!newName || !selectedMo}>Zuweisen</button>
        </Card>
      </>
    );
  }
  ```

- [ ] **Step 3: Run the web server and test dashboard loading**
  Launch the backend server:
  Run: `node backend/server.js`
  Navigate to `http://localhost:3000` to verify that the dashboard renders correctly and sync triggers.
