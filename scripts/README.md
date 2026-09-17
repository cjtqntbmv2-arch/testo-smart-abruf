# Migrationsskripte (entfernt)

Dieses Verzeichnis ist leer. Es enthielt sechs einmalige Reparaturskripte für bereits
gespeicherte Daten: jedes gehörte zu einem Vorwärts-Fix im Anwendungscode, der nur neu
abgeholte Daten betraf — die alten Zeilen wurden nie erneut geholt und wären ohne diese
Skripte für immer falsch geblieben.

**Alle sechs sind an der einzigen Installation gelaufen.** Weitere Installationen stehen
nicht an, deshalb wurden sie am 2026-09-17 entfernt. Diese Notiz bleibt stehen, damit
nachvollziehbar ist, warum alte Datenzeilen anders aussehen als neue.

## Was jedes Skript repariert hat

| Skript | Repariert |
| --- | --- |
| `migrate-system-alarm-relabel.js` | System-Alarmzeilen (Verbindung/Batterie) aus dem testo-Feed lagen als `severity = 'warning'`; setzt `'system'` + normalisierten Subtyp und rechnet danach die `active`-Flags wie der Scheduler neu aus. |
| `migrate-system-alarm-text.js` | Alter Meldungstext der Systemzeilen („Alarm condition is violated" / „… Wert von null gemeldet."). |
| `migrate-measurement-alarm-text.js` | Englische Überschrift der Grenzwertalarme, ersetzt durch die deutsche Richtungsmeldung. |
| `migrate-dewpoint-relabel.js` | Taupunktkanal lag als zweite `'temperature'`-Reihe; prüfte rechnerisch gegen `dewPoint(Luft, Feuchte)` und schrieb nur bei Übereinstimmung um. |
| `migrate-pressure-relabel.js` | Barometrischer Druck lag als `'abshumid'`; erkannt an der Einheit `hPa`. |
| `migrate-alarm-resync.js` | Löschte die Alarm-Wasserstandsmarke, damit der nächste Sync 7 Tage Alarme erneut holt und dabei `metric`/`serial_no` nachträgt. |

Die ersten drei mussten in dieser Reihenfolge laufen: Skript 1 schrieb das Paar
`severity`/`alarm_condition_type`, auf dem 2 und 3 ihre disjunkten Zeilenmengen auswählten.

## Wo der Code liegt

In der Git-Historie. Zuletzt vorhanden im Commit
**`4dd2fa82f7cd4f541b7a0a09fcd0ee4b18ac9c6b`**, dort abrufbar mit

```
git show 4dd2fa8:scripts/migrate-system-alarm-relabel.js
```

Ebenfalls dort: `scripts/args.js` (die gemeinsame `--db`/`--apply`-Prüfung) sowie die
Tests `backend/tests/migrate-args.test.js` und
`backend/tests/migrate-system-alarm-relabel.test.js`.
