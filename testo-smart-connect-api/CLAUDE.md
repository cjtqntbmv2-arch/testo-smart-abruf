# testo Smart Connect API — Documentation Index

> **For Claude agents:** This is the entry point for using the testo Smart
> Connect API in this project. Read this file first; then follow the links
> below to the specific topic you need. Every file in this directory is a
> snapshot of the official docs at <https://developers.testo.dev/smart-connect-api/>
> as of 2026-05-19. The source URL and snapshot date are recorded in each
> file's YAML frontmatter.

## What the API is, in one paragraph

The Smart Connect API is a **RESTful, asynchronous, polling-based** API
that returns measurement data, alarms, device metadata/status, locations,
and measuring objects from a testo Smart Connect account. You authenticate
with an **API key** in the `x-custom-api-key` header. Every endpoint pair
follows the same pattern: POST submits a request and returns a
`request_uuid`; GET polls that uuid until `Completed`, then returns
download URLs for the result file (CSV / ORC / PARQUET / AVRO / JSON /
TEXTFILE).

## Base URL

```
https://data-api.<region>.smartconnect.testo.com
```

`<region>` is one of `eu`, `am`, `ap` — pick the region your Smart Connect
account lives in (the first two letters of your account's Smart Connect
hostname).

## Authentication, in 30 seconds

```http
POST /v3/devices/properties HTTP/1.1
Host: data-api.eu.smartconnect.testo.com
Content-Type: application/json
x-custom-api-key: your-api-key-here
```

Generate the key once in the Smart Connect UI (max validity: 1 year).
Full walkthrough: [02-authentication.md](02-authentication.md).

## The async pattern, in 5 lines

1. `POST /v…/<endpoint>` with a body describing what you want → returns
   `{ "status": "Submitted", "request_uuid": "..." }`.
2. `GET /v…/<endpoint>/{request_uuid}` → polls; returns `In Progress` or
   `Completed`.
3. When `Completed`, the response contains download URLs (valid for
   approximately one hour).
4. Download the result file from those URLs.
5. Dedupe records on the row-level `uuid` field (at-least-once delivery).

Full details, backoff strategy, and 429 handling:
[03-async-pattern.md](03-async-pattern.md).

## What do I need? → Which file do I read?

| You need to…                                        | Read this                                   |
|-----------------------------------------------------|---------------------------------------------|
| Understand what the API does and what regions exist | [01-overview.md](01-overview.md)            |
| Generate, rotate, or secure an API key              | [02-authentication.md](02-authentication.md)|
| Implement the submit → poll → download loop         | [03-async-pattern.md](03-async-pattern.md)  |
| Filter, project, or sort results                    | [04-odata-filtering.md](04-odata-filtering.md) |
| Look up an endpoint's request body or response schema | [05-endpoints/README.md](05-endpoints/README.md) |
| See every data column each endpoint can return        | [05-endpoints/retrievable-parameters.md](05-endpoints/retrievable-parameters.md) |
| Find alarm thresholds / limit values per measuring object | [09-limit-values.md](09-limit-values.md) |
| Follow a use-case-driven walkthrough                | [06-tutorials.md](06-tutorials.md)          |
| Port code from the legacy Saveris 2 API             | [07-migration-from-saveris2.md](07-migration-from-saveris2.md) |
| See what changed and when                           | [08-changelog.md](08-changelog.md)          |
| Check exact spelling for status values, headers, …  | [_assets/glossary.md](_assets/glossary.md)  |
| Inspect the raw OpenAPI spec                        | [_assets/openapi.json](_assets/openapi.json) |

## All endpoint pairs at a glance

| Resource           | POST (submit)                            | GET (poll)                                                | Date range | OData |
|--------------------|------------------------------------------|-----------------------------------------------------------|------------|-------|
| Device Properties  | `/v3/devices/properties`                 | `/v3/devices/properties/{request_uuid}`                   | no         | yes   |
| Device Status      | `/v3/devices/status` (v4 path TBD)       | `/v3/devices/status/{request_uuid}` (v4 path TBD)         | no         | yes   |
| Measurements       | `/v2/measurements`                       | `/v2/measurements/{request_uuid}`                         | yes        | yes   |
| Alarms             | `/v3/alarms`                             | `/v3/alarms/{request_uuid}`                               | yes        | yes   |
| Locations          | `/v1/locations`                          | `/v1/locations/{request_uuid}`                            | no         | yes   |
| Measuring Objects  | `/v1/measuring-objects`                  | `/v1/measuring-objects/{request_uuid}`                    | no         | yes   |

Per-endpoint request/response schemas, sample curl commands, and OData
examples live in [05-endpoints/](05-endpoints/).

## Important behaviors to know before you call

- **At-least-once delivery.** The same record may appear more than once
  in your download. Dedupe on the row-level `uuid` field (NOT
  `request_uuid`, which is the request identifier).
- **Download URLs are temporary** (≈ 1 hour). Cache the URL itself if you
  may re-download soon; otherwise re-submit a new request.
- **API keys expire** after at most one year. Rotate before expiry — a
  failed integration is the only signal you get.
- **Status enum mismatch.** The OpenAPI `StatusRequest.status` enum lists
  `Completed`, `In Progress`, `Error`, but the documentation describes
  `Submitted`, `In Progress`, `Completed`, `Failed`. Treat the prose
  status names as authoritative and `Error` ≡ `Failed` until clarified.
- **OData filtering happens server-side** — use it to reduce download
  size, not just for convenience. See
  [04-odata-filtering.md](04-odata-filtering.md).
- **Trust the local docs over `_assets/openapi.json` where they differ.**
  Known divergences: `measurement_alarm_configuration` is a nested
  camelCase `measurementAlarmConditionSet[...]` in the live response, not
  the flat `upper_violation` / `lower_warning` shape in the spec; the live
  row id is `measuring_object_uuid`, not `mo_uuid` as labelled in the
  spec; v4 Device Status file-content schemas exist in the spec but no
  `/v4/devices/status` path is published, and `POST /v3/devices/status` is
  marked `deprecated: true`. **/v3/alarms field-name corrections (observed
  2026-06-11):** the live API uses `physical_property_name` (not
  `physical_value`), `physical_extension` (not `physical_value_extension`),
  and `customer_site` (not `customer_site_uuid`); `alarm_value` is a string
  not a number; `alarm_type` is `"measurement alarm"` (space) not
  `measurement_alarm`; `alarm_condition_type` is `"Upper limit"` /
  `"Lower limit"` (plain text) not `HighLimit` / `LowLimit`. Enum values in
  `measurement_alarm_configuration` are also plain text (`"Lower limit"`,
  `"Warning"`, `"Temperature"`, `"°C"`) not the prefixed `MACT_*` / `ASV_*`
  / `PV_*` / `PU_*` forms. Details:
  [05-endpoints/alarms.md](05-endpoints/alarms.md),
  [05-endpoints/retrievable-parameters.md](05-endpoints/retrievable-parameters.md),
  [09-limit-values.md](09-limit-values.md) and
  [05-endpoints/device-status.md](05-endpoints/device-status.md).
- **Some result columns are JSON-encoded strings.** In
  `/v1/measuring-objects` responses, `measurement_alarm_configuration` and
  `channel_assignments` are JSON strings inside the downloaded file — parse
  them as JSON after download. `channel_assignments` can be empty, in
  which case there is no direct measuring-object → device-serial link in
  that payload. See [09-limit-values.md](09-limit-values.md).
- **v4 Device Status dropped the `CT_` prefix on `connection_type`.**
  v3 uses `CT_WIFI` / `CT_ETHERNET` / `CT_UNKNOWN`; v4 uses `WIFI` /
  `ETHERNET` / `UNKNOWN`. OData filters written for one version silently
  return nothing on the other. See
  [05-endpoints/device-status.md](05-endpoints/device-status.md).

## How this directory was built

Every `.md` file (except this one and `_assets/glossary.md`) carries
frontmatter recording its `source_url`, `snapshot_date` (2026-05-19), and
the indexed source chunks it derives from. If the upstream docs change,
re-run the worker subagents pointed at the affected source IDs and the
glossary will keep terminology consistent across files.
