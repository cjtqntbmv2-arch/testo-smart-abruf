# Echte Alarm-Dauer & Episode-Konsolidierung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jede abgeschlossene Alarm-Episode zeigt in der Historie ihre echte Dauer (Lücke Verletzung→Entspannung) statt „< 1 min", und reine Entspannungs-Zeilen erscheinen nicht mehr als Phantom-Karte.

**Architecture:** Der testo `/v3/alarms`-Feed ist ein Übergangs-Log (Verletzung `'Alarm'` und Entspannung `'Ok'` = getrennte Zeilen). `end_ts` einer Zeile wird in der Sync-Reconciliation neu als Start des **nächsten Übergangs derselben logischen Gruppe** berechnet (`LEAD`-Fensterfunktion über dieselbe Partition wie die Aktiv-Reconciliation). Der History-Endpoint blendet `'Ok'`-Zeilen aus. Das Frontend bleibt bis auf einen defensiven `NaN`-Guard unverändert.

**Tech Stack:** Node.js, Express, better-sqlite3 (SQLite, Fensterfunktionen + `UPDATE…FROM`), Tests via `node --test` (`npm test`), React (Babel-in-Browser, kein Build-Step).

## Global Constraints

- **Version-Ziel:** `0.9.2 → 0.9.3` (PATCH). Synchron halten: `VERSION`, README-Badge (`version-0.9.3-blue`), `?v=`-Cache-Buster in `Smart Meter Dashboard/Klima Dashboard.html` (alle `?v=0.9.2` → `?v=0.9.3`).
- **Kein Git-Remote** → Versionierungs-Tag/-Push **entfällt**; nur lokaler `chore`-Commit.
- **Partition-Schlüssel** (identisch zur bestehenden Aktiv-Reconciliation, exakt übernehmen): `station_id, COALESCE(serial_no,''), alarm_condition_type, severity, COALESCE(metric,'')`.
- **`sys-*`-Zeilen** (`alarm_status IS NULL`, von `applySystemEvents`) werden von Reconciliation und Filter **nicht** angetastet.
- **TDD:** zuerst roter Test, dann minimale Implementierung. Häufige, kleine Commits.
- Tests laufen mit `:memory:`-DB; jeder neue Test nutzt eine **eindeutige** `station_id`, um Kollisionen in der geteilten In-Memory-DB zu vermeiden.

---

### Task 1: Reconciliation berechnet `end_ts` aus dem nächsten Übergang

**Files:**
- Modify: `backend/scheduler.js` (Reconciliation-Transaktion, aktuell Zeilen 364–380)
- Test: `backend/tests/scheduler.test.js`

**Interfaces:**
- Consumes: `schedulerModule.runSyncCycle(client)`, `MockTestoClient` (beide bereits in `scheduler.test.js` vorhanden), `getDb()`, `initDb()`, `saveSetting()`, `closeDb()` aus `../db`.
- Produces: Nach `runSyncCycle` trägt jede Feed-Zeile (`alarm_status IS NOT NULL`) in `events.end_ts` den `start_ts` des chronologisch nächsten Übergangs derselben Partition; die neueste Zeile je Gruppe hat `end_ts = NULL`.

- [ ] **Step 1: SQLite-Voraussetzung verifizieren**

Run:
```bash
node -e "console.log(require('better-sqlite3')(':memory:').prepare('SELECT sqlite_version() AS v').get())"
```
Expected: `{ v: '3.x.y' }` mit x ≥ 33 (für `UPDATE … FROM`; Fensterfunktionen ab 3.25). Bei < 3.33 stoppen und in der Reconciliation auf eine korrelierte Subquery ausweichen (nicht erwartet — better-sqlite3 bündelt ≥ 3.40).

- [ ] **Step 2: Failing-Tests schreiben** (`backend/tests/scheduler.test.js`, ans Dateiende anhängen)

```js
test('Sync derives episode end_ts from the next transition in the same group', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  const base = Date.parse('2026-05-29T06:00:00Z');
  const mk = (uuid, status, offsetMin) => ({
    uuid, serial_no: 'SN123', alarm_source_uuid: 'dev-1',
    alarm_type: 'device system alarm', alarm_severity: 'Warning', alarm_status: status,
    alarm_reason: status === 'Alarm' ? 'Alarm condition is violated' : 'Alarm condition is adhered',
    alarm_condition_type: 'Connection timeout, device did not communicated in expected time',
    alarm_value: null,
    alarm_time: new Date(base + offsetMin * 60000).toISOString(),
    last_status_change_time: new Date(base + offsetMin * 60000).toISOString(),
  });

  // violated(0) -> adhered(20) -> violated(40), one logical group
  await schedulerModule.runSyncCycle(new MockTestoClient([
    mk('v1', 'Alarm', 0),
    mk('a1', 'Ok', 20),
    mk('v2', 'Alarm', 40),
  ]));

  const by = Object.fromEntries(
    db.prepare("SELECT uuid, start_ts, end_ts, active FROM events WHERE station_id='emc'")
      .all().map(r => [r.uuid, r])
  );
  assert.strictEqual(by['v1'].end_ts, base + 20 * 60000, 'violation end_ts = its recovery start');
  assert.strictEqual(by['v1'].end_ts - by['v1'].start_ts, 20 * 60000, 'episode duration = 20 min');
  assert.strictEqual(by['a1'].end_ts, base + 40 * 60000, 'recovery end_ts = following violation start');
  assert.strictEqual(by['v2'].end_ts, null, 'latest (active) transition has null end_ts');
  assert.strictEqual(by['v2'].active, 1, 'latest unresolved violation stays active');

  closeDb();
});

test('end_ts pairs only within a group — interleaved groups do not cross-pair', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // Insert two logical groups directly, timestamps interleaved across groups.
  // group A: alarm_condition_type 'connection', group B: 'battery' (distinct partitions).
  const base = Date.parse('2026-05-29T06:00:00Z');
  const ins = db.prepare(`INSERT INTO events
    (uuid, station_id, severity, alarm_status, alarm_condition_type, serial_no, metric, start_ts, end_ts, active)
    VALUES (?, 'emc', 'system', ?, ?, 'SN123', NULL, ?, ?, 0)`);
  ins.run('A-v',  'Alarm', 'connection', base + 0 * 60000,  base + 0 * 60000);
  ins.run('B-v',  'Alarm', 'battery',    base + 10 * 60000, base + 10 * 60000);
  ins.run('A-ok', 'Ok',    'connection', base + 30 * 60000, base + 30 * 60000);
  ins.run('B-ok', 'Ok',    'battery',    base + 50 * 60000, base + 50 * 60000);

  // Empty alarm feed: no inserts, but reconciliation still recomputes end_ts over all rows.
  await schedulerModule.runSyncCycle(new MockTestoClient([]));

  const by = Object.fromEntries(
    db.prepare("SELECT uuid, end_ts FROM events WHERE station_id='emc'")
      .all().map(r => [r.uuid, r])
  );
  assert.strictEqual(by['A-v'].end_ts, base + 30 * 60000, 'connection violation pairs with connection recovery');
  assert.strictEqual(by['B-v'].end_ts, base + 50 * 60000, 'battery violation pairs with battery recovery');

  closeDb();
});
```

- [ ] **Step 3: Tests laufen lassen — müssen fehlschlagen**

Run: `npm test`
Expected: Beide neuen Tests FAIL. `v1.end_ts` ist `base` (alt: `last_status_change_time` der eigenen Zeile) statt `base + 20min`; `A-v.end_ts` ist `base` statt `base + 30min`.

- [ ] **Step 4: Reconciliation um `end_ts`-Berechnung erweitern** (`backend/scheduler.js`)

In der bestehenden Reconciliation-Transaktion **nach** dem `active = 1`-UPDATE (vor dem schließenden `})();`, aktuell um Zeile 379) dieses Statement einfügen:

```js
        // Episode end_ts = start of the NEXT transition in the same logical group.
        // The feed is a transition log; a violation's real end is its recovery's start
        // (or the next violation if no recovery was recorded). LEAD over the SAME
        // partition as the active reconciliation, ordered ascending, yields that next
        // start. The newest row in a group (the active violation, or a trailing
        // recovery) gets NULL — the frontend shows "läuft" for active rows via the
        // active flag, not via end_ts. This runs over ALL stored feed rows every cycle,
        // so historical durations settle even when only one side was fetched this cycle.
        db.prepare(`
          UPDATE events AS e
          SET end_ts = nxt.next_start
          FROM (
            SELECT rowid AS rid,
              LEAD(start_ts) OVER (
                PARTITION BY station_id, COALESCE(serial_no,''), alarm_condition_type, severity, COALESCE(metric,'')
                ORDER BY start_ts ASC, rowid ASC
              ) AS next_start
            FROM events
            WHERE alarm_status IS NOT NULL
          ) AS nxt
          WHERE e.rowid = nxt.rid AND e.alarm_status IS NOT NULL
        `).run();
```

- [ ] **Step 5: Tests laufen lassen — müssen bestehen**

Run: `npm test`
Expected: Alle Tests PASS, inkl. der beiden neuen und des bestehenden Reconciliation-Tests (`scheduler.test.js:136`).

- [ ] **Step 6: Commit**

```bash
git add backend/scheduler.js backend/tests/scheduler.test.js
git commit -m "fix(alarms): echte Episodendauer via end_ts = naechster Uebergang

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: History-Endpoint blendet Entspannungen (`'Ok'`) aus

**Files:**
- Modify: `backend/server.js` (`GET /api/stations/:id/events`, aktuell Zeilen 192–223)
- Test: `backend/tests/server.test.js`

**Interfaces:**
- Consumes: laufender Test-Server auf `http://localhost:3001` (in `server.test.js` bereits gestartet), `getDb()` aus `../db`.
- Produces: `/api/stations/:id/events` liefert keine Zeilen mit `alarm_status = 'Ok'`; `'Alarm'`-Zeilen und `sys-*`-Zeilen (`alarm_status IS NULL`) bleiben enthalten.

- [ ] **Step 1: Failing-Test schreiben** (`backend/tests/server.test.js`, vor dem abschließenden `after(...)`/Dateiende anhängen)

```js
test('GET /api/stations/:id/events hides recovery (Ok) rows, keeps Alarm and sys-* rows', async () => {
  const db = getDb();
  db.prepare("INSERT INTO stations (id, name) VALUES ('evfilt','EvFilt')").run();
  const t = Date.now() - 3600000;
  db.prepare("INSERT INTO events (uuid, station_id, severity, alarm_status, start_ts, active) VALUES ('ev-alarm','evfilt','warning','Alarm',?,0)").run(t);
  db.prepare("INSERT INTO events (uuid, station_id, severity, alarm_status, start_ts, active) VALUES ('ev-ok','evfilt','warning','Ok',?,0)").run(t + 60000);
  db.prepare("INSERT INTO events (uuid, station_id, severity, alarm_status, start_ts, active) VALUES ('ev-sys','evfilt','system',NULL,?,0)").run(t + 120000);

  const res = await fetch('http://localhost:3001/api/stations/evfilt/events?active=0');
  assert.strictEqual(res.status, 200);
  const uuids = (await res.json()).map(e => e.uuid);
  assert.ok(uuids.includes('ev-alarm'), 'violation rows are shown');
  assert.ok(uuids.includes('ev-sys'), 'self-derived sys-* rows are shown');
  assert.ok(!uuids.includes('ev-ok'), 'recovery (Ok) rows are hidden');
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npm test`
Expected: FAIL — `uuids` enthält `'ev-ok'` (Endpoint liefert aktuell alle `active=0`-Zeilen).

- [ ] **Step 3: Ausschluss-Klausel einfügen** (`backend/server.js`)

Direkt nach der Initialisierung von `clauses`/`params` (nach `const params = [req.params.id];`, aktuell Zeile 194) einfügen:

```js
  // Recovery transitions ('Ok') are the closing edge of an episode, not standalone
  // events — their timestamp is folded into the violation's duration (end_ts), so they
  // must never render as their own card. Self-derived sys-* rows (alarm_status NULL)
  // and active rows (never 'Ok') are unaffected.
  clauses.push("(alarm_status IS NULL OR alarm_status <> 'Ok')");
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npm test`
Expected: Alle Tests PASS, inkl. des neuen Endpoint-Tests.

- [ ] **Step 5: Commit**

```bash
git add backend/server.js backend/tests/server.test.js
git commit -m "fix(alarms): History-Endpoint blendet Ok-Entspannungszeilen aus

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Defensiver `NaN`-Guard in `formatDuration`

**Files:**
- Modify: `Smart Meter Dashboard/data.js` (`formatDuration`, aktuell Zeilen 365–372)

**Interfaces:**
- Consumes: nichts Neues.
- Produces: `formatDuration(ms)` gibt für nicht-endliche `ms` (`NaN`/`null`/`undefined`) `"—"` zurück, statt „NaN h".

**Hinweis:** `data.js` ist die Browser-Datenschicht (Objekt-Literal, via Babel im Browser geladen) und hat keinen node-Unit-Test-Harness. Der Guard ist ein defensiver Einzeiler für den Fall einer inaktiven Zeile ohne `end_ts` (kommt bei sichtbaren Zeilen normalerweise nicht vor, da inaktive Verletzungen stets einen Folge-Übergang haben). Die korrekte Dauer-Anzeige wird in Task 4 in der Preview verifiziert.

- [ ] **Step 1: Guard einfügen** (`Smart Meter Dashboard/data.js`)

`formatDuration` so ändern (erste Zeile ergänzen):

```js
    formatDuration(ms) {
      if (!Number.isFinite(ms)) return "—";
      const m = Math.round(ms / 60000);
      if (m < 1) return "< 1 min";
      if (m < 60) return `${m} min`;
      const h = Math.floor(m / 60);
      const rm = m % 60;
      return rm ? `${h} h ${rm} min` : `${h} h`;
    },
```

- [ ] **Step 2: Manuelle Plausibilität (kein Build-Step)**

Run:
```bash
node -e "const f=(ms)=>{if(!Number.isFinite(ms))return '—';const m=Math.round(ms/60000);if(m<1)return '< 1 min';if(m<60)return m+' min';const h=Math.floor(m/60),rm=m%60;return rm?h+' h '+rm+' min':h+' h';}; console.log(f(NaN),'|',f(null),'|',f(47*60000),'|',f(72*60000),'|',f(30000))"
```
Expected: `— | — | 47 min | 1 h 12 min | < 1 min` (Guard greift, Zahlfälle unverändert).

- [ ] **Step 3: Commit**

```bash
git add "Smart Meter Dashboard/data.js"
git commit -m "fix(ui): formatDuration faengt nicht-endliche Dauer mit Strich ab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Versions-Bump 0.9.3 + Verifikation auf echten Daten

**Files:**
- Modify: `VERSION`
- Modify: `README.md` (Badge)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (alle `?v=0.9.2` → `?v=0.9.3`)

**Interfaces:**
- Consumes: die in Task 1–3 implementierten Änderungen.
- Produces: konsistente Version `0.9.3` an allen drei Stellen; verifizierte korrekte Dauer-Anzeige.

- [ ] **Step 1: Version an allen drei Stellen setzen**

```bash
cd "/Users/dniehof/Programming/Programme/testo-smart-abruf"
printf '0.9.3\n' > VERSION
sed -i '' 's/version-0\.9\.2-blue/version-0.9.3-blue/' README.md
sed -i '' 's/?v=0\.9\.2/?v=0.9.3/g' "Smart Meter Dashboard/Klima Dashboard.html"
```

- [ ] **Step 2: Konsistenz prüfen**

Run:
```bash
cat VERSION; grep -o "version-[0-9.]*-blue" README.md | head -1; grep -o "?v=[0-9.]*" "Smart Meter Dashboard/Klima Dashboard.html" | sort -u
```
Expected: `0.9.3`, `version-0.9.3-blue`, und genau `?v=0.9.3` (kein verbleibendes `?v=0.9.2`).

- [ ] **Step 3: Volle Test-Suite grün**

Run: `npm test`
Expected: alle Tests PASS (keine Regression).

- [ ] **Step 4: Reconciliation auf echte DB anwenden + Belege ziehen**

Die Reconciliation läuft im Betrieb jeden Sync-Zyklus über `klima.db`. Um die Korrektur auf den Bestandsdaten ohne Wartezeit zu belegen, dieselbe `end_ts`-Berechnung einmal direkt anwenden und Vorher/Nachher zeigen:

Run:
```bash
node -e '
const Database = require("better-sqlite3");
const db = new Database("klima.db");
const before = db.prepare("SELECT COUNT(*) c FROM events WHERE alarm_status IS NOT NULL AND COALESCE(end_ts,start_ts)-start_ts < 60000").get().c;
db.prepare(`
  UPDATE events AS e SET end_ts = nxt.next_start
  FROM ( SELECT rowid AS rid, LEAD(start_ts) OVER (
           PARTITION BY station_id, COALESCE(serial_no,""), alarm_condition_type, severity, COALESCE(metric,"")
           ORDER BY start_ts ASC, rowid ASC) AS next_start
         FROM events WHERE alarm_status IS NOT NULL ) AS nxt
  WHERE e.rowid = nxt.rid AND e.alarm_status IS NOT NULL
`).run();
const after = db.prepare("SELECT severity, alarm_status, (end_ts-start_ts) dur_ms FROM events WHERE alarm_status=\"Alarm\" AND end_ts IS NOT NULL AND end_ts>start_ts ORDER BY start_ts DESC LIMIT 5").all();
console.log("rows_under_1min_before:", before);
console.log("sample violation durations (min):", after.map(r => Math.round(r.dur_ms/60000)));
'
```
Expected: `rows_under_1min_before` ist hoch (~340); die Stichprobe zeigt realistische Dauern in Minuten (nicht 0). Dies ist exakt die Operation, die der Scheduler ohnehin idempotent in jedem Zyklus ausführt.

- [ ] **Step 5: Preview-Verifikation**

- `preview_start` (bzw. `npm start`), Dashboard öffnen, eine Messstelle mit Historie wählen, „HISTORIE" aufklappen.
- `preview_screenshot`: bestätigen, dass (a) vergangene Meldungen **echte Dauern** zeigen (z. B. „47 min", „1 h 12 min") statt durchgängig „< 1 min", und (b) **keine** Phantom-Karte mit `Spitze` unter der Schwelle mehr erscheint (Entspannungs-Zeilen ausgeblendet).
- `preview_console_logs`: keine neuen Fehler (insb. kein „NaN").

- [ ] **Step 6: Commit**

```bash
git add VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.9.3

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review-Notiz (Plan ↔ Spec)

- Spec-Lösung 1 (Reconciliation `end_ts`) → Task 1. Spec-Lösung 2 (Endpoint-Filter) → Task 2. Spec-Lösung 3 (`formatDuration`-Guard) → Task 3. Versionierung → Task 4.
- Spec-Tests: Episodendauer-Paar, aktive Verletzung `end_ts NULL`, zwei Verletzungen ohne Entspannung (via `adhered→violated`-Kette in Task-1-Test 1 + `LEAD`-Generik), Partition-Trennung (Task-1-Test 2), `'Ok'`-Filter inkl. `sys-*`/aktiv (Task 2), `formatDuration`-Guard (Task 3 Step 2).
- Akzeptanzkriterien 1–7 der Spec sind durch Task 1 (1,3), Task 2 (2,4), „Migration"-Verhalten (5, Task 4 Step 4), `npm test` (6) und Versionskonsistenz (7) abgedeckt.
- Keine Migration nötig — Bestandsdaten heilen sich beim nächsten Sync; Task 4 Step 4 belegt das auf der realen DB.
