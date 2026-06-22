// Settings page — sidebar navigation + section content.
// All values are mocked / persisted to localStorage. Test buttons simulate calls.

const { useState: sState, useRef: sRef, useEffect: sEff, useMemo: sMemo } = React;

// v2: v1 blob carried a fabricated api key (kli_live_8a3…) + removed calibration keys — abandon it.
const SETTINGS_KEY = "dash-settings-v2";

const DEFAULT_SETTINGS = {
  api: {
    apiKey: "",           // empty — real key lives in backend only; never written to localStorage (stripped before persist)
    apiRegion: "eu",
    pollIntervalSec: 900, // 15 min — matches backend default
  },
  database: {
    retentionDays: 365,
  },
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const stored = JSON.parse(raw);
    // shallow merge with defaults to handle new keys
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      api: { ...DEFAULT_SETTINGS.api, ...(stored.api || {}) },
      database: { ...DEFAULT_SETTINGS.database, ...(stored.database || {}) },
    };
  } catch (e) {
    return DEFAULT_SETTINGS;
  }
}

// System snapshot is now fetched dynamically from /api/system/status

const SETTINGS_SECTIONS = [
  { id: "overview",  label: "Übersicht",        icon: "grid" },
  { id: "api",       label: "API & Verbindung", icon: "plug" },
  { id: "database",  label: "Datenbank",        icon: "db" },
  { id: "stations",  label: "Messstellen",      icon: "node" },
  { id: "advanced",  label: "Erweitert",        icon: "sliders" },
  { id: "export",    label: "Datenexport",      icon: "download" },
];

function SettingsPage({ onClose }) {
  const [section, setSection] = sState("overview");
  const [settings, setSettings] = sState(loadSettings);
  const [savedFlash, setSavedFlash] = sState(false);
  const [saveError, setSaveError] = sState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = sState(false);
  const [systemStatus, setSystemStatus] = sState(null);
  const [, forceTick] = sState(0);

  // Lädt die Systemdiagnose neu; im Mount-Effekt und als onRefresh für die Übersicht genutzt.
  const loadStatus = () => {
    fetch('/api/system/status')
      .then(res => res.json())
      .then(data => setSystemStatus(data))
      .catch(err => console.error('Failed to load system diagnostics:', err));
  };

  // Hydration gate: tracks whether the initial GET /api/settings has completed AND the resulting
  // state update has been absorbed. We need TWO counters, not a simple boolean:
  //   skipCount.current = number of [settings] effect runs still to skip before POSTing.
  //
  // Timeline:
  //   1. Mount  → [settings] effect fires (initial render) — this is NOT a user edit → skip 1.
  //   2. GET resolves → setSettings(...) fires → [settings] effect fires again — this IS the
  //      hydration state-update, also NOT a user edit → skip 1 more.
  //   3. Any subsequent [settings] effect run is a genuine user edit → POST.
  //
  // So we pre-load skipCount with 1 (for the mount run), and the GET .then increments it by 1
  // more (for the hydration run). Total skips = 2 on a successful load; 1 on load failure
  // (where no setSettings is called and hence no second effect run happens, but hydrated must
  // still be set so user edits after a failed load do save).
  //
  // Edge case: if the GET fails, no setSettings is called, skipCount stays at 1, and the one
  // initial-mount effect run is consumed. After that, any user edit POSTs normally.
  const skipCount = sRef(1); // start at 1 to absorb the initial-mount run

  // Subscribe to dashboard data changes so the UI reflects added/deleted stations immediately
  sEff(() => {
    if (window.DASH_DATA && window.DASH_DATA.subscribe) {
      return window.DASH_DATA.subscribe(() => forceTick(v => v + 1));
    }
  }, []);

  // Load configuration and diagnostics from backend on mount.
  // Note: GET /api/settings no longer returns the cleartext api_key — only api_key_set (boolean).
  // We track that flag in apiKeyConfigured state and never set settings.api.apiKey from the response.
  sEff(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        // Update api_key_set flag (shown as placeholder in the key input)
        setApiKeyConfigured(!!data.api_key_set);
        // Hydrate other settings from backend. api.apiKey intentionally NOT set here — we never
        // receive the cleartext key. The field stays empty so the user types a new key only when
        // actually changing it.
        setSettings(s => ({
          ...s,
          api: {
            ...s.api,
            apiRegion: data.api_region || 'eu',
            pollIntervalSec: data.poll_interval_sec || 900
          },
          database: {
            ...s.database,
            retentionDays: data.retention_days || 365
          }
        }));
        // Increment skip counter so the [settings] effect that fires due to this setSettings
        // call is also skipped (it's the hydration update, not a user edit).
        skipCount.current += 1;
      })
      .catch(err => {
        console.error('Failed to load backend settings:', err);
        // No setSettings called on failure, so no extra effect run to absorb. skipCount stays
        // at 1, which was already consumed by the initial-mount run. User edits save normally.
      });

    loadStatus();
    const intervalId = setInterval(loadStatus, 10000);
    return () => clearInterval(intervalId);
  }, []);

  sEff(() => {
    // K1 hydration gate — consume one skip token per non-user effect run:
    //   skipCount starts at 1 (initial-mount run). GET success adds 1 more (hydration run).
    //   User edits fire after all tokens are spent → POST fires.
    //   - Page open, GET succeeds: 2 skips consumed (mount + hydration) → 0 POSTs.
    //   - Page open, GET fails:    1 skip consumed (mount only, no setSettings) → 0 POSTs.
    //   - User changes a field:    skipCount is 0 → POST fires normally.
    if (skipCount.current > 0) {
      skipCount.current -= 1;
      return;
    }

    // H2: Never persist the typed api key to localStorage — the backend is the source of truth.
    // The in-memory settings.api.apiKey is intentionally kept intact (used for the POST body
    // during the session); only the persisted copy has it stripped.
    try {
      const persisted = { ...settings, api: { ...settings.api, apiKey: '' } };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
    } catch (e) {}

    // Save to backend with a 1-second debounce to avoid spamming keystrokes.
    // H4: savedFlash/saveError are set based on actual POST outcome, not just "change happened".
    const saveId = setTimeout(() => {
      // H2: Only include api_key in the body when the user has actually typed a non-empty value.
      // An empty field means "leave the stored key unchanged" — omitting it from the POST
      // prevents accidentally wiping the stored key when changing other settings.
      const body = {
        api_region: settings.api.apiRegion || 'eu',
        poll_interval_sec: settings.api.pollIntervalSec,
        retention_days: settings.database.retentionDays
      };
      if (settings.api.apiKey) {
        body.api_key = settings.api.apiKey;
      }

      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(res => {
          if (!res.ok) {
            // H4: surface backend rejection (e.g. 400 validation) as save error
            setSaveError(true);
            setSavedFlash(false);
            setTimeout(() => setSaveError(false), 3000);
            return;
          }
          setSavedFlash(true);
          setSaveError(false);
          setTimeout(() => setSavedFlash(false), 1200);
          // Immediately trigger status refresh after successful settings update
          fetch('/api/system/status')
            .then(r => r.json())
            .then(data => setSystemStatus(data))
            .catch(() => {});
        })
        .catch(err => {
          console.error('Failed to save backend settings:', err);
          setSaveError(true);
          setSavedFlash(false);
          setTimeout(() => setSaveError(false), 3000);
        });
    }, 1000);

    return () => clearTimeout(saveId);
  }, [settings]);

  function update(path, value) {
    setSettings((s) => {
      const next = { ...s };
      const parts = path.split(".");
      let cur = next;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = { ...cur[parts[i]] };
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  }

  const ctx = { settings, update };
  let body = null;
  if (section === "overview")      body = <OverviewSection settings={settings} systemStatus={systemStatus} onNavigate={setSection} onRefresh={loadStatus} />;
  if (section === "api")           body = <ApiSection settings={settings} update={update} systemStatus={systemStatus} apiKeyConfigured={apiKeyConfigured} />;
  if (section === "database")      body = <DatabaseSection settings={settings} update={update} systemStatus={systemStatus} />;
  if (section === "stations")  body = <StationsSection />;
  if (section === "advanced")  body = <AdvancedSection {...ctx} systemStatus={systemStatus} onReset={() => setSettings(DEFAULT_SETTINGS)} />;
  if (section === "export")    body = <ExportPanel />;

  return (
    <div className="settings-shell">
      <aside className="settings-side">
        <div className="settings-side-head">Einstellungen</div>
        <nav className="settings-nav">
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.id}
                    className={`settings-nav-item ${section === s.id ? "active" : ""}`}
                    onClick={() => setSection(s.id)}>
              <NavIcon id={s.icon} />
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-side-foot">
          {saveError ? (
            <div className="save-pill show" style={{ background: 'var(--alarm)', color: '#fff' }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2v5M6 9v1"/></svg>
              Speichern fehlgeschlagen
            </div>
          ) : (
            <div className={`save-pill ${savedFlash ? "show" : ""}`}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2.5 6 5 8.5 9.5 3.5"/></svg>
              Gespeichert
            </div>
          )}
        </div>
      </aside>
      <main className="settings-main">
        <div className="settings-content">{body}</div>
      </main>
    </div>
  );
}

// ---------- Sections ----------
function OverviewSection({ settings, systemStatus, onNavigate, onRefresh }) {
  const [resyncing, setResyncing] = sState(false);
  const D = window.DASH_DATA;
  const stationsOnline = D.stationOrder.filter((id) => D.stations[id].online).length;
  const stationsTotal  = D.stationOrder.length;

  if (!systemStatus) {
    return (
      <>
        <SectionHead title="Systemübersicht" sub="Zustand aller verbundenen Dienste und Komponenten." />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--text-muted)' }}>
          <Spinner /> <span style={{ marginLeft: '8px' }}>Lade Systemdiagnose...</span>
        </div>
      </>
    );
  }

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
      { label: resyncing ? 'Sync gestartet…' : 'Erneut synchronisieren', onClick: handleResync, primary: true, disabled: resyncing },
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
  // Grill-Fix: storage.status kann 'unknown' sein (z. B. :memory:-DB oder statfs-Fehler).
  // Dann sind usedGb/totalGb null → kein "null / null GB", kein NaN-Balken, kein rotes Badge.
  let storageValue = `${storage.usedGb} / ${storage.totalGb} GB`;
  let storageSub = `${Math.round((storage.usedGb / storage.totalGb) * 100)} % belegt · Pfad: ../klima.db`;
  let storageProgress = storage.usedGb / storage.totalGb;
  let storageCause = null, storageActions = null;
  if (storage.status === 'unknown' || storage.usedGb == null) {
    storageValue = 'Nicht verfügbar';
    storageSub = 'Speicherinfo nicht verfügbar · Pfad: ../klima.db';
    storageProgress = null;
  } else if (storage.status === 'warn') {
    storageValue = 'Speicher fast voll';
    storageCause = 'Weniger als 1 GB frei.';
    storageActions = [{ label: 'Aufbewahrung anpassen →', onClick: () => onNavigate('database'), primary: true }];
  }

  return (
    <>
      <SectionHead title="Systemübersicht" sub="Zustand aller verbundenen Dienste und Komponenten." />
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
          sub={storageSub}
          icon="disk"
          progress={storageProgress}
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

      <SectionHead title="Aktive Vorgänge" sub="Was das System gerade tut." compact />
      <div className="ops-list">
        {scheduler.isSyncing ? (
          <OpRow status="running" label="Testo API Synchronisation" detail="Lese Messwerte und Gerätestatus aus testo Smart Connect API..." />
        ) : (
          <OpRow status="idle" label="Testo API Synchronisation" detail={`Nächste regelmäßige Synchronisation geplant (Intervall: ${Math.round(scheduler.pollIntervalSec / 60)} Min.)`} />
        )}
        <OpRow status="idle" label="Datenbereinigung (Retention)" detail={`Geplant nach jedem erfolgreichen Sync (Aufbewahrung: ${settings.database.retentionDays} Tage)`} />
      </div>
    </>
  );
}

function ApiSection({ settings, update, systemStatus, apiKeyConfigured }) {
  const [testing, setTesting] = sState(false);
  const [showKey, setShowKey] = sState(false);
  const [testResult, setTestResult] = sState(null);

  function runTest() {
    setTesting(true);
    setTestResult(null);
    fetch('/api/testo/measuring-objects')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Verbindung fehlgeschlagen');
        }
        return res.json();
      })
      .then((data) => {
        setTesting(false);
        setTestResult({ ok: true, msg: `${data.length} Messobjekt(e) erfolgreich geladen` });
      })
      .catch((err) => {
        setTesting(false);
        setTestResult({ ok: false, msg: err.message });
      });
  }

  const hasStatus = !!systemStatus;
  const currentStatus = hasStatus 
    ? (systemStatus.scheduler.lastSyncStatus === 'error' ? 'err' : (systemStatus.api.apiKeyConfigured ? 'ok' : 'warn'))
    : 'warn';
  const lastSyncTime = hasStatus ? systemStatus.scheduler.lastSyncTime : null;
  const lastSyncError = hasStatus ? systemStatus.scheduler.lastSyncError : null;

  return (
    <>
      <SectionHead title="API & Verbindung" sub="Anbindung an den Klima-Datenservice." />

      <Card>
        <div className="card-head">
          <StatusPill status={testResult ? (testResult.ok ? "ok" : "err") : currentStatus} />
          <div className="card-head-text">
            <div className="card-title">Live-Status (Testo Cloud Sync)</div>
            <div className="card-sub">
              {testResult
                ? (testResult.ok ? `Test erfolgreich: ${testResult.msg}` : `Fehler: ${testResult.msg}`)
                : lastSyncTime
                  ? `Zuletzt synchronisiert: ${window.DASH_DATA.formatRelative(lastSyncTime)}${lastSyncError ? ` (Fehler: ${lastSyncError})` : ''}`
                  : 'Noch nicht synchronisiert. Konfigurieren Sie den API-Schlüssel.'}
            </div>
          </div>
          <button className={`btn ${testing ? "" : "primary"}`} onClick={runTest} disabled={testing}>
            {testing ? <><Spinner /> Teste …</> : "Verbindung testen"}
          </button>
        </div>
      </Card>

      <Card>
        <Field label="API-Schlüssel" hint="Wird zur Authentifizierung bei der Testo Smart Connect Cloud verwendet. Leer lassen, um den gespeicherten Schlüssel beizubehalten.">
          <div className="input-row">
            {/* H2: The backend never returns the cleartext key. The field starts empty.
                A placeholder indicates whether a key is already stored on the backend.
                The user types here only when changing the key; an empty field on save
                means "leave stored key unchanged" (omitted from POST body). */}
            <input
              type={showKey ? "text" : "password"}
              value={settings.api.apiKey}
              onChange={(e) => update("api.apiKey", e.target.value)}
              placeholder={apiKeyConfigured ? "•••••••••• (gespeichert)" : "Kein Schlüssel konfiguriert"}
            />
            <button className="btn ghost" onClick={() => setShowKey((v) => !v)} title={showKey ? "Verbergen" : "Anzeigen"}>
              {showKey ? "Verbergen" : "Anzeigen"}
            </button>
          </div>
        </Field>
        <Field label="API-Region" hint="Die Region Ihrer Testo Smart Connect Cloud.">
          <SegmentedControl
            value={settings.api.apiRegion || 'eu'}
            options={[{ value: 'eu', label: 'Europa (EU)' }, { value: 'us', label: 'Amerika (US)' }]}
            onChange={(v) => update("api.apiRegion", v)}
          />
        </Field>
        <Field label={`Abfrage-Intervall · ${Math.round(settings.api.pollIntervalSec / 60)} min`}>
          <input type="range" min="60" max="3600" step="60" value={settings.api.pollIntervalSec || 900}
                 onChange={(e) => update("api.pollIntervalSec", +e.target.value)} />
        </Field>
      </Card>
    </>
  );
}

function DatabaseSection({ settings, update, systemStatus }) {
  if (!systemStatus) {
    return (
      <>
        <SectionHead title="Datenbank" sub="Speicherung der historischen Messdaten und Ereignisse." />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--text-muted)' }}>
          <Spinner /> <span style={{ marginLeft: '8px' }}>Lade Datenbankstatus...</span>
        </div>
      </>
    );
  }

  const { database } = systemStatus;
  const dbStatus    = database.status;
  const dbEngine    = database.engine;
  const dbLastWrite = database.lastWrite;
  const dbSizeBytes = database.sizeBytes;
  const dbRowCount  = database.rowCount;
  const dbOldest    = database.oldestRecord;

  return (
    <>
      <SectionHead title="Datenbank" sub="Speicherung der historischen Messdaten und Ereignisse." />

      <Card>
        <div className="card-head">
          <StatusPill status={dbStatus} />
          <div className="card-head-text">
            <div className="card-title">{dbEngine}</div>
            <div className="card-sub">
              Verbunden · letzter Schreibvorgang {dbLastWrite ? window.DASH_DATA.formatRelative(dbLastWrite) : '—'}
            </div>
          </div>
        </div>
        <div className="kv-grid">
          <KV label="Größe"             value={formatBytes(dbSizeBytes)} />
          <KV label="Datensätze"        value={dbRowCount.toLocaleString("de-DE")} />
          <KV label="Ältester Eintrag"  value={dbOldest ? new Date(dbOldest).toLocaleDateString("de-DE") : '—'} />
          <KV label="Engine"            value={dbEngine} />
        </div>
      </Card>

      <Card>
        <Field label="Aufbewahrungszeit" hint="Wie lange Rohmessdaten gespeichert werden. Aggregierte Daten bleiben dauerhaft erhalten.">
          <SegmentedControl
            value={settings.database.retentionDays}
            options={[
              { value: 30,  label: "30 Tage" },
              { value: 90,  label: "90 Tage" },
              { value: 180, label: "6 Monate" },
              { value: 365, label: "1 Jahr" },
              { value: 730, label: "2 Jahre" },
            ]}
            onChange={(v) => update("database.retentionDays", v)}
          />
        </Field>

      </Card>
    </>
  );
}

function StationsSection() {
  const D = window.DASH_DATA;
  const [editingId, setEditingId] = sState(null);
  const [adding, setAdding] = sState(false);

  // Form states
  const [formId, setFormId] = sState('');
  const [formName, setFormName] = sState('');
  const [formLocation, setFormLocation] = sState('');
  const [formMoUuid, setFormMoUuid] = sState('');
  const [formDeviceUuid, setFormDeviceUuid] = sState('');

  // Device list from local backend proxy (one entry per physical logger)
  const [deviceList, setDeviceList] = sState([]);
  const [loadingDevices, setLoadingDevices] = sState(false);
  const [deviceError, setDeviceError] = sState(null);
  const [saveStationError, setSaveStationError] = sState(null);

  sEff(() => {
    if (!editingId && !adding) return;
    setLoadingDevices(true);
    setDeviceError(null);
    fetch('/api/testo/devices')
      .then(res => {
        if (!res.ok) throw new Error('API-Fehler oder API-Schlüssel nicht konfiguriert');
        return res.json();
      })
      .then(data => {
        setDeviceList(data || []);
        setLoadingDevices(false);
      })
      .catch(err => {
        setDeviceError(err.message);
        setLoadingDevices(false);
      });
  }, [editingId, adding]);

  function startEdit(s) {
    setEditingId(s.id);
    setAdding(false);
    setFormId(s.id);
    setFormName(s.name);
    setFormLocation(s.location || '');
    setFormMoUuid(s.mo_uuid || '');
    setFormDeviceUuid(s.device_uuid || '');
  }

  function startAdd() {
    setAdding(true);
    setEditingId(null);
    setFormId('');
    setFormName('');
    setFormLocation('');
    setFormMoUuid('');
    setFormDeviceUuid('');
  }

  function cancelEdit() {
    setEditingId(null);
    setAdding(false);
    setSaveStationError(null);
  }

  function saveEdit() {
    setSaveStationError(null);
    const payload = {
      id: formId,
      name: formName,
      location: formLocation,
      mo_uuid: formMoUuid || null,
      device_uuid: formDeviceUuid || null
    };

    fetch('/api/stations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => {
        // H4: check res.ok before treating as success; on 4xx/5xx surface error inline
        if (!res.ok) {
          return res.json().catch(() => ({})).then(body => {
            setSaveStationError(body.error || `Fehler ${res.status}: Speichern fehlgeschlagen`);
          });
        }
        return res.json().then(() => {
          // Force reload dashboard data only on success
          if (window.DASH_DATA && window.DASH_DATA.forceApiRefresh) {
            window.DASH_DATA.forceApiRefresh();
          }
          setEditingId(null);
          setAdding(false);
        });
      })
      .catch(err => {
        console.error('Error saving station:', err);
        setSaveStationError('Netzwerkfehler: Messstelle konnte nicht gespeichert werden.');
      });
  }

  function deleteStation(sid, name) {
    if (confirm(`Messstelle "${name}" (${sid}) wirklich löschen? Alle zugehörigen Verlaufsdaten werden unwiderruflich aus der Datenbank entfernt.`)) {
      fetch(`/api/stations/${sid}`, { method: 'DELETE' })
        .then(res => {
          // H4: check res.ok; on failure alert the user and do not refresh (nothing was deleted)
          if (!res.ok) {
            return res.json().catch(() => ({})).then(body => {
              alert(`Löschen fehlgeschlagen: ${body.error || `Fehler ${res.status}`}`);
            });
          }
          return res.json().then(() => {
            if (window.DASH_DATA && window.DASH_DATA.forceApiRefresh) {
              window.DASH_DATA.forceApiRefresh();
            }
          });
        })
        .catch(err => {
          console.error('Error deleting station:', err);
          alert('Netzwerkfehler: Messstelle konnte nicht gelöscht werden.');
        });
    }
  }

  if (editingId || adding) {
    return (
      <>
        <SectionHead
          title={adding ? "Messstelle hinzufügen" : `Messstelle bearbeiten: ${formName}`}
          sub="Zuweisung zu einem physikalischen Sensor in der testo Cloud konfigurieren."
        />
        <Card>
          <Field label="Messstellen-ID (Kürzel)" hint="Eindeutiger Bezeichner, z. B. 'living' oder 'bedroom'. Darf nach Erstellung nicht geändert werden.">
            <input
              type="text"
              value={formId}
              onChange={(e) => setFormId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
              disabled={!adding}
              placeholder="z. B. küche"
            />
          </Field>
          <Field label="Anzeigename" hint="Name der Messstelle im Dashboard (z. B. 'Küche').">
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="z. B. Küche"
            />
          </Field>
          <Field label="Standort / Beschreibung" hint="Genaue Ortsangabe (z. B. 'EG · Nordseite').">
            <input
              type="text"
              value={formLocation}
              onChange={(e) => setFormLocation(e.target.value)}
              placeholder="z. B. EG · Nordseite"
            />
          </Field>
          <Field label="Testo Gerät (Logger)" hint="Verbindet diese Messstelle mit einem physikalischen Logger aus Ihrem testo Account. Alle Sensoren/Kanäle des Geräts fließen in die Metriken.">
            {loadingDevices ? (
              <div style={{ padding: '8px 0' }}><Spinner /> Lade Geräte aus testo Cloud...</div>
            ) : deviceError ? (
              <div style={{ color: 'var(--alarm)', fontSize: '12px', padding: '8px 0' }}>
                ⚠️ {deviceError}
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Bitte stellen Sie sicher, dass Ihr API-Schlüssel in der Rubrik 'API & Verbindung' korrekt eingetragen ist.
                </div>
              </div>
            ) : (
              <select
                value={formDeviceUuid}
                onChange={(e) => setFormDeviceUuid(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 11px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-strong)',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  outline: 'none',
                  fontSize: '13px'
                }}
              >
                <option value="">-- Kein Gerät zugewiesen (statische Simulation) --</option>
                {deviceList.map(dev => (
                  <option key={dev.device_uuid} value={dev.device_uuid}>
                    {dev.name}{dev.serial_no ? ` · ${dev.serial_no}` : ''} ({dev.device_uuid.substring(0, 8)}...)
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Geräte-UUID (manuell)" hint="Die device_uuid des Loggers. Wird bei Geräteauswahl automatisch befüllt; nur für manuelle Overrides ändern.">
            <input
              type="text"
              value={formDeviceUuid}
              onChange={(e) => setFormDeviceUuid(e.target.value)}
              placeholder="Wird automatisch befüllt oder manuell eingeben"
            />
          </Field>
          
          {/* H4: inline error — shown when saveEdit gets a non-ok response; dialog stays open */}
          {saveStationError && (
            <div style={{ color: 'var(--alarm)', fontSize: '12px', marginTop: '12px', padding: '8px 10px', background: 'color-mix(in srgb, var(--alarm) 10%, transparent)', borderRadius: 'var(--radius-sm)', border: '1px solid color-mix(in srgb, var(--alarm) 30%, transparent)' }}>
              ⚠️ {saveStationError}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
            <button className="btn ghost" onClick={cancelEdit}>Abbrechen</button>
            <button className="btn primary" onClick={saveEdit} disabled={!formId || !formName}>Zuweisung Speichern</button>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
        <SectionHead title="Messstellen & Zuweisungs-Manager" sub="Verbinden Sie lokale Dashboard-Räume mit Ihren physikalischen Testo Cloud-Fühlern." />
        <button className="btn primary" onClick={startAdd}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ marginRight: '6px' }}><path d="M7 2v10M2 7h10"/></svg>
          Messstelle hinzufügen
        </button>
      </div>

      <Card noPad>
        <table className="settings-table">
          <thead>
            <tr>
              <th>Messstelle / Details</th>
              <th>Status</th>
              <th>Verbindung</th>
              <th>API-Zuweisung</th>
              <th className="th-right" style={{ paddingRight: '24px' }}>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {D.stationOrder.map((sid) => {
              const s = D.stations[sid];
              if (!s) return null;
              const hasAssignment = !!(s.mo_uuid || s.device_uuid);

              return (
                <tr key={sid}>
                  <td>
                    <div className="cell-name">
                      <span className={`station-dot ${s.online ? "on" : "off"}`} />
                      <div>
                        <div className="cell-title">{s.name}</div>
                        <div className="cell-sub">
                          {s.location} · <span className="mono">{sid}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={s.online ? "ok" : "err"} label={s.online ? "Online" : "Offline"} />
                  </td>
                  <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {s.battery !== null ? "🔋 " + s.battery + "%" : "🔋 —"}
                    <br />
                    {s.signal !== null ? "📶 " + s.signal + "%" : "📶 —"}
                  </td>
                  <td>
                    {hasAssignment ? (
                      <div>
                        <div style={{ fontSize: '12px', fontWeight: '500', color: 'var(--text)' }}>
                          Messobjekt: <span className="mono" style={{ fontSize: '11px', color: 'var(--accent-dark)' }}>{s.mo_uuid ? s.mo_uuid.substring(0, 8) : '—'}...</span>
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          Sensor: <span className="mono">{s.device_uuid ? s.device_uuid.substring(0, 8) : '—'}...</span>
                        </div>
                      </div>
                    ) : (
                      <span style={{ fontStyle: 'italic', color: 'var(--text-faint)' }}>Nur lokale Simulation</span>
                    )}
                  </td>
                  <td className="td-right" style={{ paddingRight: '24px' }}>
                    <div style={{ display: 'inline-flex', gap: '6px' }}>
                      <button className="btn ghost" title="Zuweisung & Details bearbeiten" onClick={() => startEdit(s)}>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 10.5V12h1.5L11 4.5 9.5 3 2 10.5z"/></svg>
                        Bearbeiten
                      </button>
                      <button className="btn ghost" style={{ color: 'var(--alarm)' }} title="Löschen" onClick={() => deleteStation(sid, s.name)}>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3l8 8M11 3l-8 8"/></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function AdvancedSection({ settings, update, onReset, systemStatus }) {
  return (
    <>
      <SectionHead title="Erweitert" sub="Zurücksetzen und Über das System." />

      <Card>
        <div className="card-title">Zurücksetzen</div>
        <div className="card-sub" style={{ marginBottom: 12 }}>
          Setzt alle Einstellungen auf Werkseinstellungen zurück. Layout und Schwellwerte bleiben erhalten.
        </div>
        <button className="btn danger" onClick={() => { if (confirm("Einstellungen auf Werkseinstellungen zurücksetzen?")) onReset(); }}>
          Auf Werkseinstellungen zurücksetzen
        </button>
      </Card>

      <Card>
        <div className="card-title">Über</div>
        <div className="kv-grid two-col">
          <KV label="Version"    value={`Klima Dashboard ${systemStatus?.appVersion || '—'}`} />
          <KV label="API"        value="v3 · Testo Smart Connect" />
          <KV label="Datenbank"  value="SQLite 3" />
          <KV label="Lizenz"     value="Open Source" />
          <KV label="Support"    value="https://github.com/dniehof/testo-smart-abruf" />
        </div>
      </Card>
    </>
  );
}

// ---------- Primitives ----------
function SectionHead({ title, sub, compact }) {
  return (
    <div className={`section-head ${compact ? "compact" : ""}`}>
      <h2>{title}</h2>
      {sub && <p>{sub}</p>}
    </div>
  );
}

function Card({ children, noPad }) {
  return <div className={`card ${noPad ? "no-pad" : ""}`}>{children}</div>;
}

function Field({ label, hint, children }) {
  return (
    <div className="setting-field">
      <div className="setting-field-label">
        <span className="lbl">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="setting-field-control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, labelOn = "An", labelOff = "Aus" }) {
  return (
    <button className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked}>
      <span className="toggle-knob" />
      <span className="toggle-label">{checked ? labelOn : labelOff}</span>
    </button>
  );
}

function SegmentedControl({ value, options, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusPill({ status }) {
  return (
    <span className={`status-pill st-${status}`}>
      <span className="status-pill-dot" />
      {status === "ok"   && "OK"}
      {status === "warn" && "Warnung"}
      {status === "err"  && "Fehler"}
    </span>
  );
}

function StatusBadge({ status, label }) {
  return (
    <span className={`status-badge st-${status}`}>
      <span className="status-badge-dot" />{label}
    </span>
  );
}

function HealthCard({ status, label, value, sub, icon, progress, cause, causeRaw, actions }) {
  return (
    <div className={`health-card st-${status}`}>
      <div className="hc-top">
        <span className="hc-icon"><NavIcon id={icon} /></span>
        {(status === "ok" || status === "warn" || status === "err") && (
          <StatusBadge status={status} label={status === "ok" ? "OK" : status === "warn" ? "Achtung" : "Fehler"} />
        )}
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

function OpRow({ status, label, detail }) {
  return (
    <div className={`op-row st-${status}`}>
      {status === "running" ? <Spinner /> : <span className={`op-dot st-${status}`} />}
      <div className="op-text">
        <div className="op-label">{label}</div>
        <div className="op-detail">{detail}</div>
      </div>
    </div>
  );
}

function KV({ label, value }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="spinner" width="14" height="14" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.8"/>
      <path d="M7 2a5 5 0 0 1 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function NavIcon({ id }) {
  switch (id) {
    case "grid":    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="1"/><rect x="8" y="8" width="4.5" height="4.5" rx="1"/></svg>;
    case "plug":    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M5 1v3M9 1v3M3.5 4h7v3a3.5 3.5 0 0 1-7 0V4zM7 10.5V13"/></svg>;
    case "db":      return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><ellipse cx="7" cy="3" rx="5" ry="1.6"/><path d="M2 3v8a5 1.6 0 0 0 10 0V3M2 7a5 1.6 0 0 0 10 0"/></svg>;
    case "node":    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="3" cy="3" r="1.5"/><circle cx="11" cy="3" r="1.5"/><circle cx="3" cy="11" r="1.5"/><circle cx="11" cy="11" r="1.5"/><circle cx="7" cy="7" r="1.5"/><path d="M4.4 4.4 5.6 5.6M9.6 4.4 8.4 5.6M4.4 9.6 5.6 8.4M9.6 9.6 8.4 8.4"/></svg>;
    case "bell":    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M3 10V7a4 4 0 0 1 8 0v3l1 1.5H2zM5.5 12a1.5 1.5 0 0 0 3 0"/></svg>;
    case "sliders": return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 4h10M2 7h10M2 10h10"/><circle cx="4" cy="4" r="1.4" fill="white"/><circle cx="9" cy="7" r="1.4" fill="white"/><circle cx="5.5" cy="10" r="1.4" fill="white"/></svg>;
    case "bolt":    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M8 1 3 8h3l-1 5 5-7H7z"/></svg>;
    case "disk":    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1.5" y="2" width="11" height="10" rx="1.5"/><rect x="4" y="2" width="6" height="4"/><circle cx="7" cy="9" r="1.4"/></svg>;
    case "archive":   return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1.5" y="2.5" width="11" height="3" rx="0.5"/><path d="M2.5 5.5h9V12h-9zM5.5 8h3"/></svg>;
    case "download":  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M7 1v8M4 6l3 3 3-3"/><path d="M1.5 10v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/></svg>;
    default:        return null;
  }
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} kB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

Object.assign(window, { SettingsPage });
