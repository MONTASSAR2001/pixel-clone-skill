/**
 * Server-side half of the progressive replay loader (no "use client": runs at build/render time on the server).
 *
 * <ReplayPreload/> inlines a tiny script that runs while the HTML is still parsing, long before React hydrates: it
 * picks the viewport variant for the window and starts every request the hero needs (manifests, static registry, hero
 * keyframe, its geometry chunk, DOM hero, anchors) plus preloads of the hero's texture files. The runtime consumes
 * those in-flight requests instead of starting its own.
 *
 * It also shows the hero POSTER (public/replay/<variant>/hero-poster.webp, baked from the clone's own replay render by
 * scripts/bake-hero-poster.mjs) full-bleed at first paint; ThreeReplay cross-fades to the live canvas once the hero's
 * textures are in and removes it. Without a baked poster nothing is shown and the canvas appears at its first draw.
 *
 * loadReplayHero() reads the primary variant's hero DOM keyframe so <ReplayHeroProvider> can server-render it: the
 * hero UI is in the first HTML response, placed for any window size by CSS.
 */
import fs from "node:fs";
import path from "node:path";
import type { ReplayHero } from "./DomLayer";

const PUBLIC = path.join(process.cwd(), "public");
const ROOT = "/replay/";
const read = <T,>(rel: string): T | null => {
  try { return JSON.parse(fs.readFileSync(path.join(PUBLIC, rel), "utf8")) as T; } catch { return null; }
};
type V = { width: number; height: number; base: string; scrollHeight?: number | null };
const exists = (rel: string) => { try { return fs.statSync(path.join(PUBLIC, rel)).isFile(); } catch { return false; } };
const variants = (): V[] => read<V[]>(ROOT + "viewports.json") ?? [{ width: 1440, height: 900, base: "" }];

/** URLs the hero needs, per variant base. */
function heroUrls(v: V) {
  const b = ROOT + v.base;
  const json: string[] = [];
  const bin: string[] = [];
  const preload: { href: string; as: "fetch" | "image" }[] = [];
  const m = read<{ keyframes: { y: number; file: string; chunks: number[]; textures: string[] }[]; chunks: { file: string }[] }>(b + "manifest.json");
  if (m) {
    json.push(b + "manifest.json", b + "static.json", b + "texture-map.json");
    const hero = m.keyframes.slice().sort((x, y) => x.y - y.y)[0];
    const tm = read<Record<string, { kind: string; url?: string; glb?: string }>>(b + "texture-map.json") ?? {};
    if (hero) {
      json.push(b + hero.file);
      for (const c of hero.chunks) bin.push(b + m.chunks[c]!.file);
      const seen = new Set<string>();
      for (const u of hero.textures) {
        const e = tm[u];
        const href = e?.glb ?? e?.url;
        if (!href || href.startsWith("data:") || seen.has(href)) continue;
        seen.add(href);
        preload.push({ href, as: e!.kind === "url" ? "image" : "fetch" });
      }
      if (hero.textures.some((u) => tm[u]?.kind === "ktx2" || tm[u]?.kind === "glb")) preload.push({ href: ROOT + "basis_transcoder.js", as: "fetch" }, { href: ROOT + "basis_transcoder.wasm", as: "fetch" });
    }
  }
  const dm = read<{ keyframes: number[] }>(b + "dom/manifest.json");
  if (dm) {
    json.push(b + "dom/manifest.json", b + "dom/keyframes.json", b + "dom/responsive.json");
    const y = dm.keyframes.slice().sort((p, q) => p - q)[0];
    if (y !== undefined) json.push(`${b}dom/dom-y-${y}.json`);
  }
  return { json, bin, preload };
}

export function ReplayPreload() {
  const vs = variants();
  const urls = Object.fromEntries(vs.map((v) => [v.base, heroUrls(v)]));
  const posters = Object.fromEntries(vs.filter((v) => exists(ROOT + v.base + "hero-poster.webp")).map((v) => [v.base, ROOT + v.base + "hero-poster.webp"]));
  // Same variant scoring as replayMath.pickVariant.
  const js = `(function(){try{var V=${JSON.stringify(vs)},U=${JSON.stringify(urls)};window.__replayVariants=V;
var W=innerWidth,H=innerHeight,best=null,sc=1/0;for(var i=0;i<V.length;i++){var v=V[i],s=2*Math.abs(Math.log((W/H)/(v.width/v.height)))+Math.abs(Math.log(W/v.width));if(s<sc){sc=s;best=v;}}
if(!best||scrollY>H)return;var po=${JSON.stringify(posters)}[best.base],im=document.querySelector("img[data-replay-poster]");if(im){if(po)im.src=po;else im.remove();}
var u=U[best.base];if(!u)return;var P=window.__replayPrefetch={};
u.json.concat(u.bin).forEach(function(x){P[x]=fetch(x);});
u.preload.forEach(function(p){var l=document.createElement("link");l.rel="preload";l.as=p.as;l.href=p.href;l.crossOrigin="anonymous";document.head.appendChild(l);});
}catch(e){}})();`;
  return (
    <>
      {Object.keys(posters).length > 0 && (
        // eslint-disable-next-line @next/next/no-img-element
        <img data-replay-poster="" alt="" aria-hidden fetchPriority="high" decoding="async" style={{ position: "fixed", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none", transition: "opacity 200ms linear" }} />
      )}
      <script dangerouslySetInnerHTML={{ __html: js }} />
    </>
  );
}

/** The primary variant's hero keyframe for server rendering (null when no replay data is staged). */
export function loadReplayHero(): ReplayHero | null {
  const v = variants()[0];
  if (!v) return null;
  const b = ROOT + v.base;
  const manifest = read<ReplayHero["manifest"]>(b + "dom/manifest.json");
  if (!manifest?.keyframes?.length) return null;
  const y = manifest.keyframes.slice().sort((p, q) => p - q)[0]!;
  const frame = read<ReplayHero["frame"]>(`${b}dom/dom-y-${y}.json`);
  if (!frame) return null;
  for (const bx of frame.boxes) bx.key ??= `y-${y}#${bx.order}`;
  const anchors = read<{ rules: ReplayHero["anchors"] }>(b + "dom/responsive.json")?.rules ?? {};
  return { base: v.base, manifest, anchors, frame };
}
