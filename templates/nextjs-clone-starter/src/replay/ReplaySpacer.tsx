"use client";

import { useDocHeight } from "./replayData";

/**
 * In-flow spacer that gives the document the target's scroll length for the current window size (the replay layers
 * are fixed overlays). Use instead of a hard-coded `min-height: <px>` on <body>.
 */
export function ReplaySpacer({ fallback = "100vh" }: { fallback?: string }) {
  const h = useDocHeight();
  return <div aria-hidden style={{ height: h ? `${h}px` : fallback, width: "1px", pointerEvents: "none" }} />;
}
