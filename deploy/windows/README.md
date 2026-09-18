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
  - **Installation aus dem Quellcode (`npm ci`): zusaetzlich die npm-Registry**
    (`registry.npmjs.org`). Das native better-sqlite3-Binary liegt seit 13.x im
    npm-Tarball selbst (`prebuilds/win32-x64.node`) — ein separater Download von
    `github.com` findet nicht mehr statt, der Host muss nicht freigegeben werden.
    Nur waehrend der Installation; im spaeteren Betrieb wird die Registry nicht
    mehr kontaktiert, die Freigabe kann also temporaer sein. Hinter Proxy:
    `npm config set proxy <url>` / `https-proxy` setzen.

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
eines ggf. laufenden Dienstes, `npm ci --omit=dev --ignore-scripts` (inkl. Prebuild-Check),
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
   npm ci --omit=dev --ignore-scripts
   ```
   `--ignore-scripts` weglassen heisst: npm leitet aus der von better-sqlite3
   mitgelieferten `binding.gyp` ein `node-gyp rebuild` ab und verlangt einen
   C++-Compiler, den diese Maschine nicht hat. Das fertige Binary liegt bereits
   im npm-Paket.
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
- Crash-Restart: nur den Node-Prozess des Dienstes beenden (derselbe Befehl wie in
  `setup.ps1`; andere Node-Programme der Maschine bleiben unberuehrt) → Task startet Node
  binnen ~1 Min neu:
  ```powershell
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'backend\\server\.js' } | Invoke-CimMethod -MethodName Terminate | Out-Null
  ```
  Als Administrator ausfuehren: ohne Admin-Rechte liefert Windows die Kommandozeile des
  Dienstprozesses nicht, der Filter faende ihn dann nicht.
- Task immer ueber `Stop-ScheduledTask -TaskName TestoSmartAbruf` stoppen — das
  beendet den Prozessbaum (cmd + node). Danach pruefen, dass kein verwaistes `node.exe`
  des Dienstes laeuft; diese Abfrage darf nichts ausgeben:
  ```powershell
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'backend\\server\.js' }
  ```
  Sonst haelt es Port 3000 und der naechste Start scheitert mit `EADDRINUSE` → mit dem
  Befehl aus "Crash-Restart" beenden.

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

## Datensicherung und Ruecksicherung

Der Dienst sichert auf zwei Wegen, beide im Backup-Verzeichnis (Standard
`C:\ProgramData\TestoSmartAbruf\backups`, abweichend per Einstellung `backup_dir`):

- **Monats-ZIPs** (`<safeName>_<stationId>_<YYYY-MM>.zip`): CSV je Messstelle und
  abgeschlossenem Monat, zum Lesen in Excel. **Kein Backup** - aus ihnen laesst sich keine
  Datenbank wiederherstellen (es fehlen Einstellungen, Grenzwerte, Geraetezuordnung und
  die IDs der Messwerte).
- **Taeglicher Datenbank-Abzug** im Unterordner `datenbank`: eine vollstaendige Kopie der
  Datenbank - Messwerte bis zum Zeitpunkt des Abzugs (auch des laufenden Monats),
  Meldungen, Grenzwerte, Messstellen samt Geraetezuordnung, Einstellungen. **Nur dieser
  Abzug ist zurueckspielbar.**

Zum Datenbank-Abzug:

- **Name:** `klima-JJJJ-MM-TT.db`, Datum in Ortszeit, eine Datei je Tag.
- **Zeitpunkt:** mit dem taeglichen Backup-Lauf im ersten Sync-Zyklus eines Tages, noch
  vor dem Loeschen alter Messwerte (Aufbewahrung); nur bei eingeschalteter Sicherung
  (`backup_enabled`). Scheitert er, versucht der Dienst es im naechsten Zyklus erneut.
  Zustand unter `GET /api/system/status`, Feld `backup.health`: `lastDbSnapshot` und
  `lastDbSnapshotAt` (letzter gelungener Abzug), `dbSnapshotError`.
- **Aufbewahrung:** die sieben neuesten Tage. Ein zweiter Lauf am selben Tag ersetzt die
  Datei dieses Tages. Aeltere Abzuege loescht der Dienst erst, nachdem ein neuer gelungen
  ist, jeden einzeln (ein gesperrter haelt die uebrigen nicht auf; er steht dann in
  `dbSnapshotPruneError`); andere Dateien im Ordner fasst er nicht an. Reste eines
  abgebrochenen Abzugs (`klima-JJJJ-MM-TT.db.tmp`, `...tmp-journal`) raeumt der naechste
  Lauf weg.
- **Schutz der Messwerte:** Solange die Sicherung eingeschaltet ist, loescht die
  Aufbewahrung (`retention_days`) nichts, was juenger ist als der letzte gelungene Abzug,
  und vor dem ersten gelungenen Abzug gar nichts. Scheitern die Abzuege dauerhaft, waechst
  die Datenbank also weiter, statt Ungesichertes zu loeschen.
- **Platzbedarf:** etwa sieben mal die Datenbankgroesse, kurz vor dem Loeschen des
  aeltesten acht. Gemessen: 45 MB Datenbank ergeben einen Abzug von 44 MB, zusammen gut
  300 MB; waechst mit der Datenbank.
- **Schutz:** Der Abzug enthaelt alle Einstellungen **einschliesslich des API-Schluessels**
  - gewollt, damit nach dem Zurueckspielen alles ohne Nacharbeit laeuft. Den
  Sicherungsordner deshalb schuetzen wie die Datenbank selbst; liegt er auf einer
  Netzfreigabe, diese nur fuer Berechtigte lesbar freigeben. Die Freigabe ist fuer den
  Sicherungsordner erlaubt, die Datenbank selbst muss auf der lokalen Platte bleiben (WAL).
- Jede Installation braucht ihren **eigenen** Sicherungsordner: die Abzuege heissen nur
  nach dem Datum, zwei Dienste im selben Ordner ueberschrieben sich gegenseitig.

### Jetzt sichern

Einstellungen -> Datenexport, Abschnitt "Datensicherung", Knopf **Jetzt sichern**
(technisch `POST /api/backup`): fuehrt den Lauf sofort aus - Datenbank-Abzug und fehlende
Monats-ZIPs -, unabhaengig von der Tagesdrossel und auch bei ausgeschaltetem automatischen
Backup (der Schalter gilt nur dem taeglichen Lauf). Gedacht fuer die Sicherung vor einem
Update und fuer den Nachweis nach einem behobenen Sicherungsfehler: die Fehleranzeige
verschwindet sofort. Der Lauf **ersetzt den Abzug des heutigen Tages**, aeltere Abzuege
bleiben; die Oberflaeche fragt deshalb vorher nach. `logs\app.log` erhaelt genau eine
Zeile, `Sicherung (manuell) ok: Abzug klima-JJJJ-MM-TT.db, N ZIP neu` bzw.
`Sicherung (manuell) fehlgeschlagen: <Ursache>`.

**Nach einem Datenverlust nicht "Jetzt sichern" druecken** - das ersetzt den heutigen
Abzug durch den beschaedigten Stand; aeltere Abzuege bleiben. Stattdessen zuruecksichern
(naechster Abschnitt).

### Sicherungsfehler erkennen

Scheitert ein Lauf (z. B. Zielordner nicht beschreibbar), steht das an vier Stellen:

- Hinweisleiste unter der Kopfzeile des Dashboards: `Datensicherung fehlgeschlagen: <Ursache>`.
- Einstellungen -> Uebersicht, Karte "Datensicherung": `Fehler` mit Ursache und dem letzten
  gelungenen Abzug; ebenso im Abschnitt "Datensicherung" unter Datenexport. Alle drei
  aktualisieren sich alle 10 Sekunden.
- `logs\app.log`: der Herzschlag des Zyklus lautet `Sync mit Fehlern ... (Sicherung): ...`,
  die Ursache steht gedrosselt davor (`Sync Sicherung: ...` - beim ersten Mal voll, danach
  nur bei 10, 100, 1000 Wiederholungen eine Zaehlzeile). Ein gelungener Tageslauf steht als
  `Sicherung ok (Abzug ..., N ZIP neu)` im Herzschlag.
- `GET /api/system/status`, Feld `backup.health.status` = `error`, Text in `lastError`.

Ein gescheiterter Lauf - auch ein gescheitertes "Jetzt sichern" - verbraucht den
Tagesversuch nicht: jeder Sync-Zyklus versucht es erneut. Nach Behebung der Ursache
verschwindet die Meldung also spaetestens mit dem naechsten Zyklus (Abfrage-Intervall),
sofort mit "Jetzt sichern"; im Log steht dann `Sync ok ..., Sicherung ok (...) - wieder
fehlerfrei nach N Zyklen mit Fehlern`.

### Datenbank zuruecksichern

Aus einer **Administrator**-PowerShell:

1. Dienst stoppen und einen verbliebenen Node-Prozess des Dienstes gezielt beenden (nur
   den mit `backend\server.js`, andere Node-Programme bleiben unberuehrt; derselbe Befehl
   wie in `setup.ps1`):
   ```powershell
   Stop-ScheduledTask -TaskName TestoSmartAbruf
   Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'backend\\server\.js' } | Invoke-CimMethod -MethodName Terminate | Out-Null
   Start-Sleep -Seconds 2     # Windows gibt die Dateien frei
   ```
2. Den jetzigen Stand beiseitelegen - **alle drei Dateien zusammen verschieben**, nicht
   loeschen:
   ```powershell
   cd C:\ProgramData\TestoSmartAbruf
   mkdir vor-ruecksicherung
   Move-Item klima.db, klima.db-wal, klima.db-shm vor-ruecksicherung -ErrorAction SilentlyContinue
   dir klima.db*              # muss leer sein
   ```
   Warum: `Stop-ScheduledTask` beendet Node hart, ohne dass die Datenbank sauber
   geschlossen wird; `klima.db-wal` und `klima.db-shm` bleiben liegen und gehoeren zur
   **alten** Datenbank. Laege die alte `-wal` neben dem eingespielten Abzug, spielte
   SQLite sie beim naechsten Oeffnen in ihn hinein: die Datei oeffnet ohne Fehlermeldung,
   ist aber beschaedigt (im Funktionstest: 48.563 statt 171.198 Messwerte,
   `integrity_check` meldet `malformed`). Zusammen verschoben bleibt der alte Stand
   dagegen vollstaendig lesbar.
3. Gewuenschten Abzug als `klima.db` einspielen - **kopieren**, nicht verschieben: der
   Abzug bleibt erhalten, und die Kopie erbt die Rechte des Datenordners fuer
   NetworkService (bei eigenem `backup_dir` den Quellpfad anpassen):
   ```powershell
   Copy-Item backups\datenbank\klima-2026-09-18.db klima.db
   ```
4. Dienst starten und pruefen:
   ```powershell
   Start-ScheduledTask -TaskName TestoSmartAbruf
   ```
   Das Dashboard zeigt die Messstellen mit Werten, `logs\app.log` meldet nach dem ersten
   Zyklus `Sync ok ...`, `GET http://localhost:3000/api/system/status` ist ohne Fehler.
   Dieser erste Zyklus schreibt auch den Abzug des heutigen Tages neu (eine vorhandene
   Datei dieses Tages wird ersetzt) - der Stand vor der Ruecksicherung liegt in
   `vor-ruecksicherung`. Den Ordner erst loeschen, wenn alles stimmt.

**Was zwischen Abzug und Ruecksicherung geschah:**

- Messwerte holt der erste Sync-Zyklus nach dem Start aus der testo-Cloud nach, soweit
  die Cloud sie noch liefert: er fragt ab dem letzten gespeicherten Messwert bis jetzt an
  (bei mehreren Messstellen ab dem am weitesten zurueckliegenden).
- Alarme und Meldungen ebenso, ab dem Abrufstand, der mit dem Abzug zurueckkommt
  (`last_alarm_sync_time`), mindestens 26 Stunden zurueck. Geraetestatus und Grenzwerte
  liest ohnehin jeder Zyklus neu.
- **Nicht** nachgeholt wird, was nur lokal entstand: Einstellungen sowie seit dem Abzug
  angelegte oder geaenderte Messstellen und Zuordnungen stehen wieder auf dem Stand des
  Abzugs und sind von Hand zu wiederholen.
- **Achtung Aufbewahrung:** Der Abzug bringt auch die Aufbewahrungsdauer
  (`retention_days`) mit. Wer zuruecksichert, weil eine zu kleine Aufbewahrung Messwerte
  geloescht hat, waehlt einen Abzug von **vor** dieser Aenderung - sonst loescht der erste
  Zyklus nach dem Start erneut.

## Deinstallation

`deploy\windows\uninstall-task.ps1` entfernt den geplanten Task wieder (stoppt ihn,
dann `Unregister-ScheduledTask`). Admin-Rechte noetig, wie bei der Installation.
Existiert der Task nicht, meldet das Skript das nur und aendert nichts.

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-task.ps1 -WhatIf   # Trockenlauf
powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-task.ps1
```

**Was dabei erhalten bleibt** (das Skript fasst ausschliesslich den Scheduled Task an):

- Das Anwendungsverzeichnis (Code, `node_modules`, `.env`), Standardpfad
  `C:\Apps\TestoSmartAbruf`.
- Die Datenbank mit allen bisher aufgezeichneten Messwerten:
  `C:\ProgramData\TestoSmartAbruf\klima.db` (+ `-wal`/`-shm`).
- Die Logs: `C:\ProgramData\TestoSmartAbruf\logs\app.log` (plus rotierte
  `.bak`-Dateien) und `logs\setup.log`.
- Die monatlichen Backup-ZIPs und im Unterordner `datenbank` die taeglichen
  Datenbank-Abzuege: standardmaessig `C:\ProgramData\TestoSmartAbruf\backups`,
  abweichend falls unter Einstellungen ein eigener `backup_dir` gesetzt wurde.
- Eine eingerichtete Firewall-Regel fuer LAN-Zugriff (Abschnitt "LAN-Zugriff",
  `New-NetFirewallRule -DisplayName "TestoSmartAbruf 3000"`).

Das ist beabsichtigt: die Messdaten liegen bewusst ausserhalb des Anwendungsverzeichnisses,
genau damit ein Update sie nicht beruehrt (Abschnitt "Update der App") - bei einer reinen
Deinstallation bleiben sie aus demselben Grund erhalten.

**Alles entfernen (nur wenn wirklich gewuenscht):** nach dem Task-Uninstall zusaetzlich
von Hand loeschen: `C:\Apps\TestoSmartAbruf` (Anwendungsverzeichnis) sowie
`C:\ProgramData\TestoSmartAbruf` (Datenbank, Logs, Backups - **enthaelt saemtliche
Messwerte**, vorher bei Bedarf sichern). Eine LAN-Firewall-Regel zusaetzlich per
`Remove-NetFirewallRule -DisplayName "TestoSmartAbruf 3000"` (Admin-PowerShell)
entfernen.

## Troubleshooting

- **`EADDRINUSE` im Log:** Port belegt → in `.env` Datei `PORT` aendern oder den
  blockierenden Prozess beenden.
- **`npm ci` schlaegt fehl (Compiler/`node-gyp`):** meist fehlt `--ignore-scripts`
  (dann verlangt npm einen C++-Compiler, s.o.); sonst npm-Registry nicht
  erreichbar oder falsche Node-Version. Node 24 x64 verwenden, Proxy/Allowlist
  pruefen.
  Erfolgskontrolle: `node_modules\better-sqlite3\prebuilds\win32-x64.node` muss
  existieren und `node_modules\better-sqlite3\build\` darf **nicht** existieren —
  ein `build\`-Ordner bedeutet, dass `node-gyp` kompiliert hat (Guardrail-Bruch:
  Compiler laeuft). Seit better-sqlite3 13.x bringt der npm-Tarball das Prebuild
  selbst mit, es wird nichts mehr nachgeladen.
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
  in `.npmrc`), damit `npm ci` die Registry (`registry.npmjs.org`) erreicht. Ein
  separater Download von `github.com` findet seit better-sqlite3 13.x nicht mehr
  statt — das Prebuild liegt im npm-Tarball (s. "Voraussetzungen").
- **Setup-Eigenlog:** `setup.ps1` schreibt zusätzlich nach
  `C:\ProgramData\TestoSmartAbruf\logs\setup.log` (auch wenn das Fenster zugeht).

## §9 Abnahmekriterien (Acceptance Criteria)

Diese Punkte muessen auf der Zielmaschine (Windows 11 x64, NetworkService) erfuellt sein, bevor der Release als abgenommen gilt.

### Basisbetrieb

- `http://localhost:3000` zeigt das Dashboard ohne JS-Fehler in der Konsole.
- `C:\ProgramData\TestoSmartAbruf\klima.db` existiert; WAL-Dateien (`-wal`, `-shm`) tauchen auf.
- Logs werden nach `C:\ProgramData\TestoSmartAbruf\logs\app.log` geschrieben. Jede Zeile
  beginnt mit einem Zeitstempel in Ortszeit mit Offset (`2026-09-18T14:03:12+02:00`), und
  je Sync-Zyklus steht genau eine Zeile `Sync ok ...` bzw. `Sync mit Fehlern ...` darin.
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
- **Prune-Sicherheit:** Bei eingeschalteter Sicherung loescht die Aufbewahrung nur, was gesichert ist: nichts aus einem Monat ohne ZIP (z. B. weil `backup_enabled=false` war) und nichts, was juenger ist als der letzte gelungene Datenbank-Abzug (`backup.health.lastDbSnapshotAt`); vor dem ersten gelungenen Abzug gar nichts (`effectiveCutoff = min(retentionCutoff, computePruneFloor)`). Bei ausgeschalteter Sicherung gilt nur `retention_days`.
- Der laufende Monat wird nie als ZIP gesichert. Die Aufbewahrung kann auch in ihm loeschen (bei kleiner `retention_days`), aber nur, was schon in einem gelungenen Datenbank-Abzug steht.

### Datenbank-Abzug

- Nach dem ersten Backup-Lauf eines Tages liegt `backups\datenbank\klima-JJJJ-MM-TT.db`
  mit dem heutigen Datum (Ortszeit) vor; `GET /api/system/status` zeigt ihn unter
  `backup.health.lastDbSnapshot`. Nach einem Update erscheint der erste Abzug erst am
  Folgetag, wenn der Backup-Lauf des Tages schon vor dem Update stattfand.
- Ab dem achten Abzug bleibt es bei sieben Dateien im Ordner `datenbank`: der aelteste
  Tag verschwindet, sobald der neue geschrieben ist.
- **Ruecksicherungsprobe:** den Weg aus "Datenbank zuruecksichern" einmal durchspielen.
  Danach zeigt das Dashboard dieselben Messstellen mit Werten wie vorher, und
  `logs\app.log` meldet `Sync ok ...`.
- **Jetzt sichern:** Einstellungen -> Datenexport -> "Jetzt sichern", Rueckfrage
  bestaetigen. Danach traegt der heutige `backups\datenbank\klima-JJJJ-MM-TT.db` die
  aktuelle Uhrzeit (`LastWriteTime`), die Zeile "Letzter Datenbank-Abzug" zeigt
  "gerade eben", und `logs\app.log` hat genau eine neue Zeile `Sicherung (manuell) ok: ...`.
- **Sicherungsfehler sichtbar:** dem Dienstkonto (NetworkService) das Schreibrecht auf den
  Sicherungsordner entziehen, "Jetzt sichern" druecken. Die Fehlermeldung erscheint am
  Knopf, binnen 10 Sekunden auch als Hinweisleiste unter der Kopfzeile und als Karte
  "Datensicherung" (`Fehler`) in der Uebersicht - ohne Neuladen der Seite; im Log
  `Sicherung (manuell) fehlgeschlagen: ...`. Recht zurueckgeben, erneut "Jetzt sichern":
  Hinweisleiste und Fehlerkarte verschwinden binnen 10 Sekunden.

### Versionscheck

- `GET /api/system/status` → Feld `appVersion` lautet `0.16.1`.
- Alle App-`<script src="…?v=…">`-Tags **und der `dashboard.css`-`<link>`** im `Klima Dashboard.html` tragen dieselbe Version wie `appVersion` (Browserkonsole: keine 404 auf `.js`/`.jsx`/`.css`-Ressourcen). Die drei `vendor/`-Tags tragen bewusst keinen Cache-Buster. **Ein 404 auf `dashboard.css` ist der schlimmste Fall dieser Liste** — die Seite laedt dann vollstaendig unformatiert, ohne Fehlermeldung.

### Update-Hinweis (ab v0.15.0)

- **Alt-ZIP-Probe:** In den leeren Ablageordner NUR die ZIP einer **aelteren**
  Fassung legen (`testo-smart-abruf-0.9.0-win-x64.zip` — diese Nummer bleibt
  bewusst fest, sie traegt die Zeichenketten-Falle weiter unten), `update_dir`
  setzen (Befehl im Abschnitt "Update-Hinweis") und Einstellungen -> Erweitert ->
  Ueber oeffnen: die Zeile `Update` muss `Aktuell` zeigen. Erst wenn zusaetzlich
  eine ZIP mit **echt hoeherer** Version als der laufenden im Ordner liegt (etwa
  die naechste Patch-Version) und `update_dir` erneut gespeichert wird, muss dort
  `Update verfuegbar: <diese hoehere Version>` stehen.
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
- Nach Installation existiert `C:\Apps\TestoSmartAbruf\node.exe` und `...\node_modules\better-sqlite3\prebuilds\win32-x64.node`; ein Ordner `...\node_modules\better-sqlite3\build\` existiert **nicht** (er waere ein node-gyp-Compile, den `setup.ps1` und der CI-Guard als Fehler werten).
- Nach erfolgreichem Smoke-Check oeffnet sich der Browser auf `http://localhost:3000`.
- Update durch erneutes `install.cmd`: Dienst laeuft danach mit neuer `appVersion`, DB-Daten unveraendert.

## Alternativen (nicht Standard)

- **SYSTEM-Konto** statt NetworkService: einfacher (keine ACLs), aber ein
  elevated Netzwerk-Listener — mit der IT/EDR abklaeren. In `install-task.ps1`
  `-UserId 'NT AUTHORITY\NetworkService'` durch `'NT AUTHORITY\SYSTEM'` ersetzen.
- **Echter Dienst (WinSW):** falls ein Eintrag in `services.msc` gewuenscht ist
  — bekannte, signierte Wrapper-Exe + XML; nicht in diesem Repo enthalten.
