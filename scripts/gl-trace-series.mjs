#!/usr/bin/env node
/**
 * Exact per-frame GL draw records on the target's virtual clock (continuous frame trace).
 *   node scripts/gl-trace-series.mjs <url> <frames> <out.json> --match name=substring [--match ...] [--entry css]
 * For every frame and every named program, records the uniforms the program had AT ITS DRAW in that frame
 * (more reliable than snapshotting program state, which a second draw of the same program can overwrite).
 * Output: { startFrame, frames: [{ k, draws: { name: [ { fb, uniforms } ] } }] } (uniform values full, per draw).
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
  console.error("usage: gl-trace-series.mjs <url> <frames> <out.json> --match name=substring [--match ...] [--entry css]");
  process.exit(2);
}
const browser = await launchBrowser();
const ctx = await newContext(browser);
await ctx.addInitScript(VIRTUAL_TIME_INIT);
await ctx.addInitScript(WEBGL_HOOK_INIT);
const page = await ctx.newPage();
const gates = await gotoAndSettle(page, url, 1500, { entrySelector: opt("entry"), readyTimeoutMs: 150000 });
const startFrame = await page.evaluate(() => window.__pcFrames);
await page.evaluate(() => window.__pcTraceArm(true));
const N = Number(framesArg);
for (let k = 0; k < N + 1; k++) await page.evaluate(() => window.__pcStep(1)); // +1: the first frame only arms the trace
const trace = await page.evaluate(() => window.__pcTrace());
const progNames = await page.evaluate((m) => Object.fromEntries(Object.entries(m).map(([name, sub]) => [name, window.__pcGL.programs.filter((q) => q.shaders.some((s) => s.stage === "fragment" && s.source.includes(sub))).map((q) => q.id)])), matches);
const idToName = {};
for (const [n, ids] of Object.entries(progNames)) for (const id of ids) idToName[id] = n;

// Segment by frame: a frame ends at the draw of the LAST named pass that reaches the screen (fb === null).
const frames = [];
let cur = { k: 1, order: [], draws: {} };
const screenName = Object.keys(matches).at(-1); // convention: list the final/screen pass last
for (const op of trace.ops) {
  if (op.op !== "draw") continue;
  const name = idToName[op.program];
  if (!name) continue;
  const rec = { fb: op.fb, uniforms: op.uniforms, textures: Object.fromEntries(Object.entries(op.textures).map(([u, id]) => [u, trace.textures[id]?.sourceUrl ?? id])) };
  (cur.draws[name] ??= []).push(rec);
  cur.order.push(name);
  if (name === screenName && op.fb === null) { frames.push(cur); cur = { k: frames.length + 1, order: [], draws: {} }; }
}
fs.writeFileSync(out, JSON.stringify({ url, startFrame, gates: { actions: gates.actions.length, waitedForPreloader: gates.waitedForPreloader }, matches, programIds: progNames, frames }));
const per = Object.fromEntries(Object.keys(matches).map((n) => [n, frames.reduce((a, f) => a + (f.draws[n]?.length ?? 0), 0)]));
console.log(`wrote ${out}: ${frames.length} frames, startFrame=${startFrame}, draws by program ${JSON.stringify(per)}`);
await browser.close();
