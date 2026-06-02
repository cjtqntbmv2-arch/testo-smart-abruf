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

after(() => {
  global.fetch = originalFetch;
});

