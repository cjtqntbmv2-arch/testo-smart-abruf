const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Haelt die Versionsangaben zusammen, die beim Release von Hand gepflegt werden.
// Anlass: deploy/windows/README.md nannte zwei Releases lang appVersion 0.15.1,
// waehrend VERSION schon auf 0.16.0 stand — das §9-Abnahmekriterium pruefte damit
// eine Version, die es nicht mehr gab. Die ?v=-Cache-Buster deckt bereits
// "Smart Meter Dashboard/tests/dashboard-load.test.js" ab; hier fehlte der Rest.
//
// Bewusst ankerbasiert statt zeilennummernbasiert: eine Pruefung "jede
// Versionsangabe in der Datei muss VERSION entsprechen" erzeugt 14 Fehlalarme
// (die IP 127.0.0.1, HOST=0.0.0.0, die absichtlichen Marker "ab v0.11.0" /
// "v0.14.0" / "v0.15.0" und die bewusst fixe 0.9.0 der Update-Probe). Findet ein
// Anker seinen Satz nicht mehr, scheitert der Test laut — das ist der
// ertraeglichere Fehlalarm, weil er in einer Zeile behoben ist und genau dann
// feuert, wenn jemand die Stelle ohnehin neu liest.

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const VERSION = read('VERSION').trim();

test('package.json traegt dieselbe Version wie VERSION', () => {
  // Der ZIP-Name des Windows-Bundles kommt aus package.json
  // (.github/workflows/windows-bundle.yml), appVersion dagegen aus VERSION
  // (backend/server.js). Laufen die beiden auseinander, vergleicht
  // backend/update-check.js einen ZIP-Namen gegen eine andere laufende Version —
  // Dauermeldung "Update verfuegbar" oder ein Update, das nie angeboten wird.
  assert.strictEqual(JSON.parse(read('package.json')).version, VERSION);
});

test('README-Badge traegt dieselbe Version wie VERSION', () => {
  const m = read('README.md').match(/badge\/version-(.+?)-blue/);
  assert.ok(m, 'Versions-Badge in README.md nicht gefunden');
  assert.strictEqual(m[1], VERSION);
});

test('deploy/windows/README.md: §9-Abnahmekriterium zu appVersion traegt dieselbe Version wie VERSION', () => {
  const m = read('deploy', 'windows', 'README.md').match(/`appVersion` lautet `(.+?)`/);
  assert.ok(m, 'appVersion-Zeile in deploy/windows/README.md nicht gefunden');
  assert.strictEqual(m[1], VERSION);
});
