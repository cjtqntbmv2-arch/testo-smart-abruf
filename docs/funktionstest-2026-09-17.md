# Funktionstest testo-smart-abruf v0.16.1

Stand: 2026-09-17 · Prüfling: laufende Live-Instanz auf `http://localhost:3000`
Schwerpunkt: Bedienerfehler, Fehleingaben, Logging, Export, Datensicherung — soweit möglich über die Oberfläche.

> Überarbeitete Fassung nach adversarialer Review (3 Reviewer). Was sich geändert hat, steht am Ende in Abschnitt 6.

## 1. Ausgangslage

| Punkt | Wert |
|---|---|
| Version | 0.16.1 |
| Daten | 4 Messstellen, 171.198 Messwerte (Juni–September 2026), 2.174 Ereignisse, 6 Grenzwerte |
| Anbindung | echter API-Schlüssel, Region EU, kein Mock |
| Sync | alle 900 s, letzter Lauf erfolgreich |
| Datensicherung | aktiv, Ordner `backups/`, 19 ZIPs |
| Automatische Tests | **330/330 grün** — zwei Blöcke: 168 Backend + 162 Frontend |

Zur Testzahl: `npm test` verkettet beide Blöcke mit `&&` und druckt **zwei** Zusammenfassungen. Schlägt der Backend-Block fehl, läuft der Frontend-Block gar nicht erst — dann fehlen 162 Tests, ohne dass das auffällt. Beim Abarbeiten immer beide Zahlen ablesen.

**Werkzeug-Hinweis:** Die Sandbox dieser Sitzung blockiert `listen()` und ausgehende localhost-Verbindungen (EPERM). Alle HTTP-Testfälle brauchen ein Terminal außerhalb der Sandbox, sonst erscheinen Sandbox-Sperren als App-Fehler.

### Referenzstand (aus der Sicherung, Vorher-Wert für G5)

Summen allein finden keinen Teilverlust. Diese Tabelle ist der Vergleichsmaßstab:

| Messstelle | 2026-06 | 2026-07 | 2026-08 | 2026-09 | Summe |
|---|---:|---:|---:|---:|---:|
| Büro | 10120 | 11740 | 11904 | 6304 | **40068** |
| EMC | 12885 | 14900 | 14905 | 7480 | **50170** |
| UWL | 10816 | 11792 | 11896 | 6304 | **40808** |
| uwl3 | 10176 | 11784 | 11888 | 6304 | **40152** |

Ereignisse: Büro 376 · EMC 1092 · UWL 405 · uwl3 301 · **gesamt 2.174**

Der September wächst während des Tests weiter (~50 Messwerte je Stunde über alle Stationen). **G5 prüft daher „je Station und Monat ≥ Referenz", nicht „gleich".**

### Sicherung

- `klima.backup-vor-funktionstest-20260917-121422.db` im Projektordner — über `.backup` erstellt, `integrity_check: ok`, git-ignoriert. Enthält alle fünf Tabellen samt vollständiger `settings` (Schlüssel, Region, Intervall, Aufbewahrung, Format). Ein Rücktausch heilt damit auch C13 und C15 vollständig.
- **Vor Block E zusätzlich sichern:** `JSON.stringify(localStorage)` in der Browserkonsole ausgeben und wegkopieren. Das Kachel-Layout liegt nur dort, eine Import-Funktion gibt es im Code nicht.

### Rückweg nach dem Test — in genau dieser Reihenfolge

1. Server **sauber** stoppen (SIGINT/SIGTERM, *nicht* `kill -9` / `taskkill /F`). `server.js:588-599` fährt darauf Scheduler und Datenbank geordnet herunter.
2. Prüfen, dass `klima.db-wal` und `klima.db-shm` **verschwunden** sind. Sind sie noch da, von Hand löschen.
3. Erst dann die Sicherung als `klima.db` einspielen.
4. Server starten, gegen die Referenztabelle abgleichen.

> **Schritt 2 ist nicht optional.** Die Datenbank läuft im WAL-Modus (`db.js:18`). Bleibt eine WAL-Datei liegen, spielt SQLite sie auf die frische Sicherung zurück. Nachgemessen: Rückweg ohne Schritt 2 → **48.563 statt 171.198 Messwerte** und `integrity_check: "database disk image is malformed"` — der Schaden bleibt, die Datenbank ist zusätzlich kaputt und öffnet trotzdem ohne Fehlermeldung. Mit Schritt 2: 171.198 / 4 / 2.174, `integrity_check: ok`.

**Was der Rücktausch *nicht* heilt:** angelegte Ordner aus A3/A4/A6 (entstehen im Projektordner, **nicht** git-ignoriert — `.gitignore` deckt nur `backups/`), neue ZIPs in `backups/`, und das `localStorage`-Layout.

## 2. Vorab-Befunde

Aus Code und Datenbestand belegt, vor dem ersten Testfall. Die mit **(A)** markierten wurden durch Ausführung bestätigt, nicht nur durch Lektüre.

### Schwer

| # | Befund | Beleg |
|---|---|---|
| V1 | **Kein Wiederherstellungsweg.** Kein Code, keine Dokumentation, um aus einem Backup-ZIP wieder einen lauffähigen Zustand zu machen. Die ZIPs enthalten die `uuid` der Messwerte nicht — Rückspielen erzeugte Duplikate beim nächsten Abgleich. | repoweite Suche; Spaltensatz vs. `measurements`-Schema |
| V2 | **Der Sicherung fehlen `settings`, die `limits`-Tabelle und aus `stations` die Felder `device_uuid`/`mo_uuid`.** Name, Standort, Seriennummer und Modell stehen im ZIP-Kopf, die ID im Dateinamen — die sind rekonstruierbar. Die beiden UUIDs sind der betriebskritische Teil: ohne sie synct eine wiederhergestellte Messstelle nicht mehr. **(A)** | ZIP-Kopf vs. `.schema stations` |
| V3 | **Der laufende Monat wird nie gesichert** — `backup-runner.js` sichert nur abgeschlossene Monate (`lastComplete` als exklusive Obergrenze). Aktuell 26.392 Messwerte ungesichert, am Monatsende bis zu 31 Tage. Auch nach Löschen *jedes* ZIP liefert `computePruneFloor` nie den laufenden Monat. **(A)** | Trockenlauf gegen DB-Kopie |
| V4 | **Abfrage-Intervall ohne Obergrenze → Dauerlast.** `poll_interval_sec: 999999999` → HTTP 200, Log meldet „Syncing every 999999999 seconds", Node quittiert mit `TimeoutOverflowWarning … Timeout duration was set to 1`; die Zyklen liefen danach unmittelbar hintereinander. Über die Oberfläche nicht erreichbar (Regler 60–3600), über die API sehr wohl. **(A)** | `server.js:93-98`, `scheduler.js:459-461` |
| V5 | **Aufbewahrungszeit ist eine scharfe Waffe ohne Sicherung.** Gemessen gegen den echten Bestand: `retention_days=30` löscht **71,6 %**, `=1` löscht **99,3 %** (170.037 von 171.198) plus 2.167 Ereignisse. Die Prune-Sperre `computePruneFloor` existiert, steht im Ist-Zustand aber auf `Infinity` und schützt nichts, weil jeder abgeschlossene Monat ein ZIP hat. **(A)** | `scheduler.js:419-434`, `backup-runner.js:118-134` |
| V24 | **Dritter Weg zum Datenverlust:** Bei `backup_enabled=false` liefert `computePruneFloor` sofort `Infinity` — die Sperre ist dann vollständig aus. Die Kombination „Sicherung aus + kleine Aufbewahrung" löscht ungebremst, auch ungesicherte Monate. Über die Oberfläche in zwei Klicks erreichbar. **(A)** | `backup-runner.js:118-134` |

### Mittel

| # | Befund | Beleg |
|---|---|---|
| V6 | **Log-Zeilen haben keine Zeitstempel.** 24 `console.*` im Backend, kein einziger. `start.cmd:25` nutzt `Get-Date` nur für den Rotations-*Dateinamen*. **(A)** | alle `console.*` in `backend/` |
| V7 | **Die Update-Prüfung schweigt vollständig** — 0 Logzeilen in 104 Zeilen `update-check.js`. Toter Pfad, fehlende Rechte, falscher Ordner: alles sieht aus wie „kein Update vorhanden". **(A)** | `update-check.js` |
| V8 | **Nur der zuletzt fehlgeschlagene Schritt ist sichtbar.** Sechs Fehlerfänge überschreiben `errorMsg`. Bei falschem Schlüssel scheitern alle, im Dashboard steht einer. | `scheduler.js:108,141,200,239,379,433` |
| V9 | **Leerer Schlüssel im Feld löscht nichts** — wird aus dem Request ausgelassen, der alte bleibt aktiv, ohne Hinweis. | `settings.jsx:164-166` |
| V10 | **Werkseinstellungen setzen den Schlüssel nicht zurück** (folgt aus V9); der Bestätigungstext nennt den Umfang nicht. | `settings.jsx:713` |
| V11 | **Bereits geschriebene ZIPs werden nie erneuert.** Der Ist-Bestand ist im RFC-Format, die Einstellung steht auf Deutsch — im ZIP steht wörtlich `CSV-Format,"International (RFC)…"`. `getDialect` selbst arbeitet korrekt; die Mischung kommt vom `existsSync`-Skip. **(A)** | `backup-runner.js:83` |
| V12 | **Das Kachel-Layout lebt nur im Browser** (`localStorage`). Anderer Browser, geleerter Cache → leeres Dashboard. Beim Öffnen reproduziert. | `app.jsx:11` |
| V13 | **Navigations-Schaltflächen ohne zugänglichen Namen** — die sechs Einstellungs-Reiter sind im Accessibility-Baum namenlos. | `read_page` der laufenden App |
| V14 | **`GET /api/stations/:id/events` hat weder Obergrenze noch Standardwert.** Ohne `limit`, mit `limit=-1`, `0` oder `abc`: immer der volle Bestand (203 Zeilen gemessen). `limit=-1` gewinnt nichts gegenüber dem Weglassen. **(A)** | `server.js:305-309` |
| V15 | **Kaputtes JSON ergibt 500 statt 400** — bei *allen* POST-Endpunkten, `/api/export` eingeschlossen. Die interne Parser-Meldung geht an den Aufrufer. Zusätzlich: `POST /api/settings` mit leerem Body quittiert `success: true`, obwohl nichts gespeichert wurde, und startet dabei den Scheduler neu. **(A)** | `server.js:47` + `:563`, `:156` |

### Leicht

| # | Befund |
|---|---|
| V16 | Leeres Datumsfeld im Export meldet „Zeitraum ungültig (von > bis)" — `fromTs=NaN` fällt in dieselbe Prüfung. **(A)** |
| V17 | Kein Doppelklick-Schutz bei „Zuweisung Speichern" und „Löschen". |
| V18 | Die Messstellen-ID filtert beim Tippen stillschweigend — „Büro" wird zu „bro". |
| V19 | Kein Touch-Support: Kacheln auf Tablets weder verschiebbar noch skalierbar. |
| V20 | Kein responsives Raster — 12 Spalten fest. |
| V21 | `backup_enabled` nimmt `"ja"`, `"nein"`, `123`, `null` alle als „Ein". **(A)** |
| V22 | `backup_dir: 12345` legt tatsächlich einen Ordner `12345` im Arbeitsverzeichnis an. **(A)** |
| V23 | Kachel entfernen ohne Rückfrage; der Kachel-Assistent verwirft Eingaben bei Esc ohne Rückfrage. |

**Geprüft und verworfen:** Der gemeldete kaputte UNC-Platzhalter ist keiner — JSX-Attribute interpretieren keine Escapes, im DOM steht der Pfad korrekt. Die Notiz, Kopfzeile und Dialoge lägen ausserhalb einer Fehlergrenze, ist überholt; ungeschützt ist nur die Wurzelkomponente. Und die fünf kleinen ZIPs im Sicherungsordner (`A1_Station`, `A2_Station`, `Retention_Test`, `Rowid_Test`, `Wohnzimmer`) sind **keine Leichen gelöschter Messstellen**, sondern Testartefakte aus `scheduler.test.js` — der Testcode umgeht das Problem inzwischen, sie sind historische Überreste.

## 3. Testplan

Legende: ✔ soll funktionieren · ⚠ erwarteter Schwachpunkt · ? offen, mit Durchfallkriterium

### A — Datensicherung und Wiederherstellung

| # | Testfall | Weg über die Oberfläche | Erwartung |
|---|---|---|---|
| A1 | Sicherungs-Status | Einstellungen → Datenexport → Kasten unten | ✔ „Aktiv", Ordner, letzter Scan, letzte Datei |
| A2 | Sicherung aus und wieder ein | Schalter „Automatisches Backup" | ✔ Zustand überlebt Neuladen |
| A3 | Pfad auf nicht existierenden Ordner | `backups-test-neu` → Speichern | ✔ wird angelegt |
| A4 | Pfad auf schreibgeschützten Ordner | `chmod 500`-Ordner → Speichern | ✔ 400, **alter Pfad bleibt** (der Wert wird nie gespeichert) |
| A5 | Pfad auf eine **Datei** | Pfad auf `VERSION` → Speichern | ✔ `EEXIST` → 400; `VERSION` bleibt unbeschädigt |
| A6 | Pfad mit Umlauten und Leerzeichen | `Sicherung Büro Ä` → Speichern | ? Ordner entsteht. **Durchgefallen**, wenn der Name verstümmelt ankommt |
| A7 | Pfad leeren | Feld leeren → Speichern | ✔ Rückfall auf Standardordner. **Vorbedingung für A8** |
| A8 | **Sicherungslauf auslösen und beobachten** | vorher: leeren Pfad bestätigen; **eine vorhandene ZIP beiseitelegen** (`mv backups/UWL_uwl_2026-08.zip $TMPDIR/`); `last_backup_scan_date` zurücksetzen; „Erneut synchronisieren" | ✔ die beiseitegelegte ZIP wird **neu geschrieben**. Ohne diesen Kniff schreibt der Lauf nichts (alle 12 ZIPs existieren) und der Testfall kann nicht durchfallen. **Danach die Originaldatei zurücklegen** — sonst senkt der fehlende Monat `computePruneFloor` und verfälscht G0a |
| A9 | Laufender Monat bleibt ungesichert | nach A8 auf September-ZIPs prüfen | ⚠ V3 — entstehen nicht |
| A10 | Sicherungsfehler wird sichtbar | **gültigen** Ordner speichern, **danach** `chmod 500` darauf, Lauf auslösen | ✔ rote Status-Pille + Fehlertext. (Über A4 nicht erreichbar — ein unbeschreibbarer Pfad wird gar nicht erst gespeichert) |
| A11 | CSV-Format der Sicherung umstellen | „CSV-Format der Monats-Backups" | ✔ gespeichert; ⚠ Altbestand bleibt (V11) |
| A12 | **Wiederherstellungsprobe** | ZIP entpacken, Rückweg zu funktionierenden Daten versuchen | ⚠ V1 — nicht möglich; Umfang des Verlusts dokumentieren |
| A13 | Vollständigkeitsprobe | ZIP-Zeilen gegen die Referenztabelle in Abschnitt 1 | ✔ müssen übereinstimmen |
| A14 | Was fehlt der Sicherung | ZIP-Inhalt gegen `.schema` | ⚠ V2 — `settings`, `limits`, `device_uuid`/`mo_uuid`. Name/Standort/Seriennummer/Modell sind **vorhanden** und kein Mangel |

### B — Export

| # | Testfall | Weg | Erwartung |
|---|---|---|---|
| B1 | Standardexport | „Exportieren" | ✔ ZIP mit 4 CSV |
| B2 | Eine Messstelle, ohne Meldungen | eine Checkbox | ✔ einzelne CSV statt ZIP |
| B3 | Mit Meldungen | Schalter „Meldungen & Alarme" | ✔ erzwingt ZIP, zwei CSV je Stelle |
| B4 | Keine Messstelle gewählt | alle Haken weg | ✔ Meldung, kein Request |
| B5 | Von/Bis vertauscht | Bis vor Von | ✔ Meldung „von > bis" |
| B6 | Von leer lassen | Von-Feld leeren | ⚠ V16 — irreführende Meldung |
| B7 | Zeitraum in der Zukunft | 2030 | ⚠ keine Prüfung; leere CSV mit Hinweiszeile |
| B8 | Zeitraum ohne Daten | Januar 2020 | ✔ CSV mit Kopf + Hinweis |
| B9 | Sehr großer Zeitraum | 2000–2030, alle Stellen, mit Meldungen | ? **Durchgefallen** bei Serverfehler, Abbruch oder >60 s ohne Antwort |
| B10 | Deutsches Format | Format „Deutsch" | ✔ BOM, CRLF, `;`, Dezimalkomma |
| B11 | Internationales Format | Format „International" | ✔ `,` und Dezimalpunkt |
| B12 | Umlaut im Dateinamen | Station „Büro" | ✔ korrekter Name, UTF-8-Flag im ZIP |
| B13 | Formelzeichen im Namen | Station auf `=1+1` umbenennen | ✔ mit `'` entschärft |
| B14 | Nur eine Messgröße | eine Checkbox | ✔ CSV mit genau dieser Spalte |
| B15 | Messgröße, die die Station nicht hat | Luftdruck bei Station ohne Drucksensor | ? **Durchgefallen** bei Fehler oder falsch zugeordneten Werten; leere Spalte und Auslassung sind beide zulässig |
| B16 | Export während laufendem Abgleich | gleichzeitig | ✔ beides geht durch |
| B17 | Doppelklick auf „Exportieren" | zweimal schnell | ✔ Knopf gesperrt |

### C — Einstellungen und Fehleingaben

| # | Testfall | Weg | Erwartung |
|---|---|---|---|
| C1 | Schlüssel-Feld leeren und speichern | Feld leeren | ⚠ V9 — alter bleibt, ohne Hinweis |
| C2 | Schlüssel mit Leerzeichen | ` schlüssel ` einfügen | ⚠ kein Trim — Ursache unsichtbar |
| C3 | Falscher Schlüssel | Unsinn → „Verbindung testen" | ✔ klare Fehlermeldung |
| C4 | Fehlermeldung danach | Übersicht ansehen | ⚠ V8 — nur letzter Schritt |
| C5 | Schlüssel wiederherstellen | echten Wert zurück | ✔ wieder grün |
| C6 | Region umstellen | EU → AP → testen | ✔ schlägt fehl; zurückstellen heilt |
| C7 | Intervall Minimum/Maximum | Regler 1 bzw. 60 min | ✔ gespeichert |
| C8 | **Intervall über die API verbiegen** | **Zuerst den Schlüssel auf einen ungültigen Wert setzen**, dann `poll_interval_sec: 999999999` | ⚠ V4 — messbar an `TimeoutOverflowWarning` und der Frequenz der 401-Antworten. Entschieden: kein echter Anfragensturm gegen die Cloud |
| C9 | Intervall 0 / negativ / „abc" per API | drei Aufrufe | ✔ je 400 |
| C10 | Intervall `"900abc"` per API | Aufruf | ⚠ Teilparse ergibt 900 |
| C13 | Werkseinstellungen zurücksetzen | Erweitert → Zurücksetzen | ⚠ V10 — Schlüssel überlebt |
| C14 | Ablageordner auf Unsinn | `Z:\gibtsnicht` → Speichern | ⚠ V7 — angenommen, keine Rückmeldung, kein Logeintrag |
| C15 | `api_key: null` per API | Aufruf | ⚠ speichert die Zeichenkette `'null'`; heilt der Rücktausch |
| C16 | **Kaputtes JSON** per API | `POST /api/settings` mit `{"a":` | ⚠ V15 — 500 mit Parser-Meldung an den Aufrufer. Gegenprobe: leerer Body → 200 `success:true`, obwohl nichts geschah |
| C17 | Speichern ohne Cloud-Verbindung | Region verbiegen | ✔ Speichern geht, Abgleich meldet Fehler |

*C11 und C12 sind nach Block G verschoben — sie löschen Daten.*

### D — Messstellen

Jede hier angelegte Teststelle wird **unmittelbar nach ihrem Testfall wieder gelöscht** — nicht erst am Ende. Grund: Eine Messstelle mit gesetzter `device_uuid` ohne eigene Messwerte lässt `windowStart` auf `dayAgo` zurückfallen (`scheduler.js:164-172`); jeder Zyklus zieht dann ~1.200 statt ~12 Datensätze aus der Cloud, alle 15 Minuten.

| # | Testfall | Weg | Erwartung |
|---|---|---|---|
| D1 | **Teststelle `pruef-01` anlegen** | Hinzufügen, ID `pruef-01`, Name „Prüfstelle", **Geräte-UUID von UWL** | ✔ erscheint in der Liste; sammelt Messwerte, damit D11 etwas zu prüfen hat |
| D2 | ID mit Umlauten tippen | „Büro-Süd" | ⚠ V18 — wird still zu „bro-sd" |
| D3 | Name nur aus Leerzeichen | `"   "` | ⚠ besteht die Sperre |
| D4 | Sehr langer Name | 5.000 Zeichen | ? **Durchgefallen** bei Absturz oder zerschossenem Layout; Abschneiden ist zulässig |
| D5 | HTML im Namen | `<b>fett</b>` | ✔ React maskiert |
| D6 | Zwei Stellen, dasselbe Gerät | zweite mit gleicher UUID | ⚠ erlaubt, nur Logwarnung. **Sofort wieder löschen:** die Dublette gewinnt in `deviceToStation` und fängt alle neuen Messwerte der echten Station ab — deren Kacheln in Block E zeigen sonst eine einfrierende Kurve |
| D7 | Geräte-UUID von Hand | Freitextfeld | ⚠ Auswahlfeld zeigt danach nichts. **Sofort wieder löschen** |
| D8 | Bearbeiten erhält die Historie | Name ändern, Zahl vorher/nachher | ✔ bleibt gleich |
| D9 | Doppelklick auf Speichern | zweimal schnell | ⚠ V17 |

*D10–D14 (Löschen mit Kaskade) sind nach Block G verschoben.*

### E — Dashboard und Kacheln

**Vorher:** `localStorage` sichern (Abschnitt 1).

| # | Testfall | Weg | Erwartung |
|---|---|---|---|
| E1 | Erste Kachel anlegen | Assistent | ✔ erscheint im Raster |
| E2 | Alle fünf Kacheltypen | je eine | ✔ alle zeichnen Daten |
| E3 | Mehr Messwerte als erlaubt | über das Limit klicken | ⚠ still ignoriert |
| E4 | Titel leer lassen | ohne Eingabe | ✔ Vorschlagstitel |
| E5 | Sehr langer Titel | 500 Zeichen | ? **Durchgefallen**, wenn die Kachel andere überlappt oder das Raster bricht |
| E6 | Esc im Assistenten | nach Schritt 3 | ⚠ V23 |
| E7 | Kachel verschieben | ziehen | ✔ rastet ein, andere weichen nach unten |
| E8 | Größe ändern | Ecke ziehen | ✔ Mindestgröße greift |
| E9 | Raster füllen | viele Kacheln | ⚠ ab einem Punkt landet eine bei (0,0) und überlappt |
| E10 | Kachel entfernen | X-Icon | ⚠ V23 — sofort |
| E11 | Layout zurücksetzen | „Zurücksetzen" | ✔ Rückfrage, dann Standard |
| E12 | Layout sperren | „Layout sperren" | ✔ Ziehen/Entfernen gesperrt |
| E13 | **Anderer Browser** | zweiten Browser öffnen | ⚠ V12 — leeres Dashboard |
| E14 | Browserspeicher leeren | `localStorage` löschen | ⚠ Layout weg, keine Vorwarnung |
| E15 | Speicher voll | künstlich füllen | ✔ Fehlerbanner |
| E16 | Schmales Fenster | 375 px | ⚠ V20 |
| E17 | Tablet-Bedienung | Touch, ziehen | ⚠ V19 |
| E18 | Meldungs-Übersicht | Pillen im Kopf | ✔ Panel nach Messstelle gruppiert |
| E19 | Historie nachladen | „weitere Einträge…" | ✔ blättert |
| E20 | Tastaturbedienung | nur Tab und Enter | ⚠ V13 |

### F — Logging und Fehlersichtbarkeit

| # | Testfall | Weg | Erwartung |
|---|---|---|---|
| F1 | Normalbetrieb | Ausgabe über einen Zyklus | ✔ Start, Zyklus, Zusammenfassung |
| F2 | **Zeitstempel** | dieselbe Ausgabe | ⚠ V6 — keine |
| F3 | Falscher Schlüssel | C3 auslösen | ✔ Meldung je Schritt, ohne Stack |
| F4 | Wiederkehrender Fehler | mehrere Zyklen | ⚠ Scheduler-Fehler nicht gedrosselt |
| F5 | HTTP-Fehler wiederholt | 15× derselbe Aufruf | ✔ gedrosselt, Zählzeilen bei 10/100 |
| F6 | Update-Prüfung mit totem Pfad | C14 auslösen | ⚠ V7 — kein Eintrag |
| F7 | Sicherungsfehler im Log | **A10** auslösen (nicht A4 — dessen 400er-Zweig protokolliert nichts) | ✔ Fehlerzeile vorhanden |
| F8 | Portkonflikt | zweite Instanz auf 3000 | ✔ klare Zeile + Ende ≠ 0 |
| F9 | Fehler ohne Terminal erkennbar? | nur Dashboard | ⚠ nur letzter Fehler, keine Historie |
| F10 | Logdatei wächst unbegrenzt | Windows-Ablauf | ⚠ Rotation nur beim Dienststart |

### G — Abschluss (unumkehrbare Fälle zuerst, dann Rückweg)

**Vorbedingung für G0a/G0b:** `ls backups/ | wc -l` muss 19 ergeben. Fehlt eine ZIP (z. B. die aus A8 nicht zurückgelegt), sinkt `computePruneFloor` und die Aufbewahrungs-Fälle löschen weniger — man schlösse dann fälschlich, V5 sei nicht reproduzierbar.

| # | Testfall | Weg | Erwartung |
|---|---|---|---|
| G0a | **Aufbewahrung auf 30 Tage** | Datenbank → „30 Tage", einen Zyklus abwarten | ⚠ V5 — löscht **71,6 %** (122.659 Messwerte, Schnitt am 18.08.). Der ungesicherte September bleibt unberührt |
| G0b | **Aufbewahrung = 1 per API** | Aufruf | ⚠ V5 — löscht **99,3 %**. Die ~26.400 September-Werte sind **unwiederbringlich**, sie stehen in keinem ZIP |
| G0c | **Sicherung aus + kleine Aufbewahrung** | Schalter aus, dann G0b | ⚠ V24 — Prune-Sperre vollständig aus |
| G0d | **Messstelle löschen, mit Rückfrage** | `pruef-01` aus D1 löschen | ✔ Rückfrage nennt die Folge |
| G0e | **Kaskade prüfen** | Messwert-/Ereigniszahl von `pruef-01` vorher/nachher | ✔ beide mit gelöscht (deshalb bekam `pruef-01` in D1 eine echte Geräte-UUID — ohne Historie verglichen man 0 gegen 0) |
| G0f | Kachel einer gelöschten Stelle | Dashboard ansehen | ✔ „Messstelle gelöscht." statt Absturz |
| G0g | Gelöschte Stelle im Export | Auswahl prüfen | ✔ nicht mehr wählbar |
| G0h | ZIPs einer gelöschten Stelle | `backups/` ansehen | ? bleiben liegen. **Durchgefallen**, wenn sie verschwinden — das wäre Datenverlust |
| G1 | Backend stoppen, Dashboard offen | – | ✔ Offline-Banner |
| G2 | Backend wieder starten | – | ✔ Banner weg, Daten zurück |
| G3 | Neustart mit Testeinstellungen | – | ✔ Zustand überlebt |
| G4 | Aufräumen ausserhalb der Datenbank | `backups-test-neu`, `Sicherung Büro Ä`, Zahlenordner entfernen; `backups/` gegen das Inventar | ✔ `git status` wieder sauber |
| G5 | **Rücksicherung** (4 Schritte aus Abschnitt 1) | – | ✔ je Station und Monat **≥ Referenztabelle** (September darf gewachsen sein), 4 Messstellen, `integrity_check: ok` |
| G6 | Automatische Tests | `npm test` | ✔ **beide** Blöcke: 168 + 162, je `fail 0`. **Sagt nichts über die echten Daten** — die Tests laufen gegen `:memory:`. Zusätzlich `sqlite3 klima.db "PRAGMA integrity_check;"` |

*Gestrichen:* „Datenbank während des Betriebs ersetzen". Bereits gemessen: Die laufende Verbindung checkpointet ihr WAL über die eingespielte Datei zurück, der Tausch wird unsichtbar rückgängig gemacht — und hinterlässt genau den heissen WAL, an dem G5 scheitert. Kein Bediener tut das.

## 4. Nicht über die Oberfläche prüfbar

- C8–C10, C15, C16, G0b — die Oberfläche lässt diese Werte nicht zu, das Backend schon.
- V14 — die Oberfläche setzt `limit` nicht selbst und bekommt dadurch ohnehin den vollen Bestand.
- A8 — es gibt keinen Auslöser für die Sicherung in der Oberfläche.
- **Windows-spezifisch, hier nicht prüfbar** (Entwicklungsmaschine ist macOS): Dienststart als NetworkService, Logdatei-Rotation (F10), UNC-Pfad als Sicherungsziel, Excel-Doppelklick auf die CSV. Gehört in die §9-Abnahme auf der Zielmaschine.

## 5. Sicherheitsregeln und Entscheidungspunkt

- **Block G ist unumkehrbar.** Nichts daraus vorziehen. A13 und B9 brauchen den vollen Datenbestand.
- Teststellen aus Block D sofort nach ihrem Fall löschen, nicht sammeln.
- Findet sich ein Datenverlust, der nicht im Plan steht: anhalten, Zustand sichern, dann weiter.

> **Zur Entscheidung — C8 gegen den echten Schlüssel?**
> `testo-client.js:17` hält fest, dass HTTP-Fehler **nicht** wiederholt werden: ein 429 fliegt sofort durch, der Zyklus endet, der 1-ms-Timer feuert den nächsten. Kein Backoff, obwohl der eigene Doku-Stand ihn vorschreibt (`03-async-pattern.md:215-223`). Wie die testo-Cloud auf einen solchen Anfragensturm reagiert, ist nicht vorhersagbar und durch keine Rücksicherung heilbar. Drei Möglichkeiten: C8 mit einem *ungültigen* Schlüssel fahren (der Overflow ist auch an 401-Antworten messbar), C8 auf einer Zweitinstanz fahren, oder C8 streichen und V4 als Codebefund stehen lassen.

## 7. Ergebnisse Block A (durchgeführt 2026-09-17)

| # | Ergebnis | Beleg |
|---|---|---|
| A1 | ✔ | Status zeigt „Aktiv", Ordner, Scan-Datum, letzte Datei — deckt sich mit der Datenbank |
| A2 | ✔ | Schalter aus → `backup_enabled=0` in der DB, Statuskasten wechselt zu „ist ausgeschaltet"; überlebt Neuladen |
| A3 | ✔ | `backups-test-neu` angelegt, „Gespeichert ✓". **Nicht git-ignoriert** — Review-Befund bestätigt |
| A4 | ✔ | `EACCES: permission denied` als Klartext, alter Pfad bleibt (der Wert wird nie gespeichert) |
| A5 | ✔ | `EEXIST: file already exists, mkdir 'VERSION'`; `VERSION` unversehrt (`0.16.1`, git meldet keine Änderung) |
| A6 | ✔ | Ordner `Sicherung Büro Ä` korrekt angelegt, Umlaute intakt, NFC-normalisiert |
| A7 | ✔ | Feld leer → Rückfall auf `backups` |
| A8 | ✔ | Beiseitegelegte ZIP wurde **neu geschrieben** (`written: 1`), gleiche Zeilenzahl (2.988) |
| A9 | ⚠ | Keine September-ZIPs, 26.416 Messwerte ungesichert — **V3 bestätigt** |
| A10 | ✖ | **Durchgefallen**, siehe V26 |
| A13 | ✔ | Alle 12 ZIPs stimmen **exakt** mit der Datenbank überein (nach Vergleich mit lokalen Monatsgrenzen — ein UTC-Vergleich erzeugt Scheinabweichungen von 2–8 Zeilen) |
| A11/A12/A14 | — | Durch V11, V1 und V2 bereits belegt, kein eigener Klickweg nötig |

### Neue Befunde aus Block A

| # | Befund | Beleg |
|---|---|---|
| V25 | **Das Von-Datum im Export steht einen Tag zu früh.** Bei „Letzter Monat" rechnet die Logik korrekt 01.08. 00:00 lokal, das Feld zeigt aber **31.07.2026**. Betrifft alle vier Presets (last7, last30, thisMonth, lastMonth). Sobald der Bediener ein Feld anfasst, wird der angezeigte Wert übernommen und der Export beginnt 24 Stunden zu früh. Ursache: `new Date(r.fromTs).toISOString().slice(0,10)` — `toISOString` liefert UTC, die Logik rechnet lokal. | `export-panel.jsx:27-28`, in der laufenden App gemessen |
| V26 | **Eine fehlschlagende Datensicherung bleibt im geöffneten Panel unsichtbar.** Backend meldete `status: "error"` mit Klartext, die Oberfläche zeigte weiter „● Aktiv" **samt Erfolgsmeldung des vorherigen Laufs** („Zuletzt geschrieben … (1)"). Erst nach Neuladen erscheint „Fehler" mit dem Text. Ursache: `settings.jsx:217` rendert `<ExportPanel />` **ohne Props**; das Panel lädt den Status einmal beim Öffnen und pollt nie — anders als Kopfzeile (`header.jsx:36`) und Systemübersicht (`settings.jsx:129`), die beide alle 10 s aktualisieren. | in der laufenden App gemessen + Code |
| V27 | **Ein Sicherungsfehler bleibt bis zum Folgetag stehen.** `backup_health` wird erst vom nächsten Lauf überschrieben, und der ist auf einen Lauf je Kalendertag gedrosselt. Nach behobener Ursache zeigt das Dashboard weiter „Fehler", bis am nächsten Tag ein Lauf stattfindet — ohne Möglichkeit, ihn über die Oberfläche anzustoßen. | beobachtet; nur über direkten Eingriff in `last_backup_scan_date` aufzulösen |

## 8. Ergebnisse Block B (durchgeführt 2026-09-17)

| # | Ergebnis | Beleg |
|---|---|---|
| B1 | ✔ | 4 Messstellen → `messwert-export.zip`, 300 KB, vier CSV (eine je Stelle) |
| B2 | ✔ | Eine Stelle ohne Meldungen → einzelne `UWL_uwl_messwerte.csv`, kein ZIP |
| B3 | ✔ | Mit Meldungen → `UWL_uwl_export.zip`, ZIP erzwungen |
| B4 | ✔ | Ohne Messstelle: „Bitte mindestens eine Messstelle wählen", kein Request |
| B5 | ✔ | Bis vor Von: „Zeitraum ungültig (von > bis)" |
| B6 | ⚠ | Leeres Von-Feld erzeugt **dieselbe** Meldung „von > bis" — **V16 bestätigt**, irreführend |
| B7 | ✔ | Zeitraum 2030: HTTP 200, CSV mit Kopf + „# Keine Daten im gewählten Zeitraum" |
| B8 | ✔ | Januar 2020: identisch sauber |
| B9 | ✔ | 2000–2030, alle vier Stellen, mit Meldungen: **1,0 MB in 0,2 s**, Server unbeeinträchtigt. Der bekannte Speicheraufbau ist bei dieser Datenmenge unkritisch |
| B10 | ✔ | Deutsch: BOM, CRLF, `;`, Dezimalkomma (`26,28997`) — Excel-tauglich |
| B11 | ✔ | International: BOM, CRLF, `,`, Dezimalpunkt (`26.28997`) |
| B12 | ✔ | Bereits in A6/A8 belegt: Umlaute in Datei- und ZIP-Einträgen korrekt (UTF-8-Flag gesetzt) |
| B14 | ✔ | Eine Messgröße → genau diese Spalte |
| B15 | ✔ | Luftdruck bei einer Station ohne Drucksensor: HTTP 200, Spalte `Luftdruck []`, „Keine Daten". Kein Fehler, keine falsch zugeordneten Werte. Schönheitsfehler: leere Einheit `[]` |
| B16 | ✔ | Export während laufendem Abgleich: 8.642 intakte Zeilen, Scheduler danach `success` |
| B17 | ✔ | Während des Laufs „Export läuft…" und `disabled` — Doppelklick wirkungslos |
| B13 | — | Nach Block G verschoben (erfordert Umbenennen einer Messstelle); CSV-Injection ist durch `csv-export.test.js` abgedeckt |

### V25 ist schwerwiegender als in Block A angenommen

Nicht nur die Anzeige ist falsch — **der Export selbst nimmt einen Tag zu viel.** `export-panel.jsx:55` rechnet aus dem *Feldwert*, nicht aus dem korrekten Zeitstempel:

```js
const fromTs = new Date(fromStr + 'T00:00:00').getTime();   // fromStr = "2026-07-31"
```

Gemessen am echten Export mit Preset „Letzter Monat": Der Kopfblock schreibt `Zeitraum von;2026-07-31T00:00:00+02:00`, und die Datei enthält **96 Messwerte vom 31. Juli**. Analog beginnt „Letzte 7 Tage" acht Tage zurück und „Aktueller Monat" am letzten Tag des Vormonats. Für Monatsberichte einer Klimaüberwachung ist das relevant.

**Eingrenzung:** Das automatische Monats-Backup ist **nicht** betroffen — `backup-runner.js` rechnet direkt mit `monthStartMs()` statt über die Datumsfelder. A13 bestätigt das: alle 12 ZIPs stimmen exakt.

**V11 ist damit praktisch bewiesen**, nicht mehr nur aus dem Code abgeleitet: Dieselbe Station, derselbe Monat, dieselben 2.988 Zeilen — die alte ZIP im RFC-Format (`26.28997`, Komma-Trenner), die neu geschriebene im deutschen (`26,28997`, Semikolon). Wer das Format umstellt, hat dauerhaft einen gemischten Sicherungsbestand; Excel öffnet die eine Hälfte korrekt, die andere als eine einzige Spalte.

## 9. Ergebnisse Block C (durchgeführt 2026-09-17)

| # | Ergebnis | Beleg |
|---|---|---|
| C1 | ✔ | Das Schlüsselfeld ist beim Öffnen **immer** leer, Platzhalter `•••••••••• (gespeichert)`, Hilfetext: „Leer lassen, um den gespeicherten Schlüssel beizubehalten." **V9 damit widerlegt** — das Verhalten ist direkt am Feld erklärt, keine Täuschung. Was fehlt, ist ein Weg, den Schlüssel bewusst zu *entfernen* |
| C2 | ✖ | **Drei Leerzeichen werden als Schlüssel gespeichert** (hex `202020`), die Oberfläche quittiert mit „Gespeichert". Kein Trim, keine Warnung. Ein misslungenes Einfügen zerstört die Anbindung |
| C3 | ✔ | „Verbindung testen" meldet `401 UNAUTHORIZED` mit Klartext. Anmerkung: Die rohe API-Antwort inkl. interner `instance`-ID geht 1:1 an den Bediener |
| C4 | ⚠ | `lastSyncError` zeigt nur `/v3/alarms` — den letzten von sechs scheiternden Schritten. **V8 bestätigt.** `api.status: err` ist immerhin sichtbar |
| C5 | ✔ | Schlüssel zurück → `api.status: ok`, Sync `success`, keine Fehler |
| C6 | ✔ | Region auf Asien-Pazifik → 401. **Nebenbefund:** identische Meldung wie bei falschem Schlüssel — die beiden Ursachen sind für den Bediener nicht unterscheidbar |
| C7 | ✔ | Regler klemmt auf 60–3600 (Schritt 60). Ein Versuch mit 99999 wird auf 3600 begrenzt — **über die Oberfläche ist V4 nicht erreichbar** |
| C8 | ✖ | **V4 bestätigt:** `999999999` → HTTP 200. Statt einem Lauf in 31 Jahren: **29 verschiedene Sync-Zeitpunkte in 12 Sekunden** (~2,4 Zyklen/s). Mit gültigem Schlüssel wäre das ein Dauerbeschuss der testo-Cloud. Nach Rückstellung sofort wieder ruhig |
| C9 | ✔ | `0`, `-5`, `"abc"` → je 400 `poll_interval_sec must be a positive integer` |
| C10 | ⚠ | `"900abc"` → 200, gespeichert als 900 (Teilparse, keine Warnung) |
| C13 | ⚠ | Bestätigungstext lautet nur „Einstellungen auf Werkseinstellungen zurücksetzen?" — nennt den Umfang nicht. `update_dir` wird **nicht** zurückgesetzt, der Schlüssel überlebt. **V10 bestätigt** |
| C14 | ✖ | **V7 praktisch belegt:** `Z:\gibtsnicht\nirgendwo` → 200, Status meldet `enabled: true, updateAvailable: false` — **exakt wie bei funktionierender Prüfung ohne neues Update**. Der Bediener kann nicht erkennen, dass die Update-Prüfung ins Leere läuft |
| C15 | ✖ | `api_key: null` → 200, gespeichert wird die Zeichenkette `"null"` (4 Zeichen) |
| C16 | ✖ | Kaputtes JSON → **500** mit interner Parser-Meldung (`Unexpected end of JSON input`), auch bei `/api/export`. Body ganz weglassen → **200 `success:true`**, obwohl nichts geschieht. **Review-Korrektur von V15 bestätigt** |
| C17 | — | Durch C6 mit abgedeckt |

### Vorfall während Block C: 25.308 Messwerte gelöscht

Beim Vorbereiten von C13 habe ich `retention_days: 90` gesetzt, um den Werkseinstellungs-Reset gegen einen Nicht-Default-Wert zu prüfen. Ein Sync-Zyklus lief sofort an und hat geprunt, bevor der Wert zurückgestellt war. Verlust: **25.308 Messwerte und 309 Ereignisse** (alles vor dem 19.06. 13:30). Messstellen und Grenzwerte blieben unversehrt.

Das war ein Fehler in der Testdurchführung, nicht in der Anwendung — der Plan hatte die Aufbewahrungs-Fälle bewusst nach Block G gelegt. Zwei Erkenntnisse daraus:

1. **V5 ist unter echten Bedingungen belegt.** Eine Aufbewahrungsänderung wirkt beim *nächsten Zyklus*, ohne Rückfrage und ohne Vorwarnung. Zwischen Klick und Datenverlust liegen im ungünstigen Fall Sekunden.
2. **V1 wurde praktisch relevant.** Die gelöschten Juni-Daten liegen in sieben Backup-ZIPs — zurückspielen lassen sie sich daraus nicht. Der einzige Weg zurück war die DB-Sicherung.

### G5 vorgezogen und bestanden

Der in der Review korrigierte Rückweg wurde unter echten Bedingungen gefahren:

1. `SIGTERM` an den Serverprozess → nach 0,5 s beendet
2. `klima.db-wal` und `klima.db-shm` **beide verschwunden** — der saubere Shutdown (`server.js:588-599`) arbeitet wie dokumentiert
3. Sicherung eingespielt → `integrity_check: ok`
4. Server gestartet

Ergebnis: **alle 12 Station/Monat-Kombinationen exakt auf Referenzstand**, alle Einstellungen zurück auf die Ausgangswerte (auch `update_dir` leer), API und Backup wieder aktiv. Der Scheduler holte die Lücke selbsttätig nach (171.246 Messwerte). Hätte Schritt 2 gefehlt, wäre die Datenbank laut Vorab-Messung bei 48.563 Messwerten und `malformed` gelandet.

## 10. Ergebnisse Blöcke D, E, F (durchgeführt 2026-09-17, seriell durch Subagenten)

### Block D — Messstellen

| # | Ergebnis | Beleg |
|---|---|---|
| D1 | ✔ | `pruef-01` angelegt, erscheint in der Liste |
| D2 | ⚠ | „Büro-Süd" getippt → Feldinhalt `bro-sd`, kein Hinweis. **V18 bestätigt** |
| D3 | ✔ | Speichern-Knopf ist bei `"   "` nicht gesperrt, aber das Backend lehnt ab: „name must be a non-empty string". Nichts gespeichert |
| D4 | ⚠ | 5.000 Zeichen werden ungekürzt gespeichert. Kein Absturz — aber die Tabelle wächst auf **36.982 px** in einem 826-px-Container; die Knöpfe „Bearbeiten"/„Löschen" **aller** Zeilen liegen damit außerhalb des Sichtbereichs und sind praktisch unerreichbar |
| D5 | ✔ | `<b>fett</b>` wird literal angezeigt, React maskiert korrekt |
| D6 | ⚠ | Doppelte Geräte-UUID wird ohne Oberflächenmeldung gespeichert. Logwarnung: „station 'pruef-06' overrides 'essbro'" |
| D7 | ✖ | Anders als erwartet: Das Auswahlfeld zeigt nicht „keine Auswahl", sondern fällt auf die **erste Option** zurück („-- Kein Gerät zugewiesen --"), während die getippte UUID gespeichert wird. Die Oberfläche behauptet aktiv etwas Falsches |
| D8 | ✔ | Umbenennen erhält die Historie: 50.170 Messwerte vorher wie nachher (Upsert, kein Delete+Insert) |
| D9 | ⚠ | Zwei Klicks 7 ms auseinander → **zwei** `POST /api/stations`. **V17 bestätigt** |

**V28 (neu, schwer): Doppelte Geräte-UUID führt zu echtem Datenverlust.** Solange die Teststelle dieselbe UUID wie UWL trug, schrieb der Abgleich die UWL-Alarme auf sie („overrides 'uwl'"). Beim Löschen nahm die Kaskade **zwei echte UWL-Ereignisse** mit. Sie kamen nur zurück, weil der Alarm-Abruf 26 h zurückgreift und `ON CONFLICT(uuid)` sie wieder einsetzte — nach Ablauf dieses Fensters wären sie endgültig weg. Dazu im Log: `Error syncing alarms: FOREIGN KEY constraint failed` — ein Zyklus, der mit einer Doppel-Station startet und nach deren Löschung schreibt, bricht den kompletten Alarmschritt ab.

### Block E — Dashboard und Kacheln

| # | Ergebnis | Beleg |
|---|---|---|
| E1/E2 | ✔ | Alle fünf Kacheltypen zeichnen echte Daten, keine Fehlergrenze schlägt zu |
| E3 | ⚠ | Über dem Limit wird still ignoriert. **Nuance:** Bei Limit 1 (Kennzahl/Tachometer) wird nicht ignoriert, sondern **ersetzt** |
| E4/E5 | ✔ | Leerer Titel → Vorschlagstitel; 500-Zeichen-Titel bricht nichts (`text-overflow: ellipsis`) |
| E6 | ✔ | Esc verwirft ohne Rückfrage |
| E7 | ✔ | Ziehen rastet ein. **Nebenbefund:** `compactLayout` schiebt nur nach unten, füllt nie auf — es bleiben Löcher |
| E8 | ✔ | Mindestgröße greift exakt; Höhe ohne Obergrenze, aber ohne Schaden |
| E9 | ⚠ | Bei vollem Raster landet die neue Kachel auf `(0,0)` und überlappt **ohne jeden Hinweis**. Die verdeckte Kachel verliert ihre Titelzeile samt Bedienknöpfen |
| E10 | ⚠ | Entfernen sofort, ohne Rückfrage. **V23 bestätigt** |
| E11 | ✔ | Rückfrage „Layout auf Standard zurücksetzen?". **Befund:** „Standard" ist ein **leeres** Dashboard (`DEFAULT_LAYOUT = []`), kein Standard-Kachelsatz — der Knopftext legt anderes nahe |
| E12 | ✔ | Sperre wirkt. **Befund:** „Zurücksetzen" bleibt trotzdem aktiv — die Sperre schützt nicht vor dem Löschen des ganzen Layouts |
| E13 | ⚠ | **Neu: Zwei Tabs überschreiben sich gegenseitig.** Kein `storage`-Abgleich: Tab 1 entfernt eine Kachel, Tab 2 schreibt beim nächsten Eingriff seinen veralteten Stand zurück — die Löschung ist weg. Letzter Schreiber gewinnt, ohne Hinweis |
| E14 | ⚠ | `localStorage` geleert → leeres Dashboard, keine Vorwarnung. **V12 bestätigt** |
| E15 | ✔ | Bei vollem Speicher erscheint ein klares Banner: „Kachel-Anordnung konnte nicht gespeichert werden…" |
| E16 | ⚠ | Bei 375 px bleiben 12 Spalten → **16 px Spaltenbreite**, Inhalte abgeschnitten. **V20 bestätigt** |
| E17 | ⚠ | Vollständige Touch-Folge bewegt nichts; `onTouch*`/`onPointer*` kommen im Code nicht vor. **V19 bestätigt** |
| E18/E19 | ✔ | Meldungs-Panel gruppiert korrekt, Historie blättert (62 → 82 → 102), alle Anfragen 200 |
| E20 | ✖ | **V13 widerlegt** — siehe unten |

**Weiterer Befund:** `dashboard.css:1347` blendet ab ≤1280 px „Zurücksetzen" und die Kachelzahl per `display: none` aus. Bei der Standardbreite von 1024 px sind beide **gar nicht erreichbar**, auch nicht per Tastatur.

### Block F — Logging und Fehlersichtbarkeit

| # | Ergebnis | Beleg |
|---|---|---|
| F1 | ⚠ | **Das Log ist im Normalbetrieb praktisch leer.** Sechs Zyklen, davon drei erfolgreich mit je ~1.100 Messwerten — das Log blieb **byte-identisch**. Die einzigen Betriebszeilen stammen vom Start. Wer `app.log` beim Kunden öffnet, kann nicht unterscheiden, ob die Anwendung seit Wochen sammelt oder seit Wochen nichts tut |
| F2 | ⚠ | Kein einziger Zeitstempel in 20 Aufrufstellen. **V6 bestätigt** |
| F3 | ✔ | Fünf Zeilen je Zyklus, je gescheitertem Schritt eine, ohne Stacktrace. Endpunkt und Status genannt — diagnostisch brauchbar |
| F4 | ⚠ | Vier Zyklen → **4× jede Zeile**, keine Drosselung. Hochgerechnet: ein abgelaufener Schlüssel erzeugt **480 Zeilen pro Tag**, ~14.000 im Monat. Die wechselnde `instance`-ID der Cloud verhindert dabei sogar ein nachträgliches `sort -u` |
| F5 | ✔ | 16 kaputte Requests → eine volle Ausgabe mit Stacktrace, dann genau eine Zählzeile `(10x)`. Die Drosselung arbeitet wie dokumentiert |
| F6 | ⚠ | Toter Update-Pfad: **kein einziger Logeintrag**. **V7 bestätigt** |
| F7 | ✖ | **Der Sicherungsfehler erscheint NICHT im Log.** `runBackupScan` fängt ihn selbst ab und schreibt ihn nur nach `backup_health`; der `console.error`-Zweig in `scheduler.js:415` wird nie erreicht |
| F8 | ✔ | Portkonflikt: klare deutsche Zeile + Exit 1, für den Windows-Task auswertbar. Zwei Einschränkungen unten |
| F9 | ⚠ | Dashboard deutet gut („Zugangsschlüssel wurde abgelehnt") und bietet eine Handlungsschaltfläche — zeigt aber nur den **zuletzt** gescheiterten Schritt, ohne Historie. **V8 bestätigt** |
| F10 | ⚠ | Rotation nur beim Dienststart. Harmlos bei fehlerfreiem Betrieb (siehe F1), kritisch im Dauerfehler (siehe F4) |

**V29 (neu, schwer — betrifft den Windows-Betrieb): `startScheduler()` läuft vor `app.listen()`.** `server.js:43` startet den Scheduler, `server.js:576` bindet erst danach den Port. Eine Instanz, die am Portkonflikt scheitert, hat also bereits einen vollständigen Sync-Zyklus gegen die echte testo-Cloud angestoßen und auf dieselbe SQLite-Datei gezielt, bevor sie stirbt. Der Windows-Task ist mit `RestartCount 3` konfiguriert — das wiederholt sich dort bis zu viermal hintereinander.

**V30 (neu): Ein Sicherungsfehler ist an keiner Stelle sichtbar, die ein Bediener routinemäßig ansieht.** Er steht nicht im Log (F7), nicht in der Systemübersicht — nur im Export-Dialog, den man gezielt öffnen muss, und dort aktualisiert er sich nicht ohne Neuladen (V26). Drei Schichten, die alle wegsehen.

**Nebenbefund F8:** Jeder Bindefehler außer `EADDRINUSE` (blockierter Port durch Richtlinie o. ä.) fällt in den `else`-Zweig von `listen-error.js` und liefert die unklare Variante mit rohem Error-Objekt und Stacktrace.

### Korrekturen an eigenen Befunden

- **V13 widerlegt.** Die sechs Navigationsknöpfe der Einstellungen **haben** zugängliche Namen: `<button class="settings-nav-item"><NavIcon/><span>Übersicht</span></button>`, kein `aria-hidden`, Text sichtbar. Ein Screenreader liest „Übersicht, Schaltfläche". Mein ursprünglicher Befund war ein Artefakt des Accessibility-Auslesers, der die Namen nicht auflöste. Selbst per DOM gegengeprüft.
- **V9 widerlegt** (bereits in Block C): Der Hilfetext am Schlüsselfeld erklärt das Verhalten direkt — „Leer lassen, um den gespeicherten Schlüssel beizubehalten."
- **Kein Befund:** Dass ein gescheiterter Alarmschritt später `success` zeigt, ist kein Verschlucken — `scheduler.js:437` setzt bei jedem gefangenen Fehler `'error'`; ein nachfolgender sauberer Zyklus überschreibt ihn. Das ist die bereits bekannte fehlende Fehlerhistorie (V8/F9).

### Offen geblieben

- **Tachometer-Skala:** Eine Kachel zeigte `22,9 °C` bei Skalenenden `1,46` / `22,12` — Wert außerhalb der eigenen Skala, Zeiger am Anschlag. Vom E-Agenten beiläufig beobachtet, nicht systematisch geprüft. Verdient eine eigene Untersuchung.
- **D10–D14** (Löschen einer echten Messstelle mit Kaskade) und **B13** (Formelzeichen im Stationsnamen) wurden bewusst nicht ausgeführt.

## 6. Was die Review geändert hat

Drei Reviewer, Lenses: Tragfähigkeit des Rückwegs · Faktenbasis der Vorab-Befunde · Falsifiziert die Schlussprüfung?

**Eingearbeitet:**

- Der Rückweg zerstörte die Datenbank. Ohne Löschen von `-wal`/`-shm` ergab er 48.563 statt 171.198 Messwerte und eine korrupte Datei. Vier nummerierte Schritte plus Stopp-Verfahren ersetzen den Einzeiler.
- `npm test` ist blind gegenüber Schaden an den echten Daten (belegt: kaputte Datei unter `DB_PATH`, Tests trotzdem grün). G6 sagt das jetzt und bekommt einen `integrity_check` daneben.
- „Zahlen stimmen" war zirkulär — nach einem Dateitausch ist jede Zahl eine Eigenschaft der Sicherung. Referenztabelle je Station und Monat in Abschnitt 1, G5 prüft „≥".
- A8 konnte nicht durchfallen: alle 12 ZIPs existieren, der Lauf schrieb nichts. Jetzt wird eine ZIP beiseitegelegt.
- A10 war nicht ausführbar — ein unbeschreibbarer Pfad wird gar nicht gespeichert. Umgestellt, F7 daran gehängt.
- D10 benannte die Messstelle nicht, und D12–D14 hingen hinter einem verschobenen Testfall. Alles in Block G zusammengezogen, `pruef-01` mit echter Geräte-UUID.
- Teststellen aus D1/D6/D7 hätten die Cloud-Abfrage bis zum Testende verhundertfacht und die Kacheln der echten Station leerlaufen lassen. Sofortiges Löschen ergänzt.
- Testzahl korrigiert: 330 statt 168 — der Frontend-Block war nie gelaufen.
- V2, V14, V15 waren falsch, V8 unvollständig belegt, die „fünf Leichen" waren Testartefakte. Alle korrigiert. Neuer Befund V24.
- Sieben Testfälle hatten Erwartungen, die nicht durchfallen konnten. Kriterien ergänzt.

**Gestrichen statt repariert:** „Datenbank im Betrieb ersetzen" (G4 alt) — erzeugte genau den Zustand, in dem die Rücksicherung scheitert, ohne eigenen Erkenntniswert.

**Gehalten:** V4 und V5, die beiden schwersten Befunde, wurden durch Ausführung bestätigt — V5 sogar schärfer als geschrieben (99,3 % statt „fast alles"). Der Server bleibt auch im Overflow-Zustand bedienbar, das Zurückstellen greift.
