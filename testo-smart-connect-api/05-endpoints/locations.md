---
source_url: https://developers.testo.dev/smart-connect-api/examples/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-examples
  - _assets/openapi.json
---

# Locations

Retrieve information about the physical locations in your tenant —
typically used to map devices and measuring objects to their site,
building, or area context. This endpoint pair supports OData filtering
but does not accept a date range.

## Endpoint paths

| Operation | Path                           |
| --------- | ------------------------------ |
| POST      | `/v1/locations`                |
| GET       | `/v1/locations/{request_uuid}` |

## Date range support

No. Locations returns the current snapshot.

## OData support

Yes. See [OData Filtering](../04-odata-filtering.md).

## Request body schema

Resolved from `components.schemas.GeneralAsyncRequestV3`.

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

| Field          | Type          | Description                                          |
| -------------- | ------------- | ---------------------------------------------------- |
| `status`       | string        | Initial status of the request — `Submitted`.         |
| `request_uuid` | string (uuid) | UUID used as the path parameter on the GET endpoint. |

## Response schema (GET poll)

`200 OK` returns `AsyncLocationsSuccessResponse`, composing `StatusRequest`
with an `x-file-content` schema describing the result columns.

| Field            | Type           | Description                                                                            |
| ---------------- | -------------- | -------------------------------------------------------------------------------------- |
| `status`         | string         | One of `Completed`, `In Progress`, `Error`. (`Submitted` and `Failed` per [Concepts](../03-async-pattern.md).) |
| `data_urls`      | array<string>  | Pre-signed S3 URLs to result files. Present when `status` is `Completed`.              |
| `metadata_url`   | string         | Pre-signed S3 URL to the result metadata schema. Present when `status` is `Completed`. |
| `x-file-content` | object         | Schema describing the columns in the downloaded files.                                 |

## Basic curl example

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v1/locations" \
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
  "request_uuid": "c8d7e6f5-a4b3-2c1d-0e9f-8a7b6c5d4e3f"
}
```

## OData example

The source examples page does not include a dedicated OData-filtered curl
sample for Locations beyond the basic request shown above. The same OData
query options apply as on the other endpoints — refer to
[OData Filtering](../04-odata-filtering.md) for `$filter`, `$select` and
`$orderby` syntax, and use the column names listed in the GET response's
`x-file-content` schema for valid field references. (`TODO: source
unavailable` — endpoint-specific OData example.)

## GET poll example

```bash
curl -X GET "https://data-api.<region>.smartconnect.testo.com/v1/locations/c8d7e6f5-a4b3-2c1d-0e9f-8a7b6c5d4e3f" \
  -H "x-custom-api-key: your-api-key-here"
```

## Sample responses

When completed:

```json
{
  "status": "Completed",
  "data_urls": [
    "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/locations/c8d7e6f5-a4b3-2c1d-0e9f-8a7b6c5d4e3f.csv?..."
  ],
  "metadata_url": "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/locations/c8d7e6f5-a4b3-2c1d-0e9f-8a7b6c5d4e3f.csv.metadata?..."
}
```
