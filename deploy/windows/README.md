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

**Update:** ab v0.18.0 per `update.cmd` aus dem Ablageordner, siehe "Update der
App". Der Handweg bleibt als Rueckfall: neue ZIP entpacken, `install.cmd` erneut
doppelklicken (sichert die Datenbank, stoppt den Dienst, schaltet per atomarem
Wechsel auf die neue Version um, re-registriert; bei Fehlschlag Rollback auf die
alte Version). Die Datenbank in `C:\ProgramData\TestoSmartAbruf\` bleibt erhalten.

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

Der Dienst meldet eine neue Fassung nur, eingespielt wird sie von der IT. Ab v0.18.0
geht das mit `update.cmd` im Ablageordner: Doppelklick, UAC, eine Rueckfrage. Den Rest
erledigt `install.cmd` der neuen Fassung: Datenbank-Abzug, Staging, Umschalten,
Versionspruefung und bei Bedarf den automatischen Rollback. Der Dienst selbst laedt,
installiert und startet nichts.

### Installationen vor v0.18.0: einmal von Hand (Bootstrap)

`update.cmd` fragt das installierte Programm, welche Fassung es nehmen soll. Das
koennen erst Fassungen ab v0.18.0. Der Schritt auf v0.18.0 geht deshalb **einmal ueber
den Handweg** (unten): ZIP entpacken, `install.cmd` starten. Ein vorher gestartetes
`update.cmd` bricht ab mit
`FEHLER: Die installierte Fassung ist aelter als 0.18.0 und kennt diese Pruefung noch nicht.`
Bei dieser Gelegenheit die "Einmalige Einrichtung durch die IT" erledigen. Fassungen
**vor v0.15.0** zeigen nicht einmal den Hinweis; v0.15.0 bis v0.17.2 zeigen ihn nur
unter Einstellungen -> Erweitert -> Ueber, ohne Hinweisleiste und ohne Fehlergrund.

Die `install.cmd` vor v0.18.0 legte wegen eines echo-Fehlers (ein unmaskiertes `>` in
den Fortschrittszeilen wirkte als Umleitung) Dateien wie `Bundle` oder `Staging` im
Programmordner ab. Sie sind harmlos und verschwinden mit dem naechsten Update.

### Update-Hinweis (Ablageordner, ab v0.15.0)

Der Dienst sieht beim Start, danach alle 6 Stunden und sofort nach dem Speichern des
Ablageordners nach, ob dort eine neuere Release-ZIP liegt. Gesucht wird genau der Name,
den die CI baut: `testo-smart-abruf-<version>-win-x64.zip`. Gemeldet wird nur eine echt
hoehere Version, numerisch verglichen - die ZIP des vorigen Rollouts darf also liegen
bleiben. Eine Datei mit 0 Byte gilt als noch laufende Kopie und wird uebergangen.

**Der Start wird nie gesperrt.** Das ist eine bewusste Abweichung von der sonst
ueblichen Startsperre: eine gesperrte Klimaueberwachung waere schlimmer als eine
alte Fassung, und unter `NT AUTHORITY\NetworkService` (BootTrigger) sitzt niemand
davor, der eine Sperre wegklicken koennte. Der Dienst meldet nur.

**Der Dienst listet den Ordner nur.** Er liest Namen und Groessen, oeffnet keine Datei
darin, laedt nichts herunter, installiert nichts und startet keine Programme. Internet
oder GitHub fragt er nicht, der Ablageordner ist der einzige Weg. Standard ist ein
leerer Ablageordner (`update_dir`): dann ist die Pruefung aus, und es entsteht kein
Netzzugriff.

Wo das Ergebnis steht:

- **Hinweisleiste** unter der Kopfzeile, auf jeder Ansicht (Dashboard und
  Einstellungen), solange eine neuere Fassung bereitliegt:
  `Neue Fassung <Version> liegt bereit (installiert: <Version>). Installation durch die IT: update.cmd im Ablageordner <Ordner> als Administrator ausführen.`
  Ein Lesefehler erzeugt keine Leiste, er steht nur in den Einstellungen.
- **Einstellungen -> Erweitert -> Karte "Update-Hinweis":** unter dem Feld
  `Zustand: ...` mit dem Zeitpunkt der letzten Pruefung (etwa `geprüft vor 5 min`),
  bei einem Lesefehler darunter der Grund (Texte unter "Troubleshooting"). So zeigt
  sich direkt nach dem Speichern, ob **der Dienst** den Ordner lesen kann - nicht nur
  der angemeldete Benutzer.
- **Einstellungen -> Erweitert -> Ueber**, Zeile `Update`.
- Die Zustaende: `Prüfung aus (kein Ablageordner)`, `Prüfung läuft …`,
  `Ablageordner nicht lesbar`, `Update verfügbar: <Version>`, `Aktuell`.
- Maschinenlesbar: `GET /api/system/status`, Feld `update` mit `enabled`,
  `updateAvailable`, `latestVersion`, `latestFile`, `dir`, `error` (Klartext oder
  `null`), `checking`, `checkedAt`.
- `logs\app.log`: je Zustandswechsel genau eine Zeile `Update-Prüfung ...`.

### Einmalige Einrichtung durch die IT

1. **Ablageordner auf einer Freigabe** anlegen und per UNC-Pfad ansprechen, z. B.
   `\\fileserver\Software\TestoSmartAbruf`, nicht per Laufwerksbuchstaben: der Dienst
   laeuft ohne Benutzeranmeldung und sieht keine Netzlaufwerke.
2. **Leserecht fuer das Computerkonto** der Zielmaschine, auf der Freigabe **und** im
   NTFS: `DOMAENE\RECHNERNAME$` oder die Gruppe "Domaenencomputer". "Domaenen-Benutzer"
   genuegt nicht: der Dienst laeuft als `NT AUTHORITY\NetworkService` und greift im Netz
   als Computerkonto zu, und Computerkonten sind dort nicht Mitglied. Lesen genuegt.

   **Reiner Entra-ID-Join oder Arbeitsgruppe:** Dann kann NetworkService keine Freigabe
   lesen. Stattdessen einen lokalen Ordner auf der Zielmaschine nehmen und die ZIPs von
   Hand hineinlegen. NetworkService braucht darauf Leserecht, schreiben duerfen nur
   Administratoren (siehe "Betriebsregeln"); ein neuer Ordner unter `C:\` ist dagegen
   fuer Authentifizierte Benutzer beschreibbar. Passend ist dieselbe ACL, die
   `install.cmd` dem Programmordner gibt:
   ```powershell
   icacls "<Ablageordner>" /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-20:(OI)(CI)RX"
   ```
3. **`update_dir` setzen:** Einstellungen -> Erweitert -> Karte "Update-Hinweis", Feld
   "Ablageordner", Speichern. Oder per REST:
   ```powershell
   Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/settings `
     -ContentType 'application/json' `
     -Body '{"update_dir":"\\\\fileserver\\Software\\TestoSmartAbruf"}'
   ```
   Angenommen wird ein leerer Wert (= Pruefung aus) oder ein absoluter Pfad, ein
   relativer wird abgelehnt. Die Pruefung laeuft direkt nach dem Speichern, ein
   Dienstneustart ist nicht noetig. Danach die Karte ansehen: `Aktuell` oder
   `Update verfügbar: ...` heisst, der Dienst liest den Ordner;
   `Ablageordner nicht lesbar` nennt darunter den Grund.
4. **`update.cmd` einmal in den Ablageordner kopieren**, neben die ZIPs. Es liegt im
   Bundle unter `deploy\windows\update.cmd` und gehoert nur in den Ablageordner: aus
   einer Installation oder einem entpackten Bundle gestartet, bricht es ab.

### Ablauf eines Updates

Ausfuehren muss ein Konto, das auf der Zielmaschine **Administrator** ist **und** die
Freigabe lesen darf.

1. Die Hinweisleiste meldet `Neue Fassung <Version> liegt bereit ...`.
2. `update.cmd` im Ablageordner doppelklicken, gern ueber das verbundene Netzlaufwerk
   (`Q:\update.cmd`): es schreibt den Laufwerksbuchstaben vor der Rechteerhoehung auf
   den UNC-Pfad um, denn das erhoehte Fenster sieht die Netzlaufwerke des Benutzers
   nicht.
3. UAC mit "Ja" bestaetigen (`Administrator-Rechte werden angefordert...`). Die Arbeit
   laeuft in einem zweiten, erhoehten Fenster, das am Ende offen bleibt.
4. Den Bericht lesen. Welche Fassung es wird, entscheidet das **installierte**
   Programm nach derselben Regel wie die Hinweisleiste; jeder Eintrag des Ordners steht
   mit Grund da. Beispiel:
   ```text
    testo-smart-abruf: Update aus dem Ablageordner
    Ablageordner: "\\fileserver\Software\TestoSmartAbruf\"

   Update-Pruefung testo-smart-abruf
   Ablageordner:         \\fileserver\Software\TestoSmartAbruf
   Installierte Version: 0.18.0
   Ordner lesbar:        ja
   Eintraege:
     [--] testo-smart-abruf-0.18.0-win-x64.zip (nicht neuer)
     [ok] testo-smart-abruf-0.19.0-win-x64.zip (neuer)
     [--] update.cmd (fremder Name)
   Ergebnis: neuere Fassung 0.19.0 gefunden: testo-smart-abruf-0.19.0-win-x64.zip

    Neue Fassung: 0.19.0   Datei: testo-smart-abruf-0.19.0-win-x64.zip
    Der Dienst wird dafuer kurz gestoppt. Vorher sichert install.cmd die Datenbank.

   Jetzt installieren? [J/N]
   ```
   Weitere Gruende fuer `[--]`: `keine Datei`, `0 Byte, Kopie laeuft noch?`,
   `stat gescheitert (...)`.
5. `J` eingeben. `update.cmd` kopiert die ZIP nach `C:\Apps\TestoSmartAbruf.update`,
   prueft sie (`install.cmd`, `node.exe` und `VERSION` in der obersten Ebene, `VERSION`
   gleich der Version im Dateinamen), entpackt sie dort und startet `install.cmd` der
   **neuen** Fassung. Das baut das Staging `C:\Apps\TestoSmartAbruf.staging` (mit der
   `.env` der bisherigen Installation), zieht den Datenbank-Abzug noch bei laufendem
   Dienst, stoppt den Dienst, schaltet per `move` um (die bisherige Fassung wird zu
   `C:\Apps\TestoSmartAbruf.old`) und richtet die neue mit `setup.ps1 -Bundled` ein.
   Dessen Versionspruefung verlangt, dass der gestartete Dienst genau die Version aus
   der neuen `VERSION` meldet. Gelingt das, loescht `install.cmd` die `.old`; sonst
   rollt es automatisch zurueck (naechster Abschnitt).
6. Ende: `Update auf <Version> abgeschlossen.` Der Dienst prueft beim Start neu, die
   Hinweisleiste verschwindet. Im Browser einmal hart neu laden (Strg+F5).

`update.cmd` erwartet die Installation wie `install.cmd` unter `C:\Apps\TestoSmartAbruf`.
Exit-Code: 0 = aktualisiert oder nichts zu tun, 1 = Fehler oder Abbruch. Aussagekraeftig
ist er nur, wenn `update.cmd` schon erhoeht startet; sonst endet das erste Fenster nach
dem Anfordern der Rechte mit 0.

**Erhoeht die IT mit einem lokalen Admin-Konto (LAPS),** hat das erhoehte Fenster keine
Domaenenanmeldung und kann die Freigabe nicht lesen; es bleibt mit der Fehlermeldung von
Windows offen. Dann die ZIP **und** `update.cmd` in einen lokalen Ordner kopieren, in den
nur Administratoren schreiben duerfen (ACL wie in der Einrichtung, Schritt 2), und
`update.cmd` dort starten: es nimmt immer seinen eigenen Ordner als Quelle.

### Datenbank-Abzug und Rollback

- **Abzug vor jedem Update:** `install.cmd` sichert die Datenbank nach
  `C:\ProgramData\TestoSmartAbruf\klima-vor-update.db`, bevor es den Dienst stoppt
  (`VACUUM INTO`, die Datenbank nur lesend geoeffnet; erfasst auch, was erst im `-wal`
  steht). Scheitert der Abzug, bricht das Update ab und der Dienst laeuft unveraendert
  weiter. Jedes Update ersetzt den Abzug des vorigen. Bei der Erstinstallation gibt es
  noch keine Datenbank und damit keinen Abzug.
- **Automatischer Rollback:** Scheitert die Einrichtung der neuen Fassung (`setup.ps1`,
  einschliesslich der Versionspruefung), deaktiviert `install.cmd` zuerst die Aufgabe
  (sonst startete sie die abgestuerzte Fassung neu), stoppt den Dienst, verschiebt die
  neue Fassung nach `C:\Apps\TestoSmartAbruf.failed` und die vorherige zurueck nach
  `C:\Apps\TestoSmartAbruf`. Dann richtet es die vorherige mit ihrem eigenen
  `setup.ps1 -Bundled` wieder ein; das registriert die Aufgabe neu und damit wieder
  aktiv. Den Abzug benennt es in `klima-vor-update.fehlgeschlagen.db` um, damit ein
  neuer Versuch ihn nicht mit seinem eigenen Abzug ueberschreibt; ein weiterer
  gescheiterter Versuch ersetzt ihn. Nach einem Rollback endet `install.cmd` mit Exit 1.
- **Zurueckgesetzt wird nur der Code, nie die Daten.** Die Datenbank bleibt, wie die
  gescheiterte Fassung sie hinterlassen hat. Deshalb duerfen neue Fassungen das Schema
  nur ergaenzen: die vorherige muss es vertragen. Wird der Stand von vor dem Update
  gebraucht, den Abzug zurueckspielen, und zwar **nur** ueber "Datenbank
  zuruecksichern" - nicht einfach ueber `klima.db` kopieren, sonst spielt SQLite die
  alte `-wal` hinein.

### Handweg (Rueckfall)

Geht `update.cmd` nicht - Installation vor v0.18.0, kein Ablageordner, Abbruch im
Ablauf -, bleibt der Weg aus "Installation aus dem Bundle": die neue ZIP per
**"Alle extrahieren"** entpacken, darin `install.cmd` doppelklicken. Das ist dieselbe
`install.cmd` mit Abzug und Rollback; `update.cmd` erledigt davor nur Auswahl, Kopie und
Pruefung der ZIP.

### Betriebsregeln fuer den Ablageordner

- Der Dateiname ist zeichengenau `testo-smart-abruf-X.Y.Z-win-x64.zip`. Kein `v`, keine
  Zusaetze, kein `(1)`.
- Andere Dateien im Ordner stoeren nicht, dafuer ist das strikte Muster da. Auch
  `update.cmd` liegt ja darin.
- **Erst unter fremdem Namen kopieren, dann umbenennen.** Wer direkt unter dem
  Zielnamen kopiert, hat die Datei minutenlang unvollstaendig im Ordner: der Dienst
  meldet sie schon als neue Fassung (uebergangen wird nur eine Datei mit 0 Byte), und
  ein `update.cmd` in dieser Zeit holt Bruchstuecke.
- Alte Fassungen duerfen liegen bleiben, es gewinnt die hoechste Nummer.
- Zum Zurueckziehen muss die Fassung **geloescht** werden. Eine aeltere danebenzulegen
  hilft nicht, `update.cmd` waehlt nur eine hoehere Nummer als die installierte.
- **Schreibrecht auf den Ablageordner hat nur die Stelle, die das Release bereitstellt.**
  Wer dort schreiben darf, kann Code mit Adminrechten zur Ausfuehrung bringen, sobald
  die IT `update.cmd` startet: `update.cmd` selbst liegt dort, und aus der ZIP laufen
  `install.cmd` und `node.exe` mit Adminrechten. Eine Pruefsumme oder Signatur der ZIP
  prueft `update.cmd` nicht; die Schreibrechte sind die Sicherung.
- Abschalten: `update_dir` leeren. Dann prueft der Dienst nichts mehr und greift nicht
  auf den Ordner zu.

### Versionsstand beim Release (Entwickler)

Nach jedem App-Update **VERSION**, README-Badge und die `?v=`-Cache-Buster im
`Klima Dashboard.html` synchron halten (gleicher SemVer). Achtung: `?v=` kommt
**mehrfach** vor — in jedem App-`<script src="...?v=...">`-Tag und im
`dashboard.css`-`<link>` (aktuell 18; die drei `vendor/`-Tags tragen bewusst keinen) —
alle zugleich bumpen, nicht nur eins. Der Server sendet keine Cache-Header → der
`?v=`-Bump ist der einzige Invalidierungs-Hebel; im Browser des Bedieners
zusaetzlich einmal hart neu laden (Strg+F5).

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

Dazu kommt der **Vor-Update-Abzug** von `install.cmd`:
`C:\ProgramData\TestoSmartAbruf\klima-vor-update.db`, der Stand unmittelbar vor dem
letzten Update, nach einem Rollback umbenannt in `klima-vor-update.fehlgeschlagen.db`
(siehe "Update der App"). Er ist ebenso vollstaendig und der Ruecksprungpunkt, wenn eine
neue Fassung Daten beschaedigt hat. Er entsteht unabhaengig von `backup_enabled`, liegt
im Datenordner statt im Backup-Verzeichnis und wird genauso zurueckgespielt (Abschnitt
"Datenbank zuruecksichern").

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
   Der Vor-Update-Abzug genauso: `Copy-Item klima-vor-update.db klima.db` (bzw.
   `klima-vor-update.fehlgeschlagen.db` nach einem Rollback).
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

### Update-Hinweis und update.cmd

**Update-Karte** (Einstellungen -> Erweitert -> "Update-Hinweis"). Steht dort
`Zustand: Ablageordner nicht lesbar`, nennt der Text darunter den Grund:

- `Ablageordner „<Ordner>“ nicht lesbar: Zugriff verweigert (EPERM). Der Dienst läuft als NT AUTHORITY\NetworkService und greift im Netz als Computerkonto (DOMÄNE\RECHNERNAME$) zu. Dieses Konto braucht Leserecht auf Freigabe und Ordner.`
  (statt `EPERM` auch `EACCES`): Das Computerkonto darf Freigabe oder Ordner nicht
  lesen, oft ist nur "Domaenen-Benutzer" berechtigt. Leserecht auf Freigabe **und** NTFS
  fuer `DOMAENE\RECHNERNAME$` oder "Domaenencomputer" geben ("Einmalige Einrichtung",
  Schritt 2). Bei reinem Entra-ID-Join oder in einer Arbeitsgruppe hilft das nicht:
  lokalen Ordner nehmen.
- `Ablageordner „Q:\…“ nicht lesbar: nicht gefunden (ENOENT). Ist Q: ein Netzlaufwerk? Laufwerksbuchstaben von Netzlaufwerken sieht der Dienst nicht – bitte den UNC-Pfad eintragen, z. B. \\fileserver\Software\TestoSmartAbruf.`
  Im Feld steht ein Laufwerksbuchstabe. Verbundene Netzlaufwerke gehoeren zur Anmeldung
  eines Benutzers, der Dienst hat keine: den UNC-Pfad eintragen. Derselbe Text erscheint
  fuer einen lokalen Pfad, den es nicht gibt.
- `Ablageordner „<Ordner>“ nicht lesbar (<Fehlercode und Meldung von Node>).`: jeder
  andere Lesefehler, etwa Server nicht erreichbar oder Freigabe- bzw. Ordnername falsch.
  Pfad pruefen und erneut speichern.
- `Update-Prüfung fehlgeschlagen: <Meldung>`: Die Pruefung selbst ist gescheitert, etwa
  beim Lesen der Einstellung. Der Dienst laeuft weiter; Einzelheiten in `logs\app.log`.

Ein relativer Pfad wird schon beim Speichern abgelehnt:
`Ablageordner (update_dir) muss ein absoluter Pfad sein, am besten ein UNC-Pfad wie \\fileserver\Software\TestoSmartAbruf (leer = Prüfung aus).`

**Keine Hinweisleiste, obwohl eine neue ZIP liegt** (`Zustand: Aktuell`): Der Name
weicht ab, die Datei hat 0 Byte, oder die Version ist nicht hoeher. Die Pruefung laeuft
nur beim Start, alle 6 Stunden und nach dem Speichern; erneutes Speichern prueft sofort.
Welchen Eintrag das Programm aus welchem Grund verwirft, zeigt ein Bericht ohne
Installation, aus einer **Administrator**-Eingabeaufforderung (der Programmordner ist
nur fuer Administratoren lesbar). Er liest als angemeldeter Benutzer, nicht als Dienst,
und schreibt nichts:

```powershell
C:\Apps\TestoSmartAbruf\node.exe C:\Apps\TestoSmartAbruf\backend\update-check.js --check-update \\fileserver\Software\TestoSmartAbruf
```

Exit-Code: 0 = neuere Fassung, 10 = nichts Neueres, 2 = Ordner nicht lesbar, 3 = Aufruf
falsch oder eigene `VERSION` unlesbar.

**Meldungen von update.cmd und install.cmd** (wortgetreu, `<...>` steht fuer den
eingesetzten Wert):

| Meldung | Bedeutung, was tun |
|---|---|
| `Nichts zu tun: im Ablageordner liegt keine neuere Fassung.` | Kein Fehler, Exit 0. Warum ein Eintrag nicht zaehlt, steht im Bericht darueber (`[--] <Name> (<Grund>)`). |
| `FEHLER: Die installierte Fassung ist aelter als 0.18.0 und kennt diese Pruefung noch nicht.` | Bootstrap: einmal den Handweg nehmen, danach geht jedes Update ueber `update.cmd`. |
| `FEHLER: Der Ablageordner ist nicht lesbar, Grund siehe oben.` | Den Grund nennt die Zeile `Ergebnis: Ablageordner ... nicht lesbar ...` darueber. Hier liest das Konto, mit dem `update.cmd` laeuft, nicht der Dienst: der Hinweis auf das Computerkonto in diesem Text gilt dann nicht, sondern dieses Konto braucht das Leserecht (LAPS: siehe "Ablauf eines Updates"). |
| `FEHLER: <Datei> laesst sich nicht lesen - defekt oder unvollstaendig in den Ablageordner kopiert?` | `tar` kann die ZIP nicht lesen, meist eine abgebrochene oder noch laufende Kopie. Neu kopieren, erst unter fremdem Namen, dann umbenennen. |
| `FEHLER: <Datei> hat install.cmd, node.exe und VERSION nicht in der obersten Ebene.` | Die ZIP ist falsch gebaut: eine ZIP in der ZIP oder ein Oberordner. Die Inhaltsliste steht in `C:\Apps\TestoSmartAbruf.update\inhalt.txt`. Nur die Release-ZIP der CI unveraendert ablegen, nicht neu packen. |
| `FEHLER: VERSION in der ZIP lautet "<a>", der Dateiname sagt "<b>".` | ZIP umbenannt oder falsch gebaut. Ohne diese Pruefung meldete das Dashboard nach dem Update weiter eine neue Fassung. Die Release-ZIP unter ihrem Originalnamen ablegen. |
| `FEHLER: Rechteerhoehung abgelehnt oder gescheitert. Nichts geaendert.` | UAC abgelehnt oder das Konto ist kein Administrator. |
| `FEHLER: install.cmd endete mit Exit-Code <n>, Einzelheiten siehe oben.` | Die Meldungen von `install.cmd` darueber lesen (folgende Zeilen). `C:\Apps\TestoSmartAbruf.update` bleibt zur Diagnose liegen, der naechste Lauf raeumt ihn weg. |
| `FEHLER: Datenbank-Abzug gescheitert, der Dienst laeuft unveraendert weiter.` | Vor dem Stopp: nichts geaendert. Die Ausgabe darueber nennt den Fehler. |
| `FEHLER: Server meldet Version '<a>', installiert ist '<b>' (C:\Apps\TestoSmartAbruf\VERSION).` | Aus `setup.ps1`: auf dem Port antwortet noch ein alter Prozess (der Hinweis zum verwaisten `node.exe` steht darueber). Loest den Rollback aus. |
| `ROLLBACK abgeschlossen: die vorherige Version laeuft wieder. Die gescheiterte liegt in "C:\Apps\TestoSmartAbruf.failed".` | Die neue Fassung liess sich nicht einrichten, die vorherige laeuft. Ursache in den Zeilen darueber, in `logs\setup.log` und `logs\app.log`. Der Abzug liegt als `klima-vor-update.fehlgeschlagen.db` bereit. |
| `ROLLBACK unvollstaendig: auch die vorherige Version startet nicht, Exit-Code <n>. Log: C:\ProgramData\TestoSmartAbruf\logs\app.log` | Ursache in `logs\app.log` und `logs\setup.log`. Scheitert die vorherige Fassung an der Datenbank, die die neue schon veraendert hat, `klima-vor-update.fehlgeschlagen.db` zurueckspielen ("Datenbank zuruecksichern"). |
| `FEHLER: Der ROLLBACK blieb stehen, ein Ordner ist gesperrt. Die Aufgabe TestoSmartAbruf ist deaktiviert.` | Ein `move` scheiterte, meist haelt ein Fenster oder Programm einen der Ordner offen. Schliessen, dann die ausgegebenen Handschritte (unten) in einer Admin-Eingabeaufforderung. |

Die Handschritte nach `Der ROLLBACK blieb stehen`, wie `install.cmd` sie ausgibt. Die
ersten beiden nur, solange `C:\Apps\TestoSmartAbruf` noch die neue Version enthaelt;
`setup.ps1` registriert die Aufgabe neu und aktiviert sie damit wieder:

```cmd
rmdir /s /q "C:\Apps\TestoSmartAbruf.failed"
move "C:\Apps\TestoSmartAbruf" "C:\Apps\TestoSmartAbruf.failed"
move "C:\Apps\TestoSmartAbruf.old" "C:\Apps\TestoSmartAbruf"
powershell -ExecutionPolicy Bypass -File "C:\Apps\TestoSmartAbruf\deploy\windows\setup.ps1" -Bundled
```

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

- `GET /api/system/status` → Feld `appVersion` lautet `0.18.0`.
- Alle App-`<script src="…?v=…">`-Tags **und der `dashboard.css`-`<link>`** im `Klima Dashboard.html` tragen dieselbe Version wie `appVersion` (Browserkonsole: keine 404 auf `.js`/`.jsx`/`.css`-Ressourcen). Die drei `vendor/`-Tags tragen bewusst keinen Cache-Buster. **Ein 404 auf `dashboard.css` ist der schlimmste Fall dieser Liste** — die Seite laedt dann vollstaendig unformatiert, ohne Fehlermeldung.

### Update-Hinweis (ab v0.15.0)

- **Alt-ZIP-Probe:** In den leeren Ablageordner NUR die ZIP einer **aelteren**
  Fassung legen (`testo-smart-abruf-0.9.0-win-x64.zip` — diese Nummer bleibt
  bewusst fest, sie traegt die Zeichenketten-Falle weiter unten), `update_dir`
  setzen ("Einmalige Einrichtung durch die IT", Schritt 3) und Einstellungen -> Erweitert ->
  Ueber oeffnen: die Zeile `Update` muss `Aktuell` zeigen. Erst wenn zusaetzlich
  eine ZIP mit **echt hoeherer** Version als der laufenden im Ordner liegt (etwa
  die naechste Patch-Version) und `update_dir` erneut gespeichert wird, muss dort
  `Update verfügbar: <diese hoehere Version>` stehen.
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
- **Fehlergrund sichtbar (ab v0.18.0):** `update_dir` auf eine Freigabe setzen, die
  Benutzer lesen duerfen, das Computerkonto aber nicht. Kurz nach dem Speichern zeigt die
  Karte "Update-Hinweis" `Zustand: Ablageordner nicht lesbar` und darunter den Grund
  (erwartet: `Zugriff verweigert` mit dem Hinweis auf das Computerkonto); eine
  Hinweisleiste erscheint dabei nicht. Leserecht fuer das Computerkonto geben, erneut
  speichern: der Zustand wechselt auf `Aktuell` bzw. `Update verfügbar: <Version>`.
- **Hinweisleiste auf jeder Ansicht (ab v0.18.0):** Mit einer echt hoeheren ZIP im
  Ablageordner steht `Neue Fassung <Version> liegt bereit ...` unter der Kopfzeile des
  Dashboards und ebenso in den Einstellungen, mit installierter Version und
  Ablageordner.

### Update per update.cmd (ab v0.18.0)

Erstinstallation, Update und Rollback prueft schon der Windows-CI-Installtest
(`windows-bundle.yml`, Schritte "Installtest 1/4" bis "4/4"). Hier bleibt, was keine CI
kann: der UAC-Zweig (Runner arbeiten als Admin ohne UAC) und eine echte Freigabe, die der
Dienst als Computerkonto liest.

- **Doppelklick aus dem gemappten Laufwerk:** Als Benutzer, der Administrator ist, aber
  nicht erhoeht arbeitet, den Ablageordner als Laufwerk verbinden und dort `update.cmd`
  doppelklicken. Erwartet: die UAC-Abfrage erscheint; im erhoehten Fenster nennen die
  Zeilen `Ablageordner:` den UNC-Pfad, nicht den Laufwerksbuchstaben; nach `J` laeuft das
  Update durch (`Update auf <Version> abgeschlossen.`), `GET /api/system/status` meldet
  in `appVersion` die neue Version, und
  `C:\ProgramData\TestoSmartAbruf\klima-vor-update.db` ist vorhanden.
- **NetworkService liest die echte Freigabe:** `update_dir` auf die UNC-Freigabe der IT
  setzen, nicht auf einen lokalen Ordner. Die Karte "Update-Hinweis" zeigt `Aktuell` oder
  `Update verfügbar: <Version>`, keinen Fehlergrund. Die CI prueft den Dienst nur an
  einem lokalen Ordner.

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
