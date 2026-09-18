// Logzeilen fuer app.log (deploy/windows/start.cmd leitet stdout und stderr dorthin).
// Jede Zeile beginnt mit einem Zeitstempel in Ortszeit mit Offset, z. B.
// 2026-09-18T14:03:12+02:00 — ohne ihn ist ein Kundenlog nicht auszuwerten.
// Bewusst ohne Abhaengigkeit: der Server installiert mit npm ci --omit=dev, und die CI
// kopiert node_modules unveraendert ins Windows-Buendel.
const { formatTimestamps } = require('./csv-format');

const stamp = () => formatTimestamps(Date.now()).iso;

// console.* erst beim Aufruf nachschlagen, nie beim Laden in eine Konstante kopieren:
// Tests ersetzen console.error zur Laufzeit und muessen die Ausgabe sehen.
function info(...args) { console.log(stamp(), ...args); }
function warn(...args) { console.warn(stamp(), ...args); }
function error(...args) { console.error(stamp(), ...args); }

// app.log wird nur beim Dienststart rotiert, der Dienst laeuft monatelang durch. Fehler,
// die sich wiederholen (Dashboard-Poll alle 5 s, Sync-Zyklus alle 15 min), kaemen sonst
// tausendfach. Erstes Auftreten je Signatur: volle Ausgabe, danach nur bei 10, 100,
// 1000, … Vorkommnissen eine Zaehlzeile — das Log waechst logarithmisch statt linear.
// Je Anfrage wechselnde Teile (die instance-ID, die die testo-Cloud an jede Fehlerantwort
// haengt, UUIDs, signierte URLs, Zeitstempel) zaehlen nicht zur Signatur, sonst griffe die
// Drosselung nie: jedes Wort ab 8 Zeichen mit einer Ziffer wird zu <id>. Statuscodes (401)
// und Pfade (/v3/alarms) bleiben erhalten.
const counts = new Map(); // Signatur -> Anzahl
function logThrottled(signature, firstLine = signature) {
  const key = String(signature).replace(/[\w-]{8,}/g, (w) => (/\d/.test(w) ? '<id>' : w));
  // ponytail: Obergrenze leert alles auf einmal (auch laufende Scheduler-Zaehler);
  // reicht, solange es nicht mehr als 200 verschiedene Signaturen gibt.
  if (counts.size > 200) counts.clear();
  const count = (counts.get(key) || 0) + 1;
  counts.set(key, count);
  if (count === 1) error(firstLine);
  else if (/^10*$/.test(String(count))) error(`${key} (${count}x)`);
}

// Vergisst alle Signaturen mit diesem Praefix, sobald die Ursache behoben ist: ein
// spaeterer neuer Ausfall erscheint dann wieder mit voller Zeile statt als Zaehlerstand.
function resetThrottled(prefix) {
  for (const key of counts.keys()) if (key.startsWith(prefix)) counts.delete(key);
}

module.exports = { info, warn, error, logThrottled, resetThrottled };
