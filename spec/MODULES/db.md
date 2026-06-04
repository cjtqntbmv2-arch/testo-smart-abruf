# Module: `backend/db.js`

Singleton SQLite connection + schema + settings accessors. Uses `better-sqlite3` (synchronous).

## Public interface

```js
module.exports = { initDb, getDb, getSetting, saveSetting, closeDb };
```

| Function | Signature | Behavior |
|---|---|---|
| `initDb()` | `() => void` | Idempotent. If already open, returns. Opens DB at `process.env.DB_PATH` or `<repo>/klima.db`. Sets `PRAGMA foreign_keys = ON`. Creates `settings`, `stations`, `measurements`, `events` tables + index `idx_meas_timestamp` (all `IF NOT EXISTS`). Seeds default settings on first run (see below). |
| `getDb()` | `() => Database` | Returns the connection; calls `initDb()` first if not open. |
| `getSetting(key)` | `(string) => string\|null` | `SELECT value FROM settings WHERE key=?`; returns the value or `null`. |
| `saveSetting(key, value)` | `(string, any) => void` | `INSERT OR REPLACE INTO settings (key,value) VALUES (?, String(value))`. Note `value` is coerced to string. |
| `closeDb()` | `() => void` | Closes and nulls the connection (used by tests). |

## First-run seed

Only when DB is **not** `:memory:` **and** `settings` is empty: inserts `api_key`, `api_region`, `poll_interval_sec`, `retention_days` from env (`TESTO_API_KEY`/`TESTO_API_REGION`/`POLL_INTERVAL_SEC`/`RETENTION_DAYS`) or hardcoded defaults `''`/`'eu'`/`'900'`/`'365'`. **No stations are seeded** (comment: stations are created by the user via the assignment UI).

## Schema

Verbatim DDL in DATA_MODEL.md. Key points the rebuild must keep:
- `foreign_keys = ON` (without it the cascades silently no-op).
- `measurements` and `events` both `FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE`.
- `measurements.uuid` / `events.uuid` PRIMARY KEY → enables `INSERT OR IGNORE` / `INSERT OR REPLACE` dedupe.

## Side effects / dependencies

- File I/O (DB file creation).
- `require('dotenv').config()` at load.
- Module-level singleton `db` variable.

## Open Questions

None.
