import path from "node:path";
import fs from "node:fs/promises";
import pixelmatch from "pixelmatch";
import type { Page } from "playwright";
import { launchBrowser, newContext, gotoAndSettle, primeLazyContent, outRoot, ensureDir, timestamp, VIEWPORT, log, type ReadyOptions } from "../lib/browser.js";
import { VIRTUAL_TIME_INIT } from "../lib/page-helpers.js";
import { WEBGL_HOOK_INIT } from "./inspectWebglScene.js";
import { decodePng, writePng, PNG } from "../lib/png.js";
import { createHash } from "node:crypto";

export interface Viewport {
  width: number;
  height: number;
  /** Mobile emulation (touch, isMobile, mobile UA), e.g. { width: 390, height: 844, mobile: true }. */
  mobile?: boolean;
}

/** An interactive state captured after the slices: menus, modals, hovers, tabs... */
export interface Interaction {
  name: string;
  /** Scroll position to go to first (default 0). */
  scrollY?: number;
  /** Hover this selector (resolved on the TARGET; the same coordinates are used on the clone). */
  hover?: string;
  /** Click this selector (resolved on the TARGET; same coordinates on the clone). */
  click?: string;
  /** Press a key after the action, e.g. "Escape". */
  press?: string;
  waitMs?: number;
}

export interface CompareInput extends ReadyOptions {
  targetUrl: string;
  localUrl: string;
  viewports?: Viewport[];
  /**
   * Pause every playing <video> right before each capture (dump + screenshot see the same frame) and resume it after
   * (default true). Replay clones read `window.__pcVisualDiff` and hold their videos at the recorded time.
   */
  freezeMedia?: boolean;
  /**
   * "fullpage" (default): slice the ENTIRE scroll height into consecutive viewport-height captures, plus hover,
   * auto-detected menu and `interactions` states. "states": legacy 5 snapshots (top / 25% / 50% / hover / bottom),
   * only for quick checks; it can never prove a full clone.
   */
  mode?: "fullpage" | "states";
  /** Max vertical slices (default 20, up to 60). Taller pages get evenly spaced slices over the full height (`sampled: true`). */
  maxSlices?: number;
  /** Distance between slices in px (default: viewport height, i.e. no gaps). */
  sliceStep?: number;
  /**
   * For virtual scrollers (document does not scroll, wheel input drives a transformed wrapper): the scroll length to
   * slice, in wheel px. Without it a wheel-driven page yields a single slice and the report carries a coverage warning.
   */
  virtualScrollHeight?: number;
  /** Wait after each scroll before capturing (default min(settleMs, 800)). Raise for scroll-driven animation that eases in. */
  sliceWaitMs?: number;
  /**
   * After each scroll, wait until the visible DOM stops changing (scroll-triggered transitions run for seconds), up to
   * this long (default 10000; 0 disables). Checked with a cheap DOM signature, so GL-heavy pages are not slowed down.
   */
  stableTimeoutMs?: number;
  /** Intros often lock scrolling for a while: keep probing until scrollTo works, up to this long (default 20000). */
  scrollUnlockTimeoutMs?: number;
  /** Max relative difference of document scrollHeight for a pass (default 0.02 = 2%). */
  heightTolerance?: number;
  /** Extra interactive states (menus, modals, tabs). */
  interactions?: Interaction[];
  /** Auto-detect a menu toggle (burger / aria-expanded / "menu") on the target and capture the opened state (default true). */
  autoMenu?: boolean;
  /** pixelmatch per-pixel colour threshold (0..1). Default 0.05 (strict: ~4/255 colour drift is detected). */
  threshold?: number;
  /** Every slice and state must reach this percentage. Default 99. */
  minSimilarity?: number;
  /** CSS selector to hover. Default: auto-pick on the target, reuse its coordinates locally. */
  hoverSelector?: string;
  settleMs?: number;
  /** Deterministic virtual time (rAF / performance.now / Date.now advance only in fixed frame steps). */
  freezeTime?: boolean;
  /** Virtual frames stepped after load (default 60) and before each capture (default 30). Lower on GL-heavy pages. */
  settleFrames?: number;
  stateFrames?: number;
  /** Cumulative wheel deltas for the legacy "states" mode when the document does not scroll. */
  wheelDeltas?: [number, number, number];
  /** Per-screenshot timeout (default 180000). Software-GL scenes can need minutes. */
  screenshotTimeoutMs?: number;
  /**
   * Capture replay state (three.js scenes via the GL hook + the visible DOM layer) from the TARGET session right before
   * each screenshot, into this folder (y-<y>.json, state-<name>.json, dom-*.json, static.json, geometry.bin). The clone
   * can then replay exactly the states that are compared, including history-dependent ones (state-top-return).
   */
  dumpReplayTo?: string;
  /** CSS selectors excluded from the DOM dump (default "canvas"). */
  dumpExclude?: string[];
  /** Re-use previously captured TARGET screenshots (same url/viewport/options). */
  reuseTarget?: boolean;
  outputDir?: string;
}

interface Item {
  name: string;
  kind: "slice" | "hover" | "menu" | "interaction";
  /** Scroll position of the capture (target coordinates). */
  y: number;
  /** Pointer target for hover/menu/interaction, resolved on the target and replayed on the clone. */
  point?: { x: number; y: number; selector: string | null; action: "hover" | "click" } | null;
  press?: string;
  waitMs?: number;
}

interface Capture {
  shots: Buffer[];
  /** Priming scrolled the page deep (>= 1.5 viewports) before slice 0: once-only intros may have fired. */
  primedDeep?: boolean;
  plan: Item[];
  scrollHeight: number;
  maxScroll: number;
  sampled: boolean;
  scrollModel: "native" | "wheel";
  /** Wheel input visibly moves content although the document does not scroll (virtual scroller). */
  virtualScroller: boolean;
  probeAttempts: number;
  scrollLockedMs: number;
  readiness: unknown;
}

/** Bump whenever capture behaviour changes, so reuseTarget never mixes captures taken with different logic. */
const CAPTURE_VERSION = 10;

let SHOT_TIMEOUT = 180_000;
async function shoot(page: Page): Promise<Buffer> {
  return page.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "css", timeout: SHOT_TIMEOUT });
}

/** Resolve a selector (or auto-pick a hoverable element) to viewport coordinates at the current scroll. */
async function resolvePoint(page: Page, sel: string | undefined, mode: "hover" | "menu"): Promise<{ x: number; y: number; selector: string | null } | null> {
  return page.evaluate(
    ({ sel, mode }) => {
      const path = (window as unknown as { __pcPath: (e: Element) => string }).__pcPath;
      const ok = (el: Element) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width >= 12 && r.height >= 12 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && cs.visibility !== "hidden" && cs.pointerEvents !== "none" && parseFloat(cs.opacity) > 0.05;
      };
      const center = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), selector: path(el) };
      };
      if (sel) {
        const el = Array.from(document.querySelectorAll(sel)).find(ok);
        return el ? center(el) : null;
      }
      if (mode === "menu") {
        const cands = Array.from(document.querySelectorAll("[aria-expanded], [aria-controls], [class*=burger], [class*=hamburger], [class*=menu-toggle], [class*=menu-btn], [class*=btn-menu], button, [role=button]"));
        const el = cands.find((e) => ok(e) && /burger|hamburger|menu/i.test(`${typeof e.className === "string" ? e.className : ""} ${e.getAttribute("aria-label") ?? ""} ${(e as HTMLElement).innerText ?? ""}`.slice(0, 200)) && e.getBoundingClientRect().width < innerWidth * 0.3);
        return el ? center(el) : null;
      }
      for (const el of Array.from(document.querySelectorAll("a[href], button, [role=button]"))) {
        if (!ok(el) || el.getBoundingClientRect().width > innerWidth * 0.7) continue;
        return center(el);
      }
      return { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2), selector: null };
    },
    { sel, mode },
  );
}

function slicePositions(maxScroll: number, step: number, maxSlices: number): { ys: number[]; sampled: boolean } {
  const ys: number[] = [];
  for (let y = 0; y < maxScroll; y += step) ys.push(Math.round(y));
  if (!ys.length || ys[ys.length - 1] !== maxScroll) ys.push(maxScroll);
  if (ys.length <= maxSlices) return { ys, sampled: false };
  // Too tall: evenly spaced over the FULL height (first = 0, last = bottom), never truncated.
  return { ys: Array.from({ length: maxSlices }, (_, i) => Math.round((maxScroll * i) / (maxSlices - 1))), sampled: true };
}

async function capture(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  url: string,
  vp: Viewport,
  opt: {
    settleMs: number; freezeTime: boolean; freezeMedia: boolean; ready: ReadyOptions; frames: { settle: number; state: number };
    mode: "fullpage" | "states"; maxSlices: number; sliceStep?: number; wheelDeltas: number[]; virtualScrollHeight?: number; sliceWaitMs?: number; scrollUnlockTimeoutMs: number; stableTimeoutMs: number;
    hoverSelector?: string; autoMenu: boolean; interactions: Interaction[];
    /** When capturing the clone: replay the target's plan, scroll model and probe count exactly. */
    ref?: { plan: Item[]; scrollModel: "native" | "wheel"; probeAttempts?: number; primedDeep?: boolean };
    dump?: { dir: string; exclude: string[] };
  },
): Promise<Capture> {
  const context = await newContext(browser, vp);
  // Both pages know they are being compared (replay clones hold videos at their recorded frame instead of playing).
  await context.addInitScript(() => { (window as unknown as { __pcVisualDiff: boolean }).__pcVisualDiff = true; });
  try {
    if (opt.freezeTime) await context.addInitScript(VIRTUAL_TIME_INIT);
    // GL hook: lets the stability wait see canvas animation too (scroll-driven WebGL eases in for seconds).
    await context.addInitScript(WEBGL_HOOK_INIT);
    const page = await context.newPage();
    const frames = async (n: number) => {
      if (opt.freezeTime && n > 0) await page.evaluate((k) => (window as unknown as { __pcStep: (n: number) => number }).__pcStep(k), n);
    };
    let readiness: unknown = null;
    try {
      readiness = await gotoAndSettle(page, url, opt.settleMs, opt.ready);
    } catch (e) {
      throw new Error(`Could not load ${url}: ${(e as Error).message.split("\n")[0]}. Is the dev server running?`);
    }
    // Replay-state capture (target only): same session, same history, same moment as the screenshots.
    type Writer = { addScene: (n: string, d: unknown) => void; addDom: (n: string, d: unknown) => void; meta: (m: Record<string, unknown>) => void; has: (n: string) => boolean; remove: (n: string) => void; rename: (a: string, b: string) => void; finish: () => unknown };
    type Ser = { SCENE_SERIALIZE: string; DOM_SNAPSHOT: string; createReplayWriter: (d: string) => Writer };
    const box: { writer: Writer | null; ser: Ser | null } = { writer: null, ser: null };
    if (opt.dump && !opt.ref) {
      box.ser = (await import(new URL("../../../scripts/lib/replay-serializers.mjs", import.meta.url).href)) as Ser;
      box.writer = box.ser.createReplayWriter(opt.dump.dir);
    }
    const dumpState = async (name: string) => {
      const { writer, ser } = box;
      if (!writer || !ser) return;
      // Scene first (recording complete frames takes seconds), then the DOM snapshot, so the DOM state is the one the
      // screenshot right after shows (scroll-triggered UI keeps animating during a long GL recording).
      const hasThree = await page.evaluate(() => !!(window as unknown as { __pcGL?: { renderers: unknown[] } }).__pcGL?.renderers.length);
      if (hasThree) writer.addScene(name, await page.evaluate(`(${ser.SCENE_SERIALIZE})(${JSON.stringify({ recordMs: 2000, maxRecordMs: 20000 })})`));
      writer.addDom(name, await page.evaluate(`(${ser.DOM_SNAPSHOT})(${JSON.stringify(opt.dump!.exclude)})`));
    };
    // The TRUE hero: the page as a visitor first sees it, before anything has scrolled (priming below may fire
    // once-only intros). The clone opens on this state.
    let initialShot: Buffer | null = null;
    const simTo = (a: Buffer, bBuf: Buffer) => {
      const x = decodePng(a), y = decodePng(bBuf);
      return x.width === y.width && x.height === y.height ? Math.round((1 - pixelmatch(x.data, y.data, undefined, x.width, x.height, { threshold: 0.05, includeAA: false }) / (x.width * x.height)) * 10000) / 100 : 0;
    };
    // Media timeline: playing videos are paused for the duration of a capture so the dump and the screenshot see the
    // same frame, then resumed (the page's own paused/playing state is preserved in the dump).
    const pauseMedia = () => opt.freezeMedia ? page.evaluate(() => {
      const w = window as unknown as { __pcPausedMedia?: Set<HTMLVideoElement> };
      const set = (w.__pcPausedMedia = new Set());
      for (const v of Array.from(document.querySelectorAll("video"))) if (!v.paused) { v.pause(); set.add(v); }
    }).catch(() => undefined) : Promise.resolve();
    const resumeMedia = () => opt.freezeMedia ? page.evaluate(() => {
      const w = window as unknown as { __pcPausedMedia?: Set<HTMLVideoElement> };
      for (const v of Array.from(w.__pcPausedMedia ?? [])) void v.play().catch(() => undefined);
      w.__pcPausedMedia = new Set();
    }).catch(() => undefined) : Promise.resolve();
    if (!opt.ref) {
      await page.mouse.move(vp.width - 1, vp.height - 1);
      await pauseMedia();
      initialShot = await shoot(page);
      await dumpState("initial");
      await resumeMedia();
    }
    // Priming scrolls through the page (lazy content). Whether it counted as a "visit" (the target already showed its
    // post-visit top at slice 0) is decided at the hover state, by comparing slice 0 with the top after the full slice
    // run. The clone is primed only in that case, so both pages share the same history at every slice. (A fast sweep
    // often does NOT trigger a site's post-visit state, and an intro that is still animating at load makes "the top
    // changed" a useless signal.)
    let primedDeep = false;
    let deepest = 0;
    if (opt.ref) {
      if (opt.ref.primedDeep) await primeLazyContent(page);
      primedDeep = !!opt.ref.primedDeep;
    } else deepest = await primeLazyContent(page);
    await page.mouse.move(vp.width - 1, vp.height - 1);
    await frames(opt.frames.settle);
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const maxScroll = Math.max(0, scrollHeight - vp.height);
    const wait = opt.sliceWaitMs ?? Math.max(300, Math.min(opt.settleMs, 800));

    // Scroll model. A scroll-locked intro or a virtual scroller both look like "scrollTo does nothing" for a moment, so
    // the probe gives the page real time and frames before deciding. The probes run IDENTICALLY on both pages (same
    // inputs, same virtual frames); only the target's verdict is used: the clone inherits it.
    let probedModel: "native" | "wheel" = maxScroll > 50 ? "native" : "wheel";
    let scrollLockedMs = 0;
    let probeAttempts = 0;
    if (maxScroll > 50) {
      // Scroll-locked intros: keep trying until scrolling works (or give up and treat the page as wheel-driven).
      // The clone replays the SAME number of attempts as the target so both advance identical virtual frames.
      const t0 = Date.now();
      const maxAttempts = opt.ref ? (opt.ref.probeAttempts ?? 1) : Math.max(1, Math.ceil(opt.scrollUnlockTimeoutMs / 1000));
      let attempts = 0;
      for (; attempts < maxAttempts; attempts++) {
        await page.evaluate(() => window.scrollTo({ top: 200, behavior: "instant" as ScrollBehavior }));
        await page.waitForTimeout(500);
        await frames(Math.max(opt.frames.state, 10));
        const moved = (await page.evaluate(() => window.scrollY)) > 100;
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
        await page.waitForTimeout(500);
        if (!opt.ref && moved) { probedModel = "native"; attempts++; break; }
        probedModel = "wheel";
      }
      probeAttempts = attempts;
      scrollLockedMs = probedModel === "native" ? Date.now() - t0 - 1000 : Date.now() - t0;
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    await frames(Math.max(opt.frames.state, 10));
    // A single-screen page and a virtual scroller both have maxScroll ~ 0; only the latter moves content on wheel input.
    const sig = () => page.evaluate(() => { const els = Array.from(document.querySelectorAll("body *")).slice(0, 3000); return els.map((e) => getComputedStyle(e).transform).join("|") + "|" + els.map((e) => e.scrollTop).join(","); });
    const before = await sig();
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(500);
    await frames(Math.max(opt.frames.state, 10));
    const wheelMoves = (await sig()) !== before || (await page.evaluate(() => window.scrollY)) > 0;
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(500);
    await frames(Math.max(opt.frames.state, 30));
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    // Park the pointer again: pointer-parallax scenes must see the same pointer on every slice and in every dump.
    await page.mouse.move(vp.width - 1, vp.height - 1);
    const scrollModel: "native" | "wheel" = opt.ref?.scrollModel ?? probedModel;
    const virtualScroller = opt.ref ? false : scrollModel === "wheel" && wheelMoves;
    const domSig = () => page.evaluate(() => {
      let s = "";
      let n = 0;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        if (++n > 4000) break;
        const r = el.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= innerHeight || r.width < 1 || r.height < 1) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        s += `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${cs.opacity}|`;
      }
      // three.js scenes: active camera + visible object transforms (canvas pixels are not readable cheaply).
      const g = (window as unknown as { __pcGL?: { last?: { camera?: { matrixWorld: { elements: number[] } }; scene?: { traverse: (f: (o: { visible: boolean; matrixWorld: { elements: number[] } }) => void) => void } } } }).__pcGL;
      if (g?.last?.scene) {
        let acc = 0, n2 = 0;
        g.last.scene.traverse((o) => { if (o.visible) { n2++; acc += o.matrixWorld.elements[12]! + o.matrixWorld.elements[13]! * 3 + o.matrixWorld.elements[0]! * 7; } });
        s += `gl:${n2}:${Math.round(acc * 100)}:${Math.round((g.last.camera?.matrixWorld.elements[13] ?? 0) * 1000)}`;
      }
      return s.length + ":" + Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
    }).catch(() => "");
    const waitStable = async () => {
      if (!opt.stableTimeoutMs) return;
      const t0 = Date.now();
      let prev = await domSig(), same = 0;
      while (Date.now() - t0 < opt.stableTimeoutMs && same < 2) {
        await page.waitForTimeout(700);
        await frames(Math.max(2, Math.round(opt.frames.state / 3)));
        const cur = await domSig();
        same = cur === prev ? same + 1 : 0;
        prev = cur;
      }
    };
    let wheelDone = 0;
    const go = async (y: number) => {
      if (scrollModel === "native") {
        await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" as ScrollBehavior }), y);
        await page.waitForTimeout(wait);
        await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => undefined);
      } else if (y !== wheelDone) {
        // Virtual scroller: wheel input is the only lever; 1 wheel px is taken as 1 scroll px.
        await page.mouse.move(vp.width / 2, vp.height / 2);
        await page.mouse.wheel(0, y - wheelDone);
        wheelDone = y;
        await page.waitForTimeout(wait);
      } else await page.waitForTimeout(wait);
      await frames(opt.frames.state);
      await waitStable();
    };

    // ---- the plan: what to capture (built on the target, replayed on the clone) ----
    let plan: Item[];
    let sampled = false;
    if (opt.ref) plan = opt.ref.plan;
    else if (opt.mode === "states") {
      const w = opt.wheelDeltas;
      const ys = scrollModel === "native" ? [0, Math.round(maxScroll * 0.25), Math.round(maxScroll * 0.5), maxScroll] : [0, w[0] ?? 600, w[1] ?? 1200, w[2] ?? 2400];
      plan = [
        { name: "top", kind: "slice", y: ys[0]! }, { name: "scroll25", kind: "slice", y: ys[1]! },
        { name: "scroll50", kind: "slice", y: ys[2]! }, { name: "bottom", kind: "slice", y: ys[3]! },
        { name: "hover", kind: "hover", y: 0 },
      ];
    } else {
      const span = scrollModel === "wheel" && opt.virtualScrollHeight ? Math.max(0, opt.virtualScrollHeight - vp.height) : maxScroll;
      const s = slicePositions(span, opt.sliceStep ?? vp.height, opt.maxSlices);
      sampled = s.sampled;
      plan = s.ys.map((y, i) => ({ name: `slice-${String(i).padStart(2, "0")}@${y}`, kind: "slice" as const, y }));
      plan.push({ name: "hover", kind: "hover", y: 0 });
      if (opt.autoMenu) plan.push({ name: "menu-open", kind: "menu", y: 0 });
      for (const it of opt.interactions) plan.push({ name: it.name, kind: "interaction", y: it.scrollY ?? 0, press: it.press, waitMs: it.waitMs, point: null });
    }

    const shots: Buffer[] = [];
    const resolved: Item[] = [];
    box.writer?.meta({ viewport: [vp.width, vp.height], dpr: 1, scrollHeight, scrollModel });
    for (let i = 0; i < plan.length; i++) {
      const item = { ...plan[i]! };
      await go(item.y);
      // The top of the page after the full scroll (a deep visit) can differ from the first view (intros that play
      // once). It is only kept when it GENUINELY differs from the true hero captured before any scrolling: the clone
      // always opens on the hero and switches to top-return only after a deep visit.
      if (item.kind === "hover" && !opt.ref) {
        const returnShot = await shoot(page);
        const first = resolved.findIndex((r) => r.kind === "slice" && r.y === 0);
        const slice0 = first >= 0 ? shots[first]! : null;
        const simSlice0 = slice0 ? simTo(slice0, returnShot) : 0;
        primedDeep = deepest >= 1.5 * vp.height && simSlice0 >= 98.5;
        // The hero the clone opens on: the pre-scroll capture if priming already produced the post-visit state, else
        // the settled slice-0 capture. top-return is kept only when it genuinely differs from that hero.
        const hero = primedDeep ? initialShot : slice0;
        const similarity = hero ? simTo(hero, returnShot) : 0;
        const distinct = similarity < 98.5; // margin for load-time noise; once-only intros differ far more
        box.writer?.meta({ topReturn: { similarityToHero: similarity, slice0VsReturn: simSlice0, distinct } });
        if (distinct) { await pauseMedia(); await dumpState("state-top-return"); await resumeMedia(); }
      }
      if (item.kind !== "slice") {
        // Resolve pointers on the target only; the clone replays the same coordinates.
        if (!opt.ref) {
          const spec = item.kind === "interaction" ? opt.interactions.find((x) => x.name === item.name) : undefined;
          const p = item.kind === "hover" ? await resolvePoint(page, opt.hoverSelector, "hover")
            : item.kind === "menu" ? await resolvePoint(page, undefined, "menu")
            : await resolvePoint(page, spec?.click ?? spec?.hover, "hover");
          item.point = p ? { ...p, action: item.kind === "menu" || spec?.click ? "click" : "hover" } : null;
        }
        if (item.kind === "menu" && !item.point) continue; // no menu toggle on this page
        if (item.point) {
          await page.mouse.move(item.point.x, item.point.y, { steps: 6 });
          if (item.point.action === "click") await page.mouse.click(item.point.x, item.point.y);
        }
        if (item.press) await page.keyboard.press(item.press);
        await page.waitForTimeout(item.waitMs ?? 800);
        await frames(opt.frames.state);
      }
      await pauseMedia();
      await dumpState(item.kind === "slice" ? `y-${item.y}` : `state-${item.name}`);
      shots.push(await shoot(page));
      await resumeMedia();
      resolved.push(item);
      if (item.kind !== "slice") {
        // Undo: close what we opened so later states start clean.
        if (item.point?.action === "click") { await page.keyboard.press("Escape").catch(() => undefined); if (item.kind === "menu") await page.mouse.click(item.point.x, item.point.y); }
        await page.mouse.move(vp.width - 1, vp.height - 1);
        await page.waitForTimeout(400);
        await frames(opt.frames.state);
      }
    }
    if (box.writer) {
      // y-0 must be the hero. If priming already visited the page deep, the slice-0 capture is a post-visit state
      // (covered by top-return when distinct): use the pre-scroll capture instead. Otherwise slice 0 IS the hero
      // (and the more settled capture of it).
      box.writer.meta({ primedDeep });
      if (primedDeep && box.writer.has("initial")) box.writer.rename("initial", "y-0");
      else box.writer.remove("initial");
      log("replay dump:", JSON.stringify(box.writer.finish()));
    }
    return { shots, primedDeep, plan: resolved, scrollHeight, maxScroll, sampled, scrollModel, virtualScroller, probeAttempts, scrollLockedMs, readiness };
  } finally {
    await context.close();
  }
}

function hotspots(diff: PNG, offsetY: number, cellW = 160, cellH = 100) {
  const cols = Math.ceil(diff.width / cellW);
  const rows = Math.ceil(diff.height / cellH);
  const counts = new Array<number>(cols * rows).fill(0);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const d = diff.data;
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0) {
        counts[Math.floor(y / cellH) * cols + Math.floor(x / cellW)]!++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cells = counts
    .map((c, i) => ({ x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH, pageY: offsetY + Math.floor(i / cols) * cellH, w: cellW, h: cellH, diffPixels: c, cellDiffPct: Math.round((c / (cellW * cellH)) * 10000) / 100 }))
    .filter((c) => c.diffPixels > 0)
    .sort((a, b) => b.diffPixels - a.diffPixels)
    .slice(0, 6);
  return { hotspots: cells, diffBounds: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

/** Box-filter downscale (for the overview filmstrip). */
function downscale(src: PNG, s: number): PNG {
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
  const dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x / s), y0 = Math.floor(y / s), x1 = Math.min(src.width, Math.ceil((x + 1) / s)), y1 = Math.min(src.height, Math.ceil((y + 1) / s));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * src.width + xx) * 4; r += src.data[i]!; g += src.data[i + 1]!; b += src.data[i + 2]!; n++; }
    const o = (y * w + x) * 4; dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = b / n; dst.data[o + 3] = 255;
  }
  return dst;
}

/** One image of the whole run: a row per slice/state with target | local | diff, plus a pass/fail bar. */
function overview(rows: { a: PNG; b: PNG; d: PNG; pass: boolean }[], s = 0.18): PNG {
  const GAP = 6, BAR = 6;
  const cw = Math.round(rows[0]!.a.width * s), ch = Math.round(rows[0]!.a.height * s);
  const out = new PNG({ width: BAR + GAP + 3 * cw + 3 * GAP, height: rows.length * (ch + GAP) + GAP });
  out.data.fill(40);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  rows.forEach((r, i) => {
    const y = GAP + i * (ch + GAP);
    for (let yy = y; yy < y + ch; yy++) for (let xx = 0; xx < BAR; xx++) {
      const o = (yy * out.width + xx) * 4; out.data[o] = r.pass ? 60 : 230; out.data[o + 1] = r.pass ? 200 : 60; out.data[o + 2] = 80;
    }
    [r.a, r.b, r.d].forEach((img, j) => { const sm = downscale(img, s); PNG.bitblt(sm, out, 0, 0, Math.min(cw, sm.width), Math.min(ch, sm.height), BAR + GAP + j * (cw + GAP), y); });
  });
  return out;
}

export async function compareVisualDiff(input: CompareInput) {
  const {
    targetUrl, localUrl, viewports = [VIEWPORT], threshold = 0.05, minSimilarity = 99, hoverSelector, settleMs = 1200,
    freezeTime = false, freezeMedia = true, wheelDeltas = [600, 1200, 2400], settleFrames = 60, stateFrames = 30, screenshotTimeoutMs = 180_000,
    reuseTarget = false, mode = "fullpage", maxSlices = 20, sliceStep, heightTolerance = 0.02, interactions = [], autoMenu = true, virtualScrollHeight, sliceWaitMs, scrollUnlockTimeoutMs = 20_000, stableTimeoutMs = 10_000, dumpReplayTo, dumpExclude = ["canvas"], ...ready
  } = input;
  SHOT_TIMEOUT = screenshotTimeoutMs;
  const frameCfg = { settle: settleFrames, state: stateFrames };
  const dir = await ensureDir(input.outputDir ?? path.join(outRoot(), "diff", timestamp()));
  const browser = await launchBrowser();
  try {
    const perViewport = [];
    for (const vp of viewports) {
      const vdir = await ensureDir(path.join(dir, `${vp.width}x${vp.height}`));
      log(`capturing ${vp.width}x${vp.height} (${mode})`);
      const base = { settleMs, freezeTime, freezeMedia, frames: frameCfg, mode, maxSlices: Math.min(60, maxSlices), sliceStep, wheelDeltas, hoverSelector, autoMenu, interactions, virtualScrollHeight, sliceWaitMs, scrollUnlockTimeoutMs, stableTimeoutMs };
      // CAPTURE_VERSION invalidates cached target captures whenever the capture logic changes (pointer, probes, waits).
      const cacheKey = createHash("sha1").update(JSON.stringify([CAPTURE_VERSION, targetUrl, vp, base, ready.entrySelector])).digest("hex").slice(0, 16);
      const cacheDir = path.join(outRoot(), "_target-captures", cacheKey);
      const metaFile = path.join(cacheDir, "meta.json");
      let t: Capture;
      // A replay dump must come from the very session that is compared: never served from the cache.
      const cached = reuseTarget && !dumpReplayTo ? await fs.readFile(metaFile, "utf8").then((x) => JSON.parse(x) as Omit<Capture, "shots">).catch(() => null) : null;
      if (cached) {
        log(`re-using cached target captures ${cacheKey}`);
        t = { ...cached, shots: await Promise.all(cached.plan.map((_, i) => fs.readFile(path.join(cacheDir, `${i}.png`)))) };
      } else {
        // Several viewports: one replay variant per viewport (<dumpReplayTo>/<W>x<H>/); the clone picks the closest.
        const dumpDir = dumpReplayTo ? (viewports.length > 1 ? path.join(dumpReplayTo, `${vp.width}x${vp.height}`) : dumpReplayTo) : undefined;
        t = await capture(browser, targetUrl, vp, { ...base, ready, dump: dumpDir ? { dir: dumpDir, exclude: dumpExclude } : undefined });
        await ensureDir(cacheDir);
        await Promise.all(t.shots.map((b, i) => fs.writeFile(path.join(cacheDir, `${i}.png`), b)));
        const { shots: _omit, ...meta } = t;
        void _omit;
        await fs.writeFile(metaFile, JSON.stringify(meta));
      }
      const l = await capture(browser, localUrl, vp, { ...base, ready: { ...ready, entryTimeoutMs: 4000 }, ref: { plan: t.plan, scrollModel: t.scrollModel, probeAttempts: t.probeAttempts, primedDeep: t.primedDeep ?? true } });

      const items = [];
      const rows: { a: PNG; b: PNG; d: PNG; pass: boolean }[] = [];
      for (let i = 0; i < t.plan.length; i++) {
        const it = t.plan[i]!;
        const safe = it.name.replace(/[^\w.@-]/g, "_");
        const tf = path.join(vdir, `target-${safe}.png`), lf = path.join(vdir, `local-${safe}.png`), df = path.join(vdir, `diff-${safe}.png`);
        const lb = l.shots[i];
        await fs.writeFile(tf, t.shots[i]!);
        if (!lb) { items.push({ state: it.name, kind: it.kind, y: it.y, error: "not captured on the clone", similarity: 0, pass: false }); continue; }
        await fs.writeFile(lf, lb);
        const a = decodePng(t.shots[i]!), b = decodePng(lb);
        if (a.width !== b.width || a.height !== b.height) {
          items.push({ state: it.name, kind: it.kind, y: it.y, error: `size mismatch target ${a.width}x${a.height} vs local ${b.width}x${b.height}`, similarity: 0, pass: false });
          continue;
        }
        const diff = new PNG({ width: a.width, height: a.height });
        const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold, includeAA: false, alpha: 0.15, diffColor: [255, 0, 0], aaColor: [255, 255, 0] });
        const total = a.width * a.height;
        const similarity = Math.round((1 - diffPixels / total) * 10000) / 100;
        await writePng(df, diff);
        const pass = similarity >= minSimilarity;
        rows.push({ a, b, d: diff, pass });
        items.push({ state: it.name, kind: it.kind, y: it.y, point: it.point ?? undefined, similarity, diffPixels, totalPixels: total, pass, ...hotspots(diff, it.kind === "slice" ? it.y : 0), files: { target: tf, local: lf, diff: df } });
      }
      const overviewFile = path.join(vdir, "overview.png");
      if (rows.length) await writePng(overviewFile, overview(rows));
      const deltaPct = t.scrollHeight ? Math.abs(l.scrollHeight - t.scrollHeight) / t.scrollHeight : 0;
      const scored = items.filter((s) => typeof s.similarity === "number");
      const slices = items.filter((s) => s.kind === "slice");
      perViewport.push({
        viewport: vp,
        mode,
        coverage: {
          slices: slices.length, step: sliceStep ?? vp.height, sampled: t.sampled, from: 0, to: slices.length ? Math.max(...slices.map((x) => x.y)) : 0, scrollModel: t.scrollModel,
          scrollLockedMs: t.scrollLockedMs,
          warning: t.virtualScroller && !virtualScrollHeight && mode === "fullpage" ? "Wheel-driven page: only one slice was captured. Pass virtualScrollHeight (the scroll length in wheel px) to cover the whole page." : undefined,
        },
        height: { target: t.scrollHeight, local: l.scrollHeight, deltaPct: Math.round(deltaPct * 10000) / 100, tolerancePct: heightTolerance * 100, pass: deltaPct <= heightTolerance },
        targetScrollHeight: t.scrollHeight,
        localScrollHeight: l.scrollHeight,
        scrollHeightDelta: l.scrollHeight - t.scrollHeight,
        scrollModel: t.scrollModel,
        targetReadiness: t.readiness,
        localReadiness: l.readiness,
        meanSimilarity: Math.round((scored.reduce((n, s) => n + s.similarity, 0) / (scored.length || 1)) * 100) / 100,
        worstState: scored.slice().sort((x, y) => x.similarity - y.similarity)[0]?.state ?? null,
        failingSlices: slices.filter((s) => !s.pass).map((s) => ({ state: s.state, y: s.y, similarity: s.similarity })),
        overview: rows.length ? overviewFile : null,
        states: items,
      });
    }
    const all = perViewport.flatMap((v) => v.states);
    const heightsOk = perViewport.every((v) => v.height.pass);
    const coverageOk = perViewport.every((v) => !v.coverage.warning);
    const pass = all.length > 0 && all.every((s) => s.pass) && heightsOk && coverageOk && mode === "fullpage";
    const report = {
      targetUrl,
      localUrl,
      method: "pixelmatch; similarity = (1 - diffPixels/totalPixels) * 100; full-page viewport slices + interactive states, deviceScaleFactor 1, animations disabled",
      threshold,
      minSimilarity,
      freezeTime,
      mode,
      pass,
      passRule: "every vertical slice AND every interactive state >= minSimilarity, scrollHeight within heightTolerance, full coverage (no wheel-coverage warning), mode fullpage",
      overallSimilarity: Math.round((all.reduce((n, s) => n + s.similarity, 0) / (all.length || 1)) * 100) / 100,
      outputDir: dir,
      viewports: perViewport,
      nextStep: pass
        ? "PASS: every slice and state meets the threshold and the page height matches."
        : mode === "states"
          ? "Legacy 'states' mode never passes: run mode 'fullpage' to verify the whole page."
          : !heightsOk
            ? "FAIL: page height differs by more than the tolerance; sections are missing or mis-sized. Fix layout before pixels."
            : "FAIL: open overview.png, then the worst failing slice's diff; hotspots[].pageY gives page coordinates. Fix and re-run.",
    };
    await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await browser.close();
  }
}
