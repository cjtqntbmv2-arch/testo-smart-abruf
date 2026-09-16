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
| 2 | #4 UpdateCard · #5 DELETE-Test · #7 uninstall-Doku · #12 Mock-Riegel · #14 spec/ | `fix/befunde-welle-2` | **erledigt** — 272 Tests grün |
| 3 | #8 Abhängigkeiten · #10 Schwellwert-Konflikt · #15 BackupSettings | `fix/befunde-welle-3` | **erledigt** — 276 Tests grün |
| 4 | #11 Vereinheitlichung | `refactor/befunde-welle-4` | **erledigt** — 276 Tests grün, Verhalten unverändert |
| 5 | #9 data.js-Tests (+ #17) · #16 Mock-Status | `test/befunde-welle-5` | **erledigt** — 313 Tests grün |

## Nachträglich aufgenommen (Folgefunde aus Welle 2, vom Nutzer freigegeben)

Drei Punkte, die nicht in der ursprünglichen Liste standen. Sie entstanden aus den
Agentenberichten der Welle 2 und wurden dem Nutzer einzeln vorgelegt.

| # | Aufgabe | Ausschliesslich diese Dateien | Welle |
|---|---|---|---|
| 15 | `BackupSettings` sperrt Speichern/Umschalten nicht, wenn das Laden scheiterte — gleicher Fehler wie #4, aber mit Umschalter zusätzlich | `Smart Meter Dashboard/export-panel.jsx` | 3 |
| 16 | Mock-Modus sichtbar machen: Feld in `GET /api/system/status` + Banner im Dashboard, damit ein versehentlich gesetztes `TESTO_MOCK=1` nicht nur als Logzeile erscheint | `backend/server.js`, `backend/tests/server.test.js`, `Smart Meter Dashboard/header.jsx` | 5 |
| 17 | `fetchSettings` übersetzt nur HTTP-Fehler; Netzwerkabbruch und kaputtes JSON erreichen die Oberfläche als rohe englische Browser-Meldung | `Smart Meter Dashboard/data.js` (an #9 angehängt) | 5 |

#16 kann nicht in Welle 3 laufen: `backend/server.js` und `settings.jsx` gehören dort #10.
Deshalb Welle 5, und die Anzeige über `header.jsx` statt `settings.jsx`.
#17 kann nicht vor Welle 5 laufen: `data.js` gehört in Welle 4 dem Punkt #11.

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

## Übertrag aus Welle 3

- **#11 bekommt zusätzlich:** Die deutsche Metrik-Beschriftungstabelle existiert jetzt
  **dreifach** — in `Smart Meter Dashboard/data.js` (`META`), in `backend/device-bridge.js`
  und neu in `settings.jsx` (durch #10). Die dritte Kopie entstand nur, weil die
  Dateisperre das Teilen verhinderte. Sie gehört in die Vereinheitlichung.
- **Zurückgestellt, nicht vergessen:** `better-sqlite3` 13.0.3 hat belegt
  win32-x64-Prebuilds für Node 22/24/26 (N-API, eine Binärdatei für alle) — der Bump
  scheitert aber an `.github/workflows/windows-bundle.yml:46-57`, das noch den alten
  12.x-Pfad `build/Release/better_sqlite3.node` prüft. Bump und CI-Guard müssen
  **gemeinsam** geändert werden, sonst bricht der nächste Release-Build. Veraltet sind
  dadurch auch `deploy/windows/README.md:24,262` und
  `docs/superpowers/specs/2026-06-22-windows-service-design.md:146` (Proxy-Allowlist für
  `prebuild-install`, das 13.x nicht mehr braucht).
- **Beobachtet, nicht behoben:** Ein fehlschlagender `assert` in `scheduler.test.js` oder
  `server.test.js` überspringt das abschliessende `closeDb()` und lässt den *nächsten*
  Test kaskadierend mit `SQLITE_CONSTRAINT_PRIMARYKEY` scheitern. Das macht einen
  einzelnen echten Fehlschlag schwerer lesbar als nötig. Vorbestehend.
- **`dotenv` 17 schreibt beim Start eine Zeile** (`quiet` defaultet auf `false`):
  `injected env (N) from .env`. Abstellbar mit `quiet: true` in `backend/server.js` und
  `backend/db.js`. Bewusst **nicht** abgestellt: Auf einer Kundenmaschine ist „wurde die
  .env überhaupt gelesen und mit wie vielen Werten" genau die Frage, die im Fehlerfall
  zuerst gestellt wird — die Zeile ist dort eher Diagnose als Rauschen.

## Abschluss — erledigt

Alle 17 Punkte sind in `main`. Version auf **0.16.0** gehoben (MINOR: neue Funktionen
abwärtskompatibel ergänzt). Tests 256 → **313**.

Achtung für den nächsten Bump: `check_version.py --set` kennt in diesem Projekt nur
`VERSION` und `package.json`. Der README-Badge und die **14** `?v=`-Cache-Buster in
`Klima Dashboard.html` müssen von Hand nachgezogen werden — `dashboard-load.test.js`
schlägt fehl, wenn die `?v=` nicht zur `VERSION` passen, fängt den Badge aber nicht.

### Offen geblieben (bewusst, mit Begründung)

| Thema | Warum offen |
|---|---|
| `better-sqlite3` 13 | Prebuilds belegt vorhanden, aber CI-Guard prüft den alten 12.x-Pfad. Bump und `windows-bundle.yml:46-57` müssen gemeinsam geändert werden. |
| `express` 4 → 5 | Vom Nutzer ausdrücklich aus diesem Lauf ausgenommen. Die 3 offenen `npm audit`-Findings hängen daran. |
| `EventRow` erfindet Richtung bei `threshold == null` | `eventTitle()` fängt den Fall ab, die sichtbare Kopfzeile nicht. Korrektur ist ein Rendering-Redesign ohne Testbarkeit. |
| `closeDb()` wird bei fehlschlagendem `assert` übersprungen | Lässt den *nächsten* Test kaskadierend scheitern. Vorbestehend, erschwert Fehlersuche. |
| `dashboard-load.test.js` kennt `SyntaxError` nicht | Bezeichner-Liste unvollständig; in #17 über `err.name` umgangen statt nachgetragen. |
| Mock-Banner scrollt weg | Wie das bestehende Offline-Banner nicht `position: sticky`; bräuchte eine Stylesheet-Änderung. |
