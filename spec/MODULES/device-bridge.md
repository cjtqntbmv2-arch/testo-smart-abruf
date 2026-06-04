# Module: `backend/device-bridge.js`

Pure helpers (no I/O) mapping the testo identifier model (device ↔ sensor ↔ serial ↔ property) into the lookups the scheduler needs. Unit-tested in isolation.

```js
module.exports = { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter };
```

## `mapPhysicalProperty(name, extension) → metricId | null`

Maps a testo channel to a dashboard metric id. Returns `null` for properties with no tile (e.g. CO₂). **Order matters** — extension is checked first so derived channels never collapse into a primary metric.

```js
function mapPhysicalProperty(name, extension) {
  const p = (name || '').toLowerCase();
  const ext = (extension || '').toLowerCase();
  if (ext.includes('dew') || ext.includes('tau')) return 'dewpoint';
  if (ext.includes('absolut')) return 'abshumid';
  if (p.includes('temp')) return 'temperature';
  if (p.includes('humid') || p.includes('feucht')) return 'humidity';
  if (p.includes('press') || p.includes('druck')) return 'pressure';
  return null;
}
```

**Why the extension check exists (load-bearing):** a testo dewpoint channel reports `physical_property_name = "Temperature"` (dewpoint *is* a temperature), and absolute humidity shares `"Humidity"` with relative humidity. Classifying on the property name alone stores two `temperature` (or two `humidity`) rows per timestamp → wildly jumping readings. The `physical_extension` (e.g. "Dewpoint Temperature" / "Absolute Humidity") disambiguates. German substrings (`tau`, `feucht`, `druck`, `absolut`) are matched alongside English. Called single-arg for alarms (`mapPhysicalProperty(a.physical_value)`), where `extension` is undefined → only the name branches apply.

## `buildDeviceBridge(properties) → { sensorToDevice, deviceSensors, serialToDevice, devices }`

Input: array of Device Properties rows (one per channel; fields `device_uuid`, `sensor_uuid`, `sensor_serial_no`, `device_serial_no`). Builds:
- `sensorToDevice: Map<sensor_uuid, device_uuid>`
- `deviceSensors: Map<device_uuid, Set<sensor_uuid>>`
- `serialToDevice: Map<serial, device_uuid>` (both `sensor_serial_no` and `device_serial_no` keys)
- `devices: Set<device_uuid>`

Rows without `device_uuid` are skipped. Rows without `sensor_uuid` still register the device + any serials.

## `buildSensorFilter(sensorUuids) → string | null`

Builds an OData `$filter` matching any of the given sensor uuids:
```js
list.map(s => `sensor_uuid eq '${s}'`).join(' or ')
```
**Injection guard:** only tokens matching `/^[A-Za-z0-9_-]+$/` are included (others dropped) so the OData string can't be broken/injected. Returns `null` when no valid sensors (caller must skip the request).

## Open Questions

None.
