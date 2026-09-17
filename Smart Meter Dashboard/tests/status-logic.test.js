const { test } = require('node:test');
const assert = require('node:assert');
const { explainSyncError, explainLayoutSaveError } = require('../status-logic');

test('explainSyncError: fehlender API-Schlüssel', () => {
  const r = explainSyncError('No API Key configured');
  assert.strictEqual(r.plain, 'Kein API-Schlüssel hinterlegt.');
  assert.strictEqual(r.showRaw, false);
});

test('explainSyncError: 401 / invalid_token', () => {
  assert.strictEqual(explainSyncError('Request failed: 401 Unauthorized').plain, 'Zugangsschlüssel wurde abgelehnt.');
  assert.strictEqual(explainSyncError('invalid_token').plain, 'Zugangsschlüssel wurde abgelehnt.');
});

test('explainSyncError: 403 forbidden', () => {
  assert.strictEqual(explainSyncError('403 Forbidden').plain, 'Zugriff verweigert — Berechtigung prüfen.');
});

test('explainSyncError: Netzwerkfehler', () => {
  assert.strictEqual(explainSyncError('fetch failed').plain, 'Keine Verbindung zur testo-Cloud.');
  assert.strictEqual(explainSyncError('connect ECONNREFUSED 1.2.3.4:443').plain, 'Keine Verbindung zur testo-Cloud.');
});

test('explainSyncError: Timeout', () => {
  assert.strictEqual(explainSyncError('ETIMEDOUT').plain, 'Zeitüberschreitung bei der Anfrage.');
});

test('explainSyncError: Rate-Limit', () => {
  assert.strictEqual(explainSyncError('429 Too Many Requests').plain, 'Zu viele Anfragen (Rate-Limit erreicht).');
});

test('explainSyncError: Serverfehler', () => {
  assert.strictEqual(explainSyncError('500 Internal Server Error').plain, 'testo-Cloud meldet einen Serverfehler.');
});

test('explainSyncError: unbekannt -> Default mit Rohtext', () => {
  const r = explainSyncError('something weird happened');
  assert.strictEqual(r.plain, 'Synchronisation fehlgeschlagen.');
  assert.strictEqual(r.showRaw, true);
});

test('explainSyncError: null/leer -> Default ohne Rohtext', () => {
  assert.strictEqual(explainSyncError(null).plain, 'Synchronisation fehlgeschlagen.');
  assert.strictEqual(explainSyncError(null).showRaw, false);
  assert.strictEqual(explainSyncError('').showRaw, false);
});

test('explainLayoutSaveError: geglueckter Schreibvorgang -> keine Meldung', () => {
  assert.strictEqual(explainLayoutSaveError(null), null);
  assert.strictEqual(explainLayoutSaveError(undefined), null);
});

test('explainLayoutSaveError: fehlgeschlagen -> Meldung nennt Vorgang und Folge', () => {
  const msg = explainLayoutSaveError(new Error('irgendwas'));
  assert.match(msg, /nicht gespeichert/);
  assert.match(msg, /verloren/);
});

// Bewusste Entscheidung: voller und gesperrter Speicher werden NICHT unterschieden.
// Der Bediener kann in beiden Faellen nur dasselbe tun, ein zweiter Satz brauchte
// eine Fallunterscheidung ohne Nutzen.
test('explainLayoutSaveError: voller und gesperrter Speicher ergeben denselben Satz', () => {
  const voll = new Error('The quota has been exceeded.');
  voll.name = 'QuotaExceededError';
  const gesperrt = new Error('The operation is insecure.');
  gesperrt.name = 'SecurityError';
  assert.strictEqual(explainLayoutSaveError(voll), explainLayoutSaveError(gesperrt));
});
