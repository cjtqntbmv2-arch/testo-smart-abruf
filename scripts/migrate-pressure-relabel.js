#!/usr/bin/env node
// One-off, idempotent data migration.
//
// Background: before the fix in device-bridge.js, mapPhysicalProperty() classified any
// channel whose physical_extension contained "absolut" as absolute humidity. But testo
// barometric pressure reports physical_extension "Absolute Pressure" (property name
// "Pressure", unit hPa, ~1000), while absolute humidity reports extension "Absolute
// Humidity" (property name "Density", unit g/m³, ~10). Both matched, so the pressure
// channel was stored as physical_property 'abshumid'. Result on a device with both
// channels (e.g. station EMC): no pressure series at all, and the abs.humidity series
// jumping between ~10 g/m³ and ~1000 hPa with a wrong unit (hPa) shown.
//
// This script re-labels the mis-stored pressure rows to physical_property 'pressure'.
// It is SELF-VALIDATING: a candidate row must be physical_property 'abshumid' AND carry
// unit 'hPa' (absolute humidity is always g/m³, so an hPa value under 'abshumid' can
// only be the misclassified pressure channel). As a second guard every candidate value
// must fall inside a plausible barometric band; if any does not, the script aborts
// without writing rather than guessing.
//
// Usage:
//   node scripts/migrate-pressure-relabel.js [--apply] [--db <path>]
// Default is a dry run (no writes). Pass --apply to write changes.

const path = require('path');
const Database = require('better-sqlite3');

const apply = process.argv.includes('--apply');
const dbArgIdx = process.argv.indexOf('--db');
const dbPath = dbArgIdx !== -1 ? process.argv[dbArgIdx + 1] : path.join(__dirname, '..', 'klima.db');

// Plausible barometric pressure band (hPa). Generous enough for high-altitude sites,
// tight enough to never overlap g/m³ humidity magnitudes (~6-12).
const PRESSURE_MIN_HPA = 500;
const PRESSURE_MAX_HPA = 1100;

const db = new Database(dbPath);

// Misclassified rows: stored as absolute humidity but carrying a pressure unit.
const candidates = db
  .prepare(
    `SELECT station_id, count(*) AS n, round(min(value), 2) AS lo, round(max(value), 2) AS hi
     FROM measurements
     WHERE physical_property = 'abshumid' AND unit = 'hPa'
     GROUP BY station_id`
  )
  .all();

if (candidates.length === 0) {
  console.log(`No 'abshumid' rows with unit 'hPa' in ${dbPath}; nothing to relabel (already clean).`);
  db.close();
  process.exit(0);
}

let totalCandidates = 0;
let outOfBand = false;
for (const c of candidates) {
  const inBand = c.lo >= PRESSURE_MIN_HPA && c.hi <= PRESSURE_MAX_HPA;
  totalCandidates += c.n;
  if (!inBand) outOfBand = true;
  console.log(
    `station=${c.station_id} n=${c.n} range=[${c.lo} .. ${c.hi}] hPa -> ${
      inBand ? "PRESSURE (relabel)" : `OUT OF BAND [${PRESSURE_MIN_HPA}..${PRESSURE_MAX_HPA}] — abort`
    }`
  );
}

if (outOfBand) {
  console.error(
    `\nAborting: at least one candidate value falls outside the plausible barometric band ` +
      `[${PRESSURE_MIN_HPA}..${PRESSURE_MAX_HPA}] hPa. No rows written. Investigate before relabeling.`
  );
  db.close();
  process.exit(1);
}

let relabeled = 0;
if (apply) {
  const res = db
    .prepare(`UPDATE measurements SET physical_property = 'pressure' WHERE physical_property = 'abshumid' AND unit = 'hPa'`)
    .run();
  relabeled = res.changes;

  // Post-condition: no 'abshumid' row may carry unit 'hPa' anymore.
  const leftover = db
    .prepare(`SELECT count(*) AS c FROM measurements WHERE physical_property = 'abshumid' AND unit = 'hPa'`)
    .get().c;
  if (leftover !== 0) {
    console.error(`\nPost-check FAILED: ${leftover} 'abshumid'/hPa rows remain after relabel.`);
    db.close();
    process.exit(1);
  }
}

console.log(
  `\n${apply ? 'Relabeled' : '[dry run] Would relabel'} ${apply ? relabeled : totalCandidates} rows to 'pressure' in ${dbPath}`
);
if (!apply) console.log('Re-run with --apply to write changes.');

db.close();
