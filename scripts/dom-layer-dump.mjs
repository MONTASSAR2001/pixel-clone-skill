#!/usr/bin/env node
/**
 * DOM layer snapshot per scroll position (generic).
 *
 *   node scripts/dom-layer-dump.mjs <url> <outDir> <y1> [y2 ...] [--exclude "<css>,<css>"] [--mouse x,y] [--wait ms]
 *        [--click x,y --state <name>]   capture an interactive state (menu, modal) after clicking at x,y -> dom-state-<name>.json
 *        [--viewports 1440x900,1920x1080]  one replay variant per viewport (<outDir>/<W>x<H>/ when more than one); the
 *                                          clone picks the closest variant and fits per-box anchoring across variants
 *
 * For each scroll position, records every VISIBLE painting element as a box in viewport coordinates: rect, the clip
 * rect inherited from overflow/clip ancestors (split-text reveal masks), effective opacity, paint + typography styles,
 * own text (text-node line fragments for mixed content), <img>/<video> sources, inline <svg> markup and CSS
 * background images. Each box is tagged with its section (closest section/header/footer/nav or top-level layer) and a
 * stacking key, so a clone can render the scroll-driven UI exactly as the target shows it at that position.
 */
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newContext, gotoAndSettle } from "../mcp-server/dist/lib/browser.js";
import { DOM_SNAPSHOT } from "./lib/replay-serializers.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [url, outDir, ...ysRaw] = pos;
const ys = ysRaw.map(Number);
if (!url || !outDir || !ys.length) { console.error("usage: dom-layer-dump.mjs <url> <outDir> <y...> [--exclude css,css] [--mouse x,y] [--wait ms]"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const exclude = String(opt("exclude", "canvas")).split(",").map((s) => s.trim()).filter(Boolean);

const SNAPSHOT = DOM_SNAPSHOT;

const viewports = String(opt("viewports", "1440x900")).split(",").map((v) => { const [width, height] = v.split("x").map(Number); return { width, height }; });
const browser = await launchBrowser();
for (const vp of viewports) {
  const dir = viewports.length > 1 ? path.join(outDir, `${vp.width}x${vp.height}`) : outDir;
  fs.mkdirSync(dir, { recursive: true });
  await dumpViewport(vp, dir);
}
await browser.close();

async function dumpViewport(vp, dir) {
const ctx = await newContext(browser, vp);
const page = await ctx.newPage();
await gotoAndSettle(page, url, 3000, { readyTimeoutMs: 150000 });
// Default pointer = bottom-right corner, where compare_visual_diff parks it.
const [mx, my] = String(opt("mouse", `${vp.width - 1},${vp.height - 1}`)).split(",").map(Number);
await page.mouse.move(mx, my);
const wait = Number(opt("wait", 3000));
const assets = new Set();
for (const y of ys) {
  for (let k = 0; k < 60; k++) {
    await page.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" }), y);
    await page.waitForTimeout(k === 0 ? 1000 : 1500);
    if (Math.abs((await page.evaluate(() => window.scrollY)) - y) < 2) break;
  }
  await page.waitForTimeout(wait);
  // Settle until the visible DOM stops changing (scroll-triggered transitions run for seconds).
  let d = await page.evaluate(`(${SNAPSHOT})(${JSON.stringify(exclude)})`);
  const key = (x) => x.boxes.map((b) => `${b.key}${Math.round(b.rect.x)},${Math.round(b.rect.y)},${Math.round(b.rect.w)},${Math.round(b.rect.h)}:${b.opacity}:${b.text ?? ""}`).join("|");
  for (let k = 0, stable = 0; k < 15 && stable < 2; k++) {
    await page.waitForTimeout(1000);
    const d2 = await page.evaluate(`(${SNAPSHOT})(${JSON.stringify(exclude)})`);
    stable = key(d2) === key(d) ? stable + 1 : 0;
    d = d2;
  }
  for (const b of d.boxes) {
    if (b.src) assets.add(b.src);
    if (b.poster) assets.add(b.poster);
    for (const m of (b.styles.backgroundImage || "").matchAll(/url\("?([^")]+)"?\)/g)) assets.add(m[1]);
  }
  const click = opt("click"), stateName = opt("state");
  if (click && stateName) {
    const [cx, cy] = click.split(",").map(Number);
    await page.mouse.move(cx, cy, { steps: 4 });
    await page.mouse.click(cx, cy);
    let s = await page.evaluate(`(${SNAPSHOT})(${JSON.stringify(exclude)})`);
    for (let k = 0, stable = 0; k < 15 && stable < 2; k++) { await page.waitForTimeout(1000); const s2 = await page.evaluate(`(${SNAPSHOT})(${JSON.stringify(exclude)})`); stable = JSON.stringify(s2.boxes.map((b) => [b.rect, b.opacity])) === JSON.stringify(s.boxes.map((b) => [b.rect, b.opacity])) ? stable + 1 : 0; s = s2; }
    s.click = { x: cx, y: cy, scrollY: y };
    fs.writeFileSync(path.join(dir, `dom-state-${stateName}.json`), JSON.stringify(s));
    console.log(`[${vp.width}x${vp.height}] state ${stateName} after click at ${cx},${cy} (scrollY ${y}): ${s.boxes.length} boxes`);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.mouse.click(cx, cy);
    await page.mouse.move(mx, my);
    continue;
  }
  fs.writeFileSync(path.join(dir, `dom-y-${y}.json`), JSON.stringify(d));
  const secs = [...new Set(d.boxes.map((b) => b.section))];
  console.log(`[${vp.width}x${vp.height}] y=${y} (scrollY ${d.y}): ${d.boxes.length} boxes, ${d.boxes.filter((b) => b.text || b.fragments).length} text, ${d.boxes.filter((b) => b.src).length} media, ${d.boxes.filter((b) => b.xf).length} transformed, ${d.boxes.filter((b) => b.pseudo).length} pseudo, sections: ${secs.slice(0, 6).join(", ")}`);
}
fs.writeFileSync(path.join(dir, "dom-assets.json"), JSON.stringify([...assets].filter((u) => !u.startsWith("data:")), null, 1));
fs.writeFileSync(path.join(dir, "replay-index.json"), JSON.stringify({ scene: [], dom: fs.readdirSync(dir).filter((f) => /^dom-(y-\d+|state-[\w-]+)\.json$/.test(f)).map((f) => f.slice(4, -5)), meta: { viewport: [vp.width, vp.height], dpr: 1 } }, null, 1));
await ctx.close();
}
