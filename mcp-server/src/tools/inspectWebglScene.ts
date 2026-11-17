import path from "node:path";
import fs from "node:fs/promises";
import { launchBrowser, newContext, gotoAndSettle, outRoot, slugify, ensureDir, type ReadyOptions } from "../lib/browser.js";
import { PATH_HELPER_INIT } from "../lib/page-helpers.js";
import { collectAssets } from "../lib/assets.js";

export interface WebglInput extends ReadyOptions {
  url: string;
  /** Scroll fractions (0..1) at which to re-sample camera/uniforms, for scroll-driven scenes. e.g. [0, 0.5, 1] */
  scrollCheckpoints?: number[];
  /** Record the ordered GL command stream of one frame (passes, framebuffers, textures, state, per-draw uniforms) to webgl-frame-trace.json. */
  frameTrace?: boolean;
  settleMs?: number;
  maxObjects?: number;
  includeShaders?: boolean;
}

/**
 * Installed before any page script. Three.js (r1xx+) announces every Scene/WebGLRenderer
 * to `__THREE_DEVTOOLS__`; we also wrap render() to learn the live (scene, camera) pair and
 * patch WebGL shader/context APIs so raw GLSL is captured for any engine.
 */
export const WEBGL_HOOK_INIT = `(() => {
  if (window.__pcGL) return;
  const gl = { renderers: [], scenes: [], last: null, shaders: [], contexts: [], draws: 0, programs: [], textures: [], buffers: { count: 0, bytes: 0 } };
  window.__pcGL = gl;
  gl.renderLog = []; gl.recording = false; gl.recFrame = 0;
  // Record every renderer.render() call (scene, camera, render target) for a while, tagged by rAF frame.
  window.__pcRecordRenders = (ms) => new Promise((res) => {
    gl.renderLog = []; gl.recording = true; gl.recFrame = 0;
    const tick = () => { gl.recFrame++; if (gl.recording) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => { gl.recording = false; res(gl.renderLog); }, ms);
  });

  const dev = window.__THREE_DEVTOOLS__ || new EventTarget();
  window.__THREE_DEVTOOLS__ = dev;
  dev.addEventListener('observe', (e) => {
    const o = e.detail;
    if (!o) return;
    if (o.isWebGLRenderer && !gl.renderers.includes(o)) {
      gl.renderers.push(o);
      const orig = o.render;
      // Log clears / viewport / scissor between passes while recording (pass-graph reconstruction).
      const rec = (op, extra) => { if (gl.recording && gl.renderLog.length < 4000) { const rt = o.getRenderTarget ? o.getRenderTarget() : null; gl.renderLog.push(Object.assign({ op, target: rt ? { uuid: rt.texture ? rt.texture.uuid : String(rt.uuid), w: rt.width, h: rt.height, texture: rt.texture ? rt.texture.uuid : null, depth: !!rt.depthBuffer, stencil: !!rt.stencilBuffer, samples: rt.samples || 0 } : null, frame: gl.recFrame }, extra)); } };
      const ccol = { r: 0, g: 0, b: 0, copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; } };
      for (const fn of ['clear', 'clearColor', 'clearDepth', 'clearStencil']) { const of_ = o[fn]; if (typeof of_ === 'function') o[fn] = function () { try { o.getClearColor && o.getClearColor(ccol); rec(fn, { args: Array.from(arguments), clearColor: [ccol.r, ccol.g, ccol.b], clearAlpha: o.getClearAlpha ? o.getClearAlpha() : null }); } catch (e) {} return of_.apply(this, arguments); }; }
      for (const fn of ['setViewport', 'setScissor', 'setScissorTest']) { const of_ = o[fn]; if (typeof of_ === 'function') o[fn] = function () { try { const a = Array.from(arguments).map((x) => (x && x.isVector4 ? [x.x, x.y, x.z, x.w] : x)); rec(fn, { args: a }); } catch (e) {} return of_.apply(this, arguments); }; }
      // MaskPass-style effects drive renderer.state.buffers directly (and lock them); materials never show it.
      try {
        const bufs = o.state && o.state.buffers;
        for (const bname of ['color', 'depth', 'stencil']) {
          const buf = bufs && bufs[bname]; if (!buf) continue;
          for (const fn of ['setMask', 'setFunc', 'setOp', 'setTest', 'setLocked', 'setClear']) {
            const of2 = buf[fn]; if (typeof of2 !== 'function') continue;
            buf[fn] = function () { try { rec('state', { buffer: bname, fn, args: Array.from(arguments).map((x) => (x && x.isColor ? [x.r, x.g, x.b] : x)) }); } catch (e) {} return of2.apply(this, arguments); };
          }
        }
      } catch (e) {}
      o.render = function (scene, camera) {
        gl.last = { renderer: o, scene, camera };
        gl.sceneById = gl.sceneById || {}; gl.sceneById[scene.uuid] = scene;
        gl.cameraById = gl.cameraById || {}; gl.cameraById[camera.uuid] = camera;
        if (gl.recording && gl.renderLog.length < 2000) {
          const rt = o.getRenderTarget ? o.getRenderTarget() : null;
          const vis = []; scene.traverse((x) => vis.push(x.visible ? 1 : 0));
          gl.renderLog.push({ op: 'render', vis: vis.join(''), camLayers: camera.layers ? camera.layers.mask : 1, overrideMaterial: scene.overrideMaterial ? scene.overrideMaterial.uuid : null, scene: scene.uuid, children: scene.children.length, camera: camera.type, cameraUuid: camera.uuid, target: rt ? { uuid: rt.texture ? rt.texture.uuid : String(rt.uuid), w: rt.width, h: rt.height, texture: rt.texture ? rt.texture.uuid : null, depth: !!rt.depthBuffer, stencil: !!rt.stencilBuffer, samples: rt.samples || 0 } : null, autoClear: o.autoClear, frame: gl.recFrame });
        }
        return orig.apply(this, arguments);
      };
    } else if (o.isScene && !gl.scenes.includes(o)) gl.scenes.push(o);
  });

  // ---- WebGL1 + WebGL2: shaders, programs, uniforms, textures, buffers, draws ----
  const shaderInfo = new WeakMap();
  const progInfo = new WeakMap();
  const locInfo = new WeakMap();
  const val = (v) => { try { if (v == null) return null; if (typeof v === 'number' || typeof v === 'boolean') return v; if (v.length !== undefined) return Array.from(v).slice(0, 32).map((x) => Math.round(x * 10000) / 10000); } catch (e) {} return String(v); };
  for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    const P = Ctx.prototype;
    const wrap = (name, fn) => { const o = P[name]; if (typeof o === 'function') P[name] = function () { try { fn.apply(this, arguments); } catch (e) {} return o.apply(this, arguments); }; };
    const cs = P.createShader;
    P.createShader = function (type) { const s = cs.call(this, type); if (s) shaderInfo.set(s, { stage: type === this.VERTEX_SHADER ? 'vertex' : 'fragment', source: '' }); return s; };
    const ss = P.shaderSource;
    P.shaderSource = function (shader, src) {
      try { const i = shaderInfo.get(shader) || { stage: 'unknown' }; i.source = String(src); shaderInfo.set(shader, i); gl.shaders.push({ stage: i.stage, source: String(src) }); } catch (e) {}
      return ss.call(this, shader, src);
    };
    const cp = P.createProgram;
    P.createProgram = function () { const p = cp.call(this); if (p) { const info = { id: gl.programs.length, shaders: [], uniforms: {}, draws: 0, lastDraw: null, __prog: p }; progInfo.set(p, info); gl.programs.push(info); } return p; };
    wrap('attachShader', (prog, shader) => { const pi = progInfo.get(prog), si = shaderInfo.get(shader); if (pi && si) pi.shaders.push(si); });
    wrap('useProgram', (prog) => { gl.__cur = prog; });
    const gul = P.getUniformLocation;
    P.getUniformLocation = function (prog, name) { const loc = gul.call(this, prog, name); if (loc) locInfo.set(loc, { prog, name }); return loc; };
    for (const fn of ['uniform1f','uniform2f','uniform3f','uniform4f','uniform1i','uniform2i','uniform3i','uniform4i','uniform1fv','uniform2fv','uniform3fv','uniform4fv','uniform1iv','uniform2iv','uniform3iv','uniform4iv','uniform1ui','uniform2ui','uniform3ui','uniform4ui','uniformMatrix2fv','uniformMatrix3fv','uniformMatrix4fv']) {
      wrap(fn, (loc, a, b2, c, d) => {
        const li = locInfo.get(loc); if (!li) return;
        const pi = progInfo.get(li.prog); if (!pi) return;
        const isMat = /Matrix/.test(fn), isVec = /v$/.test(fn);
        pi.uniforms[li.name] = isMat ? val(c !== undefined && typeof c !== 'number' ? c : b2) : isVec ? val(a) : val([a, b2, c, d].filter((x) => x !== undefined && typeof x === 'number'));
        if (!isMat && !isVec && pi.uniforms[li.name] && pi.uniforms[li.name].length === 1) pi.uniforms[li.name] = pi.uniforms[li.name][0];
      });
    }
    for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      wrap(fn, function (mode, a, b2, c) { gl.draws++; const pi = progInfo.get(gl.__cur); if (pi) { pi.draws++; pi.lastDraw = { fn, mode, count: /Arrays/.test(fn) ? b2 : a, instances: /Instanced/.test(fn) ? c : 1 }; } });
    }
    wrap('bufferData', (t, d) => { gl.buffers.count++; gl.buffers.bytes += (d && (d.byteLength !== undefined ? d.byteLength : typeof d === 'number' ? d : 0)) || 0; });
    const texSrc = (args) => {
      for (const a of args) {
        if (a && a.tagName) { const tag = a.tagName.toLowerCase(); return { source: tag, src: a.currentSrc || a.src || null, width: a.naturalWidth || a.videoWidth || a.width, height: a.naturalHeight || a.videoHeight || a.height }; }
        if (typeof ImageBitmap !== 'undefined' && a instanceof ImageBitmap) return { source: 'ImageBitmap', width: a.width, height: a.height };
      }
      const n = args.filter((x) => typeof x === 'number'); return { source: 'data', width: n[3], height: n[4] };
    };
    for (const fn of ['texImage2D', 'texImage3D', 'compressedTexImage2D', 'texStorage2D']) {
      wrap(fn, function () { if (gl.textures.length < 120) gl.textures.push({ fn, ...texSrc(Array.from(arguments)) }); });
    }
  }
  // ---- Frame trace: the ordered GL command stream of ONE frame (pass graph, state, bindings, draws) ----
  const T = (gl.trace = { armed: false, on: false, done: false, ops: [], textures: {}, buffers: {}, fbs: {}, seq: 0 });
  const ids = new WeakMap();
  const idOf = (o, kind) => { if (!o) return null; if (!ids.has(o)) ids.set(o, kind + (++T.seq)); return ids.get(o); };
  const st = { fb: null, unit: 0, tex: {}, vao: null, abuf: null, ebuf: null, vaos: {} };
  const rec = (op) => { if (T.on && T.ops.length < (T.continuous ? 60000 : 6000)) T.ops.push(op); };
  const a4 = (v) => Array.from(v || []).slice(0, 16);
  gl.progInfoOf = (p) => progInfo.get(p);
  window.__pcTraceArm = (continuous) => { T.armed = true; T.on = false; T.done = false; T.ops = []; T.drawsToScreen = 0; T.continuous = !!continuous; };
  window.__pcTrace = () => ({ done: T.done, ops: T.ops, textures: T.textures, buffers: T.buffers, framebuffers: T.fbs });
  for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    const P = Ctx.prototype;
    const hook = (name, fn) => { const o = P[name]; if (typeof o === 'function') P[name] = function () { try { fn.call(this, ...arguments); } catch (e) {} return o.apply(this, arguments); }; };
    const frameBoundary = () => { if (T.continuous && T.on) return; if (T.armed && !T.on) { T.armed = false; T.on = true; T.ops = []; T.drawsToScreen = 0; } else if (T.on && T.drawsToScreen > 0) { T.on = false; T.done = true; } };
    hook('bindFramebuffer', function (t, fb) { frameBoundary(); st.fb = idOf(fb, 'fb'); rec({ op: 'bindFB', fb: st.fb }); });
    hook('clear', function (m) { frameBoundary(); rec({ op: 'clear', mask: m, fb: st.fb }); });
    hook('framebufferTexture2D', function (t, att, tt, tex, lvl) { const fb = st.fb; if (fb) { (T.fbs[fb] = T.fbs[fb] || {})[att] = idOf(tex, 'tex'); } rec({ op: 'fbTex', fb, attachment: att, tex: idOf(tex, 'tex'), level: lvl }); });
    for (const n of ['viewport', 'scissor', 'clearColor', 'blendColor']) hook(n, function (a, b, c, d) { rec({ op: n, args: [a, b, c, d] }); });
    for (const n of ['enable', 'disable', 'depthFunc', 'depthMask', 'cullFace', 'frontFace', 'blendEquation', 'stencilFunc', 'stencilOp', 'stencilMask', 'clearDepth', 'clearStencil']) hook(n, function (a, b, c) { rec({ op: n, args: [a, b, c].filter((x) => x !== undefined) }); });
    for (const n of ['blendFunc', 'blendFuncSeparate', 'blendEquationSeparate', 'colorMask']) hook(n, function (a, b, c, d) { rec({ op: n, args: [a, b, c, d].filter((x) => x !== undefined) }); });
    hook('activeTexture', function (u) { st.unit = u - 0x84C0; });
    hook('bindTexture', function (t, tex) { st.tex[st.unit] = { id: idOf(tex, 'tex'), target: t }; rec({ op: 'bindTex', unit: st.unit, tex: idOf(tex, 'tex'), target: t }); });
    hook('texParameteri', function (t, pn, v) { const b = st.tex[st.unit]; if (b && b.id) { const x = (T.textures[b.id] = T.textures[b.id] || {}); (x.params = x.params || {})[pn] = v; } });
    // Uploads into storage allocated earlier (texStorage2D + texSubImage2D): where video/canvas/bitmap textures come from.
    for (const fn of ['texSubImage2D', 'texSubImage3D', 'compressedTexSubImage2D']) {
      hook(fn, function () { const b = st.tex[st.unit]; if (!b || !b.id) return; const args = Array.from(arguments); const src = args.find((x) => x && (x.tagName || (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) || (typeof OffscreenCanvas !== 'undefined' && x instanceof OffscreenCanvas))); const x = (T.textures[b.id] = T.textures[b.id] || {}); x.uploads = (x.uploads || 0) + 1; if (src) { x.sourceKind = src.tagName ? src.tagName.toLowerCase() : src.constructor.name; x.sourceUrl = src.currentSrc || src.src || null; x.sourceSize = [src.naturalWidth || src.videoWidth || src.width, src.naturalHeight || src.videoHeight || src.height]; if (src.tagName === 'VIDEO') x.video = { loop: src.loop, muted: src.muted, duration: src.duration, time: src.currentTime }; } else x.sourceKind = 'ArrayBufferView'; });
    }
    for (const fn of ['texImage2D', 'texStorage2D', 'compressedTexImage2D', 'texImage3D']) {
      hook(fn, function () { const b = st.tex[st.unit]; if (!b || !b.id) return; const args = Array.from(arguments); const n = args.filter((x) => typeof x === 'number'); const src = args.find((x) => x && x.tagName); const x = (T.textures[b.id] = T.textures[b.id] || {}); x.fn = fn; x.target = b.target; x.size = src ? [src.naturalWidth || src.videoWidth || src.width, src.naturalHeight || src.videoHeight || src.height] : [n[3], n[4]]; x.src = src ? (src.currentSrc || src.src || src.tagName) : 'data'; x.internalFormat = n[1]; });
    }
    hook('bindBuffer', function (t, b) { if (t === 0x8892) st.abuf = idOf(b, 'buf'); else if (t === 0x8893) st.ebuf = idOf(b, 'buf'); });
    hook('bufferData', function (t, d) { const id = t === 0x8892 ? st.abuf : t === 0x8893 ? st.ebuf : null; if (!id) return; const bytes = d && d.byteLength !== undefined ? d.byteLength : typeof d === 'number' ? d : 0; T.buffers[id] = { target: t === 0x8893 ? 'element' : 'array', bytes }; if (d && d.byteLength !== undefined && bytes <= 4096) T.buffers[id].data = Array.from(new (t === 0x8893 ? Uint16Array : Float32Array)(d.buffer, d.byteOffset, bytes / (t === 0x8893 ? 2 : 4))).slice(0, 1024); });
    hook('bindVertexArray', function (v) { st.vao = idOf(v, 'vao'); });
    hook('vertexAttribPointer', function (i, size, type, norm, stride, off) { const key = st.vao || 'default'; (st.vaos[key] = st.vaos[key] || {})[i] = { size, type, normalized: norm, stride, offset: off, buffer: st.abuf }; });
    hook('vertexAttribDivisor', function (i, d) { const key = st.vao || 'default'; ((st.vaos[key] = st.vaos[key] || {})[i] = st.vaos[key][i] || {}).divisor = d; });
    for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      hook(fn, function (mode, a, b, c, d) {
        if (!T.on) return;
        const cur = gl.__cur; const info = gl.programs.find((p) => p.__prog === cur);
        const tex = {}; for (const u of Object.keys(st.tex)) if (st.tex[u].id) tex[u] = st.tex[u].id;
        rec({ op: 'draw', fn, mode, count: /Arrays/.test(fn) ? b : a, type: /Elements/.test(fn) ? b : undefined, instances: /Instanced/.test(fn) ? (/Arrays/.test(fn) ? c : c) : 1, fb: st.fb, program: info ? info.id : null, uniforms: info ? JSON.parse(JSON.stringify(info.uniforms)) : null, textures: tex, vao: st.vao || 'default', attribs: JSON.parse(JSON.stringify(st.vaos[st.vao || 'default'] || {})), ebuf: st.ebuf });
        if (st.fb === null) T.drawsToScreen++;
      });
    }
  }
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = gc.call(this, type, attrs);
    if (ctx && /webgl/.test(type)) {
      let info = {};
      try {
        const ext = ctx.getExtension('WEBGL_debug_renderer_info');
        info = { version: ctx.getParameter(ctx.VERSION), glsl: ctx.getParameter(ctx.SHADING_LANGUAGE_VERSION), renderer: ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null };
      } catch (e) {}
      gl.contexts.push({ type, attrs: attrs || null, ...info, canvas: window.__pcPath ? window.__pcPath(this) : null, width: this.width, height: this.height });
    }
    return ctx;
  };
})();`;

/** Serializer executed in the page. Receives the options object. */
const SERIALIZE = `(opts) => {
  const gl = window.__pcGL;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const vec = (v) => (v ? [r3(v.x), r3(v.y), r3(v.z)] : null);
  const hex = (c) => (c && c.isColor ? '#' + c.getHexString() : c);
  const out = { engine: null, three: null, renderers: [], scenes: [], raw: null };

  out.three = { revision: (window.THREE && window.THREE.REVISION) || null, hookedRenderers: gl.renderers.length, hookedScenes: gl.scenes.length };
  if (gl.renderers.length || gl.scenes.length || window.THREE) out.engine = 'three.js';
  else if (window.BABYLON) out.engine = 'babylon.js';
  else if (window.PIXI) out.engine = 'pixi.js';
  else if (gl.contexts.length) out.engine = 'raw-webgl-or-unknown';

  const texInfo = (t) => !t ? null : { name: t.name || null, src: (t.image && (t.image.currentSrc || t.image.src)) || null, colorSpace: t.colorSpace, wrapS: t.wrapS, wrapT: t.wrapT, repeat: t.repeat ? [t.repeat.x, t.repeat.y] : null, flipY: t.flipY, size: t.image ? [t.image.width || t.image.videoWidth || null, t.image.height || t.image.videoHeight || null] : null, compressed: !!t.isCompressedTexture, mipmaps: t.mipmaps ? t.mipmaps.length : 0, isVideo: !!t.isVideoTexture, isCube: !!t.isCubeTexture, isCanvas: !!t.isCanvasTexture };
  const uni = (u) => {
    const out = {};
    for (const k of Object.keys(u || {})) {
      const v = u[k] && u[k].value;
      if (v === undefined || v === null) out[k] = null;
      else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
      else if (v.isColor) out[k] = hex(v);
      else if (v.isVector2 || v.isVector3 || v.isVector4) out[k] = v.toArray().map(r3);
      else if (v.isTexture) out[k] = { texture: texInfo(v) };
      else if (v.isMatrix4 || v.isMatrix3) out[k] = v.elements.map(r3);
      else if (Array.isArray(v)) out[k] = v.slice(0, 8).map((x) => typeof x === 'number' ? r3(x) : '[obj]');
      else out[k] = '[' + (v.constructor && v.constructor.name) + ']';
    }
    return out;
  };
  const mat = (m) => {
    if (!m) return null;
    const o = { type: m.type, name: m.name || null };
    for (const k of ['color','emissive','specular','sheenColor','attenuationColor']) if (m[k] && m[k].isColor) o[k] = hex(m[k]);
    for (const k of ['roughness','metalness','opacity','transparent','wireframe','side','flatShading','depthTest','depthWrite','blending','alphaTest','emissiveIntensity','envMapIntensity','transmission','thickness','ior','clearcoat','clearcoatRoughness','reflectivity','shininess','vertexColors','fog','toneMapped','dithering']) if (m[k] !== undefined) o[k] = typeof m[k] === 'number' ? r3(m[k]) : m[k];
    for (const k of ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap','envMap','alphaMap','bumpMap','displacementMap','lightMap','matcap','gradientMap']) if (m[k]) o[k] = texInfo(m[k]);
    if (m.isShaderMaterial || m.isRawShaderMaterial) {
      o.uniforms = uni(m.uniforms);
      o.defines = m.defines || null;
      if (opts.includeShaders) { o.vertexShader = m.vertexShader; o.fragmentShader = m.fragmentShader; }
    }
    return o;
  };
  const geo = (g) => {
    if (!g) return null;
    const o = { type: g.type, name: g.name || null };
    if (g.parameters) o.parameters = JSON.parse(JSON.stringify(g.parameters, (k, v) => (v && v.isShape ? '[Shape]' : v)));
    const a = g.attributes || {};
    o.attributes = Object.fromEntries(Object.keys(a).map((k) => [k, { count: a[k].count, itemSize: a[k].itemSize }]));
    o.indexCount = g.index ? g.index.count : null;
    if (!g.boundingBox && g.computeBoundingBox) { try { g.computeBoundingBox(); } catch (e) {} }
    if (g.boundingBox) o.boundingBox = { min: vec(g.boundingBox.min), max: vec(g.boundingBox.max) };
    return o;
  };
  const camInfo = (c) => {
    if (!c) return null;
    const o = { type: c.type, position: vec(c.position), rotation: vec(c.rotation), near: c.near, far: c.far, zoom: c.zoom };
    o.projectionMatrix = c.projectionMatrix ? Array.from(c.projectionMatrix.elements).map(r3) : null; o.matrixWorld = c.matrixWorld ? Array.from(c.matrixWorld.elements).map(r3) : null;
    if (c.isPerspectiveCamera) Object.assign(o, { fov: r3(c.fov), aspect: r3(c.aspect), filmGauge: c.filmGauge });
    if (c.isOrthographicCamera) Object.assign(o, { left: c.left, right: c.right, top: c.top, bottom: c.bottom });
    try { c.updateWorldMatrix(true, false); const d = new c.position.constructor(); c.getWorldDirection(d); o.lookDirection = vec(d); o.worldPosition = vec(c.getWorldPosition(new c.position.constructor())); } catch (e) {}
    return o;
  };
  const light = (l) => {
    const o = { color: hex(l.color), intensity: r3(l.intensity) };
    for (const k of ['distance','angle','penumbra','decay','width','height']) if (l[k] !== undefined) o[k] = r3(l[k]);
    if (l.groundColor) o.groundColor = hex(l.groundColor);
    if (l.target && l.target.position) o.target = vec(l.target.position);
    if (l.shadow) o.shadow = { castShadow: !!l.castShadow, mapSize: l.shadow.mapSize ? [l.shadow.mapSize.x, l.shadow.mapSize.y] : null, bias: l.shadow.bias, radius: l.shadow.radius };
    return o;
  };

  const serializeScene = (scene) => {
    const objects = [];
    let n = 0;
    const walk = (obj, parentIdx) => {
      if (n >= opts.maxObjects) return;
      const idx = n++;
      const o = { idx, parent: parentIdx, type: obj.type, name: obj.name || null, visible: obj.visible, position: vec(obj.position), rotation: obj.rotation ? [r3(obj.rotation.x), r3(obj.rotation.y), r3(obj.rotation.z)] : null, scale: vec(obj.scale) };
      if (obj.isMesh || obj.isPoints || obj.isLine || obj.isSprite || obj.isInstancedMesh) {
        o.geometry = geo(obj.geometry);
        o.material = Array.isArray(obj.material) ? obj.material.map(mat) : mat(obj.material);
        if (obj.isInstancedMesh) o.instanceCount = obj.count;
        if (obj.castShadow || obj.receiveShadow) o.shadows = { cast: obj.castShadow, receive: obj.receiveShadow };
        if (obj.isSkinnedMesh) o.skinned = true;
      }
      if (obj.isLight) o.light = light(obj);
      if (obj.isCamera) o.camera = camInfo(obj);
      if (obj.animations && obj.animations.length) o.clips = obj.animations.map((c) => ({ name: c.name, duration: r3(c.duration), tracks: c.tracks.length }));
      objects.push(o);
      for (const c of obj.children) walk(c, idx);
    };
    walk(scene, null);
    const s = { uuid: scene.uuid, objectCount: objects.length, truncated: n >= opts.maxObjects, background: scene.background ? (scene.background.isColor ? hex(scene.background) : texInfo(scene.background)) : null, environment: scene.environment ? texInfo(scene.environment) : null, environmentIntensity: scene.environmentIntensity, fog: scene.fog ? { type: scene.fog.isFogExp2 ? 'FogExp2' : 'Fog', color: hex(scene.fog.color), near: scene.fog.near, far: scene.fog.far, density: scene.fog.density } : null, objects };
    return s;
  };

  for (const r of gl.renderers) {
    let size = null;
    try { const t = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } }; r.getSize(t); size = [t.x, t.y]; } catch (e) {}
    let clear = null;
    try { const g = r.getContext(); const v = g.getParameter(g.COLOR_CLEAR_VALUE); clear = { rgba: Array.from(v).map(r3), alphaApi: r.getClearAlpha() }; } catch (e) {}
    out.renderers.push({
      size,
      toneMapping: r.toneMapping, toneMappingExposure: r.toneMappingExposure, outputColorSpace: r.outputColorSpace,
      pixelRatio: r.getPixelRatio ? r.getPixelRatio() : null, shadowMap: r.shadowMap ? { enabled: r.shadowMap.enabled, type: r.shadowMap.type } : null,
      antialias: r.getContextAttributes ? r.getContextAttributes().antialias : null, alpha: r.getContextAttributes ? r.getContextAttributes().alpha : null,
      physicallyCorrectLights: r.physicallyCorrectLights, info: r.info ? { geometries: r.info.memory.geometries, textures: r.info.memory.textures, drawCalls: r.info.render.calls, triangles: r.info.render.triangles } : null,
      clear, domElement: window.__pcPath ? window.__pcPath(r.domElement) : null,
    });
  }

  const live = gl.last;
  if (live) { out.activeCamera = camInfo(live.camera); out.activeSceneUuid = live.scene && live.scene.uuid; }
  const scenes = [...new Set([...(live ? [live.scene] : []), ...gl.scenes])].filter(Boolean);
  out.scenes = scenes.slice(0, 3).map(serializeScene);

  out.raw = {
    contexts: gl.contexts,
    drawCallsObserved: gl.draws,
    programs: gl.programs.filter((p) => p.shaders.length).slice(0, 30).map((p) => ({ id: p.id, draws: p.draws, lastDraw: p.lastDraw, uniforms: p.uniforms, shaders: p.shaders.map((s) => ({ stage: s.stage, lines: s.source.split('\\n').length, source: opts.includeShaders ? s.source.slice(0, 30000) : undefined })) })),
    textureUploads: gl.textures.slice(0, 60),
    buffers: gl.buffers,
    shaders: opts.includeShaders ? gl.shaders.slice(0, 40).map((s) => ({ stage: s.stage, lines: s.source.split('\\n').length, source: s.source.slice(0, 20000) })) : gl.shaders.length,
    canvases: Array.from(document.querySelectorAll('canvas')).map((c) => { const r = c.getBoundingClientRect(); return { selector: window.__pcPath(c), rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }, width: c.width, height: c.height, position: getComputedStyle(c).position }; }),
  };
  return out;
}`;

/** Lightweight per-checkpoint sample: live camera, top-level object transforms, and animated-looking uniforms. */
const SCROLL_SAMPLE = `(() => {
  const gl = window.__pcGL; if (!gl) return {};
  const r3 = (n) => Math.round(n * 1000) / 1000, vec = (v) => (v ? [r3(v.x), r3(v.y), r3(v.z)] : null);
  const out = {};
  const live = gl.last;
  if (live && live.camera) { const c = live.camera; out.camera = { position: vec(c.position), rotation: c.rotation ? [r3(c.rotation.x), r3(c.rotation.y), r3(c.rotation.z)] : null, fov: c.fov !== undefined ? r3(c.fov) : null, zoom: c.zoom }; }
  if (live && live.scene) out.objects = live.scene.children.slice(0, 30).map((o) => ({ name: o.name || o.type, position: vec(o.position), rotation: o.rotation ? [r3(o.rotation.x), r3(o.rotation.y), r3(o.rotation.z)] : null, scale: vec(o.scale), visible: o.visible }));
  out.uniforms = gl.programs.filter((p) => p.shaders.length).slice(0, 20).map((p) => ({ id: p.id, uniforms: Object.fromEntries(Object.entries(p.uniforms).filter(([k]) => /time|scroll|progress|mouse|offset|scale|amount|strength|speed|intensity|rotation|opacity|mix|factor|u_/i.test(k)).slice(0, 24)) }));
  return out;
})()`;

export async function inspectWebglScene(input: WebglInput) {
  const { url, settleMs = 4000, maxObjects = 400, includeShaders = true, scrollCheckpoints = [], frameTrace = false, ...ready } = input;
  const dir = await ensureDir(path.join(outRoot(), "webgl", slugify(url)));
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser);
    await context.addInitScript(PATH_HELPER_INIT);
    await context.addInitScript(WEBGL_HOOK_INIT);
    const page = await context.newPage();
    const assets = collectAssets(page, path.join(dir, "assets"), { only: ["model", "hdr", "texture", "image"] });
    const gates = await gotoAndSettle(page, url, settleMs, ready);

    const scene = (await page.evaluate(`(${SERIALIZE})(${JSON.stringify({ maxObjects, includeShaders })})`)) as Record<string, any>;
    let traceFile: string | null = null;
    let traceSummary: unknown = null;
    if (frameTrace) {
      await page.evaluate("window.__pcTraceArm && window.__pcTraceArm()");
      const t0 = Date.now();
      let tr: { done: boolean; ops: Record<string, unknown>[] } = { done: false, ops: [] };
      while (Date.now() - t0 < 120_000) {
        await page.waitForTimeout(1500);
        tr = (await page.evaluate("window.__pcTrace && window.__pcTrace()")) as typeof tr;
        if (tr?.done) break;
      }
      traceFile = path.join(dir, "webgl-frame-trace.json");
      await fs.writeFile(traceFile, JSON.stringify(tr, null, 1));
      const draws = (tr.ops ?? []).filter((o) => o.op === "draw");
      const passes: Record<string, number> = {};
      for (const d of draws) passes[String(d.fb)] = (passes[String(d.fb)] ?? 0) + 1;
      traceSummary = { complete: !!tr.done, ops: tr.ops?.length ?? 0, draws: draws.length, drawsPerFramebuffer: passes };
    }
    // Scroll-driven scenes: re-sample camera + interesting uniforms at scroll checkpoints.
    const samples: unknown[] = [];
    if (scrollCheckpoints.length && scene.engine) {
      const maxScroll = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
      let wheelTotal = 0;
      await page.mouse.move(720, 450);
      for (const f of scrollCheckpoints) {
        if (maxScroll > 50) await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }), Math.round(maxScroll * f));
        else { const target = Math.round(f * 3000); if (target !== wheelTotal) await page.mouse.wheel(0, target - wheelTotal); wheelTotal = target; }
        await page.waitForTimeout(1500);
        samples.push({ fraction: f, scrollY: await page.evaluate(() => Math.round(window.scrollY)), ...((await page.evaluate(SCROLL_SAMPLE)) as object) });
      }
      scene.scrollSamples = samples;
    }
    const saved = await assets.done();
    const webglAssets = saved.filter((a) => a.kind !== "image" || /texture|env|normal|rough|metal|matcap|hdri|map/i.test(a.url));
    const hasScene = !!scene.engine;
    if (hasScene) await page.screenshot({ path: path.join(dir, "webgl-reference.png"), animations: "disabled" }).catch(() => undefined);

    const result = {
      url,
      readiness: gates,
      frameTraceFile: traceFile,
      frameTrace: traceSummary,
      webgl: hasScene,
      ...scene,
      assets: webglAssets.map((a) => ({ kind: a.kind, url: a.url, bytes: a.bytes, localPath: a.localPath })),
      modelFiles: saved.filter((a) => a.kind === "model").map((a) => a.localPath),
      guidance: hasScene
        ? "Map renderer/camera/lights/material values 1:1 into React Three Fiber props. Re-use downloaded models via useGLTF. Port ShaderMaterial shaders verbatim."
        : "No WebGL context detected. Treat the page as pure DOM/CSS.",
    };
    const jsonPath = path.join(dir, "webgl-scene.json");
    await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
    return { sceneJson: jsonPath, ...result };
  } finally {
    await browser.close();
  }
}
