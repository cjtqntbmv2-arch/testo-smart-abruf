---
source_url: https://developers.testo.dev/smart-connect-api/examples/
snapshot_date: 2026-05-19
source_chunks:
  - testo-sc-examples
  - _assets/openapi.json
---

# Limit Values (Grenzwerte)

Per-Measuring-Object alarm thresholds — the upper/lower warning and
violation limits that define when a channel goes into alarm. This page
explains **where** the limits live in the API, **how** to retrieve them,
and **how** to map them back to a measuring object, physical property, and
alarm.

> **Verified against the live EU API on 2026-05-20.** The structure below
> reflects the **actual payload**, which differs from the OpenAPI
> `AlarmConfiguration` schema (see [Caveats](#notes-and-caveats)). Trust
> this page over the raw spec for field names.

## Where the limits live

There is **no dedicated limit-values endpoint**. The thresholds are part of
the alarm configuration of a **Measuring Object** and are returned by:

```
POST /v1/measuring-objects
```

in the field **`measurement_alarm_configuration`** — a **JSON-encoded
string** (see [Measuring Objects](05-endpoints/measuring-objects.md)). The
legacy Saveris 2 `limitValue` maps here; see
[Migration](07-migration-from-saveris2.md).

## Actual JSON structure

Decoding `measurement_alarm_configuration` yields:

```jsonc
{
  "measurementAlarmConditionSet": [
    {
      "measurementAlarmConditions": [
        {
          "measurementAlarmConditionTypeId": "MACT_LOWER_LIMIT",
          "alarmSeverityId": "ASV_ALARM",
          "physicalProperty": { "physicalValueId": "PV_TEMPERATURE" },
          "limitValue": 18.0,
          "limitHysteresis": 0.0,
          "delay": 600000,
          "physicalUnitId": "PU_DEGREE_CELSIUS"
        }
        // … one entry per (property × direction × severity)
      ]
    }
  ],
  "alarmConfigurationBackReference": "…"
}
```

Each condition object carries:

| Field                              | Meaning                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| `measurementAlarmConditionTypeId`  | Limit direction. Observed: `MACT_LOWER_LIMIT`, `MACT_UPPER_LIMIT`.   |
| `alarmSeverityId`                  | Severity. Observed: `ASV_WARNING` (warning), `ASV_ALARM` (violation).|
| `physicalProperty.physicalValueId` | Which channel/property. Observed: `PV_TEMPERATURE`, `PV_HUMIDITY`, `PV_PRESSURE`. |
| `limitValue`                       | The threshold value itself.                                          |
| `physicalUnitId`                   | Unit. Observed: `PU_DEGREE_CELSIUS`, `PU_PERCENT_HUMIDITY`, `PU_PRESSURE_HECTOPASCAL`. |
| `limitHysteresis`                  | Hysteresis band around the limit.                                    |
| `delay`                            | Alarm delay in **milliseconds** (e.g. `600000` = 10 min).            |

So a single measuring object exposes one condition per
**property × direction × severity** — e.g. temperature lower-warning,
temperature lower-alarm, temperature upper-warning, temperature
upper-alarm, then the same for humidity and pressure.

## How to retrieve them

Request JSON output and project the columns you need. **Note:** the row
identifier is `measuring_object_uuid` (not `mo_uuid` as the OpenAPI spec
labels it):

```bash
curl -X POST "https://data-api.<region>.smartconnect.testo.com/v1/measuring-objects" \
  -H "Content-Type: application/json" \
  -H "x-custom-api-key: your-api-key-here" \
  -d '{
    "options": {
      "result_file_format": "JSON"
    },
    "odata": {
      "$select": "measuring_object_uuid,customer_site,measurement_alarm_configuration,channel_assignments"
    }
  }'
```

Then follow submit → poll → download ([Async pattern](03-async-pattern.md))
and **parse the `measurement_alarm_configuration` string as JSON** to walk
`measurementAlarmConditionSet[].measurementAlarmConditions[]`.

## How to assign them

- **Per measuring object:** each row carries `measuring_object_uuid` and
  `customer_site`.
- **Per property:** each condition is keyed by
  `physicalProperty.physicalValueId` (temperature / humidity / pressure …),
  so limits are property-specific within one object.
- **To a physical sensor/channel:** use `channel_assignments` (also a
  JSON-encoded string) to map the object to device channels. ⚠ This field
  can be **empty** (it was empty for all objects in the verified tenant);
  in that case there is no direct object→serial link in this payload.
- **Bridge to an alarm:** an alarm row exposes `serial_no`,
  `physical_value`, `alarm_value`, and `alarm_severity` (`Warning` /
  `Alarm`) ([Alarms](05-endpoints/alarms.md)). Match the triggering
  threshold by property + severity + direction against the measuring
  object's conditions.

## Notes and caveats

1. **The OpenAPI spec is misleading here.** The
   `components.schemas.AlarmConfiguration` schema in
   [`_assets/openapi.json`](_assets/openapi.json) describes a *flat* shape
   (`upper_violation`, `upper_warning`, `lower_warning`, `lower_violation`,
   `display_unit`, `limit_values_uuid`, …). The **live API does not return
   that** — it returns the nested, camelCase
   `measurementAlarmConditionSet` structure documented above. Always
   validate against a real response.
2. The spec also labels the row id `mo_uuid`, but the live field name is
   `measuring_object_uuid`.
3. A richer `AsyncEquipmentsFileContentObject` schema (flat limit fields)
   exists in the spec, but **no `/equipments` path exists** — limits are
   available only through `measuring-objects`.
4. The `MACT_*` / `ASV_*` / `PV_*` / `PU_*` enum lists above are what was
   observed in one tenant; other deployments may expose additional values
   (e.g. more physical properties or units).
