---
source_url: https://developers.testo.dev/smart-connect-api/examples/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-examples
  - _assets/openapi.json
---

# Measurements

Retrieve sensor measurement values across a time range — including the
measured value, physical property, unit, sensor identifiers, and the
measurement timestamp. This is the highest-volume endpoint pair in the
API; request small time windows and consider `PARQUET` output for
analytical workloads.

## Endpoint paths

| Operation | Path                              |
| --------- | --------------------------------- |
| POST      | `/v2/measurements`                |
| GET       | `/v2/measurements/{request_uuid}` |

## Date range support

Yes. Pass `date_time_from` and `date_time_until` in the request body. If
`date_time_from` is omitted, it defaults to one hour before the current
time. If `date_time_until` is omitted, it defaults to one hour after
`date_time_from`.

## OData support

Yes. See [OData Filtering](../04-odata-filtering.md).

## Request body schema

Resolved from `components.schemas.GeneralAsyncRequestWithDatetimeRangeV3`
(which composes `GeneralAsyncRequestV3`).

| Field                        | Type            | Required | Description                                                                                                              |
| ---------------------------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `date_time_from`             | string (date-time) | No   | Start of the data window (UTC ISO-8601). Defaults to one hour before "now".                                              |
| `date_time_until`            | string (date-time) | No   | End of the data window (UTC ISO-8601). Defaults to one hour after `date_time_from`.                                      |
| `options`                    | object          | No       | Additional parameters such as the file format of the result. Resolves to `GeneralAsyncOptionsV3`.                        |
| `options.result_file_format` | string          | No       | Result file format. Enum: `CSV`, `ORC`, `PARQUET`, `AVRO`, `JSON`, `TEXTFILE`. Defaults to `CSV`.                        |
| `odata`                      | object          | No       | OData system query options applied to the result set. Resolves to `ODataQueryOptions`.                                   |
| `odata.$filter`              | string          | No       | Filter expression using OData operators (`eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not`) and string functions.   |
| `odata.$select`              | string          | No       | Comma-separated list of column names to include in the response.                                                         |
| `odata.$orderby`             | string          | No       | Comma-separated list of columns with optional `asc` or `desc` direction.                                                 |

## Response schema (POST submit)

`200 OK` returns `GeneralAsyncSuccessResponse`:

| Field          | Type          | Description                                           |
| -------------- | ------------- | ----------------------------------------------------- |
| `status`       | string        | Initial status of the request — `Submitted`.          |
| `request_uuid` | string (uuid) | UUID used as the path parameter on the GET endpoint.  |

## Response schema (GET poll)

`200 OK` returns `AsyncMeasurementsSuccessResponseV2`, composing
`StatusRequest` with an `x-file-content` schema describing the result
columns.

| Field            | Type           | Description                                                                            |
| ---------------- | -------------- | -------------------------------------------------------------------------------------- |
| `status`         | string         | One of `Completed`, `In Progress`, `Error`. (`Submitted` and `Failed` per [Concepts](../03-async-pattern.md).) |
| `data_urls`      | array<string>  | Pre-signed S3 URLs to result files. Present when `status` is `Completed`. May contain multiple URLs depending on file format. |
| `metadata_url`   | string         | Pre-signed S3 URL to the result metadata schema. Present when `status` is `Completed`. |
| `x-file-content` | object         | Schema describing the columns in the downloaded files.                                 |

## Basic curl example

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v2/measurements" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  -d '{
    "date_time_from": "2025-04-01T00:00:00Z",
    "date_time_until": "2025-04-07T23:59:59Z",
    "options": {
      "result_file_format": "CSV"
    }
  }'
```

Sample response:

```json
{
  "status": "Submitted",
  "request_uuid": "5f330649-9cf2-4d3d-8c96-9e4b2d960678"
}
```

> Tip: `PARQUET` format is recommended for analysis workflows with tools
> like Pandas or Apache Spark — request body identical, just swap
> `"result_file_format": "PARQUET"`. The number of result files in
> `data_urls` may differ depending on the file format used.

## OData example

Scenario: Retrieve only temperature measurements from the past week,
sorted by most recent first.

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v2/measurements" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  -d '{
    "date_time_from": "2025-04-01T00:00:00Z",
    "date_time_until": "2025-04-07T23:59:59Z",
    "options": {
      "result_file_format": "CSV"
    },
    "odata": {
      "$filter": "physical_property_name eq '\''Temperature'\''",
      "$select": "uuid,sensor_uuid,serial_no,timestamp,measurement,physical_property_name,physical_unit",
      "$orderby": "timestamp desc"
    }
  }'
```

## GET poll example

```bash
curl -X GET "https://data-api.<region>.smartconnect.testo.com/v2/measurements/5f330649-9cf2-4d3d-8c96-9e4b2d960678" \
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
    "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/measurements/5f330649-9cf2-4d3d-8c96-9e4b2d960678.csv?..."
  ],
  "metadata_url": "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/measurements/5f330649-9cf2-4d3d-8c96-9e4b2d960678.csv.metadata?..."
}
```
