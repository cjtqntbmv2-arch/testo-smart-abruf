# Windows-Schnellinstallation — `setup.ps1`-Orchestrator — Design / Spec

- **Datum:** 2026-06-23
- **Status:** Entwurf (Design mit Nutzer abgestimmt, nach Grilling überarbeitet)
- **Betrifft:** Ein neues `deploy/windows/setup.ps1` (+ doppelklickbarer `setup.cmd`-Launcher), das die heute manuellen Inbetriebnahme-Schritte zu **einem** Admin-Aufruf bündelt.
- **Voraussetzung-Spec:** [2026-06-22-windows-service-design.md](2026-06-22-windows-service-design.md) (Dienstbetrieb als geplanter Task / NetworkService, geliefert in v0.10.0).

---

## 1. Kontext & Ziel

Die Windows-Inbetriebnahme als login-unabhängiger Hintergrund-Task ist seit v0.10.0 vollständig gebaut und dokumentiert ([deploy/windows/README.md](../../../deploy/windows/README.md)). Das vorhandene [install-task.ps1](../../../deploy/windows/install-task.ps1) automatisiert bereits **Datenordner, ACLs (SID `*S-1-5-20`) und Task-Registrierung** — idempotent, mit `-WhatIf`-Trockenlauf.

**Manuell** bleiben heute: Node-Version prüfen, `npm ci --omit=dev` auf der Zielmaschine, Pfad-/Konsistenz-Validierung, Task starten, Liveness prüfen. Diese Schritte sind über die README verteilt und je einzeln eine Fehlerquelle (falsche Node-Version → kein Prebuild; Pfad mit Leerzeichen → Task-Action scheitert; UNC-Pfad → WAL bricht).

**Ziel:** Ein `setup.ps1`, das diese Lücken plus den Aufruf von `install-task.ps1` zu einem einzigen, fail-fast, re-run-sicheren Admin-Aufruf bündelt. Es **ersetzt `install-task.ps1` nicht**, sondern ruft es auf — die bewährte Task-Logik bleibt unangetastet.

**Ausdrücklich NICHT im Umfang (mit Nutzer geklärt — YAGNI):**
- **Kein Auto-Install von Node.** Bei fehlendem/falschem Node nur prüfen & abbrechen mit Anleitung (winget-Befehl + Download-Link).
- **Kein API-Key-Seeding.** Der Key wird wie heute im Dashboard unter Einstellungen eingetragen; `setup.ps1` fasst ihn nie an. Der Smoke-Check **meldet** lediglich, ob bereits ein Key konfiguriert ist (`api.apiKeyConfigured`), und weist sonst auf den Dashboard-Schritt hin.
- **Kein Editieren von `PORT`/`HOST`/`DB_PATH`.** Diese bleiben Single Source of Truth in [start.cmd](../../../deploy/windows/start.cmd); kein fragiles Rewriting.
- **Keine Firewall-/LAN-Regel.** Bleibt opt-in und dokumentiert.
- **Kein Proxy-Setup.** Nur Hinweis bei `npm ci`-Fehler + README-Troubleshooting.
- **Kein gepacktes Binary/MSI** (verworfen, s. §3).

## 2. Constraints

| Constraint | Wert |
|---|---|
| Bestehende Skripte | [install-task.ps1](../../../deploy/windows/install-task.ps1), [uninstall-task.ps1](../../../deploy/windows/uninstall-task.ps1), [start.cmd](../../../deploy/windows/start.cmd) bleiben **unverändert** |
| EDR-Regel | „Nichts Überraschendes": **kein neues gebündeltes Binary**, keine überraschenden Netzwerkaufrufe by-default, keine Build-Tools auf dem Ziel (CLAUDE.md) |
| Node | Pflicht **x64**, Major ∈ {22, 24, 26}; **23/25 nicht** (kein win32-x64-Prebuild für better-sqlite3) |
| Install-Pfad | **ohne Leerzeichen** (schließt `C:\Program Files\…` mit ein), **lokale Platte** (kein UNC/Netzlaufwerk — WAL) |
| Pfad-Bildung | nur `Join-Path`/`$PSScriptRoot`; keine hartkodierten Unix-Pfade oder `/`-Konkatenation |
| Idempotenz | re-run-sicher; **stoppt zuerst einen laufenden Dienst** (sonst Datei-Lock/`EADDRINUSE`); dient zugleich als Update-Pfad nach `git pull` |
| Elevation | `setup.cmd` self-elevating (UAC); `setup.ps1` trägt `#Requires -RunAsAdministrator` → **auch `-WhatIf` braucht eine Admin-Shell** (in README dokumentiert) |
| Status-API | Feld heißt `appVersion` (nicht `version`); Liveness über `scheduler.lastSyncStatus` + `storage.status`; `api.apiKeyConfigured` für Key-Hinweis (`database.status` ist hartkodiert `ok` → nicht als Health ausgeben) |
| Sprache | deutsche Konsolenausgaben (wie README) |
| Entwicklung/Test | Entwicklung auf macOS (`pwsh` dort nicht installiert); verlässlicher Funktionsnachweis nur per Content-Review + `-WhatIf` + manueller Abnahme auf Windows-11-x64 |

## 3. Gewählter Ansatz & verworfene Alternativen

**Gewählt (Ansatz A): PowerShell-Orchestrator `setup.ps1` + dünner self-elevating `setup.cmd`-Launcher.** Klartext, auditierbar, kein neues Binary, ruft dieselben Bausteine (`npm ci`, `install-task.ps1`) wie der manuelle Weg. Passt exakt zur EDR-„nichts Überraschendes"-Regel und ist von macOS aus per Content-Review + `-WhatIf` prüfbar.

**Verworfen:**
- **Ansatz B — gepacktes `.exe`/MSI (Inno Setup/NSIS).** Wizard-Komfort, aber: neues gebündeltes Binary (verstößt gegen die EDR-Regel), braucht ein Build-Toolchain, lässt sich von macOS aus weder bauen noch testen.
- **Ansatz C — minimaler `.cmd`-Batch-Wrapper.** Doppelklickbar, aber Batch ist schwach bei Preflight-Logik, Fehlerbehandlung und Self-Elevation und müsste für die Task-Registrierung ohnehin PowerShell aufrufen. (Der dünne `setup.cmd`-Launcher aus Ansatz A übernimmt nur die Elevation, keine Logik.)

## 4. Aufrufe

```powershell
# doppelklickbar (self-elevating via UAC) ODER aus Admin-Shell:
.\deploy\windows\setup.cmd
powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1

# Trockenlauf (Preflight + geplante Änderungen) — ebenfalls aus einer ADMIN-Shell:
powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1 -WhatIf

# Re-Run ohne Dependency-Neuinstallation (Update-Pfad, wenn package-lock unverändert):
powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1 -SkipNpm
```

`setup.cmd` ist **nur für den interaktiven (Doppelklick-)Pfad** — es endet mit `pause` und propagiert keinen Exit-Code. Für Automatisierung `setup.ps1` direkt via `-File` aufrufen und `$LASTEXITCODE` prüfen.

## 5. Ablauf von `setup.ps1` (Reihenfolge = fail-fast, 5 Phasen)

Phasen laufen strikt der Reihe nach; **Phase 1 (Preflight) ändert nichts** — schlägt eine Prüfung fehl, bricht das Skript ab, bevor irgendetwas am System verändert wird (kein halb-installierter Zustand). Außerhalb `-WhatIf` läuft ein `Start-Transcript` nach `<DataDir>\logs\setup.log` (best effort), damit auch ein im elevierten Fenster verlorener Lauf nachvollziehbar bleibt.

### Phase 1 — Preflight (nur prüfen)
1. **Node:** via `Get-Command node` vorhanden; `node -v` per Regex `^v(\d+)\.` geparst, Major ∈ {22, 24, 26}; `node -p process.arch` == `x64`. Sonst exakter `winget install OpenJS.NodeJS.LTS` + Download-Link, **Abbruch**.
2. **npm:** via `Get-Command npm` vorhanden.
3. **AppRoot-Pfad:** **keine Leerzeichen** (deckt `C:\Program Files\…` mit ab). Sonst Abbruch.
4. **Lokale Platte:** kein UNC (`\\…`); `Win32_LogicalDisk.DriveType == 4` (Netz) → Abbruch. Lässt sich der Typ nicht ermitteln → **Warnung** (best-effort, kein harter Garant).
5. **Konsistenz-Check:** `DB_PATH`-Ordner aus `start.cmd` == `-DataDir`? Bei Abweichung **Warnung** (kein Abbruch).

### Phase 2 — Laufenden Dienst stoppen (Update-Pfad)
6. Existiert der Task und ist `State -eq 'Running'` → `Stop-ScheduledTask` (beendet den Prozessbaum), dann bis zu ~20 s pollen, bis der State nicht mehr `Running` ist, + 2 s Grace für Datei-/Port-Freigabe. Sonst Hinweis „kein laufender Dienst". Unter `-WhatIf` nur angekündigt. **Verhindert** Datei-Lock auf `better_sqlite3.node` beim `npm ci` und `EADDRINUSE` beim Neustart.

### Phase 3 — Dependencies
7. **`npm ci --omit=dev`** im AppRoot (in `ShouldProcess` gekapselt; Fehler → `catch` → freundliches `Fail` inkl. der drei bekannten Ursachen: falsche Node-Version, `github.com` geblockt, Datei-Lock durch laufenden node).
8. **Prebuild-Verifikation (immer, auch unter `-SkipNpm`; nicht unter `-WhatIf`):** `node_modules\better-sqlite3\build\Release\better_sqlite3.node` existiert **und** `node -e "require('better-sqlite3')"` lädt fehlerfrei. Sonst Abbruch (falsche Node-Version / `github.com` geblockt / kopierte `node_modules` = ABI-Mismatch).

### Phase 4 — Dienst registrieren
9. **`install-task.ps1` aufrufen** (Parameter `-DataDir`/`-TaskName`/`-WhatIf` durchgereicht; `try/catch` → `Fail`). Legt Datenordner, ACLs, Task an (unverändert).

### Phase 5 — Start & Verifikation
10. **Task starten:** `Start-ScheduledTask`.
11. **Smoke-Check:** `GET http://127.0.0.1:<port>/api/system/status` (explizit IPv4, nicht `localhost` → kein `::1`-Refuse) mit Polling (30 × 2 s = ~60 s). Bei Erfolg ausgeben: `appVersion`, `scheduler.lastSyncStatus`, `storage.status`, `api.apiKeyConfigured` (sonst „API-Key noch nicht konfiguriert → Dashboard"), Dashboard-URL, DB-/Log-Pfad. Bei Misserfolg `Get-ScheduledTaskInfo.LastTaskResult` ausgeben + Orphan-node-Hinweis, dann `Fail`. `<port>` aus `start.cmd`, Fallback 3000.

> Der Smoke-Check ist die maschinelle Entsprechung der ersten §9-Basisbetrieb-Punkte. Die **finale Abnahme** (Reboot-ohne-Login, CSV-Export, Monats-Backup) bleibt der manuelle §9-Durchlauf aus der README.

## 6. Dateien

| Datei | Status | Inhalt |
|---|---|---|
| `deploy/windows/setup.ps1` | **neu** | Orchestrator (§5). `#Requires -RunAsAdministrator`, `[CmdletBinding(SupportsShouldProcess)]`, Parameter `-DataDir`, `-TaskName`, `-SkipNpm`, `-WhatIf`. `Start-Transcript`-Eigenlog. |
| `deploy/windows/setup.cmd` | **neu** | Dünner self-elevating Launcher (nur interaktiv): Admin-Check, ggf. UAC-Relaunch (leeres-`%*` separat behandelt), `cd /d "%~dp0"`, ruft `setup.ps1`, `pause`. |
| `deploy/windows/install-task.ps1` | unverändert | wird von `setup.ps1` aufgerufen |
| `deploy/windows/uninstall-task.ps1` | unverändert | Deinstallation |
| `deploy/windows/start.cmd` | unverändert | Single Source of Truth für `PORT`/`HOST`/`DB_PATH` |
| `deploy/windows/README.md` | **ergänzt** | Abschnitt „Schnellinstallation per `setup.ps1`" vor der manuellen Anleitung; Troubleshooting (SmartScreen/`Unblock-File`, GPO `AllSigned`, npm-Proxy); §9-Fix (`appVersion`/0.13.0) |

## 7. Parameter von `setup.ps1`

| Parameter | Default | Wirkung |
|---|---|---|
| `-DataDir` | `C:\ProgramData\TestoSmartAbruf` | an `install-task.ps1` durchgereicht; Konsistenz-Check gegen `start.cmd`; Ort des `setup.log` |
| `-TaskName` | `TestoSmartAbruf` | an `install-task.ps1` durchgereicht; Ziel von Stop/Start |
| `-SkipNpm` | (aus) | Phase 3 `npm ci` überspringen (Prebuild-Check läuft trotzdem) |
| `-WhatIf` | (aus) | Trockenlauf: Phase 1 läuft, Phasen 2–5 zeigen nur geplante Änderungen |

`AppRoot` wird aus `$PSScriptRoot\..\..` abgeleitet, nicht als Parameter.

## 8. Fehlerbehandlung

- `$ErrorActionPreference = 'Stop'`; jede Abbruchstelle geht über `Fail` (rote Meldung + `Stop-Transcript` + `exit 1`, für Logs/Automatisierung erkennbar).
- Preflight-Fehler brechen ab, **bevor** etwas verändert wird.
- `npm ci`/Prebuild-Fehler werden mit den bekannten Ursachen erklärt (s. Phase 3).
- Node-Erkennung über `Get-Command` (nicht über native-Command-Exceptions, die in PS 5.1 nicht zuverlässig werfen); Versions-Parse per Regex (kein crashender `[int]`-Cast).

## 9. Idempotenz / Update-Pfad

Re-run-sicher: Phase 2 stoppt zuerst einen laufenden Dienst, danach ist `npm ci` idempotent und `install-task.ps1` re-registriert den Task. `setup.ps1` ist damit zugleich der **Update-Pfad** nach `git pull`: erneut ausführen (mit `-SkipNpm`, wenn `package-lock.json` unverändert).

## 10. Test / Verifikation

Entwicklung auf macOS, Ziel Windows — ehrliche Abstufung:
- **Statisch:** `PSScriptAnalyzer`/`pwsh`-Syntaxparse (falls `pwsh` vorhanden) + Content-Review gegen die Windows-Guardrails aus CLAUDE.md (`Join-Path`, kein `/`, `%*`-Korrektheit im Launcher).
- **Trockenlauf:** `setup.ps1 -WhatIf` (aus Admin-Shell) — Phase 1 läuft, Phasen 2–5 zeigen geplante Änderungen.
- **Echte Abnahme:** ein manueller `setup.ps1`-Lauf auf Windows-11-x64, anschließend der §9-Durchlauf. Einziger verlässlicher Funktionsnachweis.

## 11. Release / Versionierung

Reine Tooling-Ergänzung im `deploy/windows/`-Pfad (kein App-/Frontend-Code), aber release-würdig (neues Deployment-Feature) → **MINOR-Bump** auf `0.13.0`. Dieses Repo hält **alle** Versionsorte im Gleichschritt (genau das prüft §9 der README) — daher gemeinsam gebumpt: `VERSION`, README-Badge, `package.json` **und alle 12 `?v=`-Cache-Buster** in `Klima Dashboard.html`. Anschließend annotierter Tag `v0.13.0`; **kein Push** (lokales Repo ohne Remote).

In **denselben** README-Edits wird der §9-Doku-Fehler mitkorrigiert (im Plan, Task 4): Die Akzeptanz nennt das Status-Feld „`version`"; tatsächlich heißt der JSON-Key `appVersion` ([server.js:406](../../../backend/server.js)) — Feldname **und** Wert (→ `0.13.0`) werden korrigiert, damit ein IT-Admin nach §9 nicht auf ein nicht existierendes Feld prüft.
