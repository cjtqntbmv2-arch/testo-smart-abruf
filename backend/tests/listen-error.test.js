const test = require('node:test');
const assert = require('node:assert');
const util = require('node:util');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { handleListenError } = require('../listen-error');

test('EADDRINUSE → klare Meldung mit Port + exit(1)', () => {
  const logs = [];
  let exitCode = null;
  handleListenError(
    { code: 'EADDRINUSE' },
    { log: (...a) => logs.push(a.join(' ')), exit: (c) => { exitCode = c; }, port: 3000 }
  );
  const out = logs.join('\n');
  assert.match(out, /EADDRINUSE/);
  assert.match(out, /3000/);
  assert.strictEqual(exitCode, 1);
});

test('anderer Fehler → eine Zeile mit Code und Kurztext, kein Stacktrace, exit(1)', () => {
  const logs = [];
  let exitCode = null;
  // Ein echtes Error-Objekt, wie net.Server es liefert, und ein log, das wie console.error
  // formatiert (util.format) — nur so taucht ein mitgeloggter Stacktrace hier überhaupt auf.
  const err = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:3000'),
    { code: 'EACCES', errno: -13, syscall: 'listen', address: '127.0.0.1', port: 3000 });
  handleListenError(err, { log: (...a) => logs.push(util.format(...a)), exit: (c) => { exitCode = c; }, port: 3000 });
  const out = logs.join('\n');
  assert.match(out, /Listen-Fehler/);
  assert.match(out, /EACCES/);
  assert.match(out, /permission denied/);
  assert.doesNotMatch(out, /\n/, `Meldung muss einzeilig sein, war:\n${out}`);
  assert.doesNotMatch(out, /\bat .+:\d+:\d+/, 'kein Stacktrace im Dienst-Log');
  assert.strictEqual(exitCode, 1);
});

// ── server.js als Kindprozess: Hintergrundjobs erst nach dem Port-Bind ────
// Eine zweite Instanz (Windows-Task-Neustart, doppelter Start), die am belegten Port
// scheitert, darf vorher weder den Scheduler noch einen Sync-Zyklus anstoßen — sonst
// greift sie auf die DB der laufenden Instanz und (je nach HOST) auf die testo-Cloud zu.
// NODE_ENV=production: nur außerhalb von 'test' hängt server.js handleListenError an,
// das ist der Weg des Windows-Dienstes. Das settings-Seeding mit leerem api_key
// unterdrückt das Default-Seeding in initDb, das sonst TESTO_API_KEY aus der .env
// übernähme — kein Lauf erreicht so die Cloud, auch nicht mit dem alten Fehler.
function startServer(port) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testo-listen-'));
  const dbPath = path.join(tmpDir, 'klima.db');
  const seed = new Database(dbPath);
  seed.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  seed.prepare("INSERT INTO settings (key, value) VALUES ('api_key', '')").run();
  seed.close();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, NODE_ENV: 'production', DB_PATH: dbPath, PORT: String(port), HOST: '127.0.0.1' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // 'close' statt 'exit': erst dann ist die Ausgabe des Kindprozesses vollständig da.
  const closed = new Promise((resolve) => child.on('close', (code) => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resolve(code);
  }));
  return { child, closed, output: () => out };
}

test('server.js bei belegtem Port: Exit 1 mit klarer Meldung, weder Scheduler noch Sync gestartet', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  const srv = startServer(port);
  const killTimer = setTimeout(() => srv.child.kill('SIGKILL'), 8000);
  try {
    const code = await srv.closed;
    const out = srv.output();
    assert.strictEqual(code, 1, `Exit-Code 1 erwartet (der Windows-Task wertet ihn aus), Ausgabe:\n${out}`);
    assert.match(out, new RegExp(`Port ${port} ist bereits belegt \\(EADDRINUSE\\)`));
    assert.doesNotMatch(out, /Scheduler started|Skipping sync/,
      `eine am Port gescheiterte Instanz darf weder Scheduler noch Sync-Zyklus starten, Ausgabe:\n${out}`);
  } finally {
    clearTimeout(killTimer);
    blocker.close();
  }
});

test('server.js bei freiem Port: Scheduler startet, und zwar erst nach dem Bind', async () => {
  const srv = startServer(0);
  try {
    const deadline = Date.now() + 8000;
    while (!/Scheduler started/.test(srv.output())) {
      assert.ok(Date.now() < deadline, `Scheduler nicht gestartet, Ausgabe:\n${srv.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const out = srv.output();
    const bound = out.indexOf('running on http');
    assert.ok(bound !== -1 && bound < out.indexOf('Scheduler started'),
      `Scheduler muss nach dem Port-Bind starten, Ausgabe:\n${out}`);
  } finally {
    srv.child.kill('SIGTERM');
    await srv.closed;
  }
});
