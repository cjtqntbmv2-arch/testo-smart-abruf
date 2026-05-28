---
title: "Smart Connect API — Change Log"
source_url: "https://developers.testo.dev/smart-connect-api/change-log/"
snapshot_date: 2026-05-19
source_chunks:
  - "testo-sc-changelog::https://developers.testo.dev/smart-connect-api/change-log/"
---

# Smart Connect API — Change Log

Reverse-chronological list of dated releases of the testo Smart Connect
API. Entries reproduce the upstream change-log bullets verbatim. Where the
upstream notes redirect a removed column to another endpoint, the redirect
target is linked to its local endpoint reference page.

---

## 2026-05-13

- Added asynchronous v4 devices status endpoints
- POST `/v4/devices/status`
- GET `/v4/devices/status/{request_uuid}`
- Added new columns
  - `production_date`
  - `battery_temperature`
  - `status_time`
- Renamed columns
  - `last_communication` to `last_communication_time`
  - `next_communication` to `next_communication_time`
- Removed columns
  - `fw_code` --> can be retrieved via [`/v3/devices/properties`](05-endpoints/device-properties.md) endpoint
  - `fw_version` --> can be retrieved via [`/v3/devices/properties`](05-endpoints/device-properties.md) endpoint

---

## 2026-04-16

Initial release of the Smart Connect API.

- Added asynchronous v3 device properties endpoints with OData query params for `$filter`, `$select` and `$orderby`
- POST `/v3/devices/properties`
- GET `/v3/devices/properties/{request_uuid}`
- Added asynchronous v3 devices status endpoints with OData query params for `$filter`, `$select` and `$orderby`
- POST `/v3/devices/status`
- GET `/v3/devices/status/{request_uuid}`
- Added asynchronous v2 measurements endpoints with OData query params for `$filter`, `$select` and `$orderby`
- POST `/v2/measurements`
- GET `/v2/measurements/{request_uuid}`
- Added asynchronous v3 alarms endpoints with OData query params for `$filter`, `$select` and `$orderby`
- POST `/v3/alarms`
- GET `/v3/alarms/{request_uuid}`
- Added asynchronous v1 locations endpoints with OData query params for `$filter`, `$select` and `$orderby`
- POST `/v1/locations`
- GET `/v1/locations/{request_uuid}`
- Added asynchronous v1 measuring objects endpoints with OData query params for `$filter`, `$select` and `$orderby`
- POST `/v1/measuring-objects`
- GET `/v1/measuring-objects/{request_uuid}`
