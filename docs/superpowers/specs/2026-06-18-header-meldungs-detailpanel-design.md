# Header-Meldungs-Detailpanel — Design

- **Datum:** 2026-06-18
- **Status:** Entwurf (zur Umsetzung freigegeben)
- **Zielversion:** 0.5.0 (MINOR — neues, abwärtskompatibles Feature)

## 1. Problem & Ziel

Der Header zeigt in der `top-summary`-Pille drei Zähler-Dots (Alarm / Warnung / System)
„über alle Messstellen". Sie nennen nur **Anzahlen**, nicht **was** wo los ist. Wer wissen
will, welche Meldung an welchem Gerät/Messwert anliegt und seit wann, muss raten oder die
einzelnen Stationen/Kacheln durchgehen.

**Ziel:** Ein Klick auf die `top-summary`-Pille öffnet ein Detail-Panel, das **alle aktiven
Meldungen aller Messstellen** auflistet — gruppiert nach Gerät — mit Messwert, Schwellen-
Kontext und „seit wann". So ist auf einen Blick erkennbar: *welcher Fehler/Alarm an welchem
Gerät / Messwert besteht und seit wie lange*.

## 2. Nicht-Ziele (Scope / YAGNI)

- **Keine** Pro-Dot-Filterung (Klick auf nur den Alarm-Dot → nur Alarme). Die ganze Pille ist
  ein Klick-Ziel; das Panel zeigt alles gruppiert.
- **Keine** Timeline und **keine** Filter-Pills im Header-Panel (die bleiben der Alerts-Kachel
  vorbehalten).
- **Keine** Historie / Inaktiv-Ansicht im Header — nur aktive Meldungen.
- **Keine** Backend-Änderung. Alle Daten liegen bereits im Client (siehe §3).
- **Keine** neuen Farb-/Design-Tokens. Schwere-Farben kommen aus den vorhandenen `sev-*`-Stilen.
- `EventRow` wird **unverändert** wiederverwendet (kein Eingriff in die geteilte Komponente).

## 3. Ausgangslage (was bereits existiert)

- **Header-Pille:** `Header` in `app.jsx` rendert `<div className="top-summary">` mit drei
  `SummaryDot`-Komponenten, gespeist aus `D.totalActive()` (= `/api/totals`, globale Zähler).
- **Detaildaten pro Station:** `D.stations[id].events[]` trägt je Event:
  `severity` ('alarm' | 'warning' | 'system'), `metric` (Frontend-Messwert-ID, kleingeschrieben),
  `startTs`, `endTs`, `message`, `detail`, `threshold`, `condition` ('high'|'low'),
  `extreme`, `active`. Stations-Meta (`name`, `code`, `location`, `online`) liegt am
  Stations-Objekt.
- **`EventRow`** (`tiles.jsx`) rendert genau eine Meldungszeile: Schwere-Tag, Headline
  („Temperatur ▲ über 25 °C"), `ev-when` = `formatRelative(startTs)` („vor 2 h") und
  `ev-dur` = „läuft" (aktiv) bzw. Dauer. Nimmt eine `station`-Prop für die Einheiten-/
  Schwellen-Auflösung (`station.metrics[e.metric]`, Fallback `D.limitUnit`).
- **Konsistenz-Fakt:** `/api/totals` zählt `SUM(... active = 1 ...) FROM events` über *alle*
  Stationen; `/api/stations/:id/events` liefert dieselbe `events`-Tabelle pro Station. Die Summe
  der aktiven Pro-Station-Events entspricht also den Header-Zählern — Pille und Panel bleiben
  zwangsläufig konsistent. Garantiert durch `events.station_id` FK `ON DELETE CASCADE` +
  `foreign_keys = ON` (db.js) — keine verwaisten Events; einziger theoretischer Rest wäre ein
  Event mit `station_id = NULL`, das der Scheduler nicht erzeugt.
- **Muster für Popover:** `StationSelector` (`app.jsx`) zeigt die etablierte Mechanik:
  `wrap`-Ref + Trigger-Button + `pop`-Container, schließt per Esc und Klick-außerhalb, mit
  rotierendem Chevron.
- **Muster für pure Logik + Tests:** `metrics-logic.js` definiert pure Funktionen, hängt sie an
  `window` (Browser) und `module.exports` (Node) und wird via `Smart Meter Dashboard/tests/
  metrics-logic.test.js` (`node --test`) getestet. `data.js` exponiert dünne Wrapper.
- **Ladereihenfolge:** Alle Skripte laden seriell; `app.jsx` mountet den React-Root als letzte
  Zeile (`ReactDOM.createRoot(...).render(<App/>)`). Neue Komponenten-Dateien müssen **vor**
  `app.jsx` geladen werden. Dateiübergreifende Komponenten-Referenzen funktionieren bereits
  (`app.jsx` nutzt `TILE_BODIES` aus `tiles.jsx`).

## 4. Entwurf (Ansatz: neue, isolierte Dateien + Klick-Trigger)

### 4.1 Interaktion & Affordanz

- Die `top-summary`-Pille wird ein **Button** (Klick-Ziel). Klick öffnet/schließt das Panel
  darunter.
- **Affordanz:** `cursor: pointer`, dezenter Hover-Highlight und ein kleines **Chevron (▾)**
  rechts neben „über alle Messstellen" (rotiert bei geöffnetem Panel, analog `StationSelector`).
- **Schließen:** Esc und Klick-außerhalb (Effekt-Hook 1:1 aus `StationSelector` übernommen).
- `aria-expanded`, `aria-haspopup="true"` am Trigger; das Panel ist per Tastatur erreichbar/
  scrollbar.

### 4.2 Pure Hilfe: `groupActiveEventsByStation`

Neues Modul `Smart Meter Dashboard/summary-logic.js` (Muster wie `metrics-logic.js`:
IIFE, `module.exports` + `window`-Attach, keine DOM-/fetch-/Timer-/`Date`-Zugriffe — voll pur).

**Signatur:** `groupActiveEventsByStation(stations, stationOrder) → Array<{ station, events }>`

**Vertrag:**
- Für jede `id` in `stationOrder`: `station = stations[id]`. Fehlt das Objekt → Gruppe
  überspringen (kein Crash).
- `events = (station.events || []).filter(e => e && e.active)`. Ist die Liste leer → Gruppe
  **weglassen**.
- **Event-Sortierung je Gruppe:** nach Schwere-Rang aufsteigend, dann `startTs` **absteigend**
  (neueste zuerst). Schwere-Rang: `alarm = 0`, `warning = 1`, `system = 2`.
- **Gruppen-Sortierung:** nach kleinstem (schwerstem) Schwere-Rang der Gruppe aufsteigend
  (Geräte mit Alarm zuerst), dann nach **neuestem** `startTs` der Gruppe absteigend.
  Stabiler Tie-break: ursprüngliche `stationOrder`-Reihenfolge.
- Rein funktional; identische Eingabe → identische Ausgabe.

`data.js` exponiert den dünnen Wrapper:
`activeEventGroups() { return groupActiveEventsByStation(STATIONS, STATION_ORDER); }`

### 4.3 Panel-Komponenten & Dateiaufteilung

`app.jsx` hat bereits **844 Zeilen** (> 400-Schwelle für GUI-Entry-Dateien). Neue UI kommt
daher in eine eigene Datei `Smart Meter Dashboard/summary-panel.jsx`:

- **`SystemSummaryTrigger({ totals })`** — `wrap`-Ref + Button (die Pille mit den drei
  `SummaryDot`s + Label + Chevron), hält `open`-State, rendert `SystemSummaryPanel` wenn offen,
  verkabelt Esc/Klick-außerhalb.
- **`SystemSummaryPanel()`** — liest `D.activeEventGroups()`, rendert Leerzustand **oder** die
  gruppierte Liste.
- **`SummaryDot`** wird aus `app.jsx` **hierher verschoben** (nur von der Summary genutzt →
  Co-Location, verkleinert die GUI-Entry-Datei).

`app.jsx`-Änderung (in `Header`): der Block
`{!inSettings && (<div className="top-summary">…drei SummaryDots…</div>)}`
wird ersetzt durch `{!inSettings && <SystemSummaryTrigger totals={totals} />}`.

### 4.4 Panel-Aufbau & `EventRow`-Wiederverwendung

Pro Gruppe (= Gerät) ein Abschnitt:
- **Gruppenkopf:** Online-Punkt (`station-dot on/off`) · Stationsname · `station-code` ·
  Standort, rechts ein Mini-Zähler `events.length`.
- **Meldungen:** je Event eine `<EventRow event={e} station={group.station} />` (nicht
  `compact` → voller Detailgrad). `station` ist das Gerät der Gruppe → korrekte Einheiten/
  Schwellen.
- „**Seit wie lange**" wird durch `EventRow` abgedeckt: `ev-when` zeigt „vor 2 h" (= seit wann),
  `ev-dur` zeigt „läuft" für aktive Meldungen. *Entscheidung:* `EventRow` bleibt unverändert
  (geteilte Komponente, geringeres Risiko). Eine explizitere Dauer („seit 2 h 15 min") ist
  bewusst nicht Teil dieses Specs.

### 4.5 Leerzustand

Keine aktiven Meldungen (`D.activeEventGroups()` leer) → Panel zeigt eine Zeile „Keine aktiven
Meldungen" im Stil der vorhandenen `.alerts-empty` (Häkchen-Icon + Text). Der Trigger bleibt
klickbar.

### 4.6 Live-Aktualisierung

Das Dashboard re-rendert bereits pro 5-s-Poll (die Header-Zähler laufen live über
`D.subscribe`). `SystemSummaryPanel` liest `D.activeEventGroups()` bei jedem Render → zeigt
stets den aktuellen Stand, inklusive Meldungen, die sich auflösen (Gruppe verschwindet) oder
neu auftreten.

### 4.7 Positionierung / Overflow

- Popover absolut unter dem Trigger (`.top-summary-wrap { position: relative }`,
  `.top-summary-pop { position: absolute; top: 100% }`).
- `max-height: 60vh; overflow-y: auto` für viele Meldungen; sinnvolle `min-width`/`max-width`
  (~320–420 px).
- Die Pille sitzt mittig im Header → das Panel muss gegen den Viewport-Rand abgesichert sein
  (rechts-/linksbündig oder zentriert, in der Umsetzung visuell verifizieren, damit nichts
  abgeschnitten wird).
- `z-index` über dem Grid (analog `station-pop`).

### 4.8 Barrierefreiheit

`aria-expanded`/`aria-haspopup` am Trigger; Esc schließt; Klick-außerhalb schließt;
`:focus-visible`-Outline am Button. Pragmatisch auf dem Niveau von `StationSelector`.

### 4.9 Styling (keine neuen Tokens)

CSS im `<style>`-Block von `Klima Dashboard.html`:
- `.top-summary` als Button: Button-Reset (border/bg/font), Pille-Optik erhalten,
  `cursor: pointer`, Hover-/`[aria-expanded="true"]`-Highlight, `.chev`-Rotation.
- `.top-summary-wrap`, `.top-summary-pop`, `.tsp-group`, `.tsp-group-head`, `.tsp-count`,
  `.tsp-empty` — neue Layout-Klassen, die Farben/Radien/Schatten aus bestehenden Variablen
  (`--surface-*`, `--border*`, `--alarm`, `--warn`, `sev-*`) beziehen.
- `.evrow` und `.alerts-empty` werden unverändert wiederverwendet.

## 5. Betroffene Dateien

| Datei | Art | Zweck |
|---|---|---|
| `Smart Meter Dashboard/summary-logic.js` | **neu** | pure `groupActiveEventsByStation` |
| `Smart Meter Dashboard/tests/summary-logic.test.js` | **neu** | Node-Unit-Tests dazu |
| `Smart Meter Dashboard/summary-panel.jsx` | **neu** | `SystemSummaryTrigger`, `SystemSummaryPanel`, verschobener `SummaryDot` |
| `Smart Meter Dashboard/app.jsx` | mod | `Header`: Pille → `<SystemSummaryTrigger/>`; `SummaryDot` entfernt |
| `Smart Meter Dashboard/data.js` | mod | `activeEventGroups()` exponieren |
| `Smart Meter Dashboard/Klima Dashboard.html` | mod | 2 neue Skript-Tags (`summary-logic.js`, `summary-panel.jsx`); CSS; alle `?v=` → 0.5.0 |
| `package.json` | mod | Version 0.5.0; Testdatei `summary-logic.test.js` ergänzen |
| `package-lock.json` | mod | Version 0.5.0 |
| `VERSION` | mod | 0.5.0 |
| `README.md` | mod | Badge 0.5.0 |

**Skript-Reihenfolge in der HTML:** `summary-logic.js` nach `metrics-logic.js` und vor
`data.js`; `summary-panel.jsx` nach `tiles.jsx` und vor `app.jsx`.

**Test-Befehl** (`package.json`) listet Frontend-Tests **explizit** (kein Glob, wegen
Leerzeichen im Pfad). Den neuen Test als weiteres explizites Argument anhängen, z. B.:
`… node --test "Smart Meter Dashboard/tests/metrics-logic.test.js" "Smart Meter Dashboard/tests/summary-logic.test.js"`.

## 6. Randfälle

- **Keine aktiven Meldungen** → Leerzustand (§4.5).
- **Station in `stationOrder`, aber nicht in `stations`** → Gruppe übersprungen, kein Crash.
- **`station.events` undefined/leer** → als leer behandelt, Gruppe weggelassen.
- **Mehrere Geräte gleichzeitig betroffen** → mehrere Gruppen, schwerste-Schwere-Gruppe zuerst.
- **Sehr viele Meldungen** → Panel scrollt (`max-height` + `overflow-y`).
- **`metric` ohne Eintrag in `station.metrics`** (z. B. Druck an Feuchte-Sonde) → `EventRow`
  fällt bereits über `D.limitUnit` auf die Einheit zurück (vorhandenes Verhalten).
- **System-Event** (`severity: 'system'`, `metric` evtl. null) → `EventRow` rendert seine
  System-Variante (Batterie/Verbindung/Wartung); im Vertrag Rang 2, erscheint zuletzt.

## 7. Tests

`tests/summary-logic.test.js` (`node --test`, Muster wie `metrics-logic.test.js`):
- Leere Eingabe (`{}`, `[]`) → `[]`.
- Station ohne aktive Events → ausgelassen; nur inaktive Events → ausgelassen.
- Inaktive Events werden herausgefiltert, aktive bleiben.
- Mehrere Geräte: Gruppe mit Alarm steht vor Gruppe mit nur Warnung.
- Event-Sortierung je Gruppe: alarm vor warning vor system; bei gleichem Rang neueste
  `startTs` zuerst.
- Gruppen-Tie-break: gleiche schwerste Schwere → Gruppe mit neuerem `startTs` zuerst.
- Robustheit: `id` in `stationOrder` ohne Objekt in `stations` → übersprungen, kein Wurf;
  `station.events` undefined → kein Wurf.

Lauf über `npm test` (Backend- + Frontend-Tests müssen grün bleiben).

## 8. Manuelle Verifikation (vor „fertig")

1. `npm test` grün (inkl. neuer Tests).
2. `npm start`, Dashboard öffnen: Pille klicken → Panel mit Gruppen je Gerät; je Zeile korrekter
   Messwert/Schwelle + „seit wann".
3. Esc und Klick-außerhalb schließen das Panel; Chevron rotiert.
4. Leerzustand sichtbar, wenn keine aktiven Meldungen.
5. Live-Update: nach einem Poll spiegelt das Panel Änderungen (neue/aufgelöste Meldung).
6. Keine neuen Konsolen-Warnungen (Rules-of-Hooks etc.).

## 9. Versionierung

MINOR-Bump **0.4.2 → 0.5.0**:
1. `package.json`, `package-lock.json`, `VERSION`, README-Badge auf `0.5.0`.
2. In `Klima Dashboard.html` alle `?v=0.4.2` → `?v=0.5.0` **und** die zwei neuen Skript-Tags mit
   `?v=0.5.0` einfügen.
3. Commit der Feature-Arbeit + `chore: bump version to 0.5.0`.
4. Annotierter Tag `v0.5.0`, `git push --follow-tags`.

## 10. Offene Punkte

Keine — alle Designfragen sind aufgelöst (Interaktion: Klick-Dropdown; Gliederung: nach Gerät;
Sortierung: schwerste Schwere zuerst; `EventRow` voll, unverändert; Scope wie §2).
