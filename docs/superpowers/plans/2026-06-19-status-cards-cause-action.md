# Angereicherte Statuskarten (Ursache + Aktion) — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jede Karte der Systemübersicht mit Status ≠ ok zeigt klares Verdikt, Ursache in Klartext und nächste Aktion — der Widerspruch „Schlüssel Aktiv" unter rotem „Fehler" verschwindet.

**Architecture:** Reine Übersetzungslogik (`explainSyncError`) in neuem `status-logic.js` (dual-environment, unit-getestet). `HealthCard` bekommt optionale `cause/causeRaw/actions`-Props. `OverviewSection` baut pro Karte Verdikt/Ursache/Aktionen und reicht `onNavigate`/`onRefresh` durch. Backend bekommt einen `POST /api/sync`-Endpunkt für den Resync-Button.

**Tech Stack:** Node/Express/SQLite (better-sqlite3), React 18 via Babel-Standalone (kein Build-Step), Tests via `node:test` / `npm test`.

## Global Constraints

- Reine Logik liegt in `*-logic.js` mit dual-environment Export (`module.exports` + `window.<fn>`), unit-getestet via `node:test` — Muster exakt wie `summary-logic.js`.
- Tests laufen über `npm test`. Neue Frontend-Logik-Tests müssen ins Test-Script in `package.json` aufgenommen werden.
- Version: MINOR-Bump **0.5.0 → 0.6.0** synchron in `package.json` (autoritativ), `VERSION`, README-Badge und **allen** `?v=`-Query-Strings in `Smart Meter Dashboard/Klima Dashboard.html`. Lokales annotiertes Tag `v0.6.0`. **Kein Remote konfiguriert → kein Push.**
- React-Hooks (`sState` etc.) müssen in jeder Komponente VOR jedem early `return` aufgerufen werden (dokumentierte Projektfalle).
- Niemals Werte erfinden: `D.stations[id].lastSeen` fällt auf `Date.now()` zurück, wenn `last_communication` fehlt → **keine** „offline seit X"-Dauer anzeigen, nur Stationsname(n).
- Deutsche UI-Strings, Satz-Schreibweise, Ton wie im Bestand.
- **Keine neue `.jsx`-Datei** (vermeidet Hook-Alias-Kollision) — Änderungen gehen in bestehende `settings.jsx` + neues reines `status-logic.js`.
- Backend-Statusroute: `GET /api/system/status`; neue Route `POST /api/sync`.

## File Structure

- Create `Smart Meter Dashboard/status-logic.js` — pure `explainSyncError(raw)`, dual export.
- Create `Smart Meter Dashboard/tests/status-logic.test.js` — Unit-Tests.
- Modify `Smart Meter Dashboard/Klima Dashboard.html` — `<script>`-Tag für status-logic.js; neues CSS (`.hc-cause`, `.hc-cause-raw`, `.hc-actions`); `?v=`-Bump (im Release).
- Modify `Smart Meter Dashboard/settings.jsx` — `HealthCard`-Props; `OverviewSection`-Anreicherung + Resync; `SettingsPage` reicht `onNavigate`/`onRefresh` durch.
- Modify `backend/server.js` — `POST /api/sync`.
- Modify `backend/tests/server.test.js` — Test für `POST /api/sync`.
- Modify `package.json` — Test-Script (Task 1) + Versionsfeld (Task 5).
- Modify `VERSION`, `README.md` — Version (Task 5).

---

### Task 1: Ursachen-Übersetzung `explainSyncError`

**Files:**
- Create: `Smart Meter Dashboard/status-logic.js`
- Test: `Smart Meter Dashboard/tests/status-logic.test.js`
- Modify: `package.json:8` (Test-Script)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html:1193` (Script-Tag)

**Interfaces:**
- Produces: `explainSyncError(raw: string|null) -> { plain: string, showRaw: boolean }`. Im Browser als `window.explainSyncError`, in Node als `require('../status-logic').explainSyncError`.

- [ ] **Step 1: Failing test schreiben**

Create `Smart Meter Dashboard/tests/status-logic.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { explainSyncError } = require('../status-logic');

test('explainSyncError: fehlender API-Schlüssel', () => {
  const r = explainSyncError('No API Key configured');
  assert.strictEqual(r.plain, 'Kein API-Schlüssel hinterlegt.');
  assert.strictEqual(r.showRaw, false);
});

test('explainSyncError: 401 / invalid_token', () => {
  assert.strictEqual(explainSyncError('Request failed: 401 Unauthorized').plain, 'Zugangsschlüssel wurde abgelehnt.');
  assert.strictEqual(explainSyncError('invalid_token').plain, 'Zugangsschlüssel wurde abgelehnt.');
});

test('explainSyncError: 403 forbidden', () => {
  assert.strictEqual(explainSyncError('403 Forbidden').plain, 'Zugriff verweigert — Berechtigung prüfen.');
});

test('explainSyncError: Netzwerkfehler', () => {
  assert.strictEqual(explainSyncError('fetch failed').plain, 'Keine Verbindung zur testo-Cloud.');
  assert.strictEqual(explainSyncError('connect ECONNREFUSED 1.2.3.4:443').plain, 'Keine Verbindung zur testo-Cloud.');
});

test('explainSyncError: Timeout', () => {
  assert.strictEqual(explainSyncError('ETIMEDOUT').plain, 'Zeitüberschreitung bei der Anfrage.');
});

test('explainSyncError: Rate-Limit', () => {
  assert.strictEqual(explainSyncError('429 Too Many Requests').plain, 'Zu viele Anfragen (Rate-Limit erreicht).');
});

test('explainSyncError: Serverfehler', () => {
  assert.strictEqual(explainSyncError('500 Internal Server Error').plain, 'testo-Cloud meldet einen Serverfehler.');
});

test('explainSyncError: unbekannt -> Default mit Rohtext', () => {
  const r = explainSyncError('something weird happened');
  assert.strictEqual(r.plain, 'Synchronisation fehlgeschlagen.');
  assert.strictEqual(r.showRaw, true);
});

test('explainSyncError: null/leer -> Default ohne Rohtext', () => {
  assert.strictEqual(explainSyncError(null).plain, 'Synchronisation fehlgeschlagen.');
  assert.strictEqual(explainSyncError(null).showRaw, false);
  assert.strictEqual(explainSyncError('').showRaw, false);
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag verifizieren**

Run: `NODE_ENV=test node --test "Smart Meter Dashboard/tests/status-logic.test.js"`
Expected: FAIL — `Cannot find module '../status-logic'`.

- [ ] **Step 3: Minimale Implementierung**

Create `Smart Meter Dashboard/status-logic.js`:

```js
// Pure, side-effect-free Übersetzung roher Sync-Fehler in Klartext.
// Browser: als <script> vor settings.jsx geladen, hängt an window.
// Node: per require() in Tests genutzt. Kein DOM / fetch / timer / Date.
(function () {
  // Übersetzt scheduler.lastSyncError in eine verständliche Erklärung.
  // Reihenfolge: spezifischste Treffer zuerst.
  // Rückgabe: { plain: Klartext, showRaw: ob die Rohmeldung zusätzlich angezeigt werden soll }
  function explainSyncError(raw) {
    const s = raw == null ? '' : String(raw);
    const l = s.toLowerCase();
    if (/no api key/.test(l)) return { plain: 'Kein API-Schlüssel hinterlegt.', showRaw: false };
    if (/\b401\b|unauthorized|invalid_token/.test(l)) return { plain: 'Zugangsschlüssel wurde abgelehnt.', showRaw: true };
    if (/\b403\b|forbidden/.test(l)) return { plain: 'Zugriff verweigert — Berechtigung prüfen.', showRaw: true };
    if (/fetch failed|enotfound|econnrefused|econnreset|network/.test(l)) return { plain: 'Keine Verbindung zur testo-Cloud.', showRaw: true };
    if (/timeout|etimedout/.test(l)) return { plain: 'Zeitüberschreitung bei der Anfrage.', showRaw: true };
    if (/\b429\b|rate limit|too many requests/.test(l)) return { plain: 'Zu viele Anfragen (Rate-Limit erreicht).', showRaw: true };
    if (/\b5\d\d\b|server error|internal server/.test(l)) return { plain: 'testo-Cloud meldet einen Serverfehler.', showRaw: true };
    return { plain: 'Synchronisation fehlgeschlagen.', showRaw: s.length > 0 };
  }

  const api = { explainSyncError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.explainSyncError = explainSyncError; }
})();
```

- [ ] **Step 4: Test ausführen, grün verifizieren**

Run: `NODE_ENV=test node --test "Smart Meter Dashboard/tests/status-logic.test.js"`
Expected: PASS — alle Tests bestanden, 0 Fehler.

- [ ] **Step 5: In `npm test` und HTML einhängen**

Modify `package.json:8` — das Frontend-Test-Listing um die neue Datei ergänzen. Die Zeile lautet danach:

```json
    "test": "NODE_ENV=test node --test backend/tests/*.test.js && NODE_ENV=test node --test \"Smart Meter Dashboard/tests/metrics-logic.test.js\" \"Smart Meter Dashboard/tests/summary-logic.test.js\" \"Smart Meter Dashboard/tests/status-logic.test.js\""
```

Modify `Smart Meter Dashboard/Klima Dashboard.html` — nach Zeile 1193 (`summary-logic.js`) eine Zeile einfügen:

```html
<script src="status-logic.js?v=0.5.0"></script>
```

(`?v=` wird im Release-Task 5 zusammen mit allen anderen auf `0.6.0` gehoben.)

- [ ] **Step 6: Voller Testlauf**

Run: `npm test`
Expected: PASS — alle Suites grün, 0 Fehler.

- [ ] **Step 7: Commit**

```bash
git add "Smart Meter Dashboard/status-logic.js" "Smart Meter Dashboard/tests/status-logic.test.js" package.json "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): add explainSyncError sync-error translation helper"
```

---

### Task 2: Backend-Endpunkt `POST /api/sync`

**Files:**
- Modify: `backend/server.js` (nach der Statusroute, ~Zeile 358)
- Test: `backend/tests/server.test.js` (neuer Test ans Ende, vor evtl. `after()`-Teardown)

**Interfaces:**
- Consumes: `getSchedulerStatus()` und `runSyncCycle()` aus `./scheduler` (bereits in `server.js:6` importiert).
- Produces: Route `POST /api/sync` → `202 { started: true }`, oder `200 { started: false, reason: 'already-running' }`, wenn bereits ein Sync läuft.

- [ ] **Step 1: Failing test schreiben**

In `backend/tests/server.test.js` nach dem letzten `test(...)`-Block einfügen (mock-Key wird aus früheren Tests bereits gesetzt sein, hier defensiv erneut):

```js
test('POST /api/sync stößt einen Sync an und meldet started', async () => {
  saveSetting('api_key', 'mock-api-key');
  saveSetting('api_region', 'eu');
  const res = await fetch('http://localhost:3001/api/sync', { method: 'POST' });
  assert.ok(res.status === 202 || res.status === 200);
  const body = await res.json();
  assert.ok(body.hasOwnProperty('started'));
  assert.strictEqual(typeof body.started, 'boolean');
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag verifizieren**

Run: `NODE_ENV=test node --test backend/tests/server.test.js`
Expected: FAIL — die neue Route fehlt (404 → `res.status` ist 404, Assertion schlägt fehl).

- [ ] **Step 3: Minimale Implementierung**

In `backend/server.js` direkt nach dem Block der `GET /api/system/status`-Route (vor dem test-only `/api/_test/throw`-Block, ~Zeile 358) einfügen:

```js
// POST /api/sync — stößt sofort einen Sync-Zyklus an (Resync-Button der Systemübersicht).
// No-op, wenn bereits ein Sync läuft — runSyncCycle() ist zusätzlich selbst idempotent.
app.post('/api/sync', (req, res) => {
  if (getSchedulerStatus().isSyncing) {
    return res.json({ started: false, reason: 'already-running' });
  }
  runSyncCycle().catch(console.error);
  res.status(202).json({ started: true });
});
```

- [ ] **Step 4: Test ausführen, grün verifizieren**

Run: `NODE_ENV=test node --test backend/tests/server.test.js`
Expected: PASS — alle Server-Tests grün.

- [ ] **Step 5: Commit**

```bash
git add backend/server.js backend/tests/server.test.js
git commit -m "feat(backend): add POST /api/sync to trigger a manual sync cycle"
```

---

### Task 3: `HealthCard` um Ursache + Aktionen erweitern (+ CSS)

**Files:**
- Modify: `Smart Meter Dashboard/settings.jsx:895-910` (`HealthCard`)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (CSS nach `.hc-sub`, ~Zeile 1045)

**Interfaces:**
- Produces: `HealthCard` akzeptiert zusätzlich optionale Props `cause: string`, `causeRaw: string`, `actions: Array<{label, onClick, primary?, disabled?}>`. Werden nur gerendert, wenn vorhanden. Bestehende Aufrufe (nur `status/label/value/sub/icon/progress`) bleiben unverändert funktionsfähig.

- [ ] **Step 1: `HealthCard` ersetzen**

In `Smart Meter Dashboard/settings.jsx` die Funktion `HealthCard` (Zeilen 895–910) ersetzen durch:

```jsx
function HealthCard({ status, label, value, sub, icon, progress, cause, causeRaw, actions }) {
  return (
    <div className={`health-card st-${status}`}>
      <div className="hc-top">
        <span className="hc-icon"><NavIcon id={icon} /></span>
        <StatusBadge status={status} label={status === "ok" ? "OK" : status === "warn" ? "Achtung" : "Fehler"} />
      </div>
      <div className="hc-value">{value}</div>
      <div className="hc-label">{label}</div>
      {progress != null && (
        <div className="hc-progress"><span style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
      )}
      <div className="hc-sub">{sub}</div>
      {cause && (
        <div className="hc-cause">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>{cause}</span>
        </div>
      )}
      {causeRaw && <div className="hc-cause-raw">{causeRaw}</div>}
      {actions && actions.length > 0 && (
        <div className="hc-actions">
          {actions.map((a, i) => (
            <button key={i} className={`btn ${a.primary ? "primary" : ""}`} disabled={a.disabled} onClick={a.onClick}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: CSS ergänzen**

In `Smart Meter Dashboard/Klima Dashboard.html` direkt nach der `.hc-sub`-Regel (Zeile 1045) einfügen:

```css
  .hc-cause { display: flex; gap: 6px; align-items: flex-start; margin-top: 10px; font-size: 12px; color: var(--text-muted); line-height: 1.45; }
  .hc-cause svg { flex: none; margin-top: 1px; color: var(--text-muted); }
  .health-card.st-warn .hc-cause svg { color: var(--warn); }
  .health-card.st-err  .hc-cause svg { color: var(--alarm); }
  .hc-cause-raw { margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-faint); word-break: break-word; }
  .hc-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
  .hc-actions .btn { font-size: 11.5px; padding: 5px 10px; }
```

- [ ] **Step 3: Regressionscheck (keine JSX-Unit-Tests vorhanden)**

Run: `npm test`
Expected: PASS — unverändert grün (HealthCard-Rendering wird visuell in Task 5 verifiziert).

- [ ] **Step 4: Commit**

```bash
git add "Smart Meter Dashboard/settings.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(dashboard): HealthCard supports cause + action rows"
```

---

### Task 4: `OverviewSection` + `SettingsPage` verdrahten

**Files:**
- Modify: `Smart Meter Dashboard/settings.jsx:47-54` (`SettingsPage` — body-level `loadStatus`)
- Modify: `Smart Meter Dashboard/settings.jsx:116-128` (Mount-Effekt nutzt body-level `loadStatus`)
- Modify: `Smart Meter Dashboard/settings.jsx:214` (`OverviewSection`-Aufruf mit `onNavigate`/`onRefresh`)
- Modify: `Smart Meter Dashboard/settings.jsx:256-336` (`OverviewSection` — Verdikt/Ursache/Aktionen)

**Interfaces:**
- Consumes: `window.explainSyncError` (Task 1); `HealthCard`-Props `cause/causeRaw/actions` (Task 3); `POST /api/sync` (Task 2); `setSection` (vorhanden, `settings.jsx:48`).
- Produces: `OverviewSection({ settings, systemStatus, onNavigate, onRefresh })`.

- [ ] **Step 1: `loadStatus` in den Komponenten-Body heben (DRY)**

In `SettingsPage` direkt nach `const [, forceTick] = sState(0);` (Zeile 54) einfügen:

```jsx
  // Lädt die Systemdiagnose neu; im Mount-Effekt und als onRefresh für die Übersicht genutzt.
  const loadStatus = () => {
    fetch('/api/system/status')
      .then(res => res.json())
      .then(data => setSystemStatus(data))
      .catch(err => console.error('Failed to load system diagnostics:', err));
  };
```

Im Mount-Effekt (Zeilen 116–123) die **lokale** `const loadStatus = () => {...};`-Definition entfernen, sodass nur noch die Aufrufe stehen bleiben:

```jsx
    loadStatus();
    const intervalId = setInterval(loadStatus, 10000);
    return () => clearInterval(intervalId);
```

- [ ] **Step 2: `OverviewSection`-Aufruf erweitern**

`settings.jsx:214` ersetzen durch:

```jsx
  if (section === "overview")      body = <OverviewSection settings={settings} systemStatus={systemStatus} onNavigate={setSection} onRefresh={loadStatus} />;
```

- [ ] **Step 3: `OverviewSection` umbauen**

Signatur (Zeile 256) ändern zu `function OverviewSection({ settings, systemStatus, onNavigate, onRefresh }) {` und als **allererste Zeile** der Funktion (VOR dem `if (!systemStatus)`-early-return — Hook-Order-Regel!) den Resync-State einfügen:

```jsx
function OverviewSection({ settings, systemStatus, onNavigate, onRefresh }) {
  const [resyncing, setResyncing] = sState(false);
  const D = window.DASH_DATA;
  const stationsOnline = D.stationOrder.filter((id) => D.stations[id].online).length;
  const stationsTotal  = D.stationOrder.length;
```

Den bestehenden `if (!systemStatus) { ... }`-Block (Zeilen 261–270) unverändert lassen.

Nach `const { database, scheduler, storage, api } = systemStatus;` (Zeile 272) den Resync-Handler und die Pro-Karte-Anreicherung einfügen (ersetzt die bisherigen Format-Blöcke der Zeilen 274–287):

```jsx
  const { database, scheduler, storage, api } = systemStatus;

  // Resync-Button → POST /api/sync, danach Diagnose neu laden.
  const handleResync = () => {
    setResyncing(true);
    fetch('/api/sync', { method: 'POST' })
      .then(res => res.json())
      .then(() => { if (onRefresh) onRefresh(); })
      .catch(err => console.error('Resync failed:', err))
      .finally(() => setResyncing(false));
  };

  // --- Testo Connect API ---
  const apiStatus = api.status;
  const apiSub = `Region: ${api.region.toUpperCase()} · Letzter Sync: ${scheduler.lastSyncStatus === 'success' ? 'Erfolgreich' : scheduler.lastSyncStatus === 'skipped' ? 'Übersprungen' : scheduler.lastSyncStatus === 'error' ? 'Fehler' : 'Nie'}`;
  let apiValue = api.apiKeyConfigured ? "Schlüssel Aktiv" : "Nicht Konfiguriert";
  let apiCause = null, apiCauseRaw = null, apiActions = null;
  if (apiStatus === 'err') {
    apiValue = 'Sync fehlgeschlagen';
    const ex = window.explainSyncError(scheduler.lastSyncError);
    apiCause = ex.plain;
    apiCauseRaw = ex.showRaw ? scheduler.lastSyncError : null;
    apiActions = [
      { label: resyncing ? 'Synchronisiert…' : 'Erneut synchronisieren', onClick: handleResync, primary: true, disabled: resyncing },
      { label: 'API-Schlüssel prüfen →', onClick: () => onNavigate('api') },
    ];
  } else if (apiStatus === 'warn') {
    apiValue = 'Kein API-Schlüssel';
    apiCause = 'Kein API-Schlüssel hinterlegt.';
    apiActions = [{ label: 'API-Schlüssel hinterlegen →', onClick: () => onNavigate('api'), primary: true }];
  }

  // --- Lokale Datenbank (immer ok) ---
  const dbStatus = database.status;
  const dbValue = database.engine;
  const dbSub = `${database.rowCount.toLocaleString("de-DE")} Datensätze · Größe: ${formatBytes(database.sizeBytes)}`;

  // --- Hintergrund-Scheduler ---
  const schedulerStatus = scheduler.isActive ? "ok" : "warn";
  let schedulerValue = scheduler.isActive ? `Intervall: ${Math.round(scheduler.pollIntervalSec / 60)} Min.` : "Deaktiviert";
  const schedulerSub = `Zustand: ${scheduler.isSyncing ? "Synchronisiert..." : "Wartend"} · Letzter Sync: ${scheduler.lastSyncTime ? D.formatRelative(scheduler.lastSyncTime) : 'Nie'}`;
  let schedulerCause = null, schedulerActions = null;
  if (!scheduler.isActive) {
    schedulerValue = 'Synchronisation aus';
    schedulerCause = 'Automatische Synchronisation ist ausgeschaltet.';
    schedulerActions = [{ label: 'Synchronisation einrichten →', onClick: () => onNavigate('api'), primary: true }];
  }

  // --- Messstellen ---
  const offlineIds = D.stationOrder.filter((id) => !D.stations[id].online);
  const stationsStatus = offlineIds.length === 0 ? "ok" : "warn";
  let stationsValue = `${stationsOnline}/${stationsTotal} online`;
  let stationsCause = null, stationsActions = null;
  if (offlineIds.length > 0) {
    stationsValue = `${offlineIds.length} offline`;
    const names = offlineIds.map((id) => `„${D.stations[id].name}"`).join(', ');
    stationsCause = offlineIds.length === 1 ? `${names} meldet sich nicht.` : `${names} melden sich nicht.`;
    stationsActions = [{ label: 'Messstellen öffnen →', onClick: () => onNavigate('stations'), primary: true }];
  }

  // --- Speicherbelegung ---
  let storageValue = `${storage.usedGb} / ${storage.totalGb} GB`;
  let storageCause = null, storageActions = null;
  if (storage.status === 'warn') {
    storageValue = 'Speicher fast voll';
    storageCause = 'Weniger als 1 GB frei.';
    storageActions = [{ label: 'Aufbewahrung anpassen →', onClick: () => onNavigate('database'), primary: true }];
  }
```

Anschließend im `return`-JSX (Zeilen 289–336) die sechs `HealthCard`-Aufrufe so anpassen, dass sie die neuen Variablen + `cause/causeRaw/actions` nutzen:

```jsx
      <div className="health-grid">
        <HealthCard
          status={apiStatus}
          label="Testo Connect API"
          value={apiValue}
          sub={apiSub}
          icon="plug"
          cause={apiCause}
          causeRaw={apiCauseRaw}
          actions={apiActions}
        />
        <HealthCard
          status={dbStatus}
          label="Lokale Datenbank"
          value={dbValue}
          sub={dbSub}
          icon="db"
        />
        <HealthCard
          status={schedulerStatus}
          label="Hintergrund-Scheduler"
          value={schedulerValue}
          sub={schedulerSub}
          icon="bolt"
          cause={schedulerCause}
          actions={schedulerActions}
        />
        <HealthCard
          status={stationsStatus}
          label="Messstellen"
          value={stationsValue}
          sub={D.stationOrder.map((id) => D.stations[id].name).join(" · ")}
          icon="node"
          cause={stationsCause}
          actions={stationsActions}
        />
        <HealthCard
          status={storage.status}
          label="Speicherbelegung (Drive)"
          value={storageValue}
          sub={`${Math.round((storage.usedGb / storage.totalGb) * 100)} % belegt · Pfad: ../klima.db`}
          icon="disk"
          progress={storage.usedGb / storage.totalGb}
          cause={storageCause}
          actions={storageActions}
        />
        <HealthCard
          status="ok"
          label="Letzter Sync & Aufbewahrung"
          value={`${settings.database.retentionDays} Tage`}
          sub={`Ältester Messwert: ${database.oldestRecord ? new Date(database.oldestRecord).toLocaleDateString("de-DE") : 'Keine Daten'}`}
          icon="archive"
        />
      </div>
```

Hinweis: Die frühere Variable `stationsOnline === stationsTotal ? "ok" : "warn"` wird durch `stationsStatus` (auf Basis `offlineIds`) ersetzt — identisches Verhalten, aber wir brauchen die Offline-Liste ohnehin für die Ursache.

- [ ] **Step 4: Regressionscheck**

Run: `npm test`
Expected: PASS — unverändert grün (Verhalten wird visuell in Task 5 verifiziert).

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/settings.jsx"
git commit -m "feat(dashboard): enrich overview status cards with cause + actions"
```

---

### Task 5: Release 0.6.0 — Version, Verifikation, Integration

**Files:**
- Modify: `package.json:3`, `VERSION`, `README.md:3`
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (alle `?v=0.5.0` → `?v=0.6.0`)

**Interfaces:** keine (Release-/Verifikationsschritt).

- [ ] **Step 1: Live-Verifikation der Warn-Pfade**

Dev-Server starten (Preview-Tools, nicht Bash): Dashboard öffnen → Einstellungen → Übersicht.
- **Kein API-Schlüssel** (frische DB / Schlüssel entfernt): API-Karte zeigt „Kein API-Schlüssel" (Badge „Achtung"), Ursache „Kein API-Schlüssel hinterlegt.", Aktion „API-Schlüssel hinterlegen →". Klick springt zu „API & Verbindung".
- **Eine Station offline**: Messstellen-Karte zeigt „1 offline", Ursache nennt den Stationsnamen, Aktion „Messstellen öffnen →".
- Konsole prüfen (`preview_console_logs`): keine Fehler, keine leere Seite (Hook-Order ok).
Quelle bei Problemen lesen/fixen, dann erneut prüfen.

- [ ] **Step 2: Live-Verifikation des Fehler-Pfads + Resync**

API-Karte im `err`-Zustand erzeugen: ungültigen, nicht-mock Schlüssel setzen (z. B. über die Settings-UI einen Fantasie-Schlüssel speichern), sodass der nächste Sync mit echtem Fehler endet (`lastSyncStatus = 'error'`). Übersicht zeigt dann „Sync fehlgeschlagen" + übersetzte Ursache + ggf. kleine Rohzeile. „Erneut synchronisieren" klicken → `preview_network` zeigt `POST /api/sync` (202); Button-Label wechselt kurz auf „Synchronisiert…". Danach mock-Schlüssel wiederherstellen.
(Die exakten Übersetzungstreffer sind durch die Unit-Tests aus Task 1 abgedeckt.)

- [ ] **Step 3: Screenshot als Nachweis**

`preview_screenshot` der Übersicht mit mindestens einer Problemkarte (Ursache + Aktion sichtbar).

- [ ] **Step 4: Versionsstände heben**

- `package.json:3`: `"version": "0.5.0"` → `"0.6.0"`.
- `VERSION`: Inhalt `0.5.0` → `0.6.0`.
- `README.md:3`: `version-0.5.0-blue` → `version-0.6.0-blue`.
- `Smart Meter Dashboard/Klima Dashboard.html`: alle `?v=0.5.0` → `?v=0.6.0` (Zeilen 1192–1200 plus der neue `status-logic.js`-Tag aus Task 1).

Konsistenzcheck:

```bash
grep -rn "0\.5\.0" package.json VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html"
```
Expected: keine Treffer mehr (alles auf 0.6.0).

- [ ] **Step 5: Voller Testlauf**

Run: `npm test`
Expected: PASS — alle Suites grün, 0 Fehler.

- [ ] **Step 6: Release-Commit**

```bash
git add package.json VERSION README.md "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "chore: bump version to 0.6.0"
```

- [ ] **Step 7: Integration nach master + lokales Tag**

Per Skill `superpowers:finishing-a-development-branch` abwickeln. Konkret (kein Remote → kein Push):

```bash
git checkout master
git merge --no-ff feat/status-cards-cause-action -m "merge: enriched system-overview status cards (0.6.0)"
git tag -a v0.6.0 -m "v0.6.0"
```

Konsistenzcheck:

```bash
git tag -l v0.6.0
git log --oneline -1
```
Expected: Tag `v0.6.0` existiert; HEAD ist der Merge-Commit auf master.

---

## Self-Review

**Spec-Abdeckung:** Verdikt-Überschriften (Task 4) ✓ · Ursache Klartext+Technik via `explainSyncError` (Task 1, gerendert Task 3/4) ✓ · Aktionen Navigation+Resync (Task 2 Endpunkt, Task 4 Verdrahtung) ✓ · nur ≠ok-Karten angereichert (Task 4 Bedingungen) ✓ · Backend `POST /api/sync` (Task 2) ✓ · CSS (Task 3) ✓ · Tests (Task 1/2) ✓ · Release 0.6.0 (Task 5) ✓. Offene Punkte der Spec aufgelöst: Scheduler-Aktion → `onNavigate('api')`; Messstellen ohne Dauer; `/api/sync` → 202/200.

**Platzhalter:** keine — jeder Code-Schritt zeigt vollständigen Code.

**Typkonsistenz:** `explainSyncError` liefert `{plain, showRaw}` (Task 1) und wird in Task 4 als `ex.plain`/`ex.showRaw` genutzt ✓. `HealthCard`-Props `cause/causeRaw/actions` (Task 3) entsprechen den in Task 4 übergebenen Variablen ✓. `actions`-Items `{label,onClick,primary?,disabled?}` (Task 3) ↔ erzeugte Arrays (Task 4) ✓. `onNavigate`=`setSection`, Ziel-Ids `api`/`stations`/`database` aus `SETTINGS_SECTIONS` ✓.
