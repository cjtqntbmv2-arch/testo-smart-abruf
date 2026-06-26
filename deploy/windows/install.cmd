@echo off
REM Ein-Klick-Installer fuer das vorgebaute Windows-Bundle (Staging+Swap).
REM Re-run-/update-sicher: entpacken -> install.cmd doppelklicken. Daten liegen
REM getrennt in C:\ProgramData\TestoSmartAbruf und bleiben unberuehrt.
setlocal
set "LIVE=C:\Apps\TestoSmartAbruf"
set "STAGE=C:\Apps\TestoSmartAbruf.staging"
set "OLD=C:\Apps\TestoSmartAbruf.old"
set "TASKNAME=TestoSmartAbruf"

REM --- UAC-Self-Elevation ---
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Administrator-Rechte werden angefordert...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"

REM --- Bundle-Wurzel selbst-lokalisieren: node.exe liegt entweder NEBEN install.cmd
REM     (Wurzel-Kopie) ODER zwei Ebenen darueber (Start aus deploy\windows\). So
REM     funktioniert beide im Bundle vorhandene install.cmd-Kopien. ---
set "ROOT="
for %%A in ("%~dp0.") do set "CAND0=%%~fA"
for %%A in ("%~dp0..\..") do set "CAND2=%%~fA"
if exist "%CAND0%\node.exe" set "ROOT=%CAND0%"
if not defined ROOT if exist "%CAND2%\node.exe" set "ROOT=%CAND2%"
if not defined ROOT goto :notextracted
if not exist "%ROOT%\node_modules\better-sqlite3\build\Release\better_sqlite3.node" goto :notextracted

REM --- Nicht aus dem Zielordner selbst starten (sonst wird der laufende Pfad weggemoved) ---
if /i "%ROOT%"=="%LIVE%" (
  echo FEHLER: Bitte install.cmd aus dem entpackten Download-Ordner starten, NICHT aus %LIVE%.
  pause & exit /b 1
)

echo ==> Bundle entsperren (Mark-of-the-Web)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path $env:ROOT -Recurse | Unblock-File" 2>nul

echo ==> Staging vorbereiten (%STAGE%)
if exist "%STAGE%" (
  rmdir /s /q "%STAGE%"
  if exist "%STAGE%" (
    echo FEHLER: %STAGE% ist noch gesperrt. Abbruch.
    pause & exit /b 1
  )
)
robocopy "%ROOT%" "%STAGE%" /E /NFL /NDL /NJH /NJS /R:5 /W:3 >nul
if %errorlevel% GEQ 8 (
  echo FEHLER: Kopieren ins Staging fehlgeschlagen. Bestehende Installation unveraendert.
  rmdir /s /q "%STAGE%" 2>nul
  pause & exit /b 1
)

echo ==> Konfiguration aus bestehender Installation uebernehmen
if exist "%LIVE%\.env" (
  copy /Y "%LIVE%\.env" "%STAGE%\.env" >nul
)

echo ==> Gebuendeltes node.exe pruefen (better-sqlite3 laedt?)
"%STAGE%\node.exe" -e "require('better-sqlite3')" 2>nul
if %errorlevel% NEQ 0 (
  echo FEHLER: better-sqlite3 laedt nicht ^(defektes Bundle^). Abbruch, alte Version unveraendert.
  rmdir /s /q "%STAGE%" 2>nul
  pause & exit /b 1
)

echo ==> Laufenden Dienst stoppen + verwaisten node.exe beenden
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue; foreach ($i in 1..15) { if ((Get-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue).State -ne 'Running') { break }; Start-Sleep -Seconds 1 }; Start-Sleep -Seconds 2"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'backend\\server\.js' } | Invoke-CimMethod -MethodName Terminate | Out-Null"

echo ==> Umschalten auf neue Version (atomarer move)
if exist "%OLD%" rmdir /s /q "%OLD%"
if exist "%LIVE%" (
  move "%LIVE%" "%OLD%" >nul
  if errorlevel 1 (
    echo FEHLER: Laufende Version konnte nicht nach %OLD% verschoben werden ^(Datei gesperrt?^). Abbruch, alte Version unveraendert.
    rmdir /s /q "%STAGE%" 2>nul
    pause & exit /b 1
  )
)
move "%STAGE%" "%LIVE%" >nul
if errorlevel 1 (
  echo FEHLER beim Umschalten — Rollback auf vorherige Version.
  if exist "%OLD%" move "%OLD%" "%LIVE%" >nul
  pause & exit /b 1
)
if exist "%OLD%" rmdir /s /q "%OLD%"

echo ==> Berechtigungen haerten (nur Admin/SYSTEM schreibend; NetworkService liest+fuehrt aus)
icacls "%LIVE%" /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-20:(OI)(CI)RX" >nul

echo ==> Einrichtung starten (setup.ps1 -Bundled)
powershell -NoProfile -ExecutionPolicy Bypass -File "%LIVE%\deploy\windows\setup.ps1" -Bundled
echo.
pause
exit /b

:notextracted
echo FEHLER: Dieses Fenster laeuft nicht aus einem vollstaendig entpackten Ordner.
echo Bitte die ZIP zuerst per Rechtsklick "Alle extrahieren" entpacken und dann
echo install.cmd im entpackten Ordner doppelklicken (NICHT direkt aus der ZIP).
pause & exit /b 1
