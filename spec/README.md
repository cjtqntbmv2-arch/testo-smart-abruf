# testo-smart-abruf — Reconstruction Specification

This directory specifies a program named **`testo-smart-abruf`** (UI brand: **"Klima · Dashboard"**) precisely enough to rebuild it from these documents plus the testo Smart Connect API docs, with no access to the original source.

## Purpose & scope

A self-hosted, single-process Node.js application that:

1. Periodically pulls device status, measurements, and alarms from a user's **testo Smart Connect** cloud account (an external, asynchronous polling REST API — see `API_DOCS`).
2. Stores the pulled data in a local **SQLite** database.
3. Serves a **single-page React dashboard** (no build step; React + Babel loaded from CDN, JSX transpiled in-browser) that visualizes the data as a configurable tile grid, evaluates user-defined thresholds client-side, and exposes a settings UI for API credentials, retention, and station↔device assignment.

There is no authentication on the local server; it is intended to run on `localhost`.

> The repository historically also contains a documentation snapshot of the testo API under `testo-smart-connect-api/` and a top-level README describing *that* snapshot. **This spec documents the application** (the `backend/` + `Smart Meter Dashboard/` code), not the doc snapshot. The doc snapshot **is** the `API_DOCS` the rebuilder will have.

## API_DOCS reference

Everything about the upstream testo Smart Connect API (base URL, auth header, async submit→poll→download pattern, OData filtering, endpoint request/response schemas, status enum) is in the API docs the rebuilder also receives. Its index is `testo-smart-connect-api/CLAUDE.md`. This spec **references** that material by topic file (e.g. `03-async-pattern.md`, `05-endpoints/`) instead of restating it. Only the application's *use* of the API is specified here.

## Tech stack & versions

| Layer | Choice | Version (pin) |
|---|---|---|
| Runtime | Node.js | (LTS; `fetch`, `fs.statfsSync` required → Node ≥ 18.15 / ≥ 19 for `statfsSync`; targeted Node ≥ 20) |
| HTTP server | `express` | `^4.19.2` |
| DB driver | `better-sqlite3` | `^12.10.0` (synchronous SQLite) |
| Env loading | `dotenv` | `^16.4.5` |
| Headless browser | `puppeteer` | `^25.1.0` (declared dependency; used only by ad-hoc dev scripts, not by the server — see BUILD_AND_ENV.md) |
| Frontend | React + ReactDOM (UMD, CDN) | `18.3.1` |
| JSX transpile | `@babel/standalone` (CDN) | `7.29.0` |
| Fonts | Geist / Geist Mono (Google Fonts) | — |
| Tests | Node built-in `node:test` | — |

No bundler, no TypeScript, no CSS framework. The frontend is plain `.jsx`/`.js` files served statically and transpiled in the browser.

## How to run / build / test

```bash
npm install
cp .env.example .env      # then edit (see BUILD_AND_ENV.md)
npm start                 # node backend/server.js → http://localhost:3000
npm test                  # node --test backend/tests/*.test.js
```

There is no build step. `npm start` launches the server, which immediately runs `initDb()`, `startScheduler()` (which fires one sync right away then every `poll_interval_sec`), and serves the dashboard at `/`.

## Top-level directory map

```
backend/                       Node server, DB, scheduler, testo API client
  server.js                    Express app + all REST routes + entry point
  db.js                        SQLite open + schema + settings get/save
  scheduler.js                 Periodic sync cycle (status, measurements, alarms, retention)
  testo-client.js              testo Smart Connect API client (async flow, retries, mock mode)
  device-bridge.js             Pure helpers: property→metric mapping, device/sensor lookups, OData filter
  tests/                       node:test suites (see ARCHITECTURE.md §Tests)
Smart Meter Dashboard/         Static frontend (served by express.static)
  Klima Dashboard.html         HTML shell: all CSS (design tokens) + CDN script tags + JSX includes
  data.js                      window.DASH_DATA: polling, reactive cache, derived metrics, local events
  charts.jsx                   SVG primitives: Sparkline, LineChart, Gauge
  tiles.jsx                    Tile registry, layout math, tile bodies, alerts/timeline
  app.jsx                      App root: grid, drag/resize, dialogs, header, station selector
  settings.jsx                 Settings page: sections, primitives, station assignment manager
  uploads/                     Static image assets (draw-*.png) — not referenced by code
scripts/
  migrate-dewpoint-relabel.js  One-off idempotent data migration (see MODULES/migration-dewpoint-relabel.md)
package.json                   Manifest (name, version, scripts, deps)
VERSION                        "0.1.4" (mirrors package.json version & README badge & ?v= cache-buster)
.env.example                   Env var template
testo-smart-connect-api/       (API_DOCS — not part of the app; referenced, not rebuilt)
docs/superpowers/              Historical design/plan docs (not required for rebuild)
klima.db, klima__.db, *.backup SQLite data files (runtime artifacts; not committed deliverables)
check-ui.js, test-*.js         Ad-hoc dev/puppeteer scripts at repo root (not part of the app runtime)
```

## Document set

| File | Contents |
|---|---|
| `ARCHITECTURE.md` | Process model, data flow, sync pipeline, concurrency, design patterns, dual event systems, tests |
| `DATA_MODEL.md` | SQLite schema (verbatim), settings keys, localStorage keys, in-memory station object shape |
| `API.md` | Every REST route the server **defines** (method, path, request/response shape, status codes) |
| `BUILD_AND_ENV.md` | Dependencies, env vars, commands, external service, known dev-only artifacts |
| `GUI.md` | Full UI spec: design tokens, component trees, layout, state→view bindings, events, navigation |
| `MODULES/*.md` | Per-module interface + behavior for non-trivial logic |

## Open Questions

- **Version inconsistency (carry into rebuild?):** `package.json`/`VERSION`/README badge say `0.1.4`, but `settings.jsx` AdvancedSection "Über" card hardcodes `"Klima Dashboard 1.0.0"`, `Build "2026-05-29 · #local"`, `API "v1.0 · Testo Smart Connect"`. These are static display strings. Reproduced verbatim in GUI.md; whether to "fix" them is a product decision, not derivable from code.
- The repo's top-level `README.md` describes the *API documentation snapshot*, not the application. The app has no dedicated user-facing README. This file is the authoritative description of the program.
