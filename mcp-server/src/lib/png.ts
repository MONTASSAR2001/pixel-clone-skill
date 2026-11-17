import { PNG } from "pngjs";
import fs from "node:fs/promises";

export function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}
export async function writePng(file: string, png: PNG): Promise<void> {
  await fs.writeFile(file, PNG.sync.write(png));
}
export { PNG };
