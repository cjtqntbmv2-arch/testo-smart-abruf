# System-Alarm Meldungstexte Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed-basierte System-Alarme (Verbindung/Batterie/Gerät) zeigen verständliche deutsche Überschrift + Detailzeile statt „Alarm condition is violated" / „Sensor X hat einen Wert von null gemeldet."; Messwert-Alarme mit nicht-numerischem Wert zeigen nie mehr „null".

**Architecture:** Eine neue reine Helper-Funktion `systemAlarmText(systemType)` in `backend/device-bridge.js` liefert je Subtyp `{ message, detail }`. Der Insert-Block in `backend/scheduler.js` verwendet sie für System-Alarme und einen gegen `null` abgesicherten Detailtext für Messwert-Alarme. Keine Frontend-Änderung — alle Renderer lesen `e.message`/`e.detail`.

**Tech Stack:** Node.js, `node:test` + `node:assert`, better-sqlite3 (In-Memory für Tests).

## Global Constraints

- Sprache aller neuen Anwender-Texte: **Deutsch**; Umlaute korrekt (`Gerät`, `Batterie`).
- `backend/device-bridge.js` enthält **reine** Mapping-Helfer — keine Seiteneffekte, kein DB-/Zeit-Zugriff.
- TDD: jeder Code-Schritt zuerst als fehlschlagender Test, dann minimale Implementierung.
- Wortlaute exakt wie in der Spec (`docs/superpowers/specs/2026-06-19-system-alarm-meldungstexte-design.md`):
  - `connection` → message `Verbindung verloren`, detail `Gerät hat sich nicht im erwarteten Intervall gemeldet.`
  - `battery` → message `Batterie schwach`, detail `Batteriestand des Geräts ist niedrig.`
  - `maintenance`/Fallback → message `Gerätehinweis`, detail `Das Gerät meldet einen Geräte- oder Wartungshinweis.`
- Version-Ziel: **0.9.0 → 0.9.1** (PATCH). Kein Git-Remote konfiguriert → **kein Tag, kein Push**; nur `VERSION`, README-Badge und die `?v=`-Cache-Buster konsistent halten.
- Voller Testlauf `npm test` muss am Ende grün sein (Basis: 92 Tests).

---

### Task 1: `systemAlarmText` Pure-Function

**Files:**
- Modify: `backend/device-bridge.js` (neue Funktion + Export in `module.exports`, Zeile 252)
- Test: `backend/tests/device-bridge.test.js` (Require-Zeile 3 + neuer Test)

**Interfaces:**
- Consumes: nichts (reine Funktion).
- Produces: `systemAlarmText(systemType: 'connection'|'battery'|'maintenance'|string|null|undefined) → { message: string, detail: string }`. Unbekannte/fehlende Subtypen liefern den `maintenance`-Text.

- [ ] **Step 1: Failing test schreiben**

In `backend/tests/device-bridge.test.js` die Require-Destrukturierung (Zeile 3) um `systemAlarmText` erweitern:

```js
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions, classifyAlarm, alarmConditionDirection, parseAlarmConfiguration, systemAlarmText } = require('../device-bridge');
```

Am Ende der Datei diesen Test anhängen:

```js
test('systemAlarmText returns German headline + detail per system subtype, with a maintenance fallback', () => {
  assert.deepStrictEqual(systemAlarmText('connection'),
    { message: 'Verbindung verloren', detail: 'Gerät hat sich nicht im erwarteten Intervall gemeldet.' });
  assert.deepStrictEqual(systemAlarmText('battery'),
    { message: 'Batterie schwach', detail: 'Batteriestand des Geräts ist niedrig.' });
  assert.deepStrictEqual(systemAlarmText('maintenance'),
    { message: 'Gerätehinweis', detail: 'Das Gerät meldet einen Geräte- oder Wartungshinweis.' });
  // Unbekannte / fehlende Subtypen fallen sicher auf den maintenance-Text zurück (nie "undefined").
  assert.deepStrictEqual(systemAlarmText('unbekannt'), systemAlarmText('maintenance'));
  assert.deepStrictEqual(systemAlarmText(null), systemAlarmText('maintenance'));
  assert.deepStrictEqual(systemAlarmText(undefined), systemAlarmText('maintenance'));
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm test -- --test-name-pattern="systemAlarmText"`
(oder voller Lauf `npm test`)
Expected: FAIL — `systemAlarmText is not a function`.

- [ ] **Step 3: Minimale Implementierung**

In `backend/device-bridge.js` direkt vor `deriveSystemConditions` (oder direkt nach `classifyAlarm`) einfügen:

```js
// Map a system-alarm subtype (from classifyAlarm) to the German headline + detail the
// dashboard shows. System alarms carry no measured value, so the measurement template
// ("… hat einen Wert von X gemeldet.") must never be applied to them. Wording mirrors the
// synthetic rows in deriveSystemConditions so feed-based and self-derived system messages
// read identically. Unknown/missing subtypes fall back to the neutral maintenance text.
function systemAlarmText(systemType) {
  switch (systemType) {
    case 'connection':
      return { message: 'Verbindung verloren', detail: 'Gerät hat sich nicht im erwarteten Intervall gemeldet.' };
    case 'battery':
      return { message: 'Batterie schwach', detail: 'Batteriestand des Geräts ist niedrig.' };
    case 'maintenance':
    default:
      return { message: 'Gerätehinweis', detail: 'Das Gerät meldet einen Geräte- oder Wartungshinweis.' };
  }
}
```

`module.exports` (Zeile 252) um `systemAlarmText` erweitern:

```js
module.exports = { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions, classifyAlarm, alarmConditionDirection, parseAlarmConfiguration, systemAlarmText };
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npm test -- --test-name-pattern="systemAlarmText"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/device-bridge.js backend/tests/device-bridge.test.js
git commit -m "feat(alarms): systemAlarmText liefert deutsche System-Alarm-Texte"
```

---

### Task 2: Scheduler-Verdrahtung + Messwert-Guard

**Files:**
- Modify: `backend/scheduler.js` (Require Zeile 3; Insert-Block Zeilen 325-333)
- Test: `backend/tests/scheduler.test.js` (bestehenden Connection-Test ~Zeile 123 erweitern; neuen Messwert-Test anhängen)

**Interfaces:**
- Consumes: `systemAlarmText` aus `./device-bridge` (Task 1); vorhandene lokale Variablen `severity`, `systemType` (aus `classifyAlarm`) und `alarmValue` (gecoercte Zahl oder `null`).
- Produces: gespeicherte `events`-Zeilen mit korrekten `message`/`detail`-Spalten. Keine neue Signatur nach außen.

- [ ] **Step 1: Failing tests schreiben**

(a) Bestehenden Test „Sync ingests a testo connection-timeout system alarm as an active system event" erweitern — die SELECT-Zeile (aktuell Zeile 123) und Assertions ersetzen durch:

```js
  const ev = db.prepare("SELECT severity, alarm_condition_type, active, message, detail FROM events WHERE uuid = ?").get('alarm-conn-1');
  assert.ok(ev, 'the connection-timeout alarm must be stored');
  assert.strictEqual(ev.severity, 'system');
  assert.strictEqual(ev.alarm_condition_type, 'connection');
  assert.strictEqual(ev.active, 1);
  // Verständlicher deutscher Text statt API-Rohtext / "Wert von null".
  assert.strictEqual(ev.message, 'Verbindung verloren');
  assert.strictEqual(ev.detail, 'Gerät hat sich nicht im erwarteten Intervall gemeldet.');
  assert.ok(!/null/.test(ev.detail), 'detail darf kein wörtliches "null" enthalten');
```

(b) Neuen Test ans Dateiende anhängen (Messwert-Alarm mit nicht-numerischem Wert):

```js
test('Measurement alarm with a non-numeric value gets a generic detail, never "Wert von null"', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // Messwert-Alarm (kein System-Alarm), dessen alarm_value ausnahmsweise null ist.
  const alarm = [{
    uuid: 'alarm-meas-nonum', serial_no: 'SN123', alarm_source_uuid: 'sensor-1',
    alarm_type: 'measurement alarm', alarm_severity: 'Alarm', alarm_status: 'Alarm',
    alarm_reason: 'Alarm condition is violated', alarm_condition_type: 'Upper limit',
    physical_property_name: 'Temperature', physical_extension: null,
    alarm_value: null, physical_value: 'Temperature',
    alarm_time: '2026-05-29T06:10:00Z', last_status_change_time: '2026-05-29T06:10:00Z'
  }];

  await schedulerModule.runSyncCycle(new MockTestoClient(alarm));

  const ev = db.prepare("SELECT severity, message, detail FROM events WHERE uuid = ?").get('alarm-meas-nonum');
  assert.ok(ev, 'the measurement alarm must be stored');
  assert.notStrictEqual(ev.severity, 'system');
  assert.strictEqual(ev.detail, 'Sensor SN123 hat einen Grenzwert verletzt.');
  assert.ok(!/null/.test(ev.detail), 'detail darf kein wörtliches "null" enthalten');

  closeDb();
});
```

(c) Neuen Test ans Dateiende anhängen (System-Alarm ohne connection/battery-Bezug ⟹
`maintenance`-Fallback — bisher ungetesteter Feed-Pfad):

```js
test('Sync ingests a non-connection/non-battery system alarm with the maintenance fallback text', async () => {
  initDb();
  saveSetting('api_key', 'mock-key');
  saveSetting('api_region', 'eu');

  const db = getDb();
  db.prepare(`INSERT INTO stations (id, name, device_uuid) VALUES (?, ?, ?)`)
    .run('emc', 'EMC', 'dev-1');

  // alarm_type enthält "system" → System-Alarm; condition nennt weder Verbindung noch
  // Batterie → classifyAlarm.subtypeOf() liefert 'maintenance'.
  const alarm = [{
    uuid: 'alarm-maint-1', serial_no: 'SN123', alarm_source_uuid: 'dev-1',
    alarm_type: 'device system alarm', alarm_severity: 'Warning', alarm_status: 'Alarm',
    alarm_reason: 'Alarm condition is violated', alarm_condition_type: 'Sensor maintenance required',
    alarm_value: null, physical_value: null,
    alarm_time: '2026-05-29T06:10:00Z', last_status_change_time: '2026-05-29T06:10:00Z'
  }];

  await schedulerModule.runSyncCycle(new MockTestoClient(alarm));

  const ev = db.prepare("SELECT severity, alarm_condition_type, message, detail FROM events WHERE uuid = ?").get('alarm-maint-1');
  assert.ok(ev, 'the maintenance system alarm must be stored');
  assert.strictEqual(ev.severity, 'system');
  assert.strictEqual(ev.alarm_condition_type, 'maintenance');
  assert.strictEqual(ev.message, 'Gerätehinweis');
  assert.strictEqual(ev.detail, 'Das Gerät meldet einen Geräte- oder Wartungshinweis.');

  closeDb();
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `npm test`
Expected: FAIL — der Connection-Test bekommt `message === 'Alarm condition is violated'` und `detail === 'Sensor SN123 hat einen Wert von null gemeldet.'`; der neue Messwert-Test scheitert am `/null/`-Check.

- [ ] **Step 3: Implementierung — Require erweitern**

In `backend/scheduler.js` Zeile 3 die Destrukturierung aus `./device-bridge` um `systemAlarmText` ergänzen:

```js
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions, classifyAlarm, alarmConditionDirection, parseAlarmConfiguration, systemAlarmText } = require('./device-bridge');
```

- [ ] **Step 4: Implementierung — Insert-Block anpassen**

Den Block `insertAlarmStmt.run(...)` (Zeilen 325-333) ersetzen durch:

```js
          let message, detail;
          if (severity === 'system') {
            ({ message, detail } = systemAlarmText(systemType));
          } else {
            message = a.alarm_reason || 'Grenzwert verletzt';
            detail = alarmValue != null
              ? `Sensor ${a.serial_no} hat einen Wert von ${alarmValue} gemeldet.`
              : `Sensor ${a.serial_no} hat einen Grenzwert verletzt.`;
          }

          insertAlarmStmt.run(
            a.uuid, stationId,
            severity,
            a.alarm_status, a.alarm_reason, conditionForFrontend, alarmValue,
            metric, threshold,
            parseTimestamp(a.alarm_time), parseTimestamp(a.last_status_change_time), alarmValue,
            isActive, message,
            detail,
            a.serial_no || null);
```

Hinweis: Die `alarm_reason`-Spalte (5. Argument) bleibt unverändert `a.alarm_reason` — sie ist der Roh-Audit-Wert; nur die Anzeige-Spalten `message` (14.) und `detail` (15.) ändern sich. Das Detail nutzt jetzt den gecoerceten `alarmValue` statt `a.alarm_value`.

- [ ] **Step 5: Tests laufen lassen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS (alle Tests grün, inkl. erweitertem Connection-Test und neuem Messwert-Test).

- [ ] **Step 6: Commit**

```bash
git add backend/scheduler.js backend/tests/scheduler.test.js
git commit -m "fix(alarms): System-Alarme mit verständlichem Text, Messwert-Guard gegen null"
```

---

### Task 3: Einmal-Migration bestehender Zeilen

**Files:**
- Create: `scripts/migrate-system-alarm-text.js`

**Interfaces:**
- Consumes: `systemAlarmText` aus `../backend/device-bridge` (Task 1); `better-sqlite3`.
- Produces: ausführbares CLI-Skript (Dry-Run-Default, `--apply`, `--db <pfad>`), das
  bestehende System-Feed- und „Wert von null"-Messwert-Zeilen in-place korrigiert.

Hinweis: Wie die vier bestehenden `scripts/migrate-*.js` ist dies ein einmaliges,
selbst-validierendes Operations-Skript **ohne Unit-Test** (Repo-Konvention) — die Sicherheit
liefern Dry-Run-Default + Post-Check nach `--apply`.

- [ ] **Step 1: Skript anlegen**

`scripts/migrate-system-alarm-text.js` mit exakt diesem Inhalt:

```js
#!/usr/bin/env node
// One-off, idempotent data migration.
//
// Background: feed-based testo system alarms (connection/battery/device) and measurement
// alarms with a null value were stored with the measurement template, producing the English
// headline "Alarm condition is violated" and the misleading detail
// "Sensor X hat einen Wert von null gemeldet." The forward fix (systemAlarmText in
// device-bridge.js, wired into scheduler.js) only affects newly fetched alarms; the upsert
// refreshes re-seen alarms, but a long-active alarm whose timestamp sits outside the
// alarm-fetch window is never re-fetched and would keep the old text forever.
//
// This script repairs already-stored rows in place:
//   - System feed rows (severity 'system', alarm_status IS NOT NULL): message/detail are
//     re-derived from systemAlarmText(alarm_condition_type) — for system rows that column
//     already holds the normalized subtype 'connection'/'battery'/'maintenance'.
//   - Measurement rows still carrying "... hat einen Wert von null gemeldet.": detail is
//     rewritten to "Sensor <serial_no> hat einen Grenzwert verletzt." (message unchanged).
// Synthetic sys-* rows (alarm_status IS NULL) already carry correct text and are skipped.
//
// Usage:
//   node scripts/migrate-system-alarm-text.js [--apply] [--db <path>]
// Default is a dry run (no writes). Pass --apply to write changes.

const path = require('path');
const Database = require('better-sqlite3');
const { systemAlarmText } = require('../backend/device-bridge');

const apply = process.argv.includes('--apply');
const dbArgIdx = process.argv.indexOf('--db');
const dbPath = dbArgIdx !== -1 ? process.argv[dbArgIdx + 1] : path.join(__dirname, '..', 'klima.db');

const db = new Database(dbPath);

// System feed rows whose stored message/detail differ from the canonical subtype text.
const sysRows = db
  .prepare(`SELECT uuid, alarm_condition_type, message, detail
            FROM events
            WHERE severity = 'system' AND alarm_status IS NOT NULL`)
  .all()
  .map((r) => ({ ...r, want: systemAlarmText(r.alarm_condition_type) }))
  .filter((r) => r.message !== r.want.message || r.detail !== r.want.detail);

// Measurement rows still carrying the "Wert von null" detail.
const measRows = db
  .prepare(`SELECT uuid, serial_no
            FROM events
            WHERE severity != 'system' AND detail LIKE '%hat einen Wert von null gemeldet.%'`)
  .all()
  .map((r) => ({ ...r, want: r.serial_no
      ? `Sensor ${r.serial_no} hat einen Grenzwert verletzt.`
      : 'Grenzwert verletzt.' }));

if (sysRows.length === 0 && measRows.length === 0) {
  console.log(`No stale alarm texts in ${dbPath}; nothing to migrate (already clean).`);
  db.close();
  process.exit(0);
}

console.log(`System feed rows to relabel: ${sysRows.length}`);
console.log(`Measurement "Wert von null" rows to fix: ${measRows.length}`);

if (apply) {
  const updSys = db.prepare(`UPDATE events SET message = ?, detail = ? WHERE uuid = ?`);
  const updMeas = db.prepare(`UPDATE events SET detail = ? WHERE uuid = ?`);
  const tx = db.transaction(() => {
    for (const r of sysRows) updSys.run(r.want.message, r.want.detail, r.uuid);
    for (const r of measRows) updMeas.run(r.want, r.uuid);
  });
  tx();

  // Post-condition: no system feed row deviates from its canonical text; no row keeps "null".
  const sysLeft = db
    .prepare(`SELECT uuid, alarm_condition_type, message, detail
              FROM events WHERE severity = 'system' AND alarm_status IS NOT NULL`)
    .all()
    .filter((r) => {
      const w = systemAlarmText(r.alarm_condition_type);
      return r.message !== w.message || r.detail !== w.detail;
    });
  const measLeft = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE detail LIKE '%hat einen Wert von null gemeldet.%'`)
    .get().n;
  if (sysLeft.length !== 0 || measLeft !== 0) {
    console.error(`\nPost-check FAILED: ${sysLeft.length} system rows off-text, ${measLeft} rows still "null".`);
    db.close();
    process.exit(1);
  }
}

console.log(`\n${apply ? 'Migrated' : '[dry run] Would migrate'} ${sysRows.length + measRows.length} row(s) in ${dbPath}`);
if (!apply) console.log('Re-run with --apply to write changes.');

db.close();
```

- [ ] **Step 2: Dry-Run (keine Writes)**

Run: `node scripts/migrate-system-alarm-text.js`
Expected: Bericht „System feed rows to relabel: N" / „Measurement … rows to fix: M" und
„[dry run] Would migrate …"; **keine** Änderung an der DB. Ausgabe prüfen, bevor `--apply`.
(Liegt die DB nicht unter `./klima.db`, Pfad via `--db <pfad>` angeben.)

- [ ] **Step 3: Migration anwenden**

Run: `node scripts/migrate-system-alarm-text.js --apply`
Expected: „Migrated N row(s) …", Exit-Code 0 (Post-Check bestanden).

- [ ] **Step 4: Idempotenz verifizieren**

Run: `node scripts/migrate-system-alarm-text.js`
Expected: „No stale alarm texts … nothing to migrate (already clean)."

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-system-alarm-text.js
git commit -m "fix(alarms): Einmal-Migration korrigiert bestehende System-/null-Alarmtexte"
```

---

### Task 4: Versionsbump 0.9.0 → 0.9.1

**Files:**
- Modify: `VERSION`
- Modify: `README.md` (Badge, Zeile 3)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (alle `?v=0.9.0`)

**Interfaces:**
- Consumes: nichts.
- Produces: konsistente Version 0.9.1 an allen drei Stellen.

- [ ] **Step 1: Konsistenz vor dem Bump prüfen**

Run: `grep -rn "0.9.0" VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html" | head`
Expected: `VERSION`=`0.9.0`, Badge `version-0.9.0-blue`, mehrere `?v=0.9.0`.
Run: `git tag -l v0.9.1`
Expected: leere Ausgabe (Tag existiert noch nicht — wird mangels Remote ohnehin nicht erstellt).

- [ ] **Step 2: `VERSION` setzen**

`VERSION` Inhalt zu `0.9.1` ändern (eine Zeile, keine weiteren Zeichen).

- [ ] **Step 3: README-Badge setzen**

In `README.md` Zeile 3 `version-0.9.0-blue` → `version-0.9.1-blue`.

- [ ] **Step 4: Cache-Buster setzen**

In `Smart Meter Dashboard/Klima Dashboard.html` alle `?v=0.9.0` → `?v=0.9.1` ersetzen.

- [ ] **Step 5: Konsistenz nach dem Bump prüfen**

Run: `grep -rn "0.9.0" VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html"`
Expected: keine Treffer mehr (alles auf 0.9.1).
Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit (kein Tag/Push — kein Remote)**

```bash
git add VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.9.1"
```

---

## Hinweise zur Verifikation (nach allen Tasks)

- `npm test` grün (92+ Tests, inkl. der drei neuen/erweiterten Scheduler-Tests und des `systemAlarmText`-Tests).
- Migration gelaufen: Dry-Run geprüft, `--apply` mit Post-Check bestanden, zweiter Lauf meldet „already clean" (idempotent). Der aktive Alarm aus dem Screenshot zeigt danach „Verbindung verloren".
- Optional Browser-Check (Preview): ein Feed-Verbindungs-Alarm erscheint mit Überschrift „Verbindung verloren" und Detail „Gerät hat sich nicht im erwarteten Intervall gemeldet."; das durchgestrichene WLAN-Icon und der Aktiv-Status bleiben unverändert.
