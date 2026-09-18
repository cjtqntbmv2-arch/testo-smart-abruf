// backend/tests/update-check.test.js
// Update-Hinweis: liest einen Ablageordner (Netzlaufwerk) und meldet, ob dort eine
// NEUERE Release-ZIP liegt. Der Dienst darf davon nie gestoppt oder gestoert werden,
// deshalb prueft jeder Fall zusaetzlich: kein Wurf nach oben.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = ':memory:';
const { saveSetting } = require('../db');
const { findNewerVersion, runUpdateCheck, getUpdateStatus } = require('../update-check');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'updchk-'));
}
function zip(dir, name, bytes = 'PKstub') {
  fs.writeFileSync(path.join(dir, name), bytes);
}
const NAME = (v) => `testo-smart-abruf-${v}-win-x64.zip`;

// ── 1. Neuere Fassung liegt im Ordner ────────────────────────────────────────
test('findNewerVersion: neuere ZIP im Ablageordner wird mit ihrer Version gemeldet', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.16.0'));
  assert.strictEqual(await findNewerVersion(dir, '0.15.0'), '0.16.0');
});

// ── 2. Gleiche Fassung ───────────────────────────────────────────────────────
test('findNewerVersion: gleiche Fassung im Ordner meldet kein Update', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.15.0'));
  assert.strictEqual(await findNewerVersion(dir, '0.15.0'), null);
});

// ── 3. Ordner existiert nicht ────────────────────────────────────────────────
test('findNewerVersion: fehlender Ordner meldet kein Update und stuerzt nicht ab', async () => {
  const dir = path.join(os.tmpdir(), 'updchk-gibt-es-nicht-' + Date.now());
  assert.strictEqual(await findNewerVersion(dir, '0.15.0'), null);
});

// ── 4. Ordner nicht lesbar ───────────────────────────────────────────────────
test('findNewerVersion: unlesbarer Ordner meldet kein Update und stuerzt nicht ab', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('als root ist jeder Ordner lesbar');
    return;
  }
  const dir = tmpDir();
  zip(dir, NAME('0.16.0'));
  fs.chmodSync(dir, 0o000);
  try {
    assert.strictEqual(await findNewerVersion(dir, '0.15.0'), null);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

// ── 5. Nur eine AELTERE Fassung liegt im Ordner ──────────────────────────────
// Normalzustand einer Ablage: die ZIP des vorigen Rollouts liegt noch da.
// Eine naive Umsetzung (neueste !== aktuelle) meldet hier dauerhaft "Update verfuegbar".
test('findNewerVersion: nur eine aeltere ZIP (0.14.2 neben laufender 0.15.0) meldet kein Update', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.14.2'));
  assert.strictEqual(await findNewerVersion(dir, '0.15.0'), null);
});

// ── 6. Lexikographische Falle ────────────────────────────────────────────────
// "0.9.0" > "0.15.0" als Zeichenkette. Es braucht einen numerischen Vergleich.
test('findNewerVersion: 0.9.0 neben laufender 0.15.0 meldet kein Update (SemVer, nicht Text)', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.9.0'));
  assert.strictEqual(await findNewerVersion(dir, '0.15.0'), null);
});

// Gegenprobe zur selben Falle: 0.15.0 IST neuer als 0.9.0.
test('findNewerVersion: 0.15.0 neben laufender 0.9.0 meldet ein Update', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.15.0'));
  assert.strictEqual(await findNewerVersion(dir, '0.9.0'), '0.15.0');
});

// ── Mehrere ZIPs: die hoechste gewinnt ───────────────────────────────────────
test('findNewerVersion: bei mehreren ZIPs gewinnt die hoechste Version', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.14.2'));
  zip(dir, NAME('0.16.1'));
  zip(dir, NAME('0.16.10'));
  zip(dir, NAME('0.9.9'));
  assert.strictEqual(await findNewerVersion(dir, '0.15.0'), '0.16.10');
});

// ── Fremdes Namensmuster wird ignoriert ──────────────────────────────────────
test('findNewerVersion: Dateien mit fremdem Namensmuster werden ignoriert', async () => {
  const dir = tmpDir();
  zip(dir, 'Anleitung Update 2.0.pdf');
  zip(dir, 'anderes-programm-9.9.9-win-x64.zip');
  zip(dir, NAME('0.16.0') + '.part');          // abgebrochener Kopiervorgang
  zip(dir, 'testo-smart-abruf-0.16.0-win-x64.zip.zip'); // doppelt gepacktes CI-Artefakt
  zip(dir, 'testo-smart-abruf-win-x64.zip');
  fs.mkdirSync(path.join(dir, NAME('0.17.0')));         // Ordner, keine Datei
  assert.strictEqual(await findNewerVersion(dir, '0.15.0'), null);
});

// ── 0-Byte-Datei (Kopie laeuft noch) wird ignoriert ──────────────────────────
test('findNewerVersion: 0-Byte-Datei wird ignoriert (Kopiervorgang laeuft noch)', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.16.0'), '');
  assert.strictEqual(await findNewerVersion(dir, '0.15.0'), null);
});

// ── runUpdateCheck: leere Einstellung = Pruefung aus (Standard) ──────────────
test('runUpdateCheck: ohne gesetzten Ablageordner ist die Pruefung aus', async () => {
  saveSetting('update_dir', '');
  const s = await runUpdateCheck('0.15.0');
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.updateAvailable, false);
  assert.strictEqual(s.latestVersion, null);
  assert.deepStrictEqual(getUpdateStatus(), s);
});

// ── runUpdateCheck: gesetzter Ordner mit neuerer ZIP ─────────────────────────
test('runUpdateCheck: gesetzter Ablageordner mit neuerer ZIP meldet das Update', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.99.0'));
  saveSetting('update_dir', dir);
  const s = await runUpdateCheck('0.15.0');
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.updateAvailable, true);
  assert.strictEqual(s.latestVersion, '0.99.0');
  assert.ok(typeof s.checkedAt === 'number');
  saveSetting('update_dir', '');
});

// ── runUpdateCheck: unbrauchbarer Pfad wirft nie nach oben ───────────────────
test('runUpdateCheck: unerreichbarer Ablageordner meldet kein Update statt zu werfen', async () => {
  saveSetting('update_dir', '\\\\kein-server\\keine-freigabe');
  const s = await runUpdateCheck('0.15.0');
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.updateAvailable, false);
  assert.strictEqual(s.latestVersion, null);
  saveSetting('update_dir', '');
});

// ── eigene Version unlesbar: kein Update, kein Wurf ──────────────────────────
test('findNewerVersion: unlesbare eigene Version meldet kein Update', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.16.0'));
  assert.strictEqual(await findNewerVersion(dir, 'v0.15.0-dev'), null);
});

// ── Log: jeder Zustandswechsel genau einmal, kein Eintrag je Pruefung ────────
// Vorher schrieb die Pruefung gar nichts: totes Netzlaufwerk, fehlende Rechte und
// "kein Update vorhanden" waren im Feld nicht zu unterscheiden. Alle 6 h eine Zeile
// waere dagegen Rauschen — also nur, wenn sich der Zustand aendert.
test('runUpdateCheck: loggt jeden Zustandswechsel genau einmal (nicht lesbar, erreichbar, Update, aus)', async () => {
  const util = require('node:util');
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(util.format(...a));
  const dir = path.join(os.tmpdir(), `updchk-log-${process.pid}-${Date.now()}`);
  const twice = async () => { await runUpdateCheck('0.15.0'); await runUpdateCheck('0.15.0'); };
  try {
    saveSetting('update_dir', dir);
    await twice();                 // Ordner fehlt
    fs.mkdirSync(dir);
    await twice();                 // erreichbar, nichts Neueres
    zip(dir, NAME('0.99.0'));
    await twice();                 // neuere Fassung liegt bereit
    saveSetting('update_dir', '');
    await twice();                 // Pruefung aus
  } finally {
    Object.assign(console, orig);
    saveSetting('update_dir', '');
  }
  assert.strictEqual(lines.length, 4, `genau eine Zeile je Zustandswechsel:\n${lines.join('\n')}`);
  assert.ok(lines.every((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d /.test(l)), lines.join('\n'));
  assert.ok(lines[0].includes(dir) && /nicht lesbar.*ENOENT/.test(lines[0]), `Grund fehlt: ${lines[0]}`);
  assert.match(lines[1], /erreichbar/);
  assert.match(lines[2], /0\.99\.0/);
  assert.match(lines[3], /Update-Prüfung aus/);
});
