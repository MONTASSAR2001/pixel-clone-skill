---
name: pixel-clone
description: Reverse-engineer a website you own or have permission to replicate (static pages, SaaS/e-commerce sites, dashboards, smooth-scroll/GSAP sites, WebGL/Three.js experiences) into a clean Next.js (App Router) + Tailwind CSS project, adding GSAP / Framer Motion / Lenis / React Three Fiber ONLY if the target uses them. Profiles the site, clears cookie banners/age gates/preloaders/"Enter" screens, extracts a design blueprint (with per-element responsive rules measured at 1440x900 and 1920x1080), motion timeline and WebGL scene via Playwright + CDP, then iterates against a full-page, multi-viewport pixelmatch diff until every slice is >= 99% or a documented plateau. Clones are responsive (full-bleed at any window size), open on the target's hero, load progressively and scroll smoothly. Use when asked to clone, replicate, recreate, reverse-engineer or make a pixel-perfect copy of a site, landing page, scroll animation, HUD or 3D scene from a URL.
license: MIT
compatibility: Requires Node >= 20.9 and the pixel-clone MCP server (this repo; start it with node scripts/mcp-launch.mjs after npm run setup). Works with any Agent Skills + MCP client, e.g. Claude Code, Cursor, Windsurf, Antigravity, Gemini CLI.
---

# pixel-clone: universal reverse-engineering protocol

You replicate a target by **measuring it, never by eyeballing it**. Every value in the output (color, spacing, font metric, easing, camera FOV, shader uniform) must trace back to a number returned by an MCP tool. **The deliverable is always the ENTIRE page, top to bottom: every section, menu, modal and scroll-driven scene. A hero-only or partial clone is never an acceptable result, and is never reported as done.** Work is finished only when `compare_visual_diff` (full-page mode) reports `pass: true` (every vertical slice and every interactive state >= 99%, page height within 2%) or a documented stop condition is reached and reported honestly. No tool can promise 100% on *any* site: video, live data, ads, third-party iframes, bot walls and GPU-specific rasterization cap what is achievable. Your job is to get as close as the evidence allows and to say precisely what remains.

## 0. Before you start

1. **Authorization.** Proceed only if the user owns the target, has permission, or the goal is learning/prototyping. Third-party copyrighted text, images, logos, fonts, audio and 3D models are **never committed or published**: keep the clone and its assets local (`.clone-output/`, gitignored) and tell the user which assets need licensing.
2. **Tools.** Confirm the MCP server `pixel-clone` exposes `profile_site`, `scan_page_sections`, `extract_dom_and_styles`, `capture_motion_timeline`, `inspect_webgl_scene`, `compare_visual_diff`. If not, tell the user to run `npm run setup` in this skill's directory (dependencies, build, bundled Chromium) and register `node <skill-dir>/scripts/mcp-launch.mjs` with their client (README has the snippet for Claude Code, Cursor, Windsurf, Antigravity and Gemini CLI). Do not guess.
3. **Capture geometry.** Primary `1440x900` plus wide `1920x1080`, `deviceScaleFactor: 1`. Extraction measures both from the start (responsive rules); the diff loop runs at 1440x900 and the clone must also pass at 1920x1080 before it is done. Never change viewports mid-loop.
4. **Keep notes.** Maintain `CLONE_NOTES.md` in the clone project (URL, date, profile, digest, iteration table, deviations). It is your memory across context resets.
5. **Cache.** Static assets are cached in `.clone-output/_http-cache/` so reloading a 100 MB site is fast. `PIXEL_CLONE_NO_CACHE=1` disables it; `localhost` is never cached.

---

## Phase 0: Profile and clear the gates (always first)

Run `profile_site({ url })`. It loads the page robustly (heavy sites may never fire `load`; this is handled), **auto-dismisses cookie banners, age gates and "Enter" screens and waits out preloaders** (the budget extends while a loader's % keeps advancing), then reports the stack and recommends a scaffold.

Read `gates` first:

| `gates` result | Meaning / action |
|---|---|
| `ready: true`, `actions: []` | No gate. Proceed. |
| `actions: [{kind: "cookie"\|"gate"\|"gate-anywhere"}]` | Gate(s) cleared. Record them in `CLONE_NOTES.md`: **the clone must reproduce the gate if it is part of the experience** (see Phase 2). |
| `ready: false`, `remainingBlocker` set | Auto-detection failed. Find the control (inspect screenshot/DOM), then pass `entrySelector: "<css>"` to **every** tool. Raise `readyTimeoutMs` for slow loaders. |
| `loadEvent: false` | Normal for streaming/heavy sites. Nothing to do. |

Pass the same `entrySelector` / `readyTimeoutMs` to `extract_dom_and_styles`, `capture_motion_timeline`, `inspect_webgl_scene` and `compare_visual_diff` (the diff tool applies it to the target and tolerates its absence on the clone).

Then decide the plan from `archetype` and `recommendedScaffold`:

| Signal | Decision |
|---|---|
| `rendering.webgl1/2` with a sizeable canvas | Run `inspect_webgl_scene`; scaffold with three/R3F; diff with `freezeTime: true` |
| No WebGL context | **Skip `inspect_webgl_scene` entirely** and do not install three / @react-three/* |
| `rendering.canvas2d` | Rebuild with a plain `<canvas>` + `useEffect`; no 3D deps. Capture the draw logic by observation |
| `animation.lenis` / `scrollSmoother` / `layout.virtualScroll` | Capture the scroll curve (`smoothScroll` in motion output); implement Lenis or a transform scroller |
| `media.videos` | Download the files (extraction does, <= 25 MB); use `<video>` with the same attributes |
| `layout.shadowRoots` / `iframes` | Not reachable by style walk or cross-origin: rebuild by measurement and record as a deviation |
| `frameworks` | Informational only: output is always Next.js regardless of the original stack |
| `scriptHints` mention gsap/ScrollTrigger but `animation.gsap.version` is `unknown` | GSAP is *possibly* bundled: infer easing from sampled values and the mutation log |

### Hard rule: hand-authored code by default, replay only for bespoke canvas pipelines

`recommendedScaffold.replay` (with `replayReasons`) decides how the clone is written. It is `true` only when the target is a **bespoke scroll-driven WebGL/canvas pipeline**: a canvas covering the viewport AND a page that scrolls through several screens (or a virtual scroller).

- `replay: false` (SaaS landing pages, e-commerce, blogs, docs, dashboards, a 3D widget inside a normal page): write **clean, idiomatic, human-readable React + Tailwind components** from `design-blueprint.json` (tokens, typography, layout, effects, responsive rules). `DomLayer`, `ThreeReplay` and JSON box dumps are **forbidden**; the scaffold does not even contain them. A 3D widget is rebuilt with R3F from `inspect_webgl_scene`.
- `replay: true`: dump-and-replay is allowed **for the canvas-driven sections only**. Standard sections around them (navigation, footer, forms, text blocks that are ordinary DOM) are still hand-authored components; say in `CLONE_NOTES.md` which sections are replayed and why.
- Never switch to replay because hand-authoring is hard: the profile decides, and `--replay on` on a standard site must be justified in writing.

### Adaptive scaffolding

```
node scripts/scaffold.mjs <clone-dir> --profile <profile.json from profile_site>
```
Copies `templates/nextjs-clone-starter` and keeps **only** what the profile recommends (three/R3F, GSAP, Framer Motion, Lenis, and the replay runtime `src/replay/` only when `replay` is true). Without WebGL the project contains no 3D dependency; with it you get `CloneCanvas`. Override with `--three on|off --gsap on|off --framer on|off --lenis on|off`. Then `npm install` and `npm run build && npm start` (port 3000). Always diff against a **production build**: `next dev` paints an "N" badge into the page.

---

## Phase 1: Deep extraction (no code yet)

| Tool | Gives you | Output |
|---|---|---|
| `extract_dom_and_styles` | Flat DOM + computed styles + page-space rects, `::before/::after`, inline SVG, stacking-context reasons, tokens, CSS variables, `@font-face` (+files), `@keyframes`, breakpoints, images/fonts/videos/models downloaded, **`design-blueprint.json`**, and **`responsive-rules.json`**: every element re-measured at 1920x1080 and fitted to a rule (`left`/`right`/`center` anchored, `stretch` full-bleed, `scale` vw-proportional, `center-fluid`, fluid type `kf`), plus `hardcodeTraps` | `extract/<slug>/` |
| `capture_motion_timeline` | Every CSS animation/transition (exact keyframes, duration, `cubic-bezier`); frozen-time samples; per-checkpoint, per-frame transform/opacity/clip-path deltas on a **deterministic virtual clock**; hover before/after; mutation log vs scroll; **scroll model and smooth-scroll curve** (`estimatedLerpPerFrame`, `settledFrame`); GSAP/ScrollTrigger when reachable | `motion/<slug>/timeline.json` |
| `inspect_webgl_scene` | WebGL1+WebGL2 hooks: Three.js renderer/camera (FOV, matrices)/lights/meshes/materials/textures; raw GLSL, linked programs, last-set uniforms, texture/buffer uploads, draw counts; downloaded `.glb/.ktx2/.hdr`; `scrollCheckpoints` re-samples camera/uniforms for scroll-driven scenes; **`frameTrace: true`** records the ordered GL command stream (framebuffer passes, texture source URLs, state, per-draw uniforms) | `webgl/<slug>/webgl-scene.json`, `webgl-frame-trace.json` |

**`design-blueprint.json` is your source of truth.** It contains `responsive` (full-bleed, right/bottom-anchored, centered, proportional and fluid-type elements across viewports; fixed layers carry their `anchor`), `tokens`, `cssVariables`, `fonts` (with local files), `breakpoints`, `structure.sections`, `layers.fixedAndSticky` and `layers.stackingContexts` (with reasons and z-order), `effects` (clip-path / mix-blend-mode / backdrop-filter / filter / mask), `media` (images, inline SVG, videos, canvases, models) and `components`: a nested tree where each node separates `layout`, `paint`, `typography`, `motion`, with wrapper-collapse markers and `repeatGroups` (siblings that should become one mapped component).

For scroll-driven 3D call `inspect_webgl_scene` with `scrollCheckpoints: [0, 0.25, 0.5, 0.75, 1]`.

**Custom multi-pass renderers (render targets, post-processing, stencil portals):** a scene graph is not enough. Run `frameTrace: true` and read the *whole* frame in `webgl-frame-trace.json`: which framebuffer each pass renders to, which texture (with its source URL) is bound, blend/stencil/depth state, and the uniforms at each draw. A trace that stops at the first screen draw hides later passes (a stencil-gated 3D pass hid behind the first screen draw on one real site), so check the op list to the end of the frame. For animated uniforms run `node scripts/gl-trace-series.mjs <url> <frames> out.json --match name=<unambiguous GLSL marker> ...` (per-draw uniforms on the virtual clock; list the screen/final pass last). Pick markers that cannot appear in three.js' injected prelude (`tMap` also matches `displacementMap`). For per-frame animation constants (rotation per frame, lerp factors), **measure from the target by stepping its virtual clock** instead of guessing.

### Mobile pass (390x844)

Run `extract_dom_and_styles({ url, mobile: true })` whenever the clone must work on phones (always, unless the user scopes it out). A mobile-emulated pass (touch, isMobile, mobile UA, DSF 1) reports `responsive.mobile`: `hiddenOnMobile`, `visibleOnlyOnMobile`, `menuToggles` (hamburger/drawer controls), `stacked` (flex row -> column, grid columns collapsing), `typeScale` and the mobile page height, plus a mobile reference screenshot. Implement them with the target's own `breakpoints` (`max-[Npx]:`/`min-[Npx]:` variants), build the mobile navigation toggle and its open state, and verify with `compare_visual_diff({ viewports: [..., { width: 390, height: 844, mobile: true }] })`.

### Mandatory: Section-by-Section Inventory (before any code)

Run `scan_page_sections({ url })`. It scrolls the **whole** document in viewport steps and records, per slice, the visible text, section containers, media, fixed layers and the WebGL passes/textures drawn, then groups consecutive slices into section candidates (`inventory.md`). This matters most on scroll-driven sites where every section lives in a fixed layer: DOM rects then say nothing about *where in the scroll* a section appears.

Copy the inventory into `CLONE_NOTES.md` as a table and complete it by hand:

| # | Scroll range (px) | Section / scene | Kind (DOM, WebGL scene, video, transition) | Component | Slices | Status |
|---|---|---|---|---|---|---|

Rules:
- Every vertical section, navigation menu, modal/overlay, scroll-driven scene, 3D glTF/WebGL pass and scene transition across the full `scrollHeight` gets a row. Use `interactions` to cover states the scroll cannot reach (open menu, modal, tab).
- Every row becomes a **dedicated React component** (`src/sections/<Name>.tsx`, `src/scenes/<Name>.tsx`), composed in page order in `page.tsx`.
- The clone's document height must match the target's (within 2%) from the first build, with every section present at its scroll range, before any pixel polishing.
- **Forbidden:** hero-only clones, "representative" sections, collapsing several sections into one, placeholders left in a delivered clone, and reporting a pass from a 5-state or single-slice check.
- A row is ticked only when all of its slices pass. If something truly cannot be reproduced (cross-origin iframe, DRM video), the row stays unticked and is reported as a deviation: the clone does not pass.

Write an **extraction digest** in `CLONE_NOTES.md`: sections with y/height, tokens, font plan, layers + z-order, motion inventory (trigger, property, duration, easing), 3D inventory, gates, unknowns/limits.

---

## Phase 2: Code synthesis

Build bottom-up: **tokens -> fonts -> layers/stacking -> layout shell -> sections -> motion -> 3D**. Turn `components` into clean React components named from `suggestedName`; use `repeatGroups` for `.map()`; keep the original tag semantics.

### Zero-Approximation Rule

Every color, spacing value, font metric, easing curve, timing, camera parameter, light intensity and shader uniform comes **strictly** from the blueprint / tool output. If a number is not there, measure it (re-run a tool, or `getComputedStyle` / `getBoundingClientRect` through Playwright) before using it. No rounding to Tailwind presets: use arbitrary values (`px-[34px]`, `tracking-[-0.02em]`, `bg-[rgb(14,14,16)]`).

### Mapping rules (blueprint -> code)

- **Tokens/variables:** every `cssVariables` entry into `globals.css` (`@theme`/`:root`) under its original name.
- **Fonts:** copy `fonts[].sources[].localPath` to `public/fonts/`, same `@font-face` descriptors; confirm the rendered family with `platformFonts`. If a file is missing, use the closest `next/font/google` family, record the substitution and expect a typography diff.
- **Layout:** reproduce `display/flex/grid/position/gap/min/max` exactly. Heights come from content unless the original fixes them. Compare `rect` values to your render when a section is off.
- **Layers:** reproduce `layers.fixedAndSticky` with the same `position` and `z-index`, offsets from each layer's `anchor` (e.g. `right`/`top`, not the resolved four-side `inset`), and honor `stackingContexts` (opacity/transform/filter/isolation create contexts that change paint order).
- **Transforms:** copy `transform`/`rotate`/`skew` and `transform-origin` verbatim; angled typography and HUD lines are part of the design, not noise.
- **Effects:** `clip-path`, `mix-blend-mode`, `backdrop-filter`, `filter`, `mask-image` verbatim from `effects`.
- **Images/SVG/video/audio:** use downloaded files; inline SVG markup verbatim; match `object-fit/position`, `aspect-ratio`; `<video>` with the same `autoplay/loop/muted/poster`.
- **Pseudo-elements:** `before:`/`after:` utilities with identical `content` and styles.
- **Breakpoints:** `breakpoints` -> exact `min-[Npx]:`/`max-[Npx]:` variants, not Tailwind defaults.
- **CSS animation:** `@keyframes` verbatim; `effectiveEasing` for the curve. Framer: `ease: [a,b,c,d]` in seconds. GSAP: original ease, or `registerEase()` for a raw cubic-bezier.
- **Scroll motion:** ScrollTrigger config as captured; IntersectionObserver reveals (from `mutationLog`) via `whileInView` with an `amount` that matches the trigger scroll positions. **Smooth scroll:** match `smoothScroll.estimatedLerpPerFrame` / `settledFrame`; if `model: "wheel"`, build a transform-based virtual scroller on the `driver` element.
- **Gates:** if the target has an enter/loader screen that is part of the experience, rebuild it (same overlay, label text, progress behavior, button) so the diff tool's gate handling passes on both sides.
- **WebGL (R3F):** `<Canvas>` `dpr`, `gl`, `flat` (when `toneMapping` is 0; R3F otherwise applies ACES), `camera` from `activeCamera`; lights/meshes/materials one-to-one from `scenes[0].objects`; `useGLTF` with downloaded models; `ShaderMaterial` with `vertexShader`/`fragmentShader`/`uniforms` verbatim from `raw.programs` (drive time uniforms in `useFrame`). Wrap in `ClientOnly`.

### Scroll-driven experiences and bespoke renderers: dump + replay

Some sites cannot be rebuilt by hand within reason: every section is a multi-pass three.js tableau (render targets, MaskPass stencils, custom shaders) and the UI is split text that animates with scroll. For those, rebuild each section from **measured state** instead of approximating it:

1. **Dump in the compared session, at both viewports:** `compare_visual_diff({ ..., viewports: [{1440,900},{1920,1080}], dumpReplayTo: "<dir>" })` writes one replay variant per viewport (`<dir>/1440x900/`, `<dir>/1920x1080/`) captured right before each screenshot, so history-dependent states (intro played, menu open) match what is compared. Per slice it records:
   - the site's own per-frame pass list (`renderer.render` with scene, camera and render target, clears, viewport/scissor, `renderer.state.buffers` calls: MaskPass stencil/colour/depth locking), scene graphs, geometry buffers, materials with the **exact compiled GLSL**, uniforms, texture identities and render targets (segmented on the site's own frame-opening clear, after the scene stops changing);
   - every visible painting DOM box: stable structural `key`, rect, the untransformed box + cumulative matrix of **rotated/skewed/scaled** elements (`xf`), inherited clip, `pin` (inside a fixed layer), effective opacity, paint/typography/**transition** styles, text and line fragments, images, video time, **self-contained inline SVG** (computed `fill`/`stroke` inlined, external `<symbol>`/gradient refs copied in) and **`::before`/`::after`** boxes (HUD lines, frames, bullets).
   The standalone `scripts/three-scene-dump.mjs` / `dom-layer-dump.mjs` take the same `--viewports 1440x900,1920x1080`.
2. `node scripts/stage-replay.mjs --app <clone> --extract <extraction.json> --cache <_http-cache> --scene <dir> --dom <dir>` stages each variant (`public/replay/<W>x<H>/`), resolves every texture to a file and records *how* (URL, glTF name, unique KTX2 size, inferred name pattern: report the inferred ones), splits geometry into per-keyframe chunks with a dependency manifest (hero first), fits every DOM box's anchoring **across** the two variants (`dom/responsive.json`) and drops a non-distinct top-return state.
3. Replay with the template runtime (`src/replay/`, composition example in the template's `page.tsx`): `<ReplayHeroProvider hero={loadReplayHero()}>` + `<ReplayPreload/>` + `<ReplaySpacer/>` + `ThreeReplay` + one `DomLayer` per inventory section (`src/sections/<Name>Section.tsx`). The runtime:
   - picks the variant closest to the window; places every DOM box with CSS container units from its anchor rule (responsive before any script runs, no re-render on resize); resizes the renderer, projections, screen-sized render targets, viewport/scissor rects and resolution uniforms;
   - server-renders the hero's UI and starts the hero's data requests from an inline script before hydration; draws the WebGL hero as soon as its geometry and per-pass precompiled programs are ready while its textures stream in; streams every other keyframe by distance from the scroll position;
   - interpolates matrices, projections, uniforms, opacities and boxes between keyframes on one damped scroll clock and draws only on change;
   - applies UI states (menu, hover) as deltas at any scroll position with the target's own transition curves.
   Map **every** entry of the stager's `dom.sections` report to a section component (or to a hand-built widget excluded with `dumpExclude`); an unmapped section's boxes silently vanish.
4. `node scripts/bake-hero-poster.mjs <cloneUrl> <cloneDir>` (after a build) renders the clone's own complete hero per variant to `hero-poster.webp`; rebuild. It shows in the first paint and cross-fades to the live canvas once the hero's textures are in. It is a cached frame of the replay itself, never a screenshot of the target, and never the final state.
5. `node scripts/verify-clone.mjs <cloneUrl> --viewports 1440x900,1920x1080,2560x1080 [--gpu]` checks what pixels cannot: first paint and WebGL hero times, hero on load, canvas covering the window, frame rate and interpolated states while scrolling, top-return only after a deep visit. Use `--gpu` for frame-rate numbers (software GL measures the rasteriser, not the clone).

Pitfalls this approach must handle (each one broke a real run):
- `WebGLRenderTarget` has no `uuid` in recent three: identify a target by its texture's uuid.
- `drawRange.count = Infinity` becomes `null` in JSON: treat null as Infinity or nothing is drawn.
- Three adds its own `#define`s before a `RawShaderMaterial` source: move `#version` to `glslVersion` and drop duplicate `SHADER_NAME`/`SHADER_TYPE` defines.
- Sites built on pre-r152 three have no colour management (`colorSpace` undefined): disable `ColorManagement`, use linear output and `NoColorSpace` textures, or every KTX2 texture is decoded as sRGB and the image darkens.
- Pointer position changes parallax: dump with the pointer where the diff tool parks it (bottom-right corner).
- Settle on stability, not a fixed delay: scroll-triggered transitions can take several seconds.
- Record the GL scene FIRST and snapshot the DOM LAST, right before the screenshot: a multi-second GL recording lets scroll-triggered UI finish animating, and a DOM snapshot taken before it shows half-revealed text the screenshot does not.
- History matters: a fast priming sweep is not necessarily a visit, and an intro still animating at load makes "the top changed" meaningless. The diff tool treats priming as a visit (and primes the clone the same way) only when slice 0 already equals the top seen after the full slice run; otherwise slice 0 is the hero and the post-visit top (`state-top-return`) appears only after the slices went deep. `replay-index.json` `meta` records `primedDeep` and `topReturn` (`similarityToHero`, `slice0VsReturn`, `distinct`).
- The canvas is part of the stacking order: decorations painted beneath the WebGL canvas must stay beneath it. The DOM snapshot measures each box against the main canvas with the browser's own paint order (`zLayer: "behind" | "above"`); the runtime draws "behind" boxes at `z-index: -1` (under `ThreeReplay`) and the rest at `z-index: 1`.
- Video is a timeline: the diff tool pauses playing videos for each capture (`freezeMedia`, default on) so the dump records the exact `currentTime` the screenshot shows (and the page's own paused/playing state, rate, loop). The runtime seeks DOM videos and WebGL video textures to that time; during a visual diff (`window.__pcVisualDiff`) or virtual time it holds that frame, for visitors it plays on from it.
- A bounding box is not a rotated element: draw transformed boxes at their untransformed box with the captured matrix (`xf`), or angled type and HUD lines come out axis-aligned and oversized.

Trade-offs to state in the report: replayed sections reproduce the target's own assets and shaders state-for-state, but they are data-driven components, not hand-authored semantic markup; between keyframes the state is interpolated (exact at the dumped positions, an approximation of non-linear scroll animation in between: dump denser `sliceStep` where it matters); time-animated details (video, idle loops) differ frame to frame; windows between the captured viewports are adapted by rule, not captured. Never present replayed third-party assets as your own work.

### Responsive rules (mandatory: the clone must fill ANY screen)

A clone that only works at 1440x900 is broken: on a 1920x1080 or ultrawide monitor a hard-coded composition sits as a shrunken box in the top-left corner with empty bands around it. Use `responsive-rules.json` / `blueprint.responsive`, never the raw 1440 numbers:
- **Full-bleed** (`fullBleed`, rule `stretch`): `inset-x-0` / `w-full` / `100%`, never `w-[1440px]` (and not `100vw` inside a scrolling page: it includes the scrollbar). Full-screen canvases and overlays: `fixed inset-0`, renderer and camera resized on `resize`.
- **Edge-anchored HUD** (`rightAnchored`, `bottomAnchored`): `right-[21px]`, `bottom-[24px]`, never the resolved `left: 1299px`. `getComputedStyle` resolves `left/top` of positioned boxes to px even when the author wrote `right`/`bottom`; every entry in `hardcodeTraps` is one of these.
- **Centered columns** (`center`, `center-fluid`): `mx-auto` + the measured `max-w-[Npx]`; **proportional** (`scale`): vw units; **fluid type** (`fluidType`, `kf` = px per viewport px): `font-size: calc(Apx + Bvw)` or the original `clamp()`.
- Document height: the target's own `scrollHeight` at each viewport (the replay template's `<ReplaySpacer/>` does this), never a hard-coded `min-height` copied from one viewport.
- Breakpoint changes between the two viewports (a rule classified `fluid`) need a media query at the target's breakpoint from `breakpoints`.

### The hero is always the entry view

The page opens on the target's initial hero (slice `y=0`). Never replace it with a post-scroll state on load. Some targets show a different top after the visitor has scrolled down and back (intros that play once): reproduce that **only** when `compare_visual_diff` marked it distinct from the hero (`replay-index.json` `meta.topReturn.distinct`), and only after the visitor scrolled at least 1.5 viewports down and returned (the template's `replayState.ts` enforces this).

### Performance and feel (mandatory)

- **Load:** the hero must be visible in the first paint (server-rendered UI, baked poster for WebGL) and live within seconds on a local production build. Never block first paint on downloading every section (`Promise.all` over all keyframes/textures): request the hero's data before hydration, load the hero's own data first, stream the rest in priority order (nearest to the scroll position first), precompile shaders per pass off the critical path. Report first paint, WebGL-hero and hero-complete times separately (`verify-clone.mjs`).
- **Scroll:** no stepped/snapping states. Interpolate between measured states (camera/object matrices, uniforms, opacities, box positions) on a damped scroll value at display rate, and render only when something changed.
- **Resilience:** a missing GPU must never blank the page. WebGL can be unavailable (hardware acceleration off, GPU process down after a browser update, blocklisted driver) or lost at runtime: create the renderer defensively, keep the UI layers and the hero poster as the fallback, rebuild on `webglcontextrestored`, and wrap every replay layer in an error boundary (the template's `ReplayBoundary`). Test once with `--disable-3d-apis`.
- **Interaction:** hover/click/menu transitions use the target's own `transition` durations and curves (typically 150-250 ms, from the extraction or the DOM dump); scroll-driven motion never runs through a CSS transition (it would lag the scroll).

### Anti-slop rules (hard requirements)

1. **No invented values.** 2. **No generic defaults** (purple gradients, glassmorphism, `rounded-xl`/`shadow-lg`, Inter/system fonts, emoji icons, lorem ipsum, `hover:scale-105`, `transition-all duration-300`, unmeasured `ease-in-out`) unless extracted. 3. **No Tailwind-preset rounding.** 4. **Copy text verbatim** including case and line breaks. 5. **Semantic HTML** matching the original tags; do not flatten wrapper elements that carry layout. 6. **Preserve** `alt`, `aria-*`, `role`; never invent them. 7. **Never embed screenshots as content.** 8. **Never hard-code to the diff** (viewport special cases, unmeasured offsets, hidden overflow). 9. **One source of truth** (repeated values become variables/components). 10. **Document every deviation** in `CLONE_NOTES.md`.

---

## Phase 3: Full-page segmented visual diff

```
compare_visual_diff({
  targetUrl: "<target>", localUrl: "http://localhost:3000",
  viewports: [{ "width": 1440, "height": 900 }, { "width": 1920, "height": 1080 }],   // both, every time it matters
  minSimilarity: 99,
  freezeTime: true,                 // always for canvas/WebGL/GSAP/rAF-driven pages
  entrySelector: "<css, if needed>",
  mode: "fullpage",                 // default: slice the WHOLE page
  maxSlices: 20,                    // taller pages are sampled evenly over the full height
  heightTolerance: 0.02,
  interactions: [{ "name": "menu", "click": ".menu-toggle" }],   // menus/modals the scroll cannot reach
  reuseTarget: true,                // pin the target's captures across iterations
  settleFrames: 20, stateFrames: 6  // lower both on GL-heavy pages: software GL can cost seconds per frame
})
```

Captures (DSF 1, fonts/images awaited, CSS animations disabled): **every vertical slice** from `y=0` to the bottom in viewport-height steps (`slice-00@0`, `slice-01@900`, ...; at most `maxSlices`, sampled evenly over the full height beyond that), then `hover`, an auto-detected `menu-open` state and every `interactions` entry. Slice positions come from the *target's* height and are replayed on the clone, so missing or mis-sized sections surface as drift. When the document does not follow `scrollTo` (virtual scrollers) the tool uses wheel input (`coverage.scrollModel: "wheel"`).

**Pass rule:** `pass: true` only if **every** slice and every interactive state is >= `minSimilarity` **and** `height.pass` (scrollHeight within `heightTolerance`, default 2%). The legacy `mode: "states"` (5 snapshots) can never pass. Open `overview.png` first: one row per slice (target | clone | diff, green/red bar), then the worst slices' diffs; `hotspots[].pageY` gives page coordinates and `failingSlices` lists what is left.

`freezeTime: true` replaces `requestAnimationFrame`, `performance.now` and `Date.now` with a virtual clock advanced in fixed frame steps, so target and clone render the *same frame number* in every state. (Without it a page compared with itself scored 87% in testing.) Real timers, network and CSS animations are not virtualized. If a gate/preloader forces frames to run before capture, frame counts can differ by a few frames between runs: treat sub-percent canvas noise accordingly and say so.

**Both pages are driven identically**: the local page inherits the target's scroll model (native vs wheel), so state frame counts match even if the clone could scroll natively where the original uses a virtual scroller. Screenshots have a 180 s default timeout (`screenshotTimeoutMs`).

**Phase jitter.** If the target's animation is driven by asset loading (preloaders, intro timelines), the frame at which it starts is wall-clock dependent, so two captures of the *same* target differ. Always run target-vs-target first (`localUrl` = `targetUrl`) to measure the ceiling, pin one target capture with `reuseTarget: true` for the loop, and report **both** the pinned score and a fresh-capture score. If you calibrate a frame offset for the clone (scan offsets and score each), say that it is a fitted constant.

Use: `states[].similarity` (`(1 - diffPixels/total) * 100`, pixelmatch threshold 0.05, anti-aliasing excluded), `hotspots[]` (grid cells with the most differing pixels), `files.diff` (red mask: **look at it every iteration**; also view target and local side by side), `height`, `failingSlices`, `pass`.

Sanity-check a perfect score: confirm the captures contain content, and once break a measured constant on purpose to see the score drop and `pass` turn false, then restore it.

---

## Phase 4: Self-healing loop

```
iteration = 0
while not pass and iteration < 12:
    if height.pass is false: fix missing / mis-sized sections first (inventory rows), never pixels
    open overview.png; pick the WORST failing slice
    view its diff + target + local
    diagnose ONE root cause (largest hotspot first)
    measure the true value in the target (tool / getComputedStyle / __pcStep), never guess
    apply the smallest fix; re-run compare_visual_diff
    log iteration, per-slice similarity, change, result in CLONE_NOTES.md
    iteration += 1
```

| Symptom in diff | Likely cause | Verify with |
|---|---|---|
| Everything below some y shifted | Height error above it (line-height, margin collapse, missing element, font metrics) | blueprint `rect` y/h vs clone DOM; fix the **first** diverging section |
| Text red, boxes aligned | Font file/weight, letter-spacing, wrapping width, `font-feature-settings` | `platformFonts` vs clone; line count and `rect.w` |
| Thin outlines on edges | Sub-pixel offsets, border widths, `box-sizing`, rem conversions | px from blueprint |
| Solid blocks differ | Color/gradient stops, opacity layering, `mix-blend-mode`, `backdrop-filter`, stacking order | `effects`, `layers.stackingContexts` |
| Fixed UI wrong while scrolling | `position`/`inset`/`z-index` or missing stacking context | `layers.fixedAndSticky` |
| Only `hover` differs | Missing hover style, wrong duration/easing, wrong target | `hover[].changed`, report `hoverPoint` |
| Only scroll states differ | Reveal trigger point, parallax, sticky/pin, smooth-scroll curve | `scrollSteps[].frames`, `mutationLog`, `smoothScroll` |
| Scroll states identical to `top` | Virtual scroller not reproduced, or `wheelDeltas` too small | report `scrollModel`; raise `wheelDeltas` |
| Canvas region differs | Camera FOV/position/matrix, tone mapping, color space, light intensity, env map, texture, shader uniform, `dpr`, frame/phase offset | `inspect_webgl_scene` on both; diff the JSON; step the target with `__pcStep` for per-frame constants |
| Differs only on first load | Gate/preloader timing | `targetReadiness` vs `localReadiness` in the report |
| Same shapes, edges shifted, error similar in every state | Animation phase offset between the captures | scan a clone frame offset (one peak = a phase constant); validate against a fresh target capture |
| Logo/shape polarity inverted in one region | A pass that is stencil/scissor/blend-gated in the target drawn ungated in the clone | `frameTrace` state ops (`stencilFunc`, `enable[2960]`, `blendFunc`) |
| Small cluster in a bottom corner of the clone | Dev overlay (Next "N" badge) | diff a production build |
| 1920x1080 only: composition stuck top-left, empty band right/bottom | Hard-coded 1440/900 widths, `left:` offsets, fixed-size canvas | `responsive.fullBleed`, `hardcodeTraps`; canvas `fixed inset-0` + resize |
| 1920x1080 only: HUD element drifted inward | Resolved `left: Npx` copied instead of `right` | `responsive.rightAnchored` |
| Hero missing on load / post-scroll header shown first | top-return state applied without a deep scroll | `replay-index.json` `meta.topReturn`, `replayState.ts` |
| Scrolling looks stepped, states pop | Nearest-keyframe snapping, no interpolation | template replay runtime; denser `sliceStep` |
| Target moved between runs | Live data, A/B variant, rotating content | repeat target-vs-target; if it differs, that region is outside your control |

**Rules:** one root cause per iteration; revert any fix that makes a passing state fail; do not refactor while diffing; fix the cluster in `hotspots[0]`, not the average.

**Stop conditions** (then report honestly, never claim success): (a) `pass: true`; (b) 12 iterations; (c) three consecutive iterations improve the worst state by < 0.1%; (d) the remaining diff is outside your control (video frames, live data, ads, third-party iframes, GPU-specific rasterization, target nondeterminism proven by target-vs-target, load-driven animation phase). In (b)-(d) deliver: final per-state similarity, remaining hotspots with causes, and what would close the gap.

### Definition of done
- Every inventory row implemented as its own component and ticked.
- `compare_visual_diff` (mode `fullpage`) -> `pass: true` at 1440x900 **and** 1920x1080: every slice and interactive state >= 99%, height within 2%, **or** a documented stop condition with the per-slice table per viewport. A partial clone is reported as partial, with the failing slices listed.
- Responsive: no empty band or corner-pinned composition at 1920x1080 or an ultrawide window; HUD items keep their edge distance; the mobile pass (390x844) implemented and verified unless the user scoped mobile out.
- Code style matches the profile: hand-authored React + Tailwind for standard sites; replay only where `recommendedScaffold.replay` allowed it.
- The page opens on the hero; the hero renders within ~1 s on a production build; scrolling interpolates (no stepped states).
- `npm run build` of the clone succeeds with no TypeScript errors; no console errors (third-party library warnings noted).
- `CLONE_NOTES.md` has the profile, iteration log, asset-licensing notes and deviations.
- Final message to the user: per-state similarity, iteration count, what is and is not matched, and licensing caveats. No third-party assets committed or published.

## Troubleshooting
- **Page never finishes loading:** expected on heavy sites; navigation proceeds after DOMContentLoaded and a bounded `load` wait.
- **Loader never completes within budget:** raise `readyTimeoutMs`; check `gates.remainingBlocker`.
- **Wrong control clicked / nothing clicked:** pass `entrySelector`.
- **Stale target content:** delete `.clone-output/_http-cache/` or set `PIXEL_CLONE_NO_CACHE=1`.
- **`Read` of large PNGs blocked by a hook:** make a downscaled copy to inspect, but keep the full-resolution files for the diff.
