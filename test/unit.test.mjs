import test from "node:test";
import assert from "node:assert/strict";
import { extractAtRules, parseFontFace, extractRootVariables, extractMediaQueries } from "../mcp-server/dist/lib/css.js";
import { buildBlueprint } from "../mcp-server/dist/lib/blueprint.js";

test("extractAtRules returns balanced keyframes blocks", () => {
  const css = "@keyframes a{0%{opacity:0}100%{opacity:1}} .x{color:red} @keyframes b{from{top:0}to{top:1px}}";
  const out = extractAtRules(css, "@keyframes");
  assert.equal(out.length, 2);
  assert.match(out[0], /^@keyframes a\{0%\{opacity:0\}100%\{opacity:1\}\}$/);
});

test("parseFontFace resolves urls and formats", () => {
  const f = parseFontFace('@font-face{font-family:"Foo";font-weight:700;font-style:italic;font-display:swap;src:url(/f/foo.woff2) format("woff2"),url(data:font/woff;base64,AAA) format("woff")}', "https://x.test/css/a.css");
  assert.equal(f.family, "Foo");
  assert.equal(f.weight, "700");
  assert.equal(f.sources[0].url, "https://x.test/f/foo.woff2");
  assert.equal(f.sources[1].url, "data:(inline)");
});

test("extractRootVariables reads :root and theme blocks only", () => {
  const v = extractRootVariables(":root{--a:1px;--b:#fff} .card{--z:9} html[data-theme=dark]{--a:2px}");
  assert.equal(v["--a"], "2px");
  assert.equal(v["--b"], "#fff");
  assert.equal(v["--z"], undefined);
});

test("extractMediaQueries dedupes", () => {
  assert.deepEqual(extractMediaQueries("@media (min-width:768px){a{}} @media (min-width:768px){b{}} @media (max-width:500px){c{}}"), ["(min-width:768px)", "(max-width:500px)"]);
});

const mk = (id, parent, tag, extra = {}) => ({ id, parent, tag, selector: tag, attrs: {}, rect: { x: 0, y: id * 10, w: 100, h: 10 }, styles: {}, ...extra });
const base = { url: "u", capturedAt: "t", viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, tokens: {}, cssVariables: {}, fonts: [], keyframes: {}, mediaQueries: [], assets: [], canvases: [], videos: [], profile: {}, page: {} };

test("buildBlueprint collapses inert wrappers and keeps meaningful ones", () => {
  const nodes = [
    mk(0, null, "html"), mk(1, 0, "body"),
    mk(2, 1, "div", { rect: { x: 0, y: 0, w: 100, h: 10 }, styles: { display: "block" } }), // inert wrapper
    mk(3, 2, "h1", { text: "Hi", rect: { x: 0, y: 0, w: 100, h: 10 } }),
    mk(4, 1, "div", { styles: { display: "flex", gap: "8px" } }), mk(5, 4, "span", { text: "a" }),
  ];
  const bp = buildBlueprint({ ...base, nodes });
  const kids = bp.components.children;
  assert.equal(kids[0].tag, "h1");
  assert.deepEqual(kids[0].collapsedWrappers, ["div"]);
  assert.equal(kids[1].layout.display, "flex");
});

test("buildBlueprint reports repeated siblings, layers, stacking and effects", () => {
  const nodes = [mk(0, null, "html"), mk(1, 0, "body")];
  for (let i = 0; i < 4; i++) nodes.push(mk(10 + i, 1, "li", { text: "x" }));
  nodes.push(mk(20, 1, "div", { styles: { position: "fixed", zIndex: "9", clipPath: "circle(50%)" }, stack: { zIndex: "9", reasons: ["fixed", "clip-path"] } }));
  const bp = buildBlueprint({ ...base, nodes });
  assert.equal(bp.components.repeatGroups[0].count, 4);
  assert.equal(bp.layers.fixedAndSticky[0].zIndex, "9");
  assert.equal(bp.layers.stackingContexts[0].reasons.includes("clip-path"), true);
  assert.equal(bp.effects[0].clipPath, "circle(50%)");
});
