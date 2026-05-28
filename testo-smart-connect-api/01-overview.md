---
source_url: https://developers.testo.dev/smart-connect-api/
snapshot_date: 2026-05-19
source_chunks:
  - testo-smart-connect-api-index::https://developers.testo.dev/smart-connect-api/
---

# Smart Connect API Overview

## What is the Smart Connect API?

The Smart Connect API provides RESTful access to data stored in testo
Smart Connect. It is intended for developers who want to programmatically
retrieve and integrate measurement data, alarm information, device
metadata and status, locations, and measuring objects from their
Smart Connect account into their own systems or workflows.

## Main capabilities

The API exposes five main capability areas:

- **Measurements** — retrieve measurement data from loggers and sensors.
- **Alarms** — fetch alarm data and status information.
- **Device Properties / Device Status** — access metadata about devices
  and their current status.
- **Locations** — retrieve locations corresponding to customers or
  measurement sites.
- **Measuring Objects** — fetch measuring objects. If you are migrating
  from Saveris 2, see
  [07-migration-from-saveris2.md](07-migration-from-saveris2.md) for the
  terminology change.

## Delivery guarantee

The Smart Connect API follows an **at-least-once** delivery policy for
measurements, alarms, and device status payloads.

Duplicated records can occur — for example, when loggers retransmit data
to guarantee delivery to the cloud. The same logical record may therefore
appear more than once in a response.

If your workflow requires strictly unique entries, deduplicate the
results using the `uuid` field present on each record. This `uuid` is the
per-record deduplication key and is distinct from `request_uuid`, which
identifies an asynchronous request.

## Base URL

The base URL of the API follows this pattern:

```
https://data-api.<region>.smartconnect.testo.com
```

Replace `<region>` with the lowercase code that matches your Smart
Connect tenant:

| Region code | Region              |
|-------------|---------------------|
| `eu`        | Europe              |
| `am`        | Americas            |
| `ap`        | Asia-Pacific        |

To find your own region, sign in to the Smart Connect web page and check
the URL in your browser, which has the form
`<region>.smartconnect.testo.com`. The first two letters after `www.`
are your region — if there is no `www.`, use the first two letters right
after `https://`.

Append endpoint paths (always starting with `/`) to this base URL; no
trailing slash is used in prose.

## What next

- See [Authentication](02-authentication.md) to generate an API key and
  authorize requests.
- See the [API Reference](05-endpoints/README.md) for the full list of
  endpoints and their request/response shapes.
