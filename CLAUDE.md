# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A local **climate-monitoring application** for the **testo Smart Connect API**, plus a curated AI-readable snapshot of that API's docs. It has two halves:

- **The app** — a Node/Express/SQLite backend that polls the testo Smart Connect cloud on a schedule and stores measurements, device status and alarms, plus a React (Babel-in-browser, no build step) dashboard that visualises them. Key locations:
  - `backend/` (12 modules) — `server.js` (Express REST API), `scheduler.js` (sync cycle), `testo-client.js` (async submit→poll→download client), `device-bridge.js` (pure mapping helpers), `db.js` (better-sqlite3 schema + settings), `listen-error.js` (turns a port conflict into a clear log line + exit≠0 so the Windows task can restart), `update-check.js` (looks in a drop folder for a newer release ZIP, reported via `GET /api/system/status`). CSV export + backup subsystem: `export-service.js` (DB-bound orchestration, shared by manual export and backup), `csv-export.js` (pure table builders), `csv-format.js` (pure CSV dialect/formatting), `backup-runner.js` (monthly per-station ZIPs + retention prune), `zip-writer.js` (minimal PKZIP writer on Node's zlib). Tests in `backend/tests/` run via `npm test` (`node --test`).
  - `Smart Meter Dashboard/` (13 files) — `Klima Dashboard.html` (entry + styles + the versioned script tags), `app.jsx` (grid shell), `header.jsx` (top bar), `tiles.jsx` (tile grid, drag/resize), `charts.jsx` (SVG chart primitives), `settings.jsx` (settings page), `export-panel.jsx` (CSV export dialog + backup settings), `summary-panel.jsx` (active-events detail panel), `data.js` (frontend data layer / `window.DASH_DATA`). Pure, DOM-free logic modules loaded as plain `<script>`s and unit-tested from Node (dual export: `window` + `module.exports`): `metrics-logic.js`, `summary-logic.js`, `status-logic.js`, `export-logic.js` — their tests live in `Smart Meter Dashboard/tests/` and run as the second half of `npm test`. `vendor/` holds the checked-in React/ReactDOM/Babel/Geist assets (see the no-external-assets rule below). Note the directory name contains spaces.
  - `scripts/` — one-off DB migration scripts, plus `args.js` (shared argument parsing; deliberately never guesses a DB path) and `README.md` (the run procedure). `VERSION` + the README badge + the `?v=` query in the HTML script tags all carry the SemVer version and must stay in sync.
  - `.github/workflows/` — `test.yml` (`npm test` on every push/PR) and `windows-bundle.yml` (the Windows release bundle + E2E smoke; kept separate so the heavy job does not run on every push).
- **The API docs snapshot** — `testo-smart-connect-api/` holds the curated upstream API documentation (endpoints, async pattern, auth, OData, schemas, limit values, Saveris 2 migration).

Run the app with `npm start` (serves on port 3000). Tests: `npm test`.

## Start here

For any task about the **testo API itself** (endpoint paths, async pattern, authentication, OData, schemas, limit values, migration from Saveris 2), read [testo-smart-connect-api/CLAUDE.md](testo-smart-connect-api/CLAUDE.md) first — it is the documentation index and routes to the right file. For application work, start from the `backend/` and `Smart Meter Dashboard/` files listed above. The editing safety rails below apply to the `testo-smart-connect-api/` docs snapshot, not to the application source.

## Deployment target: the app must stay Windows-runnable

The application is deployed as a **login-independent background service on a corporate Windows 11 x64 machine** (Windows Task Scheduler, account `NT AUTHORITY\NetworkService`, BootTrigger). Shipped in v0.10.0. The dev machine is macOS, so Windows behaviour is confirmed only by content review + a manual acceptance pass on a Windows box. Detailed design / plan / IT setup guide: [docs/superpowers/specs/2026-06-22-windows-service-design.md](docs/superpowers/specs/2026-06-22-windows-service-design.md), [docs/superpowers/plans/2026-06-22-windows-service.md](docs/superpowers/plans/2026-06-22-windows-service.md), [deploy/windows/README.md](deploy/windows/README.md) (the latter holds the §9 acceptance criteria).

**Any change to the app must keep these true** — they are easy to break from macOS, where the broken version still looks fine:

- **Paths:** always `path.join(__dirname, …)`; never hardcode `/`, Unix paths, or manual `'/'` concatenation. The DB path comes from `process.env.DB_PATH` (the service points it at `C:\ProgramData\TestoSmartAbruf\`) — never assume the code directory is writable (it may be read-only / under `C:\Program Files`).
- **Env loading:** dotenv is called with `{ path: path.join(__dirname, '../.env') }` (CWD-independent) because the service runs with a foreign working directory. Do not revert to bare `require('dotenv').config()`.
- **npm scripts:** no inline `VAR=value cmd` (breaks cmd.exe/PowerShell) — use `cross-env` (already a devDependency), as the `test` script does.
- **Native modules:** only add native deps that ship **win32-x64 prebuilds for Node 22/24/26** (the pinned `engines` / `.nvmrc=24`; Node 23/25 are excluded). Avoid deps that need a compiler — that breaks the corporate "nothing-surprising" / no-build-tools constraint. `better-sqlite3` is the only native module today.
- **"Nothing surprising" for corporate EDR:** no new bundled binaries, no surprising network calls at startup. `puppeteer` stays in `devDependencies` (the server installs with `npm ci --omit=dev`); the only outbound traffic is the testo-cloud sync.
- **No external frontend assets:** React, ReactDOM, Babel and the Geist fonts are checked in under `Smart Meter Dashboard/vendor/` and served locally — the dashboard makes **zero** external requests when opened. Never reintroduce a CDN (`unpkg`, `fonts.googleapis.com`, `fonts.gstatic.com`): the customer's IT allowlist contains the testo host only, so a CDN reference silently yields a blank dashboard on the target machine. `deploy/windows/README.md` documents this in "Voraussetzungen" and the §9 offline probe.
- **SQLite WAL:** the DB must stay on a **local disk** — WAL breaks on UNC / network shares.
- **Server binding:** configure via `PORT` / `HOST` env; `HOST` defaults to localhost. LAN access is opt-in (a firewall rule), never the default.
- **On release / when the deployment story changes:** keep `VERSION`, the README badge, `package.json` version, and all `?v=` cache-busters in `Klima Dashboard.html` (12 script tags) in sync; update `deploy/windows/` and re-run the Windows acceptance.

## Ignore: `spec/`

The `spec/` directory is a generated reverse-documentation snapshot (reconstruction spec of the application code), produced as a one-off deliverable. **Ignore it during normal work in this project** — do not read, edit, search, index, or treat it as a source of truth. It is not maintained in lockstep with the code and may go stale. Work from the actual source instead.

## Editing safety rails

- Every `.md` file (except the inner index and `_assets/glossary.md`) carries YAML frontmatter with `source_url`, `snapshot_date`, and `source_chunks`. This frontmatter is load-bearing for re-snapshotting — preserve it on every edit. Mechanics are described in the inner index's "How this directory was built" section.
- [testo-smart-connect-api/_assets/glossary.md](testo-smart-connect-api/_assets/glossary.md) is the single source of truth for terminology (endpoint names, async status enum, header casing). A cross-consistency reviewer greps for violations — match its spellings exactly.
- **Do not invent** endpoint paths, status enum values, header names, or schema fields. If a fact is not in an existing snapshot file with a `source_chunks` reference, re-fetch from upstream rather than writing it from memory.

## Running the app

Start command: `npm start` (runs `node backend/server.js`), serves on `http://localhost:3000` (default `PORT=3000`, overridable via env). **Claude Code sessions: don't re-derive this** — `.claude/launch.json` already defines the server config `dashboard`; start the app via `preview_start` with that name.

