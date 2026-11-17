import path from "node:path";
import fs from "node:fs/promises";
import { launchBrowser, newContext, gotoAndSettle, primeLazyContent, outRoot, slugify, ensureDir, VIEWPORT, type ReadyOptions } from "../lib/browser.js";
import { decodePng, writePng, PNG } from "../lib/png.js";
import { WEBGL_HOOK_INIT } from "./inspectWebglScene.js";

export interface ScanInput extends ReadyOptions {
  url: string;
  maxSlices?: number;
  sliceStep?: number;
  /** Real-time wait after each scroll so scroll-driven animation settles (default 2000). */
  sliceWaitMs?: number;
  settleMs?: number;
  /** Record which WebGL passes/textures are drawn in each slice (default true). */
  traceGl?: boolean;
}

interface SliceInfo {
  index: number;
  y: number;
  scrollY: number;
  texts: { tag: string; text: string; selector: string; rect: number[]; fontSize: string; color: string }[];
  containers: string[];
  media: { tag: string; src: string; rect: number[] }[];
  fixedVisible: string[];
  gl: { draws: number; passes: number; programs: number[]; textures: string[] } | null;
  thumbnail: string;
}

function thumb(buf: Buffer, s = 0.25): PNG {
  const src = decodePng(buf);
  const w = Math.round(src.width * s), h = Math.round(src.height * s);
  const dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (Math.min(src.height - 1, Math.floor(y / s)) * src.width + Math.min(src.width - 1, Math.floor(x / s))) * 4, di = (y * w + x) * 4;
    dst.data[di] = src.data[si]!; dst.data[di + 1] = src.data[si + 1]!; dst.data[di + 2] = src.data[si + 2]!; dst.data[di + 3] = 255;
  }
  return dst;
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/**
 * Full-height section & scene inventory. Scrolls the whole page in viewport steps and records, per slice, what is
 * actually visible (text, containers, media, fixed layers, WebGL passes and the textures they sample), then groups
 * consecutive slices into section candidates. Works for scroll-driven sites where every section lives in a fixed
 * layer (DOM rects alone cannot tell you where a section appears in the scroll).
 */
export async function scanPageSections(input: ScanInput) {
  const { url, maxSlices = 20, sliceStep, sliceWaitMs = 2000, settleMs = 2000, traceGl = true, ...ready } = input;
  const dir = await ensureDir(path.join(outRoot(), "inventory", slugify(url)));
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser, VIEWPORT);
    if (traceGl) await context.addInitScript(WEBGL_HOOK_INIT);
    const page = await context.newPage();
    const gates = await gotoAndSettle(page, url, settleMs, ready);
    await primeLazyContent(page);
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    const maxScroll = Math.max(0, H - VIEWPORT.height);
    const step = sliceStep ?? VIEWPORT.height;
    let ys: number[] = [];
    for (let y = 0; y < maxScroll; y += step) ys.push(y);
    if (ys[ys.length - 1] !== maxScroll) ys.push(maxScroll);
    const sampled = ys.length > maxSlices;
    if (sampled) ys = Array.from({ length: maxSlices }, (_, i) => Math.round((maxScroll * i) / (maxSlices - 1)));

    const slices: SliceInfo[] = [];
    for (let i = 0; i < ys.length; i++) {
      const y = ys[i]!;
      await page.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" as ScrollBehavior }), y);
      await page.waitForTimeout(sliceWaitMs);
      // Scroll locks (intros) can snap back to 0: retry once after another wait.
      if (y > 0 && (await page.evaluate(() => window.scrollY)) < 1) {
        await page.waitForTimeout(sliceWaitMs);
        await page.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" as ScrollBehavior }), y);
        await page.waitForTimeout(sliceWaitMs);
      }
      const dom = await page.evaluate(() => {
        const path = (window as unknown as { __pcPath: (e: Element) => string }).__pcPath;
        const vh = innerHeight, vw = innerWidth;
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
          for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) return false;
          }
          return true;
        };
        const texts: { tag: string; text: string; selector: string; rect: number[]; fontSize: string; color: string }[] = [];
        const containers = new Set<string>();
        for (const el of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,a,button,span,div,label,figcaption"))) {
          if (texts.length >= 40) break;
          let own = "";
          for (const c of Array.from(el.childNodes)) if (c.nodeType === 3) own += c.textContent ?? "";
          own = own.replace(/\s+/g, " ").trim();
          if (own.length < 2 || !visible(el)) continue;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          texts.push({ tag: el.tagName.toLowerCase(), text: own.slice(0, 80), selector: path(el), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], fontSize: cs.fontSize, color: cs.color });
          const sec = el.closest("section, header, footer, nav, article, aside, [class*=section], [class*=Section]");
          if (sec) containers.add(path(sec));
        }
        const media = Array.from(document.querySelectorAll("img, video, picture source")).filter(visible).slice(0, 20).map((m) => {
          const r = m.getBoundingClientRect();
          return { tag: m.tagName.toLowerCase(), src: ((m as HTMLImageElement).currentSrc || (m as HTMLImageElement).src || (m as HTMLSourceElement).srcset || "").split("/").pop() ?? "", rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
        });
        const fixedVisible = Array.from(document.querySelectorAll("body *")).filter((e) => getComputedStyle(e).position === "fixed" && visible(e)).slice(0, 15).map((e) => path(e));
        return { scrollY: Math.round(window.scrollY), texts, containers: [...containers], media, fixedVisible };
      });
      let gl: SliceInfo["gl"] = null;
      if (traceGl && (await page.evaluate(() => !!(window as unknown as { __pcTraceArm?: unknown }).__pcTraceArm && document.querySelector("canvas") !== null))) {
        await page.evaluate("window.__pcTraceArm()");
        type Trace = { done: boolean; ops: { op: string; fb?: string | null; program?: number; textures?: Record<string, string> }[]; textures: Record<string, { sourceUrl?: string; fn?: string; size?: number[] }> };
        let tr = null as Trace | null;
        for (let k = 0; k < 20; k++) {
          await page.waitForTimeout(500);
          tr = (await page.evaluate("window.__pcTrace()")) as Trace;
          if (tr?.done) break;
        }
        if (tr) {
          const draws = tr.ops.filter((o) => o.op === "draw");
          const texs = new Set<string>();
          for (const d of draws) for (const id of Object.values(d.textures ?? {})) {
            const t = tr.textures[id];
            if (t?.sourceUrl) texs.add(t.sourceUrl.split("/").slice(-2).join("/"));
            else if (t?.fn === "compressedTexImage2D" || (t?.fn === "texStorage2D" && !t.sourceUrl && t.size && t.size[0]! >= 256)) texs.add(`gpu-texture ${t.size?.join("x")} (${t.fn === "compressedTexImage2D" ? "compressed/KTX2" : "storage"})`);
          }
          gl = { draws: draws.length, passes: new Set(draws.map((d) => String(d.fb))).size, programs: [...new Set(draws.map((d) => d.program ?? -1))], textures: [...texs].slice(0, 30) };
        }
      }
      const shot = await page.screenshot({ animations: "disabled", timeout: 180_000 });
      const tfile = path.join(dir, `slice-${String(i).padStart(2, "0")}.png`);
      await writePng(tfile, thumb(shot));
      slices.push({ index: i, y, ...dom, gl, thumbnail: tfile });
    }

    // Group consecutive slices into section candidates by what is visible (containers, texture set, lead texts).
    const sig = (s: SliceInfo) => new Set([...s.containers, ...(s.gl?.textures ?? []).map((t) => "tex:" + t), ...s.texts.slice(0, 6).map((t) => "txt:" + t.text.slice(0, 30))]);
    const sections: { id: number; fromY: number; toY: number; slices: number[]; headings: string[]; containers: string[]; textures: string[]; media: string[] }[] = [];
    for (const s of slices) {
      const last = sections[sections.length - 1];
      const prev = last ? slices[last.slices[last.slices.length - 1]!]! : null;
      if (last && prev && jaccard(sig(prev), sig(s)) >= 0.4) {
        last.slices.push(s.index); last.toY = s.y + VIEWPORT.height;
      } else {
        sections.push({ id: sections.length + 1, fromY: s.y, toY: s.y + VIEWPORT.height, slices: [s.index], headings: [], containers: [], textures: [], media: [] });
      }
      const cur = sections[sections.length - 1]!;
      cur.headings = [...new Set([...cur.headings, ...s.texts.filter((t) => /^h\d$/.test(t.tag) || parseFloat(t.fontSize) >= 24).map((t) => t.text.slice(0, 50))])].slice(0, 8);
      cur.containers = [...new Set([...cur.containers, ...s.containers])].slice(0, 10);
      cur.textures = [...new Set([...cur.textures, ...(s.gl?.textures ?? [])])].slice(0, 20);
      cur.media = [...new Set([...cur.media, ...s.media.map((m) => m.src)])].slice(0, 12);
    }
    const md = [
      `# Section & scene inventory: ${url}`,
      ``,
      `Document height ${H}px, ${slices.length} slices of ${step}px${sampled ? " (sampled evenly over the full height)" : ""}. Every row below must become a component and pass the slice diff.`,
      ``,
      `| # | y range | slices | headings / lead text | containers | WebGL textures | media |`,
      `|---|---|---|---|---|---|---|`,
      ...sections.map((s) => `| ${s.id} | ${s.fromY}-${s.toY} | ${s.slices.join(",")} | ${s.headings.join(" · ").replace(/\|/g, "/") || "-"} | ${s.containers.slice(0, 3).join("<br>") || "-"} | ${s.textures.slice(0, 6).join(", ") || "-"} | ${s.media.slice(0, 4).join(", ") || "-"} |`),
      ``,
      `Fixed layers seen: ${[...new Set(slices.flatMap((s) => s.fixedVisible))].join(", ") || "none"}`,
    ].join("\n");
    const jsonFile = path.join(dir, "page-inventory.json");
    const mdFile = path.join(dir, "inventory.md");
    await fs.writeFile(jsonFile, JSON.stringify({ url, documentHeight: H, step, sampled, gates, slices, sections }, null, 2));
    await fs.writeFile(mdFile, md);
    return {
      inventoryJson: jsonFile,
      inventoryMarkdown: mdFile,
      documentHeight: H,
      slices: slices.length,
      sampled,
      sections: sections.map((s) => ({ id: s.id, fromY: s.fromY, toY: s.toY, slices: s.slices, headings: s.headings, textures: s.textures.slice(0, 8), media: s.media.slice(0, 6) })),
      note: "Each section is a mandatory component. Copy inventory.md into CLONE_NOTES.md and tick sections off only when their slices pass compare_visual_diff.",
    };
  } finally {
    await browser.close();
  }
}
