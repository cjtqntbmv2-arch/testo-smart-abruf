---
source_url: https://developers.testo.dev/smart-connect-api/examples/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-examples
  - _assets/openapi.json
---

# Device Status

Retrieve the current operational status of devices — including connection
type, battery level, radio signal strength, firmware version (v3 only),
and communication timestamps. This endpoint pair supports OData filtering.

The original v3 endpoint pair is documented below, alongside the v4 result
schema introduced on 2026-05-13. The v4 column changes (additions,
renames, removals) are summarised after the v3 reference.

## Endpoint paths

| Operation | Path                                |
| --------- | ----------------------------------- |
| POST      | `/v3/devices/status`                |
| GET       | `/v3/devices/status/{request_uuid}` |

> **Note on v4.** `_assets/openapi.json` defines the result-file schemas
> `AsyncDevicesStatusV4FileContentObject` and
> `AsyncDevicesStatusV4SuccessResponse` (the v4 column shape) but does
> **not** expose a separate `/v4/devices/status` path under `paths`. The
> POST `/v3/devices/status` operation in the spec is marked
> `deprecated: true`, and its GET still references the v3 file-content
> schema. The v4 path mapping in the public API is `TODO: source
> unavailable` — readers should consult the changelog entry for
> 2026-05-13 and the testo API Reference for the canonical v4 path.

## Date range support

No. Device Status returns the current snapshot — `date_time_from` and
`date_time_until` are not accepted.

## OData support

Yes. See [OData Filtering](../04-odata-filtering.md).

## Request body schema

Identical for both versions, resolved from
`components.schemas.GeneralAsyncRequestV3`.

| Field                        | Type   | Required | Description                                                                                                              |
| ---------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `options`                    | object | No       | Additional parameters such as the file format of the result. Resolves to `GeneralAsyncOptionsV3`.                        |
| `options.result_file_format` | string | No       | Result file format. Enum: `CSV`, `ORC`, `PARQUET`, `AVRO`, `JSON`, `TEXTFILE`. Defaults to `CSV`.                        |
| `odata`                      | object | No       | OData system query options applied to the result set. Resolves to `ODataQueryOptions`.                                   |
| `odata.$filter`              | string | No       | Filter expression using OData operators (`eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not`) and string functions.   |
| `odata.$select`              | string | No       | Comma-separated list of column names to include in the response.                                                         |
| `odata.$orderby`             | string | No       | Comma-separated list of columns with optional `asc` or `desc` direction.                                                 |

## Response schema (POST submit)

`200 OK` returns `GeneralAsyncSuccessResponse`:

| Field          | Type          | Description                                       |
| -------------- | ------------- | ------------------------------------------------- |
| `status`       | string        | Initial status of the request — `Submitted`.      |
| `request_uuid` | string (uuid) | UUID used as the path parameter on the GET endpoint. |

## Response schema (GET poll)

`200 OK` returns `AsyncDevicesStatusSuccessResponse` (v3) or
`AsyncDevicesStatusV4SuccessResponse` (v4). Both compose `StatusRequest`
with an `x-file-content` schema describing the columns in the downloaded
result file.

| Field            | Type           | Description                                                                              |
| ---------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `status`         | string         | One of `Completed`, `In Progress`, `Error`. (`Submitted` and `Failed` per [Concepts](../03-async-pattern.md).) |
| `data_urls`      | array<string>  | Pre-signed S3 URLs to result files. Present when `status` is `Completed`.                |
| `metadata_url`   | string         | Pre-signed S3 URL to the result metadata schema. Present when `status` is `Completed`.   |
| `x-file-content` | object         | Schema describing the columns in the downloaded files — differs between v3 and v4 (see below). |

### v3 result columns (`AsyncDevicesStatusFileContentObject`)

| Column                  | Type             | Description                                                                |
| ----------------------- | ---------------- | -------------------------------------------------------------------------- |
| `device_uuid`           | string (uuid)    | Unique identifier of the device.                                           |
| `tenant_uuid`           | string (uuid)    | Unique identifier of the tenant account.                                   |
| `customer_site`         | string (uuid)    | Site/Restaurant who operates the device.                                   |
| `serial_no`             | string           | Serial number of the device.                                               |
| `model_code`            | string           | Article number of the device.                                              |
| `fw_version`            | string           | Firmware version of the device.                                            |
| `connection_type`       | string (enum)    | `CT_UNKNOWN`, `CT_WIFI`, `CT_ETHERNET`.                                    |
| `battery_level_percent` | integer (0–100)  | Battery level in percent.                                                  |
| `radio_level_percent`   | integer (0–100)  | Radio level in percent.                                                    |
| `is_powersupply_on`     | boolean          | Whether the power supply is on.                                            |
| `last_communication`    | string (date-time, UTC) | Last time the device communicated.                                  |
| `next_communication`    | string (date-time, UTC) | Next scheduled communication.                                       |
| `last_measurement_time` | string (date-time, UTC) | Last time the device took a measurement.                            |
| `processed_at`          | string (date-time, UTC) | Time at which the device status was processed.                      |

### v4 result columns (`AsyncDevicesStatusV4FileContentObject`)

| Column                    | Type             | Description                                                              |
| ------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `device_uuid`             | string (uuid)    | Unique identifier of the device.                                         |
| `tenant_uuid`             | string (uuid)    | Unique identifier of the tenant account.                                 |
| `customer_site`           | string (uuid)    | Site/Restaurant who operates the device.                                 |
| `serial_no`               | string           | Serial number of the device.                                             |
| `model_code`              | string           | Article number of the device.                                            |
| `production_date`         | string (date)    | **New in v4.** Production date of the device (UTC, `YYYY-MM-DD`).        |
| `connection_type`         | string (enum)    | `UNKNOWN`, `WIFI`, `ETHERNET` (note: `CT_` prefix dropped in v4).        |
| `battery_level_percent`   | integer (0–100)  | Battery level in percent.                                                |
| `battery_temperature`     | number           | **New in v4.** Battery temperature in degrees Celsius.                   |
| `radio_level_percent`     | integer (0–100)  | Radio level in percent.                                                  |
| `is_powersupply_on`       | boolean          | Whether the power supply is on.                                          |
| `last_communication_time` | string (date-time, UTC) | **Renamed.** Was `last_communication` in v3.                      |
| `next_communication_time` | string (date-time, UTC) | **Renamed.** Was `next_communication` in v3.                      |
| `status_time`             | string (date-time, UTC) | **New in v4.** Last time the device reported a status.            |
| `processed_at`            | string (date-time, UTC) | Time at which the device status was processed.                    |

### v3 → v4 column changes (summary)

- **Added:** `production_date`, `battery_temperature`, `status_time`.
- **Renamed:** `last_communication` → `last_communication_time`,
  `next_communication` → `next_communication_time`.
- **Removed:** `fw_code`, `fw_version` (and `last_measurement_time` is no
  longer in the v4 file-content schema). For firmware fields, use
  [Device Properties](./device-properties.md).
- **Enum values:** `connection_type` no longer carries the `CT_` prefix —
  `WIFI`, `ETHERNET`, `UNKNOWN` instead of `CT_WIFI`, `CT_ETHERNET`,
  `CT_UNKNOWN`.

## Basic curl example

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v3/devices/status" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  -d '{
    "options": {
      "result_file_format": "CSV"
    }
  }'
```

Sample response:

```json
{
  "status": "Submitted",
  "request_uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

## OData example

Scenario (from the OpenAPI example): low-battery devices for a specific
tenant, sorted by last communication.

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v3/devices/status" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  -d '{
    "options": {
      "result_file_format": "CSV"
    },
    "odata": {
      "$filter": "tenant_uuid eq '\''c0514728-da91-431c-8eb3-8f815c5ddcbd'\'' and battery_level_percent lt 20",
      "$select": "device_uuid,tenant_uuid,serial_no,model_code,battery_level_percent,last_communication,fw_version",
      "$orderby": "last_communication desc,battery_level_percent asc"
    }
  }'
```

## GET poll example

```bash
curl -X GET "https://data-api.<region>.smartconnect.testo.com/v3/devices/status/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "x-custom-api-key: your-api-key-here"
```

## Sample responses

When completed:

```json
{
  "status": "Completed",
  "data_urls": [
    "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/devices-status/a1b2c3d4-e5f6-7890-abcd-ef1234567890.csv?..."
  ],
  "metadata_url": "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/devices-status/a1b2c3d4-e5f6-7890-abcd-ef1234567890.csv.metadata?..."
}
```
