#!/usr/bin/env node
// One-off, idempotent repair migration.
//
// Background: before the fixes in scheduler.js (A1–A3):
//   - mapPhysicalProperty was called with a.physical_value, a field that does not exist
//     in the live API.  Every measurement alarm was stored with metric = NULL.
//   - serial_no was never written to the events table, so the reconciliation query
//     couldn't distinguish alarms from different sensors on the same station.
//   - The reconciliation PARTITION BY didn't include serial_no or severity, so a
//     recovery event from one sensor/severity could silence an unrelated violation.
//
// The forward fix (A1–A3) only affects newly fetched alarms.  Because the alarm
// watermark (last_alarm_sync_time) advances with each sync cycle, already-stored rows
// are never re-fetched — so the stored metric = NULL / missing serial_no values
// would persist forever.
//
// This script resets the watermark so the next sync re-fetches the last 7 days of
// alarms.  The ON CONFLICT(uuid) DO UPDATE clause then repairs metric and serial_no
// in-place for every row whose uuid comes back in the re-fetch window.
//
// Choosing "delete the setting" over "set it 7 days back":
//   - Deleting is simpler and exactly equivalent: the scheduler defaults to
//     (now − 7 days) when the setting is absent (same as when it has never been set).
//   - No timestamp arithmetic needed; idempotent on repeated runs.
//
// Usage:
//   node scripts/migrate-alarm-resync.js [--apply] [--db <path>]
// Default is a dry run (no writes). Pass --apply to write changes.

const path = require('path');
const Database = require('better-sqlite3');

const apply = process.argv.includes('--apply');
const dbArgIdx = process.argv.indexOf('--db');
const dbPath = dbArgIdx !== -1 ? process.argv[dbArgIdx + 1] : path.join(__dirname, '..', 'klima.db');

const db = new Database(dbPath);

const before = db.prepare("SELECT value FROM settings WHERE key = 'last_alarm_sync_time'").get();
const beforeVal = before ? before.value : '(not set)';

console.log(`DB: ${dbPath}`);
console.log(`last_alarm_sync_time before: ${beforeVal}`);

if (!apply) {
  console.log('\n[dry run] Would DELETE last_alarm_sync_time from settings.');
  console.log('Effect: next sync re-fetches the last 7 days of alarms, repairing metric and serial_no.');
  console.log('Re-run with --apply to write changes.');
  db.close();
  process.exit(0);
}

db.prepare("DELETE FROM settings WHERE key = 'last_alarm_sync_time'").run();

const after = db.prepare("SELECT value FROM settings WHERE key = 'last_alarm_sync_time'").get();
const afterVal = after ? after.value : '(not set)';

console.log(`last_alarm_sync_time after:  ${afterVal}`);
console.log('\nDone. Start the app to trigger a re-fetch of the last 7 days of alarms.');

db.close();
