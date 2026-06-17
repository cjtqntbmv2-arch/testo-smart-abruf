# Diagramm-Kachel: KPI-Wertezeile mit Trend & Grenzwert-Indikator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die „Linien-Diagramm"-Kachel zeigt über dem Diagramm eine KPI-Wertezeile (Wert + 1-h-Trend pro Messwert) mit einem aus dem aktiven Meldungs-Feed abgeleiteten Grenzwert-Indikator (gelbes Dreieck bei Warnung, rote Zahl + rotes Dreieck bei Alarm).

**Architecture:** Zwei reine, isoliert getestete Hilfsfunktionen (`metricAlertStatus`, `metricTrend`) in einem neuen, framework-freien Modul `metrics-logic.js`, das im Browser Globals setzt und in Node per `require` testbar ist. `ChartBody` (in `tiles.jsx`) rendert die Wertezeile über eine neue `MetricValue`-Komponente; das bestehende `LineChart` bleibt unverändert. Kein Backend-/DB-/API-Eingriff.

**Tech Stack:** React (Babel-im-Browser, kein Build), Vanilla-JS-Modul, `node --test` (node:test/node:assert), better-sqlite3-Backend bleibt unangetastet.

**Spec:** `docs/superpowers/specs/2026-06-17-chart-tile-kpi-values-design.md`

**Branch:** `feat/chart-tile-kpi-values` (bereits angelegt, Spec committet)

---

## Dateien-Überblick

- **Neu** `Smart Meter Dashboard/metrics-logic.js` — reine Logik (`metricAlertStatus`, `metricTrend`); Dual-Export (Browser-Globals + CommonJS).
- **Neu** `Smart Meter Dashboard/tests/metrics-logic.test.js` — Node-Unit-Tests der reinen Logik.
- **Ändern** `package.json` — Test-Script führt zusätzlich die Frontend-Logik-Tests aus; Versions-Bump.
- **Ändern** `Smart Meter Dashboard/data.js` — `metricAlertStatus`/`metricTrend` über `DASH_DATA` exponieren; pro Station eigene `timestamps` am Stationsobjekt ablegen.
- **Ändern** `Smart Meter Dashboard/tiles.jsx` — `ChartBody` auf Wertezeile umstellen; neue Komponenten `MetricValue` + `AlertFlag`.
- **Ändern** `Smart Meter Dashboard/Klima Dashboard.html` — neuer `<script>`-Tag (Ladereihenfolge vor `data.js`); CSS für `.chart-values`/`MetricValue`/Indikator; `?v=`-Bump.
- **Ändern** `VERSION`, `README.md` — Versions-Bump 0.3.0 → 0.4.0.

---

## Task 1: Reine Metric-Helfer + Node-Tests (TDD)

**Files:**
- Create: `Smart Meter Dashboard/metrics-logic.js`
- Test: `Smart Meter Dashboard/tests/metrics-logic.test.js`
- Modify: `package.json` (Test-Script)

- [ ] **Step 1: Test-Datei schreiben (schlägt fehl, Modul fehlt)**

Create `Smart Meter Dashboard/tests/metrics-logic.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { metricAlertStatus, metricTrend } = require('../metrics-logic.js');

test('metricAlertStatus: active alarm outranks warning', () => {
  const events = [
    { active: true, severity: 'warning', metric: 'temperature' },
    { active: true, severity: 'alarm', metric: 'temperature' },
  ];
  assert.strictEqual(metricAlertStatus(events, 'temperature'), 'alarm');
});

test('metricAlertStatus: only active warning -> warning', () => {
  assert.strictEqual(
    metricAlertStatus([{ active: true, severity: 'warning', metric: 'humidity' }], 'humidity'),
    'warning'
  );
});

test('metricAlertStatus: inactive events ignored', () => {
  assert.strictEqual(
    metricAlertStatus([{ active: false, severity: 'alarm', metric: 'temperature' }], 'temperature'),
    null
  );
});

test('metricAlertStatus: system events ignored', () => {
  assert.strictEqual(
    metricAlertStatus([{ active: true, severity: 'system', metric: 'temperature' }], 'temperature'),
    null
  );
});

test('metricAlertStatus: other metric ignored', () => {
  assert.strictEqual(
    metricAlertStatus([{ active: true, severity: 'alarm', metric: 'pressure' }], 'temperature'),
    null
  );
});

test('metricAlertStatus: non-array / missing id -> null', () => {
  assert.strictEqual(metricAlertStatus(null, 'temperature'), null);
  assert.strictEqual(metricAlertStatus([{ active: true, severity: 'alarm', metric: 'temperature' }], null), null);
});

test('metricTrend: 1h window delta and pct', () => {
  const H = 3600000, t0 = 1_000_000_000_000;
  const r = metricTrend([18, 20, 23], [t0, t0 + H, t0 + 2 * H], H);
  assert.strictEqual(r.hasTrend, true);
  assert.strictEqual(r.last, 23);
  assert.strictEqual(r.ref, 20);
  assert.strictEqual(r.delta, 3);
  assert.ok(Math.abs(r.pct - 15) < 1e-9);
});

test('metricTrend: falls back to earliest when series shorter than window', () => {
  const H = 3600000, t0 = 1_000_000_000_000;
  const r = metricTrend([10, 12], [t0, t0 + 10 * 60000], H);
  assert.strictEqual(r.hasTrend, true);
  assert.strictEqual(r.ref, 10);
  assert.strictEqual(r.delta, 2);
});

test('metricTrend: all NaN -> no trend', () => {
  assert.strictEqual(metricTrend([NaN, NaN], [1, 2], 3600000).hasTrend, false);
});

test('metricTrend: empty series -> no trend', () => {
  assert.strictEqual(metricTrend([], [], 3600000).hasTrend, false);
});

test('metricTrend: ref 0 uses ||1 to avoid divide-by-zero', () => {
  const H = 3600000, t0 = 1e12;
  const r = metricTrend([0, 5], [t0, t0 + H], H);
  assert.strictEqual(r.ref, 0);
  assert.strictEqual(r.delta, 5);
  assert.strictEqual(r.pct, 500);
});
```

- [ ] **Step 2: Test-Script in `package.json` ergänzen**

Modify `package.json` `scripts.test` (currently `"NODE_ENV=test node --test backend/tests/*.test.js"`) to also run the frontend-logic test:

```json
"test": "NODE_ENV=test node --test backend/tests/*.test.js && NODE_ENV=test node --test \"Smart Meter Dashboard/tests/metrics-logic.test.js\""
```

- [ ] **Step 3: Tests ausführen — müssen fehlschlagen**

Run: `npm test`
Expected: backend tests pass, then the new file errors with `Cannot find module '../metrics-logic.js'` (FAIL).

- [ ] **Step 4: Modul implementieren**

Create `Smart Meter Dashboard/metrics-logic.js`:

```js
// Pure, side-effect-free metric helpers shared by the dashboard UI and Node unit tests.
// Browser: loaded as a plain <script> before data.js, attaches functions to window.
// Node: require()d directly by tests via module.exports. No DOM / fetch / timers here.
(function () {
  function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

  // Worst active alert severity for one metric, derived from the station event feed.
  // events: array of { active, severity, metric }; metricId: frontend metric id (lowercased).
  // Returns 'alarm' | 'warning' | null. Alarm outranks warning; 'system' events are ignored.
  function metricAlertStatus(events, metricId) {
    if (!Array.isArray(events) || !metricId) return null;
    let warning = false;
    for (const e of events) {
      if (!e || !e.active) continue;
      if (e.severity === 'system') continue;
      if (e.metric !== metricId) continue;
      if (e.severity === 'alarm') return 'alarm';
      if (e.severity === 'warning') warning = true;
    }
    return warning ? 'warning' : null;
  }

  // Trend of a numeric series over a trailing time window (default 1 h).
  // series + timestamps are parallel arrays; timestamps in ms. Returns
  // { delta, pct, hasTrend, ref, last }.
  // last = newest finite value; ref = newest finite sample whose timestamp is at least
  // windowMs old, else the earliest finite value (graceful fallback for short series).
  // hasTrend=false when last or ref is missing (caller renders "—", no arrow).
  function metricTrend(series, timestamps, windowMs) {
    if (windowMs == null) windowMs = 3600000;
    if (!Array.isArray(series) || series.length === 0) {
      return { delta: NaN, pct: NaN, hasTrend: false, ref: NaN, last: NaN };
    }
    let lastIdx = -1;
    for (let i = series.length - 1; i >= 0; i--) { if (isNum(series[i])) { lastIdx = i; break; } }
    if (lastIdx === -1) return { delta: NaN, pct: NaN, hasTrend: false, ref: NaN, last: NaN };
    const last = series[lastIdx];

    const haveTs = Array.isArray(timestamps) && timestamps.length === series.length;
    let refIdx = -1;
    if (haveTs) {
      const cutoff = timestamps[lastIdx] - windowMs;
      let bestBefore = -1, earliest = -1;
      for (let i = 0; i < lastIdx; i++) {
        if (!isNum(series[i])) continue;
        if (earliest === -1) earliest = i;
        if (timestamps[i] <= cutoff) bestBefore = i;
      }
      refIdx = bestBefore !== -1 ? bestBefore : earliest;
    } else {
      for (let i = 0; i < lastIdx; i++) { if (isNum(series[i])) { refIdx = i; break; } }
    }
    if (refIdx === -1) return { delta: NaN, pct: NaN, hasTrend: false, ref: NaN, last };
    const ref = series[refIdx];
    const delta = last - ref;
    const pct = (delta / (ref || 1)) * 100;
    return { delta, pct, hasTrend: true, ref, last };
  }

  const api = { metricAlertStatus, metricTrend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.metricAlertStatus = metricAlertStatus;
    window.metricTrend = metricTrend;
  }
})();
```

- [ ] **Step 5: Tests ausführen — müssen bestehen**

Run: `npm test`
Expected: all backend tests PASS and all 11 metrics-logic tests PASS.

- [ ] **Step 6: Commit**

```bash
git add "Smart Meter Dashboard/metrics-logic.js" "Smart Meter Dashboard/tests/metrics-logic.test.js" package.json
git commit -m "feat(dashboard): add pure metric helpers (alert status, 1h trend) with node tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Helfer in die App einbinden (Browser-Verdrahtung)

**Files:**
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (script tag, ~line 1139)
- Modify: `Smart Meter Dashboard/data.js` (station timestamps + DASH_DATA exposure)

- [ ] **Step 1: Script-Tag vor `data.js` einfügen**

In `Smart Meter Dashboard/Klima Dashboard.html`, directly above the line `<script src="data.js?v=0.3.0"></script>` (line ~1139), add:

```html
<script src="metrics-logic.js?v=0.3.0"></script>
```

(Plain script, not `type="text/babel"` — it must run and define the globals before `data.js` builds `DASH_DATA`.)

- [ ] **Step 2: Pro-Station-Timestamps am Stationsobjekt ablegen**

In `Smart Meter Dashboard/data.js`, in the `stationObj` literal (currently ends with `metrics,` / `events: []`), add a `timestamps` field so per-station trend math doesn't depend on the active-station global. Change:

```js
          mo_uuid: s.mo_uuid,
          device_uuid: s.device_uuid,
          metrics,
          events: []
```

to:

```js
          mo_uuid: s.mo_uuid,
          device_uuid: s.device_uuid,
          metrics,
          timestamps: stationTimestamps,
          events: []
```

- [ ] **Step 3: Helfer über `DASH_DATA` exponieren**

In `Smart Meter Dashboard/data.js`, inside the returned `window.DASH_DATA = { ... }` object, after the `limitUnit(...)` method, add:

```js
    // Pure metric helpers (defined in metrics-logic.js, attached to window).
    metricAlertStatus(events, metricId) { return metricAlertStatus(events, metricId); },
    metricTrend(series, timestamps, windowMs) { return metricTrend(series, timestamps, windowMs); },
```

- [ ] **Step 4: Manuelle Konsolen-Verifikation**

Run: app is already served on `http://localhost:3000`. In the browser DevTools console (or via the Chrome MCP) evaluate:

```js
typeof window.metricAlertStatus === 'function' && typeof window.DASH_DATA.metricTrend === 'function'
```

Expected: `true`. Also check a real station: `window.DASH_DATA.metricTrend(Object.values(window.DASH_DATA.stations)[0].metrics.temperature.series, Object.values(window.DASH_DATA.stations)[0].timestamps)` returns an object with `hasTrend`.

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/Klima Dashboard.html" "Smart Meter Dashboard/data.js"
git commit -m "feat(dashboard): expose metric helpers via DASH_DATA and per-station timestamps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `ChartBody`-Wertezeile mit Trend + Grenzwert-Indikator

**Files:**
- Modify: `Smart Meter Dashboard/tiles.jsx` (replace `ChartBody`, add `MetricValue` + `AlertFlag`)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (CSS, near existing `.chart-legend` ~line 282)

- [ ] **Step 1: `AlertFlag`-Komponente hinzufügen**

In `Smart Meter Dashboard/tiles.jsx`, add above `function ChartBody`:

```jsx
function AlertFlag({ status }) {
  const label = status === "alarm" ? "Alarm aktiv" : "Warnung aktiv";
  return (
    <span className={`cv-flag is-${status}`} role="img" aria-label={label} title={label}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <path d="M7 2l6 10H1z"/><path d="M7 6v3M7 10.5v.5" strokeLinecap="round"/>
      </svg>
    </span>
  );
}
```

- [ ] **Step 2: `MetricValue`-Komponente hinzufügen**

In `Smart Meter Dashboard/tiles.jsx`, add directly below `AlertFlag`:

```jsx
function MetricValue({ metric, status, trend, hidePct, hideTrend }) {
  const last = trend.last;
  const valStr = (last == null || Number.isNaN(last)) ? "—" : last.toFixed(metric.decimals);
  const up = trend.delta > 0;
  return (
    <div className="cv-item">
      <span className="cv-label">
        <span className="legend-dot" style={{ background: metric.color }} />
        {metric.short}
      </span>
      <span className="cv-value-row">
        <span className={`cv-value ${status === "alarm" ? "is-alarm" : ""}`}>
          {valStr}<span className="cv-unit">{metric.unit}</span>
        </span>
        {status && <AlertFlag status={status} />}
      </span>
      {!hideTrend && trend.hasTrend && (
        <span className={`cv-trend trend ${up ? "up" : "down"}`}>
          {up ? "▲" : "▼"} {Math.abs(trend.delta).toFixed(metric.decimals)} {metric.unit}
          {!hidePct && (
            <span className="trend-pct">({trend.pct >= 0 ? "+" : ""}{trend.pct.toFixed(1)} %)</span>
          )}
          <span className="cv-range">1 h</span>
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: `ChartBody` ersetzen**

In `Smart Meter Dashboard/tiles.jsx`, replace the entire existing `ChartBody` function with:

```jsx
function ChartBody({ tile }) {
  if (!tile.metrics.length) return <Empty />;
  const station = tileStation(tile);
  if (!station) return <EmptyDeleted />;
  const ref = tRef(null);
  const size = useSize(ref);
  const hidePct = size.h > 0 && size.h < 170;
  const hideTrend = size.h > 0 && (size.h < 130 || size.w < 300);
  const D = window.DASH_DATA;
  const ts = station.timestamps || D.timestamps;
  return (
    <div className="chart-wrap" ref={ref}>
      <div className="chart-values">
        {tile.metrics.map((id) => {
          const M = station.metrics[id];
          if (!M) return null;
          const status = D.metricAlertStatus(station.events, id);
          const trend = D.metricTrend(M.series, ts, 3600000);
          return <MetricValue key={id} metric={M} status={status} trend={trend} hidePct={hidePct} hideTrend={hideTrend} />;
        })}
      </div>
      <div className="chart-area">
        <LineChart metricIds={tile.metrics} stationId={station.id} timestamps={D.timestamps} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: CSS ergänzen**

In `Smart Meter Dashboard/Klima Dashboard.html`, after the existing `.legend-unit { ... }` rule (line ~290), add:

```css
  .chart-values { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: flex-start; }
  .cv-item { display: flex; flex-direction: column; gap: 1px; min-width: 82px; }
  .cv-label { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); }
  .cv-value-row { display: inline-flex; align-items: center; gap: 5px; }
  .cv-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text); line-height: 1.15; }
  .cv-value.is-alarm { color: var(--alarm); }
  .cv-unit { font-family: var(--mono); font-size: 11px; color: var(--text-faint); margin-left: 2px; font-weight: 400; }
  .cv-flag { display: inline-flex; align-items: center; }
  .cv-flag.is-warning { color: var(--warn); }
  .cv-flag.is-alarm { color: var(--alarm); }
  .cv-trend { font-size: 11px; gap: 4px; }
  .cv-range { font-size: 10px; color: var(--text-faint); margin-left: 4px; }
```

(`--mono`, `--text`, `--text-muted`, `--text-faint`, `--warn`, `--alarm` and the `.trend.up`/`.trend.down`/`.trend-pct` classes already exist — reused, not redefined.)

- [ ] **Step 5: Manuelle visuelle Verifikation (Chrome)**

App on `http://localhost:3000`. Hard-reload (cache-buster still 0.3.0 here, so use Cmd-Shift-R). In edit mode: add a „Linien-Diagramm" tile for a station that currently has active alerts, select 2–3 metrics. Verify:
- value row above the chart shows each value + unit + a `1 h` trend (▲/▼ + %);
- a metric with an active warning shows a yellow triangle; an active alarm shows a red value + red triangle;
- the multi-line chart below is unchanged;
- shrinking the tile drops the % first, then the whole trend line; values + flags remain;
- the „Kennzahl" tile is visually unchanged (regression check).

- [ ] **Step 6: Commit**

```bash
git add "Smart Meter Dashboard/tiles.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): chart tile value row with 1h trend and alert indicator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Release — Versions-Bump 0.3.0 → 0.4.0

**Files:**
- Modify: `VERSION`, `README.md`, `package.json`, `Smart Meter Dashboard/Klima Dashboard.html`

- [ ] **Step 1: Version an allen Stellen setzen**

- `VERSION`: replace `0.3.0` with `0.4.0`.
- `README.md` line 3: badge `version-0.3.0-blue` → `version-0.4.0-blue`.
- `package.json`: `"version": "0.3.0"` → `"version": "0.4.0"`.
- `Smart Meter Dashboard/Klima Dashboard.html`: change **all** `?v=0.3.0` to `?v=0.4.0` (6 script tags incl. the new `metrics-logic.js`).

- [ ] **Step 2: Konsistenz prüfen**

Run:

```bash
cd "/Users/dniehof/Programming/Programme/testo-smart-abruf" && \
  rg -n "0\.3\.0" VERSION README.md package.json "Smart Meter Dashboard/Klima Dashboard.html"; \
  git tag --list v0.4.0
```

Expected: no `0.3.0` matches remain in those files; `v0.4.0` tag does not yet exist (empty output).

- [ ] **Step 3: Tests erneut ausführen (Sicherheitsnetz)**

Run: `npm test`
Expected: all backend + metrics-logic tests PASS.

- [ ] **Step 4: Commit, Tag, Push**

```bash
git add VERSION README.md package.json "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.4.0

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag -a v0.4.0 -m "v0.4.0"
git push --follow-tags -u origin feat/chart-tile-kpi-values
```

(Per the project versioning rule this push is pre-authorized. No force-push; never overwrite existing tags.)

---

## Task 5: Abschließende Live-Verifikation

**Files:** none (verification only)

- [ ] **Step 1: Hard-Reload mit neuem Cache-Buster**

App on `http://localhost:3000`. Reload (the `?v=0.4.0` now forces fresh assets per the stale-asset rule). Confirm the dashboard loads without console errors (`window.DASH_DATA.connectionError` is null).

- [ ] **Step 2: Funktionale Endkontrolle**

Re-run the Task 3 / Step 5 checklist once more on the released build and confirm all points hold. Capture a screenshot for the summary.

---

## Self-Review (durchgeführt beim Schreiben)

- **Spec-Abdeckung:** Wertezeile + 1-h-Trend → Task 1/3; Grenzwert-Indikator aus Feed → Task 1 (`metricAlertStatus`) + Task 3 (`AlertFlag`/`MetricValue`); Diagramm unverändert → Task 3 behält `LineChart`; responsive Reduktion → Task 3 (`hidePct`/`hideTrend`); keine Backend-Änderung → keine Backend-Datei in den Tasks; Versionierung → Task 4. Kein offener Spec-Punkt.
- **Platzhalter-Scan:** keine TBD/TODO; jeder Code-Schritt enthält vollständigen Code.
- **Typ-/Namens-Konsistenz:** `metricAlertStatus(events, metricId)` und `metricTrend(series, timestamps, windowMs) → { delta, pct, hasTrend, ref, last }` identisch in Modul (Task 1), Test (Task 1), `DASH_DATA`-Passthrough (Task 2) und Aufruf in `ChartBody` (Task 3). Props `hidePct`/`hideTrend`, Status `'alarm'|'warning'|null`, CSS-Klassen `cv-*`/`is-alarm`/`is-warning` durchgängig gleich benannt.
