# Meldungs-Panel — alle Messstellen + lazy Historie — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das Header-Meldungs-Panel listet alle Messstellen; aktive sind aufgeklappt, ruhige eingeklappt, und pro Station wird die Historie seitenweise („weitere laden") on-demand geladen.

**Architecture:** Aktive Meldungen kommen weiter live aus dem In-Memory-`station.events` (Poll); die Historie (aufgelöste Events) wird über einen parametrisierten Endpoint `GET /api/stations/:id/events?active=0&limit=&before=` paginiert nachgeladen. Eine pure `buildStationOverview`-Funktion liefert alle Stationen sortiert; eine gekapselte `StationHistoryGroup`-Komponente hält Expand-/Paginierungs-State je Station. Der 5-s-Poll wird per `?limit=50` entlastet.

**Tech Stack:** Node/Express + better-sqlite3 (Backend), React via Babel-in-Browser (kein Build-Step), `node --test` (Tests).

**Spec:** [docs/superpowers/specs/2026-06-19-meldungs-panel-alle-messstellen-historie-design.md](../specs/2026-06-19-meldungs-panel-alle-messstellen-historie-design.md)

## Global Constraints

- **Zielversion:** 0.8.0 (MINOR; Bump erst in Task 5). Versionsorte synchron: `package.json`, `package-lock.json`, `VERSION`, README-Badge, **alle** `?v=` in `Klima Dashboard.html`.
- **Lokal-only Repo:** kein Remote → kein Push. Direkt auf `master` committen (Projektkonvention).
- **Babel-in-Browser:** jede `.jsx`-Datei braucht **eindeutige** React-Hook-Aliase; bare `useState`/etc. kollidieren global → weiße Seite. `summary-panel.jsx` nutzt `ss*`.
- **Rules of Hooks:** in Komponenten **alle** Hooks zuoberst, vor jedem frühen Return.
- **Panel sitzt außerhalb der Tile-Error-Boundary:** Fetch-Fehler **müssen** lokal gefangen werden, dürfen nie werfen (sonst weiße Seite).
- **`EventRow` (`tiles.jsx`) bleibt unverändert** — wird für aktive und historische Zeilen wiederverwendet.
- **Endpoints liefern bare Arrays** (keine `{data:…}`/`{hasMore:…}`-Hüllen).
- **`station_id` FK + `foreign_keys = ON`:** Events brauchen eine existierende Station; nie `INSERT OR REPLACE` in `stations`.

---

### Task 1: Backend — paginierbarer Events-Endpoint

**Files:**
- Modify: `backend/server.js:185-193` (Route `GET /api/stations/:id/events`)
- Test: `backend/tests/server.test.js` (neuer Test ans Ende, vor `after(...)`)

**Interfaces:**
- Produces: `GET /api/stations/:id/events` akzeptiert optionale Query-Parameter `limit` (int > 0), `active` (`'0'` = aufgelöst, `'1'` = aktiv) und einen **Compound-Cursor** `before_ts` (int ms) + `before_rowid` (int). Cursor-Semantik: `(start_ts < before_ts) OR (start_ts = before_ts AND rowid < before_rowid)` — robust gegen gleiche `start_ts` (Zeitstempel-Gleichstand). Ist nur `before_ts` gesetzt → `start_ts < before_ts`. Ungültige/fehlende Werte werden ignoriert. Sortierung `active DESC, start_ts DESC, rowid DESC` (Total-Order; spiegelt scheduler.js:356). Antwort: bares Array von DB-Zeilen **inkl. `_rowid`** (Spalten u.a. `uuid, station_id, severity, alarm_condition_type, alarm_value, metric, threshold, start_ts, end_ts, extreme, active, message, detail, _rowid`).

- [ ] **Step 1: Failing-Test schreiben** — ans Ende von `backend/tests/server.test.js`, **vor** dem `after(() => {…})`-Block einfügen:

```js
test('GET /api/stations/:id/events supports limit, active and compound (start_ts,rowid) cursor', async () => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id, name) VALUES ('evpag', 'Pagination Test')").run();
  db.prepare("DELETE FROM events WHERE station_id = 'evpag'").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-act','evpag','alarm',400,420,1)").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-r3','evpag','warning',300,350,0)").run();
  // two resolved events that SHARE start_ts=200 (realistic tie); e-r2a inserted first => lower rowid
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-r2a','evpag','warning',200,250,0)").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-r2b','evpag','alarm',200,250,0)").run();
  db.prepare("INSERT INTO events (uuid, station_id, severity, start_ts, end_ts, active) VALUES ('e-r1','evpag','warning',100,150,0)").run();

  const base = 'http://localhost:3001/api/stations/evpag/events';
  const ids = (arr) => arr.map((e) => e.uuid);

  // no params => all 5; active first, then start_ts desc, then rowid desc (e-r2b before e-r2a)
  assert.deepStrictEqual(ids(await (await fetch(base)).json()), ['e-act', 'e-r3', 'e-r2b', 'e-r2a', 'e-r1']);
  // active=1 => only active
  assert.deepStrictEqual(ids(await (await fetch(base + '?active=1')).json()), ['e-act']);
  // active=0 => only resolved, newest first; rowid breaks the start_ts=200 tie
  assert.deepStrictEqual(ids(await (await fetch(base + '?active=0')).json()), ['e-r3', 'e-r2b', 'e-r2a', 'e-r1']);
  // rowid is exposed in the payload for the cursor
  const first = (await (await fetch(base + '?active=0&limit=1')).json())[0];
  assert.strictEqual(first.uuid, 'e-r3');
  assert.ok(Number.isInteger(first._rowid));

  // walk the compound cursor at limit=1 — MUST NOT skip the start_ts=200 tie
  const collected = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    let url = base + '?active=0&limit=1';
    if (cursor) url += `&before_ts=${cursor.start_ts}&before_rowid=${cursor._rowid}`;
    const page = await (await fetch(url)).json();
    if (page.length === 0) break;
    collected.push(page[0].uuid);
    cursor = { start_ts: page[0].start_ts, _rowid: page[0]._rowid };
  }
  assert.deepStrictEqual(collected, ['e-r3', 'e-r2b', 'e-r2a', 'e-r1']); // both start_ts=200 rows present

  // invalid params ignored => same as no params
  assert.deepStrictEqual(ids(await (await fetch(base + '?limit=abc&before_ts=xyz&active=2')).json()), ['e-act', 'e-r3', 'e-r2b', 'e-r2a', 'e-r1']);
  // before_ts beyond all data => empty
  assert.deepStrictEqual(await (await fetch(base + '?active=0&before_ts=100')).json(), []);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test 2>&1 | grep -A3 "limit, active and compound"`
Expected: FAIL (heutige Route ignoriert die Query-Parameter und liefert kein `_rowid` → falsche Reihenfolge/Anzahl, Cursor-Walk überspringt den Tie).

- [ ] **Step 3: Route ersetzen** — `backend/server.js:185-193` komplett ersetzen durch:

```js
// GET /api/stations/:id/events
// Optional query params:
//   limit       — max rows (positive int); omitted/invalid => no limit (backward compatible)
//   active      — '0' (resolved only) | '1' (active only); anything else => both
//   before_ts   — compound cursor anchor (int ms); omitted/invalid => ignored
//   before_rowid— compound cursor tiebreak (int); only used together with before_ts
// Cursor (robust against equal start_ts): (start_ts < before_ts) OR (start_ts = before_ts AND rowid < before_rowid).
app.get('/api/stations/:id/events', (req, res) => {
  const clauses = ['station_id = ?'];
  const params = [req.params.id];

  if (req.query.active === '0' || req.query.active === '1') {
    clauses.push('active = ?');
    params.push(Number(req.query.active));
  }

  const beforeTs = Number.parseInt(req.query.before_ts, 10);
  if (Number.isFinite(beforeTs)) {
    const beforeRowid = Number.parseInt(req.query.before_rowid, 10);
    if (Number.isFinite(beforeRowid)) {
      clauses.push('(start_ts < ? OR (start_ts = ? AND rowid < ?))');
      params.push(beforeTs, beforeTs, beforeRowid);
    } else {
      clauses.push('start_ts < ?');
      params.push(beforeTs);
    }
  }

  let sql = `SELECT *, rowid AS _rowid FROM events WHERE ${clauses.join(' AND ')} ORDER BY active DESC, start_ts DESC, rowid DESC`;

  const limit = Number.parseInt(req.query.limit, 10);
  if (Number.isFinite(limit) && limit > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const events = getDb().prepare(sql).all(...params);
  res.json(events);
});
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `npm test`
Expected: PASS — alle Backend- + Frontend-Tests grün (vorher 92, jetzt 93).

- [ ] **Step 5: Commit**

```bash
git add backend/server.js backend/tests/server.test.js
git commit -m "feat(backend): paginate events endpoint (limit/before/active)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure Logik — `buildStationOverview`

**Files:**
- Modify: `Smart Meter Dashboard/summary-logic.js` (ersetzt `groupActiveEventsByStation`)
- Test: `Smart Meter Dashboard/tests/summary-logic.test.js` (an neue API anpassen + erweitern)

**Interfaces:**
- Consumes: nichts.
- Produces: `buildStationOverview(stations, stationOrder) → Array<{ station, activeEvents, activeCount }>`. **Alle** Stationen aus `stationOrder` (deren Objekt existiert) erscheinen. `activeEvents` = aktive Events, sortiert (alarm<warning<system, dann `startTs` desc); `activeCount` = deren Anzahl. Stations-Reihenfolge: aktive vor ruhigen; aktive nach schwerster Severity, dann neuestem aktiven `startTs`, dann `stationOrder`; ruhige in `stationOrder`. Exporte: `module.exports = { buildStationOverview }` und `window.buildStationOverview`.

- [ ] **Step 1: Testdatei ersetzen** — `Smart Meter Dashboard/tests/summary-logic.test.js` komplett durch folgendes ersetzen:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildStationOverview } = require('../summary-logic.js');

// active defaults to true unless explicitly false.
function ev(severity, startTs, active) {
  return { severity, startTs, active: active !== false };
}

test('empty / nullish inputs -> empty array', () => {
  assert.deepStrictEqual(buildStationOverview({}, []), []);
  assert.deepStrictEqual(buildStationOverview(null, null), []);
});

test('all stations are included, even quiet ones (activeCount 0)', () => {
  const stations = {
    a: { id: 'a', events: [] },
    b: { id: 'b', events: [ev('alarm', 100, false)] }, // only inactive
  };
  const res = buildStationOverview(stations, ['a', 'b']);
  assert.deepStrictEqual(res.map((g) => g.station.id).sort(), ['a', 'b']);
  assert.ok(res.every((g) => g.activeCount === 0 && g.activeEvents.length === 0));
});

test('active events filtered/sorted; inactive excluded from activeEvents', () => {
  const stations = { a: { id: 'a', events: [ev('warning', 200, true), ev('alarm', 100, false)] } };
  const res = buildStationOverview(stations, ['a']);
  assert.strictEqual(res[0].activeCount, 1);
  assert.strictEqual(res[0].activeEvents[0].severity, 'warning');
});

test('stations with active events sort before quiet stations', () => {
  const stations = {
    quiet: { id: 'quiet', events: [] },
    warn: { id: 'warn', events: [ev('warning', 500, true)] },
  };
  // order lists quiet first, but the active station must come first
  const res = buildStationOverview(stations, ['quiet', 'warn']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['warn', 'quiet']);
});

test('among active stations: alarm sorts before warning-only', () => {
  const stations = {
    warnStation: { id: 'warnStation', events: [ev('warning', 500, true)] },
    alarmStation: { id: 'alarmStation', events: [ev('alarm', 100, true)] },
  };
  const res = buildStationOverview(stations, ['warnStation', 'alarmStation']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['alarmStation', 'warnStation']);
});

test('quiet stations keep stationOrder among themselves', () => {
  const stations = {
    x: { id: 'x', events: [] },
    y: { id: 'y', events: [] },
    z: { id: 'z', events: [ev('alarm', 100, true)] },
  };
  const res = buildStationOverview(stations, ['y', 'x', 'z']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['z', 'y', 'x']);
});

test('activeEvents within a station: alarm < warning < system; ties newest-first', () => {
  const stations = {
    a: { id: 'a', events: [
      ev('system', 300, true), ev('warning', 400, true),
      ev('alarm', 100, true), ev('warning', 900, true),
    ] },
  };
  const res = buildStationOverview(stations, ['a']);
  const order = res[0].activeEvents.map((e) => e.severity + ':' + e.startTs);
  assert.deepStrictEqual(order, ['alarm:100', 'warning:900', 'warning:400', 'system:300']);
});

test('active group tie-break: same worst severity -> newer startTs first', () => {
  const stations = {
    older: { id: 'older', events: [ev('alarm', 100, true)] },
    newer: { id: 'newer', events: [ev('alarm', 800, true)] },
  };
  const res = buildStationOverview(stations, ['older', 'newer']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['newer', 'older']);
});

test('robust: id missing from stations skipped; missing events array tolerated', () => {
  const stations = {
    a: { id: 'a' },                                  // no events array -> quiet
    c: { id: 'c', events: [ev('alarm', 100, true)] },
  };
  const res = buildStationOverview(stations, ['a', 'ghost', 'c']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['c', 'a']); // active first, then quiet
});

test('public shape carries only { station, activeEvents, activeCount }', () => {
  const stations = { a: { id: 'a', events: [ev('alarm', 100, true)] } };
  const res = buildStationOverview(stations, ['a']);
  assert.deepStrictEqual(Object.keys(res[0]).sort(), ['activeCount', 'activeEvents', 'station']);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `npm test 2>&1 | grep -iE "buildStationOverview|not a function|summary-logic"`
Expected: FAIL (`buildStationOverview` ist noch nicht exportiert).

- [ ] **Step 3: `summary-logic.js` ersetzen** — Datei komplett durch folgendes ersetzen:

```js
// Pure, side-effect-free station-overview helper shared by the dashboard UI and Node unit tests.
// Browser: loaded as a plain <script> before data.js, attaches to window.
// Node: require()d directly by tests via module.exports. No DOM / fetch / timers / Date here.
(function () {
  // Lower rank = more severe. Unknown severities sort last.
  const SEV_RANK = { alarm: 0, warning: 1, system: 2 };
  function rank(sev) { return SEV_RANK[sev] != null ? SEV_RANK[sev] : 99; }

  // Build the full station overview for the header detail panel.
  // stations: map id -> { id, name, code, location, online, events: [...] }
  // stationOrder: array of station ids (stable tie-break order)
  // Returns: [{ station, activeEvents, activeCount }] for EVERY station whose object exists.
  //   Stations with active events sort first (by worst severity asc, then newest active startTs
  //   desc, then stationOrder); quiet stations follow in stationOrder.
  //   activeEvents per station are sorted severity asc, then startTs desc (newest first).
  function buildStationOverview(stations, stationOrder) {
    if (!stations || !Array.isArray(stationOrder)) return [];
    const rows = [];
    for (let i = 0; i < stationOrder.length; i++) {
      const station = stations[stationOrder[i]];
      if (!station) continue;
      const activeEvents = (station.events || []).filter((e) => e && e.active);
      activeEvents.sort((a, b) => {
        const r = rank(a.severity) - rank(b.severity);
        if (r !== 0) return r;
        return (b.startTs || 0) - (a.startTs || 0);
      });
      let newest = -Infinity, worst = 99;
      for (const e of activeEvents) {
        if ((e.startTs || 0) > newest) newest = e.startTs || 0;
        const r = rank(e.severity);
        if (r < worst) worst = r;
      }
      rows.push({
        station, activeEvents, activeCount: activeEvents.length,
        _quiet: activeEvents.length > 0 ? 0 : 1, // active group sorts first
        _worst: worst, _newest: newest, _order: i,
      });
    }
    rows.sort((a, b) => {
      if (a._quiet !== b._quiet) return a._quiet - b._quiet;
      if (a._quiet === 0) {
        if (a._worst !== b._worst) return a._worst - b._worst;
        if (a._newest !== b._newest) return b._newest - a._newest;
      }
      return a._order - b._order;
    });
    return rows.map((r) => ({ station: r.station, activeEvents: r.activeEvents, activeCount: r.activeCount }));
  }

  const api = { buildStationOverview };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.buildStationOverview = buildStationOverview;
  }
})();
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `npm test`
Expected: PASS — alle Tests grün.

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/summary-logic.js" "Smart Meter Dashboard/tests/summary-logic.test.js"
git commit -m "feat(dashboard): generalize summary-logic to buildStationOverview (all stations)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Datenschicht (`data.js`) — Mapper, Poll-Limit, neue Accessoren

**Files:**
- Modify: `Smart Meter Dashboard/data.js`

**Interfaces:**
- Consumes: `buildStationOverview` (global, aus Task 2); `GET …/events?limit/&before/&active` (Task 1).
- Produces: `D.stationOverview() → Array<{station, activeEvents, activeCount}>`; `D.fetchStationHistory(stationId, { beforeTs?, beforeRowid?, limit? }) → Promise<Event[]>` (aufgelöste Events, gemappt, jedes mit `_rowid`; **wirft** bei `!res.ok`/Netzfehler). Modul-lokale `mapBackendEvent(row) → Event` (trägt `_rowid` durch). `D.activeEventGroups()` entfällt.

> Hinweis: `data.js` ist Browser-Glue (IIFE mit `fetch`/`setInterval`) und wird von keinem Node-Test importiert. Verifikation = `node --check` (Syntax) + `npm test` bleibt grün; das Laufzeitverhalten wird in Task 4 im Browser geprüft.

- [ ] **Step 1: Konstante ergänzen** — in `data.js` direkt nach `const STEP_MS = 10 * 60 * 1000;` (Zeile ~6) einfügen:

```js
  const POLL_EVENT_LIMIT = 50; // bound the 5s poll's per-station history fetch
```

- [ ] **Step 2: `mapBackendEvent` als Modulfunktion anlegen** — direkt **nach** der Funktion `alarmDirection(...)` (endet ~Zeile 68) einfügen:

```js
  // Map one backend events-row to the frontend event shape. Single source of truth
  // for both the 5s poll and on-demand history fetches.
  function mapBackendEvent(e) {
    return {
      id: e.uuid,
      severity: e.severity,
      system: e.severity === 'system' ? (e.alarm_condition_type || 'maintenance') : null,
      message: e.message || e.alarm_reason || 'Grenzwert verletzt',
      detail: e.detail || `Sensorwert: ${e.alarm_value}`,
      metric: e.metric ? e.metric.toLowerCase() : null,
      condition: alarmDirection(e.alarm_condition_type),
      threshold: e.threshold,
      startTs: e.start_ts,
      endTs: e.end_ts,
      extreme: e.extreme || e.alarm_value,
      active: !!e.active,
      _rowid: e._rowid, // compound-cursor tiebreak (route always returns rowid AS _rowid)
    };
  }
```

- [ ] **Step 3: Poll-Fetch begrenzen + Inline-Mapping ersetzen** — in `refresh()`:

3a. Fetch-URL (Zeile ~226) ändern:

```js
          const resEvents = await fetch(`/api/stations/${s.id}/events?limit=${POLL_EVENT_LIMIT}`);
```

3b. Das Inline-`rawEvents.map(e => ({ … }))` (Zeilen ~229–242) ersetzen durch:

```js
            backendEvents = rawEvents.map(mapBackendEvent);
```

- [ ] **Step 4: Accessor ersetzen + History-Methode ergänzen** — im `window.DASH_DATA`-Objekt die Zeile `activeEventGroups() { return groupActiveEventsByStation(STATIONS, STATION_ORDER); },` ersetzen durch:

```js
    // All stations (incl. quiet), sorted, with their active events (summary-logic.js).
    stationOverview() { return buildStationOverview(STATIONS, STATION_ORDER); },

    // Lazy, paginated resolved-event history for one station. Rejects on failure —
    // callers (StationHistoryGroup) catch and render an inline error.
    async fetchStationHistory(stationId, opts) {
      const limit = (opts && opts.limit) || 20;
      let url = `/api/stations/${stationId}/events?active=0&limit=${limit}`;
      if (opts && opts.beforeTs != null) url += `&before_ts=${opts.beforeTs}`;
      if (opts && opts.beforeRowid != null) url += `&before_rowid=${opts.beforeRowid}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Historie konnte nicht geladen werden');
      const rows = await res.json();
      return rows.map(mapBackendEvent);
    },
```

- [ ] **Step 5: Syntax + Tests prüfen**

Run: `node --check "Smart Meter Dashboard/data.js" && npm test`
Expected: kein Syntaxfehler; alle Tests grün.

- [ ] **Step 6: Commit**

```bash
git add "Smart Meter Dashboard/data.js"
git commit -m "feat(dashboard): stationOverview + paginated fetchStationHistory; cap poll at 50

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Panel-Komponenten + CSS

**Files:**
- Modify: `Smart Meter Dashboard/summary-panel.jsx` (`SystemSummaryPanel` umbauen; `StationHistoryGroup` neu)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (CSS nach der `.tsp-count`-Regel ~Zeile 729 einfügen; `.tsp-group-head`-Regel ~Zeile 719 ersetzen — per Inhalt matchen, Zeilen können durch parallele Merges driften)

**Interfaces:**
- Consumes: `D.stationOverview()`, `D.fetchStationHistory(...)` (Task 3); `EventRow` (global, `tiles.jsx`); `ss*`-Hook-Aliase (bereits in der Datei).
- Produces: visuelles Panel; keine weiteren Code-Abhängigkeiten.

> Verifikation erfolgt im Browser (Preview-Tools), da `.jsx` via Babel im Browser läuft — kein Node-Test.

- [ ] **Step 1: `summary-panel.jsx` — `SystemSummaryPanel` ersetzen + `StationHistoryGroup` ergänzen.** Den `function SystemSummaryPanel() {…}`-Block (ab Zeile ~41 bis Dateiende) ersetzen durch:

```jsx
const PAGE_SIZE = 20;

function SystemSummaryPanel() {
  const D = window.DASH_DATA;
  const overview = D.stationOverview();
  return (
    <div className="top-summary-pop">
      <div className="station-pop-head">Meldungen · alle Messstellen</div>
      {overview.length === 0 ? (
        <div className="alerts-empty">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="11" cy="11" r="8"/><path d="M7 11l3 3 5-6"/>
          </svg>
          <span>Keine Messstellen vorhanden.</span>
        </div>
      ) : (
        overview.map((g) => (
          <StationHistoryGroup key={g.station.id} station={g.station}
                               activeEvents={g.activeEvents} activeCount={g.activeCount} />
        ))
      )}
    </div>
  );
}

function StationHistoryGroup({ station, activeEvents, activeCount }) {
  const D = window.DASH_DATA;
  const [expanded, setExpanded] = ssState(activeCount > 0);
  const [history, setHistory] = ssState([]);
  const [loading, setLoading] = ssState(false);
  const [loaded, setLoaded] = ssState(false);
  const [done, setDone] = ssState(false);
  const [error, setError] = ssState(null);
  const inflight = ssRef(false);

  async function loadPage() {
    if (inflight.current || done) return;
    inflight.current = true;
    setLoading(true);
    setError(null);
    try {
      const last = history[history.length - 1];
      const cursor = last ? { beforeTs: last.startTs, beforeRowid: last._rowid } : {};
      const page = await D.fetchStationHistory(station.id, { ...cursor, limit: PAGE_SIZE });
      setHistory((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return prev.concat(page.filter((e) => !seen.has(e.id)));
      });
      setLoaded(true);
      if (page.length < PAGE_SIZE) setDone(true);
    } catch (e) {
      setError((e && e.message) || 'Historie konnte nicht geladen werden');
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }

  // History is opt-in — there is NO auto-load effect. Quiet stations are only ever opened
  // to see history, so expanding one loads its first page immediately. Active stations are
  // auto-expanded for their active glance; their history waits for an explicit click on
  // the "Historie laden…" button below. Opening the panel triggers zero history requests.
  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && activeCount === 0 && !loaded && !inflight.current) loadPage();
  }

  const evKey = (e) => e.id ?? `${e.startTs}-${e.severity}-${e.metric || 'sys'}`;

  return (
    <div className={`tsp-group ${expanded ? "open" : ""}`}>
      <button className="tsp-group-head" aria-expanded={expanded} onClick={toggle}>
        <span className={`station-dot ${station.online ? "on" : "off"}`} />
        <span className="tsp-group-title">{station.name}</span>
        <span className="station-code">{station.code}</span>
        <span className="tsp-group-loc">{station.location}{station.online ? "" : " · offline"}</span>
        {activeCount > 0
          ? <span className="tsp-count">{activeCount}</span>
          : <span className="tsp-quiet-hint">keine aktiven</span>}
        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"
             stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
      </button>
      {expanded && (
        <div className="tsp-group-body">
          {activeEvents.map((e) => <EventRow event={e} key={evKey(e)} station={station} />)}
          {activeCount > 0 && <div className="tsp-history-divider">Historie</div>}
          {history.length > 0 && (
            <div className="tsp-history">
              {history.map((e) => <EventRow event={e} key={evKey(e)} station={station} />)}
            </div>
          )}
          {loading && <div className="tsp-loading">Historie wird geladen…</div>}
          {!loading && error && (
            <button className="tsp-error" onClick={loadPage}>{error} — erneut versuchen</button>
          )}
          {!loading && !error && loaded && history.length === 0 && (
            <div className="tsp-empty-hist">Keine Meldungen vorhanden.</div>
          )}
          {!loading && !error && loaded && history.length > 0 && !done && (
            <button className="tsp-loadmore" onClick={loadPage}>
              <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
              weitere Einträge laden…
            </button>
          )}
          {!loading && !error && !loaded && (
            <button className="tsp-loadmore" onClick={loadPage}>Historie laden…</button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: CSS — `.tsp-group-head`-Regel ersetzen.** In `Klima Dashboard.html` die bestehende Regel `.tsp-group-head { display: flex; align-items: center; gap: 8px; padding: 2px 8px 6px; }` (~Zeile 719) ersetzen durch:

```css
  button.tsp-group-head {
    width: 100%; appearance: none; background: none; border: none; font: inherit;
    text-align: left; cursor: pointer; border-radius: var(--radius-sm);
    display: flex; align-items: center; gap: 8px; padding: 4px 8px;
  }
  button.tsp-group-head:hover { background: var(--surface-2); }
  button.tsp-group-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tsp-group.open .tsp-group-head .chev { transform: rotate(180deg); }
```

- [ ] **Step 3: CSS — neue Klassen einfügen.** Direkt **nach** der `.tsp-count { … }`-Regel (endet ~Zeile 729) einfügen:

```css
  .tsp-quiet-hint {
    margin-left: auto; flex-shrink: 0;
    font-family: var(--mono); font-size: 10px; color: var(--text-faint);
  }
  .tsp-group-body { padding: 0 2px 2px; }
  .tsp-history-divider {
    display: flex; align-items: center; gap: 8px; margin: 8px 6px 4px;
    font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint);
  }
  .tsp-history-divider::before, .tsp-history-divider::after {
    content: ""; flex: 1; height: 1px; background: var(--border);
  }
  .tsp-history { opacity: 0.82; }
  .tsp-loadmore {
    width: 100%; appearance: none; cursor: pointer; font: inherit; font-size: 12px;
    margin: 4px 2px 2px; padding: 7px;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    background: none; border: 1px dashed var(--border-strong); border-radius: var(--radius-sm);
    color: var(--text-muted);
  }
  .tsp-loadmore:hover { background: var(--surface-2); color: var(--text); }
  .tsp-loading, .tsp-empty-hist {
    padding: 8px; text-align: center; font-size: 12px; color: var(--text-faint);
  }
  .tsp-error {
    width: 100%; appearance: none; cursor: pointer; font: inherit; font-size: 12px;
    margin: 4px 2px 2px; padding: 8px; text-align: center;
    background: var(--alarm-tint); border: 1px solid var(--alarm); border-radius: var(--radius-sm);
    color: var(--alarm);
  }
```

- [ ] **Step 4: Server starten & Panel im Browser prüfen**

Verifikation per Preview-Tools (kein Node-Test möglich):
1. `preview_start` (bzw. sicherstellen, dass `npm start` auf Port 3000 läuft), Dashboard öffnen.
2. `preview_console_logs` — **keine** React-Warnungen (Rules-of-Hooks, Hook-Alias-Kollision → weiße Seite).
3. Auf die `top-summary`-Pille klicken (`preview_click`), `preview_snapshot`:
   - **alle** Messstellen gelistet; Stationen mit aktiven Meldungen aufgeklappt (aktive Zeilen oben), ruhige eingeklappt mit „keine aktiven".
4. Aktive Station: aktive Zeilen + „Historie"-Trenner + Button „Historie laden…" (Historie **nicht** automatisch geladen). Klick auf „Historie laden…" → erste Seite erscheint; „weitere Einträge laden…" hängt weitere Seiten an.
5. Ruhige Station per Klick aufklappen → lädt sofort die erste Historie-Seite bzw. „Keine Meldungen vorhanden.".
6. `preview_network`: das bloße Öffnen des Panels löst **keine** `/events`-Requests aus (Historie strikt opt-in; erst Klick fetcht).
7. `preview_screenshot` als Beleg.

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/summary-panel.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): all-stations panel with expandable lazy-loaded history

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Versionsbump 0.7.0 → 0.8.0 + Gesamt-Verifikation

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm version`), `VERSION`, `README.md`, `Smart Meter Dashboard/Klima Dashboard.html` (`?v=`)

**Interfaces:** keine.

- [ ] **Step 1: Gesamt-Testlauf**

Run: `npm test`
Expected: alle Tests grün (Backend + Frontend).

- [ ] **Step 2: Version in manifest + lockfile bumpen**

Run: `npm version minor --no-git-tag-version`
Expected: Ausgabe `v0.8.0`; `package.json` und `package-lock.json` tragen `0.8.0`.

- [ ] **Step 3: VERSION, README-Badge und `?v=` mitziehen**

```bash
printf '0.8.0\n' > VERSION
sed -i '' 's/version-0\.7\.0-blue/version-0.8.0-blue/' README.md
sed -i '' 's/?v=0\.7\.0/?v=0.8.0/g' "Smart Meter Dashboard/Klima Dashboard.html"
```

- [ ] **Step 4: Konsistenz prüfen (alle Orte = 0.8.0, keine 0.7.0-Reste)**

Run:
```bash
grep -RIn "0\.7\.0" package.json VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html"; echo "exit:$?"
```
Expected: keine Treffer (grep `exit:1`). Gegenprobe: `node -e "console.log(require('./package.json').version)"` → `0.8.0`; `grep -c "?v=0.8.0" "Smart Meter Dashboard/Klima Dashboard.html"` → Anzahl > 0.

- [ ] **Step 5: Browser-Schnellcheck nach Bump** (Stale-Asset-Falle vermeiden)

`preview_eval: window.location.reload()` → Dashboard lädt; Pille klicken → Panel funktioniert; `preview_console_logs` ohne Fehler.

- [ ] **Step 6: Commit + annotierter Tag (kein Push — lokal-only)**

```bash
git add package.json package-lock.json VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.8.0

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag -a v0.8.0 -m "v0.8.0"
```

---

## Self-Review

**Spec-Abdeckung (jede Spec-Sektion → Task):**
- §4.1 Quellentrennung → Task 4 (aktive aus `activeEvents`-Prop, Historie via `fetchStationHistory`).
- §4.2 Backend-Endpoint → Task 1.
- §4.3 Datenschicht (`mapBackendEvent`, Poll-Limit, `stationOverview`, `fetchStationHistory`, `activeEventGroups` entfernt) → Task 3.
- §4.4 `buildStationOverview` (Ersatz, mit Tests) → Task 2.
- §4.5 Panel + `StationHistoryGroup` + `PAGE_SIZE=20` + Footer-Zustände → Task 4.
- §4.6 Fehler-/Leerzustände → Task 4 (`tsp-error`/`tsp-empty-hist`/`tsp-loading`).
- §4.7 Live-Grenzen (key=station.id, kein Refetch) → Task 4 (Komponenten-State + key).
- §4.8 Styling → Task 4 (CSS).
- §5 Dateien → Tasks 1–5; §9 Versionierung → Task 5.
- §7 Tests → Task 1 (Backend) + Task 2 (pure).

**Platzhalter-Scan:** keine TBD/TODO; jeder Code-Schritt enthält vollständigen Code bzw. exakte Befehle. Frontend-Tasks (3/4) sind bewusst Browser-/Syntax-verifiziert (begründet), nicht Node-getestet — entspricht der Projektrealität für `data.js`/`.jsx`.

**Typ-Konsistenz:** `buildStationOverview` liefert `{station, activeEvents, activeCount}` (Task 2) — exakt so konsumiert in `D.stationOverview()` (Task 3) und `SystemSummaryPanel`/`StationHistoryGroup`-Props (Task 4). `fetchStationHistory(stationId, {beforeTs, beforeRowid, limit})` (Task 3) wird in `loadPage()` identisch aufgerufen, Cursor aus `last.startTs`/`last._rowid` (Task 4). Endpoint-Parameter `limit/active/before_ts/before_rowid` (Task 1) = exakt die URL-Bildung in Task 3; `mapBackendEvent` reicht `_rowid` durch (Task 3), das die Route als `rowid AS _rowid` liefert (Task 1). Historie ist opt-in: kein Auto-Load-Effekt, `loadPage` nur klick-getriggert (Task 4) — deckt sich mit der „weitere laden"-Semantik des Specs.
