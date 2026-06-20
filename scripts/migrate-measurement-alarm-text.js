#!/usr/bin/env node
// One-off, idempotent data migration.
//
// Background: measurement (threshold) alarms were stored with testo's raw English
// alarm_reason as the headline — "Alarm condition is violated" / "Alarm condition is
// adhered" — the same uninformative phrase for an over-temperature and an under-humidity
// breach alike. The forward fix (measurementAlarmText in device-bridge.js, wired into
// scheduler.js) only affects newly fetched alarms; the upsert refreshes re-seen alarms,
// but a row whose timestamp sits outside the alarm-fetch window is never re-fetched and
// would keep the English headline forever.
//
// This script repairs already-stored measurement rows in place: the headline (message) is
// re-derived from measurementAlarmText using the row's direction (from alarm_condition_type),
// metric, status and value. The detail line is already German (same template the forward fix
// uses) and is left untouched. System rows (severity 'system') are owned by
// migrate-system-alarm-text.js and are skipped here.
//
// Usage:
//   node scripts/migrate-measurement-alarm-text.js [--apply] [--db <path>]
// Default is a dry run (no writes). Pass --apply to write changes.

const path = require('path');
const Database = require('better-sqlite3');
const { measurementAlarmText, alarmConditionDirection } = require('../backend/device-bridge');

const apply = process.argv.includes('--apply');
const dbArgIdx = process.argv.indexOf('--db');
const dbPath = dbArgIdx !== -1 ? process.argv[dbArgIdx + 1] : path.join(__dirname, '..', 'klima.db');

const db = new Database(dbPath);

// Measurement feed rows whose stored headline differs from the canonical German headline.
const rows = db
  .prepare(`SELECT uuid, alarm_status, alarm_condition_type, metric, serial_no, alarm_value, message
            FROM events
            WHERE severity != 'system' AND alarm_status IS NOT NULL`)
  .all()
  .map((r) => ({
    uuid: r.uuid,
    message: r.message,
    want: measurementAlarmText({
      isViolation: r.alarm_status === 'Alarm',
      direction: alarmConditionDirection(r.alarm_condition_type),
      metric: r.metric,
      serialNo: r.serial_no,
      alarmValue: r.alarm_value,
    }).message,
  }))
  .filter((r) => r.message !== r.want);

if (rows.length === 0) {
  console.log(`No stale measurement headlines in ${dbPath}; nothing to migrate (already clean).`);
  db.close();
  process.exit(0);
}

console.log(`Measurement headlines to relabel: ${rows.length}`);

if (apply) {
  const upd = db.prepare(`UPDATE events SET message = ? WHERE uuid = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(r.want, r.uuid);
  });
  tx();

  // Post-condition: no measurement row keeps an English "Alarm condition …" headline.
  const left = db
    .prepare(`SELECT COUNT(*) AS n FROM events
              WHERE severity != 'system' AND message LIKE 'Alarm condition%'`)
    .get().n;
  if (left !== 0) {
    console.error(`\nPost-check FAILED: ${left} measurement rows still carry an English headline.`);
    db.close();
    process.exit(1);
  }
}

console.log(`\n${apply ? 'Migrated' : '[dry run] Would migrate'} ${rows.length} row(s) in ${dbPath}`);
if (!apply) console.log('Re-run with --apply to write changes.');

db.close();
