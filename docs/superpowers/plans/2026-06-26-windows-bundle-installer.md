# Windows-Bundle-Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine pro Release auf GitHub Actions (win32-x64) vorgebaute ZIP, die der Bediener nur laden, entpacken und per einem Doppelklick (`install.cmd`) installiert — ohne Node-Install, ohne `npm ci`, ohne Pfadregeln.

**Architecture:** CI (`windows-latest`) baut `node_modules` (inkl. `better-sqlite3`-win32-x64-Prebuild), legt ein portables `node.exe` dazu und packt alles als ZIP ans Release. `install.cmd` entsperrt das Bundle, kopiert es nach `C:\Apps\TestoSmartAbruf` und ruft den bestehenden `setup.ps1` im neuen `-Bundled`-Modus (überspringt System-Node-Preflight und `npm ci`). `start.cmd` bevorzugt das gebündelte `node.exe`, fällt sonst auf PATH-`node` zurück (Quellcode-Betrieb bleibt intakt).

**Tech Stack:** GitHub Actions (YAML), Windows PowerShell (`.ps1`), cmd/batch (`.cmd`), Node.js 24 x64, `better-sqlite3`.

## Global Constraints

(Verbatim aus Spec + CLAUDE.md — gelten implizit für jede Task.)

- Bundle MUSS auf **win32-x64** gebaut werden; `node_modules` NIE von macOS/Linux kopieren (ABF/ABI).
- Node-Major nur **22/24/26** (NICHT 23/25 — kein `better-sqlite3`-Prebuild); arch **x64**.
- Einziges natives Modul: `better-sqlite3`. Kein Compiler/`node-gyp` zur Laufzeit (Prebuild-Download).
- `puppeteer` bleibt devDependency → Bundle baut mit `npm ci --omit=dev`.
- Pfade in Skripten ohne Leerzeichen am Task-Action-Ziel; Zielordner fest = `C:\Apps\TestoSmartAbruf`.
- DB-Pfad getrennt: `DB_PATH=C:\ProgramData\TestoSmartAbruf\klima.db` (Code-Overwrite berührt Daten nie).
- `setup.ps1` ohne `-Bundled` MUSS sich exakt wie heute verhalten (Quellcode-Pfad).
- Kein lokaler PowerShell/CI-Lauf möglich (macOS, kein `pwsh`) → Verifikation = CI via `workflow_dispatch` + Windows-Abnahme (`deploy/windows/README.md` §9).
- Bei Release: `VERSION`, README-Badge, `package.json`-Version, die **12** `?v=`-Cache-Buster in `Smart Meter Dashboard/Klima Dashboard.html` und der ZIP-Dateiname tragen dieselbe SemVer.

---

### Task 1: GitHub-Remote anlegen (Voraussetzung)

**Files:** keine (Repo-Konfiguration).

**Interfaces:**
- Produces: ein erreichbares `origin`-Remote auf GitHub; Releases-Seite als Download-Ort; ermöglicht CI in Task 5.

- [ ] **Step 1: Prüfen, ob bereits ein Remote existiert**

Run: `git remote -v`
Expected: leer (bislang local-only).

- [ ] **Step 2: Privates GitHub-Repo erstellen und als Remote setzen**

```bash
gh repo create testo-smart-abruf --private --source=. --remote=origin --push
```
Expected: Repo wird erstellt, `main` gepusht, `origin` gesetzt.

- [ ] **Step 3: Verifizieren**

Run: `git remote -v && gh repo view --json nameWithOwner -q .nameWithOwner`
Expected: `origin` zeigt auf das neue Repo; Repo-Name wird ausgegeben.

*(Kein Commit — reine Repo-Konfiguration.)*

---

### Task 2: `start.cmd` — gebündeltes `node.exe` bevorzugen

**Files:**
- Modify: `deploy/windows/start.cmd:16-20`

**Interfaces:**
- Consumes: nichts.
- Produces: `start.cmd` startet den Server mit `.\node.exe` (Bundle) falls vorhanden, sonst `node` (PATH). Keine Signaturänderung — derselbe Aufruf, dieselbe Env.

- [ ] **Step 1: Node-Auflösung nach dem `cd` einfügen**

Ersetze die Zeilen ab `cd /d "%~dp0..\.."` bis zum Ende durch:

```cmd
REM App-Root = zwei Ebenen ueber diesem Script (deploy\windows\)
cd /d "%~dp0..\.."

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Gebuendeltes node.exe (Bundle) bevorzugen, sonst PATH-node (Quellcode-Betrieb)
set "NODE_EXE=node"
if exist "node.exe" set "NODE_EXE=.\node.exe"

"%NODE_EXE%" backend\server.js >> "%LOGDIR%\app.log" 2>&1
```

- [ ] **Step 2: Verifizieren (Inhaltsprüfung, da kein cmd auf macOS)**

Run: `grep -n "NODE_EXE" deploy/windows/start.cmd`
Expected: drei Treffer (Default `node`, `if exist`-Override, Aufruf `"%NODE_EXE%"`).

- [ ] **Step 3: Commit**

```bash
git add deploy/windows/start.cmd
git commit -m "feat(deploy): start.cmd prefers bundled node.exe, falls back to PATH"
```

---

### Task 3: `setup.ps1` — Schalter `-Bundled`

**Files:**
- Modify: `deploy/windows/setup.ps1` (param-Block; Phase 1 Preflight; Phase 3 Dependencies + Prebuild-Check; Phase 5 Browser-Open)

**Interfaces:**
- Consumes: gebündeltes `node.exe` unter `$AppRoot\node.exe` (aus Task 5); `start.cmd` aus Task 2.
- Produces: `setup.ps1 -Bundled` überspringt System-Node-Preflight und `npm ci`, prüft stattdessen das gebündelte `node.exe` + Prebuild-Last, und öffnet nach erfolgreichem Smoke-Check den Browser. Ohne `-Bundled` unverändert.

- [ ] **Step 1: `-Bundled`-Switch zum param-Block hinzufügen**

Ersetze den `param(...)`-Block (Zeilen 9-13) durch:

```powershell
param(
  [string]$DataDir  = 'C:\ProgramData\TestoSmartAbruf',
  [string]$TaskName = 'TestoSmartAbruf',
  [switch]$SkipNpm,
  [switch]$Bundled
)
```

- [ ] **Step 2: Vor Phase 1 die Node-Kommando-Variable bestimmen**

Direkt nach der `Step`-Funktionsdefinition (nach Zeile 24, vor dem Transcript-Block) einfügen:

```powershell
# Node-Kommando: im Bundle das mitgelieferte node.exe, sonst System-node (PATH).
$nodeCmd = if ($Bundled) { Join-Path $AppRoot 'node.exe' } else { 'node' }
```

- [ ] **Step 3: Phase-1-Preflight für den Bundle-Fall verzweigen**

Ersetze den System-Node-Block (Zeilen 38-50, von `if (-not (Get-Command node ...))` bis `Write-Host "  Node $nodeVer ($arch), npm OK"`) durch:

```powershell
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
```

- [ ] **Step 4: Phase 3 — `npm ci` im Bundle-Fall überspringen**

Ersetze den `if (-not $SkipNpm) { ... } else { ... }`-Block (Zeilen 88-102) durch:

```powershell
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
```

- [ ] **Step 5: Prebuild-Lade-Check über `$nodeCmd` statt `node`**

Ersetze in der Prebuild-Verifikation (Zeilen 108-112) den Push-Location/`& node`-Teil durch:

```powershell
  Push-Location $AppRoot
  $loadOk = $true
  try { & $nodeCmd -e "require('better-sqlite3')"; if ($LASTEXITCODE -ne 0) { $loadOk = $false } } catch { $loadOk = $false }
  Pop-Location
```

- [ ] **Step 6: Phase 5 — Browser nach Erfolg öffnen**

Im Erfolgszweig (`if ($resp) { ... }`) direkt nach `Write-Host "  Dashboard: http://localhost:$port"` (Zeile 148) einfügen:

```powershell
  try { Start-Process "http://localhost:$port" } catch {}
```

- [ ] **Step 7: Verifizieren (Inhaltsprüfung)**

Run: `grep -n "Bundled\|nodeCmd\|Start-Process \"http" deploy/windows/setup.ps1`
Expected: `[switch]$Bundled` im param-Block; `$nodeCmd`-Definition; Bundle-Verzweigungen in Phase 1 und 3; `Start-Process "http://localhost:$port"` in Phase 5.

- [ ] **Step 8: Commit**

```bash
git add deploy/windows/setup.ps1
git commit -m "feat(deploy): setup.ps1 -Bundled mode (skip node-preflight + npm ci, open browser)"
```

---

### Task 4: `install.cmd` — Ein-Klick-Installer im Bundle

**Files:**
- Create: `deploy/windows/install.cmd`

**Interfaces:**
- Consumes: `setup.ps1 -Bundled` aus Task 3 (am Zielpfad).
- Produces: Einstiegspunkt für den Bediener. Self-elevating; entsperrt das Bundle; stoppt einen laufenden Task; kopiert das Bundle nach `C:\Apps\TestoSmartAbruf`; ruft dort `setup.ps1 -Bundled`.

- [ ] **Step 1: `install.cmd` anlegen**

```cmd
@echo off
REM Ein-Klick-Installer fuer das vorgebaute Windows-Bundle.
REM Self-elevating: entsperrt das Bundle, stoppt einen ggf. laufenden Dienst,
REM kopiert nach C:\Apps\TestoSmartAbruf und ruft setup.ps1 -Bundled.
REM Re-run-sicher (zugleich Update-Pfad: neue ZIP entpacken -> install.cmd erneut).
setlocal
set "DEST=C:\Apps\TestoSmartAbruf"
set "TASKNAME=TestoSmartAbruf"

REM --- UAC-Self-Elevation ---
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Administrator-Rechte werden angefordert...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

REM Elevated: CWD ist C:\Windows\system32 -> ins Bundle-Verzeichnis wechseln.
cd /d "%~dp0"

echo ==> Bundle entsperren (Mark-of-the-Web)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path '%~dp0' -Recurse | Unblock-File" 2>nul

echo ==> Laufenden Dienst stoppen (falls vorhanden)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3"

echo ==> Bundle kopieren nach %DEST%
robocopy "%~dp0." "%DEST%" /E /NFL /NDL /NJH /NJS /R:2 /W:2
if %errorlevel% GEQ 8 (
  echo FEHLER: Kopieren nach %DEST% fehlgeschlagen ^(robocopy %errorlevel%^).
  pause
  exit /b 1
)

echo ==> Einrichtung starten (setup.ps1 -Bundled)
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\deploy\windows\setup.ps1" -Bundled
echo.
pause
```

- [ ] **Step 2: Verifizieren (Inhaltsprüfung)**

Run: `grep -n "RunAs\|Unblock-File\|Stop-ScheduledTask\|robocopy\|setup.ps1\" -Bundled" deploy/windows/install.cmd`
Expected: UAC-Elevation, Unblock-File, Stop-ScheduledTask, robocopy nach `%DEST%`, abschließender `setup.ps1 -Bundled`-Aufruf.

- [ ] **Step 3: Commit**

```bash
git add deploy/windows/install.cmd
git commit -m "feat(deploy): install.cmd one-click bundle installer (unblock, copy, setup -Bundled)"
```

---

### Task 5: CI-Workflow — Bundle bauen & veröffentlichen

**Files:**
- Create: `.github/workflows/windows-bundle.yml`

**Interfaces:**
- Consumes: `package.json` (Version, deps), `install.cmd` (Task 4), `deploy/windows/` (Tasks 2-4).
- Produces: `testo-smart-abruf-<version>-win-x64.zip` als Release-Artefakt (bei `v*`-Tag) bzw. als Workflow-Artefakt (bei `workflow_dispatch`). Bundle-Wurzel enthält `install.cmd` + App + `node_modules` + `node.exe`.

- [ ] **Step 1: Workflow-Datei anlegen**

```yaml
name: Windows Bundle

on:
  push:
    tags: ['v*']
  workflow_dispatch: {}

permissions:
  contents: write   # fuer Release-Upload

jobs:
  bundle:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          architecture: x64

      - name: Verify Node arch
        shell: pwsh
        run: |
          $arch = node -p "process.arch"
          if ($arch -ne 'x64') { throw "Node arch $arch != x64" }
          Write-Host "Node $(node -v) ($arch)"

      - name: Install prod dependencies
        run: npm ci --omit=dev

      - name: Verify better-sqlite3 prebuild loads
        run: node -e "require('better-sqlite3'); console.log('prebuild ok')"

      - name: Read app version
        id: ver
        shell: pwsh
        run: |
          $v = node -p "require('./package.json').version"
          "version=$v" | Out-File -FilePath $env:GITHUB_OUTPUT -Append

      - name: Fetch portable node.exe
        shell: pwsh
        run: |
          $v = (node -v).Trim()                 # z.B. v24.4.1
          $url = "https://nodejs.org/dist/$v/node-$v-win-x64.zip"
          Invoke-WebRequest -Uri $url -OutFile node-win.zip
          Expand-Archive -Path node-win.zip -DestinationPath node-dist -Force
          Copy-Item "node-dist/node-$v-win-x64/node.exe" -Destination ./node.exe -Force

      - name: Assemble bundle
        shell: pwsh
        run: |
          $dest = "bundle/testo-smart-abruf"
          New-Item -ItemType Directory -Force -Path $dest | Out-Null
          $items = @('backend','scripts','Smart Meter Dashboard','deploy','node_modules','node.exe','package.json','package-lock.json','VERSION')
          Copy-Item -Path $items -Destination $dest -Recurse -Force
          Copy-Item -Path 'deploy/windows/install.cmd' -Destination "$dest/install.cmd" -Force

      - name: Zip bundle
        shell: pwsh
        run: Compress-Archive -Path "bundle/testo-smart-abruf" -DestinationPath "testo-smart-abruf-${{ steps.ver.outputs.version }}-win-x64.zip" -Force

      - name: Upload workflow artifact
        uses: actions/upload-artifact@v4
        with:
          name: windows-bundle
          path: testo-smart-abruf-*-win-x64.zip

      - name: Attach to release
        if: startsWith(github.ref, 'refs/tags/')
        uses: softprops/action-gh-release@v2
        with:
          files: testo-smart-abruf-*-win-x64.zip
```

- [ ] **Step 2: Verifizieren (Inhaltsprüfung, da kein actionlint lokal)**

Run: `grep -n "runs-on: windows-latest\|npm ci --omit=dev\|node.exe\|install.cmd\|Compress-Archive" .github/workflows/windows-bundle.yml`
Expected: `windows-latest`, `npm ci --omit=dev`, `node.exe`-Fetch+Copy, `install.cmd` im Bundle, `Compress-Archive`.

- [ ] **Step 3: Commit + Push (Workflow muss am Remote liegen, um zu laufen)**

```bash
git add .github/workflows/windows-bundle.yml
git commit -m "ci(deploy): windows-latest workflow builds + publishes bundle zip"
git push -u origin HEAD
```

- [ ] **Step 4: CI-Probelauf (echter Test — ersetzt lokales TDD)**

Run: `gh workflow run "Windows Bundle" && sleep 5 && gh run list --workflow="Windows Bundle" -L 1`
Dann den Lauf beobachten: `gh run watch`
Expected: Job grün; Artefakt `windows-bundle` vorhanden.

- [ ] **Step 5: Artefakt prüfen (Bundle-Struktur)**

Run: `gh run download --name windows-bundle -D /tmp/bundle-check && unzip -l /tmp/bundle-check/*.zip | grep -E "install.cmd|node.exe|node_modules/better-sqlite3|backend/server.js|Smart Meter Dashboard/Klima Dashboard.html"`
Expected: alle fünf Pfade in der ZIP vorhanden.

*(Kein zusätzlicher Commit — Verifikation.)*

---

### Task 6: Doku, Abnahme & Versions-Bump

**Files:**
- Modify: `deploy/windows/README.md` (Schnellinstallation → Bundle-Ablauf; §9-Abnahme)
- Modify: `deploy/windows/env.example` (Hinweis bleibt gültig — prüfen, ggf. unverändert)
- Modify: `VERSION`, `README.md` (Badge), `package.json` (version)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (12 × `?v=`)

**Interfaces:**
- Consumes: Tasks 2-5 (fertige Skripte + CI).
- Produces: konsistente Version `0.14.0` über alle Orte; README beschreibt den Laien-Ablauf; §9-Abnahme erweitert.

- [ ] **Step 1: README — Bundle-Ablauf als neuen empfohlenen Weg dokumentieren**

In `deploy/windows/README.md` oberhalb der bestehenden „Schnellinstallation" einen Abschnitt einfügen:

```markdown
## Installation aus dem Bundle (empfohlen, fuer Laien)

Kein Node-Install, kein `npm ci`, keine Pfadregeln noetig:

1. Auf der **Releases-Seite** des Repos die Datei
   `testo-smart-abruf-<version>-win-x64.zip` herunterladen.
2. ZIP **entpacken** (egal wohin — z. B. Downloads).
3. Im entpackten Ordner **`install.cmd` doppelklicken**. Beim
   SmartScreen-Hinweis: „Weitere Informationen" → „Trotzdem ausfuehren".
   UAC bestaetigen. Der Installer entsperrt, kopiert nach
   `C:\Apps\TestoSmartAbruf`, registriert den Dienst und startet ihn.
4. Der Browser oeffnet sich automatisch → **API-Key** unter Einstellungen
   eintragen. Fertig.

**Update:** neue ZIP laden, entpacken, `install.cmd` erneut doppelklicken
(stoppt den Dienst, kopiert ueber `C:\Apps\TestoSmartAbruf`, re-registriert).
Die Datenbank in `C:\ProgramData\TestoSmartAbruf\` bleibt erhalten.

> Das Bundle bringt ein offizielles, signiertes `node.exe` mit. Mit EDR/IT
> abklaeren. Die Quellcode-Variante (`npm ci` + `setup.ps1`) unten bleibt als
> Alternative.
```

- [ ] **Step 2: §9-Abnahme um Bundle-Punkte erweitern**

In `deploy/windows/README.md` unter „### Versionscheck" anfügen:

```markdown
### Bundle-Installation (ab v0.14.0)

- ZIP-Artefakt `testo-smart-abruf-<version>-win-x64.zip` existiert auf der Releases-Seite.
- Frische Maschine **ohne vorinstalliertes Node**: `install.cmd` fuehrt ohne `npm ci` zum laufenden Dienst.
- Nach Installation existiert `C:\Apps\TestoSmartAbruf\node.exe` und `...\node_modules\better-sqlite3\build\Release\better_sqlite3.node`.
- Nach erfolgreichem Smoke-Check oeffnet sich der Browser auf `http://localhost:3000`.
- Update durch erneutes `install.cmd`: Dienst laeuft danach mit neuer `appVersion`, DB-Daten unveraendert.
```

- [ ] **Step 3: Versions-Bump auf `0.14.0` (alle Orte synchron)**

```bash
# VERSION
printf '0.14.0\n' > VERSION
```

In `package.json` Zeile 3: `"version": "0.13.0",` → `"version": "0.14.0",`.

In `README.md` (Repo-Wurzel) den Badge: `version-0.13.0-blue` → `version-0.14.0-blue`.

In `Smart Meter Dashboard/Klima Dashboard.html` **alle 12** `?v=0.13.0` → `?v=0.14.0`:
```bash
sed -i '' 's/?v=0\.13\.0/?v=0.14.0/g' "Smart Meter Dashboard/Klima Dashboard.html"
```

In `deploy/windows/README.md` den §9-Versionscheck (`0.13.0` → `0.14.0`, sowohl `appVersion` als auch die `?v=`-Zeile).

- [ ] **Step 4: Konsistenz verifizieren**

Run: `grep -rn "0\.14\.0" VERSION package.json README.md deploy/windows/README.md | head && echo "---?v count---" && grep -c "?v=0.14.0" "Smart Meter Dashboard/Klima Dashboard.html"`
Expected: VERSION/package.json/README-Badge/§9 zeigen `0.14.0`; `?v=`-Zähler = **12**.

- [ ] **Step 5: Commit + Tag + Push**

```bash
git add VERSION package.json README.md deploy/windows/README.md deploy/windows/env.example "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.14.0 (Windows bundle installer)"
git tag -a v0.14.0 -m "v0.14.0"
git push --follow-tags
```

- [ ] **Step 6: Release-Build verifizieren (der Tag löst den Workflow aus)**

Run: `gh run watch && gh release view v0.14.0 --json assets -q '.assets[].name'`
Expected: Workflow grün; Release `v0.14.0` trägt `testo-smart-abruf-0.14.0-win-x64.zip`.

---

## Self-Review

**Spec coverage:**
- CI-Build (Spec §1) → Task 5. ✓
- Bediener-Ablauf (Spec §2) → Task 4 + README in Task 6. ✓
- `install.cmd` (Spec §3) → Task 4. ✓
- `setup.ps1 -Bundled` (Spec §3.3) → Task 3. ✓
- `install-task.ps1` unverändert (Spec §4) → keine Task nötig. ✓
- `start.cmd` Node-Auflösung (Spec §5) → Task 2. ✓
- Update & Daten (Spec) → Task 4 (Stop+Copy) + README in Task 6. ✓
- Grenzen/IT-Abstimmung (Spec §6) → README-Hinweis in Task 6. ✓
- Voraussetzung GitHub-Remote → Task 1. ✓
- Versions-Synchronität (Konsistenz-Anker) → Task 6. ✓

**Placeholder scan:** keine TBD/TODO; alle Code-Schritte enthalten vollständigen Code. ✓

**Type/Name-Konsistenz:** `$nodeCmd`, `$Bundled`, `%DEST%`, `%TASKNAME%`, ZIP-Name `testo-smart-abruf-<version>-win-x64.zip`, Zielpfad `C:\Apps\TestoSmartAbruf` durchgängig identisch verwendet. ✓
