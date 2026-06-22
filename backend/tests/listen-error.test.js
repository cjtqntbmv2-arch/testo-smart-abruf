const test = require('node:test');
const assert = require('node:assert');
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

test('anderer Fehler → generische Meldung + exit(1)', () => {
  const logs = [];
  let exitCode = null;
  handleListenError(
    { code: 'EOTHER', message: 'boom' },
    { log: (...a) => logs.push(a.join(' ')), exit: (c) => { exitCode = c; } }
  );
  assert.match(logs.join('\n'), /Listen-Fehler/);
  assert.strictEqual(exitCode, 1);
});
