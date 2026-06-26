# testo Smart Abruf

[![Version](https://img.shields.io/badge/version-0.14.2-blue.svg)](VERSION)
[![API Version](https://img.shields.io/badge/api-v3-orange.svg)](testo-smart-connect-api/CLAUDE.md)

A local **climate-monitoring application** for the **testo Smart Connect API**. It polls the
testo Smart Connect cloud on a schedule, stores measurements, device status and alarms in SQLite,
and visualises them on a React dashboard. The repository also ships a curated, AI-readable snapshot
of the testo Smart Connect API documentation.

## What's inside

The repo has two halves.

### 1. The application

A Node / Express / SQLite backend plus a build-free React dashboard.

- **`backend/`** — `server.js` (Express REST API), `scheduler.js` (sync cycle),
  `testo-client.js` (async submit → poll → download client), `device-bridge.js` (mapping helpers),
  `db.js` (better-sqlite3 schema + settings). Tests live in `backend/tests/`.
- **`Smart Meter Dashboard/`** — `Klima Dashboard.html` plus `app.jsx`, `tiles.jsx`, `charts.jsx`,
  `settings.jsx`, `data.js` (Babel-in-browser React, no build step).
- **`scripts/`** — one-off DB migration scripts.
- **`deploy/windows/`** — run the app as a login-independent Windows background service
  (Windows Task Scheduler).

### 2. The API documentation snapshot

- **[`testo-smart-connect-api/`](testo-smart-connect-api/)** — a curated, AI-readable offline
  snapshot of the official testo Smart Connect API documentation (endpoints, async pattern, auth,
  OData, schemas, limit values, Saveris 2 migration). Each file keeps its `source_url` and
  `snapshot_date` in YAML frontmatter so the snapshot can be safely refreshed against upstream.

## Quick start

```bash
npm install
npm start      # serves the dashboard on http://localhost:3000
npm test       # backend tests (node --test)
```

Configure credentials by copying `.env.example` to `.env` and filling in your testo Smart Connect
API key.

## Key API concepts at a glance

1. **Base URL**: `https://data-api.<region>.smartconnect.testo.com`, where `<region>` is `eu`, `am`, or `ap`.
2. **Authentication**: the custom header `x-custom-api-key`.
3. **Async pattern**: data endpoints follow POST-submit → GET-poll → download once the state is `Completed`.

## Deployment

The app is designed to run as a login-independent background service on a corporate Windows 11
machine (Windows Task Scheduler, account `NT AUTHORITY\NetworkService`). See
[`deploy/windows/README.md`](deploy/windows/README.md) for the setup and acceptance checklist.

## Documentation

- [CLAUDE.md](CLAUDE.md) — repository guide and architecture overview.
- [testo-smart-connect-api/CLAUDE.md](testo-smart-connect-api/CLAUDE.md) — documentation index routing to specific API topics.
- [testo-smart-connect-api/_assets/glossary.md](testo-smart-connect-api/_assets/glossary.md) — terminology source of truth.
