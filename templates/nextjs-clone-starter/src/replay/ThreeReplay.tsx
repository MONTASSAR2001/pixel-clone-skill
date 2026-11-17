"use client";

/**
 * Generic three.js scene replay (dump-and-replay of a bespoke renderer).
 * Rebuilds the target's scenes from /replay (compare_visual_diff dumpReplayTo / three-scene-dump, staged by
 * stage-replay.mjs): geometry buffers, materials compiled from the target's exact GLSL (RawShaderMaterial), uniforms,
 * textures (glTF names / URLs / KTX2) and render targets, then executes the recorded per-frame pass list.
 *
 * - Responsive: picks the captured viewport variant closest to the window, renders at the window size (resize-aware),
 *   adapts camera projections, screen-sized render targets, viewport/scissor rects and resolution uniforms.
 * - Progressive: the keyframe at the visitor's scroll position (the hero, on load) is fetched and drawn first with only
 *   its own geometry chunk and textures; every other keyframe streams in by distance from the current scroll.
 * - Smooth: one damped scroll clock; object/camera matrices (decomposed + slerp), projections, numeric uniforms and
 *   opacities interpolate between the two keyframes around the scroll position. Draws only when something changed.
 */
import { useEffect, useRef, useState } from "react";
import { ReplayBoundary } from "./ReplayBoundary";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { onReplayState, setTopReturnAvailable } from "@/lib/replayState";
import { REPLAY_ROOT, binary, captureScrollY, json, onReplayFrame, priorityQueue, replayMetrics, smoothScrollY, useReplayVariant } from "./replayData";
import { adaptProjection, bracket, resolutionKind, resolutionValue, type Size, type Variant } from "./replayMath";

type Json = Record<string, any>;
type Entry = { y?: number; name?: string; file: string; chunks: number[]; textures: string[]; viewport?: Size };
type Manifest = { version: number; viewport: Size; keyframes: Entry[]; states: Entry[]; chunks: { file: string }[]; topReturn?: { distinct?: boolean } | null };
type Dec = { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 } | null;
type ObjE = { obj: THREE.Object3D; base: number[]; dec?: Dec };
type CamE = { cam: THREE.Camera; base: number[]; pm: number[]; info: Json; dec?: Dec };
type Uni = { name: string; val: any; res: ReturnType<typeof resolutionKind>; texUuid?: string; scratch?: any; resScratch?: any };
type MatS = { uuid: string; m: any; flags: [string, unknown][]; opacity?: number; uni: Uni[]; uniIdx: Map<string, Uni>; color?: number[] | null; map?: string | null; alphaMap?: string | null };
type World = { id: number; y: number; name?: string; viewport: Size; passes: Json[]; scenes: Map<string, THREE.Scene>; order: Map<string, THREE.Object3D[]>; objs: Map<string, ObjE>; cams: Map<string, CamE>; mats: Map<string, MatS>; modified: Set<ObjE | CamE> };

const TYPED: Record<string, any> = { Float32Array, Uint16Array, Uint32Array, Uint8Array, Int16Array, Int8Array, Int32Array, Uint8ClampedArray };
const CANVAS_STYLE = { display: "block", position: "fixed", inset: 0, width: "100%", height: "100%" } as const;

export function ThreeReplay() {
  const v = useReplayVariant();
  // Bumped when the GPU context is restored after a loss: the replay rebuilds from scratch.
  const [generation, setGeneration] = useState(0);
  // A new variant (window crossed to another captured aspect) remounts the replay with that variant's data. A failure
  // in the WebGL layer never takes the page down: the UI layers and the hero poster stay.
  return (
    <ReplayBoundary name="ThreeReplay">
      {v ? <ReplayCanvas key={`${v.base}#${generation}`} v={v} onRestored={() => setGeneration((g) => g + 1)} /> : <canvas style={CANVAS_STYLE} />}
    </ReplayBoundary>
  );
}

/** WebGL unavailable (GPU process down, hardware acceleration off, blocklisted driver): keep the poster as the hero. */
function keepPosterOnly(reason: string) {
  const st = replayMetrics();
  st.error = reason;
  st.stage = "no-webgl";
  console.warn(`[replay] WebGL unavailable (${reason}); showing the hero poster and the UI layers only.`);
  const poster = document.querySelector<HTMLImageElement>("img[data-replay-poster]");
  if (!poster) return () => undefined;
  // The poster is the hero frame only: fade it out once the visitor scrolls past the hero.
  const onScroll = () => { poster.style.opacity = window.scrollY > window.innerHeight / 2 ? "0" : "1"; };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  return () => window.removeEventListener("scroll", onScroll);
}

async function loadManifest(base: string): Promise<Manifest & { legacy?: boolean }> {
  const m = await json<Manifest>(base + "manifest.json");
  if (m && m.version >= 2) return m;
  // Data staged by an older stage-replay: one geometry.bin, dependencies discovered per keyframe.
  const keys = (await json<number[]>(base + "keyframes.json")) ?? [];
  const states = (await json<string[]>(base + "states.json")) ?? [];
  return { version: 1, legacy: true, viewport: [1440, 900], chunks: [{ file: "geometry.bin" }], topReturn: null,
    keyframes: keys.map((y) => ({ y, file: `y-${y}.json`, chunks: [0], textures: [] })),
    states: states.map((n) => ({ name: n, file: `state-${n}.json`, chunks: [0], textures: [] })) };
}

const texUuids = (v: unknown, out = new Set<string>()): Set<string> => {
  if (!v || typeof v !== "object") return out;
  if (Array.isArray(v)) { for (const x of v) texUuids(x, out); return out; }
  const o = v as Json;
  if (typeof o.$tex === "string") out.add(o.$tex);
  for (const [k, x] of Object.entries(o)) { if ((k === "map" || k === "alphaMap") && typeof x === "string") out.add(x); else if (x && typeof x === "object") texUuids(x, out); }
  return out;
};

function ReplayCanvas({ v, onRestored }: { v: Variant; onRestored: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const canvas = canvasRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, stencil: true, premultipliedAlpha: true });
    } catch (e) {
      canvas.style.display = "none";
      return keepPosterOnly(String((e as Error)?.message ?? e));
    }
    renderer.autoClear = false;
    // GPU resets (driver update, sleep, too many contexts): pause, then rebuild the replay when the context returns.
    const onLost = (e: Event) => { e.preventDefault(); disposed = true; replayMetrics().stage = "context-lost"; };
    const onRestore = () => onRestored();
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestore);
    cleanups.push(() => { canvas.removeEventListener("webglcontextlost", onLost); canvas.removeEventListener("webglcontextrestored", onRestore); });
    const st = replayMetrics();
    st.stage = "init";
    const base = REPLAY_ROOT + v.base;
    let dirty = true, hasVideo = false;
    const stages: Record<string, number> = {};
    st.stages = stages;
    const mark = (k: string) => { stages[k] = Math.round(performance.now()); };
    // A baked hero poster (ReplayPreload) covers the canvas until the live hero is complete, then cross-fades out.
    const poster = document.querySelector<HTMLImageElement>("img[data-replay-poster]");
    const posterShown = !!poster && !!poster.getAttribute("src");
    if (posterShown) { canvas.style.opacity = "0"; canvas.style.transition = "opacity 200ms linear"; }
    const revealCanvas = () => {
      canvas.style.opacity = "1";
      if (poster) setTimeout(() => poster.remove(), 250);
    };
    const posterTimeout = setTimeout(revealCanvas, 15000); // never keep a stale poster
    cleanups.push(() => clearTimeout(posterTimeout));

    (async () => {
      const [manifest, S, texMap] = await Promise.all([loadManifest(base), json<Json>(base + "static.json"), json<Json>(base + "texture-map.json")]);
      if (!S || !texMap) throw new Error(`replay data missing under ${base}`);
      if (disposed) return;
      mark("manifest");
      setTopReturnAvailable(manifest.states.some((s) => s.name === "top-return") && manifest.topReturn?.distinct !== false);
      const all: Entry[] = [...manifest.keyframes, ...manifest.states];
      const keyYs = manifest.keyframes.map((e) => e.y!).sort((a, b) => a - b);
      st.keyframesTotal = all.length;

      // ---------- shared loaders (memoised) ----------
      const chunkP = new Map<number, Promise<ArrayBuffer>>();
      const chunkBuf = new Map<number, ArrayBuffer>();
      const loadChunk = (i: number) => {
        if (!chunkP.has(i)) chunkP.set(i, binary(base + manifest.chunks[i]!.file).then((b) => { chunkBuf.set(i, b); return b; }));
        return chunkP.get(i)!;
      };
      const ktx2 = new KTX2Loader().setTranscoderPath(REPLAY_ROOT).detectSupport(renderer);
      const gltfLoader = new GLTFLoader().setKTX2Loader(ktx2);
      const glbP = new Map<string, Promise<Map<string, THREE.Texture>>>();
      const loadGlb = (url: string) => {
        if (!glbP.has(url)) glbP.set(url, gltfLoader.loadAsync(url).then(async (g) => new Map(((await g.parser.getDependencies("texture")) as THREE.Texture[]).filter(Boolean).map((t) => [t.name, t]))));
        return glbP.get(url)!;
      };
      const applyTexParams = (t: THREE.Texture, d: Json) => {
        for (const k of ["wrapS", "wrapT", "magFilter", "minFilter", "anisotropy", "generateMipmaps", "premultiplyAlpha", "rotation", "matrixAutoUpdate"]) if (d[k] !== undefined && d[k] !== null) (t as any)[k] = d[k];
        // Pre-r152 three (no colour management) sampled textures as stored; keep the recorded colour space otherwise.
        t.colorSpace = d.colorSpace ?? THREE.NoColorSpace;
        if (d.repeat) t.repeat.set(d.repeat[0], d.repeat[1]);
        if (d.offset) t.offset.set(d.offset[0], d.offset[1]);
        if (!(t as any).isCompressedTexture && d.flipY !== undefined) t.flipY = d.flipY;
        t.needsUpdate = true;
      };
      const textures = new Map<string, THREE.Texture>();
      const texP = new Map<string, Promise<void>>();
      const imgLoader = new THREE.TextureLoader();
      const loadTex = (uuid: string) => {
        if (!texP.has(uuid)) texP.set(uuid, (async () => {
          const m = texMap[uuid], d = S.textures[uuid];
          if (!m || m.kind === "rt" || !d) return;
          let t: THREE.Texture | undefined;
          try {
            if (m.kind === "glb") t = (await loadGlb(m.glb)).get(m.name);
            else if (m.kind === "ktx2") t = await ktx2.loadAsync(m.url);
            else if (m.kind === "video") {
              // Timeline sync: start at the recorded frame; hold it during visual diffs / virtual time.
              const vid = document.createElement("video"); vid.src = m.url; vid.muted = true; vid.loop = d.loop ?? true; vid.playsInline = true; vid.crossOrigin = "anonymous";
              const frozen = !!((window as any).__pcVisualDiff || (window as any).__pcVirtual);
              await new Promise<void>((res) => { vid.addEventListener("loadedmetadata", () => res(), { once: true }); vid.addEventListener("error", () => res(), { once: true }); vid.load(); });
              if (d.playbackRate) vid.playbackRate = d.playbackRate;
              if (typeof d.time === "number" && isFinite(d.time)) { vid.currentTime = d.time; await new Promise<void>((res) => { vid.addEventListener("seeked", () => res(), { once: true }); setTimeout(res, 1500); }); }
              if (!frozen && !d.paused) void vid.play().catch(() => undefined);
              t = new THREE.VideoTexture(vid); hasVideo = !frozen; cleanups.push(() => vid.pause());
            }
            else t = await imgLoader.loadAsync(m.url);
          } catch (e) { console.warn("texture failed", uuid, m, e); st.texturesFailed = (st.texturesFailed as number) + 1; }
          if (t) { applyTexParams(t, d); textures.set(uuid, t); st.textures = (st.textures as number) + 1; dirty = true; }
        })());
        return texP.get(uuid)!;
      };

      // ---------- renderer configuration (from the first keyframe) ----------
      let R: Json | null = null;
      let pr0 = 1, pr = 1;
      const cap: Size = manifest.viewport;
      let win: Size = [canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight];
      const rts = new Map<string, { rt: THREE.WebGLRenderTarget; ratio: number | null }>();
      const rtByTexture = new Map<string, THREE.WebGLRenderTarget>();
      const configure = (f: Json) => {
        R = f.renderer ?? {};
        pr0 = R!.pixelRatio ?? 1;
        // The dump ran at DSF 1: a site whose pixel ratio equalled it follows devicePixelRatio (capped at 2, as sites do).
        pr = pr0 === (f.dpr ?? 1) ? Math.min(window.devicePixelRatio || 1, 2) * pr0 : pr0;
        renderer.setPixelRatio(pr);
        renderer.setSize(win[0], win[1], false);
        renderer.toneMapping = R!.toneMapping ?? THREE.NoToneMapping;
        renderer.toneMappingExposure = R!.toneMappingExposure ?? 1;
        if (!R!.outputColorSpace) THREE.ColorManagement.enabled = false;
        renderer.outputColorSpace = R!.outputColorSpace ?? THREE.LinearSRGBColorSpace;
        renderer.sortObjects = R!.sortObjects ?? true;
        const bw = cap[0] * pr0, bh = cap[1] * pr0;
        for (const rt of Object.values(S.renderTargets) as Json[]) {
          const td = rt.texture ? S.textures[rt.texture] : null;
          // Screen-sized targets (full / half / quarter resolution) follow the window; fixed-size ones keep their size.
          const rx = rt.w / bw, ry = rt.h / bh;
          const ratio = Math.abs(rx - ry) < 0.01 && rx > 0.05 && rx <= 4 ? rx : null;
          const w0 = ratio ? Math.max(1, Math.round(win[0] * pr * ratio)) : rt.w, h0 = ratio ? Math.max(1, Math.round(win[1] * pr * ratio)) : rt.h;
          const target = new THREE.WebGLRenderTarget(w0, h0, {
            depthBuffer: rt.depth ?? true, stencilBuffer: rt.stencil ?? true, samples: rt.samples ?? 0,
            minFilter: td?.minFilter ?? THREE.LinearFilter, magFilter: td?.magFilter ?? THREE.LinearFilter, generateMipmaps: td?.generateMipmaps ?? false,
          });
          rts.set(rt.uuid, { rt: target, ratio });
          if (rt.texture) rtByTexture.set(rt.texture, target);
        }
      };
      const resize = () => {
        const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
        if (w === win[0] && h === win[1]) return;
        win = [w, h];
        renderer.setSize(w, h, false);
        for (const { rt, ratio } of rts.values()) if (ratio) rt.setSize(Math.max(1, Math.round(w * pr * ratio)), Math.max(1, Math.round(h * pr * ratio)));
        dirty = true;
      };
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      cleanups.push(() => ro.disconnect());
      const tex = (uuid: string) => textures.get(uuid) ?? rtByTexture.get(uuid)?.texture ?? null;
      // Until a texture has streamed in, samplers read a transparent 1x1 texture (the hero draws before its textures).
      const PENDING = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
      PENDING.needsUpdate = true;

      // ---------- geometry / values / materials ----------
      const geometries = new Map<string, THREE.BufferGeometry>();
      const geo = (uuid: string) => {
        if (geometries.has(uuid)) return geometries.get(uuid)!;
        const d = S.geometries[uuid];
        const bin = chunkBuf.get(d.chunk ?? 0)!;
        const g = new THREE.BufferGeometry();
        const view = (a: Json) => new TYPED[a.type](bin, a.offset, a.bytes / TYPED[a.type].BYTES_PER_ELEMENT);
        for (const [k, a] of Object.entries(d.attributes) as [string, Json][]) g.setAttribute(k, new THREE.BufferAttribute(view(a), a.itemSize, a.normalized));
        if (d.index) g.setIndex(new THREE.BufferAttribute(view(d.index), 1));
        for (const gr of d.groups ?? []) g.addGroup(gr.start, gr.count, gr.materialIndex);
        if (d.drawRange) g.setDrawRange(d.drawRange.start ?? 0, d.drawRange.count ?? Infinity); // JSON null = Infinity
        g.computeBoundingSphere();
        geometries.set(uuid, g);
        return g;
      };
      const conv = (val: any): any => {
        if (val === null || typeof val !== "object") return val;
        if (Array.isArray(val)) return val.map(conv);
        if ("$tex" in val) return val.$tex ? tex(val.$tex) : null;
        if ("$color" in val) return new THREE.Color(val.$color[0], val.$color[1], val.$color[2]);
        if ("$vec" in val) { const a = val.$vec; return a.length === 2 ? new THREE.Vector2(...a) : a.length === 3 ? new THREE.Vector3(...a) : new THREE.Vector4(...a); }
        if ("$mat" in val) return val.$mat.length === 9 ? new THREE.Matrix3().fromArray(val.$mat) : new THREE.Matrix4().fromArray(val.$mat);
        if ("$typed" in val) return new TYPED[val.$typed](val.data);
        const o: Json = {}; for (const k of Object.keys(val)) o[k] = conv(val[k]); return o;
      };
      const materials = new Map<string, THREE.Material>();
      const material = (uuid: string): THREE.Material => {
        if (materials.has(uuid)) return materials.get(uuid)!;
        const d = S.materials[uuid];
        const prog = d.program != null ? S.programs[d.program] : null;
        let m: THREE.Material;
        if ((d.isShaderMaterial || d.isRaw) && prog?.vertex && prog?.fragment) {
          // The exact program the target compiled; three inserts its own #defines first, so #version moves to glslVersion.
          const strip = (src: string) => src.replace(/^\s*#version 300 es\s*\n/, "").replace(/^#define SHADER_(NAME|TYPE)\b.*$/gm, "");
          m = new THREE.RawShaderMaterial({ vertexShader: strip(prog.vertex), fragmentShader: strip(prog.fragment), uniforms: {}, glslVersion: /^\s*#version 300 es/.test(prog.vertex) ? THREE.GLSL3 : null });
        } else if (d.isShaderMaterial && d.vertexShader) {
          m = new THREE.ShaderMaterial({ vertexShader: d.vertexShader, fragmentShader: d.fragmentShader, defines: d.defines ?? {}, uniforms: {}, extensions: d.extensions ?? undefined });
        } else m = new THREE.MeshBasicMaterial();
        m.name = d.name;
        materials.set(uuid, m);
        return m;
      };
      const prepMat = (state: Json): MatS => {
        const m = material(state.uuid) as any;
        const flags = Object.entries(state.flags ?? {}).filter(([k, val]) => k !== "visible" || val === true || val === false);
        const uni: Uni[] = [];
        if (m.isShaderMaterial) for (const [name, raw] of Object.entries(state.uniforms ?? {})) {
          const val = conv(raw);
          if (!m.uniforms[name]) m.uniforms[name] = { value: val };
          const texUuid = raw && typeof raw === "object" && typeof (raw as Json).$tex === "string" ? (raw as Json).$tex as string : undefined;
          uni.push({ name, val, texUuid, res: resolutionKind(name, raw, cap, pr0) });
        }
        return { uuid: state.uuid, m, flags, opacity: typeof state.flags?.opacity === "number" ? state.flags.opacity : undefined, uni, uniIdx: new Map(uni.map((u) => [u.name, u])), color: state.color, map: state.map, alphaMap: state.alphaMap };
      };

      // ---------- worlds (one per keyframe / state) ----------
      let worldId = 0;
      const buildWorld = (f: Json, e: Entry): World => {
        const scenes = new Map<string, THREE.Scene>();
        const order = new Map<string, THREE.Object3D[]>();
        const objs = new Map<string, ObjE>();
        const mats = new Map<string, MatS>();
        const addMat = (s: Json) => { if (s && !mats.has(s.uuid)) mats.set(s.uuid, prepMat(s)); return s ? material(s.uuid) : null; };
        for (const [uuid, sd] of Object.entries(f.scenes) as [string, Json][]) {
          const local = new Map<string, THREE.Object3D>();
          let scene: THREE.Scene | null = null;
          for (const o of sd.objects as Json[]) {
            let obj: THREE.Object3D;
            if (o.type === "Scene") obj = scene = new THREE.Scene();
            else if (o.geometry) {
              const ms = [o.material].flat().filter(Boolean) as Json[];
              const mm = ms.map(addMat) as THREE.Material[];
              obj = o.type === "Points" ? new THREE.Points(geo(o.geometry), mm[0]) : o.type === "Line" || o.type === "LineSegments" ? new THREE.LineSegments(geo(o.geometry), mm[0]) : new THREE.Mesh(geo(o.geometry), Array.isArray(o.material) ? mm : mm[0]);
            } else obj = new THREE.Object3D();
            obj.name = o.name;
            obj.matrixAutoUpdate = false;
            (obj as any).matrixWorldAutoUpdate = false;
            obj.matrix.fromArray(o.matrix);
            obj.matrixWorld.fromArray(o.matrixWorld);
            obj.visible = o.visible;
            obj.renderOrder = o.renderOrder;
            obj.frustumCulled = o.frustumCulled;
            obj.layers.mask = o.layers;
            local.set(o.uuid, obj);
            if (o.type !== "Scene") objs.set(o.uuid, { obj, base: o.matrixWorld });
            (order.get(uuid) ?? order.set(uuid, []).get(uuid)!).push(obj);
            if (o.parent && local.has(o.parent)) local.get(o.parent)!.add(obj);
          }
          if (scene) {
            scene.matrixWorldAutoUpdate = false;
            if (sd.overrideMaterial) scene.overrideMaterial = addMat(sd.overrideMaterial);
            scenes.set(uuid, scene);
          }
        }
        const cams = new Map<string, CamE>();
        for (const [uuid, c] of Object.entries(f.cameras) as [string, Json][]) {
          const cam = c.type === "OrthographicCamera" ? new THREE.OrthographicCamera(c.left, c.right, c.top, c.bottom, c.near, c.far) : new THREE.PerspectiveCamera(c.fov, c.aspect, c.near, c.far);
          cam.matrixAutoUpdate = false;
          (cam as any).matrixWorldAutoUpdate = false;
          cam.matrixWorld.fromArray(c.matrixWorld);
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          cam.projectionMatrix.fromArray(c.projectionMatrix);
          cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
          cam.layers.mask = c.layers;
          cams.set(uuid, { cam, base: c.matrixWorld, pm: c.projectionMatrix, info: c });
        }
        return { id: worldId++, y: f.y ?? e.y ?? 0, name: e.name, viewport: (f.viewport ?? e.viewport ?? cap) as Size, passes: f.passes, scenes, order, objs, cams, mats, modified: new Set() };
      };

      const ready = new Map<number, World>(), readyStates = new Map<string, World>();
      /**
       * Precompile every program a keyframe needs, per render pass: three picks a different program variant for
       * render-target passes (linear output, no tone mapping) and only compiles visible objects, so each pass is
       * compiled with its own target, visibility bits and layers. With KHR_parallel_shader_compile this runs on driver
       * threads; the first draw then only binds.
       */
      const compile = async (w: World) => {
        const c = renderer as any;
        if (!c.compileAsync) return;
        const jobs: Promise<unknown>[] = [];
        const seen = new Set<string>();
        for (const p of w.passes) {
          if (p.op !== "render") continue;
          const sc = w.scenes.get(p.scene), cm = w.cams.get(p.cameraUuid)?.cam;
          if (!sc || !cm) continue;
          const key = `${p.scene}|${p.target?.uuid ?? "screen"}|${p.vis ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (typeof p.vis === "string") { const objs = w.order.get(p.scene) ?? []; for (let i = 0; i < objs.length && i < p.vis.length; i++) objs[i]!.visible = p.vis[i] === "1"; }
          renderer.setRenderTarget(p.target ? rts.get(p.target.uuid)?.rt ?? null : null);
          jobs.push(c.compileAsync(sc, cm).catch(() => undefined));
        }
        renderer.setRenderTarget(null);
        await Promise.all(jobs);
      };
      /**
       * Hero: draw as soon as its geometry and programs are ready; its textures stream in meanwhile (shader compile and
       * texture decode overlap) and each one redraws. Other keyframes become visible only when complete (no pop-in
       * while scrolling) and precompile their programs before that.
       */
      const loadEntry = async (e: Entry, hero = false) => {
        const f = await json<Json>(base + e.file);
        if (!f || disposed) return;
        const texs = (manifest as { legacy?: boolean }).legacy ? [...texUuids(f.scenes)] : e.textures;
        if (hero) mark("heroJson");
        const texturesDone = Promise.all(texs.map(loadTex));
        await Promise.all(e.chunks.map(loadChunk));
        if (!hero) await texturesDone;
        if (disposed) return;
        if (hero) mark("heroGeometry");
        if (!R) configure(f);
        const w = buildWorld(f, e);
        applyWorld(w, null, 0);
        await compile(w);
        if (disposed) return;
        if (hero) {
          mark("heroCompiled");
          heroTexturesDone = texturesDone.then(() => { mark("heroTextures"); dirty = true; heroTexturesReady = true; });
        }
        if (e.name) readyStates.set(e.name, w); else ready.set(e.y!, w);
        st.keyframesReady = ready.size + readyStates.size;
        dirty = true;
      };
      let heroTexturesReady = false;
      let heroTexturesDone: Promise<void> = Promise.resolve();

      // ---------- per-frame interpolation ----------
      const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
      const decOf = (e: ObjE | CamE): Dec => {
        if (e.dec !== undefined) return e.dec;
        _m.fromArray(e.base);
        const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
        _m.decompose(p, q, s);
        const re = new THREE.Matrix4().compose(p, q, s);
        let err = 0, mag = 1;
        for (let i = 0; i < 16; i++) { err = Math.max(err, Math.abs(re.elements[i]! - e.base[i]!)); mag = Math.max(mag, Math.abs(e.base[i]!)); }
        e.dec = err < 1e-4 * mag ? { p, q, s } : null; // sheared matrices interpolate element-wise
        return e.dec;
      };
      const mixMatrix = (out: THREE.Matrix4, a: ObjE | CamE, b: ObjE | CamE, w: number) => {
        const da = decOf(a), db = decOf(b);
        if (da && db) { _p.lerpVectors(da.p, db.p, w); _q.slerpQuaternions(da.q, db.q, w); _s.lerpVectors(da.s, db.s, w); out.compose(_p, _q, _s); }
        else for (let i = 0; i < 16; i++) out.elements[i] = a.base[i]! + (b.base[i]! - a.base[i]!) * w;
      };
      const pairs = new Map<string, { objs: [ObjE, ObjE][]; cams: [CamE, CamE][] }>();
      const differs = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 1e-7) return true; return false; };
      const pairOf = (W: World, O: World) => {
        const k = W.id + "|" + O.id;
        let p = pairs.get(k);
        if (!p) {
          p = { objs: [], cams: [] };
          for (const [u, a] of W.objs) { const b = O.objs.get(u); if (b && differs(a.base, b.base)) p.objs.push([a, b]); }
          for (const [u, a] of W.cams) { const b = O.cams.get(u); if (b && (differs(a.base, b.base) || differs(a.pm, b.pm))) p.cams.push([a, b]); }
          pairs.set(k, p);
        }
        return p;
      };
      const pmScratch: number[] = new Array(16).fill(0);
      const mixUni = (u: Uni, b: any, w: number) => {
        const a = u.val;
        if (typeof a === "number" && typeof b === "number") return a + (b - a) * w;
        if (a && b && typeof a === "object" && a.constructor === b.constructor) {
          if (a.isVector2 || a.isVector3 || a.isVector4 || a.isColor) return (u.scratch ??= a.clone()).copy(a).lerp(b, w);
          if (a.isMatrix3 || a.isMatrix4) { const s = (u.scratch ??= a.clone()); for (let i = 0; i < a.elements.length; i++) s.elements[i] = a.elements[i] + (b.elements[i] - a.elements[i]) * w; return s; }
          if (Array.isArray(a) && a.length === b.length && typeof a[0] === "number") { const s = (u.scratch ??= a.slice()); for (let i = 0; i < a.length; i++) s[i] = a[i] + (b[i] - a[i]) * w; return s; }
        }
        return a;
      };
      const applyWorld = (W: World, O: World | null, w: number) => {
        const resized = win[0] !== W.viewport[0] || win[1] !== W.viewport[1] || pr !== pr0;
        // matrices
        const now = new Set<ObjE | CamE>();
        if (O && w > 0) {
          const p = pairOf(W, O);
          for (const [a, b] of p.objs) { mixMatrix(a.obj.matrixWorld, a, b, w); now.add(a); }
          for (const [a, b] of p.cams) { mixMatrix(a.cam.matrixWorld, a, b, w); a.cam.matrixWorldInverse.copy(a.cam.matrixWorld).invert(); now.add(a); }
        }
        for (const e of W.modified) if (!now.has(e)) {
          if ("obj" in e) e.obj.matrixWorld.fromArray(e.base);
          else { e.cam.matrixWorld.fromArray(e.base); e.cam.matrixWorldInverse.copy(e.cam.matrixWorld).invert(); }
        }
        W.modified = now;
        // projections: interpolated, then adapted to the window aspect
        for (const [u, c] of W.cams) {
          const o = O && w > 0 ? O.cams.get(u) : undefined;
          let P: number[] = c.pm;
          if (o && differs(c.pm, o.pm)) { for (let i = 0; i < 16; i++) pmScratch[i] = c.pm[i]! + (o.pm[i]! - c.pm[i]!) * w; P = pmScratch; }
          if (resized) P = adaptProjection(P, c.info as any, W.viewport, win);
          c.cam.projectionMatrix.fromArray(P);
          c.cam.projectionMatrixInverse.copy(c.cam.projectionMatrix).invert();
        }
        // materials
        for (const s of W.mats.values()) {
          const m = s.m;
          for (const [k, val] of s.flags) m[k] = val;
          const p = O && w > 0 ? O.mats.get(s.uuid) : undefined;
          if (p && s.opacity !== undefined && p.opacity !== undefined) m.opacity = s.opacity + (p.opacity - s.opacity) * w;
          if (m.isShaderMaterial) {
            for (const u of s.uni) {
              let val = u.val;
              if (u.texUuid) val = tex(u.texUuid) ?? PENDING;
              else if (p) { const q = p.uniIdx.get(u.name); if (q) val = mixUni(u, q.val, w); }
              if (u.res && resized) {
                const r = resolutionValue(u.res, win, pr);
                val = typeof r === "number" ? r : (u.resScratch ??= u.val.clone()).fromArray(r);
              }
              m.uniforms[u.name].value = val;
            }
          } else {
            if (s.color) m.color.setRGB(s.color[0], s.color[1], s.color[2]);
            m.map = s.map ? tex(s.map) : null;
            m.alphaMap = s.alphaMap ? tex(s.alphaMap) : null;
          }
        }
      };
      const clearColor = new THREE.Color();
      const runPasses = (W: World) => {
        const sx = win[0] / W.viewport[0], sy = win[1] / W.viewport[1];
        let target: { rt: THREE.WebGLRenderTarget; ratio: number | null } | null = null;
        for (const p of W.passes) {
          target = p.target ? rts.get(p.target.uuid) ?? null : null;
          if (p.op === "render") {
            const scene = W.scenes.get(p.scene), cam = W.cams.get(p.cameraUuid)?.cam;
            if (!scene || !cam) continue;
            // Multi-pass renderers toggle visibility and camera layers between renders of the same scene.
            if (typeof p.vis === "string") { const objs = W.order.get(p.scene) ?? []; for (let i = 0; i < objs.length && i < p.vis.length; i++) objs[i]!.visible = p.vis[i] === "1"; }
            if (typeof p.camLayers === "number") cam.layers.mask = p.camLayers;
            renderer.setRenderTarget(target?.rt ?? null);
            renderer.render(scene, cam);
          } else if (p.op.startsWith("clear")) {
            renderer.setRenderTarget(target?.rt ?? null);
            if (p.clearColor) renderer.setClearColor(clearColor.setRGB(p.clearColor[0], p.clearColor[1], p.clearColor[2]), p.clearAlpha ?? 1);
            (renderer as any)[p.op](...(p.args ?? []));
          } else if (p.op === "setViewport" || p.op === "setScissor") {
            const a = p.args ?? [];
            const r = (Array.isArray(a[0]) ? a[0] : typeof a[0] === "object" && a[0] ? [a[0].x, a[0].y, a[0].z, a[0].w] : a) as number[];
            // Rects recorded for the captured viewport follow the window (screen and screen-sized targets).
            const scale = !target || target.ratio ? [sx, sy] : [1, 1];
            (renderer as any)[p.op](r[0]! * scale[0]!, r[1]! * scale[1]!, r[2]! * scale[0]!, r[3]! * scale[1]!);
          } else if (p.op === "setScissorTest") renderer.setScissorTest(!!p.args?.[0]);
          else if (p.op === "state") {
            // MaskPass-style buffer state (stencil write/test, colour/depth masks, locks) exactly as recorded.
            const buf = (renderer.state.buffers as any)[p.buffer];
            if (buf?.[p.fn]) buf[p.fn](...(p.args ?? []));
          }
        }
        renderer.setRenderTarget(null);
      };

      // ---------- hero first, then stream the rest by distance ----------
      const sy0 = captureScrollY(window.scrollY, v);
      const hero = manifest.keyframes.slice().sort((a, b) => Math.abs(a.y! - sy0) - Math.abs(b.y! - sy0))[0];
      st.stage = "hero";
      if (hero) await loadEntry(hero, true);
      if (disposed) return;
      st.stage = "streaming";
      let activeState: string | null = null;
      cleanups.push(onReplayState((n) => { activeState = n; dirty = true; }));
      const queue = priorityQueue<Entry>((e) => loadEntry(e), (e) => (e.y !== undefined ? Math.abs(e.y - captureScrollY(smoothScrollY(), v)) : 1e9 + (e.name === activeState ? -5e8 : 0)), 2);
      // The rest streams in once the hero's own textures are in (they must not compete for bandwidth/decoders).
      void Promise.race([heroTexturesDone, new Promise((r) => setTimeout(r, 4000))]).then(() => { if (!disposed) queue.add(all.filter((e) => e !== hero)); });
      cleanups.push(() => queue.stop());
      (window as any).__replayInternals = { renderer, ready, readyStates, rts, textures, materials };

      let lastKey = "";
      let cost = 0;
      const draw = (raw: number, changed: boolean) => {
        const sy = captureScrollY(raw, v);
        if (disposed || !ready.size) return;
        // which worlds: UI state near its capture position > keyframe pair around the scroll position
        let W: World | null = null, O: World | null = null, w = 0;
        const stateW = activeState && activeState !== "top-return" ? readyStates.get(activeState) : undefined;
        if (stateW && Math.abs(sy - stateW.y) < window.innerHeight / 2) W = stateW;
        else {
          const sub = (x: World | undefined) => (x && x.y === 0 && activeState === "top-return" ? readyStates.get("top-return") ?? x : x);
          const br = bracket(keyYs, sy);
          const A = sub(br ? ready.get(br.a) : undefined), B = sub(br ? ready.get(br.b) : undefined);
          if (A && B && br) { const t = br.t; W = t < 0.5 ? A : B; O = t < 0.5 ? B : A; w = t < 0.5 ? t : 1 - t; }
          else {
            let best: World | null = null;
            for (const x of ready.values()) if (!best || Math.abs(x.y - sy) < Math.abs(best.y - sy)) best = x;
            W = sub(best ?? undefined) ?? null;
          }
        }
        if (!W) return;
        const key = `${W.id}|${O?.id ?? ""}|${w.toFixed(5)}|${win[0]}x${win[1]}`;
        if (!dirty && !changed && !hasVideo && key === lastKey) return;
        lastKey = key; dirty = false;
        const t0 = performance.now();
        applyWorld(W, O, w);
        const t1 = performance.now();
        runPasses(W);
        if (st.heroMs === null) { stages.firstApplyMs = Math.round(t1 - t0); stages.firstPassesMs = Math.round(performance.now() - t1); stages.drawStart = Math.round(t0); }
        cost = cost ? cost * 0.9 + (performance.now() - t0) * 0.1 : performance.now() - t0;
        st.frameCostMs = Math.round(cost * 100) / 100;
        st.frames = (st.frames as number) + 1;
        st.keyframe = O && w > 0 ? `${W.y}~${O.y}@${w.toFixed(2)}` : W.name ?? W.y;
        if (st.heroMs === null) { renderer.getContext().finish(); st.heroMs = Math.round(performance.now()); stages.firstDraw = st.heroMs as number; st.stage = "ready"; }
        if (heroTexturesReady && st.heroCompleteMs == null) { renderer.getContext().finish(); st.heroCompleteMs = Math.round(performance.now()); revealCanvas(); }
      };
      (window as any).__replayDraw = () => { dirty = true; draw(window.scrollY, true); return canvas; };
      // First hero frame right away (not on the next rAF, which texture decoding on the main thread can delay).
      draw(window.scrollY, true);
      cleanups.push(onReplayFrame((raw, _dt, changed) => draw(raw, changed)));
    })().catch((e) => { st.error = String(e); console.error("replay failed", e); });

    return () => {
      disposed = true;
      cleanups.forEach((f) => f());
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  return <canvas ref={canvasRef} style={CANVAS_STYLE} />;
}
