// Pure, side-effect-free SVG-Pfadmathematik der Diagramme.
// Browser: als <script> vor charts.jsx geladen, haengt an window.
// Node: per require() in Tests genutzt. Kein DOM / React / fetch / timer hier.
(function () {
  // x-Positionen von `count` gleichmaessig verteilten Punkten auf [x0, x0 + span].
  // Bei genau einem Punkt gibt es keine Strecke zu teilen: i/(count-1) waere 0/0
  // und damit NaN - der Browser verwirft ein d="MNaN ..." komplett und zeigt ein
  // leeres Diagramm ohne Konsolenmeldung. Ein einzelner Punkt gehoert in die Mitte.
  function xPositions(count, x0, span) {
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = x0 + (count > 1 ? i / (count - 1) : 0.5) * span;
    return out;
  }

  // SVG-Linienpfad aus x-/y-Arrays. Ein NaN oder null in ys ist eine Luecke:
  // der Pfad wird unterbrochen und beim naechsten gueltigen Punkt neu gesetzt.
  function buildPath(xs, ys) {
    let d = "";
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      if (Number.isNaN(ys[i]) || ys[i] == null) {
        started = false;
        continue;
      }
      d += (!started ? "M" : "L") + xs[i].toFixed(2) + " " + ys[i].toFixed(2) + " ";
      started = true;
    }
    return d;
  }

  // Dasselbe als gefuellte Flaeche bis zur Grundlinie baseY. Jede Luecke schliesst
  // die laufende Flaeche am letzten gueltigen x und oeffnet danach eine neue.
  function buildAreaPath(xs, ys, baseY) {
    let d = "";
    let started = false;
    let lastValidX = null;
    for (let i = 0; i < xs.length; i++) {
      if (Number.isNaN(ys[i]) || ys[i] == null) {
        if (started) {
          d += "L" + lastValidX.toFixed(2) + " " + baseY.toFixed(2) + " Z ";
          started = false;
        }
        continue;
      }
      if (!started) {
        d += "M" + xs[i].toFixed(2) + " " + baseY.toFixed(2) + " L" + xs[i].toFixed(2) + " " + ys[i].toFixed(2) + " ";
        started = true;
      } else {
        d += "L" + xs[i].toFixed(2) + " " + ys[i].toFixed(2) + " ";
      }
      lastValidX = xs[i];
    }
    if (started) {
      d += "L" + lastValidX.toFixed(2) + " " + baseY.toFixed(2) + " Z";
    }
    return d;
  }

  const api = { xPositions, buildPath, buildAreaPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.xPositions = xPositions;
    window.buildPath = buildPath;
    window.buildAreaPath = buildAreaPath;
  }
})();
