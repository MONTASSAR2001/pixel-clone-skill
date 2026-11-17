#!/usr/bin/env node
/**
 * Call one MCP tool from the shell (handy outside an agent):
 *   node scripts/call-tool.mjs compare_visual_diff '{"targetUrl":"https://…","localUrl":"http://localhost:3000"}'
 * Env: PIXEL_CLONE_OUT=<dir> sets where artifacts are written. Prints the tool's JSON to stdout.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [, , tool, rawArgs = "{}"] = process.argv;
if (!tool) {
  console.error("usage: node scripts/call-tool.mjs <tool> '<json args>'");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "call-tool", version: "0.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "mcp-server", "dist", "index.js")],
  env: { ...process.env },
  stderr: "ignore",
}));
const timeout = Number(process.env.PIXEL_CLONE_CALL_TIMEOUT ?? 3 * 3600 * 1000); // full-page diffs of GL-heavy sites can take > 10 min
const r = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) }, undefined, { timeout, resetTimeoutOnProgress: true, maxTotalTimeout: timeout });
await client.close();
console.log(r.content?.[0]?.text ?? "");
process.exit(r.isError ? 1 : 0);
