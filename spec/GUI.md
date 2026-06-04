# GUI Specification

The UI is a single-page React app, no router library. One HTML shell (`Klima Dashboard.html`) holds **all CSS** (one `<style>` block of design tokens + component classes) and loads the JSX. `app.jsx` renders `<App/>` into `#root` and toggles between two top-level views: **dashboard** and **settings** (`view` state). All styling is class-based against the CSS in the HTML shell; reproduce the class names exactly (component logic depends on them, e.g. the `.tile-ghost` vs `.btn.ghost` distinction).

> Reconstruction-critical literals (colors, radii, spacing, typography, layout grid math, SVG icon paths) are reproduced verbatim where they affect the rebuild. The full CSS is in the source file `Klima Dashboard.html` — this document reproduces the token system and the structurally important rules; for pixel-exact replication, port the `<style>` block verbatim.

---

## 1. Design tokens (`:root`) — reproduce verbatim

```css
:root {
  --bg: #F1F4F1;  --bg-2: #E9EDE9;
  --surface: #FFFFFF;  --surface-2: #F8FAF8;
  --border: #E1E6E2;  --border-strong: #C9D1CA;
  --text: #16201B;  --text-muted: #5B6862;  --text-faint: #95A099;

  --accent: #49A288;  --accent-dark: #2F7A65;
  --accent-soft: #DDEEE7;  --accent-tint: #ECF6F1;

  --alarm: oklch(0.58 0.17 25);   --alarm-soft: oklch(0.94 0.04 25);   --alarm-tint: oklch(0.97 0.02 25);
  --warn:  oklch(0.74 0.13 75);   --warn-soft:  oklch(0.95 0.05 80);   --warn-tint:  oklch(0.97 0.025 80);
  --sys:   oklch(0.55 0.02 200);  --sys-soft:   oklch(0.93 0.01 200);  --sys-tint:   oklch(0.97 0.005 200);

  --shadow-sm: 0 1px 2px rgba(22,32,27,0.04), 0 0 0 1px rgba(22,32,27,0.04);
  --shadow-md: 0 8px 24px -10px rgba(22,60,45,0.22), 0 2px 6px rgba(22,32,27,0.06);
  --shadow-lg: 0 24px 60px -20px rgba(22,60,45,0.28), 0 6px 16px rgba(22,32,27,0.08);

  --radius: 10px;  --radius-sm: 6px;  --radius-lg: 14px;

  --font: "Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
```

Body: `font-family: var(--font)`, `background: var(--bg)`, `color: var(--text)`, `font-size: 14px`, `line-height: 1.4`, antialiased. `* { box-sizing: border-box }`. Palette is a teal system derived from `#49A288`; severity colors are OKLCH and intentionally low-chroma. Numeric/mono values throughout use `var(--mono)` with `font-variant-numeric: tabular-nums`.

Fonts loaded from Google Fonts: **Geist** (400/500/600/700) and **Geist Mono** (400/500/600).

`html lang="de"`. Entire UI is **German**.

---

## 2. Navigation / routing graph

No URL routing. State machine in `<App>`:

```
view = "dashboard"  ──(header "Einstellungen" button)──▶  view = "settings"
view = "settings"   ──(header back-arrow / SettingsPage onClose)──▶  view = "dashboard"
```

`app` root div classes: `app`, `edit-mode` (when `editMode`), `in-settings` (when `view==='settings'`). Within dashboard there are modal overlays (add tile, edit tile, threshold), and an (instantiated but, in the shipped header, not mounted) station selector popover. The Settings page has its own sub-section nav (sidebar).

---

## 3. Component tree

```
App (app.jsx)
├─ Header
│   ├─ brand (logo SVG | back-arrow when in settings) + brand-title/sub
│   ├─ top-summary (SummaryDot ×3) [dashboard only]
│   └─ top-actions: tile-count, "Kachel hinzufügen", "Zurücksetzen" (ghost),
│                   "Layout bearbeiten/sperren", "Einstellungen" [dashboard only]
├─ view==="dashboard":
│   └─ grid-shell ▸ grid (ref)
│       ├─ grid-bg (COLS grid-col stripes) [edit mode]
│       ├─ tile-ghost (drag/resize placeholder)
│       └─ tile-pos ▸ TileFrame(tile) ▸ <Body> per tile.type   (tiles.jsx)
│            Body ∈ { KpiBody, ChartBody, GaugeBody, StatsBody, AlertsBody }
├─ view==="settings":
│   └─ SettingsPage (settings.jsx)
│       ├─ settings-side: nav (6 items) + save-pill
│       └─ settings-main ▸ <Section>  ∈ { Overview, Api, Database, Stations, Notifications, Advanced }
├─ AddTileDialog (Modal, 4 steps)        [when addOpen]
├─ EditTileDialog (Modal)                [when editing]
└─ ThresholdDialog (Modal)               [when thresholdOpen]

Also defined: StationSelector, BatteryIcon, SignalIcon, TilePreview, SummaryDot (app.jsx);
Sparkline, LineChart, Gauge (charts.jsx); AlertTimeline, EventRow, SummaryPill (tiles.jsx).
```

> **Note (faithful-rebuild detail):** `StationSelector` is fully implemented in `app.jsx` but is **not rendered** by `Header` in the current code (the header has no station-switch control mounted). Active-station switching still happens programmatically via tile config and `DASH_DATA.setActiveStation`. Reproduce `StationSelector` (it is referenced/used pattern-wise) but match the header's actual contents (no station dropdown in the bar).

---

## 4. Dashboard

### 4.1 Top bar (`.topbar`)
Sticky, `z-index:50`, `background: var(--surface)`, bottom border, `padding:14px 28px`, flex space-between, wraps. Left: brand (38×38 `.brand-mark` tile with a clock SVG in `--accent`, or a back-arrow `.back-btn` in settings) + title ("Klima · Dashboard" / "Einstellungen") + mono sub-line (`<N> Messstellen · <M> Meldung(en) aktiv`). Center (dashboard only): `.top-summary` pill with three `SummaryDot`s (alarm/warning/system counts) + label "über alle Messstellen". Right (`.top-actions`, dashboard only):
- `.tile-count` pill: `<N> Kacheln`
- `.btn` "Kachel hinzufügen" (+ icon) — `disabled` unless `editMode`
- `.btn.ghost` "Zurücksetzen" → `resetLayout()` (confirm dialog "Layout auf Standard zurücksetzen?")
- `.btn` (primary when editing) "Layout bearbeiten" / "Layout sperren" → toggles `editMode`
- `.btn` "Einstellungen" (gear icon) → `view="settings"`

`SummaryDot`: `.top-sum-dot.sev-<severity>` + `.has` when count>0; background goes alarm/warn/sys color when has.

### 4.2 Grid engine (`app.jsx` + tiles.jsx)
Constants (tiles.jsx): `COLS = 12`, `ROW_H = 72`, `GAP = 14`. Cell width `cellW = (gridW − GAP·(COLS−1)) / COLS` where `gridW` tracked by `ResizeObserver` on `.grid`. Tile pixel position:
```
left   = x·(cellW+GAP)
top    = y·(ROW_H+GAP)
width  = w·cellW + (w−1)·GAP
height = h·ROW_H + (h−1)·GAP
```
Grid container height = `max(totalRows, 12)·(ROW_H+GAP)+40`. `.tile-pos` is absolutely positioned with eased transitions on left/top/width/height (`cubic-bezier(.3,.7,.3,1) .18s`).

**Layout persistence:** `localStorage['dash-layout-v3']` (key `STORAGE_KEY="dash-layout-v3"`). `loadLayout()` falls back to `DEFAULT_LAYOUT`. Saved on every `layout` change.

**`DEFAULT_LAYOUT`** (reproduce verbatim — 12 tiles across stations living/bedroom/outdoor/basement): 4 KPI temperature tiles (3×3) on row 0; two charts on row 3 (`living` Temp+Taupunkt 6×4, `outdoor` Temp+Feuchte 6×4); three humidity gauges row 7 (3×4); one outdoor stats tile (3×4); two alerts tiles row 11 (6×5). Exact array:
```js
const DEFAULT_LAYOUT = [
  { id:"t-l-temp", type:"kpi", stationId:"living",   title:"Temperatur", metrics:["temperature"], x:0,y:0,w:3,h:3 },
  { id:"t-b-temp", type:"kpi", stationId:"bedroom",  title:"Temperatur", metrics:["temperature"], x:3,y:0,w:3,h:3 },
  { id:"t-o-temp", type:"kpi", stationId:"outdoor",  title:"Temperatur", metrics:["temperature"], x:6,y:0,w:3,h:3 },
  { id:"t-c-temp", type:"kpi", stationId:"basement", title:"Temperatur", metrics:["temperature"], x:9,y:0,w:3,h:3 },
  { id:"t-chart-temp", type:"chart", stationId:"living",  title:"Wohnzimmer · Temperatur & Taupunkt", metrics:["temperature","dewpoint"], x:0,y:3,w:6,h:4 },
  { id:"t-chart-out",  type:"chart", stationId:"outdoor", title:"Garten · Temperatur & Feuchte",      metrics:["temperature","humidity"], x:6,y:3,w:6,h:4 },
  { id:"t-l-hum", type:"gauge", stationId:"living",   title:"Rel. Feuchte", metrics:["humidity"], x:0,y:7,w:3,h:4 },
  { id:"t-b-hum", type:"gauge", stationId:"bedroom",  title:"Rel. Feuchte", metrics:["humidity"], x:3,y:7,w:3,h:4 },
  { id:"t-c-hum", type:"gauge", stationId:"basement", title:"Rel. Feuchte", metrics:["humidity"], x:6,y:7,w:3,h:4 },
  { id:"t-o-stats", type:"stats", stationId:"outdoor", title:"Außen — Tageswerte", metrics:["temperature","humidity","pressure","abshumid"], x:9,y:7,w:3,h:4 },
  { id:"t-alerts-out", type:"alerts", stationId:"outdoor", title:"Außensensor",  metrics:["temperature","humidity","pressure","dewpoint","abshumid"], x:0,y:11,w:6,h:5 },
  { id:"t-alerts-bed", type:"alerts", stationId:"bedroom", title:"Schlafzimmer", metrics:["temperature","humidity","pressure","dewpoint","abshumid"], x:6,y:11,w:6,h:5 },
];
```
> `editMode` initial state is `true` (the dashboard opens in edit mode).

**Drag** (edit mode only, left button): on `.tile-head` mousedown, capture offset; on mousemove convert pointer to grid cell `x=round(px/(cellW+GAP))`, `y=round(py/(ROW_H+GAP))`, clamp `x` to `COLS−w`; render `.tile-ghost` at target; on mouseup `compactLayout(layout, id, ghost)`.

**Resize** (edit mode only): `.tile-resize` handle (bottom-right). Delta cells `dw=round(dx/(cellW+GAP))`, `dh=round(dy/(ROW_H+GAP))`; clamp to type `minSize` and `COLS−x`; commit via `compactLayout`.

**`compactLayout(layout, movedId, target)`:** places moved tile, then iteratively pushes overlapping tiles downward (`rectsOverlap` = AABB test) until stable (safety cap 200 iterations). `findFreeSlot(layout,w,h)` scans rows 0..59, cols 0..COLS−w for first non-overlapping slot.

### 4.3 Tile chrome (`TileFrame`)
`.tile` (surface, border, `--radius`, `--shadow-sm`; hover `--shadow-md`; dragging/resizing `--shadow-lg` + accent border). Header `.tile-head`: grip (visible only in edit mode), `.tile-name` (uppercase, muted), optional `.tile-station` badge (dot on/off + name + 4-char code). In edit mode: `.tile-actions` (appear on hover) with pencil (edit metrics → `setEditing`) and × (remove → `removeTile`); `.tile-resize` handle. Body `.tile-body` renders the per-type body.

### 4.4 Tile type registry (`TILE_TYPES`) — reproduce verbatim
```js
kpi:    { label:"Kennzahl",        defaultSize:{w:3,h:3}, minSize:{w:2,h:2}, maxMetrics:1 }
chart:  { label:"Linien-Diagramm", defaultSize:{w:6,h:4}, minSize:{w:3,h:3}, maxMetrics:4 }
gauge:  { label:"Tachometer",      defaultSize:{w:3,h:4}, minSize:{w:3,h:3}, maxMetrics:1 }
stats:  { label:"Statistik",       defaultSize:{w:4,h:3}, minSize:{w:3,h:2}, maxMetrics:4 }
alerts: { label:"Meldungen & Grenzwerte", defaultSize:{w:8,h:5}, minSize:{w:4,h:3}, maxMetrics:5, hasSettings:true }
```
Descriptions (German) shown in the add-tile picker: kpi "Großer Live-Wert mit Sparkline & Trend."; chart "1–4 Messwerte über 24 h, frei kombinierbar."; gauge "Halbkreis-Anzeige des aktuellen Wertes."; stats "Min, Max, Mittelwert & Spannweite."; alerts "Alarm-/Warnverletzungen plus Systemmeldungen — mit Timeline.".

### 4.5 Tile bodies (state→view)
- **KpiBody**: `stats(M.series)` → big `.num` = last value (`toFixed(decimals)` or "—"), `.unit`; trend row (▲/▼ Δ + percent); `.kpi-range` "24 h"; `<Sparkline series color height=44>`. Dot colored `M.color`.
- **ChartBody**: legend (per metric: colored dot, label, last value+unit) + `<LineChart metricIds stationId timestamps>` in `.chart-area`.
- **GaugeBody**: `.gauge-label` (metric label) + `<Gauge metricId stationId size>` (sized via `useSize`).
- **StatsBody**: 5-col grid header `Messgröße | Aktuell | Min | Max | Ø`; one row per metric (colored dot + short name; current bold; min/max/avg). Formatter "—" for NaN.
- **AlertsBody**: see §6.
- Missing metrics → `Empty` ("Keine Messwerte zugewiesen. Stiftsymbol oben rechts anklicken."). Deleted station → `EmptyDeleted` ("Messstelle gelöscht. Kachel bitte entfernen.").

`tileStation(tile)` resolves `tile.stationId` (falls back to active station for legacy tiles).

---

## 5. Charts (`charts.jsx`) — SVG, container-sized via `useSize` (ResizeObserver)

### Sparkline `{series, color, height=36}`
Auto-scales to series min/max (pad 4). Renders an area path (`fillOpacity 0.14`) + line (`strokeWidth 1.5`, round joins). Gaps (`NaN`/null) break the path.

### LineChart `{metricIds, stationId, timestamps, showGrid=true, showAxes=true}`
- Paddings: `padL = showAxes?38:8`, `padR = (showAxes && metrics≥2)?42:12`, `padT=12`, `padB=showAxes?22:8`.
- Each metric auto-fit to its own min/max with 12% margin; up to 2 Y-axes (left = metric 0 colored by its color, right = metric 1). Single metric also gets a filled area (`fillOpacity 0.10`).
- Grid: 5 horizontal lines (0/.25/.5/.75/1) + vertical lines at X ticks. X ticks every 4h (or 2h if span < 18h), labels `de-DE` `HH:MM`.
- Hover: mousemove → nearest index → crosshair line + dots (`r 3.5`, white stroke) + `.tooltip` (time + per-metric swatch/short/value). Line width 1.8 (single) / 1.6 (multi).

### Gauge `{metricId, stationId, size}`
Semicircle arc 180°→360°. `cx=W/2`, `cy=H·0.78`, `r=min(W·0.42,H·0.62)`, stroke `max(8, r·0.14)`. Track in `--border`, value arc in `M.color`. 9 ticks (major at ends + middle). Center text: value (`.g-value` 28px mono) + unit + domain bounds `lo`/`hi`.

---

## 6. Alerts body, timeline, event rows (`tiles.jsx`)

`AlertsBody {tile, onOpenSettings}`: responsive flags from `useSize` (`compact <240h`, `veryCompact <180h`, `narrow <380w`). Filters events by `tile.metrics` allow-set (system events always shown). Summary row: 3 `SummaryPill` (Alarm/Warnung/System, active counts, click toggles filter), an "Aktiv" mini-chip filter (pulse dot), and a "Schwellen" gear mini-chip → `onOpenSettings` (opens `ThresholdDialog` for the tile's station). Timeline (unless veryCompact). Event list (`.alerts-list`, scrollable). Empty filter → checkmark + "Keine Meldungen in dieser Auswahl.".

`AlertTimeline {events}`: 24h span, ticks every 6h (`−24h … jetzt`). Each event drawn as `.tl-mark.sev-<sev>` (`.active` ring) positioned by start/end fraction (min width 0.6%). Title tooltip from `eventTitle(e)`.

`EventRow {event, compact, station}`: two layouts — **system** (sev-system; icon by `e.system` ∈ battery/connection/maintenance; "System" tag + message + detail) and **alarm/warning** (colored bar = metric color; triangle icon for alarm, circle-i for warning; headline `<label> <arrow> über/unter <threshold><unit>`; sub "Spitze … · Schwelle …" unless compact). Right meta: `formatRelative(startTs)` + duration ("läuft" if active). Active rows get a pulse dot + accent border.

`SummaryPill {severity,count,label,active,onClick}`: `.sum-pill.sev-<severity>` + `.has` (count>0) + `.sel` (active). Count badge colors by severity when has; pulse dot for non-system when count>0.

---

## 7. Dialogs (`app.jsx`)

All wrapped in `Modal {children,onClose,title}`: full-screen `.modal-bg` (rgba overlay, blur), centered `.modal` (`width: min(720px,100%)`, `max-height: 86vh`), head with title + × close. Click backdrop or Escape closes. Inner click stops propagation.

### AddTileDialog (4 steps, `.steps` breadcrumb)
1. **Typ**: `.type-grid` of `TILE_TYPES` cards (each with `TilePreview` mini SVG + label + desc) → `pickType` advances to step 2.
2. **Messstelle**: `.station-grid` of station cards (dot, name+code, location + online/battery) → `pickStation` advances to step 3.
3. **Messwerte**: `.metric-grid` of the 5 metrics (dot, label, unit, last value). `toggleMetric` respects `cfg.maxMetrics` (single-select replaces). "Weiter" disabled until ≥1 metric; sets suggested title.
4. **Bezeichnung**: title input (placeholder = `suggestTitle()`) + live preview tile (renders the actual body). "Hinzufügen" → `onAdd(type, stationId, metrics, title)`.
`suggestTitle()`: `"<station> · <type label>"` (no metrics) / `"<station> · Meldungen"` (alerts) / `"<station> · <metric shorts joined by ·>"`.

### EditTileDialog
Title input + station picker (`.station-grid.compact`) + metric grid (same toggle rules). "Speichern" → `onSave({stationId, metrics, title})` (disabled if no metrics). Changing station re-points the tile's data source.

### ThresholdDialog `{stationId}`
Per-station threshold editor. Hint emphasizes scoping to that station. `.thr-table`: header `Messgröße | Warnung (von–bis) | Alarm (von–bis)`; one `.thr-row` per metric with 4 number inputs (`step` = "0.1" if metric has decimals else "1"). `setBound` mutates `station.thresholds[mid][level][idx]`, then `recomputeStationEvents(station.id)` (fallback: temporary active-station swap + `setThreshold`). "Fertig" closes. Threshold edits persist via `data.js` `setThreshold`→localStorage.

---

## 8. Settings page (`settings.jsx`)

`.settings-shell` = grid `232px 1fr`. Left `.settings-side` (sticky, `top:71px`): "Einstellungen" header, 6 nav items, and a "Gespeichert" save-pill that flashes on change. Right `.settings-main` scrollable, `.settings-content max-width:900px`.

**Sections** (`SETTINGS_SECTIONS`, with NavIcon ids): `overview`(grid) "Übersicht", `api`(plug) "API & Verbindung", `database`(db) "Datenbank", `stations`(node) "Messstellen", `notifications`(bell) "Benachrichtigungen", `advanced`(sliders) "Erweitert".

**State & persistence:** `settings` loaded by `loadSettings()` (localStorage `dash-settings-v1` merged over `DEFAULT_SETTINGS`). On mount, `GET /api/settings` overlays `api.apiKey/apiRegion/pollIntervalSec` and `database.retentionDays`; and `GET /api/system/status` polled every 10 s. On every `settings` change: write localStorage + flash "Gespeichert" (1.2 s) + debounced (1 s) `POST /api/settings` (sends apiKey, apiRegion, pollIntervalSec, retentionDays) then refresh status. Subscribes to `DASH_DATA` for live station list.

### `DEFAULT_SETTINGS` — reproduce verbatim
```js
const DEFAULT_SETTINGS = {
  api: { endpoint:"https://api.klima.example/v3", apiKey:"kli_live_8a3f7c2d9e4b1a6f5c8d2e3b9a4f7c8d", pollIntervalSec:10, timeoutSec:5, retries:3 },
  database: { retentionDays:365, backupEnabled:true, backupTime:"03:00", autoOptimize:true },
  notifications: { pushEnabled:true, emailRecipients:["betrieb@haus.example","service@haus.example"],
                   routing:{ alarm:"instant", warning:"5min", system:"15min" },
                   quietHoursEnabled:true, quietFrom:"22:00", quietTo:"06:00" },
  general: { language:"de", timeFormat:"24h", autoRefreshSec:30, defaultStation:"living" },
  calibration: { living:{temperature:0.0,humidity:0}, bedroom:{temperature:0.0,humidity:0},
                 outdoor:{temperature:0.0,humidity:0}, basement:{temperature:0.0,humidity:0} },
};
```
> The default `apiKey` (`kli_live_…`) and `endpoint` are placeholder/mock literals; the real key comes from `GET /api/settings`. Reproduce verbatim (they are the seeded defaults before the backend overlay arrives).

### 8.1 OverviewSection
Spinner "Lade Systemdiagnose..." until `systemStatus` loaded. Then `.health-grid` of 6 `HealthCard`s: Testo API, Lokale Datenbank, Hintergrund-Scheduler, Messstellen (online/total), Speicherbelegung (Drive, with progress bar), Letzter Sync & Aufbewahrung. Each card status drives icon/badge color (`st-ok`/`st-warn`/`st-err` → OK/Achtung/Fehler). Then "Aktive Vorgänge" `.ops-list`: sync op (running spinner / idle with next-interval detail) + retention op. All text German; values pulled from `/api/system/status` (region uppercased, relative times, `formatBytes`, `toLocaleString("de-DE")`).

### 8.2 ApiSection
- Live-status card: `StatusPill` (ok/warn/err from system status or test result) + last-sync relative time/error + "Verbindung testen" button → `GET /api/testo/measuring-objects`; success "N Messobjekt(e) erfolgreich geladen", failure shows error.
- API-Schlüssel field: password/text input (show/hide toggle "Anzeigen"/"Verbergen").
- API-Region: `SegmentedControl` options `Europa (EU)` / `Amerika (US)` (values `eu`/`us`).
- Field-row of 3 range sliders: Abfrage-Intervall (60–3600 step 60, label shows `/60` min), Timeout (2–30 s), Wiederholungen (0–10). Only interval is actually persisted to backend.

### 8.3 DatabaseSection
- Status card (`StatusPill`, engine title, last-write relative) + `.kv-grid`: Größe (`formatBytes`), Datensätze, Ältester Eintrag, Engine.
- Aufbewahrungszeit `SegmentedControl` values `30/90/180/365/730` (labels "30 Tage"…"2 Jahre").
- Field-row: Automatisches Backup `Toggle`, Backup-Uhrzeit `time` input (disabled if backup off), Index-Optimierung `Toggle` (Wöchentlich/Manuell).
- Wartung card: "Backup jetzt erstellen" (fake 1.8 s spinner), "Datenbank optimieren" (fake 2.4 s spinner), "Daten exportieren (CSV)" — **all three are no-op simulations** (setTimeout only). Reproduce as such.

### 8.4 StationsSection (Zuweisungs-Manager) — the functional core
List view: header + "Messstelle hinzufügen" button → form. `.settings-table` (`Card noPad`) columns: **Messstelle / Details** (dot, name, location + mono id + calibration note if nonzero), **Status** (`StatusBadge` Online/Offline), **Verbindung** (🔋 battery% / 📶 signal%), **API-Zuweisung** (Messobjekt + Sensor truncated uuids, or italic "Nur lokale Simulation"), **Aktionen** (`.btn.ghost` "Bearbeiten" pencil → `startEdit`; `.btn.ghost` red × "Löschen" → `deleteStation`).

> **CSS gotcha (must preserve):** action buttons use `.btn.ghost`. The drag/resize placeholder uses `.tile-ghost` (NOT bare `.ghost`) precisely so `.ghost`'s `position:absolute; pointer-events:none` cannot leak onto these buttons and make them unclickable. The `@media (max-width:1280px) .top-actions .btn.ghost { display:none }` rule is **scoped to `.top-actions`** so it hides only the header's "Zurücksetzen" button, never the table's Bearbeiten/Löschen. Reproduce both scopings exactly.

Form view (`editingId || adding`): fields — Messstellen-ID (lowercased, `[^a-z0-9_-]` stripped, disabled when editing existing), Anzeigename, Standort/Beschreibung, **Testo Gerät (Logger)** `<select>` populated from `GET /api/testo/devices` (loading spinner / error message with hint to set API key / option per device "name · serial (uuid8...)" + a "Kein Gerät zugewiesen (statische Simulation)" empty option), Geräte-UUID manual override input, and a field-row of Temperatur-Offset (K, step 0.1) + Feuchtigkeit-Offset (%, step 0.5). Footer: "Abbrechen" / "Zuweisung Speichern" (disabled unless id & name).
- `saveEdit` → `POST /api/stations {id,name,location,mo_uuid,device_uuid}` then save calibration to `settings.calibration[id]` and `DASH_DATA.forceApiRefresh()`.
- `deleteStation` → confirm (German warning about irreversible history loss) → `DELETE /api/stations/:id` → refresh.

### 8.5 NotificationsSection
Push toggle; E-Mail recipients as `.chips` (add via input on Enter/button, must contain "@", dedup; remove via ×); per-severity routing `SegmentedControl` (options Sofort/Nach 5 min/Nach 15 min/Nach 1 h/Aus → values instant/5min/15min/1h/off); Stiller Modus toggle + Von/Bis time inputs (shown when enabled). **All persisted only to localStorage; no backend wiring / no actual notifications are sent.**

### 8.6 AdvancedSection
Field-row: Sprache (Deutsch/English), Zeitformat (24 Std/12 Std), Auto-Aktualisierung slider (5–300 s). Standard-Messstelle `SegmentedControl` from live stations. Daten card: 3 no-op buttons (Export JSON / Import / Cache leeren). Zurücksetzen card: danger button → confirm → `setSettings(DEFAULT_SETTINGS)`. **Über card** `.kv-grid.two-col` — reproduce these static strings verbatim:
```
Version    "Klima Dashboard 1.0.0"
Build      "2026-05-29 · #local"
API        "v1.0 · Testo Smart Connect"
Datenbank  "SQLite 3"
Lizenz     "Open Source"
Support    "https://github.com/dniehof/testo-smart-abruf"
```
(These display strings are stale vs the `0.1.4` package version — see README Open Questions.)

### 8.7 Settings primitives
`SectionHead{title,sub,compact}`, `Card{noPad}`, `Field{label,hint}`, `Toggle{checked,onChange,labelOn,labelOff}` (`role=switch`), `SegmentedControl{value,options,onChange}`, `StatusPill{status}` (OK/Warnung/Fehler), `StatusBadge{status,label}`, `HealthCard{status,label,value,sub,icon,progress}`, `OpRow{status,label,detail}`, `KV{label,value}`, `Spinner` (rotating SVG), `NavIcon{id}` (inline SVG set: grid/plug/db/node/bell/sliders/bolt/disk/archive), `formatBytes(b)` (B/kB/MB/GB).

---

## 9. Icons / assets

All icons are **inline SVG** drawn in code (no icon font, no image icons). Reproduce the SVG path data from the source for pixel fidelity (brand clock, gear, chevron, battery/signal, alarm triangle, warning circle, system battery/connection/maintenance, nav icons, tile-type previews, grip dots, resize handle, close ×, pencil, checkmarks, spinner). `Smart Meter Dashboard/uploads/draw-*.png` exist on disk but are **not referenced** by any code — ignore for the rebuild.

## 10. Responsive behavior (media queries)
- `≤1280px`: hide `.tile-count`, `.brand-sub`, and `.top-actions .btn.ghost` (header "Zurücksetzen" only).
- `≤1040px`: shrink station selector, hide `.station-sub`.
- `≤900px`: settings layout collapses to single column; sidebar becomes horizontal scroll; setting fields single-column.
- `≤720px`: tighter topbar/grid padding; type-grid single column.
- `≤640px`: icon-only top-action buttons (hide button text after svg).

## Open Questions

- `StationSelector` (a full station-switch popover with battery/signal icons and alert counts) is implemented but not mounted in the shipped `Header`. A faithful rebuild keeps it defined and matches the header as-is (no dropdown). Whether it should be mounted is a product decision.
- Numerous settings controls (notifications routing/quiet hours, timeout/retries sliders, backup/optimize/export buttons, language/time-format/import/export/cache) are **client-only or pure no-ops** — they persist to localStorage but have no backend effect. The rebuild must reproduce them as functional-looking but inert unless the product intends to wire them.
- Exact OKLCH/hex values, shadow tuples, radii, paddings, font sizes and SVG path data are reconstruction-critical for visual parity; port the `<style>` block and inline SVGs verbatim from `Klima Dashboard.html`.
