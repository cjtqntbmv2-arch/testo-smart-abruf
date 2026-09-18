// Übersetzt ein 'error'-Event des HTTP-Servers in eine klare Logzeile + Exit≠0,
// damit der Windows-Task-Scheduler ("Bei Fehler neu starten") auf einen
// Port-Konflikt reagieren kann statt einen unklaren Stacktrace zu werfen.
const { error } = require('./log');

function handleListenError(err, deps = {}) {
  const log = deps.log || error;
  const exit = deps.exit || process.exit;
  const port = deps.port || process.env.PORT || 3000;
  const code = (err && err.code) || 'ohne Code';
  if (code === 'EADDRINUSE') {
    log(`Port ${port} ist bereits belegt (EADDRINUSE) — Server kann nicht starten.`);
  } else {
    // Code + erste Meldungszeile statt des rohen Error-Objekts: console.error(err) schriebe
    // den Stacktrace ins Dienst-Log, und der erklärt bei einem Bindefehler (EACCES,
    // EADDRNOTAVAIL, ENOTFOUND bei falschem HOST …) nichts.
    const text = String((err && err.message) || err).split('\n')[0];
    log(`Server-Listen-Fehler auf Port ${port} (${code}): ${text} — Server kann nicht starten.`);
  }
  exit(1);
}

module.exports = { handleListenError };
