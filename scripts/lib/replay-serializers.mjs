/**
 * Shared in-page serializers for dump-and-replay (used by scripts/three-scene-dump.mjs, scripts/dom-layer-dump.mjs and
 * compare_visual_diff's dumpReplayTo option, so replay state is captured in the very session that is compared).
 */
import fs from "node:fs";
import path from "node:path";

export const SCENE_SERIALIZE = `(async (opts) => {
  const gl = window.__pcGL; const r = gl && gl.renderers[0];
  if (!r) return { y: Math.round(scrollY), framesRecorded: 0, passes: [], scenes: {}, cameras: {}, renderer: {}, note: 'no three.js renderer observed', S: { textures: {}, materials: {}, geometries: {}, programs: {}, renderTargets: {} } };
  // Record until enough COMPLETE frames exist (software GL can take seconds per frame), then segment frames on the
  // site's own frame-opening op (the first op of the recording = how each frame starts), not on our rAF ticks.
  let log = [];
  const t0 = performance.now();
  while (performance.now() - t0 < opts.maxRecordMs) {
    log = log.concat(await window.__pcRecordRenders(opts.recordMs));
    const opener = log.find((e) => e.op === 'clear' && !e.target);
    const starts = opener ? log.filter((e) => e.op === 'clear' && !e.target && JSON.stringify(e.args) === JSON.stringify(opener.args)).length : 0;
    if (starts >= 4) break;
  }
  const opener = log.find((e) => e.op === 'clear' && !e.target);
  const isStart = (e) => opener && e.op === 'clear' && !e.target && JSON.stringify(e.args) === JSON.stringify(opener.args);
  const segs = []; let cur = null;
  for (const e of log) { if (isStart(e)) { if (cur) segs.push(cur); cur = [e]; } else if (cur) cur.push(e); }
  // the last segment may be cut off by the end of the recording: drop it
  const list = segs.filter((f) => f.some((e) => e.op === 'render'));
  const sig = (f) => f.map((e) => e.op + (e.scene || '') + (e.target ? e.target.uuid : 'screen')).join(',');
  const count = {}; for (const f of list) count[sig(f)] = (count[sig(f)] || 0) + 1;
  const best = list.slice().sort((a, b) => (count[sig(b)] - count[sig(a)]) || (b.length - a.length))[0] || [];
  const S = { textures: {}, materials: {}, geometries: {}, programs: {}, renderTargets: {} };
  const B64 = (ta) => { const u8 = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength); let s = ''; const C = 0x8000; for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C)); return btoa(s); };
  const arr = (a) => Array.from(a);
  const texId = (t) => {
    if (!t) return null;
    if (!S.textures[t.uuid]) {
      const img = t.image || {};
      const d = { uuid: t.uuid, name: t.name || '', kind: 'image', w: img.width || img.videoWidth || null, h: img.height || img.videoHeight || null,
        flipY: t.flipY, wrapS: t.wrapS, wrapT: t.wrapT, magFilter: t.magFilter, minFilter: t.minFilter, generateMipmaps: t.generateMipmaps,
        colorSpace: t.colorSpace, premultiplyAlpha: t.premultiplyAlpha, anisotropy: t.anisotropy, repeat: t.repeat ? [t.repeat.x, t.repeat.y] : null,
        offset: t.offset ? [t.offset.x, t.offset.y] : null, rotation: t.rotation, matrixAutoUpdate: t.matrixAutoUpdate, userData: JSON.parse(JSON.stringify(t.userData || {})) };
      if (t.isRenderTargetTexture || Object.values(gl.rtByTex || {}).includes(t)) d.kind = 'rt';
      else if (t.isCompressedTexture) { d.kind = 'compressed'; d.mipmaps = (t.mipmaps || []).length; d.format = t.format; }
      else if (t.isVideoTexture || img.tagName === 'VIDEO') { d.kind = 'video'; d.src = img.currentSrc || img.src; d.time = img.currentTime; d.paused = img.paused && !(window.__pcPausedMedia && window.__pcPausedMedia.has(img)); d.loop = img.loop; d.playbackRate = img.playbackRate; }
      else if (t.isDataTexture || t.isDataArrayTexture || (img.data && !img.tagName)) { d.kind = 'data'; d.type = t.type; d.format = t.format; if (img.data && img.data.byteLength <= 4e6) d.data = B64(img.data), d.dataType = img.data.constructor.name; }
      else if (img.tagName === 'CANVAS' || (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas)) { d.kind = 'canvas'; try { d.dataUrl = img.toDataURL ? img.toDataURL('image/png') : null; } catch (e) {} }
      else if (img.tagName === 'IMG' || typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) { d.src = img.currentSrc || img.src || null; }
      S.textures[t.uuid] = d;
    }
    return t.uuid;
  };
  const val = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    if (v.isTexture) return { $tex: texId(v) };
    if (v.isColor) return { $color: [v.r, v.g, v.b] };
    if (v.isVector2 || v.isVector3 || v.isVector4 || v.isQuaternion) return { $vec: v.toArray() };
    if (v.isMatrix3 || v.isMatrix4) return { $mat: arr(v.elements) };
    if (Array.isArray(v)) return v.map(val);
    if (ArrayBuffer.isView(v)) return { $typed: v.constructor.name, data: arr(v).slice(0, 4096) };
    if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = val(v[k]); return o; }
    return null;
  };
  const geo = (g) => {
    if (!g) return null;
    if (!S.geometries[g.uuid]) {
      const d = { uuid: g.uuid, name: g.name || '', type: g.type, attributes: {}, index: null, groups: g.groups, drawRange: g.drawRange, morph: Object.keys(g.morphAttributes || {}) };
      for (const [k, a] of Object.entries(g.attributes)) {
        let data = a.array;
        if (a.isInterleavedBufferAttribute) { const out = new Float32Array(a.count * a.itemSize); for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent ? a.getComponent(i, c) : [a.getX(i), a.getY(i), a.getZ(i), a.getW(i)][c]; data = out; }
        d.attributes[k] = { itemSize: a.itemSize, normalized: a.normalized, type: data.constructor.name, count: a.count, b64: B64(data), divisor: a.meshPerAttribute || 0 };
      }
      if (g.index) d.index = { type: g.index.array.constructor.name, count: g.index.count, b64: B64(g.index.array) };
      S.geometries[g.uuid] = d;
    }
    return g.uuid;
  };
  const prog = (m) => {
    try { const p = r.properties.get(m).currentProgram; const raw = p && p.program; const info = raw && gl.progInfoOf(raw);
      if (!info) return null;
      if (!S.programs[info.id]) S.programs[info.id] = { id: info.id, vertex: (info.shaders.find((s) => s.stage === 'vertex') || {}).source, fragment: (info.shaders.find((s) => s.stage === 'fragment') || {}).source };
      return info.id; } catch (e) { return null; }
  };
  const FLAGS = ['transparent','opacity','blending','blendSrc','blendDst','blendEquation','blendSrcAlpha','blendDstAlpha','blendEquationAlpha','premultipliedAlpha','depthTest','depthWrite','depthFunc','side','colorWrite','stencilWrite','stencilWriteMask','stencilFunc','stencilRef','stencilFuncMask','stencilFail','stencilZFail','stencilZPass','alphaTest','toneMapped','visible','vertexColors','wireframe','polygonOffset','polygonOffsetFactor','polygonOffsetUnits','alphaToCoverage','fog','dithering','forceSinglePass'];
  const mat = (m) => {
    if (!m) return null;
    const state = { uuid: m.uuid, flags: {}, uniforms: null, color: m.color && m.color.isColor ? [m.color.r, m.color.g, m.color.b] : null, map: m.map ? texId(m.map) : null, alphaMap: m.alphaMap ? texId(m.alphaMap) : null };
    for (const f of FLAGS) if (m[f] !== undefined) state.flags[f] = m[f];
    if (m.uniforms) { state.uniforms = {}; for (const [k, u] of Object.entries(m.uniforms)) state.uniforms[k] = val(u && 'value' in u ? u.value : u); }
    if (!S.materials[m.uuid]) S.materials[m.uuid] = { uuid: m.uuid, type: m.type, name: m.name || '', isShaderMaterial: !!m.isShaderMaterial, isRaw: !!m.isRawShaderMaterial, program: prog(m), vertexShader: m.isShaderMaterial ? m.vertexShader : null, fragmentShader: m.isShaderMaterial ? m.fragmentShader : null, extensions: m.extensions || null, defines: m.defines || null, glslVersion: m.glslVersion || null, hasOnBeforeCompile: m.onBeforeCompile && !/^\\s*\\(?\\)?\\s*=>\\s*\\{\\s*\\}|onBeforeCompile\\s*\\(\\s*\\)\\s*\\{\\s*\\}/.test(m.onBeforeCompile.toString()) };
    else if (S.materials[m.uuid].program == null) S.materials[m.uuid].program = prog(m);
    return state;
  };
  const scenes = {}, cameras = {};
  const objOf = (o) => {
    const d = { uuid: o.uuid, name: o.name || '', type: o.type, parent: o.parent ? o.parent.uuid : null, visible: o.visible, renderOrder: o.renderOrder, frustumCulled: o.frustumCulled,
      matrix: arr(o.matrix.elements), matrixWorld: arr(o.matrixWorld.elements), layers: o.layers ? o.layers.mask : 1 };
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
      d.geometry = geo(o.geometry);
      d.material = Array.isArray(o.material) ? o.material.map(mat) : mat(o.material);
      if (o.isInstancedMesh) { d.instanceCount = o.count; d.instanceMatrix = B64(o.instanceMatrix.array); }
      if (o.isSkinnedMesh) d.skinned = true;
      if (o.morphTargetInfluences) d.morph = arr(o.morphTargetInfluences);
    }
    return d;
  };
  const camOf = (c) => ({ uuid: c.uuid, type: c.type, matrixWorld: arr(c.matrixWorld.elements), projectionMatrix: arr(c.projectionMatrix.elements), fov: c.fov, aspect: c.aspect, near: c.near, far: c.far, zoom: c.zoom, left: c.left, right: c.right, top: c.top, bottom: c.bottom, view: c.view || null, layers: c.layers ? c.layers.mask : 1 });
  for (const e of best) {
    if (e.target && !S.renderTargets[e.target.uuid]) {
      const rt = (gl.rtById || {})[e.target.uuid];
      S.renderTargets[e.target.uuid] = { uuid: e.target.uuid, w: e.target.w, h: e.target.h, texture: e.target.texture || null, depth: e.target.depth, stencil: e.target.stencil, samples: e.target.samples };
    }
    if (e.op !== 'render') continue;
    if (!scenes[e.scene]) {
      const sc = gl.sceneById[e.scene]; const objects = [];
      sc.traverse((o) => objects.push(objOf(o)));
      scenes[e.scene] = { uuid: sc.uuid, background: val(sc.background), environment: val(sc.environment), fog: sc.fog ? { type: sc.fog.type || (sc.fog.isFogExp2 ? 'FogExp2' : 'Fog'), color: val(sc.fog.color), near: sc.fog.near, far: sc.fog.far, density: sc.fog.density } : null, overrideMaterial: sc.overrideMaterial ? mat(sc.overrideMaterial) : null, objects };
    }
    if (!cameras[e.cameraUuid]) cameras[e.cameraUuid] = camOf(gl.cameraById[e.cameraUuid]);
  }
  for (const t of Object.values(S.textures)) if (t.kind === 'image' && !t.src) { /* glTF-embedded or ImageBitmap without URL: resolved later by name */ }
  const rendererState = { toneMapping: r.toneMapping, toneMappingExposure: r.toneMappingExposure, outputColorSpace: r.outputColorSpace, pixelRatio: r.getPixelRatio(), sortObjects: r.sortObjects, autoClear: r.autoClear, autoClearColor: r.autoClearColor, autoClearDepth: r.autoClearDepth, autoClearStencil: r.autoClearStencil, localClippingEnabled: r.localClippingEnabled, size: (() => { const t = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } }; r.getSize(t); return [t.x, t.y]; })() };
  return { y: Math.round(scrollY), viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, framesRecorded: list.length, passes: best, scenes, cameras, renderer: rendererState, S };
})`;

/**
 * In-page DOM layer snapshot (serialized with Function#toString, so it must stay self-contained).
 * Every VISIBLE painting element becomes a box in viewport coordinates:
 *  - key: stable structural path (child indices from <body>), used to match boxes across keyframes, states and viewports;
 *  - rect: transformed bounding box; xf: the untransformed box + the cumulative 2D affine (rotate/skew/scale of the element
 *    and every ancestor), so angled typography and HUD lines are re-drawn exactly instead of as their bounding box;
 *  - clip: the inherited overflow/contain clip (null when only the viewport clips) + clipKey of the clipping ancestor;
 *  - pin: inside a position:fixed ancestor (does not move with the document);
 *  - effective opacity, blend, paint + typography + transition styles, own text or per-line text fragments,
 *    img/video sources, self-contained inline SVG (computed presentation styles inlined, external <use>/url(#) refs copied),
 *    and ::before/::after pseudo-elements that paint (decorative lines, frames, icons) as boxes of their own.
 */
function domSnapshot(exclude) {
  const vw = innerWidth, vh = innerHeight;
  const P = ['color','fontFamily','fontSize','fontWeight','fontStyle','fontStretch','lineHeight','letterSpacing','wordSpacing','textAlign','textTransform','textDecorationLine','textDecorationColor','textDecorationStyle','textDecorationThickness','textUnderlineOffset','textIndent','whiteSpace','wordBreak','overflowWrap','fontFeatureSettings','fontVariationSettings','webkitTextStrokeWidth','webkitTextStrokeColor','webkitTextFillColor','textShadow','writingMode','textOrientation','backgroundColor','backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat','backgroundClip','backgroundOrigin','backgroundBlendMode','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius','borderImageSource','borderImageSlice','borderImageWidth','borderImageOutset','borderImageRepeat','outlineWidth','outlineStyle','outlineColor','outlineOffset','boxShadow','filter','backdropFilter','mixBlendMode','isolation','objectFit','objectPosition','paddingTop','paddingRight','paddingBottom','paddingLeft','display','flexDirection','flexWrap','justifyContent','alignItems','gap','verticalAlign','clipPath','maskImage','maskSize','maskPosition','maskRepeat','webkitMaskImage','webkitMaskSize','webkitMaskPosition','webkitMaskRepeat','transform','transformOrigin','boxSizing','textOverflow','overflowX','overflowY','transitionProperty','transitionDuration','transitionTimingFunction','transitionDelay','position'];
  const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return 0; const p = m[1].split(',').map(Number); return p.length > 3 ? p[3] : 1; };
  const inter = (a, b) => { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), r = Math.min(a.x + a.w, b.x + b.w), bt = Math.min(a.y + a.h, b.y + b.h); return { x, y, w: Math.max(0, r - x), h: Math.max(0, bt - y) }; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const R = (r) => ({ x: r2(r.left), y: r2(r.top), w: r2(r.width), h: r2(r.height) });
  const VIEW = { x: 0, y: 0, w: vw, h: vh };
  const boxes = [];
  let order = 0;
  const sectionOf = (el) => { const s = el.closest('section, header, footer, nav, [class*=section], [class*=Section]'); if (s) return (s.className && typeof s.className === 'string' ? s.className.split(' ')[0] : s.tagName.toLowerCase()) || s.tagName.toLowerCase(); let top = el; while (top.parentElement && top.parentElement !== document.body) top = top.parentElement; return top.id || (typeof top.className === 'string' ? top.className.split(' ')[0] : '') || 'body'; };

  // ---- transforms: own 2D matrix (individual translate/rotate/scale properties + transform), origin in px ----
  const ownMatrix = (cs) => {
    let m = new DOMMatrix();
    let is2D = true;
    if (cs.translate && cs.translate !== 'none') { const p = cs.translate.split(/\s+/).map(parseFloat); m = m.translate(p[0] || 0, p[1] || 0); if (p[2]) is2D = false; }
    if (cs.rotate && cs.rotate !== 'none') { const p = cs.rotate.trim().split(/\s+/); if (p.length === 1 || p[0] === 'z') { const a = p[p.length - 1]; const deg = /rad$/.test(a) ? parseFloat(a) * 180 / Math.PI : /turn$/.test(a) ? parseFloat(a) * 360 : /grad$/.test(a) ? parseFloat(a) * 0.9 : parseFloat(a); m = m.rotate(deg); } else is2D = false; }
    if (cs.scale && cs.scale !== 'none') { const p = cs.scale.split(/\s+/).map(parseFloat); m = m.scale(p[0], p.length > 1 ? p[1] : p[0]); }
    if (cs.transform && cs.transform !== 'none') { try { const t = new DOMMatrix(cs.transform); if (!t.is2D) is2D = false; m = m.multiply(t); } catch (e) {} }
    return { m, is2D };
  };
  const nonTrivial = (m) => Math.abs(m.a - 1) > 1e-4 || Math.abs(m.b) > 1e-4 || Math.abs(m.c) > 1e-4 || Math.abs(m.d - 1) > 1e-4;
  const xfInfo = new Map(); // el -> { m, is2D, cs }
  const xfEls = []; // elements with a non-translation transform (in document order)

  // ---- pseudo-elements ----
  const pseudoText = (c) => { const m = /^"((?:[^"\\]|\\.)*)"$/.exec(c || ''); return m ? m[1].replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1') : null; };
  const pseudoPending = [];
  const positionedAncestor = (el, pos) => {
    if (pos === 'fixed') return null;
    let a = el;
    while (a && a !== document.documentElement) { const s = getComputedStyle(a); if (s.position !== 'static' || s.transform !== 'none' || s.contain.includes('paint') || s.contain.includes('layout')) return a; a = a.parentElement; }
    return null;
  };
  const paddingBox = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const bl = parseFloat(s.borderLeftWidth) || 0, bt = parseFloat(s.borderTopWidth) || 0, br = parseFloat(s.borderRightWidth) || 0, bb = parseFloat(s.borderBottomWidth) || 0; return { x: r.left + bl, y: r.top + bt, w: r.width - bl - br, h: r.height - bt - bb }; };
  const pseudoRect = (host, pcs) => {
    const w = parseFloat(pcs.width), h = parseFloat(pcs.height);
    if (!(w > 0) || !(h > 0)) return null;
    if (pcs.position === 'absolute' || pcs.position === 'fixed') {
      const cb = pcs.position === 'fixed' ? VIEW : (() => { const a = positionedAncestor(host, pcs.position); if (!a) return { x: -scrollX, y: -scrollY, w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }; return paddingBox(a); })();
      const L = parseFloat(pcs.left), T = parseFloat(pcs.top), Rr = parseFloat(pcs.right), B = parseFloat(pcs.bottom);
      const x = isFinite(L) ? cb.x + L : isFinite(Rr) ? cb.x + cb.w - Rr - w : cb.x;
      const y = isFinite(T) ? cb.y + T : isFinite(B) ? cb.y + cb.h - B - h : cb.y;
      return { x, y, w, h };
    }
    // In-flow pseudo: ::before starts the host's content box, ::after ends it (exact for block/flex rows, close otherwise).
    const hr = host.getBoundingClientRect(); const hs = getComputedStyle(host);
    const cx = hr.left + (parseFloat(hs.borderLeftWidth) || 0) + (parseFloat(hs.paddingLeft) || 0);
    const cy = hr.top + (parseFloat(hs.borderTopWidth) || 0) + (parseFloat(hs.paddingTop) || 0);
    const cr = hr.right - (parseFloat(hs.borderRightWidth) || 0) - (parseFloat(hs.paddingRight) || 0);
    const cb2 = hr.bottom - (parseFloat(hs.borderBottomWidth) || 0) - (parseFloat(hs.paddingBottom) || 0);
    return pcs.__pe === '::before' ? { x: cx, y: cy, w, h } : { x: hs.display.includes('flex') && hs.flexDirection.startsWith('row') ? cr - w : cx, y: hs.display.includes('flex') && hs.flexDirection.startsWith('row') ? cy : cb2 - h, w, h };
  };

  // ---- self-contained inline SVG ----
  const SVG_PROPS = ['fill','fillOpacity','fillRule','stroke','strokeWidth','strokeOpacity','strokeDasharray','strokeDashoffset','strokeLinecap','strokeLinejoin','strokeMiterlimit','opacity','visibility','display','stopColor','stopOpacity','clipPath','mask','mixBlendMode','paintOrder','vectorEffect','fontFamily','fontSize','fontWeight','letterSpacing','textAnchor','dominantBaseline','color'];
  const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  const svgMarkup = (el) => {
    try {
      const clone = el.cloneNode(true);
      const src = [el, ...el.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
      for (let i = 0; i < src.length && i < 3000; i++) {
        const cs = getComputedStyle(src[i]);
        let st = '';
        for (const p of SVG_PROPS) { const v = cs[p]; if (v !== undefined && v !== '' && v !== 'normal' && v !== 'auto') st += kebab(p) + ':' + v + ';'; }
        if (i > 0 && cs.transform && cs.transform !== 'none') st += 'transform:' + cs.transform + ';transform-origin:' + cs.transformOrigin + ';transform-box:' + cs.transformBox + ';';
        dst[i].setAttribute('style', st + (dst[i].getAttribute('style') || ''));
      }
      clone.removeAttribute('class');
      clone.setAttribute('width', '100%'); clone.setAttribute('height', '100%');
      clone.style.display = 'block';
      // External references (sprite <use href="#icon">, url(#gradient) defined in another <svg>) are copied in.
      const ids = new Set();
      for (const u of clone.querySelectorAll('use')) { const h = u.getAttribute('href') || u.getAttribute('xlink:href') || ''; if (h.startsWith('#')) ids.add(h.slice(1)); }
      for (const m of clone.outerHTML.matchAll(/url\(\s*["']?#([^"')\s]+)/g)) ids.add(m[1]);
      const defs = [];
      for (const id of ids) { if (clone.querySelector('#' + CSS.escape(id))) continue; const d = document.getElementById(id); if (d) defs.push(d.outerHTML); }
      let html = clone.outerHTML;
      if (defs.length) html = html.replace(/^(<svg[^>]*>)/, '$1<defs>' + defs.join('') + '</defs>');
      return html.length > 200000 ? null : html;
    } catch (e) { return el.outerHTML.slice(0, 60000); }
  };

  const walk = (el, key, clip, clipKey, opacity, z, blend, pin) => {
    if (exclude.some((s) => el.matches(s))) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const op = opacity * parseFloat(cs.opacity);
    if (op < 0.004) return;
    const pinned = pin || cs.position === 'fixed';
    const own = ownMatrix(cs);
    if (nonTrivial(own.m) || !own.is2D) { xfInfo.set(el, { m: own.m, is2D: own.is2D, cs }); xfEls.push(el); }
    const r = el.getBoundingClientRect();
    const rect = R(r);
    const zi = cs.zIndex !== 'auto' && cs.position !== 'static' ? parseInt(cs.zIndex, 10) : null;
    const zk = zi === null ? z : z.concat([zi]);
    const blendHere = cs.mixBlendMode !== 'normal' ? cs.mixBlendMode : blend;
    let ownClip = clip, ownClipKey = clipKey;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.contain.includes('paint') || cs.overflow === 'clip') { ownClip = inter(clip, rect); ownClipKey = key; }
    const visibleSelf = cs.visibility !== 'hidden';
    const tag = el.tagName.toLowerCase();
    const onScreen = rect.w > 0 && rect.h > 0 && rect.x < vw && rect.y < vh && rect.x + rect.w > 0 && rect.y + rect.h > 0 && clip.w > 0 && clip.h > 0;
    const clipOut = clip.x <= 0 && clip.y <= 0 && clip.w >= vw && clip.h >= vh ? null : { ...clip };
    const base = (k, rct, styles) => ({ key: k, order: order++, tag, section: sectionOf(el), z: zk, rect: rct, clip: clipOut, clipKey: clipOut ? clipKey : null, opacity: Math.round(op * 1000) / 1000, blend: blendHere, pin: pinned || undefined, styles });
    if (visibleSelf && onScreen) {
      const styles = {}; for (const p of P) styles[p] = cs[p];
      const box = base(key, rect, styles);
      box.__el = el;
      const bordered = ['Top','Right','Bottom','Left'].some((s) => parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none');
      let paints = alpha(cs.backgroundColor) > 0 || cs.backgroundImage !== 'none' || bordered || cs.boxShadow !== 'none' || cs.backdropFilter !== 'none' || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.borderImageSource !== 'none';
      if (tag === 'img') { box.src = el.currentSrc || el.src; paints = true; }
      else if (tag === 'video') {
        // Timeline state: the diff tool pauses playing media right before a capture (window.__pcPausedMedia), so
        // "paused" reports what the page itself was doing.
        const pausedByCapture = !!(window.__pcPausedMedia && window.__pcPausedMedia.has(el));
        box.src = el.currentSrc || el.src || (el.querySelector('source') || {}).src; box.poster = el.poster || null;
        box.time = Math.round(el.currentTime * 1000) / 1000; box.paused = el.paused && !pausedByCapture; box.loop = el.loop; box.muted = el.muted; box.playbackRate = el.playbackRate; box.duration = isFinite(el.duration) ? el.duration : null;
        paints = true;
      }
      else if (tag === 'svg') { box.svg = svgMarkup(el); paints = !!box.svg; }
      else if (tag === 'canvas') { try { box.src = el.toDataURL('image/png'); box.tag = 'img'; paints = true; } catch (e) {} }
      const textNodes = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim().length);
      if (textNodes.length) {
        const elementKids = Array.from(el.children).some((c) => getComputedStyle(c).display !== 'none' && c.textContent.trim().length);
        if (!elementKids) { box.text = textNodes.map((n) => n.textContent).join(''); paints = true; }
        else {
          box.fragments = []; box.__ranges = [];
          for (const n of textNodes) {
            const range = document.createRange(); range.selectNodeContents(n);
            const rects = Array.from(range.getClientRects()).filter((q) => q.width > 0);
            if (rects.length === 1) { box.fragments.push({ text: n.textContent, rect: R(rects[0]) }); box.__ranges.push([n, 0, n.textContent.length]); }
            else if (rects.length > 1) {
              const t = n.textContent; let start = 0;
              for (const q of rects) {
                let end = start;
                while (end < t.length) { const cr = document.createRange(); cr.setStart(n, end); cr.setEnd(n, end + 1); const b = cr.getBoundingClientRect(); if (b.width > 0 && (b.top > q.bottom - 1 || b.left > q.right + 1)) break; end++; }
                box.fragments.push({ text: t.slice(start, end), rect: R(q) }); box.__ranges.push([n, start, end]); start = end;
              }
            }
          }
          if (box.fragments.length) paints = true;
        }
      }
      if (paints) boxes.push(box);
      // ::before / ::after that paint (HUD lines, frames, bullets, icon glyphs).
      if (tag !== 'img' && tag !== 'video' && tag !== 'svg') for (const pe of ['::before', '::after']) {
        const pcs = getComputedStyle(el, pe);
        if (!pcs.content || pcs.content === 'none' || pcs.content === 'normal' || pcs.display === 'none' || pcs.visibility === 'hidden') continue;
        const pop = op * parseFloat(pcs.opacity);
        if (pop < 0.004) continue;
        const txt = pseudoText(pcs.content);
        const img = /^url\(/.test(pcs.content) ? (/url\("?([^")]+)"?\)/.exec(pcs.content) || [])[1] : null;
        const pBordered = ['Top','Right','Bottom','Left'].some((s) => parseFloat(pcs['border' + s + 'Width']) > 0 && pcs['border' + s + 'Style'] !== 'none');
        const pPaints = alpha(pcs.backgroundColor) > 0 || pcs.backgroundImage !== 'none' || pBordered || pcs.boxShadow !== 'none' || (txt && txt.trim()) || img || pcs.borderImageSource !== 'none';
        if (!pPaints) continue;
        const ps = {}; for (const p of P) ps[p] = pcs[p];
        const pm = ownMatrix(pcs);
        pseudoPending.push({ host: el, pe, box: Object.assign(base(key + pe, null, ps), { opacity: Math.round(pop * 1000) / 1000, text: txt && txt.trim() ? txt : undefined, src: img || undefined, pseudo: pe, __pm: nonTrivial(pm.m) ? pm.m : null }), pcs: Object.assign({}, { width: pcs.width, height: pcs.height, position: pcs.position, left: pcs.left, top: pcs.top, right: pcs.right, bottom: pcs.bottom, transformOrigin: pcs.transformOrigin, __pe: pe }) });
      }
      if (tag === 'svg' || tag === 'img' || tag === 'video' || tag === 'canvas') return;
    }
    let i = 0;
    for (const c of Array.from(el.children)) walk(c, key + '/' + (i++), ownClip, ownClipKey, op, zk, blendHere, pinned);
  };
  let bi = 0;
  for (const c of Array.from(document.body.children)) walk(c, 'b' + (bi++), VIEW, null, 1, [], 'normal', false);

  for (const p of pseudoPending) { const rc = pseudoRect(p.host, p.pcs); if (rc && rc.x < vw && rc.y < vh && rc.x + rc.w > 0 && rc.y + rc.h > 0) { p.box.rect = R({ left: rc.x, top: rc.y, width: rc.w, height: rc.h }); p.box.__el = p.host; p.box.__p = p; boxes.push(p.box); } }

  // ---- cumulative transforms: measure untransformed boxes once (all transforms suspended in one batch) ----
  const ancestorsXf = (el) => { const out = []; for (let a = el; a && a !== document.documentElement; a = a.parentElement) if (xfInfo.has(a)) out.push(a); return out; };
  const needs = boxes.filter((b) => b.__el && (ancestorsXf(b.__el).length || b.__pm));
  if (needs.length) {
    const all = new Set(); for (const b of needs) for (const a of ancestorsXf(b.__el)) all.add(a);
    const saved = new Map();
    const origins = new Map();
    for (const a of all) origins.set(a, getComputedStyle(a).transformOrigin.split(/\s+/).map(parseFloat));
    for (const a of all) { saved.set(a, a.getAttribute('style')); a.style.setProperty('transition', 'none', 'important'); a.style.setProperty('transform', 'none', 'important'); a.style.setProperty('rotate', 'none', 'important'); a.style.setProperty('scale', 'none', 'important'); a.style.setProperty('translate', 'none', 'important'); a.style.setProperty('will-change', 'transform', 'important'); }
    const flat = new Map();
    for (const a of all) { const r = a.getBoundingClientRect(); flat.set(a, { x: r.left, y: r.top, w: r.width, h: r.height }); }
    const flatBox = new Map();
    for (const b of needs) {
      if (b.__p) { const rc = pseudoRect(b.__p.host, b.__p.pcs); if (rc) flatBox.set(b, rc); }
      else { const r = b.__el.getBoundingClientRect(); flatBox.set(b, { x: r.left, y: r.top, w: r.width, h: r.height }); }
      // text fragments of transformed boxes: their untransformed line boxes
      if (b.__ranges && b.fragments) b.__flatFrags = b.__ranges.map(([n, s0, e0]) => { const rg = document.createRange(); rg.setStart(n, s0); rg.setEnd(n, e0); const q = rg.getBoundingClientRect(); return R(q); });
    }
    // restore: transform first (transitions still off), flush, then the original inline style
    for (const a of all) { const s = saved.get(a); a.setAttribute('style', (s ? s + ';' : '') + 'transition:none !important'); }
    void document.body.getBoundingClientRect();
    for (const a of all) { const s = saved.get(a); if (s === null) a.removeAttribute('style'); else a.setAttribute('style', s); }
    for (const b of needs) {
      const fb = flatBox.get(b); if (!fb) continue;
      // C = T_outermost o ... o T_self ; T_e(p) = O_e + M_e (p - O_e), O_e = flat top-left + transform-origin.
      let C = new DOMMatrix();
      const chain = ancestorsXf(b.__el); // innermost first
      let ok = true;
      if (b.__pm) { const o = b.__p.pcs.transformOrigin.split(/\s+/).map(parseFloat); const O = { x: fb.x + (o[0] || 0), y: fb.y + (o[1] || 0) }; C = new DOMMatrix().translate(O.x, O.y).multiply(b.__pm).translate(-O.x, -O.y); }
      for (const a of chain) { const inf = xfInfo.get(a); if (!inf.is2D) ok = false; const f = flat.get(a), o = origins.get(a); const O = { x: f.x + (o[0] || 0), y: f.y + (o[1] || 0) }; C = new DOMMatrix().translate(O.x, O.y).multiply(new DOMMatrix([inf.m.a, inf.m.b, inf.m.c, inf.m.d, inf.m.e, inf.m.f])).translate(-O.x, -O.y).multiply(C); }
      // Verify: the mapped corners must reproduce the real bounding box, else keep the AABB (3D, perspective, ...).
      const pts = [[fb.x, fb.y], [fb.x + fb.w, fb.y], [fb.x, fb.y + fb.h], [fb.x + fb.w, fb.y + fb.h]].map(([x, y]) => C.transformPoint(new DOMPoint(x, y)));
      const minX = Math.min(...pts.map((p) => p.x)), minY = Math.min(...pts.map((p) => p.y)), maxX = Math.max(...pts.map((p) => p.x)), maxY = Math.max(...pts.map((p) => p.y));
      // (pseudo-elements have no measurable box of their own: their rect becomes the mapped bounds)
      if (b.pseudo && ok) b.rect = R({ left: minX, top: minY, width: maxX - minX, height: maxY - minY });
      const err = Math.max(Math.abs(minX - b.rect.x), Math.abs(minY - b.rect.y), Math.abs(maxX - (b.rect.x + b.rect.w)), Math.abs(maxY - (b.rect.y + b.rect.h)));
      if (ok && err < 2 && nonTrivial(C)) b.xf = { x: r2(fb.x), y: r2(fb.y), w: r2(fb.w), h: r2(fb.h), m: [C.a, C.b, C.c, C.d, C.e, C.f].map((v) => Math.round(v * 1e5) / 1e5) };
      else if (!ok || err >= 2) b.xfApprox = true;
      // Text fragments of a transformed box are measured as their bounding boxes; re-express them in flat space.
      if (b.xf && b.fragments && b.__flatFrags) b.fragments.forEach((f, i) => { if (b.__flatFrags[i]) { f.rect = b.__flatFrags[i]; f.flat = true; } });
    }
  }
  // ---- stacking relative to the main canvas (excluded from the dump, replayed by the WebGL layer) ----
  // The browser's own paint order decides: elementsFromPoint lists elements top-most first. Everything is made
  // hit-testable for the measurement (decorations and canvases are often pointer-events: none).
  const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => ({ c, r: c.getBoundingClientRect(), cs: getComputedStyle(c) }))
    .filter((x) => x.r.width * x.r.height >= 40000 && x.cs.display !== 'none' && x.cs.visibility !== 'hidden' && parseFloat(x.cs.opacity) > 0)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  let canvasInfo = null;
  if (canvases.length) {
    const main = canvases[0];
    canvasInfo = { rect: R(main.r), id: main.c.id || null, className: typeof main.c.className === 'string' ? main.c.className : null };
    const st = document.createElement('style');
    st.textContent = '*,*::before,*::after{pointer-events:auto !important}';
    document.head.appendChild(st);
    const inCanvas = (x, y) => x >= main.r.left && x < main.r.right && y >= main.r.top && y < main.r.bottom;
    for (const b of boxes) {
      if (!b.__el) continue;
      const r = b.rect, c = b.clip || VIEW;
      const x0 = Math.max(r.x, c.x, 0), y0 = Math.max(r.y, c.y, 0), x1 = Math.min(r.x + r.w, c.x + c.w, vw), y1 = Math.min(r.y + r.h, c.y + c.h, vh);
      if (x1 <= x0 || y1 <= y0) continue;
      const pts = [[(x0 + x1) / 2, (y0 + y1) / 2], [x0 + 1, y0 + 1], [x1 - 1, y1 - 1], [x0 + 1, y1 - 1], [x1 - 1, y0 + 1]];
      for (const [x, y] of pts) {
        if (!inCanvas(x, y)) continue;
        const list = document.elementsFromPoint(x, y);
        const ci = list.indexOf(main.c);
        let ei = -1; for (let i = 0; i < list.length; i++) if (list[i] === b.__el || b.__el.contains(list[i])) { ei = i; break; }
        if (ci >= 0 && ei >= 0) { b.zLayer = ei < ci ? 'above' : 'behind'; break; }
      }
    }
    st.remove();
  }
  for (const b of boxes) { b.zLayer = b.zLayer || 'above'; delete b.__el; delete b.__p; delete b.__pm; delete b.__ranges; delete b.__flatFrags; }
  return { y: Math.round(scrollY), viewport: [vw, vh], dpr: devicePixelRatio, scrollHeight: document.documentElement.scrollHeight, canvas: canvasInfo, boxes, fontsLoaded: Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight + ' ' + f.style) };
}
export const DOM_SNAPSHOT = domSnapshot.toString();

/** Accumulates scene + DOM keyframes (named y-<y> or state-<name>) and writes the replay folder layout. */
export function createReplayWriter(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const statics = { textures: {}, materials: {}, geometries: {}, programs: {}, renderTargets: {} };
  const bins = []; let offset = 0; const names = { scene: [], dom: [], meta: {} };
  return {
    addScene(name, d) {
      for (const [k, g] of Object.entries(d.S.geometries)) {
        if (statics.geometries[k]) continue;
        for (const a of [...Object.values(g.attributes), ...(g.index ? [g.index] : [])]) {
          const buf = Buffer.from(a.b64, "base64"); delete a.b64; a.offset = offset; a.bytes = buf.length; bins.push(buf); offset += buf.length;
          const pad = (4 - (offset % 4)) % 4; if (pad) { bins.push(Buffer.alloc(pad)); offset += pad; }
        }
        statics.geometries[k] = g;
      }
      for (const key of ["textures", "materials", "programs", "renderTargets"]) Object.assign(statics[key], d.S[key], statics[key]);
      delete d.S;
      fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(d));
      names.scene.push(name);
    },
    addDom(name, d) { fs.writeFileSync(path.join(outDir, `dom-${name}.json`), JSON.stringify(d)); names.dom.push(name); },
    /** Free-form facts about the dump (viewport, whether the top-return state is genuinely distinct, ...). */
    meta(m) { Object.assign(names.meta, m); },
    has(name) { return names.dom.includes(name) || names.scene.includes(name); },
    remove(name) {
      for (const [list, f] of [[names.dom, `dom-${name}.json`], [names.scene, `${name}.json`]]) { const i = list.indexOf(name); if (i >= 0) { list.splice(i, 1); fs.rmSync(path.join(outDir, f), { force: true }); } }
    },
    rename(from, to) {
      this.remove(to);
      for (const [list, f, t] of [[names.dom, `dom-${from}.json`, `dom-${to}.json`], [names.scene, `${from}.json`, `${to}.json`]]) { const i = list.indexOf(from); if (i >= 0) { list[i] = to; fs.renameSync(path.join(outDir, f), path.join(outDir, t)); } }
    },
    finish() {
      if (names.scene.length) { fs.writeFileSync(path.join(outDir, "geometry.bin"), Buffer.concat(bins)); fs.writeFileSync(path.join(outDir, "static.json"), JSON.stringify(statics)); }
      fs.writeFileSync(path.join(outDir, "replay-index.json"), JSON.stringify(names, null, 1));
      return { scenes: names.scene.length, doms: names.dom.length, geometryBytes: offset };
    },
  };
}
