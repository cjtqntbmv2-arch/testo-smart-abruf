@echo off
REM Ein-Klick-Installer fuer das vorgebaute Windows-Bundle (Staging+Swap).
REM Re-run-/update-sicher: entpacken -> install.cmd doppelklicken. Daten liegen
REM getrennt in C:\ProgramData\TestoSmartAbruf und bleiben unberuehrt.
REM Vor dem Umschalten zieht install.cmd einen Abzug der Datenbank; scheitert die
REM Einrichtung der neuen Version, spielt es die vorherige zurueck (Rollback).
REM update.cmd startet diese Datei per call, dann schon mit Adminrechten.
REM Exit-Code: 0 = installiert, 1 = Fehler, auch nach einem Rollback.
setlocal
set "LIVE=C:\Apps\TestoSmartAbruf"
set "STAGE=%LIVE%.staging"
set "OLD=%LIVE%.old"
set "FAILED=%LIVE%.failed"
set "TASKNAME=TestoSmartAbruf"
REM Wortgleich wie in start.cmd, ein Test haelt das fest: der Abzug kommt von
REM genau der Datei, die der Dienst beschreibt.
set "DB_PATH=C:\ProgramData\TestoSmartAbruf\klima.db"
set "ABZUG=C:\ProgramData\TestoSmartAbruf\klima-vor-update.db"
set "ABZUG_FEHL=C:\ProgramData\TestoSmartAbruf\klima-vor-update.fehlgeschlagen.db"

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
if not exist "%ROOT%\node_modules\better-sqlite3\prebuilds\win32-x64.node" goto :notextracted

REM --- Nicht aus dem Zielordner selbst starten (sonst wird der laufende Pfad weggemoved) ---
if /i "%ROOT%"=="%LIVE%" (
  echo FEHLER: Bitte install.cmd aus dem entpackten Download-Ordner starten, NICHT aus %LIVE%.
  pause & exit /b 1
)

REM Das Groesser-Zeichen in den Fortschrittszeilen ist per Caret maskiert.
REM Unmaskiert ist es eine Umleitung: die Zeile erschiene nicht auf der Konsole,
REM sondern landete als Datei im Bundle und per robocopy bis in LIVE.
echo ==^> Bundle entsperren (Mark-of-the-Web)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path $env:ROOT -Recurse | Unblock-File" 2>nul

echo ==^> Staging vorbereiten (%STAGE%)
if exist "%STAGE%" rmdir /s /q "%STAGE%"
if exist "%STAGE%" (
  echo FEHLER: %STAGE% ist noch gesperrt.
  goto :abbruch
)
REM Erst anlegen und haerten, dann befuellen: ein neuer Ordner unter C:\ ist fuer
REM Authentifizierte Benutzer beschreibbar, und gleich startet von dort node.exe
REM mit Adminrechten. Dieselbe ACL wie unten fuer LIVE.
md "%STAGE%"
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :stagefehler
icacls "%STAGE%" /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-20:(OI)(CI)RX" >nul
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :stagefehler
robocopy "%ROOT%" "%STAGE%" /E /NFL /NDL /NJH /NJS /R:5 /W:3 >nul
set "RC=%errorlevel%"
if %RC% GEQ 8 goto :kopierfehler
if %RC% LSS 0 goto :kopierfehler

echo ==^> Konfiguration aus bestehender Installation uebernehmen
if exist "%LIVE%\.env" (
  copy /Y "%LIVE%\.env" "%STAGE%\.env" >nul
)

echo ==^> Gebuendeltes node.exe pruefen (better-sqlite3 laedt?)
"%STAGE%\node.exe" -e "require('better-sqlite3')" 2>nul
if %errorlevel% NEQ 0 (
  echo FEHLER: better-sqlite3 laedt nicht ^(defektes Bundle^).
  goto :abbruch
)

REM --- Datenbank-Abzug VOR dem Dienststopp ---
REM Scheitert er, bricht das Update ab, und der Dienst laeuft unveraendert weiter.
REM Nur bei einem Update: bei der Erstinstallation gibt es noch keine Datenbank.
REM fileMustExist legt eine falsch geschriebene Quelle nicht still als leere DB
REM an. readonly schreibt nach einem Absturz des Dienstes nichts aus dem -wal in
REM die Live-DB zurueck. VACUUM INTO liest auch Zeilen, die erst im -wal stehen,
REM scheitert aber an einem nicht leeren Ziel: erst .tmp, dann umbenennen, wie
REM backend\backup-runner.js. Pfade per Umgebungsvariable, nie im SQL-Text.
if not exist "%DB_PATH%" goto :nach_abzug
echo ==^> Datenbank sichern (%ABZUG%)
if exist "%ABZUG%.tmp" del /f /q "%ABZUG%.tmp"
REM Auch das -journal eines abgebrochenen Abzugs, wie backend\backup-runner.js.
if exist "%ABZUG%.tmp-journal" del /f /q "%ABZUG%.tmp-journal"
"%STAGE%\node.exe" -e "const D=require(require('path').join(process.env.STAGE,'node_modules','better-sqlite3'));const db=new D(process.env.DB_PATH,{readonly:true,fileMustExist:true});db.prepare('VACUUM INTO ?').run(process.env.ABZUG+'.tmp');db.close()"
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :abzugfehler
move /y "%ABZUG%.tmp" "%ABZUG%" >nul
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :abzugfehler
:nach_abzug

echo ==^> Laufenden Dienst stoppen + verwaisten node.exe beenden
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue; foreach ($i in 1..15) { if ((Get-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue).State -ne 'Running') { break }; Start-Sleep -Seconds 1 }; Start-Sleep -Seconds 2"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'backend\\server\.js' } | Invoke-CimMethod -MethodName Terminate | Out-Null"

REM Ab hier ist der Dienst gestoppt: jeder Abbruch startet die vorherige Version
REM wieder, eine gescheiterte Einrichtung faengt der Rollback unten ab.
echo ==^> Umschalten auf neue Version (atomarer move)
if exist "%OLD%" rmdir /s /q "%OLD%"
if exist "%OLD%" (
  echo FEHLER: %OLD% laesst sich nicht loeschen ^(Datei gesperrt?^).
  goto :abbruch_nach_stopp
)
if not exist "%LIVE%" goto :stage_nach_live
move "%LIVE%" "%OLD%" >nul
set "RC=%errorlevel%"
if not %RC% EQU 0 (
  echo FEHLER: Laufende Version konnte nicht nach %OLD% verschoben werden ^(Datei gesperrt?^).
  goto :abbruch_nach_stopp
)
:stage_nach_live
move "%STAGE%" "%LIVE%" >nul
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :umschaltfehler

echo ==^> Berechtigungen haerten (nur Admin/SYSTEM schreibend; NetworkService liest+fuehrt aus)
icacls "%LIVE%" /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-20:(OI)(CI)RX" >nul

echo ==^> Einrichtung starten (setup.ps1 -Bundled)
powershell -NoProfile -ExecutionPolicy Bypass -File "%LIVE%\deploy\windows\setup.ps1" -Bundled
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :rollback
REM Erst jetzt ist die neue Version bestaetigt, die vorherige darf weg.
if exist "%OLD%" rmdir /s /q "%OLD%"
if exist "%OLD%" echo WARNUNG: %OLD% liess sich nicht vollstaendig loeschen, bitte von Hand entfernen.
echo.
pause
exit /b %RC%

:rollback
echo.
echo FEHLER: Einrichtung der neuen Version gescheitert, Exit-Code %RC%.
if not exist "%OLD%" goto :ohne_vorversion
echo ==^> ROLLBACK auf die vorherige Version
REM Zuerst deaktivieren: die Aufgabe startet eine abgestuerzte Fassung nach 1, 2
REM und 3 Minuten neu (install-task.ps1), setup.ps1 gibt erst nach 60 bis 150 s
REM auf, und ein neu gestartetes start.cmd steht per cd /d in LIVE und liesse das
REM move scheitern. Stop-ScheduledTask allein verhindert keinen anstehenden
REM Neustart. Wieder aktiv wird die Aufgabe durch install-task.ps1 im alten setup.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Disable-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue | Out-Null; Stop-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue; foreach ($i in 1..15) { if ((Get-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue).State -ne 'Running') { break }; Start-Sleep -Seconds 1 }"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'backend\\server\.js' } | Invoke-CimMethod -MethodName Terminate | Out-Null; Start-Sleep -Seconds 2"
if exist "%FAILED%" rmdir /s /q "%FAILED%"
if exist "%FAILED%" goto :rollback_hand
move "%LIVE%" "%FAILED%" >nul
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :rollback_hand
move "%OLD%" "%LIVE%" >nul
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :rollback_hand
REM Den Abzug zur Seite legen: ein zweiter Versuch schriebe sonst einen neuen
REM klima-vor-update.db ueber den Stand vor diesem Versuch.
if exist "%ABZUG%" move /y "%ABZUG%" "%ABZUG_FEHL%" >nul
if exist "%ABZUG%" echo WARNUNG: %ABZUG% liess sich nicht umbenennen. Vor einem neuen Versuch von Hand wegsichern.
echo ==^> Vorherige Version wieder einrichten (ihr eigenes setup.ps1 -Bundled)
powershell -NoProfile -ExecutionPolicy Bypass -File "%LIVE%\deploy\windows\setup.ps1" -Bundled
set "RC=%errorlevel%"
echo.
if %RC% EQU 0 echo ROLLBACK abgeschlossen: die vorherige Version laeuft wieder. Die gescheiterte liegt in "%FAILED%".
if not %RC% EQU 0 echo ROLLBACK unvollstaendig: auch die vorherige Version startet nicht, Exit-Code %RC%. Log: C:\ProgramData\TestoSmartAbruf\logs\app.log
echo.
pause
exit /b 1

:rollback_hand
echo.
echo FEHLER: Der ROLLBACK blieb stehen, ein Ordner ist gesperrt. Die Aufgabe %TASKNAME% ist deaktiviert.
echo Von Hand in einer Admin-Eingabeaufforderung, sobald darin nichts mehr laeuft:
echo   rmdir /s /q "%FAILED%"
echo   move "%LIVE%" "%FAILED%"
echo   move "%OLD%" "%LIVE%"
echo   powershell -ExecutionPolicy Bypass -File "%LIVE%\deploy\windows\setup.ps1" -Bundled
echo Die ersten beiden Schritte nur, solange "%LIVE%" noch die neue Version enthaelt.
echo.
pause
exit /b 1

:ohne_vorversion
echo Keine vorherige Version vorhanden, Erstinstallation: kein Rollback moeglich.
echo Log: C:\ProgramData\TestoSmartAbruf\logs\app.log
echo.
pause
exit /b 1

:umschaltfehler
echo FEHLER beim Umschalten - zurueck auf die vorherige Version.
if not exist "%OLD%" goto :abbruch_nach_stopp
move "%OLD%" "%LIVE%" >nul
set "RC=%errorlevel%"
if %RC% EQU 0 goto :abbruch_nach_stopp
echo FEHLER: Auch das Zurueckschieben scheiterte. Von Hand in einer Admin-Eingabeaufforderung:
echo   move "%OLD%" "%LIVE%"
echo   schtasks /Run /TN %TASKNAME%
echo.
pause
exit /b 1

:abbruch_nach_stopp
if exist "%STAGE%" rmdir /s /q "%STAGE%" 2>nul
echo ==^> Vorherige Version wieder starten
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-ScheduledTask -TaskName '%TASKNAME%' -ErrorAction SilentlyContinue"
echo Abbruch, vorherige Version unveraendert.
echo.
pause
exit /b 1

:abzugfehler
echo FEHLER: Datenbank-Abzug gescheitert, der Dienst laeuft unveraendert weiter.
if exist "%ABZUG%.tmp" del /f /q "%ABZUG%.tmp" 2>nul
goto :abbruch

:stagefehler
echo FEHLER: %STAGE% laesst sich nicht anlegen oder haerten.
goto :abbruch

:kopierfehler
echo FEHLER: Kopieren ins Staging fehlgeschlagen, robocopy-Code %RC%.
goto :abbruch

:abbruch
if exist "%STAGE%" rmdir /s /q "%STAGE%" 2>nul
echo Abbruch, bestehende Installation unveraendert.
echo.
pause
exit /b 1

:notextracted
echo FEHLER: Dieses Fenster laeuft nicht aus einem vollstaendig entpackten Ordner.
echo Bitte die ZIP zuerst per Rechtsklick "Alle extrahieren" entpacken und dann
echo install.cmd im entpackten Ordner doppelklicken (NICHT direkt aus der ZIP).
pause & exit /b 1
