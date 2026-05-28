---
source_url: https://developers.testo.dev/smart-connect-api/odata-filtering/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-odata
---

# OData Filtering

OData system query options let you filter, project and sort the result set
directly in your Smart Connect API request. The backend applies them **before**
the result file is generated, which reduces the size of the downloaded file
and removes the need for client-side post-processing.

This page is the syntax reference. For copy-paste-ready curl invocations that
combine these OData options with full request bodies, see the
[Examples / Curl Cookbook](05-endpoints/README.md). For background on how the
asynchronous submit-then-poll flow consumes these options, see
[Concepts](03-async-pattern.md).

## Supported endpoints

OData query options are available on all asynchronous endpoint pairs:

- **Device Properties** — `POST /v3/devices/properties`
- **Device Status** — `POST /v3/devices/status`
- **Measurements** — `POST /v2/measurements`
- **Alarms** — `POST /v3/alarms`
- **Locations** — `POST /v1/locations`
- **Measuring Objects** — `POST /v1/measuring-objects`

## `$filter` operators

Use the `$filter` option to restrict results based on conditions. The
following comparison and logical operators are supported:

| Operator | Description           | Example                                                              |
| -------- | --------------------- | -------------------------------------------------------------------- |
| `eq`     | Equal                 | `connection_type eq 'CT_WIFI'`                                       |
| `ne`     | Not equal             | `alarm_status ne 'Ok'`                                               |
| `gt`     | Greater than          | `battery_level_percent gt 50`                                        |
| `ge`     | Greater than or equal | `battery_level_percent ge 20`                                        |
| `lt`     | Less than             | `battery_level_percent lt 10`                                        |
| `le`     | Less than or equal    | `radio_level_percent le 30`                                          |
| `and`    | Logical AND           | `alarm_status eq 'Alarm' and alarm_severity eq 'Warning'`            |
| `or`     | Logical OR            | `connection_type eq 'CT_WIFI' or connection_type eq 'CT_ETHERNET'`   |
| `not`    | Logical NOT           | `not is_powersupply_on eq true`                                      |

## `$filter` string functions

The following string functions can be used within `$filter` expressions:

| Function                    | Description       | Example                            |
| --------------------------- | ----------------- | ---------------------------------- |
| `contains(field, 'value')`  | Substring match   | `contains(name, 'Cold Storage')`   |
| `startswith(field, 'value')`| Starts with prefix| `startswith(serial_no, '556')`     |
| `endswith(field, 'value')`  | Ends with suffix  | `endswith(fw_version, '.1')`       |

## `$select`

Use `$select` to specify which columns to include in the result. This reduces
file size and download time.

```json
"$select": "device_uuid,serial_no,battery_level_percent,last_communication"
```

> **Tip:** Using `$select` to request only the fields you need can
> significantly reduce download size and processing time, especially for
> endpoints with many fields like Device Properties.

## `$orderby`

Use `$orderby` to sort results by one or more columns. Specify `asc` for
ascending (default) or `desc` for descending order.

```json
"$orderby": "alarm_time desc,alarm_severity asc"
```

You can sort by multiple columns by separating them with commas. The results
will be sorted by the first column, then by the second column for rows with
the same first column value, and so on.

## Practical OData scenarios

The following scenarios show how to combine `$filter`, `$select` and
`$orderby` for common use cases. Only the `odata` object (plus surrounding
request-body fields where required by the endpoint) is shown here; full curl
invocations live in [the endpoint reference](05-endpoints/README.md).

### 1. Low Battery Wi-Fi Devices (Device Status)

Find all Wi-Fi connected devices with battery below 20 % to schedule
maintenance:

```json
{
  "options": { "result_file_format": "CSV" },
  "odata": {
    "$filter": "connection_type eq 'CT_WIFI' and battery_level_percent lt 20",
    "$select": "device_uuid,serial_no,battery_level_percent,last_communication",
    "$orderby": "battery_level_percent asc"
  }
}
```

### 2. Active Alarms Sorted by Time (Alarms)

Retrieve all currently active alarms, most recent first:

```json
{
  "date_time_from": "2025-04-01T00:00:00Z",
  "date_time_until": "2025-04-30T23:59:59Z",
  "options": { "result_file_format": "CSV" },
  "odata": {
    "$filter": "alarm_status eq 'Alarm'",
    "$select": "uuid,alarm_reason,alarm_severity,alarm_time,alarm_value,physical_unit,serial_no",
    "$orderby": "alarm_time desc"
  }
}
```

### 3. Temperature Alarms in a Date Range (Alarms)

Retrieve only temperature-related alarms for a specific month:

```json
{
  "date_time_from": "2025-04-01T00:00:00Z",
  "date_time_until": "2025-04-30T23:59:59Z",
  "options": { "result_file_format": "CSV" },
  "odata": {
    "$filter": "physical_value eq 'Temperature'",
    "$select": "uuid,alarm_reason,alarm_severity,alarm_time,alarm_value,physical_unit,serial_no,alarm_type",
    "$orderby": "alarm_time desc"
  }
}
```

### 4. Locations of a Specific Type (Locations)

Retrieve all measurement site locations with a specific subtype:

```json
{
  "options": { "result_file_format": "CSV" },
  "odata": {
    "$filter": "location_type eq 'Measurement site' and location_subtype eq 'Ventilation'",
    "$select": "location_uuid,name,location_type,location_subtype,parent_uuid",
    "$orderby": "name asc"
  }
}
```

### 5. Devices Not Communicating Recently (Device Status)

Identify devices that have not communicated since a specific date:

```json
{
  "options": { "result_file_format": "CSV" },
  "odata": {
    "$filter": "last_communication lt '2025-04-01T00:00:00Z'",
    "$select": "device_uuid,serial_no,connection_type,last_communication,fw_version",
    "$orderby": "last_communication asc"
  }
}
```

### 6. Measuring Objects for a Product Family (Measuring Objects)

Retrieve all measuring objects belonging to the "savr" product family:

```json
{
  "options": { "result_file_format": "JSON" },
  "odata": {
    "$filter": "product_family_id eq 'savr'",
    "$select": "mo_uuid,customer_uuid,product_family_id,customer_site,measurement_alarm_configuration"
  }
}
```

### 7. Locations Matching a Name Pattern (Locations)

Find all locations whose name contains "Cold Storage":

```json
{
  "options": { "result_file_format": "CSV" },
  "odata": {
    "$filter": "contains(name, 'Cold Storage')",
    "$select": "location_uuid,name,location_type,location_subtype",
    "$orderby": "name asc"
  }
}
```

---

For complete curl invocations combining these OData options with full request
bodies, see [the endpoint reference](05-endpoints/README.md).
