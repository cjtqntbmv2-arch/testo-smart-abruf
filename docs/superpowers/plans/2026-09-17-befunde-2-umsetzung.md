# Umsetzung der Befundliste 2 (Projektanalyse 2026-09-17)

Spezifikation ist der Befundbericht der Analyse-Sitzung vom 2026-09-17 (14 Aufgaben,
sortiert nach Nutzen pro Aufwand). Diese Datei ist die Fortschrittsverfolgung und der
verbindliche Wellenschnitt — sie wiederholt den Bericht nicht.

Grundlage: 28 Agenten haben die 14 Aufgaben am Code vertieft, jede Untersuchung wurde
adversarisch gegengeprüft. Anschließend haben drei unabhängige Reviewer den Plan selbst
angegriffen (Linsen: Disjunktheit der Wellen, falsche Codeannahmen, Falsifizierbarkeit
der Prüfschritte) und dabei sechs Fehler gefunden, die hier bereits eingearbeitet sind.
Zusatzbefunde stehen unten unter „Was die Vertiefung zusätzlich ergab".

## Entscheidungen des Nutzers (2026-09-17)

- **Release:** Tag jetzt setzen, §9-Abnahme auf Windows später. Die Abnahme blockiert
  die Wellen 1–3 **nicht**; sie steht unten als offener Punkt.
- **Aufgabe 10:** Die vier Skripte sind an der einzigen Installation gelaufen, weitere
  Installationen stehen nicht an → **löschen statt testen**.
- **Aufgabe 13:** Nur `backend/event-reconcile.js` extrahieren, kein voller
  Datenzugriffs-Layer.
- **Aufgabe 14:** Wird umgesetzt, als letzte Welle allein.

## Regeln für jeden Agenten

- Erst vertiefen (Befund am Code verifizieren), dann umsetzen. Die Vertiefung aus der
  Planungssitzung liegt vor, ist aber nicht heilig — widersprich ihr, wenn der Code
  etwas anderes sagt, und melde das.
- **Test zuerst:** der fehlschlagende Test kommt vor der Implementierung, der rote Lauf
  wird tatsächlich beobachtet und im Bericht genannt.
- **Nur die zugewiesenen Dateien anfassen.** Andere Dateien: melden, nicht ändern.
- **`CLAUDE.md`, `README.md` und `deploy/windows/README.md` fasst kein Agent an.**
  Diese drei werden von vier bzw. fünf Aufgaben berührt; der Orchestrator pflegt sie
  zwischen den Wellen. Wenn deine Arbeit eine Doku-Änderung dort nötig macht: den
  gewünschten Wortlaut im Bericht liefern, nicht selbst editieren.
- **`VERSION`, `package.json`-Version, README-Badge und die `?v=`-Cache-Buster fasst
  kein Agent an.** Versionsstrategie siehe unten.
- **Niemals `.env` oder `.env.*` anfassen** — in einer früheren Sitzung hat ein Subagent
  `.env.example` auf 0 Byte gekürzt.
- Nicht committen. Der Orchestrator committet je Welle.
- `backend/tests/server.test.js` scheitert in der Sandbox mit `EPERM` beim `listen` auf
  127.0.0.1:3001. Das ist **kein** Codefehler. Nicht danach suchen.
- Eine neue Datei unter `Smart Meter Dashboard/` braucht einen `<script>`-Tag in
  `Klima Dashboard.html` **mit** `?v=<VERSION>`. Eine neue **Test**datei unter
  `Smart Meter Dashboard/tests/` braucht zusätzlich einen Eintrag in der Testliste von
  `package.json` — die Dashboard-Tests sind dort **einzeln** aufgeführt (`package.json:8`),
  nicht per Glob. Quelldateien gehören **nicht** in diese Liste.
- Eine neue `.jsx` braucht ein **freies** Hook-Alias-Präfix. Vergeben und geprüft:
  bare (`charts.jsx`), `a*` (`app.jsx`), `s*` (`settings.jsx`), `t*` (`tiles.jsx`),
  `h*` (`header.jsx`), `ss*` (`summary-panel.jsx`), Suffix `*E` (`export-panel.jsx`).
- Neue Testdateien unter `backend/tests/` laufen per Glob automatisch mit.

## Regeln für den Orchestrator

- **Jede Welle läuft auf einem eigenen Branch und wird mit `finish -y` abgeschlossen,
  nicht von Hand gemergt.** `finish` holt den Hauptbranch zuerst in den Feature-Branch,
  testet danach und testet nach dem Merge erneut, wenn der Baum abweicht
  (`~/.local/bin/finish:179-217`). Ein handgebautes `npm test && git merge` hat diesen
  zweiten Lauf nicht und lässt genau den semantischen Bruch durch, den `finish` fängt.
  `finish` und `ship` mit `dangerouslyDisableSandbox` aufrufen (sonst meldet git
  `.env.example` fälschlich als gelöscht).
- **Testzahl festhalten, nicht nur `fail 0`.** Vor jeder Welle `ℹ pass N` notieren, nach
  der Welle muss die Zahl **gestiegen** sein. `npm test` kettet zwei `node --test`-Läufe
  mit `&&` (`package.json:8`) — es sind zwei Blöcke, die addiert werden müssen.
  Begründung: bei einem Commit je Welle ist `git log --diff-filter=D` **wirkungslos** —
  eine Datei, die Agent A anlegt und Agent B vor dem Commit löscht, war nie in einem
  Commit. `fail 0` bleibt dabei grün.
- **Nach jeder Welle prüfen, dass jede oben als „(neu)" gelistete Datei existiert.**
  Zweiter Riegel gegen dieselbe Lücke.

## Versionsstrategie

Zwei Releases, nicht acht. Ein Bump pro Welle würde `VERSION`, `package.json`, den
README-Badge und die `?v=` in jede Welle ziehen und jede Parallelität zerstören.

| Zeitpunkt | Version | Inhalt |
|---|---|---|
| Ende Block A | **0.16.1** | Die zwei liegengebliebenen Fixes + Doku-Korrektur |
| Ende Welle 3 | **0.17.0** | `csv_format`-Oberfläche und Speicher-Banner sind `feat`, der Rest intern |

## Block A — Release 0.16.1 (seriell, keine Parallelität)

| Schritt | Aufgabe | Dateien | Stand |
|---|---|---|---|
| A0 | #8 Worktree entfernen | `.claude/worktrees/eager-chebyshev-1b84d7` | **erledigt** — SHA `16e73b4` war Vorfahr von `main` und `origin/main`, Worktree sauber, `node_modules` echtes Verzeichnis (kein Symlink) |
| A1 | #4 Versions-Sync-Test (rot) | `backend/tests/version-sync.test.js` | **erledigt** — roter Lauf beobachtet: `actual '0.15.1' / expected '0.16.0'`, genau die eine Zusicherung |
| A2 | #1 Doku-Korrektur, **sechs** Stellen | `deploy/windows/README.md` | **erledigt** — Test danach 3/3 grün, Gegenproben leer |
| A3 | #2 `node_modules` auf better-sqlite3 13.0.3, Suite dagegen | keine getrackte Datei | **erledigt** — 13.0.3, alle 8 Prebuilds, **kein** `build/`; 316/316 grün auf Node 26 |
| A3b | **nachträglich aufgenommen:** drei moderate CVEs der express-4-Kette | `package-lock.json` | **erledigt** — `npm audit fix` (ohne `--force`), `qs` 6.15.2, express bleibt 4.22.2, 0 verbleibend |
| A4 | #3 Bump 0.16.1, Tag, CI baut das Bundle | `VERSION`, `package.json`, `package-lock.json`, `README.md`, `Smart Meter Dashboard/Klima Dashboard.html`, `deploy/windows/README.md` | **erledigt** — alle sechs Orte auf 0.16.1, Tag `v0.16.1` gesetzt und gepusht |

**A3b war nicht geplant.** Das `npm ci` in A3 machte drei moderate CVEs sichtbar
(`qs` → `body-parser` → `express`, zwei DoS-Vektoren). `npm audit fix` behebt alle drei
**innerhalb** express 4.x — der Umstieg auf express 5, den der Nutzer am 2026-09-16
ausdrücklich zurückgestellt hat, bleibt davon unberührt. Vom Nutzer am 2026-09-17
freigegeben, weil es dieselbe Datei betrifft, die A4 ohnehin anfasst, und einen zweiten
Release erspart. Änderungsumfang: 19 Zeilen in `package-lock.json`, sonst nichts.

**Testzahl-Protokoll Block A:** 313 (Baseline) → **316** nach A1. Die drei neuen sind der
Versions-Sync-Test. Gestiegen, wie die Orchestrator-Regel es verlangt.

**A0** ist bulk-destructive: Inventar vor dem Löschen, SHA (`16e73b4`) festhalten,
`git -C <worktree> status --porcelain` und `git -C <worktree> log --oneline main..HEAD`
müssen beide leer sein. Erst dann `git worktree remove`.

**A1 — der Test ankert am Satz, nicht an der Zeilennummer.** Eine Prüfung auf „jede
Versionsangabe muss `VERSION` entsprechen" ist unbrauchbar: gemessen 15 Treffer, 14 davon
Fehlalarm (die IP `127.0.0.1`, `HOST=0.0.0.0`, die absichtlichen Marker `ab v0.11.0` /
`v0.14.0` / `v0.15.0`, die bewusst fixe `0.9.0`). Stattdessen:

```js
const m = README.match(/`appVersion` lautet `([^`]+)`/);
assert.ok(m, 'appVersion-Zeile nicht gefunden');   // laut scheitern, wenn jemand den Satz umschreibt
assert.strictEqual(m[1], VERSION);
```

Dazu zwei weitere `assert` in dieselbe Datei — sie liest `VERSION` ohnehin:
`package.json.version === VERSION` und der README-Badge `version-<VERSION>-blue`.
Beide sind heute **ungeprüft**: der ZIP-Name kommt aus `package.json`
(`windows-bundle.yml:72`), `appVersion` aus `VERSION` (`server.js:18`) — divergieren sie,
vergleicht `update-check.js` einen ZIP-Namen gegen eine andere laufende Version und meldet
dauerhaft „Update verfügbar".

Tautologisch ist das nicht: `server.js:18` liest `appVersion` wirklich aus der Datei
`VERSION`, die README-Behauptung ist also genau dann wahr, wenn das Literal passt.

**A2 — die sechs Stellen** (drei aus dem Bericht, drei von der Prüfung gefunden):

| Zeile | Was |
|---|---|
| 68 | `npm ci --omit=dev` → `--ignore-scripts` ergänzen (`setup.ps1:121` tut es längst) |
| 286–287 | Proxy-Punkt: `github.com` → `registry.npmjs.org`, parallel zu Zeile 25 |
| 328 | `appVersion` `0.15.1` → **`0.16.0`** (der Stand, der zu diesem Zeitpunkt gilt — siehe unten) |
| 329 | „Alle **14** `<script …?v=…>`-Tags" → Zahl streichen, „alle App-`<script>`-Tags". B1 legt zwei Dateien an, B7 eine → die Zahl wäre danach 17 |
| 333–339 | Update-Probe: nennt `0.16.0` als „höhere" ZIP gegenüber laufender `0.15.0` — bei VERSION 0.16.0 **nicht mehr bestehbar** (`update-check.js:60` verlangt echt größer). Versionsrelativ formulieren, **aber die `0.9.0` in Zeile 334 und 343 bleibt fix** — sie trägt das Argument des Zeichenketten-Vergleichs |
| 375 | `build\Release\better_sqlite3.node` → `prebuilds\win32-x64.node`, plus: `build\` darf **nicht** existieren (`setup.ps1:137` und `windows-bundle.yml:61` brechen sonst ab) |

**Warum Zeile 328 auf `0.16.0` und nicht auf `0.16.1`:** A4 bumpt `VERSION` erst danach.
Schriebe A2 schon `0.16.1`, bliebe der Test aus A1 bis A4 **rot** — und A3 liegt
dazwischen und hat als einzige Prüfung „Suite grün". Gemessen: A1 rot, A2 mit `0.16.1`
weiterhin rot, erst A4 grün. Mit `0.16.0` gilt: A1 rot → A2 grün → A3 prüfbar → A4 hebt
`VERSION` **und** diese Zeile gemeinsam auf `0.16.1`, bleibt grün. A4 besitzt
`deploy/windows/README.md` ohnehin.

**A3 ist kein Formalakt.** Installiert ist 12.10.0, das gar kein `prebuilds/` hat, sondern
`build/Release/` plus `scripts.install: "prebuild-install || node-gyp rebuild"` — und
`prebuild-install` lädt von `github.com`. Genau deshalb war Zeile 287 einmal richtig.
13.0.3 liefert alle acht Plattform-Prebuilds im Tarball mit, `darwin-arm64` eingeschlossen;
`npm ci --ignore-scripts` braucht hier also keinen Compiler, und `--ignore-scripts` bleibt
Pflicht, weil `binding.gyp` weiterhin im Tarball liegt. Lauf ohne Sandbox (Port-Bindung).
Diese Maschine hat Node 26, `.nvmrc` sagt 24, `engines` erlaubt beides — es wird gegen 26
getestet, was die CI nie tut.

## Welle 1 (drei Agenten parallel, disjunkte Dateien)

| # | Aufgabe | Ausschließlich diese Dateien |
|---|---|---|
| B1 | **#5 + #6**: `chart-logic.js` und `layout-logic.js` extrahieren, testen, NaN-Fehler beheben | `Smart Meter Dashboard/chart-logic.js` (neu), `layout-logic.js` (neu), `tests/chart-logic.test.js` (neu), `tests/layout-logic.test.js` (neu), `charts.jsx`, `tiles.jsx`, `Klima Dashboard.html`, `package.json` |
| B2 | #13 Reconciliation-SQL nach `event-reconcile.js` | `backend/event-reconcile.js` (neu), `backend/tests/event-reconcile.test.js` (neu), `backend/scheduler.js`, `backend/tests/scheduler.test.js` |
| B3 | #10 **alle sechs** Migrationsskripte entfernen (Nutzerentscheidung 2026-09-17) | die sechs `scripts/migrate-*.js`, `scripts/args.js`, `backend/tests/migrate-args.test.js`, `backend/tests/migrate-system-alarm-relabel.test.js` (alle gelöscht), `scripts/README.md`, `backend/device-bridge.js` (nur der Kommentarverweis in Zeile 134) |

**Welle 1 ist erledigt (2026-09-17).** Alle drei Agenten sind in ihrem Revier geblieben:
genau 22 berührte Pfade, exakt die zugewiesenen, `scheduler.test.js` unverändert.

| Agent | Ergebnis |
|---|---|
| B1 | Zwei rote Läufe beobachtet (`MODULE_NOT_FOUND`, dann `Linienpfad enthaelt NaN: MNaN 32.00`). Der Fix sitzt in `xPositions(count, x0, span)` — dem einen x-Erzeuger, durch den beide Diagramme laufen: `count > 1 ? i/(count-1) : 0.5`. Für `count >= 2` nachweislich identisch zu vorher. +39 Tests |
| B2 | Roter Lauf beobachtet (`MODULE_NOT_FOUND`). `EPISODE_PARTITION` steht jetzt **einmal** statt zweimal wortgleich; `scheduler.js` 6 Zeilen rein, 51 raus; `scheduler.test.js` **unverändert** grün. +6 Tests |
| B3 | 9 Dateien gelöscht, für jede einzeln belegt, dass kein Nutzer bleibt. `args.js` hatte genau sechs `require`-Stellen — die sechs Skripte |

**Testzahl-Protokoll Welle 1:** vorher 316 (200 + 116). Erwartet wurde **162 + neu**
(200 − 38 gelöschte). Tatsächlich: **168 Backend** (162 + 6) und **155 Dashboard**
(116 + 39), 0 Fehlschläge. Punktgenau — und damit greift der Riegel, der den unwirksamen
`--diff-filter=D`-Detektor ersetzt.

**Abweichung vom Vorbild, von B2 gemeldet und angenommen:** `event-reconcile.js` bekommt
`db` als Parameter, statt es sich wie `export-service.js` per `getDb()` zu holen. Das
direkte Vorbild steht in derselben Datei zwanzig Zeilen höher (`applySystemEvents(db, …)`),
der Aufrufer hält `db` ohnehin, und die Untersuchung unter B2(b) brauchte das Modul gegen
ein fremdes Handle.

**#5 und #6 gehören in einen Agenten**, obwohl es zwei Aufgaben sind: sie teilen sich
`Klima Dashboard.html` und `package.json`. Getrennt wären sie eine garantierte Kollision.
`app.jsx` braucht B1 **nicht** — nachgemessen: `app.jsx:173/176/192` ruft `compactLayout`
und `findFreeSlot` auf, aber der `window`-Export-Visitor von `dashboard-load.test.js:83-108`
erfasst Zuweisungen überall in der Datei, nicht nur auf Top-Level; die Extraktion lief in
einer Kopie 7/7 grün, ohne `app.jsx` anzufassen. Damit kollidieren B1 und B5 nicht.

**B1 behebt einen echten, erreichbaren Fehler** — aber **nicht dort, wo der Bericht ihn
verortet hat.** Reproduziert:

```
series.length === 1 →  xs = [NaN]
  buildPath      = "MNaN 32.00 "
  buildAreaPath  = "MNaN 35.00 LNaN 32.00 LNaN 35.00 Z"
```

Die `NaN` entsteht in den **xs-Erzeugern** `charts.jsx:72` (Sparkline) und `charts.jsx:118`
(LineChart), beide `i / (length - 1)` → `0/0`. `buildPath` formatiert nur, was es bekommt;
ein Guard dort verschweigt den Punkt, statt ihn zu setzen. `buildAreaPath` ist identisch
betroffen. Der Fix gehört in den Erzeuger: bei `length === 1` die Bildmitte statt `0/0`.
Erreichbar im Echtbetrieb: `data.js:218` fängt Länge **0** ab, Länge 1 nicht — das ist der
erste Sync nach der Installation oder eine Station, die nach über 24 h Offline zurückkommt.
Der Browser verwirft `d="MNaN …"` komplett: leeres Diagramm, nichts in der Konsole.

**B2 nimmt einen Folgebefund mit:** `migrate-system-alarm-relabel.js:81-83` ändert
`severity` **und** `alarm_condition_type` — **zwei** Spalten des Partitionsschlüssels
(`PARTITION BY station_id, COALESCE(serial_no,''), alarm_condition_type, severity,
COALESCE(metric,'')`, identisch in `scheduler.js:383` und `:407`). Das Skript rechnet nur
die `active`-Flags neu, die Episoden-`end_ts` nicht (`grep end_ts` findet dort nur
Kommentare).

**`backend/tests/migrate-args.test.js` gehört zu B2, nicht zu B3.** Der Test sammelt seine
Skripte per `readdirSync` (`:17-20`) und fährt auch `migrate-system-alarm-relabel.js` —
B2s Datei — inklusive eines vollen DB-Snapshot-Vergleichs (`:199-208`). Läge er bei B3,
änderten zwei gleichzeitig laufende Agenten dieselbe Prüfung.

**B3 braucht den Test nicht.** Die ursprüngliche Begründung („die erwarteten Zahlen im
Test ändern sich") war falsch — es gibt dort keine Zahlen. Gemessen: nach dem Löschen der
vier Skripte läuft er unverändert durch, 37 → 13 Tests, grün. Genau das ist der
unangenehmere Fall: 24 Prüfungen verschwinden geräuschlos. Der Orchestrator zieht nach der
Welle den einzigen veralteten Punkt nach — den Kommentar `migrate-args.test.js:110`
(„keines der **sechs** Skripte") — und den toten Verweis in `backend/device-bridge.js:134`
auf ein gelöschtes Skript.

`scripts/README.md` behält fest, was die gelöschten Skripte repariert haben; die Skripte
selbst bleiben über die Git-Historie erreichbar.

## Welle 2 (drei Agenten parallel, disjunkte Dateien)

| # | Aufgabe | Ausschließlich diese Dateien |
|---|---|---|
| B4 | #7 `csv_format` dauerhaft speicherbar | `Smart Meter Dashboard/export-panel.jsx`, `Smart Meter Dashboard/export-logic.js`, `Smart Meter Dashboard/tests/export-logic.test.js`, `backend/tests/server.test.js` |
| B5 | #11 Fehlgeschlagenen Layout-Speichervorgang melden | `Smart Meter Dashboard/status-logic.js`, `Smart Meter Dashboard/tests/status-logic.test.js`, `Smart Meter Dashboard/app.jsx` |
| B6 | #12 Aufräumen: tote Exports, `pad2`, Autosave | `backend/backup-runner.js`, `backend/export-service.js`, `backend/csv-format.js`, `backend/tests/csv-format.test.js`, `backend/tests/backup-runner.test.js`, `backend/tests/export-service.test.js`, `Smart Meter Dashboard/partial-failure-logic.js`, `Smart Meter Dashboard/settings.jsx` |

**B4 braucht `export-logic.js`**, weil `tests/export-logic.test.js:3` seinen Prüfling von
dort zieht. Der Dialekt-Zustand liegt heute in `export-panel.jsx:13/30/122-124` — eine
`.jsx`, die kein Node-Test `require`n kann. Ohne die Quelldatei kann B4 den geforderten
roten Test gar nicht schreiben. Das Backend ist bereits fertig (`server.js:84,123-126`,
`db.js:130`, geprüft in `server.test.js:681-697`); es fehlt nur der Schreibweg aus der
Oberfläche.

**B5 nutzt einen bestehenden Mechanismus**, keinen neuen: das Banner-Muster aus
`header.jsx`. Die Entscheidung „melden ja/nein" wandert als reine Funktion nach
`status-logic.js` und wird dort getestet — `app.jsx` selbst bleibt ungetestet.

**B6 braucht `backend/tests/export-service.test.js`.** Nachgemessen: die drei toten Exports
(`safeFileName`, `queryMeasurements`, `queryEvents` in `export-service.js:96`) sind der
einzige Grund, warum diese Testdatei noch läuft — ohne sie endet Welle 2 mit
`TypeError: svc.safeFileName is not a function` in `export-service.test.js:23`.

**B6 Teil (c)** — Autosave auf `DASH_DATA.saveSettings()` umstellen — hat keinen
automatisierbaren Test. Deshalb ist der Beleg der **Liefergegenstand**, nicht die
Vorbedingung: der Agent zitiert im Bericht den handgebauten Autosave
(`settings.jsx:155-195`) und `data.js:497 saveSettings` nebeneinander für Fehlerbehandlung,
Kopfzeilen, Rückgabewert und Abbruchverhalten. Ohne dieses Zitat nimmt der Orchestrator (c)
nicht an. Weicht die Semantik ab, ist es kein Aufräumen — dann meldet der Agent das und
lässt (c) liegen.

**#9 hat keinen Agenten** und wird ein **nummerierter §9-Abnahmepunkt**, kein Fließtext —
sonst gibt es nichts, woran die verschobene Windows-Abnahme scheitern könnte. Empfehlung,
die dort festgehalten wird: **dokumentieren, keine automatische Obergrenze einbauen.** An
Klimadaten kann eine Aufbewahrungspflicht hängen, die länger läuft als jedes
Plausibilitätsfenster — ein Automatismus, der Archivdateien löscht, ist das gefährlichere
Verhalten.

## Welle 3 (ein Agent allein)

| # | Aufgabe | Ausschließlich diese Dateien |
|---|---|---|
| B7 | #14 `Klima Dashboard.html` und `settings.jsx` aufteilen | `Smart Meter Dashboard/Klima Dashboard.html`, `dashboard.css` (neu), `settings.jsx`, `settings-stations.jsx` (neu), `tests/dashboard-load.test.js` |

Allein, weil `Klima Dashboard.html` mit fast allem kollidiert.

**Die CSS-Frage ist beantwortet, und die Antwort ist eine Aufgabe:** eine `.css` ist für
`dashboard-load.test.js` in **beiden** Prüfungen unsichtbar. Der Verzeichnis-Test filtert
auf `.js`/`.jsx` (`:215`), und `appTags()` (`:151`) liest nur `<script>`-Tags, also sieht
auch die `?v=`-Prüfung (`:201-209`) einen `<link>` nie. Gemessen: `dashboard.css` ohne
`<link>` → 7/7 grün; `<link>` ohne `?v=` → 7/7 grün; Gegenprobe mit einer `.js` ohne Tag →
rot. B7 baut sonst genau die Stale-Asset-Falle ein, die in diesem Projekt schon einmal als
„fehlendes Feature" erschienen ist. **Also: `.css` in den Filter `:215` aufnehmen und
`<link href>` in `appTags()`.**

Zweite Frage, die der Agent **vor** dem ersten Edit beantworten und melden muss: welcher
Zustand in `settings.jsx` geht über die Sektionsgrenzen? Der Schnitt darf ihn nicht
zerreißen.

## Abschluss

1. Volle Testsuite ohne Sandbox, Testzahl gegen die Baseline vor Welle 1 prüfen.
2. Bump auf **0.17.0**: `VERSION`, `package.json`, README-Badge, alle `?v=` **und
   `deploy/windows/README.md`** (die `appVersion`-Zeile — seit A1 hält ein Test sie fest).
3. Tag, CI baut das Bundle.
4. §9-Abnahme auf Windows — für **beide** Releases, 0.16.1 und 0.17.0, in einem Durchgang.

## Was die Vertiefung zusätzlich ergab

| Befund | Fundstelle | Wo behandelt |
|---|---|---|
| `npm ci --omit=dev` ohne `--ignore-scripts` in der Ablaufbeschreibung | `deploy/windows/README.md:68` | A2 |
| §9-Update-Probe ist bei VERSION 0.16.0 nicht bestehbar | `deploy/windows/README.md:333-339` | A2 |
| „Alle 14 Script-Tags" verrottet, sobald B1/B7 Dateien anlegen (→ 17) | `deploy/windows/README.md:329` | A2 |
| `package.json.version` und `VERSION` werden nirgends gegeneinander geprüft | — | A1 |
| Echter NaN-Fehler bei Reihenlänge 1, in den xs-Erzeugern (nicht in `buildPath`), `buildAreaPath` ebenso betroffen | `Smart Meter Dashboard/charts.jsx:72`, `:118` | B1 |
| Relabel-Skript ändert **zwei** Partitionsspalten, rechnet aber nur `active` neu, nicht `end_ts` | `scripts/migrate-system-alarm-relabel.js:81-83` | B2 |
| `.css` ist für `dashboard-load.test.js` vollständig unsichtbar | `tests/dashboard-load.test.js:151`, `:215` | B7 |
| Toter Kommentarverweis auf ein von B3 gelöschtes Skript | `backend/device-bridge.js:134` | Orchestrator nach Welle 1 |
| Diese Maschine läuft auf Node 26, `.nvmrc` sagt 24 (`engines` erlaubt beides) | `.nvmrc`, `package.json:11` | A3, nur Hinweis |

## Offene Punkte

- **NEU (2026-09-17, beim Ausführen von Block A gefunden): das Bundle trägt jetzt sieben
  fremde Plattform-Binaries.** better-sqlite3 13 liefert alle acht Prebuilds im Tarball
  aus (zusammen 16 MB), 12.x baute nur eines. Die CI kopiert `node_modules` unverändert
  in die ZIP — das Windows-Bundle wuchs dadurch von 42,0 MB (0.16.0) auf 49,5 MB (0.16.1)
  und enthält `.node`-Binaries für macOS, Linux, Linux-musl und Windows-ARM, die dort nie
  laufen. Das berührt die CLAUDE.md-Regel „keine neuen gebündelten Binaries" für die
  EDR-Freigabe. **ERLEDIGT am 2026-09-17** (Commit `25ce16b`, auf Wunsch des Nutzers sofort
  statt zum 0.17.0): neuer Schritt „Prune foreign-platform prebuilds" in
  `.github/workflows/windows-bundle.yml`, zwischen dem bestehenden Prebuild-Guard und dem
  Bundling — damit testet der E2E-Smoke die ausgedünnte Fassung. Der Schritt wirft, wenn
  nicht genau `win32-x64.node` übrig bleibt, und prüft danach selbst `require()`.
  Auf dem Branch per `workflow_dispatch` verifiziert (Lauf `35204775642`, grün):
  Artefakt **49.367.576 B → 41.695.222 B**, Schrittausgabe `prebuilds: 1 statt 8,
  14.2 MB entfernt`, `prebuild laedt auch nach dem Ausduennen`.
  **Wirkt erst ab dem nächsten Tag** — das Release-Asset von v0.16.1 trägt noch alle acht.
- **§9-Abnahme auf Windows** steht aus — für 0.16.1 und 0.17.0. Bis dahin liegt ein
  Release-Asset auf GitHub, das niemand auf Windows angefasst hat. Bewusste Entscheidung
  des Nutzers vom 2026-09-17.
- ~~**Die beiden verbleibenden Migrationsskripte.**~~ **Entschieden 2026-09-17: alle sechs
  weg**, samt `args.js` und den beiden zugehörigen Testdateien. In Welle 1 erledigt.

- **NEU (aus Welle 1, B1): `charts.jsx:xTicks` hat dieselbe `0/0`-Falle.** Rund um Zeile 110
  rechnet `(t - first) / (last - first)`; bei genau einem Zeitstempel ist `last === first`.
  Liegt der exakt auf einer vollen Stunde, entsteht ein Gitterstrich und eine
  Achsenbeschriftung mit `NaN`. Folge ist milder als der behobene Fall — der Browser
  verwirft nur diesen einen Tick, das Diagramm bleibt sichtbar. B1 hat es korrekt liegen
  gelassen, weil der Auftrag den Fix auf die xs-Erzeuger festlegte. Dieselbe Ursache,
  eigene Aufgabe.

- **NEU (aus Welle 1, B2): Das gelöschte Relabel-Skript hat falsche `end_ts` hinterlassen —
  die sich selbst reparieren.** An einer Wegwerf-DB mit echtem `--apply` nachgespielt: drei
  von vier Episoden bekamen ein falsches oder fehlendes `end_ts`, darunter eine geschlossene
  Episode ohne Ende (`active` 1→0, `end_ts` NULL). Die Abweichung geht **nur** in eine
  Richtung (zu spät oder NULL, nie zu früh), weil Partitionen beim Relabel nur verschmelzen
  und nie Mitglieder verlieren können. **Kein Handlungsbedarf:** das `end_ts`-Statement ist
  nicht inkrementell — es rechnet jeden Zyklus über alle Feed-Zeilen und überschreibt auch
  auf NULL zurück. Seit der Migration hat sich die Tabelle bei jedem erfolgreichen Zyklus
  selbst korrigiert. Wer Gewissheit will, fragt die Kunden-DB einmal ab:
  `active = 0 AND end_ts IS NULL AND alarm_status IS NOT NULL` — null Treffer heißt durch.
  Die Eigenschaft steht jetzt in `CLAUDE.md`, damit sie ein künftiger „Performance"-Umbau
  auf inkrementelles Rechnen nicht still entfernt.

- **NEU (aus Welle 1, B2): Der Monats-Backup läuft außerhalb des Alarm-`try`.** Damit ist es
  der einzige Weg, auf dem eine falsche Dauer **dauerhaft** wird: die Reconciliation sitzt
  innerhalb des `try`, das mit `await client.fetchAlarms(...)` beginnt, `maybeRunBackupScan`
  davor bzw. daneben. Eine ZIP, die in einem Zyklus mit gescheitertem Alarm-Abruf entsteht,
  friert `end_ts` ein — eine CSV wird nie nachgerechnet. Dass ein Backup-Ausfall den Sync
  nicht rot färben soll, ist Absicht; ob das die eingefrorene Dauer aufwiegt, ist eine
  eigene Entscheidung. Kein Blocker.
- **`README.md:38`** nennt im Quick start blankes `npm install`. Für `npm ci` ist belegt,
  dass npm daraus trotz `"gypfile": false` ein `node-gyp rebuild` synthetisiert; ob
  `npm install` bei 13.x denselben Pfad nimmt, ist **nicht** belegt. In A3 mitprüfen.
