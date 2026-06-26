@echo off
REM Self-elevating Launcher fuer setup.ps1 - NUR fuer interaktiven Doppelklick/Aufruf.
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
