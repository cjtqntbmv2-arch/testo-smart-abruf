// Smart Meter Dashboard/export-panel.jsx
// Manual CSV export dialog + backup-status block. Mounted as a settings section.
const { useState: useStateE, useEffect: useEffectE, useMemo: useMemoE } = React;

function ExportPanel() {
  const [meta, setMeta] = useStateE([]);
  const [stationIds, setStationIds] = useStateE([]);
  const [metricKeys, setMetricKeys] = useStateE([]);
  const [preset, setPreset] = useStateE('lastMonth');
  const [fromStr, setFromStr] = useStateE('');
  const [toStr, setToStr] = useStateE('');
  const [includeEvents, setIncludeEvents] = useStateE(false);
  const [dialect, setDialect] = useStateE('de');
  const [busy, setBusy] = useStateE(false);
  const [error, setError] = useStateE(null);

  useEffectE(() => {
    DASH_DATA.fetchExportMetadata().then(m => {
      setMeta(m);
      setStationIds(m.map(s => s.id)); // default: all stations
    }).catch(e => setError(e.message));
    // default range = last month
    const r = window.presetRange('lastMonth', Date.now());
    setFromStr(new Date(r.fromTs).toISOString().slice(0, 10));
    setToStr(new Date(r.toTs).toISOString().slice(0, 10));
    // default dialect from settings
    fetch('/api/settings').then(r => r.json()).then(s => setDialect(s.csv_format || 'de')).catch(() => {});
  }, []);

  const availMetrics = useMemoE(() => window.unionMetrics(meta, stationIds), [meta, stationIds]);

  function applyPreset(key) {
    setPreset(key);
    if (key === 'custom') return;
    const r = window.presetRange(key, Date.now());
    setFromStr(new Date(r.fromTs).toISOString().slice(0, 10));
    setToStr(new Date(r.toTs).toISOString().slice(0, 10));
  }
  function toggle(list, setList, id) {
    setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  }

  async function doExport() {
    setError(null); setBusy(true);
    try {
      const fromTs = new Date(fromStr + 'T00:00:00').getTime();
      const toTs = new Date(toStr + 'T23:59:59').getTime();
      if (!stationIds.length) throw new Error('Bitte mindestens eine Messstelle wählen');
      if (!(fromTs <= toTs)) throw new Error('Zeitraum ungültig (von > bis)');
      const payload = window.buildExportPayload({ stationIds, metricKeys, fromTs, toTs, includeEvents, dialect });
      await DASH_DATA.postExport(payload);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="settings-section export-panel">
      <h3>Datenexport — Messwerte als CSV</h3>
      {error && <div className="error-banner">{error}</div>}

      <div className="label">Messstellen</div>
      {meta.map(s => (
        <label key={s.id} style={{ display: 'block' }}>
          <input type="checkbox" checked={stationIds.includes(s.id)} onChange={() => toggle(stationIds, setStationIds, s.id)} /> {s.name}
        </label>
      ))}

      <div className="label">Messgrößen <span style={{ opacity: .6 }}>(leer = alle)</span></div>
      {availMetrics.map(m => (
        <label key={m.key} style={{ display: 'block' }}>
          <input type="checkbox" checked={metricKeys.includes(m.key)} onChange={() => toggle(metricKeys, setMetricKeys, m.key)} /> {m.label || m.key} [{m.unit}]
        </label>
      ))}

      <div className="label">Zeitraum</div>
      {['last7','last30','thisMonth','lastMonth','custom'].map(k => (
        <button key={k} className={preset === k ? 'preset active' : 'preset'} onClick={() => applyPreset(k)}>{k}</button>
      ))}
      <div>
        Von <input type="date" value={fromStr} onChange={e => { setFromStr(e.target.value); setPreset('custom'); }} />
        Bis <input type="date" value={toStr} onChange={e => { setToStr(e.target.value); setPreset('custom'); }} />
      </div>

      <div className="label">CSV-Format</div>
      <label><input type="radio" checked={dialect === 'de'} onChange={() => setDialect('de')} /> Deutsch (Excel)</label>
      <label><input type="radio" checked={dialect === 'rfc'} onChange={() => setDialect('rfc')} /> International (RFC)</label>

      <label style={{ display: 'block', marginTop: 8 }}>
        <input type="checkbox" checked={includeEvents} onChange={e => setIncludeEvents(e.target.checked)} /> Meldungen &amp; Alarme zusätzlich exportieren
      </label>

      <p style={{ fontSize: 13, opacity: .7 }}>Mehrere Messstellen → ZIP (eine CSV je Stelle). Genau eine Stelle ohne Meldungen → einzelne CSV.</p>
      <button disabled={busy} onClick={doExport}>{busy ? 'Export läuft…' : '⬇ Exportieren'}</button>
    </div>
  );
}
// Bare global function declaration — matches every other component (SettingsPage,
// SystemSummaryPanel, App). Babel concatenates all .jsx into one global scope, so NO
// `window.ExportPanel = …` and NO `window.ExportPanel ?` guard (those are non-idiomatic here
// and the guard would silently render null instead of surfacing a load error).
