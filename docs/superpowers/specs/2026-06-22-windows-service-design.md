# Windows-Dauerbetrieb als Hintergrunddienst — Design / Spec

- **Datum:** 2026-06-22
- **Status:** Entwurf (nach kritischem Review überarbeitet — Rev. 2)
- **Betrifft:** Inbetriebnahme der `testo-smart-abruf` Node/Express/SQLite-App als login-unabhängiger Autostart-Dienst auf einem Firmen-Windows-11-Rechner.

---

## 1. Kontext & Ziel

Die App (Node/Express-Backend + better-sqlite3 + statisches React-Dashboard) läuft bisher per `npm start` im Vordergrund auf macOS (Dev). Sie soll **nach Abschluss auf einem Windows-11-64-bit-Rechner innerhalb einer Firmen-IT** dauerhaft laufen:

- **Autostart nach Reboot**, ohne dass sich ein Benutzer anmeldet.
- Läuft als Hintergrundprozess (kein sichtbares Fenster).
- **Leitplanke:** „nichts Überraschendes" — keine Aktionen/Binaries, die Firmen-Sicherheitsrichtlinien (AV/EDR, Netzwerk-Policy) potenziell verletzen.

Zusätzlich werden plattformübergreifende Begleit-Fixes mitgenommen, die für den Windows-Betrieb nötig bzw. sauber sind.

## 2. Constraints (bestätigt mit dem Nutzer)

| Constraint | Wert |
|---|---|
| Ziel-OS | Windows 11, 64-bit (x64) |
| Umfeld | Firmen-IT, sicherheitsrichtlinien-bewusst |
| Admin-Rechte | vorhanden; **IT installiert einmalig** |
| **Dienstkonto** | **`NT AUTHORITY\NetworkService`** (Least-Privilege, netzwerkfähig, kein Passwort) — *kein* SYSTEM |
| Dashboard-Zugriff | konfigurierbar; **Default nur localhost**, LAN als dokumentierter optionaler Schritt |
| Internet beim Setup | vorhanden (ggf. über Firmen-Proxy) |
| Node-Version (Server) | **24 LTS** (festgelegt via `.nvmrc`) |

## 3. Gewählter Ansatz & verworfene Alternativen

**Gewählt: Windows-Aufgabenplanung (Bordmittel).** Ein geplanter Task läuft als **`NetworkService`**, Trigger „Bei Systemstart", login-unabhängig, und startet einen kleinen Launcher, der `node backend\server.js` ausführt.

**Begründung:** Erfüllt das Ziel (Hintergrund + Autostart nach Reboot) vollständig und führt **kein neues Binary** ein — es läuft nur die ohnehin von der IT freigegebene `node.exe`. Mit `NetworkService` statt SYSTEM gibt es **keinen elevated Netzwerk-Listener** — die für EDR auffälligste Signatur entfällt.

**Verworfen / als Alternative dokumentiert:**
- **SYSTEM-Konto** — verworfen als Default (elevated Netzwerk-Listener aus beschreibbarem Ordner = EDR-Red-Flag); nur als klar markierter Fallback im README, falls die IT es ausdrücklich verlangt.
- **WinSW** (echter Dienst) — dokumentierte Alternative im README, falls die IT einen Eintrag in `services.msc` wünscht und eine signierte Wrapper-Exe freigibt.
- **node-windows / NSSM** — verworfen (zusätzliche Abhängigkeit bzw. AV-Flag-Risiko).

## 4. Architektur & Laufzeit-Mechanik

```
Reboot
  └─► Aufgabenplanung (BootTrigger, Delay PT30S)
        └─ Principal: NetworkService, LogonType ServiceAccount, versteckt, NICHT elevated
        └─ Conditions: RunOnlyIfNetworkAvailable=$false, RunOnlyIfIdle=$false, Batterie-Gates aus
        └─ Settings: ExecutionTimeLimit=PT0S, RestartCount=3/RestartInterval=PT1M, MultipleInstances=IgnoreNew
        └─► deploy\windows\start.cmd
              ├─ chcp 65001 (UTF-8 für °C/µ-Logs)
              ├─ setzt DB_PATH / PORT / HOST explizit (CWD- & .env-unabhängig)
              ├─ cd /d "%~dp0..\.." auf App-Root (start.cmd liegt in deploy\windows\, voll gequotet)
              ├─ stdout/stderr -> "%ProgramData%\TestoSmartAbruf\logs\app.log"
              └─► node backend\server.js
                    ├─ lädt .env CWD-unabhängig (Fix 2a, als Ergänzung)
                    ├─ öffnet DB unter C:\ProgramData\… (Fix 2b, mkdir-Guard)
                    ├─ EADDRINUSE → klare Logzeile + Exit≠0 (Fix 2h) → Task-Restart greift
                    └─ Express :PORT + Scheduler-Loop (retry-fähig)
```

### Verzeichnis-Layout & ACLs auf dem Zielrechner

| Pfad | Inhalt | ACL für `NetworkService` |
|---|---|---|
| `C:\Apps\TestoSmartAbruf\` (von IT wählbar) | App-Code + `node_modules` + optional `.env` | **Read & Execute** (Code darf read-only sein) |
| `C:\ProgramData\TestoSmartAbruf\klima.db` (+ `-wal`/`-shm`) | SQLite-DB | **Modify** auf den **Ordner** (deckt alle drei Dateien ab) |
| `C:\ProgramData\TestoSmartAbruf\logs\app.log` | stdout/stderr | **Modify** (s. o.) |

**Prinzip:** Code (read-only) und veränderliche Daten (DB, Logs) sind getrennt; `NetworkService` erhält Schreibrechte **ausschließlich** auf den Datenordner. Der Installer setzt diese ACLs (`icacls`). Damit entfällt das EDR-typische „writable-path + privileged-exec"-Muster.

## 5. Code-/Config-Änderungen (plattformneutral, betreffen auch dev)

| ID | Änderung | Datei(en) | Begründung |
|---|---|---|---|
| 2a | `require('dotenv').config()` → `config({ path: path.join(__dirname, '../.env') })`. **`db.js` ist der effektive erste Loader** (server.js:5 `require('./db')` läuft vor server.js:8), daher muss `db.js:3` gepatcht werden; in server.js zusätzlich dotenv **über** das `./db`-require ziehen. | `backend/db.js:3`, `backend/server.js` | `.env` CWD-unabhängig laden. Im Windows-Betrieb ist `.env` ohnehin sekundär (start.cmd setzt die Kern-Vars), aber dev/macOS-Verhalten bleibt identisch. Test-sicher: dotenv überschreibt gesetzte `process.env`-Werte nicht; Tests setzen `DB_PATH=:memory:` vor dem `require`. |
| 2b | `const fs = require('fs')` + vor `new Database(dbPath)`: `if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })` | `backend/db.js` | better-sqlite3 legt das Zielverzeichnis nicht selbst an → sonst Crash beim ersten Start, wenn der ProgramData-Ordner fehlt. Idempotent, plattformneutral. |
| 2c | `puppeteer` von `dependencies` → `devDependencies` | `package.json` | kein ~150-MB-Chromium-Download, keine „überraschende" Netzaktivität auf dem Server. Nur lose Root-Testscripts nutzen es, nicht das Backend. |
| 2d | `cross-env` (devDep) + `test`-Script auf `cross-env NODE_ENV=test …` | `package.json` | Inline-`VAR=wert`-Syntax bricht unter cmd/PowerShell. |
| 2e | `"engines": { "node": "22.x \|\| 24.x \|\| 26.x" }` + `.nvmrc`=`24` + `.npmrc` mit `engine-strict=true` | `package.json`, `.nvmrc`, `.npmrc` | **Node 23 (ABI 131) hat keinen win32-x64-Prebuild** → aus dem erlaubten Set ausgeschlossen. Verifiziert: better-sqlite3 12.10.0 liefert win32-x64-node-Prebuilds für ABI 127/137/141/147 (= Node 22/24/25/26). Erlaubt sind bewusst die **LTS-Linien 22/24/26** (alle mit Prebuild); **Node 23** (kein Prebuild) und **Node 25** (Non-LTS, obwohl Prebuild vorhanden) sind ausgeschlossen. `.nvmrc=24` ist die getestete Server-Version. `engine-strict` macht aus der Empfehlung eine harte Sperre für `npm ci`. |
| 2f | `package-lock.json` nach den `package.json`-Änderungen via `npm install` neu erzeugen und **mit committen** | `package-lock.json` | sonst schlägt `npm ci --omit=dev` (Lockfile-Konsistenzprüfung) auf der Box fehl. |
| 2h | `server.on('error', e => { if (e.code==='EADDRINUSE') console.error(...); process.exit(1); })` nach `app.listen` | `backend/server.js` | Port-Konflikt erzeugt heute einen unklaren Stacktrace; klare Logzeile + Exit≠0, damit der Task-Restart sauber greift. |

> **Nicht** geändert (Review-Befund zurückgewiesen): kein zusätzliches `busy_timeout`-Pragma — better-sqlite3 setzt es bereits per Default auf 5000 ms (`lib/database.js:34`).

Keine Logik-Umbauten — nur Pfad-/Start-Robustheit + Verpackung. Alle Änderungen sind dev/macOS-neutral.

## 6. Windows-Deploy-Artefakte (neu, in `deploy/windows/`)

| Datei | Zweck |
|---|---|
| `start.cmd` | `chcp 65001`; setzt `DB_PATH`/`PORT`/`HOST`; `cd /d "%~dp0..\.."` auf App-Root (start.cmd liegt in `deploy\windows\`, gequotet); `node backend\server.js >> "%ProgramData%\TestoSmartAbruf\logs\app.log" 2>&1` (cmd blockiert auf node → Task bleibt „running"; **kein** `start`, **kein** Self-Loop). Hinweis: `chcp 65001` ist nur für eine angehängte Konsole relevant — in die Logdatei schreibt Node ohnehin UTF-8-Bytes. |
| `install-task.ps1` | Einmal-Setup (Admin): ProgramData-Ordner anlegen, **ACLs** für NetworkService setzen (`icacls`), Read-Exec auf Code-Ordner sichern, Task **idempotent** registrieren (vorhandenen gleichnamigen Task vorher `Unregister`) |
| `uninstall-task.ps1` | `Unregister-ScheduledTask` (saubere Entfernung) |
| `env.example` | Vorlage: `DB_PATH`, `HOST=127.0.0.1`, `PORT=3000`, optional `TESTO_API_KEY` (Seed beim ersten Init; alternativ via Dashboard-UI). |
| `README.md` | Schritt-für-Schritt für die IT inkl. Proxy-Hinweis, optionalem Firewall-Snippet, Update-Checklist, SYSTEM-/WinSW-Alternativen |

### Task-Definition (`Register-ScheduledTask`)

- **Principal:** `New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\NetworkService" -LogonType ServiceAccount` (nicht elevated).
- **Trigger:** BootTrigger mit `Delay = PT30S` (Netzwerk/DNS warmlaufen lassen).
- **Settings (kritisch):**
  - `ExecutionTimeLimit = PT0S` (**unbegrenzt**) — ⚠️ wichtigster Punkt: Default 72 h würde den Server killen.
  - `RestartCount = 3`, `RestartInterval = PT1M` — nativer Auto-Neustart bei **Crash** (Node-Exit ≠ 0). Ein Graceful-Stop (Exit 0) löst korrekt **keinen** Neustart aus.
  - `MultipleInstances = IgnoreNew`.
  - `DisallowStartIfOnBatteries = $false`, `StopIfGoingOnBatteries = $false`.
  - `RunOnlyIfNetworkAvailable = $false`, `RunOnlyIfIdle = $false` (explizit, damit ein späterer GUI-Edit den Start nicht still blockiert).
  - Task **nicht** versteckt (`-Hidden` weggelassen): eine sichtbare, auditierbare Aufgabe ist EDR-konformer als eine versteckte Aufgabe mit Netzwerk-Listener.
  - **Konto-Bindung:** Node bindet Port 3000 über Winsock/libuv (raw socket), **nicht** über HTTP.sys → **kein** `netsh http add urlacl` nötig; NetworkService darf einen High-Port ohne Elevation binden. ACL-Grants nutzen die **SID `*S-1-5-20`** (locale-unabhängig; auf deutschem Windows heißt das Konto „NETZWERKDIENST").
- **Hinweis:** `StartWhenAvailable` ist bei einem BootTrigger wirkungslos und wird **nicht** gesetzt.

### Resilienz-Klarstellung

Die **eigentliche Garantie** für „läuft nach Reboot" ist der **BootTrigger** (feuert bei jedem Systemstart). Das native „Restart-on-failure" deckt **Crashes** ab (Exit ≠ 0). Ein hängender (nicht-beendender) Prozess wird von keinem der beiden erfasst — das ist ein bewusst akzeptiertes Restrisiko (selten; ggf. später per externem Health-Check abdeckbar, s. §9), kein Self-Loop-`cmd` (wäre „überraschender").

### Firewall

Standardmäßig **keine** Regel (Default `HOST=127.0.0.1`). Für den LAN-Fall ein **separater, dokumentierter** `New-NetFirewallRule`-Befehl im README (und `HOST=0.0.0.0` setzen) — bewusst nicht automatisch, damit die IT den Policy-Eingriff kontrolliert freigibt.

## 7. Edge Cases (Vollständigkeit)

| # | Edge Case | Behandlung |
|---|---|---|
| 4a | dotenv lädt aus CWD; Task hat fremdes CWD | `start.cmd` setzt Kern-Vars **und** `config({ path: __dirname-relativ })` (2a); db.js als effektiver Loader korrekt gepatcht |
| 4b | DB-Schreibrechte (Code evtl. read-only) | DB nach `C:\ProgramData\…`; NetworkService bekommt Modify nur dort |
| 4c | WAL nicht auf Netzlaufwerken/UNC | DB lokal (dokumentiert) + mkdir-Guard (2b) |
| 4d | Graceful Stop: Task-Stop = Hard-Kill, kein `SIGTERM` unter Windows | bewusst akzeptiert — **WAL crashsicher**, Scheduler idempotent → kein Datenverlust |
| 4e | Firewall blockt Port eingehend | nur LAN-Fall, dokumentierter optionaler Schritt |
| E1 | `ExecutionTimeLimit`-Default (72 h) killt Dauerserver | explizit `PT0S` |
| E2 | Node-Version ohne win32-x64-Prebuild (Node 23) → Compiler-Zwang | engines `22\|24\|26`, `.nvmrc=24`, `engine-strict` |
| E3 | `node_modules` von macOS kopiert → falsches ABI/Plattform-`.node` | `npm ci` **auf der Box**, nie kopieren (dokumentiert) |
| E4 | Pfade mit Leerzeichen (Program Files) | überall quoten (`%~dp0`, Task-Action) |
| E5 | Installer doppelt / Task existiert bereits | idempotent: erst `Unregister`, dann `Register` |
| E6 | Port belegt → Crash → Restart-Loop | `PORT` konfigurierbar; EADDRINUSE klar geloggt + Exit≠0 (2h) |
| E7 | Boot vor Netzwerk/DNS bereit | BootTrigger-Delay PT30S + App-Retry/Backoff (vorhanden, `testo-client.js`) |
| E8 | AV sperrt frisch entpackte `.node` während `npm ci` (selten EPERM) | README: `npm ci` ggf. wiederholen / AV-Ausnahme für App-Ordner |
| E9 | `package-lock.json` nach package.json-Edit inkonsistent | Lockfile neu erzeugen + committen (2f) |
| E10 | OEM-Codepage verstümmelt °C/µ in Logs | `chcp 65001` in `start.cmd` |
| E11 | Orphan-`node.exe` hält Port nach Task-Stop → nächster Start EADDRINUSE | Task beendet Prozessbaum; in Abnahme verifizieren (kein Rest-`node.exe`) |
| E12 | `prebuild-install` lädt von **github.com** (Release-Host), nicht nur npm-Registry | Proxy/Allowlist-Hinweis im README; für Air-Gap Prebuild/`node_modules` vorab mitbringen |
| E13 | `?v=`-Cache-Buster: nach Update servt Browser veraltetes JSX | Update-Checklist: VERSION/Badge/`?v=` synchron + Hard-Reload; Server sendet keine Cache-Header → `?v=`-Bump ist der einzige Hebel |
| E14 | NetworkService braucht Schreibrechte auf `.db` **und** `-wal`/`-shm` | Modify auf den **Ordner** (deckt alle drei ab); AV-Ausnahme auf den **Daten**-Ordner empfehlen |

## 8. Offene Annahmen (im README zu adressieren)

- **Proxy / Outbound:** `npm ci` braucht ggf. `npm config set proxy …` — **und** `prebuild-install` braucht Zugriff auf `github.com`/`objects.githubusercontent.com` (separater Allowlist-Eintrag). Der Server muss ausgehend `data-api.<region>.smartconnect.testo.com` erreichen.
- **Delivery:** App-Ordner wird kopiert (ZIP/Netzlaufwerk), dann `npm ci --omit=dev` **auf der Box**. Kein Installer-Paket.

## 9. Tests & Verifikation

- **Bestehende Suite bleibt grün:** `npm test` nach den Änderungen (verifizieren, nicht behaupten).
- **Neue Tests (TDD):** mkdir-Guard (2b) erzeugt fehlendes DB-Verzeichnis; EADDRINUSE-Handler (2h) loggt + exitet ≠0; optional dotenv-Pfadladung CWD-unabhängig.
- **Health-Probe:** `GET /api/system/status` (existiert, `server.js:301`) liefert Scheduler-/DB-/Storage-Status → als Liveness-Endpoint für die IT dokumentieren; daneben „Letztes Ausführungsergebnis" in der Aufgabenplanung.
- **Windows-spezifisch nicht auf macOS testbar:** `install-task.ps1` erhält einen `-WhatIf`-Dry-Run; die echte Reboot-/Autostart-Verifikation ist ein **manueller Abnahmeschritt auf einer Windows-Box** (keine ungetesteten Erfolgsbehauptungen).
- **Akzeptanzkriterien (auf der Windows-Box):**
  1. Nach `install-task.ps1` läuft der Task als NetworkService; `http://localhost:3000` lädt das Dashboard.
  2. `klima.db` + `-wal`/`-shm` entstehen unter `ProgramData`, von NetworkService beschreibbar; `app.log` wird UTF-8-korrekt geschrieben.
  3. Nach **Reboot ohne Login** ist der Server wieder erreichbar.
  4. Crash-Restart: `taskkill /IM node.exe /F` → Task startet Node binnen `RestartInterval` neu; DB bleibt intakt (WAL-Recovery). (Exakte Kill-Variante dokumentieren.)
  5. Nach Task-Stop bleibt **kein** Orphan-`node.exe` auf dem Port (E11).
  6. `uninstall-task.ps1` entfernt den Task rückstandslos.

## 10. Out of Scope (YAGNI)

- Echter Windows-Dienst (WinSW) und SYSTEM-Konto — nur als dokumentierte Alternativen, nicht implementiert.
- Self-Loop-`cmd` für Hang-Erkennung / externer Health-Watchdog — bewusst weggelassen (Restrisiko akzeptiert).
- `busy_timeout`-Pragma — bereits better-sqlite3-Default (5000 ms), kein Code nötig.
- Log-Rotation (Logvolumen niedrig; README-Hinweis), Auto-Update, MSI-Paketierung, HTTPS/Reverse-Proxy.
