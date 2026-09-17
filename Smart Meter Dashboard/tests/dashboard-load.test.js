// Ladbarkeitspruefung fuer das Dashboard.
//
// Die Dashboard-Dateien haben keinen Buildschritt und kein Modulsystem: sie werden
// als <script> aus "Klima Dashboard.html" geladen und teilen einen globalen Scope.
// Zwei Fehler machen daraus eine weisse Seite, ohne dass ein Test etwas merkt:
//   1. zwei Dateien deklarieren denselben Namen mit const/let/class
//      -> "Identifier has already been declared", Auswertung bricht ab
//   2. ein Bezeichner wird benutzt, aber nirgends deklariert
//      -> "X is not defined" beim ersten Render (vergessener <script>-Tag)
// Diese Pruefung faengt beides statisch ab. Sie benutzt das bereits eingecheckte
// vendor/babel.min.js als Parser - keine zusaetzliche Abhaengigkeit.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..");
const ROOT = path.join(DIR, "..");

const Babel = require(path.join(DIR, "vendor/babel.min.js"));
const traverse = Babel.packages.traverse.default || Babel.packages.traverse;
const types = Babel.packages.types;

// Nur diese Deklarationsarten werfen bei Doppelvergabe im gemeinsamen Scope.
// function/var ueberschreiben sich still - unschoen, aber keine weisse Seite.
const HARTE_ARTEN = new Set(["const", "let", "class"]);

const BROWSER_GLOBALS = new Set([
  "window", "document", "console", "fetch", "localStorage", "sessionStorage", "navigator", "location",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "Error", "TypeError", "RangeError",
  "Promise", "Set", "Map", "WeakMap", "WeakSet", "Symbol", "Proxy", "Reflect", "RegExp", "Intl", "BigInt",
  "isNaN", "isFinite", "parseInt", "parseFloat", "NaN", "Infinity", "undefined", "arguments", "globalThis",
  "URL", "URLSearchParams", "Blob", "File", "FileReader", "FormData", "Headers", "Request", "Response",
  "AbortController", "alert", "confirm", "prompt", "encodeURIComponent", "decodeURIComponent",
  "structuredClone", "performance", "getComputedStyle", "ResizeObserver", "MutationObserver", "IntersectionObserver",
  "Event", "CustomEvent", "TextEncoder", "TextDecoder", "queueMicrotask", "crypto", "btoa", "atob",
  "React", "ReactDOM", "module", "require", "exports",
]);

// files: [{ name, source, babel }] in Ladereihenfolge.
// Liefert eine Liste lesbarer Problembeschreibungen; leer = ladbar.
function analyze(files) {
  const probleme = [];
  const deklariert = new Map(); // name -> [{ datei, art }]
  const freieNamen = new Map(); // datei -> string[]

  const merke = (name, art, datei) => {
    if (!deklariert.has(name)) deklariert.set(name, []);
    deklariert.get(name).push({ datei, art });
  };

  for (const f of files) {
    let ast;
    try {
      const code = f.babel
        ? Babel.transform(f.source, { presets: ["react"], sourceType: "script" }).code
        : f.source;
      ast = Babel.packages.parser.parse(code, { sourceType: "script" });
    } catch (e) {
      probleme.push(`Syntaxfehler in ${f.name}: ${String(e.message).split("\n")[0]}`);
      continue;
    }

    // Top-Level-Bindings. getBindingIdentifiers loest Destrukturierung auf -
    // ohne das bliebe "const { useState } = React" unsichtbar, also genau der Fall,
    // der die weisse Seite ausloest.
    for (const node of ast.program.body) {
      const art =
        node.type === "VariableDeclaration" ? node.kind
        : node.type === "FunctionDeclaration" ? "function"
        : node.type === "ClassDeclaration" ? "class"
        : null;
      if (art) for (const name of Object.keys(types.getBindingIdentifiers(node))) merke(name, art, f.name);
    }

    let globals = [];
    traverse(ast, {
      Program(p) {
        globals = Object.keys(p.scope.globals);
      },
      // window.X = ... und Object.assign(window, { X }) sind die Exportwege der
      // Logikmodule; die dort gesetzten Namen gelten als deklariert.
      AssignmentExpression(p) {
        const ziel = p.node.left;
        if (
          ziel.type === "MemberExpression" && !ziel.computed &&
          ziel.object.type === "Identifier" && ziel.object.name === "window" &&
          ziel.property.type === "Identifier"
        ) merke(ziel.property.name, "window", f.name);
      },
      CallExpression(p) {
        const ruf = p.node.callee;
        if (
          ruf.type === "MemberExpression" &&
          ruf.object.type === "Identifier" && ruf.object.name === "Object" &&
          ruf.property.type === "Identifier" && ruf.property.name === "assign" &&
          p.node.arguments[0] && p.node.arguments[0].type === "Identifier" &&
          p.node.arguments[0].name === "window"
        ) {
          for (const arg of p.node.arguments.slice(1)) {
            if (arg.type !== "ObjectExpression") continue;
            for (const prop of arg.properties) {
              if (prop.key && prop.key.type === "Identifier") merke(prop.key.name, "window", f.name);
            }
          }
        }
      },
    });
    freieNamen.set(f.name, globals);
  }

  // Nach einem Syntaxfehler sind alle weiteren Aussagen wertlos - fehlende
  // Deklarationen der kaputten Datei erzeugten sonst eine Folgelawine.
  if (probleme.length) return probleme;

  for (const [name, stellen] of deklariert) {
    // "window.X = X" ist ein Export, keine zweite Deklaration.
    const echte = stellen.filter((s) => s.art !== "window");
    const dateien = new Set(echte.map((s) => s.datei));
    if (dateien.size > 1 && echte.some((s) => HARTE_ARTEN.has(s.art))) {
      probleme.push(
        `Kollision "${name}": ${echte.map((s) => `${s.datei} [${s.art}]`).join(" + ")}` +
        ` - die zweite Auswertung wirft "Identifier has already been declared" (weisse Seite).`
      );
    }
  }

  for (const [datei, namen] of freieNamen) {
    const fehlend = namen.filter((n) => !BROWSER_GLOBALS.has(n) && !deklariert.has(n));
    if (fehlend.length) {
      probleme.push(`Nicht deklariert, in ${datei} benutzt: ${fehlend.sort().join(", ")}`);
    }
  }

  return probleme;
}

// ---------- Testdaten ----------

function scriptTags() {
  const html = fs.readFileSync(path.join(DIR, "Klima Dashboard.html"), "utf8");
  return [...html.matchAll(/<script([^>]*)src="([^"]+)"/g)].map((m) => ({
    src: m[2].split("?")[0],
    version: m[2].includes("?v=") ? m[2].split("?v=")[1] : null,
    babel: /text\/babel/.test(m[1]),
  }));
}

// <link rel="stylesheet" href="..."> - kein JS, deshalb fuer analyze() uninteressant,
// fuer Registrierung und Cache-Buster aber genauso verbindlich wie ein Skript-Tag.
// Ohne diese Funktion war eine .css in BEIDEN Pruefungen unten unsichtbar: ein
// fehlender <link> und ein fehlendes ?v= blieben gruen - genau die Stale-Asset-Falle,
// die in diesem Projekt schon einmal als "fehlendes Feature" erschienen ist.
function linkTags() {
  const html = fs.readFileSync(path.join(DIR, "Klima Dashboard.html"), "utf8");
  return [...html.matchAll(/<link([^>]*)href="([^"]+)"/g)].map((m) => ({
    src: m[2].split("?")[0],
    version: m[2].includes("?v=") ? m[2].split("?v=")[1] : null,
  }));
}

const istApp = (t) => !t.src.startsWith("vendor/");

// Nur Skript-Tags: analyze() parst diese Quellen, eine .css wuerde daran zerschellen.
const appTags = () => scriptTags().filter(istApp);

// Alles, was das HTML laedt - Skripte UND Stylesheets.
const appAssets = () => [...appTags(), ...linkTags().filter(istApp)];
const vendorAssets = () => [...scriptTags(), ...linkTags()].filter((t) => !istApp(t));

const realFiles = () =>
  appTags().map((t) => ({
    name: t.src,
    source: fs.readFileSync(path.join(DIR, t.src), "utf8"),
    babel: t.babel,
  }));

// ---------- Tests ----------

test("die geladenen Dashboard-Dateien sind widerspruchsfrei", () => {
  const problems = analyze(realFiles());
  assert.deepStrictEqual(problems, [], problems.join("\n"));
});

test("erkennt kollidierende const-Deklarationen (die weisse Seite)", () => {
  const problems = analyze([
    { name: "a.jsx", babel: true, source: "const { useState } = React;\n" },
    { name: "b.jsx", babel: true, source: "const { useState } = React;\n" },
  ]);
  assert.strictEqual(problems.length, 1, `erwartete genau eine Kollision, bekam: ${problems.join(" | ")}`);
  assert.match(problems[0], /useState/);
  assert.match(problems[0], /a\.jsx/);
  assert.match(problems[0], /b\.jsx/);
});

test("erkennt einen Bezeichner ohne Deklaration (vergessener script-Tag)", () => {
  const problems = analyze([
    { name: "nutzt.jsx", babel: true, source: "function A(){ return <Card/>; }\n" },
  ]);
  assert.strictEqual(problems.length, 1, `erwartete einen Fund, bekam: ${problems.join(" | ")}`);
  assert.match(problems[0], /Card/);
  assert.match(problems[0], /nutzt\.jsx/);
});

test("function-Deklarationen kollidieren nicht hart, window-Export ist keine Deklaration", () => {
  const problems = analyze([
    { name: "a.jsx", babel: true, source: "function Card(){ return null; }\nwindow.Card = Card;\n" },
    { name: "b.js", babel: false, source: "window.helfer = function(){ return Card; };\n" },
  ]);
  assert.deepStrictEqual(problems, [], problems.join("\n"));
});

test("erkennt einen Syntaxfehler", () => {
  const problems = analyze([{ name: "kaputt.jsx", babel: true, source: "function A( { return <div/>;\n" }]);
  assert.strictEqual(problems.length, 1, `erwartete einen Fund, bekam: ${problems.join(" | ")}`);
  assert.match(problems[0], /kaputt\.jsx/);
});

test("jede App-Datei traegt die aktuelle Version als Cache-Buster, vendor keine", () => {
  const version = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
  for (const t of appAssets()) {
    assert.strictEqual(t.version, version, `${t.src} traegt ?v=${t.version}, erwartet ${version}`);
  }
  for (const t of vendorAssets()) {
    assert.strictEqual(t.version, null, `${t.src} soll bewusst keinen Cache-Buster tragen`);
  }
});

test("jede Datei im Dashboard-Verzeichnis ist im HTML registriert", () => {
  const geladen = new Set(appAssets().map((t) => t.src));
  const vorhanden = fs
    .readdirSync(DIR)
    .filter((f) => /\.(js|jsx|css)$/.test(f) && !f.startsWith("."));
  for (const f of vorhanden) {
    assert.ok(geladen.has(f), `${f} liegt im Verzeichnis, wird aber von keinem <script>- oder <link>-Tag geladen`);
  }
});
