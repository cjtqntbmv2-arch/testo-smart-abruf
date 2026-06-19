# Tile Limit-Status Indicators — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-metric limit status (warning/alarm value colouring + warn/alarm symbol + over/under direction triangle) at the values of the `kpi`, `chart` and `stats` tiles, as a per-tile opt-in checkbox (default on).

**Architecture:** A new pure helper `metricAlertState(events, metricId)` derives `{severity, direction}` from the existing active-event feed (`station.events`). A shared React component `LimitFlag` renders the symbol + corner direction triangle. Each value-tile body reads the tile's `limitFlags` flag (undefined ⇒ on), colours its value and renders `LimitFlag`. The Add/Edit tile dialogs expose the checkbox for the three supporting tile types. No backend/API/DB change.

**Tech Stack:** Node + better-sqlite3 backend (unchanged here); React via Babel-in-browser (no build step); `node --test` for pure-logic unit tests. Frontend lives in `Smart Meter Dashboard/` (directory name contains a space — always quote it).

## Global Constraints

- **No backend/API/DB change.** Status + direction derive only from existing frontend data (`station.events`).
- **Default ON everywhere:** `tile.limitFlags === undefined` ⇒ treated as on. Render gate is always `tile.limitFlags !== false`.
- **In scope:** tile types `kpi`, `chart`, `stats`. **Out of scope and untouched:** `gauge` (separate future feature), `alerts` (no checkbox — it is the alarm list itself).
- **Direction semantics:** `condition === 'high'` ⇒ upper limit exceeded ⇒ "limit-line + spike" glyph with the spike ABOVE the line; `condition === 'low'` ⇒ lower limit undershot ⇒ spike BELOW the line. Unknown/missing ⇒ `'high'`. This glyph is a small SVG corner badge on the warn/alarm symbol — deliberately NOT a ▲/▼ (would clash with the tiles' trend arrow). Identical across kpi/chart/stats.
- **Colour tokens:** alarm value/symbol = `var(--alarm)`; warning value/symbol = `var(--warn-strong)` (= `oklch(0.50 0.13 75)`, the existing warn-symbol colour, promoted to a token in Task 2). Do **not** use the light `var(--warn)` for text/symbols.
- **Babel-in-browser caution:** do not introduce bare `useState`/`useEffect`/etc. in `.jsx` files — they collide with other files' globals and blank the page. `tiles.jsx` uses aliases `tRef/tEff/tState`; `app.jsx` uses `aState/aEff`. `LimitFlag` uses no hooks.
- **Worktree hygiene:** never `git add -A` (node_modules symlink trap); add exact paths only.
- **Versioning:** MINOR bump 0.5.0 → 0.6.0 as the final task; project is local-only (no remote) ⇒ local annotated tag, no push. If the parallel `feat/status-cards-cause-action` branch takes 0.6.0 first, use 0.7.0.
- **Quote the path** `"Smart Meter Dashboard"` in every shell command.

---

### Task 1: Data layer — `metricAlertState` pure helper

**Files:**
- Modify: `Smart Meter Dashboard/metrics-logic.js` (add `metricAlertState`; refactor `metricAlertStatus` to delegate; export both)
- Modify: `Smart Meter Dashboard/tests/metrics-logic.test.js` (import + new tests)
- Modify: `Smart Meter Dashboard/data.js` (expose `metricAlertState` on `DASH_DATA`)

**Interfaces:**
- Produces: `metricAlertState(events, metricId) → { severity: 'alarm'|'warning'|null, direction: 'high'|'low'|null }`. Browser global `window.metricAlertState`; Node `module.exports.metricAlertState`; `window.DASH_DATA.metricAlertState(events, metricId)`.
- `metricAlertStatus(events, metricId) → 'alarm'|'warning'|null` is unchanged in behaviour (now delegates).
- Consumes: event shape `{ active, severity, metric, condition }` where `condition` is already `'high'|'low'` (set by `alarmDirection()` in `data.js`).

- [ ] **Step 1: Write the failing tests**

In `Smart Meter Dashboard/tests/metrics-logic.test.js`, change the require line and append the new tests:

```js
const { metricAlertState, metricAlertStatus, metricTrend } = require('../metrics-logic.js');
```

```js
test('metricAlertState: high alarm -> severity alarm, direction high', () => {
  const events = [{ active: true, severity: 'alarm', metric: 'temperature', condition: 'high' }];
  assert.deepStrictEqual(metricAlertState(events, 'temperature'), { severity: 'alarm', direction: 'high' });
});

test('metricAlertState: low warning -> severity warning, direction low', () => {
  const events = [{ active: true, severity: 'warning', metric: 'humidity', condition: 'low' }];
  assert.deepStrictEqual(metricAlertState(events, 'humidity'), { severity: 'warning', direction: 'low' });
});

test('metricAlertState: alarm outranks warning and keeps the alarm direction', () => {
  const events = [
    { active: true, severity: 'warning', metric: 'temperature', condition: 'high' },
    { active: true, severity: 'alarm', metric: 'temperature', condition: 'low' },
  ];
  assert.deepStrictEqual(metricAlertState(events, 'temperature'), { severity: 'alarm', direction: 'low' });
});

test('metricAlertState: first active warning wins its direction', () => {
  const events = [
    { active: true, severity: 'warning', metric: 'temperature', condition: 'high' },
    { active: true, severity: 'warning', metric: 'temperature', condition: 'low' },
  ];
  assert.deepStrictEqual(metricAlertState(events, 'temperature'), { severity: 'warning', direction: 'high' });
});

test('metricAlertState: missing condition defaults to high', () => {
  const events = [{ active: true, severity: 'warning', metric: 'pressure' }];
  assert.deepStrictEqual(metricAlertState(events, 'pressure'), { severity: 'warning', direction: 'high' });
});

test('metricAlertState: inactive / system / other-metric -> {null,null}', () => {
  assert.deepStrictEqual(metricAlertState([{ active: false, severity: 'alarm', metric: 'temperature', condition: 'high' }], 'temperature'), { severity: null, direction: null });
  assert.deepStrictEqual(metricAlertState([{ active: true, severity: 'system', metric: 'temperature' }], 'temperature'), { severity: null, direction: null });
  assert.deepStrictEqual(metricAlertState([{ active: true, severity: 'alarm', metric: 'pressure', condition: 'high' }], 'temperature'), { severity: null, direction: null });
});

test('metricAlertState: non-array / missing id -> {null,null}', () => {
  assert.deepStrictEqual(metricAlertState(null, 'temperature'), { severity: null, direction: null });
  assert.deepStrictEqual(metricAlertState([{ active: true, severity: 'alarm', metric: 'temperature', condition: 'high' }], null), { severity: null, direction: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: exactly the **7 new `metricAlertState` tests fail** with `metricAlertState is not a function`. The destructure of a not-yet-exported name yields `undefined` (it does **not** throw at require time), so the file still loads and all existing `metricAlertStatus`/`metricTrend`/backend tests stay **green**. Do not read a green summary as "nothing failed" — confirm the 7 new failures are present.

- [ ] **Step 3: Implement `metricAlertState` and delegate**

In `Smart Meter Dashboard/metrics-logic.js`, replace the whole `metricAlertStatus` function (lines ~10–21) with:

```js
  // Worst active alert for one metric, plus the direction of the breached limit.
  // events: array of { active, severity, metric, condition }; condition is 'high'|'low' (alarmDirection()).
  // Returns { severity: 'alarm'|'warning'|null, direction: 'high'|'low'|null }. Alarm outranks warning;
  // 'system' events are ignored (no metric value).
  function metricAlertState(events, metricId) {
    if (!Array.isArray(events) || !metricId) return { severity: null, direction: null };
    let warnDir = null;
    for (const e of events) {
      if (!e || !e.active) continue;
      if (e.severity === 'system') continue;
      if (e.metric !== metricId) continue;
      const dir = e.condition === 'low' ? 'low' : 'high';
      if (e.severity === 'alarm') return { severity: 'alarm', direction: dir };
      if (e.severity === 'warning' && warnDir === null) warnDir = dir;
    }
    return warnDir ? { severity: 'warning', direction: warnDir } : { severity: null, direction: null };
  }

  // Backward-compatible severity-only accessor (delegates to metricAlertState).
  function metricAlertStatus(events, metricId) {
    return metricAlertState(events, metricId).severity;
  }
```

Then update the exports block at the bottom:

```js
  const api = { metricAlertState, metricAlertStatus, metricTrend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.metricAlertState = metricAlertState;
    window.metricAlertStatus = metricAlertStatus;
    window.metricTrend = metricTrend;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — both suites green; the new `metricAlertState` tests pass and all existing `metricAlertStatus`/`metricTrend` tests stay green.

- [ ] **Step 5: Expose on `DASH_DATA`**

In `Smart Meter Dashboard/data.js`, next to the existing `metricAlertStatus` passthrough (~line 387), add:

```js
    metricAlertState(events, metricId) { return metricAlertState(events, metricId); },
    metricAlertStatus(events, metricId) { return metricAlertStatus(events, metricId); },
```

(Inside each method body the bare name resolves to the browser global set by `metrics-logic.js`, exactly like the existing `metricAlertStatus` passthrough.)

- [ ] **Step 6: Commit**

```bash
git add "Smart Meter Dashboard/metrics-logic.js" "Smart Meter Dashboard/tests/metrics-logic.test.js" "Smart Meter Dashboard/data.js"
git commit -m "feat(dashboard): metricAlertState helper (severity + limit direction)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Chart tile — shared `LimitFlag`, CSS foundations, warning colour + direction

**Files:**
- Modify: `Smart Meter Dashboard/tiles.jsx` (`AlertFlag` → `LimitFlag`; add `tileLimitFlagsOn` helper; `supportsLimitFlags` on chart type; rewire `MetricValue` + `ChartBody`)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (CSS: `--warn-strong` token + migrate literals; `.cv-value.is-warning`; `.lf-dir` direction triangle; `.cv-flag` position)

**Interfaces:**
- Consumes: `window.DASH_DATA.metricAlertState` (Task 1).
- Produces (used by Tasks 3–5): React component `LimitFlag({ severity, direction })` (renders nothing when `severity` is falsy); module-local helper `tileLimitFlagsOn(tile) → boolean`; `TILE_TYPES.chart.supportsLimitFlags === true`.

- [ ] **Step 1: Add `tileLimitFlagsOn` helper and the chart capability flag**

In `Smart Meter Dashboard/tiles.jsx`, add the chart capability flag inside the `chart` entry of `TILE_TYPES`:

```js
  chart: {
    id: "chart",
    label: "Linien-Diagramm",
    desc: "1–4 Messwerte über 24 h, frei kombinierbar.",
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 3 },
    maxMetrics: 4,
    supportsLimitFlags: true,
  },
```

Add this helper just below the `TILE_TYPES` object (before the layout-math section):

```js
// Whether a tile shows the limit-status treatment. Default on; undefined => on.
function tileLimitFlagsOn(tile) { return tile.limitFlags !== false; }
```

- [ ] **Step 2: Replace `AlertFlag` with `LimitFlag`**

In `Smart Meter Dashboard/tiles.jsx`, replace the `AlertFlag` function (lines ~201–210) with:

```js
function LimitFlag({ severity, direction }) {
  if (!severity) return null;
  const sevLabel = severity === "alarm" ? "Alarm aktiv" : "Warnung aktiv";
  const low = direction === "low";
  const label = `${sevLabel} · ${low ? "unterer" : "oberer"} Grenzwert`;
  // Direction glyph "limit-line + spike": short threshold line with the value-spike
  // above it (upper limit exceeded) or below it (lower limit undershot). Built as an
  // element array (no JSX fragment) to match the codebase's plain style. Inherits the
  // flag colour via fill="currentColor".
  const dirPaths = low
    ? [<rect key="line" x="2" y="4.2" width="8" height="1.6" />, <path key="spike" d="M6 11l-3-4h6z" />]
    : [<path key="spike" d="M6 1l3 4H3z" />, <rect key="line" x="2" y="6.2" width="8" height="1.6" />];
  return (
    <span className={`cv-flag is-${severity}`} role="img" aria-label={label} title={label}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <path d="M7 2l6 10H1z"/><path d="M7 6v3M7 10.5v.5" strokeLinecap="round"/>
      </svg>
      <svg className={`lf-dir lf-dir-${low ? "low" : "high"}`} width="9" height="9" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        {dirPaths}
      </svg>
    </span>
  );
}
```

- [ ] **Step 3: Rewire `MetricValue` to use severity + direction**

In `Smart Meter Dashboard/tiles.jsx`, replace `MetricValue` (lines ~212–239) with:

```js
function MetricValue({ metric, state, trend, hidePct, hideTrend }) {
  const last = trend.last;
  const valStr = (last == null || Number.isNaN(last)) ? "—" : last.toFixed(metric.decimals);
  const up = trend.delta > 0;
  const sev = state.severity;
  const valClass = sev === "alarm" ? "is-alarm" : sev === "warning" ? "is-warning" : "";
  return (
    <div className="cv-item">
      <span className="cv-label">
        <span className="legend-dot" style={{ background: metric.color }} />
        {metric.short}
      </span>
      <span className="cv-value-row">
        <span className={`cv-value ${valClass}`}>
          {valStr}<span className="cv-unit">{metric.unit}</span>
        </span>
        <LimitFlag severity={sev} direction={state.direction} />
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

- [ ] **Step 4: Pass state (gated) from `ChartBody`**

In `Smart Meter Dashboard/tiles.jsx`, inside `ChartBody`'s `tile.metrics.map(...)` (lines ~259–264), replace the `status`/`MetricValue` lines with:

```js
        {tile.metrics.map((id) => {
          const M = station.metrics[id];
          if (!M) return null;
          const state = tileLimitFlagsOn(tile)
            ? D.metricAlertState(station.events, id)
            : { severity: null, direction: null };
          const trend = D.metricTrend(M.series, ts, 3600000);
          return <MetricValue key={id} metric={M} state={state} trend={trend} hidePct={hidePct} hideTrend={hideTrend} />;
        })}
```

- [ ] **Step 5: CSS — token, migration, warning colour, direction triangle**

In `Smart Meter Dashboard/Klima Dashboard.html`:

(a) In `:root`, add the token immediately after `--warn-tint` (line ~34):

```css
    --warn-strong: oklch(0.50 0.13 75);
```

(b) Migrate **every** existing literal `oklch(0.50 0.13 75)` to `var(--warn-strong)`. There are **four** exact occurrences (currently ~lines 254, 299, 584, 642), not two — trust the grep, not this prose:

Run: `grep -n "oklch(0.50 0.13 75)" "Smart Meter Dashboard/Klima Dashboard.html"`
Replace the colour value in **each** hit (except the new `:root` token line you just added) with `var(--warn-strong)`. Do **not** touch the near-but-different variants `oklch(0.48 0.12 75)` or `oklch(0.25 0.08 75)` — those are deliberately other shades.

(c) Add the warning value colour next to `.cv-value.is-alarm` (~line 296):

```css
  .cv-value.is-warning { color: var(--warn-strong); }
```

(d) Position the direction glyph **contained inside the flag box** — `.tile` has `overflow: hidden` (`Klima Dashboard.html:170`), so the glyph must NOT rely on offsets that escape the flag/tile (they would be clipped at a tile edge). Change `.cv-flag` (~line 298) into a fixed-size relative box and place the 9px SVG glyph at the right corner inside it:

```css
  .cv-flag { display: inline-flex; align-items: center; justify-content: center; position: relative; width: 17px; height: 15px; }
  .lf-dir { position: absolute; right: 0; pointer-events: none; }
  .lf-dir-high { top: 0; }
  .lf-dir-low { bottom: 0; }
```

The 13px warn/alarm symbol sits centred in the 17×15 box; the 9px `lf-dir` glyph (an `<svg>`, not text — no `font-size`) overlaps its upper/lower-right corner (the "corner badge" look) while staying within the box → never clipped. It fills with `currentColor`, so it inherits `var(--warn-strong)` / `var(--alarm)` from the `.cv-flag.is-*` modifier. Replace the existing `.cv-flag { display: inline-flex; align-items: center; }` rule entirely with the rule above.

- [ ] **Step 6: Live-verify the chart tile**

Start the app and verify (the app polls the testo cloud and currently has active warnings/alarms):

Run: `npm start` (serves on port 3000), then open the preview.
- Create a `Linien-Diagramm` tile with the affected station's humidity (or any metric with an active event).
- Confirm: active warning ⇒ value in dark-yellow + warn triangle with a small ▲ (high) / ▼ (low) at the corner; active alarm ⇒ red value + red triangle + direction triangle; metric with no event ⇒ plain value, no symbol.
- Check the browser console is free of React errors (no blank page).

- [ ] **Step 7: Commit**

```bash
git add "Smart Meter Dashboard/tiles.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): limit-status flag + direction triangle in chart tile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: KPI tile (`KpiBody`)

**Files:**
- Modify: `Smart Meter Dashboard/tiles.jsx` (`TILE_TYPES.kpi.supportsLimitFlags`; `KpiBody`)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (CSS: `.kpi-value .num.is-warning` / `.is-alarm`)

**Interfaces:**
- Consumes: `LimitFlag`, `tileLimitFlagsOn` (Task 2); `window.DASH_DATA.metricAlertState` (Task 1).
- Produces: `TILE_TYPES.kpi.supportsLimitFlags === true`.

- [ ] **Step 1: Add capability flag to `kpi`**

In `TILE_TYPES.kpi`, add `supportsLimitFlags: true` (alongside `maxMetrics: 1`).

- [ ] **Step 2: Wire `KpiBody`**

In `Smart Meter Dashboard/tiles.jsx`, in `KpiBody` (lines ~166–199): after `const s = window.DASH_DATA.stats(M.series);` add:

```js
  const D = window.DASH_DATA;
  const state = tileLimitFlagsOn(tile)
    ? D.metricAlertState(station.events, tile.metrics[0])
    : { severity: null, direction: null };
  const numClass = state.severity === "alarm" ? "is-alarm" : state.severity === "warning" ? "is-warning" : "";
```

Then change the `.kpi-value` block to:

```js
      <div className="kpi-value">
        <span className={`num ${numClass}`}>{Number.isNaN(s.last) || s.last == null ? "—" : s.last.toFixed(M.decimals)}</span>
        <span className="unit">{M.unit}</span>
        <LimitFlag severity={state.severity} direction={state.direction} />
      </div>
```

- [ ] **Step 3: CSS — KPI value colours**

In `Smart Meter Dashboard/Klima Dashboard.html`, after the `.kpi-value .unit` rule (~line 267) add:

```css
  .kpi-value .num.is-warning { color: var(--warn-strong); }
  .kpi-value .num.is-alarm { color: var(--alarm); }
```

- [ ] **Step 4: Live-verify**

Reload the preview; create or reuse a `Kennzahl` tile bound to a metric with an active event. Confirm the big number colours (yellow/red) and the corner-triangle flag sits next to the unit, distinct from the 24-h trend arrow below. No console errors.

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/tiles.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): limit-status indicator in KPI tile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Stats tile (`StatsBody`)

**Files:**
- Modify: `Smart Meter Dashboard/tiles.jsx` (`TILE_TYPES.stats.supportsLimitFlags`; `StatsBody`)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (CSS: `.srow-v.current.is-warning` / `.is-alarm`)

**Interfaces:**
- Consumes: `LimitFlag`, `tileLimitFlagsOn` (Task 2); `window.DASH_DATA.metricAlertState` (Task 1).
- Produces: `TILE_TYPES.stats.supportsLimitFlags === true`.

- [ ] **Step 1: Add capability flag to `stats`**

In `TILE_TYPES.stats`, add `supportsLimitFlags: true` (alongside `maxMetrics: 4`).

- [ ] **Step 2: Wire `StatsBody`**

In `Smart Meter Dashboard/tiles.jsx`, replace `StatsBody` (lines ~291–318) with:

```js
function StatsBody({ tile }) {
  if (!tile.metrics.length) return <Empty />;
  const station = tileStation(tile);
  if (!station) return <EmptyDeleted />;
  const D = window.DASH_DATA;
  const showFlags = tileLimitFlagsOn(tile);
  return (
    <div className="stats">
      <div className="stats-grid">
        <div className="stats-head">
          <span>Messgröße</span><span>Aktuell</span><span>Min</span><span>Max</span><span>Ø</span>
        </div>
        {tile.metrics.map((id) => {
          const M = station.metrics[id];
          if (!M) return null;   // stale metric id (station no longer exposes it) — match ChartBody's guard
          const s = D.stats(M.series);
          const fmt = (v) => (v == null || Number.isNaN(v)) ? "—" : v.toFixed(M.decimals);
          const state = showFlags ? D.metricAlertState(station.events, id) : { severity: null, direction: null };
          const curClass = state.severity === "alarm" ? "is-alarm" : state.severity === "warning" ? "is-warning" : "";
          return (
            <div className="stats-row" key={id}>
              <span className="srow-name"><span className="legend-dot" style={{ background: M.color }} />{M.short}</span>
              <span className={`srow-v current ${curClass}`}>{fmt(s.last)}<span className="srow-u">{M.unit}</span><LimitFlag severity={state.severity} direction={state.direction} /></span>
              <span className="srow-v">{fmt(s.min)}</span>
              <span className="srow-v">{fmt(s.max)}</span>
              <span className="srow-v">{fmt(s.avg)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: CSS — Stats current-value colours**

In `Smart Meter Dashboard/Klima Dashboard.html`, after `.srow-v.current` (~line 358) add:

```css
  .srow-v.current.is-warning { color: var(--warn-strong); }
  .srow-v.current.is-alarm { color: var(--alarm); }
```

- [ ] **Step 4: Live-verify**

Reload; create a `Statistik` tile with a metric that has an active event. Confirm the "Aktuell" cell colours and the small flag fits in the cell (symbol + corner triangle). If the cell is visibly cramped, reduce the symbol to `width/height="11"` in `LimitFlag` and re-check — note this in the commit if changed. No console errors.

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/tiles.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): limit-status indicator in stats tile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Per-tile opt-in checkbox (Add/Edit dialogs)

**Files:**
- Modify: `Smart Meter Dashboard/app.jsx` (`addTile`; `AddTileDialog`; `EditTileDialog`)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (CSS: `.dialog-check`)

**Interfaces:**
- Consumes: `TILE_TYPES[type].supportsLimitFlags` (Tasks 2–4); tile bodies already read `tile.limitFlags` via `tileLimitFlagsOn`.
- Produces: tiles created/edited with `limitFlags: false` when the user unchecks the box (stored only when false; default-on stays implicit).

- [ ] **Step 1: Extend `addTile`**

In `Smart Meter Dashboard/app.jsx`, replace `addTile` (lines ~168–175) with:

```js
  function addTile(type, stationId, metrics, title, limitFlags) {
    const cfg = TILE_TYPES[type];
    const { w, h } = cfg.defaultSize;
    const slot = findFreeSlot(layout, w, h);
    const id = "t" + Math.random().toString(36).slice(2, 8);
    const tile = { id, type, stationId, title, metrics, x: slot.x, y: slot.y, w, h };
    if (cfg.supportsLimitFlags && limitFlags === false) tile.limitFlags = false;
    setLayout((L) => [...L, tile]);
    setAddOpen(false);
  }
```

- [ ] **Step 2: `AddTileDialog` — state, checkbox, preview, commit**

In `AddTileDialog`:

(a) Add state next to the other `aState` hooks (~line 323):

```js
  const [limitFlags, setLimitFlags] = aState(true);
```

(b) In `pickType` (~line 333), reset it alongside metrics/title:

```js
  function pickType(t) {
    setType(t);
    setMetrics([]);
    setTitle("");
    setLimitFlags(true);
    setStep(2);
  }
```

(c) Update `commit` (~line 364):

```js
  function commit() {
    onAdd(type, stationId, metrics, title.trim() || suggestTitle(), limitFlags);
  }
```

(d) In step 4, add the checkbox after the title `<label className="field">…</label>` (~line 473), and include `limitFlags` in the preview body props (~line 488):

```jsx
            {cfg.supportsLimitFlags && (
              <label className="dialog-check">
                <input type="checkbox" checked={limitFlags} onChange={(e) => setLimitFlags(e.target.checked)} />
                <span>Grenzwert-Status an den Messwerten anzeigen</span>
              </label>
            )}
```

```jsx
                  {React.createElement(TILE_BODIES[type], { tile: { type, stationId, metrics, title: title || suggestTitle(), limitFlags } })}
```

- [ ] **Step 3: `EditTileDialog` — state, checkbox, save**

In `EditTileDialog`:

(a) Add state next to the other `aState` hooks (~line 516):

```js
  const [limitFlags, setLimitFlags] = aState(tile.limitFlags !== false);
```

(b) Add the checkbox inside the `{station && (<>…</>)}` block, right after the closing `</div>` of `.metric-grid` (~line 601):

```jsx
            {cfg.supportsLimitFlags && (
              <label className="dialog-check">
                <input type="checkbox" checked={limitFlags} onChange={(e) => setLimitFlags(e.target.checked)} />
                <span>Grenzwert-Status an den Messwerten anzeigen</span>
              </label>
            )}
```

(c) Update the Save button's `onSave` (~line 607):

```jsx
                  onClick={() => onSave({ stationId, metrics, title: title.trim() || cfg.label, ...(cfg.supportsLimitFlags ? { limitFlags } : {}) })}
```

- [ ] **Step 4: CSS — checkbox row**

In `Smart Meter Dashboard/Klima Dashboard.html`, near the dialog styles, add:

```css
  .dialog-check { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 13px; color: var(--text-muted); cursor: pointer; }
  .dialog-check input { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
```

- [ ] **Step 5: Live-verify the toggle**

Reload. In the Add dialog, pick a `Kennzahl`/`Statistik`/`Linien-Diagramm` type → step 4 shows the checkbox; the preview reacts when toggled. Confirm the checkbox is **absent** for `Tachometer` and `Meldungen & Grenzwerte`. Add a tile with the box **unchecked** ⇒ plain values, no colour/symbol. Edit an existing tile, toggle the box, save ⇒ behaviour switches. No console errors.

- [ ] **Step 6: Commit**

```bash
git add "Smart Meter Dashboard/app.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): per-tile opt-in checkbox for limit-status indicators

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Full verification & regression

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all green (baseline 92 + the new `metricAlertState` tests; 0 failures).

- [ ] **Step 2: Live regression sweep**

With the app running:
- `gauge` (Tachometer): unchanged — no colour/symbol, no checkbox. Arc still in the metric colour.
- `alerts` (Meldungen): unchanged — no checkbox; event rows render as before.
- A previously-saved layout (no `limitFlags` field) shows the status on `kpi`/`chart`/`stats` by default (default-on), and the chart tile looks like before plus warning colour + direction triangle.
- A metric with no active event renders plain.

- [ ] **Step 3: Console/network check**

Confirm no React warnings/errors in the console and the page never blanks (hook-alias regression guard).

- [ ] **Step 4: Commit (only if a fix was needed)**

If Steps 1–3 surfaced a defect, fix it, re-verify, and commit with a clear `fix(dashboard): …` message. Otherwise no commit.

---

### Task 7: Version bump 0.5.0 → 0.6.0 (final, pre-merge)

**Files:**
- Modify: `VERSION`, `README.md` (badge), `package.json`, `Smart Meter Dashboard/Klima Dashboard.html` (`?v=` cache-buster in all script tags)

> Do this LAST, right before integrating to `master`. If the parallel `feat/status-cards-cause-action` branch already merged as 0.6.0, use 0.7.0 / `v0.7.0` throughout instead.
>
> **Known merge landmine (verified):** the parallel branch touches `Klima Dashboard.html` only in two spots — a `.hc-*` CSS block (~line 1043, no overlap with this feature) and **one inserted `<script src="status-logic.js?v=0.5.0">` line in the script-tag block (~line 1199)**. Since this task rewrites every `?v=` in that same block, a three-way merge will conflict there — resolve by keeping both the new `status-logic.js` line and the bumped `?v=`. The parallel branch also already bumped `package.json`; whichever branch merges second must re-bump `package.json` + `VERSION` + README badge to the next free number. This feature does **not** touch `app.jsx`/`tiles.jsx` in a way the parallel branch also touches (confirmed: the parallel branch does not modify `app.jsx` or `tiles.jsx`), so those edits will merge cleanly.

- [ ] **Step 1: Confirm the target version is free**

Run: `git tag -l "v0.6.0"; git log --oneline master | head -3`
Expected: no `v0.6.0` tag. If `master` already carries 0.6.0, switch this task to 0.7.0.

- [ ] **Step 2: Bump all version locations**

- `VERSION` → `0.6.0`
- `README.md` badge → `version-0.6.0`
- `package.json` `"version": "0.6.0"`
- `Smart Meter Dashboard/Klima Dashboard.html` → change every `?v=0.5.0` to `?v=0.6.0`.

First enumerate the script tags so none is missed:

Run: `grep -n "?v=0.5.0" "Smart Meter Dashboard/Klima Dashboard.html"`
Then replace each occurrence with `?v=0.6.0`.

- [ ] **Step 3: Consistency check**

Run: `grep -rn "0\.5\.0" VERSION README.md package.json "Smart Meter Dashboard/Klima Dashboard.html"`
Expected: no stale `0.5.0` remains in these files.

- [ ] **Step 4: Run tests once more**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit and tag (local; no push — no remote)**

```bash
git add VERSION README.md package.json "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.6.0

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag -a v0.6.0 -m "v0.6.0"
```

---

## Self-Review (author checklist — completed)

**Spec coverage:**
- Warning value colouring → Tasks 2 (chart), 3 (kpi), 4 (stats) via `.is-warning`.
- Over/under direction triangle → `LimitFlag` (Task 2), used in 2–4.
- All three value tiles → Tasks 2/3/4.
- Per-tile opt-in checkbox, default on, supported types only → Task 5 (+ `tileLimitFlagsOn` gate used in 2–4).
- `metricAlertState` data helper + tests → Task 1.
- `gauge`/`alerts` untouched, no checkbox → enforced by `supportsLimitFlags` only on kpi/chart/stats; verified Task 6.
- `--warn-strong` token + migration → Task 2 Step 5.
- Versioning (local tag, no push; 0.7.0 fallback) → Task 7.
- Parallel-work coordination (version bump last) → Task 7 ordering + note.

**Placeholder scan:** none — every code step shows full code; no TBD/“handle edge cases”.

**Type consistency:** `metricAlertState → {severity, direction}` used identically in Tasks 1–4; `LimitFlag({severity, direction})` and `tileLimitFlagsOn(tile)` names consistent across tasks; `addTile(type, stationId, metrics, title, limitFlags)` matches `AddTileDialog.commit`.
