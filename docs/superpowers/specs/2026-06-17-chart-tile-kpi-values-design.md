# Diagramm-Kachel: KPI-Wertezeile mit Trend & Grenzwert-Indikator

- **Datum:** 2026-06-17
- **Status:** Entwurf freigegeben (Brainstorming)
- **Betrifft:** Frontend-Kachel „Linien-Diagramm" (`type: chart`)
- **Version-Ziel:** 0.3.0 → 0.4.0 (MINOR, abwärtskompatibles Feature)

## Kontext & Problem

Das Dashboard kennt zwei Kacheln mit Live-Werten einer Messstelle:

- **„Kennzahl"** (`kpi`, `KpiBody`): genau ein großer Wert + Trend (▲/▼ + %) + Sparkline. `maxMetrics: 1`.
- **„Linien-Diagramm"** (`chart`, `ChartBody`): 1–4 Messwerte einer Messstelle als Multi-Linien-Diagramm mit einer schlanken Legende darüber (Punkt · Name · aktueller Wert). `maxMetrics: 4`.

Der Wunsch: mehrere Messwerte **einer** Messstelle gebündelt anzeigen — alle Werte gleichberechtigt **über** einem Diagramm, mit **einer Linie je Messwert**, und mit dem KPI-Charakter (Wert + Trend) der Kennzahl-Kachel. Zusätzlich soll an jeder Zahl ein **Grenzwert-Indikator** sichtbar sein.

Die „Linien-Diagramm"-Kachel liefert den Diagramm-Teil bereits (eine Linie je Messwert über `LineChart`). Ihr fehlt nur der KPI-Charakter in der Kopfzeile: Die heutige Legende zeigt den aktuellen Wert, aber keinen Trend und keinen Grenzwert-Status.

## Ziel

Die „Linien-Diagramm"-Kachel erhält eine **angereicherte Wertezeile** über dem Diagramm:

1. Pro Messwert: farbiger Punkt + Label, aktueller Wert + Einheit (prominent), **Trend ▲/▼ + %** über ein **1-Stunden-Fenster**.
2. **Grenzwert-Indikator** je Wert, abgeleitet aus dem **aktiven Meldungs-Feed** (`station.events`):
   - aktives **Warning**-Event → kleines **gelbes Warndreieck** neben dem Wert,
   - aktives **Alarm**-Event → **Wert rot** + **rotes Warndreieck** (Alarm schlägt Warnung).
3. Das Multi-Linien-Diagramm bleibt unverändert.

## Nicht-Ziele (Out of Scope)

- Die **„Kennzahl"-Kachel** (`kpi`) bleibt vollständig unverändert (großer Einzelwert, 24-h-Trend, Sparkline, `maxMetrics: 1`).
- Keine Änderung an `maxMetrics` der Diagramm-Kachel (bleibt 4).
- **Keine Backend-/API-/Datenbank-Änderung.** Trend und Indikator werden ausschließlich aus bereits vorhandenen Frontend-Daten (`metrics[].series`, `station.events`, `timestamps`) berechnet.
- Kein konfigurierbares Trend-Fenster im UI (1 h ist eine Konstante; Änderung ist ein Einzeiler).
- Keine Migration gespeicherter Layouts (`localStorage` `dash-layout-v3`): Das Tile-Modell `{ stationId, metrics[] }` bleibt identisch; bestehende Diagramm-Kacheln gewinnen die neue Darstellung automatisch.

## Betroffene Dateien

- `Smart Meter Dashboard/metrics-logic.js` (neu) — reine, framework-freie Hilfsfunktionen `metricAlertStatus`, `metricTrend`; Dual-Export (Browser-Globals + CommonJS), damit isoliert mit `node --test` prüfbar.
- `Smart Meter Dashboard/tests/metrics-logic.test.js` (neu) — Node-Unit-Tests der reinen Logik.
- `Smart Meter Dashboard/data.js` — `metricAlertStatus`/`metricTrend` über `window.DASH_DATA` durchreichen; pro Station eigene `timestamps` am Stationsobjekt ablegen (messstellengenauer Trend).
- `Smart Meter Dashboard/tiles.jsx` — `ChartBody` umbauen (Wertezeile mit Trend + Indikator); Komponenten `MetricValue` + `AlertFlag`; `LineChart` erhält die messstellengenaue Zeitachse.
- `Smart Meter Dashboard/Klima Dashboard.html` — neuer `<script>` (vor `data.js`); CSS für Wertezeile + Indikator; `?v=`-Cache-Buster auf neue Version.
- `package.json` — Test-Script führt zusätzlich die Frontend-Logik-Tests aus; Versions-Bump.
- `VERSION`, `README.md` (Badge) — Versions-Bump.

## Design

### 1. Datenschicht (`metrics-logic.js`, eingebunden über `data.js`)

Zwei **reine Funktionen** (keine Seiteneffekte, keine DOM-Abhängigkeit) in einem eigenen Modul `metrics-logic.js`, damit die Logik isoliert mit `node --test` prüfbar ist und zwischen Komponenten geteilt werden kann. Das Modul setzt im Browser Globals und exportiert in Node per `module.exports`; `data.js` reicht die Funktionen über `window.DASH_DATA` durch.

**`metricAlertStatus(events, metricId) → 'alarm' | 'warning' | null`**

```
function metricAlertStatus(events, metricId) {
  if (!Array.isArray(events) || !metricId) return null;
  let warning = false;
  for (const e of events) {
    if (!e.active) continue;
    if (e.severity === 'system') continue;     // System-Events haben keinen Messwert-Bezug
    if (e.metric !== metricId) continue;        // e.metric ist bereits lowercased (siehe refresh())
    if (e.severity === 'alarm') return 'alarm'; // Alarm schlägt Warnung sofort
    if (e.severity === 'warning') warning = true;
  }
  return warning ? 'warning' : null;
}
```

- Quelle ist `station.events` — dieselbe, die Kopf-Zähler und „Meldungen"-Kachel speist. Damit ist der Indikator **messstellengenau** (Events hängen pro Gerät/Messstelle) und konsistent mit dem Rest der App.
- Das Vokabular von `e.metric` ist identisch zu den Frontend-Metric-IDs (`temperature`, `humidity`, `pressure`, `dewpoint`, `abshumid`) — die „Meldungen"-Kachel filtert bereits über `allowed.has(e.metric)` mit genau diesen IDs.

**`metricTrend(series, timestamps, windowMs = 3600000) → { delta, pct, hasTrend }`**

- `last` = letzter gültiger (numerischer, nicht NaN) Wert der Reihe.
- `ref` = Wert am Sample, dessen Zeitstempel `last_ts − windowMs` am nächsten liegt; gibt es kein Sample ≥ `windowMs` zurück, Rückfall auf den **ältesten** gültigen Wert.
- `delta = last − ref`, `pct = delta / (ref || 1) * 100`.
- `hasTrend = false`, wenn `last` oder `ref` fehlt (→ Anzeige „—", kein Pfeil), analog zur heutigen Absicherung in `KpiBody`.
- `windowMs` ist parametrisiert; `ChartBody` ruft mit `3600000` (1 h) auf. Die Kennzahl-Kachel bleibt bei ihrer eigenen 24-h-Rechnung und wird **nicht** umgestellt.

Beide Funktionen werden auf `window.DASH_DATA` exponiert (neben `stats`, `limitUnit`).

### 2. Kachel-Body (`ChartBody` in `tiles.jsx`)

`ChartBody` rendert künftig:

```
<div class="chart-wrap">
  <div class="chart-values">            // war: chart-legend
     {tile.metrics.map(id => <MetricValue ... />)}
  </div>
  <div class="chart-area">
     <LineChart metricIds={tile.metrics} stationId={station.id} timestamps={…} />
  </div>
</div>
```

Neue, kleine Komponente **`MetricValue`** (lokal in `tiles.jsx`), zuständig für genau einen Wert in der Zeile:

- Eingaben: `metric` (aus `station.metrics[id]`), `series`, `timestamps`, `status` (aus `metricAlertStatus`), `compact`/`narrow` (aus `useSize`).
- Darstellung:
  - Punkt (`metric.color`) + `metric.label`.
  - Wert: `last.toFixed(metric.decimals)` + `metric.unit`; bei `status === 'alarm'` Wert-Farbe `var(--alarm)`.
  - Trend: `▲/▼ |delta| metric.unit (±pct %)`; Zeitraum-Hinweis „1 h".
  - Indikator-Dreieck rechts neben dem Wert:
    - `warning` → Dreieck in `var(--warn)`,
    - `alarm` → Dreieck in `var(--alarm)`,
    - `null` → kein Dreieck.
- Das Dreieck verwendet dasselbe SVG wie die Alarm-Zeile in `EventRow` (`<path d="M7 2l6 10H1z"/>` + Ausrufezeichen), `aria-label`/`title` z. B. „Alarm aktiv" / „Warnung aktiv".

### 3. Responsives Verhalten

- Container-Größe via `useSize(ref)` (bestehendes Muster, siehe `AlertsBody`).
- Wertezeile ist ein `flex-wrap`-Container: mehrere Werte brechen bei schmaler Kachel um.
- Schwellen (Richtwerte, im Plan zu fixieren):
  - **niedrig** (`h < ~150` px): Prozentangabe ausblenden, nur `▲/▼ |delta|`.
  - **sehr niedrig / sehr schmal**: Trendzeile ganz ausblenden, nur Punkt + Label + Wert (+ Indikator).
- Das Diagramm (`chart-area`) füllt den Rest der Höhe wie bisher (`flex: 1`).
- Mindestgröße der Kachel bleibt `minSize {w:3, h:3}` — die reduzierten Stufen stellen sicher, dass Wertezeile + Diagramm dort noch sinnvoll passen.

### 4. CSS (`Klima Dashboard.html`)

- `.chart-values` als flex-wrap-Zeile (ersetzt bzw. erweitert `.chart-legend`).
- `.cv-item`, `.cv-label`, `.cv-value`, `.cv-unit`, `.cv-trend` (Wiederverwendung der Trend-Optik aus `.kpi-trend` / `.trend.up` / `.trend.down`).
- `.cv-value.is-alarm { color: var(--alarm); }`.
- `.cv-flag` für das Dreieck; Farbe per `currentColor`, gesetzt über Modifier `is-warning` (`var(--warn)`) / `is-alarm` (`var(--alarm)`).
- Keine neuen Farb-Tokens — `var(--alarm)` und `var(--warn)` existieren bereits.

## Edge Cases

- **Keine Messwerte zugewiesen** → bestehender `Empty`-Zustand.
- **Messstelle gelöscht** → bestehender `EmptyDeleted`-Zustand.
- **Reihe enthält nur NaN/Lücken** (Sensor liefert die Größe nicht) → Wert „—", kein Trend, kein Indikator.
- **Kein aktives Event für die Messgröße** → kein Dreieck, Wert in Normalfarbe.
- **Mehrere aktive Events derselben Messgröße** → schlimmster Schweregrad gewinnt (Alarm > Warnung).
- **Zu wenige Datenpunkte für 1 h** → Rückfall auf ältesten Wert; reicht auch das nicht, kein Trend.
- **Ein Messwert in der Diagramm-Kachel** → Wertezeile mit einem Eintrag; Diagramm wie heute (inkl. Flächenfüllung bei Single-Metric).

## Versionierung

MINOR-Bump **0.3.0 → 0.4.0** (neues, abwärtskompatibles Feature). Synchron in:

- `VERSION`
- `README.md` Badge (`version-0.4.0`)
- `package.json` (`"version": "0.4.0"`)
- `Smart Meter Dashboard/Klima Dashboard.html` — `?v=0.4.0` in allen **6** Script-Tags (`metrics-logic.js`, `data.js`, `charts.jsx`, `tiles.jsx`, `settings.jsx`, `app.jsx`)
- annotierter Tag `v0.4.0` + Push (`git push --follow-tags`) gemäß Versionsregel.

Vor dem Tag: Konsistenz-Check, dass keine Stelle die alte Version trägt und kein `v0.4.0` existiert.

## Verifikation / Tests

- **Reine Logik** (`metricAlertStatus`, `metricTrend`): in `metrics-logic.js` ausgelagert und über `node --test` (analog `backend/tests/`) als reine Funktionen getestet; im Browser setzt dasselbe Modul nur Globals. `npm test` führt Backend- und Frontend-Logik-Tests aus.
- **Visuell, live** über Chrome in der laufenden App (Port 3000): eine „Linien-Diagramm"-Kachel mit mehreren Messwerten anlegen und prüfen:
  - Wertezeile zeigt Wert + Einheit + 1-h-Trend,
  - aktives Warning → gelbes Dreieck, aktiver Alarm → rote Zahl + rotes Dreieck (es sind aktuell aktive Meldungen vorhanden),
  - Umbruch/Reduktion bei kleiner Kachel,
  - Diagramm unverändert mit einer Linie je Messwert,
  - „Kennzahl"-Kachel unverändert (Regressionsblick).

## Bekannte Einschränkung (für diese Version akzeptiert)

Der Indikator feuert nur für Events mit zugeordneter Messgröße (`e.metric` ∈ `temperature | humidity | pressure | dewpoint | abshumid`). Ein **Mess-Alarm auf einem Kanal, den `mapPhysicalProperty` nicht klassifiziert** (Rückgabe `null` — z. B. CO₂ auf der EMC-Station, derselbe Kanal hinter dem benignen `measurementsUnmatched: 1`), erhöht den Alarm-Zähler im Kopf, löst aber **kein** Dreieck an einer Zahl aus. Das ist dieselbe metric-gefilterte Lücke, die die „Meldungen"-Kachel heute schon hat (`allowed.has(e.metric)`), und damit konsistent. System-Meldungen (Akku/Verbindung) sind ein separater Fall ohne Messwert-Bezug. Falls künftig nicht-zuordenbare Mess-Alarme sichtbar gemacht werden sollen, ist das eine eigene Erweiterung (z. B. ein Sammel-Hinweis an der Kachel).

## Offene Punkte

- Trend-Fenster ist als **1 h** festgelegt; bei Bedarf später anpassbare Konstante.
