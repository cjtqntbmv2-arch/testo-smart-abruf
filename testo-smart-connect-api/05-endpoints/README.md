---
source_url: https://developers.testo.dev/smart-connect-api/examples/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-examples
  - _assets/openapi.json
---

# Endpoint Reference

The testo Smart Connect API exposes 12 endpoints arranged as six endpoint
pairs. Each pair consists of one POST endpoint to submit a data-preparation
request and one GET endpoint to poll for results and retrieve download URLs.
All six pairs follow the same asynchronous pattern documented in
[Concepts](../03-async-pattern.md): submit → poll → download.

## Endpoint overview

| Endpoint           | POST Path                  | GET Path                                  | Date Range | OData |
| ------------------ | -------------------------- | ----------------------------------------- | ---------- | ----- |
| Device Properties  | `/v3/devices/properties`   | `/v3/devices/properties/{request_uuid}`   | No         | Yes   |
| Device Status      | `/v3/devices/status`       | `/v3/devices/status/{request_uuid}`       | No         | Yes   |
| Measurements       | `/v2/measurements`         | `/v2/measurements/{request_uuid}`         | Yes        | Yes   |
| Alarms             | `/v3/alarms`               | `/v3/alarms/{request_uuid}`               | Yes        | Yes   |
| Locations          | `/v1/locations`            | `/v1/locations/{request_uuid}`            | No         | Yes   |
| Measuring Objects  | `/v1/measuring-objects`    | `/v1/measuring-objects/{request_uuid}`    | No         | Yes   |

The 12 paths above were cross-checked against `_assets/openapi.json`
(`paths` keys) — all six pairs are present.

## Supported `result_file_format` values

- `CSV` (default)
- `ORC`
- `PARQUET`
- `AVRO`
- `JSON`
- `TEXTFILE`

The number of result files returned may differ depending on the file format
chosen. `PARQUET` is recommended for analysis workflows that consume the
data with Pandas, Apache Spark, or similar columnar tools.

## Download-URL caching

Download URLs returned by the GET (poll) endpoints are pre-signed S3 URLs.
They do **not** require the `x-custom-api-key` header and are valid for
approximately one hour. If you need the same data multiple times within
that window, cache the URL and download the file again instead of
re-submitting the request.

## Per-endpoint files

- [Device Properties](./device-properties.md) — `/v3/devices/properties`
- [Device Status](./device-status.md) — `/v3/devices/status` (v3 + v4 schemas)
- [Measurements](./measurements.md) — `/v2/measurements`
- [Alarms](./alarms.md) — `/v3/alarms`
- [Locations](./locations.md) — `/v1/locations`
- [Measuring Objects](./measuring-objects.md) — `/v1/measuring-objects`

## Retrievable parameters across all endpoints

For a consolidated table of every data column each endpoint can return
(with type and a short description), see
[Retrievable Parameters](./retrievable-parameters.md).

See also: [Concepts](../03-async-pattern.md) ·
[OData Filtering](../04-odata-filtering.md)
