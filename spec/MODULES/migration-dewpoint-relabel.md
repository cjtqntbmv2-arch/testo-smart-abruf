# Module: `scripts/migrate-dewpoint-relabel.js`

One-off, idempotent data migration. Standalone CLI (not imported by the app). Fixes historical rows that, before the `mapPhysicalProperty` extension fix, stored a dewpoint channel as `physical_property = 'temperature'` (because testo dewpoint reports `physical_property_name = "Temperature"`).

## Usage

```bash
node scripts/migrate-dewpoint-relabel.js [--apply] [--db <path>]
```
- Default: **dry run** (no writes), prints what it would do.
- `--apply`: performs the `UPDATE`s.
- `--db <path>`: target DB (default `<repo>/klima.db`).

## Algorithm (self-validating)

`TOLERANCE_C = 0.2`. Uses the same `dewPoint(T, RH)` Magnus formula as `data.js` (reproduced in DATA_MODEL.md).

For each station:
1. Load all `(timestamp, channel_no, physical_property, value)` rows. Group by timestamp into `{ temps: Map<channel_no, value>, humidity }`.
2. Collect distinct temperature channels. If `< 2`, skip (nothing to disambiguate).
3. For each candidate temperature channel, score `mean |candidateValue − dewPoint(base, humidity)|`, where `base` = the **warmest** other temperature channel at that timestamp (the air-temperature proxy).
4. A channel is classified DEWPOINT iff its mean |Δ| `< TOLERANCE_C`. A legitimate second air-temperature channel won't match and is kept.
5. With `--apply`: `UPDATE measurements SET physical_property='dewpoint' WHERE station_id=? AND channel_no=? AND physical_property='temperature'`. Without: counts affected rows.

Prints per-channel decisions and a total. Idempotent: rows already labeled `dewpoint` aren't re-touched (the `UPDATE` filters on `physical_property='temperature'`).

## Dependencies / side effects

- `better-sqlite3` directly (own connection), `path`. Writes to the DB only with `--apply`. No network.

## Open Questions

None. (This is a historical fix; a fresh rebuild with the corrected `mapPhysicalProperty` never produces the mislabeled rows, so the script is only needed against pre-fix databases.)
