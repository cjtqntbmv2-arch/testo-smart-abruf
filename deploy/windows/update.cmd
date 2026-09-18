@echo off
REM ====================================================================
REM  update.cmd - aktualisiert testo-smart-abruf aus dem Ablageordner.
REM
REM  Gehoert in den ABLAGEORDNER neben die Release-ZIPs, also in den Ordner,
REM  der in den Einstellungen als Ablageordner eingetragen ist, nicht in die
REM  Installation. Die IT legt die Datei einmal dorthin; ausgeliefert wird sie
REM  im Bundle unter deploy\windows\. Der Dienst startet sie nie selbst.
REM
REM  Ablauf: Rechte erhoehen, das INSTALLIERTE Programm waehlt die Fassung,
REM  bestaetigen, ZIP lokal kopieren, pruefen und entpacken, dann install.cmd
REM  der neuen Fassung: DB-Abzug, Staging, Umschalten, Rollback.
REM
REM  Braucht eine installierte Fassung ab 0.18.0, erst sie hat die Pruefung
REM  per Kommandozeile. Aeltere Fassungen einmalig von Hand aktualisieren.
REM  Exit-Code: 0 = aktualisiert oder nichts zu tun, 1 = Fehler oder Abbruch.
REM ====================================================================
setlocal EnableExtensions DisableDelayedExpansion
set "LIVE=C:\Apps\TestoSmartAbruf"
set "WORK=%LIVE%.update"
set "TAR=%SystemRoot%\System32\tar.exe"

REM --- 1. Ablageordner bestimmen, Laufwerksbuchstaben IMMER auf UNC umschreiben ---
REM Der erhoehte Prozess sieht die Netzlaufwerke des Benutzers nicht, deshalb vor
REM der Rechteerhoehung. Auch ohne Erhoehung, damit die Umschreibung in der CI
REM mitlaeuft: Runner arbeiten als Admin ohne UAC und ueberspringen den Zweig.
REM -Filter statt Where-Object: sonst fragte WMI jedes Laufwerk ab, auch ein
REM totes Netzlaufwerk. Eingabe aus NUL: die umgeleitete Eingabe der CI gehoert
REM der J/N-Abfrage, PowerShell soll sie nicht mitlesen.
set "SRC=%~dp0"
set "DRV=%SRC:~0,2%"
set "UNCROOT="
if "%SRC:~1,1%"==":" for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_LogicalDisk -Filter ('DeviceID=' + [char]39 + $env:DRV + [char]39)).ProviderName" ^<nul 2^>nul`) do set "UNCROOT=%%P"
if defined UNCROOT set "SRC=%UNCROOT%%SRC:~2%"

echo.
echo  testo-smart-abruf: Update aus dem Ablageordner
echo  Ablageordner: "%SRC%"
echo.

REM --- Rechte erhoehen: Neustart per cmd /k auf den UNC-Pfad ---
REM /k statt /c: kann der erhoehte Prozess die Freigabe nicht lesen, etwa ein
REM lokales Admin-Konto ohne Domaenenanmeldung (LAPS), bleibt die Meldung
REM stehen, statt dass sich das Fenster wortlos schliesst. Das Argument ERHOEHT
REM verhindert eine Endlosschleife, falls net session auch erhoeht scheitert.
REM Anfuehrungszeichen per [char]34: in -Command duerfen keine stehen, und
REM Start-Process quotet in PowerShell 5.1 nicht selbst.
net session >nul 2>&1
set "RC=%errorlevel%"
if %RC% EQU 0 goto :admin
if /i "%~1"=="ERHOEHT" goto :keinadmin
echo  Administrator-Rechte werden angefordert...
set "SELF=%SRC%%~nx0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$q = [char]34; Start-Process -FilePath $env:ComSpec -WorkingDirectory $env:SystemRoot -ArgumentList ('/k ' + $q + $q + $env:SELF + $q + ' ERHOEHT' + $q) -Verb RunAs"
set "RC=%errorlevel%"
if %RC% EQU 0 exit /b 0
echo  FEHLER: Rechteerhoehung abgelehnt oder gescheitert. Nichts geaendert.
goto :ende_fehler

:admin
cd /d "%SystemRoot%"

REM --- 2. Nicht aus einer Installation oder einem entpackten Bundle starten ---
REM Dort liegt update.cmd unter deploy\windows\, und install.cmd verschoebe beim
REM Umschalten den Ordner, aus dem diese Batch gerade liest.
if exist "%SRC%..\..\backend\update-check.js" goto :falscherort

REM --- 3. Installation vorhanden? ---
if not exist "%LIVE%\node.exe" goto :keineinstallation

REM --- 4. Arbeitsordner frisch anlegen und sofort haerten ---
REM Leeren, weil Reste eines alten bundle\ die VERSION-Pruefung bestuenden und
REM robocopy /E sie nach LIVE truege. rmdir meldet Teilfehler nicht, daher die
REM zweite Pruefung. Haerten, weil ein neuer Ordner unter C:\ fuer
REM Authentifizierte Benutzer beschreibbar ist und von hier Code mit Adminrechten
REM laeuft. Erst haerten, dann bundle anlegen: so erbt es die gehaertete ACL.
if exist "%WORK%" rmdir /s /q "%WORK%"
if exist "%WORK%" goto :workfehler
md "%WORK%"
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :workfehler
icacls "%WORK%" /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" >nul
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :workfehler
md "%WORK%\bundle"
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :workfehler

REM --- 5. Das INSTALLIERTE Programm waehlt die Fassung ---
REM Dieselbe Regel wie beim Dienst: Namensmuster, numerischer Vergleich, 0-Byte-
REM Dateien uebergangen. Keine zweite Kopie davon in cmd. Der Punkt hinter SRC ist
REM Pflicht: SRC endet auf einen Backslash, und der maskierte sonst das folgende
REM Anfuehrungszeichen. Exit-Codes: 0 = neuere Fassung, 10 = nichts Neueres,
REM 2 = Ordner nicht lesbar, 3 = Aufruf oder eigene Version. Alles andere ist ein
REM Absturz, Node endet dann mit 1. Deshalb nur per EQU vergleichen: errorlevel 1
REM hiesse "mindestens 1" und liesse negative Absturzcodes als Erfolg durch.
"%LIVE%\node.exe" "%LIVE%\backend\update-check.js" --check-update "%SRC%." --pick-file "%WORK%\pick.txt"
set "RC=%errorlevel%"
if %RC% EQU 10 goto :nichtszutun
if %RC% EQU 0 goto :gewaehlt
if %RC% EQU 2 goto :ordnerfehler
if %RC% EQU 3 goto :aufruffehler
goto :clifehler

:gewaehlt
REM Eine Fassung vor 0.18.0 kennt das CLI nicht: update-check.js endet dann still
REM mit 0 und schreibt keine Uebergabedatei. Ohne Version UND Dateinamen gilt die
REM Installation deshalb als zu alt.
set "PICKVER="
set "PICKFILE="
if exist "%WORK%\pick.txt" for /f "usebackq tokens=1,2" %%A in ("%WORK%\pick.txt") do (
  set "PICKVER=%%A"
  set "PICKFILE=%%B"
)
if not defined PICKFILE goto :zualt

REM --- 6. Bestaetigen ---
REM set /p laesst die Variable bei leerer Eingabe unveraendert: vorher leeren.
echo.
echo  Neue Fassung: %PICKVER%   Datei: %PICKFILE%
echo  Der Dienst wird dafuer kurz gestoppt. Vorher sichert install.cmd die Datenbank.
echo.
set "ANTWORT="
set /p "ANTWORT=Jetzt installieren? [J/N] "
if /i not "%ANTWORT%"=="J" goto :abgebrochen

REM --- 7. Kopieren und pruefen, BEVOR entpackt wird ---
echo.
echo ==^> Kopiere %PICKFILE%
copy /y "%SRC%%PICKFILE%" "%WORK%\%PICKFILE%" >nul
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :kopierfehler

REM install.cmd, node.exe und VERSION muessen in der ZIP-WURZEL stehen. Das faengt
REM eine ZIP in der ZIP, einen Oberordner und eine abgebrochene Kopie ab. Exakter
REM Vergleich je Zeile per for /f, nicht per findstr /x: /x trifft nur vor einem CR
REM und scheitert bei reinen LF-Zeilenenden immer. for /f entfernt das CR.
"%TAR%" -tf "%WORK%\%PICKFILE%" > "%WORK%\inhalt.txt"
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :zipdefekt
set "HAT_INSTALL="
set "HAT_NODE="
set "HAT_VERSION="
for /f "usebackq delims=" %%L in ("%WORK%\inhalt.txt") do (
  if /i "%%L"=="install.cmd" set "HAT_INSTALL=1"
  if /i "%%L"=="node.exe" set "HAT_NODE=1"
  if /i "%%L"=="VERSION" set "HAT_VERSION=1"
)
if not defined HAT_INSTALL goto :zipfalsch
if not defined HAT_NODE goto :zipfalsch
if not defined HAT_VERSION goto :zipfalsch

echo ==^> Entpacke nach "%WORK%\bundle"
"%TAR%" -xf "%WORK%\%PICKFILE%" -C "%WORK%\bundle."
set "RC=%errorlevel%"
if not %RC% EQU 0 goto :entpackfehler

REM VERSION der entpackten Fassung muss der gewaehlten entsprechen, sonst meldete
REM das Dashboard nach einem erfolgreichen Update weiter, es liege eine neue bereit.
REM for /f liest LF, CRLF und eine Datei ohne Zeilenende gleich.
set "NEUVER="
if exist "%WORK%\bundle\VERSION" for /f "usebackq delims=" %%V in ("%WORK%\bundle\VERSION") do if not defined NEUVER set "NEUVER=%%V"
if not "%NEUVER%"=="%PICKVER%" goto :versionfalsch

REM --- 8. install.cmd der NEUEN Fassung: DB-Abzug, Staging, Umschalten, Rollback ---
REM Die Rechte sind schon erhoeht, dessen net session greift also und oeffnet kein
REM zweites Fenster. install.cmd wechselt per cd /d in den Arbeitsordner: vor dem
REM Aufraeumen wieder heraus, sonst liesse er sich nicht loeschen.
echo.
echo ==^> Starte install.cmd der neuen Fassung
call "%WORK%\bundle\install.cmd"
set "RC=%errorlevel%"
cd /d "%SystemRoot%"
if not %RC% EQU 0 goto :installfehler
rmdir /s /q "%WORK%"
echo.
echo  Update auf %PICKVER% abgeschlossen.
goto :ende_ok

:keinadmin
echo  FEHLER: Keine Administrator-Rechte, auch nicht nach der Rechteerhoehung.
echo  Geprueft wird per net session - laeuft der Windows-Dienst Server?
goto :ende_fehler

:falscherort
echo  FEHLER: update.cmd gehoert in den Ablageordner neben die Release-ZIPs,
echo  nicht in eine Installation oder ein entpacktes Bundle. Bitte dorthin
echo  kopieren und dort starten.
goto :ende_fehler

:keineinstallation
echo  FEHLER: Keine Installation unter "%LIVE%" gefunden.
echo  Neuinstallation: die Release-ZIP entpacken und darin install.cmd starten.
goto :ende_fehler

:workfehler
echo  FEHLER: Der Arbeitsordner "%WORK%" laesst sich nicht frisch anlegen.
echo  Haelt ein Fenster oder Programm ihn offen? Schliessen und erneut starten.
goto :ende_fehler

:nichtszutun
echo.
echo  Nichts zu tun: im Ablageordner liegt keine neuere Fassung.
rmdir /s /q "%WORK%" 2>nul
goto :ende_ok

:ordnerfehler
echo.
echo  FEHLER: Der Ablageordner ist nicht lesbar, Grund siehe oben.
goto :ende_fehler

:aufruffehler
echo.
echo  FEHLER: Die Pruefung der Installation meldet einen Aufruf- oder Versionsfehler, siehe oben.
goto :ende_fehler

:clifehler
echo.
echo  FEHLER: Die Pruefung der Installation ist unerwartet gescheitert, Exit-Code %RC%.
goto :ende_fehler

:zualt
echo.
echo  FEHLER: Die installierte Fassung ist aelter als 0.18.0 und kennt diese Pruefung noch nicht.
echo  Einmalig von Hand aktualisieren: die neue Release-ZIP entpacken und darin
echo  install.cmd starten. Jedes weitere Update geht dann ueber update.cmd.
goto :ende_fehler

:abgebrochen
echo.
echo  Abgebrochen, nichts geaendert.
goto :ende_fehler

:kopierfehler
echo  FEHLER: "%SRC%%PICKFILE%" liess sich nicht kopieren.
goto :ende_fehler

:zipdefekt
echo  FEHLER: %PICKFILE% laesst sich nicht lesen - defekt oder unvollstaendig in den Ablageordner kopiert?
goto :ende_fehler

:zipfalsch
echo  FEHLER: %PICKFILE% hat install.cmd, node.exe und VERSION nicht in der obersten Ebene.
echo  Eine ZIP in der ZIP oder ein Oberordner? Inhaltsliste: "%WORK%\inhalt.txt"
echo  Die ZIP im Ablageordner ist falsch gebaut - bitte die IT verstaendigen.
goto :ende_fehler

:entpackfehler
echo  FEHLER: Entpacken nach "%WORK%\bundle" gescheitert. Die Installation ist unveraendert.
goto :ende_fehler

:versionfalsch
echo  FEHLER: VERSION in der ZIP lautet "%NEUVER%", der Dateiname sagt "%PICKVER%".
echo  Die ZIP im Ablageordner ist falsch benannt oder gebaut - bitte die IT verstaendigen.
goto :ende_fehler

:installfehler
echo.
echo  FEHLER: install.cmd endete mit Exit-Code %RC%, Einzelheiten siehe oben.
echo  Der Arbeitsordner "%WORK%" bleibt zur Diagnose liegen.
goto :ende_fehler

:ende_ok
echo.
pause
exit /b 0

:ende_fehler
echo.
pause
exit /b 1
