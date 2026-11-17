import type { Page, Response } from "playwright";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface SavedAsset {
  url: string;
  kind: "image" | "svg" | "font" | "model" | "texture" | "hdr" | "video" | "script-lib" | "other";
  mime: string;
  bytes: number;
  localPath: string;
}

const MAX_BYTES = 40 * 1024 * 1024;

function classify(url: string, mime: string): SavedAsset["kind"] | null {
  const u = url.split("?")[0]!.toLowerCase();
  if (/\.(glb|gltf|fbx|obj|drc|usdz)$/.test(u) || mime.startsWith("model/")) return "model";
  if (/\.(hdr|exr)$/.test(u)) return "hdr";
  if (/\.(ktx2|basis|dds)$/.test(u)) return "texture";
  if (/\.(woff2?|ttf|otf|eot)$/.test(u) || mime.includes("font")) return "font";
  if (/\.(mp4|webm|mov|m4v)$/.test(u) || mime.startsWith("video/")) return "video";
  if (mime === "image/svg+xml" || u.endsWith(".svg")) return "svg";
  if (mime.startsWith("image/")) return "image";
  return null;
}

/** Attach before navigation. Saves media/font/3D responses into `dir`. */
export function collectAssets(page: Page, dir: string, opts: { only?: SavedAsset["kind"][] } = {}) {
  const saved = new Map<string, SavedAsset>();
  const pending: Promise<void>[] = [];
  const urls: { url: string; mime: string; status: number }[] = [];

  const handler = (res: Response) => {
    const url = res.url();
    if (url.startsWith("data:")) return;
    const mime = (res.headers()["content-type"] ?? "").split(";")[0]!.trim();
    urls.push({ url, mime, status: res.status() });
    const kind = classify(url, mime);
    if (!kind || res.status() >= 400 || saved.has(url)) return;
    if (kind === "video" && res.status() !== 200) return; // range responses are partial
    if (opts.only && !opts.only.includes(kind)) return;
    pending.push(
      (async () => {
        try {
          const body = await res.body();
          if (body.length === 0 || body.length > (kind === "video" ? 25 * 1024 * 1024 : MAX_BYTES)) return;
          const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
          const base = path.basename(new URL(url).pathname) || "asset";
          const file = path.join(dir, kind, `${hash}-${base.replace(/[^\w.\-]/g, "_")}`);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, body);
          saved.set(url, { url, kind, mime, bytes: body.length, localPath: file });
        } catch {
          /* redirects / aborted bodies */
        }
      })(),
    );
  };
  page.on("response", handler);
  return {
    async done(): Promise<SavedAsset[]> {
      await Promise.allSettled(pending);
      page.off("response", handler);
      return [...saved.values()];
    },
    responses: urls,
  };
}
