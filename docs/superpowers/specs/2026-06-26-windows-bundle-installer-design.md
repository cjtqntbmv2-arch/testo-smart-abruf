# Windows-Bundle-Installer — Design

- **Datum:** 2026-06-26
- **Status:** freigegeben (Brainstorming abgeschlossen)
- **Bezug:** ersetzt den manuellen Setup-Pfad aus
  [deploy/windows/README.md](../../../deploy/windows/README.md) für den Regelfall
  (Laien-Installation); die Quellcode-/`npm ci`-Variante bleibt als Fallback.

## Problem

Die heutige Windows-Inbetriebnahme verlangt vom Bediener zu viel:

1. **Node.js 24 x64 selbst installieren** und **`npm ci` ausführen** — letzteres lädt
   den `better-sqlite3`-Prebuild von `github.com`, was im Firmennetz häufig an
   Proxy/Firewall scheitert.
2. **Viele manuelle Einzelschritte** in fester Reihenfolge: Code holen (ohne
   `node_modules`) → Pfad ohne Leerzeichen wählen → Admin-PowerShell → mehrere
   Skripte → API-Key nachtragen.

Bestätigte Hauptschmerzen (Nutzer): **(1) Node + `npm ci`** und **(2) viele
manuelle Schritte**. Ziel: ein Ablauf, den ein Laie ohne Node-Kenntnisse und ohne
Internet-Build durchführen kann.

## Lösung (Überblick)

Ein **vorgebautes, portables Bundle**, gebaut **einmal pro Release auf
`windows-latest` via GitHub Actions**, veröffentlicht als ZIP auf der
GitHub-Releases-Seite. Der Bediener führt nur noch drei Aktionen aus:

> **ZIP von der Releases-Seite laden → entpacken (egal wohin) → `install.cmd`
> doppelklicken.** Danach einmalig den API-Key im Dashboard eintragen (der Browser
> öffnet sich automatisch).

Kein Node-Install, kein `npm ci`, keine Pfadregeln als Laien-Sorge.

## Komponenten

### 1. CI-Build — `.github/workflows/windows-bundle.yml` (neu)

- **Trigger:** Push eines Tags `v*` (passt zum bestehenden Versionierungs-Workflow).
- **Runner:** `windows-latest` (win32-x64 — Pflicht wegen der ABI-Regel: das
  `node_modules` mit dem nativen `better-sqlite3`-Prebuild **muss** auf win32-x64
  entstehen, nie von macOS/Linux kopiert werden).
- **Schritte:**
  1. `actions/setup-node` mit **gepinntem Node 24 x64** (entspricht `.nvmrc`/`engines`;
     22/24/26 erlaubt, 23/25 ausgeschlossen).
  2. `npm ci --omit=dev` — backt den win32-x64-Prebuild in `node_modules` ein.
     `puppeteer` (devDependency) bleibt dadurch außen vor.
  3. Verifikation: `node -e "require('better-sqlite3')"` lädt fehlerfrei (Prebuild,
     kein `node-gyp`-Build).
  4. Offizielles `node-v<24.x>-win-x64.zip` von nodejs.org laden und `node.exe`
     entnehmen (gleiche Major-Version → ABI-kompatibel zum Prebuild).
  5. Bundle-Verzeichnis zusammenstellen: App-Code (`backend/`, `Smart Meter
     Dashboard/`, `scripts/`, `package.json`, `VERSION`, `Klima Dashboard.html`-Pfad
     etc.) **+** `node_modules/` **+** `node.exe` **+** `deploy/windows/`
     **+** `install.cmd`. **Ausgeschlossen:** `.git/`, `docs/`, `spec/`,
     `testo-smart-connect-api/`, Tests sind optional (nicht nötig zur Laufzeit).
  6. `testo-smart-abruf-<version>-win-x64.zip` packen und als Release-Artefakt
     anhängen (`softprops/action-gh-release` o. ä.).

### 2. `install.cmd` (neu, liegt im Bundle, self-elevating)

Einstiegspunkt für den Bediener. Analog zum bestehenden `setup.cmd` (UAC-Self-Elevation),
aber für den Bundle-Fall:

1. UAC-Selbst-Elevation (wie `setup.cmd` heute).
2. **Mark-of-the-Web entfernen:** `Get-ChildItem -Recurse | Unblock-File` über das
   entpackte Bundle (gegen SmartScreen-Blockade der mitgelieferten `.ps1`).
3. **Bundle nach `C:\Apps\TestoSmartAbruf` kopieren** (fester, leerzeichenfreier
   Zielpfad). Quelle darf ein Pfad mit Leerzeichen sein (z. B.
   `C:\Users\Max Müller\Downloads\…`) — nur der **Task-Action-Zielpfad** muss
   leerzeichenfrei sein, und das ist `C:\Apps\TestoSmartAbruf`. Damit entfallen die
   Pfadregeln als Laien-Sorge.
   - Reihenfolge beim Update: erst laufenden Task stoppen, dann kopieren (Datei-Locks
     auf `node.exe`/`*.node` vermeiden). Das Stoppen übernimmt `setup.ps1` Phase 2 —
     d. h. `install.cmd` ruft `setup.ps1 -Bundled` **bevor** überschrieben wird, ODER
     stoppt den Task selbst vor dem Kopieren. **Entscheidung:** `install.cmd` stoppt
     den Task (falls vorhanden) vor dem Kopieren; `setup.ps1` Phase 2 bleibt als
     idempotenter Doppel-Stopp unschädlich.
4. Ruft `powershell -ExecutionPolicy Bypass -File C:\Apps\TestoSmartAbruf\deploy\windows\setup.ps1 -Bundled`.

### 3. `setup.ps1` — Schalter `-Bundled` (Erweiterung, kein Neubau)

Der bestehende 5-Phasen-Orchestrator wird wiederverwendet. Mit `-Bundled`:

- **Phase 1 (Preflight):** System-Node-Prüfung wird ersetzt durch Prüfung des
  **gebündelten `node.exe`** (existiert neben dem App-Root, Major 22/24/26, arch x64).
  Pfad-/UNC-/Netzlaufwerk-Checks bleiben (greifen jetzt auf `C:\Apps\TestoSmartAbruf`,
  also unkritisch).
- **Phase 3 (Dependencies):** `npm ci` entfällt. Nur der **Prebuild-Lade-Check** bleibt
  (`require('better-sqlite3')` über das gebündelte `node.exe`).
- **Phasen 2, 4, 5** (Stop / `install-task.ps1` / Start + Smoke-Check): unverändert.
- **Zusatz Phase 5:** nach erfolgreichem Smoke-Check `Start-Process "http://localhost:<port>"`
  — der Browser öffnet das Dashboard automatisch (Hinweis auf API-Key-Eingabe, falls
  noch keiner gesetzt — der Hinweis existiert bereits).

Ohne `-Bundled` verhält sich `setup.ps1` exakt wie heute (Quellcode-Pfad bleibt intakt).

### 4. `install-task.ps1` (unverändert)

Registriert den Task wie bisher (BootTrigger, `NetworkService`, ACLs via SID
`*S-1-5-20`). Zeigt auf `start.cmd` im (jetzt festen) App-Root.

### 5. `start.cmd` — Node-Auflösung (kleine Erweiterung)

Nutzt `node.exe` **neben sich** (im Bundle vorhanden), wenn vorhanden; sonst Fallback
auf PATH-`node`. So funktioniert `start.cmd` sowohl gebündelt als auch aus dem
Quellcode unverändert weiter. `PORT`/`DB_PATH`/`HOST`-Logik bleibt.

## Datenfluss / Ablauf

```
Release-Tag v* gepusht
  └─> GitHub Actions (windows-latest)
        └─> npm ci --omit=dev  →  node_modules (+ win32-x64 Prebuild)
        └─> node.exe entnehmen
        └─> ZIP packen  →  GitHub Release-Artefakt

Bediener
  └─> ZIP laden + entpacken (irgendwohin)
        └─> install.cmd (UAC)
              └─> Unblock-File
              └─> (Task ggf. stoppen)
              └─> Copy → C:\Apps\TestoSmartAbruf
              └─> setup.ps1 -Bundled
                    └─> Preflight (gebündeltes node.exe)
                    └─> Prebuild-Lade-Check
                    └─> install-task.ps1 (Task registrieren)
                    └─> Start + Smoke-Check (GET /api/system/status)
                    └─> Browser öffnen → http://localhost:3000
  └─> einmalig: API-Key im Dashboard eintragen
```

## Update & Datenhaltung

- **Update:** neue ZIP laden → `install.cmd` erneut. Stoppt Task, kopiert über
  `C:\Apps\TestoSmartAbruf`, re-registriert. Re-run-sicher (idempotent).
- **Daten bleiben erhalten:** DB liegt getrennt in `C:\ProgramData\TestoSmartAbruf\`
  (`DB_PATH`), wird vom Code-Overwrite nicht berührt.

## Fehlerbehandlung

- **Prebuild fehlt/lädt nicht:** harter Abbruch mit klarer Meldung (CI-Build defekt —
  sollte den Bediener nie erreichen, da im CI verifiziert).
- **Smoke-Check scheitert:** bestehende Logik (LastTaskResult + Hinweis auf
  `logs\app.log`, verwaister `node.exe`/Port).
- **MOTW/SmartScreen:** `install.cmd` entsperrt das Bundle früh; verbleibt ein
  einmaliger „More info → Run anyway"-Klick auf `install.cmd` selbst (eine Zeile
  Anleitung).
- **`AllSigned`-GPO:** kann unsignierte `.ps1` blockieren — außerhalb unserer
  Kontrolle, dokumentiert; mit IT klären.

## Grenzen / IT-Abstimmung

- **Gebündeltes `node.exe`** = ein zusätzliches (signiertes, bekanntes) Binary im
  App-Ordner. Verstößt nicht gegen „kein gepacktes/überraschendes Binary" (es ist das
  offizielle Node), ändert aber die Deployment-Story → mit EDR/IT abklären,
  `deploy/windows/README.md` aktualisieren, Windows-Abnahme (§9) erneut durchführen.
- **API-Key** bleibt ein manueller Schritt (gehört nicht ins verteilte Bundle).
- **Einziger ausgehender Traffic** bleibt der testo-Cloud-Sync (Bundle bringt keine
  neuen Startup-Netzaufrufe).

## Voraussetzungen

- **GitHub-Remote anlegen** (privates Repo) — bislang local-only. Erst damit läuft CI
  und existiert eine Releases-Seite als Download-Ort.

## Nicht-Ziele (YAGNI)

- Kein Single-`.exe`-Packer (pkg/SEA) — fragil mit nativem Modul, EDR-auffällig.
- Kein Auto-Update-Mechanismus — Update bleibt manueller ZIP-Download + `install.cmd`.
- Kein Auto-Node-Install auf der Zielmaschine (durch das Bundle obsolet).
- Kein Signieren der Skripte in diesem Schritt (separat mit IT, falls `AllSigned`).

## Konsistenz-Anker (CLAUDE.md)

- `path.join(__dirname, …)`, `DB_PATH` aus Env, dotenv CWD-unabhängig — unberührt.
- Native Module: nur `better-sqlite3`, win32-x64-Prebuild für Node 22/24/26.
- Bei Release: `VERSION`, README-Badge, `package.json`-Version und die 12 `?v=`-Cache-Buster
  in `Klima Dashboard.html` synchron — gilt weiter, plus das ZIP-Artefakt trägt dieselbe Version.
