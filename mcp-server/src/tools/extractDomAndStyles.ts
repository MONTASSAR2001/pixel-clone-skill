import path from "node:path";
import fs from "node:fs/promises";
import { launchBrowser, newContext, gotoAndSettle, primeLazyContent, outRoot, slugify, ensureDir, log, type ReadyOptions } from "../lib/browser.js";
import { collectProfile } from "../lib/profile.js";
import { buildBlueprint, type RawNode } from "../lib/blueprint.js";
import { collectAssets } from "../lib/assets.js";
import { extractAtRules, parseFontFace, extractRootVariables, extractMediaQueries } from "../lib/css.js";
import { fitRules, type Measure, type ViewportSize } from "../lib/responsive.js";

export interface ExtractInput extends ReadyOptions {
  url: string;
  /**
   * Extract the page AS SEEN at this scroll position (scroll-driven sites reveal sections, split text and fixed
   * overlays only at their scroll range). Output goes to extract/<slug>@<y>/. Default: top of page.
   */
  scrollY?: number;
  /** Real-time wait after scrolling to scrollY before walking the DOM (default 3000). */
  scrollWaitMs?: number;
  maxNodes?: number;
  responseNodes?: number;
  downloadAssets?: boolean;
  settleMs?: number;
  /**
   * Viewports to measure (default 1440x900 then 1920x1080). The first is the primary capture (styles, tokens, assets);
   * every element is re-measured at the others and a responsive rule is fitted per element (left/right/center
   * anchored, full-bleed stretch, proportional vw scale, fluid type), written to responsive-rules.json and the blueprint.
   */
  viewports?: ViewportSize[];
  /**
   * Optional mobile pass (true = 390x844, or a size): loads the page in a mobile-emulated context (touch, isMobile,
   * mobile UA) and reports what changes against the primary desktop layout: elements hidden on mobile, elements only
   * shown on mobile (navigation toggles), containers that stack (flex row -> column, grid columns collapsing), type
   * scale changes and the mobile page height. Written to responsive-rules.json `mobile` and the blueprint.
   */
  mobile?: boolean | ViewportSize;
}

const DEFAULT_VIEWPORTS: ViewportSize[] = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];

/** Computed properties captured per element. Defaults and inherited-equal values are dropped. */
const STYLE_PROPS = [
  "display", "position", "top", "right", "bottom", "left", "zIndex", "float", "boxSizing",
  "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignSelf", "alignContent", "justifySelf", "justifyItems",
  "flexGrow", "flexShrink", "flexBasis", "order", "gap", "rowGap", "columnGap",
  "gridTemplateColumns", "gridTemplateRows", "gridColumnStart", "gridColumnEnd", "gridRowStart", "gridRowEnd", "gridAutoFlow", "gridAutoColumns", "gridAutoRows",
  "minWidth", "maxWidth", "minHeight", "maxHeight",
  "marginTop", "marginRight", "marginBottom", "marginLeft",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "overflowX", "overflowY",
  "color", "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "backgroundClip", "backgroundBlendMode",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
  "outlineWidth", "outlineStyle", "outlineColor", "outlineOffset",
  "boxShadow", "textShadow", "opacity", "transform", "transformOrigin", "perspective", "filter", "backdropFilter", "mixBlendMode", "clipPath", "maskImage",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "lineHeight", "letterSpacing", "wordSpacing",
  "textAlign", "textTransform", "textDecorationLine", "textDecorationColor", "textDecorationStyle", "textUnderlineOffset",
  "textIndent", "textOverflow", "whiteSpace", "wordBreak", "overflowWrap", "fontFeatureSettings", "fontVariationSettings", "webkitTextFillColor", "webkitTextStrokeWidth", "webkitTextStrokeColor",
  "objectFit", "objectPosition", "aspectRatio", "cursor", "pointerEvents", "visibility", "willChange", "mixBlendMode",
  "transitionProperty", "transitionDuration", "transitionTimingFunction", "transitionDelay",
  "animationName", "animationDuration", "animationTimingFunction", "animationDelay", "animationIterationCount", "animationDirection", "animationFillMode", "animationTimeline",
  "scrollSnapType", "scrollSnapAlign", "scrollBehavior", "listStyleType", "verticalAlign", "content", "isolation", "contain", "inset", "mixBlendMode",
] as const;

export async function extractDomAndStyles(input: ExtractInput) {
  const { url, maxNodes = 3000, responseNodes = 250, downloadAssets = true, settleMs = 1200, scrollY, scrollWaitMs = 3000, viewports = DEFAULT_VIEWPORTS, mobile: mobileOpt = false, ...ready } = input;
  const primaryVp = viewports[0] ?? DEFAULT_VIEWPORTS[0]!;
  const slug = slugify(url) + (scrollY ? `@${scrollY}` : "");
  const dir = await ensureDir(path.join(outRoot(), "extract", slug));
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser, primaryVp);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    // --- CDP: capture every stylesheet's full text (including cross-origin) ---
    const sheets: { url: string; text: string }[] = [];
    const sheetJobs: Promise<void>[] = [];
    await cdp.send("DOM.enable");
    cdp.on("CSS.styleSheetAdded", (e: { header: { styleSheetId: string; sourceURL: string } }) => {
      sheetJobs.push(
        cdp
          .send("CSS.getStyleSheetText", { styleSheetId: e.header.styleSheetId })
          .then((r: { text: string }) => {
            if (r.text.length < 3_000_000) sheets.push({ url: e.header.sourceURL, text: r.text });
          })
          .catch(() => undefined),
      );
    });
    await cdp.send("CSS.enable");

    const assets = collectAssets(page, path.join(dir, "assets"), downloadAssets ? {} : { only: [] });
    const responseUrls: string[] = [];
    page.on("response", (r) => responseUrls.push(r.url()));
    const gates = await gotoAndSettle(page, url, settleMs, ready);
    await primeLazyContent(page);
    await page.waitForTimeout(300);
    let actualScrollY = 0;
    if (scrollY) {
      // Scroll-locked intros may snap back: retry until the document follows (or give up after ~20 s).
      for (let k = 0; k < 10; k++) {
        await page.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" as ScrollBehavior }), scrollY);
        await page.waitForTimeout(k === 0 ? scrollWaitMs : 2000);
        actualScrollY = await page.evaluate(() => Math.round(window.scrollY));
        if (Math.abs(actualScrollY - scrollY) < 2) break;
      }
    }
    await page.screenshot({ path: path.join(dir, "reference-top.png"), animations: "disabled" });

    // --- In-page walk: BFS over visible DOM, computed styles, rects ---
    const walk = await page.evaluate(
      ({ props, maxNodes }) => {
        const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "HEAD", "TEMPLATE", "TITLE", "BASE"]);
        const INHERITED = new Set([
          "color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "lineHeight", "letterSpacing", "wordSpacing",
          "textAlign", "textTransform", "textIndent", "whiteSpace", "wordBreak", "overflowWrap", "cursor", "visibility", "listStyleType",
          "fontFeatureSettings", "fontVariationSettings", "webkitTextFillColor", "webkitTextStrokeWidth", "webkitTextStrokeColor", "textShadow",
        ]);
        const DEFAULTS = new Set([
          "none", "normal", "auto", "0px", "static", "visible", "rgba(0, 0, 0, 0)", "start", "baseline", "0", "1", "nowrap", "row",
          "stretch", "flex-start", "content-box", "all", "0s", "ease", "initial", "scroll", "repeat", "border-box 0px", "currentcolor",
          "0px 0px", "50% 50%", "0% 0%", "padding-box", "separate", "disc", "medium", "1 1 auto", "normal normal", "running", "0s ease 0s",
        ]);

        const round = (n: number) => Math.round(n * 100) / 100;
        const pick = (cs: CSSStyleDeclaration, parentCs: CSSStyleDeclaration | null, keepAll: boolean) => {
          const out: Record<string, string> = {};
          for (const p of props) {
            const v = (cs as unknown as Record<string, string>)[p];
            if (v === undefined || v === "") continue;
            if (!keepAll) {
              if (DEFAULTS.has(v)) continue;
              if (INHERITED.has(p) && parentCs && (parentCs as unknown as Record<string, string>)[p] === v) continue;
            }
            if (p === "content" && v === "normal") continue;
            out[p] = v;
          }
          return out;
        };
        const sel = (el: Element) => {
          let s = el.tagName.toLowerCase();
          if (el.id) s += "#" + el.id;
          const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
          if (cls.length) s += "." + cls.join(".");
          return s;
        };

        const nodes: RawNode[] = [];
        const queue: { el: Element; parent: number | null; key: string }[] = [{ el: document.documentElement, parent: null, key: "h" }];
        const sx = window.scrollX;
        const sy = window.scrollY;
        let id = 0;
        while (queue.length && nodes.length < maxNodes) {
          const { el, parent, key } = queue.shift()!;
          if (SKIP.has(el.tagName)) continue;
          const cs = getComputedStyle(el);
          if (cs.display === "none") continue;
          const parentCs = el.parentElement ? getComputedStyle(el.parentElement) : null;
          const r = el.getBoundingClientRect();
          const myId = id++;
          const attrs: Record<string, string> = {};
          for (const a of Array.from(el.attributes)) {
            if (/^(id|class|href|src|srcset|alt|role|type|name|placeholder|value|target|rel|viewBox|d|fill|stroke|width|height|aria-.*|data-.*)$/i.test(a.name)) {
              attrs[a.name] = a.value.length > 300 ? a.value.slice(0, 300) + "…" : a.value;
            }
          }
          let text = "";
          for (const c of Array.from(el.childNodes)) if (c.nodeType === 3) text += c.textContent ?? "";
          text = text.replace(/\s+/g, " ").trim();
          const node: RawNode = {
            id: myId,
            parent,
            tag: el.tagName.toLowerCase(),
            selector: sel(el),
            attrs,
            rect: { x: round(r.left + sx), y: round(r.top + sy), w: round(r.width), h: round(r.height) },
            styles: pick(cs, parentCs, el === document.documentElement),
            key,
          };
          {
            const reasons: string[] = [];
            const pos = cs.position, z = cs.zIndex, pd = parentCs?.display ?? "";
            if (el === document.documentElement) reasons.push("root");
            if (pos === "fixed" || pos === "sticky") reasons.push(pos);
            if ((pos === "relative" || pos === "absolute") && z !== "auto") reasons.push("z-index");
            if (/flex|grid/.test(pd) && z !== "auto") reasons.push("flex/grid-item z-index");
            if (parseFloat(cs.opacity) < 1) reasons.push("opacity");
            if (cs.transform !== "none") reasons.push("transform");
            if (cs.filter !== "none") reasons.push("filter");
            if (cs.backdropFilter !== "none") reasons.push("backdrop-filter");
            if (cs.clipPath !== "none") reasons.push("clip-path");
            if (cs.maskImage !== "none") reasons.push("mask");
            if (cs.mixBlendMode !== "normal") reasons.push("mix-blend-mode");
            if (cs.isolation === "isolate") reasons.push("isolation");
            if (cs.perspective !== "none") reasons.push("perspective");
            if (/transform|opacity|filter|perspective/.test(cs.willChange)) reasons.push("will-change");
            if (/layout|paint|strict|content/.test(cs.contain)) reasons.push("contain");
            if (reasons.length && el !== document.documentElement) node.stack = { zIndex: z, reasons };
          }
          if (text) {
            node.text = text.length > 400 ? text.slice(0, 400) + "…" : text;
            node.typo = {
              fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
              lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, textTransform: cs.textTransform, color: cs.color,
            };
          }
          if (el.tagName.toLowerCase() === "svg") {
            const html = (el as SVGElement).outerHTML;
            node.svg = html.length > 6000 ? html.slice(0, 6000) + "…" : html;
          }
          if (el instanceof HTMLImageElement) {
            node.img = { currentSrc: el.currentSrc, naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight };
          }
          for (const pe of ["::before", "::after"] as const) {
            const pcs = getComputedStyle(el, pe);
            if (pcs.content && pcs.content !== "none" && pcs.content !== "normal") {
              node.pseudo ??= {};
              node.pseudo[pe] = { ...pick(pcs, cs, true), content: pcs.content };
            }
          }
          nodes.push(node);
          // Do not descend into SVG internals (captured as markup above).
          if (!(el instanceof SVGElement)) Array.from(el.children).forEach((c, i) => queue.push({ el: c, parent: myId, key: key + "/" + i }));
        }
        return {
          nodes,
          page: {
            title: document.title,
            lang: document.documentElement.lang,
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
            viewport: { width: innerWidth, height: innerHeight },
            themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
            totalElements: document.getElementsByTagName("*").length,
          },
          usedFontsApi: (() => {
            const list: { family: string; weight: string; style: string; status: string }[] = [];
            document.fonts?.forEach((f) => list.push({ family: f.family, weight: f.weight, style: f.style, status: f.status }));
            return list;
          })(),
          canvases: Array.from(document.querySelectorAll("canvas")).map((c) => {
            const r = c.getBoundingClientRect();
            return { rect: { x: round(r.left + sx), y: round(r.top + sy), w: round(r.width), h: round(r.height) }, width: c.width, height: c.height };
          }),
          videos: Array.from(document.querySelectorAll("video")).map((v) => ({ src: v.currentSrc || v.src, poster: v.poster, loop: v.loop, muted: v.muted, autoplay: v.autoplay })),
        };
      },
      { props: [...new Set(STYLE_PROPS)] as string[], maxNodes },
    );

    // --- CDP: which platform fonts actually render ---
    const platformFonts: Record<string, unknown> = {};
    try {
      const doc = (await cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
      for (const s of ["body", "h1", "h2", "h3", "p", "a", "button", "nav"]) {
        const q = (await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: s })) as { nodeId: number };
        if (!q.nodeId) continue;
        const f = (await cdp.send("CSS.getPlatformFontsForNode", { nodeId: q.nodeId })) as {
          fonts: { familyName: string; postScriptName: string; isCustomFont: boolean; glyphCount: number }[];
        };
        platformFonts[s] = f.fonts;
      }
    } catch (e) {
      log("platform font lookup failed:", (e as Error).message);
    }

    await Promise.allSettled(sheetJobs);
    const savedAssets = await assets.done();
    const profile = await collectProfile(page, responseUrls, gates);

    // --- Multi-viewport responsive rules: re-measure every element at the other viewports and fit its anchoring ---
    const measureAll = () =>
      page.evaluate(() => {
        const out: Record<string, { x: number; y: number; w: number; h: number; fontSize: number; pinned: boolean }> = {};
        const pinnedOf = (el: Element) => { for (let a: Element | null = el; a; a = a.parentElement) if (getComputedStyle(a).position === "fixed") return true; return false; };
        const visit = (el: Element, key: string) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (cs.display === "none") return;
          const pinned = pinnedOf(el);
          // pinned: viewport coordinates; flow: page coordinates
          out[key] = { x: r.left + window.scrollX, y: pinned ? r.top : r.top + window.scrollY, w: r.width, h: r.height, fontSize: parseFloat(cs.fontSize), pinned };
          if (!(el instanceof SVGElement)) Array.from(el.children).forEach((c, i) => visit(c, key + "/" + i));
        };
        visit(document.documentElement, "h");
        return { vp: { width: innerWidth, height: innerHeight }, nodes: out };
      });
    const responsiveFiles: Record<string, string> = {};
    let responsive: Record<string, unknown> | null = null;
    let responsiveRulesPending = false;
    let responsiveRulesData: Record<string, unknown> | null = null;
    if (viewports.length > 1) {
      const base = await measureAll();
      const toMap = (o: Awaited<ReturnType<typeof measureAll>>["nodes"]) => new Map<string, Measure>(Object.entries(o));
      const a = toMap(base.nodes);
      const perVp: { viewport: ViewportSize; matched: number }[] = [];
      let rules: ReturnType<typeof fitRules> | null = null;
      for (const vp of viewports.slice(1)) {
        await page.setViewportSize(vp);
        await page.waitForTimeout(Math.max(1500, settleMs));
        if (actualScrollY) await page.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" as ScrollBehavior }), actualScrollY);
        await page.waitForTimeout(500);
        const shot = path.join(dir, `reference-top-${vp.width}x${vp.height}.png`);
        await page.screenshot({ path: shot, animations: "disabled" }).catch(() => undefined);
        responsiveFiles[`${vp.width}x${vp.height}`] = shot;
        const b = await measureAll();
        const bm = toMap(b.nodes);
        perVp.push({ viewport: vp, matched: [...a.keys()].filter((k) => bm.has(k)).length });
        // Rules are fitted against the first secondary viewport (the widest spread is the most precise fit).
        if (!rules) rules = fitRules(a, base.vp, bm, b.vp);
      }
      await page.setViewportSize(primaryVp);
      const byKey = new Map(walk.nodes.map((n) => [n.key, n] as const));
      for (const [k, r] of rules ?? []) { const n = byKey.get(k); if (n) n.responsive = r; }
      // Summary for the scaffold: which elements must NOT be hard-coded in px.
      const sel = (n: RawNode) => n.selector;
      const vis = walk.nodes.filter((n) => n.responsive && n.rect.w > 0 && n.rect.h > 0 && n.tag !== "html" && n.tag !== "body");
      const pinnedNodes = vis.filter((n) => n.styles.position === "fixed" || n.styles.position === "sticky");
      responsive = {
        viewports: [primaryVp, ...perVp.map((p) => p.viewport)],
        matchedPerViewport: perVp,
        fullBleed: vis.filter((n) => n.responsive!.h === "stretch" && n.rect.w >= primaryVp.width - 2).slice(0, 80).map(sel),
        rightAnchored: vis.filter((n) => n.responsive!.h === "right").slice(0, 80).map((n) => ({ selector: sel(n), right: Math.round((primaryVp.width - n.rect.x - n.rect.w) * 100) / 100 })),
        centered: vis.filter((n) => n.responsive!.h === "center" || n.responsive!.h === "center-fluid").slice(0, 80).map(sel),
        proportional: vis.filter((n) => n.responsive!.h === "scale").slice(0, 80).map(sel),
        bottomAnchored: pinnedNodes.filter((n) => n.responsive!.v === "bottom").map((n) => ({ selector: sel(n), bottom: Math.round((primaryVp.height - (n.rect.y - actualScrollY) - n.rect.h) * 100) / 100 })),
        fluidType: vis.filter((n) => n.text && Math.abs(n.responsive!.kf) > 1e-3).slice(0, 80).map((n) => ({ selector: sel(n), fontSize: n.styles.fontSize ?? n.typo?.fontSize, pxPerViewportPx: n.responsive!.kf })),
        // getComputedStyle resolves `left` of a right-anchored fixed box to px (e.g. left: 1299px): never copy it.
        hardcodeTraps: pinnedNodes.filter((n) => n.responsive!.h === "right" && n.styles.left && n.styles.left !== "auto").map((n) => ({ selector: sel(n), computed: { left: n.styles.left, right: n.styles.right }, use: `right: ${n.styles.right ?? "<px>"} (the computed left is resolved, not authored)` })),
      };
      responsiveRulesPending = true;
      responsiveRulesData = { rules: Object.fromEntries([...(rules ?? [])].filter(([k]) => byKey.has(k)).map(([k, r]) => [k, { selector: byKey.get(k)!.selector, ...r }])) };
    }

    // --- Optional mobile pass: what the layout does on a phone ---
    if (mobileOpt) {
      const mvp = { width: 390, height: 844, ...(typeof mobileOpt === "object" ? mobileOpt : {}), mobile: true };
      const layout = (p: typeof page) =>
        p.evaluate(() => {
          type L = { visible: boolean; x: number; y: number; w: number; h: number; dir: string; cols: number; fontSize: number; text: boolean; sel: string; toggle: boolean; kids: number };
          const out: Record<string, L> = {};
          const sel = (el: Element) => { let s = el.tagName.toLowerCase(); if (el.id) s += "#" + el.id; const c = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []; if (c.length) s += "." + c.join("."); return s; };
          const visit = (el: Element, key: string) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const visible = cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
            const label = `${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("aria-label") ?? ""} ${el.id}`;
            out[key] = {
              visible, x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height,
              dir: cs.display.includes("flex") ? cs.flexDirection : cs.display.includes("grid") ? "grid" : "",
              cols: cs.display.includes("grid") ? cs.gridTemplateColumns.split(" ").filter((x) => x && x !== "none").length : 0,
              fontSize: parseFloat(cs.fontSize), text: Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0),
              sel: sel(el), kids: el.children.length,
              toggle: (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.hasAttribute("aria-expanded") || el.tagName === "A") && /burger|hamburger|menu|nav-?toggle|toggle|drawer/i.test(label),
            };
            if (cs.display === "none" || el instanceof SVGElement) return;
            Array.from(el.children).forEach((c, i) => { if (!["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE"].includes(c.tagName)) visit(c, key + "/" + i); });
          };
          visit(document.documentElement, "h");
          return { nodes: out, scrollHeight: document.documentElement.scrollHeight };
        });
      const mctx = await newContext(browser, mvp);
      try {
        const mpage = await mctx.newPage();
        await gotoAndSettle(mpage, url, settleMs, ready);
        if (actualScrollY) { await mpage.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" as ScrollBehavior }), actualScrollY); await mpage.waitForTimeout(scrollWaitMs); }
        const shot = path.join(dir, `reference-top-${mvp.width}x${mvp.height}.png`);
        await mpage.screenshot({ path: shot, animations: "disabled" }).catch(() => undefined);
        responsiveFiles[`${mvp.width}x${mvp.height}`] = shot;
        const [d, m] = [await layout(page), await layout(mpage)];
        const parentOf = (k: string) => k.slice(0, k.lastIndexOf("/"));
        const topLevel = (keys: string[]) => { const set = new Set(keys); return keys.filter((k) => !set.has(parentOf(k))); };
        const dn = d.nodes, mn = m.nodes;
        const hidden = topLevel(Object.keys(dn).filter((k) => dn[k]!.visible && !mn[k]?.visible));
        const only = topLevel(Object.keys(mn).filter((k) => mn[k]!.visible && !dn[k]?.visible));
        const stacked = Object.keys(dn).filter((k) => dn[k]!.visible && mn[k]?.visible && dn[k]!.kids >= 2 && (
          (dn[k]!.dir.startsWith("row") && mn[k]!.dir.startsWith("column")) || (dn[k]!.cols > 1 && mn[k]!.cols < dn[k]!.cols)));
        const typeScale = Object.keys(dn).filter((k) => dn[k]!.text && dn[k]!.visible && mn[k]?.visible && Math.abs(dn[k]!.fontSize - mn[k]!.fontSize) >= 1);
        const cap = <T,>(a: T[], n = 60) => a.slice(0, n);
        responsive = {
          ...(responsive ?? {}),
          mobile: {
            viewport: mvp, screenshot: shot, scrollHeight: { desktop: d.scrollHeight, mobile: m.scrollHeight },
            hiddenOnMobile: cap(hidden.map((k) => dn[k]!.sel)),
            visibleOnlyOnMobile: cap(only.map((k) => mn[k]!.sel)),
            menuToggles: cap(Object.keys(mn).filter((k) => mn[k]!.visible && mn[k]!.toggle && !dn[k]?.visible).map((k) => mn[k]!.sel)),
            stacked: cap(stacked.map((k) => ({ selector: dn[k]!.sel, desktop: dn[k]!.cols > 1 ? `${dn[k]!.cols} grid columns` : dn[k]!.dir, mobile: mn[k]!.cols ? `${mn[k]!.cols} grid columns` : mn[k]!.dir }))),
            typeScale: cap(typeScale.map((k) => ({ selector: dn[k]!.sel, desktop: dn[k]!.fontSize, mobile: mn[k]!.fontSize })), 40),
          },
        };
        responsiveRulesPending = true;
      } finally {
        await mctx.close();
      }
    }
    if (responsiveRulesPending) await fs.writeFile(path.join(dir, "responsive-rules.json"), JSON.stringify({ ...responsive, ...(responsiveRulesData ?? {}) }, null, 1));

    // --- Parse stylesheet text ---
    const keyframes: Record<string, string> = {};
    const fontFaces: ReturnType<typeof parseFontFace>[] = [];
    const cssVariables: Record<string, string> = {};
    const mq = new Set<string>();
    for (const s of sheets) {
      for (const k of extractAtRules(s.text, "@keyframes")) {
        const name = /@keyframes\s+([^\s{]+)/.exec(k)?.[1];
        if (name) keyframes[name] = k.replace(/\s+/g, " ").slice(0, 4000);
      }
      for (const f of extractAtRules(s.text, "@font-face")) fontFaces.push(parseFontFace(f, s.url || url));
      Object.assign(cssVariables, extractRootVariables(s.text));
      extractMediaQueries(s.text).forEach((q) => mq.add(q));
    }
    const localByUrl = new Map(savedAssets.map((a) => [a.url, a.localPath]));
    const fonts = fontFaces.map((f) => ({
      ...f,
      sources: f.sources.map((s) => ({ ...s, localPath: localByUrl.get(s.url) ?? null })),
    }));

    // Group faces by family/weight/style: Google-Fonts CJK families ship hundreds of unicode-range subsets.
    const famMap = new Map<string, { family: string; weight: string | null; style: string | null; display: string | null; faceCount: number; files: { url: string; format: string | null; localPath: string | null }[] }>();
    for (const f of fonts) {
      const key = `${f.family}|${f.weight}|${f.style}`;
      const g = famMap.get(key) ?? { family: f.family, weight: f.weight, style: f.style, display: f.display, faceCount: 0, files: [] };
      g.faceCount++;
      for (const src of f.sources) if ((src.localPath || g.faceCount <= 1) && !g.files.some((x) => x.url === src.url)) g.files.push(src);
      famMap.set(key, g);
    }
    const fontFamilies = [...famMap.values()].map((g) => ({ ...g, files: g.files.slice(0, 6), downloaded: g.files.filter((x) => x.localPath).length }));

    // --- Design tokens aggregated from nodes ---
    const tally = (m: Map<string, number>, v: string | undefined) => {
      if (v && v !== "rgba(0, 0, 0, 0)" && v !== "none" && v !== "0px" && v !== "normal") m.set(v, (m.get(v) ?? 0) + 1);
    };
    const top = (m: Map<string, number>, n = 20) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
    const colors = new Map<string, number>(), bgs = new Map<string, number>(), radii = new Map<string, number>(),
      shadows = new Map<string, number>(), spacing = new Map<string, number>(), borders = new Map<string, number>();
    const type = new Map<string, { count: number; tag: string; sample: string }>();
    for (const n of walk.nodes) {
      const s = n.styles;
      if (n.text && n.typo) {
        const t = n.typo;
        tally(colors, t.color);
        const key = [t.fontFamily, t.fontSize, t.fontWeight, t.lineHeight, t.letterSpacing, t.textTransform].join(" | ");
        const e = type.get(key) ?? { count: 0, tag: n.tag, sample: n.text.slice(0, 40) };
        e.count++;
        type.set(key, e);
      }
      tally(bgs, s.backgroundColor);
      tally(radii, s.borderTopLeftRadius);
      tally(shadows, s.boxShadow);
      tally(borders, s.borderTopColor && s.borderTopWidth && s.borderTopWidth !== "0px" ? s.borderTopColor : undefined);
      for (const k of ["paddingTop", "paddingLeft", "marginTop", "marginBottom", "gap", "rowGap", "columnGap"]) tally(spacing, s[k]);
    }
    const tokens = {
      textColors: top(colors),
      backgroundColors: top(bgs),
      borderColors: top(borders),
      borderRadii: top(radii),
      boxShadows: top(shadows),
      spacingScale: top(spacing, 30),
      typography: [...type.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([k, v]) => {
          const [fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textTransform] = k.split(" | ");
          return { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textTransform, count: v.count, exampleTag: v.tag, exampleText: v.sample };
        }),
    };

    const capturedAt = new Date().toISOString();
    const full = {
      url,
      capturedAt,
      readiness: gates,
      scrollY: actualScrollY,
      profile,
      viewport: { width: primaryVp.width, height: primaryVp.height, deviceScaleFactor: 1 },
      responsive,
      page: walk.page,
      tokens,
      cssVariables,
      fonts,
      fontFamilies,
      platformFonts,
      documentFonts: walk.usedFontsApi,
      keyframes,
      mediaQueries: [...mq].slice(0, 60),
      canvases: walk.canvases,
      videos: walk.videos,
      assets: savedAssets,
      nodes: walk.nodes,
    };
    const jsonPath = path.join(dir, "extraction.json");
    await fs.writeFile(jsonPath, JSON.stringify(full, null, 2));
    const blueprint = buildBlueprint({
      url, capturedAt, viewport: full.viewport, nodes: walk.nodes as RawNode[], tokens, cssVariables, fonts: fontFamilies, keyframes,
      mediaQueries: full.mediaQueries, responsive: responsive ?? undefined, assets: savedAssets, canvases: walk.canvases, videos: walk.videos, profile: { archetype: profile.archetype, frameworks: profile.frameworks, rendering: profile.rendering, animation: profile.animation, layout: profile.layout, recommendedScaffold: profile.recommendedScaffold, gates }, page: walk.page,
    });
    const blueprintPath = path.join(dir, "design-blueprint.json");
    await fs.writeFile(blueprintPath, JSON.stringify(blueprint, null, 2));

    return {
      outputDir: dir,
      extractionJson: jsonPath,
      designBlueprint: blueprintPath,
      referenceScreenshot: path.join(dir, "reference-top.png"),
      referenceScreenshotsByViewport: responsiveFiles,
      responsiveRules: responsive ? path.join(dir, "responsive-rules.json") : null,
      ...full,
      fonts: undefined,
      assets: savedAssets.map((a) => ({ kind: a.kind, url: a.url, bytes: a.bytes, localPath: a.localPath })),
      blueprintSummary: { sections: blueprint.structure.sections, fixedLayers: blueprint.layers.fixedAndSticky.length, stackingContexts: blueprint.layers.stackingContexts.length, effects: blueprint.effects.length },
      nodes: walk.nodes.slice(0, responseNodes),
      nodesTotal: walk.nodes.length,
      note:
        walk.nodes.length > responseNodes
          ? `Response shows the first ${responseNodes} of ${walk.nodes.length} nodes (BFS order). Read extractionJson for the full tree.`
          : undefined,
    };
  } finally {
    await browser.close();
  }
}
