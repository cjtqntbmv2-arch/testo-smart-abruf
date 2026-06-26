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
  [switch]$SkipNpm,
  [switch]$Bundled
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

# Node-Kommando: im Bundle das mitgelieferte node.exe, sonst System-node (PATH).
$nodeCmd = if ($Bundled) { Join-Path $AppRoot 'node.exe' } else { 'node' }

# Setup-Eigenlog (nur ausserhalb -WhatIf; best effort, scheitert nie hart)
if (-not $WhatIfPreference) {
  try {
    $logDir = Join-Path $DataDir 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    Start-Transcript -Path (Join-Path $logDir 'setup.log') -Append | Out-Null
  } catch {}
}

# ---------- Phase 1/5: Preflight (nur pruefen) ----------
Step 'Phase 1/5: Preflight-Pruefungen'

if ($Bundled) {
  if (-not (Test-Path $nodeCmd)) { Fail "Gebuendeltes node.exe fehlt ($nodeCmd). Defektes Bundle — ZIP erneut laden." }
} else {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js nicht gefunden. Node 24 LTS (x64) installieren:`n  winget install OpenJS.NodeJS.LTS`n  oder https://nodejs.org/en/download (Windows x64 .msi)"
  }
}
$nodeVer = (& $nodeCmd -v).Trim()
if ($nodeVer -notmatch '^v(\d+)\.') { Fail "Node-Version nicht erkennbar ('$nodeVer'). Node 24 LTS x64 installieren." }
$major = [int]$Matches[1]
if ($major -notin 22,24,26) {
  Fail "Node-Version $nodeVer nicht unterstuetzt (erlaubt 22/24/26 — NICHT 23/25, kein better-sqlite3-Prebuild). Node 24 LTS x64 installieren."
}
$arch = (& $nodeCmd -p 'process.arch').Trim()
if ($arch -ne 'x64') { Fail "Node-Architektur '$arch' — benoetigt x64 (better-sqlite3-Prebuild)." }
if (-not $Bundled -and -not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm nicht gefunden (gehoert zu Node.js).' }
Write-Host "  Node $nodeVer ($arch) [$(if ($Bundled){'gebuendelt'}else{'System'})] OK"

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

# ---------- Phase 3/5: Dependencies ----------
Step 'Phase 3/5: Dependencies (npm ci --omit=dev)'
if ($Bundled) {
  Write-Host '  npm ci uebersprungen (Bundle bringt node_modules mit)'
} elseif (-not $SkipNpm) {
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
  try { & $nodeCmd -e "require('better-sqlite3')"; if ($LASTEXITCODE -ne 0) { $loadOk = $false } } catch { $loadOk = $false }
  Pop-Location
  if (-not $loadOk) { Fail 'better-sqlite3 laedt nicht (ABI-Mismatch?). Auf DIESER Maschine neu installieren (node_modules nie kopieren).' }
  Write-Host '  better-sqlite3-Prebuild OK'
}

# ---------- Phase 4/5: Dienst registrieren ----------
Step 'Phase 4/5: Dienst registrieren (install-task.ps1)'
$installScript = Join-Path $PSScriptRoot 'install-task.ps1'
$installArgs = @{ DataDir = $DataDir; TaskName = $TaskName }
if ($WhatIfPreference) { $installArgs['WhatIf'] = $true }
try { & $installScript @installArgs } catch { Fail "install-task.ps1 fehlgeschlagen: $($_.Exception.Message)" }

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
  try { Start-Process "http://localhost:$port" } catch {}
  Write-Host "  DB-Datei : $DataDir\klima.db    Log: $DataDir\logs\app.log"
  try { Stop-Transcript | Out-Null } catch {}
} else {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "  Server nach ~60s nicht erreichbar (LastTaskResult: $($info.LastTaskResult)). Log pruefen: $DataDir\logs\app.log" -ForegroundColor Yellow
  Write-Host "  Haeufig: verwaister node.exe belegt Port $port -> Stop-ScheduledTask -TaskName $TaskName; taskkill /IM node.exe /F" -ForegroundColor Yellow
  Fail 'Smoke-Check fehlgeschlagen.'
}
