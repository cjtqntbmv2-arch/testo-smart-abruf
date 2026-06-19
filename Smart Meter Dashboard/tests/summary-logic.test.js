const test = require('node:test');
const assert = require('node:assert');
const { buildStationOverview, historySectionView } = require('../summary-logic.js');

// active defaults to true unless explicitly false.
function ev(severity, startTs, active) {
  return { severity, startTs, active: active !== false };
}

test('empty / nullish inputs -> empty array', () => {
  assert.deepStrictEqual(buildStationOverview({}, []), []);
  assert.deepStrictEqual(buildStationOverview(null, null), []);
});

test('all stations are included, even quiet ones (activeCount 0)', () => {
  const stations = {
    a: { id: 'a', events: [] },
    b: { id: 'b', events: [ev('alarm', 100, false)] }, // only inactive
  };
  const res = buildStationOverview(stations, ['a', 'b']);
  assert.deepStrictEqual(res.map((g) => g.station.id).sort(), ['a', 'b']);
  assert.ok(res.every((g) => g.activeCount === 0 && g.activeEvents.length === 0));
});

test('active events filtered/sorted; inactive excluded from activeEvents', () => {
  const stations = { a: { id: 'a', events: [ev('warning', 200, true), ev('alarm', 100, false)] } };
  const res = buildStationOverview(stations, ['a']);
  assert.strictEqual(res[0].activeCount, 1);
  assert.strictEqual(res[0].activeEvents[0].severity, 'warning');
});

test('stations with active events sort before quiet stations', () => {
  const stations = {
    quiet: { id: 'quiet', events: [] },
    warn: { id: 'warn', events: [ev('warning', 500, true)] },
  };
  // order lists quiet first, but the active station must come first
  const res = buildStationOverview(stations, ['quiet', 'warn']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['warn', 'quiet']);
});

test('among active stations: alarm sorts before warning-only', () => {
  const stations = {
    warnStation: { id: 'warnStation', events: [ev('warning', 500, true)] },
    alarmStation: { id: 'alarmStation', events: [ev('alarm', 100, true)] },
  };
  const res = buildStationOverview(stations, ['warnStation', 'alarmStation']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['alarmStation', 'warnStation']);
});

test('quiet stations keep stationOrder among themselves', () => {
  const stations = {
    x: { id: 'x', events: [] },
    y: { id: 'y', events: [] },
    z: { id: 'z', events: [ev('alarm', 100, true)] },
  };
  const res = buildStationOverview(stations, ['y', 'x', 'z']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['z', 'y', 'x']);
});

test('activeEvents within a station: alarm < warning < system; ties newest-first', () => {
  const stations = {
    a: { id: 'a', events: [
      ev('system', 300, true), ev('warning', 400, true),
      ev('alarm', 100, true), ev('warning', 900, true),
    ] },
  };
  const res = buildStationOverview(stations, ['a']);
  const order = res[0].activeEvents.map((e) => e.severity + ':' + e.startTs);
  assert.deepStrictEqual(order, ['alarm:100', 'warning:900', 'warning:400', 'system:300']);
});

test('active group tie-break: same worst severity -> newer startTs first', () => {
  const stations = {
    older: { id: 'older', events: [ev('alarm', 100, true)] },
    newer: { id: 'newer', events: [ev('alarm', 800, true)] },
  };
  const res = buildStationOverview(stations, ['older', 'newer']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['newer', 'older']);
});

test('robust: id missing from stations skipped; missing events array tolerated', () => {
  const stations = {
    a: { id: 'a' },                                  // no events array -> quiet
    c: { id: 'c', events: [ev('alarm', 100, true)] },
  };
  const res = buildStationOverview(stations, ['a', 'ghost', 'c']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['c', 'a']); // active first, then quiet
});

test('public shape carries only { station, activeEvents, activeCount }', () => {
  const stations = { a: { id: 'a', events: [ev('alarm', 100, true)] } };
  const res = buildStationOverview(stations, ['a']);
  assert.deepStrictEqual(Object.keys(res[0]).sort(), ['activeCount', 'activeEvents', 'station']);
});

// ---------------------------------------------------------------------------
// historySectionView: pure view-model deciding which controls/content the
// per-station history section renders. Drives the collapsible-history UX
// (independent collapse + bottom collapse control) without any DOM/React.
// ---------------------------------------------------------------------------
function vstate(over) {
  return Object.assign(
    { loaded: false, loading: false, error: null, done: false, histOpen: false, historyCount: 0 },
    over,
  );
}

test('preload (not loaded): shows only the "Historie laden…" button', () => {
  const v = historySectionView(vstate({}));
  assert.strictEqual(v.showLoadButton, true);
  assert.strictEqual(v.showToggle, false);
  assert.strictEqual(v.showItems, false);
  assert.strictEqual(v.showLoadMore, false);
  assert.strictEqual(v.showCollapseFoot, false);
  assert.strictEqual(v.showLoading, false);
  assert.strictEqual(v.showError, false);
});

test('preload while loading: spinner only, no load button', () => {
  const v = historySectionView(vstate({ loading: true }));
  assert.strictEqual(v.showLoading, true);
  assert.strictEqual(v.showLoadButton, false);
  assert.strictEqual(v.showToggle, false);
});

test('preload after error: error-retry only, no load button or spinner', () => {
  const v = historySectionView(vstate({ error: 'boom' }));
  assert.strictEqual(v.showError, true);
  assert.strictEqual(v.showLoadButton, false);
  assert.strictEqual(v.showLoading, false);
  assert.strictEqual(v.showToggle, false);
});

test('loaded + open + more pages: toggle, items, load-more, collapse-foot; count suffix "+"', () => {
  const v = historySectionView(vstate({ loaded: true, histOpen: true, historyCount: 20, done: false }));
  assert.strictEqual(v.showToggle, true);
  assert.strictEqual(v.showItems, true);
  assert.strictEqual(v.showLoadMore, true);
  assert.strictEqual(v.showCollapseFoot, true);
  assert.strictEqual(v.showLoadButton, false);
  assert.strictEqual(v.count, 20);
  assert.strictEqual(v.countSuffix, '+');
});

test('loaded + open + done: no load-more; count suffix empty', () => {
  const v = historySectionView(vstate({ loaded: true, histOpen: true, historyCount: 7, done: true }));
  assert.strictEqual(v.showItems, true);
  assert.strictEqual(v.showLoadMore, false);
  assert.strictEqual(v.showCollapseFoot, true);
  assert.strictEqual(v.countSuffix, '');
});

test('loaded + collapsed: toggle stays, content hidden, data preserved (count still reported)', () => {
  // The user requirement: once loaded, history can be collapsed independently of the
  // station group without losing the loaded rows.
  const v = historySectionView(vstate({ loaded: true, histOpen: false, historyCount: 40, done: true }));
  assert.strictEqual(v.showToggle, true);
  assert.strictEqual(v.showItems, false);
  assert.strictEqual(v.showCollapseFoot, false);
  assert.strictEqual(v.showLoadMore, false);
  assert.strictEqual(v.showEmptyHint, false);
  assert.strictEqual(v.count, 40); // rows are not discarded, just hidden
});

test('loaded + open + zero history: empty hint, no items/foot/load-more', () => {
  const v = historySectionView(vstate({ loaded: true, histOpen: true, historyCount: 0, done: true }));
  assert.strictEqual(v.showEmptyHint, true);
  assert.strictEqual(v.showItems, false);
  assert.strictEqual(v.showCollapseFoot, false);
  assert.strictEqual(v.showLoadMore, false);
});

test('loaded + open + load-more in flight: spinner shown, load-more hidden, foot persists', () => {
  const v = historySectionView(vstate({ loaded: true, histOpen: true, historyCount: 20, loading: true }));
  assert.strictEqual(v.showLoading, true);
  assert.strictEqual(v.showLoadMore, false);
  assert.strictEqual(v.showError, false);
  assert.strictEqual(v.showItems, true);
  assert.strictEqual(v.showCollapseFoot, true);
});

test('loaded + open + load-more failed: error-retry shown, items still visible', () => {
  const v = historySectionView(vstate({ loaded: true, histOpen: true, historyCount: 20, error: 'net' }));
  assert.strictEqual(v.showError, true);
  assert.strictEqual(v.showLoadMore, false);
  assert.strictEqual(v.showItems, true);
  assert.strictEqual(v.showCollapseFoot, true);
});

test('collapsed phase suppresses spinner/error/empty body controls regardless of flags', () => {
  const v = historySectionView(vstate({ loaded: true, histOpen: false, loading: true, error: 'x', historyCount: 0 }));
  assert.strictEqual(v.showToggle, true);
  assert.strictEqual(v.showLoading, false);
  assert.strictEqual(v.showError, false);
  assert.strictEqual(v.showEmptyHint, false);
});
