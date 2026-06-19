const test = require('node:test');
const assert = require('node:assert');
const { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions, classifyAlarm, alarmConditionDirection, parseAlarmConfiguration, systemAlarmText } = require('../device-bridge');

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

test('classifyAlarm routes testo system alarms to the system severity with a normalized subtype', () => {
  // Real bug: testo delivers connection/battery problems through its alarm feed as
  // alarm_type "device system alarm" / "sensor system alarm". Classifying on
  // alarm_severity alone (Warning/Alarm) buried them among measurement warnings, so
  // the dashboard never showed them as system messages. alarm_type is what marks a
  // system alarm; alarm_condition_type supplies the connection/battery subtype the
  // frontend renders an icon for.
  assert.deepStrictEqual(
    classifyAlarm({ alarm_type: 'device system alarm', alarm_severity: 'Warning', alarm_condition_type: 'Connection timeout, device did not communicated in expected time' }),
    { severity: 'system', systemType: 'connection' });
  assert.deepStrictEqual(
    classifyAlarm({ alarm_type: 'sensor system alarm', alarm_severity: 'Warning', alarm_condition_type: 'Battery low' }),
    { severity: 'system', systemType: 'battery' });
  // A system alarm whose condition is neither connection nor battery still renders as
  // a system message, under the generic maintenance subtype.
  assert.deepStrictEqual(
    classifyAlarm({ alarm_type: 'device system alarm', alarm_severity: 'Alarm', alarm_condition_type: 'Firmware update required' }),
    { severity: 'system', systemType: 'maintenance' });
  // Measurement alarms keep the severity/Warning mapping and carry no system subtype.
  assert.deepStrictEqual(
    classifyAlarm({ alarm_type: 'measurement_alarm', alarm_severity: 'Alarm', alarm_condition_type: 'Upper limit' }),
    { severity: 'alarm', systemType: null });
  assert.deepStrictEqual(
    classifyAlarm({ alarm_type: 'measurement_alarm', alarm_severity: 'Warning', alarm_condition_type: 'Upper limit' }),
    { severity: 'warning', systemType: null });
  // Fallback: when alarm_type is absent (older rows), a connection/battery condition
  // string still classifies as a system alarm rather than a plain warning.
  assert.deepStrictEqual(
    classifyAlarm({ alarm_severity: 'Warning', alarm_condition_type: 'Connection timeout, device did not communicated in expected time' }),
    { severity: 'system', systemType: 'connection' });
  // Fallback with no type hints at all defaults to a warning.
  assert.deepStrictEqual(
    classifyAlarm({}),
    { severity: 'warning', systemType: null });
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

// ── B2: alarmConditionDirection ───────────────────────────────────────────
test('alarmConditionDirection maps condition type strings to high/low/null', () => {
  // Live API strings from verified real fetch
  assert.strictEqual(alarmConditionDirection('Upper limit'), 'high');
  assert.strictEqual(alarmConditionDirection('Lower limit'), 'low');
  // Legacy/variation strings
  assert.strictEqual(alarmConditionDirection('HighLimit'), 'high');
  assert.strictEqual(alarmConditionDirection('LowLimit'), 'low');
  assert.strictEqual(alarmConditionDirection('Obere Grenze'), 'high');
  assert.strictEqual(alarmConditionDirection('Untere Grenze'), 'low');
  // System alarms / unknowns return null — no threshold direction for those
  assert.strictEqual(alarmConditionDirection('Connection timeout'), null);
  assert.strictEqual(alarmConditionDirection('Battery low'), null);
  assert.strictEqual(alarmConditionDirection(''), null);
  assert.strictEqual(alarmConditionDirection(null), null);
  assert.strictEqual(alarmConditionDirection(undefined), null);
  // Case-insensitive
  assert.strictEqual(alarmConditionDirection('UPPER LIMIT'), 'high');
  assert.strictEqual(alarmConditionDirection('lower limit'), 'low');
});

// ── B2: parseAlarmConfiguration ──────────────────────────────────────────
// Live-shaped measuring-object fixture: 8 conditions matching the real tenant
// (2 metrics × 2 directions × 2 severities).
function makeMoRow(overrides = {}) {
  const config = {
    measurementAlarmConditionSet: [{
      measurementAlarmConditions: [
        { measurementAlarmConditionTypeId: 'Lower limit', alarmSeverityId: 'Warning',  physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 20, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' },
        { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Warning',  physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 26, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' },
        { measurementAlarmConditionTypeId: 'Lower limit', alarmSeverityId: 'Alarm',    physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 18, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' },
        { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Alarm',    physicalProperty: { physicalValueId: 'Temperature' }, limitValue: 28, limitHysteresis: 0, delay: 600000, physicalUnitId: '°C' },
        { measurementAlarmConditionTypeId: 'Lower limit', alarmSeverityId: 'Warning',  physicalProperty: { physicalValueId: 'Humidity' },    limitValue: 35, limitHysteresis: 0, delay: 600000, physicalUnitId: '%rF' },
        { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Warning',  physicalProperty: { physicalValueId: 'Humidity' },    limitValue: 55, limitHysteresis: 0, delay: 600000, physicalUnitId: '%rF' },
        { measurementAlarmConditionTypeId: 'Lower limit', alarmSeverityId: 'Alarm',    physicalProperty: { physicalValueId: 'Humidity' },    limitValue: 30, limitHysteresis: 0, delay: 600000, physicalUnitId: '%rF' },
        { measurementAlarmConditionTypeId: 'Upper limit', alarmSeverityId: 'Alarm',    physicalProperty: { physicalValueId: 'Humidity' },    limitValue: 60, limitHysteresis: 0, delay: 600000, physicalUnitId: '%rF' },
      ]
    }]
  };
  return Object.assign(
    { measuring_object_uuid: 'mo-1', measurement_alarm_configuration: JSON.stringify(config), channel_assignments: null },
    overrides
  );
}

test('parseAlarmConfiguration returns 8 entries for a single live-shaped MO row', () => {
  const result = parseAlarmConfiguration([makeMoRow()]);
  assert.strictEqual(result.length, 8, 'one row with 8 conditions -> 8 entries');

  // Check a few specific entries for correct field mapping
  const tempLowAlarm = result.find(e => e.metric === 'temperature' && e.direction === 'low' && e.severity === 'alarm');
  assert.ok(tempLowAlarm, 'temperature low alarm must be present');
  assert.strictEqual(tempLowAlarm.limitValue, 18);
  assert.strictEqual(tempLowAlarm.unit, '°C');
  assert.strictEqual(tempLowAlarm.delayMs, 600000);
  assert.strictEqual(tempLowAlarm.hysteresis, 0);

  const humHighWarning = result.find(e => e.metric === 'humidity' && e.direction === 'high' && e.severity === 'warning');
  assert.ok(humHighWarning);
  assert.strictEqual(humHighWarning.limitValue, 55);
  assert.strictEqual(humHighWarning.unit, '%rF');
});

test('parseAlarmConfiguration deduplicates identical MOs — returns 8 entries (not 16)', () => {
  // The real tenant has 5 MOs with identical configuration; deduplication keeps 8.
  const rows = [makeMoRow({ measuring_object_uuid: 'mo-1' }), makeMoRow({ measuring_object_uuid: 'mo-2' })];
  const result = parseAlarmConfiguration(rows);
  assert.strictEqual(result.length, 8, 'identical duplicate MOs must not multiply entries');
});

test('parseAlarmConfiguration drops a key when two MOs disagree on limitValue', () => {
  // mo-1: temp low alarm = 18, mo-2: temp low alarm = 16 -> conflict -> key dropped
  const config2 = JSON.parse(makeMoRow().measurement_alarm_configuration);
  const conds2 = config2.measurementAlarmConditionSet[0].measurementAlarmConditions;
  conds2.find(c => c.measurementAlarmConditionTypeId === 'Lower limit' && c.alarmSeverityId === 'Alarm' && c.physicalProperty.physicalValueId === 'Temperature').limitValue = 16;
  const mo2 = makeMoRow({ measuring_object_uuid: 'mo-2', measurement_alarm_configuration: JSON.stringify(config2) });

  const result = parseAlarmConfiguration([makeMoRow(), mo2]);
  // temperature:low:alarm is dropped; remaining 7 entries survive
  assert.strictEqual(result.length, 7, 'conflicting key must be dropped');
  const conflicted = result.find(e => e.metric === 'temperature' && e.direction === 'low' && e.severity === 'alarm');
  assert.strictEqual(conflicted, undefined, 'conflicted key must not appear in output');
});

test('parseAlarmConfiguration skips rows with malformed or missing configuration', () => {
  const rows = [
    { measuring_object_uuid: 'mo-null', measurement_alarm_configuration: null },
    { measuring_object_uuid: 'mo-empty', measurement_alarm_configuration: '' },
    { measuring_object_uuid: 'mo-bad', measurement_alarm_configuration: '{not valid json' },
    makeMoRow({ measuring_object_uuid: 'mo-good' })
  ];
  const result = parseAlarmConfiguration(rows);
  assert.strictEqual(result.length, 8, 'bad rows are skipped; the good MO produces 8 entries');
});

test('parseAlarmConfiguration skips conditions with unknown physicalValueId', () => {
  const config = JSON.parse(makeMoRow().measurement_alarm_configuration);
  // Replace one condition's physicalValueId with an unknown metric (e.g. CO2)
  config.measurementAlarmConditionSet[0].measurementAlarmConditions[0].physicalProperty.physicalValueId = 'CO2';
  const row = makeMoRow({ measurement_alarm_configuration: JSON.stringify(config) });
  const result = parseAlarmConfiguration([row]);
  // 8 conditions -> 1 with CO2 (null metric) is skipped -> 7
  assert.strictEqual(result.length, 7);
});

test('systemAlarmText returns German headline + detail per system subtype, with a maintenance fallback', () => {
  assert.deepStrictEqual(systemAlarmText('connection'),
    { message: 'Verbindung verloren', detail: 'Gerät hat sich nicht im erwarteten Intervall gemeldet.' });
  assert.deepStrictEqual(systemAlarmText('battery'),
    { message: 'Batterie schwach', detail: 'Batteriestand des Geräts ist niedrig.' });
  assert.deepStrictEqual(systemAlarmText('maintenance'),
    { message: 'Gerätehinweis', detail: 'Das Gerät meldet einen Geräte- oder Wartungshinweis.' });
  // Unbekannte / fehlende Subtypen fallen sicher auf den maintenance-Text zurück (nie "undefined").
  assert.deepStrictEqual(systemAlarmText('unbekannt'), systemAlarmText('maintenance'));
  assert.deepStrictEqual(systemAlarmText(null), systemAlarmText('maintenance'));
  assert.deepStrictEqual(systemAlarmText(undefined), systemAlarmText('maintenance'));
});
