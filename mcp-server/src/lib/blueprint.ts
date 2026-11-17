/**
 * design-blueprint.json: a modular, framework-neutral description of a page that an agent can turn into
 * clean React/Tailwind components. Built from the flat extraction node list; pure and unit-testable.
 */
export interface RawNode {
  id: number;
  parent: number | null;
  tag: string;
  selector: string;
  attrs: Record<string, string>;
  text?: string;
  rect: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
  typo?: Record<string, string>;
  pseudo?: Record<string, Record<string, string>>;
  svg?: string;
  img?: { currentSrc: string; naturalWidth: number; naturalHeight: number };
  stack?: { zIndex: string; reasons: string[] };
  /** Structural path (child indices from <html>), stable across viewports. */
  key?: string;
  /** Responsive rule fitted from the multi-viewport capture (see lib/responsive.ts). */
  responsive?: { h: string; v: string; kx: number; kw: number; ky: number; kh: number; kf: number; fitted: boolean };
}

export interface Component {
  id: number;
  tag: string;
  role: string;
  suggestedName: string;
  selector: string;
  rect: RawNode["rect"];
  layout: Record<string, string>;
  paint: Record<string, string>;
  motion: Record<string, string>;
  typography?: Record<string, string>;
  text?: string;
  attrs?: Record<string, string>;
  svg?: string;
  img?: RawNode["img"];
  pseudo?: RawNode["pseudo"];
  stack?: RawNode["stack"];
  responsive?: RawNode["responsive"];
  collapsedWrappers?: string[];
  repeatGroups?: { signature: string; count: number; childIds: number[] }[];
  children: Component[];
}

const LAYOUT = [
  "display", "position", "top", "right", "bottom", "left", "zIndex", "float", "boxSizing",
  "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignSelf", "alignContent", "justifySelf", "justifyItems",
  "flexGrow", "flexShrink", "flexBasis", "order", "gap", "rowGap", "columnGap",
  "gridTemplateColumns", "gridTemplateRows", "gridColumnStart", "gridColumnEnd", "gridRowStart", "gridRowEnd", "gridAutoFlow", "gridAutoColumns", "gridAutoRows",
  "minWidth", "maxWidth", "minHeight", "maxHeight", "aspectRatio",
  "marginTop", "marginRight", "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "overflowX", "overflowY", "scrollSnapType", "scrollSnapAlign", "verticalAlign",
];
const MOTION = [
  "transitionProperty", "transitionDuration", "transitionTimingFunction", "transitionDelay",
  "animationName", "animationDuration", "animationTimingFunction", "animationDelay", "animationIterationCount", "animationDirection", "animationFillMode", "animationTimeline", "willChange", "scrollBehavior",
];
const TYPO = new Set(["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "lineHeight", "letterSpacing", "wordSpacing", "textAlign", "textTransform", "textIndent", "whiteSpace", "wordBreak", "overflowWrap", "fontFeatureSettings", "fontVariationSettings", "textDecorationLine", "textDecorationColor", "textDecorationStyle", "textUnderlineOffset", "textOverflow", "textShadow", "webkitTextFillColor", "webkitTextStrokeWidth", "webkitTextStrokeColor", "listStyleType"]);
const LAYOUT_SET = new Set(LAYOUT);
const MOTION_SET = new Set(MOTION);
const ZERO = new Set(["0px", "auto", "normal", "none", "visible", "static"]);

const ROLE: Record<string, string> = {
  header: "header", nav: "navigation", main: "main", footer: "footer", section: "section", article: "article", aside: "aside",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading", a: "link", button: "button",
  img: "image", svg: "icon/graphic", video: "video", canvas: "canvas", ul: "list", ol: "list", li: "list-item", form: "form", input: "input",
  textarea: "input", select: "input", p: "text", span: "text", picture: "image", table: "table", figure: "figure", label: "label",
};

function pascal(s: string): string {
  const out = s.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return /^[A-Za-z]/.test(out) ? out : out ? `C${out}` : "";
}

function friendlyName(n: RawNode, index: number): string {
  const id = n.attrs.id && !/^\d|^[a-f0-9-]{12,}$/i.test(n.attrs.id) ? n.attrs.id : "";
  const cls = (n.attrs.class ?? "").split(/\s+/).find((c) => c && !/^(flex|grid|full|relative|absolute|fixed|hidden|show|w-|h-|p[xytblr]?-|m[xytblr]?-|text-|bg-|data-v|v-|css-|sc-|_)/.test(c) && !/\d{3,}/.test(c)) ?? "";
  return pascal(id || cls || ROLE[n.tag] || n.tag) || `Block${index}`;
}

export function buildBlueprint(input: {
  url: string;
  capturedAt: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  nodes: RawNode[];
  tokens: unknown;
  cssVariables: Record<string, string>;
  fonts: unknown[];
  keyframes: Record<string, string>;
  mediaQueries: string[];
  assets: { kind: string; url: string; localPath: string; bytes: number }[];
  canvases: unknown[];
  videos: unknown[];
  profile: unknown;
  page: unknown;
  /** Multi-viewport summary from extract_dom_and_styles (viewports, anchored/full-bleed elements, warnings). */
  responsive?: unknown;
}) {
  const nodes = input.nodes;
  const kids = new Map<number, RawNode[]>();
  for (const n of nodes) if (n.parent !== null) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
  const pick = (s: Record<string, string>, keys: string[]) => Object.fromEntries(keys.filter((k) => s[k] !== undefined).map((k) => [k, s[k]!]));

  const toComponent = (n: RawNode, index: number): Component => {
    const s = n.styles;
    const paint: Record<string, string> = {};
    for (const [k, v] of Object.entries(s)) if (!LAYOUT_SET.has(k) && !MOTION_SET.has(k) && !TYPO.has(k)) paint[k] = v;
    const children = (kids.get(n.id) ?? []).map((c, i) => toComponent(c, i));
    const c: Component = {
      id: n.id, tag: n.tag, role: ROLE[n.tag] ?? "container", suggestedName: friendlyName(n, index), selector: n.selector, rect: n.rect,
      layout: pick(s, LAYOUT), paint, motion: pick(s, MOTION), children,
    };
    if (n.typo) c.typography = n.typo;
    if (n.text) c.text = n.text;
    const attrs = Object.fromEntries(Object.entries(n.attrs).filter(([k]) => !/^(class|style)$/.test(k) && !/^data-v-/.test(k)));
    if (Object.keys(attrs).length) c.attrs = attrs;
    if (n.svg) c.svg = n.svg;
    if (n.img) c.img = n.img;
    if (n.pseudo) c.pseudo = n.pseudo;
    if (n.stack) c.stack = n.stack;
    if (n.responsive) c.responsive = n.responsive;

    // repeated sibling patterns -> candidates for .map()
    const sig = new Map<string, number[]>();
    for (const ch of children) {
      const key = `${ch.tag}.${(n.attrs.class ? "" : "")}${ch.suggestedName}|${ch.children.length}`;
      (sig.get(key) ?? sig.set(key, []).get(key)!).push(ch.id);
    }
    const groups = [...sig.entries()].filter(([, ids]) => ids.length >= 3).map(([signature, childIds]) => ({ signature, count: childIds.length, childIds }));
    if (groups.length) c.repeatGroups = groups;
    return c;
  };

  // Collapse pass-through wrappers that carry no layout or paint of their own.
  const collapse = (c: Component): Component => {
    c.children = c.children.map(collapse);
    if (c.children.length !== 1 || c.text || c.svg || c.img || c.pseudo || c.stack) return c;
    const child = c.children[0]!;
    const inert = (o: Record<string, string>) => Object.entries(o).every(([k, v]) => ZERO.has(v) || k === "display" || k === "boxSizing" || k === "position" && v === "static");
    const sameBox = Math.abs(c.rect.w - child.rect.w) <= 1 && Math.abs(c.rect.h - child.rect.h) <= 1 && Math.abs(c.rect.x - child.rect.x) <= 1 && Math.abs(c.rect.y - child.rect.y) <= 1;
    const plainDisplay = !c.layout.display || c.layout.display === "block";
    if (inert(c.layout) && Object.keys(c.paint).length === 0 && Object.keys(c.motion).length === 0 && sameBox && plainDisplay && c.tag === "div") {
      child.collapsedWrappers = [...(child.collapsedWrappers ?? []), c.selector];
      return child;
    }
    return c;
  };

  const root = nodes.find((n) => n.parent === null && n.tag === "html");
  const body = nodes.find((n) => n.tag === "body");
  const tree = body ? collapse(toComponent(body, 0)) : null;

  const flat = (c: Component | null, out: Component[] = []) => { if (c) { out.push(c); c.children.forEach((x) => flat(x, out)); } return out; };
  const all = flat(tree);
  const fixed = all.filter((c) => c.layout.position === "fixed" || c.layout.position === "sticky");
  const stacking = all.filter((c) => c.stack).map((c) => ({ id: c.id, selector: c.selector, name: c.suggestedName, zIndex: c.stack!.zIndex, reasons: c.stack!.reasons })).sort((a, b) => (parseInt(b.zIndex, 10) || 0) - (parseInt(a.zIndex, 10) || 0));

  const mainEl = all.find((c) => c.tag === "main") ?? tree;
  const sections = (mainEl?.children ?? []).filter((c) => c.rect.h >= 40).map((c) => ({ id: c.id, name: c.suggestedName, role: c.role, y: c.rect.y, h: c.rect.h, position: c.layout.position ?? "static" })).sort((a, b) => a.y - b.y);

  const byUrl = new Map(input.assets.map((a) => [a.url, a]));
  const imgs = all.filter((c) => c.img?.currentSrc).map((c) => ({ nodeId: c.id, src: c.img!.currentSrc, natural: [c.img!.naturalWidth, c.img!.naturalHeight], local: byUrl.get(c.img!.currentSrc)?.localPath ?? null, alt: c.attrs?.alt ?? null, rect: c.rect }));
  const bgImages = all.filter((c) => c.paint.backgroundImage && /url\(/.test(c.paint.backgroundImage)).map((c) => ({ nodeId: c.id, backgroundImage: c.paint.backgroundImage, rect: c.rect }));
  const effects = all.filter((c) => c.paint.clipPath || c.paint.mixBlendMode || c.paint.backdropFilter || c.paint.filter || c.paint.maskImage).map((c) => ({ nodeId: c.id, name: c.suggestedName, clipPath: c.paint.clipPath, mixBlendMode: c.paint.mixBlendMode, backdropFilter: c.paint.backdropFilter, filter: c.paint.filter, maskImage: c.paint.maskImage }));

  return {
    schema: "pixel-clone/design-blueprint@2",
    source: { url: input.url, capturedAt: input.capturedAt, viewport: input.viewport },
    page: input.page,
    profile: input.profile,
    tokens: input.tokens,
    cssVariables: input.cssVariables,
    fonts: input.fonts,
    breakpoints: input.mediaQueries,
    responsive: input.responsive ?? null,
    structure: { sections, nodeCount: nodes.length, rootTag: root?.tag ?? null },
    layers: {
      fixedAndSticky: fixed.map((c) => ({ id: c.id, name: c.suggestedName, selector: c.selector, position: c.layout.position, zIndex: c.layout.zIndex ?? "auto", rect: c.rect, pointerEvents: c.paint.pointerEvents ?? "auto", anchor: c.responsive ? { h: c.responsive.h, v: c.responsive.v, fitted: c.responsive.fitted } : undefined })),
      stackingContexts: stacking.slice(0, 120),
    },
    effects,
    media: {
      images: imgs,
      backgroundImages: bgImages,
      inlineSvgs: all.filter((c) => c.svg).map((c) => ({ nodeId: c.id, name: c.suggestedName, rect: c.rect, markupChars: c.svg!.length })),
      videos: input.videos,
      canvases: input.canvases,
      models: input.assets.filter((a) => a.kind === "model" || a.kind === "texture" || a.kind === "hdr").map((a) => ({ url: a.url, kind: a.kind, local: a.localPath, bytes: a.bytes })),
    },
    keyframes: input.keyframes,
    components: tree,
  };
}
