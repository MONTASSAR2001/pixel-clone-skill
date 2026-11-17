/**
 * Unit tests for the template's replay runtime math (templates/nextjs-clone-starter/src/replay/replayMath.ts) and the
 * server-side responsive fitter (mcp-server/src/lib/responsive.ts). The template file is transpiled with the repo's
 * TypeScript so the tested code is exactly what clones ship.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { fitRule, heuristicRule, applyRule } from "../mcp-server/dist/lib/responsive.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "templates/nextjs-clone-starter/src/replay/replayMath.ts"), "utf8");
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pc-math-")), "replayMath.mjs");
fs.writeFileSync(tmp, out);
const M = await import(pathToFileURL(tmp).href);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("bracket finds the surrounding keyframes and blend", () => {
  const k = [0, 900, 1800, 2700];
  assert.deepEqual(M.bracket(k, 0), { a: 0, b: 0, t: 0 });
  assert.deepEqual(M.bracket(k, 450), { a: 0, b: 900, t: 0.5 });
  assert.deepEqual(M.bracket(k, 2000), { a: 1800, b: 2700, t: 200 / 900 });
  assert.deepEqual(M.bracket(k, 5000), { a: 2700, b: 2700, t: 0 });
  assert.equal(M.bracket([], 10), null);
});

test("dampScroll converges exactly, frame-rate independently, and jumps on large moves", () => {
  let y = 0, n = 0;
  while (y !== 900 && n < 200) { y = M.dampScroll(y, 900, 16.7, 45, 2000); n++; }
  assert.equal(y, 900);
  assert.ok(n > 5 && n < 60, `${n} frames`);
  // two 8.35ms steps == one 16.7ms step
  close(M.dampScroll(M.dampScroll(0, 100, 8.35, 45, 1e9), 100, 8.35, 45, 1e9), M.dampScroll(0, 100, 16.7, 45, 1e9), 1e-9);
  assert.equal(M.dampScroll(0, 5000, 16.7, 45, 2000), 5000);
});

test("pickVariant prefers the matching aspect ratio, then size", () => {
  const vs = [{ width: 1440, height: 900, base: "a/" }, { width: 1920, height: 1080, base: "b/" }];
  assert.equal(M.pickVariant(vs, 1440, 900).base, "a/");
  assert.equal(M.pickVariant(vs, 2560, 1440).base, "b/");
  assert.equal(M.pickVariant(vs, 1680, 1050).base, "a/");
});

test("heuristic anchoring: full-bleed stretches, pinned HUD sticks to its edge, flow stays centered", () => {
  assert.deepEqual(M.heuristicAnchor({ x: 0, y: 0, w: 1440, h: 56 }, [1440, 900], true), [0, 1, 0, 0, 0]);
  assert.deepEqual(M.heuristicAnchor({ x: 1299, y: 21, w: 120, h: 40 }, [1440, 900], true), [1, 0, 0, 0, 0]);
  assert.deepEqual(M.heuristicAnchor({ x: 620, y: 846, w: 200, h: 30 }, [1440, 900], true), [0.5, 0, 1, 0, 0]);
  assert.deepEqual(M.heuristicAnchor({ x: 240, y: 300, w: 400, h: 50 }, [1440, 900], false), [0.5, 0, 0, 0, 0]);
  // right-anchored HUD keeps its 21px gap at 1920x1080
  const r = M.anchorRect({ x: 1299, y: 21, w: 120, h: 40 }, [1, 0, 0, 0, 0], [1440, 900], [1920, 1080]);
  assert.equal(1920 - r.x - r.w, 21);
  assert.deepEqual(M.anchorRect({ x: 0, y: 0, w: 1440, h: 900 }, [0, 1, 0, 1, 0], [1440, 900], [1920, 1080]), { x: 0, y: 0, w: 1920, h: 1080 });
});

test("localMatrix reproduces the cumulative viewport-space transform", () => {
  const flat = { x: 240, y: 120, w: 960, h: 65 };
  const m = [0.99027, -0.13917, 0.13917, 0.99027, -18.8882, 34.88565];
  const css = M.localMatrix(flat, m);
  const [a, b, c, d, e, f] = css.slice(7, -1).split(",").map(Number);
  // corner (x+w, y) through left/top + local matrix must equal m applied in viewport space
  const q = [flat.w, 0];
  const viaLocal = [flat.x + a * q[0] + c * q[1] + e, flat.y + b * q[0] + d * q[1] + f];
  const p = [flat.x + flat.w, flat.y];
  const viaM = [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  close(viaLocal[0], viaM[0], 1e-9); close(viaLocal[1], viaM[1], 1e-9);
});

test("adaptProjection keeps vertical FOV for viewport-tracking perspective cameras only", () => {
  const P = new Array(16).fill(0); P[0] = 1.2 / (1440 / 900); P[5] = 1.2; P[10] = -1.001; P[11] = -1; P[14] = -0.2;
  const out = M.adaptProjection(P, { type: "PerspectiveCamera", aspect: 1440 / 900 }, [1440, 900], [1920, 1080]);
  close(out[0], 1.2 / (1920 / 1080)); close(out[5], 1.2);
  assert.deepEqual(M.adaptProjection(P, { type: "PerspectiveCamera", aspect: 1 }, [1440, 900], [1920, 1080]), P);
  assert.deepEqual(M.adaptProjection(P, { type: "PerspectiveCamera", aspect: 1.6 }, [1440, 900], [1440, 900]), P);
});

test("resolution uniforms are detected and follow the window", () => {
  assert.equal(M.resolutionKind("uResolution", { $vec: [1440, 900] }, [1440, 900], 1), "px");
  assert.equal(M.resolutionKind("uTexel", { $vec: [1 / 1440, 1 / 900] }, [1440, 900], 1), "inv");
  assert.equal(M.resolutionKind("uRes", { $vec: [2880, 1800] }, [1440, 900], 2), "px-buf");
  assert.equal(M.resolutionKind("uAspect", 1.6, [1440, 900], 1), "aspect");
  assert.equal(M.resolutionKind("uColor", { $vec: [0.2, 0.3] }, [1440, 900], 1), null);
  assert.deepEqual(M.resolutionValue("px", [1920, 1080], 1), [1920, 1080]);
  assert.deepEqual(M.resolutionValue("px-buf", [1920, 1080], 2), [3840, 2160]);
});

test("mixValue interpolates numeric uniforms and leaves textures/flags alone", () => {
  assert.equal(M.mixValue(0, 10, 0.25), 2.5);
  assert.deepEqual(M.mixValue({ $vec: [0, 0, 0] }, { $vec: [2, 4, 6] }, 0.5), { $vec: [1, 2, 3] });
  assert.deepEqual(M.mixValue({ $tex: "a" }, { $tex: "b" }, 0.5), { $tex: "a" });
  assert.equal(M.mixValue(true, false, 0.9), true);
});

test("splitTransitions keeps motion out of the always-on list and expands 'all'", () => {
  const t = M.splitTransitions({ transitionProperty: "opacity, background-color", transitionDuration: "0.2s, 150ms", transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1), ease", transitionDelay: "0s, 0s" });
  assert.equal(t.paint, "background-color 150ms ease 0s");
  assert.match(t.full, /^opacity 0\.2s cubic-bezier\(0\.4, 0, 0\.2, 1\) 0s, background-color 150ms ease 0s$/);
  assert.equal(t.maxMs, 200);
  const all = M.splitTransitions({ transitionProperty: "all", transitionDuration: "0.25s", transitionTimingFunction: "ease", transitionDelay: "0s" });
  assert.match(all.paint, /background-color 0\.25s/);
  assert.doesNotMatch(all.paint, /transform|opacity/);
  assert.equal(M.splitTransitions({ transitionProperty: "all", transitionDuration: "0s" }).maxMs, 0);
});

test("docHeight follows the viewport dimension the target's height depends on", () => {
  const vh = [{ width: 1440, height: 900, scrollHeight: 9000 }, { width: 1920, height: 1080, scrollHeight: 10800 }];
  assert.equal(M.docHeight(vh, 1440, 900), 9000);
  close(M.docHeight(vh, 1920, 1200), 12000);
  const fixed = [{ width: 1440, height: 900, scrollHeight: 5000 }, { width: 1920, height: 1080, scrollHeight: 5000 }];
  assert.equal(M.docHeight(fixed, 2560, 1440), 5000);
  assert.equal(M.toCaptureScroll(500, 8100, 8100), 500);
  close(M.toCaptureScroll(1000, 8100, 16200), 500);
});

test("responsive fitter classifies anchoring from two viewports", () => {
  const A = { width: 1440, height: 900 }, B = { width: 1920, height: 1080 };
  assert.equal(fitRule({ x: 1299, y: 21, w: 120, h: 40, pinned: true }, A, { x: 1779, y: 21, w: 120, h: 40, pinned: true }, B).h, "right");
  assert.equal(fitRule({ x: 0, y: 0, w: 1440, h: 56, pinned: true }, A, { x: 0, y: 0, w: 1920, h: 56, pinned: true }, B).h, "stretch");
  const dock = fitRule({ x: 620, y: 846, w: 200, h: 30, pinned: true }, A, { x: 860, y: 1026, w: 200, h: 30, pinned: true }, B);
  assert.deepEqual([dock.h, dock.v], ["center", "bottom"]);
  const vw = fitRule({ x: 144, y: 0, w: 288, h: 10, fontSize: 57.6 }, A, { x: 192, y: 0, w: 384, h: 10, fontSize: 76.8 }, B);
  assert.equal(vw.h, "scale"); close(vw.kf, 0.04, 1e-4); assert.equal(vw.v, "flow");
  assert.equal(heuristicRule({ x: 1299, y: 21, w: 120, h: 40, pinned: true }, A).h, "right");
  const at = applyRule({ x: 1299, y: 21, w: 120, h: 40 }, { kx: 1, kw: 0, ky: 0, kh: 0, kf: 0 }, A, { width: 2560, height: 1080 });
  assert.equal(2560 - at.x - at.w, 21);
});
