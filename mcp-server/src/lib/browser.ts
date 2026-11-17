import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import { PATH_HELPER_INIT, PROFILE_HOOK_INIT } from "./page-helpers.js";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

/** Fixed capture geometry. Never change between target and local captures. */
export const VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * Cross-platform deterministic rendering flags.
 * SwiftShader gives software WebGL on machines without a GPU (CI, containers, Linux boxes).
 */
export const CHROMIUM_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-webgl",
  "--ignore-gpu-blocklist",
  "--enable-unsafe-swiftshader",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--force-device-scale-factor=1",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--disable-font-subpixel-positioning",
  "--no-sandbox",
];

export function log(...args: unknown[]): void {
  // stdout is reserved for the MCP stdio protocol.
  console.error("[pixel-clone]", ...args);
}

/** Launch bundled Chromium (reproducible); fall back to system Chrome. */
export async function launchBrowser(): Promise<Browser> {
  const base = { headless: true, args: CHROMIUM_ARGS };
  try {
    return await chromium.launch(base);
  } catch (bundledErr) {
    log("Bundled Chromium unavailable, trying system Chrome:", (bundledErr as Error).message.split("\n")[0]);
    try {
      return await chromium.launch({ ...base, channel: "chrome" });
    } catch (chromeErr) {
      throw new Error(
        "No usable browser. Run `npm run setup` in the pixel-clone skill directory (bundled Chromium) or install Google Chrome. " +
          `Bundled: ${(bundledErr as Error).message.split("\n")[0]} | Chrome: ${(chromeErr as Error).message.split("\n")[0]}`,
      );
    }
  }
}

/** Mobile emulation for a viewport pass (touch, mobile meta-viewport handling, mobile UA); DSF stays 1 for diffs. */
export const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
export async function newContext(
  browser: Browser,
  viewport: { width: number; height: number; mobile?: boolean } = VIEWPORT,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    ...(viewport.mobile ? { isMobile: true, hasTouch: true, userAgent: MOBILE_UA } : {}),
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    ignoreHTTPSErrors: true,
  });
  // Every tool gets the stable CSS-path helper and the passive profiling hooks (both idempotent).
  await ctx.addInitScript(PATH_HELPER_INIT);
  await ctx.addInitScript(PROFILE_HOOK_INIT);
  await installAssetCache(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// On-disk cache for static assets (models, KTX2 textures, images, fonts, bundles).
// Heavy sites download 100+ MB per load; the diff loop reloads the target every iteration.
// Disable with PIXEL_CLONE_NO_CACHE=1. Never caches localhost (the clone must always be live).
// ---------------------------------------------------------------------------------------------
const CACHEABLE = /\.(glb|gltf|ktx2|basis|drc|hdr|exr|bin|wasm|png|jpe?g|webp|avif|gif|svg|woff2?|ttf|otf|mp3|ogg|wav|css|js|mjs|json)$/i;

async function installAssetCache(ctx: BrowserContext): Promise<void> {
  if (process.env.PIXEL_CLONE_NO_CACHE) return;
  const dir = path.join(outRoot(), "_http-cache");
  await fs.mkdir(dir, { recursive: true });
  await ctx.route(
    (u) => !/^(localhost|127\.|\[::1\])/.test(u.hostname) && CACHEABLE.test(u.pathname),
    async (route) => {
      const req = route.request();
      if (req.method() !== "GET" || req.headers()["range"]) return route.continue();
      const key = createHash("sha1").update(req.url()).digest("hex");
      const metaFile = path.join(dir, `${key}.json`);
      const bodyFile = path.join(dir, `${key}.bin`);
      try {
        const meta = JSON.parse(await fs.readFile(metaFile, "utf8")) as { status: number; headers: Record<string, string> };
        return await route.fulfill({ status: meta.status, headers: meta.headers, body: await fs.readFile(bodyFile) });
      } catch {
        /* cache miss */
      }
      try {
        const res = await route.fetch({ timeout: 120_000 });
        const body = await res.body();
        const headers = { ...res.headers() };
        delete headers["content-encoding"]; // fetch() already decoded the body
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        if (res.status() === 200 && body.length > 0 && body.length < 80 * 1024 * 1024) {
          await fs.writeFile(bodyFile, body);
          await fs.writeFile(metaFile, JSON.stringify({ status: 200, headers }));
        }
        return await route.fulfill({ status: res.status(), headers, body });
      } catch {
        return route.continue().catch(() => undefined);
      }
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Interactive readiness: cookie banners, age gates, preloaders and "Enter" screens
// ---------------------------------------------------------------------------------------------

export interface ReadyOptions {
  /** CSS selector of an explicit "enter" control to click once visible (escape hatch for unusual gates). */
  entrySelector?: string;
  /** Auto-detect and dismiss blocking overlays (default true). */
  dismissOverlays?: boolean;
  /** How long to wait for `entrySelector` to appear (default 30 s). Use a short value for pages that may lack it. */
  entryTimeoutMs?: number;
  /** Budget for gates/preloaders (default 40 s). Extended automatically (up to 4x) while a loader's % keeps advancing. */
  readyTimeoutMs?: number;
  /** How long to wait for the window `load` event before moving on (default 12 s). */
  loadTimeoutMs?: number;
}

export interface ReadyAction {
  kind: "entrySelector" | "cookie" | "gate" | "gate-anywhere";
  selector: string;
  text: string;
  atMs: number;
}

export interface ReadyReport {
  ready: boolean;
  waitedMs: number;
  loadEvent: boolean;
  actions: ReadyAction[];
  waitedForPreloader: boolean;
  /** Present only when something still blocks the page at the deadline. */
  remainingBlocker: { kind: string; selector: string; text: string } | null;
}

interface Blocker {
  kind: "cookie" | "gate" | "loading" | "gate-anywhere";
  selector: string;
  text: string;
  progress: number | null;
  target: { selector: string; text: string; x: number; y: number } | null;
}

/** Runs in the page. Returns the single most important thing blocking the real page, or null. */
function detectBlocker(): Blocker | null {
  const w = window as unknown as { __pcPath: (e: Element) => string };
  const vw = innerWidth, vh = innerHeight;
  const COOKIE = /cookie|consent|gdpr|onetrust|cookiebot|didomi|usercentrics|osano|cc-window|cc-banner|privacy-banner|truste|iubenda|termly|cmp[-_]/i;
  const LOADER = /preload|loader|loading|intro|splash|boot|initiali[sz]/i;
  const ENTER = /\b(enter|start|begin|continue|explore|launch|play|access|proceed|skip|let'?s go|get started|click|tap|press|sound|experience|i am|yes|over 18|18\+|21\+|of age|agree)\b/i;
  const ENTER_ATTR = /enter|start|begin|continue|explore|skip|cta|audio|sound|play|launch|proceed|confirm|agree/i;
  const ACCEPT_BEST = /accept all|allow all|accept & close|agree to all|accept cookies|allow cookies/i;
  const ACCEPT = /accept|agree|allow|got it|\bok(ay)?\b|i understand|consent|understood/i;
  const REJECT = /reject|decline|deny|manage|settings|preferences|customi[sz]e|more options|necessary only/i;

  const visible = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  };
  const z = (el: Element) => { const n = parseInt(getComputedStyle(el).zIndex, 10); return Number.isNaN(n) ? 0 : n; };
  const label = (el: Element) => ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLInputElement).value || "").replace(/\s+/g, " ").trim();
  const ident = (el: Element) => `${el.id} ${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("role") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
  const alpha = (c: string) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return 0; const p = m[1]!.split(",").map(Number); return p.length > 3 ? (p[3] ?? 1) : 1; };
  const paints = (el: Element) => { const cs = getComputedStyle(el); return alpha(cs.backgroundColor) >= 0.6 || (cs.backgroundImage !== "none" && alpha(cs.backgroundColor) >= 0) || cs.backdropFilter !== "none"; };
  const opaqueOverlay = (el: Element) => {
    if (paints(el)) return true;
    for (const c of Array.from(el.children).slice(0, 12)) {
      const r = c.getBoundingClientRect();
      if (r.width * r.height >= vw * vh * 0.8 && paints(c)) return true;
    }
    return false;
  };
  const clickables = (root: Element) => {
    const out = new Set<Element>(root.querySelectorAll("button, a[href], [role=button], input[type=button], input[type=submit], [onclick], summary"));
    let n = 0;
    for (const e of Array.from(root.querySelectorAll("*"))) { if (++n > 500) break; if (getComputedStyle(e).cursor === "pointer") out.add(e); }
    return [...out].filter(visible);
  };
  const pick = (root: Element, mode: "cookie" | "gate") => {
    let best: { el: Element; score: number } | null = null;
    for (const el of clickables(root)) {
      const t = label(el), id = ident(el), r = el.getBoundingClientRect();
      if (r.width * r.height < 100) continue;
      let sc = 0;
      if (mode === "cookie") {
        if (REJECT.test(t)) continue;
        if (ACCEPT_BEST.test(t)) sc += 8; else if (ACCEPT.test(t)) sc += 5; else if (/close|dismiss|×|✕/i.test(t + id)) sc += 2;
        if (/accept|agree|allow/i.test(id)) sc += 2;
      } else {
        if (ENTER.test(t)) sc += 5;
        if (ENTER_ATTR.test(id)) sc += 3;
        if (/^(BUTTON|A)$/.test(el.tagName) || el.getAttribute("role") === "button") sc += 2;
        if (getComputedStyle(el).cursor === "pointer") sc += 1;
        if (t.length > 60) sc -= 2;
      }
      if (sc > 0 && (!best || sc > best.score)) best = { el, score: sc };
    }
    return best;
  };
  const target = (el: Element) => { const r = el.getBoundingClientRect(); return { selector: w.__pcPath(el), text: label(el).slice(0, 60), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };

  // 1) Full-screen overlays (preloaders, enter screens, age gates)
  const overlays: Element[] = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const cs = getComputedStyle(el);
    if (!/^(fixed|absolute|sticky)$/.test(cs.position) || cs.pointerEvents === "none" || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < vw * vh * 0.55) continue;
    if (/^(MAIN|HEADER|NAV|CANVAS|VIDEO)$/.test(el.tagName)) continue;
    const top = document.elementFromPoint(vw / 2, vh / 2);
    if (!top || !(el === top || el.contains(top))) continue;
    overlays.push(el);
  }
  overlays.sort((a, b) => z(b) - z(a));
  for (const ov of overlays) {
    const text = label(ov).slice(0, 300);
    const loaderish = LOADER.test(ident(ov)) || /loading|initiali[sz]/i.test(text);
    if (!loaderish && !opaqueOverlay(ov)) continue; // transparent UI containers are not gates
    const pm = /(\d{1,3})\s*%/.exec(text);
    const progress = pm ? Math.min(100, Number(pm[1])) : null;
    const best = pick(ov, "gate");
    const sel = w.__pcPath(ov);
    if (loaderish && progress !== null && progress < 100) return { kind: "loading", selector: sel, text: text.slice(0, 80), progress, target: null };
    if (best && best.score >= 3) return { kind: "gate", selector: sel, text: text.slice(0, 80), progress, target: target(best.el) };
    if (loaderish) return { kind: "loading", selector: sel, text: text.slice(0, 80), progress, target: null };
    if (/click|tap|press|enter/i.test(text) || getComputedStyle(ov).cursor === "pointer") {
      return { kind: "gate-anywhere", selector: sel, text: text.slice(0, 80), progress, target: { selector: sel, text: text.slice(0, 60), x: Math.round(vw / 2), y: Math.round(vh / 2) } };
    }
  }

  // 2) Cookie / consent banners (any size)
  const banners = Array.from(document.querySelectorAll("[role=dialog], [aria-modal=true], div, section, aside, form")).filter((el) => {
    const cs = getComputedStyle(el);
    if (!/^(fixed|sticky|absolute)$/.test(cs.position) || !visible(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 4000 || r.width * r.height > vw * vh * 0.9) return false;
    return COOKIE.test(ident(el)) || (/cookies?|consent/i.test(label(el).slice(0, 400)) && !!pick(el, "cookie"));
  });
  banners.sort((a, b) => z(b) - z(a));
  for (const b of banners) {
    const best = pick(b, "cookie");
    if (best) return { kind: "cookie", selector: w.__pcPath(b), text: label(b).slice(0, 80), progress: null, target: target(best.el) };
  }
  return null;
}

/**
 * Wait `ms`. In virtual-time mode this advances an EXACT number of frames (ms / 16.67), never "as many as fit in the
 * wall-clock time": frame counts must not depend on CPU load or the gate would make captures irreproducible.
 * Real time still passes between small batches so network/IO/real timers can interleave.
 */
async function pump(page: Page, ms: number): Promise<void> {
  const virtual = await page.evaluate(() => !!(window as unknown as { __pcVirtual?: boolean }).__pcVirtual).catch(() => false);
  if (!virtual) return page.waitForTimeout(ms);
  const total = Math.max(1, Math.round(ms / 16.667));
  for (let done = 0; done < total; ) {
    const n = Math.min(3, total - done);
    await page.evaluate((k) => (window as unknown as { __pcStep: (n: number) => number }).__pcStep(k), n).catch(() => undefined);
    done += n;
    await page.waitForTimeout(40);
  }
}

/**
 * Make sure the *real* page is visible: dismisses cookie banners, age gates and "Enter" screens, and waits
 * out preloaders. Conservative by design: only full-screen, painted (or loader-named) overlays with a
 * plausible entry control are clicked, never ordinary page UI.
 */
export async function waitForInteractiveReady(page: Page, opts: ReadyOptions = {}): Promise<ReadyReport> {
  const t0 = Date.now();
  const base = opts.readyTimeoutMs ?? 40_000;
  let deadline = t0 + base;
  const hardCap = t0 + Math.max(base * 4, 180_000);
  let bestProgress = -1;
  const actions: ReadyAction[] = [];
  const clicks = new Map<string, number>();
  let waitedForPreloader = false;
  let clear = 0;

  if (opts.entrySelector) {
    try {
      const loc = page.locator(opts.entrySelector).first();
      await loc.waitFor({ state: "visible", timeout: Math.min(opts.entryTimeoutMs ?? 30_000, deadline - Date.now()) });
      const box = await loc.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await loc.click({ timeout: 3000 });
      actions.push({ kind: "entrySelector", selector: opts.entrySelector, text: ((await loc.innerText().catch(() => "")) || "").slice(0, 60), atMs: Date.now() - t0 });
      await pump(page, 900);
    } catch (e) {
      log("entrySelector not clickable:", (e as Error).message.split("\n")[0]);
    }
  }

  if (opts.dismissOverlays !== false) {
    while (Date.now() < deadline) {
      const b = await page.evaluate(detectBlocker).catch(() => null);
      if (!b) {
        if (++clear >= 2) break;
        // No blocker: wait in REAL time. Pumping virtual frames here would make frame counts depend on wall-clock.
        await page.waitForTimeout(350);
        continue;
      }
      clear = 0;
      if (b.kind === "loading") {
        waitedForPreloader = true;
        // Adaptive budget: a preloader that is still advancing earns more time; a stalled one does not.
        if (b.progress !== null && b.progress > bestProgress) {
          bestProgress = b.progress;
          deadline = Math.min(hardCap, Math.max(deadline, Date.now() + 25_000));
        }
        await pump(page, 400);
        continue;
      }
      if (b.target) {
        const key = `${b.kind}:${b.target.selector}`;
        const n = clicks.get(key) ?? 0;
        if (n >= 3) { await pump(page, 400); continue; }
        clicks.set(key, n + 1);
        await page.mouse.click(b.target.x, b.target.y);
        actions.push({ kind: b.kind, selector: b.target.selector, text: b.target.text, atMs: Date.now() - t0 });
        await pump(page, 1000);
        continue;
      }
      await pump(page, 400);
    }
  }
  const remaining = opts.dismissOverlays === false ? null : await page.evaluate(detectBlocker).catch(() => null);
  return {
    ready: !remaining,
    waitedMs: Date.now() - t0,
    loadEvent: true,
    actions,
    waitedForPreloader,
    remainingBlocker: remaining ? { kind: remaining.kind, selector: remaining.selector, text: remaining.text } : null,
  };
}

/**
 * Navigate robustly: heavy sites (streamed audio/video, hundreds of textures) may never fire `load`, so we
 * wait for DOMContentLoaded, give `load`/network-idle a bounded chance, then clear gates and settle.
 */
export async function gotoAndSettle(page: Page, url: string, settleMs = 1000, opts: ReadyOptions = {}): Promise<ReadyReport> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const loadEvent = await page
    .waitForLoadState("load", { timeout: opts.loadTimeoutMs ?? 12_000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready.then(() => undefined)).catch(() => undefined);
  await page
    .evaluate(() =>
      Promise.race([
        Promise.all(Array.from(document.images).map((i) => (i.complete ? null : i.decode().catch(() => null)))),
        new Promise((r) => setTimeout(r, 4000)),
      ]).then(() => undefined),
    )
    .catch(() => undefined);
  const report = await waitForInteractiveReady(page, opts);
  report.loadEvent = loadEvent;
  // Only advance virtual frames if a gate/preloader forced the page to run; otherwise keep it held (deterministic).
  if (settleMs > 0) await (report.actions.length || report.waitedForPreloader ? pump(page, settleMs) : page.waitForTimeout(settleMs));
  return report;
}

/** Scroll the full page once to trigger lazy loading / IntersectionObservers, then return to top. */
/** Scrolls through the page to trigger lazy content. Returns the deepest scrollY actually reached (scroll-locked
 * intros stay at 0), so callers know whether the page has been "visited deep" (once-only intros fire on that). */
export async function primeLazyContent(page: Page): Promise<number> {
  return page
    .evaluate(async () => {
      const vh = window.innerHeight;
      const max = () => document.documentElement.scrollHeight;
      let deepest = 0;
      for (let y = 0, n = 0; y < max() && n < 60; y += Math.round(vh * 0.8), n++) {
        window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
        await new Promise((r) => setTimeout(r, 120));
        deepest = Math.max(deepest, window.scrollY);
      }
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      await new Promise((r) => setTimeout(r, 200));
      return deepest;
    })
    .catch(() => 0);
}

export function outRoot(): string {
  return process.env.PIXEL_CLONE_OUT ?? path.resolve(process.cwd(), ".clone-output");
}

export function slugify(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page";
  } catch {
    return "page";
  }
}

export async function ensureDir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
