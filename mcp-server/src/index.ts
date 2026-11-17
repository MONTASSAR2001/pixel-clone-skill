#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractDomAndStyles } from "./tools/extractDomAndStyles.js";
import { captureMotionTimeline } from "./tools/captureMotionTimeline.js";
import { inspectWebglScene } from "./tools/inspectWebglScene.js";
import { compareVisualDiff } from "./tools/compareVisualDiff.js";
import { profileSite } from "./tools/profileSite.js";
import { scanPageSections } from "./tools/scanPageSections.js";

const server = new McpServer({ name: "pixel-clone", version: "0.2.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    const e = err as Error;
    return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
  }
}

const url = z.string().url().describe("Absolute http(s) URL of the page");

/** Shared options for pages behind cookie banners, age gates, preloaders or "Enter" screens. */
const ready = {
  entrySelector: z.string().optional().describe("CSS selector of an explicit 'enter' control to click (escape hatch; gates are auto-detected otherwise)"),
  dismissOverlays: z.boolean().optional().describe("Auto-dismiss cookie banners / age gates / enter screens and wait out preloaders (default true)"),
  readyTimeoutMs: z.number().int().min(1000).max(180000).optional().describe("Budget for gates/preloaders (default 40000)"),
  loadTimeoutMs: z.number().int().min(1000).max(120000).optional().describe("How long to wait for the window load event (default 12000); heavy sites may never fire it"),
};

server.registerTool(
  "profile_site",
  {
    title: "Profile the target site and recommend a lean scaffold",
    description:
      "Run this FIRST. Loads the URL (clearing cookie banners, age gates, preloaders and 'Enter' screens), then reports the stack (React/Next/Nuxt/Vue/Webflow/...), " +
      "animation libraries (GSAP/ScrollTrigger/ScrollSmoother/Lenis/Framer/WAAPI), rendering (WebGL1/2, Three.js, canvas 2D, video, audio), scroll model (native vs virtual), " +
      "fixed layers, shadow DOM and iframes, plus recommendedScaffold {three, canvas2d, gsap, framerMotion, lenis} so 2D sites stay free of 3D dependencies.",
    inputSchema: { url, settleMs: z.number().int().min(0).max(20000).optional(), ...ready },
  },
  (args) => run(() => profileSite(args)),
);

server.registerTool(
  "scan_page_sections",
  {
    title: "Full-height section & scene inventory",
    description:
      "Run after profile_site. Scrolls the ENTIRE page in viewport steps and records per slice what is visible: text blocks (with font size/colour), " +
      "section containers, images/videos, fixed layers, and the WebGL passes + textures drawn. Groups consecutive slices into section candidates and " +
      "writes inventory.md. Every section in it is mandatory: a hero-only or partial clone is not acceptable.",
    inputSchema: {
      url,
      maxSlices: z.number().int().min(2).max(60).optional(),
      sliceStep: z.number().int().min(100).max(4000).optional(),
      sliceWaitMs: z.number().int().min(0).max(20000).optional().describe("Real-time wait after each scroll (default 2000)"),
      settleMs: z.number().int().min(0).max(20000).optional(),
      traceGl: z.boolean().optional().describe("Record WebGL passes/textures per slice (default true)"),
      ...ready,
    },
  },
  (args) => run(() => scanPageSections(args)),
);

server.registerTool(
  "extract_dom_and_styles",
  {
    title: "Extract DOM, computed styles, tokens, fonts and assets",
    description:
      "Loads the URL at 1440x900 (DSF 1) in Chromium over CDP, then re-measures every element at 1920x1080 and fits a responsive rule per element " +
      "(left/right/center anchored, full-bleed stretch, proportional vw scale, fluid type; responsive-rules.json + blueprint.responsive, incl. " +
      "hardcodeTraps such as a right-anchored fixed box whose computed left resolves to px). Returns a flat BFS DOM list with computed styles + page-space bounding boxes, " +
      "::before/::after content, inline SVG, design tokens (colors, type scale, spacing, radii, shadows), CSS custom properties, @font-face rules " +
      "(+ downloaded files), @keyframes, media-query breakpoints and downloaded images/fonts/3D models. Full JSON is written to disk (extractionJson).",
    inputSchema: {
      url,
      maxNodes: z.number().int().min(50).max(10000).optional().describe("Max DOM nodes walked (default 3000)"),
      responseNodes: z.number().int().min(10).max(2000).optional().describe("Nodes included in the reply (default 250); the file has all"),
      scrollY: z.number().int().min(0).optional().describe("Extract the page as seen at this scroll position (scroll-driven sections reveal only at their range)"),
      scrollWaitMs: z.number().int().min(0).max(30000).optional(),
      downloadAssets: z.boolean().optional().describe("Save images/fonts/models locally (default true)"),
      viewports: z.array(z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2400) })).min(1).max(4).optional()
        .describe("Viewports to measure; the first is primary (default [{1440,900},{1920,1080}]). One viewport disables the responsive fit"),
      mobile: z.union([z.boolean(), z.object({ width: z.number().int().min(280).max(1024), height: z.number().int().min(480).max(1600) })]).optional()
        .describe("Optional mobile pass (true = 390x844, mobile-emulated): hidden/mobile-only elements, nav toggles, stacked grids, type scale, mobile height"),
      settleMs: z.number().int().min(0).max(20000).optional(),
      ...ready,
    },
  },
  (args) => run(() => extractDomAndStyles(args)),
);

server.registerTool(
  "capture_motion_timeline",
  {
    title: "Capture scroll/hover motion timeline",
    description:
      "Freezes time (Playwright page.clock for JS timers/rAF; CDP Animation domain for CSS), steps through scroll positions and hover triggers, and records " +
      "exact keyframes (transform/opacity/...), duration, delay and cubic-bezier easing for every CSS animation/transition, sampled values at fixed progress, " +
      "class/style mutations tied to scrollY, plus GSAP tweens and ScrollTrigger config when the library is reachable.",
    inputSchema: {
      url,
      scrollSteps: z.number().int().min(1).max(40).optional().describe("Number of scroll intervals (default 8)"),
      hoverTargets: z.number().int().min(0).max(40).optional().describe("Max hover candidates (default 10)"),
      samplesPerAnimation: z.number().int().min(2).max(20).optional(),
      virtualTime: z.boolean().optional().describe("Deterministic virtual clock for rAF/performance.now/Date.now, stepped frame by frame (default true)"),
      settleMs: z.number().int().min(0).max(20000).optional(),
      ...ready,
    },
  },
  (args) => run(() => captureMotionTimeline(args)),
);

server.registerTool(
  "inspect_webgl_scene",
  {
    title: "Inspect Three.js / WebGL scene",
    description:
      "Injects hooks before page scripts run to capture Three.js renderers/scenes (via __THREE_DEVTOOLS__), the live camera (position, rotation, FOV, near/far), " +
      "lights, every mesh's geometry + material (incl. ShaderMaterial uniforms) and raw GLSL from gl.shaderSource for any engine. Downloads .glb/.gltf/HDR assets. " +
      "Returns { webgl: false } when no WebGL is present. Uses SwiftShader software GL, so it works without a GPU.",
    inputSchema: {
      url,
      settleMs: z.number().int().min(0).max(30000).optional().describe("Wait for the scene to initialise (default 4000)"),
      maxObjects: z.number().int().min(10).max(5000).optional(),
      includeShaders: z.boolean().optional().describe("Include GLSL source (default true)"),
      frameTrace: z.boolean().optional().describe("Record one frame of GL commands (pass graph: framebuffers, textures, state, per-draw uniforms) to webgl-frame-trace.json"),
      scrollCheckpoints: z.array(z.number().min(0).max(1)).max(12).optional().describe("Scroll fractions at which to re-sample camera/uniforms, e.g. [0,0.5,1]"),
      ...ready,
    },
  },
  (args) => run(() => inspectWebglScene(args)),
);

server.registerTool(
  "compare_visual_diff",
  {
    title: "Full-page visual diff: every vertical slice + interactive states",
    description:
      "Captures target and local at a fixed viewport (default 1440x900, DSF 1) slice by slice over the ENTIRE scroll height " +
      "(consecutive viewport-height slices, max 20 by default; taller pages are sampled evenly over the full height), then hover, an auto-detected " +
      "menu-open state and any `interactions` (menus, modals, tabs). Runs pixelmatch per capture, writes target/local/diff PNGs plus overview.png " +
      "(all slices: target | local | diff). pass=true only if EVERY slice and state >= minSimilarity (default 99) AND document scrollHeight matches " +
      "within heightTolerance (default 2%). Hotspots carry pageY (page coordinates). mode 'states' is a legacy 5-snapshot check that never passes.",
    inputSchema: {
      targetUrl: url.describe("The reference site"),
      localUrl: url.describe("The clone, e.g. http://localhost:3000"),
      freezeMedia: z.boolean().optional().describe("Pause playing videos for each capture so dump and screenshot see the same frame, then resume (default true)"),
      viewports: z.array(z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2400), mobile: z.boolean().optional() })).optional().describe("Default [{1440,900}]. Mobile: {width:390,height:844,mobile:true}. Verify responsive clones with [{1440,900},{1920,1080}]; with dumpReplayTo each viewport gets its own replay variant (<dir>/<W>x<H>/)"),
      threshold: z.number().min(0).max(1).optional().describe("pixelmatch colour threshold (default 0.05; lower = stricter)"),
      minSimilarity: z.number().min(0).max(100).optional().describe("Pass threshold in percent (default 99)"),
      hoverSelector: z.string().optional().describe("CSS selector to hover on both pages (default: auto-pick on target)"),
      settleMs: z.number().int().min(0).max(20000).optional(),
      freezeTime: z.boolean().optional().describe("Deterministic virtual time (rAF/performance.now/Date.now stepped in fixed frames). Use for canvas/WebGL or JS-animated pages (default false)"),
      settleFrames: z.number().int().min(0).max(600).optional().describe("Virtual frames stepped after load (default 60). Lower for GL-heavy pages"),
      stateFrames: z.number().int().min(0).max(300).optional().describe("Virtual frames stepped before each state screenshot (default 30). Lower for GL-heavy pages"),
      screenshotTimeoutMs: z.number().int().min(5000).max(900000).optional().describe("Per-screenshot timeout (default 180000)"),
      reuseTarget: z.boolean().optional().describe("Re-use cached TARGET captures from a previous identical run (saves minutes per loop iteration)"),
      wheelDeltas: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Cumulative wheel px for 25%/50%/bottom when the document does not scroll (default [600,1200,2400])"),
      mode: z.enum(["fullpage", "states"]).optional().describe("fullpage (default): slice the whole page; states: legacy 5 snapshots, never passes"),
      maxSlices: z.number().int().min(2).max(60).optional().describe("Max vertical slices (default 20); taller pages are sampled evenly over the full height"),
      sliceStep: z.number().int().min(100).max(4000).optional().describe("Distance between slices in px (default viewport height)"),
      virtualScrollHeight: z.number().int().min(100).max(200000).optional().describe("Wheel-driven (virtual scroll) pages: scroll length to slice, in wheel px"),
      sliceWaitMs: z.number().int().min(0).max(20000).optional().describe("Wait after each scroll before capture (default min(settleMs,800)); raise for eased scroll animation"),
      scrollUnlockTimeoutMs: z.number().int().min(0).max(120000).optional().describe("Keep probing a scroll-locked intro until scrolling works (default 20000)"),
      stableTimeoutMs: z.number().int().min(0).max(60000).optional().describe("After each scroll, wait until the visible DOM stops changing, up to this long (default 10000; 0 disables)"),
      dumpReplayTo: z.string().optional().describe("Also capture replay state (three.js scenes + DOM layer) from the TARGET session right before each screenshot into this folder (one sub-folder per viewport when several are given). state-top-return is only kept when the post-scroll top genuinely differs from the initial hero"),
      dumpExclude: z.array(z.string()).max(30).optional().describe("Selectors excluded from the DOM dump (default [\"canvas\"])"),
      heightTolerance: z.number().min(0).max(0.5).optional().describe("Max relative scrollHeight difference for a pass (default 0.02)"),
      autoMenu: z.boolean().optional().describe("Auto-detect a menu toggle and capture the opened state (default true)"),
      interactions: z.array(z.object({
        name: z.string(), scrollY: z.number().int().min(0).optional(), hover: z.string().optional(), click: z.string().optional(),
        press: z.string().optional(), waitMs: z.number().int().min(0).max(20000).optional(),
      })).max(20).optional().describe("Extra interactive states: selectors are resolved on the target and replayed at the same coordinates on the clone"),
      outputDir: z.string().optional(),
      ...ready,
    },
  },
  (args) => run(() => compareVisualDiff(args)),
);

await server.connect(new StdioServerTransport());
console.error("[pixel-clone] MCP server ready on stdio");
