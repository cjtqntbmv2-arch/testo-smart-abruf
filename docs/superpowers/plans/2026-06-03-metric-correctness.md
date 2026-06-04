# Metric Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard faithfully reflect what the testo devices actually report — deliver the *measured* dewpoint/abs-humidity channels that are already stored but silently dropped (#1), and give the `system` severity a real data source so the always-zero counter and its dead UI branch become live (#3).

**Architecture:** Two independent correctness fixes in the same data-path domain. (#1) The read endpoint `/api/stations/:id/metrics` is generalized to forward-fill **all five** metric properties (it currently hard-codes only temperature/humidity/pressure); the frontend `data.js` then prefers a measured dewpoint/abs-humidity value per timestamp and falls back to its local formula where the device has no such channel. (#3) Two new pure helpers in `device-bridge.js` derive online-state and the set of active system conditions from a device-status snapshot; the scheduler writes `stations.online` and upserts/auto-closes `system`-severity rows in the existing `events` table, which `/api/totals` already counts.

**Tech Stack:** Node.js, Express 4, better-sqlite3, `node:test` (built-in runner), React 18 via in-browser Babel (no frontend test harness).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/server.js` | REST endpoints | Rewrite the `/api/stations/:id/metrics` handler to be data-driven over a `METRIC_PROPS` list covering all 5 metrics. |
| `backend/tests/server.test.js` | Endpoint contract tests | Add: metrics endpoint returns measured dewpoint/abshumid; `/api/totals` counts active system events. |
| `backend/device-bridge.js` | Pure, I/O-free testo↔dashboard helpers | Add `deriveOnline` and `deriveSystemConditions`; export them. |
| `backend/tests/device-bridge.test.js` | Pure-helper unit tests | Add tests for both new helpers. |
| `backend/scheduler.js` | Sync cycle | In the device-status step: derive & persist `online`, and upsert/close `system` events per station. |
| `backend/tests/scheduler.test.js` | Sync integration tests | Add: status sync derives online and opens/closes a battery system event. |
| `Smart Meter Dashboard/data.js` | Frontend data layer (browser IIFE) | Consume measured dewpoint/abshumid; prefer them over the locally computed formula per timestamp. |
| `Smart Meter Dashboard/Klima Dashboard.html` | Asset includes | Bump the `?v=` cache-buster on all five script tags. |
| `Smart Meter Dashboard/settings.jsx` | Settings UI "Über" box | Correct the hard-coded version string to match the manifest (resolves the version-inconsistency this release introduces). |
| `package.json`, `VERSION`, `README.md` | Version source-of-truth + badge | Bump 0.1.4 → 0.1.5 (patch: bugfix). |

**Note on the frontend:** `data.js` is a browser IIFE assigned to `window.DASH_DATA`; there is no JS test runner for the dashboard. Task 2's behavior is guaranteed at the API boundary by Task 1's automated test, and verified end-to-end manually in the browser. Do not invent a frontend test framework for this plan (YAGNI).

---

### Task 1: Metrics endpoint delivers all five measured series (#1)

**Files:**
- Modify: `backend/server.js:82-157` (replace the entire `GET /api/stations/:id/metrics` handler)
- Test: `backend/tests/server.test.js`

- [ ] **Step 1: Write the failing test**

Append this test to `backend/tests/server.test.js`, immediately before the final `after(() => {` block (around line 77):

```javascript
test('GET /api/stations/:id/metrics returns measured dewpoint and abshumid series', async () => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id, name) VALUES ('mtest', 'Metric Test')").run();
  const ts = Date.now() - 3600 * 1000; // within the 24h window
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('mm-t','mtest',?,21.0,'temperature','°C')").run(ts);
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('mm-d','mtest',?,9.5,'dewpoint','°C')").run(ts);
  db.prepare("INSERT INTO measurements (uuid, station_id, timestamp, value, physical_property, unit) VALUES ('mm-a','mtest',?,8.2,'abshumid','g/m³')").run(ts);

  const res = await fetch('http://localhost:3001/api/stations/mtest/metrics');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.metrics.dewpoint, 'response must include a dewpoint series');
  assert.ok(body.metrics.abshumid, 'response must include an abshumid series');
  assert.deepStrictEqual(body.metrics.dewpoint.series, [9.5]);
  assert.deepStrictEqual(body.metrics.abshumid.series, [8.2]);
  assert.deepStrictEqual(body.metrics.temperature.series, [21.0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "measured dewpoint"`
Expected: FAIL — `body.metrics.dewpoint` is `undefined` (the current handler only emits temperature/humidity/pressure), so the `assert.ok(body.metrics.dewpoint, ...)` assertion throws.

- [ ] **Step 3: Replace the handler with the data-driven version**

In `backend/server.js`, replace the whole block from the `// GET /api/stations/:id/metrics` comment (line 82) through the closing `});` of that handler (line 157) with:

```javascript
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
    metrics[key] = { series: [], unit: units[key] || unit };
  }
  const last = {};
  for (const ts of sortedTimestamps) {
    const slot = timeMap.get(ts);
    for (const { key } of METRIC_PROPS) {
      if (slot[key] !== undefined) last[key] = slot[key];
      metrics[key].series.push(last[key] ?? null);
    }
  }

  res.json({ timestamps: sortedTimestamps, metrics });
});
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `npm test 2>&1 | tail -8`
Expected: PASS — `ℹ pass 24`, `ℹ fail 0` (the new test plus the 23 existing ones).

- [ ] **Step 5: Commit**

```bash
git add backend/server.js backend/tests/server.test.js
git commit -m "$(cat <<'EOF'
fix(api): deliver measured dewpoint & abshumid from /metrics

The endpoint hard-coded only temperature/humidity/pressure, so the
device's measured dewpoint/abs-humidity channels (stored since v0.1.4)
were silently dropped at the API boundary. Generalize the handler over
a METRIC_PROPS list so all five forward-filled series are returned.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Frontend prefers the measured dewpoint/abshumid (#1)

**Files:**
- Modify: `Smart Meter Dashboard/data.js:174-178` (initial `stationMetrics`)
- Modify: `Smart Meter Dashboard/data.js:185-189` (pick measured series from the response)
- Modify: `Smart Meter Dashboard/data.js:240-255` (merge measured over computed, then build `allSeries`)
- Verify: browser (no JS test runner for the dashboard)

- [ ] **Step 1: Add dewpoint/abshumid to the initial `stationMetrics`**

In `Smart Meter Dashboard/data.js`, replace the `let stationMetrics = { ... }` initializer (lines 174-178) with:

```javascript
        let stationMetrics = {
          temperature: { series: [], unit: '°C' },
          humidity: { series: [], unit: '%' },
          pressure: { series: [], unit: 'hPa' },
          dewpoint: { series: [], unit: '°C' },
          abshumid: { series: [], unit: 'g/m³' }
        };
```

- [ ] **Step 2: Pick the measured dewpoint/abshumid out of the response**

Replace the `if (data.metrics) { ... }` block (lines 185-189) with:

```javascript
            if (data.metrics) {
              if (data.metrics.temperature) stationMetrics.temperature = data.metrics.temperature;
              if (data.metrics.humidity) stationMetrics.humidity = data.metrics.humidity;
              if (data.metrics.pressure) stationMetrics.pressure = data.metrics.pressure;
              if (data.metrics.dewpoint) stationMetrics.dewpoint = data.metrics.dewpoint;
              if (data.metrics.abshumid) stationMetrics.abshumid = data.metrics.abshumid;
            }
```

- [ ] **Step 3: Merge measured over computed, then build `allSeries`**

Replace the block that computes `seriesD`/`seriesA` and builds `allSeries` (lines 240-255) with:

```javascript
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
```

- [ ] **Step 4: Verify in the browser with a seeded measured-dewpoint row**

Seed a station with measured + computed-divergent dewpoint, then start the server:

```bash
node -e "const D=require('better-sqlite3'); const db=new D('./klima.db'); db.pragma('foreign_keys=ON'); db.prepare(\"INSERT OR IGNORE INTO stations (id,name,online) VALUES ('vtest','Verify Test',1)\").run(); const ts=Date.now()-1800000; db.prepare(\"INSERT OR REPLACE INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES ('v-t','vtest',?,21.0,'temperature','°C')\").run(ts); db.prepare(\"INSERT OR REPLACE INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES ('v-h','vtest',?,45.0,'humidity','%')\").run(ts); db.prepare(\"INSERT OR REPLACE INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES ('v-d','vtest',?,2.0,'dewpoint','°C')\").run(ts); db.close(); console.log('seeded vtest: measured dewpoint=2.0; computed dewpoint(21,45)≈8.9');"
npm start
```

Open http://localhost:3000, select the **Verify Test** station, and confirm the Taupunkt value reads **≈ 2.0 °C** (the measured channel) — **not** ≈ 8.9 °C (the formula from T=21, RH=45). Stop the server with Ctrl-C. Remove the verification rows:

```bash
node -e "const D=require('better-sqlite3'); const db=new D('./klima.db'); db.prepare(\"DELETE FROM stations WHERE id='vtest'\").run(); db.close();"
```

Expected: Taupunkt shows the measured value; a station with no dewpoint channel still shows the computed value (unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/data.js"
git commit -m "$(cat <<'EOF'
fix(dashboard): use measured dewpoint/abshumid when available

The frontend ignored the backend's dewpoint/abshumid series and always
recomputed them from T+RH. Prefer the device's measured value per
timestamp, falling back to the formula only where no channel exists.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `deriveOnline` pure helper (#3)

**Files:**
- Modify: `backend/device-bridge.js` (add function + export)
- Test: `backend/tests/device-bridge.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/tests/device-bridge.test.js`, change the import line (line 3) to add the new helper:

```javascript
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline } = require('../device-bridge');
```

Then append this test at the end of the file:

```javascript
test('deriveOnline flags a device offline only when its known comm timestamp is stale', () => {
  const now = 1_000_000_000_000;
  const grace = 3600000; // 1h, the default
  // next_communication still in the future -> online
  assert.strictEqual(deriveOnline(null, now + 900000, now), 1);
  // next_communication overdue beyond grace -> offline
  assert.strictEqual(deriveOnline(null, now - grace - 1, now), 0);
  // no next_communication: fall back to last_communication freshness
  assert.strictEqual(deriveOnline(now - 1000, null, now), 1);
  assert.strictEqual(deriveOnline(now - grace - 1, null, now), 0);
  // no comm data at all -> assume online, do not fabricate an offline state
  assert.strictEqual(deriveOnline(null, null, now), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/device-bridge.test.js 2>&1 | grep -A3 deriveOnline`
Expected: FAIL — `deriveOnline is not a function` (import is `undefined`).

- [ ] **Step 3: Implement `deriveOnline` and export it**

In `backend/device-bridge.js`, add this function after `mapPhysicalProperty` (after line 25):

```javascript
// Derive a device's online state (1/0) from its communication timestamps (ms epoch).
// Prefer the device's promised next_communication; if it is overdue past the grace
// window the device is offline. With no comm data at all we assume online rather than
// fabricating an offline state for a device that simply has not reported yet.
function deriveOnline(lastCommTs, nextCommTs, now, graceMs = 3600000) {
  if (nextCommTs != null) return now <= nextCommTs + graceMs ? 1 : 0;
  if (lastCommTs != null) return now - lastCommTs <= graceMs ? 1 : 0;
  return 1;
}
```

Then update the export line at the bottom (line 61) to:

```javascript
module.exports = { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/device-bridge.test.js 2>&1 | tail -5`
Expected: PASS — all device-bridge tests green, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend/device-bridge.js backend/tests/device-bridge.test.js
git commit -m "$(cat <<'EOF'
feat(device-bridge): add deriveOnline helper

Pure helper to compute online/offline from a device's communication
timestamps, used next to populate stations.online during sync.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `deriveSystemConditions` pure helper (#3)

**Files:**
- Modify: `backend/device-bridge.js` (add function + export)
- Test: `backend/tests/device-bridge.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/tests/device-bridge.test.js`, extend the import line (line 3) to also pull in the new helper:

```javascript
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions } = require('../device-bridge');
```

Append this test at the end of the file:

```javascript
test('deriveSystemConditions reports connection and battery system events from a status snapshot', () => {
  // healthy device -> no system conditions
  assert.deepStrictEqual(deriveSystemConditions({ online: 1, battery: 80 }), []);
  // offline -> a single connection condition
  const offline = deriveSystemConditions({ online: 0, battery: 80 });
  assert.strictEqual(offline.length, 1);
  assert.strictEqual(offline[0].type, 'connection');
  // low battery -> a single battery condition whose detail mentions the level
  const low = deriveSystemConditions({ online: 1, battery: 12 });
  assert.strictEqual(low.length, 1);
  assert.strictEqual(low[0].type, 'battery');
  assert.match(low[0].detail, /12/);
  // both at once -> two conditions
  assert.strictEqual(deriveSystemConditions({ online: 0, battery: 5 }).length, 2);
  // unknown battery (null) must NOT trigger a battery condition
  assert.deepStrictEqual(deriveSystemConditions({ online: 1, battery: null }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/device-bridge.test.js 2>&1 | grep -A3 deriveSystemConditions`
Expected: FAIL — `deriveSystemConditions is not a function`.

- [ ] **Step 3: Implement `deriveSystemConditions` and export it**

In `backend/device-bridge.js`, add this function directly after `deriveOnline`:

```javascript
// Given a device-status snapshot ({ online: 1|0, battery: number|null }), return the
// list of system conditions currently TRUE. Each entry { type, message, detail } maps
// straight onto the dashboard's system-event rendering (type -> the system icon;
// message/detail -> the headline/sub text). type values: 'connection', 'battery'.
function deriveSystemConditions(snapshot, opts = {}) {
  const batteryLowPct = opts.batteryLowPct ?? 20;
  const out = [];
  if (snapshot.online === 0) {
    out.push({
      type: 'connection',
      message: 'Verbindung verloren',
      detail: 'Gerät hat sich nicht im erwarteten Intervall gemeldet.',
    });
  }
  if (snapshot.battery != null && snapshot.battery <= batteryLowPct) {
    out.push({
      type: 'battery',
      message: 'Batterie schwach',
      detail: `Batteriestand bei ${snapshot.battery} %.`,
    });
  }
  return out;
}
```

Then update the export line at the bottom of the file to:

```javascript
module.exports = { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/device-bridge.test.js 2>&1 | tail -5`
Expected: PASS — `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend/device-bridge.js backend/tests/device-bridge.test.js
git commit -m "$(cat <<'EOF'
feat(device-bridge): add deriveSystemConditions helper

Pure helper that turns a device-status snapshot into the set of active
system conditions (connection lost, battery low) the dashboard already
knows how to render.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Scheduler persists online state and system events (#3)

**Files:**
- Modify: `backend/scheduler.js:3` (import the new helpers)
- Modify: `backend/scheduler.js:62-83` (status statement + loop)
- Modify: `backend/scheduler.js` (add `applySystemEvents` helper)
- Test: `backend/tests/scheduler.test.js`

- [ ] **Step 1: Write the failing test**

Append this test to the end of `backend/tests/scheduler.test.js`:

```javascript
test('Device status sync derives online state and opens/closes system events', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`).run('living', 'Wohnzimmer', 'dev-1');

  const lowBatteryClient = {
    async fetchDeviceProperties() { return []; },
    async fetchDeviceStatus() {
      return [{
        device_uuid: 'dev-1', serial_no: 'SN1', battery_level_percent: 8, radio_level_percent: 50,
        last_communication: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        next_communication: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      }];
    },
    async fetchMeasurements() { return []; },
    async fetchAlarms() { return []; }
  };

  await schedulerModule.runSyncCycle(lowBatteryClient);

  const station = db.prepare("SELECT online FROM stations WHERE id = 'living'").get();
  assert.strictEqual(station.online, 1, 'a fresh next_communication keeps the device online');

  const batteryEvent = db.prepare("SELECT severity, alarm_condition_type, active FROM events WHERE uuid = 'sys-battery-living'").get();
  assert.ok(batteryEvent, 'a low battery must open a system event');
  assert.strictEqual(batteryEvent.severity, 'system');
  assert.strictEqual(batteryEvent.alarm_condition_type, 'battery');
  assert.strictEqual(batteryEvent.active, 1);
  // no connection event while the device is online
  assert.strictEqual(db.prepare("SELECT 1 FROM events WHERE uuid = 'sys-connection-living'").get(), undefined);

  // Battery recovers -> the open system event auto-closes.
  const recoveredClient = {
    async fetchDeviceProperties() { return []; },
    async fetchDeviceStatus() {
      return [{
        device_uuid: 'dev-1', serial_no: 'SN1', battery_level_percent: 90, radio_level_percent: 50,
        last_communication: new Date().toISOString(),
        next_communication: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      }];
    },
    async fetchMeasurements() { return []; },
    async fetchAlarms() { return []; }
  };
  await schedulerModule.runSyncCycle(recoveredClient);

  const closed = db.prepare("SELECT active, end_ts FROM events WHERE uuid = 'sys-battery-living'").get();
  assert.strictEqual(closed.active, 0, 'a recovered battery closes the system event');
  assert.ok(closed.end_ts, 'a closed system event carries an end timestamp');
  closeDb();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/scheduler.test.js 2>&1 | grep -A3 "derives online"`
Expected: FAIL — `sys-battery-living` row is `undefined` (the scheduler does not write system events yet); `assert.ok(batteryEvent, ...)` throws.

- [ ] **Step 3: Import the helpers**

In `backend/scheduler.js`, change the device-bridge import (line 3) to:

```javascript
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions } = require('./device-bridge');
```

- [ ] **Step 4: Add the `applySystemEvents` helper**

In `backend/scheduler.js`, add this near the top of the file, immediately after the `parseTimestamp` definition (after line 15):

```javascript
const SYSTEM_EVENT_TYPES = ['connection', 'battery'];

// Reconcile a station's open system events against its current status snapshot.
// One stable synthetic row per (station, type) — opened on first detection (start_ts
// preserved across repeats), reopened if it had cleared, and closed (active=0,end_ts)
// when the condition no longer holds. /api/totals counts the active ones.
function applySystemEvents(db, stationId, snapshot, now) {
  const active = new Map(); // type -> { message, detail }
  for (const c of deriveSystemConditions(snapshot)) active.set(c.type, c);

  for (const type of SYSTEM_EVENT_TYPES) {
    const uuid = `sys-${type}-${stationId}`;
    const existing = db.prepare("SELECT active FROM events WHERE uuid = ?").get(uuid);

    if (active.has(type)) {
      const { message, detail } = active.get(type);
      if (!existing) {
        db.prepare(`
          INSERT INTO events (uuid, station_id, severity, alarm_condition_type, alarm_reason,
                              start_ts, end_ts, active, message, detail)
          VALUES (?, ?, 'system', ?, ?, ?, NULL, 1, ?, ?)
        `).run(uuid, stationId, type, message, now, message, detail);
      } else if (existing.active === 0) {
        db.prepare("UPDATE events SET active = 1, start_ts = ?, end_ts = NULL, message = ?, detail = ? WHERE uuid = ?")
          .run(now, message, detail, uuid);
      } else {
        // still active — refresh the detail (e.g. battery % changed)
        db.prepare("UPDATE events SET message = ?, detail = ? WHERE uuid = ?")
          .run(message, detail, uuid);
      }
    } else if (existing && existing.active === 1) {
      db.prepare("UPDATE events SET active = 0, end_ts = ? WHERE uuid = ?").run(now, uuid);
    }
  }
}
```

- [ ] **Step 5: Persist `online` and call `applySystemEvents` in the status step**

In `backend/scheduler.js`, replace the `updateStatusStmt` prepared statement (lines 62-68) — add `online = ?`:

```javascript
    const updateStatusStmt = db.prepare(`
      UPDATE stations
      SET battery = ?, signal = ?, connection_type = ?, is_powersupply_on = ?,
          fw_version = ?, model_code = ?, last_communication = ?,
          last_measurement_time = ?, next_communication = ?, serial_no = ?, online = ?
      WHERE device_uuid = ?
    `);
```

Then replace the status `try { ... }` block's body (lines 69-83) with:

```javascript
    try {
      const statuses = await client.fetchDeviceStatus();
      const now = Date.now();
      db.transaction(() => {
        for (const s of statuses) {
          const lastComm = parseTimestamp(s.last_communication);
          const nextComm = parseTimestamp(s.next_communication);
          const online = deriveOnline(lastComm, nextComm, now);
          updateStatusStmt.run(
            s.battery_level_percent, s.radio_level_percent, s.connection_type,
            s.is_powersupply_on ? 1 : 0, s.fw_version, s.model_code,
            lastComm, parseTimestamp(s.last_measurement_time),
            nextComm, s.serial_no, online, s.device_uuid);

          const stationId = deviceToStation.get(s.device_uuid);
          if (stationId) {
            applySystemEvents(db, stationId, { online, battery: s.battery_level_percent }, now);
          }
        }
      })();
    } catch (e) {
      console.error('Error syncing device status:', e.message);
      hasError = true; errorMsg = e.message;
    }
```

- [ ] **Step 6: Run the full suite to verify it passes**

Run: `npm test 2>&1 | tail -8`
Expected: PASS — all tests green, `fail 0` (the existing "Sync resolves devices…" test still passes: its mock status row has no comm timestamps, so `deriveOnline(null,null,now)` returns `1` — online, no spurious connection event — and battery 85 is above the 20% threshold).

- [ ] **Step 7: Commit**

```bash
git add backend/scheduler.js backend/tests/scheduler.test.js
git commit -m "$(cat <<'EOF'
feat(scheduler): derive online state and emit system events

Populate stations.online from device comm timestamps and reconcile
per-station system events (connection lost, battery low) into the events
table. Gives the previously always-zero `system` severity a real data
source so /api/totals and the dashboard system UI become meaningful.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `/api/totals` surfaces active system events (#3 guard)

**Files:**
- Test: `backend/tests/server.test.js` (no production change — this locks in the contract that closes #3)

- [ ] **Step 1: Write the test**

Append to `backend/tests/server.test.js`, before the final `after(() => {` block:

```javascript
test('GET /api/totals counts active system events', async () => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id, name) VALUES ('totst', 'Totals Test')").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, active) VALUES ('sys-x-totst','totst','system',?,1)")
    .run(Date.now());

  const res = await fetch('http://localhost:3001/api/totals');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.system >= 1, 'active system events must be counted in totals.system');
});
```

- [ ] **Step 2: Run the suite to verify it passes**

Run: `npm test 2>&1 | grep -A2 "counts active system"`
Expected: PASS — the existing `/api/totals` query (`severity='system' AND active=1`) already counts the row; this test proves the end-to-end loop is now closed. No production code change is required.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/server.test.js
git commit -m "$(cat <<'EOF'
test(api): guard that /api/totals counts active system events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Release v0.1.5 (version sync + cache-busters)

This change is a bugfix → PATCH bump 0.1.4 → 0.1.5. Per the project's versioning rule, every version location must carry the same value; the dashboard `?v=` cache-buster must move so browsers reload the changed `data.js`. The "Über" box in `settings.jsx` is also a version location and currently reads `1.0.0` — bringing it to `0.1.5` makes all locations consistent.

**Files:**
- Modify: `package.json:3`
- Modify: `VERSION`
- Modify: `README.md` (version badge)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html:1098-1102` (five `?v=` tags)
- Modify: `Smart Meter Dashboard/settings.jsx:929-930` (About box)

- [ ] **Step 1: Bump the manifest, VERSION, and badge**

In `package.json`, change line 3 `"version": "0.1.4",` to `"version": "0.1.5",`.

Overwrite `VERSION` with exactly `0.1.5` (single line, no trailing newline change beyond the existing format).

In `README.md`, change the badge `![version](https://img.shields.io/badge/version-0.1.4-blue)` to `![version](https://img.shields.io/badge/version-0.1.5-blue)`.

- [ ] **Step 2: Bump the five asset cache-busters**

In `Smart Meter Dashboard/Klima Dashboard.html`, change every `?v=0.1.4` to `?v=0.1.5` on the five script tags (lines 1098-1102):

```html
<script src="data.js?v=0.1.5"></script>
<script type="text/babel" src="charts.jsx?v=0.1.5"></script>
<script type="text/babel" src="tiles.jsx?v=0.1.5"></script>
<script type="text/babel" src="settings.jsx?v=0.1.5"></script>
<script type="text/babel" src="app.jsx?v=0.1.5"></script>
```

- [ ] **Step 3: Correct the About box version**

In `Smart Meter Dashboard/settings.jsx`, in the `AdvancedSection` "Über" card (lines 929-930), change:

```jsx
          <KV label="Version"    value="Klima Dashboard 1.0.0" />
          <KV label="Build"      value="2026-05-29 · #local" />
```

to:

```jsx
          <KV label="Version"    value="Klima Dashboard 0.1.5" />
          <KV label="Build"      value="2026-06-03 · #local" />
```

- [ ] **Step 4: Verify version consistency**

Run:

```bash
grep -n '"version"' package.json; cat VERSION; grep -n 'badge/version' README.md; grep -c '?v=0.1.5' "Smart Meter Dashboard/Klima Dashboard.html"; grep -n 'Klima Dashboard 0.1.5' "Smart Meter Dashboard/settings.jsx"; git tag -l v0.1.5
```

Expected: `package.json` shows `0.1.5`; `VERSION` prints `0.1.5`; README badge shows `0.1.5`; the HTML grep count is `5`; the settings grep matches; `git tag -l v0.1.5` prints **nothing** (tag must not exist yet).

- [ ] **Step 5: Run the full suite one last time**

Run: `npm test 2>&1 | tail -6`
Expected: PASS — `ℹ pass 26`, `ℹ fail 0` (23 original + 3 new: Task 1, Task 5, Task 6; Tasks 3 & 4 add to the device-bridge file count too — confirm `fail 0` regardless of the exact pass total).

- [ ] **Step 6: Commit, tag, and push**

```bash
git add package.json VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html" "Smart Meter Dashboard/settings.jsx"
git commit -m "$(cat <<'EOF'
chore: bump version to 0.1.5

Release the measured-metric delivery (#1) and system-event (#3) fixes;
bump asset cache-busters and align the dashboard About box version.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
git tag -a v0.1.5 -m "v0.1.5"
git push --follow-tags
```

Expected: commit + annotated tag `v0.1.5` created and pushed (the project's versioning rule pre-authorizes pushing the version-bump commit and its tag).

---

## Self-Review

**1. Spec coverage**
- #1 "measured dewpoint/abshumid stored but never delivered" → Task 1 (backend delivers all 5 series) + Task 2 (frontend consumes, prefers measured) ✓
- #3 "system severity is a dead function / always-0 counter" → Tasks 3-4 (pure helpers) + Task 5 (scheduler writes `online` + system events) + Task 6 (totals guard) ✓
- Version cache-buster for the changed `data.js`/`settings.jsx`, plus the version-consistency fix that the bump requires → Task 7 ✓

**2. Placeholder scan** — No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code; every run step shows an exact command and expected result. The only non-automated verification (Task 2 Step 4) is explicit because the dashboard has no JS test runner, with exact seed/curl/cleanup commands. ✓

**3. Type consistency**
- `deriveOnline(lastCommTs, nextCommTs, now, graceMs=3600000)` — defined Task 3, called Task 5 with `(lastComm, nextComm, now)` (uses default grace). ✓
- `deriveSystemConditions(snapshot{online,battery})` returns `[{type,message,detail}]` — defined Task 4, consumed by `applySystemEvents` (Task 5) which reads `.type/.message/.detail`. ✓
- `applySystemEvents(db, stationId, snapshot, now)` — defined and called Task 5; synthetic uuid `sys-${type}-${stationId}` matches the test's `sys-battery-living`. ✓
- `METRIC_PROPS` keys (`temperature/humidity/pressure/dewpoint/abshumid`) match the frontend `stationMetrics` keys (Task 2) and `data.metrics.*` reads. ✓
- System `alarm_condition_type` values `'connection'`/`'battery'` match the frontend mapping `system: e.alarm_condition_type` and `EventRow`'s `e.system === 'battery'|'connection'`. ✓
