const zlib = require('zlib');
const { warn } = require('./log');

class TestoClient {
  constructor(apiKey, region = 'eu', opts = {}) {
    this.apiKey = apiKey;
    this.region = region;
    this.baseUrl = `https://data-api.${region}.smartconnect.testo.com`;
    this.retryAttempts = opts.retryAttempts ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
  }

  // Long-running processes hit transient network failures (stale keep-alive
  // sockets after sleep/wake, brief DNS/connection drops). fetch() rejects with
  // a generic "fetch failed" TypeError whose real reason lives in error.cause.
  // Retry the transport-level rejection with exponential backoff; on final
  // failure throw an Error that surfaces the cause so it is diagnosable.
  // A returned response (even a non-ok HTTP status) is NOT retried — that is the
  // caller's concern.
  async _fetchWithRetry(url, options) {
    let lastErr;
    for (let i = 0; i < this.retryAttempts; i++) {
      try {
        return await fetch(url, options);
      } catch (err) {
        lastErr = err;
        if (i < this.retryAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, this.retryBaseMs * Math.pow(2, i)));
        }
      }
    }
    const cause = (lastErr && lastErr.cause) || lastErr;
    const detail = cause ? `${cause.code || cause.name || 'error'}: ${cause.message}` : 'unknown error';
    const wrapped = new Error(`fetch failed for ${url} after ${this.retryAttempts} attempt(s) (${detail})`);
    wrapped.cause = cause;
    throw wrapped;
  }

  // Mock mode returns fabricated fixture data instead of calling the real
  // testo cloud. It exists for two reasons: the test suite drives this class
  // through a real instance with no network access (see
  // backend/tests/testo-client.test.js and, indirectly, server.test.js's
  // POST /api/sync -> scheduler.js -> new TestoClient(...)), and it lets a
  // developer run the app normally and see a populated dashboard without a
  // real testo API key.
  //
  // The trigger is a literal string in the apiKey field, so it must never
  // fire just because someone typed or pasted 'mock-api-key' into a live
  // deployment's Settings screen -- that would silently replace real
  // measurements with plausible-looking fabricated ones. Outside the
  // automated test run (NODE_ENV=test, set only by npm test / cross-env --
  // deploy/windows/env.example tells operators never to set NODE_ENV) mock
  // mode additionally requires the explicit opt-in TESTO_MOCK=1, and logs
  // loudly whenever that opt-in is what activated it.

  // #16: pure condition, no side effect (no logging) -- shared with GET /api/system/status
  // (backend/server.js) so the dashboard's "showing fabricated data" indicator can never
  // drift from the condition that actually fabricates the data. Kept side-effect-free on
  // purpose: that status endpoint is polled every few seconds by the frontend, and running
  // _mockModeActive()'s console.warn on every poll would flood the log for no reason -- the
  // warn below already fires on every faked API call while mock mode is active.
  static isMockCondition(apiKey) {
    if (apiKey !== 'mock-api-key') return false;
    return process.env.NODE_ENV === 'test' || process.env.TESTO_MOCK === '1';
  }

  _mockModeActive() {
    if (!TestoClient.isMockCondition(this.apiKey)) return false;
    if (process.env.NODE_ENV !== 'test' && process.env.TESTO_MOCK === '1') {
      warn('[testo-client] TESTO_MOCK=1 is set: returning fabricated mock data instead of real testo cloud data.');
    }
    return true;
  }

  async _request(path, method = 'GET', body = null) {
    if (this._mockModeActive()) {
      if (path === '/v3/devices/status' && method === 'POST') return { request_uuid: 'mock-status-req' };
      if (path === '/v3/devices/status/mock-status-req') return { status: 'Completed', data_urls: ['mock://status'] };
      if (path === '/v1/measuring-objects' && method === 'POST') return { request_uuid: 'mock-mo-req' };
      if (path === '/v1/measuring-objects/mock-mo-req') return { status: 'Completed', data_urls: ['mock://mo'] };
      if (path === '/v2/measurements' && method === 'POST') return { request_uuid: 'mock-meas-req' };
      if (path === '/v2/measurements/mock-meas-req') return { status: 'Completed', data_urls: ['mock://meas'] };
      if (path === '/v3/alarms' && method === 'POST') return { request_uuid: 'mock-alarms-req' };
      if (path === '/v3/alarms/mock-alarms-req') return { status: 'Completed', data_urls: ['mock://alarms'] };
      if (path === '/v3/devices/properties' && method === 'POST') return { request_uuid: 'mock-props-req' };
      if (path === '/v3/devices/properties/mock-props-req') return { status: 'Completed', data_urls: ['mock://properties'] };
    }

    const url = `${this.baseUrl}${path}`;
    const headers = {
      'x-custom-api-key': this.apiKey,
      'Content-Type': 'application/json'
    };

    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await this._fetchWithRetry(url, options);
    if (!response.ok) {
      let errMsg = '';
      try {
        const buffer = Buffer.from(await response.arrayBuffer());
        let bodyText;
        if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
          bodyText = zlib.gunzipSync(buffer).toString('utf8');
        } else {
          bodyText = buffer.toString('utf8');
        }
        try {
          const errJson = JSON.parse(bodyText);
          errMsg = errJson.message || errJson.error || bodyText;
        } catch (_) {
          errMsg = bodyText;
        }
      } catch (_) {}
      throw new Error(`HTTP error! status: ${response.status} on ${path}${errMsg ? `: ${errMsg}` : ''}`);
    }
    return response.json();
  }

  async _poll(pollPath, maxBudgetSec = 300) {
    let delay = 2000; // start with 2s delay
    const maxDelay = 30000;
    const deadline = Date.now() + maxBudgetSec * 1000;

    while (Date.now() < deadline) {
      const result = await this._request(pollPath);
      if (result.status === 'Completed') {
        return result.data_urls;
      }
      if (result.status === 'Failed' || result.status === 'Error') {
        throw new Error(`Testo API report failed for ${pollPath}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
    throw new Error(`Polling timeout for ${pollPath}`);
  }

  async _downloadFiles(urls) {
    let allRecords = [];
    const list = urls || [];
    for (const url of list) {
      if (url.startsWith('mock://') && this._mockModeActive()) {
        if (url === 'mock://status') {
          allRecords = allRecords.concat([
            { device_uuid: 'mock-device-uuid', serial_no: 'MOCK123', battery_level_percent: 85, radio_level_percent: 90, connection_type: 'wifi', is_powersupply_on: true, fw_version: '1.0.0', model_code: 'testo-160', last_communication: new Date().toISOString(), last_measurement_time: new Date().toISOString(), next_communication: new Date(Date.now() + 900000).toISOString() }
          ]);
          continue;
        } else if (url === 'mock://mo') {
          // Live-shaped MO row: measurement_alarm_configuration is a JSON-encoded string.
          // This minimal fixture carries one temperature upper-alarm condition so that
          // the scheduler's threshold-join test has a real limit to look up.
          allRecords = allRecords.concat([
            {
              measuring_object_uuid: 'mock-mo-uuid',
              measurement_alarm_configuration: JSON.stringify({
                measurementAlarmConditionSet: [{
                  measurementAlarmConditions: [
                    { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Alarm', physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 28, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' }
                  ]
                }]
              }),
              channel_assignments: null
            }
          ]);
          continue;
        } else if (url === 'mock://meas') {
          const rand = Math.random().toString(36).substring(2, 7);
          allRecords = allRecords.concat([
            { uuid: `meas-${Date.now()}-${rand}-1`, sensor_uuid: 'mock-sensor-temp', timestamp: new Date().toISOString(), timestamp_local: new Date().toLocaleString(), measurement: 23.5, physical_property_name: 'Temperature', physical_unit: '°C', channel_no: 1, serial_no: 'MOCK123-S1', model_code: 'testo-160-THE', processed_at: new Date().toISOString() },
            { uuid: `meas-${Date.now()}-${rand}-2`, sensor_uuid: 'mock-sensor-hum', timestamp: new Date().toISOString(), timestamp_local: new Date().toLocaleString(), measurement: 45.2, physical_property_name: 'Humidity', physical_unit: '%', channel_no: 2, serial_no: 'MOCK123-S2', model_code: 'testo-160-THE', processed_at: new Date().toISOString() }
          ]);
          continue;
        } else if (url === 'mock://alarms') {
          allRecords = allRecords.concat([
            { uuid: `alarm-${Date.now()}`, serial_no: 'MOCK123-S1', alarm_source_uuid: 'mock-sensor-temp', alarm_type: 'measurement alarm', alarm_severity: 'Warning', alarm_status: 'Alarm', alarm_reason: 'High temperature', alarm_condition_type: 'Upper limit', alarm_value: '23.5', physical_property_name: 'Temperature', physical_extension: 'Unknown', alarm_time: new Date(Date.now() - 3600000).toISOString(), last_status_change_time: new Date().toISOString() }
          ]);
          continue;
        } else if (url === 'mock://properties') {
          allRecords = allRecords.concat([
            { device_uuid: 'mock-device-uuid', device_serial_no: 'MOCK123', device_display_name: 'Mock Logger', device_model_code: 'testo-160-THE', sensor_uuid: 'mock-sensor-temp', sensor_serial_no: 'MOCK123-S1', channel_no: 1, channel_physical_property_name: 'Temperature', channel_physical_unit: '°C' },
            { device_uuid: 'mock-device-uuid', device_serial_no: 'MOCK123', device_display_name: 'Mock Logger', device_model_code: 'testo-160-THE', sensor_uuid: 'mock-sensor-hum', sensor_serial_no: 'MOCK123-S2', channel_no: 2, channel_physical_property_name: 'Humidity', channel_physical_unit: '%' }
          ]);
          continue;
        }
      }
      const response = await this._fetchWithRetry(url);
      if (!response.ok) {
        throw new Error(`Download failed for file: ${url}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      let jsonString;
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        jsonString = zlib.gunzipSync(buffer).toString('utf8');
      } else {
        jsonString = buffer.toString('utf8');
      }
      
      let data = [];
      const trimmed = jsonString.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          data = Array.isArray(parsed) ? parsed : [parsed];
        } catch (_) {
          const lines = trimmed.split(/\r?\n/);
          for (const line of lines) {
            const lineTrim = line.trim();
            if (lineTrim) {
              data.push(JSON.parse(lineTrim));
            }
          }
        }
      }
      allRecords = allRecords.concat(data);
    }
    return allRecords;
  }

  async _executeAsyncFlow(postPath, getPathPrefix, requestBody) {
    const submitRes = await this._request(postPath, 'POST', requestBody);
    const uuid = submitRes.request_uuid;
    if (!uuid) {
      throw new Error(`No request_uuid returned by POST ${postPath}`);
    }
    const dataUrls = await this._poll(`${getPathPrefix}/${uuid}`);
    return this._downloadFiles(dataUrls);
  }

  async fetchDeviceStatus() {
    return this._executeAsyncFlow('/v3/devices/status', '/v3/devices/status', {
      options: { result_file_format: 'JSON' }
    });
  }

  async fetchMeasuringObjects() {
    return this._executeAsyncFlow('/v1/measuring-objects', '/v1/measuring-objects', {
      options: { result_file_format: 'JSON' }
    });
  }

  async fetchDeviceProperties() {
    return this._executeAsyncFlow('/v3/devices/properties', '/v3/devices/properties', {
      options: { result_file_format: 'JSON' }
    });
  }

  async fetchMeasurements(params = {}) {
    return this._executeAsyncFlow('/v2/measurements', '/v2/measurements', {
      date_time_from: params.date_time_from,
      date_time_until: params.date_time_until,
      options: { result_file_format: 'JSON' },
      odata: params.odata
    });
  }

  async fetchAlarms(params = {}) {
    return this._executeAsyncFlow('/v3/alarms', '/v3/alarms', {
      date_time_from: params.date_time_from,
      date_time_until: params.date_time_until,
      options: { result_file_format: 'JSON' },
      odata: params.odata
    });
  }
}

module.exports = TestoClient;
