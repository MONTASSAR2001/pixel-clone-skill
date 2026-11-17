"use client";

/**
 * Shared replay infrastructure: viewport variant selection, one damped scroll clock for every layer, and a
 * priority-ordered fetch queue (the keyframe the visitor is looking at first, then outward by distance).
 */
import { useEffect, useState } from "react";
import { dampScroll, docHeight, pickVariant, toCaptureScroll, type Variant } from "./replayMath";

export const REPLAY_ROOT = "/replay/";

// ---------------- variants ----------------
let variantsPromise: Promise<Variant[]> | null = null;
export const loadVariants = () =>
  (variantsPromise ??= (typeof window !== "undefined" && (window as unknown as { __replayVariants?: Variant[] }).__replayVariants
    ? Promise.resolve((window as unknown as { __replayVariants: Variant[] }).__replayVariants)
    : fetch(REPLAY_ROOT + "viewports.json").then((r) => (r.ok ? r.json() : null)).catch(() => null))
    .then((v: Variant[] | null) => (Array.isArray(v) && v.length ? v : [{ width: 1440, height: 900, base: "" }])));

/** The captured variant closest to the window; re-evaluated on resize (debounced). */
export function useReplayVariant(): Variant | null {
  const [v, setV] = useState<Variant | null>(null);
  useEffect(() => {
    let alive = true, timer = 0;
    const update = () => void loadVariants().then((vs) => {
      const best = pickVariant(vs, window.innerWidth, window.innerHeight);
      if (alive) setV((cur) => (cur && best && cur.base === best.base ? cur : best));
    });
    update();
    const onResize = () => { clearTimeout(timer); timer = window.setTimeout(update, 200); };
    window.addEventListener("resize", onResize);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener("resize", onResize); };
  }, []);
  return v;
}

/**
 * Requests started by <ReplayPreload/>'s inline script before React hydrates (the hero's data), keyed by URL.
 * Each is consumed once; later calls fetch normally (from the HTTP cache).
 */
const prefetched = (url: string): Promise<Response> | null => {
  const m = typeof window !== "undefined" ? (window as unknown as { __replayPrefetch?: Record<string, Promise<Response>> }).__replayPrefetch : undefined;
  const p = m?.[url];
  if (p) delete m![url];
  return p ?? null;
};
const get = (url: string) => prefetched(url) ?? fetch(url);
export const json = <T,>(url: string): Promise<T | null> => get(url).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);
export const binary = (url: string): Promise<ArrayBuffer> => get(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); });

// ---------------- scroll clock ----------------
/**
 * One damped scroll value for every replay layer (WebGL and DOM stay in lock-step). Follows window.scrollY with a
 * short half-life (smooth, never laggy), converges exactly, and jumps on large programmatic moves.
 */
type Tick = (smoothY: number, dtMs: number, changed: boolean) => void;
const ticks = new Set<Tick>();
let raf = 0, smooth = 0, last = 0, running = false;
export const SCROLL_HALF_LIFE_MS = 45;
export const smoothScrollY = () => smooth;
function frame(now: number) {
  const dt = last ? Math.min(100, now - last) : 16.7;
  last = now;
  const target = window.scrollY;
  const prev = smooth;
  smooth = dampScroll(smooth, target, dt, SCROLL_HALF_LIFE_MS, 2.5 * window.innerHeight);
  const changed = smooth !== prev;
  (window as unknown as { __replaySmoothY: number }).__replaySmoothY = smooth;
  for (const t of ticks) t(smooth, dt, changed);
  raf = ticks.size ? requestAnimationFrame(frame) : 0;
  running = !!raf;
}
/** Subscribe to the per-frame clock. The first subscriber starts it at the current scroll position (no glide in). */
export function onReplayFrame(t: Tick): () => void {
  if (!ticks.size && !running) { smooth = window.scrollY; last = 0; }
  ticks.add(t);
  if (!running) { running = true; raf = requestAnimationFrame(frame); }
  return () => { ticks.delete(t); if (!ticks.size && raf) { cancelAnimationFrame(raf); raf = 0; running = false; } };
}

// ---------------- priority queue ----------------
/**
 * Loads items by priority with bounded concurrency. `priority` is re-evaluated every time a slot frees up, so the
 * queue follows the visitor: nearest keyframes to the current scroll position first.
 */
export function priorityQueue<K>(load: (k: K) => Promise<unknown>, priority: (k: K) => number, concurrency = 3) {
  const waiting = new Set<K>();
  let active = 0, stopped = false;
  const pump = () => {
    while (!stopped && active < concurrency && waiting.size) {
      let best: K | null = null, bp = Infinity;
      for (const k of waiting) { const p = priority(k); if (p < bp) { bp = p; best = k; } }
      waiting.delete(best as K);
      active++;
      void load(best as K).catch(() => undefined).finally(() => { active--; pump(); });
    }
  };
  return {
    add(ks: Iterable<K>) { for (const k of ks) waiting.add(k); pump(); },
    stop() { stopped = true; waiting.clear(); },
  };
}

/** requestIdleCallback with a timeout fallback (Safari). */
export const idle = (fn: () => void, timeout = 200) => {
  const w = window as unknown as { requestIdleCallback?: (f: () => void, o: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout }); else setTimeout(fn, 16);
};

/** Shared load metrics (read by tests and the verify script). */
export const replayMetrics = () => {
  const w = window as unknown as { __replay?: Record<string, unknown> };
  return (w.__replay ??= { stage: "init", heroMs: null, heroCompleteMs: null, domHeroMs: null, frames: 0, keyframesReady: 0, keyframesTotal: 0, textures: 0, texturesFailed: 0, keyframe: null, error: null, frameCostMs: 0 });
};

/** Live scroll position mapped into the captured variant's scroll space (identity at a captured window size). */
export function captureScrollY(sy: number, v: Variant): number {
  const capMax = v.scrollHeight ? v.scrollHeight - v.height : null;
  return toCaptureScroll(sy, capMax, document.documentElement.scrollHeight - window.innerHeight);
}

/**
 * The document height the visitor scrolls through: the target's own scrollHeight for the matching viewport variant
 * (re-computed on resize), so the replayed layers keep the target's scroll length at every window size.
 */
export function useDocHeight(): number | null {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const update = () => void loadVariants().then((vs) => { if (alive) setH(docHeight(vs, window.innerWidth, window.innerHeight)); });
    update();
    window.addEventListener("resize", update);
    return () => { alive = false; window.removeEventListener("resize", update); };
  }, []);
  return h;
}
