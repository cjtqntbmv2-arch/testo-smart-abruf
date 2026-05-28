---
source_url: https://developers.testo.dev/smart-connect-api/examples/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-examples
  - _assets/openapi.json
---

# Retrievable Parameters

This is a consolidated overview of every data column the API can return,
grouped by endpoint. These are the fields that appear in the downloaded
result files and that you can project with `odata.$select`, filter with
`odata.$filter`, and sort with `odata.$orderby`.

The columns are resolved from each endpoint's `x-file-content` schema in
`_assets/openapi.json` (the per-endpoint pages link to these schemas but
do not enumerate them). Types are shown as `type` or `type/format`.

| Endpoint | Columns |
| --- | --- |
| [Device Properties](#device-properties-v3devicesproperties) | 40 |
| [Alarms](#alarms-v3alarms) | 19 |
| [Measurements](#measurements-v2measurements) | 14 |
| [Device Status](#device-status-v3devicesstatus) | 14 |
| [Locations](#locations-v1locations) | 9 |
| [Measuring Objects](#measuring-objects-v1measuring-objects) | 9 |

Common identifiers recur across endpoints: `uuid` (row-level dedupe key,
see [Concepts](../03-async-pattern.md)), `tenant_uuid` (the account),
`serial_no` / `sensor_uuid` / `device_uuid` (the hardware), and
`customer_site` (the site). Timestamps are UTC ISO-8601 unless the column
name ends in `_local`.

## Device Properties (`/v3/devices/properties`)

Current property snapshot of every device, sensor, and channel in the
tenant. One row per channel, so a device with multiple channels appears
multiple times.

| Column | Type | Description |
| --- | --- | --- |
| `channel_attenuation` | number | Product simulation attenuation (product simulation coefficient) |
| `channel_id` | integer/int64 | Unique identifier of the channel |
| `channel_is_calibration_possible` | string | Is the probe calibratable |
| `channel_is_external` | string | Is the probe external |
| `channel_last_modified` | string/date-time | Time the channel was last modified (ISO-8601) |
| `channel_no` | integer | Number identifying a specific channel of a sensor that has multiple ones |
| `channel_physical_extension` | string | Physical extension defining the channel (e.g. Air Temperature, Absolute Humidity, Door Contact) |
| `channel_physical_property_name` | string | Physical property name of the channel (e.g. Temperature, Density, Door) |
| `channel_physical_unit` | string | The measurement unit (e.g. °C, %rF, g/m³) |
| `channel_physical_unit_exponent` | integer | Exponent of the measurement — number of decimal places |
| `customer_site` | string | Identifier for the customer site |
| `device_category` | string | Category of the device (e.g. LOGGER, GATEWAY) |
| `device_communication_log_time` | integer | Communication time interval (milliseconds) |
| `device_display_name` | string | Name of the logger |
| `device_firmware_version` | string | Firmware version of the device |
| `device_is_active` | string | Whether the device is active |
| `device_is_ethernetprobe` | string | Is the probe an ethernet probe |
| `device_is_powersuppliable` | string | Is the probe power-suppliable |
| `device_is_wirelessprobe` | string | Is the probe a radio probe |
| `device_last_modified` | string/date-time | Time the device was last modified (ISO-8601) |
| `device_measuring_cycle` | integer | Device measuring cycle interval (milliseconds) |
| `device_measuring_cycle_effective` | integer | Effective device measuring cycle interval (milliseconds) |
| `device_model_code` | string | Device article number |
| `device_serial_no` | string | Serial number of the device |
| `device_supported_battery_types` | array | Supported battery types of the device |
| `device_uuid` | string | Unique identifier of the device |
| `equipment_parts_uuid` | string/uuid | Equipment identifier the sensor is assigned to |
| `equipment_uuid` | string/uuid | Equipment identifier the device is assigned to |
| `sensor_display_name` | string | Name of the sensor |
| `sensor_firmware_version` | string | Firmware version of the sensor |
| `sensor_is_connected` | string | Is the sensor connected |
| `sensor_is_radio` | string | Is the sensor wireless |
| `sensor_is_wired` | string | Is the sensor wired |
| `sensor_last_modified` | string/date-time | Time the sensor was last modified (ISO-8601) |
| `sensor_measuring_cycle` | integer | Sensor measuring cycle interval (milliseconds) |
| `sensor_measuring_cycle_effective` | integer | Effective sensor measuring cycle interval (milliseconds) |
| `sensor_model_code` | string | Article number of the sensor |
| `sensor_serial_no` | string | Serial number of the sensor |
| `sensor_uuid` | string/uuid | Unique identifier of the sensor |
| `tenant_uuid` | string | Unique identifier of the tenant account |

## Device Status (`/v3/devices/status`)

Live operational status per device: battery, signal, and the last/next
communication and measurement times.

| Column | Type | Description |
| --- | --- | --- |
| `battery_level_percent` | integer | Battery level in percent |
| `connection_type` | string | Connection type of the device |
| `customer_site` | string/uuid | Site that operates the device |
| `device_uuid` | string/uuid | Unique identifier of the device |
| `fw_version` | string | Firmware version of the device |
| `is_powersupply_on` | boolean | Is the power supply on |
| `last_communication` | string/date-time | Last time the device communicated (UTC) |
| `last_measurement_time` | string/date-time | Last time the device took a measurement (UTC) |
| `model_code` | string | Article number of the device |
| `next_communication` | string/date-time | Next time the device will communicate (UTC) |
| `processed_at` | string/date-time | Time the device status was processed (UTC) |
| `radio_level_percent` | integer | Radio signal level in percent |
| `serial_no` | string | Serial number of the device |
| `tenant_uuid` | string/uuid | Unique identifier of the tenant account |

## Measurements (`/v2/measurements`)

The actual measurement values across a time range. Highest-volume
endpoint — bound it with a date window and `$filter`.

| Column | Type | Description |
| --- | --- | --- |
| `channel_no` | integer | Channel number on the sensor |
| `customer_site` | string/uuid | Site beneath the tenant that operates the logger |
| `measurement` | number | Measurement value |
| `model_code` | string | Model code of the sensor |
| `physical_extension` | string | Physical value/extension defining the channel (e.g. Door Contact, Product Temperature) |
| `physical_property_name` | string | Property name of the channel (e.g. Temperature, Humidity, Density) |
| `physical_unit` | string | The measurement unit (e.g. CELSIUS, FAHRENHEIT) |
| `processed_at` | string/date-time | Time the measurement was received by the testo Cloud |
| `sensor_uuid` | string/uuid | Unique identifier of the sensor that took the measurement |
| `serial_no` | string | Serial number of the sensor |
| `tenant_uuid` | string/uuid | Unique identifier of the tenant account |
| `timestamp` | string/date-time | Time the measurement was taken by the datalogger (UTC) |
| `timestamp_local` | string/date-time | Time the measurement was taken by the datalogger (local timezone) |
| `uuid` | string/uuid | Unique identifier of the measurement (row-level dedupe key) |

## Alarms (`/v3/alarms`)

Alarm events across a time range, including the triggering value, the
condition type, severity, and status transitions.

| Column | Type | Description |
| --- | --- | --- |
| `alarm_condition_type` | string | Type of alarm condition (e.g. Upper limit, connection timeout) |
| `alarm_reason` | string | Reason that caused the alarm (e.g. alarm condition violated) |
| `alarm_severity` | string | Severity of the alarm |
| `alarm_source_uuid` | string/uuid | UUID of the source that caused the alarm (e.g. sensor_uuid, device_uuid) |
| `alarm_status` | string | Actual status of the alarm |
| `alarm_time` | string/date-time | Time the alarm occurred (UTC) |
| `alarm_time_local` | string/date-time | Time the alarm occurred (local timezone) |
| `alarm_type` | string | Type of alarm |
| `alarm_value` | number | Measurement value that caused the alarm |
| `customer_site_uuid` | string/uuid | Site the alarm occurred in |
| `last_status_change_time` | string/date-time | Last time the alarm condition status changed |
| `physical_unit` | string | The measurement unit (e.g. °C, %rF) |
| `physical_value` | string | Physical value defining the channel (e.g. Temperature, Humidity, Door) |
| `physical_value_extension` | string | Physical extension defining the channel (e.g. Product Temperature, Relative Humidity, Door Contact) |
| `processed_at` | string/date-time | Time the alarm was received by the testo Cloud |
| `serial_no` | string | Serial number of the sensor that detected the alarm |
| `source_alarm_event_uuid` | string/uuid | Source alarm UUID related to a back-to-normal event (set only on back-to-normal) |
| `tenant_uuid` | string/uuid | Unique identifier of the tenant account |
| `uuid` | string/uuid | Unique identifier of the alarm (row-level dedupe key) |

## Locations (`/v1/locations`)

The location hierarchy (customer sites, measurement sites) with parent
references.

| Column | Type | Description |
| --- | --- | --- |
| `last_modified_at` | string/date-time | Time the location was last modified (UTC) |
| `location_subtype` | string | Subtype of the location (e.g. ventilation and flue gas) |
| `location_type` | string | Type of the location (e.g. customer, measurement site) |
| `location_uuid` | string/uuid | Unique identifier of the location |
| `name` | string | Name of the location |
| `parent_location_type` | string | Type of the parent location (e.g. customer, measurement site) |
| `parent_uuid` | string | Unique identifier of the parent location |
| `tenant_uuid` | string/uuid | Unique identifier of the tenant account |
| `valid_from` | string/date-time | Time the location was created (UTC) |

## Measuring Objects (`/v1/measuring-objects`)

The logical measuring objects, including their channel assignments and
alarm-limit configuration. Several columns are JSON-encoded strings that
must be parsed after download (this is where alarm thresholds live — see
[Limit Values](../09-limit-values.md)).

| Column | Type | Description |
| --- | --- | --- |
| `channel_assignments` | string/json | JSON-encoded object describing channel assignments |
| `customer_site` | string | Identifier for the customer site |
| `customer_uuid` | string/uuid | Unique identifier of the customer account |
| `measurement_alarm_configuration` | string/json | JSON-encoded object describing the alarm configuration for measurements |
| `measuring_instructions` | string/json | JSON-encoded object describing measuring instructions |
| `mo_uuid` | string/uuid | Unique identifier of the measuring object |
| `product_family_id` | string | Product family (e.g. savr, sav3, data layer) |
| `valid_from` | string/date-time | Time the measuring object was created (UTC) |
| `version_timestamp` | string/date-time | Version timestamp (UTC) |

See also: [Endpoint Reference](./README.md) ·
[OData Filtering](../04-odata-filtering.md) ·
[Limit Values](../09-limit-values.md)
