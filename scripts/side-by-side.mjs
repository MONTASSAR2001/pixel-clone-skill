#!/usr/bin/env node
/**
 * Build README-ready composites from a compare_visual_diff run directory.
 *   node scripts/side-by-side.mjs <runDir> <outDir> [scale=0.4]
 * Writes <outDir>/compare-<state>.png (TARGET | CLONE | DIFF, labelled) and <outDir>/report.json
 * (absolute paths stripped so it is safe to commit).
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const [, , runDir, outDir, scaleArg = "0.4"] = process.argv;
if (!runDir || !outDir) {
  console.error("usage: node scripts/side-by-side.mjs <runDir> <outDir> [scale]");
  process.exit(2);
}
const scale = Number(scaleArg);
const report = JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
fs.mkdirSync(outDir, { recursive: true });

// 5x7 bitmap font for the few glyphs the labels need.
const G = {
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"], A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"], G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"], O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"], D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"], F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"], "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"], "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"], "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};
function text(img, str, x, y, px, rgb) {
  for (const ch of str.toUpperCase()) {
    const g = G[ch] ?? G[" "];
    g.forEach((row, r) => [...row].forEach((bit, c) => {
      if (bit !== "1") return;
      for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) {
        const i = ((y + r * px + dy) * img.width + x + c * px + dx) * 4;
        img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
      }
    }));
    x += 6 * px;
  }
}
function downscale(src, s) {
  const w = Math.round(src.width * s), h = Math.round(src.height * s), dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x / s), y0 = Math.floor(y / s), x1 = Math.min(src.width, Math.ceil((x + 1) / s)), y1 = Math.min(src.height, Math.ceil((y + 1) / s));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * src.width + xx) * 4; r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++; }
    const o = (y * w + x) * 4; dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = b / n; dst.data[o + 3] = 255;
  }
  return dst;
}

const vp = report.viewports[0];
// Report paths are absolute; fall back to the run directory if the run was moved.
const resolveFile = (f) => (fs.existsSync(f) ? f : path.join(runDir, `${vp.viewport.width}x${vp.viewport.height}`, path.basename(f)));
const GAP = 10, BAR = 34, bg = [28, 30, 36];
for (const st of vp.states) {
  const panels = [["TARGET", st.files.target, [255, 255, 255]], ["CLONE", st.files.local, [255, 255, 255]], [`DIFF ${st.similarity.toFixed(2)}%`, st.files.diff, st.pass ? [90, 220, 130] : [255, 110, 110]]]
    .map(([label, file, color]) => ({ label, color, img: downscale(PNG.sync.read(fs.readFileSync(resolveFile(file))), scale) }));
  const w = panels.reduce((n, p) => n + p.img.width, 0) + GAP * (panels.length + 1), h = panels[0].img.height + BAR + GAP;
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = bg[0]; out.data[i + 1] = bg[1]; out.data[i + 2] = bg[2]; out.data[i + 3] = 255; }
  let x = GAP;
  for (const p of panels) {
    text(out, p.label, x, 10, 3, p.color);
    PNG.bitblt(p.img, out, 0, 0, p.img.width, p.img.height, x, BAR);
    x += p.img.width + GAP;
  }
  fs.writeFileSync(path.join(outDir, `compare-${st.state}.png`), PNG.sync.write(out));
}

// Committable report: strip absolute paths.
const strip = (v) => typeof v === "string" ? v.replace(/^.*\/(target|local|diff)-(\w+)\.png$/, "$1-$2.png").replace(/^\/.*\/diff\/[^/]+$/, "diff-run") : Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)])) : v;
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(strip(report), null, 2));
console.log(`wrote ${vp.states.length} composites + report.json to ${outDir}`);
