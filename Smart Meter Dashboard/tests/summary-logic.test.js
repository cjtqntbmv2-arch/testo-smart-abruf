const test = require('node:test');
const assert = require('node:assert');
const { groupActiveEventsByStation } = require('../summary-logic.js');

// active defaults to true unless explicitly false.
function ev(severity, startTs, active) {
  return { severity, startTs, active: active !== false };
}

test('empty / nullish inputs -> empty array', () => {
  assert.deepStrictEqual(groupActiveEventsByStation({}, []), []);
  assert.deepStrictEqual(groupActiveEventsByStation(null, null), []);
});

test('station with no active events is omitted', () => {
  const stations = {
    a: { id: 'a', events: [] },
    b: { id: 'b', events: [ev('alarm', 100, false)] }, // only inactive
  };
  assert.deepStrictEqual(groupActiveEventsByStation(stations, ['a', 'b']), []);
});

test('inactive events filtered out, active kept', () => {
  const stations = {
    a: { id: 'a', events: [ev('warning', 200, true), ev('alarm', 100, false)] },
  };
  const res = groupActiveEventsByStation(stations, ['a']);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].events.length, 1);
  assert.strictEqual(res[0].events[0].severity, 'warning');
});

test('groups: a station with an alarm sorts before a warning-only station', () => {
  const stations = {
    warnStation:  { id: 'warnStation',  events: [ev('warning', 500, true)] },
    alarmStation: { id: 'alarmStation', events: [ev('alarm', 100, true)] },
  };
  // stationOrder lists warn first, but the alarm group must come first by severity.
  const res = groupActiveEventsByStation(stations, ['warnStation', 'alarmStation']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['alarmStation', 'warnStation']);
});

test('events within a group: alarm < warning < system; ties newest-first', () => {
  const stations = {
    a: { id: 'a', events: [
      ev('system', 300, true),
      ev('warning', 400, true),
      ev('alarm', 100, true),
      ev('warning', 900, true), // newer warning
    ] },
  };
  const res = groupActiveEventsByStation(stations, ['a']);
  const order = res[0].events.map((e) => e.severity + ':' + e.startTs);
  assert.deepStrictEqual(order, ['alarm:100', 'warning:900', 'warning:400', 'system:300']);
});

test('group tie-break: same worst severity -> newer startTs group first', () => {
  const stations = {
    older: { id: 'older', events: [ev('alarm', 100, true)] },
    newer: { id: 'newer', events: [ev('alarm', 800, true)] },
  };
  const res = groupActiveEventsByStation(stations, ['older', 'newer']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['newer', 'older']);
});

test('robust: id in order missing from stations skipped; missing events array tolerated', () => {
  const stations = {
    a: { id: 'a' },                                   // no events array
    c: { id: 'c', events: [ev('alarm', 100, true)] },
  };
  const res = groupActiveEventsByStation(stations, ['a', 'ghost', 'c']);
  assert.deepStrictEqual(res.map((g) => g.station.id), ['c']);
});

test('public shape carries only { station, events } (no internal sort keys)', () => {
  const stations = { a: { id: 'a', events: [ev('alarm', 100, true)] } };
  const res = groupActiveEventsByStation(stations, ['a']);
  assert.deepStrictEqual(Object.keys(res[0]).sort(), ['events', 'station']);
});
