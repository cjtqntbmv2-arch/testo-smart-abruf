# Windows-Schnellinstallation (`setup.ps1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein `deploy/windows/setup.ps1` (+ doppelklickbarer `setup.cmd`-Launcher) bündelt Node-Preflight, Stoppen eines laufenden Dienstes, `npm ci`, Pfad-/Konsistenz-Checks, den Aufruf von `install-task.ps1` und einen `/api/system/status`-Smoke-Check zu **einem** Admin-Aufruf.

**Architecture:** PowerShell-Orchestrator über den bestehenden Bausteinen. `setup.cmd` elevatet sich selbst (UAC) und ruft `setup.ps1`. `setup.ps1` läuft fail-fast in fünf Phasen (Preflight → laufenden Dienst stoppen → Dependencies → `install-task.ps1` → Start & Smoke-Check), ist re-run-sicher und kennt einen `-WhatIf`-Trockenlauf. Bestehende Skripte (`install-task.ps1`, `uninstall-task.ps1`, `start.cmd`) bleiben unverändert.

**Tech Stack:** Windows PowerShell 5.1 / PowerShell 7, cmd.exe-Launcher, Node.js 24 LTS x64, npm, better-sqlite3 (nativer Prebuild), Windows-Aufgabenplanung.

**Spec:** [docs/superpowers/specs/2026-06-23-windows-installer-design.md](../specs/2026-06-23-windows-installer-design.md)

## Global Constraints

- **Keine Build-Tools / kein neues Binary auf dem Ziel** (EDR „nichts Überraschendes"); Klartext-Skripte.
- **Pfad-Bildung nur** `Join-Path` / `$PSScriptRoot`; keine hartkodierten Unix-Pfade, kein `/`.
- **Node x64, Major ∈ {22, 24, 26}**; 23/25 verboten (kein better-sqlite3-win32-x64-Prebuild).
- **Install-Pfad** ohne Leerzeichen (deckt `C:\Program Files\…` ab), lokale Platte (kein UNC/Netzlaufwerk — WAL).
- **`install-task.ps1` / `uninstall-task.ps1` / `start.cmd` bleiben unverändert.**
- **`PORT`/`HOST`/`DB_PATH`** bleiben Single Source of Truth in `start.cmd` — keine `setup.ps1`-Parameter dafür.
- **Status-API** ([server.js:405](../../../backend/server.js)): Feld `appVersion` (nicht `version`); Liveness via `scheduler.lastSyncStatus` + `storage.status`; Key-Hinweis via `api.apiKeyConfigured`. `database.status` ist hartkodiert `ok` → **nicht** als Health ausgeben.
- **Smoke-Check** trifft `http://127.0.0.1:<port>` explizit (nicht `localhost`, sonst evtl. IPv6-`::1`-Connection-Refuse).
- **`#Requires -RunAsAdministrator`** auf `setup.ps1` → auch `-WhatIf` braucht eine Admin-Shell (in README dokumentieren).
- **Sprache:** deutsche Konsolenausgaben.
- **Test-Realität:** Entwicklung auf macOS, `pwsh` dort nicht installiert. **Kein** rotgrüner Laufzeit-Test; Verifikation = statisches Review + optionaler `pwsh`-Syntaxcheck (falls vorhanden) + `-WhatIf`-Trockenlauf und §9-Abnahme **auf der Windows-Box**. Bewusst so (PowerShell-Scheduled-Task-Verhalten ist von macOS aus nicht ausführbar).

---

### Task 1: `setup.cmd` — self-elevating Launcher (nur interaktiv)

**Files:**
- Create: `deploy/windows/setup.cmd`

**Interfaces:**
- Consumes: nichts.
- Produces: ruft `setup.ps1` im selben Verzeichnis mit durchgereichten einfachen Flags (`-WhatIf`, `-SkipNpm`). Keine Logik außer Elevation. Interaktiv-only (endet mit `pause`, propagiert keinen Exit-Code).

- [ ] **Step 1: Datei `deploy/windows/setup.cmd` anlegen**

```batch
@echo off
REM Self-elevating Launcher fuer setup.ps1 — NUR fuer interaktiven Doppelklick/Aufruf.
REM Fuer Automatisierung stattdessen setup.ps1 direkt via -File aufrufen und %ERRORLEVEL%/$LASTEXITCODE pruefen.
REM Unterstuetzt einfache Flags (-WhatIf, -SkipNpm); kein komplexes Quoting.
setlocal

net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Administrator-Rechte werden angefordert...
  if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)

REM Elevated: CWD ist nach RunAs C:\Windows\system32 -> ins Skriptverzeichnis wechseln.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
```

- [ ] **Step 2: Statisches Review gegen die Launcher-Fallen**

Augenschein-Checkliste:
- `net session` = Admin-Check; bei nicht-elevated erfolgt der `RunAs`-Relaunch von `%~f0`. **Leeres `%*`** wird separat behandelt (kein `-ArgumentList ''`, das auf manchen PS-Versionen wirft).
- Die elevierte Instanz besteht den `net session`-Check und fällt in den zweiten Block.
- `cd /d "%~dp0"` korrigiert das `system32`-CWD nach Elevation; `setup.ps1` nutzt zwar `$PSScriptRoot`, aber so ist auch relatives Verhalten sauber.
- `"%~dp0setup.ps1"` nutzt das Skriptverzeichnis mit endendem Backslash.
- `pause` hält das Fenster nach Doppelklick offen. Der Automatisierungspfad nutzt `setup.ps1` direkt (siehe Kopfkommentar).

- [ ] **Step 3: Commit**

```bash
git add deploy/windows/setup.cmd
git commit -m "feat(deploy): self-elevating setup.cmd launcher (interactive)"
```

---

### Task 2: `setup.ps1` — Orchestrator (5 Phasen)

**Files:**
- Create: `deploy/windows/setup.ps1`
- Reference (unverändert): `deploy/windows/install-task.ps1`, `deploy/windows/start.cmd`

**Interfaces:**
- Consumes: `install-task.ps1` mit `-DataDir`/`-TaskName`/`-WhatIf` (existieren dort, `SupportsShouldProcess`; `install-task.ps1` wirft bei Fehler — kein `exit`). `start.cmd`-Zeilen `set "DB_PATH=…"` / `set "PORT=…"` (gelesen). `GET /api/system/status` → `appVersion`, `scheduler.lastSyncStatus`, `storage.status`, `api.apiKeyConfigured`.
- Produces: ausführbares Setup mit Parametern `-DataDir` (Default `C:\ProgramData\TestoSmartAbruf`), `-TaskName` (Default `TestoSmartAbruf`), `-SkipNpm` (switch), `-WhatIf` (switch). Exit 0 bei Erfolg, Exit 1 bei jedem Abbruch (`Fail`).

> Bauweise: Die Datei wird in einem Rutsch geschrieben. Steps 1–6 sind die aufeinanderfolgenden Blöcke **derselben** Datei, in Reihenfolge eingefügt. Erst nach Step 6 ist die Datei vollständig und prüfbar.

- [ ] **Step 1: Kopf + Parameter + Helper + Transcript** (`deploy/windows/setup.ps1`)

```powershell
#Requires -RunAsAdministrator
<#
  Windows-Schnellinstallation (Orchestrator).
  Preflight -> (laufenden Dienst stoppen) -> npm ci --omit=dev -> install-task.ps1 -> Start -> Smoke-Check.
  Ruft die bestehenden Bausteine; ersetzt install-task.ps1 NICHT.
  Re-run-sicher (zugleich Update-Pfad nach git pull). Trockenlauf via -WhatIf (ebenfalls Admin-Shell noetig).
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$DataDir  = 'C:\ProgramData\TestoSmartAbruf',
  [string]$TaskName = 'TestoSmartAbruf',
  [switch]$SkipNpm
)

$ErrorActionPreference = 'Stop'
$AppRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$startCmd = Join-Path $AppRoot 'deploy\windows\start.cmd'

function Fail($msg) {
  Write-Host "FEHLER: $msg" -ForegroundColor Red
  if (-not $WhatIfPreference) { try { Stop-Transcript | Out-Null } catch {} }
  exit 1
}
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# Setup-Eigenlog (nur ausserhalb -WhatIf; best effort, scheitert nie hart)
if (-not $WhatIfPreference) {
  try {
    $logDir = Join-Path $DataDir 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    Start-Transcript -Path (Join-Path $logDir 'setup.log') -Append | Out-Null
  } catch {}
}
```

- [ ] **Step 2: Phase 1 — Preflight (nur prüfen)** ans Dateiende anfügen

```powershell
# ---------- Phase 1/5: Preflight (nur pruefen) ----------
Step 'Phase 1/5: Preflight-Pruefungen'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js nicht gefunden. Node 24 LTS (x64) installieren:`n  winget install OpenJS.NodeJS.LTS`n  oder https://nodejs.org/en/download (Windows x64 .msi)"
}
$nodeVer = (& node -v).Trim()
if ($nodeVer -notmatch '^v(\d+)\.') { Fail "Node-Version nicht erkennbar ('$nodeVer'). Node 24 LTS x64 installieren." }
$major = [int]$Matches[1]
if ($major -notin 22,24,26) {
  Fail "Node-Version $nodeVer nicht unterstuetzt (erlaubt 22/24/26 — NICHT 23/25, kein better-sqlite3-Prebuild). Node 24 LTS x64 installieren."
}
$arch = (& node -p 'process.arch').Trim()
if ($arch -ne 'x64') { Fail "Node-Architektur '$arch' — benoetigt x64 (better-sqlite3-Prebuild)." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm nicht gefunden (gehoert zu Node.js).' }
Write-Host "  Node $nodeVer ($arch), npm OK"

if ($AppRoot -match '\s') { Fail "Installationspfad enthaelt Leerzeichen: '$AppRoot'. Nach z.B. C:\Apps\TestoSmartAbruf legen (Task-Action scheitert; 'C:\Program Files\...' ist deshalb ebenfalls ungeeignet)." }
if ($AppRoot.StartsWith('\\')) { Fail "UNC-Pfad: '$AppRoot'. SQLite-WAL braucht lokale Platte." }
$drive = Split-Path -Qualifier $AppRoot
$vol = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'" -ErrorAction SilentlyContinue
if ($vol -and $vol.DriveType -eq 4) { Fail "Netzlaufwerk ($drive): SQLite-WAL braucht lokale Platte." }
elseif (-not $vol) { Write-Host "  Hinweis: Laufwerkstyp fuer $drive nicht ermittelbar — bitte selbst sicherstellen: lokale Platte (kein Netz/subst)." -ForegroundColor Yellow }
Write-Host "  Pfad OK: $AppRoot"

if (Test-Path $startCmd) {
  $m = Select-String -Path $startCmd -Pattern 'set\s+"DB_PATH=([^"]+)"'
  if ($m) {
    $dbDir = Split-Path -Parent $m.Matches[0].Groups[1].Value
    if ($dbDir -ne $DataDir) { Write-Host "  WARNUNG: start.cmd DB_PATH-Ordner ('$dbDir') != -DataDir ('$DataDir') — angleichen." -ForegroundColor Yellow }
    else { Write-Host "  Konsistenz OK (DataDir == start.cmd DB_PATH-Ordner)" }
  }
}
```

- [ ] **Step 3: Phase 2 — laufenden Dienst stoppen** anfügen

```powershell
# ---------- Phase 2/5: Laufenden Dienst stoppen (Update-Pfad) ----------
Step 'Phase 2/5: Laufenden Dienst stoppen (falls vorhanden)'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop-ScheduledTask (laufende Instanz beenden)')) {
    Stop-ScheduledTask -TaskName $TaskName | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 1
      if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { break }
    }
    Start-Sleep -Seconds 2   # Grace fuer Datei-/Port-Freigabe (WAL, Port)
    Write-Host '  Dienst gestoppt.'
  }
} else {
  Write-Host '  Kein laufender Dienst (Erstinstallation oder bereits gestoppt).'
}
```

- [ ] **Step 4: Phase 3 — Dependencies + Prebuild-Verifikation** anfügen

```powershell
# ---------- Phase 3/5: Dependencies ----------
Step 'Phase 3/5: Dependencies (npm ci --omit=dev)'
if (-not $SkipNpm) {
  if ($PSCmdlet.ShouldProcess($AppRoot, 'npm ci --omit=dev')) {
    Push-Location $AppRoot
    try {
      & npm ci --omit=dev
      if ($LASTEXITCODE -ne 0) { throw "npm ci exit $LASTEXITCODE" }
    } catch {
      Pop-Location
      Fail "npm ci fehlgeschlagen ($($_.Exception.Message)). Ursachen: falsche Node-Version (kein Prebuild); github.com/objects.githubusercontent.com nicht erreichbar (Proxy/Allowlist); oder Datei-Lock durch noch laufenden node.exe (Stop-ScheduledTask -TaskName $TaskName; taskkill /IM node.exe /F)."
    }
    Pop-Location
  }
} else {
  Write-Host '  npm ci uebersprungen (-SkipNpm)'
}

# Prebuild-Verifikation: IMMER (auch unter -SkipNpm), aber nicht unter -WhatIf
if (-not $WhatIfPreference) {
  $nodeFile = Join-Path $AppRoot 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
  if (-not (Test-Path $nodeFile)) { Fail "better-sqlite3-Prebuild fehlt ($nodeFile). Falsche Node-Version oder github.com geblockt (node-gyp-Build statt Download). node_modules NIE von macOS/Linux kopieren." }
  Push-Location $AppRoot
  $loadOk = $true
  try { & node -e "require('better-sqlite3')"; if ($LASTEXITCODE -ne 0) { $loadOk = $false } } catch { $loadOk = $false }
  Pop-Location
  if (-not $loadOk) { Fail 'better-sqlite3 laedt nicht (ABI-Mismatch?). Auf DIESER Maschine neu installieren (node_modules nie kopieren).' }
  Write-Host '  better-sqlite3-Prebuild OK'
}
```

- [ ] **Step 5: Phase 4 — `install-task.ps1` aufrufen** anfügen

```powershell
# ---------- Phase 4/5: Dienst registrieren ----------
Step 'Phase 4/5: Dienst registrieren (install-task.ps1)'
$installScript = Join-Path $PSScriptRoot 'install-task.ps1'
$installArgs = @{ DataDir = $DataDir; TaskName = $TaskName }
if ($WhatIfPreference) { $installArgs['WhatIf'] = $true }
try { & $installScript @installArgs } catch { Fail "install-task.ps1 fehlgeschlagen: $($_.Exception.Message)" }
```

- [ ] **Step 6: Phase 5 — Start + Smoke-Check** anfügen

```powershell
# ---------- Phase 5/5: Start & Smoke-Check ----------
Step 'Phase 5/5: Start & Smoke-Check'
if ($WhatIfPreference) { Write-Host '  -WhatIf: Start & Smoke-Check uebersprungen.'; return }

$port = 3000
if (Test-Path $startCmd) {
  $pm = Select-String -Path $startCmd -Pattern 'set\s+"PORT=(\d+)"'
  if ($pm) { $port = [int]$pm.Matches[0].Groups[1].Value }
}

Start-ScheduledTask -TaskName $TaskName

$statusUrl = "http://127.0.0.1:$port/api/system/status"
$resp = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try { $resp = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 3 -ErrorAction Stop; break } catch {}
}

if ($resp) {
  Write-Host "`n  Server erreichbar." -ForegroundColor Green
  Write-Host "  Version  : $($resp.appVersion)"
  Write-Host "  Scheduler: $($resp.scheduler.lastSyncStatus)   Storage: $($resp.storage.status)"
  if ($resp.api.apiKeyConfigured) { Write-Host "  API-Key  : konfiguriert" }
  else { Write-Host "  API-Key  : NOCH NICHT konfiguriert -> im Dashboard unter Einstellungen eintragen" -ForegroundColor Yellow }
  Write-Host "  Dashboard: http://localhost:$port"
  Write-Host "  DB-Datei : $DataDir\klima.db    Log: $DataDir\logs\app.log"
  try { Stop-Transcript | Out-Null } catch {}
} else {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "  Server nach ~60s nicht erreichbar (LastTaskResult: $($info.LastTaskResult)). Log pruefen: $DataDir\logs\app.log" -ForegroundColor Yellow
  Write-Host "  Haeufig: verwaister node.exe belegt Port $port -> Stop-ScheduledTask -TaskName $TaskName; taskkill /IM node.exe /F" -ForegroundColor Yellow
  Fail 'Smoke-Check fehlgeschlagen.'
}
```

- [ ] **Step 7: Optionaler Syntaxcheck (nur falls `pwsh` vorhanden)**

Auf der macOS-Dev-Box ist `pwsh` i. d. R. nicht installiert. Falls doch (`brew install --cask powershell`):

Run:
```bash
pwsh -NoProfile -Command "\$e=\$null; [System.Management.Automation.Language.Parser]::ParseFile('deploy/windows/setup.ps1',[ref]\$null,[ref]\$e); if(\$e){\$e; exit 1} else {'PARSE OK'}"
```
Expected: `PARSE OK`. Ist `pwsh` nicht vorhanden: Step überspringen, auf Step 8 + Windows-`-WhatIf` verlassen.

- [ ] **Step 8: Statisches Review gegen die Guardrails**

Augenschein-Checkliste (entspricht den Global Constraints):
- Alle Pfade via `Join-Path`/`$PSScriptRoot`; **kein** `/`, kein hartkodierter Unix-Pfad.
- Smoke-Check trifft `http://127.0.0.1:$port` und liest `$resp.appVersion`, `$resp.scheduler.lastSyncStatus`, `$resp.storage.status`, `$resp.api.apiKeyConfigured` (nicht `.version`, nicht `database.status`).
- `-WhatIf` verändert nichts: kein Transcript/Log-Dir, Phase 2 (Stop) und Phase 3 (`npm ci`) in `ShouldProcess` gekapselt, Phase 4 reicht `-WhatIf` an `install-task.ps1` durch, Phase 5 kehrt früh zurück.
- Phase 2 stoppt einen laufenden Task vor `npm ci` (Update-Pfad).
- Prebuild-Check läuft auch unter `-SkipNpm`.
- Node-Erkennung über `Get-Command`; Versions-Parse per Regex (kein crashender `[int]`-Cast).
- Jeder Abbruch geht über `Fail` (rote Meldung + `Stop-Transcript` + `exit 1`).

- [ ] **Step 9: Commit**

```bash
git add deploy/windows/setup.ps1
git commit -m "feat(deploy): setup.ps1 orchestrator (preflight, stop, npm ci, task install, smoke check)"
```

---

### Task 3: README — Abschnitt „Schnellinstallation" + Troubleshooting

**Files:**
- Modify: `deploy/windows/README.md`

**Interfaces:**
- Consumes: das Verhalten von `setup.cmd`/`setup.ps1` aus Task 1/2.
- Produces: Doku; keine Code-Abhängigkeit.

- [ ] **Step 1: Abschnitt „Schnellinstallation" einfügen** (nach „## Voraussetzungen", vor „## Installation")

```markdown
## Schnellinstallation (empfohlen)

`setup.ps1` bündelt die Schritte unten zu einem Aufruf: Node-Preflight, Stoppen
eines ggf. laufenden Dienstes, `npm ci --omit=dev` (inkl. Prebuild-Check),
Pfad-/Konsistenz-Prüfung, Aufruf von `install-task.ps1`, Task-Start und ein
`GET /api/system/status`-Smoke-Check. Re-run-sicher = zugleich Update-Pfad.

1. **Pflicht: Installationspfad OHNE Leerzeichen** (z. B. `C:\Apps\TestoSmartAbruf`),
   nicht unter `C:\Program Files` (enthält ein Leerzeichen), lokale Platte
   (kein Netzlaufwerk — WAL).
2. Code auf die Maschine bringen (`git clone`/kopieren — **node_modules NIE
   mitkopieren**, falsches ABI). Node 24 LTS (x64) muss installiert sein.
3. Setup ausführen — doppelklickbar **oder** aus einer **Administrator**-PowerShell
   (auch der Trockenlauf braucht Admin-Rechte), **aus dem Repo-Wurzelverzeichnis**:
   ```powershell
   .\deploy\windows\setup.cmd
   powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1 -WhatIf   # Trockenlauf
   powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1
   ```
4. Nach Erfolg: **API-Key im Dashboard** unter Einstellungen hinterlegen — der
   Dienst synct erst danach (der Smoke-Check weist darauf hin, falls noch keiner
   gesetzt ist).

**Update nach `git pull`:** `setup.ps1` erneut ausführen (stoppt zuerst den
laufenden Dienst, dann npm ci + Neuregistrierung). Wenn `package-lock.json`
unverändert ist, mit `-SkipNpm` schneller (der Prebuild-Check läuft trotzdem).

`setup.cmd` ist nur für den interaktiven Doppelklick gedacht. Für Automatisierung
`setup.ps1` direkt via `-File` aufrufen und `$LASTEXITCODE` prüfen.

Die manuelle Schritt-für-Schritt-Anleitung unten bleibt als Fallback/Transparenz.
```

- [ ] **Step 2: Troubleshooting-Punkte ergänzen** (im bestehenden Abschnitt „## Troubleshooting", an dessen Ende)

```markdown
- **SmartScreen / „Windows protected your PC" beim Doppelklick:** per Download
  (Browser/E-Mail) bezogene `.cmd`/`.ps1` tragen das Mark-of-the-Web. Entweder per
  `git clone` holen (kein MOTW) oder einmalig entsperren:
  `Get-ChildItem deploy\windows\*.ps1,deploy\windows\*.cmd | Unblock-File`.
- **`AllSigned` per GPO:** Ist die `ExecutionPolicy` auf MachinePolicy-Ebene auf
  `AllSigned` gesetzt, überschreibt das `-ExecutionPolicy Bypass` — unsignierte
  Skripte laufen dann nicht. Ohne Signatur mit der IT klären.
- **npm hinter Proxy:** `npm config set proxy <url>` / `https-proxy` setzen (oder
  in `.npmrc`), damit der better-sqlite3-Prebuild von `github.com` geladen wird.
- **Setup-Eigenlog:** `setup.ps1` schreibt zusätzlich nach
  `C:\ProgramData\TestoSmartAbruf\logs\setup.log` (auch wenn das Fenster zugeht).
```

- [ ] **Step 3: §9-Versionscheck korrigieren** (Feldname + Wert)

In §9 „Versionscheck" die Zeile
`- GET /api/system/status → Feld version lautet 0.12.0.`
ersetzen durch
`- GET /api/system/status → Feld appVersion lautet 0.13.0.`
und die nächste Zeile auf `?v=0.13.0` setzen:
`- Alle 12 <script src="…?v=…">-Tags … tragen ?v=0.13.0 …`

- [ ] **Step 4: Konsistenz-Review**

Prüfen: Befehle nennen exakt `setup.cmd`/`setup.ps1`; Pfadregel deckt sich mit Task 2 Phase 1; `-WhatIf`/`-SkipNpm` korrekt; §9 nennt jetzt `appVersion`/`0.13.0`/`?v=0.13.0`; keine widersprüchliche zweite Pfad-/Node-Aussage.

- [ ] **Step 5: Commit**

```bash
git add deploy/windows/README.md
git commit -m "docs(deploy): document setup.ps1 quick-install + fix §9 appVersion/0.13.0"
```

---

### Task 4: Release — Version-Bump 0.13.0 + Tag

**Files:**
- Modify: `VERSION`
- Modify: `README.md` (Badge `version-X.Y.Z`)
- Modify: `package.json` (`"version"`)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (alle 12 `?v=`-Cache-Buster)

**Interfaces:**
- Consumes: nichts.
- Produces: konsistente Version `0.13.0` über alle Orte + annotierter Tag `v0.13.0`.

> Dieses Repo hält **alle** Versionsorte im Gleichschritt (die §9-Akzeptanz prüft das). Auch ohne Frontend-Änderung müssen die 12 `?v=` mitgebumpt werden, sonst schlägt der §9-Versionscheck fehl.

- [ ] **Step 1: Aktuellen Stand verifizieren**

Run:
```bash
cat VERSION; grep -m1 '"version"' package.json; grep -oE 'version-[0-9.]+-blue' README.md; grep -oE '\?v=[0-9.]+' "Smart Meter Dashboard/Klima Dashboard.html" | sort -u; git tag -l 'v0.13.0'
```
Expected: überall `0.12.0`, ein einziges distinct `?v=0.12.0` (12 Vorkommen), und **kein** `v0.13.0`-Tag.

- [ ] **Step 2: `VERSION` setzen** — Inhalt auf:
```
0.13.0
```

- [ ] **Step 3: `package.json`** — `"version": "0.12.0",` → `"version": "0.13.0",`

- [ ] **Step 4: README-Badge** — in `README.md` `version-0.12.0-blue` → `version-0.13.0-blue`.

- [ ] **Step 5: Alle 12 `?v=` im HTML bumpen** (macOS BSD sed)

Run:
```bash
sed -i '' 's/?v=0\.12\.0/?v=0.13.0/g' "Smart Meter Dashboard/Klima Dashboard.html"
```

- [ ] **Step 6: Konsistenz verifizieren**

Run:
```bash
cat VERSION; grep -m1 '"version"' package.json; grep -oE 'version-[0-9.]+-blue' README.md; grep -c '?v=0.13.0' "Smart Meter Dashboard/Klima Dashboard.html"
```
Expected: `0.13.0`, `"version": "0.13.0",`, `version-0.13.0-blue`, und `12`.

- [ ] **Step 7: Gesamttests** (Regressionsschutz — Backend unberührt, aber Pflicht-Gate)

Run: `npm test`
Expected: alle Tests grün (kein neuer Test in diesem Plan; PowerShell ist nicht node-getestet).

- [ ] **Step 8: Commit + annotierter Tag (kein Push — lokales Repo)**

```bash
git add VERSION package.json README.md "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.13.0 (Windows setup.ps1 installer)"
git tag -a v0.13.0 -m "v0.13.0"
```

---

## Notes für die Abnahme (Definition of Done, nicht Teil der Tasks)

Der einzige verlässliche Funktionsnachweis ist die manuelle Abnahme auf Windows-11-x64:
1. `setup.ps1 -WhatIf` (Admin-Shell) → Preflight läuft, geplante Änderungen werden gezeigt, **nichts** verändert.
2. `setup.ps1` echt → Phasen 1–5 grün, Smoke-Check meldet `appVersion 0.13.0`, Dashboard erreichbar, API-Key-Hinweis korrekt.
3. **Re-Run** (Update-Pfad) → laufender Dienst wird gestoppt, kein `EADDRINUSE`, Server kommt wieder hoch.
4. Anschließend der vollständige **§9-Durchlauf** aus `deploy/windows/README.md` (Reboot ohne Login, CSV-Export, Monats-Backup).
