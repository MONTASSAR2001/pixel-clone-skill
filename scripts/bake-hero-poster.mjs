#!/usr/bin/env node
/**
 * Bake the hero poster of a replay clone: renders the clone's OWN hero (y-0 keyframe, all textures loaded) at each
 * captured viewport variant and saves the canvas as public/replay/<variant>/hero-poster.webp. ReplayPreload shows it
 * at first paint and ThreeReplay cross-fades to the live render once the hero is complete (progressive loading: a
 * visually complete hero in the first paint, the live scene within seconds). Rebuild the clone afterwards (Next only
 * serves public files present at build time).
 *
 *   node scripts/bake-hero-poster.mjs <cloneUrl> <cloneDir> [--gpu] [--quality 0.9]
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { launchBrowser } from "../mcp-server/dist/lib/browser.js";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const [url, app] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && args[i - 1] !== "--gpu"));
if (!url || !app) { console.error("usage: bake-hero-poster.mjs <cloneUrl> <cloneDir> [--gpu] [--quality 0.9]"); process.exit(2); }
const root = path.join(app, "public/replay");
const variants = JSON.parse(fs.readFileSync(path.join(root, "viewports.json"), "utf8"));
const browser = args.includes("--gpu") ? await chromium.launch({ headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist"] }) : await launchBrowser();
for (const v of variants) {
  const out = path.join(root, v.base, "hero-poster.webp");
  fs.rmSync(out, { force: true }); // never bake a poster on top of a poster
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__replay?.heroCompleteMs != null || window.__replay?.error, null, { timeout: 180000 });
  await page.waitForTimeout(1000);
  const dataUrl = await page.evaluate((q) => { const c = window.__replayDraw(); return c.toDataURL("image/webp", q); }, Number(opt("quality", "0.9")));
  fs.writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`${v.width}x${v.height}: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  await ctx.close();
}
await browser.close();
