#!/usr/bin/env node
/**
 * Stage dump-and-replay data into a clone (generic). Accepts the folders written by three-scene-dump.mjs /
 * dom-layer-dump.mjs, or ONE folder written by compare_visual_diff's dumpReplayTo (pass it as both --scene and --dom).
 * A folder holding <W>x<H>/ sub-folders (multi-viewport dumps) is staged as one replay VARIANT per viewport.
 *
 *   node scripts/stage-replay.mjs --app <cloneDir> --extract <extraction.json> [--cache <_http-cache dir>]
 *        [--scene <dump dir>] [--dom <dump dir>] [--texture-hints <hints.json>]
 *
 * --texture-hints (site knowledge for textures the dump cannot name exactly, always reported as "inferred"):
 *   { "sheets": { "<SheetName>": "<url path prefix>" },      // texture "sheet<SheetName>Map<k>"  -> *<prefix><k>.ktx2
 *     "families": { "<object name>": "<url file prefix>" },   // unnamed textures used by that object, in order of first
 *                                                              // appearance -> *<prefix>0.ktx2, <prefix>1.ktx2, ...
 *     "unnamedObjectFamily": "<url file prefix>" }            // same, for textures used by unnamed objects
 *
 * Output (<app>/public/replay):
 *   viewports.json                     [{ width, height, base }]  the runtime picks the variant closest to the window
 *   <base>manifest.json                scene keyframes in PRIORITY order (hero y-0 first) with their dependencies:
 *                                      geometry chunks + texture uuids, so the hero renders before anything else loads
 *   <base>static.json, geo-<n>.bin     programs/materials/geometry registry; geometry split by first-use keyframe
 *   <base>y-<y>.json, state-<n>.json   per-keyframe pass lists, scenes, cameras, uniforms
 *   <base>texture-map.json             texture uuid -> local file (exact: url | gltf-name | unique KTX2 size; inferred: name pattern)
 *   <base>dom/manifest.json            DOM keyframes + states; <base>dom/dom-*.json boxes with local asset URLs
 *   <base>dom/responsive.json          per-box anchoring [kx,kw,ky,kh,kf] fitted ACROSS variants (left/right/center/stretch/vw)
 *   assets/, dom/assets/, basis transcoder (shared by all variants); <app>/src/app/fonts.css
 * state-top-return is only staged when the dump marked it as genuinely distinct from the initial hero.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fitRule } from "../mcp-server/dist/lib/responsive.js";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const app = opt("app"), extractFile = opt("extract"), cache = opt("cache"), sceneDir = opt("scene"), domDir = opt("dom");
const hints = opt("texture-hints") ? JSON.parse(fs.readFileSync(opt("texture-hints"), "utf8")) : {};
if (!app || !extractFile || (!sceneDir && !domDir)) { console.error("usage: stage-replay.mjs --app <dir> --extract <extraction.json> [--cache dir] [--scene dir] [--dom dir]"); process.exit(2); }
const ex = JSON.parse(fs.readFileSync(extractFile, "utf8"));
const byUrl = new Map(ex.assets.map((a) => [a.url, a.localPath]));
const sha = (u) => createHash("sha1").update(u).digest("hex");
const local = (u) => byUrl.get(u) ?? (cache && fs.existsSync(path.join(cache, sha(u) + ".bin")) ? path.join(cache, sha(u) + ".bin") : null);
const fetchRetry = async (u, n = 3) => { for (let i = 0; ; i++) { try { const r = await fetch(u); if (r.ok || i >= n - 1) return r; } catch (e) { if (i >= n - 1) throw e; } await new Promise((r) => setTimeout(r, 500 * (i + 1))); } };
const fetchTo = async (u, dir) => { const r = await fetchRetry(u); if (!r.ok) return null; const f = path.join(dir, sha(u).slice(0, 8) + "-" + path.basename(new URL(u).pathname)); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); return f; };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const ROOT = path.join(app, "public/replay");
fs.mkdirSync(ROOT, { recursive: true });
const report = { variants: [] };

/** Viewport variants of a dump folder: <W>x<H>/ sub-folders, or the folder itself. */
function variantsOf(dir) {
  if (!dir) return [];
  const subs = fs.readdirSync(dir).filter((f) => /^\d+x\d+$/.test(f) && fs.statSync(path.join(dir, f)).isDirectory());
  const meta = (d) => readJson(path.join(d, "replay-index.json"), {})?.meta ?? {};
  if (subs.length) return subs.map((s) => { const [width, height] = s.split("x").map(Number); return { width, height, dir: path.join(dir, s), meta: meta(path.join(dir, s)) }; }).sort((a, b) => a.width - b.width);
  const m = meta(dir);
  const sample = fs.readdirSync(dir).find((f) => /^(dom-)?y-\d+\.json$/.test(f));
  const vp = m.viewport ?? readJson(path.join(dir, sample ?? "_"), {})?.viewport ?? [1440, 900];
  return [{ width: vp[0], height: vp[1], dir, meta: m }];
}
const sceneVariants = variantsOf(sceneDir), domVariants = variantsOf(domDir);
const keyOf = (v) => `${v.width}x${v.height}`;
const allKeys = [...new Set([...sceneVariants, ...domVariants].map(keyOf))];
const multi = allKeys.length > 1;
const baseOf = (k) => (multi ? `${k}/` : "");
const topReturnOk = (v) => v.meta?.topReturn ? v.meta.topReturn.distinct !== false : true;

// ---------------- scene ----------------
const A = path.join(ROOT, "assets");
fs.mkdirSync(A, { recursive: true });
const copy = (src, name) => { const dst = path.join(A, name); if (!fs.existsSync(dst)) fs.copyFileSync(src, dst); return "/replay/assets/" + name; };
const ktxDims = (f) => { const b = fs.readFileSync(f); return b.slice(1, 7).toString() === "KTX 20" ? [b.readUInt32LE(20), b.readUInt32LE(24), b.readUInt32LE(40)] : null; };
const nameToGlb = {};
for (const g of ex.assets.filter((a) => a.kind === "model" && /\.glb$/i.test(a.url))) {
  const b = fs.readFileSync(g.localPath); const j = JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString());
  (j.textures || []).forEach((t) => { const img = (j.images || [])[t.extensions?.KHR_texture_basisu?.source ?? t.source] || {}; const nm = t.name || img.name; if (nm) nameToGlb[nm] = path.basename(g.url); });
  if (sceneVariants.length) copy(g.localPath, path.basename(g.url));
}
const ktx = sceneVariants.length ? ex.assets.filter((x) => /\.ktx2$/i.test(x.url)).map((a) => ({ file: a.localPath, url: a.url, dims: ktxDims(a.localPath) })) : [];
if (cache && sceneVariants.length) for (const f of fs.readdirSync(cache).filter((f) => f.endsWith(".bin"))) { const p = path.join(cache, f); const d = ktxDims(p); if (d && !ktx.some((k) => fs.statSync(k.file).size === fs.statSync(p).size)) ktx.push({ file: p, url: null, dims: d }); }

const texUuids = (v, out = new Set()) => {
  if (!v || typeof v !== "object") return out;
  if (Array.isArray(v)) { for (const x of v) texUuids(x, out); return out; }
  if (typeof v.$tex === "string") out.add(v.$tex);
  for (const [k, x] of Object.entries(v)) { if ((k === "map" || k === "alphaMap") && typeof x === "string") out.add(x); else if (x && typeof x === "object") texUuids(x, out); }
  return out;
};

for (const v of sceneVariants) {
  const key = keyOf(v), OUT = path.join(ROOT, baseOf(key));
  fs.mkdirSync(OUT, { recursive: true });
  const S = JSON.parse(fs.readFileSync(path.join(v.dir, "static.json"), "utf8"));
  const bin = fs.readFileSync(path.join(v.dir, "geometry.bin"));
  const map = {}; const stats = { exact: 0, inferred: 0, unresolved: [] };
  // Which object first uses each texture, in keyframe order (drives family inference and reporting).
  const usage = {};
  for (const f of fs.readdirSync(v.dir).filter((f) => /^y-\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5)))) {
    const d = JSON.parse(fs.readFileSync(path.join(v.dir, f), "utf8")); const y = Number(f.slice(2, -5));
    for (const sc of Object.values(d.scenes ?? {})) for (const o of sc.objects ?? []) for (const m of [o.material].flat()) for (const u of texUuids(m)) usage[u] ??= { object: o.name ?? "", y };
  }
  const famCount = {};
  const byUrlEnd = (suffix) => ktx.find((k) => k.url?.endsWith(suffix));
  for (const t of Object.values(S.textures).sort((a, b) => (usage[a.uuid]?.y ?? 1e9) - (usage[b.uuid]?.y ?? 1e9))) {
    let e = null;
    if (t.kind === "rt") e = { kind: "rt" };
    else if (t.src && local(t.src)) e = { kind: t.kind === "video" ? "video" : "url", url: copy(local(t.src), path.basename(new URL(t.src).pathname)), how: "exact:url" };
    else if (t.kind === "canvas" && t.dataUrl) e = { kind: "dataUrl", url: t.dataUrl, how: "exact:canvas" };
    else if (t.name && nameToGlb[t.name]) e = { kind: "glb", glb: "/replay/assets/" + nameToGlb[t.name], name: t.name, how: "exact:gltf-name" };
    else if (t.kind === "compressed") {
      const same = ktx.filter((k) => k.dims && k.dims[0] === t.w && k.dims[1] === t.h && k.dims[2] === t.mipmaps);
      const m = /^sheet([A-Za-z]+?)Map(\d+)$/.exec(t.name || "");
      if (m) {
        const prefix = hints.sheets?.[m[1]];
        const c = prefix ? byUrlEnd(prefix + m[2] + ".ktx2") : same.find((k) => k.url && new RegExp(`${m[1].replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}-${m[2]}\\.ktx2$`).test(k.url));
        if (c) e = { kind: "ktx2", url: copy(c.file, path.basename(c.url)), how: "inferred:name-pattern" };
      }
      if (!e && same.length === 1) e = { kind: "ktx2", url: copy(same[0].file, same[0].url ? path.basename(same[0].url) : `cache-${t.w}x${t.h}.ktx2`), how: "exact:unique-size" };
      if (!e) {
        const obj = usage[t.uuid]?.object;
        const fam = (obj && hints.families?.[obj]) || (!obj && hints.unnamedObjectFamily) || null;
        if (fam) { const i = (famCount[fam] = (famCount[fam] ?? -1) + 1); const c = byUrlEnd(fam + i + ".ktx2") ?? byUrlEnd(fam + "0.ktx2"); if (c) e = { kind: "ktx2", url: copy(c.file, path.basename(c.url)), how: "inferred:object-family+appearance-order" }; }
      }
    }
    if (e) { map[t.uuid] = e; if (e.how?.startsWith("exact")) stats.exact++; else if (e.how) stats.inferred++; }
    else if (t.kind !== "rt") stats.unresolved.push(`${t.kind} ${t.name || "(unnamed)"} ${t.w}x${t.h} used by ${usage[t.uuid]?.object || "?"}@${usage[t.uuid]?.y ?? "?"}`);
  }
  const ys = fs.readdirSync(v.dir).filter((f) => /^y-\d+\.json$/.test(f)).map((f) => Number(f.slice(2, -5))).sort((a, b) => a - b);
  const stateNames = fs.readdirSync(v.dir).filter((f) => /^state-[\w-]+\.json$/.test(f)).map((f) => f.slice(6, -5)).filter((n) => n !== "top-return" || topReturnOk(v));
  // Priority: the hero (y-0, or the lowest y) first, then by scroll order, then interactive states.
  const entries = [...ys.map((y) => ({ y, file: `y-${y}.json` })), ...stateNames.map((n) => ({ name: n, file: `state-${n}.json` }))];
  // Geometry chunks: each keyframe's chunk holds the geometries it is the first to use.
  const assigned = new Map(); const chunks = [];
  const geoBytes = (g) => [...Object.values(g.attributes), ...(g.index ? [g.index] : [])];
  for (const e of entries) {
    const d = JSON.parse(fs.readFileSync(path.join(v.dir, e.file), "utf8"));
    const used = new Set(); for (const sc of Object.values(d.scenes ?? {})) for (const o of sc.objects ?? []) if (o.geometry) used.add(o.geometry);
    const fresh = [...used].filter((g) => !assigned.has(g) && S.geometries[g]);
    if (fresh.length) {
      const idx = chunks.length; const parts = []; let off = 0;
      for (const gid of fresh) {
        for (const a of geoBytes(S.geometries[gid])) {
          parts.push(bin.subarray(a.offset, a.offset + a.bytes)); a.offset = off; off += a.bytes;
          const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
        }
        S.geometries[gid].chunk = idx; assigned.set(gid, idx);
      }
      fs.writeFileSync(path.join(OUT, `geo-${idx}.bin`), Buffer.concat(parts));
      chunks.push({ file: `geo-${idx}.bin`, bytes: off });
    }
    e.chunks = [...new Set([...used].map((g) => assigned.get(g)).filter((x) => x !== undefined))];
    e.textures = [...texUuids(d.scenes)].filter((u) => map[u] && map[u].kind !== "rt");
    e.viewport = d.viewport ?? [v.width, v.height];
    fs.writeFileSync(path.join(OUT, e.file), JSON.stringify(d));
  }
  fs.writeFileSync(path.join(OUT, "static.json"), JSON.stringify(S));
  fs.writeFileSync(path.join(OUT, "texture-map.json"), JSON.stringify(map));
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ version: 2, viewport: [v.width, v.height], keyframes: entries.filter((e) => e.y !== undefined), states: entries.filter((e) => e.name), chunks, topReturn: v.meta?.topReturn ?? null }));
  // legacy listings (tools, older runtimes)
  fs.writeFileSync(path.join(OUT, "keyframes.json"), JSON.stringify(ys));
  fs.writeFileSync(path.join(OUT, "states.json"), JSON.stringify(stateNames));
  report.variants.push({ viewport: key, scene: { keyframes: ys.length, states: stateNames, chunks: chunks.length, heroBytes: (chunks[0]?.bytes ?? 0), textures: { exact: stats.exact, inferred: stats.inferred, unresolved: stats.unresolved } } });
}
if (sceneVariants.length) {
  const basis = path.join(app, "node_modules/three/examples/jsm/libs/basis/");
  for (const f of ["basis_transcoder.js", "basis_transcoder.wasm"]) if (fs.existsSync(basis + f)) fs.copyFileSync(basis + f, path.join(ROOT, f));
}

// ---------------- DOM ----------------
if (domVariants.length) {
  const DA = path.join(ROOT, "dom/assets"), FONTS = path.join(app, "public/fonts");
  fs.mkdirSync(DA, { recursive: true }); fs.mkdirSync(FONTS, { recursive: true });
  const seen = new Map(); const missing = [];
  const resolve = async (u) => {
    if (!u || u.startsWith("data:") || u.startsWith("/replay/")) return u;
    if (seen.has(u)) return seen.get(u);
    let f = local(u); let pub = null;
    let why = "";
    if (f) { const name = sha(u).slice(0, 8) + "-" + path.basename(new URL(u).pathname); fs.copyFileSync(f, path.join(DA, name)); pub = "/replay/dom/assets/" + name; }
    else { try { const g = await fetchTo(u, DA); if (g) pub = "/replay/dom/assets/" + path.basename(g); else why = "HTTP error"; } catch (e) { why = String(e?.cause?.code ?? e?.message ?? e); } }
    if (!pub) missing.push(why ? `${u} (${why})` : u);
    seen.set(u, pub ?? u); return pub ?? u;
  };
  const used = new Set();
  const loaded = new Map(); // variant key -> { ys, frames: Map(name -> data) }
  for (const v of domVariants) {
    const key = keyOf(v), OUT = path.join(ROOT, baseOf(key), "dom");
    fs.mkdirSync(OUT, { recursive: true });
    const frames = new Map(); const ys = []; const states = [];
    for (const f of fs.readdirSync(v.dir).filter((f) => /^dom-(y-\d+|state-[\w-]+)\.json$/.test(f))) {
      const name = f.slice(4, -5);
      if (name === "state-top-return" && !topReturnOk(v)) continue;
      const d = JSON.parse(fs.readFileSync(path.join(v.dir, f), "utf8"));
      for (const b of d.boxes) {
        if (b.src) b.src = await resolve(b.src);
        if (b.poster) b.poster = await resolve(b.poster);
        if (b.styles.backgroundImage && b.styles.backgroundImage !== "none") { let s = b.styles.backgroundImage; for (const m of [...s.matchAll(/url\("?([^")]+)"?\)/g)]) s = s.replace(m[1], await resolve(m[1])); b.styles.backgroundImage = s; }
        if (b.styles.borderImageSource && b.styles.borderImageSource !== "none") { let s = b.styles.borderImageSource; for (const m of [...s.matchAll(/url\("?([^")]+)"?\)/g)]) s = s.replace(m[1], await resolve(m[1])); b.styles.borderImageSource = s; }
        for (const mk of ["maskImage", "webkitMaskImage"]) if (b.styles[mk] && b.styles[mk] !== "none") { let s = b.styles[mk]; for (const m of [...s.matchAll(/url\("?([^")]+)"?\)/g)]) s = s.replace(m[1], await resolve(m[1])); b.styles[mk] = s; }
        if (b.styles.fontFamily) used.add(b.styles.fontFamily.split(",")[0].replace(/"/g, "").trim());
      }
      d.viewport ??= [v.width, v.height];
      fs.writeFileSync(path.join(OUT, f), JSON.stringify(d));
      frames.set(name, d);
      if (name.startsWith("y-")) ys.push(Number(name.slice(2))); else states.push(name.slice(6));
    }
    ys.sort((a, b) => a - b);
    fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ version: 2, viewport: [v.width, v.height], keyframes: ys, states, topReturn: v.meta?.topReturn ?? null }));
    fs.writeFileSync(path.join(OUT, "keyframes.json"), JSON.stringify(ys));
    loaded.set(key, { v, ys, frames });
  }
  // Responsive anchoring per box, fitted across variants (the same element measured at two viewports).
  const measures = (L) => {
    const maxY = Math.max(1, ...L.ys);
    const out = new Map(); // key -> [{ rel, m }]
    const add = (k, rel, m) => { const a = out.get(k) ?? out.set(k, []).get(k); a.push({ rel, m }); };
    for (const [name, d] of L.frames) {
      const rel = name.startsWith("y-") ? Number(name.slice(2)) / maxY : 0;
      for (const b of d.boxes) {
        const r = b.xf ?? b.rect;
        add(b.key, rel, { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: parseFloat(b.styles.fontSize) || undefined, pinned: !!b.pin });
        if (b.clipKey && b.clip) add(b.clipKey, rel, { x: b.clip.x, y: b.clip.y, w: b.clip.w, h: b.clip.h, pinned: !!b.pin });
      }
    }
    return out;
  };
  const ms = new Map([...loaded].map(([k, L]) => [k, measures(L)]));
  for (const [k, L] of loaded) {
    const others = [...loaded.keys()].filter((o) => o !== k).sort((a, b) => Math.abs(loaded.get(b).v.width - L.v.width) - Math.abs(loaded.get(a).v.width - L.v.width));
    const rules = {}; let fitted = 0;
    if (others.length) {
      const O = loaded.get(others[0]); const mo = ms.get(others[0]);
      for (const [bk, list] of ms.get(k)) {
        const cand = mo.get(bk); if (!cand) continue;
        const a = list[0]; const b = cand.slice().sort((p, q) => Math.abs(p.rel - a.rel) - Math.abs(q.rel - a.rel))[0];
        const r = fitRule(a.m, { width: L.v.width, height: L.v.height }, b.m, { width: O.v.width, height: O.v.height });
        rules[bk] = [r.kx, r.kw, r.ky, r.kh, r.kf]; fitted++;
      }
    }
    fs.writeFileSync(path.join(ROOT, baseOf(k), "dom", "responsive.json"), JSON.stringify({ viewport: [L.v.width, L.v.height], against: others[0] ?? null, rules }));
    const rep = report.variants.find((x) => x.viewport === k) ?? (report.variants.push({ viewport: k }), report.variants.at(-1));
    rep.dom = { keyframes: L.ys.length, states: [...L.frames.keys()].filter((n) => n.startsWith("state-")).map((n) => n.slice(6)), boxesWithFittedAnchors: fitted, transformedBoxes: [...L.frames.values()].reduce((n, d) => n + d.boxes.filter((b) => b.xf).length, 0), pseudoBoxes: [...L.frames.values()].reduce((n, d) => n + d.boxes.filter((b) => b.pseudo).length, 0) };
  }
  const css = new Set();
  for (const f of ex.fonts ?? []) {
    if (!used.has(f.family)) continue;
    for (const s of f.sources) {
      if (s.url.startsWith("data:")) continue;
      const file = local(s.url) ?? (await fetchTo(s.url, FONTS).catch(() => null));
      if (!file) { missing.push(s.url); continue; }
      const name = path.basename(new URL(s.url).pathname);
      if (path.resolve(file) !== path.resolve(path.join(FONTS, name))) fs.copyFileSync(file, path.join(FONTS, name));
      css.add(`@font-face { font-family: "${f.family}"; src: url("/fonts/${name}")${s.format ? ` format("${s.format}")` : ""};${f.weight ? ` font-weight: ${f.weight};` : ""}${f.style ? ` font-style: ${f.style};` : ""} font-display: block;${f.unicodeRange ? ` unicode-range: ${f.unicodeRange};` : ""} }`);
      break;
    }
  }
  fs.mkdirSync(path.join(app, "src/app"), { recursive: true });
  fs.writeFileSync(path.join(app, "src/app/fonts.css"), "/* Generated by stage-replay.mjs from the target's @font-face rules. */\n" + [...css].join("\n") + "\n");
  // Every section name with its box count: each must be rendered by a <DomLayer sections=[...]/> component (or be a
  // widget rebuilt by hand and excluded), or its boxes silently disappear from the clone.
  const sectionBoxes = {};
  for (const L of loaded.values()) for (const d of L.frames.values()) for (const b of d.boxes) sectionBoxes[b.section] = (sectionBoxes[b.section] ?? 0) + 1;
  report.dom = { assets: seen.size, missing, fontFamiliesUsed: [...used], fontFaces: css.size, sections: sectionBoxes };
}
// Document height per variant (the clone's ReplaySpacer reproduces the target's scroll length at every window size).
const heightOf = (k) => {
  for (const v of [...domVariants, ...sceneVariants].filter((x) => keyOf(x) === k)) {
    if (v.meta?.scrollHeight) return v.meta.scrollHeight;
    const f = fs.readdirSync(v.dir).find((x) => /^dom-y-\d+\.json$/.test(x));
    const sh = f && readJson(path.join(v.dir, f), {})?.scrollHeight;
    if (sh) return sh;
  }
  return null;
};
fs.writeFileSync(path.join(ROOT, "viewports.json"), JSON.stringify(allKeys.map((k) => { const [width, height] = k.split("x").map(Number); return { width, height, base: baseOf(k), scrollHeight: heightOf(k) }; })));
console.log(JSON.stringify(report, null, 1));
