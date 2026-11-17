#!/usr/bin/env node
// Downloads Playwright's bundled Chromium for reproducible rendering.
// Never fails the install: the server falls back to system Chrome at runtime.
import { spawnSync } from "node:child_process";

if (process.env.PIXEL_CLONE_SKIP_BROWSER_DOWNLOAD) {
  console.log("[pixel-clone] PIXEL_CLONE_SKIP_BROWSER_DOWNLOAD set; skipping Chromium download.");
  process.exit(0);
}
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const r = spawnSync(npx, ["playwright", "install", "chromium"], { stdio: "inherit", shell: process.platform === "win32" });
if (r.status !== 0) {
  console.warn("[pixel-clone] Chromium download failed. The server will fall back to system Chrome (channel: chrome). Run `npx playwright install chromium` manually to retry.");
}
process.exit(0);
