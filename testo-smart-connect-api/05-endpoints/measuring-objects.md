---
source_url: https://developers.testo.dev/smart-connect-api/examples/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-examples
  - _assets/openapi.json
---

# Measuring Objects

Retrieve detailed information about measuring objects — including product
family, customer site, and configuration data such as alarm
configurations, channel assignments, and measuring instructions. Several
of those configuration fields are JSON-encoded strings, so requesting the
result as JSON is often more convenient than CSV.

(Note on terminology: **Measuring Object** is the current term;
**Measuring Point** is the legacy Saveris 2 term — see the glossary.)

## Endpoint paths

| Operation | Path                                   |
| --------- | -------------------------------------- |
| POST      | `/v1/measuring-objects`                |
| GET       | `/v1/measuring-objects/{request_uuid}` |

## Date range support

No. Measuring Objects returns the current snapshot.

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

`200 OK` returns `AsyncMeasuringObjectsSuccessResponse`, composing
`StatusRequest` with an `x-file-content` schema describing the result
columns.

| Field            | Type           | Description                                                                            |
| ---------------- | -------------- | -------------------------------------------------------------------------------------- |
| `status`         | string         | One of `Completed`, `In Progress`, `Error`. (`Submitted` and `Failed` per [Concepts](../03-async-pattern.md).) |
| `data_urls`      | array<string>  | Pre-signed S3 URLs to result files. Present when `status` is `Completed`.              |
| `metadata_url`   | string         | Pre-signed S3 URL to the result metadata schema. Present when `status` is `Completed`. |
| `x-file-content` | object         | Schema describing the columns in the downloaded files (e.g. `mo_uuid`, `customer_uuid`, `product_family_id`, `customer_site`, `measurement_alarm_configuration`, `channel_assignments`, `measuring_instructions`). |

## Basic curl example

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v1/measuring-objects" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  -d '{
    "options": {
      "result_file_format": "JSON"
    }
  }'
```

Sample response:

```json
{
  "status": "Submitted",
  "request_uuid": "d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a"
}
```

> Tip: JSON output is often more convenient for this endpoint because
> the `measurement_alarm_configuration`, `channel_assignments`, and
> `measuring_instructions` fields contain JSON-encoded strings.

> The alarm thresholds (limit values) live inside
> `measurement_alarm_configuration`. For the decoded field list and how to
> map limits to channels and alarms, see [Limit Values](../09-limit-values.md).

## OData example

Scenario: Retrieve all measuring objects for the "savr" product family.

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v1/measuring-objects" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  -d '{
    "options": {
      "result_file_format": "JSON"
    },
    "odata": {
      "$filter": "product_family_id eq '\''savr'\''",
      "$select": "mo_uuid,customer_uuid,product_family_id,customer_site,measurement_alarm_configuration"
    }
  }'
```

## GET poll example

```bash
curl -X GET "https://data-api.<region>.smartconnect.testo.com/v1/measuring-objects/d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a" \
  -H "x-custom-api-key: your-api-key-here"
```

## Sample responses

When completed:

```json
{
  "status": "Completed",
  "data_urls": [
    "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/measuring-objects/d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a.json?..."
  ],
  "metadata_url": "https://tds-eu-i-data-storage-query-results.s3.amazonaws.com/measuring-objects/d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a.json.metadata?..."
}
```
