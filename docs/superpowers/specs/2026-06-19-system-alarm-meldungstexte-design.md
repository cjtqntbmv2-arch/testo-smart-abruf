# Spec: Verständliche Meldungstexte für Feed-System-Alarme

- **Datum:** 2026-06-19
- **Version-Ziel:** 0.9.0 → 0.9.1 (PATCH / Bugfix)
- **Status:** Freigegeben (Brainstorming abgeschlossen)

## Problem

Feed-basierte System-Alarme (Verbindungsausfall, schwache Batterie, Geräte-/Wartungshinweis)
kommen über denselben testo-Alarm-Feed wie Messwert-Alarme. Im Insert-Block des Schedulers
([backend/scheduler.js:325-333](../../../backend/scheduler.js)) durchlaufen sie dieselbe
Vorlage wie Messwert-Alarme:

- `message = a.alarm_reason` → generischer englischer Übergangstext **„Alarm condition is violated"**
- `detail  = `Sensor ${a.serial_no} hat einen Wert von ${a.alarm_value} gemeldet.`` →
  weil System-Alarme **keinen** Messwert tragen, ist `a.alarm_value` `null` und es erscheint
  wörtlich **„Sensor 51620927 hat einen Wert von null gemeldet."**

Das ist inhaltlich falsch: Das „null" ist kein gemessener Wert 0, sondern der fehlende
Messwert eines System-Alarms. Der Anwender liest eine Meldung, die suggeriert, der Sensor
habe „null" gemessen, obwohl es um einen abgerissenen Verbindungs-/Gerätestatus geht.

Die **synthetischen** System-Zeilen (`deriveSystemConditions`,
[backend/device-bridge.js:47-65](../../../backend/device-bridge.js)) zeigen dagegen bereits
sauberes Deutsch — die Inkonsistenz betrifft nur die feed-basierten Zeilen.

## Ziel

Feed-System-Alarme zeigen **Überschrift und Detail** in klarem Deutsch, im Wortlaut der
synthetischen Zeilen. Zusätzlich werden Messwert-Alarme gegen nicht-numerische `alarm_value`
abgesichert, damit auch sie nie „Wert von null" zeigen.

## Nicht-Ziele (YAGNI)

- **Keine** rückwirkende Migration alter DB-Zeilen. System-Alarme werden bei jedem Sync-Zyklus
  neu aus dem Feed geschrieben; bestehende falsche Texte verschwinden beim nächsten Lauf von
  selbst. Ein Migrationsskript ist nicht vorgesehen.
- **Keine** Frontend-Änderung. Alle Renderer lesen `e.message` / `e.detail`
  ([Smart Meter Dashboard/tiles.jsx](../../../Smart%20Meter%20Dashboard/tiles.jsx),
  Zeilen 471/488/506/509) — ein korrigierter Backend-Datensatz deckt Tile-Liste und
  Header-Detail-Panel gleichermaßen ab.
- **Kein** Eingriff in die Klassifizierung (`classifyAlarm`), das Icon-Mapping
  (`alarm_condition_type` → Subtyp-Icon) oder die Reconcile-/Aktiv-Logik.

## Lösung (Ansatz A: Backend, reine Helper-Funktion)

### 1. Neue Pure-Function `systemAlarmText` in `backend/device-bridge.js`

Signatur:

```js
function systemAlarmText(systemType) // → { message, detail }
```

Liefert je Subtyp fertige deutsche Texte:

| `systemType`            | `message`              | `detail`                                             |
|-------------------------|------------------------|------------------------------------------------------|
| `'connection'`          | `Verbindung verloren`  | `Gerät hat sich nicht im erwarteten Intervall gemeldet.` |
| `'battery'`             | `Batterie schwach`     | `Batteriestand des Geräts ist niedrig.`              |
| `'maintenance'`         | `Gerätehinweis`        | `Das Gerät meldet einen Geräte- oder Wartungshinweis.` |
| sonst (`null`/unbekannt)| → wie `'maintenance'`  | → wie `'maintenance'`                                |

Eigenschaften:

- **Rein** (keine Seiteneffekte, kein DB-/Zeit-Zugriff) → passt zu „device-bridge = pure
  mapping helpers" und ist direkt unit-testbar.
- `connection`/`battery`-`message` und `connection`-`detail` sind **wortgleich** zu
  `deriveSystemConditions`, damit synthetische und feed-basierte Zeilen identisch klingen.
  `battery`-`detail` weicht bewusst ab (der Feed liefert keinen Prozentwert; die synthetische
  Variante „Batteriestand bei X %." kann nicht repliziert werden).
- Unbekannte/fehlende Subtypen fallen sicher auf den `maintenance`-Text zurück (nie „undefined").
- Wird über `module.exports` exportiert (analog zu `classifyAlarm`,
  [backend/device-bridge.js:252](../../../backend/device-bridge.js)).

### 2. Verdrahtung im Scheduler-Insert-Block (`backend/scheduler.js`)

Im bestehenden Insert-Block (`severity`/`systemType` stammen bereits aus `classifyAlarm`,
`alarmValue` ist bereits gecoerced, [backend/scheduler.js:300-333](../../../backend/scheduler.js)):

```js
let message, detail;
if (severity === 'system') {
  ({ message, detail } = systemAlarmText(systemType));
} else {
  message = a.alarm_reason || 'Grenzwert verletzt';
  detail  = alarmValue != null
    ? `Sensor ${a.serial_no} hat einen Wert von ${alarmValue} gemeldet.`
    : `Sensor ${a.serial_no} hat einen Grenzwert verletzt.`;
}
```

Dann `message` / `detail` in `insertAlarmStmt.run(...)` einsetzen (ersetzt die bisherigen
Inline-Ausdrücke `a.alarm_reason || 'Grenzwert verletzt'` und das Null-Template).

Geänderte Spalten: **nur** `message` und `detail`. Unverändert bleiben: `alarm_status`,
`conditionForFrontend` (→ Icon), `alarmValue`, `metric`, `threshold`, Timestamps, `extreme`,
`active`, `serial_no`.

Zusätzliche Härtung (Messwert-Pfad): Das Detail nutzt jetzt den gecoerceten Zahlenwert
`alarmValue` statt des Rohstrings `a.alarm_value`; ist er `null` (nicht-numerisch/fehlend),
greift der generische Fallback „… hat einen Grenzwert verletzt." statt „Wert von null".

`import`/`require` von `systemAlarmText` zur bestehenden Destrukturierung aus `./device-bridge`
([backend/scheduler.js:3](../../../backend/scheduler.js)) hinzufügen.

## Tests (TDD — zuerst rot)

### `backend/tests/device-bridge.test.js`

- `systemAlarmText('connection')` → `{ message: 'Verbindung verloren', detail: 'Gerät hat sich nicht im erwarteten Intervall gemeldet.' }`
- `systemAlarmText('battery')` → `{ message: 'Batterie schwach', detail: 'Batteriestand des Geräts ist niedrig.' }`
- `systemAlarmText('maintenance')` → `{ message: 'Gerätehinweis', detail: 'Das Gerät meldet einen Geräte- oder Wartungshinweis.' }`
- `systemAlarmText(null)` und `systemAlarmText('unbekannt')` → identisch zum `maintenance`-Ergebnis.

### `backend/tests/scheduler.test.js`

- **Feed-Connection-Alarm** (System) ⟹ gespeicherte Zeile hat
  `message === 'Verbindung verloren'` und
  `detail === 'Gerät hat sich nicht im erwarteten Intervall gemeldet.'`
  (assert explizit: `detail` enthält **nicht** „Wert von null").
- **Messwert-Alarm mit nicht-numerischem `alarm_value`** (z. B. `alarm_value: null` oder `''`)
  ⟹ `detail` endet auf „hat einen Grenzwert verletzt." und enthält **nicht** „null".
- **Messwert-Alarm mit numerischem Wert** ⟹ unverändert „… hat einen Wert von <zahl> gemeldet.".
- Bestehende Connection-Alarm-Erwartungen anpassen
  ([backend/tests/scheduler.test.js:115/157-159/558ff](../../../backend/tests/scheduler.test.js)),
  die heute den generischen/`alarm_reason`-Text annehmen.

Vollständiger Lauf: `npm test` grün.

## Versionierung

Bugfix → **PATCH**: `0.9.0 → 0.9.1`. In Sync zu halten:

- `VERSION`
- README-Badge (`...badge/version-0.9.1-blue...`)
- `?v=`-Cache-Buster in `Smart Meter Dashboard/Klima Dashboard.html` (alle `?v=0.9.0` → `?v=0.9.1`)

Anschließend annotiertes Tag `v0.9.1`, `git push --follow-tags` (Versions-Sync-Autorisierung
greift).

## Akzeptanzkriterien

1. Ein Feed-Verbindungs-Alarm im Dashboard zeigt Überschrift „Verbindung verloren" und Detail
   „Gerät hat sich nicht im erwarteten Intervall gemeldet." — kein „Alarm condition is violated"
   und kein „Wert von null" mehr.
2. `systemAlarmText` ist rein, exportiert und für alle Subtypen + Fallback getestet.
3. Messwert-Alarme mit nicht-numerischem Wert zeigen keinen „null"-Text mehr.
4. `npm test` ist grün; Icon, Aktiv-Status und Reconcile-Verhalten unverändert.
5. Version konsistent auf 0.9.1 (VERSION, Badge, Cache-Buster), Tag `v0.9.1` gepusht.
