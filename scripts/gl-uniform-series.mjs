#!/usr/bin/env node
/**
 * Measure how GL uniforms evolve frame by frame on the target's deterministic virtual clock.
 *   node scripts/gl-uniform-series.mjs <url> <frames> <out.json> [--entry <css>] [--match name=substring ...]
 * Each --match names a program by a substring of its fragment source (e.g. --match sprite=uFrame).
 * Output: { startFrame, frames: [{ k, changed: { <name>: { uniform: value } }, draws: { <name>: n } }] } (delta-encoded).
 */
import fs from "node:fs";
import { launchBrowser, newContext, gotoAndSettle } from "../mcp-server/dist/lib/browser.js";
import { VIRTUAL_TIME_INIT } from "../mcp-server/dist/lib/page-helpers.js";
import { WEBGL_HOOK_INIT } from "../mcp-server/dist/tools/inspectWebglScene.js";

const args = process.argv.slice(2);
const [url, framesArg, out] = args;
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const matches = Object.fromEntries(args.flatMap((a, i) => (a === "--match" ? [args[i + 1].split("=")] : [])));
if (!url || !framesArg || !out || !Object.keys(matches).length) {
  console.error("usage: gl-uniform-series.mjs <url> <frames> <out.json> --match name=substring [--match ...] [--entry css]");
  process.exit(2);
}
const browser = await launchBrowser();
const ctx = await newContext(browser);
await ctx.addInitScript(VIRTUAL_TIME_INIT);
await ctx.addInitScript(WEBGL_HOOK_INIT);
const page = await ctx.newPage();
const gates = await gotoAndSettle(page, url, 1500, { entrySelector: opt("entry"), readyTimeoutMs: 150000 });
const startFrame = await page.evaluate(() => window.__pcFrames);
const N = Number(framesArg);
const result = { url, startFrame, gates: { actions: gates.actions.length, waitedForPreloader: gates.waitedForPreloader }, matches, frames: [] };
let prev = {}, prevDraws = {};
for (let k = 1; k <= N; k++) {
  const snap = await page.evaluate(({ m }) => {
    window.__pcStep(1);
    const out = { u: {}, d: {} };
    for (const [name, sub] of Object.entries(m)) {
      const p = window.__pcGL.programs.find((q) => q.shaders.some((s) => s.stage === "fragment" && s.source.includes(sub)));
      if (p) { out.u[name] = JSON.parse(JSON.stringify(p.uniforms)); out.d[name] = p.draws; }
    }
    return out;
  }, { m: matches });
  const changed = {}, draws = {};
  for (const [name, u] of Object.entries(snap.u)) {
    for (const [k2, v] of Object.entries(u)) if (JSON.stringify(prev[name]?.[k2]) !== JSON.stringify(v)) (changed[name] ??= {})[k2] = v;
    const dd = snap.d[name] - (prevDraws[name] ?? snap.d[name]);
    if (dd) draws[name] = dd;
  }
  prev = snap.u; prevDraws = snap.d;
  result.frames.push({ k, changed, draws });
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(`wrote ${out}: ${N} frames, startFrame=${startFrame}, programs=${Object.keys(matches).join(",")}`);
await browser.close();
