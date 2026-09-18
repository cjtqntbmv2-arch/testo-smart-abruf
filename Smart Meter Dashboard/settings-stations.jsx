// Sektion "Messstellen" der Einstellungsseite - Zuweisung lokaler Dashboard-Raeume
// zu physikalischen testo-Cloud-Fuehlern. Bis 0.16.1 lag sie in settings.jsx.
//
// Warum der Schnitt hier faellt: die Sektion nimmt keine Props, teilt keinen State mit
// SettingsPage und liest ihre Daten direkt aus window.DASH_DATA. Die einzige Kopplung
// waren die Hook-Aliasse von settings.jsx - unten durch eigene ersetzt.
//
// Sie aktualisiert sich NICHT selbst: nach Anlegen/Loeschen ruft sie
// DASH_DATA.forceApiRefresh(), und SettingsPage rendert wegen seines
// DASH_DATA.subscribe-Abos neu. Diese Kopplung laeuft ueber Eltern-Render,
// nicht ueber die Dateigrenze - hier also kein eigenes Abo anlegen.
//
// Eigenes Alias-Praefix m* (Messstellen) - Pflicht: bare useState kollidiert mit
// charts.jsx und erzeugt eine weisse Seite. Vergeben sind bare, a*, s*, t*, h*, ss*, *E.
const { useState: mState, useEffect: mEff } = React;

function StationsSection() {
  const D = window.DASH_DATA;
  const [editingId, setEditingId] = mState(null);
  const [adding, setAdding] = mState(false);

  // Form states
  const [formId, setFormId] = mState('');
  const [formName, setFormName] = mState('');
  const [formLocation, setFormLocation] = mState('');
  const [formMoUuid, setFormMoUuid] = mState('');
  const [formDeviceUuid, setFormDeviceUuid] = mState('');
  // Auswahlfeld und Freitextfeld teilen formDeviceUuid; gespeichert und verglichen wird getrimmt
  // (der Server trimmt ebenso, leer = kein Geraet).
  const deviceUuid = formDeviceUuid.trim();

  // Device list from local backend proxy (one entry per physical logger)
  const [deviceList, setDeviceList] = mState([]);
  const [loadingDevices, setLoadingDevices] = mState(false);
  const [deviceError, setDeviceError] = mState(null);
  const [saveStationError, setSaveStationError] = mState(null);

  mEff(() => {
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
      device_uuid: deviceUuid || null
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
                value={deviceUuid}
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
                {/* D7: Eine UUID, die die Geraeteliste nicht enthaelt (von Hand getippt, oder die Cloud
                    listet das Geraet nicht mehr), bekommt eine eigene Option. Ohne sie waehlt React bei
                    fehlendem Treffer sichtbar die erste Option ("Kein Geraet"), gespeichert wird aber
                    die UUID. */}
                {deviceUuid && !deviceList.some(dev => dev.device_uuid === deviceUuid) && (
                  <option value={deviceUuid}>Manuell eingetragen (nicht in der Geräteliste): {deviceUuid}</option>
                )}
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
