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

  const PRESET_LABELS = { last7: 'Letzte 7 Tage', last30: 'Letzte 30 Tage', thisMonth: 'Aktueller Monat', lastMonth: 'Letzter Monat', custom: 'Benutzerdefiniert' };

  async function doExport() {
    setError(null); setBusy(true);
    try {
      const fromTs = new Date(fromStr + 'T00:00:00').getTime();
      const toTs = new Date(toStr + 'T23:59:59.999').getTime();
      if (!stationIds.length) throw new Error('Bitte mindestens eine Messstelle wählen');
      if (!(fromTs <= toTs)) throw new Error('Zeitraum ungültig (von > bis)');
      const payload = window.buildExportPayload({ stationIds, metricKeys, fromTs, toTs, includeEvents, dialect });
      await DASH_DATA.postExport(payload);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <SectionHead
        title="Datenexport — Messwerte als CSV"
        sub="Messwerte und optional Meldungen je Messstelle als CSV exportieren. Mehrere Messstellen werden als ZIP gebündelt."
      />

      {error && (
        <div className="export-error">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>{error}</span>
        </div>
      )}

      <Card>
        <Field label="Messstellen" hint="Welche Messstellen exportiert werden. Standard: alle.">
          <div className="export-checks">
            {meta.map(s => (
              <label key={s.id} className="export-check">
                <input type="checkbox" checked={stationIds.includes(s.id)} onChange={() => toggle(stationIds, setStationIds, s.id)} />
                <span>{s.name}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Messgrößen" hint="Leer lassen, um alle verfügbaren Messgrößen zu exportieren.">
          <div className="export-checks">
            {availMetrics.map(m => (
              <label key={m.key} className="export-check">
                <input type="checkbox" checked={metricKeys.includes(m.key)} onChange={() => toggle(metricKeys, setMetricKeys, m.key)} />
                <span>{m.label || m.key} <span className="export-unit">[{m.unit}]</span></span>
              </label>
            ))}
          </div>
        </Field>
      </Card>

      <Card>
        <Field label="Zeitraum" hint="Schnellauswahl oder eigener Bereich (von/bis).">
          <div className="export-presets">
            {['last7','last30','thisMonth','lastMonth','custom'].map(k => (
              <button key={k} type="button" className={preset === k ? 'export-preset active' : 'export-preset'} onClick={() => applyPreset(k)}>{PRESET_LABELS[k]}</button>
            ))}
          </div>
          <div className="export-range">
            <label className="export-range-field">
              <span>Von</span>
              <input type="date" value={fromStr} onChange={e => { setFromStr(e.target.value); setPreset('custom'); }} />
            </label>
            <label className="export-range-field">
              <span>Bis</span>
              <input type="date" value={toStr} onChange={e => { setToStr(e.target.value); setPreset('custom'); }} />
            </label>
          </div>
        </Field>
      </Card>

      <Card>
        <Field label="CSV-Format" hint="Deutsch (Excel) nutzt ; und Komma; International (RFC) nutzt , und Punkt.">
          <SegmentedControl
            value={dialect}
            options={[{ value: 'de', label: 'Deutsch (Excel)' }, { value: 'rfc', label: 'International (RFC)' }]}
            onChange={v => setDialect(v)}
          />
        </Field>
        <Field label="Meldungen & Alarme" hint="Zusätzlich eine Meldungs-CSV je Messstelle exportieren (erzwingt ZIP-Ausgabe).">
          <Toggle checked={includeEvents} onChange={setIncludeEvents} labelOn="Ein" labelOff="Aus" />
        </Field>
      </Card>

      <div className="export-actions">
        <p className="export-hint">Mehrere Messstellen → ZIP (eine CSV je Stelle). Genau eine Stelle ohne Meldungen → einzelne CSV.</p>
        <button className="btn primary" disabled={busy} onClick={doExport}>
          {busy
            ? <><Spinner /> Export läuft…</>
            : <><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 1v8M4 6l3 3 3-3"/><path d="M1.5 10v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/></svg> Exportieren</>}
        </button>
      </div>
    </>
  );
}
// Bare global function declaration — matches every other component (SettingsPage,
// SystemSummaryPanel, App). Babel concatenates all .jsx into one global scope, so NO
// `window.ExportPanel = …` and NO `window.ExportPanel ?` guard (those are non-idiomatic here
// and the guard would silently render null instead of surfacing a load error).
