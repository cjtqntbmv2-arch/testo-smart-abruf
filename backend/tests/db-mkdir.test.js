const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Eindeutiger, noch NICHT existierender Pfad — beweist, dass initDb das Verzeichnis anlegt.
const tmpRoot = path.join(os.tmpdir(), `testo-mkdir-${process.pid}`);
const dbPath = path.join(tmpRoot, 'nested', 'klima.db');
process.env.DB_PATH = dbPath; // muss VOR dem require gesetzt sein

const { initDb, getDb, closeDb } = require('../db');

test('initDb legt das DB-Elternverzeichnis an, wenn es fehlt', () => {
  assert.ok(!fs.existsSync(path.dirname(dbPath)), 'Vorbedingung: Verzeichnis fehlt');
  initDb();
  assert.ok(fs.existsSync(dbPath), 'DB-Datei wurde erstellt');
  const row = getDb().prepare('SELECT 1 AS one').get();
  assert.strictEqual(row.one, 1);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
