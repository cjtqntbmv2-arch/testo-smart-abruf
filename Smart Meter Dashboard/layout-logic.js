// Pure, side-effect-free Layout-Mathematik des Kachelrasters.
// Browser: als <script> vor tiles.jsx geladen, haengt an window (app.jsx nutzt COLS).
// Node: per require() in Tests genutzt. Kein DOM / React / fetch / timer hier.
// COLS ist Rastertopologie und gehoert zur Mathematik; ROW_H/GAP sind reine
// Pixelgeometrie und bleiben in tiles.jsx.
(function () {
  const COLS = 12;

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // Move tile to (x,y) with size (w,h); push colliding tiles downward.
  function compactLayout(layout, movedId, target) {
    const items = layout.map((t) => (t.id === movedId ? { ...t, ...target } : { ...t }));
    // Iterative push-down until no overlaps
    let safety = 200;
    while (safety-- > 0) {
      let changed = false;
      const moved = items.find((t) => t.id === movedId);
      for (const t of items) {
        if (t.id === movedId) continue;
        if (rectsOverlap(moved, t)) {
          // push t below moved
          const newY = moved.y + moved.h;
          if (t.y < newY) {
            t.y = newY;
            changed = true;
          }
        }
      }
      // Cascade between non-moved
      for (let i = 0; i < items.length; i++) {
        for (let j = 0; j < items.length; j++) {
          if (i === j) continue;
          const A = items[i], B = items[j];
          if (A.id === movedId || B.id === movedId) continue;
          if (rectsOverlap(A, B)) {
            // push B below A if A is higher
            if (A.y <= B.y) {
              const newY = A.y + A.h;
              if (B.y < newY) {
                B.y = newY;
                changed = true;
              }
            }
          }
        }
      }
      if (!changed) break;
    }
    return items;
  }

  // Find first non-overlapping position for a new tile of given size.
  function findFreeSlot(layout, w, h) {
    // try rows from 0 down
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x <= COLS - w; x++) {
        const cand = { x, y, w, h };
        if (!layout.some((t) => rectsOverlap(cand, t))) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }

  const api = { COLS, rectsOverlap, compactLayout, findFreeSlot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.COLS = COLS;
    window.rectsOverlap = rectsOverlap;
    window.compactLayout = compactLayout;
    window.findFreeSlot = findFreeSlot;
  }
})();
