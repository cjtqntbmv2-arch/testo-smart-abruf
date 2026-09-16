# Umsetzung der Befundliste (Projektanalyse 2026-09-16)

Spezifikation ist der Befundbericht der Analyse-Sitzung vom 2026-09-16. Diese Datei
ist nur die Fortschrittsverfolgung — sie wiederholt den Bericht nicht.

Jeder Punkt wird von einem eigenen Subagenten vertieft und umgesetzt. Die Wellen sind
so geschnitten, dass **keine zwei gleichzeitig laufenden Agenten dieselbe Datei
anfassen**. Zwischen den Wellen: volle Testsuite ohne Sandbox, dann Merge nach `main`.

## Regeln für jeden Agenten

- Erst vertiefen (Befund am Code verifizieren), dann umsetzen.
- Test zuerst: der fehlschlagende Test kommt vor der Implementierung, der rote Lauf
  wird tatsächlich beobachtet.
- Nur die dem Punkt zugewiesenen Dateien anfassen. Andere Dateien: melden, nicht ändern.
- **Niemals `.env` oder `.env.*` anfassen** — in einer früheren Sitzung hat ein
  Subagent `.env.example` auf 0 Byte gekürzt.
- Nicht committen. Der Orchestrator committet je Welle.
- `backend/tests/server.test.js` scheitert in der Sandbox mit `EPERM` beim `listen`
  auf 127.0.0.1:3001. Das ist **kein** Codefehler. Nicht danach suchen.

## Wellen

| Welle | Punkte | Branch | Stand |
|---|---|---|---|
| 0 | #3 Branches/Worktree | — (direkt auf main) | **erledigt** |
| 1 | #1 Region · #2 §9-Doku · #13 foreign_keys · #6 Löschungen | `fix/befunde-welle-1` | **erledigt** — 265 Tests grün |
| 2 | #4 UpdateCard · #5 DELETE-Test · #7 uninstall-Doku · #12 Mock-Riegel · #14 spec/ | `fix/befunde-welle-2` | offen |
| 3 | #8 Abhängigkeiten · #10 Schwellwert-Konflikt | `fix/befunde-welle-3` | offen |
| 4 | #11 Vereinheitlichung | `refactor/befunde-welle-4` | offen |
| 5 | #9 data.js-Tests | `test/befunde-welle-5` | offen |

## Dateizuordnung (verbindlich, verhindert Kollisionen)

| # | Aufgabe | Ausschliesslich diese Dateien |
|---|---|---|
| 1 | Region `eu`/`am`/`ap` | `Smart Meter Dashboard/settings.jsx`, `backend/server.js`, `backend/tests/server.test.js` |
| 2 | §9: Endpunkt + Idempotenz | `deploy/windows/README.md` |
| 13 | `foreign_keys = ON` | `scripts/migrate-*.js`, `backend/tests/migrate-args.test.js` |
| 6 | uploads/.thumbnail/monthKey | `Smart Meter Dashboard/uploads/*`, `Smart Meter Dashboard/.thumbnail`, `.gitignore`, `backend/backup-runner.js`, `backend/tests/backup-runner.test.js` |
| 4 | UpdateCard-Ladefehler | `Smart Meter Dashboard/settings.jsx` |
| 5 | DELETE-Route absichern | `backend/server.js`, `backend/tests/server.test.js` |
| 7 | uninstall dokumentieren | `deploy/windows/README.md` |
| 12 | Mock-Pfad riegeln | `backend/testo-client.js`, `backend/tests/testo-client.test.js` |
| 14 | spec/ entfernen | `spec/**`, `CLAUDE.md` |
| 8 | Abhängigkeiten | `package.json`, `package-lock.json` |
| 10 | Schwellwert-Konflikt melden | `backend/device-bridge.js`, `backend/scheduler.js`, `backend/server.js`, `Smart Meter Dashboard/settings.jsx` |
| 11 | Vereinheitlichung | `Smart Meter Dashboard/data.js`, `tiles.jsx`, `app.jsx`, `backend/device-bridge.js` |
| 9 | data.js-Tests | `Smart Meter Dashboard/tests/` (neu), `Smart Meter Dashboard/data.js`, `package.json` |

## Entscheidungen des Nutzers (2026-09-16)

- **#14**: `spec/` vollständig löschen **und** den `## Ignore: spec/`-Abschnitt aus
  `CLAUDE.md` streichen.
- **#6**: alle 6 Dateien löschen (5 PNG + `.thumbnail`) und in `.gitignore` aufnehmen.
- **#8**: `cross-env` und `dotenv` heben; `better-sqlite3` 13 nur nach geprüften
  win32-x64-Prebuilds für Node 22/24/26; `express` 5 ausdrücklich **nicht** Teil
  dieses Laufs.

## Übertrag aus Welle 1 (in Welle 2 einzuarbeiten)

- **#5 bekommt zusätzlich:** einen Test für die Regions-Startup-Migration aus
  `backend/server.js` (setzt ein ungültiges gespeichertes Regionskürzel einmalig auf
  `eu`). Der Agent von #1 konnte sie nicht in `server.test.js` abdecken, weil `server.js`
  dort einmalig beim Modul-Load geladen wird und sich ein vorheriges `us` nicht mehr
  einschleusen lässt. Der Weg über einen Kindprozess ist gangbar und im Projekt üblich —
  `migrate-args.test.js` nutzt `spawnSync`, `dotenv-path.test.js` und `db-mkdir.test.js`
  ebenso. Bis dahin ist die Migration nur von Hand verifiziert.
- **#7 bekommt zusätzlich:** `deploy/windows/env.example:45` nennt nur
  `# TESTO_API_REGION=eu` als Beispiel, ohne die gültigen Werte. Nach der Korrektur aus #1
  gehört die vollständige Liste (`eu`, `am`, `ap`) dorthin. Damit besitzt #7 zwei Dateien:
  `deploy/windows/README.md` **und** `deploy/windows/env.example`.
- **Gemeldet, bewusst nicht behoben:** `backend/db.js:124` seedet `api_region` ungeprüft
  aus `TESTO_API_REGION`, `backend/scheduler.js:75` liest sie ungeprüft. Beides ist durch
  die Startup-Migration abgesichert — kein eigener Handlungsbedarf.

## Abschluss

Nach Welle 5: Versionsstand nach `versioning`-Skill heben (mehrere Bugfixes +
entfernte Dateien ⇒ mindestens PATCH, eher MINOR), `VERSION` / `package.json` /
README-Badge / alle `?v=` in `Klima Dashboard.html` synchron halten.
