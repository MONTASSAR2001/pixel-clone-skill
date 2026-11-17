#!/usr/bin/env node
/**
 * Adaptive scaffolding: copy templates/nextjs-clone-starter and keep ONLY what the target needs.
 *
 *   node scripts/scaffold.mjs <outDir> [--profile profile.json] [--three auto|on|off] [--gsap auto|on|off]
 *                              [--framer auto|on|off] [--lenis auto|on|off] [--replay auto|on|off]
 *
 * --replay: the dump-and-replay runtime (src/replay, src/lib/replayState.ts) is kept ONLY when profile_site recommends
 * it (bespoke scroll-driven WebGL/canvas pipeline). Standard sites get no replay code: they are hand-authored.
 *
 * With --profile (output of profile_site) every `auto` follows recommendedScaffold.
 * Without a profile `auto` is lean: no three/R3F, no lenis; gsap + framer-motion kept.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tpl = path.join(root, "templates", "nextjs-clone-starter");

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
const flag = (name, dflt = "auto") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
if (!out) {
  console.error("usage: node scripts/scaffold.mjs <outDir> [--profile profile.json] [--three auto|on|off] [--gsap ...] [--framer ...] [--lenis ...]");
  process.exit(2);
}
const profileFile = flag("profile", "");
const rec = profileFile ? JSON.parse(fs.readFileSync(profileFile, "utf8")).recommendedScaffold ?? {} : null;
const resolve = (name, recKey, leanDefault) => {
  const v = flag(name);
  if (v === "on") return true;
  if (v === "off") return false;
  return rec ? !!rec[recKey] : leanDefault;
};
const use = {
  three: resolve("three", "three", false),
  gsap: resolve("gsap", "gsap", true),
  framer: resolve("framer", "framerMotion", true),
  lenis: resolve("lenis", "lenis", false),
  replay: resolve("replay", "replay", false),
};

if (fs.existsSync(out) && fs.readdirSync(out).length) {
  console.error(`refusing to scaffold into non-empty directory: ${out}`);
  process.exit(1);
}
fs.cpSync(tpl, out, {
  recursive: true,
  filter: (src) => !/(node_modules|\.next|next-env\.d\.ts|tsbuildinfo)/.test(src),
});

const pkgPath = path.join(out, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const drop = (names, files = []) => {
  for (const n of names) { delete pkg.dependencies[n]; delete pkg.devDependencies[n]; }
  for (const f of files) fs.rmSync(path.join(out, f), { force: true });
};
if (!use.three) {
  drop(["three", "@react-three/fiber", "@react-three/drei", "@types/three"], ["src/components/CloneCanvas.tsx", "src/replay/ThreeReplay.tsx"]);
  const nc = path.join(out, "next.config.ts");
  fs.writeFileSync(nc, fs.readFileSync(nc, "utf8").replace(/\s*\/\/ R3F[^\n]*\n\s*transpilePackages: \["three"\],/, ""));
}
if (!use.replay) {
  // Standard site: no data-driven replay layers; sections are written by hand from the blueprint.
  fs.rmSync(path.join(out, "src/replay"), { recursive: true, force: true });
  fs.rmSync(path.join(out, "src/lib/replayState.ts"), { force: true });
  const pg = path.join(out, "src/app/page.tsx");
  fs.writeFileSync(pg, fs.readFileSync(pg, "utf8").replace(/\/\/\n\/\/ Dump-and-replay sections[\s\S]*?\/\/   }\n/, ""));
}
if (!use.gsap) drop(["gsap"], ["src/lib/gsap.ts", "src/components/useScrollTrigger.ts"]);
if (!use.framer) drop(["framer-motion"], ["src/components/Reveal.tsx"]);
if (use.lenis) {
  pkg.dependencies["lenis"] = "^1.3.0";
  fs.writeFileSync(path.join(out, "src/components/SmoothScroll.tsx"), `"use client";

import Lenis from "lenis";
import { useEffect } from "react";

/**
 * Smooth scrolling. Fill \`options\` from capture_motion_timeline -> smoothScroll
 * (settledFrame / samples tell you the lerp or duration to match).
 */
export function SmoothScroll({ options }: { options?: ConstructorParameters<typeof Lenis>[0] }) {
  useEffect(() => {
    const lenis = new Lenis(options);
    let id = requestAnimationFrame(function raf(t) {
      lenis.raf(t);
      id = requestAnimationFrame(raf);
    });
    return () => {
      cancelAnimationFrame(id);
      lenis.destroy();
    };
  }, [options]);
  return null;
}
`);
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(path.join(out, "SCAFFOLD.json"), JSON.stringify({ generatedBy: "pixel-clone scaffold", profile: profileFile || null, include: use, notes: rec?.notes ?? [] }, null, 2) + "\n");
console.log(JSON.stringify({ out, include: use, dependencies: Object.keys(pkg.dependencies) }));
