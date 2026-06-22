const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Race-frei: prüft am Quelltext, dass dotenv mit einem __dirname-relativen Pfad
// aufgerufen wird. Ein nacktes config() würde aus dem CWD laden (Bug 4a).
// Kein Mutieren der geteilten .env, kein Kindprozess → keine Parallel-Test-Races.
for (const rel of ['db.js', 'server.js']) {
  test(`${rel} ruft dotenv mit __dirname-relativem Pfad auf`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(
      src,
      /require\(['"]dotenv['"]\)\.config\(\s*\{[^}]*__dirname/,
      `${rel}: dotenv.config() muss { path: ...__dirname... } erhalten`
    );
  });
}
