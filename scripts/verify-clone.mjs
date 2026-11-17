#!/usr/bin/env node
/**
 * Runtime verification of a replay-based clone (complements compare_visual_diff, which measures pixels):
 *
 *   node scripts/verify-clone.mjs <url> [--viewports 1440x900,1920x1080,2560x1080] [--gpu] [--out report.json]
 *
 * Per viewport:
 *  - load:       ms from navigation to the first WebGL hero frame and to the first DOM-layer keyframe (window.__replay)
 *  - hero:       the page opens on keyframe y=0 with no replay state active (not a post-scroll "top-return")
 *  - fullBleed:  the canvas covers the whole window, fixed DOM layers span it, and the right/bottom 15% bands of the
 *                screenshot are not an empty flat colour (no shrunken composition in a corner)
 *  - scroll:     a continuous wheel scroll across keyframes; frame intervals (fps), JS cost per drawn frame, and how many
 *                distinct interpolated states were drawn between two keyframes (0 = stepped/snapping)
 *  - topReturn:  after scrolling >1.5 viewports and back, which state shows (top-return only if the data has one)
 * --gpu launches Chromium with hardware GL (frame-rate numbers on a real GPU); default is the deterministic
 * SwiftShader software renderer used by the diff, where fps reflects the CPU rasteriser, not the clone.
 */
import fs from "node:fs";
import { chromium } from "playwright";
import { launchBrowser } from "../mcp-server/dist/lib/browser.js";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const url = args.find((a) => !a.startsWith("--") && !/^\d+x\d+/.test(a) && a !== opt("out"));
if (!url) { console.error("usage: verify-clone.mjs <url> [--viewports WxH,...] [--gpu] [--out file]"); process.exit(2); }
const viewports = String(opt("viewports", "1440x900,1920x1080")).split(",").map((v) => v.split("x").map(Number));
const gpu = args.includes("--gpu");
const browser = gpu
  ? await chromium.launch({ headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-webgl"] })
  : await launchBrowser();

const results = [];
for (const [width, height] of viewports) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const t0 = Date.now();
  // How many hero UI boxes arrive in the server HTML (painted before any script runs).
  await page.addInitScript(() => { document.addEventListener("DOMContentLoaded", () => { window.__ssrHeroBoxes = document.querySelectorAll('[data-replay-layer="static"] [data-key]').length; }); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__replay && (window.__replay.heroMs !== null || window.__replay.error), null, { timeout: 120000 }).catch(() => undefined);
  await page.waitForFunction(() => window.__replay && window.__replay.domHeroMs !== null, null, { timeout: 30000 }).catch(() => undefined);
  await page.waitForFunction(() => window.__replay && window.__replay.heroCompleteMs != null, null, { timeout: 60000 }).catch(() => undefined);
  const load = await page.evaluate(() => ({ fcpMs: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1), ssrHeroBoxes: window.__ssrHeroBoxes ?? null, heroMs: window.__replay?.heroMs ?? null, heroCompleteMs: window.__replay?.heroCompleteMs ?? null, domHeroMs: window.__replay?.domHeroMs ?? null, keyframe: window.__replay?.keyframe ?? null, error: window.__replay?.error ?? null, stages: window.__replay?.stages ?? null, renderer: (() => { const c = document.createElement("canvas").getContext("webgl2"); const d = c && c.getExtension("WEBGL_debug_renderer_info"); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; })() }));
  const hero = await page.evaluate(() => ({ scrollY: scrollY, keyframe: window.__replay?.keyframe, state: document.documentElement.dataset.replayState ?? null }));
  await page.waitForTimeout(1500);
  // full-bleed
  const geo = await page.evaluate(() => {
    const c = document.querySelector("canvas"); const r = c ? c.getBoundingClientRect() : null;
    const layers = [...document.querySelectorAll("[data-key]")].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
    const maxRight = layers.reduce((m, b) => Math.max(m, b.right), 0), maxBottom = layers.reduce((m, b) => Math.max(m, b.bottom), 0);
    return { canvas: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, vw: innerWidth, vh: innerHeight, domBoxes: layers.length, domMaxRight: Math.round(maxRight), domMaxBottom: Math.round(maxBottom), docHeight: document.documentElement.scrollHeight };
  });
  const shot = await page.screenshot({ type: "png" });
  const { PNG } = await import("pngjs");
  const img = PNG.sync.read(shot);
  const band = (x0, y0, x1, y1) => {
    let n = 0, sum = [0, 0, 0], sq = 0; const first = [img.data[(y0 * img.width + x0) * 4], img.data[(y0 * img.width + x0) * 4 + 1], img.data[(y0 * img.width + x0) * 4 + 2]];
    let differing = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * img.width + x) * 4; n++; if (Math.abs(img.data[i] - first[0]) + Math.abs(img.data[i + 1] - first[1]) + Math.abs(img.data[i + 2] - first[2]) > 12) differing++; }
    return Math.round((differing / n) * 1000) / 10;
  };
  const rightBand = band(Math.floor(width * 0.85), 0, width, height), bottomBand = band(0, Math.floor(height * 0.85), width, height);
  const fullBleed = !!geo.canvas && geo.canvas.x === 0 && geo.canvas.y === 0 && Math.abs(geo.canvas.w - width) < 1 && Math.abs(geo.canvas.h - height) < 1;
  // scroll: continuous wheel input across the first keyframe gap
  const scroll = await page.evaluate(async () => {
    const frames = []; const states = new Set(); let last = performance.now(); const t0 = last;
    const drawn0 = window.__replay?.frames ?? 0;
    await new Promise((res) => {
      const tick = (now) => { frames.push(now - last); last = now; const k = window.__replay?.keyframe; if (k !== undefined && k !== null) states.add(String(k)); if (now - t0 < 3000) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick);
      let y = 0; const step = () => { y += 12; window.scrollTo(0, y); if (y < innerHeight * 1.2 && performance.now() - t0 < 2500) setTimeout(step, 16); }; step();
    });
    frames.shift();
    const sorted = frames.slice().sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { rafFrames: frames.length, fpsMedian: Math.round(1000 / p(0.5)), frameMsP95: Math.round(p(0.95) * 10) / 10, drawnFrames: (window.__replay?.frames ?? 0) - drawn0, jsCostPerDrawMs: window.__replay?.frameCostMs ?? null, interpolatedStates: [...states].filter((s) => s.includes("~")).length, sampleStates: [...states].slice(0, 6) };
  });
  // top-return behaviour
  await page.evaluate(() => window.scrollTo(0, innerHeight * 2.2)); await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({ keyframe: window.__replay?.keyframe ?? null }));
  results.push({
    viewport: `${width}x${height}`, wallMs: Date.now() - t0, load, hero, geometry: geo,
    fullBleed: { canvasCoversWindow: fullBleed, nonFlatRightBandPct: rightBand, nonFlatBottomBandPct: bottomBand },
    scroll, topReturn: after, errors: errors.slice(0, 10),
  });
  console.log(`${width}x${height} [${load.renderer}]: FCP ${load.fcpMs}ms (SSR hero boxes ${load.ssrHeroBoxes}) webgl hero ${load.heroMs}ms complete ${load.heroCompleteMs}ms (dom live ${load.domHeroMs}ms) stages=${JSON.stringify(load.stages)} keyframe@load=${hero.keyframe} canvasFull=${fullBleed} rightBand=${rightBand}% bottomBand=${bottomBand}% fps~${scroll.fpsMedian} p95=${scroll.frameMsP95}ms drawCost=${scroll.jsCostPerDrawMs}ms interpolated=${scroll.interpolatedStates} afterReturn=${after.keyframe} errors=${errors.length}`);
  await ctx.close();
}
await browser.close();
const out = opt("out");
if (out) fs.writeFileSync(out, JSON.stringify({ url, gpu, results }, null, 2));
