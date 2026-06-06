# Remove Local Threshold Subsystem — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alarms and warnings are sourced solely from the API (Testo alarm feed → `events` table → `/api/...`); the client-side local threshold system and its editor UI are removed entirely.

**Architecture:** The dashboard currently merges backend API events with client-side threshold breaches (`data.js`: `station.events = [...backendEvents, ...localEvents]`). This plan removes the local branch so `station.events = backendEvents` only. The header (`totalActive()` → `/api/totals`) and tile counts (`station.events`) then share one source and are consistent by construction. The reported "0 Meldungen aktiv while a tile shows an alarm" bug disappears.

**Tech Stack:** Vanilla browser React 18 + Babel-standalone (in-browser JSX transpile, no build step). `data.js` is an IIFE exposing `window.DASH_DATA`. Backend is Node/Express + SQLite (unchanged by this work).

**Testing note:** There is no JS unit-test harness for `data.js`/`*.jsx` (browser-coupled IIFE; JSX transpiled in-browser). For this *removal*, verification = (a) grep shows no remaining references to removed symbols, (b) `node --check` passes for `data.js`, (c) the app loads with no console errors and shows consistent counts, (d) backend `npm test` stays green. Order of tasks removes consumers before the API they call, so every commit leaves a loadable app.

---

### Task 1: Remove the "Schwellen" gear button from the alerts tile (tiles.jsx)

**Files:**
- Modify: `Smart Meter Dashboard/tiles.jsx:273` (component signature)
- Modify: `Smart Meter Dashboard/tiles.jsx:315-320` (gear button block)

- [ ] **Step 1: Remove the gear button block**

In `AlertsBody`, delete the `onOpenSettings` button (lines 315-320):

```jsx
        {onOpenSettings && (
          <button className="mini-chip ghost-chip" onClick={onOpenSettings} title="Schwellen bearbeiten">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="6" cy="6" r="1.6"/><path d="M6 1v1.5M6 9.5V11M11 6H9.5M2.5 6H1M9.5 2.5l-1 1M3.5 8.5l-1 1M9.5 9.5l-1-1M3.5 3.5l-1-1"/></svg>
            {!narrow && "Schwellen"}
          </button>
        )}
```

Delete that entire block. The preceding "Aktiv" filter button (lines 311-314) and the closing `</div>` of `.alerts-summary` (line 321) remain.

- [ ] **Step 2: Remove the now-unused `onOpenSettings` prop**

Change the component signature on line 273 from:

```jsx
function AlertsBody({ tile, onOpenSettings }) {
```

to:

```jsx
function AlertsBody({ tile }) {
```

- [ ] **Step 3: Verify no references remain in tiles.jsx**

Run: `grep -n "onOpenSettings" "Smart Meter Dashboard/tiles.jsx"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add "Smart Meter Dashboard/tiles.jsx"
git commit -m "refactor(dashboard): remove threshold-editor gear from alerts tile"
```

---

### Task 2: Remove ThresholdDialog and its wiring (app.jsx)

**Files:**
- Modify: `Smart Meter Dashboard/app.jsx:28` (state)
- Modify: `Smart Meter Dashboard/app.jsx:214` (alerts prop wiring)
- Modify: `Smart Meter Dashboard/app.jsx:244-250` (dialog render)
- Modify: `Smart Meter Dashboard/app.jsx:648-708` (component definition)

- [ ] **Step 1: Remove the `thresholdOpen` state**

Delete line 28:

```jsx
  const [thresholdOpen, setThresholdOpen] = aState(null); // stationId | null
```

- [ ] **Step 2: Remove the alerts-tile `onOpenSettings` wiring**

Delete line 214:

```jsx
            if (t.type === "alerts") bodyProps.onOpenSettings = () => setThresholdOpen(t.stationId || window.DASH_DATA.activeStationId);
```

(The `bodyProps` object on line 213 and the `<Body {...bodyProps} />` render on line 227 remain — alerts tiles now render with just `{ tile }`.)

- [ ] **Step 3: Remove the ThresholdDialog render block**

Delete lines 244-250:

```jsx
      {thresholdOpen && (
        <ThresholdDialog
          stationId={thresholdOpen}
          onClose={() => setThresholdOpen(null)}
          onChange={() => forceTick((v) => v + 1)}
        />
      )}
```

- [ ] **Step 4: Remove the ThresholdDialog component**

Delete the entire `function ThresholdDialog(...) { ... }` definition (lines 648-708), from `function ThresholdDialog({ stationId, onClose, onChange }) {` through its closing `}` immediately before `function Modal(`. Leave `function Modal(...)` intact.

- [ ] **Step 5: Update the stale subscribe comment (optional tidy)**

Line 35 reads `// Subscribe to data changes (station switch, threshold edits)`. Change to:

```jsx
  // Subscribe to data changes (station switch, polling refresh)
```

- [ ] **Step 6: Verify no references remain in app.jsx**

Run: `grep -n "thresholdOpen\|ThresholdDialog\|setThreshold\|recomputeStationEvents\|\.thresholds" "Smart Meter Dashboard/app.jsx"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add "Smart Meter Dashboard/app.jsx"
git commit -m "refactor(dashboard): remove ThresholdDialog editor and its wiring"
```

---

### Task 3: Remove local threshold logic from data.js

**Files:**
- Modify: `Smart Meter Dashboard/data.js` (multiple regions below)

- [ ] **Step 1: Remove `DEFAULT_THRESHOLDS`**

Delete lines 28-34:

```js
  const DEFAULT_THRESHOLDS = {
    temperature: { warn: [19.0, 23.5], alarm: [17.5, 25.5] },
    humidity:    { warn: [38,   55],   alarm: [33,   62]   },
    pressure:    { warn: [1011, 1019], alarm: [1008, 1022] },
    dewpoint:    { warn: [7.5,  13.0], alarm: [6.0,  14.5] },
    abshumid:    { warn: [7.5,  11.0], alarm: [6.5,  12.0] },
  };
```

- [ ] **Step 2: Remove threshold persistence helpers**

Delete `getThresholdsForStation` and `saveThresholdsForStation` (lines 50-65), including their leading comment `// Retrieve user custom thresholds from localStorage or fall back to defaults`:

```js
  // Retrieve user custom thresholds from localStorage or fall back to defaults
  function getThresholdsForStation(sid) {
    const key = `dash-thresholds-${sid}`;
    try {
      const stored = localStorage.getItem(key);
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
  }

  function saveThresholdsForStation(sid, thr) {
    const key = `dash-thresholds-${sid}`;
    try {
      localStorage.setItem(key, JSON.stringify(thr));
    } catch (e) {}
  }
```

- [ ] **Step 3: Remove `classify`, `thresholdValue`, and `generateLocalThresholdEvents`**

Delete lines 67-135 — the comment `// Re-evaluates local series data...`, `classify` (68-76), `thresholdValue` (78-85), and `generateLocalThresholdEvents` (87-135). Stop before `// Statistics helper` / `function stats(arr)` (line 137), which remains.

- [ ] **Step 4: Stop building and merging local events in `refresh()`**

Replace lines 328-352. Current:

```js
        const thresholds = getThresholdsForStation(s.id);

        const stationObj = {
          id: s.id,
          name: s.name,
          code: s.device_uuid ? s.device_uuid.substring(0, 4).toUpperCase() : 'M01',
          location: s.location || 'Unbekannt',
          online: s.online === 1,
          battery: s.battery !== null ? s.battery : 100,
          signal: s.signal !== null ? s.signal : 100,
          lastSeen: s.last_communication || Date.now(),
          mo_uuid: s.mo_uuid,
          device_uuid: s.device_uuid,
          metrics,
          thresholds,
          events: []
        };

        // Combine backend alarms/system events with local threshold breaches
        const localEvents = generateLocalThresholdEvents(stationObj);
        stationObj.events = [...backendEvents, ...localEvents];
        stationObj.events.sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          return b.startTs - a.startTs;
        });
```

Replace with (drop the `thresholds` local + field, drop local-event generation; keep the sort):

```js
        const stationObj = {
          id: s.id,
          name: s.name,
          code: s.device_uuid ? s.device_uuid.substring(0, 4).toUpperCase() : 'M01',
          location: s.location || 'Unbekannt',
          online: s.online === 1,
          battery: s.battery !== null ? s.battery : 100,
          signal: s.signal !== null ? s.signal : 100,
          lastSeen: s.last_communication || Date.now(),
          mo_uuid: s.mo_uuid,
          device_uuid: s.device_uuid,
          metrics,
          events: []
        };

        // Events come solely from the API (Testo alarm feed + system events).
        stationObj.events = backendEvents;
        stationObj.events.sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          return b.startTs - a.startTs;
        });
```

- [ ] **Step 5: Remove the `thresholds` field from the seed station block**

In the startup seed loop, delete line 404:

```js
      thresholds: JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS)),
```

The seed station object keeps `metrics` and `events: []`.

- [ ] **Step 6: Remove the threshold-related public API methods**

In `window.DASH_DATA`, delete the `thresholds` getter (line 439):

```js
    get thresholds() { return STATIONS[activeStationId]?.thresholds; },
```

and delete `setThreshold` (442-458), `recomputeStationEvents` (459-472), and `classify` (473-477):

```js
    setThreshold(metricId, level, bound, value) {
      const station = STATIONS[activeStationId];
      if (!station) return;
      station.thresholds[metricId][level][bound] = value;
      saveThresholdsForStation(station.id, station.thresholds);

      // Re-evaluate local events
      const localEvents = generateLocalThresholdEvents(station);
      const backendEvents = station.events.filter(e => !e.id.includes('-local-e-'));
      station.events = [...backendEvents, ...localEvents];
      station.events.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.startTs - a.startTs;
      });

      emit();
    },
    recomputeStationEvents(stationId) {
      const station = STATIONS[stationId];
      if (!station) return;

      const localEvents = generateLocalThresholdEvents(station);
      const backendEvents = station.events.filter(e => !e.id.includes('-local-e-'));
      station.events = [...backendEvents, ...localEvents];
      station.events.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.startTs - a.startTs;
      });

      emit();
    },
    classify(metricId, v) {
      const station = STATIONS[activeStationId];
      if (!station) return "normal";
      return classify(station.thresholds, metricId, v);
    },
```

Leave `totalActive()`, `forceApiRefresh()`, `formatValue`, the active-station shortcuts `metrics`/`events`, and all other methods untouched.

- [ ] **Step 7: Verify no references remain in data.js**

Run: `grep -n "DEFAULT_THRESHOLDS\|getThresholdsForStation\|saveThresholdsForStation\|generateLocalThresholdEvents\|thresholdValue\|dash-thresholds\|local-e-\|classify\|\.thresholds\|setThreshold\|recomputeStationEvents" "Smart Meter Dashboard/data.js"`
Expected: no output.

- [ ] **Step 8: Syntax-check data.js**

Run: `node --check "Smart Meter Dashboard/data.js"`
Expected: no output, exit code 0 (clean parse).

- [ ] **Step 9: Commit**

```bash
git add "Smart Meter Dashboard/data.js"
git commit -m "feat(dashboard): source alarms/warnings solely from API, drop local thresholds"
```

---

### Task 4: Verify the running app and backend tests

**Files:** none (verification only)

- [ ] **Step 1: Run backend test suite**

Run: `npm test`
Expected: all suites pass (unchanged backend; regression guard).

- [ ] **Step 2: Start the server**

Run: `npm start` (serves on http://localhost:3000). If port 3000 is held by a stale process, free it first: `lsof -ti:3000 | xargs kill` then retry.

- [ ] **Step 3: Load the dashboard and confirm consistency**

Open http://localhost:3000 in a browser (hard-reload to bypass cached assets). Confirm:
- Header reads "… Messstellen · 0 Meldungen aktiv" (no Testo alarm currently active).
- The EMC tile shows **no** active alarm (the former local pressure-low alarm at 1001.2 hPa is gone).
- Browser console shows no errors referencing `thresholds`, `classify`, `setThreshold`, or `ThresholdDialog`.
- The alerts/Meldungen tile no longer shows a "Schwellen" gear button.

- [ ] **Step 4: No commit** (verification only — proceed to release once all confirmed).

---

### Task 5: Release 0.1.8

**Files:**
- Modify: `package.json` (version)
- Modify: `VERSION`
- Modify: `README.md` (version badge)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (cache-buster query strings, lines 1112-1116)

- [ ] **Step 1: Confirm current version and that the tag is free**

Run: `cat VERSION && git tag -l v0.1.8`
Expected: prints `0.1.7` and no tag output (v0.1.8 does not yet exist).

- [ ] **Step 2: Bump `VERSION`**

Set the file contents to:

```
0.1.8
```

- [ ] **Step 3: Bump `package.json`**

Change `"version": "0.1.7"` to `"version": "0.1.8"`.

- [ ] **Step 4: Bump the README badge**

Change the badge URL from `version-0.1.7-blue` to `version-0.1.8-blue`.

- [ ] **Step 5: Bump the asset cache-busters in the HTML**

In `Smart Meter Dashboard/Klima Dashboard.html`, change every `?v=0.1.7` to `?v=0.1.8` on the script tags (lines 1112-1116: `data.js`, `charts.jsx`, `tiles.jsx`, `settings.jsx`, `app.jsx`).

Run to confirm none remain: `grep -n "?v=0.1.7" "Smart Meter Dashboard/Klima Dashboard.html"`
Expected: no output.

- [ ] **Step 6: Verify version consistency**

Run: `grep -rn "0.1.8" VERSION package.json README.md | head` and confirm all three show 0.1.8.

- [ ] **Step 7: Commit, tag, and push**

```bash
git add VERSION package.json README.md "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.1.8"
git tag -a v0.1.8 -m "v0.1.8"
git push --follow-tags
```

Expected: commit + tag pushed to the remote.

---

## Notes / Out of Scope

- Orphaned `dash-thresholds-<sid>` keys in users' localStorage are left in place (harmless; no code reads them).
- `settings.jsx` notification routing (`notifications.routing.alarm`) is unrelated to local thresholds and stays.
- Backend (`scheduler.js`, `server.js`, `db.js`) is unchanged — the API is the intended source.
