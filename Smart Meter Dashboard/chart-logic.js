// Pure, side-effect-free SVG-Pfad- und Skalenmathematik der Diagramme.
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

  // Skalenenden { lo, hi } des Tachometers.
  // Sind fuer die Messgroesse Grenzwerte konfiguriert (GET /api/limits - sie gelten je
  // Messgroesse, nicht je Messstelle), spannt die Skala diese auf, sonst die gueltigen
  // Messwerte. Der angezeigte Wert (letztes Element der Reihe) liegt immer innerhalb.
  // Dazu 10 % Rand je Seite, dann nach aussen auf einen runden Schritt (1/2/5 x 10^k,
  // nie feiner als `decimals`): die Enden sind als Text mit den Dezimalstellen der
  // Messgroesse exakt - frueher standen hier Rohwerte wie 21.461187, deren erste und
  // letzte Ziffer am SVG-Rand abgeschnitten wurden. Nichts da: 0..100 wie bisher.
  function gaugeScale(series, limits, metricId, decimals) {
    const values = (series || []).filter(Number.isFinite);
    const limitValues = (Array.isArray(limits) ? limits : [])
      .filter((l) => l && l.metric === metricId && Number.isFinite(l.limitValue))
      .map((l) => l.limitValue);
    const v = series && series[series.length - 1];
    const points = limitValues.length ? limitValues.concat(Number.isFinite(v) ? [v] : []) : values;
    if (!points.length) return { lo: 0, hi: 100 };
    let lo = points.reduce((a, b) => Math.min(a, b));
    let hi = points.reduce((a, b) => Math.max(a, b));
    if (lo === hi) { lo -= 1; hi += 1; }
    const margin = (hi - lo) * 0.1;
    lo -= margin;
    hi += margin;
    const raw = (hi - lo) / 5;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    const step = Math.max((f >= 5 ? 5 : f >= 2 ? 2 : 1) * pow, Math.pow(10, -decimals));
    // floor/ceil runden nach aussen; toFixed entfernt nur das Gleitkomma-Rauschen der
    // Multiplikation (21.200000000000003), der Rand haelt den Wert weit davon weg.
    return {
      lo: Number((Math.floor(lo / step) * step).toFixed(decimals)),
      hi: Number((Math.ceil(hi / step) * step).toFixed(decimals)),
    };
  }

  const api = { xPositions, buildPath, buildAreaPath, gaugeScale };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.xPositions = xPositions;
    window.buildPath = buildPath;
    window.buildAreaPath = buildAreaPath;
    window.gaugeScale = gaugeScale;
  }
})();
