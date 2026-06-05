# Design: Entfernung des lokalen Grenzwert-Subsystems

- **Datum:** 2026-06-05
- **Status:** Freigegeben (Brainstorming abgeschlossen)
- **Betrifft:** `Smart Meter Dashboard/` (Frontend); Backend unverändert
- **Release:** 0.1.7 → 0.1.8 (MINOR — Feature-Entfernung)

## Problem

Der Header oben links zeigt „0 Meldungen aktiv", obwohl auf einer Kachel ein
Alarm aktiv ist. Ursache: Es existieren **zwei parallele Alarm-Quellen**, die
unterschiedlich gezählt werden.

1. **API/Backend-Events** — `/api/stations/:id/events` und `/api/totals`,
   gespeist aus der `events`-Tabelle, die der Scheduler aus dem
   Testo-Alarm-Feed (`fetchAlarms`) und synthetischen System-Events füllt.
   Liefert `alarm`, `warning` und `system`.
2. **Lokale Grenzwert-Events** — client-seitig in `data.js`
   (`generateLocalThresholdEvents`) aus den Messreihen gegen
   `DEFAULT_THRESHOLDS` bzw. localStorage-Grenzwerte berechnet.

Kombiniert werden sie in `data.js` (`station.events = [...backendEvents,
...localEvents]`). Der Header liest `totalActive()` → `/api/totals` (nur
Tabelle, aktuell leer → 0), während die Kacheln die kombinierte Liste inkl.
lokalem Druck-Alarm der EMC-Station zeigen (1001,2 hPa < lokaler Alarm-Grenzwert
1008 hPa). Daher die Diskrepanz.

## Entscheidung

Alarme und Warnungen werden **ausschließlich** aus dem API-Abruf bestimmt. Das
client-seitige Grenzwert-System wird **vollständig entfernt** (Code und UI).
Eine grenzwertbasierte Einfärbung von Messwerten existiert heute faktisch nicht
(Werte/Sparklines nutzen die feste Metrik-Farbe `M.color`; `classify` ist als
öffentliche API toter Code) — der tote `classify`-Export wird mitentfernt.

## Architektur nachher — eine einzige Alarm-Quelle

- `data.js` holt pro Station weiterhin `/api/stations/:id/events` und global
  `/api/totals`. `station.events` enthält **nur** Backend-Events.
- Header (`totalActive()` → `/api/totals`) und Kachel-Zähler
  (`station.events`) stammen aus derselben Quelle → per Konstruktion
  konsistent. Der gemeldete Bug ist damit behoben; der Header-Wert 0 war
  eigentlich korrekt.

## Änderungen im Detail

### `Smart Meter Dashboard/data.js` — entfernen
- `DEFAULT_THRESHOLDS`
- `getThresholdsForStation`, `saveThresholdsForStation` (inkl.
  localStorage-Key `dash-thresholds-<sid>` als Schreib-/Lesepfad)
- `classify` (interne Funktion **und** toter öffentlicher API-Export)
- `thresholdValue`
- `generateLocalThresholdEvents`
- das Kombinieren: `station.events = [...backendEvents, ...localEvents]` wird
  zu `station.events = backendEvents`
- das `thresholds`-Feld am Stationsobjekt (Aufbau in `refresh()` und im
  Seed-Block)
- öffentliche API-Methoden: `setThreshold`, `recomputeStationEvents`,
  `classify`, sowie der `thresholds`-Getter

### `Smart Meter Dashboard/data.js` — unverändert behalten
- `totalActive()` (liest `/api/totals`)
- der Events-Fetch und das API-Event-Mapping (liefert `severity`, `metric`,
  `threshold`, `extreme`, `condition`, `message`, `detail`, `active`)
- `stats`, `refresh`, Polling, alle Formatierungshelfer

### `Smart Meter Dashboard/app.jsx` — entfernen
- Komponente `ThresholdDialog` (Grenzwert-Editor)
- State `thresholdOpen`
- Render-Verdrahtung von `ThresholdDialog`
- die `onOpenSettings`-Zuweisung für die alerts-Kachel
  (`if (t.type === "alerts") ...`)

### `Smart Meter Dashboard/tiles.jsx` — entfernen
- der Zahnrad-/Settings-Button auf der Meldungs-Kachel, der den Editor öffnete

### `Smart Meter Dashboard/tiles.jsx` — unverändert behalten
- Event-Anzeige: `SummaryPill`, `EventRow`, Filter, Zählung. Rendert künftig
  nur API-Events; die benötigten Felder liefert das API-Event-Mapping bereits.

## Bewusst nicht im Scope (YAGNI)

- Verwaiste `dash-thresholds-<sid>`-Keys in localStorage bleiben liegen
  (harmlos; kein Code liest sie mehr).
- `settings.jsx` Notification-Routing (`notifications.routing.alarm`) bleibt —
  betrifft Benachrichtigungskanäle, nicht lokale Grenzwerte.
- Backend (`scheduler.js`, `server.js`, `db.js`) bleibt komplett unverändert —
  die API-Seite ist die gewünschte Quelle.

## Release

Feature-Entfernung = MINOR-Bump **0.1.7 → 0.1.8**:
- `package.json`, `VERSION`, README-Badge
- Cache-Buster `?v=0.1.8` an den Script-Tags (`data.js`, `*.jsx`) in
  `Klima Dashboard.html` — sonst greift die Stale-Asset-Falle und die Änderung
  wird vom Browser nicht geladen
- annotiertes Tag `v0.1.8`, Push mit `git push --follow-tags`

## Verifikation

- App starten, Dashboard öffnen: Header und EMC-Kachel zeigen beide
  **keine aktiven Alarme** (kein Testo-Alarm aktiv), keine Konsolen-Fehler
  durch entfernte API-Aufrufe / fehlende Felder.
- `npm test` (Backend) weiterhin grün — unverändert, dient als
  Regressionsschutz.
