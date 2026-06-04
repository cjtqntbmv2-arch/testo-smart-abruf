# Data Model

## SQLite database

- Driver: `better-sqlite3` (synchronous).
- File path: `process.env.DB_PATH` or `<repo>/klima.db` (relative to `backend/`: `path.join(__dirname, '../klima.db')`). `':memory:'` is special-cased (no seed, no file-size/storage stats).
- `PRAGMA foreign_keys = ON` is set on open (required for the cascade deletes below to work).
- All tables created with `CREATE TABLE IF NOT EXISTS` at startup; safe to re-run.

### Table: `settings` (key/value)

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

Known keys (all values stored as TEXT):

| key | meaning | default (seeded on first run) |
|---|---|---|
| `api_key` | testo Smart Connect API key | `process.env.TESTO_API_KEY` or `''` |
| `api_region` | region segment of base URL (`eu`/`am`/`ap`/`us`…) | `process.env.TESTO_API_REGION` or `'eu'` |
| `poll_interval_sec` | scheduler interval, seconds | `process.env.POLL_INTERVAL_SEC` or `'900'` |
| `retention_days` | data retention, days | `process.env.RETENTION_DAYS` or `'365'` |
| `last_alarm_sync_time` | alarm watermark (epoch ms) — written by scheduler only | (unset until first alarm sync) |

First-run seed happens only when the `settings` table is empty **and** the DB is not `:memory:`. No stations are seeded (the user creates them via the assignment UI).

### Table: `stations`

```sql
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,            -- user-chosen short slug, e.g. 'living'
  name TEXT NOT NULL,            -- display name
  location TEXT,
  mo_uuid TEXT,                  -- testo measuring-object uuid (optional)
  device_uuid TEXT,             -- testo device uuid (binds station to a logger)
  serial_no TEXT,               -- filled from device status sync
  online INTEGER DEFAULT 1,
  battery INTEGER,
  signal INTEGER,
  connection_type TEXT,
  is_powersupply_on INTEGER,
  fw_version TEXT,
  model_code TEXT,
  last_communication INTEGER,    -- epoch ms
  last_measurement_time INTEGER, -- epoch ms
  next_communication INTEGER     -- epoch ms
);
```

The columns from `serial_no` downward are **telemetry**, populated by the device-status sync phase via `UPDATE … WHERE device_uuid = ?`. They must survive a station edit (see upsert note below).

### Table: `measurements`

```sql
CREATE TABLE IF NOT EXISTS measurements (
  uuid TEXT PRIMARY KEY,        -- testo row uuid (dedupe key)
  station_id TEXT,
  timestamp INTEGER,            -- epoch ms (parsed from ISO string)
  timestamp_local TEXT,
  value REAL,
  physical_property TEXT,       -- 'temperature'|'humidity'|'pressure'|'dewpoint'|'abshumid'
  unit TEXT,
  channel_no INTEGER,
  sensor_uuid TEXT,
  serial_no TEXT,
  model_code TEXT,
  processed_at TEXT,
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meas_timestamp ON measurements(station_id, timestamp);
```

Inserted with `INSERT OR IGNORE` (idempotent on `uuid`). `physical_property` is the **dashboard metric id**, not the raw testo property name — produced by `mapPhysicalProperty()`.

### Table: `events` (alarms + system messages)

```sql
CREATE TABLE IF NOT EXISTS events (
  uuid TEXT PRIMARY KEY,        -- testo alarm uuid
  station_id TEXT,
  severity TEXT NOT NULL,       -- 'alarm' | 'warning' | 'system'
  alarm_status TEXT,            -- e.g. 'Active'
  alarm_reason TEXT,
  alarm_condition_type TEXT,    -- e.g. contains 'UPPER'/'LOWER' (used to derive high/low)
  alarm_value REAL,
  metric TEXT,                  -- mapped metric id (from physical_value)
  threshold REAL,               -- (always inserted NULL by scheduler)
  start_ts INTEGER NOT NULL,    -- epoch ms (alarm_time)
  end_ts INTEGER,               -- epoch ms (last_status_change_time)
  extreme REAL,                 -- = alarm_value
  active INTEGER DEFAULT 1,     -- 1 if alarm_status === 'Active' else 0
  message TEXT,
  detail TEXT,
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
);
```

Inserted with `INSERT OR REPLACE`. `severity` normalization: `(alarm_severity||'Warning').toLowerCase()==='alarm' ? 'alarm' : 'warning'`. The `'system'` severity value is supported by schema/queries but **never produced by the scheduler** — no code path inserts a system event (dead branch in `GET /api/totals` and the frontend system-event rendering).

German literals written by the scheduler:
- `message` = `alarm_reason || 'Grenzwert verletzt'`
- `detail` = `` `Sensor ${serial_no} hat einen Wert von ${alarm_value} gemeldet.` ``

### Relationships & cascade

```
stations(id) 1 ──< measurements(station_id)   ON DELETE CASCADE
stations(id) 1 ──< events(station_id)          ON DELETE CASCADE
```

**Critical rebuild rule:** updating a station must **not** delete its row first. Use `INSERT … ON CONFLICT(id) DO UPDATE SET name=…, location=…, mo_uuid=…, device_uuid=…`. Using `INSERT OR REPLACE` would delete-then-insert, and with FKs on + cascade that wipes the station's measurements/events and resets telemetry columns. (This is enforced by a server test.)

## Server `/metrics` response shape

`GET /api/stations/:id/metrics` (last 24h) returns:

```json
{
  "timestamps": [/* sorted unique epoch-ms */],
  "metrics": {
    "temperature": { "series": [/* aligned, forward-filled */], "unit": "°C" },
    "humidity":    { "series": [...], "unit": "%" },
    "pressure":    { "series": [...], "unit": "hPa" }
  }
}
```

Only these three metrics are returned even though `dewpoint`/`abshumid` may be stored. Series are aligned to the union of timestamps and **forward-filled** (carry previous value; leading gaps stay `null` until first value). Empty → all series `[]` with default units.

## Frontend in-memory station object (`data.js`)

Each station in `window.DASH_DATA.stations[id]`:

```js
{
  id, name,
  code,            // device_uuid.slice(0,4).toUpperCase() || 'M01' (seed uses id.slice(0,3))
  location,        // s.location || 'Unbekannt'
  online,          // s.online === 1
  battery,         // s.battery ?? 100
  signal,          // s.signal ?? 100
  lastSeen,        // s.last_communication || Date.now()
  mo_uuid, device_uuid,
  metrics: {       // for each of the 5 METRIC_IDS:
    temperature|humidity|pressure|dewpoint|abshumid: {
      ...META[id], series: number[](NaN for gaps), unit, domain: [lo,hi]
    }
  },
  thresholds,      // from localStorage or DEFAULT_THRESHOLDS
  events: [ /* merged backend + local-threshold events, sorted active-first then startTs desc */ ]
}
```

Merged event object shape (both sources normalized to):
```js
{ id, severity:'alarm'|'warning'|'system', system, message, detail, metric, condition:'high'|'low', threshold, startTs, endTs, extreme, active }
```

## Metric metadata (`META` in data.js) — reproduce verbatim

```js
const META = {
  temperature: { id:"temperature", label:"Temperatur",      short:"Temp.",        unit:"°C",   color:"oklch(0.70 0.13 55)",  colorSoft:"oklch(0.70 0.13 55 / 0.18)",  decimals:1, icon:"thermo" },
  humidity:    { id:"humidity",    label:"Rel. Luftfeuchte", short:"rel. Feuchte", unit:"%",    color:"oklch(0.62 0.12 230)", colorSoft:"oklch(0.62 0.12 230 / 0.18)", decimals:0, icon:"drop" },
  pressure:    { id:"pressure",    label:"Luftdruck",        short:"Druck",        unit:"hPa",  color:"oklch(0.55 0.11 300)", colorSoft:"oklch(0.55 0.11 300 / 0.18)", decimals:1, icon:"gauge" },
  dewpoint:    { id:"dewpoint",    label:"Taupunkt",         short:"Taupunkt",     unit:"°C",   color:"oklch(0.65 0.09 200)", colorSoft:"oklch(0.65 0.09 200 / 0.18)", decimals:1, icon:"snow" },
  abshumid:    { id:"abshumid",    label:"Abs. Luftfeuchte", short:"abs. Feuchte", unit:"g/m³", color:"oklch(0.60 0.10 165)", colorSoft:"oklch(0.60 0.10 165 / 0.18)", decimals:2, icon:"vapor" },
};
const METRIC_IDS = ["temperature","humidity","pressure","dewpoint","abshumid"];
```

## Default thresholds (`DEFAULT_THRESHOLDS`) — reproduce verbatim

```js
const DEFAULT_THRESHOLDS = {
  temperature: { warn:[19.0,23.5], alarm:[17.5,25.5] },
  humidity:    { warn:[38,55],     alarm:[33,62]     },
  pressure:    { warn:[1011,1019], alarm:[1008,1022] },
  dewpoint:    { warn:[7.5,13.0],  alarm:[6.0,14.5]  },
  abshumid:    { warn:[7.5,11.0],  alarm:[6.5,12.0]  },
};
```

## Derived-metric formulas (data.js + migration script) — reproduce verbatim

```js
function dewPoint(T, RH) {            // Magnus formula
  const a = 17.625, b = 243.04;
  const alpha = Math.log(Math.max(1, RH) / 100) + (a * T) / (b + T);
  return (b * alpha) / (a - alpha);
}
function absHumidity(T, RH) {         // g/m³
  return (6.112 * Math.exp((17.67 * T) / (T + 243.5)) * RH * 2.1674) / (273.15 + T);
}
```

## Browser localStorage keys

| Key | Written by | Shape |
|---|---|---|
| `dash-layout-v3` | app.jsx | tile layout array (see GUI.md) |
| `dash-settings-v1` | settings.jsx | full settings object (`DEFAULT_SETTINGS` shape; incl. `calibration[stationId]`) |
| `dash-thresholds-${stationId}` | data.js | per-station thresholds object |

These are authoritative client state; the server never reads them.

## Constants (data.js)

```js
const POINTS = 144;               // placeholder series length
const STEP_MS = 10 * 60 * 1000;   // 10 min spacing for placeholder timestamps
```

## Open Questions

- **Dead storage path:** `dewpoint`/`abshumid` are written into `measurements` by the scheduler but never read back (the metrics endpoint omits them; the frontend recomputes). A faithful rebuild keeps both behaviors; whether to expose stored derived metrics instead of recomputing is a product decision, not determinable from code.
- `events.threshold` is always inserted `NULL` by the scheduler; the frontend's `e.threshold` for backend alarms is therefore usually null. The local-event path sets `threshold` from the station thresholds. Intended? Unclear from code.
- `mo_uuid` is stored and shown but never used for data routing (routing is by `device_uuid`/`sensor_uuid`). Retained for display/assignment only.
