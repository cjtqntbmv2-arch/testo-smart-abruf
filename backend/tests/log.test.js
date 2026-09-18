// backend/tests/log.test.js
// Logzeilen fuer app.log. TZ muss stehen, bevor irgendein Date benutzt wird — sonst
// haengt der erwartete Offset von der Maschine ab, auf der der Test laeuft.
process.env.TZ = 'Europe/Berlin';
const test = require('node:test');
const assert = require('node:assert');
const util = require('node:util');
const crypto = require('node:crypto');
const log = require('../log');

// console.* zur Laufzeit ersetzen — genau so, wie server.test.js es tut.
function capture(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(`${k}: ${util.format(...a)}`);
  try { fn(); } finally { Object.assign(console, orig); }
  return lines;
}

test('info/warn/error: Zeitstempel in Ortszeit mit Offset vor jeder Zeile, Sommer- und Winterzeit', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 18, 12, 3, 12) });
  assert.deepStrictEqual(capture(() => { log.info('a'); log.warn('b'); log.error('c', 42); }), [
    'log: 2026-09-18T14:03:12+02:00 a',
    'warn: 2026-09-18T14:03:12+02:00 b',
    'error: 2026-09-18T14:03:12+02:00 c 42',
  ]);
  t.mock.timers.setTime(Date.UTC(2026, 11, 1, 7, 0, 5));
  assert.deepStrictEqual(capture(() => log.info('d')), ['log: 2026-12-01T08:00:05+01:00 d']);
});

// Die testo-Cloud haengt an jede Fehlerantwort eine neue instance-ID; testo-client.js
// uebernimmt den rohen Body in die Meldung. Ohne Normalisierung greift die Drosselung nie.
test('logThrottled: je Anfrage wechselnde IDs zaehlen als dieselbe Signatur; resetThrottled gibt sie wieder frei', () => {
  const msg = () => `Sync Alarme: HTTP error! status: 401 on /v3/alarms: {"instance":"/${crypto.randomUUID()}"}`;
  const lines = capture(() => { for (let i = 0; i < 12; i++) log.logThrottled(msg()); });
  assert.strictEqual(lines.length, 2, `volle Zeile + eine Zaehlzeile erwartet:\n${lines.join('\n')}`);
  assert.match(lines[1], /status: 401 on \/v3\/alarms: \{"instance":"\/<id>"\} \(10x\)$/);

  log.resetThrottled('Sync Alarme:');
  assert.strictEqual(capture(() => log.logThrottled(msg())).length, 1,
    'nach dem Zuruecksetzen erscheint derselbe Fehler wieder mit voller Zeile');
});
