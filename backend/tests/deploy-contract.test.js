const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Vertraege zwischen deploy/windows/update.cmd, install.cmd, start.cmd,
// backend/update-check.js und dem Bundle-Workflow.
//
// Je ZEILE geprueft, nicht als Teilstring: ein Teilstring-Test uebersieht
// Tippfehler, fehlende Schalter und hart codierte Pfade (ausgefuehrt). CRLF-fest,
// weil .gitattributes die .cmd-Dateien mit CRLF auscheckt. Eine Textpruefung
// fuehrt die Batch nicht aus; die eigentliche Absicherung ist der Windows-CI-Lauf
// in .github/workflows/windows-bundle.yml.

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim());
// Ausfuehrbare Zeilen einer Batch: ohne Leerzeilen und ohne REM-/::-Kommentare.
const code = (text) => lines(text).filter((l) => l && !/^(rem\b|::)/i.test(l));
const deploy = (f) => read('deploy', 'windows', f);

test('update.cmd ruft das CLI in genau einer Zeile auf, mit genau den Schaltern aus CLI_FLAGS', () => {
  const { CLI_FLAGS } = require('../update-check');
  assert.ok(Array.isArray(CLI_FLAGS), 'backend/update-check.js exportiert CLI_FLAGS nicht');

  // Jede Zeile, die update-check.js mit Schaltern startet, zaehlt als Aufruf.
  const calls = code(deploy('update.cmd')).filter((l) => /update-check\.js/i.test(l) && /\s--[a-z]/i.test(l));
  assert.strictEqual(calls.length, 1, `genau eine CLI-Aufrufzeile erwartet, gefunden:\n${calls.join('\n')}`);
  const [call] = calls;

  // Das INSTALLIERTE Programm waehlt die Fassung: dieselbe Regel wie der Dienst,
  // keine zweite Kopie in cmd.
  assert.match(call, /^"%LIVE%\\node\.exe" "%LIVE%\\backend\\update-check\.js" /);
  assert.deepStrictEqual(call.match(/--[a-z][a-z-]*/g), CLI_FLAGS);
  // SRC endet auf "\" (aus %~dp0), und "...\" maskiert das Anfuehrungszeichen.
  // Ohne den Punkt bekaeme das CLI den Rest der Zeile als Ordnernamen.
  assert.match(call, /--check-update "%SRC%\." /);
});

test('der LIVE-Pfad steht in update.cmd und install.cmd je genau einmal, als Wert von LIVE', () => {
  // Grenze (?=["\\]): der LIVE-Pfad ist Praefix von .staging, .old, .failed und
  // .update, die bleiben erlaubt. Gezaehlt wird in allen Zeilen, auch in Kommentaren,
  // und fuer jeden Laufwerksbuchstaben: kein hart codiertes X:\Apps\TestoSmartAbruf\
  // neben der Variable.
  const LIVE_RE = /[a-z]:\\Apps\\TestoSmartAbruf(?=["\\])/gi;
  for (const f of ['update.cmd', 'install.cmd']) {
    const hits = lines(deploy(f)).flatMap((l) => (l.match(LIVE_RE) || []).map(() => l));
    assert.deepStrictEqual(hits, ['set "LIVE=C:\\Apps\\TestoSmartAbruf"'], `${f}: LIVE-Pfad genau einmal erwartet`);
  }
});

test('install.cmd setzt DB_PATH wortgleich wie start.cmd', () => {
  // Der volle Pfad, nicht nur der Ordner: install.cmd zieht den DB-Abzug von
  // genau der Datei, die der Dienst beschreibt.
  const dbPathLine = (f) => {
    const hits = code(deploy(f)).filter((l) => /^set\s+"?DB_PATH=/i.test(l));
    assert.strictEqual(hits.length, 1, `${f}: genau eine DB_PATH-Zeile erwartet, gefunden ${hits.length}`);
    return hits[0];
  };
  assert.strictEqual(dbPathLine('install.cmd'), dbPathLine('start.cmd'));
});

test('update.cmd kommt ins Bundle: der Workflow kopiert deploy/ komplett', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'deploy', 'windows', 'update.cmd')), 'deploy/windows/update.cmd fehlt');

  const wf = lines(read('.github', 'workflows', 'windows-bundle.yml'));
  const itemLines = wf.filter((l) => /^\$items\s*=\s*@\(/.test(l));
  assert.strictEqual(itemLines.length, 1, 'genau eine $items-Zeile im Schritt "Assemble bundle" erwartet');
  const items = itemLines[0]
    .replace(/^\$items\s*=\s*@\(|\)\s*$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^'(.*)'$/, '$1'));
  assert.ok(items.includes('deploy'), `deploy fehlt in $items: ${items.join(', ')}`);

  const copies = wf.filter((l) => /^Copy-Item\b.*-Path \$items\b/.test(l));
  assert.strictEqual(copies.length, 1, 'genau ein Copy-Item ueber $items erwartet');
  assert.match(copies[0], /\s-Recurse\b/);
});
