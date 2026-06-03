// Pure helpers mapping the testo identifier model (device <-> sensor <-> serial <-> property)
// into the lookups the scheduler needs. No I/O — unit-testable in isolation.

// Map a testo channel to one of the dashboard's metrics.
// Returns null for properties the dashboard has no tile for (e.g. CO2).
//
// A channel is identified by TWO fields: the generic `physical_property_name`
// (e.g. "Temperature") and the specific `physical_extension` (e.g. "Air Temperature"
// vs "Dewpoint Temperature"). Several derived channels share a property name with a
// primary metric: a device's dewpoint reports physical_property_name "Temperature"
// (dewpoint IS a temperature), and absolute humidity shares "Humidity" with relative
// humidity. Classifying on the property name alone collapses those derived channels
// into the primary series, producing two values per timestamp and wildly jumping
// readings. The extension disambiguates them, so check it first.
function mapPhysicalProperty(name, extension) {
  const p = (name || '').toLowerCase();
  const ext = (extension || '').toLowerCase();
  // Derived channels (distinguished only by extension) must NOT collapse into a primary metric.
  if (ext.includes('dew') || ext.includes('tau')) return 'dewpoint';
  if (ext.includes('absolut')) return 'abshumid';
  if (p.includes('temp')) return 'temperature';
  if (p.includes('humid') || p.includes('feucht')) return 'humidity';
  if (p.includes('press') || p.includes('druck')) return 'pressure';
  return null;
}

// Build lookup maps from Device Properties rows (one row per channel).
function buildDeviceBridge(properties) {
  const sensorToDevice = new Map();
  const deviceSensors = new Map();
  const serialToDevice = new Map();
  const devices = new Set();

  for (const row of (properties || [])) {
    const dev = row.device_uuid;
    if (!dev) continue;
    devices.add(dev);

    const sensor = row.sensor_uuid;
    if (sensor) {
      sensorToDevice.set(sensor, dev);
      if (!deviceSensors.has(dev)) deviceSensors.set(dev, new Set());
      deviceSensors.get(dev).add(sensor);
    }
    if (row.sensor_serial_no) serialToDevice.set(row.sensor_serial_no, dev);
    if (row.device_serial_no) serialToDevice.set(row.device_serial_no, dev);
  }

  return { sensorToDevice, deviceSensors, serialToDevice, devices };
}

// Build an OData $filter matching any of the given sensor uuids.
// Returns null when there are no sensors (caller should skip the request).
function buildSensorFilter(sensorUuids) {
  // Only allow id-shaped tokens (letters, digits, '-', '_') to avoid breaking/injecting the OData string.
  const list = Array.from(sensorUuids || []).filter((s) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s));
  if (list.length === 0) return null;
  return list.map((s) => `sensor_uuid eq '${s}'`).join(' or ');
}

module.exports = { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter };
