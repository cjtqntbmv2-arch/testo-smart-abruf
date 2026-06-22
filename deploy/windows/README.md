# Windows-Inbetriebnahme (Hintergrund-Dienst)

Betrieb der App als login-unabhaengiger Hintergrund-Task auf Windows 11 x64,
gestartet bei jedem Systemstart, laufend als `NT AUTHORITY\NetworkService`.

## Voraussetzungen

- **Node.js 24 LTS (x64)** installiert (`node -v` → `v24.*`). Erlaubt sind 22/24/26;
  **Node 23 nicht** (kein win32-x64-Prebuild fuer better-sqlite3).
- Admin-Rechte fuer die einmalige Einrichtung.
- Netzwerk: ausgehend zu `data-api.<region>.smartconnect.testo.com` (HTTPS).
  Beim `npm ci`: Zugriff auf die npm-Registry **und** auf `github.com`
  (`objects.githubusercontent.com`) — von dort laedt `prebuild-install` das
  native better-sqlite3-Binary. Hinter Proxy: `npm config set proxy <url>` /
  `https-proxy` setzen; ggf. beide Hosts in der Allowlist freigeben.

## Installation

1. **Pflicht: Installationspfad OHNE Leerzeichen** (z. B. `C:\Apps\TestoSmartAbruf`),
   NICHT unter `C:\Program Files\…`. Grund: Der geplante Task ruft `start.cmd`
   direkt über seinen Pfad auf; ein Pfad mit Leerzeichen kann die Task-Action
   fehlschlagen lassen. Außerdem lokale Platte (kein UNC/Netzlaufwerk — WAL).
2. Abhaengigkeiten **auf dieser Maschine** installieren (node_modules NIE von
   macOS/Linux kopieren — falsches ABI):
   ```powershell
   cd C:\Apps\TestoSmartAbruf
   npm ci --omit=dev
   ```
3. Bei Bedarf `deploy\windows\start.cmd` anpassen (`PORT`, `DB_PATH`, `HOST`).
   Default `HOST=127.0.0.1` = nur lokal erreichbar.
4. Task registrieren (Admin-PowerShell), optional vorab mit `-WhatIf`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 -WhatIf
   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
   ```
5. Starten und pruefen:
   ```powershell
   schtasks /Run /TN TestoSmartAbruf
   start http://localhost:3000
   ```
6. API-Key im Dashboard unter Einstellungen hinterlegen (wird in der DB
   gespeichert) — oder vor dem ersten Start via `.env`/`TESTO_API_KEY` seeden.

## Verifikation

- `http://localhost:3000` zeigt das Dashboard.
- `C:\ProgramData\TestoSmartAbruf\klima.db` (+ `-wal`/`-shm`) existiert; `logs\app.log` waechst.
- **Reboot ohne Login** → Server wieder erreichbar.
- Liveness/Health: `GET http://localhost:3000/api/system/status` (Scheduler/DB/Storage).
  In der Aufgabenplanung zusaetzlich Spalte "Letztes Ausfuehrungsergebnis".
- Crash-Restart: `taskkill /IM node.exe /F` → Task startet Node binnen ~1 Min neu.
- Task immer ueber `Stop-ScheduledTask -TaskName TestoSmartAbruf` stoppen — das
  beendet den Prozessbaum (cmd + node). Danach pruefen: `tasklist | findstr node`
  zeigt **kein** verwaistes `node.exe`; sonst haelt es Port 3000 und der naechste
  Start scheitert mit `EADDRINUSE` → ggf. `taskkill /IM node.exe /F`.

## LAN-Zugriff (optional, IT-Freigabe)

Standard ist nur-lokal. Fuer Zugriff von Tablets/anderen PCs:
1. In `start.cmd` `HOST=0.0.0.0` setzen.
2. Eingehende Firewall-Regel (Admin):
   ```powershell
   New-NetFirewallRule -DisplayName "TestoSmartAbruf 3000" -Direction Inbound `
     -Action Allow -Protocol TCP -LocalPort 3000
   ```

## Update der App

Nach jedem App-Update **VERSION**, README-Badge und die `?v=`-Cache-Buster im
`Klima Dashboard.html` synchron halten (gleicher SemVer). Achtung: `?v=` kommt
**mehrfach** vor — in jedem `<script src="...?v=...">`-Tag (aktuell 10) — alle
zugleich bumpen, nicht nur eins. Der Server sendet keine Cache-Header → der
`?v=`-Bump ist der einzige Invalidierungs-Hebel; im Browser des Bedieners
zusaetzlich einmal hart neu laden (Strg+F5).

## Troubleshooting

- **`EADDRINUSE` im Log:** Port belegt → in `start.cmd` `PORT` aendern oder den
  blockierenden Prozess beenden.
- **`npm ci` schlaegt fehl (Compiler/`node-gyp`):** falsche Node-Version
  (kein Prebuild) oder `github.com` nicht erreichbar. Node 24 x64 verwenden,
  Proxy/Allowlist pruefen. Erfolgskontrolle: die better-sqlite3-Ausgabe muss
  `prebuild-install ... (download)`/`prebuilt binary` zeigen — taucht stattdessen
  `node-gyp rebuild` auf, fehlt der Prebuild (Guardrail-Bruch: Compiler laeuft).
- **Port-Binding & NetworkService:** der Server bindet Port 3000 ueber Winsock
  (libuv), NICHT ueber HTTP.sys → es ist **kein** `netsh http add urlacl` noetig,
  und NetworkService darf den High-Port ohne Elevation binden.
- **`EPERM`/gesperrte `.node` bei `npm ci`:** AV scannt frisch entpackte Datei →
  `npm ci` wiederholen oder AV-Ausnahme fuer den App-Ordner setzen.
- **AV/EDR & DB:** AV-Ausnahme fuer `C:\ProgramData\TestoSmartAbruf\` empfohlen
  (haeufige `-wal`/`-shm`-Schreibzugriffe).

## Alternativen (nicht Standard)

- **SYSTEM-Konto** statt NetworkService: einfacher (keine ACLs), aber ein
  elevated Netzwerk-Listener — mit der IT/EDR abklaeren. In `install-task.ps1`
  `-UserId 'NT AUTHORITY\NetworkService'` durch `'NT AUTHORITY\SYSTEM'` ersetzen.
- **Echter Dienst (WinSW):** falls ein Eintrag in `services.msc` gewuenscht ist
  — bekannte, signierte Wrapper-Exe + XML; nicht in diesem Repo enthalten.
