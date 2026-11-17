"use client";

/**
 * Which captured state the replay layers show, beyond "the keyframes around the current scroll position":
 * - an explicit UI state ("menu-open", "hover", ...) requested via `pc-ui-state` events (window CustomEvent, detail =
 *   state name or null);
 * - "top-return": the top of the page AFTER a deep visit. The initial hero (y-0) is ALWAYS the entry view: top-return
 *   only activates when (1) the replay data marked it as genuinely distinct from the initial top (compare_visual_diff
 *   measures this while dumping; staging drops it otherwise), (2) the visitor scrolled at least 1.5 viewports down and
 *   (3) came back to the top half of the first viewport.
 * Layers subscribe with onReplayState(); the active name is the dumped state file suffix.
 */
type Listener = (name: string | null) => void;
const listeners = new Set<Listener>();
let ui: string | null = null;
let maxSeen = 0;
let current: string | null = null;
let started = false;
let topReturnAvailable = false;

const DEEP = 1.5;
const compute = (): string | null => {
  if (ui) return ui;
  if (typeof window === "undefined" || !topReturnAvailable) return null;
  const vh = window.innerHeight;
  return maxSeen >= DEEP * vh && window.scrollY < vh / 2 ? "top-return" : null;
};
const emit = () => {
  const next = compute();
  if (next === current) return;
  current = next;
  for (const l of listeners) l(current);
};
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  // A page restored deep by the browser (reload) is not a visit: only scrolling after load counts.
  window.addEventListener("scroll", () => { maxSeen = Math.max(maxSeen, window.scrollY); emit(); }, { passive: true });
  window.addEventListener("pc-ui-state", (e) => { ui = (e as CustomEvent<string | null>).detail ?? null; emit(); });
}
/** Called by the data loader: the replay variant has a distinct top-return state. */
export function setTopReturnAvailable(v: boolean) {
  topReturnAvailable = v;
  emit();
}
export function onReplayState(l: Listener): () => void {
  start();
  listeners.add(l);
  l(compute());
  return () => listeners.delete(l);
}
export const activeReplayState = () => current;
