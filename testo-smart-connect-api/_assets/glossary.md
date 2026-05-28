# Canonical Terminology — testo Smart Connect API Docs

**Purpose:** This file is the single source of truth for naming in the local
Smart Connect API documentation. All worker subagents MUST follow these
spellings exactly. The cross-consistency reviewer greps for violations.

## Endpoint pair names (Title Case, hyphenated where applicable)

Use these names in prose, headings, tables, and cross-references.

| Canonical name      | Filename slug          | Path prefix             |
|---------------------|------------------------|-------------------------|
| Device Properties   | `device-properties`    | `/v3/devices/properties` |
| Device Status       | `device-status`        | `/v3/devices/status` (v3 + v4) |
| Measurements        | `measurements`         | `/v2/measurements`       |
| Alarms              | `alarms`               | `/v3/alarms`             |
| Locations           | `locations`            | `/v1/locations`          |
| Measuring Objects   | `measuring-objects`    | `/v1/measuring-objects`  |

Not: "Device Property" (singular), "Device-Properties" (different casing),
"DeviceProperties", "device properties" (lowercase in prose).

## Async request status values (exact string, code font)

`Submitted`, `In Progress`, `Completed`, `Failed`

Always render in inline code (`` `Submitted` ``), never `submitted` or
`SUBMITTED` or `in_progress`.

## Authentication

- Header name: `x-custom-api-key` — exactly this casing, always in inline
  code, always with hyphens (never `X-Custom-Api-Key`, never
  `x_custom_api_key`).
- Placeholder for the user's key in code blocks: `your-api-key-here`.
- The string "API Key" (two words, capitalized) is used in prose; the string
  "API key" (lowercase k) appears in some original-doc passages — prefer
  "API key" in prose and "API Key Management" only when referring to the
  Smart Connect UI section by that exact name.

## Region codes

`eu`, `am`, `ap` — always lowercase, always in inline code. Placeholder in
URLs: `<region>` (angle brackets, lowercase).

## Base URL pattern

`https://data-api.<region>.smartconnect.testo.com` — no trailing slash in
prose; append paths starting with `/`.

## OData option names (exact, with leading `$`)

`$filter`, `$select`, `$orderby` — always in inline code with leading `$`,
never `filter`/`select`/`orderby` alone.

## OData operators (lowercase, inline code)

`eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not`

## OData string functions

`contains`, `startswith`, `endswith` — never `startsWith`/`endsWith` (camel
case is wrong here).

## File formats (uppercase, inline code)

`CSV`, `ORC`, `PARQUET`, `AVRO`, `JSON`, `TEXTFILE` — match the API's
`result_file_format` enum exactly.

## Concept terms

- **Asynchronous endpoint pair** = one POST (submit) + one GET (poll). Use
  "endpoint pair" when referring to the combination, "POST endpoint" /
  "GET endpoint" when referring to one half.
- **request_uuid** — always snake_case, inline code; this is the API's
  identifier returned by POST and used in the GET path.
- **Measuring Object** (Title Case) is the *new* term; **Measuring Point**
  is the legacy Saveris 2 term — only appears in the migration guide.
- **Deduplication key:** the `uuid` field on individual records (not to be
  confused with `request_uuid`).

## API versioning

Endpoint versions are part of the path: `v1`, `v2`, `v3`, `v4`. Always
lowercase, with a leading `v`. When discussing the v4 device-status
endpoint added 2026-05-13, refer to it as "v4 Device Status".

## Do NOT invent

If a field, value, enum, or behavior is not present in the indexed source
chunks or `_assets/openapi.json`, do not write it. Mark gaps as:

> `TODO: source unavailable`
