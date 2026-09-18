# Offene Aufgaben aus dem Funktionstest v0.16.1

Abgeleitet aus [funktionstest-2026-09-17.md](funktionstest-2026-09-17.md). **Stand 2026-09-18: alle acht Aufgaben umgesetzt (v0.17.0)** — Ergebnis, Abweichungen und Offenes je Aufgabe im Abschnitt „Umsetzungsstand“ am Ende.

Jede Aufgabe ist eigenständig formuliert und lässt sich ohne den Testlauf bearbeiten. Alle Zahlen stammen aus Messungen an der laufenden Anwendung, nicht aus Code-Lektüre.

Empfohlene Reihenfolge, falls nicht alles angegangen wird: **4** zuerst (kleinster Diff, größtes Produktionsrisiko), dann **1 + 2** zusammen, dann **3**.

---

## 1. Datensicherung wiederherstellbar machen

**Befunde V1, V2, V3 — schwer.** Die Monats-ZIPs sind ein Export-Archiv, kein Backup.

- **Kein Wiederherstellungsweg.** Kein Code liest ein ZIP zurück in die Datenbank, keine Dokumentation beschreibt einen Weg. Die ZIPs enthalten die `uuid` der Messwerte nicht — ein Rückspielen erzeugte Duplikate beim nächsten Abgleich.
- **Zwei von fünf Tabellen gesichert.** Es fehlen `settings` komplett, die `limits`-Tabelle und aus `stations` die Felder `device_uuid`/`mo_uuid` — ohne sie synchronisiert eine wiederhergestellte Messstelle nicht mehr. Name, Standort, Seriennummer und Modell stehen im ZIP-Kopfblock, die ID im Dateinamen; die sind rekonstruierbar.
- **Der laufende Monat ist nie gesichert.** `backend/backup-runner.js` sichert nur abgeschlossene Monate. Zum Testzeitpunkt: 26.416 ungesicherte Messwerte, am Monatsende bis zu 31 Tage.

Praktisch wurde das im Test relevant: Ein versehentliches `retention_days=90` löschte 25.308 Messwerte. Die Juni-Daten lagen in sieben ZIPs — zurückholen ließen sie sich daraus nicht.

**Richtung:** `VACUUM INTO` neben die ZIPs — eine Zeile, konsistent auch bei aktiver WAL, löst alle drei Punkte. Offen: Aufbewahrung (die ZIPs werden bewusst nie gelöscht; für 44-MB-Kopien gilt das kaum), Platzbedarf, eigener Ordner oder derselbe.

**Randbedingungen:** Windows-Dienst unter `NT AUTHORITY\NetworkService`, Pfade über `path.join(__dirname, …)`, `DB_PATH` aus der Umgebung. Der Sicherungsordner darf auf einem Netzlaufwerk liegen, die Datenbank nicht (WAL bricht auf UNC). Wiederherstellungsweg in `deploy/windows/README.md` dokumentieren — **einschließlich des Entfernens von `klima.db-wal`/`-shm` vor dem Einspielen** (siehe Aufgabe 2 unten und den gemessenen Schaden im Protokoll).

## 2. Fehlgeschlagene Sicherung sichtbar machen

**Befunde V26, V27, V30 — schwer.** Drei Schichten sehen unabhängig voneinander weg.

1. **Das Log schweigt.** `backend/backup-runner.js:69` fängt den Fehler selbst ab und schreibt ihn nach `backup_health`, statt zu werfen — der `console.error`-Zweig in `backend/scheduler.js:415` wird nie erreicht.
2. **Die Systemübersicht kennt ihn nicht.** Der Zustand wird nur in `Smart Meter Dashboard/export-panel.jsx` gerendert, also im Export-Dialog, den man gezielt öffnen muss.
3. **Der Dialog aktualisiert sich nicht.** `Smart Meter Dashboard/settings.jsx:217` rendert `<ExportPanel />` **ohne Props**; das Panel lädt den Status einmal beim Öffnen und pollt nie. Kopfzeile (`header.jsx:36`) und Systemübersicht (`settings.jsx:129`) aktualisieren alle 10 s.

Gemessen: Backend meldete `status: "error"` mit `lastError: "backup_dir nicht beschreibbar: EACCES…"`, die Oberfläche zeigte weiter **„● Aktiv"** samt Erfolgsmeldung des Vorlaufs. Erst nach Neuladen erschien „Fehler".

**Dazu V27:** `backup_health` wird erst vom nächsten Lauf überschrieben, und der ist auf einen je Kalendertag gedrosselt. Nach behobener Ursache zeigt das Dashboard weiter „Fehler" bis zum Folgetag. Prüfen, ob ein „Jetzt sichern"-Knopf die bessere Antwort ist — er löst das und erlaubt gezieltes Sichern vor einem Update.

**Randbedingungen:** Log wird nur beim Dienststart rotiert — neue Zeilen nicht ungedrosselt in einer Schleife. `backend/server.js:55` (`logThrottled`) zeigt das Muster. Zum Nachstellen: Zielordner über die Oberfläche setzen, **danach** `chmod 500` (ein bereits unbeschreibbarer Pfad wird beim Speichern abgelehnt, `server.js:133-143`), `last_backup_scan_date` löschen, Abgleich anstoßen.

## 3. Export-Zeitraum: ein Tag zu viel

**Befund V25 — Datenfehler.** `Smart Meter Dashboard/export-panel.jsx` (~Zeile 27):

```js
setFromStr(new Date(r.fromTs).toISOString().slice(0, 10));   // toISOString = UTC
```

`presetRange` rechnet korrekt lokal (01.08. 00:00 MESZ), als UTC formatiert wird daraus `2026-07-31`. Zeile ~55 rechnet aus genau diesem Feldwert den gesendeten Zeitstempel zurück — es ist also **kein reiner Anzeigefehler**.

Gemessen: Export „Letzter Monat" weist `Zeitraum von;2026-07-31T00:00:00+02:00` aus und enthält **96 Messwerte vom 31. Juli**.

| Preset | Logik rechnet | Feld zeigt |
|---|---|---|
| Letzte 7 Tage | 11.09. | 10.09. |
| Letzte 30 Tage | 19.08. | 18.08. |
| Aktueller Monat | 01.09. | 31.08. |
| Letzter Monat | 01.08. | 31.07. |

Das Bis-Feld ist unauffällig, weil 23:59:59 lokal am selben UTC-Tag liegt.

**Eingrenzung:** Das automatische Monats-Backup ist **nicht** betroffen (`backup-runner.js` rechnet direkt mit `monthStartMs()`); im Test bestätigt — alle 12 ZIPs stimmen exakt. Diesen Pfad nicht anfassen.

**Richtung:** Lokale Formatierung statt `toISOString()`. Prüfen, ob `Smart Meter Dashboard/export-logic.js` dieselbe Falle woanders hat. Regressionstest in `tests/export-logic.test.js` (DOM-frei, aus Node testbar). `?v=`-Cache-Buster in `Klima Dashboard.html` beachten.

## 4. Scheduler startet vor dem Port-Bind

**Befund V29 — schwer, Windows-Produktion.** `backend/server.js:43` ruft `startScheduler()`, `server.js:576` bindet erst danach den Port.

Eine zweite Instanz, die am Portkonflikt scheitert, hat den Scheduler längst gestartet und einen **vollständigen Sync-Zyklus gegen die echte testo-Cloud** angestoßen — auf dieselbe SQLite-Datei wie die laufende Instanz —, bevor `listen-error.js` sie beendet. Im Test direkt beobachtet: Die scheiternde Instanz gab vor ihrem Tod `Scheduler started. Syncing every 900 seconds.` aus.

`deploy/windows/install-task.ps1` konfiguriert `-RestartCount 3` — auf dem Zielrechner wiederholt sich das bis zu viermal hintereinander.

**Richtung:** `startScheduler()` und `startUpdateCheck()` in den Erfolgs-Callback von `app.listen()`. Der zweite Aufruf in `server.js:156` (nach `POST /api/settings`, um das Intervall zu übernehmen) ist legitim und bleibt. Regressionstest möglich nach dem Muster in `backend/tests/server.test.js:746ff` (Kindprozess mit eigenem `DB_PATH`).

**Nebenbefund:** Jeder Bindefehler außer `EADDRINUSE` fällt in den `else`-Zweig von `backend/listen-error.js` und gibt das rohe Error-Objekt samt Stacktrace aus. Lohnt sich mitzunehmen.

## 5. Eingabeprüfung der Einstellungs-API härten

**Befunde V4, V15, V21, V22, C2, C15 — alle durch Ausführung belegt.**

| Lücke | Messung |
|---|---|
| `poll_interval_sec` ohne Obergrenze | `999999999` → HTTP 200. Node kappt das Delay auf 1 ms → **29 Sync-Zeitpunkte in 12 s** (~2,4 Zyklen/s) gegen die echte Cloud. `backend/server.js:93-98` |
| Kein Trim beim Schlüssel | `"   "` (hex `202020`) wird gespeichert, Oberfläche meldet „Gespeichert", danach scheitert jeder Abgleich mit 401. `server.js:113-117` |
| `api_key: null` | Speichert die Zeichenkette `"null"` |
| Kaputtes JSON | **500** mit interner Parser-Meldung an den Aufrufer, bei *allen* POST-Endpunkten inkl. `/api/export`. Entsteht in `express.json()` (`server.js:47`), durchgereicht von `:563` |
| Leerer Body | `{"success":true}`, obwohl nichts gespeichert wurde — und startet über `server.js:156` den Scheduler neu |
| `"900abc"` | `parseInt`-Teilparse → klaglos als 900 übernommen |
| `backup_enabled` | Alles außer vier expliziten „Aus"-Werten gilt als „Ein", auch `null`, `123`, `"nein"` |
| `backup_dir: 12345` | Legt tatsächlich ein Verzeichnis `./12345` an, bevor eine Typprüfung greift |

Verschärfend zur ersten Zeile: `backend/testo-client.js:17` wiederholt HTTP-Fehler bewusst nicht — ein 429 fliegt sofort durch, der nächste Zyklus startet umgehend. Kein Backoff, obwohl der eigene Dokumentationsstand einen vorschreibt (`testo-smart-connect-api/03-async-pattern.md:215-223`).

**Vorbild:** `api_region` und `csv_format` sind sauber gelöst (Whitelist, Cast vor dem Vergleich). Die Obergrenze für `poll_interval_sec` gehört zusätzlich in `backend/scheduler.js:452-462`, damit ein direkt in die Datenbank geschriebener Wert ebenfalls gefangen wird.

**Nicht ändern:** Dass ein leeres Schlüsselfeld den gespeicherten Schlüssel behält, ist beabsichtigt und am Feld erklärt („Leer lassen, um den gespeicherten Schlüssel beizubehalten"). War zunächst als Fehler notiert und wurde widerlegt.

## 6. Logging für den Feldeinsatz brauchbar machen

**Befunde V6, V7, F1, F4, F10.**

- **Der Normalbetrieb hinterlässt keine Spur.** Sechs Zyklen, drei davon erfolgreich mit je ~1.100 Messwerten — das Log blieb **byte-identisch**. Die einzigen Betriebszeilen stammen vom Start. Wer beim Kunden `app.log` öffnet, kann nicht unterscheiden, ob die Anwendung seit Wochen sammelt oder seit Wochen nichts tut.
- **Keine Zeitstempel** in rund 20 `console.*`-Aufrufstellen. Zusammen mit dem vorigen Punkt gibt es nicht einmal eine Zyklusmarke zum Mitzählen.
- **Scheduler-Fehler nicht gedrosselt.** Vier Zyklen → 4× dieselben fünf Zeilen. Hochgerechnet: ein abgelaufener Schlüssel schreibt ~**480 Zeilen/Tag**, ~14.000 im Monat. Die wechselnde `instance`-ID der Cloud (roh mitgeloggt, ~200 Zeichen/Zeile) verhindert sogar ein nachträgliches `sort -u`.
- **Rotation nur beim Dienststart** (`deploy/windows/start.cmd`), der Dienst läuft monatelang durch.
- **Die Update-Prüfung schweigt vollständig.** `backend/update-check.js` enthält keine Logzeile (`catch (_e) { return null; }`). Totes Netzlaufwerk, fehlende Rechte und „kein Update vorhanden" sind nicht unterscheidbar — im Test bestätigt.

**Funktioniert bereits:** Die Drosselung für HTTP-Routenfehler (`backend/server.js:55`, verifiziert: 16 gleiche Fehler → eine volle Ausgabe mit Stacktrace, dann `(10x)`). Der Scheduler-Pfad ist daran nicht angeschlossen.

**Randbedingung:** **Keine neue Abhängigkeit** — der Server installiert mit `npm ci --omit=dev`, die CI kopiert `node_modules` unverändert ins Windows-Bündel. Kein `winston`, kein `pino`. Zeitstempel in lokaler Zeit mit Offset. `backend/tests/server.test.js` prüft bereits „logs a stack once per signature" — das darf nicht brechen.

## 7. Doppelte Geräte-UUID kostet echte Daten

**Befund V28 — schwer.** Zwei Messstellen dürfen dieselbe `device_uuid` tragen; `backend/db.js:31-48` kennt keinen UNIQUE-Constraint, `POST /api/stations` prüft nichts, die Oberfläche meldet nichts.

`backend/scheduler.js:90-96` baut `deviceToStation` **ohne `ORDER BY`** — bei einer Dublette gewinnt die später gelesene Zeile. Ab dann schreibt `scheduler.js:192` jeden neuen Messwert und Alarm unter die falsche Station. Im Log immerhin: `station 'pruef-06' overrides 'essbro'`.

**Der Verlust entsteht beim Aufräumen:** Im Test trug eine Teststelle dieselbe UUID wie UWL. Ein Zyklus schrieb zwei echte UWL-Alarme auf sie; beim Löschen nahm die `ON DELETE CASCADE` sie mit. Sie kamen nur zurück, weil der Alarm-Abruf 26 h zurückgreift und `ON CONFLICT(uuid)` sie wieder einsetzte — danach wären sie endgültig weg gewesen. Dazu im Log: `Error syncing alarms: FOREIGN KEY constraint failed` — ein Zyklus, der mit einer Doppel-Station startet und nach deren Löschung schreibt, bricht den kompletten Alarmschritt ab.

**Verwandt (D7):** Wird die UUID von Hand ins Freitextfeld getippt, fällt das Auswahlfeld darüber sichtbar auf die erste Option zurück („-- Kein Gerät zugewiesen --"), während die getippte UUID gespeichert wird. Beide teilen sich `formDeviceUuid` in `Smart Meter Dashboard/settings-stations.jsx`.

**Zu entscheiden:** Dublette verhindern (UNIQUE + verständliche Meldung) oder nur sichtbar machen. Für Ersteres spricht die Kaskade. Ein Constraint muss auf bestehenden Installationen greifen — vorher prüfen, ob dort Dubletten existieren können.

**Nicht ändern:** `ON CONFLICT … DO UPDATE` in `POST /api/stations` ist bewusst so (ein `INSERT OR REPLACE` würde beim Umbenennen die Zeile löschen und neu anlegen — Kaskade nähme die Historie mit). Im Test bestätigt: Umbenennen ließ 50.170 Messwerte unverändert.

## 8. Tachometer-Skala prüfen

**Beobachtung, kein bestätigter Fehler.** Eine Tachometer-Kachel zeigte **22,9 °C** bei Skalenenden **1,461107** und **22,116878** — der Wert lag außerhalb der eigenen Skala, der Zeiger am Anschlag.

Zwei Auffälligkeiten: Der Wert liegt über dem Maximum, und die Enden sind ungerundete Rohwerte mit sechs Nachkommastellen. Das deutet auf eine Skala hin, die aus Minimum und Maximum eines Datenfensters abgeleitet wird, das den aktuellen Wert nicht enthält.

Beiläufig aus einem Testlauf mit anderem Schwerpunkt — **erst reproduzieren**, es kann ein kurzzeitiger Zustand direkt nach dem Anlegen gewesen sein.

**Wo suchen:** `Smart Meter Dashboard/tiles.jsx` (`GaugeBody`), `charts.jsx`, `metrics-logic.js` samt `tests/metrics-logic.test.js`. Klären, ob die Skala aus `GET /api/limits` (die konfigurierten Schwellen, aktuell sechs Einträge) stammen sollte statt aus den Messdaten — für eine Klimaüberwachung wäre das fachlich richtiger.

---

## Sicherheitsregeln für Arbeiten an der laufenden Instanz

Sie enthält echte Daten und einen echten Cloud-Schlüssel:

- **Niemals `retention_days` ändern** — der Prune läuft im nächsten Zyklus (Sekunden später) und löscht bis zu 99 % der Messwerte. Im Test so passiert: 25.308 Messwerte weg.
- Keine Messstelle löschen (Kaskade), `poll_interval_sec` nicht über 3600 (Anfragensturm gegen die Cloud).
- Vor Eingriffen sichern: `sqlite3 klima.db ".backup 'klima.backup-<zweck>-<zeit>.db'"` — nicht `cp`, die laufende WAL macht die Kopie sonst inkonsistent. Das Namensschema `klima.backup-*.db` ist git-ignoriert.
- **Beim Zurückspielen:** Server per `SIGTERM` stoppen (nicht `kill -9`), prüfen dass `klima.db-wal`/`-shm` weg sind, **erst dann** einspielen. Ohne diesen Schritt: 48.563 statt 171.198 Messwerte und `integrity_check: malformed` — die Datei öffnet danach still und ohne Fehlermeldung.
- Das Kachel-Layout liegt nur im `localStorage` (`dash-layout-v3`), eine Import-Funktion gibt es nicht.

---

## Umsetzungsstand (v0.17.0, 2026-09-18)

Seriell abgearbeitet, je Aufgabe ein Subagent (erst Behauptungen am Code prüfen, dann umsetzen), jedes Ergebnis vom Orchestrator nachgeprüft. Tests: 330 → 394, alle grün.

| # | Ergebnis | Commit |
|---|---|---|
| 4 | Scheduler und Update-Prüfung starten erst nach erfolgreichem Port-Bind; jeder Bindefehler gibt eine Zeile ohne Stacktrace aus | `6c84375` |
| 6 | `backend/log.js`: Zeitstempel mit Offset, eine Herzschlagzeile je Zyklus, Scheduler-Fehler gedrosselt (wechselnde `instance`-ID herausgerechnet), Update-Prüfung loggt Zustandswechsel | `3a738a7` |
| 1 | Täglicher `VACUUM INTO`-Abzug nach `<backup_dir>/datenbank/`, die neuesten 7 Tage; Rücksicherung in `deploy/windows/README.md`. Nach Gegenprüfung: Aufbewahrung löscht bei eingeschalteter Sicherung nichts, was in keinem Abzug steht | `48d4800`, `dbfbe66` |
| 2 | Sicherungsfehler in Log, Systemübersicht, Kopfzeile und Dialog (aktualisiert sich); Knopf „Jetzt sichern“ (`POST /api/backup`). **V27 widerlegt:** ein Fehlschlag verbrauchte den Tagesversuch nie, gesehen wurde der veraltete Dialog (V26) | `b594f39` |
| 5 | Regeltabelle für `POST /api/settings` (erst alles prüfen, dann speichern); Intervall 60–3600 s, zusätzlich im Scheduler geklemmt; kaputtes JSON → 400 an allen Endpunkten | `a5b793c` |
| 3 | Datumsfelder im Ortstag statt UTC; dazu `presetRange` in Kalendertagen (Zeitumstellung) und V16 (leeres Datumsfeld) | `f024b0c` |
| 7 | Dubletten verhindert: 409 mit Name der anderen Messstelle, Teil-UNIQUE-Index (bei Alt-Dublette Warnung statt Startabbruch), Zuordnung deterministisch, FK-Abbruch beim Löschen während eines Zyklus behoben, D7 behoben | `5e76ba2` |
| 8 | **Beobachtung widerlegt:** die gemeldeten Skalenenden gab es in keinem Datenstand — die ungerundeten Beschriftungen wurden am Rand abgeschnitten, der Wert lag innerhalb. Skala jetzt aus den Grenzwerten (sonst Daten), Enden gerundet | `074b7c1` |

**Bewusst offen:** 429-Backoff (`testo-client.js`); Fehler der Update-Prüfung nur im Log, nicht in der Oberfläche; keine fachliche Obergrenze für `retention_days`; `setup.ps1` empfiehlt in zwei Hinweistexten noch `taskkill /IM node.exe /F`; `backend/tests/server.test.js` erreicht mit Wegwerf-Schlüsseln die echte testo-Cloud; die neuen §9-Punkte brauchen die Abnahme auf einer Windows-Maschine.

**Nachgezogen bis v0.17.2:** 429-Backoff nach `testo-smart-connect-api/03-async-pattern.md` — beim Absenden `Retry-After` bzw. 2/4/8 s, höchstens 3 Wiederholungen; beim Abfragen kein Abbruch, solange das 300-s-Budget reicht; `setup.ps1`-Hinweise ohne `taskkill /IM node.exe` (`c886601`); `server.test.js` ohne Cloud-Zugriff (`9723e49`, `83150d5`); Obergrenze für `retention_days` (v0.17.2): `POST /api/settings` nimmt 1 bis 3650 Tage an, und `retentionDays()` (`backup-runner.js`) klemmt jeden gespeicherten Wert auf diesen Bereich — für die Aufbewahrung, das Scan-Fenster der Sicherung und `GET /api/settings`. Offen bleiben die Update-Prüfungsfehler in der Oberfläche und die §9-Abnahme auf Windows.

**Nachgezogen in v0.18.0:** V7 erledigt — die Update-Prüfung nennt ihren Fehlergrund: `GET /api/system/status` liefert ihn unter `update.error` als Klartext (Leserecht des Computerkontos, Netzlaufwerksbuchstabe statt UNC-Pfad, sonst Code und Meldung), die Update-Karte unter Einstellungen → Erweitert zeigt Zustand, Grund und Prüfzeitpunkt, und eine bereitliegende Fassung meldet eine Hinweisleiste auf jeder Ansicht. Dazu der Update-Weg: `update.cmd` im Ablageordner lässt das installierte Programm die Fassung wählen und startet `install.cmd` der neuen Fassung mit Datenbank-Abzug und automatischem Rollback; Erstinstallation, Update und Rollback laufen im Windows-CI-Installtest (`e06658c`). Offen bleibt die §9-Abnahme auf Windows.
