# pixel-clone-skill

An Agent Skill + local MCP server that **reverse-engineers a website you own or have permission to replicate** into a clean
**Next.js (App Router) + Tailwind CSS** project (GSAP / Framer Motion / Lenis / React Three Fiber only when the target uses
them), then proves accuracy with a **full-page, multi-viewport pixelmatch loop** until every slice and interactive state is
≥ 99% identical, or reports honestly why not.

One repository, every agent: the skill is a root `SKILL.md` in the [Agent Skills](https://agentskills.io) format, the tools are a
standard stdio MCP server.

| Client | Skill | MCP server |
|---|---|---|
| Claude Code | plugin marketplace (skill + server in one step), or `npx skills add` | bundled in the plugin, or `claude mcp add` |
| Cursor | `npx skills add` | `~/.cursor/mcp.json` |
| Windsurf / Devin Local | `npx skills add` | `~/.codeium/windsurf/mcp_config.json` / `~/.config/devin/mcp_config.json` |
| Antigravity (app, IDE, CLI) | `npx skills add`, or `~/.gemini/config/skills/` | `~/.gemini/config/mcp_config.json` |
| Gemini CLI | extension (`gemini-extension.json`: context + server) | bundled in the extension, or `~/.gemini/settings.json` |

## Install

Requires Node ≥ 20.9 and git. In the commands below, replace `<owner>` with the GitHub account that hosts this repository.

### 1. Get the skill

```bash
npx skills add <owner>/pixel-clone-skill
```

`npx skills add` discovers the root `SKILL.md` and installs it for the agents it supports (Claude Code, Cursor, Windsurf, Antigravity
and others; see `npx skills --help`). Alternatively clone the repository anywhere and point your agent at it (paths below).

### 2. Set up the MCP server (one command)

```bash
cd <path-to>/pixel-clone-skill
npm run setup     # npm install + build mcp-server + download Playwright's Chromium (~150 MB)
```

Every config below starts the server through `scripts/mcp-launch.mjs`. If `npm run setup` was never run (a fresh plugin or extension
install), the launcher installs and builds on the first start (about 15 s, logged to stderr) and uses your system Chrome until you run
`npm run setup` for the bundled Chromium. Use absolute paths in the snippets.

### Claude Code

**Plugin (skill + MCP server together):**

```bash
claude plugin marketplace add <owner>/pixel-clone-skill
claude plugin install pixel-clone@pixel-clone-skill
```

The marketplace (`.claude-plugin/marketplace.json`) lists this repository root as the `pixel-clone` plugin; `.claude-plugin/plugin.json`
bundles the root `SKILL.md` and the MCP server (`${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launch.mjs`). Also available in a session through `/plugin`.

**Manual:** add the skill with `npx skills add`, then register the server:

```bash
claude mcp add pixel-clone -- node /abs/path/to/pixel-clone-skill/scripts/mcp-launch.mjs
```

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "pixel-clone": {
      "command": "node",
      "args": ["/abs/path/to/pixel-clone-skill/scripts/mcp-launch.mjs"]
    }
  }
}
```

### Windsurf / Devin Local

Windsurf reads `~/.codeium/windsurf/mcp_config.json`. Windsurf's current documentation now lives under Devin Local, whose files are
`~/.config/devin/mcp_config.json` (user), `.devin/mcp_config.json` (project) and `%APPDATA%\devin\mcp_config.json` (Windows). Same shape:

```json
{
  "mcpServers": {
    "pixel-clone": {
      "command": "node",
      "args": ["/abs/path/to/pixel-clone-skill/scripts/mcp-launch.mjs"]
    }
  }
}
```

### Antigravity

- **Skill:** `npx skills add`, or place the repository (it is a skill folder) at `~/.gemini/config/skills/pixel-clone/` (all workspaces) or
  `<workspace>/.agents/skills/pixel-clone/` (one workspace).
- **MCP server:** `~/.gemini/config/mcp_config.json` (global) or `<workspace>/.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "pixel-clone": {
      "command": "node",
      "args": ["/abs/path/to/pixel-clone-skill/scripts/mcp-launch.mjs"]
    }
  }
}
```

### Gemini CLI

Gemini CLI's own documentation marks it as superseded by the Antigravity CLI (above). For Gemini CLI installs:

```bash
gemini extensions install https://github.com/<owner>/pixel-clone-skill
```

`gemini-extension.json` loads `SKILL.md` as the extension's context and starts the MCP server from the extension directory. Or add the server
to `~/.gemini/settings.json` (all projects) or `.gemini/settings.json` (one project):

```json
{
  "mcpServers": {
    "pixel-clone": {
      "command": "node",
      "args": ["/abs/path/to/pixel-clone-skill/scripts/mcp-launch.mjs"]
    }
  }
}
```

> **Long tool calls.** A full-page diff of a GL-heavy site under software GL can take 10-30 minutes (a fresh target capture
> waits for scroll-triggered transitions to settle on every slice). Raise your MCP client's tool timeout (Claude Code:
> `MCP_TOOL_TIMEOUT=3600000`; Gemini CLI: `"timeout"` in ms on the server entry), and use `reuseTarget: true` so loop
> iterations only re-capture the clone.

### Use it

> "Clone https://example.com into ./my-clone. Follow the pixel-clone skill."

The agent profiles the site, scaffolds `templates/nextjs-clone-starter/` with only what the site needs, extracts, writes the
sections, and loops on `compare_visual_diff` while logging each iteration to `CLONE_NOTES.md`.

## Universal by design

The skill adapts to what the target actually is. `profile_site` classifies it first; everything after follows the profile.

| Target | What the profile finds | What changes |
|---|---|---|
| Static / SaaS / e-commerce / blog / dashboard | no full-screen canvas pipeline | lean scaffold, **hand-authored React + Tailwind** from `design-blueprint.json`; no three / R3F, no replay runtime |
| GSAP / Lenis / ScrollSmoother site | animation libs, scroll model | smooth-scroll curve captured (`estimatedLerpPerFrame`), virtual scrollers detected |
| WebGL / Three.js widget or scene | contexts, renderer, canvas coverage | R3F scaffold; camera, materials, GLSL, uniforms, textures, models extracted |
| Bespoke scroll-driven WebGL pipeline | viewport-covering canvas + scroll-driven page (`recommendedScaffold.replay`) | dump-and-replay allowed for the canvas-driven sections only |
| Gated site | cookie banner, age gate, preloader, "Enter" screen | cleared automatically (`waitForInteractiveReady`), or via `entrySelector` |

Robustness for heavy sites: navigation tolerates pages whose `load` event never fires; loader waits extend while the % advances; static assets are cached on disk (`.clone-output/_http-cache`, disable with `PIXEL_CLONE_NO_CACHE=1`).

```bash
node scripts/scaffold.mjs ./my-clone --profile .clone-output/profile/<slug>/profile.json   # only the deps the site needs
```

> No tool can honestly promise 100% on every site. Video, live data, ads, third-party iframes, bot walls and GPU-specific rasterization cap what is achievable; the skill's loop therefore has explicit stop conditions and must report the real numbers.

## How it works

| Phase | What happens |
|---|---|
| 0 Profile | Clear gates, classify the site, choose the scaffold (hand-authored vs replay) |
| 1 Deep Extraction | DOM, computed styles, tokens, fonts, assets, responsive rules (1440x900 + 1920x1080, optional 390x844 mobile), motion, WebGL scenes, full-height section inventory |
| 2 Code Synthesis | Components written from the *measured* values only (strict anti-slop rules in `SKILL.md`) |
| 3 Full-page Diff | Every vertical slice + hover/menu/interaction states, per viewport, compared with `pixelmatch`; page height gate |
| 4 Self-Healing | Read the red diff mask, find the root cause, fix, re-diff, repeat until ≥ 99% (or an honest stop condition) |

## MCP tools

| Tool | Purpose |
|---|---|
| `scan_page_sections(url)` | Full-height inventory: per viewport slice, visible text, containers, media, fixed layers and WebGL passes/textures, grouped into section candidates (`inventory.md`). Every section is mandatory |
| `profile_site(url)` | Run first. Clears gates, then reports stack, animation libs, rendering (WebGL1/2, Three.js, canvas 2D), video/audio, scroll model, fixed layers, shadow DOM/iframes, and `recommendedScaffold` |
| `extract_dom_and_styles(url)` | Flat DOM with computed styles + page-space boxes, `::before/::after`, inline SVG, design tokens, CSS variables, `@font-face`, `@keyframes`, breakpoints; downloads images/fonts/`.glb`/`.gltf`. Measures every element at 1440x900 **and** 1920x1080 and fits a responsive rule per element (`responsive-rules.json`: full-bleed, right/bottom-anchored HUD, centered, vw-proportional, fluid type, and `hardcodeTraps` such as a resolved `left: 1299px`) |
| `capture_motion_timeline(url)` | Deterministic virtual clock + CDP `Animation`; steps scroll checkpoints frame by frame (transform/opacity/clip-path deltas), hover triggers; exact keyframes, duration, `cubic-bezier`; scroll model + smooth-scroll curve (lerp, settle frames); mutation log vs scroll; GSAP/ScrollTrigger config |
| `inspect_webgl_scene(url)` | WebGL1 + WebGL2 hooks (`frameTrace: true` records the ordered GL command stream of a frame, passes and per-draw uniforms): Three.js renderer/camera (matrices, FOV)/lights/meshes/materials/textures; raw GLSL, linked programs, last-set uniforms, texture/buffer uploads, draw counts; scroll-checkpoint re-sampling; downloads models/KTX2/HDR |
| `compare_visual_diff(targetUrl, localUrl, …)` | **Full-page segmented diff**: every viewport slice from top to bottom (max 20, sampled evenly beyond), plus hover, auto-detected menu and custom `interactions`. Pass = every slice and state ≥ 99% **and** scrollHeight within 2%. Writes `overview.png` (all slices: target / clone / diff). Handles scroll-locked intros, virtual scrollers (`virtualScrollHeight`), DOM settle waits, `freezeTime` virtual time. Several `viewports` (e.g. 1440x900 + 1920x1080) are verified in one run; `dumpReplayTo` captures replay state per viewport in the compared session |

All results are also written as JSON/PNG under `.clone-output/` (override with `PIXEL_CLONE_OUT`).

### Full-page, never hero-only

A clone is judged on the **whole page**: `scan_page_sections` builds the section inventory, each section becomes its own component, and `compare_visual_diff` slices the full scroll height. A page that is missing sections fails the height gate before any pixel is compared; the legacy 5-state mode can never pass.

### Hand-authored first; replay only for bespoke canvas pipelines

`profile_site` sets `recommendedScaffold.replay` only for a viewport-covering WebGL/canvas pipeline on a scroll-driven page. Standard sites (SaaS, e-commerce, blogs, dashboards) are written as clean React + Tailwind components from the design blueprint, and the scaffold omits the replay runtime entirely. `extract_dom_and_styles({ mobile: true })` adds a 390x844 mobile pass (hidden/mobile-only elements, nav toggles, stacked grids, type scale).

### Responsive, hero-first, progressive, smooth

Clones must fill any screen: extraction reports which elements are full-bleed, edge-anchored or proportional, and `SKILL.md` forbids hard-coded 1440/900 geometry. The page always opens on the target's hero; a different "top after scrolling back" is reproduced only when the target really has one.

For scroll-driven experiences whose sections are bespoke three.js pipelines (render targets, MaskPass stencils, custom shaders), `compare_visual_diff`'s `dumpReplayTo` (or `scripts/three-scene-dump.mjs` / `dom-layer-dump.mjs`, both with `--viewports`) captures the target's per-frame pass list, scenes, exact GLSL, uniforms and DOM layer at every slice and viewport. The DOM layer keeps rotations/skews as exact matrices, `::before/::after` boxes, self-contained SVG and transition curves. `scripts/stage-replay.mjs` stages one variant per viewport with per-keyframe geometry chunks and cross-viewport anchors. The template runtime (`src/replay/`):

| | |
|---|---|
| Responsive | picks the closest captured viewport variant, renders at the window size (renderer, projections, screen-sized render targets, resolution uniforms, `viewport`/`scissor` follow `resize`), anchors every DOM box (fitted rule or full-bleed/edge heuristic), document height per viewport (`<ReplaySpacer/>`) |
| Progressive | hero UI server-rendered (painted before any script); hero data requested by an inline script before hydration; WebGL hero drawn as soon as its geometry chunk and per-pass precompiled programs are ready, textures streaming in; optional baked hero poster (`scripts/bake-hero-poster.mjs`, rendered from the clone itself) cross-fades to the live canvas; every other keyframe streams in by distance |
| Smooth | one damped scroll clock; matrices (decompose + slerp), projections, numeric uniforms, opacities and DOM boxes interpolate between keyframes; render-on-change |
| Interactive | UI states (menu, hover) applied as deltas at any scroll position with the target's own transition curves |
| Layered | each DOM box carries its measured paint order relative to the WebGL canvas (`zLayer`): "behind" boxes render under the canvas, the rest above |
| Timeline-synced | videos (DOM and WebGL textures) start at the recorded `currentTime`; held on that frame during visual diffs (`freezeMedia`) |
| Resilient | no WebGL / GPU reset: the UI layers and hero poster stay, the 3D layer rebuilds on context restore; every layer has an error boundary |

See SKILL.md for the trade-offs.

### Similarity definition

`similarity = (1 − diffPixels / totalPixels) × 100` per state, using `pixelmatch` with `threshold: 0.05` (strict: ~4/255 colour
drift is flagged), anti-aliased pixels ignored, viewport screenshots at `deviceScaleFactor: 1` with CSS animations disabled.
`pass` is true only when **every** state ≥ `minSimilarity` (default 99).

### Rendering & reproducibility

Chromium runs with `--use-gl=angle --use-angle=swiftshader --enable-webgl --ignore-gpu-blocklist`, so WebGL works without a GPU on
Linux, macOS, Windows and CI. Bundled Playwright Chromium is preferred; system Chrome is the automatic fallback.
Environment variables: `PIXEL_CLONE_OUT` (output dir), `PIXEL_CLONE_SKIP_BROWSER_DOWNLOAD=1` (skip Chromium download on install), `PIXEL_CLONE_NO_CACHE=1` (disable the static-asset cache).

### CLI helpers

```bash
# call any tool from the shell (artifacts go to $PIXEL_CLONE_OUT or ./.clone-output)
node scripts/call-tool.mjs compare_visual_diff '{"targetUrl":"https://…","localUrl":"http://localhost:3000","freezeTime":true}'

# per-draw GL uniforms for N frames on the virtual clock (rebuilds animated multi-pass shaders from measurements)
node scripts/gl-trace-series.mjs https://… 240 series.json --match sprite=<GLSL marker> --match final=<GLSL marker>

# runtime checks of a replay clone: first paint, WebGL hero, full-bleed coverage, fps + interpolation while scrolling
node scripts/verify-clone.mjs http://localhost:3000 --viewports 1440x900,1920x1080,2560x1080 --gpu

# bake the hero poster (the clone's own complete hero render) per viewport variant, then rebuild
node scripts/bake-hero-poster.mjs http://localhost:3000 ./my-clone

# turn a diff run into README-ready "target | clone | diff" composites
node scripts/side-by-side.mjs <outputDir from the report> <out dir> 0.4
```

## Verify your install

```bash
npm test                      # unit tests (CSS parsing, blueprint builder, responsive fitter, replay runtime math)
npm run test:e2e              # fixtures + live URLs
E2E_LIVE=0 npm run test:e2e   # fixtures only (offline except the three.js CDN)
```

The fixture suite checks exact extraction values, cubic-bezier recovery, frozen-time sampling, hover capture, Three.js camera/material/shader
capture, 100% on identical pages, detection of a deliberate colour change, and that `freezeTime` makes an animated WebGL page match itself.

## Limitations (read before relying on it)

- ≥ 99% is realistic for static layouts. Video, carousels, ads, live data, third-party iframes and time-based WebGL animation can cap the score;
  the skill's loop has stop conditions and must report the real number rather than claim success.
- GSAP/Three.js bundled privately are still discovered through the Three.js devtools hook and runtime motion capture, but GSAP tween
  details are only listed when `window.gsap` is reachable; otherwise easing is inferred from sampled values.
- Software GL (SwiftShader) output can differ slightly from GPU rendering, and heavy scenes can cost seconds per frame (use `settleFrames`/`stateFrames`).
- Load-driven animations (preloaders, intro timelines) start at a wall-clock-dependent frame, so two captures of the *same* page can differ (one real site scored 97% against itself). Pin the target with `reuseTarget`, measure target-vs-target first, and report both numbers.
- Bot-protected sites, auth walls and signed asset URLs may block extraction.
- **Legal/ethical:** use only on sites you own or have permission to replicate. Do not ship third-party copy, imagery, fonts or 3D models
  without a licence; the skill keeps them as local placeholders and records them in `CLONE_NOTES.md`.

## Repository layout

```
SKILL.md                         the skill: workflow, rules, diagnosis table (Agent Skills format)
.claude-plugin/                  Claude Code plugin + marketplace manifests (skill + MCP server)
gemini-extension.json            Gemini CLI extension manifest
mcp-server/src                   TypeScript MCP server (Playwright + CDP + pixelmatch); built to mcp-server/dist
scripts/                         mcp-launch (entry for every client), postinstall, dump/stage/verify/bake helpers, e2e + fixtures
templates/nextjs-clone-starter   Next.js + Tailwind v4 starter (+ GSAP, Framer Motion, R3F, replay runtime, kept per profile)
test/                            unit tests
```

Clone outputs, captures and caches go to `.clone-output/` (gitignored): nothing a run produces is ever committed.

MIT licensed.
