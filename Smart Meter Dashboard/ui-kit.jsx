// Praesentationale Bausteine der Oberflaeche: keine Hooks, kein Zustand, keine
// Datenzugriffe - jede Funktion bildet nur Props auf Markup ab.
//
// Lagen bis v0.15.0 am Ende von settings.jsx, werden aber auch von
// export-panel.jsx benutzt. Eine eigene Datei macht diese Abhaengigkeit sichtbar,
// statt sie aus einer Datei namens "Einstellungsseite" zu beziehen.
//
// Bewusst OHNE "const { ... } = React"-Zeile: hier wird kein Hook gebraucht, und
// jede weitere Alias-Zeile waere nur eine zusaetzliche Kollisionsquelle im
// gemeinsamen globalen Scope.

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
