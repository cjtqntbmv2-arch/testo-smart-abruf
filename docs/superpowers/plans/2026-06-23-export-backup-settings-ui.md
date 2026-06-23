# Datenexport — Backup-Einstellungen-UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Im Datenexport-Menü eine Untersektion ergänzen, mit der das bereits aktive automatische Monats-Backup ein-/ausgeschaltet, der Speicherpfad gesetzt und der Lauf-Status angezeigt wird.

**Architecture:** Reine Frontend-Arbeit. Eine zweite Komponente `BackupSettings()` in [export-panel.jsx](../../../Smart%20Meter%20Dashboard/export-panel.jsx) lädt Einstellungen/Status über neue `DASH_DATA`-Helfer und speichert über das bestehende `POST /api/settings`. Backend bleibt unverändert.

**Tech Stack:** React via Babel-in-Browser (kein Build), `window.DASH_DATA`-Datenschicht in `data.js`, Styles inline in `Klima Dashboard.html`. Backend: Express/SQLite (nur lesend/schreibend über vorhandene Endpunkte).

**Spec:** [docs/superpowers/specs/2026-06-23-export-backup-settings-ui-design.md](../specs/2026-06-23-export-backup-settings-ui-design.md)

## Global Constraints

- **Kein Build-Schritt** — alle `.jsx` werden von Babel global in einen Scope konkateniert; **keine** bare `useState`/`useEffect`-Globals (Kollision), die in `export-panel.jsx` definierten Aliase `useStateE`/`useEffectE`/`useMemoE` wiederverwenden.
- **Kein neuer Script-Tag** — `BackupSettings` lebt in `export-panel.jsx`; die 12 `?v=`-Positionen in `Klima Dashboard.html` bleiben 12.
- **Kein Unit-Test-Runner fürs Frontend** — Verifikation per **Preview** (manuelle Akzeptanz). Nur Backend hat `node --test`; Backend wird hier nicht angefasst.
- **`export-panel.jsx` bleibt < 400 Zeilen** (GUI-Entry-Regel; aktuell 143, nach diesem Plan ~270).
- **Pfad-Validierung lebt im Backend** — `POST /api/settings` antwortet bei nicht beschreibbarem `backup_dir` mit `400 { error: "backup_dir nicht beschreibbar: …" }`; die UI zeigt diese Meldung nur an, validiert nicht selbst.
- **Sprache:** Deutsch für alle UI-Texte.
- **Release:** MINOR-Bump auf **0.12.0** (von aktuell 0.11.2) in `VERSION`, README-Badge, `package.json`, **allen 12** `?v=`-Cache-Bustern in `Klima Dashboard.html`; annotiertes Tag `v0.12.0`.

---

### Task 1: `DASH_DATA`-Helfer für Settings & Backup-Status

**Files:**
- Modify: `Smart Meter Dashboard/data.js` (im `window.DASH_DATA = { … }`-Objekt, nach `postExport`, ~Zeile 412)

**Interfaces:**
- Consumes: nichts (nur `fetch` gegen vorhandene Endpunkte `GET /api/settings`, `POST /api/settings`, `GET /api/system/status`).
- Produces:
  - `DASH_DATA.fetchSettings(): Promise<Object>` — das rohe Settings-JSON (`backup_enabled: boolean`, `backup_dir: string`, …).
  - `DASH_DATA.saveSettings(patch: Object): Promise<Object>` — POST mit Teil-Patch; wirft `Error(msg)` mit der **Backend-Fehlermeldung** bei nicht-OK-Antwort.
  - `DASH_DATA.fetchBackupStatus(): Promise<Object>` — der `backup`-Block aus **`/api/system/status`** (es gibt **kein** `/api/status` — verifiziert, server.js:332): `{ enabled, dir, lastScanDate, health }`, wobei `health = {}` ist, solange nie ein Scan lief.

- [ ] **Step 1: Helfer einfügen**

In `data.js`, direkt nach dem `postExport`-Block (vor `// Extra helpers …`/`forceApiRefresh`), einfügen:

```javascript
    async fetchSettings() {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Einstellungen konnten nicht geladen werden');
      return res.json();
    },

    async saveSettings(patch) {
      const res = await fetch('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        let msg = 'Speichern fehlgeschlagen';
        try { msg = (await res.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      return res.json().catch(() => ({}));
    },

    async fetchBackupStatus() {
      const res = await fetch('/api/system/status'); // NICHT /api/status — die Route heisst /api/system/status (server.js:332)
      if (!res.ok) throw new Error('Status konnte nicht geladen werden');
      const s = await res.json();
      return s.backup || {};
    },
```

- [ ] **Step 2: Server starten (falls nicht läuft) und Helfer im Preview prüfen**

Run (Preview): Dashboard öffnen, in der Browser-Konsole:
```javascript
await DASH_DATA.fetchBackupStatus()
```
Expected: Objekt mit `enabled`, `dir`, `lastScanDate`, `health` (kein Fehler). `fetchSettings()` liefert u.a. `backup_enabled`, `backup_dir`.

- [ ] **Step 3: Commit**

```bash
git add "Smart Meter Dashboard/data.js"
git commit -m "feat(export): add DASH_DATA settings/backup-status helpers"
```

---

### Task 2: `BackupSettings`-Komponente (Ein/Aus + Pfad + Status) im Datenexport-Menü

**Files:**
- Modify: `Smart Meter Dashboard/export-panel.jsx` (Kopfkommentar Zeile 2; neue Komponente `BackupSettings`; Render-Aufruf in `ExportPanel`)
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (CSS für `.backup-*`, bei den übrigen `.export-*`-Styles)

**Interfaces:**
- Consumes: `DASH_DATA.fetchSettings`, `DASH_DATA.saveSettings`, `DASH_DATA.fetchBackupStatus` (Task 1); vorhandene Komponenten `SectionHead`, `Card`, `Field`, `Toggle`, `Spinner`; Hook-Aliase `useStateE`/`useEffectE` aus derselben Datei; CSS-Klassen `export-error`, `status-pill`/`status-pill-dot`/`st-ok`/`st-err`, Tokens `--alarm`/`--warn`.
- Produces: `BackupSettings` (parameterlose Komponente), gerendert am Ende von `ExportPanel`.

- [ ] **Step 1: Kopfkommentar aktualisieren**

In `export-panel.jsx` Zeile 2 steht aktuell exakt (englisch):
```javascript
// Manual CSV export dialog + backup-status block. Mounted as a settings section.
```
Ersetzen durch (deutsch, präziser — jetzt mit echten Bedien-Controls statt nur „status block"):
```javascript
// Manueller CSV-Export-Dialog + Backup-Einstellungen (Ein/Aus, Pfad) und -Status. Als Settings-Sektion eingehängt.
```

- [ ] **Step 2: `BackupSettings`-Komponente hinzufügen**

In `export-panel.jsx`, **nach** der `ExportPanel`-Funktion und **vor** dem abschließenden Bare-Global-Kommentarblock, einfügen:

```javascript
function BackupSettings() {
  const [enabled, setEnabled] = useStateE(true);
  const [dir, setDir] = useStateE('');
  const [status, setStatus] = useStateE(null);   // backup-Block aus /api/system/status, oder null
  const [statusErr, setStatusErr] = useStateE(false);
  const [pathErr, setPathErr] = useStateE(null);
  const [savedFlash, setSavedFlash] = useStateE(false);
  const [busy, setBusy] = useStateE(false);
  const [pollSec, setPollSec] = useStateE(900); // Poll-Intervall für den „erster Lauf"-Hinweis

  function reloadStatus() {
    DASH_DATA.fetchBackupStatus()
      .then(b => { setStatus(b); setStatusErr(false); })
      .catch(() => setStatusErr(true));
  }

  useEffectE(() => {
    DASH_DATA.fetchSettings()
      .then(s => { setEnabled(s.backup_enabled !== false); setDir(s.backup_dir || ''); setPollSec(s.poll_interval_sec || 900); })
      .catch(() => {});
    reloadStatus();
  }, []);

  async function toggleEnabled(next) {
    if (busy) return;                  // Doppelklick/Race-Schutz: ein In-Flight-Save zur Zeit
    setBusy(true);
    setEnabled(next);                  // optimistisch
    try { await DASH_DATA.saveSettings({ backup_enabled: next }); }
    catch (_) { setEnabled(!next); }   // bei Fehler zurücksetzen
    finally { setBusy(false); reloadStatus(); }
  }

  async function savePath() {
    setPathErr(null); setBusy(true);
    try {
      await DASH_DATA.saveSettings({ backup_dir: dir });
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000);
      reloadStatus();
    } catch (e) { setPathErr(e.message); }
    finally { setBusy(false); }
  }

  const effectiveDir = (status && status.dir) || null; // aufgelöster Zielordner (gesetzter Pfad ODER Default)
  const health = (status && status.health) || {};

  return (
    <>
      <SectionHead
        title="Automatisches Monats-Backup"
        sub="Sichert je Messstelle Messwerte und Meldungen eines Monats als ZIP. Läuft selbsttätig, höchstens einmal pro Tag."
      />

      <Card>
        <Field label="Automatisches Backup" hint="Monatliche ZIP-Sicherung ein- oder ausschalten.">
          <Toggle checked={enabled} onChange={toggleEnabled} labelOn="Ein" labelOff="Aus" />
        </Field>
        <Field label="Speicherpfad" hint="Zielordner für die Backup-ZIPs. Leer = Standardordner.">
          <div className="backup-path">
            <input
              type="text"
              className="backup-path-input"
              value={dir}
              placeholder="Leer lassen für Standardordner"
              onChange={e => { setDir(e.target.value); setPathErr(null); }}
            />
            <button className="btn" disabled={busy} onClick={savePath}>
              {busy ? <Spinner /> : (savedFlash ? 'Gespeichert ✓' : 'Speichern')}
            </button>
          </div>
          {pathErr && (
            <div className="export-error">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span>{pathErr}</span>
            </div>
          )}
        </Field>
      </Card>

      <Card>
        {statusErr ? (
          <p className="backup-status-msg">Status nicht verfügbar.</p>
        ) : !enabled ? (
          <p className="backup-status-msg muted">Automatisches Backup ist ausgeschaltet.</p>
        ) : !health.status ? (
          <p className="backup-status-msg muted">Noch kein Backup gelaufen — der erste Lauf erfolgt beim nächsten Sync (spätestens in {Math.max(1, Math.round(pollSec / 60))} Min).</p>
        ) : (
          <div className="backup-status">
            <div className="backup-status-head">
              <span className={`status-pill st-${health.status === 'ok' ? 'ok' : 'err'}`}>
                <span className="status-pill-dot" />
                {health.status === 'ok' ? 'Aktiv' : 'Fehler'}
              </span>
              {health.status !== 'ok' && health.lastError && (
                <span className="backup-status-err">{health.lastError}</span>
              )}
            </div>
            <div className="backup-status-rows">
              <div><span className="k">Zielordner</span><span className="v">{effectiveDir || '—'}</span></div>
              <div><span className="k">Letzter Scan</span><span className="v">{status.lastScanDate || '—'}</span></div>
              <div><span className="k">Zuletzt geschrieben</span><span className="v">{health.lastZip ? (health.written ? `${health.lastZip} (${health.written})` : health.lastZip) : '—'}</span></div>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
```

- [ ] **Step 3: `BackupSettings` in `ExportPanel` rendern**

In `ExportPanel`, unmittelbar **vor** dem schließenden `</>` (nach dem `<div className="export-actions">…</div>`), einfügen:

```javascript
      <BackupSettings />
```

- [ ] **Step 4: CSS ergänzen**

In `Klima Dashboard.html`, bei den `.export-*`-Regeln, einfügen:

```css
  .backup-path { display: flex; gap: 8px; align-items: center; }
  .backup-path-input { flex: 1; min-width: 0; } /* Border/Padding/Font erbt von .setting-field-control input[type="text"] (Klima Dashboard.html:1006) */
  .backup-status { display: flex; flex-direction: column; gap: 10px; }
  .backup-status-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .backup-status-err { color: var(--alarm); font-size: 13px; }
  .backup-status-rows { display: flex; flex-direction: column; gap: 6px; }
  .backup-status-rows > div { display: flex; justify-content: space-between; gap: 16px; font-size: 13px; }
  .backup-status-rows .k { color: var(--text-muted); white-space: nowrap; }
  .backup-status-rows .v { font-variant-numeric: tabular-nums; word-break: break-all; text-align: right; }
  .backup-status-msg { color: var(--text-muted); font-size: 13px; margin: 0; }
  .backup-status-msg.muted { opacity: 0.85; }
```

> Tokens verifiziert: `--text-muted` (#5B6862), `--border-strong`, `--alarm`, `--warn` existieren im `:root` (Klima Dashboard.html:18-50). **Nicht** `--line`/`--text-dim` (existieren nicht). `.backup-path-input` setzt bewusst nur `flex`/`min-width`; alles Übrige liefert die vorhandene Input-Regel.

- [ ] **Step 5: Preview-Verifikation (Spec §8)**

Run (Preview): Dashboard → Einstellungen → Datenexport. Prüfen:
1. Unter dem manuellen Export erscheint „Automatisches Monats-Backup" — Konsole sauber, kein Blank-Screen.
2. **Toggle persistiert:** Aus schalten → Reload → bleibt Aus; Status-Block zeigt „ausgeschaltet". Wieder Ein → Reload → Ein.
3. **Ungültiger Pfad:** z.B. `/nicht/existent/readonly` eingeben → „Speichern" → rote Inline-Meldung „backup_dir nicht beschreibbar: …", Pfad-Stand bleibt.
4. **Gültiger Pfad:** leeren oder gültigen Ordner eingeben → „Speichern" → „Gespeichert ✓"; Status-Block zeigt den aufgelösten Pfad-Default als Placeholder bei leerem Feld.
5. **„Nie gelaufen"-Fall + D3-Hinweis:** Nur **bevor je ein Scan lief** (`health = {}`) → grauer Hinweis „Noch kein Backup gelaufen — der erste Lauf erfolgt beim nächsten Sync (spätestens in X Min)" mit korrektem X (= `poll_interval_sec`/60, Default 15). Achtung: Schon ein **erfolgreicher, aber ZIP-loser** Scan (kein Monat fällig) schreibt `health.status='ok', lastZip=null` → der Block kippt dann auf „Aktiv" mit „Zuletzt geschrieben: —". Das ist korrekt; nicht mit einem Bug verwechseln.

> Branch „Fehler" (`health.status === 'error'`) ist im Preview schwer erzwingbar (echter Schreibfehler nötig); per Code-Review der Branch-Logik bestätigen. Branches „aus"/„nie gelaufen"/„aktiv" live prüfen.

- [ ] **Step 6: Commit**

```bash
git add "Smart Meter Dashboard/export-panel.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(export): backup settings UI (toggle + path + status) under Datenexport"
```

---

### Task 3: Release 0.12.0

**Files:**
- Modify: `VERSION`, `README.md` (Badge), `package.json` (`version`), `Smart Meter Dashboard/Klima Dashboard.html` (12 `?v=`-Tags)

**Interfaces:**
- Consumes: fertige, im Preview verifizierte Feature-Commits (Task 1–2).
- Produces: kohärente Version `0.12.0` an allen Stellen + annotiertes Tag `v0.12.0`.

- [ ] **Step 1: Version an allen Stellen auf 0.12.0**

- `VERSION`: `0.12.0`
- `README.md`: Badge `version-0.12.0-blue`
- `package.json`: `"version": "0.12.0"`
- `Klima Dashboard.html`: alle 12 `?v=0.11.2` → `?v=0.12.0` (Zeilen 1332–1343)

- [ ] **Step 2: Kohärenz prüfen**

Run:
```bash
cd "/Users/dniehof/Programming/Programme/testo-smart-abruf" && \
  grep -c "?v=0.12.0" "Smart Meter Dashboard/Klima Dashboard.html"; \
  grep -n "version" package.json | head -1; cat VERSION; grep -o "version-[0-9.]*-blue" README.md; \
  git tag -l v0.12.0
```
Expected: `12` Treffer für `?v=0.12.0`, `package.json`/`VERSION`/Badge alle `0.12.0`, **kein** vorhandenes Tag `v0.12.0`.

- [ ] **Step 3: Commit + Tag + Push**

```bash
cd "/Users/dniehof/Programming/Programme/testo-smart-abruf" && \
  git add VERSION README.md package.json "Smart Meter Dashboard/Klima Dashboard.html" && \
  git commit -m "chore: bump version to 0.12.0 (Datenexport backup settings UI)" && \
  git tag -a v0.12.0 -m "v0.12.0" && \
  (git remote | grep -q . && git push --follow-tags || echo "kein Remote — Tag nur lokal")
```

---

## Self-Review

**1. Spec coverage:**
- §4 Platzierung (unter manuellem Export) → Task 2 Step 3. ✅
- §5.1 Toggle (sofort speichern + Status-Reload) → Task 2 `toggleEnabled`. ✅
- §5.2 Pfad (Button, Placeholder=Default, 400-Inline-Fehler, „Gespeichert ✓") → Task 2 `savePath` + Render. ✅
- §5.3 Status-Block (alle 5 Branches: aus / nie gelaufen / ok / error / nicht verfügbar) → Task 2 Render. ✅
- §6 Datenfluss (Mount-Load + Reload-nach-Speichern, kein Live-Poll) → Task 2 `useEffectE` + `reloadStatus`. ✅
- §7 Fehlerbehandlung (kein Throw, Hooks vor early return) → alle Hooks stehen vor dem `return`; Branches statt Throws. ✅
- §8 Tests → Task 2 Step 5. ✅
- §9 Release → Task 3. ✅
- Helfer-Schicht (implizit für §6) → Task 1. ✅

**2. Placeholder-Scan:** Keine TBD/TODO; jeder Code-Schritt zeigt vollständigen Code. ✅

**3. Typ-Konsistenz:** `fetchBackupStatus()` liefert `{ enabled, dir, lastScanDate, health }` (Task 1) — genau so in Task 2 (`status.dir`, `status.lastScanDate`, `status.health`) konsumiert. `saveSettings(patch)` wirft `Error` mit Backend-`msg` — in `savePath` als `e.message` angezeigt. `backup_enabled` ist bool aus `fetchSettings` — `s.backup_enabled !== false`. ✅
