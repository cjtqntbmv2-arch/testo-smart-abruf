#!/usr/bin/env node
// One-off, idempotent data migration.
//
// Background: before the fix in device-bridge.js, mapPhysicalProperty() classified
// channels by physical_property_name only. A testo dewpoint channel reports
// physical_property_name "Temperature", so it was stored as physical_property
// 'temperature' alongside the real air-temperature channel. Two 'temperature' rows
// per timestamp made the dashboard temperature (and the derived dewpoint/abs.humidity)
// jump between the air value and the dewpoint value.
//
// This script re-labels the mis-stored dewpoint rows to physical_property 'dewpoint'.
// It is SELF-VALIDATING: within a station that has 2+ temperature channels, a channel
// is only relabeled if its values match dewPoint(otherChannel, humidity) within a
// tight tolerance. A legitimate second temperature channel would not match and is
// left untouched.
//
// Usage:
//   node scripts/migrate-dewpoint-relabel.js [--apply] [--db <path>]
// Default is a dry run (no writes). Pass --apply to write changes.

const path = require('path');
const Database = require('better-sqlite3');

const apply = process.argv.includes('--apply');
const dbArgIdx = process.argv.indexOf('--db');
const dbPath = dbArgIdx !== -1 ? process.argv[dbArgIdx + 1] : path.join(__dirname, '..', 'klima.db');

const TOLERANCE_C = 0.2; // mean |channel - computedDewpoint| must be below this to relabel

function dewPoint(T, RH) {
  const a = 17.625, b = 243.04;
  const alpha = Math.log(Math.max(1, RH) / 100) + (a * T) / (b + T);
  return (b * alpha) / (a - alpha);
}

const db = new Database(dbPath);
const stations = db.prepare('SELECT id FROM stations').all().map((r) => r.id);

let totalRelabeled = 0;

for (const stationId of stations) {
  const rows = db
    .prepare(
      `SELECT timestamp, channel_no, physical_property, value
       FROM measurements WHERE station_id = ?`
    )
    .all(stationId);

  // Group values by timestamp.
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.timestamp)) byTs.set(r.timestamp, { temps: new Map(), humidity: null });
    const slot = byTs.get(r.timestamp);
    if (r.physical_property === 'temperature') slot.temps.set(r.channel_no, r.value);
    else if (r.physical_property === 'humidity') slot.humidity = r.value;
  }

  // Distinct temperature channels for this station.
  const tempChannels = new Set();
  for (const slot of byTs.values()) for (const ch of slot.temps.keys()) tempChannels.add(ch);
  if (tempChannels.size < 2) continue; // nothing to disambiguate

  // For each candidate channel, score how well it matches dewPoint(otherChannel, humidity).
  const channels = [...tempChannels];
  const scores = new Map(); // channel -> { mean, n }
  for (const cand of channels) {
    const others = channels.filter((c) => c !== cand);
    let sum = 0, n = 0;
    for (const slot of byTs.values()) {
      const candVal = slot.temps.get(cand);
      if (candVal == null || slot.humidity == null) continue;
      // Use the warmest other channel as the air-temperature base.
      let base = null;
      for (const o of others) {
        const v = slot.temps.get(o);
        if (v != null && (base == null || v > base)) base = v;
      }
      if (base == null) continue;
      sum += Math.abs(candVal - dewPoint(base, slot.humidity));
      n += 1;
    }
    if (n > 0) scores.set(cand, { mean: sum / n, n });
  }

  for (const [ch, { mean, n }] of scores) {
    const isDewpoint = mean < TOLERANCE_C;
    console.log(
      `station=${stationId} channel=${ch} n=${n} mean|Δ|=${mean.toFixed(3)}°C -> ${
        isDewpoint ? 'DEWPOINT (relabel)' : 'temperature (keep)'
      }`
    );
    if (isDewpoint && apply) {
      const res = db
        .prepare(
          `UPDATE measurements SET physical_property = 'dewpoint'
           WHERE station_id = ? AND channel_no = ? AND physical_property = 'temperature'`
        )
        .run(stationId, ch);
      totalRelabeled += res.changes;
    } else if (isDewpoint) {
      const cnt = db
        .prepare(
          `SELECT count(*) c FROM measurements
           WHERE station_id = ? AND channel_no = ? AND physical_property = 'temperature'`
        )
        .get(stationId, ch).c;
      totalRelabeled += cnt;
    }
  }
}

console.log(
  `\n${apply ? 'Relabeled' : '[dry run] Would relabel'} ${totalRelabeled} rows to 'dewpoint' in ${dbPath}`
);
if (!apply) console.log('Re-run with --apply to write changes.');

db.close();
