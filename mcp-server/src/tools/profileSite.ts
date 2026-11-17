import path from "node:path";
import fs from "node:fs/promises";
import { launchBrowser, newContext, gotoAndSettle, outRoot, slugify, ensureDir, type ReadyOptions } from "../lib/browser.js";
import { collectProfile } from "../lib/profile.js";

export interface ProfileInput extends ReadyOptions {
  url: string;
  settleMs?: number;
}

/** Tool 0: classify the target (stack, rendering, gates, scroll model) and recommend a lean scaffold. */
export async function profileSite(input: ProfileInput) {
  const { url, settleMs = 1500, ...ready } = input;
  const dir = await ensureDir(path.join(outRoot(), "profile", slugify(url)));
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser);
    const page = await context.newPage();
    const urls: string[] = [];
    page.on("response", (r) => urls.push(r.url()));
    const gates = await gotoAndSettle(page, url, settleMs, ready);
    const profile = await collectProfile(page, urls, gates);
    const file = path.join(dir, "profile.json");
    await fs.writeFile(file, JSON.stringify(profile, null, 2));
    return { profileJson: file, ...profile };
  } finally {
    await browser.close();
  }
}
