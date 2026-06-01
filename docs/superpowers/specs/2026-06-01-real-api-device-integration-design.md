# Design: Robuste Real-API-Anbindung (Gerät-zentriertes Modell)

**Datum:** 2026-06-01
**Status:** Freigegeben (Brainstorming abgeschlossen)
**Kontext:** Die Klima-Dashboard-App läuft aktuell im Mock-Modus (`api_key='mock-api-key'`).
Mit echtem testo-API-Key erscheinen keine Messwerte, weil die `stations`-Tabelle nur
*eine* ID-Spalte (`device_uuid`) führt, der Scheduler diesen Wert aber für zwei Joins
mit **unterschiedlichen** Identifiern nutzt: Gerätestatus (braucht `device_uuid`) und
Messwerte (Measurements-Endpoint ist nur über `sensor_uuid`/`serial_no` filterbar — es
gibt dort *keine* `device_uuid`-Spalte). Zusätzlich läuft die Auto-Befüllung über
`channel_assignments`, das laut Doku in echten Tenants oft leer ist.

## Ziel

Mit echtem API-Key zuverlässig: (1) Messwerte auf den Kacheln, (2) Live-Gerätestatus
(Batterie/Signal/online), (3) echte testo-Alarme. Validierung der Echt-API erfolgt durch
den Nutzer mit seinem eigenen Key; der Code muss diese Validierung durch gezielte
Diagnose unterstützen.

## Festgelegte Entscheidungen

- **Zuordnungs-Einheit:** Eine Dashboard-Messstelle = **ein Gerät/Logger** (`device_uuid`).
  Ein Gerät kann mehrere Sensoren/Kanäle haben (Temp + Feuchte + ggf. Druck), die alle in
  die Metriken der Station fließen.
- **Umfang:** Alle drei Datenflüsse (Messwerte + Status + Alarme).
- **Alarme:** Echte Alarm-Ereignisse aus `/v3/alarms`. Die lokale, clientseitige
  Schwellwert-Funktion des Dashboards bleibt unverändert als Zusatz bestehen.
- **Architektur:** **Device Properties (`/v3/devices/properties`) als zentrale Brücke** —
  das einzige Endpoint mit `device_uuid ↔ sensor_uuid ↔ serial ↔ channel ↔ physical_property`
  in einer Zeile. Pro Sync-Zyklus frisch abgerufen.
- **Bewusst ausgeklammert (YAGNI):** Grenzwert-Sync aus `measurement_alarm_configuration`
  (scheitert am leeren `channel_assignments`). Metriken außer Temperatur/Feuchte/Druck
  (Dashboard hat keine Kacheln dafür).

## Referenz-Fakten aus der API-Doku (verifiziert)

Quelle: `testo-smart-connect-api/05-endpoints/retrievable-parameters.md` (Schemas) und
`09-limit-values.md` (live verifiziert 2026-05-20).

- **Measurements (`/v2/measurements`)** Spalten u.a.: `uuid` (Row-Dedupe), `sensor_uuid`,
  `serial_no` (Sensor-Serial), `channel_no`, `measurement`, `physical_property_name`,
  `physical_unit`, `timestamp`, `timestamp_local`, `model_code`, `processed_at`.
  **Kein `device_uuid`, kein `mo_uuid`.** Filterbar nur über `sensor_uuid`/`serial_no`/
  `channel_no`/`customer_site`.
- **Device Status (`/v3/devices/status`)** u.a.: `device_uuid`, `serial_no` (Geräte-Serial),
  `battery_level_percent`, `radio_level_percent`, `connection_type`, `is_powersupply_on`,
  `fw_version`, `model_code`, `last_communication`, `last_measurement_time`,
  `next_communication`. (`POST /v3/devices/status` ist in der Spec `deprecated`, aber der
  einzige veröffentlichte Pfad — beibehalten.)
- **Device Properties (`/v3/devices/properties`)** — eine Zeile pro Kanal. Enthält BEIDE:
  `device_uuid` + `sensor_uuid`, dazu `device_serial_no`, `sensor_serial_no`, `channel_no`,
  `channel_physical_property_name`, `channel_physical_unit`, `device_display_name`,
  `device_model_code`, u.v.m. → **die Brücke.**
- **Alarms (`/v3/alarms`)** u.a.: `uuid`, `serial_no` (Sensor-Serial, der den Alarm meldete),
  `alarm_source_uuid` (kann sensor_uuid oder device_uuid sein), `alarm_severity`
  (`Warning`/`Alarm`), `alarm_status`, `alarm_condition_type`, `alarm_value`,
  `physical_value`, `physical_unit`, `alarm_time`, `last_status_change_time`.
- **Async-Muster** für alle: POST → `request_uuid` → GET poll bis `Completed` → `data_urls`
  herunterladen → auf Row-`uuid` deduplizieren.

## Architektur & Datenfluss

### Sync-Zyklus (`backend/scheduler.js`, `runSyncCycle`)

```
1. Device Properties holen (fetchDeviceProperties)
   → Brücken-Maps aufbauen:
       sensorToDevice:  sensor_uuid  -> device_uuid
       deviceSensors:   device_uuid  -> Set<sensor_uuid>
       serialToDevice:  sensor_serial_no -> device_uuid
   (Eine Device-Properties-Zeile pro Kanal; nach device_uuid/sensor_uuid entduplizieren.)

2. Gerätestatus (fetchDeviceStatus)
   → UPDATE stations SET battery,signal,serial_no,fw,model,comm-times
     WHERE device_uuid = status.device_uuid        (Feld bereits korrekt)

3. Messwerte (fetchMeasurements)
   → assignedSensors = Vereinigung der deviceSensors[station.device_uuid]
     über alle Stationen mit gesetzter device_uuid
   → falls assignedSensors leer: überspringen (mit Diagnose-Log)
   → EIN Request:  $filter = sensor_uuid eq 's1' or sensor_uuid eq 's2' ...
                   date_time_from = jüngster Messwert-Timestamp (global) bzw. -24h
   → pro Zeile:  device_uuid = sensorToDevice[row.sensor_uuid]
                 station     = stations WHERE device_uuid = device_uuid
                 metric      = mapPhysicalProperty(row.physical_property_name)
                 INSERT OR IGNORE measurements(uuid, station_id, ... sensor_uuid ...)
   → Zeilen ohne Mapping (unbekannter Sensor / unbekannte Größe) zählen + loggen

4. Alarme (fetchAlarms)
   → pro Alarm:  device_uuid = serialToDevice[a.serial_no]
                            ?? sensorToDevice[a.alarm_source_uuid]
                            ?? (a.alarm_source_uuid als device_uuid direkt)
                 station = stations WHERE device_uuid = device_uuid
                 severity = (a.alarm_severity == 'Alarm') ? 'alarm' : 'warning'
                 INSERT OR REPLACE events(...)
   → unmatched Alarme zählen + loggen

5. Retention-Cleanup (unverändert)
```

### Metrik-Mapping (`mapPhysicalProperty`)

Case-insensitive Keyword-Match auf `physical_property_name` (DE + EN):
`temp` → `temperature`; `humid`/`feucht` → `humidity`; `press`/`druck` → `pressure`;
sonst `null` (Zeile wird gezählt/geloggt und ignoriert). Einheiten-Normalisierung wie
bisher (Dashboard erwartet `°C`, `%`, `hPa`).

### Backend-Endpoints (`backend/server.js`)

- **Neu:** `GET /api/testo/devices` → Geräteliste aus Device Properties, entdupliziert nach
  `device_uuid`: `{ device_uuid, name (device_display_name), serial_no (device_serial_no),
  model_code }`. Speist das Zuweisungs-Dropdown.
- `GET /api/system/status` erweitern um Sync-Diagnose: `devicesSeen`, `sensorsSeen`,
  `measurementsFetched`, `measurementsUnmatched`, `alarmsUnmatched` (aus dem letzten Zyklus),
  damit der Nutzer bei Echt-Key-Problemen die Bruchstelle sieht.

### Datenmodell (`backend/db.js`)

- `stations`: `device_uuid` ist die maßgebliche Geräte-ID; `serial_no` (Geräte-Serial) aus
  Status; `mo_uuid` bleibt als optionales Feld erhalten (für späteren Grenzwert-Sync).
  **Keine neue Sensor-Spalte** — Sensoren werden zur Laufzeit aufgelöst.
- `measurements`, `events`: unverändert. (`measurements.sensor_uuid` wird jetzt korrekt
  befüllt; `station_id` aus der Brücke.)

### Frontend (`Smart Meter Dashboard/settings.jsx`)

- Zuweisungs-Manager: Messobjekt-Dropdown → **Geräte-Dropdown** (`GET /api/testo/devices`):
  Label = `name` + Serial, Wert = `device_uuid`. Auswahl speichert `device_uuid` (und
  optional `mo_uuid` weiterhin manuell). Den fragilen `extractDeviceUuid`/
  `channel_assignments`-Pfad entfernen. Manuelles UUID-Feld bleibt als Experten-Override,
  jetzt eindeutig als **device_uuid** beschriftet.

### Mock-Modus (`backend/testo-client.js`)

Mock konsistent zum neuen Modell machen (damit aktuelle Mock-Nutzung + Tests weiterlaufen):

- `device-properties` (neuer Mock-Pfad): Zeilen, die `sensor_uuid='mock-sensor-temp'` und
  `sensor_uuid='mock-sensor-hum'` auf `device_uuid='mock-device-uuid'` abbilden, mit
  `device_serial_no='MOCK123'`, `sensor_serial_no='MOCK123-S1/-S2'`,
  `channel_physical_property_name` = `Temperature`/`Humidity`.
- `measurements`-Mock: `sensor_uuid` = `mock-sensor-temp`/`mock-sensor-hum` (getrennt von
  device_uuid), `physical_property_name` = `Temperature`/`Humidity`.
- `status`-Mock: `device_uuid='mock-device-uuid'`, `serial_no='MOCK123'`.
- `alarms`-Mock: `serial_no` = ein Sensor-Serial des Mock-Geräts.

## Fehlerbehandlung & Diagnose

- Jeder Endpoint-Abruf in `try/catch`, Fehler in `lastSyncError` + Konsolen-Log mit Kontext.
- Pro Zyklus Zähler (devices/sensors/measurements/unmatched) in den Scheduler-Status, über
  `/api/system/status` sichtbar — entscheidend, weil der Nutzer die Echt-API allein
  validiert.
- Leere Sensor-Menge / leere Messwerte führen zu klarer Log-Meldung, nicht zu stillem Nichts.

## Testing (TDD)

Framework: `node:test` (vorhanden), Mock-Client statt echter HTTP-Calls.

- **`backend/tests/testo-client.test.js`**: `fetchDeviceProperties()` liefert Brücken-Zeilen;
  Mock-Konsistenz (sensor_uuid ≠ device_uuid).
- **`backend/tests/scheduler.test.js`** (umbauen + erweitern):
  - Messwerte-`$filter` enthält genau die sensor_uuids der zugewiesenen Geräte.
  - Eine Messwert-Zeile wird über die Brücke der richtigen Station zugeordnet.
  - Gerätestatus-Join aktualisiert die Station mit passender `device_uuid`.
  - Alarm wird über `serial_no`→Gerät der richtigen Station zugeordnet.
  - Unmatched-Zähler werden korrekt geführt.
- **`backend/tests/server.test.js`**: `GET /api/testo/devices` liefert entduplizierte Liste;
  `/api/system/status` enthält die neuen Diagnose-Felder.

## Verifikation (End-to-End)

1. `npm test` — alle Tests grün.
2. Mock-Modus in Chrome (`http://localhost:3000`): Kacheln zeigen Werte, Batterie/Signal
   gefüllt, Alarme erscheinen; Konsole fehlerfrei.
3. Echt-Key: Nutzer trägt eigenen Key + Region ein, weist ein Gerät zu; prüft Kacheln und
   `/api/system/status`-Diagnose. Code liefert genug Logging, um eine Bruchstelle zu
   lokalisieren.

## Betroffene Dateien

- `backend/testo-client.js` — `fetchDeviceProperties()`, Mock-Konsistenz.
- `backend/scheduler.js` — Sync-Umbau (Brücke, Filter, Mapping, Alarm-Auflösung, Diagnose).
- `backend/server.js` — `GET /api/testo/devices`, Diagnose in `/api/system/status`.
- `Smart Meter Dashboard/settings.jsx` — Geräte-Dropdown statt Messobjekt.
- `backend/tests/*.test.js` — neue/angepasste Tests.
- `backend/db.js` — ggf. Index/Spalten-Sicherstellung (kein Sensor-Spalten-Add nötig).
