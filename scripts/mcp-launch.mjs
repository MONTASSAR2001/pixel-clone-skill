#!/usr/bin/env node
/**
 * Entry point for every MCP client (Claude Code plugin, Cursor, Windsurf, Antigravity, Gemini CLI, `claude mcp add`).
 *
 * Starts the pixel-clone MCP server over stdio. On a fresh checkout (a git clone, a marketplace/extension install)
 * there is no node_modules and no compiled mcp-server/dist yet: the launcher installs dependencies and builds once,
 * then starts. Everything it prints goes to stderr, because stdout carries the MCP protocol.
 *
 * The one-time bootstrap skips the ~150 MB Chromium download to start quickly; the server then uses the system
 * Chrome. Run `npm run setup` in the skill directory for the bundled, reproducible Chromium.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "mcp-server", "dist", "index.js");
const depsReady = () => existsSync(path.join(root, "node_modules", "@modelcontextprotocol", "sdk")) && existsSync(path.join(root, "node_modules", "playwright"));
const log = (m) => process.stderr.write(`[pixel-clone] ${m}\n`);
const npm = (args, env = {}) => {
  const isWin = process.platform === "win32";
  const r = spawnSync(isWin ? "npm.cmd" : "npm", args, { cwd: root, stdio: ["ignore", process.stderr, process.stderr], env: { ...process.env, ...env }, shell: isWin });
  return r.status === 0;
};

if (!depsReady() || !existsSync(entry)) {
  log("first start: installing dependencies and building the MCP server (one time)...");
  if (!depsReady() && !npm(["install", "--no-audit", "--no-fund"], { PIXEL_CLONE_SKIP_BROWSER_DOWNLOAD: "1" })) {
    log(`dependency install failed. Run \`npm run setup\` in ${root} and restart your MCP client.`);
    process.exit(1);
  }
  if (!existsSync(entry) && !npm(["run", "build"])) {
    log(`build failed. Run \`npm run setup\` in ${root} and restart your MCP client.`);
    process.exit(1);
  }
  log("ready. For the bundled Chromium (reproducible rendering) run `npm run setup` once; until then system Chrome is used.");
}

await import(pathToFileURL(entry).href);
