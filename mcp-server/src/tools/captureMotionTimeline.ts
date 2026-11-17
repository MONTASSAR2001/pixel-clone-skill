import path from "node:path";
import fs from "node:fs/promises";
import type { CDPSession } from "playwright";
import { launchBrowser, newContext, gotoAndSettle, outRoot, slugify, ensureDir, log, VIEWPORT, type ReadyOptions } from "../lib/browser.js";
import { PATH_HELPER_INIT, MUTATION_LOG_INIT, VIRTUAL_TIME_INIT } from "../lib/page-helpers.js";

export interface MotionInput extends ReadyOptions {
  url: string;
  scrollSteps?: number;
  hoverTargets?: number;
  samplesPerAnimation?: number;
  /** Deterministic virtual clock (rAF/performance.now/Date.now advance only when stepped). Default true. */
  virtualTime?: boolean;
  settleMs?: number;
}

interface CdpAnimation {
  id: string;
  name: string;
  type: "CSSTransition" | "CSSAnimation" | "WebAnimation";
  playbackRate: number;
  startTime: number;
  currentTime: number;
  source?: {
    delay: number;
    endDelay: number;
    iterationStart: number;
    iterations: number;
    duration: number;
    direction: string;
    fill: string;
    easing: string;
    backendNodeId?: number;
    keyframesRule?: { name?: string; keyframes: { offset: string; easing: string }[] };
  };
}

interface Described {
  id: string;
  type: CdpAnimation["type"];
  name: string;
  target: string | null;
  pseudo: string | null;
  timing: { delay: number; duration: number; iterations: number | string; direction: string; fill: string; easing: string };
  /** The easing that actually shapes motion: CSS animations keep it on keyframes, transitions on the effect. */
  effectiveEasing: string;
  keyframes: Record<string, unknown>[];
  animatedProperties: string[];
  samples?: { progress: number; timeMs: number; values: Record<string, string> }[];
  discoveredAt: string;
}

/** Runs inside the page on the resolved Animation object (via CDP Runtime.callFunctionOn). */
const DESCRIBE_FN = `function () {
  const eff = this.effect;
  if (!eff) return null;
  const t = eff.target;
  const timing = eff.getTiming();
  let keyframes = [];
  try { keyframes = eff.getKeyframes().map(k => { const o = {}; for (const key in k) o[key] = typeof k[key] === 'object' ? String(k[key]) : k[key]; return o; }); } catch (e) {}
  const skip = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const props = [...new Set(keyframes.flatMap(k => Object.keys(k).filter(x => !skip.has(x))))];
  return {
    target: t && window.__pcPath ? window.__pcPath(t) : null,
    pseudo: eff.pseudoElement || null,
    name: this.animationName || this.transitionProperty || this.id || '',
    timing: { delay: timing.delay, duration: typeof timing.duration === 'number' ? timing.duration : 0, iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations, direction: timing.direction, fill: timing.fill, easing: timing.easing },
    keyframes, animatedProperties: props,
  };
}`;

const SAMPLE_FN = `function (props) {
  const eff = this.effect; const t = eff && eff.target;
  if (!t) return null;
  const cs = getComputedStyle(t, eff.pseudoElement || null);
  const out = {};
  for (const p of props) out[p] = cs[p] !== undefined ? cs[p] : cs.getPropertyValue(p);
  return out;
}`;

async function callOn<T>(cdp: CDPSession, animationId: string, fn: string, args: unknown[] = []): Promise<T | null> {
  try {
    const { remoteObject } = (await cdp.send("Animation.resolveAnimation", { animationId })) as { remoteObject: { objectId: string } };
    const r = (await cdp.send("Runtime.callFunctionOn", {
      objectId: remoteObject.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    })) as { result: { value: T } };
    return r.result.value ?? null;
  } catch {
    return null;
  }
}

const settleFrames = (ms: number) => Math.max(30, Math.round(ms / 16.67));
const camel = (p: string) => p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export async function captureMotionTimeline(input: MotionInput) {
  const { url, scrollSteps = 8, hoverTargets = 10, samplesPerAnimation = 5, virtualTime = true, settleMs = 1500, ...ready } = input;
  const dir = await ensureDir(path.join(outRoot(), "motion", slugify(url)));
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser);
    await context.addInitScript(PATH_HELPER_INIT);
    await context.addInitScript(MUTATION_LOG_INIT);
    if (virtualTime) await context.addInitScript(VIRTUAL_TIME_INIT);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const scripts: string[] = [];
    page.on("response", (r) => {
      if (/javascript/.test(r.headers()["content-type"] ?? "")) scripts.push(r.url());
    });

    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Animation.enable");
    const seen = new Map<string, CdpAnimation>();
    const order: { id: string; phase: string }[] = [];
    let phase = "load";
    cdp.on("Animation.animationStarted", (e) => {
      const a = e.animation as unknown as CdpAnimation;
      if (!seen.has(a.id)) {
        seen.set(a.id, a);
        order.push({ id: a.id, phase });
      }
    });

    // Virtual time: the page is "held" until we step it, so every run advances through identical frames.
    const frames = async (n: number) => {
      if (!virtualTime) return page.waitForTimeout(Math.round(n * 16.67));
      for (let left = n; left > 0; left -= 5) {
        await page.evaluate((k) => (window as unknown as { __pcStep: (n: number) => number }).__pcStep(k), Math.min(5, left));
        await page.waitForTimeout(2); // let promises/IO/real timers interleave
      }
    };
    const advance = async (ms: number) => {
      await frames(Math.max(1, Math.round(ms / 16.67)));
      await page.waitForTimeout(60); // CSS animations run on the real document timeline
    };

    const gates = await gotoAndSettle(page, url, 400, ready);
    await frames(settleFrames(settleMs));

    const described = new Map<string, Described>();
    const describe = async (id: string, ph: string) => {
      if (described.has(id)) return;
      const a = seen.get(id)!;
      const d = await callOn<{
        target: string | null; pseudo: string | null; name: string;
        timing: Described["timing"]; keyframes: Record<string, unknown>[]; animatedProperties: string[];
      }>(cdp, id, DESCRIBE_FN);
      if (!d) return;
      const kfEase = d.keyframes.find((k) => typeof k.easing === "string" && k.easing !== "linear")?.easing as string | undefined;
      const effectiveEasing = d.timing.easing !== "linear" ? d.timing.easing : (kfEase ?? "linear");
      described.set(id, { id, type: a.type, name: d.name || a.name, target: d.target, pseudo: d.pseudo, timing: d.timing, effectiveEasing, keyframes: d.keyframes, animatedProperties: d.animatedProperties, discoveredAt: ph });
    };

    // --- scroll model + smooth-scroll interpolation profile ---
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    const nativeMax = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
    let scrollModel: "native" | "wheel" = nativeMax > 50 ? "native" : "wheel";
    if (scrollModel === "native") {
      await page.evaluate(() => window.scrollTo({ top: 100, behavior: "instant" as ScrollBehavior }));
      await advance(120);
      const y = await page.evaluate(() => window.scrollY);
      if (y < 1) scrollModel = "wheel"; // document does not follow programmatic scroll (virtual scroll container)
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
      await advance(200);
    }
    const readScroll = () => page.evaluate(() => Math.round(window.scrollY * 100) / 100);
    // Candidates whose translateY may carry a virtual scroller: found BEFORE the wheel input.
    const movers = await page.evaluate(() => {
      const path = (window as unknown as { __pcPath: (e: Element) => string }).__pcPath;
      const out: string[] = [];
      let n = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        if (++n > 4000 || out.length >= 60) break;
        const cs = getComputedStyle(el);
        if (cs.transform !== "none" || /transform/.test(cs.willChange) || /transform|translate/.test(el.getAttribute("style") ?? "")) out.push(path(el));
      }
      return out;
    });
    const tyOf = () =>
      page.evaluate((sels) => {
        const out: Record<string, number> = {};
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const t = getComputedStyle(el).transform;
          out[sel] = t === "none" ? 0 : new DOMMatrix(t).m42;
        }
        return out;
      }, movers);
    const WHEEL = 300, WINDOW = 90;
    const base = await tyOf();
    const scrollTrace: number[] = [];
    const traces: Record<string, number[]> = {};
    await page.mouse.wheel(0, WHEEL);
    for (let f = 1; f <= WINDOW; f++) {
      await frames(1);
      await page.waitForTimeout(16);
      scrollTrace.push(await readScroll());
      const ty = await tyOf();
      for (const [sel, v] of Object.entries(ty)) (traces[sel] ??= []).push(Math.round((v - (base[sel] ?? 0)) * 100) / 100);
    }
    // Position series: document scroll if it moved, otherwise the content wrapper that travelled furthest.
    let driver = "window.scrollY";
    let positions = scrollTrace;
    if ((scrollTrace.at(-1) ?? 0) < 0.5) {
      const best = Object.entries(traces).sort((x, y) => Math.abs(y[1].at(-1) ?? 0) - Math.abs(x[1].at(-1) ?? 0))[0];
      if (best && Math.abs(best[1].at(-1) ?? 0) > 0.5) {
        driver = `transform:${best[0]}`;
        positions = best[1].map((v) => Math.abs(v));
      }
    }
    const finalY = positions.at(-1) ?? 0;
    const settledAt = positions.findIndex((v) => Math.abs(v - finalY) < Math.max(0.5, finalY * 0.002));
    const firstMoved = positions.findIndex((v) => v > 0.5);
    // Per-frame lerp factor: remaining distance shrinks by (1 - k) each frame (k=1 means an instant jump).
    const target = Math.abs(finalY - WHEEL) < WHEEL * 0.05 ? WHEEL : finalY;
    const ks: number[] = [];
    for (let i = 0; i < Math.min(20, positions.length - 1); i++) {
      const r0 = target - positions[i]!, r1 = target - positions[i + 1]!;
      if (r0 > 1) ks.push(1 - r1 / r0);
    }
    ks.sort((x, y) => x - y);
    const smoothScroll = {
      model: scrollModel,
      driver,
      wheelDelta: WHEEL,
      finalPosition: finalY,
      firstMovedFrame: firstMoved < 0 ? null : firstMoved + 1,
      settledFrame: settledAt < 0 ? null : settledAt + 1,
      interpolated: finalY > 0 && settledAt > 3, // eased/lerped (Lenis, ScrollSmoother, native smooth) vs instant jump
      estimatedLerpPerFrame: ks.length ? Math.round(ks[Math.floor(ks.length / 2)]! * 1000) / 1000 : null,
      note: scrollModel === "wheel" ? "document.scrollY does not follow wheel input: virtual scroller. Position series is the content wrapper's translateY (see driver)." : undefined,
      samples: positions.map((v, i) => ({ frame: i + 1, position: Math.round(v * 100) / 100 })).filter((_, i) => i < 12 || i % 6 === 0),
    };
    await page.mouse.wheel(0, -300);
    await frames(60);
    if (scrollModel === "native") await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    await advance(200);

    // --- scroll checkpoints, frame-by-frame deltas of every moving element ---
    const maxScroll = nativeMax;
    const steps: Record<string, unknown>[] = [];
    const checkpoints = Array.from({ length: scrollSteps + 1 }, (_, i) => (scrollModel === "native" ? Math.round((maxScroll * i) / scrollSteps) : i * 400));
    let cumulativeWheel = 0;
    const trackedSet = new Set<string>();
    const discoverTracked = () =>
      page.evaluate(() => {
        const path = (window as unknown as { __pcPath: (e: Element) => string }).__pcPath;
        const out: string[] = [];
        let n = 0;
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
          if (++n > 5000 || out.length >= 120) break;
          const cs = getComputedStyle(el);
          const inline = el.getAttribute("style") ?? "";
          if (cs.transform !== "none" || parseFloat(cs.opacity) < 1 || cs.position === "fixed" || /transform|opacity|translate|clip-path/.test(inline)) out.push(path(el));
        }
        return out;
      });
    const snapshot = (sels: string[]) =>
      page.evaluate((list) => {
        const out: Record<string, string> = {};
        for (const sel of list) {
          const el = document.querySelector<HTMLElement>(sel);
          if (!el) continue;
          const cs = getComputedStyle(el);
          out[sel] = `${cs.transform}|${cs.opacity}|${cs.clipPath}|${cs.visibility}`;
        }
        return out;
      }, sels);
    let prevSnap: Record<string, string> = {};
    for (const target of checkpoints) {
      phase = `scroll-${target}`;
      if (scrollModel === "native") await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" as ScrollBehavior }), target);
      else if (target - cumulativeWheel !== 0) {
        await page.mouse.wheel(0, target - cumulativeWheel);
        cumulativeWheel = target;
      }
      const before = order.length;
      (await discoverTracked()).forEach((x) => trackedSet.add(x));
      const sels = [...trackedSet].slice(0, 160);
      const frameLog: { offsetFrames: number; scrollY: number; changed: { selector: string; transform: string; opacity: string; clipPath: string }[] }[] = [];
      let done = 0;
      for (const off of [0, 6, 20, 45, 90]) {
        await frames(off - done);
        done = off;
        await page.waitForTimeout(25);
        const snap = await snapshot(sels);
        const changed = Object.entries(snap)
          .filter(([k, v]) => prevSnap[k] !== v)
          .slice(0, 40)
          .map(([selector, v]) => { const [transform, opacity, clipPath] = v.split("|"); return { selector, transform: transform!, opacity: opacity!, clipPath: clipPath! }; });
        prevSnap = snap;
        frameLog.push({ offsetFrames: off, scrollY: await readScroll(), changed });
      }
      for (const o of order.slice(0)) await describe(o.id, o.phase);
      const snap = await page.evaluate(() => {
        const path = (window as unknown as { __pcPath: (e: Element) => string }).__pcPath;
        const js = Array.from(document.querySelectorAll<HTMLElement>("[style]"))
          .filter((el) => /transform|opacity|translate|visibility|clip-path/.test(el.getAttribute("style") ?? ""))
          .slice(0, 80)
          .map((el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return { selector: path(el), transform: cs.transform, opacity: cs.opacity, visibility: cs.visibility, inViewport: r.bottom > 0 && r.top < innerHeight };
          });
        const live = document.getAnimations().slice(0, 60).map((a) => {
          const t = a.effect?.getComputedTiming();
          return {
            selector: a.effect instanceof KeyframeEffect && a.effect.target ? path(a.effect.target) : null,
            name: (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id,
            state: a.playState,
            progress: t?.progress ?? null,
            timeline: a.timeline?.constructor?.name ?? null,
          };
        });
        return { jsDriven: js, liveAnimations: live };
      });
      steps.push({
        scrollTarget: target,
        scrollY: await readScroll(),
        scrollPct: scrollModel === "native" && maxScroll ? Math.round((target / maxScroll) * 100) : null,
        newAnimationsSinceLast: order.length - before,
        frames: frameLog,
        ...snap,
      });
    }

    // --- freeze + sample every discovered animation at fixed progress points ---
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    await advance(300);
    for (const o of order) await describe(o.id, o.phase);
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 }).catch(() => undefined);
    for (const d of [...described.values()].slice(0, 40)) {
      const props = d.animatedProperties.map((p) => camel(p));
      const dur = d.timing.duration;
      const delay = d.timing.delay;
      if (!props.length || !dur) continue;
      d.samples = [];
      for (let s = 0; s < samplesPerAnimation; s++) {
        const progress = samplesPerAnimation === 1 ? 1 : s / (samplesPerAnimation - 1);
        const timeMs = delay + progress * dur;
        // Prefer CDP seek; the in-page read gives the computed value at that frozen time.
        await cdp.send("Animation.seekAnimations", { animations: [d.id], currentTime: timeMs }).catch(() => undefined);
        const values = await callOn<Record<string, string>>(cdp, d.id, SAMPLE_FN, [props]);
        if (values) d.samples.push({ progress: Math.round(progress * 100) / 100, timeMs: Math.round(timeMs), values });
      }
    }
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 }).catch(() => undefined);

    // --- hover triggers ---
    phase = "hover";
    const hoverResults: Record<string, unknown>[] = [];
    const candidates = await page.evaluate((limit) => {
      const path = (window as unknown as { __pcPath: (e: Element) => string }).__pcPath;
      const all = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, [role=button], [role=link], summary, input[type=submit], label, li, [class*=card], [class*=btn], [class*=button], img"));
      const picked: HTMLElement[] = [];
      const isPrimary = (el: HTMLElement) => el.matches("a[href], button, [role=button], [role=link], summary, input[type=submit]");
      all.sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)));
      for (const el of all) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 12 || r.height < 12 || cs.visibility === "hidden" || cs.display === "none") continue;
        const hasTransition = cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0);
        if (!hasTransition && cs.cursor !== "pointer") continue;
        if (picked.some((p) => p.contains(el) || el.contains(p))) continue;
        picked.push(el);
      }
      // Interactive elements first (all of them, up to the limit); remaining slots are spread over the rest.
      const primary = picked.filter(isPrimary);
      const rest = picked.filter((el) => !isPrimary(el));
      const room = Math.max(0, limit - primary.length);
      const stride = Math.max(1, Math.floor(rest.length / Math.max(1, room)));
      const chosen = [...primary.slice(0, limit), ...rest.filter((_, i) => i % stride === 0).slice(0, room)];
      return chosen.map((el) => path(el));
    }, hoverTargets);

    const PROPS = ["color", "backgroundColor", "borderColor", "boxShadow", "transform", "opacity", "filter", "textDecorationLine", "outlineColor", "scale", "translate"];
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        await page.mouse.move(2, 2);
        await loc.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }));
        await advance(150);
        const box = await loc.boundingBox();
        if (!box) continue;
        const read = () =>
          loc.evaluate((el, props) => {
            const cs = getComputedStyle(el);
            const v: Record<string, string> = {};
            for (const p of props) v[p] = (cs as unknown as Record<string, string>)[p] ?? "";
            return {
              values: v,
              transition: { property: cs.transitionProperty, duration: cs.transitionDuration, timingFunction: cs.transitionTimingFunction, delay: cs.transitionDelay },
              cursor: cs.cursor,
            };
          }, PROPS);
        const before = await read();
        const startIdx = order.length;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
        await page.waitForTimeout(60);
        for (const o of order.slice(startIdx)) await describe(o.id, "hover");
        const maxMs = Math.min(
          2000,
          Math.max(...before.transition.duration.split(",").map((d) => parseFloat(d) * (d.includes("ms") ? 1 : 1000)), 0) +
            Math.max(...before.transition.delay.split(",").map((d) => parseFloat(d) * (d.includes("ms") ? 1 : 1000)), 0) + 100,
        );
        await page.waitForTimeout(maxMs);
        const after = await read();
        const changed: Record<string, { from: string; to: string }> = {};
        for (const p of PROPS) if (before.values[p] !== after.values[p]) changed[p] = { from: before.values[p]!, to: after.values[p]! };
        const started = order.slice(startIdx).map((o) => described.get(o.id)).filter((d): d is Described => !!d);
        hoverResults.push({
          selector: sel,
          rect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
          transition: before.transition,
          cursor: before.cursor,
          changed,
          animations: started.map((d) => ({ type: d.type, name: d.name, target: d.target, timing: d.timing, effectiveEasing: d.effectiveEasing, keyframes: d.keyframes })),
        });
      } catch (e) {
        log("hover failed for", sel, (e as Error).message.split("\n")[0]);
      }
    }
    await page.mouse.move(2, 2);

    // --- JS animation library detection (GSAP / ScrollTrigger / smooth scroll) ---
    const libraries = await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      const path = w.__pcPath as (e: Element) => string;
      const prim = (v: unknown): unknown => (["string", "number", "boolean"].includes(typeof v) ? v : typeof v === "function" ? "[fn]" : Array.isArray(v) ? v.slice(0, 6).map(prim) : v && typeof v === "object" ? "[obj]" : v);
      const out: Record<string, unknown> = {};
      const g = w.gsap;
      if (g) {
        const tweens: unknown[] = [];
        try {
          for (const t of g.globalTimeline.getChildren(true, true, true).slice(0, 120)) {
            const targets = typeof t.targets === "function" ? t.targets().slice(0, 3).map((x: unknown) => (x instanceof Element ? path(x) : String(x).slice(0, 40))) : [];
            const vars: Record<string, unknown> = {};
            for (const k of Object.keys(t.vars ?? {})) if (k !== "scrollTrigger") vars[k] = prim(t.vars[k]);
            const st = t.vars?.scrollTrigger;
            tweens.push({
              kind: t.getChildren ? "timeline" : "tween",
              targets, vars, duration: t.duration?.(), delay: t.delay?.(), startTime: t.startTime?.(),
              scrollTrigger: st && typeof st === "object" ? Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v instanceof Element ? path(v) : prim(v)])) : undefined,
            });
          }
        } catch (e) { out.gsapError = String(e); }
        out.gsap = { version: g.version, tweens, plugins: Object.keys(g.plugins ?? {}).slice(0, 20) };
      }
      const ST = w.ScrollTrigger ?? g?.plugins?.scrollTrigger;
      if (ST?.getAll) {
        out.scrollTriggers = ST.getAll().slice(0, 80).map((s: any) => ({
          trigger: s.trigger instanceof Element ? path(s.trigger) : null,
          pin: s.pin instanceof Element ? path(s.pin) : !!s.pin,
          startPx: s.start, endPx: s.end,
          vars: Object.fromEntries(["start", "end", "scrub", "toggleActions", "snap", "pinSpacing", "anticipatePin"].filter((k) => s.vars?.[k] !== undefined).map((k) => [k, prim(s.vars[k])])),
        }));
      }
      const html = document.documentElement;
      out.smoothScroll = {
        lenis: !!(w.lenis || w.Lenis || html.classList.contains("lenis")),
        locomotive: !!document.querySelector("[data-scroll-container]"),
        scrollSmoother: !!(w.ScrollSmoother || document.querySelector("#smooth-wrapper")),
      };
      out.attributeHooks = {
        aos: document.querySelectorAll("[data-aos]").length,
        dataScroll: document.querySelectorAll("[data-scroll]").length,
        framerMotion: document.querySelectorAll("[data-framer-appear-id], [data-projection-id]").length,
      };
      out.scrollBehaviorCss = getComputedStyle(html).scrollBehavior;
      return out;
    });

    const scriptHints = [...new Set(scripts)]
      .filter((s) => /gsap|scrolltrigger|lenis|locomotive|framer|motion|three|aos|lottie|splitting|swiper|barba|anime|popmotion/i.test(s))
      .slice(0, 30);
    const mutationLog = (await page.evaluate(() => (window as unknown as { __pcMutations?: unknown[] }).__pcMutations ?? [])) as unknown[];

    const result = {
      url,
      clock: virtualTime ? "virtual" : "real",
      readiness: gates,
      scrollModel,
      smoothScroll,
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      maxScroll,
      animationCount: described.size,
      animations: [...described.values()],
      scrollSteps: steps,
      hover: hoverResults,
      libraries,
      scriptHints,
      mutationLog: mutationLog.slice(0, 400),
      mutationLogTotal: mutationLog.length,
      notes: [
        "animations[].keyframes are the exact Web Animations keyframes (transform/opacity/etc.) with per-keyframe easing. Use effectiveEasing (cubic-bezier()/steps()/linear): for CSS @keyframes the curve lives on the keyframes, for transitions on timing.easing.",
        "animations[].samples are computed values with the document timeline frozen (CDP Animation.setPlaybackRate=0 + seekAnimations).",
        "mutationLog shows class/style changes tied to scrollY: JS-driven reveals (IntersectionObserver, GSAP inline styles).",
        "scrollSteps[].frames[] lists, per checkpoint and frame offset, only the elements whose transform/opacity/clip-path changed (virtual clock = reproducible frame numbers).",
        "smoothScroll.interpolated=true means wheel input is eased over many frames: use estimatedLerpPerFrame (Lenis lerp) / settledFrame and samples to match the curve; model=wheel means a virtual scroller (driver names the transformed wrapper).",
        "If libraries.gsap is absent but jsDriven samples change with scroll, the bundle hides GSAP: infer easing from sampled values.",
      ],
    };
    const jsonPath = path.join(dir, "timeline.json");
    await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
    return { timelineJson: jsonPath, ...result, mutationLog: result.mutationLog.slice(0, 120) };
  } finally {
    await browser.close();
  }
}
