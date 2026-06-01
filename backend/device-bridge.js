// Pure helpers mapping the testo identifier model (device <-> sensor <-> serial <-> property)
// into the lookups the scheduler needs. No I/O — unit-testable in isolation.

// Map a testo physical_property_name to one of the dashboard's three metrics.
// Returns null for properties the dashboard has no tile for (e.g. CO2).
function mapPhysicalProperty(name) {
  const p = (name || '').toLowerCase();
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
