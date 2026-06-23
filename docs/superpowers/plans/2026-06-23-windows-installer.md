# Windows-Schnellinstallation (`setup.ps1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein `deploy/windows/setup.ps1` (+ doppelklickbarer `setup.cmd`-Launcher) bündelt Node-Preflight, `npm ci`, Pfad-/Konsistenz-Checks, den Aufruf von `install-task.ps1` und einen `/api/system/status`-Smoke-Check zu **einem** Admin-Aufruf.

**Architecture:** PowerShell-Orchestrator über den bestehenden Bausteinen. `setup.cmd` elevatet sich selbst (UAC) und ruft `setup.ps1`. `setup.ps1` läuft fail-fast in vier Phasen (Preflight → Dependencies → `install-task.ps1` → Start & Smoke-Check), ist re-run-sicher und kennt einen `-WhatIf`-Trockenlauf. Bestehende Skripte (`install-task.ps1`, `uninstall-task.ps1`, `start.cmd`) bleiben unverändert.

**Tech Stack:** Windows PowerShell 5.1 / PowerShell 7, cmd.exe-Launcher, Node.js 24 LTS x64, npm, better-sqlite3 (nativer Prebuild), Windows-Aufgabenplanung.

**Spec:** [docs/superpowers/specs/2026-06-23-windows-installer-design.md](../specs/2026-06-23-windows-installer-design.md)

## Global Constraints

- **Keine Build-Tools / kein neues Binary auf dem Ziel** (EDR „nichts Überraschendes"); Klartext-Skripte.
- **Pfad-Bildung nur** `Join-Path` / `$PSScriptRoot`; keine hartkodierten Unix-Pfade, kein `/`.
- **Node x64, Major ∈ {22, 24, 26}**; 23/25 verboten (kein better-sqlite3-win32-x64-Prebuild).
- **Install-Pfad** ohne Leerzeichen, nicht unter `C:\Program Files`, lokale Platte (kein UNC/Netzlaufwerk — WAL).
- **`install-task.ps1` / `uninstall-task.ps1` / `start.cmd` bleiben unverändert.**
- **`PORT`/`HOST`/`DB_PATH`** bleiben Single Source of Truth in `start.cmd` — keine `setup.ps1`-Parameter dafür.
- **Status-Feld** der API heißt `appVersion` (nicht `version`); Sub-Status unter `database.status` / `storage.status`.
- **Sprache:** deutsche Konsolenausgaben.
- **Test-Realität:** Entwicklung auf macOS, `pwsh` dort nicht installiert. Es gibt **keinen** rotgrünen Laufzeit-Test; Verifikation = statisches Review + optionaler `pwsh`-Syntaxcheck (falls vorhanden) + `-WhatIf`-Trockenlauf und §9-Abnahme **auf der Windows-Box**. Das ist bewusst so (PowerShell-Scheduled-Task-Verhalten ist von macOS aus nicht ausführbar).

---

### Task 1: `setup.cmd` — self-elevating Launcher

**Files:**
- Create: `deploy/windows/setup.cmd`

**Interfaces:**
- Consumes: nichts.
- Produces: ruft `setup.ps1` im selben Verzeichnis mit durchgereichten Argumenten (`%*`). Keine Logik außer Elevation.

- [ ] **Step 1: Datei `deploy/windows/setup.cmd` anlegen**

```batch
@echo off
REM Self-elevating Launcher fuer setup.ps1.
REM Doppelklick -> UAC-Abfrage -> elevated -> ruft setup.ps1.
REM Aus einer bereits erhoehten Shell laeuft es direkt durch.
setlocal

net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Administrator-Rechte werden angefordert...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
```

- [ ] **Step 2: Statisches Review gegen die Launcher-Fallen**

Prüfen (Augenschein, kein Tool nötig):
- `net session` ist der Admin-Check; bei `errorlevel NEQ 0` (nicht-elevated) erfolgt der `RunAs`-Relaunch von `%~f0` (Vollpfad der .cmd) → die elevierte Instanz besteht den Check und fällt in den zweiten Block.
- `"%~dp0setup.ps1"` nutzt das Skriptverzeichnis mit endendem Backslash (kein doppelter/fehlender Trenner).
- `%*` reicht Flags (`-WhatIf`, `-SkipNpm`) durch; ohne Argumente bleibt es leer (harmlos).
- `pause` hält das Fenster nach Doppelklick offen (Ausgabe lesbar). Der Automatisierungspfad nutzt `setup.ps1` direkt, nicht `setup.cmd` — `pause` blockiert dort nicht.

- [ ] **Step 3: Commit**

```bash
git add deploy/windows/setup.cmd
git commit -m "feat(deploy): self-elevating setup.cmd launcher for Windows install"
```

---

### Task 2: `setup.ps1` — Orchestrator (Phasen 1–4)

**Files:**
- Create: `deploy/windows/setup.ps1`
- Reference (unverändert): `deploy/windows/install-task.ps1`, `deploy/windows/start.cmd`

**Interfaces:**
- Consumes: `install-task.ps1` mit Parametern `-DataDir`, `-TaskName`, optional `-WhatIf` (existieren dort bereits). `start.cmd`-Zeilen `set "DB_PATH=…"` und `set "PORT=…"` (gelesen, nicht geschrieben). `GET /api/system/status` → Felder `appVersion`, `database.status`, `storage.status`.
- Produces: ausführbares Setup mit Parametern `-DataDir` (Default `C:\ProgramData\TestoSmartAbruf`), `-TaskName` (Default `TestoSmartAbruf`), `-SkipNpm` (switch), `-WhatIf` (switch). Exit 0 bei Erfolg, Exit 1 bei jedem Abbruch.

> Bauweise: Die Datei wird in einem Rutsch geschrieben (ein zusammenhängendes Skript). Die Steps 1–5 sind die fünf aufeinanderfolgenden Blöcke **derselben** Datei, in Reihenfolge eingefügt. Erst nach Step 5 ist die Datei vollständig und prüfbar.

- [ ] **Step 1: Kopf + Parameter + Helper anlegen** (`deploy/windows/setup.ps1`)

```powershell
#Requires -RunAsAdministrator
<#
  Windows-Schnellinstallation (Orchestrator).
  Preflight -> npm ci --omit=dev -> install-task.ps1 -> Start -> Smoke-Check.
  Ruft die bestehenden Bausteine; ersetzt install-task.ps1 NICHT.
  Re-run-sicher (zugleich Update-Pfad nach git pull). Trockenlauf via -WhatIf.
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

function Fail($msg) { Write-Host "FEHLER: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
```

- [ ] **Step 2: Phase 1 — Preflight (nur prüfen)** ans Dateiende anfügen

```powershell
# ---------- Phase 1/4: Preflight (nur pruefen) ----------
Step 'Phase 1/4: Preflight-Pruefungen'

$nodeVer = $null; $arch = $null
try { $nodeVer = (& node -v).Trim() } catch {}
if (-not $nodeVer) {
  Fail "Node.js nicht gefunden. Node 24 LTS (x64) installieren:`n  winget install OpenJS.NodeJS.LTS`n  oder https://nodejs.org/en/download (Windows x64 .msi)"
}
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -notin 22,24,26) {
  Fail "Node-Version $nodeVer nicht unterstuetzt (erlaubt 22/24/26 — NICHT 23/25, kein better-sqlite3-Prebuild). Node 24 LTS x64 installieren."
}
try { $arch = (& node -p 'process.arch').Trim() } catch {}
if ($arch -ne 'x64') { Fail "Node-Architektur '$arch' — benoetigt x64 (better-sqlite3-Prebuild)." }
try { $null = (& npm -v) } catch { Fail 'npm nicht gefunden (gehoert zu Node.js).' }
Write-Host "  Node $nodeVer ($arch), npm OK"

if ($AppRoot -match '\s') { Fail "Installationspfad enthaelt Leerzeichen: '$AppRoot'. Nach z.B. C:\Apps\TestoSmartAbruf legen (Task-Action scheitert sonst)." }
if ($env:ProgramFiles -and $AppRoot.StartsWith($env:ProgramFiles, [StringComparison]::OrdinalIgnoreCase)) { Fail "Pfad unter 'Program Files': '$AppRoot'. Nach z.B. C:\Apps\TestoSmartAbruf legen (Read-only-Risiko)." }
if (${env:ProgramFiles(x86)} -and $AppRoot.StartsWith(${env:ProgramFiles(x86)}, [StringComparison]::OrdinalIgnoreCase)) { Fail "Pfad unter 'Program Files (x86)': '$AppRoot'." }
if ($AppRoot.StartsWith('\\')) { Fail "UNC-Pfad: '$AppRoot'. SQLite-WAL braucht lokale Platte." }
$drive = Split-Path -Qualifier $AppRoot
$vol = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'" -ErrorAction SilentlyContinue
if ($vol -and $vol.DriveType -eq 4) { Fail "Netzlaufwerk ($drive): SQLite-WAL braucht lokale Platte." }
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

- [ ] **Step 3: Phase 2 — Dependencies + Prebuild-Verifikation** anfügen

```powershell
# ---------- Phase 2/4: Dependencies ----------
if ($SkipNpm) {
  Step 'Phase 2/4: uebersprungen (-SkipNpm)'
} else {
  Step 'Phase 2/4: Dependencies (npm ci --omit=dev)'
  if ($PSCmdlet.ShouldProcess($AppRoot, 'npm ci --omit=dev')) {
    Push-Location $AppRoot
    try {
      & npm ci --omit=dev
      if ($LASTEXITCODE -ne 0) { Fail 'npm ci fehlgeschlagen. Ursachen: falsche Node-Version (kein Prebuild) oder github.com/objects.githubusercontent.com nicht erreichbar (Proxy/Allowlist).' }
    } finally { Pop-Location }

    $nodeFile = Join-Path $AppRoot 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
    if (-not (Test-Path $nodeFile)) { Fail "better-sqlite3-Prebuild fehlt ($nodeFile). Falsche Node-Version oder github.com geblockt (node-gyp-Build statt Download)." }
    Push-Location $AppRoot
    try {
      & node -e "require('better-sqlite3')"
      if ($LASTEXITCODE -ne 0) { Fail 'better-sqlite3 laedt nicht (ABI-Mismatch?). node_modules NIE von macOS/Linux kopieren — auf dieser Maschine neu installieren.' }
    } finally { Pop-Location }
    Write-Host '  better-sqlite3-Prebuild OK'
  }
}
```

- [ ] **Step 4: Phase 3 — `install-task.ps1` aufrufen** anfügen

```powershell
# ---------- Phase 3/4: Dienst registrieren ----------
Step 'Phase 3/4: Dienst registrieren (install-task.ps1)'
$installScript = Join-Path $PSScriptRoot 'install-task.ps1'
$installArgs = @{ DataDir = $DataDir; TaskName = $TaskName }
if ($WhatIfPreference) { $installArgs['WhatIf'] = $true }
try { & $installScript @installArgs } catch { Fail "install-task.ps1 fehlgeschlagen: $($_.Exception.Message)" }
```

- [ ] **Step 5: Phase 4 — Start + Smoke-Check** anfügen

```powershell
# ---------- Phase 4/4: Start & Smoke-Check ----------
Step 'Phase 4/4: Start & Smoke-Check'
if ($WhatIfPreference) { Write-Host '  -WhatIf: Start & Smoke-Check uebersprungen.'; return }

$port = 3000
if (Test-Path $startCmd) {
  $pm = Select-String -Path $startCmd -Pattern 'set\s+"PORT=(\d+)"'
  if ($pm) { $port = [int]$pm.Matches[0].Groups[1].Value }
}

Start-ScheduledTask -TaskName $TaskName

$statusUrl = "http://localhost:$port/api/system/status"
$resp = $null
foreach ($i in 1..15) {
  Start-Sleep -Seconds 2
  try { $resp = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 3 -ErrorAction Stop; break } catch {}
}
if ($resp) {
  Write-Host "`n  Server erreichbar." -ForegroundColor Green
  Write-Host "  Version : $($resp.appVersion)"
  Write-Host "  DB      : $($resp.database.status)   Storage: $($resp.storage.status)"
  Write-Host "  Dashboard: http://localhost:$port"
  Write-Host "  DB-Datei: $DataDir\klima.db    Log: $DataDir\logs\app.log"
  Write-Host "`n  API-Key noch im Dashboard unter Einstellungen hinterlegen (falls nicht geschehen)."
} else {
  Write-Host "  Server nach ~30s nicht erreichbar. Log pruefen: $DataDir\logs\app.log" -ForegroundColor Yellow
  Write-Host "  Haeufig: verwaister node.exe belegt Port ($port) -> Stop-ScheduledTask -TaskName $TaskName; taskkill /IM node.exe /F" -ForegroundColor Yellow
  exit 1
}
```

- [ ] **Step 6: Optionaler Syntaxcheck (nur falls `pwsh` vorhanden)**

Auf der macOS-Dev-Box ist `pwsh` i. d. R. nicht installiert. Falls doch (`brew install --cask powershell`), Syntax cross-platform parsen:

Run:
```bash
pwsh -NoProfile -Command "\$e=\$null; [System.Management.Automation.Language.Parser]::ParseFile('deploy/windows/setup.ps1',[ref]\$null,[ref]\$e); if(\$e){\$e; exit 1} else {'PARSE OK'}"
```
Expected: `PARSE OK` (keine Parser-Fehler). Ist `pwsh` nicht vorhanden: diesen Step überspringen und auf Step 7 + Windows-`-WhatIf` verlassen.

- [ ] **Step 7: Statisches Review gegen die Guardrails**

Augenschein-Checkliste (entspricht den Global Constraints):
- Alle Pfade via `Join-Path`/`$PSScriptRoot`; **kein** `/`, kein hartkodierter Unix-Pfad.
- Smoke-Check liest `$resp.appVersion` (nicht `.version`), `$resp.database.status`, `$resp.storage.status`.
- `-WhatIf` verändert nichts: Phase 2 ist in `ShouldProcess` gekapselt, Phase 3 reicht `-WhatIf` an `install-task.ps1` durch, Phase 4 kehrt früh zurück.
- Node-Major-Whitelist `22,24,26` (23/25 ausgeschlossen); Arch-Check `x64`.
- Jeder Abbruch geht über `Fail` (rote Meldung + `exit 1`).

- [ ] **Step 8: Commit**

```bash
git add deploy/windows/setup.ps1
git commit -m "feat(deploy): setup.ps1 orchestrator (preflight, npm ci, task install, smoke check)"
```

---

### Task 3: README — Abschnitt „Schnellinstallation per `setup.ps1`"

**Files:**
- Modify: `deploy/windows/README.md` (neuer Abschnitt direkt nach „## Voraussetzungen", **vor** „## Installation")

**Interfaces:**
- Consumes: das Verhalten von `setup.cmd`/`setup.ps1` aus Task 1/2.
- Produces: Doku; keine Code-Abhängigkeit.

- [ ] **Step 1: Abschnitt einfügen** (nach „## Voraussetzungen", vor „## Installation")

```markdown
## Schnellinstallation (empfohlen)

`setup.ps1` bündelt die Schritte unten zu einem Aufruf: Node-Preflight,
`npm ci --omit=dev` (inkl. Prebuild-Check), Pfad-/Konsistenz-Prüfung, Aufruf von
`install-task.ps1`, Task-Start und ein `GET /api/system/status`-Smoke-Check.

1. **Pflicht: Installationspfad OHNE Leerzeichen** (z. B. `C:\Apps\TestoSmartAbruf`),
   nicht unter `C:\Program Files`, lokale Platte (kein Netzlaufwerk — WAL).
2. Code auf die Maschine bringen (`git clone`/kopieren — **node_modules NIE
   mitkopieren**, falsches ABI). Node 24 LTS (x64) muss installiert sein.
3. Setup ausführen — doppelklickbar oder aus Admin-PowerShell:
   ```powershell
   .\deploy\windows\setup.cmd
   powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1 -WhatIf   # Trockenlauf
   powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1
   ```
4. Nach Erfolg: API-Key im Dashboard unter Einstellungen hinterlegen.

**Update nach `git pull`:** `setup.ps1` erneut ausführen (idempotent). Wenn sich
`package-lock.json` nicht geändert hat, mit `-SkipNpm` schneller.

Die manuelle Schritt-für-Schritt-Anleitung unten bleibt als Fallback/Transparenz.
```

- [ ] **Step 2: Konsistenz-Review**

Prüfen: Befehle nennen exakt `setup.cmd`/`setup.ps1`; Pfadregel (keine Leerzeichen, nicht Program Files, lokale Platte) deckt sich mit Task 2 Phase 1; `-WhatIf`/`-SkipNpm` korrekt geschrieben; keine widersprüchliche zweite Pfad-/Node-Aussage gegenüber der bestehenden README.

- [ ] **Step 3: Commit**

```bash
git add deploy/windows/README.md
git commit -m "docs(deploy): document setup.ps1 quick-install path"
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

> Hintergrund: Dieses Repo hält **alle** Versionsorte im Gleichschritt (die §9-Akzeptanz prüft das). Auch ohne Frontend-Änderung müssen die 12 `?v=` mitgebumpt werden, sonst schlägt der §9-Versionscheck fehl.

- [ ] **Step 1: Aktuellen Stand verifizieren**

Run:
```bash
cat VERSION; grep -m1 '"version"' package.json; grep -oE 'version-[0-9.]+-blue' README.md; grep -oE '\?v=[0-9.]+' "Smart Meter Dashboard/Klima Dashboard.html" | sort -u; git tag -l 'v0.13.0'
```
Expected: überall `0.12.0`, ein einziges distinct `?v=0.12.0` (12 Vorkommen), und **kein** `v0.13.0`-Tag.

- [ ] **Step 2: `VERSION` setzen**

Inhalt von `VERSION` auf:
```
0.13.0
```

- [ ] **Step 3: `package.json`-Version setzen**

`"version": "0.12.0",` → `"version": "0.13.0",`

- [ ] **Step 4: README-Badge setzen**

In `README.md` den Badge `version-0.12.0-blue` → `version-0.13.0-blue`.

- [ ] **Step 5: Alle 12 `?v=` im HTML bumpen**

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

- [ ] **Step 7: Gesamttests laufen lassen** (Regressionsschutz — Backend unberührt, aber Pflicht-Gate)

Run: `npm test`
Expected: alle Tests grün (kein neuer Test in diesem Plan; PowerShell ist nicht node-getestet).

- [ ] **Step 8: Commit + annotierter Tag (kein Push — lokales Repo)**

```bash
git add VERSION package.json README.md "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.13.0 (Windows setup.ps1 installer)"
git tag -a v0.13.0 -m "v0.13.0"
```

---

## Notes für die Abnahme (nicht Teil der Tasks, aber Definition of Done)

Der einzige verlässliche Funktionsnachweis ist die manuelle Abnahme auf Windows-11-x64:
1. `setup.ps1 -WhatIf` → Preflight läuft, geplante Änderungen werden gezeigt, **nichts** verändert.
2. `setup.ps1` echt → Phasen 1–4 grün, Smoke-Check meldet `appVersion 0.13.0`, Dashboard erreichbar.
3. Anschließend der vollständige **§9-Durchlauf** aus `deploy/windows/README.md` (Reboot ohne Login, CSV-Export, Monats-Backup).
