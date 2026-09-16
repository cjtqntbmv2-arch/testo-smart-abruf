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
// ergeben alle "kein Update bekannt". Der Dienst hat Vorrang.
async function findNewerVersion(dir, currentVersion) {
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
  } catch (_e) {
    return null;
  }
  return best ? best.join('.') : null;
}

let state = { enabled: false, updateAvailable: false, latestVersion: null, checkedAt: null };
let timer = null;

function getUpdateStatus() { return { ...state }; }

// Einmalige Pruefung. Liest den Ablageordner bei jedem Lauf neu aus den Einstellungen,
// damit eine Aenderung ohne Dienstneustart greift.
async function runUpdateCheck(currentVersion) {
  try {
    const dir = (getSetting('update_dir') || '').trim();
    if (!dir) {
      state = { enabled: false, updateAvailable: false, latestVersion: null, checkedAt: Date.now() };
      return getUpdateStatus();
    }
    const newer = await findNewerVersion(dir, currentVersion);
    state = { enabled: true, updateAvailable: !!newer, latestVersion: newer, checkedAt: Date.now() };
  } catch (_e) {
    // Auch ein Fehler beim Lesen der Einstellung darf den Dienst nicht stoeren.
    state = { ...state, checkedAt: Date.now() };
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
