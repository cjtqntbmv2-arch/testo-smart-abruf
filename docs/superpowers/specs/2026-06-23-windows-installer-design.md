# Windows-Schnellinstallation — `setup.ps1`-Orchestrator — Design / Spec

- **Datum:** 2026-06-23
- **Status:** Entwurf (Design mit Nutzer abgestimmt)
- **Betrifft:** Ein neues `deploy/windows/setup.ps1` (+ doppelklickbarer `setup.cmd`-Launcher), das die heute manuellen Inbetriebnahme-Schritte zu **einem** Admin-Aufruf bündelt.
- **Voraussetzung-Spec:** [2026-06-22-windows-service-design.md](2026-06-22-windows-service-design.md) (Dienstbetrieb als geplanter Task / NetworkService, geliefert in v0.10.0).

---

## 1. Kontext & Ziel

Die Windows-Inbetriebnahme als login-unabhängiger Hintergrund-Task ist seit v0.10.0 vollständig gebaut und dokumentiert ([deploy/windows/README.md](../../../deploy/windows/README.md)). Das vorhandene [install-task.ps1](../../../deploy/windows/install-task.ps1) automatisiert bereits **Datenordner, ACLs (SID `*S-1-5-20`) und Task-Registrierung** — idempotent, mit `-WhatIf`-Trockenlauf.

**Manuell** bleiben heute: Node-Version prüfen, `npm ci --omit=dev` auf der Zielmaschine, Pfad-/Konsistenz-Validierung, Task starten, Liveness prüfen. Diese Schritte sind über die README verteilt und je einzeln eine Fehlerquelle (falsche Node-Version → kein Prebuild; Pfad mit Leerzeichen → Task-Action scheitert; UNC-Pfad → WAL bricht).

**Ziel:** Ein `setup.ps1`, das diese Lücken plus den Aufruf von `install-task.ps1` zu einem einzigen, fail-fast, re-run-sicheren Admin-Aufruf bündelt. Es **ersetzt `install-task.ps1` nicht**, sondern ruft es auf — die bewährte Task-Logik bleibt unangetastet.

**Ausdrücklich NICHT im Umfang (mit Nutzer geklärt — YAGNI):**
- **Kein Auto-Install von Node.** Bei fehlendem/falschem Node nur prüfen & abbrechen mit Anleitung (winget-Befehl + Download-Link).
- **Kein API-Key-Seeding.** Der Key wird wie heute im Dashboard unter Einstellungen eingetragen; `setup.ps1` fasst ihn nie an.
- **Kein Editieren von `PORT`/`HOST`/`DB_PATH`.** Diese bleiben Single Source of Truth in [start.cmd](../../../deploy/windows/start.cmd); kein fragiles Rewriting.
- **Keine Firewall-/LAN-Regel.** Bleibt opt-in und dokumentiert.
- **Kein Proxy-Setup.** Nur Hinweis bei `npm ci`-Fehler.
- **Kein gepacktes Binary/MSI** (verworfen, s. §3).

## 2. Constraints

| Constraint | Wert |
|---|---|
| Bestehende Skripte | [install-task.ps1](../../../deploy/windows/install-task.ps1), [uninstall-task.ps1](../../../deploy/windows/uninstall-task.ps1), [start.cmd](../../../deploy/windows/start.cmd) bleiben **unverändert** |
| EDR-Regel | „Nichts Überraschendes": **kein neues gebündeltes Binary**, keine überraschenden Netzwerkaufrufe by-default, keine Build-Tools auf dem Ziel (CLAUDE.md) |
| Node | Pflicht **x64**, Major ∈ {22, 24, 26}; **23/25 nicht** (kein win32-x64-Prebuild für better-sqlite3) |
| Install-Pfad | **ohne Leerzeichen**, **nicht** unter `C:\Program Files`, **lokale Platte** (kein UNC/Netzlaufwerk — WAL) |
| Pfad-Bildung | nur `Join-Path`/`$PSScriptRoot`; keine hartkodierten Unix-Pfade oder `/`-Konkatenation |
| Idempotenz | re-run-sicher; dient zugleich als Update-Pfad nach `git pull` |
| Elevation | `setup.cmd` self-elevating (UAC); `setup.ps1` trägt `#Requires -RunAsAdministrator` |
| Sprache | deutsche Konsolenausgaben (wie README) |
| Entwicklung/Test | Entwicklung auf macOS, verlässlicher Funktionsnachweis nur per manueller Abnahme auf Windows-11-x64 |

## 3. Gewählter Ansatz & verworfene Alternativen

**Gewählt (Ansatz A): PowerShell-Orchestrator `setup.ps1` + dünner self-elevating `setup.cmd`-Launcher.** Klartext, auditierbar, kein neues Binary, ruft dieselben Bausteine (`npm ci`, `install-task.ps1`) wie der manuelle Weg. Passt exakt zur EDR-„nichts Überraschendes"-Regel und ist von macOS aus per Content-Review + `-WhatIf` prüfbar.

**Verworfen:**
- **Ansatz B — gepacktes `.exe`/MSI (Inno Setup/NSIS).** Wizard-Komfort, aber: neues gebündeltes Binary (verstößt gegen die EDR-Regel), braucht ein Build-Toolchain, lässt sich von macOS aus weder bauen noch testen. Müsste mit IT/EDR abgeklärt werden — zu viel Reibung für den Nutzen.
- **Ansatz C — minimaler `.cmd`-Batch-Wrapper.** Doppelklickbar, aber Batch ist schwach bei Preflight-Logik, Fehlerbehandlung und Self-Elevation und müsste für die Task-Registrierung ohnehin PowerShell aufrufen — faktisch eine schwächere Variante von A. (Der dünne `setup.cmd`-Launcher aus Ansatz A übernimmt nur die Elevation, keine Logik.)

## 4. Aufrufe

```powershell
# doppelklickbar (self-elevating via UAC) ODER aus Admin-Shell:
.\setup.cmd
powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1

# Trockenlauf (Preflight + geplante Änderungen, ohne sie anzuwenden):
powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1 -WhatIf

# Re-Run ohne Dependency-Neuinstallation (Update-Pfad, wenn package-lock unverändert):
powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1 -SkipNpm
```

## 5. Ablauf von `setup.ps1` (Reihenfolge = fail-fast)

Phasen laufen strikt der Reihe nach; **alle Preflight-Prüfungen (Phase 1) ändern nichts** — schlägt eine fehl, bricht das Skript ab, bevor irgendetwas am System verändert wird (kein halb-installierter Zustand).

### Phase 1 — Preflight (nur prüfen)
1. **Node vorhanden + Version + Architektur:** `node -v` muss existieren, Major ∈ {22, 24, 26}, `process.arch === 'x64'` (via `node -p "process.arch"`). Sonst: exakter `winget install OpenJS.NodeJS.LTS`-Befehl + manueller Download-Link ausgeben, **Abbruch**.
2. **npm vorhanden:** `npm -v` muss existieren.
3. **AppRoot-Pfad:** **keine Leerzeichen** und **nicht** unter `C:\Program Files`. Sonst Abbruch mit Begründung (Task-Action / Read-only-Risiko).
4. **Lokale Platte:** AppRoot kein UNC (`\\…`) und kein Netzlaufwerk (DriveType prüfen). Sonst Abbruch (WAL bricht auf Netzlaufwerken).
5. **Konsistenz-Check:** Der in [start.cmd](../../../deploy/windows/start.cmd) gesetzte `DB_PATH`/`LOGDIR`-Ordner muss mit `-DataDir` übereinstimmen. Bei Abweichung **Warnung** (kein Abbruch) mit Hinweis, beide anzugleichen.

### Phase 2 — Dependencies
6. **`npm ci --omit=dev`** im AppRoot.
7. **Prebuild-Verifikation:** prüfen, dass `node_modules\better-sqlite3\build\Release\better_sqlite3.node` existiert **und** `node -e "require('better-sqlite3')"` ohne Fehler durchläuft. Schlägt das fehl → die zwei bekannten Ursachen erklären (falsche Node-Version → kein Prebuild; `github.com`/`objects.githubusercontent.com` nicht erreichbar → Proxy/Allowlist), **Abbruch**.

### Phase 3 — Dienst registrieren
8. **`install-task.ps1` aufrufen**, Parameter `-DataDir`/`-TaskName`/`-WhatIf` durchgereicht. Legt Datenordner, ACLs, Task an (unverändert).

### Phase 4 — Start & Verifikation
9. **Task starten:** `Start-ScheduledTask -TaskName <TaskName>`.
10. **Smoke-Check:** `GET http://localhost:<port>/api/system/status` mit Polling (Timeout ~30 s). Bei Erfolg Kurz-Zusammenfassung ausgeben: erreichbar ja/nein, `version`, `scheduler`/`db`/`storage`-Status, DB-Pfad, Log-Pfad. Danach die Dashboard-URL anzeigen (**kein** Auto-Browser im Dienstkontext). `<port>` wird aus `start.cmd` gelesen, Fallback 3000.

> Der Smoke-Check ist die maschinelle Entsprechung der ersten §9-Basisbetrieb-Punkte. Die **finale Abnahme** (Reboot-ohne-Login, CSV-Export, Monats-Backup) bleibt der manuelle §9-Durchlauf aus der README.

## 6. Dateien

| Datei | Status | Inhalt |
|---|---|---|
| `deploy/windows/setup.ps1` | **neu** | Orchestrator (§5). `#Requires -RunAsAdministrator`, `[CmdletBinding(SupportsShouldProcess)]`, Parameter `-DataDir`, `-TaskName`, `-SkipNpm`, `-WhatIf`. |
| `deploy/windows/setup.cmd` | **neu** | Dünner self-elevating Launcher: prüft Admin, startet sich bei Bedarf via UAC neu, ruft dann `powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*`. Nur Elevation, keine Logik. |
| `deploy/windows/install-task.ps1` | unverändert | wird von `setup.ps1` aufgerufen |
| `deploy/windows/uninstall-task.ps1` | unverändert | Deinstallation |
| `deploy/windows/start.cmd` | unverändert | Single Source of Truth für `PORT`/`HOST`/`DB_PATH` |
| `deploy/windows/README.md` | **ergänzt** | neuer Abschnitt „Schnellinstallation per `setup.ps1`" **vor** der bestehenden manuellen Schritt-für-Schritt-Anleitung (die als Fallback/Transparenz bleibt) |

## 7. Parameter von `setup.ps1`

| Parameter | Default | Wirkung |
|---|---|---|
| `-DataDir` | `C:\ProgramData\TestoSmartAbruf` | an `install-task.ps1` durchgereicht; Konsistenz-Check gegen `start.cmd` |
| `-TaskName` | `TestoSmartAbruf` | an `install-task.ps1` durchgereicht |
| `-SkipNpm` | (aus) | Phase 2 überspringen (Update-Pfad, wenn Dependencies unverändert) |
| `-WhatIf` | (aus) | Trockenlauf: Phase 1 läuft, Phasen 2–4 zeigen nur geplante Änderungen |

`AppRoot` wird aus `$PSScriptRoot\..\..` abgeleitet (zwei Ebenen über `deploy\windows\`), nicht als Parameter.

## 8. Fehlerbehandlung

- `$ErrorActionPreference = 'Stop'`; Try/Catch je Phase; jede Abbruchstelle gibt **Ursache + nächster Schritt** aus und endet mit `exit 1` (für Logs/Automatisierung erkennbar).
- Preflight-Fehler brechen ab, **bevor** etwas verändert wird.
- `npm ci`/Prebuild-Fehler werden mit den zwei bekannten Ursachen erklärt (s. Phase 2).
- Gezielte Hinweise zu bekannten Stolpersteinen: verwaister `node.exe` belegt Port → `EADDRINUSE` (Hinweis: sauber per `Stop-ScheduledTask` stoppen / `taskkill`); AV-Lock auf frisch entpackter `.node` → `npm ci` wiederholen / AV-Ausnahme.

## 9. Idempotenz / Update-Pfad

Komplett re-run-sicher: `npm ci` ist idempotent, `install-task.ps1` entfernt+registriert den Task neu (bereits idempotent). Damit ist `setup.ps1` zugleich der **Update-Pfad** nach `git pull`: erneut ausführen (mit `-SkipNpm`, wenn `package-lock.json` unverändert). Wird in der README so dokumentiert.

## 10. Test / Verifikation

Entwicklung auf macOS, Ziel Windows — ehrliche Abstufung:
- **Statisch:** `PSScriptAnalyzer` über `setup.ps1`/`setup.cmd` (falls verfügbar) + Content-Review gegen die Windows-Guardrails aus CLAUDE.md (`Join-Path`, kein `/`, `%*`-Korrektheit im Launcher, `cross-env`-Konventionen bleiben gewahrt).
- **Trockenlauf:** `-WhatIf` läuft Phase 1 + zeigt geplante Änderungen, ohne sie anzuwenden — der Hauptschalter für risikoarmes Probieren.
- **Echte Abnahme:** ein manueller `setup.ps1`-Lauf auf Windows-11-x64, anschließend der §9-Durchlauf. Einziger verlässlicher Funktionsnachweis — wie beim restlichen Windows-Deployment.

## 11. Release / Versionierung

Reine Tooling-Ergänzung im `deploy/windows/`-Pfad (kein App-/Frontend-Code), aber release-würdig (neues Deployment-Feature) → **MINOR-Bump** auf `0.13.0`. Dieses Repo hält **alle** Versionsorte im Gleichschritt (genau das prüft §9 der README) — daher werden **gemeinsam** gebumpt: `VERSION`, README-Badge, `package.json` **und alle 12 `?v=`-Cache-Buster** in `Klima Dashboard.html`. Letztere zwingen zwar nur einen unnötigen Cache-Reload (keine `.jsx` geändert), bleiben aber lockstep, sonst schlägt der §9-Versionscheck fehl und die Konsistenzregel aus CLAUDE.md ist verletzt. Anschließend annotierter Tag `v0.13.0`; **kein Push** (lokales Repo ohne Remote).

> Außerdem als kleiner Folge-Fix vermerkt (nicht Teil dieses Plans): Die §9-Akzeptanz nennt das Status-Feld „`version`"; tatsächlich heißt der JSON-Key `appVersion` ([server.js:406](../../../backend/server.js)). Der Smoke-Check in `setup.ps1` liest korrekt `appVersion`.
