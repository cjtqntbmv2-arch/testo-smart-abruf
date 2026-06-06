#!/usr/bin/env node
// One-off, idempotent data migration.
//
// Background: before the fix in device-bridge.js (classifyAlarm) and scheduler.js, the
// alarm sync classified every testo alarm-feed row purely by alarm_severity
// (Warning/Alarm). But testo delivers connection/battery problems through that SAME feed
// as system alarms (alarm_type "device system alarm" / "sensor system alarm", e.g.
// alarm_condition_type "Connection timeout, device did not communicated in expected
// time"). Those rows were stored as severity 'warning', so the dashboard — which renders
// system messages only when severity === 'system' — never showed them as system
// messages. The active flag was also wrong (it tested alarm_status === 'Active', a value
// the live API never sends; the real enum is 'Alarm'/'Ok'), so every feed row was stored
// inactive.
//
// The forward fix only affects newly ingested alarms; the alarm watermark means existing
// rows are never re-fetched. This script re-labels the already-stored system alarms:
//   - severity -> 'system'
//   - alarm_condition_type -> normalized subtype 'connection' | 'battery' (matching the
//     synthetic sys-* rows and what the frontend reads to pick its icon)
// then reconciles the active flag the same way the scheduler now does: per
// (station, condition, metric) only the most recent transition is live, and only when it
// is a violation ('Alarm'); a later 'Ok' recovery closes the group. Synthetic system
// rows (alarm_status IS NULL, owned by applySystemEvents) are left untouched.
//
// It is SELF-VALIDATING: a candidate must be a feed row (alarm_status IS NOT NULL) whose
// alarm_condition_type clearly names a connection or battery condition. Anything else is
// left alone.
//
// Usage:
//   node scripts/migrate-system-alarm-relabel.js [--apply] [--db <path>]
// Default is a dry run (no writes). Pass --apply to write changes.

const path = require('path');
const Database = require('better-sqlite3');

const apply = process.argv.includes('--apply');
const dbArgIdx = process.argv.indexOf('--db');
const dbPath = dbArgIdx !== -1 ? process.argv[dbArgIdx + 1] : path.join(__dirname, '..', 'klima.db');

// Classify a raw condition string into a system subtype, or null if it is not a
// connection/battery system condition (same keyword logic as classifyAlarm's fallback).
function systemSubtype(cond) {
  const c = (cond || '').toLowerCase();
  if (c.includes('connection') || c.includes('timeout') || c.includes('verbind')) return 'connection';
  if (c.includes('battery') || c.includes('batterie') || c.includes('akku')) return 'battery';
  return null;
}

const db = new Database(dbPath);

// Feed rows (alarm_status set) not yet classified as system but whose condition names a
// connection/battery problem.
const candidates = db
  .prepare(
    `SELECT uuid, station_id, severity, alarm_condition_type
     FROM events
     WHERE alarm_status IS NOT NULL AND severity != 'system'`
  )
  .all()
  .map((r) => ({ ...r, subtype: systemSubtype(r.alarm_condition_type) }))
  .filter((r) => r.subtype !== null);

if (candidates.length === 0) {
  console.log(`No misclassified system alarms in ${dbPath}; nothing to relabel (already clean).`);
  db.close();
  process.exit(0);
}

const byStation = {};
for (const c of candidates) {
  const k = `${c.station_id}/${c.subtype}`;
  byStation[k] = (byStation[k] || 0) + 1;
}
for (const [k, n] of Object.entries(byStation)) {
  console.log(`${k}: ${n} row(s) -> severity 'system', condition '${k.split('/')[1]}'`);
}

let relabeled = 0;
if (apply) {
  const relabel = db.prepare(
    `UPDATE events SET severity = 'system', alarm_condition_type = ? WHERE uuid = ?`
  );
  const tx = db.transaction((rows) => {
    for (const r of rows) relabeled += relabel.run(r.subtype, r.uuid).changes;

    // Reconcile active flags exactly like the scheduler: newest transition per
    // (station, condition, metric) wins; only a trailing 'Alarm' is active.
    db.prepare("UPDATE events SET active = 0 WHERE alarm_status IS NOT NULL").run();
    db.prepare(`
      UPDATE events SET active = 1 WHERE uuid IN (
        SELECT uuid FROM (
          SELECT uuid,
            ROW_NUMBER() OVER (
              PARTITION BY station_id, alarm_condition_type, COALESCE(metric, '')
              ORDER BY start_ts DESC, rowid DESC
            ) AS rn,
            alarm_status
          FROM events
          WHERE alarm_status IS NOT NULL
        ) WHERE rn = 1 AND alarm_status = 'Alarm'
      )
    `).run();
  });
  tx(candidates);

  // Post-condition: no feed row naming a connection/battery condition may remain
  // outside the 'system' severity.
  const leftover = db
    .prepare(`SELECT uuid, alarm_condition_type FROM events WHERE alarm_status IS NOT NULL AND severity != 'system'`)
    .all()
    .filter((r) => systemSubtype(r.alarm_condition_type) !== null);
  if (leftover.length !== 0) {
    console.error(`\nPost-check FAILED: ${leftover.length} system-condition rows remain as non-system severity.`);
    db.close();
    process.exit(1);
  }
}

console.log(
  `\n${apply ? 'Relabeled' : '[dry run] Would relabel'} ${apply ? relabeled : candidates.length} row(s) to severity 'system' in ${dbPath}`
);
if (!apply) console.log('Re-run with --apply to write changes.');

db.close();
