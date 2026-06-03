const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

// Set DB_PATH to memory for testing
process.env.DB_PATH = ':memory:';
const { initDb, getDb, saveSetting, getSetting, closeDb } = require('../db');

test('SQLite schema setup and settings operations', () => {
  initDb();
  const db = getDb();
  
  // Check tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  assert.ok(tables.includes('settings'), 'settings table should exist');
  assert.ok(tables.includes('stations'), 'stations table should exist');
  assert.ok(tables.includes('measurements'), 'measurements table should exist');
  assert.ok(tables.includes('events'), 'events table should exist');

  // Save and load settings
  saveSetting('test_key', 'test_value');
  assert.strictEqual(getSetting('test_key'), 'test_value');
  
  closeDb();
});

test('Cascade delete testing', () => {
  initDb();
  const db = getDb();

  // Insert a station
  db.prepare("INSERT INTO stations (id, name) VALUES (?, ?)").run('station-1', 'Test Station');

  // Insert a measurement referencing the station
  db.prepare(`
    INSERT INTO measurements (uuid, station_id, timestamp, timestamp_local, value, physical_property, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('meas-uuid-1', 'station-1', 1600000000, '2020-09-13T12:26:40', 23.5, 'temperature', 'C');

  // Verify measurement is present
  const beforeDelete = db.prepare("SELECT count(*) as count FROM measurements WHERE station_id = ?").get('station-1');
  assert.strictEqual(beforeDelete.count, 1);

  // Delete the station
  db.prepare("DELETE FROM stations WHERE id = ?").run('station-1');

  // Verify measurement was deleted by cascade
  const afterDelete = db.prepare("SELECT count(*) as count FROM measurements WHERE station_id = ?").get('station-1');
  assert.strictEqual(afterDelete.count, 0);

  closeDb();
});
