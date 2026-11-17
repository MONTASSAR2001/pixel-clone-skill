"use client";

/**
 * Scroll-keyed DOM layer (dump-and-replay of the target's UI). Renders every visible painting box captured by the DOM
 * snapshot (rect, inherited clip, effective opacity, paint + typography styles, text / line fragments, images, videos,
 * self-contained inline SVG, ::before/::after pseudo-elements). One instance per inventory section (`sections` prop).
 *
 * - Responsive: the captured viewport variant closest to the window is used; every box is placed by its anchor rule
 *   (fitted across viewport variants by stage-replay: left/right/center/stretch/vw-proportional + fluid type), or by
 *   the edge heuristic (full-bleed stretches, pinned HUD sticks to its edge, flow content stays centered).
 * - Transforms: rotated/skewed/scaled boxes are drawn at their untransformed box with the cumulative matrix.
 * - Progressive: the keyframe at the scroll position renders first; the rest stream in by distance.
 * - Smooth: driven by the shared damped scroll clock; boxes present in both surrounding keyframes interpolate, boxes
 *   present in only one scroll with the document (pinned ones cross-fade). Updated imperatively every frame.
 * - UI states (menu-open, hover, ...): only the boxes the state changes are swapped in, at any scroll position, with
 *   the target's own transition curves.
 */
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { onReplayState, setTopReturnAvailable } from "@/lib/replayState";
import { ReplayBoundary } from "./ReplayBoundary";
import { REPLAY_ROOT, captureScrollY, json, onReplayFrame, priorityQueue, replayMetrics, smoothScrollY, useReplayVariant } from "./replayData";
import { bracket, clamp01, heuristicAnchor, lerp, lerpRect, localMatrix, splitTransitions, type Anchor, type Rect, type Size, type Variant } from "./replayMath";

export type Box = {
  key?: string; order: number; tag: string; section: string; z: number[]; rect: Rect; clip: Rect | null; clipKey?: string | null; opacity: number; blend: string; pin?: boolean;
  styles: Record<string, string>; text?: string; fragments?: { text: string; rect: Rect; flat?: boolean }[]; src?: string; poster?: string | null; svg?: string | null;
  time?: number; paused?: boolean; loop?: boolean; muted?: boolean; playbackRate?: number; xf?: Rect & { m: number[] }; pseudo?: string;
  /** Paint order relative to the main WebGL canvas, measured on the target ("behind" boxes are drawn under it). */
  zLayer?: "behind" | "above";
};
export type Frame = { y: number; viewport?: Size; boxes: Box[] };
export type Manifest = { viewport: Size; keyframes: number[]; states: string[]; topReturn?: { distinct?: boolean } | null };

// ---------------- data store (one per variant, shared by every section instance) ----------------
type Store = { base: string; manifest: Manifest | null; anchors: Record<string, Anchor>; frames: Map<string, Frame>; version: number; listeners: Set<() => void>; started: boolean };
const stores = new Map<string, Store>();
function getStore(base: string): Store {
  let s = stores.get(base);
  if (s) return s;
  s = { base, manifest: null, anchors: {}, frames: new Map(), version: 0, listeners: new Set(), started: false };
  stores.set(base, s);
  return s;
}
const bump = (s: Store) => { s.version++; for (const l of s.listeners) l(); };
const keyOfBox = (b: Box) => b.key ?? `o${b.order}`;
function startStore(s: Store) {
  if (s.started) return;
  s.started = true;
  const dir = s.base + "dom/";
  const loadFrame = async (name: string) => {
    if (s.frames.has(name)) return;
    const f = await json<Frame>(`${dir}dom-${name}.json`);
    if (!f) return;
    for (const b of f.boxes) {
      // Legacy dumps have no structural keys: never match their boxes across frames.
      b.key ??= `${name}#${b.order}`;
      // Legacy dumps stored the viewport as the clip of unclipped boxes.
      const vw = f.viewport?.[0] ?? s.manifest!.viewport[0], vh = f.viewport?.[1] ?? s.manifest!.viewport[1];
      if (b.clip && b.clip.x <= 0 && b.clip.y <= 0 && b.clip.w >= vw && b.clip.h >= vh) b.clip = null;
    }
    s.frames.set(name, f);
    bump(s);
  };
  void (async () => {
    const [m, legacyKeys, resp] = await Promise.all([json<Manifest>(dir + "manifest.json"), json<number[]>(dir + "keyframes.json"), json<{ rules: Record<string, Anchor> }>(dir + "responsive.json")]);
    const states = m?.states ?? ["menu-open", "hover", "top-return", "menu"];
    s.manifest = m ?? { viewport: [1440, 900], keyframes: legacyKeys ?? [], states, topReturn: null };
    s.anchors = resp?.rules ?? {};
    if (m) setTopReturnAvailable(states.includes("top-return") && m.topReturn?.distinct !== false);
    bump(s);
    // Hero first (the keyframe at the current scroll position), then everything else by distance.
    const sy = window.scrollY;
    const ys = s.manifest.keyframes.slice().sort((a, b) => Math.abs(a - sy) - Math.abs(b - sy));
    if (ys.length) await loadFrame(`y-${ys[0]}`);
    const st = replayMetrics();
    if (st.domHeroMs === null) st.domHeroMs = Math.round(performance.now());
    const q = priorityQueue<string>(loadFrame, (n) => (n.startsWith("y-") ? Math.abs(Number(n.slice(2)) - smoothScrollY()) : 1e9), 3);
    q.add([...ys.slice(1).map((y) => `y-${y}`), ...states.map((n) => `state-${n}`)]);
  })();
}
function useStore(base: string): Store {
  const s = getStore(base);
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { s.listeners.add(force); startStore(s); return () => { s.listeners.delete(force); }; }, [s]);
  return s;
}

// ---------------- styles ----------------
const TEXT_KEYS = ["color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "lineHeight", "letterSpacing", "wordSpacing", "textAlign", "textTransform", "textDecorationLine", "textDecorationColor", "textDecorationStyle", "textDecorationThickness", "textUnderlineOffset", "textIndent", "whiteSpace", "wordBreak", "overflowWrap", "fontFeatureSettings", "fontVariationSettings", "textShadow", "webkitTextStrokeWidth", "webkitTextStrokeColor", "webkitTextFillColor", "textOverflow", "writingMode", "textOrientation"];
const PAINT_KEYS = ["backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "backgroundClip", "backgroundOrigin", "backgroundBlendMode", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius", "borderImageSource", "borderImageSlice", "borderImageWidth", "borderImageOutset", "borderImageRepeat", "outlineWidth", "outlineStyle", "outlineColor", "outlineOffset", "boxShadow", "filter", "backdropFilter", "isolation", "objectFit", "objectPosition", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "boxSizing", "clipPath", "maskImage", "maskSize", "maskPosition", "maskRepeat", "webkitMaskImage", "webkitMaskSize", "webkitMaskPosition", "webkitMaskRepeat", "display", "flexDirection", "flexWrap", "justifyContent", "alignItems", "gap"];
const SKIP_VALUES = new Set(["", "none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)"]);
/** Paint keys skip their initial values; typography is always explicit (boxes must not inherit the clone's body). */
const pick = (s: Record<string, string>, ks: string[], skipInitial = false) => {
  const o: Record<string, string> = {};
  for (const k of ks) { const v = s[k]; if (v === undefined || v === "" || (skipInitial && SKIP_VALUES.has(v) && k !== "display")) continue; o[k.replace(/^webkit/, "Webkit")] = v; }
  return o;
};
const transCache = new WeakMap<Box, ReturnType<typeof splitTransitions>>();
const transOf = (b: Box) => { let t = transCache.get(b); if (!t) { t = splitTransitions(b.styles); transCache.set(b, t); } return t; };
const zCmp = (a: Box, b: Box) => {
  for (let i = 0; i < Math.max(a.z.length, b.z.length); i++) { const x = a.z[i] ?? 0, y = b.z[i] ?? 0; if (x !== y) return x - y; }
  return a.order - b.order;
};

// ---------------- composition ----------------
type Slot = { key: string; a?: Box; b?: Box; ov?: Box; ovY?: number; leaving?: boolean; src: Box };
type Pair = { a: number; b: number; t: number; ya: string; yb: string };
const sig = (b: Box) => `${Math.round(b.rect.x)},${Math.round(b.rect.y)},${Math.round(b.rect.w)},${Math.round(b.rect.h)}|${b.opacity}|${b.text ?? ""}|${b.src ?? ""}|${b.styles.color}|${b.styles.backgroundColor}|${b.styles.borderTopColor}|${b.styles.transform}|${b.styles.filter}|${b.styles.boxShadow}|${(b.svg ?? "").length}|${(b.fragments ?? []).map((f) => f.text).join("")}`;
const deltaCache = new Map<string, { changed: Map<string, Box>; removed: Set<string>; y: number }>();
/** What a UI state changes relative to the frame it was captured on (same scroll position). */
function stateDelta(s: Store, name: string) {
  const st = s.frames.get(`state-${name}`);
  if (!st) return null;
  const tr = s.frames.get("state-top-return");
  const keys = s.manifest?.keyframes ?? [];
  const nearest = keys.reduce((a, b) => (Math.abs(b - st.y) < Math.abs(a - st.y) ? b : a), keys[0] ?? 0);
  const baseFrame = tr && Math.abs(st.y) < 2 && name !== "top-return" ? tr : s.frames.get(`y-${nearest}`);
  const ck = `${s.base}|${name}|${baseFrame ? (baseFrame === tr ? "tr" : nearest) : "-"}`;
  if (deltaCache.has(ck)) return deltaCache.get(ck)!;
  const changed = new Map<string, Box>(), removed = new Set<string>();
  if (!baseFrame) { for (const b of st.boxes) changed.set(keyOfBox(b), b); }
  else {
    const bm = new Map(baseFrame.boxes.map((b) => [keyOfBox(b), b] as const));
    const sm = new Set<string>();
    for (const b of st.boxes) { const k = keyOfBox(b); sm.add(k); const o = bm.get(k); if (!o || sig(o) !== sig(b)) changed.set(k, b); }
    for (const k of bm.keys()) if (!sm.has(k)) removed.add(k);
  }
  const d = { changed, removed, y: st.y };
  deltaCache.set(ck, d);
  return d;
}

/** Current geometry of a slot at smooth scroll position `sy` (capture coordinates, before anchoring). */
function slotGeometry(sl: Slot, p: Pair | null, sy: number): { rect: Rect; clip: Rect | null; op: number; xf?: Rect & { m: number[] } } {
  if (sl.ov) {
    const dy = sl.ov.pin ? 0 : -(sy - (sl.ovY ?? 0));
    const r = sl.ov.rect, c = sl.ov.clip;
    return { rect: { ...r, y: r.y + dy }, clip: c ? { ...c, y: c.y + dy } : null, op: sl.leaving ? 0 : sl.ov.opacity, xf: sl.ov.xf ? { ...sl.ov.xf, y: sl.ov.xf.y + dy } : undefined };
  }
  const t = p ? clamp01(p.t) : 0, ya = p?.a ?? 0, yb = p?.b ?? 0;
  const { a, b } = sl;
  if (a && b) {
    const xf = a.xf && b.xf ? { ...lerpRect(a.xf, b.xf, t), m: a.xf.m.map((v, i) => lerp(v, b.xf!.m[i]!, t)) } : (t < 0.5 ? a : b).xf;
    const clip = a.clip && b.clip ? lerpRect(a.clip, b.clip, t) : (t < 0.5 ? a : b).clip;
    return { rect: lerpRect(a.rect, b.rect, t), clip, op: lerp(a.opacity, b.opacity, t), xf };
  }
  const one = (a ?? b)!;
  const fromY = a ? ya : yb;
  if (one.pin) return { rect: one.rect, clip: one.clip, op: one.opacity * (a ? 1 - t : t), xf: one.xf };
  const dy = -(sy - fromY); // scrolls with the document
  return { rect: { ...one.rect, y: one.rect.y + dy }, clip: one.clip ? { ...one.clip, y: one.clip.y + dy } : null, op: one.opacity, xf: one.xf ? { ...one.xf, y: one.xf.y + dy } : undefined };
}

// ---------------- server-rendered hero ----------------
/**
 * The hero keyframe of the primary variant, read at build time (see ReplayPreload.tsx `loadReplayHero`) and rendered on
 * the server: the hero's UI paints with the first HTML bytes, before any script, already anchored to the window by CSS.
 */
export type ReplayHero = { base: string; manifest: Manifest; anchors: Record<string, Anchor>; frame: Frame };
export const ReplayHeroContext = createContext<ReplayHero | null>(null);
export function ReplayHeroProvider({ hero, children }: { hero: ReplayHero | null; children: ReactNode }) {
  return <ReplayHeroContext.Provider value={hero}>{children}</ReplayHeroContext.Provider>;
}
function seedStore(s: Store, hero: ReplayHero) {
  if (s.manifest) return;
  s.manifest = hero.manifest;
  s.anchors = hero.anchors;
  s.frames.set(`y-${hero.frame.y}`, hero.frame);
}

// ---------------- components ----------------
const ROOT_STYLE: CSSProperties = { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 1, overflow: "hidden", containerType: "size" };
/** Boxes the target paints beneath its WebGL canvas: under <ThreeReplay/> (which sits at the default stacking level). */
const BEHIND_STYLE: CSSProperties = { ...ROOT_STYLE, zIndex: -1 };

/** Two stacking roots around the canvas: "behind" boxes at z-index -1, "above" boxes at z-index 1. */
function Layers({ kind, slots, render }: { kind: string; slots: Slot[]; render: (sl: Slot) => ReactNode }) {
  const behind = slots.filter((sl) => sl.src.zLayer === "behind");
  const above = behind.length ? slots.filter((sl) => sl.src.zLayer !== "behind") : slots;
  return (
    <>
      {behind.length > 0 && <div style={BEHIND_STYLE} data-replay-layer={kind} data-z-layer="behind">{behind.map(render)}</div>}
      {above.length > 0 && <div style={ROOT_STYLE} data-replay-layer={kind} data-z-layer="above"><style>{SVG_CSS}</style>{above.map(render)}</div>}
    </>
  );
}
const SVG_CSS = "[data-dl-svg]>svg{width:100%;height:100%;display:block}";

export function DomLayer({ sections }: { sections: string[] | "*" }) {
  return (
    <ReplayBoundary name={`DomLayer(${sections === "*" ? "*" : sections.join(",")})`}>
      <DomLayerInner sections={sections} />
    </ReplayBoundary>
  );
}
function DomLayerInner({ sections }: { sections: string[] | "*" }) {
  const v = useReplayVariant();
  const hero = useContext(ReplayHeroContext);
  // Before the variant is known (server render and hydration) the server-rendered hero is shown as is.
  if (!v) return hero ? <StaticFrame hero={hero} sections={sections} /> : null;
  return <DomLayerVariant key={v.base} v={v} sections={sections} hero={hero && REPLAY_ROOT + v.base === REPLAY_ROOT + hero.base ? hero : null} />;
}

function buildSlots(A: Frame | undefined, B: Frame | undefined, t: number, sections: string[] | "*", delta: ReturnType<typeof stateDelta>, leaving: Map<string, { box: Box; y: number; until: number }> | null): Slot[] {
  const inSec = (b: Box) => sections === "*" || sections.includes(b.section);
  const map = new Map<string, Slot>();
  for (const b of A?.boxes ?? []) if (inSec(b)) map.set(keyOfBox(b), { key: keyOfBox(b), a: b, src: b });
  if (B && B !== A) for (const b of B.boxes) if (inSec(b)) { const k = keyOfBox(b); const s = map.get(k); if (s) { s.b = b; if (t >= 0.5) s.src = b; } else map.set(k, { key: k, b, src: b }); }
  if (A === B) for (const s of map.values()) s.b = s.a;
  if (delta) {
    for (const k of delta.removed) map.delete(k);
    for (const [k, b] of delta.changed) if (inSec(b)) { const s = map.get(k); if (s) { s.ov = b; s.ovY = delta.y; s.src = b; } else map.set(k, { key: k, ov: b, ovY: delta.y, src: b }); }
  }
  if (leaving) {
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    for (const [k, l] of leaving) {
      if (l.until < now) leaving.delete(k);
      else if (!map.has(k) && inSec(l.box)) map.set(k, { key: k, ov: l.box, ovY: l.y, leaving: true, src: l.box });
    }
  }
  return [...map.values()].sort((x, y) => zCmp(x.src, y.src));
}

function StaticFrame({ hero, sections }: { hero: ReplayHero; sections: string[] | "*" }) {
  const slots = buildSlots(hero.frame, hero.frame, 0, sections, null, null);
  const pair: Pair = { a: hero.frame.y, b: hero.frame.y, t: 0, ya: "", yb: "" };
  const cap = hero.manifest.viewport;
  if (!slots.length) return null;
  return <Layers kind="static" slots={slots} render={(sl) => <BoxView key={sl.key} sl={sl} g={place(sl, pair, hero.frame.y, cap, hero.anchors)} cap={cap} refs={null} entering={false} />} />;
}

function DomLayerVariant({ v, sections, hero }: { v: Variant; sections: string[] | "*"; hero: ReplayHero | null }) {
  const base = REPLAY_ROOT + v.base;
  const pre = getStore(base);
  if (hero) seedStore(pre, hero);
  const store = useStore(base);
  const [ui, setUi] = useState<string | null>(null);
  const [pair, setPair] = useState<Pair | null>(() => (hero ? { a: hero.frame.y, b: hero.frame.y, t: 0, ya: `y-${hero.frame.y}`, yb: `y-${hero.frame.y}` } : null));
  const refs = useRef(new Map<string, { el: HTMLDivElement | null; wrap: HTMLDivElement | null; last: string }>());
  const leavingRef = useRef(new Map<string, { box: Box; y: number; until: number }>());
  const switchRef = useRef<{ until: number; keys: Set<string> }>({ until: 0, keys: new Set() });
  useEffect(() => onReplayState(setUi), []);

  const m = store.manifest;
  const cap: Size = m?.viewport ?? [1440, 900];
  const keys = m?.keyframes ?? [];
  const frameAt = (y: number) => (y === 0 && ui === "top-return" ? store.frames.get("state-top-return") ?? store.frames.get("y-0") : store.frames.get(`y-${y}`));
  /** Keyframe pair for scroll position sy: interpolate only between loaded neighbours, else the nearest loaded one. */
  const pairFor = (sy: number): Pair | null => {
    const br = bracket(keys, sy);
    if (!br) return null;
    const A = frameAt(br.a), B = frameAt(br.b);
    if (A && B) return { a: br.a, b: br.b, t: br.t, ya: `y-${br.a}`, yb: `y-${br.b}` };
    let best: number | null = null;
    for (const y of keys) if (frameAt(y) && (best === null || Math.abs(y - sy) < Math.abs(best - sy))) best = y;
    return best === null ? null : { a: best, b: best, t: 0, ya: `y-${best}`, yb: `y-${best}` };
  };

  const slots = useMemo(() => {
    if (!pair) return [];
    const d = ui && ui !== "top-return" ? stateDelta(store, ui) : null;
    return buildSlots(frameAt(pair.a), frameAt(pair.b), pair.t, sections, d, leavingRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.ya, pair?.yb, pair && pair.t >= 0.5, ui, store.version, sections]);

  // UI state switches animate with the target's own transitions; boxes the state removes fade out the same way.
  const prevUi = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevUi.current; prevUi.current = ui;
    if (prev === ui) return;
    const before = prev && prev !== "top-return" ? stateDelta(store, prev) : null;
    const after = ui && ui !== "top-return" ? stateDelta(store, ui) : null;
    const ks = new Set<string>([...(before?.changed.keys() ?? []), ...(after?.changed.keys() ?? []), ...(after?.removed ?? [])]);
    let maxMs = 0;
    for (const k of ks) { const b = after?.changed.get(k) ?? before?.changed.get(k); if (b) maxMs = Math.max(maxMs, transOf(b).maxMs); }
    if (before && maxMs > 0) for (const [k, b] of before.changed) if (!after?.changed.has(k)) leavingRef.current.set(k, { box: b, y: before.y, until: performance.now() + maxMs + 50 });
    switchRef.current = { until: performance.now() + maxMs + 50, keys: ks };
    if (maxMs > 0) { const t = setTimeout(() => setPair((p) => (p ? { ...p } : p)), maxMs + 80); return () => clearTimeout(t); }
  }, [ui, store]);

  // Per-frame imperative update (transform / opacity / size) on the shared damped clock. Placement relative to the
  // window is pure CSS (container units), so resizing needs no re-render.
  useEffect(() => onReplayFrame((raw) => {
    const sy = captureScrollY(raw, v);
    const p = pairFor(sy);
    if (p && (!pair || p.ya !== pair.ya || p.yb !== pair.yb || (p.t >= 0.5) !== (pair.t >= 0.5))) { setPair(p); return; }
    if (!p) return;
    const sw = switchRef.current, switching = performance.now() < sw.until;
    for (const sl of slots) {
      const r = refs.current.get(sl.key);
      if (!r?.el) continue;
      const g = place(sl, p, sy, cap, store.anchors);
      const trans = switching && sw.keys.has(sl.key) ? transOf(sl.src).full : transOf(sl.src).paint;
      if (r.el.style.transition !== trans) r.el.style.transition = trans;
      const css = `${g.transform}|${g.opacity}|${g.width}|${g.height}|${g.clipTransform}`;
      if (css === r.last) continue;
      r.last = css;
      r.el.style.transform = g.transform;
      r.el.style.opacity = String(g.opacity);
      if (g.width) r.el.style.width = g.width;
      if (g.height) r.el.style.height = g.height;
      if (r.wrap) r.wrap.style.transform = g.clipTransform;
    }
  }), [slots, pair, cap[0], cap[1], store, v]);

  if (!pair || !slots.length) return hero && !store.frames.size ? <StaticFrame hero={hero} sections={sections} /> : null;
  const sy = captureScrollY(smoothScrollY(), v);
  return <Layers kind="live" slots={slots} render={(sl) => <BoxView key={sl.key} sl={sl} g={place(sl, pair, sy, cap, store.anchors)} cap={cap} refs={refs.current} entering={!!sl.ov && switchRef.current.keys.has(sl.key)} />} />;
}

// ---------------- placement ----------------
/** CSS length for a captured value that follows the window by `k` px per px of window growth (container units). */
const along = (v: number, k: number, capLen: number, unit: "cqw" | "cqh") => (k ? `calc(${round(v)}px + ${k} * (100${unit} - ${capLen}px))` : `${round(v)}px`);
type Placed = {
  k: Anchor; home: Rect; ck: Anchor | null; clipHome: Rect | null; transform: string; clipTransform: string; opacity: number;
  width: string | null; height: string | null;
};
/**
 * Where a slot is drawn: `home` (its source box in capture coordinates; anchored to the window by CSS) and the
 * per-frame transform that moves it to its current interpolated position (plus the cumulative matrix of transformed
 * boxes). Motion is window-independent: both positions carry the same anchor.
 */
function place(sl: Slot, p: Pair | null, sy: number, cap: Size, anchors: Record<string, Anchor>): Placed {
  const src = sl.src;
  const k = anchors[sl.key] ?? heuristicAnchor(src.rect, cap, !!src.pin);
  const g = slotGeometry(sl, p, sy);
  const home = src.xf ?? src.rect;
  const cur = g.xf ?? g.rect;
  let dx = cur.x - home.x, dy = cur.y - home.y;
  let clipHome: Rect | null = null, ck: Anchor | null = null, clipTransform = "";
  if (src.clip) {
    ck = (src.clipKey && anchors[src.clipKey]) || heuristicAnchor(src.clip, cap, !!src.pin);
    clipHome = src.clip;
    const c = g.clip ?? src.clip;
    clipTransform = `translate(${round(c.x - clipHome.x)}px,${round(c.y - clipHome.y)}px)`;
    dx -= c.x - clipHome.x; dy -= c.y - clipHome.y; // the box moves relative to its clip
  }
  const transform = `translate(${round(dx)}px,${round(dy)}px)` + (g.xf ? " " + localMatrix(g.xf, g.xf.m) : "");
  const width = !g.xf && Math.abs(cur.w - home.w) > 0.5 ? along(cur.w, k[1], cap[0], "cqw") : null;
  const height = !g.xf && Math.abs(cur.h - home.h) > 0.5 ? along(cur.h, k[3], cap[1], "cqh") : null;
  return { k, home, ck, clipHome, transform, clipTransform, opacity: Math.round(g.op * 1000) / 1000, width, height };
}
const round = (n: number) => Math.round(n * 100) / 100;

/** Typography that follows the window (fluid type fitted across viewports): px values scale with the font size. */
function fluidType(s: Record<string, string>, kf: number, capW: number): Record<string, string> {
  const f0 = parseFloat(s.fontSize ?? "");
  if (!kf || !f0) return {};
  const o: Record<string, string> = { fontSize: along(f0, kf, capW, "cqw") };
  for (const p of ["lineHeight", "letterSpacing", "wordSpacing", "textIndent"]) { const v = s[p]; if (v && v.endsWith("px")) { const n = parseFloat(v); o[p] = along(n, (n / f0) * kf, capW, "cqw"); } }
  return o;
}

type Refs = Map<string, { el: HTMLDivElement | null; wrap: HTMLDivElement | null; last: string }>;
function BoxView({ sl, g, cap, refs, entering }: { sl: Slot; g: Placed; cap: Size; refs: Refs | null; entering: boolean }) {
  const b = sl.src;
  const { k, home } = g;
  const xf = !!b.xf;
  // left/top relative to the clip wrapper when clipped: (box - clip) in capture px + (k - ck) * window growth
  const lx = g.clipHome && g.ck ? along(home.x - g.clipHome.x, k[0] - g.ck[0], cap[0], "cqw") : along(home.x, k[0], cap[0], "cqw");
  const ty = g.clipHome && g.ck ? along(home.y - g.clipHome.y, k[2] - g.ck[2], cap[1], "cqh") : along(home.y, k[2], cap[1], "cqh");
  const type = { ...pick(b.styles, TEXT_KEYS), ...fluidType(b.styles, k[4], cap[0]) };
  const own: CSSProperties = {
    position: "absolute", left: lx, top: ty,
    width: xf ? `${home.w}px` : g.width ?? along(home.w, k[1], cap[0], "cqw"), height: xf ? `${home.h}px` : g.height ?? along(home.h, k[3], cap[1], "cqh"),
    margin: 0, overflow: "visible", transformOrigin: "0 0",
    mixBlendMode: b.blend as CSSProperties["mixBlendMode"], ...pick(b.styles, PAINT_KEYS, true), ...type,
    transform: g.transform, opacity: entering && transOf(b).maxMs > 0 ? 0 : g.opacity, transition: transOf(b).paint,
  };
  if (own.display === "inline" || own.display === "contents") own.display = "block";
  const bl = parseFloat(b.styles.borderLeftWidth ?? "0") || 0, bt = parseFloat(b.styles.borderTopWidth ?? "0") || 0;
  const origin = b.xf ?? b.rect;
  let inner: ReactNode = null;
  if (b.tag === "img" && b.src) inner = <img src={b.src} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: b.styles.objectFit as CSSProperties["objectFit"], objectPosition: b.styles.objectPosition, display: "block" }} />;
  else if (b.tag === "video" && b.src) inner = <SyncedVideo b={b} />;
  else if (b.svg) inner = <div data-dl-svg="" style={{ width: "100%", height: "100%" }} dangerouslySetInnerHTML={{ __html: b.svg }} />;
  else if (b.pseudo && b.src) inner = <img src={b.src} alt="" style={{ width: "100%", height: "100%", display: "block" }} />;
  else if (b.text !== undefined) inner = b.text;
  const frags = b.fragments?.map((f, i) => (
    <div key={i} style={{ position: "absolute", left: f.rect.x - origin.x - bl, top: f.rect.y - origin.y - bt, width: f.rect.w + 2, height: f.rect.h, whiteSpace: "pre", ...type, textIndent: 0, padding: 0 }}>{f.text}</div>
  ));
  const setRef = refs ? (el: HTMLDivElement | null) => { const r = refs.get(sl.key) ?? { el: null, wrap: null, last: "" }; r.el = el; refs.set(sl.key, r); if (!el) refs.delete(sl.key); } : undefined;
  const setWrap = refs ? (el: HTMLDivElement | null) => { const r = refs.get(sl.key) ?? { el: null, wrap: null, last: "" }; r.wrap = el; refs.set(sl.key, r); } : undefined;
  const node = <div ref={setRef} data-section={b.section} data-key={sl.key} style={own}>{inner}{frags}</div>;
  if (!g.clipHome || !g.ck) return node;
  const c = g.clipHome, ck = g.ck;
  return (
    <div ref={setWrap} style={{ position: "absolute", left: along(c.x, ck[0], cap[0], "cqw"), top: along(c.y, ck[2], cap[1], "cqh"), width: along(c.w, ck[1], cap[0], "cqw"), height: along(c.h, ck[3], cap[1], "cqh"), overflow: "hidden", transform: g.clipTransform }}>
      {node}
    </div>
  );
}

/**
 * Video timeline sync. Visitors: the video starts at the frame the target showed (same rate, loop, paused state) and
 * plays on. Visual diff (compare_visual_diff sets window.__pcVisualDiff) or virtual time (freezeTime): the video is
 * held at the recorded frame of the current keyframe/state, so it matches the target frame for frame.
 */
export const mediaFrozen = () => typeof window !== "undefined" && !!((window as unknown as { __pcVisualDiff?: boolean; __pcVirtual?: boolean }).__pcVisualDiff || (window as unknown as { __pcVirtual?: boolean }).__pcVirtual);
function SyncedVideo({ b }: { b: Box }) {
  const ref = useRef<HTMLVideoElement>(null);
  const frozen = mediaFrozen();
  useEffect(() => {
    const v = ref.current; if (!v) return;
    const sync = () => {
      if (b.playbackRate) v.playbackRate = b.playbackRate;
      if (typeof b.time === "number" && isFinite(b.time)) v.currentTime = b.time;
      if (frozen || b.paused) v.pause(); else void v.play().catch(() => undefined);
    };
    if (v.readyState >= 1) sync(); else v.addEventListener("loadedmetadata", sync, { once: true });
    // While frozen, re-seek whenever the keyframe's recorded time changes; visitors only seek on mount.
  }, [b.src, frozen ? b.time : 0, b.paused, frozen]);
  return <video ref={ref} src={b.src} poster={b.poster ?? undefined} muted={b.muted ?? true} loop={b.loop ?? true} playsInline preload="auto" autoPlay={!b.paused && !frozen} data-time={b.time} style={{ width: "100%", height: "100%", objectFit: b.styles.objectFit as CSSProperties["objectFit"], display: "block" }} />;
}
