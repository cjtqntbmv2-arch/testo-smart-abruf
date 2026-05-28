---
title: "Migration Guide: Saveris 2 API → Smart Connect API"
source_url: "https://developers.testo.dev/smart-connect-api/migration-guide/"
snapshot_date: 2026-05-19
source_chunks:
  - "testo-sc-migration::https://developers.testo.dev/smart-connect-api/migration-guide/"
---

# Migration Guide: Saveris 2 API → Smart Connect API

This page is for integrators moving from the legacy **Saveris 2 API** to the
new **testo Smart Connect API**. It covers what changed, how the new
authentication and request flow look, how legacy terms map to the new ones,
and how to translate each old endpoint call into one or two new endpoint
calls.

> **Note on terminology.** This is the only document in the local docs that
> uses the legacy term **Measuring Point**. Everywhere else, use
> **Measuring Object**. See `_assets/glossary.md`.

---

## What's changing

There are three main changes you need to be aware of:

1. **Simpler authentication** — instead of a token that you had to include
   with every request, you now use an **API key** that you generate
   directly in Smart Connect. See [Authentication](02-authentication.md).
2. **New way of retrieving data** — the old API returned data immediately
   in one step. The new API uses a **3-step process**: you submit a
   request, wait briefly for it to be processed, and then download the
   result as a file (e.g., a CSV that you can open in Excel). See the
   [Async pattern](03-async-pattern.md).
3. **New terminology** — what was previously called a "Measuring Point" is
   now called a **Measuring Object**. The data you get back is richer and
   more detailed, but the names and structure are different.

---

## API comparison

|                       | Saveris 2 API (Old)                                                | Smart Connect API (New)                                                                  |
| --------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Base URL**          | `https://www.saveris.net/SaverisConnector/ws/api/saveris/v1`       | `https://data-api.<region>.smartconnect.testo.com`                                       |
| **Authentication**    | Token in `Authorization` header                                    | API key in `x-custom-api-key` header                                                     |
| **How you get data**  | One step: send request → receive data                              | Three steps: submit request → check status → download file                               |
| **Result format**     | JSON (data embedded directly in the response)                      | File download — usually `CSV`, but also `JSON` and other formats                         |
| **Filtering**         | URL parameters (e.g., `?param=value`)                              | OData filter expressions in the request body — see [OData filtering](04-odata-filtering.md) |
| **Endpoints**         | 3                                                                  | 6 endpoint pairs (12 total) — see [Endpoint reference](05-endpoints/README.md)            |

---

## Authentication migration

With the old API, you included an authentication token in every request:

```http
Authorization: Bearer <your_token>
```

With the new API, you use an **API key** instead — a string that you
generate once in Smart Connect and include in every request:

```http
x-custom-api-key: <your_api_key>
```

> **API keys expire after at most one year.** Generate a new key **before**
> your current one expires. Once expired, your integration will stop
> working until you replace the key.

For the full setup walkthrough (generating, scoping, rotating the key) see
[Authentication](02-authentication.md).

---

## Data retrieval migration

This is the biggest behavioral change. Where the old API answered every
call inline, the new API splits a request into three steps.

### Old (Saveris 2) — one call

```http
GET /saveris/v1/measuringPoint/value
Authorization: Bearer <your_token>
```

The response body carries the data directly as JSON.

### New (Smart Connect) — three steps

**Step 1 — Tell the API what data you need.** You send a request
describing what you want (e.g., "give me all measurements from the last
hour in CSV format"):

```http
POST /v2/measurements
x-custom-api-key: <your_api_key>
Content-Type: application/json

{
  "date_time_from": "2026-04-28T13:00:00Z",
  "date_time_until": "2026-04-28T14:00:00Z",
  "options": {"result_file_format": "CSV"}
}
```

The server confirms your request and returns a reference number
(`request_uuid`):

```json
{"status": "Submitted", "request_uuid": "abc-123"}
```

**Step 2 — Wait and check if the result is ready.** Using the reference
number, poll the GET endpoint:

```http
GET /v2/measurements/abc-123
x-custom-api-key: <your_api_key>
```

While the server is still preparing your data, it responds with
`In Progress`. Once ready, it responds with `Completed` and provides a
download link.

**Step 3 — Download the result.** Open the download link to get your
file. The link works without an API key and stays valid for about 1 hour.

> **How often should you check?** Don't check too frequently. A good
> approach: wait **5 seconds** after submitting, then **10 seconds**, then
> **20 seconds**, and so on. This is sufficient for most requests.

For the full state machine and recommended polling strategy, see the
[Async pattern](03-async-pattern.md).

---

## Terminology migration

| Legacy (Saveris 2)            | New (Smart Connect)                                                              |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Measuring Point               | **Measuring Object** (configuration) + **Devices Properties** (hardware details) |
| `measuringPointId`            | `serial_no` (in measurements and alarms) / `mo_uuid` (in Measuring Objects)      |
| `channelName` (measurements)  | `physical_property_name` + `physical_extension`                                  |
| `channelName` (alarms)        | `physical_value` + `physical_value_extension`                                    |
| `value`                       | `measurement`                                                                    |
| `unit`                        | `physical_unit`                                                                  |
| `limitViolationValue`         | `alarm_value`                                                                    |
| `limitValue`                  | Now part of the measuring object's alarm configuration (Measuring Objects)       |
| `limitUnit` / `isoUnit`       | `physical_unit`                                                                  |
| `timestamp` (measurements)    | `timestamp` + `timestamp_local` (UTC and local time)                             |
| `timestamp` (alarms)          | `alarm_time` + `alarm_time_local` (UTC and local time)                           |
| `group`                       | `location_type` / `location_subtype` (Locations)                                 |
| `area`                        | `customer_site` (Measuring Objects / Devices Properties)                         |
| `name`                        | `device_display_name` / `sensor_display_name` (Devices Properties)               |
| `description`                 | — (no direct equivalent)                                                          |
| `isoValue` / `isoUnit`        | — (no longer provided separately — values come in one format)                    |
| `systemWarnings` (top-level)  | Returned together with alarms; identify via `alarm_type`                         |

> **Matching old and new data:** the best way to match old and new data
> is by **serial number**. Use the `device_serial_no` and
> `sensor_serial_no` fields from the [Device Properties](05-endpoints/device-properties.md)
> endpoint to find the same devices you had in the Saveris 2 system.

---

## Endpoint mapping

This section shows which old API call maps to which new one.

### Measuring Points → Measuring Objects

|                       | Endpoint                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Old**               | `GET /saveris/v1/measuringPoint` — listed all your measuring points                                                  |
| **New (primary)**     | `POST /v1/measuring-objects` — returns your measuring objects with alarm settings, channel assignments, and measuring instructions. See [Measuring Objects](05-endpoints/measuring-objects.md). |
| **New (additional)**  | `POST /v3/devices/properties` — returns detailed information about your physical devices, sensors, and channels. See [Device Properties](05-endpoints/device-properties.md). |

**What changed:** your "Measuring Points" are now called **Measuring
Objects**. A measuring object contains everything that defines a
monitoring point: which alarm thresholds apply, which channels are
assigned, and what the measuring instructions are.

If you need hardware details about your devices (serial numbers, firmware
versions, battery types, etc.), these are now available through a separate
endpoint called **Device Properties**. This gives you more information
than before, organized in a hierarchy: **Device → Sensor → Channel**.

### Measurement Values

|         | Endpoint                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| **Old** | `GET /saveris/v1/measuringPoint/value` — returned the **latest value** for each measuring point                      |
| **New** | `POST /v2/measurements` — returns measurement data for a **time range** you specify. See [Measurements](05-endpoints/measurements.md). |

**What changed:** the old API had a simple "give me the current value"
call. The new API always expects you to specify a time range — for
example, "give me all measurements from the last hour." You receive a
file with all measurements in that period, not just the latest one.

> **Getting just the latest value:** if you only need the most recent
> measurement (like the old API provided), the simplest approach is to
> **leave out the start time**. The API will then automatically look at
> the **last hour**. You can also ask it to sort by time (newest first):
>
> ```json
> {
>   "options": {"result_file_format": "CSV"},
>   "odata": {
>     "$orderby": "timestamp desc"
>   }
> }
> ```
>
> The result file may contain **multiple values** (all measurements from
> the past hour). Your integration should pick the first row (= the most
> recent value).

### Alarms

|         | Endpoint                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| **Old** | `GET /saveris/v1/measuringPoint/alarm` — returned only **currently active** alarms and system warnings              |
| **New** | `POST /v3/alarms` — returns **all alarms** (both active and resolved) for a time range. See [Alarms](05-endpoints/alarms.md). |

**What changed:** the old API only showed alarms that were still active.
The new API gives you the complete alarm history for a time range —
including alarms that have already been resolved. This is more powerful,
but it means you need to filter if you only want active alarms.

> **Only want active alarms?** To get the same result as the old API (only
> active alarms), add this filter to your request:
>
> ```json
> "odata": {
>   "$filter": "alarm_status eq 'Alarm'"
> }
> ```
>
> Without this filter, you will also receive resolved alarms (marked as
> `Ok`).

**System warnings:** the old API returned system warnings in a separate
list (`systemWarnings`). In the new API, system warnings are included
together with alarms — you can identify them by their `alarm_type`:

| Old                              | New equivalent                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `systemWarnings` → `message`     | Alarms where `alarm_type` is `"device system alarm"` or `"sensor system alarm"` → `alarm_reason`                                 |
| `systemWarnings` → `measuringPointId` | `serial_no`                                                                                                                |
| `systemWarnings` → `timestamp`   | `alarm_time` + `alarm_time_local`                                                                                                 |

### Additional endpoints (new — no Saveris 2 equivalent)

The Smart Connect API also offers new endpoints that were **not
available** in the old Saveris 2 API:

| Endpoint                                                                       | What it gives you                                                                                                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`POST /v3/devices/properties`](05-endpoints/device-properties.md)             | Detailed information about your devices, sensors, and channels — serial numbers, firmware versions, calibration status, battery types, and more. |
| [`POST /v3/devices/status`](05-endpoints/device-status.md)                     | Current device health — battery level, signal strength, connection type (Wi-Fi or Ethernet), when it last communicated.            |
| `POST /v1/locations`                                                           | Your location hierarchy — customers, measurement sites, and their categories.                                                       |

---

## Filtering migration

The old API filtered with URL query parameters. The new API uses OData
filter expressions inside the JSON request body. See
[OData filtering](04-odata-filtering.md) for the full operator and
function reference.

**Before (Saveris 2):**

```http
GET /saveris/v1/measuringPoint/alarm?param=value
Authorization: Bearer <your_token>
```

**After (Smart Connect) — equivalent filter in the request body:**

```json
{
  "date_time_from": "2026-04-28T00:00:00Z",
  "date_time_until": "2026-04-28T23:59:59Z",
  "options": {"result_file_format": "CSV"},
  "odata": {
    "$filter": "alarm_status eq 'Alarm'"
  }
}
```

---

## Migration checklist

- [ ] **Generate an API key in Smart Connect** and store it securely (UI
      walkthrough: see [Authentication](02-authentication.md)). Remember
      that keys expire after at most one year.
- [ ] **Update the base URL** from
      `https://www.saveris.net/SaverisConnector/ws/api/saveris/v1` to
      `https://data-api.<region>.smartconnect.testo.com`, picking the
      correct `<region>` (`eu`, `am`, or `ap`).
- [ ] **Replace the `Authorization: Bearer …` header** with
      `x-custom-api-key: <your_api_key>` on every request.
- [ ] **Implement the asynchronous 3-step flow** (POST submit → GET poll
      → download file) for each endpoint pair you use. Use a backoff
      schedule (5 s → 10 s → 20 s …). See [Async pattern](03-async-pattern.md).
- [ ] **Rename "Measuring Point" to "Measuring Object"** in your code,
      data model, and documentation; map IDs via `serial_no` /
      `device_serial_no` / `sensor_serial_no` where possible.
- [ ] **Switch filtering** from URL query parameters to OData `$filter`
      / `$select` / `$orderby` expressions in the request body. See
      [OData filtering](04-odata-filtering.md).
- [ ] **Re-map result handling** for measurements: requests are
      time-range-based and may return many rows; if you want the "latest
      value", sort `timestamp desc` and pick the first row.
- [ ] **Re-map alarm handling**: the new endpoint returns both active and
      resolved alarms; add `"$filter": "alarm_status eq 'Alarm'"` to
      reproduce the old "active only" behavior. System warnings are now
      surfaced in the same response — identify them via `alarm_type`.
- [ ] **Adopt the new file-download model**: download links are valid for
      about 1 hour and require no API key.
