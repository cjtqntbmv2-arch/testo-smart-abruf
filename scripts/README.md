# Migrationsskripte

Einmalige Reparaturen an bereits gespeicherten Daten. Jedes Skript gehört zu einem
Vorwärts-Fix im Anwendungscode, der nur neu abgeholte Daten betrifft — die alten Zeilen
werden nie erneut geholt und blieben ohne diese Skripte für immer falsch.

## Bevor du irgendetwas startest

1. **Dienst stoppen.** Läuft das Skript gegen eine Datenbank, die ein anderer Prozess
   gerade in einer Transaktion hält, bricht es mit `SQLITE_BUSY` ab (nachgemessen).
   Halb migriert wird dabei nichts, aber der Lauf ist vergeudet.
2. **Sichern — ausschließlich per `VACUUM INTO`, niemals als blanke Dateikopie.**
   Die Datenbank läuft im WAL-Modus; einer reinen Kopie von `klima.db` fehlen alle Daten,
   die noch in `klima.db-wal` stehen (nachgemessen: 36.563 gegen 36.531 Messwerte).

   ```
   sqlite3 C:\ProgramData\TestoSmartAbruf\klima.db "VACUUM INTO 'C:\Temp\klima-sicherung.db'"
   ```
3. **`--db` ist Pflicht.** Kein Skript rät den Datenbankpfad und keines fällt still auf
   einen zurück. Wo die Produktionsdatenbank liegt, sagt die Umgebungsvariable `DB_PATH`
   des Dienstes (üblicherweise `C:\ProgramData\TestoSmartAbruf\klima.db`, siehe
   `deploy/windows/`). Zeigt der Pfad ins Leere oder auf etwas, das keine
   SQLite-Datenbank ist (`klima.db-wal`, eine Sicherungs-ZIP), bricht das Skript ab,
   bevor es die Datei öffnet — es legt am falschen Pfad nichts an.
4. **Erst trocken laufen lassen.** Ohne `--apply` wird nichts geschrieben; das Skript
   zeigt nur, was es täte. **`--apply` schreibt direkt in die angegebene Datenbank —
   es gibt keinen Weg zurück außer der Sicherung aus Schritt 2.**

```
node scripts/<skript>.js --db <pfad>            # Trockenlauf
node scripts/<skript>.js --db <pfad> --apply    # schreibt
```

Alle sechs Skripte sind idempotent (nachgemessen): ein zweiter Lauf findet nichts mehr zu
tun und meldet „already clean" bzw. „0 rows". Einzige Einschränkung ist
`migrate-alarm-resync.js` — siehe unten.

## Reihenfolge

```
1. migrate-system-alarm-relabel.js      \
2. migrate-system-alarm-text.js          |  Alarmzeilen (Tabelle events) — Reihenfolge bindend
3. migrate-measurement-alarm-text.js    /
-- frei einsortierbar, unabhängig: --
   migrate-dewpoint-relabel.js             (Tabelle measurements)
   migrate-pressure-relabel.js             (Tabelle measurements)
-- zum Schluss: --
   migrate-alarm-resync.js                 (Tabelle settings)
```

### Warum 1 vor 2 und 3 stehen muss

Die Abhängigkeit steht in keinem Skriptkommentar; sie ergibt sich daraus, welches Skript
ein Feld schreibt, das ein anderes liest.

* **1 schreibt** in `migrate-system-alarm-relabel.js:81` gleichzeitig `severity = 'system'`
  **und** `alarm_condition_type = <'connection'|'battery'>` (der normalisierte Subtyp
  ersetzt den englischen Rohtext der testo-Meldung).
* **2 liest genau dieses Paar**: `migrate-system-alarm-text.js:41` wählt
  `WHERE severity = 'system' AND alarm_status IS NOT NULL`, und Zeile 43 leitet den
  Meldungstext aus `systemAlarmText(r.alarm_condition_type)` ab. Vor Schritt 1 stehen die
  Systemzeilen noch auf `severity = 'warning'` — Skript 2 findet sie schlicht nicht und
  bekäme, fände es sie doch, statt `'connection'` den Rohtext zu sehen.
* **3 liest die Gegenmenge**: `migrate-measurement-alarm-text.js:39` wählt
  `WHERE severity != 'system' AND alarm_status IS NOT NULL` und wertet in Zeile 46
  `alarmConditionDirection(r.alarm_condition_type)` aus — dieselbe Spalte, die 1 umschreibt.
  Vor Schritt 1 fallen die Systemzeilen **in** diese Menge und bekommen eine
  Messwert-Überschrift auf einen Verbindungsabbruch. Nachgemessen an einer Wegwerf-DB:
  eine Zeile mit `alarm_condition_type = 'Connection timeout, device did not communicated
  in expected time'` steht hinterher auf `message = 'Grenzwert verletzt'`.

**2 und 3 untereinander sind frei:** 2 schreibt `message`+`detail` der Systemzeilen
(`migrate-system-alarm-text.js:41`) und nur `detail` der Messzeilen (Zeile 50), 3 schreibt
nur `message` der Messzeilen (`migrate-measurement-alarm-text.js:63`). Getrennte Spalten,
keine Überschneidung.

### Warum die übrigen drei frei sind

`migrate-dewpoint-relabel.js` und `migrate-pressure-relabel.js` fassen ausschließlich
`measurements` an und dort disjunkte Zeilenmengen (`physical_property` `'temperature'`/
`'humidity'` gegen `'abshumid'` mit Einheit `hPa`). Sie berühren die Alarmkette nicht und
sich gegenseitig nicht.

`migrate-alarm-resync.js` fasst nur `settings` an (löscht `last_alarm_sync_time`). Es hat
keine Lese-/Schreib-Abhängigkeit, gehört aber **ans Ende**: seine Wirkung tritt erst beim
nächsten Dienststart ein — der Scheduler holt dann 7 Tage Alarme erneut und überschreibt
per `ON CONFLICT(uuid) DO UPDATE` (`backend/scheduler.js:249`) unter anderem `severity`,
`alarm_condition_type`, `message` und `detail`. Läuft es zu früh, arbeitet der Wiederabruf
gegen eine noch halb migrierte Datenbank.

Zudem ist es das einzige Skript, dessen Wiederholung Arbeit auslöst: nach einem
Dienstlauf steht die Marke wieder, ein erneuter Lauf löst also einen weiteren
7-Tage-Abruf aus. Die Datenbank bleibt dabei konsistent, der Abruf kostet nur Zeit.

## Die einzelnen Skripte

| Skript | Repariert |
| --- | --- |
| `migrate-system-alarm-relabel.js` | System-Alarmzeilen (Verbindung/Batterie) aus dem testo-Feed lagen als `severity = 'warning'`; setzt `'system'` + normalisierten Subtyp und rechnet danach die `active`-Flags wie der Scheduler neu aus. |
| `migrate-system-alarm-text.js` | Alter Meldungstext der Systemzeilen („Alarm condition is violated" / „… Wert von null gemeldet."). |
| `migrate-measurement-alarm-text.js` | Englische Überschrift der Grenzwertalarme, ersetzt durch die deutsche Richtungsmeldung. |
| `migrate-dewpoint-relabel.js` | Taupunktkanal lag als zweite `'temperature'`-Reihe; prüft rechnerisch gegen `dewPoint(Luft, Feuchte)` und schreibt nur bei Übereinstimmung um. |
| `migrate-pressure-relabel.js` | Barometrischer Druck lag als `'abshumid'`; erkennt ihn an der Einheit `hPa` und bricht ab, wenn ein Wert außerhalb 500–1100 hPa liegt. |
| `migrate-alarm-resync.js` | Löscht die Alarm-Wasserstandsmarke, damit der nächste Sync 7 Tage Alarme erneut holt und dabei `metric`/`serial_no` nachträgt. |

## Tests

`backend/tests/migrate-args.test.js` deckt die Argumentprüfung aller Skripte ab (fehlendes
`--db`, `--db` ohne Wert, Trockenlauf ändert nichts),
`backend/tests/migrate-system-alarm-relabel.test.js` die Partitionierung der
`active`-Neuberechnung. Beide arbeiten ausschließlich auf Wegwerf-Datenbanken in `$TMPDIR`.
