#!/usr/bin/env node
/**
 * End-to-end verification: spawns the built MCP server over stdio and exercises all four tools
 * against (1) local deterministic fixtures and (2) live URLs.
 *   node scripts/e2e.mjs            # fixtures + live
 *   E2E_LIVE=0 node scripts/e2e.mjs # fixtures only
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
// Scripts that load pages from the in-process fixture server must run async (execFileSync would block the server).
const execFileAsync = promisify(execFile);
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "scripts", "fixtures");
const outDir = path.join(root, ".clone-output", "e2e");
const live = process.env.E2E_LIVE !== "0";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/hang.png")) return; // never answered: the window load event never fires
  const file = path.join(fixtures, req.url === "/" ? "target.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(fixtures) || !fs.existsSync(file)) return res.writeHead(404).end("nf");
  const type = file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".webm") ? "video/webm" : "text/html";
  res.writeHead(200, { "content-type": type }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "mcp-server", "dist", "index.js")],
  env: { ...process.env, PIXEL_CLONE_OUT: outDir },
  stderr: "inherit",
});
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  console.log(`      ${name} took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return JSON.parse(text);
};

try {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check("server lists 6 tools", JSON.stringify(tools) === JSON.stringify(["capture_motion_timeline", "compare_visual_diff", "extract_dom_and_styles", "inspect_webgl_scene", "profile_site", "scan_page_sections"]), tools.join(","));

  // ---------- fixtures ----------
  console.log("\n== Fixtures ==");
  const ex = await call("extract_dom_and_styles", { url: `${base}/target.html` });
  check("extract: DOM nodes", ex.nodesTotal > 20, `${ex.nodesTotal} nodes`);
  check("extract: CSS variable --brand", ex.cssVariables?.["--brand"] === "#ff5a1f");
  check("extract: @keyframes slide-in", !!ex.keyframes?.["slide-in"]);
  check("extract: h1 computed font-size 72px", ex.nodes.some((n) => n.tag === "h1" && n.styles.fontSize === "72px"));
  check("extract: typography tokens resolved (Georgia 72px)", ex.tokens.typography.some((t) => t.fontSize === "72px" && /Georgia/.test(t.fontFamily)), JSON.stringify(ex.tokens.typography[0]));
  check("extract: brand color token", ex.tokens.backgroundColors.some((c) => c.value === "rgb(255, 90, 31)"));
  check("extract: svg asset downloaded", ex.assets.some((a) => a.kind === "svg" && fs.existsSync(a.localPath)));
  check("extract: wrote JSON + screenshot", fs.existsSync(ex.extractionJson) && fs.existsSync(ex.referenceScreenshot));

  const mo = await call("capture_motion_timeline", { url: `${base}/target.html`, scrollSteps: 4, hoverTargets: 6 });
  const slide = mo.animations.find((a) => a.name === "slide-in");
  check("motion: CSS animation slide-in found", !!slide);
  check("motion: exact cubic-bezier + 900ms", slide?.effectiveEasing === "cubic-bezier(0.16, 1, 0.3, 1)" && slide?.timing.duration === 900, `${slide?.effectiveEasing} ${slide?.timing.duration}ms`);
  check("motion: transform keyframes recorded", slide?.keyframes.some((k) => String(k.transform).includes("40px")));
  const s0 = slide?.samples?.[0]?.values, s1 = slide?.samples?.at(-1)?.values;
  check("motion: frozen-time samples differ across progress", !!s0 && !!s1 && s0.opacity !== s1.opacity, `${s0?.opacity} -> ${s1?.opacity}`);
  const btn = mo.hover.find((h) => /a:nth|btn/.test(h.selector) && h.changed.backgroundColor);
  check("motion: hover bg change captured", !!btn, btn ? `${btn.changed.backgroundColor.from} -> ${btn.changed.backgroundColor.to}` : "no hover change");
  check("motion: hover transition easing recorded", mo.hover.some((h) => h.animations.some((a) => a.type === "CSSTransition" && /cubic-bezier\(0\.4, 0, 0\.2, 1\)/.test(a.effectiveEasing))));
  check("motion: scroll reveal mutations logged", mo.mutationLogTotal > 0 && mo.mutationLog.some((m) => /in/.test(m.to ?? "")), `${mo.mutationLogTotal} mutations`);
  check("motion: deterministic virtual clock", mo.clock === "virtual", mo.clock);

  const gl = await call("inspect_webgl_scene", { url: `${base}/webgl.html` });
  const objs = gl.scenes?.[0]?.objects ?? [];
  check("webgl: scene detected (three.js)", gl.webgl === true && gl.engine === "three.js");
  check("webgl: camera fov 50 @ (2,1.5,5)", gl.activeCamera?.fov === 50 && gl.activeCamera.position?.join() === "2,1.5,5", JSON.stringify(gl.activeCamera?.position));
  check("webgl: BoxGeometry + material color", objs.some((o) => o.name === "hero-box" && o.geometry?.type === "BoxGeometry" && o.material?.color === "#ff5a1f"));
  check("webgl: ShaderMaterial uniforms + GLSL", objs.some((o) => o.name === "shader-sphere" && o.material?.uniforms?.uTint === "#4aa3ff" && /gl_FragColor/.test(o.material.fragmentShader)));
  check("webgl: raw shaders captured via gl hook", Array.isArray(gl.raw?.shaders) && gl.raw.shaders.some((s) => /uTint/.test(s.source)));
  check("webgl: lights + fog", objs.some((o) => o.light?.intensity === 2.5) && gl.scenes[0].fog?.type === "Fog");
  check("webgl: renderer toneMapping ACES(4)", gl.renderers?.[0]?.toneMapping === 4);

  const same = await call("compare_visual_diff", { targetUrl: `${base}/target.html`, localUrl: `${base}/target.html` });
  const sameSlices = same.viewports[0].states.filter((x) => x.kind === "slice");
  check("diff: full-page slices cover the whole height, identical pages pass at 100%", sameSlices.length >= 3 && sameSlices[0].y === 0 && Math.max(...sameSlices.map((x) => x.y)) === same.viewports[0].coverage.to && same.viewports[0].coverage.to === same.viewports[0].targetScrollHeight - 900 && same.overallSimilarity === 100 && same.pass, `${sameSlices.length} slices to y=${same.viewports[0].coverage.to}, overall ${same.overallSimilarity}%`);
  check("diff: overview filmstrip written", fs.existsSync(same.viewports[0].overview));
  const short = await call("compare_visual_diff", { targetUrl: `${base}/target.html`, localUrl: `${base}/short.html` });
  check("diff: a page missing a section fails the height gate", short.pass === false && short.viewports[0].height.pass === false, `height delta ${short.viewports[0].height.deltaPct}%`);
  const legacy = await call("compare_visual_diff", { targetUrl: `${base}/target.html`, localUrl: `${base}/target.html`, mode: "states" });
  check("diff: legacy 5-state mode can never pass", legacy.pass === false && legacy.viewports[0].states.length === 5);
  const inter = await call("compare_visual_diff", { targetUrl: `${base}/target.html`, localUrl: `${base}/target.html`, interactions: [{ name: "btn-hover", hover: ".btn" }] });
  check("diff: custom interaction state captured on both pages", inter.viewports[0].states.some((x) => x.state === "btn-hover" && x.similarity === 100));
  const inv = await call("scan_page_sections", { url: `${base}/target.html`, sliceWaitMs: 300 });
  check("inventory: full-height scan with section candidates + inventory.md", inv.slices >= 3 && inv.sections.length >= 2 && fs.existsSync(inv.inventoryMarkdown) && inv.sections.some((x) => x.headings.some((h) => /Measured/.test(h))), `${inv.slices} slices, ${inv.sections.length} sections`);
  const diff = await call("compare_visual_diff", { targetUrl: `${base}/target.html`, localUrl: `${base}/local.html` });
  const worst = diff.viewports[0].states.slice().sort((a, b) => a.similarity - b.similarity)[0];
  check("diff: changed card color detected (<99%, mask non-trivial)", diff.overallSimilarity < 99 && diff.overallSimilarity > 20, `overall ${diff.overallSimilarity}% worst ${worst.state} ${worst.similarity}%`);
  check("diff: pass=false under 99% threshold when below", diff.pass === (diff.viewports[0].states.every((s) => s.similarity >= 99)));
  check("diff: red diff PNG + hotspots written", fs.existsSync(worst.files.diff) && worst.hotspots.length > 0, worst.files.diff);
  check("diff: screenshots are 1440x900", (() => { const b = fs.readFileSync(worst.files.target); return b.readUInt32BE(16) === 1440 && b.readUInt32BE(20) === 900; })());

  const glSame = await call("compare_visual_diff", { targetUrl: `${base}/webgl.html`, localUrl: `${base}/webgl.html`, freezeTime: true });
  check("diff: animated WebGL page vs itself is 100% with freezeTime", glSame.pass && glSame.overallSimilarity === 100, `overall ${glSame.overallSimilarity}%`);
  const glFree = await call("compare_visual_diff", { targetUrl: `${base}/webgl.html`, localUrl: `${base}/webgl.html`, freezeTime: false });
  check("diff: same page WITHOUT freezeTime is nondeterministic (<100%)", glFree.overallSimilarity < 100, `overall ${glFree.overallSimilarity}%`);

  // ---------- universal: gates, profiler, blueprint, virtual scroll, scaffold ----------
  console.log("\n== Universal architecture ==");
  const gp = await call("profile_site", { url: `${base}/gate.html` });
  check("profile: load event never fires, page still ready", gp.gates.loadEvent === false && gp.gates.ready === true, JSON.stringify(gp.gates.actions.map((a) => a.kind)));
  check("profile: cookie banner dismissed", gp.gates.actions.some((a) => a.kind === "cookie" && /accept/i.test(a.text)));
  check("profile: enter gate clicked", gp.gates.actions.some((a) => a.kind === "gate" && /enter/i.test(a.text)));
  check("profile: archetype gated-entry, no WebGL, lean scaffold", gp.archetype.includes("gated-entry") && !gp.rendering.webgl1 && !gp.rendering.webgl2 && gp.recommendedScaffold.three === false);
  const gwebgl = await call("profile_site", { url: `${base}/webgl.html` });
  check("profile: three.js scene -> scaffold.three true", gwebgl.rendering.three.detected && gwebgl.recommendedScaffold.three === true && gwebgl.archetype.includes("webgl-experience"), gwebgl.archetype.join());
  const gx = await call("extract_dom_and_styles", { url: `${base}/gate.html` });
  check("gate: extraction sees the REAL page (h1 visible, UI not auto-clicked)", gx.nodes.some((n) => n.tag === "h1" && /Main Content Revealed/.test(n.text ?? "")) && !gx.nodes.some((n) => n.text === "Played!"));
  const bp = JSON.parse(fs.readFileSync(gx.designBlueprint, "utf8"));
  check("blueprint: schema + component tree", bp.schema.startsWith("pixel-clone/design-blueprint") && bp.components?.tag === "body" && bp.components.children.length > 0);
  check("blueprint: fixed layers + stacking contexts", bp.layers.fixedAndSticky.length >= 2 && bp.layers.stackingContexts.some((c) => c.reasons.includes("mix-blend-mode")));
  check("blueprint: clip-path, mix-blend-mode, backdrop-filter captured", bp.effects.some((e) => /polygon/.test(e.clipPath ?? "")) && bp.effects.some((e) => e.mixBlendMode === "difference") && bp.effects.some((e) => /blur/.test(e.backdropFilter ?? "")));
  const wm = await call("capture_motion_timeline", { url: `${base}/wheel.html`, scrollSteps: 3, hoverTargets: 0 });
  check("motion: virtual scroller detected (wheel model)", wm.scrollModel === "wheel" && wm.smoothScroll.model === "wheel");
  check("motion: eased scroll curve recovered (lerp ~0.1)", wm.smoothScroll.interpolated === true && /transform/.test(wm.smoothScroll.driver) && Math.abs(wm.smoothScroll.estimatedLerpPerFrame - 0.1) < 0.02, `driver=${wm.smoothScroll.driver} lerp=${wm.smoothScroll.estimatedLerpPerFrame} settled@${wm.smoothScroll.settledFrame}`);
  check("motion: per-frame transform deltas at checkpoints", wm.scrollSteps.some((s) => s.frames.some((f) => f.changed.some((c) => /matrix/.test(c.transform)))));
  const wd = await call("compare_visual_diff", { targetUrl: `${base}/wheel.html`, localUrl: `${base}/wheel.html`, freezeTime: true, virtualScrollHeight: 3000, sliceStep: 600, maxSlices: 6 });
  const md5 = (f) => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");
  const wst = wd.viewports[0].states;
  check("diff: virtual scroller sliced via wheel over virtualScrollHeight (distinct slices)", wd.viewports[0].scrollModel === "wheel" && wst.filter((x) => x.kind === "slice").length >= 4 && md5(wst[0].files.target) !== md5(wst[1].files.target) && md5(wst[1].files.target) !== md5(wst[2].files.target));
  const wnov = await call("compare_visual_diff", { targetUrl: `${base}/wheel.html`, localUrl: `${base}/wheel.html`, freezeTime: true });
  check("diff: wheel page without virtualScrollHeight warns and cannot pass", !!wnov.viewports[0].coverage.warning && wnov.pass === false);
  check("diff: virtual-scroll page vs itself is 100% with freezeTime", wd.pass && wd.overallSimilarity === 100, `overall ${wd.overallSimilarity}%`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-scaffold-"));
  const j = (a) => JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts", "scaffold.mjs"), ...a], { encoding: "utf8" }));
  const lean = j([path.join(tmp, "lean"), "--profile", gp.profileJson]);
  check("scaffold: 2D profile excludes three/R3F", !lean.dependencies.some((d) => /three/.test(d)) && !fs.existsSync(path.join(tmp, "lean/src/components/CloneCanvas.tsx")));
  const full = j([path.join(tmp, "full"), "--profile", gwebgl.profileJson]);
  check("scaffold: WebGL profile includes three + R3F", ["three", "@react-three/fiber", "@react-three/drei"].every((d) => full.dependencies.includes(d)) && fs.existsSync(path.join(tmp, "full/src/components/CloneCanvas.tsx")));
  fs.rmSync(tmp, { recursive: true, force: true });

  const ft = await call("inspect_webgl_scene", { url: `${base}/webgl.html`, frameTrace: true, settleMs: 2000 });
  const ftrace = JSON.parse(fs.readFileSync(ft.frameTraceFile, "utf8"));
  check("webgl: frame trace records the GL pass (clear + draws with per-draw uniforms)", ft.frameTrace.complete && ft.frameTrace.draws >= 2 && ftrace.ops.some((o) => o.op === "draw" && o.uniforms && "roughness" in o.uniforms), JSON.stringify(ft.frameTrace));
  const ru = { targetUrl: `${base}/target.html`, localUrl: `${base}/local.html`, reuseTarget: true };
  const ru1 = await call("compare_visual_diff", ru);
  const ru2 = await call("compare_visual_diff", ru);
  check("diff: reuseTarget re-uses cached target captures and gives the same result", ru1.overallSimilarity === ru2.overallSimilarity && ru2.viewports[0].states.every((s, i) => s.similarity === ru1.viewports[0].states[i].similarity), `${ru1.overallSimilarity}% / ${ru2.overallSimilarity}%`);
  const ru3 = await call("compare_visual_diff", { ...ru, stateFrames: 2, settleFrames: 2, freezeTime: true });
  check("diff: settleFrames/stateFrames accepted", typeof ru3.overallSimilarity === "number");

  const rdDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-rdump-"));
  const rd = await call("compare_visual_diff", { targetUrl: `${base}/target.html`, localUrl: `${base}/target.html`, dumpReplayTo: rdDir, autoMenu: false });
  const rdIndex = JSON.parse(fs.readFileSync(path.join(rdDir, "replay-index.json"), "utf8"));
  check("diff: dumpReplayTo captures DOM replay state per slice in the compared session; an unchanged top is NOT dumped as top-return", rd.pass && rdIndex.dom.includes("y-0") && !rdIndex.dom.includes("state-top-return") && rdIndex.meta?.topReturn?.distinct === false && rdIndex.dom.length === rd.viewports[0].states.length, `${rdIndex.dom.length} DOM keyframes, top-return ${JSON.stringify(rdIndex.meta?.topReturn)}`);
  fs.rmSync(rdDir, { recursive: true, force: true });
  const irDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-intro-"));
  await call("compare_visual_diff", { targetUrl: `${base}/intro.html`, localUrl: `${base}/intro.html`, dumpReplayTo: irDir, autoMenu: false });
  const irIndex = JSON.parse(fs.readFileSync(path.join(irDir, "replay-index.json"), "utf8"));
  check("diff: a genuinely different post-scroll top IS dumped as top-return (hero y-0 kept separately)", irIndex.meta?.topReturn?.distinct === true && irIndex.dom.includes("state-top-return") && irIndex.dom.includes("y-0") && /Welcome<|"Welcome"/.test(fs.readFileSync(path.join(irDir, "dom-y-0.json"), "utf8")) && /Welcome back/.test(fs.readFileSync(path.join(irDir, "dom-state-top-return.json"), "utf8")), JSON.stringify(irIndex.meta?.topReturn));
  fs.rmSync(irDir, { recursive: true, force: true });

  // ---------- responsive: multi-viewport extraction, dumps, staging ----------
  console.log("\n== Responsive ==");
  const rx = await call("extract_dom_and_styles", { url: `${base}/responsive.html`, mobile: true });
  const rr = rx.responsive;
  check("extract: measured at 1440x900 AND 1920x1080", rr?.viewports?.length === 2 && rr.viewports[1].width === 1920 && fs.existsSync(rx.referenceScreenshotsByViewport?.["1920x1080"] ?? ""), JSON.stringify(rr?.viewports));
  check("extract: right-anchored fixed HUD detected (right: 21px), its resolved left flagged as a hard-code trap", rr.rightAnchored.some((x) => /hud/.test(x.selector) && x.right === 21) && rr.hardcodeTraps.some((x) => /hud/.test(x.selector)), JSON.stringify(rr.hardcodeTraps));
  check("extract: full-bleed bar stretches, centered dock, bottom-anchored dock, fluid vw headline", rr.fullBleed.some((x) => /bar/.test(x)) && rr.centered.some((x) => /dock/.test(x)) && rr.bottomAnchored.some((x) => /dock/.test(x.selector) && x.bottom === 24) && rr.fluidType.some((x) => /title/.test(x.selector)));
  const mob = rr.mobile;
  check("extract: mobile pass (390x844, mobile-emulated): hidden dock, mobile-only nav toggle, stacked row, type scale", mob?.viewport?.width === 390 && mob.hiddenOnMobile.some((x) => /dock/.test(x)) && mob.visibleOnlyOnMobile.some((x) => /burger/.test(x)) && mob.menuToggles.some((x) => /burger/.test(x)) && mob.stacked.some((x) => /row/.test(x.selector) && /column/.test(x.mobile)) && mob.typeScale.some((x) => /title/.test(x.selector) && x.mobile === 28) && fs.existsSync(mob.screenshot), JSON.stringify({ hidden: mob?.hiddenOnMobile, only: mob?.visibleOnlyOnMobile, stacked: mob?.stacked }));
  const rbp = JSON.parse(fs.readFileSync(rx.designBlueprint, "utf8"));
  check("blueprint: fixed layers carry their responsive anchor", rbp.layers.fixedAndSticky.some((l) => /hud/.test(l.selector) && l.anchor?.h === "right") && rbp.responsive?.viewports?.length === 2);
  const mvDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-mv-"));
  const mv = await call("compare_visual_diff", { targetUrl: `${base}/responsive.html`, localUrl: `${base}/responsive.html`, viewports: [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }], dumpReplayTo: mvDir, autoMenu: false });
  check("diff: verifies at 1440x900 and 1920x1080; one replay variant folder per viewport", mv.pass && mv.viewports.length === 2 && mv.viewports[1].viewport.width === 1920 && ["1440x900", "1920x1080"].every((v) => fs.existsSync(path.join(mvDir, v, "dom-y-0.json"))), `${mv.overallSimilarity}%`);
  const mvd = JSON.parse(fs.readFileSync(path.join(mvDir, "1440x900", "dom-y-0.json"), "utf8"));
  const h1 = mvd.boxes.find((b) => b.tag === "h1"), tag = mvd.boxes.find((b) => b.text === "Skewed tag"), svgBox = mvd.boxes.find((b) => b.tag === "svg");
  check("dom snapshot: rotation + nested skew captured as exact matrices over the untransformed box", h1?.xf && Math.abs(h1.xf.w - 960) < 1 && Math.abs(Math.atan2(h1.xf.m[1], h1.xf.m[0]) * 180 / Math.PI + 8) < 0.1 && tag?.xf && Math.abs(tag.xf.w - 160) < 1 && Math.abs(tag.xf.m[0] * tag.xf.m[2] + tag.xf.m[1] * tag.xf.m[3]) > 0.1, JSON.stringify(h1?.xf));
  check("dom snapshot: ::after rule line, pinned HUD, self-contained SVG (external <symbol> + computed stroke inlined)", mvd.boxes.some((b) => b.pseudo === "::after" && Math.abs(b.rect.h - 2) < 0.1 && b.styles.backgroundColor === "rgb(204, 51, 51)") && mvd.boxes.some((b) => b.text === "SIGN IN" && b.pin) && /sym-dot/.test(svgBox?.svg ?? "") && /stroke:\s*rgb\(123, 44, 191\)/.test(svgBox?.svg ?? ""));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-app-"));
  const stage = JSON.parse((await execFileAsync(process.execPath, [path.join(root, "scripts", "stage-replay.mjs"), "--app", appDir, "--extract", rx.extractionJson, "--dom", mvDir], { encoding: "utf8" })).stdout);
  const vpj = JSON.parse(fs.readFileSync(path.join(appDir, "public/replay/viewports.json"), "utf8"));
  const resp = JSON.parse(fs.readFileSync(path.join(appDir, "public/replay/1440x900/dom/responsive.json"), "utf8"));
  const hudKey = mvd.boxes.find((b) => b.text === "SIGN IN").key, barKey = mvd.boxes.find((b) => b.section === "bar").key;
  check("stage: two variants with document heights; per-box anchors fitted across variants (HUD right, bar stretch)", vpj.length === 2 && vpj.every((v) => v.scrollHeight > 900 && v.base) && resp.rules[hudKey]?.[0] === 1 && resp.rules[hudKey]?.[1] === 0 && resp.rules[barKey]?.[1] === 1 && stage.variants.every((v) => v.dom?.transformedBoxes >= 3 && v.dom?.pseudoBoxes >= 1), JSON.stringify({ hud: resp.rules[hudKey], bar: resp.rules[barKey] }));
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.rmSync(mvDir, { recursive: true, force: true });

  // ---------- canvas z-layers, video timeline, replay gating ----------
  console.log("\n== Layers, media, replay gating ==");
  const lyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-layers-"));
  await execFileAsync(process.execPath, [path.join(root, "scripts", "dom-layer-dump.mjs"), `${base}/layers.html`, lyDir, "0", "--wait", "1500"], { encoding: "utf8", env: { ...process.env, PIXEL_CLONE_OUT: outDir } });
  const ly = JSON.parse(fs.readFileSync(path.join(lyDir, "dom-y-0.json"), "utf8"));
  const deco = ly.boxes.find((b) => b.section === "deco"), hudB = ly.boxes.find((b) => b.text === "HUD above"), vid = ly.boxes.find((b) => b.tag === "video");
  check("dom snapshot: paint order vs the WebGL canvas measured (decoration behind, HUD and video above)", ly.canvas && deco?.zLayer === "behind" && hudB?.zLayer === "above" && vid?.zLayer === "above", JSON.stringify({ deco: deco?.zLayer, hud: hudB?.zLayer, video: vid?.zLayer }));
  check("dom snapshot: video timeline recorded (currentTime, playing, loop, rate)", vid && vid.time > 0.5 && vid.paused === false && vid.loop === true && vid.playbackRate === 1, JSON.stringify({ time: vid?.time, paused: vid?.paused }));
  const lcDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-layers-cmp-"));
  await call("compare_visual_diff", { targetUrl: `${base}/layers.html`, localUrl: `${base}/layers.html`, dumpReplayTo: lcDir, autoMenu: false, maxSlices: 2 });
  const lc = JSON.parse(fs.readFileSync(path.join(lcDir, "dom-y-0.json"), "utf8"));
  const lcv = lc.boxes.find((b) => b.tag === "video");
  check("diff: media frozen for the capture, the page's own playing state still recorded", lcv && lcv.paused === false && lcv.time > 0 && lc.boxes.find((b) => b.section === "deco")?.zLayer === "behind", JSON.stringify({ time: lcv?.time, paused: lcv?.paused }));
  fs.rmSync(lyDir, { recursive: true, force: true }); fs.rmSync(lcDir, { recursive: true, force: true });
  const pl = await call("profile_site", { url: `${base}/layers.html` });
  check("profile: viewport-covering canvas on a scroll-driven page -> replay allowed, with reasons", pl.recommendedScaffold.replay === true && pl.recommendedScaffold.replayReasons.length === 2, JSON.stringify(pl.recommendedScaffold.replayReasons));
  check("profile: standard pages -> replay NOT allowed (hand-authored)", gp.recommendedScaffold.replay === false && gwebgl.recommendedScaffold.replay === false && gp.recommendedScaffold.notes.some((n) => /hand-authored/.test(n)));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "pc-scaffold2-"));
  const sj = (a) => JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts", "scaffold.mjs"), ...a], { encoding: "utf8" }));
  sj([path.join(tmp2, "std"), "--profile", gp.profileJson]);
  sj([path.join(tmp2, "rep"), "--profile", pl.profileJson]);
  check("scaffold: standard site gets NO replay runtime; bespoke canvas pipeline gets it", !fs.existsSync(path.join(tmp2, "std/src/replay")) && !fs.existsSync(path.join(tmp2, "std/src/lib/replayState.ts")) && !/Dump-and-replay/.test(fs.readFileSync(path.join(tmp2, "std/src/app/page.tsx"), "utf8")) && fs.existsSync(path.join(tmp2, "rep/src/replay/DomLayer.tsx")));
  fs.rmSync(tmp2, { recursive: true, force: true });

  // dump-and-replay tooling
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-dump-"));
  await execFileAsync(process.execPath, [path.join(root, "scripts", "three-scene-dump.mjs"), `${base}/webgl.html`, dumpDir, "0", "--wait", "500"], { encoding: "utf8", env: { ...process.env, PIXEL_CLONE_OUT: outDir } });
  const sd = JSON.parse(fs.readFileSync(path.join(dumpDir, "y-0.json"), "utf8"));
  const sstatic = JSON.parse(fs.readFileSync(path.join(dumpDir, "static.json"), "utf8"));
  check("scene dump: pass list + scenes + geometry + exact programs", sd.passes.some((p) => p.op === "render") && Object.keys(sd.scenes).length >= 1 && Object.keys(sstatic.geometries).length >= 2 && Object.values(sstatic.programs).some((p) => /gl_FragColor|pc_fragColor/.test(p.fragment ?? "")) && fs.statSync(path.join(dumpDir, "geometry.bin")).size > 0, `${sd.passes.length} ops, ${Object.keys(sstatic.geometries).length} geometries`);
  await execFileAsync(process.execPath, [path.join(root, "scripts", "dom-layer-dump.mjs"), `${base}/target.html`, dumpDir, "0", "--wait", "300"], { encoding: "utf8", env: { ...process.env, PIXEL_CLONE_OUT: outDir } });
  const dd = JSON.parse(fs.readFileSync(path.join(dumpDir, "dom-y-0.json"), "utf8"));
  check("dom dump: visible boxes with text, styles, section tags and stable structural keys", dd.boxes.some((b) => b.text?.includes("Measured") && b.styles.fontSize === "72px") && dd.boxes.every((b) => b.section && b.rect && typeof b.key === "string") && new Set(dd.boxes.map((b) => b.key)).size === dd.boxes.length, `${dd.boxes.length} boxes`);
  fs.rmSync(dumpDir, { recursive: true, force: true });

  // ---------- live ----------
  if (live) {
    console.log("\n== Live URLs ==");
    try {
      const lx = await call("extract_dom_and_styles", { url: "https://example.com" });
      check("live extract example.com", lx.nodesTotal > 3 && /Example Domain/.test(lx.page.title) && lx.tokens.typography.length > 0 && !!lx.tokens.typography[0].fontSize, `${lx.nodesTotal} nodes, ${Object.keys(lx.cssVariables).length} css vars`);
      const ld = await call("compare_visual_diff", { targetUrl: "https://example.com", localUrl: "https://example.com" });
      check("live diff example.com vs itself", ld.pass && ld.overallSimilarity === 100, `${ld.overallSimilarity}%`);
      const lg = await call("inspect_webgl_scene", { url: "https://threejs.org/examples/webgl_geometry_cube.html" });
      check("live webgl threejs.org cube example", lg.webgl === true, `engine=${lg.engine} objects=${lg.scenes?.[0]?.objectCount} fov=${lg.activeCamera?.fov}`);
    } catch (e) {
      check("live phase", false, e.message.split("\n")[0]);
    }
  }
} catch (e) {
  check("unexpected error", false, e.stack ?? String(e));
} finally {
  await client.close().catch(() => undefined);
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
