const test = require('node:test');
const assert = require('node:assert');
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions } = require('../device-bridge');

test('mapPhysicalProperty maps testo property names to dashboard metrics', () => {
  assert.strictEqual(mapPhysicalProperty('Temperature'), 'temperature');
  assert.strictEqual(mapPhysicalProperty('PV_TEMPERATURE'), 'temperature');
  assert.strictEqual(mapPhysicalProperty('Relative Humidity'), 'humidity');
  assert.strictEqual(mapPhysicalProperty('Luftfeuchte'), 'humidity');
  assert.strictEqual(mapPhysicalProperty('Pressure'), 'pressure');
  assert.strictEqual(mapPhysicalProperty('Luftdruck'), 'pressure');
  assert.strictEqual(mapPhysicalProperty('CO2'), null);
  assert.strictEqual(mapPhysicalProperty(''), null);
  assert.strictEqual(mapPhysicalProperty(undefined), null);
});

test('mapPhysicalProperty uses physical_extension to separate derived channels from the primary metric', () => {
  // Real bug: a testo dewpoint channel reports physical_property_name "Temperature"
  // (dewpoint IS a temperature). Only physical_extension distinguishes it. Without it,
  // the dewpoint channel collapses into the temperature series and the values jump.
  assert.strictEqual(mapPhysicalProperty('Temperature', 'Air Temperature'), 'temperature');
  assert.strictEqual(mapPhysicalProperty('Temperature', 'Dewpoint Temperature'), 'dewpoint');
  assert.strictEqual(mapPhysicalProperty('Temperature', 'Dew Point'), 'dewpoint');
  assert.strictEqual(mapPhysicalProperty('Temperature', 'Taupunkt'), 'dewpoint');
  // Absolute humidity shares the "Humidity" property name with relative humidity.
  assert.strictEqual(mapPhysicalProperty('Humidity', 'Relative Humidity'), 'humidity');
  assert.strictEqual(mapPhysicalProperty('Humidity', 'Absolute Humidity'), 'abshumid');
  // Real testo strings: absolute humidity reports property name "Density" (it IS a
  // density, g/m³), and barometric pressure reports extension "Absolute Pressure".
  // Both extensions contain "absolut": classifying on that token alone routes the
  // pressure channel (hPa, ~1000) into the abshumid series, hiding pressure entirely
  // and making abs-humidity jump between ~10 and ~1000. The humidity token in the
  // extension is what distinguishes the two.
  assert.strictEqual(mapPhysicalProperty('Density', 'Absolute Humidity'), 'abshumid');
  assert.strictEqual(mapPhysicalProperty('Pressure', 'Absolute Pressure'), 'pressure');
  // Backward compatibility: no/empty extension keeps the property-name mapping.
  assert.strictEqual(mapPhysicalProperty('Temperature'), 'temperature');
  assert.strictEqual(mapPhysicalProperty('Temperature', ''), 'temperature');
  assert.strictEqual(mapPhysicalProperty('Humidity', undefined), 'humidity');
});

test('buildDeviceBridge builds sensor/device/serial maps from device properties', () => {
  const props = [
    { device_uuid: 'dev-1', device_serial_no: 'SN1', sensor_uuid: 's-temp', sensor_serial_no: 'SN1-A', channel_physical_property_name: 'Temperature' },
    { device_uuid: 'dev-1', device_serial_no: 'SN1', sensor_uuid: 's-hum',  sensor_serial_no: 'SN1-B', channel_physical_property_name: 'Humidity' },
    { device_uuid: 'dev-2', device_serial_no: 'SN2', sensor_uuid: 's-out',  sensor_serial_no: 'SN2-A', channel_physical_property_name: 'Temperature' }
  ];
  const b = buildDeviceBridge(props);
  assert.strictEqual(b.sensorToDevice.get('s-temp'), 'dev-1');
  assert.strictEqual(b.sensorToDevice.get('s-out'), 'dev-2');
  assert.deepStrictEqual([...b.deviceSensors.get('dev-1')].sort(), ['s-hum', 's-temp']);
  assert.strictEqual(b.serialToDevice.get('SN1-A'), 'dev-1');
  assert.strictEqual(b.serialToDevice.get('SN1'), 'dev-1');
  assert.strictEqual(b.devices.size, 2);
});

test('buildSensorFilter joins sensor uuids into an OData filter, null when empty', () => {
  assert.strictEqual(buildSensorFilter(['a', 'b']), "sensor_uuid eq 'a' or sensor_uuid eq 'b'");
  assert.strictEqual(buildSensorFilter(new Set(['x'])), "sensor_uuid eq 'x'");
  assert.strictEqual(buildSensorFilter([]), null);
  assert.strictEqual(buildSensorFilter(null), null);
  assert.strictEqual(buildSensorFilter(['good-1', "bad'value", 42]), "sensor_uuid eq 'good-1'");
});

test('deriveOnline flags a device offline only when its known comm timestamp is stale', () => {
  const now = 1_000_000_000_000;
  const grace = 3600000; // 1h, the default
  // next_communication still in the future -> online
  assert.strictEqual(deriveOnline(null, now + 900000, now), 1);
  // next_communication overdue beyond grace -> offline
  assert.strictEqual(deriveOnline(null, now - grace - 1, now), 0);
  // no next_communication: fall back to last_communication freshness
  assert.strictEqual(deriveOnline(now - 1000, null, now), 1);
  assert.strictEqual(deriveOnline(now - grace - 1, null, now), 0);
  // no comm data at all -> assume online, do not fabricate an offline state
  assert.strictEqual(deriveOnline(null, null, now), 1);
});

test('deriveSystemConditions reports connection and battery system events from a status snapshot', () => {
  // healthy device -> no system conditions
  assert.deepStrictEqual(deriveSystemConditions({ online: 1, battery: 80 }), []);
  // offline -> a single connection condition
  const offline = deriveSystemConditions({ online: 0, battery: 80 });
  assert.strictEqual(offline.length, 1);
  assert.strictEqual(offline[0].type, 'connection');
  // low battery -> a single battery condition whose detail mentions the level
  const low = deriveSystemConditions({ online: 1, battery: 12 });
  assert.strictEqual(low.length, 1);
  assert.strictEqual(low[0].type, 'battery');
  assert.match(low[0].detail, /12/);
  // both at once -> two conditions
  assert.strictEqual(deriveSystemConditions({ online: 0, battery: 5 }).length, 2);
  // unknown battery (null) must NOT trigger a battery condition
  assert.deepStrictEqual(deriveSystemConditions({ online: 1, battery: null }), []);
});
