// backend/event-reconcile.js
// DB-bound reconciliation of the testo alarm feed. Extracted from scheduler.js so the
// two halves (active flags, episode end_ts) are testable without a full sync cycle.
//
// testo emits a violation and its recovery as SEPARATE rows (distinct uuids, ascending
// timestamps), so "currently active" is a property of a logical alarm group, not of a
// single row: only the most recent transition is live, and only when it is a violation
// ('Alarm'). A later 'Ok' recovery closes the whole group.
//
// Synthetic system rows (sys-*, alarm_status IS NULL) are owned by applySystemEvents in
// scheduler.js and are excluded from every statement here.

// The group key. Both statements MUST partition identically — the active flag and the
// episode end are two views of the same grouping, and a key that differs between them
// produces episodes whose end does not match the transition that closed them. Keeping it
// in one constant is the reason this module exists.
//   serial_no  — so multi-sensor devices don't cross-close each other
//   severity   — so a Warning violation isn't extinguished by an Alarm-severity recovery
//                (separate limit bands on the same channel)
const EPISODE_PARTITION =
  "PARTITION BY station_id, COALESCE(serial_no,''), alarm_condition_type, severity, COALESCE(metric,'')";

const FEED_ROWS = 'alarm_status IS NOT NULL';

// Newest transition per group wins; only a trailing 'Alarm' stays active.
// Runs over ALL stored feed rows, so historical pairs settle even when only one side was
// fetched this cycle.
function reconcileActiveFlags(db) {
  db.prepare(`UPDATE events SET active = 0 WHERE ${FEED_ROWS}`).run();
  db.prepare(`
    UPDATE events SET active = 1 WHERE uuid IN (
      SELECT uuid FROM (
        SELECT uuid,
          ROW_NUMBER() OVER (
            ${EPISODE_PARTITION}
            ORDER BY start_ts DESC, rowid DESC
          ) AS rn,
          alarm_status
        FROM events
        WHERE ${FEED_ROWS}
      ) WHERE rn = 1 AND alarm_status = 'Alarm'
    )
  `).run();
}

// Episode end_ts = start of the NEXT transition in the same group. The feed is a
// transition log; a violation's real end is its recovery's start (or the next violation
// if no recovery was recorded). LEAD over the same partition, ordered ascending, yields
// that next start. The newest row in a group (the active violation, or a trailing
// recovery) gets NULL — the frontend shows "laeuft" for active rows via the active flag,
// not via end_ts. Unconditional over all feed rows: a stale end_ts left by an earlier
// grouping is overwritten, NULL included.
function reconcileEpisodeEnds(db) {
  db.prepare(`
    UPDATE events AS e
    SET end_ts = nxt.next_start
    FROM (
      SELECT rowid AS rid,
        LEAD(start_ts) OVER (
          ${EPISODE_PARTITION}
          ORDER BY start_ts ASC, rowid ASC
        ) AS next_start
      FROM events
      WHERE ${FEED_ROWS}
    ) AS nxt
    WHERE e.rowid = nxt.rid AND e.${FEED_ROWS}
  `).run();
}

// Both halves in one transaction: a partition change must never be visible with the
// active flags recomputed and the episode ends still on the old grouping.
function reconcileEvents(db) {
  db.transaction(() => {
    reconcileActiveFlags(db);
    reconcileEpisodeEnds(db);
  })();
}

module.exports = { reconcileEvents, reconcileActiveFlags, reconcileEpisodeEnds, EPISODE_PARTITION };
