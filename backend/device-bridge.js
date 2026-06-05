// Pure helpers mapping the testo identifier model (device <-> sensor <-> serial <-> property)
// into the lookups the scheduler needs. No I/O — unit-testable in isolation.

// Map a testo channel to one of the dashboard's metrics.
// Returns null for properties the dashboard has no tile for (e.g. CO2).
//
// A channel is identified by TWO fields: the generic `physical_property_name`
// (e.g. "Temperature") and the specific `physical_extension` (e.g. "Air Temperature"
// vs "Dewpoint Temperature"). Several derived channels share a property name with a
// primary metric: a device's dewpoint reports physical_property_name "Temperature"
// (dewpoint IS a temperature), and absolute humidity reports property name "Density"
// with extension "Absolute Humidity". Classifying on the property name alone collapses
// those derived channels into the primary series, producing two values per timestamp
// and wildly jumping readings. The extension disambiguates them, so check it first.
//
// The "absolut" extension token is NOT unique to absolute humidity: barometric pressure
// reports extension "Absolute Pressure" (unit hPa, ~1000). Matching "absolut" alone
// routed that pressure channel into the abshumid series — hiding pressure entirely and
// making abs-humidity jump between ~10 g/m³ and ~1000 hPa. The humidity token in the
// extension is what separates "Absolute Humidity" from "Absolute Pressure".
function mapPhysicalProperty(name, extension) {
  const p = (name || '').toLowerCase();
  const ext = (extension || '').toLowerCase();
  // Derived channels (distinguished only by extension) must NOT collapse into a primary metric.
  if (ext.includes('dew') || ext.includes('tau')) return 'dewpoint';
  if (ext.includes('absolut') && (ext.includes('humid') || ext.includes('feucht'))) return 'abshumid';
  if (p.includes('temp')) return 'temperature';
  if (p.includes('humid') || p.includes('feucht')) return 'humidity';
  if (p.includes('press') || p.includes('druck')) return 'pressure';
  return null;
}

// Derive a device's online state (1/0) from its communication timestamps (ms epoch).
// Prefer the device's promised next_communication; if it is overdue past the grace
// window the device is offline. With no comm data at all we assume online rather than
// fabricating an offline state for a device that simply has not reported yet.
function deriveOnline(lastCommTs, nextCommTs, now, graceMs = 3600000) {
  if (nextCommTs != null) return now <= nextCommTs + graceMs ? 1 : 0;
  if (lastCommTs != null) return now - lastCommTs <= graceMs ? 1 : 0;
  return 1;
}

// Given a device-status snapshot ({ online: 1|0, battery: number|null }), return the
// list of system conditions currently TRUE. Each entry { type, message, detail } maps
// straight onto the dashboard's system-event rendering (type -> the system icon;
// message/detail -> the headline/sub text). type values: 'connection', 'battery'.
function deriveSystemConditions(snapshot, opts = {}) {
  const batteryLowPct = opts.batteryLowPct ?? 20;
  const out = [];
  if (snapshot.online === 0) {
    out.push({
      type: 'connection',
      message: 'Verbindung verloren',
      detail: 'Gerät hat sich nicht im erwarteten Intervall gemeldet.',
    });
  }
  if (snapshot.battery != null && snapshot.battery <= batteryLowPct) {
    out.push({
      type: 'battery',
      message: 'Batterie schwach',
      detail: `Batteriestand bei ${snapshot.battery} %.`,
    });
  }
  return out;
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

module.exports = { mapPhysicalProperty, buildDeviceBridge, buildSensorFilter, deriveOnline, deriveSystemConditions };
