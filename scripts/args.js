// Gemeinsame Argumentauswertung aller Migrationsskripte in diesem Ordner.
//
// Bewusst OHNE Rueckfall auf einen geratenen Datenbankpfad. Ein Migrationsskript,
// das sich seine Datenbank selbst sucht, schreibt im Zweifel in die Produktions-
// datenbank des laufenden Dienstes - genau der Fehler, der nicht auffaellt, weil
// er wie ein Erfolg aussieht. Der Bediener nennt den Pfad, oder es passiert nichts.
//
// Meldungen bleiben reines ASCII: sie werden auf einer Windows-Konsole gelesen.

const fs = require('fs');
const path = require('path');

// Jede SQLite-Datei beginnt mit diesen 16 Bytes. Der Blick darauf kostet nichts und
// faengt den zweitwahrscheinlichsten Fehlgriff ab: den Pfad auf klima.db-wal,
// klima.db-shm oder eine Sicherungsdatei zu richten statt auf die Datenbank selbst.
// Eine WEITERGEHENDE Schemapruefung (liegt die Tabelle vor, die dieses Skript anfasst?)
// gibt es bewusst nicht: sie muesste dem Helfer je Skript die Tabelle mitgeben, und der
// Fall "echte SQLite-Datei mit fremdem Schema" ist in der Produktion unwahrscheinlich -
// dort meldet SQLite ohnehin bereits sprechend "no such table: events".
const SQLITE_MAGIC = 'SQLite format 3\0';

function looksLikeSqlite(file) {
  const buf = Buffer.alloc(16);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, 16, 0);
  } catch {
    return false; // z. B. ein Verzeichnis oder eine unlesbare Datei
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return buf.toString('latin1') === SQLITE_MAGIC;
}

function abort(reason) {
  const name = path.basename(process.argv[1] || 'migrate-*.js');
  console.error(
    `${reason}\n\n` +
      `  node scripts/${name} --db <pfad-zur-datenbank> [--apply]\n\n` +
      `Der Pfad wird nicht geraten. Beim Windows-Dienst steht er in der Umgebungs-\n` +
      `variablen DB_PATH (ueblicherweise C:\\ProgramData\\TestoSmartAbruf\\klima.db);\n` +
      `nachzusehen in der Aufgabenplanung bzw. unter deploy/windows/.\n` +
      `Vorher den Dienst stoppen und per VACUUM INTO sichern - siehe scripts/README.md.`
  );
  process.exit(1);
}

// -> { apply: boolean, dbPath: string }; beendet den Prozess mit Code 1, wenn --db
// fehlt oder keinen Wert hat (z. B. als letztes Argument).
function parseArgs() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--db');
  if (i === -1) abort('Abbruch: --db fehlt.');

  const dbPath = argv[i + 1];
  if (!dbPath || dbPath.startsWith('--')) abort('Abbruch: --db braucht einen Pfad als Wert.');

  // Vor dem Oeffnen pruefen: better-sqlite3 legt eine fehlende Datei stillschweigend neu
  // an und scheitert erst an der ersten Abfrage - zurueck bleibt eine 0-Byte-Datei am
  // falschen Ort und ein Stacktrace statt einer Meldung.
  if (!fs.existsSync(dbPath)) abort(`Abbruch: unter ${dbPath} liegt keine Datei. Tippfehler im Pfad?`);
  if (!looksLikeSqlite(dbPath)) {
    abort(
      `Abbruch: ${dbPath} ist keine SQLite-Datenbank.\n` +
        `Zeigt der Pfad versehentlich auf klima.db-wal, klima.db-shm oder eine Sicherung?`
    );
  }

  return { apply: argv.includes('--apply'), dbPath };
}

module.exports = { parseArgs };
