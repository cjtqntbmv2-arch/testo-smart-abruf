// Update-Hinweis: sieht in einem Ablageordner (in der Regel eine Netzfreigabe) nach,
// ob dort eine NEUERE Release-ZIP liegt, und meldet das ueber GET /api/system/status.
//
// Bewusste Abweichung von der Projektregel "Programm sperrt seinen eigenen Start":
// Dies ist ein Ueberwachungsdienst. Ein gesperrter Start naehme die Klimaueberwachung
// offline - schlimmer als eine alte Fassung weiterzubetreiben -, und unter
// NT AUTHORITY\NetworkService (BootTrigger) sitzt niemand davor, der eine Sperre
// wegklicken koennte. Daher: melden statt sperren. Der Start laeuft immer durch.
//
// Der Ablageordner ist eine Einstellung (settings.update_dir). Leer = Pruefung aus,
// und das ist der Standard: kein unangekuendigter Netzzugriff auf einer Firmenmaschine.
//
// IT-Vorgaben, beide durch Tests in tests/update-check.test.js festgehalten: im Ablageordner
// wird nur gelistet (readdir/stat), nie eine Datei geoeffnet oder gelesen; und der Dienst
// startet keine Programme. Eingespielt wird von der IT mit update.cmd, das dieses Modul
// als Kommandozeile (unten) nach der Wahl fragt.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
// db.js oeffnet die Datenbank erst in getDb(). Die Kommandozeile ruft weder getSetting noch
// getDb auf und laesst die Datenbank daher unberuehrt.
const { getSetting } = require('./db');
const { info, warn } = require('./log');

// Genau der Name, den .github/workflows/windows-bundle.yml baut:
//   testo-smart-abruf-<version>-win-x64.zip
// Streng gefasst, weil ein Fehltreffer beim Kunden als Dauermeldung ankommt:
// explizite Ziffernklasse [0-9] statt \d (\d ist mit u-Flag unicodeweit, "٩.٩.٩"
// wuerde sonst greifen), je Stelle hoechstens drei Ziffern, hartes ^...$ ohne
// m-Flag (so faengt ".zip.part" oder ".zip.zip" nichts), und /i, weil Windows
// Gross-/Kleinschreibung nicht unterscheidet.
const ZIP_RE = /^testo-smart-abruf-([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})-win-x64\.zip$/i;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

// "0.15.0" -> [0, 15, 0]; alles andere (v-Praefix, Vorabkennung, Muell) -> null.
function parseVersion(str) {
  const m = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(String(str || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Numerisch vergleichen, nie als Zeichenkette: "0.9.0" > "0.15.0" waere als Text wahr.
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Liest den Ablageordner und begruendet jede Entscheidung - fuer den Dienst und fuer den
// Bericht der Kommandozeile. Wirft nie: ist der Ordner selbst nicht lesbar, steht der Fehler
// in `error`. Nur Listing: readdir und stat, nie oeffnen oder lesen (IT-Vorgabe).
// -> { newer: {version, file}|null, entries: [{name, ok, reason}], error: Error|null }
async function inspectDir(dir, currentVersion) {
  const result = { newer: null, entries: [], error: null };
  const current = parseVersion(currentVersion);
  if (!current) return result; // eigene Version unlesbar -> nichts melden (das CLI prueft vorher)
  let list;
  try {
    list = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    result.error = e;
    return result;
  }
  let best = null;
  for (const entry of list) {
    const judge = (ok, reason) => result.entries.push({ name: entry.name, ok, reason });
    const m = ZIP_RE.exec(entry.name);
    if (!m) { judge(false, 'fremder Name'); continue; }
    if (!entry.isFile()) { judge(false, 'keine Datei'); continue; } // z. B. ein Ordner
    let size;
    try {
      size = (await fsp.stat(path.join(dir, entry.name))).size;
    } catch (e) {
      judge(false, `stat gescheitert (${e.code || e.message})`);
      continue;
    }
    // 0-Byte-Datei = der Kopiervorgang laeuft noch. Meldet man die, steht beim
    // Kunden "Update verfuegbar" auf eine Datei, die es noch nicht gibt.
    if (size === 0) { judge(false, '0 Byte, Kopie läuft noch?'); continue; }
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (compareVersions(v, current) <= 0) { judge(false, 'nicht neuer'); continue; }
    judge(true, 'neuer');
    if (!best || compareVersions(v, best.v) > 0) best = { v, file: entry.name };
  }
  if (best) result.newer = { version: best.v.join('.'), file: best.file };
  return result;
}

// Duenner Wrapper fuer die Bestandsaufrufer: hoechste neuere Version oder null. onError
// erfaehrt den Grund, wenn der Ordner selbst nicht lesbar ist.
async function findNewerVersion(dir, currentVersion, onError) {
  const { newer, error } = await inspectDir(dir, currentVersion);
  if (error && onError) onError(error);
  return newer ? newer.version : null;
}

// Ein Lesefehler als deutscher Klartext mit Hinweis, fuer Dienst (Status, Log) und
// Kommandozeile. Befund V7: ein totes Laufwerk sah in der Oberflaeche aus wie "kein Update".
function describeReadError(dir, err) {
  const code = (err && err.code) || '';
  const head = `Ablageordner „${dir}“ nicht lesbar`;
  if (code === 'EACCES' || code === 'EPERM') {
    return `${head}: Zugriff verweigert (${code}). Der Dienst läuft als NT AUTHORITY\\NetworkService `
      + 'und greift im Netz als Computerkonto (DOMÄNE\\RECHNERNAME$) zu. Dieses Konto braucht '
      + 'Leserecht auf Freigabe und Ordner.';
  }
  // Netzlaufwerke gehoeren zur Anmeldung eines Benutzers; der Dienst hat keine.
  if (code === 'ENOENT' && /^[A-Za-z]:/.test(dir)) {
    return `${head}: nicht gefunden (ENOENT). Ist ${dir.slice(0, 2)} ein Netzlaufwerk? `
      + 'Laufwerksbuchstaben von Netzlaufwerken sieht der Dienst nicht – bitte den UNC-Pfad '
      + 'eintragen, z. B. \\\\fileserver\\Software\\TestoSmartAbruf.';
  }
  const msg = (err && err.message) || String(err);
  return `${head} (${code && !msg.startsWith(code) ? `${code}: ` : ''}${msg}).`;
}

// Ergebnis der letzten Pruefung; `checking` kommt in getUpdateStatus() dazu.
const IDLE = { enabled: false, updateAvailable: false, latestVersion: null, latestFile: null,
  dir: null, error: null, checkedAt: null };
let state = { ...IDLE };
let timer = null;
let running = null; // Promise des laufenden Durchgangs (samt Nachlauf), sonst null
let rerun = false;  // waehrend eines Laufs angestossen -> genau ein Nachlauf

function getUpdateStatus() { return { ...state, checking: running !== null }; }

// Ins Log nur, wenn sich der Zustand aendert (Pruefung alle 6 h, zusaetzlich bei jedem
// Speichern des Ordners): so steht "nicht lesbar" mit Grund genau einmal da, und
// "erreichbar, nichts Neueres" unterscheidet sich im Log vom toten Netzlaufwerk.
let loggedState = null;
function logOnChange(key, line, log = info) {
  if (key === loggedState) return;
  loggedState = key;
  log(line);
}

// Einmalige Pruefung. Liest den Ablageordner bei jedem Lauf neu aus den Einstellungen,
// damit eine Aenderung ohne Dienstneustart greift. Wirft nie.
async function checkOnce(currentVersion) {
  try {
    const dir = (getSetting('update_dir') || '').trim();
    if (!dir) {
      state = { ...IDLE, checkedAt: Date.now() };
      logOnChange('aus', 'Update-Prüfung aus (kein Ablageordner eingestellt)');
      return;
    }
    const { newer, error } = await inspectDir(dir, currentVersion);
    const text = error ? describeReadError(dir, error) : null;
    state = { enabled: true, updateAvailable: !!newer, latestVersion: newer ? newer.version : null,
      latestFile: newer ? newer.file : null, dir, error: text, checkedAt: Date.now() };
    if (error) {
      logOnChange(`fehler|${dir}|${error.code || error.message}`, `Update-Prüfung: ${text}`, warn);
    } else if (newer) {
      logOnChange(`neu|${dir}|${newer.version}`, `Update-Prüfung: neuere Fassung ${newer.version} `
        + `(${newer.file}) im Ablageordner "${dir}", laufend ${currentVersion}. Einspielen durch die IT: `
        + 'update.cmd im Ablageordner als Administrator ausführen.');
    } else {
      logOnChange(`aktuell|${dir}`, `Update-Prüfung: Ablageordner "${dir}" erreichbar, nichts Neueres als ${currentVersion}`);
    }
  } catch (e) {
    // Auch ein Fehler beim Lesen der Einstellung darf den Dienst nicht stoeren.
    state = { ...state, updateAvailable: false, latestVersion: null, latestFile: null,
      error: `Update-Prüfung fehlgeschlagen: ${e.message}`, checkedAt: Date.now() };
    logOnChange(`fehler|${e.message}`, `Update-Prüfung fehlgeschlagen: ${e.message}`, warn);
  }
}

// Nur ein Lauf gleichzeitig. Ein totes UNC-Ziel haelt einen libuv-Thread bis zum SMB-Timeout
// fest, und denselben Thread-Pool braucht dns.lookup fuer den testo-Sync: wiederholtes
// Speichern darf keine Laeufe stapeln. Ein Anstoss waehrend eines Laufs wird vorgemerkt; alle
// vorgemerkten ergeben genau einen Nachlauf. Das Versprechen loest erst nach dem Nachlauf auf.
// Ende der Schleife und running = null liegen im selben synchronen Abschnitt, so geht kein
// Anstoss zwischen beiden verloren.
function runUpdateCheck(currentVersion) {
  if (running) {
    rerun = true;
  } else {
    running = (async () => {
      try {
        do {
          rerun = false;
          await checkOnce(currentVersion);
        } while (rerun);
      } finally {
        running = null;
      }
    })();
  }
  return running.then(() => getUpdateStatus());
}

// Beim Start einmal, danach alle 6 h. NICHT bei jedem GET /api/system/status:
// die Einstellungsseite ruft den alle 10 s ab - das waeren rund 8.600 Zugriffe
// pro Tag auf eine Netzfreigabe, und ein haengendes UNC-Ziel bliebe direkt im
// Anfragepfad haengen. 6 h reichen fuer einen Rollout, der ohnehin von Hand
// eingespielt wird. unref(): der Timer haelt den Prozess nie am Leben.
function startUpdateCheck(currentVersion) {
  if (timer) clearInterval(timer);
  runUpdateCheck(currentVersion);
  timer = setInterval(() => runUpdateCheck(currentVersion), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

// ── Kommandozeile fuer update.cmd ────────────────────────────────────────────
//   node backend/update-check.js --check-update <ordner> [--pick-file <datei>]
// Vertrag mit deploy/windows/update.cmd, stabil halten:
//   Exit 0  = neuere Fassung gefunden. Mit --pick-file steht in <datei> genau eine
//             ASCII-Zeile "<version> <dateiname>" ohne Zeilenumbruch.
//   Exit 10 = nichts Neueres, Exit 2 = Ordner nicht lesbar,
//   Exit 3  = Aufruf falsch oder eigene VERSION unlesbar.
//   Die 1 bleibt frei: mit 1 endet Node bei jedem Absturz, und ein Absturz darf nie wie
//   "kein Update" aussehen.
// Dieselbe Wahl wie der Dienst (inspectDir), die eigene Version aber aus VERSION statt aus
// der Datenbank. Schreibt nichts in den gelesenen Ordner. Der Bericht ist reines ASCII:
// eine in eine Datei umgeleitete UTF-8-Ausgabe zeigt cmd sonst als Zeichensalat.
const CLI_FLAGS = ['--check-update', '--pick-file'];
const USAGE = 'Aufruf: node backend/update-check.js --check-update <ordner> [--pick-file <datei>]';
const ASCII = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss',
  '„': '"', '“': '"', '–': '-' };
const toAscii = (s) => String(s).replace(/[äöüÄÖÜß„“–]/g, (c) => ASCII[c]);

function isInside(dir, p) {
  const rel = path.relative(dir, path.resolve(p));
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

// -> { '--check-update': ordner, '--pick-file'?: datei } oder ein Text, was falsch ist.
function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!CLI_FLAGS.includes(flag)) return `unbekannter Schalter "${flag}"`;
    if (!value || CLI_FLAGS.includes(value)) return `${flag} ohne Wert`;
    if (flag in args) return `${flag} doppelt`;
    args[flag] = value;
  }
  if (!args['--check-update']) return '--check-update <ordner> fehlt';
  const pick = args['--pick-file'];
  if (pick && isInside(path.resolve(args['--check-update']), pick)) {
    return 'die Übergabedatei darf nicht im Ablageordner liegen';
  }
  return args;
}

async function cli(argv) {
  const say = (line) => console.log(toAscii(line));
  const args = parseCliArgs(argv);
  if (typeof args === 'string') {
    say(`Falscher Aufruf: ${args}.`);
    say(USAGE);
    return 3;
  }
  const dir = path.resolve(args['--check-update']);
  const pick = args['--pick-file'];
  const versionFile = path.join(__dirname, '..', 'VERSION');
  let installed;
  try {
    installed = fs.readFileSync(versionFile, 'utf8').trim();
  } catch (e) {
    installed = e.code || e.message;
  }
  if (!parseVersion(installed)) {
    say(`Eigene Version unlesbar (${versionFile}): "${installed}"`);
    return 3;
  }

  say('Update-Prüfung testo-smart-abruf');
  say(`Ablageordner:         ${dir}`);
  say(`Installierte Version: ${installed}`);
  const { newer, entries, error } = await inspectDir(dir, installed);
  say(`Ordner lesbar:        ${error ? 'nein' : 'ja'}`);
  if (error) {
    say(`Ergebnis: ${describeReadError(dir, error)}`);
    // describeReadError spricht vom Dienst (NetworkService, Computerkonto). Hier liest aber
    // das Konto, das die Kommandozeile gestartet hat - bei update.cmd ein Administrator.
    say('Hinweis: Diese Prüfung lief unter dem Konto, das sie gestartet hat, nicht als Dienst. '
      + 'Fehlt ein Leserecht, dann diesem Konto.');
    return 2;
  }
  say(entries.length ? 'Einträge:' : 'Einträge: keine');
  for (const e of entries) say(`  [${e.ok ? 'ok' : '--'}] ${e.name} (${e.reason})`);
  if (!newer) {
    say(`Ergebnis: nichts Neueres als ${installed}.`);
    return 10;
  }
  if (pick) {
    try {
      fs.writeFileSync(pick, `${newer.version} ${newer.file}`);
    } catch (e) {
      say(`Übergabedatei nicht schreibbar: ${e.message}`);
      return 3;
    }
  }
  say(`Ergebnis: neuere Fassung ${newer.version} gefunden: ${newer.file}`);
  return 0;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  findNewerVersion, inspectDir, describeReadError, runUpdateCheck, getUpdateStatus,
  startUpdateCheck, CLI_FLAGS,
};
