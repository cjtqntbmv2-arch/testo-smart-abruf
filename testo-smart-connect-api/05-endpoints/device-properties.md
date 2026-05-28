---
source_url: https://developers.testo.dev/smart-connect-api/examples/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-examples
  - _assets/openapi.json
---

# Device Properties

Retrieve descriptive properties for the devices in your tenant — including
device identifiers, model code, firmware version, sensor assignments, and
the active/inactive flag. This is the canonical place to look up
firmware-related fields (`fw_code`, `fw_version`) for v4 Device Status
consumers (see [Device Status](./device-status.md)).

## Endpoint paths

| Operation | Path                                    |
| --------- | --------------------------------------- |
| POST      | `/v3/devices/properties`                |
| GET       | `/v3/devices/properties/{request_uuid}` |

## Date range support

No. The Device Properties endpoint pair does not accept `date_time_from` or
`date_time_until` — it always returns the current property snapshot.

## OData support

Yes. See [OData Filtering](../04-odata-filtering.md) for the full operator
and function reference.

## Request body schema

Resolved from `components.schemas.GeneralAsyncRequestV3` in
`_assets/openapi.json`.

| Field                        | Type   | Required | Description                                                                                                              |
| ---------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `options`                    | object | No       | Additional parameters such as the file format of the result. Resolves to `GeneralAsyncOptionsV3`.                        |
| `options.result_file_format` | string | No       | Result file format. Enum: `CSV`, `ORC`, `PARQUET`, `AVRO`, `JSON`, `TEXTFILE`. Defaults to `CSV` if omitted.             |
| `odata`                      | object | No       | OData system query options applied to the result set. Resolves to `ODataQueryOptions`.                                   |
| `odata.$filter`              | string | No       | Filter expression using OData operators (`eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not`) and string functions.   |
| `odata.$select`              | string | No       | Comma-separated list of column names to include in the response.                                                         |
| `odata.$orderby`             | string | No       | Comma-separated list of columns with optional `asc` or `desc` direction.                                                 |

## Response schema (POST submit)

`200 OK` returns `GeneralAsyncSuccessResponse`:

| Field          | Type   | Description                                                          |
| -------------- | ------ | -------------------------------------------------------------------- |
| `status`       | string | Status of the request. Initially `Submitted`.                        |
| `request_uuid` | string (uuid) | UUID of the submitted request — used as the path parameter on the GET endpoint. |

## Response schema (GET poll)

`200 OK` returns `AsyncDevicesPropertiesSuccessResponseV2`, which composes
`StatusRequest` with an `x-file-content` schema describing the columns in
the downloaded result file.

| Field           | Type           | Description                                                                              |
| --------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `status`        | string         | One of `Completed`, `In Progress`, `Error`. (`Submitted` and `Failed` also possible — see [Concepts](../03-async-pattern.md).) |
| `data_urls`     | array<string>  | Pre-signed S3 URLs to result files. Present when `status` is `Completed`.                |
| `metadata_url`  | string         | Pre-signed S3 URL to the result metadata schema. Present when `status` is `Completed`.   |
| `x-file-content` | object        | Schema describing the columns contained in the downloaded files (see OpenAPI spec for the full column list). |

## Basic curl example

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v3/devices/properties" \
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
  "request_uuid": "3fa85f64-5717-4562-b3fc-2c963f66afa6"
}
```

## OData example

Scenario: Find all active loggers, returning only identifying and firmware
fields.

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v3/devices/properties" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  -d '{
    "options": {
      "result_file_format": "CSV"
    },
    "odata": {
      "$filter": "device_category eq '\''LOGGER'\'' and device_is_active eq '\''true'\''",
      "$select": "device_uuid,device_serial_no,device_model_code,device_firmware_version,sensor_uuid,sensor_serial_no",
      "$orderby": "device_serial_no asc"
    }
  }'
```

## GET poll example

```bash
curl -X GET "https://data-api.<region>.smartconnect.testo.com/v3/devices/properties/3fa85f64-5717-4562-b3fc-2c963f66afa6" \
  -H "x-custom-api-key: your-api-key-here"
```

## Sample responses

While processing:

```json
{
  "status": "In Progress"
}
```

When completed:

```json
{
  "status": "Completed",
  "data_urls": [
    "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/devices-properties/3fa85f64-5717-4562-b3fc-2c963f66afa6.csv?..."
  ],
  "metadata_url": "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/devices-properties/3fa85f64-5717-4562-b3fc-2c963f66afa6.csv.metadata?..."
}
```

Download the result file directly with the returned URL (no
`x-custom-api-key` header required):

```bash
curl -o devices-properties.csv "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/devices-properties/3fa85f64-5717-4562-b3fc-2c963f66afa6.csv?..."
```
