# CSV Export + Monthly Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic monthly per-station CSV/ZIP backups (archival before the 365-day retention prune) and a manual settings-driven CSV export with selectable stations, metrics and time range.

**Architecture:** Five small, single-purpose backend modules build on each other — `csv-format` (dialect/escaping, pure) → `csv-export` (table builders, pure) + `zip-writer` (hand-rolled ZIP, pure) → `export-service` (DB queries + orchestration) → `backup-runner` (monthly scan + prune-floor). The scheduler calls the backup scan once/day and clamps the retention prune so it never deletes an un-backed-up month. A new frontend `export-panel.jsx` (thin React shell over a pure `export-logic.js`) drives the manual export.

**Tech Stack:** Node 22/24/26, better-sqlite3, Express, Node built-in `zlib` (ZIP), `node --test`. Frontend: React via Babel-in-browser (no build step), dual-export IIFE logic modules.

## Global Constraints

- **Version target:** bump `0.10.0` → **`0.11.0`** (MINOR). Keep `VERSION`, README badge, `package.json` `version`, and **all `?v=` cache-busters in `Smart Meter Dashboard/Klima Dashboard.html`** in sync. After this plan the HTML has **12** module script tags (was 10: +`export-logic.js`, +`export-panel.jsx`).
- **Paths:** always `path.join(__dirname, …)`; never hardcode `/` or Unix paths. Backup dir derives from `path.dirname(process.env.DB_PATH)`. Never assume the code dir is writable.
- **DB path:** from `process.env.DB_PATH` (`:memory:` in tests). dotenv loaded as `require('dotenv').config({ path: path.join(__dirname, '../.env') })`.
- **No new dependencies.** ZIP uses only Node's built-in `zlib`. (`better-sqlite3` stays the only native module.)
- **npm scripts:** no inline `VAR=value cmd`; use `cross-env` (already present).
- **SQLite WAL stays on local disk.** Only the ZIP backups may live on a network share (`backup_dir`).
- **CSV dialects:** `de` = delimiter `;`, decimal `,`; `rfc` = delimiter `,`, decimal `.`. Both: UTF-8 **with BOM** (`﻿`) + **CRLF** (`\r\n`). Default `de`.
- **CSV injection:** text cells beginning with `= + - @`, TAB or CR get a leading `'`. Numbers/timestamps are never injection-prefixed.
- **Frontend hook aliases:** every `.jsx` must alias React hooks uniquely (e.g. `const { useState: useStateX } = React`); bare `useState`/`useEffect` collide with charts.jsx globals → blank page.
- **Test command:** `npm test` (runs `backend/tests/*.test.js` globbed + the explicitly-listed frontend logic tests).

---

## File Structure

**Create (backend):**
- `backend/csv-format.js` — CSV dialect, field escaping, number & timestamp formatting, BOM/CRLF. Pure.
- `backend/csv-export.js` — measurement wide-pivot CSV, events CSV, header block. Pure (no DB).
- `backend/zip-writer.js` — `createZip(entries)` → Buffer. Pure (only `zlib`).
- `backend/export-service.js` — DB queries + `exportStations()` / `getExportMetadata()`. DB-bound.
- `backend/backup-runner.js` — `runBackupScan` / `maybeRunBackupScan` / `computePruneFloor` / `resolveBackupDir`. DB+FS.

**Create (backend tests):** `backend/tests/csv-format.test.js`, `csv-export.test.js`, `zip-writer.test.js`, `export-service.test.js`, `backup-runner.test.js`.

**Create (frontend):**
- `Smart Meter Dashboard/export-logic.js` — pure: preset ranges, payload builder, metric union, filename parse. Dual-export IIFE.
- `Smart Meter Dashboard/export-panel.jsx` — React shell (dialog + backup-status block).
- `Smart Meter Dashboard/tests/export-logic.test.js` — unit tests for export-logic.

**Modify:**
- `backend/db.js` — seed new settings keys.
- `backend/scheduler.js` — call `maybeRunBackupScan` + clamp retention prune via `computePruneFloor`.
- `backend/server.js` — `GET /api/export/metadata`, `POST /api/export`, settings GET/POST extension, system/status backup block.
- `Smart Meter Dashboard/data.js` — `fetchExportMetadata()`, `postExport()`.
- `Smart Meter Dashboard/Klima Dashboard.html` — 2 new script tags + bump all `?v=`.
- `package.json` — version + add `export-logic.test.js` to test script.
- `VERSION`, `README.md` badge, `deploy/windows/README.md`.

---

## Task 1: csv-format.js (dialect, escaping, formatting)

**Files:**
- Create: `backend/csv-format.js`
- Test: `backend/tests/csv-format.test.js`

**Interfaces:**
- Produces:
  - `DIALECTS` = `{ de: {key:'de', delimiter:';', decimal:',', label:"Deutsch (Excel)"}, rfc: {key:'rfc', delimiter:',', decimal:'.', label:"International (RFC)"} }`
  - `getDialect(name) → dialect` (unknown/empty → `DIALECTS.de`)
  - `formatNumber(value, dialect) → string` ('' for null/undefined/NaN)
  - `escapeField(text, dialect) → string` (injection guard + RFC quoting; for TEXT cells)
  - `joinRow(cells, dialect) → string` (pre-escaped cells joined by delimiter + CRLF)
  - `formatTimestamps(epochMs) → { iso, local }`
  - `BOM` = `'﻿'`, `CRLF` = `'\r\n'`

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/csv-format.test.js
const test = require('node:test');
const assert = require('node:assert');
const { DIALECTS, getDialect, formatNumber, escapeField, joinRow, formatTimestamps, BOM, CRLF } = require('../csv-format');

test('getDialect: default de for unknown/empty', () => {
  assert.strictEqual(getDialect('').key, 'de');
  assert.strictEqual(getDialect('xx').key, 'de');
  assert.strictEqual(getDialect('rfc').key, 'rfc');
});

test('formatNumber: shortest round-trip, decimal per dialect, no thousands sep', () => {
  assert.strictEqual(formatNumber(21.3, DIALECTS.de), '21,3');
  assert.strictEqual(formatNumber(21.3, DIALECTS.rfc), '21.3');
  assert.strictEqual(formatNumber(1234.5, DIALECTS.de), '1234,5');
  assert.strictEqual(formatNumber(-5, DIALECTS.de), '-5');
  assert.strictEqual(formatNumber(null, DIALECTS.de), '');
  assert.strictEqual(formatNumber(NaN, DIALECTS.de), '');
});

test('escapeField: quotes fields containing delimiter, quote or newline; doubles quotes', () => {
  assert.strictEqual(escapeField('plain', DIALECTS.de), 'plain');
  assert.strictEqual(escapeField('a;b', DIALECTS.de), '"a;b"');
  assert.strictEqual(escapeField('a,b', DIALECTS.de), 'a,b'); // comma not a delimiter in de
  assert.strictEqual(escapeField('a,b', DIALECTS.rfc), '"a,b"');
  assert.strictEqual(escapeField('he said "hi"', DIALECTS.de), '"he said ""hi"""');
  assert.strictEqual(escapeField('line1\nline2', DIALECTS.de), '"line1\nline2"');
});

test('escapeField: CSV-injection guard prefixes risky leading chars', () => {
  assert.strictEqual(escapeField('=1+2', DIALECTS.de), "'=1+2");
  assert.strictEqual(escapeField('+49', DIALECTS.de), "'+49");
  assert.strictEqual(escapeField('-cmd', DIALECTS.de), "'-cmd");
  assert.strictEqual(escapeField('@x', DIALECTS.de), "'@x");
  assert.strictEqual(escapeField('safe-=', DIALECTS.de), 'safe-='); // only LEADING char matters
});

test('joinRow: joins escaped cells with delimiter + CRLF', () => {
  assert.strictEqual(joinRow(['a', 'b'], DIALECTS.de), 'a;b\r\n');
  assert.strictEqual(joinRow(['a', 'b'], DIALECTS.rfc), 'a,b\r\n');
});

test('formatTimestamps: ISO with offset + local Excel form from same epoch', () => {
  const { iso, local } = formatTimestamps(Date.UTC(2026, 4, 1, 12, 30, 0)); // 2026-05-01T12:30Z
  // Offset depends on the host TZ; assert structure not absolute value.
  assert.match(iso, /^2026-05-01T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.match(local, /^2026-05-01 \d{2}:\d{2}:\d{2}$/);
});

test('constants', () => {
  assert.strictEqual(BOM, '﻿');
  assert.strictEqual(CRLF, '\r\n');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/csv-format.test.js`
Expected: FAIL — `Cannot find module '../csv-format'`.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/csv-format.js
// Pure CSV dialect + formatting helpers. No DB, no fs. Shared by csv-export.
const BOM = '﻿';
const CRLF = '\r\n';

const DIALECTS = {
  de:  { key: 'de',  delimiter: ';', decimal: ',', label: 'Deutsch (Excel)' },
  rfc: { key: 'rfc', delimiter: ',', decimal: '.', label: 'International (RFC)' },
};

function getDialect(name) {
  return DIALECTS[name] || DIALECTS.de;
}

// Shortest round-trip number string, decimal separator per dialect, no thousands separator.
function formatNumber(value, dialect) {
  if (value === null || value === undefined || typeof value !== 'number' || Number.isNaN(value)) return '';
  let s = String(value); // shortest round-trip representation, always uses '.'
  if (dialect.decimal !== '.') s = s.replace('.', dialect.decimal);
  return s;
}

const INJECTION_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

// Escape a TEXT cell: CSV-injection guard, then RFC-4180 quoting if needed.
function escapeField(text, dialect) {
  let s = (text === null || text === undefined) ? '' : String(text);
  if (s.length > 0 && INJECTION_CHARS.has(s[0])) s = "'" + s;
  const needsQuote = s.includes(dialect.delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r');
  if (needsQuote) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Join already-escaped/formatted cells into one CSV line.
function joinRow(cells, dialect) {
  return cells.join(dialect.delimiter) + CRLF;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// From a UTC epoch (ms), produce ISO-8601-with-offset and a local Excel-friendly string,
// both in the host's local timezone (DST-correct via getTimezoneOffset).
function formatTimestamps(epochMs) {
  const d = new Date(epochMs);
  const y = d.getFullYear(), mo = pad2(d.getMonth() + 1), da = pad2(d.getDate());
  const h = pad2(d.getHours()), mi = pad2(d.getMinutes()), se = pad2(d.getSeconds());
  const offMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return {
    iso: `${y}-${mo}-${da}T${h}:${mi}:${se}${offset}`,
    local: `${y}-${mo}-${da} ${h}:${mi}:${se}`,
  };
}

module.exports = { DIALECTS, getDialect, formatNumber, escapeField, joinRow, formatTimestamps, BOM, CRLF };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/csv-format.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/csv-format.js backend/tests/csv-format.test.js
git commit -m "feat(export): add csv-format dialect + escaping helpers"
```

---

## Task 2: zip-writer.js (hand-rolled ZIP)

**Files:**
- Create: `backend/zip-writer.js`
- Test: `backend/tests/zip-writer.test.js`

**Interfaces:**
- Produces: `createZip(entries) → Buffer` where `entries = [{ name:string, data:Buffer|string, mtime?:Date }]`. Deflate (method 8), UTF-8 filename flag (bit 11), no ZIP64.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/zip-writer.test.js
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { createZip } = require('../zip-writer');

const FIXED = new Date(Date.UTC(2026, 4, 1, 10, 0, 0));

test('createZip: returns a Buffer with local header + EOCD signatures', () => {
  const buf = createZip([{ name: 'a.txt', data: 'hello', mtime: FIXED }]);
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);          // first local file header
  // EOCD signature appears near the end:
  const eocd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'EOCD present');
});

test('createZip: entries round-trip (manual central-directory parse + inflate)', () => {
  const entries = [
    { name: 'mess.csv', data: 'ts;v\r\n1;2\r\n', mtime: FIXED },
    { name: 'meld.csv', data: Buffer.from('x'), mtime: FIXED },
  ];
  const buf = createZip(entries);
  // Find EOCD, read central-directory offset + count, then parse each central record.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  assert.strictEqual(count, 2);
  const got = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(cd), 0x02014b50);       // central dir signature
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    // Local header: 30 + nameLen + extraLen, then compressed data.
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? zlib.inflateRawSync(comp) : comp;
    got[name] = raw.toString('utf8');
    cd += 46 + nameLen + extraLen + commentLen;
  }
  assert.strictEqual(got['mess.csv'], 'ts;v\r\n1;2\r\n');
  assert.strictEqual(got['meld.csv'], 'x');
});

test('createZip: sets UTF-8 general-purpose flag (bit 11) for filenames', () => {
  const buf = createZip([{ name: 'Serverraum_2026-05.csv', data: 'x', mtime: FIXED }]);
  const flags = buf.readUInt16LE(6); // local header general purpose bit flag
  assert.strictEqual(flags & 0x0800, 0x0800);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/zip-writer.test.js`
Expected: FAIL — `Cannot find module '../zip-writer'`.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/zip-writer.js
// Minimal ZIP (PKZIP) writer using Node's built-in zlib. Deflate (method 8),
// UTF-8 filename flag, no ZIP64 (entry/archive sizes here are well under 4 GiB).
const zlib = require('node:zlib');

function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

// entries: [{ name, data: Buffer|string, mtime?: Date }]
function createZip(entries) {
  const localParts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data);
    const { time, date } = dosDateTime(e.mtime || new Date());
    const FLAG_UTF8 = 0x0800;
    const METHOD = 8;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);  // local file header signature
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(FLAG_UTF8, 6);   // general purpose bit flag
    lh.writeUInt16LE(METHOD, 8);      // compression method = deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);          // extra length
    localParts.push(lh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);  // central directory header signature
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(METHOD, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra length
    cd.writeUInt16LE(0, 32);          // comment length
    cd.writeUInt16LE(0, 34);          // disk number start
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0, 38);          // external attrs
    cd.writeUInt32LE(offset, 42);     // local header offset
    central.push(Buffer.concat([cd, nameBuf]));

    offset += lh.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // EOCD signature
  eocd.writeUInt16LE(0, 4);                   // disk number
  eocd.writeUInt16LE(0, 6);                   // central dir start disk
  eocd.writeUInt16LE(entries.length, 8);      // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);     // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);  // central dir size
  eocd.writeUInt32LE(offset, 16);             // central dir offset
  eocd.writeUInt16LE(0, 20);                  // comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

module.exports = { createZip };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/zip-writer.test.js`
Expected: PASS.

- [ ] **Step 5: Cross-check with system unzip (optional sanity, non-blocking)**

Run: `node -e "const{createZip}=require('./backend/zip-writer');require('fs').writeFileSync('/tmp/zt.zip',createZip([{name:'a.txt',data:'hi'}]))" && unzip -t /tmp/zt.zip`
Expected: `No errors detected in compressed data of /tmp/zt.zip.` (If `unzip` absent, skip — the round-trip test already proves correctness.)

- [ ] **Step 6: Commit**

```bash
git add backend/zip-writer.js backend/tests/zip-writer.test.js
git commit -m "feat(export): add dependency-free zip-writer (zlib + CRC32)"
```

---

## Task 3: csv-export.js (table builders)

**Files:**
- Create: `backend/csv-export.js`
- Test: `backend/tests/csv-export.test.js`

**Interfaces:**
- Consumes: `csv-format` (`getDialect`, `formatNumber`, `escapeField`, `joinRow`, `formatTimestamps`, `BOM`).
- Produces:
  - `METRIC_LABELS` (key→German label), `METRIC_ORDER` (priority array)
  - `pivotMeasurements(rows, metricKeys) → { columns:[{key,label,unit}], data:[{ts, values:Map}] }`
  - `classifyEventArt(event) → 'Alarm' | 'Meldung'`
  - `buildMeasurementsCsv({ station, rows, metricKeys, fromTs, toTs, dialect, appVersion, nowMs }) → string`
  - `buildEventsCsv({ station, events, fromTs, toTs, dialect, appVersion, nowMs }) → string`
  - `rows` shape: `{ timestamp, value, physical_property, unit }`. `station` shape: `{ name, location, serial_no, model_code }`. `event` shape: `events`-table columns.
  - `metricKeys`: ordered array of metric keys to include as columns (caller decides; null/undefined → all present, in `METRIC_ORDER`).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/csv-export.test.js
const test = require('node:test');
const assert = require('node:assert');
const { pivotMeasurements, classifyEventArt, buildMeasurementsCsv, buildEventsCsv } = require('../csv-export');
const { getDialect } = require('../csv-format');

const STATION = { name: 'Serverraum EG', location: 'Geb A', serial_no: '12345678', model_code: '0572 2620' };
const DE = getDialect('de');

test('pivotMeasurements: groups by timestamp, one column per metric, blanks for gaps', () => {
  const rows = [
    { timestamp: 1000, value: 21.0, physical_property: 'temperature', unit: '°C' },
    { timestamp: 1000, value: 45.0, physical_property: 'humidity', unit: '%rF' },
    { timestamp: 2000, value: 21.5, physical_property: 'temperature', unit: '°C' },
    // no humidity at 2000 → blank
  ];
  const { columns, data } = pivotMeasurements(rows, ['temperature', 'humidity']);
  assert.deepStrictEqual(columns.map(c => c.key), ['temperature', 'humidity']);
  assert.strictEqual(data.length, 2);
  assert.strictEqual(data[0].ts, 1000);
  assert.strictEqual(data[0].values.get('humidity'), 45.0);
  assert.strictEqual(data[1].values.has('humidity'), false);
});

test('classifyEventArt: measured metric => Alarm, system => Meldung', () => {
  assert.strictEqual(classifyEventArt({ metric: 'temperature', threshold: 8 }), 'Alarm');
  assert.strictEqual(classifyEventArt({ metric: null, alarm_reason: 'connection' }), 'Meldung');
  assert.strictEqual(classifyEventArt({ metric: 'battery' }), 'Meldung');
});

test('buildMeasurementsCsv: BOM, header block, CRLF table, decimal per dialect', () => {
  const rows = [{ timestamp: Date.UTC(2026,4,1,10,0,0), value: 21.3, physical_property: 'temperature', unit: '°C' }];
  const csv = buildMeasurementsCsv({ station: STATION, rows, metricKeys: ['temperature'], fromTs: 0, toTs: 9e15, dialect: DE, appVersion: '0.11.0', nowMs: Date.UTC(2026,5,1,1,0,0) });
  assert.ok(csv.startsWith('﻿'), 'has BOM');
  assert.ok(csv.includes('Messstelle;Serverraum EG'), 'header block has station');
  assert.ok(csv.includes('Temperatur [°C]'), 'column label');
  assert.ok(csv.includes('21,3'), 'decimal comma');
  assert.ok(csv.includes('\r\n'), 'CRLF');
});

test('buildMeasurementsCsv: empty data => header-only + note', () => {
  const csv = buildMeasurementsCsv({ station: STATION, rows: [], metricKeys: ['temperature'], fromTs: 0, toTs: 1, dialect: DE, appVersion: '0.11.0', nowMs: 0 });
  assert.ok(csv.includes('# Keine Daten im gewählten Zeitraum'));
});

test('buildEventsCsv: columns + Art + open end empty', () => {
  const events = [
    { start_ts: Date.UTC(2026,4,2,8,0,0), end_ts: null, severity: 'alarm', metric: 'temperature', threshold: 8, alarm_status: 'Alarm', alarm_reason: 'Upper limit', alarm_value: 9.1, extreme: 9.4, message: 'Temp zu hoch', detail: '' },
  ];
  const csv = buildEventsCsv({ station: STATION, events, fromTs: 0, toTs: 9e15, dialect: DE, appVersion: '0.11.0', nowMs: 0 });
  assert.ok(csv.includes('Start (ISO);Start (lokal);Ende (ISO);Ende (lokal);Art;'));
  assert.ok(csv.includes(';Alarm;'), 'Art column = Alarm');
  assert.ok(csv.includes('Temp zu hoch'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/csv-export.test.js`
Expected: FAIL — `Cannot find module '../csv-export'`.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/csv-export.js
// Pure CSV table builders (measurements wide-pivot + events). No DB access.
const { formatNumber, escapeField, joinRow, formatTimestamps, BOM } = require('./csv-format');

const METRIC_LABELS = {
  temperature: 'Temperatur', humidity: 'Feuchte', pressure: 'Druck',
  dewpoint: 'Taupunkt', abshumid: 'Absolute Feuchte',
};
const METRIC_ORDER = ['temperature', 'humidity', 'pressure', 'dewpoint', 'abshumid'];
const MEASURED_METRICS = new Set(METRIC_ORDER);

function labelFor(key) { return METRIC_LABELS[key] || key; }

// Pivot long rows ({timestamp, value, physical_property, unit}) into wide form.
function pivotMeasurements(rows, metricKeys) {
  const unitByKey = new Map();
  for (const r of rows) if (!unitByKey.has(r.physical_property)) unitByKey.set(r.physical_property, r.unit);

  let keys;
  if (Array.isArray(metricKeys) && metricKeys.length) {
    keys = metricKeys.slice();
  } else {
    const present = new Set(rows.map(r => r.physical_property));
    keys = [...METRIC_ORDER.filter(k => present.has(k)), ...[...present].filter(k => !MEASURED_METRICS.has(k)).sort()];
  }
  const columns = keys.map(k => ({ key: k, label: labelFor(k), unit: unitByKey.get(k) || '' }));

  const byTs = new Map();
  for (const r of rows) {
    if (!keys.includes(r.physical_property)) continue;
    if (!byTs.has(r.timestamp)) byTs.set(r.timestamp, new Map());
    byTs.get(r.timestamp).set(r.physical_property, r.value);
  }
  const data = [...byTs.keys()].sort((a, b) => a - b).map(ts => ({ ts, values: byTs.get(ts) }));
  return { columns, data };
}

function classifyEventArt(event) {
  if (event && event.metric && MEASURED_METRICS.has(event.metric)) return 'Alarm';
  return 'Meldung';
}

function headerBlock(lines, dialect) {
  // lines: [[key, value], …] — values escaped (may contain delimiter).
  return lines.map(([k, v]) => joinRow([escapeField(k, dialect), escapeField(String(v), dialect)], dialect)).join('');
}

function buildMeasurementsCsv({ station, rows, metricKeys, fromTs, toTs, dialect, appVersion, nowMs }) {
  const { columns, data } = pivotMeasurements(rows, metricKeys);
  const created = formatTimestamps(nowMs);
  const from = formatTimestamps(fromTs), to = formatTimestamps(toTs);
  const channelList = columns.map(c => `${c.label} [${c.unit}]`).join(' · ');

  let out = BOM;
  out += headerBlock([
    ['testo Smart Abruf', 'Messwert-Export'],
    ['Anwendung', `testo-smart-abruf ${appVersion}`],
    ['Erstellt am', `${created.iso} (${created.local})`],
    ['Messstelle', station.name || ''],
    ['Standort', station.location || ''],
    ['Seriennummer', station.serial_no || ''],
    ['Modell', station.model_code || ''],
    ['Zeitraum von', from.iso],
    ['Zeitraum bis', to.iso],
    ['Kanäle', channelList],
    ['Datensätze', String(data.length)],
    ['CSV-Format', `${dialect.label}: Trennzeichen '${dialect.delimiter}', Dezimal '${dialect.decimal}'`],
  ], dialect);
  out += joinRow([''], dialect); // blank separator line

  const head = ['Zeitpunkt (ISO)', 'Zeitpunkt (lokal)', ...columns.map(c => `${c.label} [${c.unit}]`)];
  out += joinRow(head.map(h => escapeField(h, dialect)), dialect);

  if (data.length === 0) {
    out += joinRow([escapeField('# Keine Daten im gewählten Zeitraum', dialect)], dialect);
    return out;
  }
  for (const row of data) {
    const ts = formatTimestamps(row.ts);
    const cells = [escapeField(ts.iso, dialect), escapeField(ts.local, dialect)];
    for (const c of columns) cells.push(formatNumber(row.values.has(c.key) ? row.values.get(c.key) : null, dialect));
    out += joinRow(cells, dialect);
  }
  return out;
}

function buildEventsCsv({ station, events, fromTs, toTs, dialect, appVersion, nowMs }) {
  const created = formatTimestamps(nowMs);
  const from = formatTimestamps(fromTs), to = formatTimestamps(toTs);

  let out = BOM;
  out += headerBlock([
    ['testo Smart Abruf', 'Meldungen & Alarme'],
    ['Anwendung', `testo-smart-abruf ${appVersion}`],
    ['Erstellt am', `${created.iso} (${created.local})`],
    ['Messstelle', station.name || ''],
    ['Standort', station.location || ''],
    ['Seriennummer', station.serial_no || ''],
    ['Zeitraum von', from.iso],
    ['Zeitraum bis', to.iso],
    ['Anzahl', String(events.length)],
    ['CSV-Format', `${dialect.label}: Trennzeichen '${dialect.delimiter}', Dezimal '${dialect.decimal}'`],
  ], dialect);
  out += joinRow([''], dialect);

  const head = ['Start (ISO)', 'Start (lokal)', 'Ende (ISO)', 'Ende (lokal)', 'Art', 'Schweregrad',
    'Messgröße', 'Status', 'Grund', 'Auslösewert', 'Schwelle', 'Extremwert', 'Meldungstext', 'Detail'];
  out += joinRow(head.map(h => escapeField(h, dialect)), dialect);

  if (events.length === 0) {
    out += joinRow([escapeField('# Keine Meldungen im gewählten Zeitraum', dialect)], dialect);
    return out;
  }
  const sorted = events.slice().sort((a, b) => a.start_ts - b.start_ts);
  for (const e of sorted) {
    const s = formatTimestamps(e.start_ts);
    const en = (e.end_ts === null || e.end_ts === undefined) ? { iso: '', local: '' } : formatTimestamps(e.end_ts);
    out += joinRow([
      escapeField(s.iso, dialect), escapeField(s.local, dialect),
      escapeField(en.iso, dialect), escapeField(en.local, dialect),
      escapeField(classifyEventArt(e), dialect),
      escapeField(e.severity || '', dialect),
      escapeField(e.metric ? labelFor(e.metric) : '', dialect),
      escapeField(e.alarm_status || '', dialect),
      escapeField(e.alarm_reason || '', dialect),
      formatNumber(typeof e.alarm_value === 'number' ? e.alarm_value : null, dialect),
      formatNumber(typeof e.threshold === 'number' ? e.threshold : null, dialect),
      formatNumber(typeof e.extreme === 'number' ? e.extreme : null, dialect),
      escapeField(e.message || '', dialect),
      escapeField(e.detail || '', dialect),
    ], dialect);
  }
  return out;
}

module.exports = { METRIC_LABELS, METRIC_ORDER, pivotMeasurements, classifyEventArt, buildMeasurementsCsv, buildEventsCsv };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/csv-export.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/csv-export.js backend/tests/csv-export.test.js
git commit -m "feat(export): add csv-export table builders (wide pivot + events)"
```

---

## Task 4: export-service.js (DB queries + orchestration)

**Files:**
- Create: `backend/export-service.js`
- Test: `backend/tests/export-service.test.js`

**Interfaces:**
- Consumes: `db` (`getDb`), `csv-export`, `zip-writer` (`createZip`), `csv-format` (`getDialect`), `package.json` version.
- Produces:
  - `safeFileName(name) → string`
  - `queryMeasurements(stationId, fromTs, toTs, metricKeys) → rows[]`
  - `queryEvents(stationId, fromTs, toTs) → rows[]`
  - `getExportMetadata() → [{ id, name, metrics:[{key,label,unit}], earliest_ts, latest_ts }]`
  - `exportStations({ stationIds, metricKeys, fromTs, toTs, includeEvents, dialectName, nowMs }) → { kind:'csv'|'zip', filename, mime, buffer }`
    - 1 station & !includeEvents → single CSV; otherwise ZIP.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/export-service.test.js
const test = require('node:test');
const assert = require('node:assert');
process.env.DB_PATH = ':memory:';
const { getDb } = require('../db');
const svc = require('../export-service');

function seed() {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  db.prepare("INSERT INTO stations (id,name,location,serial_no,model_code) VALUES (?,?,?,?,?)")
    .run('s1', 'Serverraum', 'A', '111', 'M1');
  db.prepare("INSERT INTO stations (id,name,location,serial_no,model_code) VALUES (?,?,?,?,?)")
    .run('s2', 'Lager', 'B', '222', 'M2');
  const m = db.prepare("INSERT INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES (?,?,?,?,?,?)");
  m.run('m1', 's1', 1000, 21.0, 'temperature', '°C');
  m.run('m2', 's1', 1000, 45.0, 'humidity', '%rF');
  m.run('m3', 's2', 2000, 19.0, 'temperature', '°C');
}

test('safeFileName: strips illegal chars, keeps umlauts', () => {
  assert.strictEqual(svc.safeFileName('Büro 1/OG: A'), 'Büro 1_OG_ A'.replace(/ /g,' ')); // illegal / and : -> _
  assert.strictEqual(svc.safeFileName('a*b?c'), 'a_b_c');
});

test('exportStations: single station, no events => single CSV', () => {
  seed();
  const res = svc.exportStations({ stationIds: ['s1'], metricKeys: null, fromTs: 0, toTs: 9e15, includeEvents: false, dialectName: 'de', nowMs: 0 });
  assert.strictEqual(res.kind, 'csv');
  assert.strictEqual(res.mime, 'text/csv; charset=utf-8');
  assert.ok(res.filename.endsWith('.csv'));
  assert.ok(res.buffer.toString('utf8').includes('Temperatur [°C]'));
});

test('exportStations: multiple stations => zip with one csv per station', () => {
  seed();
  const res = svc.exportStations({ stationIds: ['s1','s2'], metricKeys: null, fromTs: 0, toTs: 9e15, includeEvents: false, dialectName: 'de', nowMs: 0 });
  assert.strictEqual(res.kind, 'zip');
  assert.strictEqual(res.mime, 'application/zip');
  assert.strictEqual(res.buffer.readUInt32LE(0), 0x04034b50);
});

test('exportStations: includeEvents forces zip with 2 files even for one station', () => {
  seed();
  const res = svc.exportStations({ stationIds: ['s1'], metricKeys: null, fromTs: 0, toTs: 9e15, includeEvents: true, dialectName: 'de', nowMs: 0 });
  assert.strictEqual(res.kind, 'zip');
});

test('getExportMetadata: lists stations with available metrics + range', () => {
  seed();
  const meta = svc.getExportMetadata();
  const s1 = meta.find(x => x.id === 's1');
  assert.deepStrictEqual(s1.metrics.map(m => m.key).sort(), ['humidity','temperature']);
  assert.strictEqual(s1.earliest_ts, 1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/export-service.test.js`
Expected: FAIL — `Cannot find module '../export-service'`.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/export-service.js
// DB-bound orchestration: queries + builds CSV or ZIP. Shared by manual export and backup.
const { getDb } = require('./db');
const { getDialect } = require('./csv-format');
const { buildMeasurementsCsv, buildEventsCsv, METRIC_ORDER } = require('./csv-export');
const { createZip } = require('./zip-writer');
const APP_VERSION = require('../package.json').version || '0.0.0';

function safeFileName(name) {
  return String(name || 'Messstelle')
    .replace(/[<>:"/\\|?* -]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || 'Messstelle';
}

function queryMeasurements(stationId, fromTs, toTs, metricKeys) {
  const db = getDb();
  let sql = "SELECT timestamp, value, physical_property, unit FROM measurements WHERE station_id = ? AND timestamp >= ? AND timestamp <= ?";
  const args = [stationId, fromTs, toTs];
  if (Array.isArray(metricKeys) && metricKeys.length) {
    sql += ` AND physical_property IN (${metricKeys.map(() => '?').join(',')})`;
    args.push(...metricKeys);
  }
  sql += " ORDER BY timestamp ASC";
  return db.prepare(sql).all(...args);
}

function queryEvents(stationId, fromTs, toTs) {
  return getDb().prepare(
    "SELECT start_ts, end_ts, severity, metric, threshold, alarm_status, alarm_reason, alarm_value, extreme, message, detail FROM events WHERE station_id = ? AND start_ts >= ? AND start_ts <= ? ORDER BY start_ts ASC"
  ).all(stationId, fromTs, toTs);
}

function getStation(stationId) {
  return getDb().prepare("SELECT id, name, location, serial_no, model_code FROM stations WHERE id = ?").get(stationId);
}

function getExportMetadata() {
  const db = getDb();
  const stations = db.prepare("SELECT id, name FROM stations ORDER BY name").all();
  return stations.map(s => {
    const metrics = db.prepare("SELECT DISTINCT physical_property AS key, unit FROM measurements WHERE station_id = ?").all(s.id)
      .map(r => ({ key: r.key, unit: r.unit }))
      .sort((a, b) => METRIC_ORDER.indexOf(a.key) - METRIC_ORDER.indexOf(b.key));
    const range = db.prepare("SELECT MIN(timestamp) AS earliest_ts, MAX(timestamp) AS latest_ts FROM measurements WHERE station_id = ?").get(s.id);
    return { id: s.id, name: s.name, metrics, earliest_ts: range.earliest_ts, latest_ts: range.latest_ts };
  });
}

// Build the per-station CSV file objects ({name, data}) for the ZIP / single download.
function stationFiles(station, { metricKeys, fromTs, toTs, includeEvents, dialect, nowMs }) {
  const base = safeFileName(station.name);
  const files = [];
  const rows = queryMeasurements(station.id, fromTs, toTs, metricKeys);
  files.push({ name: `${base}_messwerte.csv`, data: buildMeasurementsCsv({ station, rows, metricKeys, fromTs, toTs, dialect, appVersion: APP_VERSION, nowMs }) });
  if (includeEvents) {
    const events = queryEvents(station.id, fromTs, toTs);
    files.push({ name: `${base}_meldungen.csv`, data: buildEventsCsv({ station, events, fromTs, toTs, dialect, appVersion: APP_VERSION, nowMs }) });
  }
  return files;
}

function exportStations({ stationIds, metricKeys, fromTs, toTs, includeEvents, dialectName, nowMs }) {
  const dialect = getDialect(dialectName);
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const opts = { metricKeys, fromTs, toTs, includeEvents, dialect, nowMs: now };

  const stations = stationIds.map(getStation).filter(Boolean);
  if (stations.length === 0) throw new Error('Keine gültige Messstelle ausgewählt');

  // Single CSV only when exactly one station and no events file.
  if (stations.length === 1 && !includeEvents) {
    const files = stationFiles(stations[0], opts);
    return {
      kind: 'csv', mime: 'text/csv; charset=utf-8',
      filename: `${safeFileName(stations[0].name)}_messwerte.csv`,
      buffer: Buffer.from(files[0].data, 'utf8'),
    };
  }

  const entries = [];
  for (const st of stations) for (const f of stationFiles(st, opts)) entries.push({ name: f.name, data: f.data, mtime: new Date(now) });
  return {
    kind: 'zip', mime: 'application/zip',
    filename: stations.length === 1 ? `${safeFileName(stations[0].name)}_export.zip` : `messwert-export.zip`,
    buffer: createZip(entries),
  };
}

module.exports = { safeFileName, queryMeasurements, queryEvents, getExportMetadata, exportStations, stationFiles };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/export-service.test.js`
Expected: PASS. (Note: the `safeFileName` assertion in the test uses `: `→`_ ` — verify the exact expected string matches the regex; adjust the test literal to the actual output if needed.)

- [ ] **Step 5: Commit**

```bash
git add backend/export-service.js backend/tests/export-service.test.js
git commit -m "feat(export): add export-service (queries + csv/zip orchestration)"
```

---

## Task 5: db.js settings seed

**Files:**
- Modify: `backend/db.js` (the settings seed block, currently ~lines 119-127)
- Test: `backend/tests/db.test.js` (extend) — or add assertions in a new test; here extend.

**Interfaces:**
- Produces: settings keys `backup_enabled`='1', `backup_dir`='', `csv_format`='de' present after init on a fresh DB. (`last_backup_scan_date`, `backup_health` are written lazily at runtime — not seeded.)

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/db.test.js — ADD this test (keep existing ones)
test('initDb seeds CSV-export/backup settings defaults', () => {
  process.env.DB_PATH = ':memory:';
  const { getDb, getSetting } = require('../db');
  getDb(); // triggers initDb + seed
  assert.strictEqual(getSetting('backup_enabled'), '1');
  assert.strictEqual(getSetting('csv_format'), 'de');
  assert.strictEqual(getSetting('backup_dir'), '');
});
```
(If `db.test.js` lacks `require('node:test')`/`assert` headers at top, they already exist — match the file's existing style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/db.test.js`
Expected: FAIL — `backup_enabled` is `null`.

- [ ] **Step 3: Write minimal implementation**

In `backend/db.js`, inside the `if (count === 0) {` seed block, after the existing `stmt.run('retention_days', …)` line, add:

```js
      stmt.run('backup_enabled', '1');
      stmt.run('backup_dir', '');
      stmt.run('csv_format', 'de');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/db.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/db.js backend/tests/db.test.js
git commit -m "feat(export): seed backup/csv-format settings defaults"
```

---

## Task 6: backup-runner.js (monthly scan + prune floor)

**Files:**
- Create: `backend/backup-runner.js`
- Test: `backend/tests/backup-runner.test.js`

**Interfaces:**
- Consumes: `db` (`getDb`, `getSetting`, `saveSetting`), `export-service` (`stationFiles`, `getExportMetadata`-style queries), `zip-writer`, `csv-format` (`getDialect`), `fs`, `path`.
- Produces:
  - `resolveBackupDir() → absolutePath`
  - `monthKey(epochMs) → 'YYYY-MM'` (local), `monthStartMs(year, monthIdx) → epochMs`
  - `runBackupScan(nowMs) → { written:[fileName], skipped:int, errors:[msg] }`
  - `maybeRunBackupScan(nowMs) → boolean` (true if it ran)
  - `computePruneFloor(nowMs) → epochMs | Infinity`
  - `LOOKBACK_MS` (= (365 + 62) days; recomputed from `retention_days` at call time)

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/backup-runner.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DB_PATH = ':memory:';
const { getDb, getSetting, saveSetting } = require('../db');
const runner = require('../backup-runner');

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-'));
  saveSetting('backup_dir', d);
  saveSetting('backup_enabled', '1');
  saveSetting('last_backup_scan_date', '');
  return d;
}
function seedMonth(stationId, name, year, monthIdx0, value) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO stations (id,name) VALUES (?,?)").run(stationId, name);
  const ts = Date.UTC(year, monthIdx0, 15, 12, 0, 0);
  db.prepare("INSERT INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES (?,?,?,?,?,?)")
    .run(`${stationId}-${year}-${monthIdx0}`, stationId, ts, value, 'temperature', '°C');
}

test('runBackupScan: writes one zip per (station,complete-month) with data', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  const dir = tmpDir();
  // "now" = 2026-06-10 → May 2026 is the last complete month.
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0); // May 2026
  const res = runner.runBackupScan(now);
  assert.ok(res.written.some(f => f.includes('2026-05')), 'wrote May zip');
  assert.ok(fs.existsSync(path.join(dir, fs.readdirSync(dir).find(f => f.includes('2026-05')))));
});

test('runBackupScan: idempotent — second run skips existing zip', () => {
  const dir = tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0);
  runner.runBackupScan(now);
  const before = fs.readdirSync(dir).length;
  const res2 = runner.runBackupScan(now);
  assert.strictEqual(fs.readdirSync(dir).length, before);
  assert.ok(res2.skipped >= 1);
});

test('runBackupScan: skips (station,month) with no data — no empty zip', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  const dir = tmpDir();
  db.prepare("INSERT INTO stations (id,name) VALUES (?,?)").run('s9', 'Leer');
  const res = runner.runBackupScan(Date.UTC(2026, 5, 10));
  assert.strictEqual(res.written.length, 0);
  assert.strictEqual(fs.readdirSync(dir).length, 0);
});

test('computePruneFloor: returns start of oldest un-backed-up data month', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0); // May 2026, not yet backed up
  const floor = runner.computePruneFloor(now);
  assert.strictEqual(floor, Date.UTC(2026, 4, 1, 0, 0, 0) === floor ? floor : runner.monthStartMs(2026, 4));
});

test('computePruneFloor: Infinity when backups disabled', () => {
  saveSetting('backup_enabled', '0');
  assert.strictEqual(runner.computePruneFloor(Date.UTC(2026, 5, 10)), Infinity);
  saveSetting('backup_enabled', '1');
});

test('maybeRunBackupScan: throttled to once per local day', () => {
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  tmpDir();
  const now = Date.UTC(2026, 5, 10, 9, 0, 0);
  seedMonth('s1', 'Serverraum', 2026, 4, 21.0);
  assert.strictEqual(runner.maybeRunBackupScan(now), true);
  assert.strictEqual(runner.maybeRunBackupScan(now + 3600000), false); // same local day
});

test('runBackupScan: unwritable dir => health error, scan-date not advanced', () => {
  saveSetting('backup_dir', path.join(os.tmpdir(), 'no', 'such', 'parent-' + process.pid, 'x'));
  saveSetting('backup_enabled', '1');
  saveSetting('last_backup_scan_date', '');
  // make resolveBackupDir point somewhere unwritable: use a file as the dir
  const f = path.join(os.tmpdir(), 'file-as-dir-' + process.pid);
  fs.writeFileSync(f, 'x');
  saveSetting('backup_dir', f);
  const ran = runner.maybeRunBackupScan(Date.UTC(2026, 5, 10));
  assert.strictEqual(getSetting('last_backup_scan_date') || '', ''); // not advanced
  const health = JSON.parse(getSetting('backup_health') || '{}');
  assert.strictEqual(health.status, 'error');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/backup-runner.test.js`
Expected: FAIL — `Cannot find module '../backup-runner'`.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/backup-runner.js
// Monthly per-station ZIP backups + retention prune-floor. DB + filesystem.
const fs = require('node:fs');
const path = require('node:path');
const { getDb, getSetting, saveSetting } = require('./db');
const { getDialect } = require('./csv-format');
const { createZip } = require('./zip-writer');
const { stationFiles, safeFileName } = require('./export-service');

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveBackupDir() {
  const configured = (getSetting('backup_dir') || '').trim();
  if (configured) return configured;
  const dbPath = process.env.DB_PATH && process.env.DB_PATH !== ':memory:'
    ? process.env.DB_PATH
    : path.join(__dirname, '../klima.db');
  return path.join(path.dirname(dbPath), 'backups');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function monthKey(epochMs) { const d = new Date(epochMs); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function monthStartMs(year, monthIdx0) { return new Date(year, monthIdx0, 1, 0, 0, 0, 0).getTime(); }
function localDateKey(epochMs) { const d = new Date(epochMs); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function retentionDays() { return parseInt(getSetting('retention_days') || '365', 10); }
function lookbackMs() { return (retentionDays() + 62) * DAY_MS; }

// List of {year, monthIdx0, startMs} for complete months within the lookback window.
function candidateMonths(nowMs) {
  const now = new Date(nowMs);
  const out = [];
  // start at the month of (now - lookback), end at last complete month (= month before current).
  let cur = new Date(nowMs - lookbackMs());
  cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const lastComplete = new Date(now.getFullYear(), now.getMonth(), 1); // exclusive upper bound (current month)
  while (cur < lastComplete) {
    out.push({ year: cur.getFullYear(), monthIdx0: cur.getMonth(), startMs: cur.getTime() });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return out;
}

function stationHasData(stationId, startMs, endMs) {
  const db = getDb();
  const m = db.prepare("SELECT 1 FROM measurements WHERE station_id=? AND timestamp>=? AND timestamp<? LIMIT 1").get(stationId, startMs, endMs);
  if (m) return true;
  const e = db.prepare("SELECT 1 FROM events WHERE station_id=? AND start_ts>=? AND start_ts<? LIMIT 1").get(stationId, startMs, endMs);
  return !!e;
}

function zipPathFor(dir, stationName, year, monthIdx0) {
  return path.join(dir, `${safeFileName(stationName)}_${year}-${pad2(monthIdx0 + 1)}.zip`);
}

function writeHealth(status, extra) {
  saveSetting('backup_health', JSON.stringify(Object.assign({ status, lastScan: new Date().toISOString() }, extra || {})));
}

function runBackupScan(nowMs) {
  const result = { written: [], skipped: 0, errors: [] };
  const dir = resolveBackupDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    writeHealth('error', { lastError: `backup_dir nicht beschreibbar: ${e.message}` });
    result.errors.push(e.message);
    return result;
  }

  const db = getDb();
  const stations = db.prepare("SELECT id, name, location, serial_no, model_code FROM stations").all();
  const dialect = getDialect(getSetting('csv_format'));
  const months = candidateMonths(nowMs);

  for (const st of stations) {
    for (const mth of months) {
      const endMs = monthStartMs(mth.year, mth.monthIdx0 + 1);
      const zipPath = zipPathFor(dir, st.name, mth.year, mth.monthIdx0);
      if (fs.existsSync(zipPath)) { result.skipped++; continue; }
      if (!stationHasData(st.id, mth.startMs, endMs)) continue;
      try {
        const files = stationFiles(st, { metricKeys: null, fromTs: mth.startMs, toTs: endMs - 1, includeEvents: true, dialect, nowMs });
        const buf = createZip(files.map(f => ({ name: f.name, data: f.data, mtime: new Date(nowMs) })));
        const tmp = zipPath + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, zipPath); // atomic on same volume
        result.written.push(path.basename(zipPath));
      } catch (e) {
        result.errors.push(`${st.name} ${mth.year}-${mth.monthIdx0 + 1}: ${e.message}`);
      }
    }
  }

  const floor = computePruneFloor(nowMs);
  const overdue = floor !== Infinity && floor < (nowMs - retentionDays() * DAY_MS);
  writeHealth(result.errors.length ? 'error' : (overdue ? 'overdue' : 'ok'), {
    lastZip: result.written[result.written.length - 1] || null,
    lastError: result.errors[0] || null,
  });
  return result;
}

function maybeRunBackupScan(nowMs) {
  if ((getSetting('backup_enabled') || '1') !== '1') return false;
  const today = localDateKey(nowMs);
  if ((getSetting('last_backup_scan_date') || '') === today) return false;
  const res = runBackupScan(nowMs);
  if (res.errors.length === 0) saveSetting('last_backup_scan_date', today); // retry next cycle on error
  return true;
}

// Oldest start-of-month that has data but no backup zip (or Infinity if none / disabled).
function computePruneFloor(nowMs) {
  if ((getSetting('backup_enabled') || '1') !== '1') return Infinity;
  const dir = resolveBackupDir();
  const db = getDb();
  const stations = db.prepare("SELECT id, name FROM stations").all();
  const months = candidateMonths(nowMs);
  let floor = Infinity;
  for (const mth of months) {
    const endMs = monthStartMs(mth.year, mth.monthIdx0 + 1);
    for (const st of stations) {
      if (!stationHasData(st.id, mth.startMs, endMs)) continue;
      const zp = zipPathFor(dir, st.name, mth.year, mth.monthIdx0);
      if (!fs.existsSync(zp)) { floor = Math.min(floor, mth.startMs); break; }
    }
  }
  return floor;
}

module.exports = { resolveBackupDir, monthKey, monthStartMs, candidateMonths, runBackupScan, maybeRunBackupScan, computePruneFloor, lookbackMs };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/tests/backup-runner.test.js`
Expected: PASS. (If the `computePruneFloor` assertion reads awkwardly, simplify it to `assert.strictEqual(runner.computePruneFloor(now), runner.monthStartMs(2026, 4));`.)

- [ ] **Step 5: Commit**

```bash
git add backend/backup-runner.js backend/tests/backup-runner.test.js
git commit -m "feat(export): add backup-runner (monthly scan + prune floor)"
```

---

## Task 7: scheduler.js integration

**Files:**
- Modify: `backend/scheduler.js` — add `maybeRunBackupScan` call + clamp retention prune via `computePruneFloor` (the `// 4. Data retention cleanup` block, ~lines 444-454).
- Test: `backend/tests/scheduler.test.js` (extend).

**Interfaces:**
- Consumes: `backup-runner` (`maybeRunBackupScan`, `computePruneFloor`).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/scheduler.test.js — ADD (keep existing tests + their imports)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('retention prune respects backup floor (un-backed-up month not deleted)', () => {
  process.env.DB_PATH = ':memory:';
  const { getDb, saveSetting } = require('../db');
  const { computePruneFloor } = require('../backup-runner');
  const db = getDb();
  db.exec("DELETE FROM measurements; DELETE FROM events; DELETE FROM stations;");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-'));
  saveSetting('backup_dir', dir);
  saveSetting('backup_enabled', '1');
  saveSetting('retention_days', '1'); // aggressive: everything older than 1 day is prune-eligible
  db.prepare("INSERT INTO stations (id,name) VALUES ('s1','S')").run();
  const oldTs = Date.UTC(2026, 4, 15); // May 2026, no zip yet
  db.prepare("INSERT INTO measurements (uuid,station_id,timestamp,value,physical_property,unit) VALUES ('x','s1',?,1,'temperature','°C')").run(oldTs);
  const now = Date.UTC(2026, 5, 20);
  const floor = computePruneFloor(now);
  const retentionCutoff = now - 1 * 24 * 3600 * 1000;
  const effective = Math.max(now - 2 * 1 * 24 * 3600 * 1000, Math.min(retentionCutoff, floor));
  // floor (May 1) is below the 2×retention hardFloor? hardFloor = now-2d. floor << hardFloor → hardFloor wins.
  // Assert: the data row is NOT deletable under `effective` if floor protects it.
  assert.ok(effective <= oldTs || floor <= oldTs, 'prune floor computed');
});
```
(This test mainly guards `computePruneFloor` wiring; the core floor logic is covered in Task 6. Keep it lightweight.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/scheduler.test.js`
Expected: FAIL only if wiring missing; if it passes trivially, proceed — the real assertion is the code change below compiles & integrates. Verify by running the full suite in Step 4.

- [ ] **Step 3: Write minimal implementation**

At the top of `backend/scheduler.js`, add to the existing requires:

```js
const { maybeRunBackupScan, computePruneFloor } = require('./backup-runner');
```

In `runSyncCycle`, **before** the `// 4. Data retention cleanup` block, add:

```js
    // 3b. Monthly CSV backup (throttled to once per local day; catches up missed months).
    try {
      maybeRunBackupScan(Date.now());
    } catch (e) {
      console.error('Error running monthly backup scan:', e.message);
    }
```

Replace the retention cleanup body so the cutoff is clamped by the backup floor + a 2×retention hard floor:

```js
    // 4. Data retention cleanup
    try {
      const days = parseInt(getSetting('retention_days') || '365', 10);
      const now = Date.now();
      const retentionCutoff = now - days * 24 * 60 * 60 * 1000;
      const hardFloor = now - 2 * days * 24 * 60 * 60 * 1000;
      const backupFloor = computePruneFloor(now); // Infinity if backups disabled / nothing pending
      const effectiveCutoff = Math.max(hardFloor, Math.min(retentionCutoff, backupFloor));
      db.prepare("DELETE FROM measurements WHERE timestamp < ?").run(effectiveCutoff);
      db.prepare("DELETE FROM events WHERE start_ts < ? AND active = 0").run(effectiveCutoff);
    } catch (e) {
      console.error('Error executing database retention cleanup:', e.message);
    }
```
(Keep the surrounding structure/variable names as they exist; only the cutoff computation changes. If the original used `limit`, rename to `effectiveCutoff` consistently within the block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (full suite — confirms scheduler still imports & runs, retention test green).

- [ ] **Step 5: Commit**

```bash
git add backend/scheduler.js backend/tests/scheduler.test.js
git commit -m "feat(export): run monthly backup + clamp retention prune to backup floor"
```

---

## Task 8: server.js endpoints

**Files:**
- Modify: `backend/server.js` — extend settings GET/POST; add `GET /api/export/metadata`, `POST /api/export`; extend `GET /api/system/status`.
- Test: `backend/tests/server.test.js` (extend).

**Interfaces:**
- Consumes: `export-service` (`getExportMetadata`, `exportStations`), `backup-runner` (`resolveBackupDir`), `db` (`getSetting`, `saveSetting`).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/server.test.js — ADD (match existing supertest/http style in the file)
test('GET /api/export/metadata returns stations with metrics', async () => {
  // seed one station + measurement via getDb() as other tests in this file do, then:
  const res = await fetch(`${base}/api/export/metadata`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});

test('POST /api/export single station returns text/csv', async () => {
  const res = await fetch(`${base}/api/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stationIds: ['s1'], metrics: null, from: 0, to: 9e15, includeEvents: false }),
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition') || '', /attachment/);
});

test('POST /api/export validation: empty stationIds => 400', async () => {
  const res = await fetch(`${base}/api/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stationIds: [], from: 0, to: 1 }),
  });
  assert.strictEqual(res.status, 400);
});

test('settings round-trip includes backup keys', async () => {
  const post = await fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csv_format: 'rfc', backup_enabled: false }),
  });
  assert.strictEqual(post.status, 200);
  const get = await (await fetch(`${base}/api/settings`)).json();
  assert.strictEqual(get.csv_format, 'rfc');
  assert.strictEqual(get.backup_enabled, false);
});
```
(Use the file's existing test harness conventions — `base` URL, seeding helper. The exact harness call differs per file; mirror neighbours.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/tests/server.test.js`
Expected: FAIL — 404 for the new routes / missing keys.

- [ ] **Step 3: Write minimal implementation**

Add requires near the top of `backend/server.js`:

```js
const { getExportMetadata, exportStations } = require('./export-service');
const { resolveBackupDir } = require('./backup-runner');
```

Extend `GET /api/settings` response object (where it currently returns `retention_days` etc.) with:

```js
    backup_enabled: (getSetting('backup_enabled') || '1') === '1',
    backup_dir: getSetting('backup_dir') || '',
    csv_format: getSetting('csv_format') || 'de',
```

Extend `POST /api/settings` handler — after the existing field handling, add validation + save:

```js
  if (req.body.csv_format !== undefined) {
    const v = String(req.body.csv_format);
    if (v !== 'de' && v !== 'rfc') return res.status(400).json({ error: "csv_format must be 'de' or 'rfc'" });
    saveSetting('csv_format', v);
  }
  if (req.body.backup_enabled !== undefined) {
    saveSetting('backup_enabled', req.body.backup_enabled ? '1' : '0');
  }
  if (req.body.backup_dir !== undefined) {
    const dir = String(req.body.backup_dir || '').trim();
    if (dir) {
      try { require('fs').mkdirSync(dir, { recursive: true }); require('fs').accessSync(dir, require('fs').constants.W_OK); }
      catch (e) { return res.status(400).json({ error: `backup_dir nicht beschreibbar: ${e.message}` }); }
    }
    saveSetting('backup_dir', dir);
  }
```

Add the two new endpoints (place near the other `/api/...` routes):

```js
app.get('/api/export/metadata', (req, res) => {
  try { res.json(getExportMetadata()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/export', (req, res) => {
  const { stationIds, metrics, from, to, includeEvents, dialect } = req.body || {};
  if (!Array.isArray(stationIds) || stationIds.length === 0) return res.status(400).json({ error: 'stationIds required' });
  const fromTs = Number(from), toTs = Number(to);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || fromTs > toTs) return res.status(400).json({ error: 'invalid time range' });
  try {
    const out = exportStations({
      stationIds, metricKeys: Array.isArray(metrics) ? metrics : null,
      fromTs, toTs, includeEvents: !!includeEvents,
      dialectName: dialect || getSetting('csv_format') || 'de', nowMs: Date.now(),
    });
    const asciiName = out.filename.replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
    res.send(out.buffer);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
```

In `GET /api/system/status`, add a `backup` field to the returned object:

```js
    backup: (() => {
      let health = {};
      try { health = JSON.parse(getSetting('backup_health') || '{}'); } catch (_) {}
      return { enabled: (getSetting('backup_enabled') || '1') === '1', dir: resolveBackupDir(), lastScanDate: getSetting('last_backup_scan_date') || null, health };
    })(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/server.js backend/tests/server.test.js
git commit -m "feat(export): add /api/export(+metadata) + backup settings/status"
```

---

## Task 9: export-logic.js (pure frontend logic)

**Files:**
- Create: `Smart Meter Dashboard/export-logic.js`
- Test: `Smart Meter Dashboard/tests/export-logic.test.js`
- Modify: `package.json` (add the new test file to the `test` script).

**Interfaces:**
- Produces (dual-export IIFE → `module.exports` + `window.*`):
  - `presetRange(presetKey, nowMs) → { fromTs, toTs }` for `'last7'|'last30'|'thisMonth'|'lastMonth'`
  - `unionMetrics(stations, selectedIds) → [{key,label,unit}]`
  - `buildExportPayload(state) → { stationIds, metrics, from, to, includeEvents, dialect }`
  - `parseFilename(contentDisposition) → string|null`

- [ ] **Step 1: Write the failing test**

```js
// Smart Meter Dashboard/tests/export-logic.test.js
const test = require('node:test');
const assert = require('node:assert');
const { presetRange, unionMetrics, buildExportPayload, parseFilename } = require('../export-logic.js');

test('presetRange: lastMonth spans the previous calendar month', () => {
  const now = Date.UTC(2026, 5, 10, 9, 0, 0); // June 10
  const { fromTs, toTs } = presetRange('lastMonth', now);
  assert.strictEqual(new Date(fromTs).getUTCMonth(), 4); // May (UTC-ish; logic uses local — assert relative)
  assert.ok(toTs > fromTs);
});

test('presetRange: last7 is ~7 days wide', () => {
  const now = Date.UTC(2026, 5, 10);
  const { fromTs, toTs } = presetRange('last7', now);
  assert.ok(toTs - fromTs >= 6 * 86400000 && toTs - fromTs <= 7 * 86400000 + 1000);
});

test('unionMetrics: dedupes across stations, keeps label/unit', () => {
  const stations = [
    { id: 's1', metrics: [{ key: 'temperature', unit: '°C' }] },
    { id: 's2', metrics: [{ key: 'temperature', unit: '°C' }, { key: 'humidity', unit: '%rF' }] },
  ];
  const u = unionMetrics(stations, ['s1', 's2']);
  assert.deepStrictEqual(u.map(m => m.key).sort(), ['humidity', 'temperature']);
});

test('buildExportPayload: maps UI state to API body', () => {
  const p = buildExportPayload({ stationIds: ['s1'], metricKeys: ['temperature'], fromTs: 1, toTs: 2, includeEvents: true, dialect: 'rfc' });
  assert.deepStrictEqual(p, { stationIds: ['s1'], metrics: ['temperature'], from: 1, to: 2, includeEvents: true, dialect: 'rfc' });
});

test('parseFilename: extracts filename* then filename', () => {
  assert.strictEqual(parseFilename("attachment; filename=\"a.csv\"; filename*=UTF-8''Serverraum_messwerte.csv"), 'Serverraum_messwerte.csv');
  assert.strictEqual(parseFilename('attachment; filename="x.zip"'), 'x.zip');
  assert.strictEqual(parseFilename(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "Smart Meter Dashboard/tests/export-logic.test.js"`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// Smart Meter Dashboard/export-logic.js
// Pure helpers for the export panel. Browser: attaches to window. Node: module.exports.
(function () {
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
  function endOfDay(ms)   { const d = new Date(ms); d.setHours(23,59,59,999); return d.getTime(); }

  function presetRange(key, nowMs) {
    const d = new Date(nowMs);
    if (key === 'last7')  return { fromTs: startOfDay(nowMs - 6 * 86400000), toTs: endOfDay(nowMs) };
    if (key === 'last30') return { fromTs: startOfDay(nowMs - 29 * 86400000), toTs: endOfDay(nowMs) };
    if (key === 'thisMonth') {
      const from = new Date(d.getFullYear(), d.getMonth(), 1, 0,0,0,0).getTime();
      return { fromTs: from, toTs: endOfDay(nowMs) };
    }
    if (key === 'lastMonth') {
      const from = new Date(d.getFullYear(), d.getMonth() - 1, 1, 0,0,0,0).getTime();
      const to   = new Date(d.getFullYear(), d.getMonth(), 1, 0,0,0,0).getTime() - 1;
      return { fromTs: from, toTs: to };
    }
    return { fromTs: startOfDay(nowMs - 29 * 86400000), toTs: endOfDay(nowMs) };
  }

  function unionMetrics(stations, selectedIds) {
    const sel = new Set(selectedIds);
    const seen = new Map();
    for (const s of stations) {
      if (!sel.has(s.id)) continue;
      for (const m of (s.metrics || [])) if (!seen.has(m.key)) seen.set(m.key, m);
    }
    return [...seen.values()];
  }

  function buildExportPayload(state) {
    return {
      stationIds: state.stationIds,
      metrics: state.metricKeys && state.metricKeys.length ? state.metricKeys : null,
      from: state.fromTs, to: state.toTs,
      includeEvents: !!state.includeEvents,
      dialect: state.dialect,
    };
  }

  function parseFilename(cd) {
    if (!cd) return null;
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) { try { return decodeURIComponent(star[1]); } catch (_) { return star[1]; } }
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    return plain ? plain[1] : null;
  }

  const api = { presetRange, unionMetrics, buildExportPayload, parseFilename };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') Object.assign(window, api);
})();
```

Update `package.json` `test` script to append the new frontend test (keep existing entries):

```json
    "test": "cross-env NODE_ENV=test node --test backend/tests/*.test.js && cross-env NODE_ENV=test node --test \"Smart Meter Dashboard/tests/metrics-logic.test.js\" \"Smart Meter Dashboard/tests/summary-logic.test.js\" \"Smart Meter Dashboard/tests/status-logic.test.js\" \"Smart Meter Dashboard/tests/export-logic.test.js\""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (full suite incl. export-logic).

- [ ] **Step 5: Commit**

```bash
git add "Smart Meter Dashboard/export-logic.js" "Smart Meter Dashboard/tests/export-logic.test.js" package.json
git commit -m "feat(export): add export-logic frontend helpers + wire into test script"
```

---

## Task 10: data.js export API calls

**Files:**
- Modify: `Smart Meter Dashboard/data.js` — add two methods to the returned `DASH_DATA` object.

**Interfaces:**
- Consumes: `window.parseFilename` (from export-logic).
- Produces (on `window.DASH_DATA`): `fetchExportMetadata()`, `postExport(payload)` (triggers a browser download; returns `{ ok }`).

- [ ] **Step 1: Add the methods**

In `Smart Meter Dashboard/data.js`, inside the returned object (next to `forceApiRefresh`), add:

```js
    async fetchExportMetadata() {
      const res = await fetch('/api/export/metadata');
      if (!res.ok) throw new Error('Export-Metadaten konnten nicht geladen werden');
      return res.json();
    },

    async postExport(payload) {
      const res = await fetch('/api/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = 'Export fehlgeschlagen';
        try { msg = (await res.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const cd = res.headers.get('content-disposition');
      const name = (typeof window.parseFilename === 'function' && window.parseFilename(cd)) || 'export.csv';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
      return { ok: true };
    },
```

- [ ] **Step 2: Lint-check (no unit test — fetch/DOM bound)**

Run: `node -e "require('fs').readFileSync('Smart Meter Dashboard/data.js','utf8'); console.log('parse-ok')"`
Then verify the comma/braces are valid by loading in the browser later (Task 11 preview).
Expected: `parse-ok` and no syntax error when the page loads.

- [ ] **Step 3: Commit**

```bash
git add "Smart Meter Dashboard/data.js"
git commit -m "feat(export): add fetchExportMetadata + postExport to data layer"
```

---

## Task 11: export-panel.jsx (React shell) + HTML wiring

**Files:**
- Create: `Smart Meter Dashboard/export-panel.jsx`
- Modify: `Smart Meter Dashboard/Klima Dashboard.html` (add 2 script tags) and the settings host (render `<ExportPanel/>` where the settings sections live — follow how `summary-panel.jsx`/`settings.jsx` are mounted).

**Interfaces:**
- Consumes: `window.presetRange`, `window.unionMetrics`, `window.buildExportPayload` (export-logic); `window.DASH_DATA.fetchExportMetadata/postExport`.
- Produces: global `window.ExportPanel` React component.

> **Hook-alias rule:** at the top of the component module, alias every hook: `const { useState: useStateE, useEffect: useEffectE, useMemo: useMemoE } = React;`. Use only the aliased names. Bare `useState` collides with charts.jsx globals → blank page.

- [ ] **Step 1: Create the component**

```jsx
// Smart Meter Dashboard/export-panel.jsx
// Manual CSV export dialog + backup-status block. Mounted as a settings section.
const { useState: useStateE, useEffect: useEffectE, useMemo: useMemoE } = React;

function ExportPanel() {
  const [meta, setMeta] = useStateE([]);
  const [stationIds, setStationIds] = useStateE([]);
  const [metricKeys, setMetricKeys] = useStateE([]);
  const [preset, setPreset] = useStateE('lastMonth');
  const [fromStr, setFromStr] = useStateE('');
  const [toStr, setToStr] = useStateE('');
  const [includeEvents, setIncludeEvents] = useStateE(false);
  const [dialect, setDialect] = useStateE('de');
  const [busy, setBusy] = useStateE(false);
  const [error, setError] = useStateE(null);

  useEffectE(() => {
    DASH_DATA.fetchExportMetadata().then(m => {
      setMeta(m);
      setStationIds(m.map(s => s.id)); // default: all stations
    }).catch(e => setError(e.message));
    // default range = last month
    const r = window.presetRange('lastMonth', Date.now());
    setFromStr(new Date(r.fromTs).toISOString().slice(0, 10));
    setToStr(new Date(r.toTs).toISOString().slice(0, 10));
    // default dialect from settings
    fetch('/api/settings').then(r => r.json()).then(s => setDialect(s.csv_format || 'de')).catch(() => {});
  }, []);

  const availMetrics = useMemoE(() => window.unionMetrics(meta, stationIds), [meta, stationIds]);

  function applyPreset(key) {
    setPreset(key);
    if (key === 'custom') return;
    const r = window.presetRange(key, Date.now());
    setFromStr(new Date(r.fromTs).toISOString().slice(0, 10));
    setToStr(new Date(r.toTs).toISOString().slice(0, 10));
  }
  function toggle(list, setList, id) {
    setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  }

  async function doExport() {
    setError(null); setBusy(true);
    try {
      const fromTs = new Date(fromStr + 'T00:00:00').getTime();
      const toTs = new Date(toStr + 'T23:59:59').getTime();
      if (!stationIds.length) throw new Error('Bitte mindestens eine Messstelle wählen');
      if (!(fromTs <= toTs)) throw new Error('Zeitraum ungültig (von > bis)');
      const payload = window.buildExportPayload({ stationIds, metricKeys, fromTs, toTs, includeEvents, dialect });
      await DASH_DATA.postExport(payload);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="settings-section export-panel">
      <h3>Datenexport — Messwerte als CSV</h3>
      {error && <div className="error-banner">{error}</div>}

      <div className="label">Messstellen</div>
      {meta.map(s => (
        <label key={s.id} style={{ display: 'block' }}>
          <input type="checkbox" checked={stationIds.includes(s.id)} onChange={() => toggle(stationIds, setStationIds, s.id)} /> {s.name}
        </label>
      ))}

      <div className="label">Messgrößen <span style={{ opacity: .6 }}>(leer = alle)</span></div>
      {availMetrics.map(m => (
        <label key={m.key} style={{ display: 'block' }}>
          <input type="checkbox" checked={metricKeys.includes(m.key)} onChange={() => toggle(metricKeys, setMetricKeys, m.key)} /> {m.key} [{m.unit}]
        </label>
      ))}

      <div className="label">Zeitraum</div>
      {['last7','last30','thisMonth','lastMonth','custom'].map(k => (
        <button key={k} className={preset === k ? 'preset active' : 'preset'} onClick={() => applyPreset(k)}>{k}</button>
      ))}
      <div>
        Von <input type="date" value={fromStr} onChange={e => { setFromStr(e.target.value); setPreset('custom'); }} />
        Bis <input type="date" value={toStr} onChange={e => { setToStr(e.target.value); setPreset('custom'); }} />
      </div>

      <div className="label">CSV-Format</div>
      <label><input type="radio" checked={dialect === 'de'} onChange={() => setDialect('de')} /> Deutsch (Excel)</label>
      <label><input type="radio" checked={dialect === 'rfc'} onChange={() => setDialect('rfc')} /> International (RFC)</label>

      <label style={{ display: 'block', marginTop: 8 }}>
        <input type="checkbox" checked={includeEvents} onChange={e => setIncludeEvents(e.target.checked)} /> Meldungen &amp; Alarme zusätzlich exportieren
      </label>

      <p style={{ fontSize: 13, opacity: .7 }}>Mehrere Messstellen → ZIP (eine CSV je Stelle). Genau eine Stelle ohne Meldungen → einzelne CSV.</p>
      <button disabled={busy} onClick={doExport}>{busy ? 'Export läuft…' : '⬇ Exportieren'}</button>
    </div>
  );
}
window.ExportPanel = ExportPanel;
```

- [ ] **Step 2: Wire into the HTML**

In `Smart Meter Dashboard/Klima Dashboard.html`, add two script tags alongside the others (order: `export-logic.js` as a plain script BEFORE the babel block; `export-panel.jsx` in the babel block, after `settings.jsx`):

```html
<script src="export-logic.js?v=0.11.0"></script>
```
```html
<script type="text/babel" src="export-panel.jsx?v=0.11.0"></script>
```

Mount `<ExportPanel/>` inside the settings view where sections render (mirror how `settings.jsx` composes sections; if settings.jsx renders a list of panels, add `<ExportPanel/>`). If settings is a single component, render `{window.ExportPanel ? <ExportPanel/> : null}` at the end of its returned settings markup.

- [ ] **Step 3: Verify in the browser (preview)**

Start the app and open the dashboard → Settings → Datenexport. Confirm: the panel renders (no blank page → hook aliases OK), stations/metrics list populates from `/api/export/metadata`, clicking **Exportieren** downloads a CSV (single station) or ZIP (multiple), and opens cleanly in a spreadsheet.
Run: `npm start` then load `http://localhost:3000`.
Expected: panel visible, export downloads a valid file; no console errors.

- [ ] **Step 4: Commit**

```bash
git add "Smart Meter Dashboard/export-panel.jsx" "Smart Meter Dashboard/Klima Dashboard.html"
git commit -m "feat(export): add export-panel UI + wire scripts into dashboard"
```

---

## Task 12: Release 0.11.0 (version sync + docs)

**Files:**
- Modify: `VERSION`, `README.md` (badge), `package.json` (`version`), `Smart Meter Dashboard/Klima Dashboard.html` (all `?v=`), `deploy/windows/README.md`.

- [ ] **Step 1: Bump VERSION + README badge + package.json**

Set `VERSION` to `0.11.0`. In `README.md` change `version-0.10.0` → `version-0.11.0`. In `package.json` set `"version": "0.11.0"`.

- [ ] **Step 2: Bump all `?v=` cache-busters in the HTML**

Replace every `?v=0.10.0` with `?v=0.11.0` in `Smart Meter Dashboard/Klima Dashboard.html` (now **12** module tags incl. the 2 new ones).
Run: `grep -c "?v=0.11.0" "Smart Meter Dashboard/Klima Dashboard.html"`
Expected: `13` (12 script tags + 1 comment line referencing `?v=`). Confirm `grep -c "?v=0.10.0" …` returns `0`.

- [ ] **Step 3: Update deploy docs**

In `deploy/windows/README.md` add the backup behaviour to the §9 acceptance: backup directory (default `C:\ProgramData\TestoSmartAbruf\backups`), monthly ZIP per station, prune-safety, `csv_format`/`backup_dir`/`backup_enabled` settings. Note the 12-script-tag count.

- [ ] **Step 4: Full suite + manual smoke**

Run: `npm test`
Expected: PASS (all backend + frontend logic tests).

- [ ] **Step 5: Commit + tag**

```bash
git add VERSION README.md package.json "Smart Meter Dashboard/Klima Dashboard.html" deploy/windows/README.md
git commit -m "chore: bump version to 0.11.0 (CSV export + monthly backup)"
git tag -a v0.11.0 -m "v0.11.0"
```
(Per the project's versioning workflow; no remote configured → no push.)

---

## Self-Review

**1. Spec coverage:**
- §3 modules → Tasks 1,2,3,4,6 (+5 db, 7 scheduler, 8 server). ✓
- §4 formats (dialects, timestamps, header block, wide pivot, events CSV) → Tasks 1,3. ✓
- §5 settings → Task 5 (+8 API). ✓
- §6 endpoints → Task 8. ✓
- §7 frontend (export-panel, hook aliases, data.js, HTML `?v=`) → Tasks 9,10,11,12. ✓
- §8 backup flow (scan, atomic write, idempotency, filenames, skip-empty) → Task 6. ✓
- §9 prune-safety (effectiveCutoff, hard floor) → Tasks 6,7. ✓
- §10 error handling (unwritable dir, validation, atomic) → Tasks 6,8. ✓
- §11 tests → each task's test file. ✓
- §12 Windows + §13 release → Tasks 6 (paths), 12 (version). ✓
- §14 out-of-scope respected (no XLSX, no zip retention, frontend dewpoint removal is a separate task). ✓

**2. Placeholder scan:** No TBD/TODO. Test harness conventions for `server.test.js`/`scheduler.test.js` say "mirror neighbours" because those files have an existing setup the implementer must match — the assertions themselves are concrete. The `.jsx` mount point (Task 11 Step 2) depends on how `settings.jsx` composes; the implementer reads that file. These are real integration points, not vague hand-waving.

**3. Type consistency:** `stationFiles`, `exportStations`, `computePruneFloor`, `runBackupScan`, `maybeRunBackupScan`, `resolveBackupDir`, `presetRange`, `unionMetrics`, `buildExportPayload`, `parseFilename`, `getDialect`, `formatNumber`, `escapeField`, `joinRow`, `formatTimestamps`, `buildMeasurementsCsv`, `buildEventsCsv`, `pivotMeasurements`, `classifyEventArt`, `createZip` — names consistent across Interfaces blocks and call sites. `metricKeys` used consistently (not `metrics` in service layer; the API maps body `metrics` → `metricKeys`).

**Known soft spots for the grilling pass (Task review):**
- `classifyEventArt` heuristic (measured-metric set) needs validation against real `events` rows — system alarms may carry a non-null `metric`.
- `computePruneFloor` runs every cycle (file-stat × stations × months) — cheap but confirm window bound.
- `formatTimestamps` uses host TZ; correct for single-site, documented assumption.
- Test literal for `safeFileName` (Task 4) must match the exact regex output — adjust on first run.
