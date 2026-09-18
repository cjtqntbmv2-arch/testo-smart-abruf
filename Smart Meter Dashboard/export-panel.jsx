// Smart Meter Dashboard/export-panel.jsx
// Manueller CSV-Export-Dialog + Datensicherung (Ein/Aus, Pfad, Status, „Jetzt sichern“). Als Settings-Sektion eingehängt.
const { useState: useStateE, useEffect: useEffectE, useMemo: useMemoE } = React;

// systemStatus/onRefresh kommen aus dem 10-s-Poll der Einstellungsseite (settings.jsx).
function ExportPanel({ systemStatus, onRefresh }) {
  const [meta, setMeta] = useStateE([]);
  const [stationIds, setStationIds] = useStateE([]);
  const [metricKeys, setMetricKeys] = useStateE([]);
  const [preset, setPreset] = useStateE('lastMonth');
  const [fromStr, setFromStr] = useStateE('');
  const [toStr, setToStr] = useStateE('');
  const [includeEvents, setIncludeEvents] = useStateE(false);
  const [dialect, setDialect] = useStateE('de');
  // Hat der Bediener den Dialekt fuer DIESEN Export selbst gesetzt? Danach zieht ihn
  // ein Umstellen des Dauerformats (Backup-Sektion) nicht mehr mit.
  const [dialectTouched, setDialectTouched] = useStateE(false);
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
    // Voreingestelltes CSV-Format. Scheitert das Laden, bleibt 'de' stehen — das darf
    // NICHT still passieren, sonst bekommt ein Nutzer mit RFC-Einstellung kommentarlos
    // das falsche Format angeboten.
    DASH_DATA.fetchSettings()
      .then(s => setDialect(s.csv_format || 'de'))
      .catch(() => setError('CSV-Format konnte nicht geladen werden — es ist Deutsch (Semikolon) vorausgewählt, bitte vor dem Export prüfen.'));
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
        <Field label="CSV-Format dieses Exports" hint="Gilt nur für den Export unten und wird nicht gespeichert — vorbelegt aus dem Format der Monats-Backups. Deutsch (Excel) nutzt ; und Komma; International (RFC) nutzt , und Punkt.">
          <SegmentedControl
            value={dialect}
            options={[{ value: 'de', label: 'Deutsch (Excel)' }, { value: 'rfc', label: 'International (RFC)' }]}
            onChange={v => { setDialect(v); setDialectTouched(true); }}
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
      <BackupSettings dialectTouched={dialectTouched} onDialect={setDialect} systemStatus={systemStatus} onRefresh={onRefresh} />
    </>
  );
}
function BackupSettings({ dialectTouched, onDialect, systemStatus, onRefresh }) {
  const [enabled, setEnabled] = useStateE(true);
  const [dir, setDir] = useStateE('');
  const [pathErr, setPathErr] = useStateE(null);
  const [format, setFormat] = useStateE('de'); // Dauerformat der Backups (csv_format)
  const [formatErr, setFormatErr] = useStateE(null);
  const [settingsErr, setSettingsErr] = useStateE(null);
  const [savedFlash, setSavedFlash] = useStateE(false);
  const [busy, setBusy] = useStateE(false);
  const [pollSec, setPollSec] = useStateE(900); // Poll-Intervall für den „erster Lauf"-Hinweis
  const [loaded, setLoaded] = useStateE(false); // erst true nach echtem fetchSettings-Erfolg
  const [running, setRunning] = useStateE(false); // "Jetzt sichern" läuft — Knopf gesperrt
  const [runMsg, setRunMsg] = useStateE(null);    // { ok, text } des letzten Knopfdrucks, kurzlebig

  // Der Zustand kommt aus dem 10-s-Poll der Einstellungsseite; nach einer eigenen Aktion
  // sofort nachladen, statt bis zu 10 s alten Stand zu zeigen.
  const refresh = () => { if (onRefresh) onRefresh(); };

  useEffectE(() => {
    // Scheitert das Laden, zeigten Schalter und Pfad vorher stumm die Standardwerte
    // (Ein, leerer Pfad) statt des echten Zustands — das muss sichtbar sein. Zusätzlich
    // zur Fehleranzeige bleiben Schalter und Speichern-Knopf gesperrt (loaded bleibt
    // false), sonst schreibt ein Klick genau diese Standardwerte über den echten,
    // bereits gespeicherten Zustand (Pfad geleert bzw. Backup unbeabsichtigt umgeschaltet).
    DASH_DATA.fetchSettings()
      .then(s => { setEnabled(s.backup_enabled !== false); setDir(s.backup_dir || ''); setFormat(s.csv_format || 'de'); setPollSec(s.poll_interval_sec || 900); setSettingsErr(null); setLoaded(true); })
      .catch(() => setSettingsErr('Backup-Einstellungen konnten nicht geladen werden — Schalter und Pfad zeigen nur Standardwerte, nicht den echten Zustand. Bedienung ist deshalb gesperrt (Seite neu laden zum erneuten Versuch).'));
  }, []);

  async function toggleEnabled(next) {
    if (busy || !loaded) return;       // Doppelklick/Race-Schutz + gesperrt, bis der echte Zustand geladen ist
    setBusy(true);
    setEnabled(next);                  // optimistisch
    try { await DASH_DATA.saveSettings({ backup_enabled: next }); }
    catch (_) { setEnabled(!next); }   // bei Fehler zurücksetzen
    finally { setBusy(false); refresh(); }
  }

  async function savePath() {
    setPathErr(null); setBusy(true);
    try {
      await DASH_DATA.saveSettings({ backup_dir: dir });
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000);
      refresh();
    } catch (e) { setPathErr(e.message); }
    finally { setBusy(false); }
  }

  // "Jetzt sichern" (POST /api/backup): ZIPs + Datenbank-Abzug sofort, auch bei
  // ausgeschaltetem Automatik-Backup. Die Rückfrage nennt, was überschrieben wird — nach
  // einem Datenverlust ersetzte ein Lauf den heutigen Abzug durch den beschädigten Stand.
  // Das Ergebnis steht dauerhaft im Statuskasten (sofort nachgeladen); die Meldung am
  // Knopf verschwindet nach 6 s, damit sie nie neben einem neueren Zustand stehen bleibt.
  async function runNow() {
    if (running) return;
    if (!confirm('Jetzt sichern?\n\nDer Datenbank-Abzug von heute wird durch den jetzigen Stand ersetzt; ältere Abzüge bleiben erhalten.\n\nNach einem Datenverlust nicht sichern — der beschädigte Stand würde den heutigen Abzug ersetzen.')) return;
    setRunning(true); setRunMsg(null);
    let msg;
    try {
      const r = await DASH_DATA.runBackup();
      msg = { ok: true, text: `Gesichert: ${r.snapshot}${r.written ? `, ${r.written} ZIP neu` : ''}` };
    } catch (e) {
      msg = { ok: false, text: e.message };
    }
    setRunMsg(msg);
    setRunning(false);
    refresh();
    setTimeout(() => setRunMsg(m => (m === msg ? null : m)), 6000);
  }

  async function changeFormat(next) {
    if (busy || !loaded) return;   // gleiche Sperre wie der Schalter: kein Schreiben ueber ungeladenen Zustand
    const d = window.applyCsvFormatChange(next, { archiveFormat: format, dialectTouched });
    if (!d.save) return;
    setFormatErr(null); setBusy(true);
    setFormat(d.archiveFormat);              // optimistisch
    if (d.dialect) onDialect(d.dialect);     // Vorauswahl des Export-Dialogs mitziehen
    try { await DASH_DATA.saveSettings({ csv_format: d.archiveFormat }); }
    catch (e) {
      // Nur das Dauerformat faellt zurueck. Die Dialog-Vorauswahl bleibt auf dem eben
      // angeklickten Wert stehen: sie betrifft ausschliesslich den naechsten manuellen
      // Export, nicht das Archiv, und der Bediener hat genau diesen Wert gewaehlt.
      setFormat(format); setFormatErr(e.message);
    }
    finally { setBusy(false); }
  }

  const status = (systemStatus && systemStatus.backup) || null; // backup-Block aus /api/system/status
  const effectiveDir = (status && status.dir) || null; // aufgelöster Zielordner (gesetzter Pfad ODER Default)
  const health = (status && status.health) || {};
  // Lokales enabled (optimistisch geschaltet) statt des bis zu 10 s alten Poll-Werts.
  const state = window.explainBackupStatus({ enabled, health });

  return (
    <>
      <SectionHead
        title="Datensicherung"
        sub="Sichert täglich die ganze Datenbank (Unterordner „datenbank“, die sieben neuesten Tage bleiben) und je Messstelle jeden abgeschlossenen Monat als CSV-ZIP. Läuft selbsttätig im ersten Sync des Tages."
      />

      {settingsErr && (
        <div className="export-error">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>{settingsErr}</span>
        </div>
      )}

      <Card>
        <Field label="Automatisches Backup" hint="Täglichen Lauf (Datenbank-Abzug und Monats-ZIPs) ein- oder ausschalten.">
          {/* Toggle (ui-kit.jsx) kennt kein disabled-Prop — die Sperre sitzt im Klick-Handler
              selbst (toggleEnabled), pointerEvents hier macht sie zusätzlich sichtbar/prüfbar. */}
          <span style={loaded ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
            <Toggle checked={enabled} onChange={toggleEnabled} labelOn="Ein" labelOff="Aus" />
          </span>
        </Field>
        <Field label="Speicherpfad" hint="Zielordner für Datenbank-Abzüge und Backup-ZIPs. Leer = Standardordner.">
          <div className="backup-path">
            <input
              type="text"
              className="backup-path-input"
              value={dir}
              placeholder="Leer lassen für Standardordner"
              onChange={e => { setDir(e.target.value); setPathErr(null); }}
            />
            <button className="btn" disabled={busy || !loaded} onClick={savePath}>
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
        <Field label="CSV-Format der Monats-Backups" hint="Wird dauerhaft gespeichert und gilt für jede automatische Sicherung. Bereits geschriebene ZIPs bleiben unverändert.">
          {/* SegmentedControl (ui-kit.jsx) kennt wie Toggle kein disabled-Prop — die Sperre
              sitzt in changeFormat, pointerEvents macht sie sichtbar. */}
          <span style={loaded ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
            <SegmentedControl
              value={format}
              options={[{ value: 'de', label: 'Deutsch (Excel)' }, { value: 'rfc', label: 'International (RFC)' }]}
              onChange={changeFormat}
            />
          </span>
          {formatErr && (
            <div className="export-error">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span>{formatErr}</span>
            </div>
          )}
        </Field>
      </Card>

      <Card>
        {!status ? (
          <p className="backup-status-msg muted">Status wird geladen …</p>
        ) : !enabled ? (
          <p className="backup-status-msg muted">Automatisches Backup ist ausgeschaltet. „Jetzt sichern“ sichert trotzdem einmalig.</p>
        ) : !health.status ? (
          <p className="backup-status-msg muted">Noch kein Backup gelaufen — der erste Lauf erfolgt beim nächsten Sync (spätestens in {Math.max(1, Math.round(pollSec / 60))} Min).</p>
        ) : (
          <div className="backup-status">
            <div className="backup-status-head">
              <span className={`status-pill st-${state.status}`}>
                <span className="status-pill-dot" />
                {state.label}
              </span>
              {state.cause && <span className="backup-status-err">{state.cause}</span>}
            </div>
            <div className="backup-status-rows">
              <div><span className="k">Zielordner</span><span className="v">{effectiveDir || '—'}</span></div>
              <div><span className="k">Letzter Datenbank-Abzug</span><span className="v">{health.lastDbSnapshot ? `${health.lastDbSnapshot} · ${DASH_DATA.formatRelative(Date.parse(health.lastDbSnapshotAt))}` : '—'}</span></div>
              <div><span className="k">Letzter fehlerfreier Lauf</span><span className="v">{status.lastScanDate || '—'}</span></div>
              <div><span className="k">Zuletzt geschrieben</span><span className="v">{health.lastZip ? (health.written ? `${health.lastZip} (${health.written})` : health.lastZip) : '—'}</span></div>
            </div>
          </div>
        )}
        <div className="export-actions" style={{ marginTop: 14 }}>
          <p className="export-hint">Sichert sofort (Datenbank-Abzug und fehlende Monats-ZIPs), etwa vor einem Update oder nach behobenem Fehler. Ersetzt den Abzug von heute.</p>
          <button className="btn" disabled={running} onClick={runNow}>
            {running ? <><Spinner /> Sichert…</> : 'Jetzt sichern'}
          </button>
        </div>
        {runMsg && (
          <p className={runMsg.ok ? 'backup-status-msg' : 'backup-status-err'} style={{ margin: '8px 0 0' }}>{runMsg.text}</p>
        )}
      </Card>
    </>
  );
}
// Bare global function declaration — matches every other component (SettingsPage,
// SystemSummaryPanel, App). Babel concatenates all .jsx into one global scope, so NO
// `window.ExportPanel = …` and NO `window.ExportPanel ?` guard (those are non-idiomatic here
// and the guard would silently render null instead of surfacing a load error).
