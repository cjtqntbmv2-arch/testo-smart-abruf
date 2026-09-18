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
const fsp = require('node:fs/promises');
const path = require('node:path');
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

// Hoechste Version im Ordner, die echt neuer ist als currentVersion - sonst null.
// Wirft nie: fehlender Ordner, fehlende Rechte, totes Netzlaufwerk, kaputter Eintrag
// ergeben alle "kein Update bekannt". Der Dienst hat Vorrang. onError erfaehrt den
// Grund, wenn der Ordner selbst nicht lesbar ist (fuers Log).
async function findNewerVersion(dir, currentVersion, onError) {
  const current = parseVersion(currentVersion);
  if (!current) return null; // eigene Version unlesbar -> nichts melden
  let best = null;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue; // ein Ordner mit passendem Namen zaehlt nicht
      const m = ZIP_RE.exec(entry.name);
      if (!m) continue;
      // 0-Byte-Datei = der Kopiervorgang laeuft noch. Meldet man die, steht beim
      // Kunden "Update verfuegbar" auf eine Datei, die es noch nicht gibt.
      try {
        if ((await fsp.stat(path.join(dir, entry.name))).size === 0) continue;
      } catch (_e) { continue; }
      const v = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (compareVersions(v, current) > 0 && (!best || compareVersions(v, best) > 0)) best = v;
    }
  } catch (e) {
    if (onError) onError(e);
    return null;
  }
  return best ? best.join('.') : null;
}

let state = { enabled: false, updateAvailable: false, latestVersion: null, checkedAt: null };
let timer = null;

function getUpdateStatus() { return { ...state }; }

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
// damit eine Aenderung ohne Dienstneustart greift.
async function runUpdateCheck(currentVersion) {
  try {
    const dir = (getSetting('update_dir') || '').trim();
    if (!dir) {
      state = { enabled: false, updateAvailable: false, latestVersion: null, checkedAt: Date.now() };
      logOnChange('aus', 'Update-Prüfung aus (kein Ablageordner eingestellt)');
      return getUpdateStatus();
    }
    let readError = null;
    const newer = await findNewerVersion(dir, currentVersion, (e) => { readError = e; });
    state = { enabled: true, updateAvailable: !!newer, latestVersion: newer, checkedAt: Date.now() };
    if (readError) {
      logOnChange(`fehler|${dir}|${readError.code || readError.message}`,
        `Update-Prüfung: Ablageordner "${dir}" nicht lesbar (${readError.message})`, warn);
    } else if (newer) {
      logOnChange(`neu|${dir}|${newer}`, `Update-Prüfung: neuere Fassung ${newer} im Ablageordner "${dir}" (laufend ${currentVersion})`);
    } else {
      logOnChange(`aktuell|${dir}`, `Update-Prüfung: Ablageordner "${dir}" erreichbar, nichts Neueres als ${currentVersion}`);
    }
  } catch (e) {
    // Auch ein Fehler beim Lesen der Einstellung darf den Dienst nicht stoeren.
    state = { ...state, checkedAt: Date.now() };
    logOnChange(`fehler|${e.message}`, `Update-Prüfung fehlgeschlagen: ${e.message}`, warn);
  }
  return getUpdateStatus();
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

module.exports = { findNewerVersion, runUpdateCheck, getUpdateStatus, startUpdateCheck };
