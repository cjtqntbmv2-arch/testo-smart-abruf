const test = require('node:test');
const assert = require('node:assert');
const { buildStationOverview } = require('../summary-logic.js');

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
