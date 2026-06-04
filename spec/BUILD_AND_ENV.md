# Build & Environment

## Dependency manifest (`package.json`)

```json
{
  "name": "testo-smart-abruf",
  "version": "0.1.4",
  "description": "Local server and dashboard for testo Smart Connect API data sync",
  "main": "backend/server.js",
  "scripts": {
    "start": "node backend/server.js",
    "test": "node --test backend/tests/*.test.js"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "puppeteer": "^25.1.0"
  }
}
```

- `better-sqlite3` is a native module (needs a working node-gyp/toolchain or prebuilt binary at install).
- `puppeteer` is declared as a runtime dependency but the **server never imports it**. It is used only by ad-hoc dev/screenshot scripts at the repo root (`check-ui.js`, `test-ui.js`, `test-settings.js`, `test-errors.js`). A faithful rebuild may move it to `devDependencies`; the current state has it in `dependencies`. Installing puppeteer downloads a Chromium build.
- Frontend libraries are **not** npm deps — they load from CDN at runtime (see below). No bundler/transpiler in the toolchain.

## Frontend runtime dependencies (CDN, pinned with SRI)

Loaded by `Klima Dashboard.html` `<head>`/`<body>`:

```html
<!-- Google Fonts -->
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<!-- React stack (Subresource Integrity hashes present, crossorigin=anonymous) -->
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>
<!-- App code with cache-buster ?v=<VERSION> -->
<script src="data.js?v=0.1.4"></script>
<script type="text/babel" src="charts.jsx?v=0.1.4"></script>
<script type="text/babel" src="tiles.jsx?v=0.1.4"></script>
<script type="text/babel" src="settings.jsx?v=0.1.4"></script>
<script type="text/babel" src="app.jsx?v=0.1.4"></script>
```

Load order matters: `data.js` defines `window.DASH_DATA`; `charts.jsx` defines chart primitives on `window`; `tiles.jsx` uses charts; `settings.jsx` defines `SettingsPage`; `app.jsx` references all of them and renders. JSX files are `type="text/babel"` so `@babel/standalone` transpiles them in-browser.

**`?v=` cache-buster:** bump on every release (mirror `VERSION`) so reloads pick up new code instead of stale browser-cached copies. Reproduce this mechanism.

## Environment variables

Loaded via `dotenv` in `server.js`, `db.js`, `testo-client.js` (each calls `require('dotenv').config()`).

| Var | Purpose | Default if unset |
|---|---|---|
| `PORT` | Server listen port | `3000` |
| `DB_PATH` | SQLite file path; `':memory:'` disables seed/file-stats | `<repo>/klima.db` |
| `TESTO_API_KEY` | Seeds `settings.api_key` on **first run only** | `''` |
| `TESTO_API_REGION` | Seeds `settings.api_region` on first run | `'eu'` |
| `POLL_INTERVAL_SEC` | Seeds `settings.poll_interval_sec` on first run | `'900'` |
| `RETENTION_DAYS` | Seeds `settings.retention_days` on first run | `'365'` |

After first run, the seeded settings live in the DB and are edited via `POST /api/settings`; env changes no longer take effect unless the settings table is empty. `.env.example` is the template (its exact contents could not be read in this session — permission-blocked — but the variable set above is authoritative from code).

The special value `api_key === 'mock-api-key'` activates `TestoClient` mock mode (deterministic fixtures, no network) — used by tests and for offline demoing.

## External service

The testo **Smart Connect API** (cloud). Base URL `https://data-api.<region>.smartconnect.testo.com`, auth header `x-custom-api-key`. Async submit→poll→download. Full contract: `API_DOCS` (`testo-smart-connect-api/`, index `CLAUDE.md`). The app only needs network egress to that host (and to the CDNs/fonts for the frontend).

## Commands

```bash
npm install                          # installs deps (compiles better-sqlite3, downloads Chromium for puppeteer)
npm start                            # node backend/server.js
npm test                             # node --test backend/tests/*.test.js
node scripts/migrate-dewpoint-relabel.js [--apply] [--db <path>]   # one-off data fix (see MODULES/)
```

There is no lint, no build, no deploy script. "Deploy" = run `npm start` on the target host.

## Versioning convention

The version `0.1.4` appears in: `package.json` `version`, `VERSION` file, README badge, and the `?v=` query string on every frontend script tag. Keep all four in sync on bump. (A separate hardcoded `"Klima Dashboard 1.0.0"` string in `settings.jsx`'s About card is stale and inconsistent — see README Open Questions.)

## Open Questions

- Exact `.env.example` contents not readable this session (env files are permission-restricted). The variable list above is reconstructed from code defaults; if the template lists additional commented hints, re-derive from upstream.
- `puppeteer` placement (dep vs devDep) and the root-level `check-ui.js`/`test-*.js` scripts are dev tooling, not part of the shipped app; they screenshot/poke the running UI. Not required for the rebuild.
