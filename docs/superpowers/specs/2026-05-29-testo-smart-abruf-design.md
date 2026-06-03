# Design Spec: testo Smart Connect API Integration & Dashboard Backend

**Date:** 2026-05-29  
**Status:** Draft  
**Author:** Antigravity  

---

## 1. Goal & Context

The goal of this project is to turn the static frontend draft located in the `Smart Meter Dashboard` directory into a fully functioning, locally hosted web application running on a Windows PC. The application will periodically pull measurements, alarms, and device status data from the **testo Smart Connect API**, store it in a local **SQLite database**, and serve it to the React-based dashboard.

Key capabilities to be added:
1. **Background Sync Service**: Periodically fetches data from the testo Cloud in an incremental, reliable way.
2. **Local SQLite Database**: Stores setting values, dashboard station definitions, measurements, and alerts.
3. **Local REST API Server**: Serves measurement history and device status to the frontend.
4. **Zuweisungsmanager (Assignment Manager)**: A settings UI for the user to map local rooms/dashboard tiles to physical measuring objects returned by the API.

---

## 2. Architecture & Components

The application is structured as an **integrated Node.js server** (monolith) hosting both the API/Static Server and the background scheduler. This approach minimizes setup complexity and resource usage.

```
testo-smart-abruf/
├── backend/
│   ├── server.js          # Express-Webserver (Dashboard static assets & REST API)
│   ├── db.js              # SQLite-Datenbankverbindung und SQL-Abfragen
│   ├── scheduler.js       # Background job scheduler (periodischer Cron/Tick)
│   ├── testo-client.js    # Client for testo Smart Connect API (async POST-poll-GET-download loop)
│   └── config.js          # Loads settings from SQLite
├── Smart Meter Dashboard/ # Frontend files (modified to call local API)
│   ├── Klima Dashboard.html
│   ├── app.jsx            # Updated to fetch from REST API
│   ├── settings.jsx       # Extended with Zuweisungsmanager tab
│   └── data.js            # Rewritten to act as API client layer
├── package.json           # Node.js dependencies
└── .env                   # Local dev config (Port, db path)
```

---

## 3. Database Schema (SQLite)

We will use a single SQLite file (`klima.db`) to store settings, mappings, measurements, and alarms.

### Table `settings`
Stores configuration values as key-value pairs:
- `key` (TEXT PRIMARY KEY) — Configuration name (e.g. `api_key`, `api_region`, `poll_interval_sec`, `database_retention_days`).
- `value` (TEXT) — Configuration value.

### Table `stations`
Represents dashboard tiles and mappings to physical devices:
- `id` (TEXT PRIMARY KEY) — Local unique ID (e.g., `living`, `bedroom`).
- `name` (TEXT) — Human-readable name (e.g., "Wohnzimmer").
- `location` (TEXT) — Room/sensor location description (e.g., "1. OG · Süd").
- `mo_uuid` (TEXT) — `measuring_object_uuid` from the API.
- `device_uuid` (TEXT) — `device_uuid` or `serial_no` from the API.
- `online` (INTEGER) — Connection status (0 = offline, 1 = online).
- `battery` (INTEGER) — Battery level in %.
- `signal` (INTEGER) — Signal level in %.
- `connection_type` (TEXT) — Connection type (e.g., `WIFI`, `ETHERNET`).
- `is_powersupply_on` (INTEGER) — Power supply status (0 = off, 1 = on).
- `fw_version` (TEXT) — Device firmware version.
- `model_code` (TEXT) — Device model number.
- `last_communication` (INTEGER) — Unix timestamp (ms) of last communication.
- `last_measurement_time` (INTEGER) — Unix timestamp (ms) of last measurement.
- `next_communication` (INTEGER) — Unix timestamp (ms) of next communication.

### Table `measurements`
Stores time-series measurement values. Deduped on row-level `uuid`.
- `uuid` (TEXT PRIMARY KEY) — Unique record identifier from the API (deduplication key).
- `station_id` (TEXT) — Foreign key referencing `stations.id`.
- `timestamp` (INTEGER) — Unix timestamp (ms) when measurement was taken (UTC).
- `timestamp_local` (TEXT) — ISO-8601 string of local measurement time.
- `value` (REAL) — Numeric measurement value.
- `physical_property` (TEXT) — E.g. `temperature`, `humidity`, `pressure`.
- `unit` (TEXT) — E.g. `CELSIUS`, `PERCENT`, `HECTOPASCAL`.
- `channel_no` (INTEGER) — Channel number on the sensor.
- `sensor_uuid` (TEXT) — UUID of the physical sensor.
- `serial_no` (TEXT) — Serial number of the sensor.
- `model_code` (TEXT) — Model number of the sensor.
- `processed_at` (TEXT) — ISO-8601 string of when data was received by the Cloud.

### Table `events`
Stores alarms and system messages.
- `uuid` (TEXT PRIMARY KEY) — Unique record identifier.
- `station_id` (TEXT) — Foreign key referencing `stations.id`.
- `severity` (TEXT) — Severity level (`alarm`, `warning`, `system`).
- `alarm_status` (TEXT) — API status (e.g., `Active`, `Cleared`).
- `alarm_reason` (TEXT) — Reason details from the API.
- `alarm_condition_type` (TEXT) — E.g., `MACT_UPPER_LIMIT`.
- `alarm_value` (REAL) — Violating measurement value.
- `metric` (TEXT) — Affected metric name (e.g., `PV_TEMPERATURE`).
- `threshold` (REAL) — Warning/Alarm threshold.
- `start_ts` (INTEGER) — Start timestamp (Unix ms).
- `end_ts` (INTEGER) — End timestamp (Unix ms, NULL if active).
- `extreme` (REAL) — Extreme value observed during the alarm event.
- `active` (INTEGER) — Flag (1 = active, 0 = cleared).
- `message` (TEXT) — Summary title.
- `detail` (TEXT) — Descriptive details.

---

## 4. Background Sync Logic

The background scheduler runs at configured intervals (default: 15 minutes) and coordinates fetching from the testo Smart Connect API:

1. **Configurations Check**: Loads API Key, Region, and local settings from the database.
2. **Device Status Synchronization**:
   - Submits `POST /v3/devices/status` request, polls until completed, and downloads the file payload.
   - Updates the `stations` table with live status (battery, signal, online status, connection types, firmware).
3. **Incremental Measurements Synchronization**:
   - For each configured station, finds the latest measurement timestamp stored in SQLite.
   - Submits `POST /v2/measurements` with `date_time_from` set to `max_db_timestamp + 1ms`.
   - Polls until completed and downloads the CSV or JSON payload.
   - Inserts records into SQLite using `INSERT OR IGNORE INTO measurements` to prevent duplicates.
4. **Alarms Synchronization**:
   - Submits `POST /v3/alarms` for the window since the last sync.
   - Polls, downloads, and updates the `events` table.
   - Local Diagnostic Check: The scheduler scans `stations` for batteries $\le 20\%$ or connection drops, writing local `system` event rows if issues are found.

---

## 5. REST API Endpoints

The backend Express server exposes these HTTP endpoints:

- `GET /api/stations` — Returns all mapped stations and their statuses.
- `POST /api/stations` — Creates or updates a station mapping (Zuweisungsmanager).
- `DELETE /api/stations/:id` — Deletes a station mapping and all associated database records.
- `GET /api/stations/:id/metrics` — Returns historical measurements for the charts (defaults to the last 24h, aggregated or raw).
- `GET /api/stations/:id/events` — Returns active and historical alerts/messages for the timeline and table.
- `GET /api/totals` — Returns active alarm, warning, and system counts across all stations.
- `GET /api/settings` — Returns current application settings.
- `POST /api/settings` — Saves application settings and triggers an immediate sync check.
- `GET /api/testo/measuring-objects` — Direct proxy to fetch available measuring objects from the Testo API (shows name, UUID, customer site, etc. for dropdowns).

---

## 6. Frontend Changes & Zuweisungsmanager

The existing React code in `Smart Meter Dashboard/` will be updated:
1. **`data.js`**: Rewritten to perform `fetch()` requests against `/api` endpoints rather than using mulberry32 pseudorandom generators.
2. **`settings.jsx`**: Extended with a **Zuweisungs-Manager** section.
   - Lists configured stations with names, locations, and mappings.
   - Allows adding a new station.
   - Pulls measuring objects from the backend `/api/testo/measuring-objects` and provides a dropdown to select which physical measuring object represents this station.
   - Saves settings directly to the backend.

---

## 7. Verification Plan

### Automated Tests
- Script a simple test runner in `backend/test-sync.js` that calls the sync logic manually using a mock API key and verifies that database tables are populated correctly.
- Verify API endpoint responses using `curl` or automated endpoint checks.

### Manual Verification
- Open the dashboard locally under `http://localhost:3000`.
- Verify that real measurements are plotted on the line charts.
- Verify that changing warning/alarm thresholds triggers corresponding UI events.
- Test the Zuweisungsmanager by linking a new name to a mocked measuring object and checking that the database maps it correctly.
