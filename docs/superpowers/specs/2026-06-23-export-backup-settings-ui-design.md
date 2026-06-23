# Datenexport — UI für das automatische Monats-Backup — Design / Spec

- **Datum:** 2026-06-23
- **Status:** Entwurf (Design mit Nutzer abgestimmt)
- **Betrifft:** Bedienoberfläche im Datenexport-Menü, um das bereits existierende automatische Monats-Backup ein-/auszuschalten, den Speicherpfad zu setzen und den Lauf-Status zu sehen.
- **Voraussetzung-Spec:** [2026-06-22-csv-export-backup-design.md](2026-06-22-csv-export-backup-design.md) (Backend-Feature, in v0.11.0 geliefert).

---

## 1. Kontext & Ziel

Das automatische Monats-Backup ist serverseitig seit v0.11.0 **vollständig implementiert und aktiv** ([backend/backup-runner.js](../../../backend/backup-runner.js), verdrahtet in [scheduler.js:447](../../../backend/scheduler.js)). Es fehlt jedoch **jede Bedienoberfläche** dafür: Im Dashboard ist nur der manuelle CSV-Export sichtbar ([export-panel.jsx](../../../Smart%20Meter%20Dashboard/export-panel.jsx)). Der Nutzer kann das Backup weder ein-/ausschalten noch den Zielordner ändern noch sehen, ob es läuft.

**Ziel:** Im Datenexport-Menü eine kompakte Untersektion ergänzen, die drei Dinge bietet:
1. Backup **ein-/ausschalten** (`backup_enabled`).
2. **Speicherpfad** setzen (`backup_dir`, leer = Standard).
3. **Status** anzeigen (letzter Lauf / Zustand / zuletzt geschriebene ZIP).

**Ausdrücklich nicht im Umfang (mit Nutzer geklärt):** Ein wählbares **Intervall**. Das Backend ist fest auf Kalendermonate gebaut (`candidateMonths()`, ZIP-Namen `<Messstelle>_YYYY-MM.zip`, Prune-Floor). Eine echte Granularitätswahl (wöchentlich/täglich) wäre ein Backend-Umbau; der Nutzer hat sich bewusst für „bei monatlich bleiben, kein Intervall-Wähler" entschieden.

## 2. Constraints

| Constraint | Wert |
|---|---|
| Backend | **unverändert** — `backup_enabled`/`backup_dir` in `POST /api/settings`, Status in `GET /api/status` existieren bereits |
| Frontend-Stack | React via Babel-in-Browser, **kein Build-Schritt**; alle `.jsx` werden global in einen Scope konkateniert |
| Dateigröße | `export-panel.jsx` bleibt unter ~400 Zeilen (GUI-Entry-Regel) |
| Script-Tags | **kein** neuer Script-Tag → keine 13. `?v=`-Cache-Buster-Position |
| Hook-Aliase | vorhandene Aliase aus `export-panel.jsx` wiederverwenden (`useStateE`, `useEffectE`, `useMemoE`) — keine bare `useState`-Globals (Kollisionsgefahr) |
| Sprache | Deutsch (UI-Texte), wie im restlichen Dashboard |

## 3. Gewählter Ansatz & verworfene Alternativen

**Gewählt (Ansatz A): Eigenständige Komponente `BackupSettings()` in [export-panel.jsx](../../../Smart%20Meter%20Dashboard/export-panel.jsx).** Eine zweite Komponentenfunktion in derselben Datei mit eigenem State, eigenem Laden und Speichern. `ExportPanel` rendert am Ende `<BackupSettings />` als eigene Untersektion **unter** dem manuellen Export. Nutzt die vorhandenen Hook-Aliase → kein neuer Script-Tag, keine zusätzliche Release-Buchhaltung. Löst nebenbei den seit dem ersten Commit veralteten Kopfkommentar ein, der einen „backup-status block" verspricht.

**Verworfen:**
- **Ansatz B — in `settings.jsx` unter „Aufbewahrung".** Widerspricht dem „unter Datenexport"-Wunsch und koppelt an die fragile K1-Hydration-Gate-Debounce-Logik dort.
- **Ansatz C — neue Datei `export-backup.jsx` + neuer Script-Tag.** Sauberere Trennung, aber 13. `?v=`-Cache-Buster, eigene eindeutige Hook-Aliase nötig, mehr Release-Bürokratie ohne echten Mehrwert bei der kleinen Größe.

## 4. Platzierung & Aufbau

Im Datenexport-Menü (Sektion `"export"`, gerendert via [settings.jsx:219](../../../Smart%20Meter%20Dashboard/settings.jsx)) folgt **unter** dem bestehenden manuellen Export eine neue Untersektion:

```
SectionHead  "Automatisches Monats-Backup"
             sub: kurze Erklärung (monatliche ZIPs je Messstelle, läuft selbsttätig nach jedem Sync)

Card
  Field "Automatisches Backup"   → Toggle (Ein/Aus)
  Field "Speicherpfad"           → Text-input + Button "Speichern" (+ inline-Fehler)

Card  (Status-Block, schreibgeschützt)
  Zustand · Letzter Scan · Zuletzt geschrieben
```

## 5. Bedienelemente

### 5.1 Ein/Aus-Schalter
- Komponente: `Toggle` (dieselbe wie beim manuellen Export).
- Bindet an `backup_enabled`.
- **Speichert sofort** per `POST /api/settings { backup_enabled: <bool> }`; danach `GET /api/status` neu laden, damit der Status-Block den neuen Zustand spiegelt.
- Kann nicht fehlschlagen (keine Validierung).

### 5.2 Speicherpfad
- Komponente: `Field` mit Text-`input` + Button „Speichern".
- Bindet an `backup_dir`. **Leeres Feld = Standard** (`<db-verzeichnis>/backups`).
- **Platzhalter** zeigt den aufgelösten Standardpfad aus `status.backup.dir` (z.B. `…\ProgramData\TestoSmartAbruf\backups`), damit klar ist, wohin „leer" schreibt.
- Speichern per `POST /api/settings { backup_dir: <string> }`.
- **Validierung im Backend:** Bei nicht beschreibbarem Pfad antwortet das Backend mit `400 { error: "backup_dir nicht beschreibbar: …" }`. Diese Meldung wird **inline rot** unter dem Feld angezeigt (gleiches `export-error`-Muster wie im manuellen Export). Bei Erfolg: kurzes „Gespeichert ✓"-Flash + `GET /api/status` neu laden.

### 5.3 Status-Block (schreibgeschützt)
Quelle: `GET /api/status` → `backup = { enabled, dir, lastScanDate, health }`, wobei `health = { status, lastScan, lastZip, lastError, written }` ist (und `health = {}`, solange noch kein Scan lief).

Anzeige-Logik:
- **Backup aus** (`enabled === false`): gedämpfter Hinweis „Automatisches Backup ist ausgeschaltet" — keine weiteren Detailzeilen.
- **`health` leer** (nie gelaufen): grauer Hinweis „Noch kein Backup gelaufen".
- **`health.status === 'ok'`**: grün „Aktiv".
- **`health.status === 'error'`**: rot, zeigt `health.lastError`.
- Detailzeilen (wenn vorhanden): „Letzter Scan" = `lastScanDate` (sonst „—"); „Zuletzt geschrieben" = `health.lastZip` (+ ggf. `health.written` Anzahl).
- **Status/Settings-Fetch schlägt fehl:** Block zeigt „Status nicht verfügbar"; Bedienelemente bleiben nutzbar.

## 6. Datenfluss

1. **Mount:** `BackupSettings` lädt parallel `GET /api/settings` (für `backup_enabled`, `backup_dir`) und `GET /api/status` (für `health`/Status-Block).
2. **Nutzer schaltet Toggle:** optimistischer State-Update → `POST /api/settings` → bei Antwort `GET /api/status` neu laden.
3. **Nutzer speichert Pfad:** `POST /api/settings` → bei `ok` Flash + `GET /api/status` neu laden; bei `400` Fehlermeldung inline.
4. **Aktualisierung:** Status wird **bei Mount und nach jedem Speichern** geladen. **Kein** Live-Poll (Backups laufen max. 1×/Tag; mit Nutzer bestätigt). Falls später Live-Anzeige gewünscht: 10-s-`setInterval` analog `settings.jsx` nachrüstbar.

## 7. Fehlerbehandlung

- Pfad nicht schreibbar → Backend-`400`-Meldung inline, **kein** Throw, **kein** leerer Screen.
- `GET /api/status`/`/api/settings` schlägt fehl → „Status nicht verfügbar", Bedienelemente bleiben bedienbar.
- `health = {}` (nie gelaufen) sauber abgefangen (eigener Zweig, kein Zugriff auf `undefined.status`).
- Komponente bleibt innerhalb der bestehenden Per-Tile-Error-Boundary; Hooks werden **vor** jedem early return aufgerufen (Projekt-Regel gegen Hook-Order-Bugs).

## 8. Tests & Verifikation

Reines Frontend (Babel-in-Browser) — für die `.jsx` existiert keine Unit-Test-Harness. Verifikation per **Preview** (manuelle Akzeptanz):
1. Block lädt fehlerfrei (Konsole sauber, kein Blank-Screen).
2. Toggle persistiert: aus-/einschalten → Reload zeigt neuen Stand; Status-Block spiegelt `enabled`.
3. Ungültiger Pfad (z.B. nicht existierendes/Read-only-Verzeichnis) → rote Inline-Meldung, Stand bleibt unverändert.
4. Gültiger Pfad → „Gespeichert ✓", Status-Block zeigt aufgelösten Pfad.
5. „Nie gelaufen"-Fall (`health = {}`) zeigt grauen Hinweis statt Fehler.

Die Backend-Pfade (Scan, Prune-Floor, `backup_dir`-Validierung) sind bereits durch [backend/tests/backup-runner.test.js](../../../backend/tests/backup-runner.test.js) und den `POST /api/settings`-Handler abgedeckt — **unverändert**.

## 9. Release-Bürokratie (bei Fertigstellung)

Neues Feature (Frontend) → **MINOR-Bump**, voraussichtlich **0.12.0**:
- `VERSION`, README-Badge, `package.json` `version`.
- **Alle 12 `?v=`-Cache-Buster** in `Klima Dashboard.html` synchron bumpen (kein neuer Script-Tag).
- Git-Tag `v0.12.0` (annotiert) + Push mit `--follow-tags`.

## 10. Offene Punkte / bewusst zurückgestellt

- **Live-Poll des Status** zurückgestellt (s. §6.4) — bei Bedarf trivial nachrüstbar.
- **Intervall-Wähler** bewusst nicht im Umfang (s. §1) — würde Backend-Umbau erfordern.
- **„Jetzt sichern"-Button** (manueller Backup-Anstoß) nicht im Umfang — nicht angefragt; das Backend holt verpasste Monate ohnehin beim nächsten Sync nach.
