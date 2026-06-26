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

## Installation aus dem Bundle (empfohlen, fuer Laien)

Kein Node-Install, kein `npm ci`, keine Pfadregeln noetig.

**Bereitstellung durch die IT:** Die IT laedt
`testo-smart-abruf-<version>-win-x64.zip` von der **Releases-Seite** und bringt
sie auf die Zielmaschine (USB / Fileshare / E-Mail). Der Bediener braucht keinen
GitHub-Zugang.

**Schritte fuer den Bediener:**

1. ZIP per Rechtsklick **„Alle extrahieren"** vollstaendig entpacken (NICHT
   `install.cmd` direkt aus dem ZIP-Fenster starten — das schlaegt fehl).
2. Im entpackten Ordner **`install.cmd` doppelklicken**. Beim SmartScreen-Hinweis:
   „Weitere Informationen" → „Trotzdem ausfuehren". UAC mit „Ja" bestaetigen.
   Der Installer richtet alles ein und startet den Dienst.
3. Im Browser **`http://localhost:3000`** oeffnen (das Fenster versucht das
   automatisch). Unter **Einstellungen → API-Key** den Schluessel eintragen und
   **Speichern**. Fertig.

**API-Key — woher:** Der Key stammt aus dem **testo Smart Connect Portal** (bzw.
von der IT/dem testo-Administrator). Ohne Key laeuft der Dienst, synct aber nichts
(das Setup-Fenster weist darauf hin).

**Update:** neue ZIP von der IT erhalten, entpacken, `install.cmd` erneut
doppelklicken (stoppt den Dienst, schaltet per atomarem Wechsel auf die neue
Version um, re-registriert; bei Fehlschlag Rollback auf die alte Version).
Die Datenbank in `C:\ProgramData\TestoSmartAbruf\` bleibt erhalten.

> Das Bundle bringt eine offizielle (OpenJS-signierte) portable `node.exe` mit —
> eine bewusste Lockerung der „keine gebuendelten Binaries"-Regel. Auf
> gehaerteten Maschinen (AllSigned-GPO, AppLocker/WDAC, gesperrtes „Trotzdem
> ausfuehren") kann das blockieren → vorab mit EDR/IT abklaeren. Die
> Quellcode-Variante (`npm ci` + `setup.ps1`) unten bleibt als Alternative.

## Schnellinstallation (empfohlen)

`setup.ps1` bündelt die Schritte unten zu einem Aufruf: Node-Preflight, Stoppen
eines ggf. laufenden Dienstes, `npm ci --omit=dev` (inkl. Prebuild-Check),
Pfad-/Konsistenz-Prüfung, Aufruf von `install-task.ps1`, Task-Start und ein
`GET /api/system/status`-Smoke-Check. Re-run-sicher = zugleich Update-Pfad.

1. **Pflicht: Installationspfad OHNE Leerzeichen** (z. B. `C:\Apps\TestoSmartAbruf`),
   nicht unter `C:\Program Files` (enthält ein Leerzeichen), lokale Platte
   (kein Netzlaufwerk — WAL).
2. Code auf die Maschine bringen (`git clone`/kopieren — **node_modules NIE
   mitkopieren**, falsches ABI). Node 24 LTS (x64) muss installiert sein.
3. Setup ausführen — doppelklickbar **oder** aus einer **Administrator**-PowerShell
   (auch der Trockenlauf braucht Admin-Rechte), **aus dem Repo-Wurzelverzeichnis**:
   ```powershell
   .\deploy\windows\setup.cmd
   powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1 -WhatIf   # Trockenlauf
   powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1
   ```
4. Nach Erfolg: **API-Key im Dashboard** unter Einstellungen hinterlegen — der
   Dienst synct erst danach (der Smoke-Check weist darauf hin, falls noch keiner
   gesetzt ist).

**Update nach `git pull`:** `setup.ps1` erneut ausführen (stoppt zuerst den
laufenden Dienst, dann npm ci + Neuregistrierung). Wenn `package-lock.json`
unverändert ist, mit `-SkipNpm` schneller (der Prebuild-Check läuft trotzdem).

`setup.cmd` ist nur für den interaktiven Doppelklick gedacht. Für Automatisierung
`setup.ps1` direkt via `-File` aufrufen und `$LASTEXITCODE` prüfen.

Die manuelle Schritt-für-Schritt-Anleitung unten bleibt als Fallback/Transparenz.

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
3. Bei Bedarf Umgebungsvariablen anpassen: Lege dazu eine Datei `.env` in `C:\Apps\TestoSmartAbruf\` an und setze dort `PORT` oder `HOST` (Default `HOST=127.0.0.1` = nur lokal erreichbar).
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
1. Lege eine `.env` Datei unter `C:\Apps\TestoSmartAbruf\.env` an und trage dort `HOST=0.0.0.0` ein.
2. Eingehende Firewall-Regel (Admin):
   ```powershell
   New-NetFirewallRule -DisplayName "TestoSmartAbruf 3000" -Direction Inbound `
     -Action Allow -Protocol TCP -LocalPort 3000
   ```

## Update der App

Nach jedem App-Update **VERSION**, README-Badge und die `?v=`-Cache-Buster im
`Klima Dashboard.html` synchron halten (gleicher SemVer). Achtung: `?v=` kommt
**mehrfach** vor — in jedem `<script src="...?v=...">`-Tag (aktuell 12) — alle
zugleich bumpen, nicht nur eins. Der Server sendet keine Cache-Header → der
`?v=`-Bump ist der einzige Invalidierungs-Hebel; im Browser des Bedieners
zusaetzlich einmal hart neu laden (Strg+F5).

## Troubleshooting

- **`EADDRINUSE` im Log:** Port belegt → in `.env` Datei `PORT` aendern oder den
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
- **SmartScreen / „Windows protected your PC" beim Doppelklick:** per Download
  (Browser/E-Mail) bezogene `.cmd`/`.ps1` tragen das Mark-of-the-Web. Entweder per
  `git clone` holen (kein MOTW) oder einmalig entsperren:
  `Get-ChildItem deploy\windows\*.ps1,deploy\windows\*.cmd | Unblock-File`.
- **`AllSigned` per GPO:** Ist die `ExecutionPolicy` auf MachinePolicy-Ebene auf
  `AllSigned` gesetzt, überschreibt das `-ExecutionPolicy Bypass` — unsignierte
  Skripte laufen dann nicht. Ohne Signatur mit der IT klären.
- **npm hinter Proxy:** `npm config set proxy <url>` / `https-proxy` setzen (oder
  in `.npmrc`), damit der better-sqlite3-Prebuild von `github.com` geladen wird.
- **Setup-Eigenlog:** `setup.ps1` schreibt zusätzlich nach
  `C:\ProgramData\TestoSmartAbruf\logs\setup.log` (auch wenn das Fenster zugeht).

## §9 Abnahmekriterien (Acceptance Criteria)

Diese Punkte muessen auf der Zielmaschine (Windows 11 x64, NetworkService) erfuellt sein, bevor der Release als abgenommen gilt.

### Basisbetrieb

- `http://localhost:3000` zeigt das Dashboard ohne JS-Fehler in der Konsole.
- `C:\ProgramData\TestoSmartAbruf\klima.db` existiert; WAL-Dateien (`-wal`, `-shm`) tauchen auf.
- Logs werden nach `C:\ProgramData\TestoSmartAbruf\logs\app.log` geschrieben.
- **Reboot ohne Login** → Dienst startet automatisch, Server ist danach erreichbar.
- `GET http://localhost:3000/api/system/status` liefert `200 OK` mit `scheduler`, `db`, `storage` alle ohne Fehler.

### CSV-Export (ab v0.11.0)

- Einstellungen → Exportieren: Panel ist sichtbar und bedienbar.
- Einstellungen `csv_format` (Semikolon/Komma/Tab), `backup_enabled`, `backup_dir` sind unter `GET /api/settings` als Felder vorhanden (API-Key maskiert).
- Ein manuell ausgeloester CSV-Download (`GET /api/export/csv?…`) liefert eine gueltige CSV-Datei mit korrektem Delimiter.

### Monatlicher Backup (ab v0.11.0)

- Backup-Verzeichnis: Standard `C:\ProgramData\TestoSmartAbruf\backups` (ueberschreibbar via `backup_dir`-Einstellung).
- Nach dem ersten Backup-Lauf existiert pro Messstelle eine ZIP-Datei mit dem Namensschema `<safeName>_<stationId>_<YYYY-MM>.zip` (Beispiel: `Lager_42_2026-05.zip`).
- **Idempotenz:** Ein zweiter Lauf im selben Monat ueberschreibt die bestehende ZIP (kein Duplikat).
- **Leer-Schutz:** Monate ohne Messdaten erzeugen keine ZIP.
- **Prune-Sicherheit:** Messdaten werden erst geloescht, wenn sie in einer ZIP gesichert sind. Nicht gesicherte Monate (z. B. weil `backup_enabled=false` war) werden **nicht** vorzeitig geloescht (`effectiveCutoff = min(retentionCutoff, computePruneFloor)`).
- Der laufende Monat wird nie gesichert oder geloescht (Cutoff liegt immer vor Monatsbeginn des aktuellen Monats).

### Versionscheck

- `GET /api/system/status` → Feld `appVersion` lautet `0.14.2`.
- Alle 12 `<script src="…?v=…">`-Tags im `Klima Dashboard.html` tragen `?v=0.14.2` (Browserkonsole: keine 404 auf `.js`/`.jsx`-Ressourcen).

### Bundle-Installation (ab v0.14.0)

- ZIP-Artefakt `testo-smart-abruf-<version>-win-x64.zip` existiert auf der Releases-Seite.
- Frische Maschine **ohne vorinstalliertes Node**: `install.cmd` fuehrt ohne `npm ci` zum laufenden Dienst.
- Nach Installation existiert `C:\Apps\TestoSmartAbruf\node.exe` und `...\node_modules\better-sqlite3\build\Release\better_sqlite3.node`.
- Nach erfolgreichem Smoke-Check oeffnet sich der Browser auf `http://localhost:3000`.
- Update durch erneutes `install.cmd`: Dienst laeuft danach mit neuer `appVersion`, DB-Daten unveraendert.

## Alternativen (nicht Standard)

- **SYSTEM-Konto** statt NetworkService: einfacher (keine ACLs), aber ein
  elevated Netzwerk-Listener — mit der IT/EDR abklaeren. In `install-task.ps1`
  `-UserId 'NT AUTHORITY\NetworkService'` durch `'NT AUTHORITY\SYSTEM'` ersetzen.
- **Echter Dienst (WinSW):** falls ein Eintrag in `services.msc` gewuenscht ist
  — bekannte, signierte Wrapper-Exe + XML; nicht in diesem Repo enthalten.
