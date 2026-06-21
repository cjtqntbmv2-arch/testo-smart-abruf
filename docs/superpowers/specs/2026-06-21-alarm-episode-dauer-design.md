# Spec: Echte Alarm-Dauer & Episode-Konsolidierung

- **Datum:** 2026-06-21
- **Version-Ziel:** 0.9.2 → 0.9.3 (PATCH / Bugfix)
- **Status:** Freigegeben (Brainstorming abgeschlossen)

## Problem

In der Historie zeigen praktisch **alle** vergangenen Meldungen eine Dauer von **„< 1 min"** —
unrealistisch. Messung in der Live-DB: von 344 Feed-Zeilen haben 190 exakt `start_ts == end_ts`,
152 weitere unter 1 min (1–2 s Verarbeitungs-Lag), nur 2 über 1 min.

Ursachen — beide an derselben Wurzel (der testo `/v3/alarms`-Feed ist ein **Übergangs-Log**:
Verletzung `alarm_status='Alarm'` und Entspannung `'Ok'` sind **getrennte Zeilen** mit eigenen
UUIDs):

1. **Dauer immer „< 1 min".** Der Insert speichert pro **einzelner** Zeile
   ([backend/scheduler.js:346](../../../backend/scheduler.js)):
   `start_ts = parseTimestamp(a.alarm_time)`, `end_ts = parseTimestamp(a.last_status_change_time)`.
   Laut Doku ist `last_status_change_time` „Last time the alarm condition status changed"
   ([testo-smart-connect-api/05-endpoints/retrievable-parameters.md:145](../../../testo-smart-connect-api/05-endpoints/retrievable-parameters.md)) —
   also der Zeitpunkt **genau dieses** Übergangs. Auf einer einzelnen Zeile fallen beide
   Zeitstempel zusammen. Das Frontend rechnet
   `formatDuration(e.endTs - e.startTs)` ([Smart Meter Dashboard/tiles.jsx:513/562](../../../Smart%20Meter%20Dashboard/tiles.jsx))
   ⟹ ≈ 0 ⟹ „< 1 min". Die echte Episodendauer ist die **Lücke zwischen zwei Zeilen**
   (Beispiel aus der Live-DB: `Alarm` bei 1781998109000, `Ok` bei 1782001473000 ⟹ ~56 min).

2. **Phantom-Karten.** Die History-Query ([backend/server.js:192-223](../../../backend/server.js))
   liefert **alle** `active=0`-Zeilen, also auch reine Entspannungen (`'Ok'`). Der Renderer
   rekonstruiert die Überschrift aus Metrik/Schwelle, **nicht** aus `e.message`
   ([Smart Meter Dashboard/tiles.jsx:540-545](../../../Smart%20Meter%20Dashboard/tiles.jsx)),
   sodass eine Entspannungs-Zeile als zweite „über X"-Verletzungskarte erscheint — erkennbar an
   einer `Spitze` **unter** der Schwelle (z. B. „über 55 · Spitze 54"). In der Live-DB:
   170 `Alarm`- und 170 `Ok`-Zeilen ⟹ Historie ist faktisch verdoppelt.

## Ziel

Pro Alarm-**Episode** genau **eine** Karte in der Historie, mit **echter Dauer** (Lücke
Verletzung → Entspannung). Reine Entspannungs-Zeilen erscheinen nicht mehr als eigene Karte;
ihr Zeitpunkt fließt als Episodenende in die Dauer ein. Aktive Alarme zeigen weiter „läuft".

## Nicht-Ziele (YAGNI)

- **Kein** neues „Entspannung"/„wieder im Normbereich"-Kartendesign (Produktentscheidung: nur
  eine Episode-Karte).
- **`Spitze`/`extreme` bleibt** der Messwert zum Auslöse-Zeitpunkt (nicht das Episoden-Maximum).
  Separates Thema, betrifft die Dauer nicht.
- **Kein** Eingriff in Klassifizierung (`classifyAlarm`), Icon-Mapping, Schwellen-Sync oder die
  selbst-abgeleiteten `sys-*`-Zeilen (`alarm_status IS NULL`, von `applySystemEvents`).
- **Kein** Migrationsskript (siehe „Migration bestehender Zeilen" — Daten heilen sich selbst).

## Lösung

`end_ts` wird neu definiert als **Start des chronologisch nächsten Übergangs derselben
logischen Gruppe** statt als `last_status_change_time` der eigenen Zeile. Reine
Entspannungen werden in der Historie serverseitig ausgeblendet.

### Änderung 1 — Reconciliation berechnet `end_ts` (`backend/scheduler.js`)

In der bestehenden Reconciliation-Transaktion
([backend/scheduler.js:364-380](../../../backend/scheduler.js)), die schon `active` über
dieselbe Partition setzt, kommt **nach** dem Aktiv-`UPDATE` ein drittes Statement dazu, das
`end_ts` jeder Feed-Zeile via `LEAD(start_ts)`-Fensterfunktion auf den Start der nächsten
Zeile derselben Gruppe setzt:

```sql
UPDATE events AS e
SET end_ts = nxt.next_start
FROM (
  SELECT rowid AS rid,
    LEAD(start_ts) OVER (
      PARTITION BY station_id, COALESCE(serial_no,''), alarm_condition_type, severity, COALESCE(metric,'')
      ORDER BY start_ts ASC, rowid ASC
    ) AS next_start
  FROM events
  WHERE alarm_status IS NOT NULL
) AS nxt
WHERE e.rowid = nxt.rid AND e.alarm_status IS NOT NULL
```

- **Partition identisch** zur Aktiv-Reconciliation (`station_id, serial_no, alarm_condition_type,
  severity, metric`), damit Verletzung und Entspannung in derselben Gruppe paaren. `ORDER BY
  start_ts ASC` ⟹ `LEAD` = die zeitlich **nächste** (spätere) Zeile.
- Filter `alarm_status IS NOT NULL` schließt `sys-*`-Zeilen aus (von `applySystemEvents`
  eigenständig verwaltet).
- Ergebnis pro Zeile:
  - **Inaktive Verletzung** → `end_ts` = Entspannungs-`start_ts` ⟹ Dauer = echte Episodendauer.
  - **Aktive Verletzung** (neueste, `LEAD = NULL`) → `end_ts = NULL`; Frontend zeigt „läuft" am
    `active`-Flag, nicht an `end_ts`.
  - **Entspannungs-Zeile** → `end_ts` egal (wird ausgeblendet).
- **Reihenfolge im Zyklus:** Der Insert-Block ([scheduler.js:287-351](../../../backend/scheduler.js))
  schreibt `end_ts = last_status_change_time`; die Reconciliation läuft **danach** im selben
  Zyklus und überschreibt es → die Reconciliation ist für `end_ts` **autoritativ**. Insert und
  `ON CONFLICT … end_ts = excluded.end_ts` bleiben unverändert (transient, gleich überschrieben).
- **SQLite-Voraussetzung:** `UPDATE … FROM` (SQLite ≥ 3.33) und Fensterfunktionen (≥ 3.25). Die
  von `better-sqlite3` gebündelte Version erfüllt das; im Plan wird es vor der Implementierung
  einmal verifiziert (`SELECT sqlite_version()`).

### Änderung 2 — History-Endpoint blendet Entspannungen aus (`backend/server.js`)

In `/api/stations/:id/events` ([backend/server.js:192-223](../../../backend/server.js)) eine
Klausel ergänzen, die reine Entspannungen ausschließt:

```js
clauses.push("(alarm_status IS NULL OR alarm_status <> 'Ok')");
```

- **`sys-*`-Zeilen** (`alarm_status IS NULL`) bleiben erhalten.
- **Aktive Zeilen** sind nie `'Ok'` ⟹ unberührt.
- Gilt für **alle** Aufrufe dieses Endpoints — sowohl History (`?active=0`,
  [data.js:405](../../../Smart%20Meter%20Dashboard/data.js)) als auch Live-Poll (`?limit=N` ohne
  `active`, [data.js:247](../../../Smart%20Meter%20Dashboard/data.js)). Der Poll filtert aktive
  Events ohnehin clientseitig (`e.active`, [summary-logic.js:22](../../../Smart%20Meter%20Dashboard/summary-logic.js));
  der `'Ok'`-Ausschluss trifft also genau die Phantom-Karten in der Tile-/History-Liste.
- **Cursor-Pagination bleibt korrekt:** `LIMIT` zählt nur sichtbare Zeilen; der Cursor
  (`before_ts`/`before_rowid`) ankert an der letzten sichtbaren Zeile und überspringt die
  ausgeblendeten `'Ok'`-Zeilen sauber.

### Änderung 3 — Defensiver Guard in `formatDuration` (`Smart Meter Dashboard/data.js`)

`formatDuration` ([data.js:365-372](../../../Smart%20Meter%20Dashboard/data.js)) erhält am Anfang:

```js
if (!Number.isFinite(ms)) return "—";
```

Verhindert „NaN h", falls eine inaktive Zeile ausnahmsweise kein `end_ts` trägt
(`e.endTs - e.startTs` ⟹ `NaN`). Sonst **keine** Frontend-Änderung: `formatDuration(e.endTs -
e.startTs)` liefert jetzt automatisch echte Werte, und die ausgeblendeten `'Ok'`-Zeilen
beseitigen die Phantom-Karten.

## Tests (TDD — zuerst rot)

### `backend/tests/scheduler.test.js`

Vorlage: der bestehende Reconciliation-Test
([scheduler.test.js:136-160](../../../backend/tests/scheduler.test.js)) mit `offsetMin`-Helper
und `MockTestoClient`.

- **Episodendauer aus Paar:** Verletzung (`'Alarm'`, t0) + Entspannung (`'Ok'`, t0+47 min),
  gleiche Gruppe ⟹ nach `runSyncCycle` hat die **Verletzungs**-Zeile `end_ts - start_ts == 47 min`.
- **Aktive Verletzung:** einzelne offene Verletzung (`'Alarm'`, keine Entspannung) ⟹ `active = 1`
  und `end_ts IS NULL`.
- **Zwei Verletzungen ohne Entspannung dazwischen** (Alarm t0, Alarm t0+10 min) ⟹ die ältere
  Verletzung bekommt `end_ts` = `start_ts` der jüngeren (Episodenende = nächster Übergang).
- **Partition-Trennung:** zwei Verletzungen unterschiedlicher Gruppen (anderes `serial_no` bzw.
  `severity`) paaren **nicht** über Kreuz (`end_ts` der einen bezieht sich nicht auf die andere).

### `backend/tests/server.test.js` (Endpoint)

- `?active=0` liefert **keine** `'Ok'`-Zeilen, aber `'Alarm'`-Zeilen **und** `sys-*`
  (`alarm_status IS NULL`).
- `?limit=N` (ohne `active`) liefert aktive `'Alarm'`-Zeilen, aber keine `'Ok'`-Zeilen.
- Cursor-Pagination (`before_ts`/`before_rowid`) bleibt über mehrere Seiten lückenlos und
  doppelfrei, auch wenn `'Ok'`-Zeilen dazwischen lägen.

### `formatDuration`-Guard

`formatDuration(NaN)` und `formatDuration(null)` ⟹ „—"; `formatDuration(47*60000)` ⟹ „47 min"
(reine Zahlfälle unverändert). Sofern `data.js`-Helper nicht direkt unit-testbar sind, wird der
Guard über die Preview visuell verifiziert; die Logik ist ein Einzeiler.

Vollständiger Lauf: `npm test` grün.

## Migration bestehender Zeilen

**Keine** Migration nötig. Anders als ein per-Insert-Fix recomputet die Reconciliation `end_ts`
in **jedem erfolgreichen Sync-Zyklus** über die **gesamte** `events`-Tabelle (das `UPDATE` hat
keinen Zeitfilter). Beim nächsten Zyklus tragen damit alle ~340 Bestandszeilen automatisch das
korrekte `end_ts`; die Phantom-`'Ok'`-Karten verschwinden sofort über den Endpoint-Filter. Die
Korrektheit der Historie stellt sich also innerhalb eines Sync-Intervalls ohne Skript ein.

## Versionierung

Bugfix → **PATCH**: `0.9.2 → 0.9.3`. Konsistent zu halten:

- `VERSION`
- README-Badge (`…badge/version-0.9.3-blue…`)
- `?v=`-Cache-Buster in `Smart Meter Dashboard/Klima Dashboard.html` (alle `?v=0.9.2` → `?v=0.9.3`)

Kein Git-Remote konfiguriert → Tag-/Push-Schritt der Versionierungsregel **entfällt**; lokaler
`chore`-Commit mit konsistenter Version an allen drei Stellen.

## Akzeptanzkriterien

1. Eine abgeschlossene Alarm-Episode zeigt in der Historie ihre **echte Dauer** (z. B. „47 min",
   „1 h 12 min") statt „< 1 min".
2. Reine Entspannungs-Zeilen (`'Ok'`) erscheinen **nicht** mehr als eigene Karte; keine Karte
   mit `Spitze` unter der Schwelle mehr.
3. Aktive Alarme zeigen weiter „läuft" (`end_ts = NULL`, unverändertes Verhalten).
4. `sys-*`-Zeilen und aktive Events bleiben im Endpoint sichtbar; Reconcile-/Aktiv-Logik,
   Icons und Schwellen unverändert.
5. Bestandsdaten heilen sich beim nächsten erfolgreichen Sync selbst (keine Migration).
6. `npm test` grün; neue Tests für Dauer-Paarung, Partition-Trennung und `'Ok'`-Filter.
7. Version konsistent auf 0.9.3 (VERSION, Badge, Cache-Buster). Kein Remote → kein Tag/Push.
