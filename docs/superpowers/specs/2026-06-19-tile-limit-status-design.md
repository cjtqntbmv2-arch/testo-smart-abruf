# Kachelwerte: Grenzwert-Status (Einfärbung + Richtungs-Dreieck) als Kachel-Option

- **Datum:** 2026-06-19
- **Status:** Entwurf freigegeben (Brainstorming)
- **Betrifft:** Frontend-Wert-Kacheln „Kennzahl" (`kpi`), „Linien-Diagramm" (`chart`), „Statistik" (`stats`)
- **Version-Ziel:** 0.5.0 → 0.6.0 (MINOR, abwärtskompatibles Feature) — finale Nummer beim Merge prüfen (siehe Versionierung)
- **Branch / Isolation:** `feat/tile-limit-status`, eigenes Worktree, abgezweigt von `master`. Parallel läuft `feat/status-cards-cause-action` (System-Overview-Cards) — siehe „Parallele Arbeit".

## Kontext & Problem

Seit v0.4.0 zeigt die „Linien-Diagramm"-Kachel an jeder Zahl einen **Grenzwert-Indikator** aus dem aktiven Meldungs-Feed (`station.events`): aktives Warning → gelbes Warndreieck, aktiver Alarm → roter Wert + rotes Dreieck (`MetricValue` + `AlertFlag` in `tiles.jsx`). Drei Lücken bleiben:

1. Bei **Warnung** wird der Messwert noch **nicht** eingefärbt (nur der Alarm färbt den Wert rot über `.cv-value.is-alarm`).
2. Das Dreieck signalisiert **nicht**, ob der **obere** oder **untere** Grenzwert verletzt ist — diese Richtung steckt bereits in den Events (`condition: 'high' | 'low'`), wird aber nirgends angezeigt.
3. Die Anzeige existiert **nur** in der Diagramm-Kachel. Die anderen Wert-Kacheln (`kpi`, `stats`) zeigen Grenzwertverletzungen gar nicht am Wert.

## Ziel

In allen **Wert-Kacheln** (`kpi`, `chart`, `stats`) wird der Grenzwert-Status **einheitlich** am Messwert dargestellt — als **pro Kachel abschaltbare Option** (Kontrollkästchen beim Erstellen/Bearbeiten, **Standard AN**):

1. **Wert-Einfärbung:** aktive Warnung → Wert in Warn-Farbe (dunkles Gelb); aktiver Alarm → Wert in Alarm-Farbe (Rot). Alarm schlägt Warnung.
2. **Warn-/Alarm-Symbol** (das bestehende Dreieck) neben dem Wert — wie heute in der Diagramm-Kachel, jetzt auch in `kpi` und `stats`.
3. **Richtungs-Dreieck** am Symbol: ▲ oben rechts = oberer Grenzwert überschritten (`high`), ▼ unten rechts = unterer Grenzwert unterschritten (`low`).
4. **Kein aktives Event** → Wert in Normalfarbe, kein Symbol.
5. Gilt für **alle in der Kachel gewählten Messwerte** gemeinsam (ein Kontrollkästchen pro Kachel).

## Nicht-Ziele (Out of Scope)

- **„Tachometer" (`gauge`) bleibt unberührt** — wird in einem **separaten** Schritt eigens angegangen. Kein Kontrollkästchen, keine Einfärbung, kein Symbol am Tacho in diesem Feature.
- **„Meldungen & Grenzwerte" (`alerts`)** bekommt **kein** Kontrollkästchen — die Kachel ist selbst die Alarmliste (kein Einzelwert), ihre Event-Zeilen zeigen Richtung/Schwere bereits (`EventRow`).
- **Keine Backend-/API-/DB-Änderung.** Status + Richtung werden ausschließlich aus vorhandenen Frontend-Daten (`station.events`) abgeleitet.
- Keine Änderung an `maxMetrics`, Tile-Layout-Mathematik oder Drag/Resize.
- **Keine Layout-Migration:** das Tile-Modell wird nur um ein optionales Feld erweitert; bestehende gespeicherte Layouts (`localStorage dash-layout-v3`) bleiben gültig und erhalten den Status automatisch (Default AN).

## Betroffene Dateien

- `Smart Meter Dashboard/metrics-logic.js` — neue reine Funktion `metricAlertState(events, metricId) → { severity, direction }`; `metricAlertStatus` delegiert daran (kein Verhaltensbruch). Dual-Export (Browser-Global + CommonJS).
- `Smart Meter Dashboard/tests/metrics-logic.test.js` — Node-Unit-Tests für `metricAlertState` (Richtung, Vorrang Alarm > Warnung, leere/inaktive Eingaben). Bestehende `metricAlertStatus`-Tests bleiben grün.
- `Smart Meter Dashboard/data.js` — `metricAlertState` über `window.DASH_DATA` durchreichen (neben `metricAlertStatus`, `metricTrend`).
- `Smart Meter Dashboard/tiles.jsx` —
  - `AlertFlag` → `LimitFlag({ severity, direction })`: bestehendes Dreieck-SVG + kleines Richtungs-Dreieck in der Ecke.
  - `MetricValue` (chart): Warn-Einfärbung + Richtung; Anzeige nur wenn Kachel-Option aktiv.
  - `KpiBody`, `StatsBody`: Status am Wert (Einfärbung + `LimitFlag`), nur wenn Option aktiv.
  - `TILE_TYPES`: Capability-Flag `supportsLimitFlags: true` an `kpi`, `chart`, `stats`.
  - Lese-Helfer für `tile.limitFlags` (Default AN).
- `Smart Meter Dashboard/app.jsx` — Kontrollkästchen in `AddTileDialog` (Schritt 4) und `EditTileDialog` (nur bei `supportsLimitFlags`); `addTile`/`updateTile` reichen `limitFlags` durch; Schritt-4-Vorschau berücksichtigt das Feld.
- `Smart Meter Dashboard/Klima Dashboard.html` — CSS: neues Token `--warn-strong`; `is-warning`-Einfärbung für `.cv-value`, `.kpi-value .num`, `.srow-v.current`; Richtungs-Dreieck `.lf-dir`; Kontrollkästchen-Stil; `?v=`-Cache-Buster auf neue Version.
- `VERSION`, `README.md` (Badge), `package.json` — Versions-Bump (finaler Schritt).

## Design

### 1. Datenschicht (`metrics-logic.js`)

Neue **reine Funktion** neben `metricAlertStatus`/`metricTrend`:

```
// Schlimmster aktiver Alarm/Warnung für eine Messgröße inkl. Richtung des verletzten Grenzwerts.
// events: [{ active, severity, metric, condition }]; condition ist bereits 'high'|'low' (alarmDirection()).
// → { severity: 'alarm'|'warning'|null, direction: 'high'|'low'|null }
function metricAlertState(events, metricId) {
  if (!Array.isArray(events) || !metricId) return { severity: null, direction: null };
  let warnDir = null;
  for (const e of events) {
    if (!e || !e.active) continue;
    if (e.severity === 'system') continue;            // System-Events haben keinen Messwert-Bezug
    if (e.metric !== metricId) continue;              // e.metric ist lowercased (siehe refresh())
    const dir = e.condition === 'low' ? 'low' : 'high';
    if (e.severity === 'alarm') return { severity: 'alarm', direction: dir };  // Alarm schlägt Warnung sofort
    if (e.severity === 'warning' && warnDir === null) warnDir = dir;            // erste aktive Warnung gewinnt
  }
  return warnDir ? { severity: 'warning', direction: warnDir } : { severity: null, direction: null };
}
```

`metricAlertStatus` wird zum Delegaten, damit bestehende Aufrufer/Tests unverändert bleiben:

```
function metricAlertStatus(events, metricId) { return metricAlertState(events, metricId).severity; }
```

Beide werden im Browser als Globals gesetzt und in Node exportiert; `data.js` reicht `metricAlertState` über `window.DASH_DATA` durch.

**Richtung:** Quelle ist `e.condition` (`alarmDirection()` mappt die API-Felder auf `'high'|'low'`, Default `'high'`). „high" = oberer Grenzwert überschritten (▲), „low" = unterer Grenzwert unterschritten (▼). Konsistent mit `EventRow`, das dieselbe `condition` als „über/unter" + ▲/▼ rendert.

### 2. Kachel-Option im Modell

- Neues optionales Tile-Feld **`limitFlags: boolean`**. **`undefined` gilt als AN** (Default überall, auch für bestehende gespeicherte Kacheln).
- Render-Gate (einheitlich): `const showLimitFlags = tile.limitFlags !== false;`
- `TILE_TYPES.{kpi,chart,stats}` erhalten `supportsLimitFlags: true`. `gauge` und `alerts` erhalten es nicht → kein Kontrollkästchen, keine Status-Anzeige.

### 3. Darstellung (`tiles.jsx`)

**`LimitFlag({ severity, direction })`** (ersetzt `AlertFlag`):
- rendert das bestehende Warn-/Alarm-Dreieck-SVG (`<path d="M7 2l6 10H1z"/>` + Ausrufezeichen), Farbe per Modifier `is-warning`/`is-alarm` wie heute;
- zusätzlich ein kleines Richtungs-Dreieck als Eckmarke: `<span class="lf-dir lf-dir-high">▲</span>` (oben rechts) bzw. `lf-dir-low` `▼` (unten rechts);
- `aria-label`/`title`: z. B. „Alarm aktiv · oberer Grenzwert" / „Warnung aktiv · unterer Grenzwert".

**Wert-Einfärbung** je Kachel-Body, nur wenn `showLimitFlags`:
- `MetricValue` (chart): `state = showLimitFlags ? D.metricAlertState(station.events, id) : { severity:null, direction:null }`. Wert-Klasse `is-warning`/`is-alarm`; `LimitFlag` mit `state`.
- `KpiBody` (`maxMetrics:1`): Status für `tile.metrics[0]`; `.kpi-value .num` erhält `is-warning`/`is-alarm`; `LimitFlag` neben Wert/Einheit.
- `StatsBody`: pro Zeile Status; die **„Aktuell"-Zelle** (`.srow-v.current`) erhält `is-warning`/`is-alarm`; `LimitFlag` in der Zelle nach dem Wert.

Hinweis Abgrenzung: Das 24-h-**Trend**-Dreieck der Kennzahl-Kachel (`.kpi-trend ▲/▼`) ist unabhängig vom **Grenzwert**-Richtungs-Dreieck am Symbol. Das Richtungs-Dreieck ist klein und sitzt direkt am Warnsymbol, nicht in der Trendzeile.

### 4. Dialog-Kontrollkästchen (`app.jsx`)

- `AddTileDialog`: State `limitFlags` (Default `true`). In **Schritt 4** (Bezeichnung) — nur wenn `cfg.supportsLimitFlags` — ein Kontrollkästchen „Grenzwert-Status an den Messwerten anzeigen". Schritt-4-Vorschau rendert den Body mit `{ …, limitFlags }`. `commit()` ruft `onAdd(type, stationId, metrics, title, limitFlags)`.
- `addTile(type, stationId, metrics, title, limitFlags)` (Signatur erweitert, abwärtskompatibel) speichert `limitFlags` am Tile (nur für unterstützte Typen relevant).
- `EditTileDialog`: State aus `tile.limitFlags !== false` initialisiert; gleiches Kontrollkästchen (nur unterstützte Typen); `onSave({ …, limitFlags })`.

### 5. CSS (`Klima Dashboard.html`)

- Neues Token **`--warn-strong: oklch(0.50 0.13 75)`** im `:root`. Die bereits **drei** vorhandenen Vorkommen dieses Literals (`.cv-flag.is-warning`, `.offline-banner svg`, ggf. weitere) werden auf das Token migriert (kleine, im Rahmen liegende Aufräumung), neue Vorkommen nutzen es ebenfalls.
- Wert-Einfärbung Warnung: `.cv-value.is-warning`, `.kpi-value .num.is-warning`, `.srow-v.current.is-warning` → `color: var(--warn-strong)`. Alarm-Pendants (`.is-alarm`) für `.kpi-value .num` und `.srow-v.current` ergänzen (`color: var(--alarm)`; `.cv-value.is-alarm` existiert bereits).
- Richtungs-Dreieck: `.cv-flag { position: relative }` + `.lf-dir { position:absolute; right:-4px; font-size:9–10px; line-height:1 }`, `.lf-dir-high { top:-4px }`, `.lf-dir-low { bottom:-5px }`. Farbe erbt vom `.cv-flag`-Modifier (`currentColor`).
- Kontrollkästchen-Zeile im Dialog: schlichter `.dialog-check`-Stil (Checkbox + Label), passend zu `.field`/`.dialog-foot`.

## Edge Cases

- **Kein aktives Event** für die Messgröße → keine Einfärbung, kein Symbol.
- **Warnung + Alarm gleichzeitig** auf derselben Messgröße → Alarm gewinnt (Rot + Alarm-Symbol), Richtung des Alarms.
- **`condition` fehlt/unbekannt** → `alarmDirection()`/Fallback ergibt `'high'` → ▲. Akzeptiert.
- **Reihe nur NaN/Lücken** → Wert „—"; Einfärbung/Symbol folgen weiterhin dem Event-Status (ein aktiver Alarm bei fehlendem Live-Wert zeigt „—" rot + Symbol — gewollt, der Alarm besteht).
- **Option AUS (`limitFlags === false`)** → Kachel zeigt nur reine Werte, keine Farbe/Symbole (auch die Diagramm-Kachel verliert dann ihr heutiges Dreieck — bewusst, da nun Option).
- **Bestehende gespeicherte Kacheln** (`limitFlags === undefined`) → AN; `kpi`/`stats` gewinnen die Anzeige automatisch, `chart` bleibt wie heute.
- **`gauge`/`alerts`** → unverändert; lesen `limitFlags` nicht, zeigen kein Kontrollkästchen.
- **Nicht klassifizierte Mess-Alarme** (`e.metric` nicht in `temperature|humidity|pressure|dewpoint|abshumid`, z. B. CO₂ der EMC-Station) → erhöhen Kopf-Zähler, lösen aber kein Symbol am Wert aus. Dieselbe metric-gefilterte Lücke wie heute; konsistent.

## Parallele Arbeit (Koordination mit `feat/status-cards-cause-action`)

Beide Branches sind inhaltlich unabhängig (dieses Feature: Wert-Kacheln + Dialoge; Status-Cards: System-Overview/Header). Überschneidende Dateien werden bewusst gehandhabt; Konflikte entstehen erst beim Merge:

- **`VERSION` / README-Badge / `package.json` / `?v=`:** nicht beide auf 0.6.0. Wer zuerst nach `master` mergt, nimmt 0.6.0; der zweite zieht auf 0.7.0 nach. **Versions-Bump bewusst als letzter Schritt** vor dem Merge.
- **`Klima Dashboard.html` (CSS) / `app.jsx`:** Änderungen lokal halten; kleine Merge-Konflikte beim Integrieren des zweiten Branches auflösen.
- **Worktree-Hygiene:** kein blindes `git add -A` (node_modules-Symlink-Falle); gezielt adden.

## Versionierung

MINOR-Bump **0.5.0 → 0.6.0** (neues, abwärtskompatibles Feature), synchron in `VERSION`, README-Badge (`version-0.6.0`), `package.json`, sowie `?v=0.6.0` in **allen** Script-Tags der `Klima Dashboard.html`. Projekt ist **lokal ohne Remote** → annotierter lokaler Tag `v0.6.0`, **kein Push/keine Remote-Sync**. Vor dem Tag: Konsistenz-Check (keine Stelle trägt die alte Version, kein `v0.6.0` existiert). Falls Status-Cards zuerst 0.6.0 belegt: hier 0.7.0/`v0.7.0`.

## Verifikation / Tests

- **Reine Logik** (`metricAlertState`): Node-Unit-Tests in `metrics-logic.test.js` (TDD: Richtung high/low, Vorrang Alarm > Warnung, System-Events ignoriert, leere/inaktive Eingaben → `{null,null}`). `metricAlertStatus`-Bestandstests bleiben grün. `npm test` muss vollständig grün sein (Baseline: 92).
- **Visuell, live** über die laufende App (Port 3000):
  - `kpi`-, `chart`-, `stats`-Kachel mit Messwerten anlegen; bei aktiver Warnung → gelber Wert + Symbol + ▲/▼ je Richtung; bei Alarm → roter Wert + Symbol + ▲/▼.
  - Kontrollkästchen im Erstell- und Bearbeiten-Dialog (nur diese drei Typen); AUS → reine Werte ohne Farbe/Symbol; Vorschau in Schritt 4 spiegelt die Wahl.
  - Regressionsblick: `gauge` und `alerts` unverändert; bestehende gespeicherte Kacheln zeigen den Status (Default AN).

## Offene Punkte

- Exakte Pixel-Platzierung/Größe des Richtungs-Dreiecks (`.lf-dir`) und die finale Warn-Wertfarbe werden in der Live-Verifikation feinjustiert (Startwert: `--warn-strong`).
- Engstand in der `stats`-„Aktuell"-Zelle (5-Spalten-Grid): falls Symbol + Richtung dort zu eng wird, im Plan kleinere Symbolgröße bzw. Umbruchregel festlegen.
