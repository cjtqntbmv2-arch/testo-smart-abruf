# Design Spec: Automatische CSV-Sicherung + manueller Export

- **Status:** Approved (Brainstorming abgeschlossen 2026-06-22)
- **Zielversion:** 0.11.0 (MINOR — neues, rückwärtskompatibles Feature)
- **Betrifft:** `backend/` (neue Module + scheduler/server/db), `Smart Meter Dashboard/` (neues Export-Panel), `deploy/windows/`, Versions-Artefakte

---

## 1. Zweck & Kontext

Die App pollt die testo-Smart-Connect-Cloud und speichert Messwerte/Events in SQLite. Eine
Retention-Bereinigung löscht Messwerte älter als `retention_days` (Default 365) — siehe
`backend/scheduler.js` (`DELETE FROM measurements WHERE timestamp < cutoff`, sowie inaktive Events).
Es gibt **keinen** Export- oder Archivmechanismus.

Dieses Feature liefert zwei Funktionen auf gemeinsamem Kern:

1. **Monatliches Auto-Backup** — pro Messstelle/Monat ein ZIP `<Stelle>_<JJJJ-MM>.zip`, das zwei
   CSVs enthält: `<Stelle>_messwerte.csv` und `<Stelle>_meldungen.csv`. Dies ist der
   **Archiv-Schutz, bevor die Retention die Messwerte löscht**.
2. **Manueller Export** — Dialog in den Einstellungen: Auswahl von Messstellen × Messgrößen ×
   Zeitraum → je Stelle eine Messwert-CSV (mehrere Stellen → ZIP, genau eine → einzelne CSV),
   optional zusätzlich die Meldungs-CSV.

### Wichtige Code-Fakten (verifiziert)
- Messwerte liegen **lang** vor: eine Zeile je `(timestamp, Kanal)` in `measurements`
  (`timestamp` INTEGER ms-UTC, `timestamp_local` TEXT, `value` REAL, `physical_property` =
  gemappter Metrik-Key, `unit`, `channel_no`, `serial_no`, `model_code`). Für „spaltenweise"
  muss auf **Breitformat** pivotiert werden.
- Events (`events`): `severity`, `alarm_status`, `alarm_reason`, `alarm_condition_type`,
  `alarm_value`, `metric`, `threshold`, `start_ts`, `end_ts`, `extreme`, `active`, `message`,
  `detail`, `serial_no`. Enthält **Meldungen** (System) **und** **Alarme** (Messgrenze).
- `backend/device-bridge.js` mappt physikalische Eigenschaften (`mapPhysicalProperty`) und
  klassifiziert System-/Messalarme (`classifyAlarm`, `deriveSystemConditions`). **Diese Helfer
  werden wiederverwendet** — Klassifizierung nicht neu erfinden.
- Taupunkt/abs. Feuchte werden von testo als **native Kanäle** geliefert, wenn das Gerät sie
  meldet; das Frontend berechnet sie nur als Fallback. Der Export spiegelt **nur gespeicherte
  Kanäle** (treues Archiv). (Separate Folgeaufgabe: Frontend-Berechnung entfernen.)

---

## 2. Getroffene Designentscheidungen (Brainstorming)

| # | Entscheidung |
|---|---|
| Backup-Aufbau | Zwei saubere Einzeltabellen je Stelle/Monat, gebündelt als **ZIP**. |
| ZIP-Granularität | **Ein ZIP je Messstelle/Monat** (`<Stelle>_<JJJJ-MM>.zip`). |
| ZIP-Technik | **Selbst gebaut, keine Dependency** (`zlib.deflateRaw` + CRC32 + Central Directory). |
| CSV-Dialekt | **Konfigurierbar**, Default **Deutsch (Excel)**; `de`=`;`+`,`, `rfc`=`,`+`.`. |
| Encoding/Zeilenende | **UTF-8 mit BOM + CRLF** — in beiden Dialekten fix. |
| Zeitstempel | **Zwei Spalten**: ① absolutes ISO-8601 mit Offset, ② lokal Excel-freundlich. |
| Speicherort | `<dirname(DB_PATH)>/backups`, via Setting `backup_dir` überschreibbar (Share erlaubt). |
| Aufbewahrung | **Unbegrenzt** (nie automatisch löschen). |
| Auslöser | **Resilienter Tages-Scan** + Nachholen, idempotent über Datei-Existenz. |
| Prune-Kopplung | **Prune-Sperre**: kein Löschen un-gesicherter Monate (mit Safety-Valve + Health-Warnung). |
| Spalten-Set | **Nur gespeicherte Kanäle** (keine Frontend-Berechnung im Backend). |
| Manueller Export | Messwerte; Meldungen optional zuschaltbar; 1 Stelle→CSV, n→ZIP. |

---

## 3. Architektur — Backend-Module

Kleine, isolierte Einheiten mit je einer Aufgabe (CLAUDE.md GUI/Modul-Regeln, Testbarkeit):

| Modul | Aufgabe | Abhängigkeiten | Reinheit |
|---|---|---|---|
| `backend/csv-format.js` | Dialekt-Objekt (`de`/`rfc`): Feld-Quoting, Trennzeichen, Dezimal, **CSV-Injection-Prefix**, Zahl-Formatierung, Zeitformat (ISO+Offset, lokal), `BOM`, `CRLF`. | — | rein |
| `backend/csv-export.js` | Baut Messwert-CSV (**Breit-Pivot**) + Meldungs-CSV + Header-Block aus *übergebenen* Zeilen/Metadaten. | csv-format | rein (kein DB) |
| `backend/zip-writer.js` | `createZip([{name, data:Buffer}]) → Buffer`. Local File Headers + Deflate + CRC32 + Central Directory + EOCD; **UTF-8-Flag (Bit 11)** für Umlaut-Namen; kein ZIP64 (Größen unkritisch). | nur Node `zlib`, `Buffer` | rein |
| `backend/export-service.js` | DB-Abfragen + Orchestrierung. `exportStations({stationIds, metrics, fromTs, toTs, includeEvents, dialect}) → { kind:'csv'\|'zip', filename, buffer }`. **Gemeinsamer Kern** für manuell + Backup. | db, csv-export, zip-writer, device-bridge | DB-gebunden |
| `backend/backup-runner.js` | `runBackupScan(now)`: fehlende (Stelle,Monat)-ZIPs mit Daten erkennen, erzeugen (atomar temp→rename), idempotent über Datei-Existenz, Health-Status pflegen. `computePruneFloor(now)` für die Prune-Sperre. `resolveBackupDir()`. | export-service, db, fs, path | DB+FS |

`scheduler.js` ruft pro Sync-Zyklus `maybeRunBackupScan(now)` auf (gedrosselt 1×/Tag über Setting
`last_backup_scan_date`). Nachholen nach Downtime passiert automatisch beim ersten Zyklus nach Start.

---

## 4. Datenformate

### 4.1 CSV-Dialekte
| Dialekt | Trennzeichen | Dezimal | BOM | Zeilenende |
|---|---|---|---|---|
| `de` (Default) | `;` | `,` | ja | CRLF |
| `rfc` | `,` | `.` | ja | CRLF |

- **Feld-Quoting:** Feld in `"…"` einschließen, wenn es Trennzeichen, `"`, CR oder LF enthält;
  internes `"` → `""` (RFC-4180-Regel, für beide Dialekte).
- **Zahlen:** kürzeste verlustfreie Darstellung des gespeicherten `REAL` (`String(value)`),
  Dezimalpunkt → Dezimaltrennzeichen des Dialekts; **kein** Tausendertrennzeichen; keine
  Rundung (treues Archiv). Leerer/`NULL`-Wert → leere Zelle.
- **CSV-Injection (Security):** Textfelder, die mit `=`, `+`, `-`, `@`, Tab oder CR beginnen,
  bekommen ein vorangestelltes `'` (OWASP). Betrifft nur Textspalten (Name, Standort,
  Meldungstext, Detail, Grund), nicht Zahlen/Zeitstempel.

### 4.2 Zeitstempel (zwei Spalten)
- **Spalte 1 „Zeitpunkt (ISO)":** absolutes ISO-8601 mit Offset, abgeleitet aus `timestamp`
  (UTC-ms) + lokalem Offset des Servers zum jeweiligen Zeitpunkt (DST-korrekt), z.B.
  `2026-05-01T14:30:00+02:00`.
- **Spalte 2 „Zeitpunkt (lokal)":** gleiche lokale Wandzeit ohne `T`/Offset, z.B.
  `2026-05-01 14:30:00` (Excel erkennt Datum).
- Annahme: Server-Zeitzone = Standort-Zeitzone (Single-Site-Deployment). In der Header-Präambel
  wird die Zeitzone/der UTC-Offset dokumentiert.

### 4.3 Header-Block (Metadaten-Präambel)
`Schlüssel<sep>Wert`-Zeilen, dann eine Leerzeile, dann die Tabelle (Excel-freundlich). **Werte im
Header-Block folgen demselben Quoting wie Tabellenzellen** — enthält ein Wert das aktive
Trennzeichen, `"`, CR oder LF, wird er in `"…"` gesetzt. Das Beispiel ist der Lesbarkeit halber
unquoted dargestellt; in `de` würden z.B. die „Kanäle"- und „CSV-Format"-Werte real gequotet:

```
testo Smart Abruf — Messwert-Export
Anwendung;testo-smart-abruf 0.11.0
Erstellt am;2026-06-01T03:14:00+02:00 (2026-06-01 03:14:00)
Messstelle;Serverraum EG
Standort;Gebäude A, EG
Seriennummer;12345678
Modell;0572 2620
Zeitraum von;2026-05-01T00:00:00+02:00
Zeitraum bis;2026-05-31T23:59:59+02:00
Zeitzone;Europe/Berlin (UTC+02:00 zur Erstellzeit)
Kanäle;Temperatur [°C]; Feuchte [%rF]; Taupunkt [°C]
Datensätze;2880
CSV-Format;Deutsch (Excel): Trennzeichen ';', Dezimal ','
```

### 4.4 Messwert-CSV (Breit-Pivot)
- Tabellenkopf: `Zeitpunkt (ISO);Zeitpunkt (lokal);<Metrik1> [<Einheit1>];<Metrik2> [<Einheit2>];…`
- **Eine Zeile je distinktem `timestamp`**, an dem die Stelle Daten hat. Kanal ohne Wert zu
  diesem Zeitstempel → **leere Zelle**. **Keine** künstlichen Zeilen für datenlose Intervalle.
- Spaltenlabels: Metrik-Key → deutsches Label (Map aus device-bridge: `temperature`→Temperatur,
  `humidity`→Feuchte, `pressure`→Druck, `dewpoint`→Taupunkt, `abshumid`→Absolute Feuchte; sonst
  Key), Einheit aus `measurements.unit`.
- Spaltenreihenfolge: feste Priorität `[temperature, humidity, pressure, dewpoint, abshumid]`,
  danach übrige Keys alphabetisch (stabil/reproduzierbar).
- Keine Daten im Zeitraum (manueller Export) → Header-Block + Spaltenkopf + 0 Zeilen + Zeile
  `# Keine Daten im gewählten Zeitraum`.

### 4.5 Meldungs-CSV
Tabellenkopf:
`Start (ISO);Start (lokal);Ende (ISO);Ende (lokal);Art;Schweregrad;Messgröße;Status;Grund;Auslösewert;Schwelle;Extremwert;Meldungstext;Detail`

- **Art** = `Meldung` (System: Verbindung/Batterie/Netz) vs. `Alarm` (Messgrenze), bestimmt über
  die bestehenden Klassifizierungs-Helfer in device-bridge (nicht neu erfinden).
- Laufendes Ereignis (`end_ts` NULL) → „Ende"-Spalten leer.
- **Inhalt Backup:** **alle** Events mit `start_ts` im Monat — aktiv **und** beendet (genau das
  macht das Backup zum Archiv).
- Sortierung: nach `start_ts` aufsteigend.

---

## 5. Settings (neu)
| Key | Default | Bedeutung |
|---|---|---|
| `backup_enabled` | `1` | Auto-Backup an/aus. |
| `backup_dir` | `` (leer) | Leer → `<dirname(DB_PATH)>/backups`. Sonst absoluter Pfad (Share erlaubt; DB bleibt lokal). |
| `csv_format` | `de` | `de` \| `rfc` — Default-Dialekt; im manuellen Export pro Export überschreibbar. |
| `last_backup_scan_date` | `` | Intern (YYYY-MM-DD), drosselt den Scan auf 1×/Tag. |
| `backup_health` | `` | Intern, JSON: `{status, lastScan, lastZip, lastError, missingMonths}`. |

`server.js` `GET /api/settings` gibt `backup_enabled`, `backup_dir`, `csv_format` zurück (API-Key
bleibt maskiert); `POST /api/settings` validiert & speichert sie. `backup_dir` wird beim Speichern
validiert (nicht-leer ⇒ Verzeichnis anlegbar/schreibbar; sonst 400).

---

## 6. REST-Endpunkte (neu/erweitert)

- **`GET /api/export/metadata`** → je Stelle: `{ id, name, metrics:[{key,label,unit}], earliest_ts,
  latest_ts }` (verfügbare Messgrößen via `SELECT DISTINCT physical_property, unit`). Füllt Dialog,
  Presets und Datumsgrenzen.
- **`POST /api/export`** → Body `{ stationIds:[], metrics:[], from:ISO|ts, to:ISO|ts,
  includeEvents:bool, dialect?:'de'|'rfc' }`.
  - Validierung: nicht-leere `stationIds`; `from <= to`; bekannte IDs. Fehler → 400 mit Meldung.
  - Antwort: 1 Stelle ohne Events → `text/csv`; sonst (mehrere Stellen **oder** includeEvents) →
    `application/zip`. `Content-Disposition: attachment; filename="…"` (ASCII-Fallback +
    `filename*=UTF-8''…` für Umlaute).
- **`GET /api/system/status`** erweitert um `backup`-Block (`backup_health`).
- *(optional, niedrige Prio)* `GET /api/backups` (Liste vorhandener ZIPs) + `GET
  /api/backups/:file` (Download) für die Status-Anzeige.

---

## 7. Frontend

- **Neues Modul** `Smart Meter Dashboard/export-panel.jsx`: Export-Dialog (Messstellen-/
  Messgrößen-Mehrfachauswahl, Zeitraum mit Presets [Letzte 7 Tage / Letzte 30 Tage / Aktueller
  Monat / **Letzter Monat** (Default) / Benutzerdefiniert] + von/bis, Dialekt-Auswahl vorbelegt
  aus `csv_format`, optionales „Meldungen & Alarme zusätzlich", Auslieferungshinweis) plus kleiner
  **„Datensicherung"-Statusblock** (an/aus, Verzeichnis, letzter Lauf, Health-Warnung).
  **Nicht** in `settings.jsx` (45 KB, GUI-Größenregel).
- **⚠️ Hook-Alias-Regel (Memory-Gotcha):** jedes neue `.jsx` braucht **eindeutige React-Hook-
  Aliase** — bare `useState`/`useEffect` kollidieren mit den bare-Globals aus charts.jsx → weiße
  Seite. Im neuen Modul konsequent aliasieren.
- `data.js`: `fetchExportMetadata()`, `postExport(payload)` (Antwort als Blob → Datei-Download via
  Object-URL; Dateiname aus `Content-Disposition`).
- `Klima Dashboard.html`: neuer `<script type="text/babel" src="export-panel.jsx?v=0.11.0">`-Tag;
  **alle** `?v=`-Cache-Buster auf `0.11.0` (dann 11 Script-Tags — Anzahl in CLAUDE.md/Deploy-Doku
  aktualisieren).

---

## 8. Monatliches Backup — Ablauf (`backup-runner.js`)

1. `maybeRunBackupScan(now)` (vom Scheduler): wenn `backup_enabled` und `last_backup_scan_date !=
   heute(now, lokal)` → `runBackupScan(now)`, danach Datum setzen. Bei Scan-Fehler Datum **nicht**
   setzen (Retry nächster Zyklus).
2. `runBackupScan(now)`:
   - `dir = resolveBackupDir()`; sicherstellen, dass beschreibbar (sonst Health=error, return).
   - „Abgeschlossener Monat" = jeder Monat `< aktueller Monat (lokal)`.
   - Scan-Fenster begrenzt: Monate, die `[now − (retention_days + 62 Tage), letzter abgeschl.
     Monat]` überlappen (ältere Daten sind ohnehin geprunt).
   - Für jede Stelle × Monat im Fenster **mit mindestens einem Messwert oder Event**: wenn
     `<dir>/<safeName>_<JJJJ-MM>.zip` **nicht** existiert → via `export-service` die zwei CSVs
     bauen, `zip-writer` → ZIP-Buffer → **atomar** schreiben (`.<name>.zip.tmp` → `rename`).
   - (Stelle,Monat) ohne Daten → **überspringen** (keine leeren ZIPs).
   - Health aktualisieren: `{status:'ok'|'error'|'overdue', lastScan, lastZip, lastError,
     missingMonths}`.
3. **Idempotenz:** Datei existiert → überspringen (selbstheilend; gelöschte ZIPs werden neu
   erzeugt, solange die Quelldaten in der DB sind). Spät eintreffende Daten für einen bereits
   gesicherten Monat werden **nicht** neu archiviert (first-wins, akzeptierter Edge Case).
4. **Dateinamen:** Stellenname → illegale Zeichen `< > : " / \ | ? *` und Steuerzeichen → `_`,
   führende/abschließende Punkte/Leerzeichen trimmen. Umlaute bleiben erhalten (ZIP-UTF-8-Flag;
   Windows-Dateisystem unterstützt Umlaute).

---

## 9. Prune-Sicherheit (`scheduler.js`)

Die Retention-Bereinigung nutzt:
```
retentionCutoff = now − retention_days
backupFloor     = backup_enabled ? Monatsbeginn(ältester abgeschl. Monat OHNE ZIP, im Scan-Fenster) : +∞
hardFloor       = now − 2 × retention_days            // Safety-Valve gegen Unbounded Growth
effectiveCutoff = max( hardFloor, min(retentionCutoff, backupFloor) )
DELETE FROM measurements WHERE timestamp < effectiveCutoff
```
- Normalbetrieb (365 Tage, monatlich): `backupFloor` ≫ `retentionCutoff` → keine Wirkung, keine
  Kollision.
- `backup_dir` tot / Backups schlagen fehl: `backupFloor` hält Daten — bis `hardFloor` greift
  (Daten älter als 2×Retention werden trotzdem gelöscht) **und** Health meldet
  `overdue`/`error`. So bleibt die DB beschränkt, Daten werden im Normalfall aber nie ohne Archiv
  gelöscht.
- Inaktive Events (`end_ts`/`active=0`) werden analog erst nach erfolgreichem Backup ihres Monats
  geprunt (gleiche `effectiveCutoff`-Logik auf `start_ts`).

---

## 10. Fehlerbehandlung (Zusammenfassung)
- `backup_dir` nicht schreibbar → fangen, loggen, `backup_health.status='error'`,
  `last_backup_scan_date` nicht setzen; Sync-Zyklus läuft weiter; Prune-Sperre schützt Daten.
- Manueller Export: leere Auswahl / `from>to` / unbekannte ID → 400 mit Meldung; keine Daten →
  Header-only-CSV (kein Fehler).
- Atomares Schreiben (temp→rename) verhindert korrupte ZIPs bei Absturz mitten im Schreiben.
- Große Exporte: Aufbau im Speicher ist für Monats-Backups (klein) und typische manuelle Bereiche
  unkritisch; bekannte Grenze, spätere Streaming-Optimierung möglich (out of scope).

---

## 11. Tests (TDD, `node --test`)
- `csv-format.test.js`: Trennzeichen/Dezimal je Dialekt, Quoting (Feld mit Trennzeichen/`"`/
  Newline), `""`-Escaping, CSV-Injection-Prefix, BOM-Präfix, CRLF, Zahl-Formatierung (kein
  Float-Rauschen), leere Zelle.
- `csv-export.test.js`: Breit-Pivot (mehrere Kanäle → Spalten, leere Zellen bei Lücken,
  Zeitstempel-Gruppierung), Spaltenreihenfolge, Header-Block-Felder, Meldungs-CSV-Spalten + Art-
  Klassifizierung, leere Daten → Header-only, ISO+Offset/lokal inkl. **DST-Grenzfall**.
- `zip-writer.test.js`: Round-Trip (createZip → entpacken/inflate), CRC32-Korrektheit, mehrere
  Einträge, UTF-8-Dateiname-Flag, korrekte EOCD/Central-Directory-Offsets.
- `export-service.test.js` (In-Memory-DB): 1 Stelle → CSV, n Stellen → ZIP, includeEvents → ZIP
  mit 2 Dateien/Stelle (auch bei 1 Stelle), Metrik-Filter, Zeitraum-Filter.
- `backup-runner.test.js`: ZIP-Erzeugung für abgeschl. Monat, Idempotenz-Skip, Nachholen mehrerer
  Monate, (Stelle,Monat)-ohne-Daten-Skip, `computePruneFloor`-Werte, **Prune-Sperre** (un-
  gesicherter Monat wird nicht gelöscht), Safety-Valve bei 2×Retention, Health bei Schreibfehler,
  atomares temp→rename.
- `scheduler.test.js` (erweitern): `maybeRunBackupScan`-Drosselung, `effectiveCutoff`-Integration
  in die Bereinigung.
- `server.test.js` (erweitern): `GET /api/export/metadata`, `POST /api/export` (CSV- vs. ZIP-
  Content-Type + Content-Disposition + Validierungsfehler), Settings-Round-Trip neuer Keys.

---

## 12. Windows-Runnable-Checkliste (CLAUDE.md)
- Alle Pfade via `path.join(__dirname, …)`; `backup_dir` aus `DB_PATH` abgeleitet; nie hartkodierte
  `/`.
- Keine neue native Dependency (ZIP = reines Node-`zlib`); „nothing surprising" gewahrt.
- DB bleibt lokal (WAL); **nur** ZIP-Backups dürfen auf ein Netz-Share (`backup_dir`).
- Keine Inline-`VAR=value`-npm-Scripts; `HOST`/`PORT` unverändert.

## 13. Release-Schritte (0.11.0)
`VERSION`, README-Badge, `package.json`, **alle `?v=` in Klima Dashboard.html (11 Tags)**
synchron auf `0.11.0`; annotated Tag `v0.11.0`; `deploy/windows/`-Doku + §9-Acceptance um das
Backup-Verzeichnis/-Verhalten ergänzen; Windows-Acceptance erneut.

---

## 14. Bewusst außerhalb des Scope (YAGNI)
- Backup-Aufbewahrungs-Obergrenze / Auto-Pruning der ZIPs (unbegrenzt gewählt).
- Re-Backup spät eingetroffener Daten (first-wins).
- Streaming großer Exporte.
- Entfernen der Frontend-Berechnung von Taupunkt/abs. Feuchte → **separate Folgeaufgabe**.
- Andere Formate (XLSX/JSON), Zeitzonen-Wahl pro Stelle, E-Mail-Versand der Backups.
