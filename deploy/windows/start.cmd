@echo off
REM Launcher fuer den testo-smart-abruf-Server, gestartet von der Windows-Aufgabenplanung
REM als NT AUTHORITY\NetworkService. Setzt die Prod-Env explizit (CWD- und .env-unabhaengig),
REM erzwingt UTF-8-Logs und startet den Node-Server im Vordergrund, damit der Task
REM als "wird ausgefuehrt" gilt (kein START, kein Self-Loop).

chcp 65001 >NUL

REM --- Konfiguration (von der IT anzupassen) ---
REM PORT/HOST kommen aus C:\Apps\TestoSmartAbruf\.env (ueberlebt Updates), NICHT
REM aus dieser Datei (wird beim Bundle-Update ueberschrieben). Sicherer Default
REM (HOST=127.0.0.1) liegt in backend/server.js.
set "DB_PATH=C:\ProgramData\TestoSmartAbruf\klima.db"
set "LOGDIR=C:\ProgramData\TestoSmartAbruf\logs"

REM App-Root = zwei Ebenen ueber diesem Script (deploy\windows\)
cd /d "%~dp0..\.."

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Log-Rotation beim Start: app.log mit Zeitstempel sichern (gegen Ueberschreiben
REM bei Crash-Loops) und auf die letzten 10 .bak begrenzen. Get-Date statt (in Win11
REM veraltetem) wmic; LOGDIR ist leerzeichenfrei -> keine Inline-Quotes noetig.
if exist "%LOGDIR%\app.log" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$d='%LOGDIR%'; $ts=Get-Date -Format yyyyMMddHHmmss; Move-Item -LiteralPath $d\app.log -Destination $d\app.${ts}.log.bak -Force; Get-ChildItem -LiteralPath $d -Filter app.*.log.bak | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue" >nul 2>&1
)

REM Gebuendeltes node.exe (Bundle) bevorzugen, sonst PATH-node (Quellcode-Betrieb)
set "NODE_EXE=node"
if exist "node.exe" set "NODE_EXE=.\node.exe"

"%NODE_EXE%" backend\server.js >> "%LOGDIR%\app.log" 2>&1
