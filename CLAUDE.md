# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A local **climate-monitoring application** for the **testo Smart Connect API**, plus a curated AI-readable snapshot of that API's docs. It has two halves:

- **The app** — a Node/Express/SQLite backend that polls the testo Smart Connect cloud on a schedule and stores measurements, device status and alarms, plus a React (Babel-in-browser, no build step) dashboard that visualises them. Key locations:
  - `backend/` — `server.js` (Express REST API), `scheduler.js` (sync cycle), `testo-client.js` (async submit→poll→download client), `device-bridge.js` (pure mapping helpers), `db.js` (better-sqlite3 schema + settings). Tests in `backend/tests/` run via `npm test` (`node --test`).
  - `Smart Meter Dashboard/` — `Klima Dashboard.html` (entry + styles), `app.jsx` (grid shell), `tiles.jsx`, `charts.jsx`, `settings.jsx`, `data.js` (frontend data layer / `window.DASH_DATA`). Note the directory name contains spaces.
  - `scripts/` — one-off DB migration scripts. `VERSION` + the README badge + the `?v=` query in the HTML script tags all carry the SemVer version and must stay in sync.
- **The API docs snapshot** — `testo-smart-connect-api/` holds the curated upstream API documentation (endpoints, async pattern, auth, OData, schemas, limit values, Saveris 2 migration).

Run the app with `npm start` (serves on port 3000). Tests: `npm test`.

## Start here

For any task about the **testo API itself** (endpoint paths, async pattern, authentication, OData, schemas, limit values, migration from Saveris 2), read [testo-smart-connect-api/CLAUDE.md](testo-smart-connect-api/CLAUDE.md) first — it is the documentation index and routes to the right file. For application work, start from the `backend/` and `Smart Meter Dashboard/` files listed above. The editing safety rails below apply to the `testo-smart-connect-api/` docs snapshot, not to the application source.

## Ignore: `spec/`

The `spec/` directory is a generated reverse-documentation snapshot (reconstruction spec of the application code), produced as a one-off deliverable. **Ignore it during normal work in this project** — do not read, edit, search, index, or treat it as a source of truth. It is not maintained in lockstep with the code and may go stale. Work from the actual source instead.

## Editing safety rails

- Every `.md` file (except the inner index and `_assets/glossary.md`) carries YAML frontmatter with `source_url`, `snapshot_date`, and `source_chunks`. This frontmatter is load-bearing for re-snapshotting — preserve it on every edit. Mechanics are described in the inner index's "How this directory was built" section.
- [testo-smart-connect-api/_assets/glossary.md](testo-smart-connect-api/_assets/glossary.md) is the single source of truth for terminology (endpoint names, async status enum, header casing). A cross-consistency reviewer greps for violations — match its spellings exactly.
- **Do not invent** endpoint paths, status enum values, header names, or schema fields. If a fact is not in an existing snapshot file with a `source_chunks` reference, re-fetch from upstream rather than writing it from memory.

