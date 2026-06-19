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
