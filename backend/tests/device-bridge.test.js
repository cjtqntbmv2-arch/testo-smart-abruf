const test = require('node:test');
const assert = require('node:assert');
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter } = require('../device-bridge');

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
