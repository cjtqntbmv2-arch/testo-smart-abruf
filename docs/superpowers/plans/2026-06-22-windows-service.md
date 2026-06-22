# Windows-Dauerbetrieb als Hintergrunddienst — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die `testo-smart-abruf` Node/Express/SQLite-App als login-unabhängigen, nach Reboot automatisch startenden Hintergrund-Task auf einem Firmen-Windows-11-x64-Rechner betreiben — plus die dafür nötigen plattformneutralen Code-/Config-Härtungen.

**Architecture:** Windows-Aufgabenplanung (Bordmittel, kein neues Binary) startet bei Systemstart einen `start.cmd`-Launcher als `NT AUTHORITY\NetworkService` (Least-Privilege, nicht elevated), der `node backend\server.js` mit explizit gesetzten Env-Vars und UTF-8-Logging ausführt. Code liegt read-only, die SQLite-DB unter `C:\ProgramData\TestoSmartAbruf\` (lokal → WAL-tauglich, von NetworkService beschreibbar). Begleitend: dotenv CWD-unabhängig, mkdir-Guard für den DB-Ordner, sauberes EADDRINUSE-Handling, puppeteer → devDeps, cross-env, Node-Version-Pin.

**Tech Stack:** Node.js (Server: 24 LTS), Express, better-sqlite3 (natives Modul, win32-x64-Prebuild), `node --test`, Windows Task Scheduler / PowerShell / cmd.

## Global Constraints

- Ziel-OS: **Windows 11 x64**, Firmen-IT, Leitplanke „nichts Überraschendes" (keine AV/EDR-auffälligen Binaries/Aktionen).
- Dienstkonto: **`NT AUTHORITY\NetworkService`** — nicht elevated.
- Node Server: **24 LTS**; erlaubt **`22.x || 24.x || 26.x`** (LTS-Linien, alle mit win32-x64-Prebuild). Bewusst ausgeschlossen: **Node 23** (kein Prebuild) und **Node 25** (Non-LTS, obwohl Prebuild vorhanden) — „erlaubt = LTS-mit-Prebuild", nicht „alle prebuilt".
- DB-Ablage: **`C:\ProgramData\TestoSmartAbruf\klima.db`** (lokale Platte, WAL); Code-Ordner darf read-only sein.
- Alle Code-Änderungen **dev/macOS-neutral** und **test-sicher**: Tests setzen `process.env.DB_PATH = ':memory:'` vor dem `require('../db')`; dotenv überschreibt bereits gesetzte `process.env`-Werte nicht.
- **Kein** zusätzliches `busy_timeout`-Pragma (better-sqlite3 Default = 5000 ms).
- **Kein Git-Remote** → Version-Bump = Commit + lokaler annotierter Tag, **kein Push**.
- Commit-Konvention: Conventional Commits; jede Commit-Message endet mit der Zeile `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: mkdir-Guard für den DB-Ordner

**Files:**
- Modify: `backend/db.js` (fs-Require ergänzen; `mkdirSync` vor `new Database`)
- Test: `backend/tests/db-mkdir.test.js` (neu)

**Interfaces:**
- Consumes: `initDb()`, `getDb()`, `closeDb()` aus `backend/db.js`
- Produces: keine neuen Symbole; verändertes Verhalten von `initDb()` (legt fehlendes DB-Verzeichnis an)

- [ ] **Step 1: Failing test schreiben**

`backend/tests/db-mkdir.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Eindeutiger, noch NICHT existierender Pfad — beweist, dass initDb das Verzeichnis anlegt.
const tmpRoot = path.join(os.tmpdir(), `testo-mkdir-${process.pid}`);
const dbPath = path.join(tmpRoot, 'nested', 'klima.db');
process.env.DB_PATH = dbPath; // muss VOR dem require gesetzt sein

const { initDb, getDb, closeDb } = require('../db');

test('initDb legt das DB-Elternverzeichnis an, wenn es fehlt', () => {
  assert.ok(!fs.existsSync(path.dirname(dbPath)), 'Vorbedingung: Verzeichnis fehlt');
  initDb();
  assert.ok(fs.existsSync(dbPath), 'DB-Datei wurde erstellt');
  const row = getDb().prepare('SELECT 1 AS one').get();
  assert.strictEqual(row.one, 1);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test backend/tests/db-mkdir.test.js`
Expected: FAIL — better-sqlite3 wirft `SqliteError: unable to open database file` (Verzeichnis fehlt).

- [ ] **Step 3: Minimale Implementierung in `backend/db.js`**

Oben bei den Requires `fs` ergänzen (direkt nach `const path = require('path');`):

```js
const fs = require('fs');
```

In `initDb()`, direkt nach der `dbPath`-Zeile und VOR `db = new Database(dbPath);`:

```js
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../klima.db');
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  db = new Database(dbPath);
```

- [ ] **Step 4: Test ausführen, Erfolg bestätigen**

Run: `node --test backend/tests/db-mkdir.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Regressionslauf**

Run: `NODE_ENV=test node --test backend/tests/*.test.js`
Expected: alle bestehenden + der neue Test grün.

- [ ] **Step 6: Commit**

```bash
git add backend/db.js backend/tests/db-mkdir.test.js
git commit -m "feat(db): create DB parent directory if missing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Sauberes EADDRINUSE-Handling beim Listen

**Files:**
- Create: `backend/listen-error.js`
- Modify: `backend/server.js` (Require + `server.on('error', …)`)
- Test: `backend/tests/listen-error.test.js` (neu)

**Interfaces:**
- Produces: `backend/listen-error.js` exportiert `{ handleListenError(err, deps?) }` mit `deps = { log?, exit?, port? }`; loggt eine klare Zeile und ruft `exit(1)`.
- Consumes (in server.js): `handleListenError` an `server.on('error', …)` gehängt.

- [ ] **Step 1: Failing test schreiben**

`backend/tests/listen-error.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { handleListenError } = require('../listen-error');

test('EADDRINUSE → klare Meldung mit Port + exit(1)', () => {
  const logs = [];
  let exitCode = null;
  handleListenError(
    { code: 'EADDRINUSE' },
    { log: (...a) => logs.push(a.join(' ')), exit: (c) => { exitCode = c; }, port: 3000 }
  );
  const out = logs.join('\n');
  assert.match(out, /EADDRINUSE/);
  assert.match(out, /3000/);
  assert.strictEqual(exitCode, 1);
});

test('anderer Fehler → generische Meldung + exit(1)', () => {
  const logs = [];
  let exitCode = null;
  handleListenError(
    { code: 'EOTHER', message: 'boom' },
    { log: (...a) => logs.push(a.join(' ')), exit: (c) => { exitCode = c; } }
  );
  assert.match(logs.join('\n'), /Listen-Fehler/);
  assert.strictEqual(exitCode, 1);
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test backend/tests/listen-error.test.js`
Expected: FAIL — `Cannot find module '../listen-error'`.

- [ ] **Step 3: Implementierung `backend/listen-error.js`**

```js
// Übersetzt ein 'error'-Event des HTTP-Servers in eine klare Logzeile + Exit≠0,
// damit der Windows-Task-Scheduler ("Bei Fehler neu starten") auf einen
// Port-Konflikt reagieren kann statt einen unklaren Stacktrace zu werfen.
function handleListenError(err, deps = {}) {
  const log = deps.log || console.error;
  const exit = deps.exit || process.exit;
  const port = deps.port || process.env.PORT || 3000;
  if (err && err.code === 'EADDRINUSE') {
    log(`Port ${port} ist bereits belegt (EADDRINUSE) — Server kann nicht starten.`);
  } else {
    log('Server-Listen-Fehler:', err);
  }
  exit(1);
}

module.exports = { handleListenError };
```

- [ ] **Step 4: Test ausführen, Erfolg bestätigen**

Run: `node --test backend/tests/listen-error.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: In `backend/server.js` verdrahten**

Bei den übrigen Requires oben ergänzen:

```js
const { handleListenError } = require('./listen-error');
```

Direkt **nach** dem `const server = process.env.HOST ? app.listen(...) : app.listen(...)`-Block (vor dem Graceful-Shutdown-Abschnitt) einfügen:

```js
// Nur außerhalb der Tests anhängen: backend/tests/server.test.js importiert dieses
// Modul und bindet real Port 3001 (process.env.PORT). Ein process.exit(1) im
// 'error'-Handler würde sonst bei einem Port-Konflikt den Test-Worker hart beenden.
// Gleiches NODE_ENV-Guard-Muster wie die Test-Route in server.js (Zeile ~408).
if (process.env.NODE_ENV !== 'test') {
  server.on('error', (e) => handleListenError(e));
}
```

- [ ] **Step 6: Regressionslauf**

Run: `NODE_ENV=test node --test backend/tests/*.test.js`
Expected: alle grün. `server.test.js` importiert `server.js` und bindet Port 3001 beim Import (`server.test.js:6-10`) — der `NODE_ENV`-Guard verhindert, dass der neue Handler den Test-Worker beeinflusst.

- [ ] **Step 7: Commit**

```bash
git add backend/listen-error.js backend/server.js backend/tests/listen-error.test.js
git commit -m "feat(server): clear EADDRINUSE handling with non-zero exit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: dotenv CWD-unabhängig laden

**Files:**
- Modify: `backend/db.js:3` (dotenv mit Pfad)
- Modify: `backend/server.js` (dotenv über das `./db`-require ziehen, mit Pfad)
- Test: `backend/tests/dotenv-path.test.js` (neu)

**Interfaces:**
- Consumes: `backend/db.js` (effektiver erster dotenv-Loader, da `server.js` `require('./db')` vor seiner eigenen dotenv-Zeile ausführt)
- Produces: keine neuen Symbole; `.env` wird relativ zum Modulverzeichnis statt zum CWD geladen.

- [ ] **Step 1: Failing test schreiben**

`backend/tests/dotenv-path.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Race-frei: prüft am Quelltext, dass dotenv mit einem __dirname-relativen Pfad
// aufgerufen wird. Ein nacktes config() würde aus dem CWD laden (Bug 4a).
// Kein Mutieren der geteilten .env, kein Kindprozess → keine Parallel-Test-Races.
for (const rel of ['db.js', 'server.js']) {
  test(`${rel} ruft dotenv mit __dirname-relativem Pfad auf`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(
      src,
      /require\(['"]dotenv['"]\)\.config\(\s*\{[^}]*__dirname/,
      `${rel}: dotenv.config() muss { path: ...__dirname... } erhalten`
    );
  });
}
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test backend/tests/dotenv-path.test.js`
Expected: FAIL (2 Subtests) — vor dem Fix rufen beide Dateien `require('dotenv').config()` **ohne** `{ path: … }` auf → Regex matcht nicht.

- [ ] **Step 3: `backend/db.js:3` anpassen**

`path` ist in `db.js:2` bereits required. Zeile 3 ersetzen:

```js
require('dotenv').config({ path: path.join(__dirname, '../.env') });
```

- [ ] **Step 4: `backend/server.js` anpassen**

dotenv über das `./db`-require ziehen. Der Kopf von `server.js` lautet danach:

```js
const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { initDb, getDb, getSetting, saveSetting, closeDb } = require('./db');
const { startScheduler, runSyncCycle, getSchedulerStatus, stopScheduler } = require('./scheduler');
const TestoClient = require('./testo-client');
const { handleListenError } = require('./listen-error');
```

Die **alte** `require('dotenv').config();`-Zeile (vormals server.js:8, ohne Pfad) **entfernen**.

- [ ] **Step 5: Test ausführen, Erfolg bestätigen**

Run: `node --test backend/tests/dotenv-path.test.js`
Expected: PASS (2 Subtests — db.js und server.js).

- [ ] **Step 6: Regressionslauf**

Run: `NODE_ENV=test node --test backend/tests/*.test.js`
Expected: alle grün.

- [ ] **Step 7: Commit**

```bash
git add backend/db.js backend/server.js backend/tests/dotenv-path.test.js
git commit -m "fix(config): load .env relative to module dir, not cwd

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: package.json härten + Node-Version pinnen

**Files:**
- Modify: `package.json` (puppeteer → devDeps; cross-env; test-Script; engines)
- Create: `.nvmrc`
- Create: `.npmrc`
- Modify: `package-lock.json` (neu erzeugt)

**Interfaces:**
- Consumes: nichts aus früheren Tasks
- Produces: `npm test` läuft cross-plattform; `npm ci --omit=dev` installiert kein puppeteer; Node-Version wird via `engine-strict` erzwungen.

- [ ] **Step 1: `package.json` ersetzen**

Vollständiger neuer Inhalt (Version bleibt vorerst unverändert — sie wird in Task 8 konsolidiert):

```json
{
  "name": "testo-smart-abruf",
  "version": "0.9.3",
  "description": "Local server and dashboard for testo Smart Connect API data sync",
  "main": "backend/server.js",
  "scripts": {
    "start": "node backend/server.js",
    "test": "cross-env NODE_ENV=test node --test backend/tests/*.test.js && cross-env NODE_ENV=test node --test \"Smart Meter Dashboard/tests/metrics-logic.test.js\" \"Smart Meter Dashboard/tests/summary-logic.test.js\" \"Smart Meter Dashboard/tests/status-logic.test.js\""
  },
  "engines": {
    "node": "22.x || 24.x || 26.x"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "cross-env": "^7.0.3",
    "puppeteer": "^25.1.0"
  }
}
```

> Hinweis: Die `version` bleibt hier **unverändert** beim Ist-Wert `0.9.3` (verifiziert via `node -p "require('./package.json').version"`). Sie ist absichtlich nicht deckungsgleich mit `VERSION` (=0.9.4, latenter Skew) — **nicht** hier anfassen; Task 8 konsolidiert ALLE Stellen auf `0.10.0`. Vor dem Edit den Ist-Wert erneut prüfen und übernehmen, falls abweichend.

- [ ] **Step 2: `.nvmrc` anlegen**

```
24
```

- [ ] **Step 3: `.npmrc` anlegen**

```
engine-strict=true
```

- [ ] **Step 4: Lockfile neu erzeugen**

Run: `npm install`
Expected: läuft fehlerfrei durch (Dev-Node 26 erfüllt `26.x`); `package-lock.json` wird aktualisiert, `cross-env` ergänzt, `puppeteer` nach devDependencies verschoben.

> Klarstellung: `npm install` auf dem Dev-Rechner installiert devDependencies → **puppeteer lädt hier weiterhin Chromium** (~150 MB). Der Gewinn ist **server-seitig**: dort wird `npm ci --omit=dev` ausgeführt (Task 7 README), das devDependencies und damit den Chromium-Download überspringt.

- [ ] **Step 5: Tests über das npm-Script verifizieren**

Run: `npm test`
Expected: alle Suiten grün (Backend + Dashboard), jetzt via `cross-env` gestartet.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .nvmrc .npmrc
git commit -m "chore(deps): puppeteer to devDeps, add cross-env, pin node engines

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Launcher `deploy/windows/start.cmd`

**Files:**
- Create: `deploy/windows/start.cmd`

**Interfaces:**
- Consumes: `backend/server.js` (gestartet mit `node`)
- Produces: gesetzte Env-Vars `DB_PATH`/`PORT`/`HOST`; Log unter `%LOGDIR%\app.log`. Wird in Task 6 als Task-Action referenziert.

> Nicht auf macOS ausführbar — Abnahme erfolgt manuell auf der Windows-Box (Task 5 liefert das reviewbare Artefakt).

- [ ] **Step 1: `deploy/windows/start.cmd` anlegen**

```bat
@echo off
REM Launcher fuer den testo-smart-abruf-Server, gestartet von der Windows-Aufgabenplanung
REM als NT AUTHORITY\NetworkService. Setzt die Prod-Env explizit (CWD- und .env-unabhaengig),
REM erzwingt UTF-8-Logs und startet den Node-Server im Vordergrund, damit der Task
REM als "wird ausgefuehrt" gilt (kein START, kein Self-Loop).

chcp 65001 >NUL

REM --- Konfiguration (von der IT anzupassen) ---
set "DB_PATH=C:\ProgramData\TestoSmartAbruf\klima.db"
set "PORT=3000"
set "HOST=127.0.0.1"
set "LOGDIR=C:\ProgramData\TestoSmartAbruf\logs"

REM App-Root = zwei Ebenen ueber diesem Script (deploy\windows\)
cd /d "%~dp0..\.."

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

node backend\server.js >> "%LOGDIR%\app.log" 2>&1
```

- [ ] **Step 2: Review-Check (statt Ausführung)**

Prüfen (Augenschein): (a) alle Pfade gequotet, (b) `cd /d "%~dp0..\.."`, (c) `chcp 65001`, (d) `HOST=127.0.0.1` als sicherer Default, (e) Log-Redirect `>> … 2>&1`. Optional, falls vorhanden: in einer Windows-Umgebung `cmd /c deploy\windows\start.cmd` testen und `Strg+C`.

- [ ] **Step 3: Commit**

```bash
git add deploy/windows/start.cmd
git commit -m "feat(deploy): add Windows start.cmd launcher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Task-Registrierung `install-task.ps1` + `uninstall-task.ps1`

**Files:**
- Create: `deploy/windows/install-task.ps1`
- Create: `deploy/windows/uninstall-task.ps1`

**Interfaces:**
- Consumes: `deploy/windows/start.cmd` (als Task-Action)
- Produces: geplanter Task `TestoSmartAbruf` (BootTrigger, NetworkService); ACLs auf Daten-/Code-Ordner.

> Nicht auf macOS ausführbar. Falls `pwsh` auf dem Dev-Rechner vorhanden ist: Syntax-Parse-Check (Step 3). Sonst Review + manuelle Abnahme auf der Windows-Box.

- [ ] **Step 1: `deploy/windows/install-task.ps1` anlegen**

```powershell
#Requires -RunAsAdministrator
<#
  Registriert den testo-smart-abruf-Server als geplanten Task (BootTrigger),
  laufend als NT AUTHORITY\NetworkService. Legt den Datenordner an und setzt ACLs.
  Idempotent: ein vorhandener gleichnamiger Task wird zuvor entfernt.
  Dry-Run: -WhatIf zeigt die Aenderungen, ohne sie anzuwenden.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$AppRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$DataDir  = 'C:\ProgramData\TestoSmartAbruf',
  [string]$TaskName = 'TestoSmartAbruf'
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $DataDir 'logs'

# 1) Datenordner + Logs anlegen
if ($PSCmdlet.ShouldProcess($DataDir, 'Datenordner anlegen')) {
  New-Item -ItemType Directory -Force -Path $DataDir, $logDir | Out-Null
}

# 2) ACLs: NetworkService = Modify auf Datenordner, ReadExecute auf Code-Ordner.
#    SID *S-1-5-20 statt Name 'NT AUTHORITY\NetworkService' — locale-unabhaengig
#    (auf deutschem Windows heisst das Konto 'NETZWERKDIENST', der Name wuerde scheitern).
if ($PSCmdlet.ShouldProcess($DataDir, 'ACL: NetworkService Modify')) {
  icacls $DataDir /grant '*S-1-5-20:(OI)(CI)M' /T | Out-Null
}
if ($PSCmdlet.ShouldProcess($AppRoot, 'ACL: NetworkService ReadExecute')) {
  icacls $AppRoot  /grant '*S-1-5-20:(OI)(CI)RX' /T | Out-Null
}

# 3) Task-Bestandteile
$action    = New-ScheduledTaskAction -Execute (Join-Path $AppRoot 'deploy\windows\start.cmd')
$trigger   = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\NetworkService' -LogonType ServiceAccount
# -ExecutionTimeLimit ([TimeSpan]::Zero) == PT0S == "kein Limit" (NICHT "sofort beenden").
# Kein -Hidden: eine sichtbare, auditierbare Aufgabe ist EDR-konformer.
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$settings.RunOnlyIfNetworkAvailable = $false
$settings.RunOnlyIfIdle = $false

# 4) Idempotent registrieren
if ($PSCmdlet.ShouldProcess($TaskName, 'Scheduled Task registrieren')) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings | Out-Null
  Write-Host "Task '$TaskName' registriert. Manueller Start: schtasks /Run /TN $TaskName"
}
```

- [ ] **Step 2: `deploy/windows/uninstall-task.ps1` anlegen**

```powershell
#Requires -RunAsAdministrator
[CmdletBinding(SupportsShouldProcess)]
param([string]$TaskName = 'TestoSmartAbruf')
$ErrorActionPreference = 'Stop'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Scheduled Task entfernen')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Task '$TaskName' entfernt."
  }
} else {
  Write-Host "Task '$TaskName' existiert nicht."
}
```

- [ ] **Step 3: Syntax-Check (falls `pwsh` vorhanden) oder Review**

Falls `pwsh` installiert ist:

Run:
```bash
pwsh -NoProfile -Command "\$f='deploy/windows/install-task.ps1'; \$t=\$null; \$e=\$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path \$f), [ref]\$t, [ref]\$e); if (\$e) { \$e; exit 1 } else { 'OK' }"
```
Expected: `OK` (keine Parser-Fehler). Gleiches für `uninstall-task.ps1`.

Falls kein `pwsh`: Review gegen Spec §6 (ExecutionTimeLimit=PT0S, RestartCount, NetworkService ServiceAccount, RunOnlyIf*=$false, BootTrigger.Delay=PT30S, Hidden, icacls). Echte Funktion = manuelle Abnahme auf der Windows-Box.

- [ ] **Step 4: Commit**

```bash
git add deploy/windows/install-task.ps1 deploy/windows/uninstall-task.ps1
git commit -m "feat(deploy): add scheduled-task install/uninstall scripts (NetworkService)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `deploy/windows/env.example` + `README.md`

**Files:**
- Create: `deploy/windows/env.example`
- Create: `deploy/windows/README.md`

**Interfaces:**
- Consumes: alle vorigen Deploy-Artefakte
- Produces: IT-Setup-Anleitung; keine Code-Schnittstellen.

- [ ] **Step 1: `deploy/windows/env.example` anlegen**

```ini
# Optionale .env (Projektwurzel). Im Windows-Dienstbetrieb setzt start.cmd
# DB_PATH/PORT/HOST bereits explizit — diese Datei ist dann nur fuer das
# einmalige Seeding des API-Keys relevant (alternativ im Dashboard eingeben).
#
# DB_PATH=C:\ProgramData\TestoSmartAbruf\klima.db
# PORT=3000
# HOST=127.0.0.1
# TESTO_API_KEY=
# TESTO_API_REGION=eu
```

- [ ] **Step 2: `deploy/windows/README.md` anlegen**

````markdown
# Windows-Inbetriebnahme (Hintergrund-Dienst)

Betrieb der App als login-unabhaengiger Hintergrund-Task auf Windows 11 x64,
gestartet bei jedem Systemstart, laufend als `NT AUTHORITY\NetworkService`.

## Voraussetzungen

- **Node.js 24 LTS (x64)** installiert (`node -v` → `v24.*`). Erlaubt sind 22/24/26;
  **Node 23 nicht** (kein win32-x64-Prebuild fuer better-sqlite3).
- Admin-Rechte fuer die einmalige Einrichtung.
- Netzwerk: ausgehend zu `data-api.<region>.smartconnect.testo.com` (HTTPS).
  Beim `npm ci`: Zugriff auf die npm-Registry **und** auf `github.com`
  (`objects.githubusercontent.com`) — von dort laedt `prebuild-install` das
  native better-sqlite3-Binary. Hinter Proxy: `npm config set proxy <url>` /
  `https-proxy` setzen; ggf. beide Hosts in der Allowlist freigeben.

## Installation

1. App-Ordner auf eine **lokale** Platte kopieren (kein Netzlaufwerk/UNC — WAL),
   z. B. `C:\Apps\TestoSmartAbruf`.
2. Abhaengigkeiten **auf dieser Maschine** installieren (node_modules NIE von
   macOS/Linux kopieren — falsches ABI):
   ```powershell
   cd C:\Apps\TestoSmartAbruf
   npm ci --omit=dev
   ```
3. Bei Bedarf `deploy\windows\start.cmd` anpassen (`PORT`, `DB_PATH`, `HOST`).
   Default `HOST=127.0.0.1` = nur lokal erreichbar.
4. Task registrieren (Admin-PowerShell), optional vorab mit `-WhatIf`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 -WhatIf
   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
   ```
5. Starten und pruefen:
   ```powershell
   schtasks /Run /TN TestoSmartAbruf
   start http://localhost:3000
   ```
6. API-Key im Dashboard unter Einstellungen hinterlegen (wird in der DB
   gespeichert) — oder vor dem ersten Start via `.env`/`TESTO_API_KEY` seeden.

## Verifikation

- `http://localhost:3000` zeigt das Dashboard.
- `C:\ProgramData\TestoSmartAbruf\klima.db` (+ `-wal`/`-shm`) existiert; `logs\app.log` waechst.
- **Reboot ohne Login** → Server wieder erreichbar.
- Liveness/Health: `GET http://localhost:3000/api/system/status` (Scheduler/DB/Storage).
  In der Aufgabenplanung zusaetzlich Spalte "Letztes Ausfuehrungsergebnis".
- Crash-Restart: `taskkill /IM node.exe /F` → Task startet Node binnen ~1 Min neu.
- Task immer ueber `Stop-ScheduledTask -TaskName TestoSmartAbruf` stoppen — das
  beendet den Prozessbaum (cmd + node). Danach pruefen: `tasklist | findstr node`
  zeigt **kein** verwaistes `node.exe`; sonst haelt es Port 3000 und der naechste
  Start scheitert mit `EADDRINUSE` → ggf. `taskkill /IM node.exe /F`.

## LAN-Zugriff (optional, IT-Freigabe)

Standard ist nur-lokal. Fuer Zugriff von Tablets/anderen PCs:
1. In `start.cmd` `HOST=0.0.0.0` setzen.
2. Eingehende Firewall-Regel (Admin):
   ```powershell
   New-NetFirewallRule -DisplayName "TestoSmartAbruf 3000" -Direction Inbound `
     -Action Allow -Protocol TCP -LocalPort 3000
   ```

## Update der App

Nach jedem App-Update **VERSION**, README-Badge und die `?v=`-Cache-Buster im
`Klima Dashboard.html` synchron halten (gleicher SemVer). Der Server sendet
keine Cache-Header → der `?v=`-Bump ist der einzige Invalidierungs-Hebel; im
Browser des Bedieners zusaetzlich einmal hart neu laden (Strg+F5).

## Troubleshooting

- **`EADDRINUSE` im Log:** Port belegt → in `start.cmd` `PORT` aendern oder den
  blockierenden Prozess beenden.
- **`npm ci` schlaegt fehl (Compiler/`node-gyp`):** falsche Node-Version
  (kein Prebuild) oder `github.com` nicht erreichbar. Node 24 x64 verwenden,
  Proxy/Allowlist pruefen. Erfolgskontrolle: die better-sqlite3-Ausgabe muss
  `prebuild-install ... (download)`/`prebuilt binary` zeigen — taucht stattdessen
  `node-gyp rebuild` auf, fehlt der Prebuild (Guardrail-Bruch: Compiler laeuft).
- **Port-Binding & NetworkService:** der Server bindet Port 3000 ueber Winsock
  (libuv), NICHT ueber HTTP.sys → es ist **kein** `netsh http add urlacl` noetig,
  und NetworkService darf den High-Port ohne Elevation binden.
- **`EPERM`/gesperrte `.node` bei `npm ci`:** AV scannt frisch entpackte Datei →
  `npm ci` wiederholen oder AV-Ausnahme fuer den App-Ordner setzen.
- **AV/EDR & DB:** AV-Ausnahme fuer `C:\ProgramData\TestoSmartAbruf\` empfohlen
  (haeufige `-wal`/`-shm`-Schreibzugriffe).

## Alternativen (nicht Standard)

- **SYSTEM-Konto** statt NetworkService: einfacher (keine ACLs), aber ein
  elevated Netzwerk-Listener — mit der IT/EDR abklaeren. In `install-task.ps1`
  `-UserId 'NT AUTHORITY\NetworkService'` durch `'NT AUTHORITY\SYSTEM'` ersetzen.
- **Echter Dienst (WinSW):** falls ein Eintrag in `services.msc` gewuenscht ist
  — bekannte, signierte Wrapper-Exe + XML; nicht in diesem Repo enthalten.
````

- [ ] **Step 3: Commit**

```bash
git add deploy/windows/env.example deploy/windows/README.md
git commit -m "docs(deploy): add Windows setup README and env.example

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Version-Bump 0.9.4 → 0.10.0 (+ latenten package.json-Skew konsolidieren)

**Files:**
- Modify: `VERSION`
- Modify: `README.md` (Badge, Zeile 3)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (alle `?v=…`)
- Modify: `package.json` (`version`)

**Interfaces:** keine — reine Release-Synchronisation.

- [ ] **Step 1: Ist-Stand der Versionsstellen prüfen**

Run:
```bash
cat VERSION; grep -n "version-.*-blue" README.md; grep -c "?v=0.9.4" "Smart Meter Dashboard/Klima Dashboard.html"; node -p "require('./package.json').version"
```
Erwartung (zur Bestätigung des Skews): `VERSION`=`0.9.4`, Badge `0.9.4`, **zehn** `?v=0.9.4`-Treffer (HTML-Zeilen **1265–1274**, inkl. `app.jsx` auf 1274), `package.json`=`0.9.3`. (Die Kommentarzeile 1263 `<!-- ?v=… -->` enthält keine Versionsnummer und wird vom ziffern-verankerten `sed` korrekt ignoriert.)

- [ ] **Step 2: Alle Stellen auf `0.10.0` setzen**

- `VERSION` → Inhalt `0.10.0`
- `README.md:3` Badge → `...badge/version-0.10.0-blue.svg...`
- `package.json` `"version": "0.10.0"`
- HTML-Cache-Buster (alle Vorkommen):
  ```bash
  sed -i '' 's/?v=0\.9\.4/?v=0.10.0/g' "Smart Meter Dashboard/Klima Dashboard.html"
  ```
  (Linux/CI ohne BSD-sed: `sed -i 's/?v=0\.9\.4/?v=0.10.0/g' "Smart Meter Dashboard/Klima Dashboard.html"`)

- [ ] **Step 3: Konsistenz verifizieren**

Run:
```bash
echo "VERSION=$(cat VERSION)"; grep -o "version-[0-9.]*-blue" README.md; node -p "require('./package.json').version"; grep -c "?v=0.10.0" "Smart Meter Dashboard/Klima Dashboard.html"; grep -c "?v=0.9.4" "Smart Meter Dashboard/Klima Dashboard.html"
```
Expected: überall `0.10.0`; **zehn** `?v=0.10.0`-Treffer; **null** verbliebene `?v=0.9.4`.

- [ ] **Step 4: Volle Test-Suite**

Run: `npm test`
Expected: alle Suiten grün.

- [ ] **Step 5: Commit + lokaler Tag (kein Push — kein Remote)**

Erst Konsistenz-Guard (Versioning-Workflow): sicherstellen, dass es den Tag noch nicht gibt.

```bash
test -z "$(git tag -l v0.10.0)" && echo "Tag frei" || { echo "v0.10.0 existiert bereits — abbrechen"; exit 1; }
git add VERSION README.md package.json "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.10.0

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag -a v0.10.0 -m "v0.10.0"
```

- [ ] **Step 6: Abschluss-Hinweis**

Die Windows-spezifischen Artefakte (Tasks 5–7) sind auf macOS nicht ausführbar. Vor „fertig": **manuelle Abnahme auf einer Windows-11-x64-Box** gemäß Spec §9 (Akzeptanzkriterien 1–6) durchführen und das Ergebnis berichten — keine ungetesteten Erfolgsbehauptungen.

---

## Self-Review (vom Plan-Autor durchgeführt)

**Spec-Abdeckung:** 2a→T3, 2b→T1, 2c/2d/2e/2f→T4, 2h→T2; start.cmd (chcp/env/quoting)→T5; install/uninstall + Task-Settings (ExecutionTimeLimit/RestartCount/NetworkService/RunOnlyIf*/Delay/ACL)→T6; env.example/README (Proxy+github.com, Firewall, Update-/`?v=`-Checklist, Health-Probe, AV-Ausnahme, ABI-Hinweis, SYSTEM/WinSW-Alternativen)→T7; Version-Bump→T8. Abgedeckt: E1–E14, §9-Verifikation. Bewusst nicht implementiert (YAGNI, Spec §10): busy_timeout, Self-Loop, Log-Rotation, WinSW/SYSTEM (nur dokumentiert), MSI, HTTPS.

**Placeholder-Scan:** keine TBD/TODO; jeder Code-Schritt enthält vollständigen Code; PS/cmd vollständig.

**Typ-/Namens-Konsistenz:** `handleListenError(err, deps)` in T2 definiert und in T3-server.js-Kopf require-konsistent verdrahtet; `initDb/getDb/closeDb` durchgängig; `DB_PATH`/`PORT`/`HOST`/`LOGDIR` zwischen start.cmd (T5) und server.js/db.js identisch; TaskName `TestoSmartAbruf` in T6 install/uninstall identisch.

## Post-Grill-Korrekturen (durch adversariales Subagent-Review gefunden & behoben)

- **T2 (Blocker):** `server.test.js:6-10` importiert `server.js` und bindet beim Import Port 3001 → der `'error'`-Handler hängt jetzt **nur unter `NODE_ENV !== 'test'`**; Zwischen-Regressionsläufe nutzen `NODE_ENV=test node --test …`.
- **T3:** invasiver `.env`-mutierender Kindprozess-Test (Race unter parallelem `node --test`) ersetzt durch **race-freien Statik-Assertions-Test** (`dotenv-path.test.js`).
- **T4 (Blocker):** `package.json`-Version korrekt = **`0.9.3`** (nicht 0.9.4); Klarstellung, dass `puppeteer`→devDeps den Chromium-Download nur **server-seitig** (`npm ci --omit=dev`) spart.
- **T8 (Blocker):** `?v=` sind **10** Treffer (Zeilen 1265–**1274**, `app.jsx`), nicht 9; Tag-Existenz-Guard ergänzt.
- **T6:** icacls auf SID **`*S-1-5-20`** (deutsches Windows: „NETZWERKDIENST"); **`-Hidden` entfernt** (auditierbarer = EDR-konformer); urlacl-Klarstellung im README.
- **Spec-Fix:** `cd /d "%~dp0..\.."` (vorher widersprüchlich `%~dp0`); engines-Begründung „LTS-mit-Prebuild" statt „alle prebuilt" (Node 25 bewusst raus); chcp-Begründung präzisiert.
- **Zurückgewiesen (mit Beleg):** Grill-Behauptung „`.env`/`.env.example` fehlen" — beide existieren (`ls -a`); „kein `.gitignore`-Schutz" — `.gitignore:4-10` deckt `klima.db`/`-wal`/`-shm`/`-journal`/`.env` ab.
