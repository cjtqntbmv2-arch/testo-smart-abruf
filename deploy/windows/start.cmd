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
