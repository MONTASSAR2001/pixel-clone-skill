/**
 * Responsive layout rules, fitted from the SAME element measured at two viewports (pure, no browser).
 *
 * Every box is modelled as linear in the viewport size:
 *   x(W) = x0 + kx * (W - W0)    w(W) = w0 + kw * (W - W0)
 *   y(H) = y0 + ky * (H - H0)    h(H) = h0 + kh * (H - H0)      fontSize(W) = f0 + kf * (W - W0)
 * kx=0,kw=0 is left-anchored, kx=1 right-anchored, kx=.5 centered, kw=1 full-bleed (stretch), kx=x0/W0 & kw=w0/W0 is
 * proportional (vw units). The coefficients are exact for any layout that is linear between the two captures (the vast
 * majority: px offsets from an edge, %, vw, centered max-width columns); breakpoints are handled by capturing a viewport
 * on each side. Vertical coefficients are only meaningful for pinned (position: fixed) boxes; flow content follows the
 * document ("flow").
 */
export interface ViewportSize { width: number; height: number }
export interface Measure { x: number; y: number; w: number; h: number; fontSize?: number; pinned?: boolean }
export type HRule = "left" | "right" | "center" | "stretch" | "scale" | "center-fluid" | "fluid";
export type VRule = "top" | "bottom" | "center" | "stretch" | "scale" | "fluid" | "flow";
export interface Rule { h: HRule; v: VRule; kx: number; kw: number; ky: number; kh: number; kf: number; fitted: boolean }

const TOL = 0.08;
const near = (a: number, b: number, t = TOL) => Math.abs(a - b) <= t;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function classifyH(kx: number, kw: number, m: Measure, vp: ViewportSize): HRule {
  if (near(kw, 1) && near(kx, 0)) return "stretch";
  if (near(kw, 0)) {
    if (near(kx, 0)) return "left";
    if (near(kx, 1)) return "right";
    if (near(kx, 0.5)) return "center";
  }
  if (vp.width > 0 && near(kx, m.x / vp.width) && near(kw, m.w / vp.width) && kw > TOL) return "scale";
  if (near(kx + kw / 2, 0.5)) return "center-fluid";
  return "fluid";
}

export function classifyV(ky: number, kh: number, m: Measure, vp: ViewportSize): VRule {
  if (!m.pinned) return "flow";
  if (near(kh, 1) && near(ky, 0)) return "stretch";
  if (near(kh, 0)) {
    if (near(ky, 0)) return "top";
    if (near(ky, 1)) return "bottom";
    if (near(ky, 0.5)) return "center";
  }
  if (vp.height > 0 && near(ky, m.y / vp.height) && near(kh, m.h / vp.height) && kh > TOL) return "scale";
  return "fluid";
}

/** Fit the linear rule of one element measured at viewport A and viewport B. */
export function fitRule(a: Measure, va: ViewportSize, b: Measure, vb: ViewportSize): Rule {
  const dW = vb.width - va.width, dH = vb.height - va.height;
  if (!dW && !dH) return heuristicRule(a, va);
  const kx = dW ? r4((b.x - a.x) / dW) : 0, kw = dW ? r4((b.w - a.w) / dW) : 0;
  const pinned = !!a.pinned;
  const ky = pinned && dH ? r4((b.y - a.y) / dH) : 0, kh = pinned && dH ? r4((b.h - a.h) / dH) : 0;
  const kf = dW && a.fontSize && b.fontSize ? r4((b.fontSize - a.fontSize) / dW) : 0;
  return { h: classifyH(kx, kw, a, va), v: classifyV(ky, kh, a, va), kx, kw, ky, kh, kf, fitted: true };
}

/**
 * Single-viewport fallback (no second capture): full-width boxes stretch, pinned HUD items anchor to the nearest
 * edge, everything else keeps the composition centered. Never leaves a fixed-size composition in a corner.
 */
export function heuristicRule(m: Measure, vp: ViewportSize): Rule {
  const W = vp.width, H = vp.height;
  let kx = 0.5, kw = 0;
  if (m.x <= 1 && m.w >= W - 2) { kx = 0; kw = 1; }
  else if (m.pinned) {
    const cx = m.x + m.w / 2;
    kx = Math.abs(cx - W / 2) <= 2 ? 0.5 : cx > W / 2 ? 1 : 0;
  }
  let ky = 0, kh = 0;
  if (m.pinned) {
    if (m.y <= 1 && m.h >= H - 2) kh = 1;
    else { const cy = m.y + m.h / 2; ky = Math.abs(cy - H / 2) <= 2 ? 0.5 : cy > H / 2 ? 1 : 0; }
  }
  return { h: classifyH(kx, kw, m, vp), v: classifyV(ky, kh, m, vp), kx, kw, ky, kh, kf: 0, fitted: false };
}

/** Where a box measured at `from` lands at viewport `to`. */
export function applyRule(m: Measure, r: Pick<Rule, "kx" | "kw" | "ky" | "kh" | "kf">, from: ViewportSize, to: ViewportSize): Measure {
  const dW = to.width - from.width, dH = to.height - from.height;
  return {
    x: m.x + r.kx * dW,
    w: Math.max(0, m.w + r.kw * dW),
    y: m.y + r.ky * dH,
    h: Math.max(0, m.h + r.kh * dH),
    fontSize: m.fontSize !== undefined ? Math.max(1, m.fontSize + r.kf * dW) : undefined,
    pinned: m.pinned,
  };
}

/** Fit rules for every key measured in both captures; keys only in A get the heuristic rule. */
export function fitRules(a: Map<string, Measure>, va: ViewportSize, b: Map<string, Measure>, vb: ViewportSize): Map<string, Rule> {
  const out = new Map<string, Rule>();
  for (const [k, m] of a) {
    const n = b.get(k);
    out.set(k, n ? fitRule(m, va, n, vb) : heuristicRule(m, va));
  }
  return out;
}

/** Compact array form used by replay data: [kx, kw, ky, kh, kf]. */
export const packRule = (r: Rule): [number, number, number, number, number] => [r.kx, r.kw, r.ky, r.kh, r.kf];
