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

// ══ Update-Weg (v0.18.0): Wahl mit Begruendung, Fehlertexte, Status, CLI ══════
const { spawnSync } = require('node:child_process');
const { inspectDir, describeReadError, CLI_FLAGS } = require('../update-check');
const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(REPO, 'backend', 'update-check.js');
const INSTALLED = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();

test('inspectDir: waehlt die hoechste neuere Fassung und nennt jeden verworfenen Eintrag mit Grund', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.99.0'));
  zip(dir, NAME('0.98.0'));
  zip(dir, NAME('0.99.9'), '');                    // Kopie laeuft noch
  zip(dir, NAME('0.14.2'));
  zip(dir, NAME('0.15.0'));
  zip(dir, 'Anleitung.pdf');
  fs.mkdirSync(path.join(dir, NAME('0.97.0')));    // Ordner mit passendem Namen
  const r = await inspectDir(dir, '0.15.0');
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.newer, { version: '0.99.0', file: NAME('0.99.0') });
  const got = Object.fromEntries(r.entries.map((e) => [e.name, `${e.ok ? 'ok' : '--'} ${e.reason}`]));
  assert.strictEqual(Object.keys(got).length, 7, JSON.stringify(got));
  assert.match(got[NAME('0.99.0')], /^ok /);
  assert.match(got[NAME('0.98.0')], /^ok /);
  assert.match(got[NAME('0.99.9')], /^-- .*0 Byte/);
  assert.match(got[NAME('0.14.2')], /^-- nicht neuer/);
  assert.match(got[NAME('0.15.0')], /^-- nicht neuer/);
  assert.match(got['Anleitung.pdf'], /^-- fremder Name/);
  assert.match(got[NAME('0.97.0')], /^-- keine Datei/);
});

test('inspectDir: scheitert stat an einer Datei, wird nur sie mit Grund verworfen', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.99.0'));
  zip(dir, NAME('0.98.0'));
  const fsp = require('node:fs/promises');
  const realStat = fsp.stat;
  fsp.stat = async (p, ...rest) => {
    if (path.basename(String(p)) === NAME('0.99.0')) {
      throw Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' });
    }
    return realStat(p, ...rest);
  };
  let r;
  try { r = await inspectDir(dir, '0.15.0'); } finally { fsp.stat = realStat; }
  const e = r.entries.find((x) => x.name === NAME('0.99.0'));
  assert.strictEqual(e.ok, false);
  assert.match(e.reason, /stat gescheitert.*EACCES/);
  assert.deepStrictEqual(r.newer, { version: '0.98.0', file: NAME('0.98.0') });
});

test('inspectDir: nicht lesbarer Ordner liefert den Fehler mit Code, keine Eintraege, keine Wahl', async () => {
  const dir = path.join(os.tmpdir(), `updchk-fehlt-${process.pid}-${Date.now()}`);
  const r = await inspectDir(dir, '0.15.0');
  assert.strictEqual(r.error.code, 'ENOENT');
  assert.deepStrictEqual([r.newer, r.entries], [null, []]);
});

// ── Fehlertexte: das Feld erklaert sich selbst (Befund V7: totes Laufwerk = "kein Update") ──
test('describeReadError: Klartext mit Hinweis je Ursache, immer mit Ordner', () => {
  const err = (code, message = `${code}: fehler, scandir`) => Object.assign(new Error(message), { code });

  const drive = describeReadError('X:\\Updates\\Klima', err('ENOENT'));
  assert.ok(drive.includes('X:\\Updates\\Klima'), drive);
  assert.match(drive, /UNC/, 'Laufwerksbuchstabe: der Dienst sieht keine Netzlaufwerke');

  for (const code of ['EACCES', 'EPERM']) {
    const t = describeReadError('\\\\srv\\freigabe', err(code));
    assert.ok(t.includes('\\\\srv\\freigabe'), t);
    assert.match(t, /Computerkonto/, `${code}: wer braucht das Leserecht`);
    assert.match(t, /NetworkService/);
  }

  const unc = describeReadError('\\\\srv\\fehlt', err('ENOENT'));
  assert.ok(unc.includes('\\\\srv\\fehlt') && unc.includes('ENOENT'), unc);
  assert.doesNotMatch(unc, /UNC/, 'ist schon ein UNC-Pfad');

  const other = describeReadError('\\\\srv\\freigabe', Object.assign(new Error('kaputt'), { code: 'EIO' }));
  assert.ok(other.includes('\\\\srv\\freigabe') && other.includes('EIO') && other.includes('kaputt'), other);
});

// ── Status: Ordner, Fehlergrund, Datei und laufende Pruefung ─────────────────
test('runUpdateCheck: Status traegt dir, error, latestFile und checking', async () => {
  const missing = path.join(os.tmpdir(), `updchk-fehlt-${process.pid}-${Date.now()}`);
  const dir = tmpDir();
  zip(dir, NAME('0.99.0'));
  try {
    saveSetting('update_dir', missing);
    let { checkedAt, error, ...rest } = await runUpdateCheck('0.15.0');
    assert.strictEqual(typeof checkedAt, 'number');
    assert.ok(typeof error === 'string' && error.includes(missing) && error.includes('ENOENT'), error);
    assert.deepStrictEqual(rest, { enabled: true, updateAvailable: false, latestVersion: null,
      latestFile: null, dir: missing, checking: false });

    saveSetting('update_dir', dir);
    ({ checkedAt, error, ...rest } = await runUpdateCheck('0.15.0'));
    assert.strictEqual(error, null);
    assert.deepStrictEqual(rest, { enabled: true, updateAvailable: true, latestVersion: '0.99.0',
      latestFile: NAME('0.99.0'), dir, checking: false });

    saveSetting('update_dir', '');
    ({ checkedAt, error, ...rest } = await runUpdateCheck('0.15.0'));
    assert.strictEqual(error, null);
    assert.deepStrictEqual(rest, { enabled: false, updateAvailable: false, latestVersion: null,
      latestFile: null, dir: null, checking: false });
  } finally {
    saveSetting('update_dir', '');
  }
});

test('runUpdateCheck: die Logzeile zu einer neueren Fassung nennt update.cmd', async () => {
  const util = require('node:util');
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(util.format(...a));
  const dir = tmpDir();
  zip(dir, NAME('0.99.0'));
  try {
    saveSetting('update_dir', dir);
    await runUpdateCheck('0.15.0');
  } finally {
    Object.assign(console, orig);
    saveSetting('update_dir', '');
  }
  assert.strictEqual(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /0\.99\.0.*update\.cmd/);
});

// ── Nur ein Lauf gleichzeitig ────────────────────────────────────────────────
// Ein totes UNC-Ziel haelt einen libuv-Thread bis zum SMB-Timeout fest; dns.lookup fuer den
// testo-Sync teilt sich denselben Pool. Drei Anstoesse, nicht zwei: mit zweien liefern
// "vormerken" und "stapeln" dieselbe Zahl von Aufrufen.
test('runUpdateCheck: Anstoesse waehrend eines Laufs werden vorgemerkt, danach genau ein Nachlauf', async () => {
  const dir = tmpDir();
  zip(dir, NAME('0.99.0'));
  const fsp = require('node:fs/promises');
  const realReaddir = fsp.readdir;
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  fsp.readdir = async (...a) => {
    calls++;
    if (calls === 1) await gate;
    return realReaddir(...a);
  };
  try {
    saveSetting('update_dir', dir);
    const runs = [1, 2, 3, 4].map(() => runUpdateCheck('0.15.0'));
    assert.strictEqual(calls, 1, 'waehrend eines Laufs startet kein zweiter');
    assert.strictEqual(getUpdateStatus().checking, true);
    release();
    const results = await Promise.all(runs);
    await new Promise((r) => setTimeout(r, 50)); // ein gestapelter Lauf haette jetzt begonnen
    assert.strictEqual(calls, 2, 'alle vorgemerkten Anstoesse ergeben genau einen Nachlauf');
    assert.strictEqual(getUpdateStatus().checking, false);
    for (const s of results) assert.deepStrictEqual(s, getUpdateStatus());
    assert.strictEqual(results[3].latestVersion, '0.99.0');
  } finally {
    release();
    fsp.readdir = realReaddir;
    saveSetting('update_dir', '');
  }
});

// ── IT-Vorgabe "nur Listing": Positivliste statt Negativliste ────────────────
// Jede Funktion von fs und fs.promises wird VOR einem frischen require umhuellt. So faellt
// auch ein destrukturiertes `const { open } = require('node:fs/promises')` auf, an dem eine
// Liste verbotener Funktionen vorbeischaut. Auf Pfade im Ablageordner sind nur readdir, stat
// und lstat erlaubt; die Sync-Formen nicht, sie blockierten bei totem UNC-Ziel den Dienst.
test('IT-Vorgabe "nur Listing": im Ablageordner nur readdir, stat und lstat (inspectDir und runUpdateCheck)', async () => {
  const { fileURLToPath } = require('node:url');
  const dir = tmpDir();
  zip(dir, NAME('0.99.0'));
  zip(dir, NAME('0.99.9'), '');
  zip(dir, NAME('0.1.0'));
  zip(dir, 'Anleitung.pdf');
  fs.mkdirSync(path.join(dir, NAME('0.98.0')));

  const ALLOWED = new Set(['readdir', 'stat', 'lstat']);
  const calls = [];
  const inDir = (a) => {
    let p = null;
    if (typeof a === 'string') p = a;
    else if (Buffer.isBuffer(a)) p = a.toString();
    else if (a instanceof URL && a.protocol === 'file:') p = fileURLToPath(a);
    if (p === null) return false;
    const rel = path.relative(dir, path.resolve(p));
    return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  };
  const undo = [];
  for (const [label, obj] of [['fs', fs], ['fs.promises', fs.promises]]) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      const fn = 'value' in desc ? desc.value : desc.get && desc.get.call(obj);
      if (typeof fn !== 'function') continue;
      const note = (args) => { if (args.some(inDir)) calls.push(`${label}.${key}`); };
      const wrapped = new Proxy(fn, {
        apply(target, self, args) { note(args); return Reflect.apply(target, self, args); },
        construct(target, args, newTarget) { note(args); return Reflect.construct(target, args, newTarget); },
      });
      Object.defineProperty(obj, key, 'value' in desc ? { ...desc, value: wrapped } : { ...desc, get: () => wrapped });
      undo.push(() => Object.defineProperty(obj, key, desc));
    }
  }
  const key = require.resolve('../update-check');
  const cached = require.cache[key];
  try {
    delete require.cache[key];
    const fresh = require('../update-check');
    const r = await fresh.inspectDir(dir, '0.15.0');
    assert.strictEqual(r.newer && r.newer.version, '0.99.0');
    saveSetting('update_dir', dir);
    const s = await fresh.runUpdateCheck('0.15.0');
    assert.strictEqual(s.latestVersion, '0.99.0');
  } finally {
    for (const u of undo) u();
    require.cache[key] = cached;
    saveSetting('update_dir', '');
  }
  assert.ok(calls.some((c) => c.endsWith('.readdir')), `die Huelle muss das Listing sehen: ${calls.join(', ')}`);
  assert.deepStrictEqual(calls.filter((c) => !ALLOWED.has(c.split('.').pop())), []);
});

// ── IT-Vorgabe "Dienst startet keine Programme" ──────────────────────────────
test('IT-Vorgabe "startet keine Programme": kein backend/*.js (ohne Tests) nennt child_process', () => {
  const dir = path.join(__dirname, '..');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('server.js') && files.includes('update-check.js'), files.join(', '));
  const hits = files.filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('child_process'));
  assert.deepStrictEqual(hits, []);
});

// ── CLI fuer update.cmd: node backend/update-check.js --check-update <ordner> [--pick-file <datei>] ──
// Laeuft als eigener Prozess. DB_PATH zeigt auf waechter.db in einem leeren Ordner: oeffnete das
// CLI die Datenbank (getSetting/getDb), laege danach waechter.db samt -wal darin.
function runCli(args, { script = CLI, env = {} } = {}) {
  const guard = fs.mkdtempSync(path.join(os.tmpdir(), 'updcli-db-'));
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DB_PATH: path.join(guard, 'waechter.db'), ...env },
  });
  assert.deepStrictEqual(fs.readdirSync(guard), [], `das CLI hat die Datenbank geoeffnet:\n${r.stdout}${r.stderr}`);
  return r;
}
function snapshot(dir) {
  const names = fs.readdirSync(dir).sort();
  return [fs.statSync(dir).mtimeMs, ...names.map((n) => {
    const st = fs.statSync(path.join(dir, n));
    return `${n}|${st.size}|${st.mtimeMs}`;
  })];
}
const pickPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'updcli-out-')), 'pick.txt');
const reportLine = (stdout, name) => stdout.split(/\r?\n/).find((l) => l.includes(`] ${name} (`)) || '';

test('CLI: CLI_FLAGS nennt genau die Schalter, die update.cmd benutzen darf', () => {
  assert.deepStrictEqual(CLI_FLAGS, ['--check-update', '--pick-file']);
});

test('CLI: neuere Fassung -> Exit 0, Uebergabedatei "<version> <datei>", Bericht mit Gruenden, Ordner unveraendert', () => {
  const dir = tmpDir();
  zip(dir, NAME('99.0.0'));
  zip(dir, NAME('99.9.0'), '');            // Kopie laeuft noch - waere sonst die hoechste
  zip(dir, NAME('0.1.0'));                 // aelter als die installierte Fassung
  zip(dir, NAME('99.5.0') + '.part');
  zip(dir, 'Anleitung.pdf');
  const pick = pickPath();
  const before = snapshot(dir);
  const r = runCli(['--check-update', dir, '--pick-file', pick]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(pick, 'latin1'), `99.0.0 ${NAME('99.0.0')}`);
  assert.deepStrictEqual(snapshot(dir), before, 'der Ablageordner bleibt unberuehrt');
  assert.ok(r.stdout.includes(dir), r.stdout);
  assert.ok(r.stdout.includes(INSTALLED), `installierte Version fehlt:\n${r.stdout}`);
  assert.match(reportLine(r.stdout, NAME('99.0.0')), /^\s*\[ok\]/);
  assert.match(reportLine(r.stdout, NAME('99.9.0')), /^\s*\[--\].*0 Byte/);
  assert.match(reportLine(r.stdout, NAME('0.1.0')), /^\s*\[--\].*nicht neuer/);
  assert.match(reportLine(r.stdout, NAME('99.5.0') + '.part'), /^\s*\[--\].*fremder Name/);
  assert.match(reportLine(r.stdout, 'Anleitung.pdf'), /^\s*\[--\].*fremder Name/);
  assert.match(r.stdout, /Ergebnis:.*99\.0\.0/);
  assert.match(r.stdout, /^[\x00-\x7f]*$/, 'Bericht rein ASCII: cmd zeigt UTF-8 als Zeichensalat');
});

test('CLI: nichts Neueres -> Exit 10, keine Uebergabedatei', () => {
  const dir = tmpDir();
  zip(dir, NAME('0.1.0'));
  zip(dir, NAME(INSTALLED));
  const pick = pickPath();
  const before = snapshot(dir);
  const r = runCli(['--check-update', dir, '--pick-file', pick]);
  assert.strictEqual(r.status, 10, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(pick), 'Uebergabedatei nur bei Exit 0');
  assert.deepStrictEqual(snapshot(dir), before);
  assert.match(reportLine(r.stdout, NAME(INSTALLED)), /^\s*\[--\].*nicht neuer/);
  assert.match(r.stdout, /Ergebnis:.*nichts Neueres/);
});

test('CLI: Ordner nicht lesbar -> Exit 2 mit Klartext, keine Uebergabedatei', () => {
  const dir = path.join(os.tmpdir(), `updcli-fehlt-${process.pid}-${Date.now()}`);
  const pick = pickPath();
  const r = runCli(['--check-update', dir, '--pick-file', pick]);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(pick), 'Uebergabedatei nur bei Exit 0');
  assert.ok(!fs.existsSync(dir), 'das CLI legt den Ordner nicht an');
  assert.ok(r.stdout.includes(dir), r.stdout);
  assert.match(r.stdout, /nicht lesbar.*ENOENT/);
});

test('CLI: falscher Aufruf -> Exit 3 (ohne Ordner, fremder Schalter, Schalter ohne Wert, Uebergabedatei im Ablageordner)', () => {
  const dir = tmpDir();
  zip(dir, NAME('99.0.0'));
  const before = snapshot(dir);
  for (const args of [
    [],
    ['--check-update'],
    ['--check-update', ''],
    ['--check-update', '--pick-file', pickPath()],
    ['--check-update', dir, '--unbekannt', 'x'],
    ['--check-update', dir, '--pick-file'],
    ['--check-update', dir, '--pick-file', path.join(dir, 'pick.txt')],
  ]) {
    const r = runCli(args);
    assert.strictEqual(r.status, 3, `${JSON.stringify(args)}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /--check-update <ordner>/, `${JSON.stringify(args)}: Aufrufzeile fehlt`);
  }
  assert.deepStrictEqual(snapshot(dir), before, 'nichts im Ablageordner angelegt');
});

test('CLI: eigene VERSION unlesbar (kopierter Baum) -> Exit 3, keine Uebergabedatei', () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'updcli-baum-'));
  fs.mkdirSync(path.join(tree, 'backend'));
  for (const f of fs.readdirSync(path.join(REPO, 'backend')).filter((n) => n.endsWith('.js'))) {
    fs.copyFileSync(path.join(REPO, 'backend', f), path.join(tree, 'backend', f));
  }
  fs.writeFileSync(path.join(tree, 'VERSION'), 'kaputt\n');
  const dir = tmpDir();
  zip(dir, NAME('99.0.0'));
  const pick = pickPath();
  const r = runCli(['--check-update', dir, '--pick-file', pick], {
    script: path.join(tree, 'backend', 'update-check.js'),
    env: { NODE_PATH: path.join(REPO, 'node_modules') },
  });
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /VERSION/);
  assert.ok(!fs.existsSync(pick), 'Uebergabedatei nur bei Exit 0');
});
