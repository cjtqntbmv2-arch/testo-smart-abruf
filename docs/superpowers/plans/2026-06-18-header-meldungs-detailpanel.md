# Header-Meldungs-Detailpanel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Klick auf die Header-Summary-Pille öffnet ein Dropdown, das alle aktiven Meldungen aller Messstellen — gruppiert nach Gerät, mit Messwert und „seit wann" — auflistet.

**Architecture:** Reine Frontend-Erweiterung. Eine pure, unit-getestete Hilfsfunktion (`summary-logic.js`) gruppiert aktive Events pro Station; eine neue, isolierte Komponentendatei (`summary-panel.jsx`) rendert Trigger + Popover und verwendet die bestehende `EventRow` wieder. `app.jsx` ersetzt nur den alten Summary-Block durch die neue Trigger-Komponente. Keine Backend-Änderung.

**Tech Stack:** Node.js `node --test` (pure Logik), React 18 via Babel-in-Browser (kein Build-Schritt), better-sqlite3-Backend bleibt unberührt.

**Spec:** `docs/superpowers/specs/2026-06-18-header-meldungs-detailpanel-design.md`

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `Smart Meter Dashboard/summary-logic.js` (**neu**) | Pure `groupActiveEventsByStation(stations, stationOrder)` — sortiert/gruppiert, keine Seiteneffekte. |
| `Smart Meter Dashboard/tests/summary-logic.test.js` (**neu**) | Node-Unit-Tests der Gruppierlogik. |
| `Smart Meter Dashboard/summary-panel.jsx` (**neu**) | `SystemSummaryTrigger` (Pille als Button + Popover-Mechanik) und `SystemSummaryPanel` (gruppierte Liste). |
| `Smart Meter Dashboard/data.js` (mod) | Exponiert `activeEventGroups()` (dünner Wrapper). |
| `Smart Meter Dashboard/app.jsx` (mod) | `Header`: alter `top-summary`-Block → `<SystemSummaryTrigger totals={totals}/>`. |
| `Smart Meter Dashboard/Klima Dashboard.html` (mod) | Zwei neue Skript-Tags, CSS für Trigger/Popover/Gruppen, `?v=`-Bump. |
| `package.json` / `package-lock.json` / `VERSION` / `README.md` (mod) | Version 0.5.0 + Testdatei-Eintrag. |

**Deviation from spec §4.3 (bewusst):** `SummaryDot` **bleibt in `app.jsx`** und wird von `summary-panel.jsx` dateiübergreifend referenziert (globale Funktionsdeklaration, zur Renderzeit aufgelöst — wie `app.jsx` heute `TILE_BODIES` aus `tiles.jsx` nutzt). Begründung: vermeidet einen dateiübergreifenden „Move" für 6 Zeilen; `app.jsx` schrumpft ohnehin durch das Entfernen des Summary-Blocks. Kein neuer `const`-Alias-Konflikt, da nur Funktionsdeklarationen geteilt werden.

**Cache-Hinweis für manuelle Tests:** Der Express-Dev-Server revalidiert statische Assets per mtime — ein normaler Browser-Reload zieht Datei-Änderungen, auch ohne `?v=`-Bump. Bei scheinbar veraltetem Verhalten hart neuladen (Cmd+Shift+R). Der `?v=`-Bump (Task 6) ist der Release-Cache-Bust.

---

## Task 1: Pure grouping helper `summary-logic.js` + Node tests

**Files:**
- Create: `Smart Meter Dashboard/summary-logic.js`
- Test: `Smart Meter Dashboard/tests/summary-logic.test.js`
- Modify: `package.json` (test script)

- [ ] **Step 1: Write the failing test**

Create `Smart Meter Dashboard/tests/summary-logic.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { groupActiveEventsByStation } = require('../summary-logic.js');

// active defaults to true unless explicitly false.
function ev(severity, startTs, active, extra) {
  return Object.assign({ severity, startTs, active: active !== false }, extra || {});
}

test('empty / nullish inputs -> empty array', () => {
  assert.deepStrictEqual(groupActiveEventsByStation({}, []), []);
  assert.deepStrictEqual(groupActiveEventsByStation(null, null), []);
});

test('station with no active events is omitted', () => {
  const stations = {
    a: { id: 'a', events: [] },
    b: { id: 'b', events: [ev('alarm', 100, false)] }, // only inactive
  };
  assert.deepStrictEqual(groupActiveEventsByStation(stations, ['a', 'b']), []);
});

test('inactive events filtered out, active kept', () => {
  const stations = {
    a: { id: 'a', events: [ev('warning', 200, true), ev('alarm', 100, false)] },
  };
  const res = groupActiveEventsByStation(stations, ['a']);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].events.length, 1);
  assert.strictEqual(res[0].events[0].severity, 'warning');
});

test('groups: a station with an alarm sorts before a warning-only station', () => {
  const stations = {
    warnStation:  { id: 'warnStation',  events: [ev('warning', 500, true)] },
    alarmStation: { id: 'alarmStation', events: [ev('alarm', 100, true)] },
  };
  // stationOrder lists warn first, but the alarm group must come first by severity.
  const res = groupActiveEventsByStation(stations, ['warnStation', 'alarmStation']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['alarmStation', 'warnStation']);
});

test('events within a group: alarm < warning < system; ties newest-first', () => {
  const stations = {
    a: { id: 'a', events: [
      ev('system', 300, true),
      ev('warning', 400, true),
      ev('alarm', 100, true),
      ev('warning', 900, true), // newer warning
    ] },
  };
  const res = groupActiveEventsByStation(stations, ['a']);
  const order = res[0].events.map((e) => e.severity + ':' + e.startTs);
  assert.deepStrictEqual(order, ['alarm:100', 'warning:900', 'warning:400', 'system:300']);
});

test('group tie-break: same worst severity -> newer startTs group first', () => {
  const stations = {
    older: { id: 'older', events: [ev('alarm', 100, true)] },
    newer: { id: 'newer', events: [ev('alarm', 800, true)] },
  };
  const res = groupActiveEventsByStation(stations, ['older', 'newer']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['newer', 'older']);
});

test('robust: id in order missing from stations skipped; missing events array tolerated', () => {
  const stations = {
    a: { id: 'a' },                                   // no events array
    c: { id: 'c', events: [ev('alarm', 100, true)] },
  };
  const res = groupActiveEventsByStation(stations, ['a', 'ghost', 'c']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['c']);
});

test('public shape carries only { station, events } (no internal sort keys)', () => {
  const stations = { a: { id: 'a', events: [ev('alarm', 100, true)] } };
  const res = groupActiveEventsByStation(stations, ['a']);
  assert.deepStrictEqual(Object.keys(res[0]).sort(), ['events', 'station']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_ENV=test node --test "Smart Meter Dashboard/tests/summary-logic.test.js"`
Expected: FAIL — `Cannot find module '../summary-logic.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `Smart Meter Dashboard/summary-logic.js`:

```js
// Pure, side-effect-free grouping helper shared by the dashboard UI and Node unit tests.
// Browser: loaded as a plain <script> before data.js, attaches to window.
// Node: require()d directly by tests via module.exports. No DOM / fetch / timers / Date here.
(function () {
  // Lower rank = more severe. Unknown severities sort last.
  const SEV_RANK = { alarm: 0, warning: 1, system: 2 };
  function rank(sev) { return SEV_RANK[sev] != null ? SEV_RANK[sev] : 99; }

  // Group active events by station for the header detail panel.
  // stations: map id -> { id, name, code, location, online, events: [...] }
  // stationOrder: array of station ids (defines stable tie-break order)
  // Returns: [{ station, events }] — only stations with >= 1 active event.
  //   groups sorted by worst severity asc, then newest active startTs desc, then stationOrder.
  //   events within a group sorted by severity asc, then startTs desc (newest first).
  function groupActiveEventsByStation(stations, stationOrder) {
    if (!stations || !Array.isArray(stationOrder)) return [];
    const groups = [];
    for (let i = 0; i < stationOrder.length; i++) {
      const station = stations[stationOrder[i]];
      if (!station) continue;
      const active = (station.events || []).filter((e) => e && e.active);
      if (active.length === 0) continue;
      active.sort((a, b) => {
        const r = rank(a.severity) - rank(b.severity);
        if (r !== 0) return r;
        return (b.startTs || 0) - (a.startTs || 0);
      });
      let newest = -Infinity;
      for (const e of active) { if ((e.startTs || 0) > newest) newest = e.startTs || 0; }
      groups.push({ station, events: active, _worst: rank(active[0].severity), _newest: newest, _order: i });
    }
    groups.sort((a, b) => {
      if (a._worst !== b._worst) return a._worst - b._worst;
      if (a._newest !== b._newest) return b._newest - a._newest;
      return a._order - b._order;
    });
    return groups.map((g) => ({ station: g.station, events: g.events }));
  }

  const api = { groupActiveEventsByStation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.groupActiveEventsByStation = groupActiveEventsByStation;
})();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_ENV=test node --test "Smart Meter Dashboard/tests/summary-logic.test.js"`
Expected: PASS — 8 tests, 0 fail.

- [ ] **Step 5: Wire the new test file into `npm test`**

In `package.json`, the `test` script names frontend test files explicitly (no glob, because the dir has a space). Append the new file as a second argument to the frontend `node --test` call.

Modify `package.json` line 8 — replace:

```json
    "test": "NODE_ENV=test node --test backend/tests/*.test.js && NODE_ENV=test node --test \"Smart Meter Dashboard/tests/metrics-logic.test.js\""
```

with:

```json
    "test": "NODE_ENV=test node --test backend/tests/*.test.js && NODE_ENV=test node --test \"Smart Meter Dashboard/tests/metrics-logic.test.js\" \"Smart Meter Dashboard/tests/summary-logic.test.js\""
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — backend tests + both frontend test files green (84 prior + 8 new = all pass).

- [ ] **Step 7: Commit**

```bash
git add "Smart Meter Dashboard/summary-logic.js" "Smart Meter Dashboard/tests/summary-logic.test.js" package.json
git commit -m "feat(dashboard): pure active-event grouping helper + tests"
```

---

## Task 2: Expose `activeEventGroups()` + load the module in the page

**Files:**
- Modify: `Smart Meter Dashboard/data.js` (exposed-helpers block, ~line 388)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (script tags, ~line 1151)

- [ ] **Step 1: Add the data-layer wrapper**

In `Smart Meter Dashboard/data.js`, find the exposed pure-helper block:

```js
    // Pure metric helpers (defined in metrics-logic.js, attached to window).
    metricAlertStatus(events, metricId) { return metricAlertStatus(events, metricId); },
    metricTrend(series, timestamps, windowMs) { return metricTrend(series, timestamps, windowMs); },
```

Insert immediately **after** the `metricTrend` line:

```js
    // Active events across all stations, grouped by device (summary-logic.js).
    activeEventGroups() { return groupActiveEventsByStation(STATIONS, STATION_ORDER); },
```

- [ ] **Step 2: Load `summary-logic.js` before `data.js`**

In `Smart Meter Dashboard/Klima Dashboard.html`, find:

```html
<script src="metrics-logic.js?v=0.4.2"></script>
<script src="data.js?v=0.4.2"></script>
```

Insert the new tag between them:

```html
<script src="metrics-logic.js?v=0.4.2"></script>
<script src="summary-logic.js?v=0.4.2"></script>
<script src="data.js?v=0.4.2"></script>
```

- [ ] **Step 3: Smoke-test in the browser**

Run: `npm start` (serves on port 3000). Open `http://localhost:3000`, open DevTools console, run:

```js
window.DASH_DATA.activeEventGroups()
```

Expected: an array (possibly empty). When alarms/warnings are active, entries look like `{ station: {…}, events: [ {severity, metric, startTs, active:true, …} ] }`. No `ReferenceError`.

- [ ] **Step 4: Commit**

```bash
git add "Smart Meter Dashboard/data.js" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): expose activeEventGroups() data accessor"
```

---

## Task 3: New component file `summary-panel.jsx`

**Files:**
- Create: `Smart Meter Dashboard/summary-panel.jsx`
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (script tags, ~line 1155)

- [ ] **Step 1: Create the component file**

Create `Smart Meter Dashboard/summary-panel.jsx`:

```jsx
// System summary detail panel: click the topbar summary pill to see every active
// alarm/warning/system message across all stations, grouped by device.
// Loaded as a plain <script type="text/babel"> before app.jsx (which mounts the root).
// Reuses EventRow (tiles.jsx) and SummaryDot (app.jsx) — both global function declarations,
// resolved at render time. Unique hook aliases (ss*) avoid global const collisions.

const { useState: ssState, useRef: ssRef, useEffect: ssEff } = React;

function SystemSummaryTrigger({ totals }) {
  const [open, setOpen] = ssState(false);
  const ref = ssRef(null);

  ssEff(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="top-summary-wrap" ref={ref}>
      <button className="top-summary" aria-haspopup="true" aria-expanded={open}
              onClick={() => setOpen((o) => !o)} title="Aktive Meldungen anzeigen">
        <SummaryDot severity="alarm"   count={totals.alarm} />
        <SummaryDot severity="warning" count={totals.warning} />
        <SummaryDot severity="system"  count={totals.system} />
        <span className="top-summary-label">über alle Messstellen</span>
        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"
             stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
      </button>
      {open && <SystemSummaryPanel />}
    </div>
  );
}

function SystemSummaryPanel() {
  const D = window.DASH_DATA;
  const groups = D.activeEventGroups();
  return (
    <div className="top-summary-pop" role="dialog" aria-label="Aktive Meldungen">
      <div className="station-pop-head">Aktive Meldungen · alle Messstellen</div>
      {groups.length === 0 ? (
        <div className="alerts-empty">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="11" cy="11" r="8"/><path d="M7 11l3 3 5-6"/>
          </svg>
          <span>Keine aktiven Meldungen.</span>
        </div>
      ) : (
        groups.map(({ station, events }) => (
          <div className="tsp-group" key={station.id}>
            <div className="tsp-group-head">
              <span className={`station-dot ${station.online ? "on" : "off"}`} />
              <span className="tsp-group-title">{station.name}</span>
              <span className="station-code">{station.code}</span>
              <span className="tsp-group-loc">{station.location}</span>
              <span className="tsp-count">{events.length}</span>
            </div>
            {events.map((e) => <EventRow event={e} key={e.id} station={station} />)}
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 2: Load `summary-panel.jsx` before `app.jsx`**

In `Smart Meter Dashboard/Klima Dashboard.html`, find:

```html
<script type="text/babel" src="settings.jsx?v=0.4.2"></script>
<script type="text/babel" src="app.jsx?v=0.4.2"></script>
```

Insert the new tag between them:

```html
<script type="text/babel" src="settings.jsx?v=0.4.2"></script>
<script type="text/babel" src="summary-panel.jsx?v=0.4.2"></script>
<script type="text/babel" src="app.jsx?v=0.4.2"></script>
```

- [ ] **Step 3: Verify it loads cleanly (still unused)**

Reload `http://localhost:3000`. Expected: dashboard renders exactly as before (the new components are defined but not yet referenced). DevTools console: no Babel/parse errors, no `ReferenceError`.

- [ ] **Step 4: Commit**

```bash
git add "Smart Meter Dashboard/summary-panel.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): system summary trigger + detail panel components"
```

---

## Task 4: Wire the trigger into the Header

**Files:**
- Modify: `Smart Meter Dashboard/app.jsx` (`Header`, lines ~346-353)

- [ ] **Step 1: Replace the old summary block**

In `Smart Meter Dashboard/app.jsx`, inside `Header`, find:

```jsx
      {!inSettings && (
        <div className="top-summary" title="System-Überblick">
          <SummaryDot severity="alarm"   count={totals.alarm} />
          <SummaryDot severity="warning" count={totals.warning} />
          <SummaryDot severity="system"  count={totals.system} />
          <span className="top-summary-label">über alle Messstellen</span>
        </div>
      )}
```

Replace it with:

```jsx
      {!inSettings && <SystemSummaryTrigger totals={totals} />}
```

(`SummaryDot` stays defined further down in `app.jsx` — `summary-panel.jsx` references it cross-file.)

- [ ] **Step 2: Verify the trigger works (function before form)**

Reload `http://localhost:3000`. Expected:
- The pille shows the same three dots + „über alle Messstellen", now with a chevron.
- Click → a dropdown opens listing active messages grouped by device (styling is rough until Task 5; content/structure correct: station name + code + location, then EventRows with metric + „vor … " ).
- Esc and a click outside close it. With zero active messages the panel shows „Keine aktiven Meldungen."
- Console: no Rules-of-Hooks warning, no `ReferenceError`.

- [ ] **Step 3: Commit**

```bash
git add "Smart Meter Dashboard/app.jsx"
git commit -m "feat(dashboard): open active-message detail panel from header summary"
```

---

## Task 5: Styling

**Files:**
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (`<style>` block — add after the existing `.top-summary-label` rule, ~line 677)

- [ ] **Step 1: Add the CSS**

In `Smart Meter Dashboard/Klima Dashboard.html`, find the end of the top-summary block:

```css
  .top-summary-label {
    font-family: var(--mono); font-size: 11px; color: var(--text-muted);
    padding-left: 8px; margin-left: 2px; border-left: 1px solid var(--border-strong);
  }
```

Insert immediately **after** it:

```css
  /* ---------- System summary detail panel (click the topbar summary) ---------- */
  .top-summary-wrap { position: relative; flex: 0 0 auto; }
  button.top-summary {
    appearance: none; color: inherit; font: inherit; cursor: pointer;
    transition: background .12s ease, border-color .12s ease, box-shadow .12s ease;
  }
  button.top-summary:hover { border-color: var(--border-strong); }
  button.top-summary[aria-expanded="true"] {
    border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
  }
  button.top-summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .top-summary .chev {
    color: var(--text-muted); transition: transform .15s ease; flex-shrink: 0; margin-left: 2px;
  }
  .top-summary[aria-expanded="true"] .chev { transform: rotate(180deg); }

  .top-summary-pop {
    position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
    padding: 6px;
    z-index: 60;
    width: max-content;
    min-width: 320px; max-width: min(440px, 92vw);
    max-height: 60vh; overflow-y: auto;
  }
  .tsp-group { padding: 4px 2px 6px; }
  .tsp-group + .tsp-group { border-top: 1px solid var(--border); margin-top: 2px; padding-top: 8px; }
  .tsp-group-head { display: flex; align-items: center; gap: 8px; padding: 2px 8px 6px; }
  .tsp-group-title { font-size: 12.5px; font-weight: 600; color: var(--text); }
  .tsp-group-loc {
    font-family: var(--mono); font-size: 10.5px; color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .tsp-count {
    margin-left: auto; flex-shrink: 0;
    font-family: var(--mono); font-size: 10.5px; font-weight: 600; color: var(--text-muted);
    background: var(--bg-2); border-radius: 999px; padding: 1px 7px;
  }
```

- [ ] **Step 2: Visual verification**

Reload `http://localhost:3000`. Expected:
- The pille looks interactive: cursor pointer, hover border, chevron present; open state shows the accent ring and the chevron rotates 180°.
- The dropdown is centered under the pille, does not overflow the viewport edge, scrolls when many messages.
- Each device group: online dot + name + code + location + count; below it the familiar EventRow styling (severity tag, headline „Temperatur ▲ über 25 °C", „vor 2 h" / „läuft").
- Empty state shows the dashed „Keine aktiven Meldungen." box.

- [ ] **Step 3: Commit**

```bash
git add "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): style header detail panel (trigger, popover, groups)"
```

---

## Task 6: Release v0.5.0

**Files:**
- Modify: `package.json`, `package-lock.json`, `VERSION`, `README.md`, `Smart Meter Dashboard/Klima Dashboard.html`

- [ ] **Step 1: Full manual verification (release gate)**

Run `npm test` → all green. Then with `npm start` running, walk the spec §8 checklist: open panel; groups per device with correct metric + „seit wann"; Esc / click-outside close; empty state; live update after a 5 s poll (trigger or wait for an alarm to resolve → group disappears); no new console warnings. Do not proceed until all pass.

- [ ] **Step 2: Bump the version number everywhere**

- `package.json` line 3: `"version": "0.4.2",` → `"version": "0.5.0",`
- `package-lock.json`: both `"version": "0.4.2"` occurrences (root and `packages[""].version`) → `0.5.0`
- `VERSION`: `0.4.2` → `0.5.0`
- `README.md` line 3: `version-0.4.2-blue` → `version-0.5.0-blue`

- [ ] **Step 3: Bump every cache-buster in the HTML**

In `Smart Meter Dashboard/Klima Dashboard.html`, replace all eight `?v=0.4.2` → `?v=0.5.0` (the six original tags plus the two added in Tasks 2 and 3). Verify none remain:

Run: `grep -c "v=0.4.2" "Smart Meter Dashboard/Klima Dashboard.html"`
Expected: `0`

- [ ] **Step 4: Verify consistency, then commit**

Run: `grep -R "0\.5\.0" VERSION package.json README.md | cat`
Expected: each file shows `0.5.0`.

```bash
git add -A
git commit -m "chore: bump version to 0.5.0"
```

- [ ] **Step 5: Tag and (if a remote exists) push**

```bash
git tag -a v0.5.0 -m "v0.5.0"
git remote | grep -q . && git push --follow-tags || echo "no remote configured — tag stays local"
```

Expected: annotated tag `v0.5.0` created; pushed only when a remote is configured (this project has historically been local-only).

---

## Self-Review

**1. Spec coverage:**
- Klick-Dropdown-Interaktion → Task 3 (Trigger/Popover) + Task 4 (wiring). ✓
- Affordanz (Chevron, Hover, aria-expanded) → Task 3 (markup) + Task 5 (CSS). ✓
- Pure `groupActiveEventsByStation` (Vertrag, Sortierung) → Task 1. ✓
- `activeEventGroups()`-Wrapper → Task 2. ✓
- Gruppierung nach Gerät, Kopf mit Online/Name/Code/Standort/Count → Task 3. ✓
- `EventRow`-Wiederverwendung, unverändert, mit korrekter `station`-Prop → Task 3. ✓
- Leerzustand → Task 3 (markup) + Task 5 (reuse `.alerts-empty`). ✓
- Live-Update → inherent (Panel liest `activeEventGroups()` jeden Render); verifiziert in Task 6 Step 1. ✓
- Positionierung/Overflow, keine neuen Tokens → Task 5. ✓
- Tests (Gruppierung/Sortierung/Robustheit) → Task 1. ✓
- Versionierung 0.5.0 inkl. `?v=` und Tag → Task 6. ✓
- Skript-Reihenfolge (summary-logic vor data.js; summary-panel vor app.jsx) → Tasks 2 & 3. ✓

No spec requirement is left without a task.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"add validation". Every code step shows complete code; every command shows expected output.

**3. Type consistency:** `groupActiveEventsByStation(stations, stationOrder)` and its `[{ station, events }]` shape are identical across Task 1 (impl + tests), Task 2 (wrapper), and Task 3 (consumer destructures `{ station, events }`). `activeEventGroups()` name matches between Task 2 (data.js) and Task 3 (`D.activeEventGroups()`). `SystemSummaryTrigger`/`SystemSummaryPanel`/`SummaryDot`/`EventRow` names consistent across Tasks 3 and 4.
