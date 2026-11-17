#!/usr/bin/env node
/**
 * Three.js scene dump for faithful replay (generic: works on any site rendering with three.js).
 *
 *   node scripts/three-scene-dump.mjs <url> <outDir> <y1> [y2 ...] [--entry <css>] [--wait 3000]
 *
 * --mouse x,y  pointer position during the dump (default: bottom-right corner = where compare_visual_diff parks it;
 *              parallax scenes depend on it).
 * --viewports 1440x900,1920x1080  one replay variant per viewport (<outDir>/<W>x<H>/ when more than one).
 * For each scroll position: records one complete frame of renderer calls (render / clear / viewport / scissor with
 * scene, camera and render target), then serializes every scene, camera, material (exact compiled GLSL from the GL
 * hook + uniforms + state), geometry (de-interleaved buffers) and texture identity (image URL, glTF texture name,
 * video URL, canvas/data pixels). Static data (geometry, programs, textures) goes to static.json + geometry.bin;
 * per-position state (passes, transforms, uniforms, cameras) to y-<y>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newContext, gotoAndSettle } from "../mcp-server/dist/lib/browser.js";
import { WEBGL_HOOK_INIT } from "../mcp-server/dist/tools/inspectWebglScene.js";
import { SCENE_SERIALIZE } from "./lib/replay-serializers.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [url, outDir, ...ysRaw] = pos;
const ys = ysRaw.map(Number);
if (!url || !outDir || !ys.length) { console.error("usage: three-scene-dump.mjs <url> <outDir> <y...> [--entry css] [--wait ms]"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const SERIALIZE = SCENE_SERIALIZE;

const viewports = String(opt("viewports", "1440x900")).split(",").map((v) => { const [width, height] = v.split("x").map(Number); return { width, height }; });
const browser = await launchBrowser();
for (const vp of viewports) {
  const dir = viewports.length > 1 ? path.join(outDir, `${vp.width}x${vp.height}`) : outDir;
  fs.mkdirSync(dir, { recursive: true });
  await dumpViewport(vp, dir);
}
await browser.close();

async function dumpViewport(vp, outDir) {
const ctx = await newContext(browser, vp);
await ctx.addInitScript(WEBGL_HOOK_INIT);
const page = await ctx.newPage();
await gotoAndSettle(page, url, 3000, { entrySelector: opt("entry"), readyTimeoutMs: 150000 });
const wait = Number(opt("wait", 3000));
const [mx, my] = String(opt("mouse", `${vp.width - 1},${vp.height - 1}`)).split(",").map(Number);
await page.mouse.move(mx, my);
const statics = { textures: {}, materials: {}, geometries: {}, programs: {}, renderTargets: {} };
const geoBin = [];
let geoOffset = 0;
for (const y of ys) {
  let got = 0;
  for (let k = 0; k < 60; k++) {
    await page.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" }), y);
    await page.waitForTimeout(k === 0 ? 1000 : 1500);
    got = await page.evaluate(() => Math.round(window.scrollY));
    if (Math.abs(got - y) < 2) break;
  }
  await page.waitForTimeout(wait);
  // A renderer must exist before recording (scripts loaded from a CDN can be slow).
  for (let k = 0; k < 40 && !(await page.evaluate(() => !!(window.__pcGL && window.__pcGL.renderers.length))); k++) await page.waitForTimeout(500);
  // Settle until the scene state stops changing (scroll-triggered transitions run for seconds).
  const sig = () => page.evaluate(() => { const g = window.__pcGL; const c = g.last && g.last.camera; const sc = g.last && g.last.scene; let n = 0, acc = 0; if (sc) sc.traverse((o) => { if (o.visible) { n++; acc += o.matrixWorld.elements[12] + o.matrixWorld.elements[13] * 3; } }); return [n, Math.round(acc * 100), c ? Math.round(c.matrixWorld.elements[13] * 1000) : 0, Object.keys(g.sceneById || {}).length].join(":"); });
  let prev = await sig(), stable = 0;
  for (let k = 0; k < 15 && stable < 2; k++) { await page.waitForTimeout(1000); const s2 = await sig(); stable = s2 === prev ? stable + 1 : 0; prev = s2; }
  const d = await page.evaluate(`(${SERIALIZE})(${JSON.stringify({ recordMs: 2000, maxRecordMs: 20000 })})`);
  // Merge static registries; move geometry buffers into one binary file.
  for (const [k, g] of Object.entries(d.S.geometries)) {
    if (statics.geometries[k]) continue;
    for (const a of [...Object.values(g.attributes), ...(g.index ? [g.index] : [])]) {
      const buf = Buffer.from(a.b64, "base64"); delete a.b64; a.offset = geoOffset; a.bytes = buf.length; geoBin.push(buf); geoOffset += buf.length;
      const pad = (4 - (geoOffset % 4)) % 4; if (pad) { geoBin.push(Buffer.alloc(pad)); geoOffset += pad; }
    }
    statics.geometries[k] = g;
  }
  for (const key of ["textures", "materials", "programs", "renderTargets"]) Object.assign(statics[key], d.S[key], statics[key]);
  delete d.S;
  fs.writeFileSync(path.join(outDir, `y-${y}.json`), JSON.stringify(d));
  const renders = d.passes.filter((p) => p.op === "render");
  console.log(`y=${y} (scrollY ${d.y}): ${d.framesRecorded} frames, pass list ${d.passes.length} ops / ${renders.length} renders, scenes ${Object.keys(d.scenes).length}, cameras ${Object.keys(d.cameras).length}`);
}
fs.writeFileSync(path.join(outDir, "geometry.bin"), Buffer.concat(geoBin));
fs.writeFileSync(path.join(outDir, "static.json"), JSON.stringify(statics));
const kinds = {}; for (const t of Object.values(statics.textures)) kinds[t.kind] = (kinds[t.kind] || 0) + 1;
console.log(`static: ${Object.keys(statics.geometries).length} geometries (${(geoOffset / 1e6).toFixed(1)} MB), ${Object.keys(statics.materials).length} materials, ${Object.keys(statics.programs).length} programs, textures ${JSON.stringify(kinds)}, render targets ${Object.keys(statics.renderTargets).length}`);
await ctx.close();
}
