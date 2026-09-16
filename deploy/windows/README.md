# Windows-Inbetriebnahme (Hintergrund-Dienst)

Betrieb der App als login-unabhaengiger Hintergrund-Task auf Windows 11 x64,
gestartet bei jedem Systemstart, laufend als `NT AUTHORITY\NetworkService`.

## Voraussetzungen

- **Node.js 24 LTS (x64)** installiert (`node -v` → `v24.*`). Erlaubt sind 22/24/26;
  **Node 23 nicht** (kein win32-x64-Prebuild fuer better-sqlite3).
- Admin-Rechte fuer die einmalige Einrichtung.
- Netzwerk (alles ausgehend, HTTPS), getrennt nach Betrieb und Installation:
  - **Laufender Betrieb: genau ein Host**, `data-api.<region>.smartconnect.testo.com`.
    Mehr braucht die Anwendung im Betrieb nicht. Insbesondere braucht **das Dashboard
    selbst kein Internet**: React, Babel und die Schriftarten liegen als Dateien im
    Repo unter `Smart Meter Dashboard\vendor\` und werden vom lokalen Server
    ausgeliefert: keine CDN-, Font- oder sonstigen Fremdabrufe beim Oeffnen der
    Seite. Fuer die Freigabeliste der IT ist damit **dieser eine Host die komplette
    Liste**.
  - **Installation aus dem Bundle: kein Netzzugriff noetig.** Node und
    `node_modules` liegen in der ZIP bei, `install.cmd` laedt nichts nach. Die ZIP
    bringt die IT selbst auf die Maschine (USB / Fileshare / E-Mail).
  - **Installation aus dem Quellcode (`npm ci`): zusaetzlich npm-Registry und
    `github.com`** (`objects.githubusercontent.com`): von dort laedt
    `prebuild-install` das native better-sqlite3-Binary. Nur waehrend der
    Installation; im spaeteren Betrieb wird keiner der beiden Hosts mehr
    kontaktiert, die Freigabe kann also temporaer sein. Hinter Proxy:
    `npm config set proxy <url>` / `https-proxy` setzen; ggf. beide Hosts in der
    Allowlist freigeben.

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
3. Bei Bedarf Umgebungsvariablen anpassen: Vorlage `deploy\windows\env.example`
   nach `C:\Apps\TestoSmartAbruf\.env` kopieren und die gewuenschten Zeilen
   entkommentieren. Die Vorlage listet jede Variable mit ihrem Standardwert;
   relevant sind vor allem `PORT` und `HOST` (Default `HOST=127.0.0.1` = nur
   lokal erreichbar, alles andere braucht IT-Freigabe und Firewall-Regel).
   `DB_PATH` setzt `start.cmd` bereits selbst und gewinnt gegen die `.env`.
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
   Achtung: `TESTO_API_KEY`, `TESTO_API_REGION`, `POLL_INTERVAL_SEC` und
   `RETENTION_DAYS` liest der Server nur, solange die Datenbank noch keine
   Einstellungen enthaelt. Ab dem zweiten Start bleibt eine Aenderung in der
   `.env` wirkungslos; dann gilt nur noch das Dashboard.

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
**mehrfach** vor — in jedem `<script src="...?v=...">`-Tag (aktuell 14) — alle
zugleich bumpen, nicht nur eins. Der Server sendet keine Cache-Header → der
`?v=`-Bump ist der einzige Invalidierungs-Hebel; im Browser des Bedieners
zusaetzlich einmal hart neu laden (Strg+F5).

### Update-Hinweis (Ablageordner, ab v0.15.0)

Der Dienst sieht beim Start und danach alle 6 Stunden in einem Ablageordner nach,
ob dort eine neuere Release-ZIP liegt. Gesucht wird genau der Name, den die CI
baut: `testo-smart-abruf-<version>-win-x64.zip`. Gemeldet wird nur eine echt
hoehere SemVer-Version - die ZIP des vorigen Rollouts darf also liegen bleiben.

**Der Start wird nie gesperrt.** Das ist eine bewusste Abweichung von der sonst
ueblichen Startsperre: eine gesperrte Klimaueberwachung waere schlimmer als eine
alte Fassung, und unter `NT AUTHORITY\NetworkService` (BootTrigger) sitzt niemand
davor, der eine Sperre wegklicken koennte. Der Dienst meldet nur.

Der Ordner ist eine Einstellung (`update_dir`), kein fester Pfad. **Leer =
Pruefung aus, das ist der Standard** - ohne diesen Eintrag entsteht kein
Netzzugriff. Einmalig auf der Zielmaschine setzen:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/settings `
  -ContentType 'application/json' `
  -Body '{"update_dir":"\\\\fileserver\\Software\\TestoSmartAbruf"}'
```

Die Pruefung laeuft direkt nach dem Speichern erneut; ein Dienstneustart ist nicht
noetig. Ergebnis: Einstellungen -> Erweitert -> Ueber, Zeile `Update`
(`Pruefung aus (kein Ablageordner)` / `Aktuell` / `Update verfuegbar: <Version>`).
Maschinenlesbar unter `GET /api/system/status` im Feld `update`.

Der Ordner wird nur gelesen, nie beschrieben; es wird nichts heruntergeladen und
nichts installiert. Das Update bleibt das erneute `install.cmd` aus dem Abschnitt
darueber. Nicht erreichbare Freigabe, fehlende Rechte, halb kopierte Datei
(0 Byte): alles ergibt "kein Update bekannt", nie einen Fehler im Dienst.

**Bestehende Installationen erfahren davon nichts.** Eine Fassung vor v0.15.0 hat
die Pruefung noch nicht; sie muss einmalig ueber einen Kanal ausserhalb des
Programms aktualisiert werden (Mail an die IT, Wartungstermin). Erst ab dann
traegt der Hinweis sich selbst.

### Geaenderte CSV-Spaltennamen (ab v0.15.0)

**Ab v0.15.0 heissen drei Spalten im CSV-Export anders**, damit CSV und Dashboard
dieselbe Messgroesse gleich benennen: `Feuchte` -> `Rel. Luftfeuchte`, `Druck` ->
`Luftdruck`, `Absolute Feuchte` -> `Abs. Luftfeuchte`. Betroffen sind die
Spaltenkoepfe und die Zeile `Kanaele` der Messwert-CSV sowie die Spalte
`Messgroesse` der Meldungs-CSV - in der manuellen Ausgabe wie im monatlichen
Backup. `Temperatur` und `Taupunkt` bleiben unveraendert.

Bereits geschriebene Monats-ZIPs werden **nicht** neu erzeugt (vorhandene Dateien
werden uebersprungen). Wer zwei Monate von vor und nach dem Update in Excel
untereinanderlegt, sieht deshalb zwei Spaltennamen fuer dieselbe Messgroesse und
muss sie beim Zusammenfuehren von Hand angleichen. Aeltere ZIPs zu loeschen, damit
sie neu geschrieben werden, ist **nicht** noetig und nicht empfohlen.

Der Meldungstext eines Alarms behaelt absichtlich die alte Schreibweise
(`Luftfeuchte zu hoch`, `Druck zu niedrig`): diese Texte sind in der Datenbank
gespeichert, eine Umbenennung wuerde die Historie nicht mitziehen.

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

- Einstellungen → Datenexport: Panel ist sichtbar und bedienbar.
- Einstellungen `csv_format` (`de` = "Deutsch (Excel)", `rfc` = "International (RFC)"), `backup_enabled`, `backup_dir` sind unter `GET /api/settings` als Felder vorhanden (API-Key maskiert).
- **CSV-Download:** Einstellungen -> Datenexport -> genau eine Messstelle auswaehlen, Haken
  bei "Meldungen & Alarme" NICHT setzen, auf "Exportieren" klicken. Der Browser laedt eine
  einzelne CSV-Datei herunter, deren Trennzeichen der gewaehlten Option unter "CSV-Format"
  entspricht (Deutsch = Semikolon, International/RFC = Komma). Technischer Weg: `POST
  /api/export` mit JSON-Body (`stationIds`, `from`, `to`, `dialect`, ...), Antwort mit
  `Content-Type: text/csv`. (Mehrere Messstellen oder aktivierte Meldungen liefern
  stattdessen eine ZIP mit einer CSV je Messstelle.)

### Monatlicher Backup (ab v0.11.0)

- Backup-Verzeichnis: Standard `C:\ProgramData\TestoSmartAbruf\backups` (ueberschreibbar via `backup_dir`-Einstellung).
- Nach dem ersten Backup-Lauf existiert pro Messstelle eine ZIP-Datei mit dem Namensschema `<safeName>_<stationId>_<YYYY-MM>.zip` (Beispiel: `Lager_42_2026-05.zip`).
- **Idempotenz:** Ein zweiter Lauf im selben Monat ueberspringt die bestehende ZIP-Datei
  (kein Ueberschreiben, kein Duplikat) - erkennbar am unveraenderten Zeitstempel
  (`LastWriteTime`) der ZIP nach dem zweiten Lauf.
- **Leer-Schutz:** Monate ohne Messdaten erzeugen keine ZIP.
- **Prune-Sicherheit:** Messdaten werden erst geloescht, wenn sie in einer ZIP gesichert sind. Nicht gesicherte Monate (z. B. weil `backup_enabled=false` war) werden **nicht** vorzeitig geloescht (`effectiveCutoff = min(retentionCutoff, computePruneFloor)`).
- Der laufende Monat wird nie gesichert oder geloescht (Cutoff liegt immer vor Monatsbeginn des aktuellen Monats).

### Versionscheck

- `GET /api/system/status` → Feld `appVersion` lautet `0.15.1`.
- Alle 14 `<script src="…?v=…">`-Tags im `Klima Dashboard.html` tragen dieselbe Version wie `appVersion` (Browserkonsole: keine 404 auf `.js`/`.jsx`-Ressourcen). Die drei `vendor/`-Tags tragen bewusst keinen Cache-Buster.

### Update-Hinweis (ab v0.15.0)

- **Alt-ZIP-Probe:** In den leeren Ablageordner NUR die ZIP einer **aelteren**
  Fassung legen (z. B. `testo-smart-abruf-0.9.0-win-x64.zip` bei laufender
  0.15.0), `update_dir` setzen (Befehl im Abschnitt "Update-Hinweis") und
  Einstellungen -> Erweitert -> Ueber oeffnen: die Zeile `Update` muss `Aktuell`
  zeigen. Erst wenn zusaetzlich eine ZIP mit hoeherer Version im Ordner liegt
  (`testo-smart-abruf-0.16.0-win-x64.zip`) und `update_dir` erneut gespeichert
  wird, muss dort `Update verfuegbar: 0.16.0` stehen.
  *Warum dieser Punkt unterscheidet:* Die naheliegende Probe "neue ZIP hinlegen,
  Hinweis erscheint" bestehen auch zwei kaputte Umsetzungen - die, die nur
  "gefundene Version ungleich laufender Version" prueft, und die, die Versionen
  als Text vergleicht (`"0.9.0" > "0.15.0"` ist als Zeichenkette wahr). Beide
  melden beim Kunden dauerhaft "Update verfuegbar" auf die liegengebliebene ZIP
  des vorigen Rollouts. Nur die Alt-ZIP-Probe faengt diesen Dauerfehlalarm.
- **Standard ist aus:** solange `update_dir` leer ist, liefert
  `GET /api/system/status` `update.enabled = false`, und es entsteht kein
  Netzzugriff.
- **Dienst hat Vorrang:** `update_dir` auf eine nicht erreichbare Freigabe setzen
  (`\\kein-server\freigabe`), Dienst neu starten - Dashboard ist weiterhin
  erreichbar, Sync laeuft, `update.updateAvailable` ist `false`.

### Keine externen Laufzeit-Abhaengigkeiten

- **Offline-Probe:** Netzwerkadapter der Maschine deaktivieren (oder Netzkabel
  ziehen), dann `http://localhost:3000` in einem **InPrivate-/privaten Fenster**
  (= leerer Cache) oeffnen. Das Dashboard muss sich **vollstaendig** aufbauen:
  Kacheln mit Werten, Diagramme, und die Schrift ist Geist, nicht die
  Systemschrift. Danach Adapter wieder aktivieren (waehrend der Probe synct der
  Dienst erwartungsgemaess nicht; das ist kein Fehler).
  *Warum dieser Punkt unterscheidet:* React und Babel werden erst im Browser
  geladen. Kaeme eine der Dateien noch von einem externen Host, bliebe die Seite
  ohne Netz **leer** statt sich aufzubauen; eine extern gebliebene Schriftart
  faellt sofort am Schriftbild auf. Das InPrivate-Fenster schliesst aus, dass ein
  alter Browser-Cache den Fehler verdeckt.
- Ergaenzend, falls die Probe fehlschlaegt (zeigt, ob die Dateien ueberhaupt
  mitgeliefert wurden): `dir "C:\Apps\TestoSmartAbruf\Smart Meter Dashboard\vendor"`
  listet `react.production.min.js`, `react-dom.production.min.js`, `babel.min.js`
  und den Unterordner `fonts`.

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
