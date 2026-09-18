const { test, after } = require('node:test');
const assert = require('node:assert');

const originalFetch = global.fetch;

// Mock global.fetch with sorting to avoid partial path matching issues
const mockResponses = {};
global.fetch = async (url, options) => {
  const matched = Object.keys(mockResponses)
    .sort((a, b) => b.length - a.length)
    .find(pattern => url.includes(pattern));
  if (matched) {
    const data = mockResponses[matched];
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    return {
      ok: true,
      json: async () => data,
      text: async () => dataStr,
      arrayBuffer: async () => {
        const buf = Buffer.from(dataStr);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
    };
  }
  throw new Error(`Fetch not mocked for ${url}`);
};

const TestoClient = require('../testo-client');

test('Testo API Client async submit and polling', async () => {
  const apiKey = 'test-key';
  const region = 'eu';
  const client = new TestoClient(apiKey, region);

  // Mock POST measurements submission
  mockResponses['/v2/measurements'] = { status: 'Submitted', request_uuid: 'req-123' };
  
  // Mock GET polling
  mockResponses['/v2/measurements/req-123'] = {
    status: 'Completed',
    data_urls: ['https://s3.example.com/file.json']
  };

  // Mock file download
  mockResponses['s3.example.com/file.json'] = [
    { uuid: 'row-1', measurement: 21.5, timestamp: '2026-05-29T06:00:00Z' }
  ];

  const data = await client.fetchMeasurements({
    date_time_from: '2026-05-29T00:00:00Z'
  });

  assert.strictEqual(data.length, 1);
  assert.strictEqual(data[0].uuid, 'row-1');
  assert.strictEqual(data[0].measurement, 21.5);
});

test('Testo API Client fetches device properties via async flow', async () => {
  const client = new TestoClient('test-key', 'eu');

  mockResponses['/v3/devices/properties'] = { status: 'Submitted', request_uuid: 'props-req' };
  mockResponses['/v3/devices/properties/props-req'] = {
    status: 'Completed',
    data_urls: ['https://s3.example.com/props.json']
  };
  mockResponses['s3.example.com/props.json'] = [
    { device_uuid: 'dev-1', sensor_uuid: 's-1', channel_physical_property_name: 'Temperature' }
  ];

  const data = await client.fetchDeviceProperties();
  assert.strictEqual(data.length, 1);
  assert.strictEqual(data[0].device_uuid, 'dev-1');
  assert.strictEqual(data[0].sensor_uuid, 's-1');
});

test('Mock mode returns consistent device properties, measurements and status', async () => {
  const mockClient = new TestoClient('mock-api-key', 'eu');
  const props = await mockClient.fetchDeviceProperties();
  const meas = await mockClient.fetchMeasurements({ date_time_from: new Date().toISOString() });
  const status = await mockClient.fetchDeviceStatus();

  const sensorToDevice = new Map(props.map(p => [p.sensor_uuid, p.device_uuid]));
  for (const m of meas) {
    assert.ok(sensorToDevice.has(m.sensor_uuid), `measurement sensor ${m.sensor_uuid} must be in device properties`);
  }
  assert.ok(props.some(p => p.device_uuid === status[0].device_uuid));
  assert.ok(!sensorToDevice.has(status[0].device_uuid), 'device_uuid must be distinct from sensor uuids');
});

// --- Resilience: retry transient network failures + surface the real cause ---

function transientError(code = 'ECONNRESET', msg = 'read ECONNRESET') {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error(msg), { code });
  return err;
}

test('_request retries a transient network failure then succeeds', async () => {
  const client = new TestoClient('test-key', 'eu', { retryBaseMs: 0 });
  const prev = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts++;
    if (attempts < 3) throw transientError('UND_ERR_SOCKET', 'other side closed');
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
  try {
    const res = await client._request('/v3/devices/status', 'POST', {});
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(res, { status: 'ok' });
  } finally {
    global.fetch = prev;
  }
});

test('_request surfaces the underlying cause after exhausting retries', async () => {
  const client = new TestoClient('test-key', 'eu', { retryBaseMs: 0 });
  const prev = global.fetch;
  global.fetch = async () => { throw transientError('ECONNRESET', 'read ECONNRESET'); };
  try {
    await assert.rejects(
      client._request('/v3/devices/status'),
      (e) => /ECONNRESET/.test(e.message) && e.cause && e.cause.code === 'ECONNRESET'
    );
  } finally {
    global.fetch = prev;
  }
});

test('_request does NOT retry an HTTP error response (4xx/5xx)', async () => {
  const client = new TestoClient('test-key', 'eu', { retryBaseMs: 0 });
  const prev = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts++;
    return {
      ok: false,
      status: 400,
      arrayBuffer: async () => { const b = Buffer.from('bad request'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    };
  };
  try {
    await assert.rejects(client._request('/v3/devices/status'), /status: 400/);
    assert.strictEqual(attempts, 1, 'HTTP error responses must not be retried');
  } finally {
    global.fetch = prev;
  }
});

test('_downloadFiles retries a transient failure on the download URL', async () => {
  const client = new TestoClient('test-key', 'eu', { retryBaseMs: 0 });
  const prev = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts++;
    if (attempts < 2) throw transientError('ETIMEDOUT', 'connect ETIMEDOUT');
    const payload = JSON.stringify([{ uuid: 'row-1' }]);
    return {
      ok: true,
      arrayBuffer: async () => { const b = Buffer.from(payload); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    };
  };
  try {
    const data = await client._downloadFiles(['https://s3.example.com/late.json']);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(data.length, 1);
    assert.strictEqual(data[0].uuid, 'row-1');
  } finally {
    global.fetch = prev;
  }
});

// --- 429 Too Many Requests, as testo-smart-connect-api/03-async-pattern.md prescribes ---

// Scripted cloud: each route answers from its own list in order, the last answer repeats.
// Real Response objects, so status, headers and body behave as they do with real fetch.
function scriptCloud(t, routes) {
  const calls = {};
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    const route = `${options.method || 'GET'} ${new URL(url).pathname}`;
    calls[route] = (calls[route] || 0) + 1;
    const answers = routes[route];
    if (!answers) throw new Error(`Fetch not mocked for ${route}`);
    const [status, body, headers] = answers.length > 1 ? answers.shift() : answers[0];
    return new Response(JSON.stringify(body), { status, headers });
  });
  return calls;
}

// Waits cost nothing: each one is recorded and moves the faked Date.now() forward, so the
// poll deadline counts it as if it had really been slept.
function clientWithFakeClock(t) {
  t.mock.timers.enable({ apis: ['Date'] });
  const waits = [];
  const client = new TestoClient('test-key', 'eu', {
    sleep: async (ms) => { waits.push(ms); t.mock.timers.tick(ms); }
  });
  return { client, waits };
}

const SUBMITTED = [200, { status: 'Submitted', request_uuid: 'req-429' }];
const COMPLETED = [200, { status: 'Completed', data_urls: ['https://s3.example.com/rows.json'] }];
const ROWS = [200, [{ uuid: 'row-1' }]];
const tooMany = (retryAfter) => [429, { message: 'Too Many Requests' }, retryAfter && { 'Retry-After': retryAfter }];

test('429 on submit: waits as long as Retry-After says, in seconds or as an HTTP date', async (t) => {
  const { client, waits } = clientWithFakeClock(t);
  const calls = scriptCloud(t, {
    'POST /v3/devices/status': [tooMany('7'), tooMany(new Date(Date.now() + 30000).toUTCString()), SUBMITTED],
    'GET /v3/devices/status/req-429': [COMPLETED],
    'GET /rows.json': [ROWS]
  });

  assert.deepStrictEqual(await client.fetchDeviceStatus(), [{ uuid: 'row-1' }]);
  assert.strictEqual(calls['POST /v3/devices/status'], 3);
  // The date is absolute: 30 s from the start, of which the first wait already used 7 s.
  assert.deepStrictEqual(waits, [7000, 23000]);
});

test('429 on submit without Retry-After: backs off 2 s, 4 s, 8 s, then surfaces the 429', async (t) => {
  const { client, waits } = clientWithFakeClock(t);
  const calls = scriptCloud(t, { 'POST /v2/measurements': [tooMany()] });

  await assert.rejects(client.fetchMeasurements({}), /status: 429 on \/v2\/measurements: Too Many Requests/);
  assert.strictEqual(calls['POST /v2/measurements'], 4, 'one request plus 3 retries');
  assert.deepStrictEqual(waits, [2000, 4000, 8000]);
});

test('429 on poll is no request failure: the same request_uuid is polled again after the backoff', async (t) => {
  const { client, waits } = clientWithFakeClock(t);
  const calls = scriptCloud(t, {
    'POST /v3/alarms': [SUBMITTED],
    'GET /v3/alarms/req-429': [tooMany('10'), tooMany(), tooMany(), tooMany(), COMPLETED],
    'GET /rows.json': [ROWS]
  });

  assert.deepStrictEqual(await client.fetchAlarms({}), [{ uuid: 'row-1' }]);
  assert.strictEqual(calls['POST /v3/alarms'], 1, 'a 429 on the poll must not resubmit');
  assert.strictEqual(calls['GET /v3/alarms/req-429'], 5);
  // Retry-After (10 s) outlasts the first poll delay (2 s); after that the poll backoff doubles on.
  assert.deepStrictEqual(waits, [10000, 4000, 8000, 16000]);
});

test('a Retry-After beyond the 300 s poll budget is not sat out, on submit or on poll', async (t) => {
  const { client, waits } = clientWithFakeClock(t);
  const calls = scriptCloud(t, {
    'POST /v3/devices/properties': [tooMany('3600')],
    'POST /v1/measuring-objects': [SUBMITTED],
    'GET /v1/measuring-objects/req-429': [tooMany('301')]
  });

  await assert.rejects(client.fetchDeviceProperties(), /status: 429 on \/v3\/devices\/properties/);
  await assert.rejects(client.fetchMeasuringObjects(), /status: 429 on \/v1\/measuring-objects\/req-429/);
  assert.strictEqual(calls['POST /v3/devices/properties'], 1);
  assert.strictEqual(calls['GET /v1/measuring-objects/req-429'], 1);
  assert.deepStrictEqual(waits, []);
});

test('429 on every poll: ends with the 429 once the next wait would pass the 300 s budget', async (t) => {
  const { client, waits } = clientWithFakeClock(t);
  scriptCloud(t, {
    'POST /v2/measurements': [SUBMITTED],
    'GET /v2/measurements/req-429': [tooMany()]
  });

  await assert.rejects(client.fetchMeasurements({}), /status: 429 on \/v2\/measurements\/req-429/);
  // 2 + 4 + 8 + 16 + 8 x 30 = 270 s slept; the next 30 s would reach the deadline.
  assert.deepStrictEqual(waits, [2000, 4000, 8000, 16000, ...Array(8).fill(30000)]);
});

test('other HTTP errors on submit or poll still fail at once', async (t) => {
  const { client, waits } = clientWithFakeClock(t);
  const calls = scriptCloud(t, {
    'POST /v3/devices/properties': [[503, { message: 'Service Unavailable' }]],
    'POST /v1/measuring-objects': [SUBMITTED],
    'GET /v1/measuring-objects/req-429': [[500, { message: 'Internal Server Error' }]]
  });

  await assert.rejects(client.fetchDeviceProperties(), /status: 503/);
  await assert.rejects(client.fetchMeasuringObjects(), /status: 500/);
  assert.strictEqual(calls['POST /v3/devices/properties'], 1);
  assert.strictEqual(calls['GET /v1/measuring-objects/req-429'], 1);
  assert.deepStrictEqual(waits, []);
});

// --- Mock mode must not activate outside tests without an explicit opt-in ---

test('_request: mock-api-key does not short-circuit outside test mode or explicit opt-in', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevTestoMock = process.env.TESTO_MOCK;
  process.env.NODE_ENV = 'production';
  delete process.env.TESTO_MOCK;
  try {
    const client = new TestoClient('mock-api-key', 'eu', { retryBaseMs: 0 });
    await assert.rejects(
      client._request('/v3/devices/status', 'POST'),
      /Fetch not mocked/,
      'production conditions must attempt a real request instead of returning fabricated data'
    );
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevTestoMock === undefined) delete process.env.TESTO_MOCK;
    else process.env.TESTO_MOCK = prevTestoMock;
  }
});

test('_downloadFiles: mock:// URL does not return fabricated data outside test mode or explicit opt-in', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevTestoMock = process.env.TESTO_MOCK;
  process.env.NODE_ENV = 'production';
  delete process.env.TESTO_MOCK;
  try {
    const client = new TestoClient('mock-api-key', 'eu', { retryBaseMs: 0 });
    await assert.rejects(
      client._downloadFiles(['mock://meas']),
      /Fetch not mocked/,
      'production conditions must attempt a real download instead of returning fabricated measurements'
    );
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevTestoMock === undefined) delete process.env.TESTO_MOCK;
    else process.env.TESTO_MOCK = prevTestoMock;
  }
});

test('_request: TESTO_MOCK=1 keeps mock mode available outside NODE_ENV=test', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevTestoMock = process.env.TESTO_MOCK;
  process.env.NODE_ENV = 'production';
  process.env.TESTO_MOCK = '1';
  try {
    const client = new TestoClient('mock-api-key', 'eu', { retryBaseMs: 0 });
    const res = await client._request('/v3/devices/status', 'POST');
    assert.deepStrictEqual(res, { request_uuid: 'mock-status-req' });
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevTestoMock === undefined) delete process.env.TESTO_MOCK;
    else process.env.TESTO_MOCK = prevTestoMock;
  }
});

after(() => {
  global.fetch = originalFetch;
});

