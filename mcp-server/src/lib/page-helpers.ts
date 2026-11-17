/** Injected into pages: stable CSS-path builder shared by every tool. */
export const PATH_HELPER_INIT = `(() => {
  if (window.__pcPath) return;
  window.__pcPath = function (el) {
    if (!(el instanceof Element)) return null;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      if (n.id && !/^[0-9]/.test(n.id) && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) {
        parts.unshift('#' + CSS.escape(n.id));
        break;
      }
      let i = 1, s = n;
      while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      n = n.parentElement;
    }
    return parts.join('>');
  };
})();`;

/** Records class/style attribute mutations with scroll position: exposes JS-driven reveals. */
export const MUTATION_LOG_INIT = `(() => {
  if (window.__pcMutations) return;
  window.__pcMutations = [];
  try {
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        if (window.__pcMutations.length > 1500) return;
        const el = m.target;
        window.__pcMutations.push({
          t: Math.round(performance.now()),
          scrollY: Math.round(window.scrollY),
          selector: window.__pcPath ? window.__pcPath(el) : null,
          attr: m.attributeName,
          from: m.oldValue,
          to: el.getAttribute ? el.getAttribute(m.attributeName) : null,
        });
      }
    });
    mo.observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style'] });
  } catch (e) {}
})();`;

/**
 * Deterministic virtual time for visual diffing. Replaces requestAnimationFrame, performance.now and
 * Date.now so animation frames advance ONLY when the harness calls window.__pcStep(n). Two pages that
 * run the same step sequence render identical frame numbers, even for per-frame (non time-based) animation.
 * Real setTimeout/setInterval, network and CSS animations are untouched.
 */
export const VIRTUAL_TIME_INIT = `(() => {
  if (window.__pcStep) return;
  window.__pcVirtual = true;
  const FRAME = 1000 / 60;
  const baseDate = 1700000000000;
  let vt = 0, nextId = 0, queue = [];
  window.requestAnimationFrame = (cb) => { queue.push({ id: ++nextId, cb }); return nextId; };
  window.cancelAnimationFrame = (id) => { queue = queue.filter((q) => q.id !== id); };
  performance.now = () => vt;
  Date.now = () => baseDate + vt;
  window.__pcFrames = 0;
  window.__pcStep = (n) => {
    for (let k = 0; k < n; k++) {
      vt += FRAME;
      window.__pcFrames++;
      const run = queue; queue = [];
      for (const q of run) { try { q.cb(vt); } catch (e) { console.error(e); } }
    }
    return window.__pcFrames;
  };
})();`;

/**
 * Passive profiling hooks installed in every context before page scripts run.
 * They record what the page *does* (context types, shadow DOM, media queries, WAAPI use...), which is
 * far more reliable than looking for globals when libraries are bundled privately.
 */
export const PROFILE_HOOK_INIT = `(() => {
  if (window.__pcProfile) return;
  const P = (window.__pcProfile = { contexts: [], shadowRoots: 0, customElements: [], mediaQueries: [], waapi: 0, workers: 0, wasm: 0, io: 0, ro: 0, audio: 0 });
  try {
    const gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, a) { try { P.contexts.push({ type: String(t), offscreen: false, w: this.width, h: this.height }); } catch (e) {} return gc.call(this, t, a); };
    if (window.OffscreenCanvas) {
      const og = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function (t, a) { P.contexts.push({ type: String(t), offscreen: true, w: this.width, h: this.height }); return og.call(this, t, a); };
    }
  } catch (e) {}
  try { const as = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { P.shadowRoots++; return as.call(this, i); }; } catch (e) {}
  try { const d = customElements.define.bind(customElements); customElements.define = function (n, c, o) { if (P.customElements.length < 60) P.customElements.push(n); return d(n, c, o); }; } catch (e) {}
  try { const mm = window.matchMedia.bind(window); window.matchMedia = function (q) { if (P.mediaQueries.length < 60 && !P.mediaQueries.includes(q)) P.mediaQueries.push(q); return mm(q); }; } catch (e) {}
  try { const an = Element.prototype.animate; Element.prototype.animate = function () { P.waapi++; return an.apply(this, arguments); }; } catch (e) {}
  try { const W = window.Worker; if (W) window.Worker = new Proxy(W, { construct(t, a) { P.workers++; return new t(...a); } }); } catch (e) {}
  try { const IO = window.IntersectionObserver; if (IO) window.IntersectionObserver = new Proxy(IO, { construct(t, a) { P.io++; return new t(...a); } }); } catch (e) {}
  try { const RO = window.ResizeObserver; if (RO) window.ResizeObserver = new Proxy(RO, { construct(t, a) { P.ro++; return new t(...a); } }); } catch (e) {}
  try { const AC = window.AudioContext; if (AC) window.AudioContext = new Proxy(AC, { construct(t, a) { P.audio++; return new t(...a); } }); } catch (e) {}
  try {
    const dev = window.__THREE_DEVTOOLS__ || new EventTarget();
    window.__THREE_DEVTOOLS__ = dev;
    P.three = { renderers: 0, scenes: 0 };
    dev.addEventListener('observe', (e) => { const o = e.detail; if (o && o.isWebGLRenderer) P.three.renderers++; else if (o && o.isScene) P.three.scenes++; });
  } catch (e) {}
  try { if (window.WebAssembly) for (const f of ['instantiate', 'instantiateStreaming']) { const o = WebAssembly[f]; if (o) WebAssembly[f] = function () { P.wasm++; return o.apply(this, arguments); }; } } catch (e) {}
})();`;
