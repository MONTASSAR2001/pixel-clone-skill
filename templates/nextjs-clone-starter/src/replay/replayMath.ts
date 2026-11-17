/**
 * Pure math for the replay runtime (no DOM, no three.js): viewport variants, responsive anchoring, keyframe brackets,
 * interpolation and projection adaptation. Unit-tested from the skill repo (test/replay-math.test.mjs).
 */
export type Rect = { x: number; y: number; w: number; h: number };
export type Size = [number, number];
/** Linear responsive rule: x += kx*dW, w += kw*dW, y += ky*dH, h += kh*dH, fontSize += kf*dW. */
export type Anchor = [number, number, number, number, number];
export type Variant = { width: number; height: number; base: string; scrollHeight?: number | null };

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Frame-rate independent damping: fraction of the remaining distance covered in dtMs (half-life in ms). */
export const dampFactor = (dtMs: number, halfLifeMs: number) => (halfLifeMs <= 0 ? 1 : 1 - Math.pow(2, -Math.max(0, dtMs) / halfLifeMs));

/**
 * One step of the damped scroll follower. Converges exactly (snaps under 0.5px) and jumps when the distance is larger
 * than `jumpPx` (anchor links, End key: the target jumps too).
 */
export function dampScroll(current: number, target: number, dtMs: number, halfLifeMs: number, jumpPx: number): number {
  const d = target - current;
  if (Math.abs(d) < 0.5 || Math.abs(d) > jumpPx) return target;
  const next = current + d * dampFactor(dtMs, halfLifeMs);
  return Math.abs(target - next) < 0.5 ? target : next;
}

/** The two keyframes around y (sorted ascending keys) and the blend between them. */
export function bracket(keys: readonly number[], y: number): { a: number; b: number; t: number } | null {
  if (!keys.length) return null;
  if (y <= keys[0]!) return { a: keys[0]!, b: keys[0]!, t: 0 };
  const last = keys[keys.length - 1]!;
  if (y >= last) return { a: last, b: last, t: 0 };
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m]! <= y) lo = m; else hi = m; }
  const a = keys[lo]!, b = keys[hi]!;
  return { a, b, t: b === a ? 0 : (y - a) / (b - a) };
}

/** The captured viewport variant that best matches the window (aspect ratio first, then size). */
export function pickVariant<V extends { width: number; height: number }>(variants: readonly V[], W: number, H: number): V | null {
  let best: V | null = null, score = Infinity;
  for (const v of variants) {
    const s = 2 * Math.abs(Math.log((W / H) / (v.width / v.height))) + Math.abs(Math.log(W / v.width));
    if (s < score) { score = s; best = v; }
  }
  return best;
}

/**
 * Fallback anchoring when no multi-viewport fit exists for a box: full-width boxes stretch, pinned (fixed) boxes stick
 * to their nearest edge (or stay centered), flow content keeps the composition centered. Mirrors
 * mcp-server/src/lib/responsive.ts heuristicRule.
 */
export function heuristicAnchor(r: Rect, cap: Size, pinned: boolean): Anchor {
  const [W, H] = cap;
  let kx = 0.5, kw = 0, ky = 0, kh = 0;
  if (r.x <= 1 && r.w >= W - 2) { kx = 0; kw = 1; }
  else if (pinned) { const cx = r.x + r.w / 2; kx = Math.abs(cx - W / 2) <= 2 ? 0.5 : cx > W / 2 ? 1 : 0; }
  if (pinned) {
    if (r.y <= 1 && r.h >= H - 2) kh = 1;
    else { const cy = r.y + r.h / 2; ky = Math.abs(cy - H / 2) <= 2 ? 0.5 : cy > H / 2 ? 1 : 0; }
  }
  return [kx, kw, ky, kh, 0];
}

/** Rect captured at `cap` placed in a window of size `win` by its anchor rule. */
export function anchorRect(r: Rect, k: Anchor, cap: Size, win: Size): Rect {
  const dW = win[0] - cap[0], dH = win[1] - cap[1];
  if (!dW && !dH) return r;
  return { x: r.x + k[0] * dW, w: Math.max(0, r.w + k[1] * dW), y: r.y + k[2] * dH, h: Math.max(0, r.h + k[3] * dH) };
}

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
export const shiftRect = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });

/**
 * Mix two JSON-serialized uniform/flag values (numbers, number arrays, {$vec}, {$color}, {$mat}); anything else
 * (textures, booleans, strings, mismatched shapes) is not interpolable and returns `a`.
 */
export function mixValue(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === "number" && typeof b === "number") return lerp(a, b, t);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => typeof x === "number") && b.every((x) => typeof x === "number")) return a.map((x, i) => lerp(x as number, b[i] as number, t));
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of ["$vec", "$color", "$mat"] as const) {
      const av = (a as Record<string, unknown>)[k], bv = (b as Record<string, unknown>)[k];
      if (Array.isArray(av) && Array.isArray(bv) && av.length === bv.length) return { [k]: av.map((x, i) => lerp(x, bv[i], t)) };
    }
  }
  return a;
}

/**
 * Whether a captured uniform encodes the drawing-buffer size (so it must follow the window):
 * "px" = [w,h] (CSS or buffer px), "inv" = [1/w,1/h], "px4" = [w,h,1/w,1/h], "aspect" = w/h. null otherwise.
 */
export function resolutionKind(name: string, raw: unknown, cap: Size, pr: number): "px" | "px-buf" | "inv" | "inv-buf" | "px4" | "px4-buf" | "aspect" | null {
  const near = (x: number, y: number, tol: number) => Math.abs(x - y) <= tol;
  const v = raw && typeof raw === "object" && Array.isArray((raw as { $vec?: number[] }).$vec) ? (raw as { $vec: number[] }).$vec : null;
  const [w, h] = cap;
  if (v && v.length >= 2) {
    for (const [s, suf] of [[1, ""], [pr, "-buf"]] as const) {
      if (s !== 1 && pr === 1 && suf) continue;
      const W = w * s, H = h * s;
      if (v.length === 2 && near(v[0]!, W, 0.6) && near(v[1]!, H, 0.6)) return (`px${suf}`) as "px" | "px-buf";
      if (v.length === 2 && near(v[0]!, 1 / W, 1e-6) && near(v[1]!, 1 / H, 1e-6)) return (`inv${suf}`) as "inv" | "inv-buf";
      if (v.length === 4 && near(v[0]!, W, 0.6) && near(v[1]!, H, 0.6) && near(v[2]!, 1 / W, 1e-6) && near(v[3]!, 1 / H, 1e-6)) return (`px4${suf}`) as "px4" | "px4-buf";
    }
  }
  if (typeof raw === "number" && /aspect|ratio/i.test(name) && near(raw, w / h, 1e-3)) return "aspect";
  return null;
}

/** The value a resolution-kind uniform takes at window size `win` (buffer = CSS px * pr). */
export function resolutionValue(kind: NonNullable<ReturnType<typeof resolutionKind>>, win: Size, pr: number): number | number[] {
  const buf = kind.endsWith("-buf") ? pr : 1;
  const W = win[0] * buf, H = win[1] * buf;
  if (kind.startsWith("px4")) return [W, H, 1 / W, 1 / H];
  if (kind.startsWith("px")) return [W, H];
  if (kind.startsWith("inv")) return [1 / W, 1 / H];
  return win[0] / win[1];
}

/**
 * Adapt a captured projection matrix (column-major, three.js) to a new window aspect, the way sites do on resize:
 * perspective cameras that tracked the viewport keep their vertical FOV (P[0] = f/aspect); pixel-space orthographic
 * cameras keep 1 unit = 1 px; aspect-normalised ortho cameras keep their height. Cameras that did not follow the
 * viewport (render-to-texture cameras) are returned unchanged.
 */
export function adaptProjection(P: readonly number[], cam: { type: string; aspect?: number | null; left?: number | null; right?: number | null; top?: number | null; bottom?: number | null }, cap: Size, win: Size): number[] {
  const out = P.slice();
  if (cap[0] === win[0] && cap[1] === win[1]) return out;
  const capAspect = cap[0] / cap[1], winAspect = win[0] / win[1];
  if (cam.type === "PerspectiveCamera" || P[11] === -1) {
    if (cam.aspect != null && Math.abs(cam.aspect - capAspect) > 0.01) return out;
    out[0] = P[0]! * (capAspect / winAspect);
    return out;
  }
  const w = (cam.right ?? 0) - (cam.left ?? 0), h = (cam.top ?? 0) - (cam.bottom ?? 0);
  if (Math.abs(w - cap[0]) < 1 && Math.abs(h - cap[1]) < 1) { out[0] = P[0]! * (cap[0] / win[0]); out[5] = P[5]! * (cap[1] / win[1]); return out; }
  if (h && Math.abs(w / h - capAspect) < 0.01) { out[0] = P[0]! * (capAspect / winAspect); return out; }
  return out;
}

/**
 * CSS for a box drawn at its untransformed rect `flat` (left/top = flat.x/y, transform-origin 0 0) so that the
 * cumulative viewport-space affine m = [a,b,c,d,e,f] (p' = A p + t) is reproduced exactly.
 */
export function localMatrix(flat: Rect, m: readonly number[]): string {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const tx = a * flat.x + c * flat.y + e - flat.x;
  const ty = b * flat.x + d * flat.y + f - flat.y;
  return `matrix(${a},${b},${c},${d},${tx},${ty})`;
}

const MOTION_PROPS = new Set(["transform", "opacity", "translate", "rotate", "scale", "left", "top", "width", "height", "inset"]);
const PAINT_ALL = "color, background-color, border-color, border-top-color, border-right-color, border-bottom-color, border-left-color, outline-color, box-shadow, text-shadow, filter, backdrop-filter, text-decoration-color, fill, stroke";

/**
 * The target's own transition list for an element, split in two: `paint` (colours, shadows, filters) is always active
 * so hover/click restyles animate with the captured 150-250 ms curves; `full` also animates transform/opacity and is
 * only switched on while a UI state changes (scroll-driven motion must never lag behind the scroll).
 */
export function splitTransitions(s: Record<string, string | undefined>): { paint: string; full: string; maxMs: number } {
  const props = (s.transitionProperty ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const durs = (s.transitionDuration ?? "").split(",").map((x) => x.trim());
  const fns = splitTopLevel(s.transitionTimingFunction ?? "");
  const dels = (s.transitionDelay ?? "").split(",").map((x) => x.trim());
  const ms = (v: string | undefined) => (!v ? 0 : v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000) || 0;
  const paint: string[] = [], full: string[] = [];
  let maxMs = 0;
  props.forEach((p, i) => {
    const d = durs[i % (durs.length || 1)] ?? "0s", fn = fns[i % (fns.length || 1)] ?? "ease", dl = dels[i % (dels.length || 1)] ?? "0s";
    if (p === "none" || ms(d) <= 0) return;
    maxMs = Math.max(maxMs, ms(d) + ms(dl));
    const item = (q: string) => `${q} ${d} ${fn} ${dl}`;
    full.push(item(p));
    if (p === "all") paint.push(...PAINT_ALL.split(", ").map(item));
    else if (!MOTION_PROPS.has(p)) paint.push(item(p));
  });
  return { paint: paint.join(", "), full: full.join(", "), maxMs };
}

function splitTopLevel(v: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Document height for a window of size W x H from the captured variants' scrollHeights: exact at a captured size;
 * otherwise the variants decide whether the page height follows the viewport height (vh sections), its width (vw
 * sizing) or neither (fixed px), and the nearest variant is scaled accordingly.
 */
export function docHeight(variants: readonly { width: number; height: number; scrollHeight?: number | null }[], W: number, H: number): number | null {
  const vs = variants.filter((v) => v.scrollHeight && v.scrollHeight > 0) as { width: number; height: number; scrollHeight: number }[];
  if (!vs.length) return null;
  const exact = vs.find((v) => v.width === W && v.height === H);
  if (exact) return exact.scrollHeight;
  const near = pickVariant(vs, W, H)!;
  if (vs.length < 2) return near.scrollHeight;
  const [a, b] = [vs[0]!, vs[vs.length - 1]!];
  const r = b.scrollHeight / a.scrollHeight;
  const tol = 0.03;
  if (Math.abs(r - b.height / a.height) < tol) return near.scrollHeight * (H / near.height);
  if (Math.abs(r - b.width / a.width) < tol) return near.scrollHeight * (W / near.width);
  if (Math.abs(r - 1) < tol) return near.scrollHeight;
  // mixed: linear in width through the two captures
  const k = (b.scrollHeight - a.scrollHeight) / (b.width - a.width || 1);
  return Math.max(H, near.scrollHeight + k * (W - near.width));
}

/** Scroll position in the captured variant for a live scroll position (same scroll progress). */
export function toCaptureScroll(sy: number, capMaxScroll: number | null, liveMaxScroll: number): number {
  if (!capMaxScroll || liveMaxScroll <= 0 || Math.abs(capMaxScroll - liveMaxScroll) < 1) return sy;
  return (sy / liveMaxScroll) * capMaxScroll;
}
