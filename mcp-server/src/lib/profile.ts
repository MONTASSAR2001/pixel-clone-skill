import type { Page } from "playwright";
import type { ReadyReport } from "./browser.js";

export interface SiteProfile {
  url: string;
  title: string;
  archetype: string[];
  frameworks: { name: string; evidence: string }[];
  animation: Record<string, unknown>;
  rendering: {
    webgl2: boolean;
    webgl1: boolean;
    canvas2d: boolean;
    offscreenCanvas: boolean;
    three: { detected: boolean; renderers: number; scenes: number; revision: string | null };
    otherEngines: string[];
    canvases: { selector: string; rect: { x: number; y: number; w: number; h: number }; coversViewport: boolean; position: string }[];
    mainCanvas: string | null;
  };
  media: { videos: Record<string, unknown>[]; audioElements: number; audioContexts: number; inlineSvgs: number; iframes: Record<string, unknown>[] };
  layout: {
    documentHeight: number;
    viewport: { width: number; height: number };
    fixedLayers: { selector: string; zIndex: string; rect: { x: number; y: number; w: number; h: number }; pointerEvents: string }[];
    stickyCount: number;
    innerScrollers: { selector: string; scrollHeight: number; clientHeight: number }[];
    virtualScroll: boolean;
    shadowRoots: number;
    customElements: string[];
  };
  runtime: { waapiCalls: number; workers: number; wasm: number; intersectionObservers: number; resizeObservers: number; mediaQueries: string[]; cssAnimations: number };
  scriptHints: string[];
  gates: ReadyReport | null;
  recommendedScaffold: { three: boolean; canvas2d: boolean; gsap: boolean; framerMotion: boolean; lenis: boolean; replay: boolean; replayReasons: string[]; notes: string[] };
}

/** Collects the profile from a loaded page. Pass response URLs seen during load for script-based hints. */
export async function collectProfile(page: Page, responseUrls: string[], gates: ReadyReport | null): Promise<SiteProfile> {
  const raw = await page.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    const path = w.__pcPath as (e: Element) => string;
    const P = (w.__pcProfile ?? {}) as Record<string, any>;
    const vw = innerWidth, vh = innerHeight;
    const rectOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };

    const frameworks: { name: string; evidence: string }[] = [];
    const add = (name: string, evidence: string) => { if (!frameworks.some((f) => f.name === name)) frameworks.push({ name, evidence }); };
    const html = document.documentElement.outerHTML.slice(0, 400_000);
    if (w.__NEXT_DATA__ || document.getElementById("__next")) add("Next.js", "__NEXT_DATA__/#__next");
    if (w.__NUXT__ || document.getElementById("__nuxt") || /\/_nuxt\//.test(html)) add("Nuxt", "__NUXT__/#__nuxt/_nuxt assets");
    if (/\sdata-v-[0-9a-f]{6,}/.test(html) || w.__VUE__ || (document.querySelector("#app") as any)?.__vue_app__) add("Vue", "data-v-* scoped attrs / __vue_app__");
    if (document.querySelector("[data-reactroot]") || Array.from(document.body.children).some((c) => Object.keys(c).some((k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber")))) add("React", "react root keys");
    if (document.querySelector("[class*=svelte-]") || w.__svelte) add("Svelte", "svelte-* classes");
    if (document.querySelector("astro-island, [data-astro-cid]")) add("Astro", "astro-island");
    if (document.querySelector("[ng-version]")) add("Angular", "ng-version");
    if (/gatsby/i.test(html.slice(0, 60000))) add("Gatsby", "gatsby markers");
    if (/wp-content|wp-includes/.test(html)) add("WordPress", "wp-content");
    if (w.Shopify || /cdn\.shopify\.com/.test(html)) add("Shopify", "Shopify global / cdn");
    if (document.documentElement.hasAttribute("data-wf-page")) add("Webflow", "data-wf-page");
    if (/framerusercontent|data-framer-/.test(html.slice(0, 200000))) add("Framer (site)", "framer markers");
    if (/squarespace/i.test(html.slice(0, 60000))) add("Squarespace", "markers");
    if (w.jQuery) add("jQuery", "window.jQuery");

    const html5 = document.documentElement;
    const gsap = w.gsap, ST = w.ScrollTrigger ?? gsap?.plugins?.scrollTrigger;
    const animation = {
      gsap: gsap ? { version: gsap.version } : false,
      scrollTrigger: !!ST,
      scrollSmoother: !!w.ScrollSmoother || !!document.querySelector("#smooth-wrapper, .smooth-wrapper, [data-smooth-wrapper]"),
      lenis: !!(w.lenis || w.Lenis || html5.classList.contains("lenis") || document.querySelector("[data-lenis-prevent], .lenis")),
      locomotive: !!document.querySelector("[data-scroll-container]") || !!w.LocomotiveScroll,
      framerMotion: !!document.querySelector("[data-framer-appear-id], [data-projection-id], [data-framer-component-type]"),
      aos: document.querySelectorAll("[data-aos]").length,
      lottie: !!w.lottie || !!document.querySelector("lottie-player, dotlottie-player"),
      anime: !!w.anime,
      swiper: !!w.Swiper || !!document.querySelector(".swiper"),
      splitText: !!document.querySelector("[data-char], .split-char, .char, .split-line"),
    };

    const ctxs: { type: string; offscreen: boolean; w: number; h: number }[] = P.contexts ?? [];
    const canvases = Array.from(document.querySelectorAll("canvas")).map((c) => {
      const r = c.getBoundingClientRect();
      return { selector: path(c), rect: rectOf(c), coversViewport: r.width * r.height >= vw * vh * 0.5, position: getComputedStyle(c).position };
    });
    const videos = Array.from(document.querySelectorAll("video")).map((v) => ({ selector: path(v), src: v.currentSrc || v.src || Array.from(v.querySelectorAll("source")).map((s) => s.src).join(" | "), autoplay: v.autoplay, loop: v.loop, muted: v.muted, poster: v.poster || null, rect: rectOf(v) }));

    const fixedLayers: { selector: string; zIndex: string; rect: any; pointerEvents: string }[] = [];
    let sticky = 0;
    const innerScrollers: { selector: string; scrollHeight: number; clientHeight: number }[] = [];
    let n = 0;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (++n > 6000) break;
      const cs = getComputedStyle(el);
      if (cs.position === "sticky") sticky++;
      if (cs.position === "fixed" && cs.display !== "none" && fixedLayers.length < 25) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) fixedLayers.push({ selector: path(el), zIndex: cs.zIndex, rect: rectOf(el), pointerEvents: cs.pointerEvents });
      }
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 10 && el.clientHeight > 200 && innerScrollers.length < 5) {
        innerScrollers.push({ selector: path(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      }
    }
    const docH = document.documentElement.scrollHeight;
    // Virtual scroll: a fixed full-viewport wrapper holds the content (transform-driven) and the document barely scrolls.
    const virtualScroll = animation.scrollSmoother && (docH <= vh * 1.2 || fixedLayers.some((f) => f.rect.w >= vw * 0.9 && f.rect.h >= vh * 0.9));

    return {
      title: document.title,
      frameworks, animation,
      contexts: ctxs,
      three: { ...(P.three ?? { renderers: 0, scenes: 0 }), revision: w.THREE?.REVISION ?? null },
      globals: { babylon: !!w.BABYLON, pixi: !!w.PIXI, playcanvas: !!w.pc, p5: !!w.p5, phaser: !!w.Phaser, regl: !!w.createREGL, ogl: !!w.OGL },
      canvases, videos,
      audioElements: document.querySelectorAll("audio").length,
      audioContexts: P.audio ?? 0,
      inlineSvgs: document.querySelectorAll("svg").length,
      iframes: Array.from(document.querySelectorAll("iframe")).slice(0, 10).map((f) => ({ src: f.src, rect: rectOf(f) })),
      docH, vw, vh, fixedLayers, sticky, innerScrollers, virtualScroll,
      shadowRoots: P.shadowRoots ?? 0, customElements: P.customElements ?? [],
      runtime: { waapiCalls: P.waapi ?? 0, workers: P.workers ?? 0, wasm: P.wasm ?? 0, intersectionObservers: P.io ?? 0, resizeObservers: P.ro ?? 0, mediaQueries: P.mediaQueries ?? [], cssAnimations: document.getAnimations().length },
    };
  });

  const urls = [...new Set(responseUrls)];
  const hint = (re: RegExp) => urls.filter((u) => re.test(u)).slice(0, 6);
  const scriptHints = [
    ...hint(/gsap|scrolltrigger|scrollsmoother/i), ...hint(/lenis/i), ...hint(/three(\.|-|\/)|GLTFLoader|ktx2|draco|basis/i),
    ...hint(/framer-motion|motion\.dev/i), ...hint(/locomotive/i), ...hint(/lottie/i), ...hint(/babylon|pixi|ogl|regl|playcanvas/i),
  ];

  const webgl2 = raw.contexts.some((c) => c.type === "webgl2");
  const webgl1 = raw.contexts.some((c) => c.type === "webgl" || c.type === "experimental-webgl");
  const canvas2d = raw.contexts.some((c) => c.type === "2d" && c.w * c.h >= 10_000);
  const threeDetected = raw.three.renderers > 0 || raw.three.scenes > 0 || !!raw.three.revision;
  const gsapDetected = !!raw.animation.gsap || scriptHints.some((u) => /gsap|scrolltrigger/i.test(u));
  const lenisDetected = !!raw.animation.lenis || scriptHints.some((u) => /lenis/i.test(u));
  const otherEngines = Object.entries(raw.globals).filter(([, v]) => v).map(([k]) => k);
  const mainCanvas = raw.canvases.find((c) => c.coversViewport)?.selector ?? null;
  const usesWebgl = webgl1 || webgl2;
  const bigCanvas = raw.canvases.some((c) => c.rect.w * c.rect.h >= 40_000);

  const archetype: string[] = [];
  if (usesWebgl && bigCanvas) archetype.push(mainCanvas ? "webgl-experience" : "webgl-embedded");
  if (canvas2d) archetype.push("canvas2d");
  if (raw.videos.length) archetype.push("video-media");
  if (raw.animation.scrollSmoother || lenisDetected || raw.animation.locomotive) archetype.push("smooth-scroll");
  if (raw.virtualScroll) archetype.push("virtual-scroll");
  if (gsapDetected) archetype.push("gsap-timeline");
  if (raw.frameworks.some((f) => ["Shopify", "WordPress"].includes(f.name))) archetype.push("cms/ecommerce");
  if (gates?.actions.length || gates?.waitedForPreloader) archetype.push("gated-entry");
  if (!archetype.length) archetype.push("standard-document");

  // Dump-and-replay (DomLayer / ThreeReplay) is reserved for BESPOKE scroll-driven WebGL/canvas pipelines: a canvas that
  // covers the viewport, driven by a page that scrolls through several screens (or a virtual scroller). Everything else
  // (SaaS, e-commerce, blogs, dashboards, a 3D widget on a normal page) is hand-authored React + Tailwind.
  const fullScreenCanvas = (usesWebgl || canvas2d) && !!mainCanvas;
  const scrollDriven = raw.virtualScroll || raw.docH >= 3 * raw.vh || !!raw.animation.scrollSmoother || !!raw.animation.scrollTrigger;
  const replayReasons: string[] = [];
  if (fullScreenCanvas) replayReasons.push(`viewport-covering ${usesWebgl ? "WebGL" : "canvas 2D"} canvas (${mainCanvas})`);
  if (scrollDriven) replayReasons.push(raw.virtualScroll ? "virtual scroller" : `scroll-driven (${Math.round(raw.docH / Math.max(1, raw.vh))} viewports tall${raw.animation.scrollTrigger ? ", ScrollTrigger" : ""})`);
  const replay = fullScreenCanvas && scrollDriven;

  const notes: string[] = [];
  notes.push(replay
    ? "Bespoke scroll-driven canvas pipeline: dump-and-replay (ThreeReplay + DomLayer) is ALLOWED for the canvas-driven sections; standard sections around it are still hand-authored."
    : "Standard site: write clean, hand-authored React + Tailwind components from design-blueprint.json. DomLayer/ThreeReplay dumps are NOT allowed (the scaffold omits them).");
  if (usesWebgl && !threeDetected) notes.push("WebGL detected without Three.js hooks: custom/other engine. Reproduce with R3F <shaderMaterial> using the captured GLSL and uniforms.");
  if (!usesWebgl) notes.push("No WebGL context: do NOT add three / @react-three/*.");
  if (raw.animation.scrollSmoother && !lenisDetected) notes.push("ScrollSmoother-style wrapper detected: GSAP ScrollSmoother is a licensed plugin; replicate with Lenis or a transform-based virtual scroller and verify against the captured scroll curve.");
  if (raw.shadowRoots) notes.push(`${raw.shadowRoots} shadow root(s): their internals are not reachable by computed-style walk; capture screenshots and rebuild by measurement.`);
  if (raw.iframes.length) notes.push("Cross-origin iframes cannot be cloned; leave placeholders and record them.");

  return {
    url: page.url(),
    title: raw.title,
    archetype,
    frameworks: raw.frameworks,
    animation: { ...raw.animation, gsap: raw.animation.gsap || (gsapDetected ? { version: "unknown", evidence: "possible: script URLs mention gsap/ScrollTrigger (not exposed on window)" } : false), lenis: lenisDetected },
    rendering: {
      webgl2, webgl1, canvas2d, offscreenCanvas: raw.contexts.some((c) => c.offscreen),
      three: { detected: threeDetected, renderers: raw.three.renderers, scenes: raw.three.scenes, revision: raw.three.revision },
      otherEngines, canvases: raw.canvases, mainCanvas,
    },
    media: { videos: raw.videos, audioElements: raw.audioElements, audioContexts: raw.audioContexts, inlineSvgs: raw.inlineSvgs, iframes: raw.iframes },
    layout: {
      documentHeight: raw.docH, viewport: { width: raw.vw, height: raw.vh }, fixedLayers: raw.fixedLayers, stickyCount: raw.sticky,
      innerScrollers: raw.innerScrollers, virtualScroll: raw.virtualScroll, shadowRoots: raw.shadowRoots, customElements: raw.customElements,
    },
    runtime: raw.runtime,
    scriptHints,
    gates,
    recommendedScaffold: {
      three: usesWebgl && bigCanvas,
      canvas2d,
      gsap: gsapDetected || raw.animation.scrollTrigger,
      framerMotion: !!raw.animation.framerMotion || raw.runtime.waapiCalls > 0,
      lenis: lenisDetected || !!raw.animation.scrollSmoother,
      replay,
      replayReasons,
      notes,
    },
  };
}
