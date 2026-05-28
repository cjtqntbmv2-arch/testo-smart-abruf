---
source_url: https://developers.testo.dev/smart-connect-api/tutorials/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-tutorials
---

# Tutorials

This page collects real-world, use-case-driven walkthroughs for the testo
Smart Connect API. Rather than listing endpoints one by one, each tutorial
shows *which endpoint to call when*, *in which order*, and *with which
options* to accomplish a typical monitoring task. The tutorials are
independent — pick the one that matches your scenario.

Before you start, make sure you are familiar with:

- [Authentication](02-authentication.md) — how to generate and send the
  `x-custom-api-key` header.
- [Async pattern](03-async-pattern.md) — the POST-to-submit / GET-to-poll
  model that every endpoint pair in this guide uses, including the
  `Submitted`, `In Progress`, `Completed`, and `Failed` status values and
  the `request_uuid` identifier.

The schemas for every endpoint live in the [Endpoint reference](05-endpoints/README.md);
the tutorials below cross-reference the relevant pages.

---

## Requirements

To follow any of these tutorials, you'll need:

- A valid API key — see [Authentication](02-authentication.md) on how to
  generate one.
- An API client such as Postman, or an equivalent tool, for making API
  requests.
- At least one device set up and sending data in Smart Connect.

---

## When to use asynchronous endpoints

Asynchronous endpoints are designed for retrieving larger datasets that
might take time to prepare. They work in two steps: a POST starts the
preparation and returns a `request_uuid`, then a GET polls until the data
is ready for download. They are the right choice when:

- Retrieving larger data covering a time period more than a few seconds.
- Working with sites that have many devices.
- Needing to download data in specific file formats for analysis
  (`CSV`, `PARQUET`).

See [Async pattern](03-async-pattern.md) for the complete status-polling
lifecycle.

---

## Retrieving Temperature History for Compliance Reports

When preparing compliance reports or investigating temperature excursions,
you'll need historical measurement data. For longer time periods or
multiple devices, the asynchronous approach is necessary.

1. **Initiate the data preparation** with a POST request to the
   Measurements endpoint:

   ```http
   POST https://data-api.<region>.smartconnect.testo.com/v2/measurements
   ```

   In the request body, specify the time period you're interested in:

   ```json
   {
     "date_time_from": "2025-04-01T00:00:00Z",
     "date_time_until": "2025-04-15T23:59:59Z",
     "options": {
       "result_file_format": "CSV"
     }
   }
   ```

2. **Receive the request identifier.** The response contains a unique
   identifier for your data preparation request:

   ```json
   {
     "status": "Submitted",
     "request_uuid": "5f330649-9cf2-4d3d-8c96-9e4b2d960678"
   }
   ```

3. **Poll for completion** by issuing a GET request with the
   `request_uuid` from the previous response:

   ```http
   GET https://data-api.<region>.smartconnect.testo.com/v2/measurements/<request_uuid>
   ```

   Initially, the status will show as `In Progress`:

   ```json
   { "status": "In Progress" }
   ```

   Continue checking periodically until you see:

   ```json
   {
     "status": "Completed",
     "data_urls": [
       "https://...s3.amazonaws.com/measurements/...csv?..."
     ],
     "metadata_url": "https://...s3.amazonaws.com/measurements/...csv.metadata?..."
   }
   ```

4. **Download the files** using the provided URLs. The `CSV` file will
   contain all measurements for the specified time period, which you can
   then use for your compliance reports or analysis.

See the [Measurements endpoint reference](05-endpoints/measurements.md) for
the full request and response schema. To narrow the result set to specific
devices, sensors, or channels, combine the POST body with
[OData filtering](04-odata-filtering.md).

---

## Reviewing Past Alarm Events for Root Cause Analysis

When investigating incidents or preparing for audits, you may need to
review historical alarm events. These records show when values exceeded
thresholds or when system issues occurred.

1. **Start a data preparation request** for alarm data:

   ```http
   POST https://data-api.<region>.smartconnect.testo.com/v3/alarms
   ```

   Specify the relevant time period in the body of the request. For
   example:

   ```json
   {
     "date_time_from": "2025-04-01T00:00:00Z",
     "date_time_until": "2025-04-15T23:59:59Z",
     "options": {
       "result_file_format": "CSV"
     }
   }
   ```

2. **Receive the request identifier:**

   ```json
   {
     "status": "Submitted",
     "request_uuid": "fbf29fed-e3e2-46fb-a304-ee099e849044"
   }
   ```

3. **Poll for completion** with the `request_uuid` from the previous
   response:

   ```http
   GET https://data-api.<region>.smartconnect.testo.com/v3/alarms/{request_uuid}
   ```

   Initially, the status will show as `In Progress`. Continue checking
   periodically until the status changes to `Completed`.

4. **Download the data file.** It will contain alarm records including:

   - Alarm time and reason
   - Affected device or sensor
   - Alarm severity
   - Measured values that triggered the alarm

   This information is valuable for identifying patterns in alarm events
   or demonstrating compliance with monitoring requirements during audits.

See the [Alarms endpoint reference](05-endpoints/alarms.md) for the
complete schema. To filter by severity, device, or reason, use
[OData filtering](04-odata-filtering.md).

---

## Understanding Device Properties

For a comprehensive understanding of your devices' capabilities and
settings, the Device Properties endpoint provides detailed metadata.

1. **Initiate a data preparation request** with your desired file format:

   ```http
   POST https://data-api.<region>.smartconnect.testo.com/v3/devices/properties
   ```

   ```json
   {
     "options": {
       "result_file_format": "CSV"
     }
   }
   ```

2. **Poll for completion** until the data is ready:

   ```http
   GET https://data-api.<region>.smartconnect.testo.com/v3/devices/properties/{request_uuid}
   ```

3. **Download the result.** The Device Properties data includes:

   - Detailed information about each device and its sensors.
   - Channel configurations and measurement capabilities.
   - Physical units and measurement types.
   - Calibration status and possibilities.
   - Relationships to equipment.

   This information is valuable for documentation purposes and for
   understanding the full capabilities of your monitoring system.

See the [Device Properties endpoint reference](05-endpoints/device-properties.md)
for the full schema. For runtime health and battery information, refer to
the [Device Status endpoint reference](05-endpoints/device-status.md).

---

## Understanding Locations

For a comprehensive understanding of your registered locations, the
Locations endpoint provides related information.

1. **Initiate a data preparation request** with your desired file format:

   ```http
   POST https://data-api.<region>.smartconnect.testo.com/v1/locations
   ```

   ```json
   {
     "options": {
       "result_file_format": "CSV"
     }
   }
   ```

2. **Poll for completion** until the data is ready:

   ```http
   GET https://data-api.<region>.smartconnect.testo.com/v1/locations/{request_uuid}
   ```

3. **Download the result.** The Locations data includes:

   - Location name.
   - Information about the owner (`tenant_uuid`) and the parent location
     (`parent_uuid`).
   - The type of the location and its parent (e.g., `Customer`,
     `Measurement site`), as well as a more specific subtype for the
     location itself (e.g., `Ventilation`, `Flue gas`).

See the [Locations endpoint reference](05-endpoints/locations.md) for the
full schema.

---

## Understanding Measuring Objects

For a complete view of your Measuring Objects, the Measuring Objects
endpoint exposes detailed information.

1. **Initiate a data preparation request** with your desired file format:

   ```http
   POST https://data-api.<region>.smartconnect.testo.com/v1/measuring-objects
   ```

   ```json
   {
     "options": {
       "result_file_format": "CSV"
     }
   }
   ```

2. **Poll for completion** until the data is ready:

   ```http
   GET https://data-api.<region>.smartconnect.testo.com/v1/measuring-objects/{request_uuid}
   ```

3. **Download the result.** The Measuring Objects data includes:

   - Information about the owning customer (`customer_uuid`) and the
     customer site (`customer_site`).
   - The product family ID (`product_family_id`) such as `savr`, `sav3`,
     and `data layer`.
   - The corresponding configurations including measurement alarm
     configuration, channel assignments, and measuring instructions.

   This information is essential for understanding a Measuring Object in
   detail, including its owning customer, product family ID, and related
   configurations.

See the [Measuring Objects endpoint reference](05-endpoints/measuring-objects.md)
for the full schema.

---

## Troubleshooting

### Asynchronous request taking too long

For asynchronous requests that seem to take too long:

- Verify your network connection is stable.
- Consider requesting smaller time ranges.
- Allow more time for processing large datasets.

### API request returns 401 Unauthorized

If you encounter a 401 Unauthorized error, check that:

- Your API key is valid and hasn't expired.
- The `x-custom-api-key` header is included in every request.
- The key is correctly copied without extra spaces or characters.

See [Authentication](02-authentication.md) for the full header conventions.

---

## Where to go next

- [Endpoint reference](05-endpoints/README.md) — full schema documentation
  with all available fields, request parameters, and response structures
  for every endpoint pair.
- [OData filtering](04-odata-filtering.md) — reference for `$filter`,
  `$select`, and `$orderby` syntax with practical scenarios for narrowing
  down measurement, alarm, and device queries.
- [Async pattern](03-async-pattern.md) — a deeper look at the asynchronous
  request model, status values, and file format options.
