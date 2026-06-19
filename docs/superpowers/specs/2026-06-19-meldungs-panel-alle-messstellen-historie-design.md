# Meldungs-Panel — alle Messstellen + lazy geladene Historie — Design

- **Datum:** 2026-06-19
- **Status:** Entwurf (zur Umsetzung freigegeben)
- **Zielversion:** 0.8.0 (MINOR — neues, abwärtskompatibles Feature)
- **Baut auf:** [2026-06-18-header-meldungs-detailpanel-design.md](2026-06-18-header-meldungs-detailpanel-design.md) (v0.5.0)

## 1. Problem & Ziel

Das in v0.5.0 eingeführte Detail-Panel (Klick auf die `top-summary`-Pille) zeigt aktuell nur
Messstellen **mit** anliegenden Meldungen und davon nur die **aktiven** Einträge. Ruhige
Stationen tauchen gar nicht auf, und es gibt keinen Weg, die **Historie** (aufgelöste
Meldungen) einer Station von hier aus zu sehen.

**Ziel:** Das Panel listet **immer alle Messstellen**. Ein Klick auf eine Messstelle erweitert
deren Eintrag und zeigt **scrollbar die Historie** ihrer Meldungen. Die Historie wird **nicht
komplett sofort** geladen, sondern seitenweise: zunächst die neuesten X, am Ende der Liste ein
**„weitere Einträge laden…"**. Stationen mit aktiven Meldungen sind beim Öffnen automatisch
aufgeklappt (aktive Alarme bleiben auf einen Blick sichtbar), ruhige Stationen erscheinen
eingeklappt.

Zusätzlich (vom Nutzer freigegebene Performance-Entlastung): der 5-s-Poll zieht heute die
**komplette** Event-Historie **jeder** Station über die Leitung. Er wird auf die neuesten ~50
Einträge je Station begrenzt.

## 2. Nicht-Ziele (Scope / YAGNI)

- **Keine** Änderung an `EventRow` (`tiles.jsx`) — die geteilte Komponente wird unverändert für
  aktive **und** historische Zeilen wiederverwendet.
- **Keine** Schema-/Persistenz-Änderung. Die `events`-Tabelle bleibt unverändert; der Endpoint
  bekommt nur Query-Parameter.
- **Kein** „alles laden"-Knopf, **kein** Auto-Infinite-Scroll. Nachladen passiert ausschließlich
  per explizitem „weitere Einträge laden…".
- **Keine** Suche / kein Filter innerhalb der Historie (bleibt der Alerts-Kachel vorbehalten).
- **Keine** Live-Aktualisierung bereits geladener Historie-Seiten. Die Historie ist ein
  Schnappschuss zum Ladezeitpunkt und wird beim erneuten Aufklappen neu geholt (§4.7).
- **Keine** Pro-Dot-Filterung der Pille (unverändert; ganze Pille ist ein Klick-Ziel).
- Der Poll wird **nicht** inkrementell/Delta-basiert umgebaut — nur durch ein `limit` begrenzt.
- **Keine** neuen JS-Dateien — alle betroffenen Module existieren bereits und werden erweitert.

## 3. Ausgangslage (was bereits existiert)

- **Panel heute:** `SystemSummaryPanel` (`summary-panel.jsx`) ruft `D.activeEventGroups()` →
  `groupActiveEventsByStation(STATIONS, STATION_ORDER)` (`summary-logic.js`). Dieser pure Helfer
  **überspringt** Stationen ohne aktive Events und filtert je Gruppe auf `active`. Gerendert wird
  je Event eine `EventRow`.
- **Trigger:** `SystemSummaryTrigger` (`summary-panel.jsx`) hält den `open`-State, schließt per
  Esc/Klick-außerhalb (`ss*`-Hook-Aliase). Liegt **außerhalb** der per-Tile-Error-Boundary →
  ein Wurf hier macht die Seite weiß (Memory-Gotcha) → das Panel muss eigene Fehler **lokal
  fangen**.
- **Datenpipeline:** `data.js` `refresh()` holt pro Station `/api/stations/:id/events` (ohne
  Limit → **alle** Events), mappt jede DB-Zeile inline (Zeilen ~229–242: `uuid→id`,
  `severity`, `message`, `metric`, `condition` via `alarmDirection`, `threshold`, `start_ts→
  startTs`, `end_ts→endTs`, `extreme`, `active`) und legt sie in `station.events` ab (sortiert
  `active` zuerst, dann `startTs` desc). Poll-Intervall 5 s.
- **Backend-Route:** `GET /api/stations/:id/events` (`server.js:186`) liefert
  `SELECT * FROM events WHERE station_id = ? ORDER BY active DESC, start_ts DESC` als **bares
  Array**, **ohne** Limit/Pagination. Einziger Aufrufer ist `data.js`.
- **Event-Konsumenten im Frontend** (alle lesen `station.events`):
  - `metricAlertStatus(station.events, id)` (`metrics-logic.js`) — wertet **nur aktive** Events.
  - `AlertsBody` (`tiles.jsx:325`) — `events`-Liste mit „Alle"/„Aktiv"/Schwere-Filtern, Zähler
    (nur aktive), `AlertTimeline`. Zeigt also **auch aufgelöste** Historie.
  - `countActive(s)` (`header.jsx:140`) im Stationswähler — zählt aktive Events.
- **`EventRow`** (`tiles.jsx:452`) rendert eine Zeile: Schwere-Tag, Headline, `ev-when`
  (`formatRelative(startTs)`), `ev-dur` = „läuft" (aktiv) bzw. `formatDuration(endTs−startTs)`.
  Nimmt `station` für Einheiten/Schwellen-Auflösung; fällt über `D.limitUnit` zurück.
- **Pure-Logik-Muster:** `summary-logic.js` / `metrics-logic.js` — IIFE, `module.exports` +
  `window`-Attach, keine DOM/fetch/Timer/`Date`. Getestet via `node --test`.
- **Test-Aufruf** (`package.json`): Backend per Glob `backend/tests/*.test.js` (neue Dateien
  werden automatisch erkannt); Frontend **explizit** gelistet (`metrics-logic.test.js`,
  `summary-logic.test.js`, `status-logic.test.js`) — `summary-logic.test.js` ist bereits dabei.
- **Versionsorte:** `package.json`, `package-lock.json`, `VERSION`, README-Badge, sowie alle
  `?v=<VERSION>`-Querys an den Skript-Tags in `Klima Dashboard.html` (Stale-Asset-Falle —
  müssen synchron mitgezogen werden).

## 4. Entwurf

### 4.1 Datenquellen-Trennung (Kern-Entscheidung)

Das Panel speist sich aus **zwei** klar getrennten Quellen:

1. **Aktive Meldungen** (oben je Station): kommen weiterhin **live aus dem Speicher**
   (`station.events`, gefiltert `active`). Klein, beschränkt, aktualisiert sich pro Poll. Erhält
   die „aktive Alarme auf einen Blick"-Prominenz.
2. **Historie** (aufgelöste Meldungen, darunter): wird **on-demand paginiert** über den
   erweiterten Endpoint geholt — erst beim Aufklappen, dann seitenweise per „weitere laden".

Damit entfällt die Spannung zwischen „aktive zuerst" und sauberer Cursor-Pagination: aktive
Events stehen immer oben (aus dem Speicher), die Historie darunter ist rein nach `start_ts DESC`
paginierbar.

### 4.2 Backend — ein parametrisierter Endpoint

`GET /api/stations/:id/events` wird um drei optionale Query-Parameter erweitert. Default-Antwort
bleibt ein **bares Array** (konsistent mit allen anderen Endpoints; kein `hasMore`-Feld).

| Param | Typ | Wirkung |
|---|---|---|
| `limit` | int > 0 | max. Zeilen. Fehlt/ungültig → kein Limit (heutiges Verhalten, abwärtskompatibel). |
| `active` | `'0'`/`'1'` | `'0'` → nur aufgelöste (`active = 0`), `'1'` → nur aktive (`active = 1`). Sonst → beide. |
| `before_ts` | int (ms) | Compound-Cursor-Anker. Fehlt/ungültig → ignoriert. |
| `before_rowid` | int | Compound-Cursor-Tiebreak. Nur zusammen mit `before_ts` wirksam. |

- **Compound-Cursor (robust gegen Zeitstempel-Gleichstand):** `start_ts` ist ms-Epoch aus
  sekunden-aufgelösten testo-Strings; mehrere Transitionen einer Station können denselben
  `start_ts` tragen. Ein striktes `start_ts < before` würde an Seitengrenzen einen Gleichstands-
  Eintrag **auslassen**. Daher Cursor `(start_ts < before_ts) OR (start_ts = before_ts AND
  rowid < before_rowid)`. Ist nur `before_ts` gesetzt → `start_ts < before_ts`.
- **Sortierung** `ORDER BY active DESC, start_ts DESC, rowid DESC` (Total-Order; spiegelt das
  bereits genutzte `scheduler.js:356`-Muster und die bewusst stabilen `rowid`s). Antwort enthält
  `rowid AS _rowid` für den Cursor.
- **Parameter-Robustheit:** `limit`/`before_ts`/`before_rowid` via `Number.parseInt`; nur
  übernehmen, wenn endlich (und für `limit` > 0). `active` nur `'0'`/`'1'`. Ungültige Werte
  ändern das Ergebnis nicht (kein 4xx nötig).
- **SQL** parametrisiert: `SELECT *, rowid AS _rowid FROM events WHERE station_id = ?
  [AND active = ?] [AND (start_ts < ? OR (start_ts = ? AND rowid < ?))] ORDER BY active DESC,
  start_ts DESC, rowid DESC [LIMIT ?]`.

**Zwei Aufrufmuster:**
- **Poll** (Entlastung): `?limit=50` → nur die 50 neuesten Zeilen je Station. Aktive Events immer
  dabei (active-first-Sortierung; max. aktive Events pro Station ≈ 10 = 5 Messwerte × 2 Schwere-
  grade ≪ 50). Korrektheits-Garantie für `metricAlertStatus`/Zähler bleibt damit erhalten.
- **Panel-Historie:** `?active=0&limit=<X>[&before_ts=<startTs>&before_rowid=<_rowid>]` (Cursor =
  letzter geladener Eintrag).

**`hasMore`** wird client-seitig abgeleitet: gelieferte Zeilen `=== limit` ⇒ es gibt
vermutlich mehr (eine evtl. überzählige Leer-Abfrage am exakten Ende ist akzeptabel).

### 4.3 Datenschicht (`data.js`)

- **Mapper extrahieren:** die heutige Inline-Abbildung (Zeilen ~229–242) wird zu einer
  modul-lokalen `mapBackendEvent(row)`-Funktion, die zusätzlich `_rowid: e._rowid` mitträgt.
  **Single source of truth** für Poll **und** Historie-Fetch (verhindert Feld-Drift).
- **Poll begrenzen:** in `refresh()` Fetch-URL `…/events` → `…/events?limit=${POLL_EVENT_LIMIT}`
  mit `const POLL_EVENT_LIMIT = 50;`.
- **Neuer Accessor** `stationOverview()` → `buildStationOverview(STATIONS, STATION_ORDER)` (§4.4).
- **Neue Methode** `async fetchStationHistory(stationId, { beforeTs, beforeRowid, limit })`:
  - Baut `…/events?active=0&limit=${limit}` und hängt `&before_ts`/`&before_rowid` an, wenn gesetzt.
  - `fetch` → bei `!res.ok` **wirft** sie (`throw new Error(...)`); mappt sonst jede Zeile via
    `mapBackendEvent` und gibt das Array zurück.
  - Sie fängt Fehler **bewusst nicht** selbst — der aufrufende Komponenten-State fängt und
    rendert den Fehlerzustand (§4.6). (Wurf bleibt damit innerhalb der React-Komponente
    abgefangen, erreicht nie den globalen Scope.)
- **`activeEventGroups()` entfällt** (einziger Konsument war das Panel, wird ersetzt).

### 4.4 Pure Logik (`summary-logic.js`): `groupActiveEventsByStation` → `buildStationOverview`

`groupActiveEventsByStation` wird zu `buildStationOverview` **verallgemeinert** (inkl. ruhiger
Stationen). Die alte Funktion und der `activeEventGroups()`-Wrapper werden **entfernt**; die
zugehörige Testdatei wird angepasst und erweitert (§7) — bewusster Rename+Erweitern, keine
stille Löschung.

**Signatur:** `buildStationOverview(stations, stationOrder)
→ Array<{ station, activeEvents, activeCount }>`

**Vertrag:**
- Für jede `id` in `stationOrder`: `station = stations[id]`. Fehlt das Objekt → **überspringen**
  (kein Crash).
- `activeEvents = (station.events || []).filter(e => e && e.active)`, sortiert nach Schwere-Rang
  aufsteigend (`alarm=0, warning=1, system=2`, unbekannt=99), dann `startTs` absteigend.
- `activeCount = activeEvents.length`.
- **Alle** Stationen werden aufgenommen, auch mit `activeCount === 0`.
- **Stations-Sortierung:**
  1. Stationen **mit** aktiven Events zuerst, dann ruhige (Primärschlüssel `activeCount > 0`).
  2. Innerhalb „mit aktiven": schwerster Schwere-Rang der Station aufsteigend, dann neuester
     aktiver `startTs` absteigend, dann ursprüngliche `stationOrder`-Position.
  3. Innerhalb „ruhig": ursprüngliche `stationOrder`-Position.
- Rein funktional, deterministisch; weiterhin `module.exports` + `window`-Attach.

### 4.5 Panel-Komponenten (`summary-panel.jsx`)

Neue Konstante in dieser Datei: `const PAGE_SIZE = 20;` (Panel-Seitengröße X).

- **`SystemSummaryPanel()`** — liest `D.stationOverview()`, rendert den Kopf
  „Meldungen · alle Messstellen" (Titel angepasst, da nun **alle** Stationen enthalten sind) und
  pro Station eine **`StationHistoryGroup`**. Leeres `stationOverview()` (keine Stationen
  bekannt) → Hinweiszeile im `.alerts-empty`-Stil.
- **`StationHistoryGroup({ station, activeEvents, activeCount })`** — eigene, gekapselte
  Komponente in **derselben Datei** (`ss*`-Hook-Aliase, da Babel-in-Browser globale `const`s
  kollidieren — Memory-Regel). **Alle Hooks unbedingt zuoberst**, vor jedem frühen Return
  (Rules-of-Hooks-Gotcha):
  - **State:** `expanded` (Init: `activeCount > 0`), `history` (`[]`), `loading` (`false`),
    `loaded` (`false`), `done` (`false`), `error` (`null`).
  - **Laden** via gemeinsame `loadPage()`:
    `cursor = letzter geladener Eintrag → { beforeTs: last.startTs, beforeRowid: last._rowid }`
    (leer bei der ersten Seite); ruft `D.fetchStationHistory(station.id, { ...cursor, limit:
    PAGE_SIZE })`; bei Erfolg anhängen (zusätzliche **Dedupe per Event-`id`** als Sicherheitsnetz),
    `loaded=true`, `done = (zurück.length < PAGE_SIZE)`; bei Wurf `error=<text>`, `loading=false`.
    Re-Entry-Schutz via `inflight`-Ref.
  - **Historie ist opt-in — KEIN Auto-Load-Effekt.** Das bloße Öffnen des Panels löst **null**
    Historie-Requests aus. Stattdessen klick-getrieben über `toggle()`:
    - **Ruhige Station** (`activeCount === 0`): wird nur zum Historie-Lesen aufgeklappt → das
      Aufklappen lädt die erste Seite sofort (`if (next && activeCount === 0 && !loaded) loadPage()`).
    - **Aktive Station** (auto-aufgeklappt für den Aktiv-Blick): zeigt die aktiven Zeilen +
      Button „Historie laden…"; die Historie wartet auf den expliziten Klick.
  - **Kopfzeile** (klickbar, toggelt `expanded`): Online-Punkt (`station-dot on/off`),
    Stationsname, `station-code`, Standort/online-Status; rechts der `activeCount`-Badge (nur
    wenn > 0) bzw. dezenter Hinweis „keine aktiven", dann Chevron (hoch wenn `expanded`, sonst
    runter). `aria-expanded`, klickbar/fokussierbar.
  - **Körper, wenn `expanded`:**
    1. `activeEvents` → je `EventRow event={e} station={station}` (aus dem Speicher, live).
    2. Bei `activeCount > 0` ein `── Historie ──`-Trenner (`.tsp-history-divider`), der die
       aktiven Zeilen vom Historie-Bereich/-Button trennt.
    3. Historie-Zeilen `history` → je `EventRow event={e} station={station}` (gedimmter
       Wrapper, EventRow selbst unverändert).
    4. Footer: `loading` → Ladezeile; sonst `error` → Fehlerzeile mit „erneut versuchen"
       (Retry ruft `loadPage()`); sonst `!loaded` → Button „Historie laden…" (der opt-in-Anker
       der aktiven Stationen, `loadPage()`); sonst `loaded && !done && history.length > 0` →
       „weitere Einträge laden…" (`loadPage()`); sonst `loaded && history.length === 0` →
       „Keine Meldungen vorhanden.".

`SystemSummaryTrigger` bleibt unverändert (rendert weiter `SystemSummaryPanel`, wenn offen).

### 4.6 Fehler- & Leerzustände

- **Historie-Fetch schlägt fehl** → Inline-Fehlerzeile **in dieser Station** („Historie konnte
  nicht geladen werden — erneut versuchen"), Panel bleibt stabil; Fehler wird im Komponenten-
  State gefangen, **nie geworfen** (Panel sitzt außerhalb der Error-Boundary).
- **Ruhige Station ohne jede Historie** → nach dem Laden „Keine Meldungen vorhanden.".
- **Lädt gerade** → schlanke Lade-/Skeletonzeile.

### 4.7 Live-Verhalten (bewusste Grenzen)

- Das Dashboard re-rendert pro 5-s-Poll (`D.subscribe`). `SystemSummaryPanel` liest dabei
  `D.stationOverview()` neu → **aktive** Zeilen und Kopf-Zähler laufen **live**.
- Jede `StationHistoryGroup` wird mit `key={station.id}` gerendert → React **erhält** ihren
  Historie-State über Re-Renders (kein Refetch bei jedem Poll).
- **Bewusste Grenze:** bereits geladene Historie-Seiten werden **nicht** live nachgeführt. Löst
  sich eine aktive Meldung auf, während das Panel offen ist, verschwindet sie aus dem aktiven
  Block; in der Historie taucht sie erst nach erneutem Aufklappen (Refetch) auf. Akzeptiert.
- **Bewusste Grenze:** `expanded` wird einmalig aus `activeCount > 0` initialisiert. Gewinnt eine
  ruhige (eingeklappte) Station eine aktive Meldung, während das Panel offen ist, klappt sie
  nicht automatisch auf — der Kopf-Zähler aktualisiert sich aber live, der Nutzer kann klicken.

### 4.8 Styling (keine neuen Tokens)

CSS im `<style>`-Block von `Klima Dashboard.html`, Farben/Radien aus bestehenden Variablen
(`--surface-*`, `--border*`, `--alarm`, `--warn`, `sev-*`):
- Klickbare Gruppen-Kopfzeile (`cursor: pointer`, Hover-Highlight, Chevron-Rotation
  ein-/ausgeklappt).
- `.tsp-history-divider` (Trenner mit „Historie"-Label), `.tsp-loadmore` (gestrichelter Button),
  `.tsp-quiet-hint` („keine aktiven"), `.tsp-loading`, `.tsp-error`.
- Historie-Zeilen in einem dezent gedimmten Wrapper (`opacity`/`--text-faint`); `.evrow` und
  `.alerts-empty` werden **unverändert** wiederverwendet.
- Panel behält `max-height` + `overflow-y: auto` (scrollbar bei vielen Stationen/Einträgen).

## 5. Betroffene Dateien

| Datei | Art | Zweck |
|---|---|---|
| `backend/server.js` | mod | `GET /api/stations/:id/events`: `limit`/`before`/`active` (§4.2) |
| `backend/tests/server.test.js` | mod | Tests für die neuen Query-Parameter (§7) |
| `Smart Meter Dashboard/summary-logic.js` | mod | `groupActiveEventsByStation` → `buildStationOverview` (§4.4) |
| `Smart Meter Dashboard/tests/summary-logic.test.js` | mod | an `buildStationOverview` anpassen + erweitern (§7) |
| `Smart Meter Dashboard/data.js` | mod | `mapBackendEvent`-Extraktion; Poll `?limit=50`; `stationOverview()`; `fetchStationHistory()`; `activeEventGroups()` entfernen |
| `Smart Meter Dashboard/summary-panel.jsx` | mod | `SystemSummaryPanel`-Umbau + `StationHistoryGroup` + Titel |
| `Smart Meter Dashboard/Klima Dashboard.html` | mod | neue CSS-Klassen; **alle** `?v=` → `0.8.0` |
| `package.json` | mod | Version `0.8.0` (Test-Liste unverändert — Dateien existieren bereits) |
| `package-lock.json` | mod | Version `0.8.0` |
| `VERSION` | mod | `0.8.0` |
| `README.md` | mod | Badge `0.8.0` |

**Keine neuen Skript-Tags** — alle Module existieren; nur `?v=`-Bump.

## 6. Randfälle

- **Poll-`limit=50` < aktive Events einer Station** (unrealistisch, ~10 max) — durch
  active-first-Sortierung wären aktive trotzdem zuerst; 50 hat komfortablen Puffer.
- **AlertsBody-Kachel** sieht durch `?limit=50` künftig nur noch die ~50 neuesten Events
  (bewusste, sichtbare Verhaltensänderung; tiefe Historie lebt im Panel).
- **`start_ts`-Gleichstand an Seitengrenzen** (mehrere Transitionen einer Station mit identischem
  `start_ts`, da testo-Zeitstempel sekunden-aufgelöst sind): durch den **Compound-Cursor
  `(start_ts, rowid)`** (§4.2) ausgeschlossen — keine Auslassung, kein Duplikat. Client-Dedupe
  per `id` bleibt als zweites Sicherheitsnetz.
- **`id` in `stationOrder` ohne Objekt in `stations`** → in `buildStationOverview` übersprungen.
- **`station.events` undefined** → als leer behandelt; Station erscheint als ruhig.
- **Offline-Station** → grauer Punkt, trotzdem gelistet und aufklappbar (Historie kann
  existieren).
- **Genau `PAGE_SIZE` Resteinträge** → eine zusätzliche Leer-/Kurz-Abfrage am Ende; harmlos,
  `done` greift dann.
- **Sehr viele Stationen/Einträge** → Panel scrollt (`max-height`/`overflow-y`).
- **System-Events** (`severity: 'system'`) erscheinen sowohl aktiv (oben) als auch in der
  Historie (active=0) korrekt über `EventRow`s System-Variante.

## 7. Tests

### 7.1 Backend (`backend/tests/server.test.js`, Glob-erkannt, `node --test`)
- `?limit=N` → höchstens N Zeilen, neueste zuerst.
- `?active=0` → nur aufgelöste; `?active=1` → nur aktive; ohne → beide.
- Antwort enthält `_rowid` (Integer) je Zeile.
- **Compound-Cursor mit `start_ts`-Gleichstand:** zwei aufgelöste Events mit identischem
  `start_ts` (verschiedene `rowid`); ein `limit=1`-Walk über `before_ts`+`before_rowid` liefert
  **beide** in lückenloser, disjunkter Reihenfolge — der Gleichstand wird **nicht** übersprungen.
- Sortierung `active DESC, start_ts DESC, rowid DESC` bleibt erhalten.
- Ungültige Parameter (`limit=abc`, `before_ts=xyz`, `active=2`) werden ignoriert (Ergebnis wie
  ohne Parameter).
- Station ohne Events → `[]`; `before_ts` jenseits aller Daten → `[]`.

### 7.2 Frontend pure (`Smart Meter Dashboard/tests/summary-logic.test.js`, `node --test`)
An `buildStationOverview` angepasst + erweitert:
- Leere Eingabe (`{}`, `[]`) → `[]`.
- **Alle** Stationen erscheinen, auch ruhige (`activeCount === 0`, `activeEvents: []`).
- Sortierung: Stationen mit aktiven Events vor ruhigen; unter den aktiven schwerste Schwere
  zuerst, dann neuester aktiver `startTs`; ruhige in `stationOrder`-Reihenfolge.
- `activeEvents` je Station korrekt gefiltert/sortiert (alarm vor warning vor system, neueste
  zuerst).
- Robustheit: `id` ohne Objekt → übersprungen, kein Wurf; `station.events` undefined → kein Wurf.

### 7.3 Lauf
`npm test` (Backend- + Frontend-Tests müssen grün bleiben).

## 8. Manuelle Verifikation (vor „fertig")

1. `npm test` grün (inkl. neuer/angepasster Tests).
2. `npm start`, Dashboard öffnen, Pille klicken: **alle** Messstellen sind gelistet; Stationen
   mit aktiven Meldungen aufgeklappt (aktive Zeilen oben), ruhige eingeklappt.
3. Aufklappen einer Station lädt die ersten `PAGE_SIZE` Historie-Einträge; „weitere Einträge
   laden…" hängt die nächste Seite an; verschwindet am Ende der Historie.
4. Ruhige Station ohne Historie → „Keine Meldungen vorhanden."; Klick-Außerhalb/Esc schließen.
5. Netzfehler simulieren (Backend kurz stoppen / `fetchStationHistory` scheitern lassen) →
   Inline-Fehlerzeile + „erneut versuchen", **kein** Weißbildschirm.
6. AlertsBody-Kachel funktioniert weiter (zeigt ~50 neueste Events, Zähler/Timeline korrekt).
7. Keine neuen Konsolen-Warnungen (Rules-of-Hooks, NaN-Attribute etc.).

## 9. Versionierung

MINOR-Bump **0.7.0 → 0.8.0**:
1. `package.json`, `package-lock.json`, `VERSION`, README-Badge auf `0.8.0`.
2. In `Klima Dashboard.html` **alle** `?v=0.7.0` → `?v=0.8.0`.
3. Commit der Feature-Arbeit + `chore: bump version to 0.8.0`.
4. Annotierter Tag `v0.8.0`, `git push --follow-tags` (lokal-only Repo: Tag genügt, Push entfällt,
   falls kein Remote konfiguriert ist).

## 10. Offene Punkte

Keine — alle Designfragen sind aufgelöst: Panel-Modell (aktive auf / ruhige zu, alle Stationen),
Lade-Strategie (paginierter Endpoint, on-demand), Poll-Entlastung (`limit=50`), Seitengröße
(`PAGE_SIZE = 20`), Quellentrennung (aktiv = Speicher / Historie = Endpoint), Scope wie §2.

**Grill-Revisionen (2026-06-19):** (1) Pagination per **Compound-Cursor `(start_ts, rowid)`**
statt striktem `< start_ts` — robust gegen Zeitstempel-Gleichstand (§4.2, §6). (2) Historie ist
**opt-in**: kein Auto-Load: Panel-Öffnen feuert null Requests; aktive Stationen zeigen „Historie
laden…", ruhige laden beim Aufklapp-Klick (§4.5). (3) Verifiziert: aufgelöste Events tragen
`end_ts` (`scheduler.js:330`/`:60`) → keine NaN-Dauer in der Historie.
