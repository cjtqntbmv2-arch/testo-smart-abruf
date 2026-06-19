# Angereicherte Statuskarten der Systemübersicht — Design

- Datum: 2026-06-19
- Status: Vom Nutzer abgenommen (Brainstorming abgeschlossen)
- Zielversion: 0.6.0 (MINOR — neues, rückwärtskompatibles Feature)
- Betroffene Dateien: `Smart Meter Dashboard/settings.jsx`, `Smart Meter Dashboard/Klima Dashboard.html` (CSS), neues `Smart Meter Dashboard/status-logic.js` (+ Test), `backend/server.js`, `backend/tests/`

## Problem

Auf der Seite *Einstellungen → Systemübersicht* zeigt jede `HealthCard` ein generisches Status-Badge (`OK` / `Achtung` / `Fehler`), das allein aus einem Status-Flag abgeleitet wird, während die große „Wert"-Überschrift oft eine unzusammenhängende Teil-Tatsache beschreibt. Folge: Widersprüche wie **„Schlüssel Aktiv" unter rotem „Fehler"-Badge**, ohne dass erkennbar ist, *was* schiefging oder *was zu tun* ist. Die rohe Fehlerursache liegt bereits im Payload (`systemStatus.scheduler.lastSyncError`), wird aber nicht angezeigt.

## Ziel

Jede Karte mit Status ≠ `ok` transportiert drei Dinge: ein klares **Status-Verdikt**, die **Ursache in Klartext** und den **nächsten Schritt (Aktion)**. Gewählte Tiefe: *Ursache + Aktion*. Gewählte Ursachendarstellung: *Klartext + Technik klein*. Gewählte Aktionen: *Navigation + Resync*.

## Gewählter Ansatz: A — Angereicherte Karte (in-place)

Das bestehende Karten-Raster bleibt. **Nur** Karten mit Status ≠ `ok` werden um Verdikt + Ursache + Aktion erweitert. Gesunde Karten (`ok`) bleiben unverändert (Wert + Sub-Zeile), damit der Normalfall ruhig bleibt und Probleme herausstechen. Ansätze B (Problem-Banner) und C (Detail-Aufklappung) sind bewusst zurückgestellt.

## Detaildesign

### 1. Verdikt-Überschrift (ersetzt den irreführenden „Wert" bei ≠ ok)

| Karte | Überschrift bei Fehler/Achtung |
|---|---|
| Testo Connect API | „Sync fehlgeschlagen" (err) · „Kein API-Schlüssel" (warn/nicht konfiguriert) |
| Hintergrund-Scheduler | „Synchronisation aus" |
| Messstellen | „N offline" (N = Anzahl offline) |
| Speicherbelegung | „Speicher fast voll" |

Im `ok`-Fall bleibt die Überschrift exakt wie heute („Schlüssel Aktiv", „4/4 online", „Intervall: 5 Min." …). Datenbank und Aufbewahrung sind aktuell immer `ok` → keine Anreicherung nötig.

### 2. Ursache (Klartext + Technik klein)

Neuer Bereich, nur bei ≠ ok gerendert:
- **Hauptzeile**: verständlicher Klartext.
- **Sekundärzeile** (klein, monospace): die Rohmeldung — nur, wenn sie zusätzlichen Diagnosewert hat.

Pure, testbare Hilfsfunktion `explainSyncError(raw)` in neuem `Smart Meter Dashboard/status-logic.js` (Muster wie `summary-logic.js`: dual-environment export, Unit-getestet via `node:test`). Mapping über Substring-Erkennung in `lastSyncError`:

| Erkannt in raw | Klartext |
|---|---|
| `No API Key` | „Kein API-Schlüssel hinterlegt." |
| `401` / `Unauthorized` / `invalid_token` | „Zugangsschlüssel wurde abgelehnt." |
| `403` / `Forbidden` | „Zugriff verweigert — Berechtigung prüfen." |
| `fetch failed` / `ENOTFOUND` / `ECONNREFUSED` / `ECONNRESET` | „Keine Verbindung zur testo-Cloud." |
| `timeout` / `ETIMEDOUT` | „Zeitüberschreitung bei der Anfrage." |
| `429` | „Zu viele Anfragen (Rate-Limit erreicht)." |
| `500`/`502`/`503`/`504` (5xx) | „testo-Cloud meldet einen Serverfehler." |
| (Default / unbekannt) | „Synchronisation fehlgeschlagen." + Rohtext in Sekundärzeile |

Per-Karte-Ursachenquellen:
- **API**: `explainSyncError(scheduler.lastSyncError)`; Rohtext = `lastSyncError`.
- **Messstellen**: nennt **welche** Station(en) offline sind (Namen liegen in `D.stations`). ⚠️ Eine Dauer („seit X") wird **nur** angezeigt, wenn ein verlässliches „zuletzt gesehen" verfügbar ist — sonst weglassen (kein Erfinden von Werten; vgl. Projekt-Regel „never fabricate"). Im Zweifel: nur Name + „offline".
- **Scheduler**: „Automatische Synchronisation ist ausgeschaltet."
- **Speicher**: „Weniger als 1 GB frei."

### 3. Aktionen

`HealthCard` erhält optionale `actions[]` (jeweils `{label, onClick, primary?}`):
- **API err**: `[Erneut synchronisieren]` (primär, POST /api/sync) + `[API-Schlüssel prüfen →]` (`onNavigate('api')`)
- **API warn (kein Schlüssel)**: `[API-Schlüssel hinterlegen →]` (`onNavigate('api')`)
- **Messstellen**: `[Messstellen öffnen →]` (`onNavigate('stations')`)
- **Scheduler**: `[Synchronisation aktivieren →]` (Ziel-Sektion mit Intervall/Schalter — in Umsetzung bestätigen, voraussichtlich `api` oder `advanced`)
- **Speicher**: `[Aufbewahrung anpassen →]` (`onNavigate('database')`)

### 4. Backend — einziger Eingriff: `POST /api/sync`

- Stößt `runSyncCycle()` an, wenn nicht bereits `isSyncing`.
- Antwort: `202 { started: true }`, bzw. bei laufendem Sync `{ started: false, reason: 'already-running' }` (Status 200 oder 409 — in Umsetzung festlegen, konsistent zur bestehenden Konvention).
- Kein Auth (lokale App), reiht sich in die bestehenden `/api/*`-Routen ein.
- Die Ursache braucht **keine** Backend-Änderung — `systemStatus.scheduler.lastSyncError` liefert den Rohtext bereits.

### 5. Frontend-Verdrahtung

- `SettingsPage` reicht `onNavigate={setSection}` und `onRefresh` (erneutes Laden von `systemStatus`) an `OverviewSection` durch.
- `HealthCard` bekommt optionale Props `cause` (Klartext), `causeRaw` (klein/mono), `actions[]` — nur gerendert, wenn vorhanden.
- Resync-Handler in `OverviewSection`: POST /api/sync → Button-Spinner-State → nach Antwort `onRefresh()`.
- **Hook-Alias-Hinweis**: Es wird **keine** neue `.jsx` angelegt (nur `settings.jsx` editiert + reines `status-logic.js` ohne Hooks), daher greift die Hook-Alias-Kollisionsfalle hier nicht.

### 6. Styling

Neues CSS in `Klima Dashboard.html` für `.hc-cause`, `.hc-cause-raw`, `.hc-actions` im bestehenden Dark-Look der Health-Cards. Verdikt nutzt weiter `.hc-value`. Buttons konsistent zu vorhandenen Settings-Buttons.

### 7. Tests + Verifikation

- Unit-Tests für `explainSyncError` (jeder Mapping-Fall + Default/Rohtext-Fallback) via `node:test`; in `npm test` aufnehmen.
- Backend-Test für `POST /api/sync` (startet Sync; doppelter Aufruf bei laufendem Sync startet nicht erneut).
- Live-Browser-Check mit erzwungenem Fehlerzustand (ungültiger/fehlender API-Schlüssel → API-Karte; eine Station offline → Messstellen-Karte): kein Widerspruch mehr, Ursache + Aktion sichtbar, Resync funktioniert.

### 8. Release

MINOR-Bump **0.5.0 → 0.6.0**: `VERSION`, README-Badge, `?v=`-Query der Script-Tags in `Klima Dashboard.html` synchron halten; Commit `chore: bump version to 0.6.0`; annotiertes Tag `v0.6.0`; Push mit `--follow-tags`.

## Nicht-Ziele

- Ansätze B (Banner) und C (Aufklappung) — zurückgestellt (A+B-Banner ggf. später, falls viele Komponenten).
- Keine Auth/keine externe Exposition des Resync-Endpunkts über lokale Nutzung hinaus.
- Keine Änderung an der `ok`-Darstellung gesunder Karten.

## Offene Punkte für die Umsetzung

1. Ziel-Sektion der Scheduler-Aktion (`api` vs. `advanced`) — am Code bestätigen, wo Intervall/Schalter liegen.
2. Messstellen-„zuletzt gesehen"-Dauer — nur aufnehmen, wenn ein verlässlicher Zeitstempel vorliegt.
3. HTTP-Status/Antwortform von `POST /api/sync` an bestehende Konvention angleichen.
