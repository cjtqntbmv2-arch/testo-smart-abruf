// Übersetzt ein 'error'-Event des HTTP-Servers in eine klare Logzeile + Exit≠0,
// damit der Windows-Task-Scheduler ("Bei Fehler neu starten") auf einen
// Port-Konflikt reagieren kann statt einen unklaren Stacktrace zu werfen.
function handleListenError(err, deps = {}) {
  const log = deps.log || console.error;
  const exit = deps.exit || process.exit;
  const port = deps.port || process.env.PORT || 3000;
  if (err && err.code === 'EADDRINUSE') {
    log(`Port ${port} ist bereits belegt (EADDRINUSE) — Server kann nicht starten.`);
  } else {
    log('Server-Listen-Fehler:', err);
  }
  exit(1);
}

module.exports = { handleListenError };
