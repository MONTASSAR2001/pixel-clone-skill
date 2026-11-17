"use client";

import { Canvas, type CanvasProps } from "@react-three/fiber";
import type { ReactNode } from "react";
import { ClientOnly } from "./ClientOnly";

/**
 * Thin R3F wrapper. Fill every prop from inspect_webgl_scene -> renderers[0] / activeCamera.
 * Nothing is defaulted on purpose: pass the measured values.
 *
 * <CloneCanvas
 *   camera={{ position: [0, 0, 5], fov: 45, near: 0.1, far: 100 }}
 *   dpr={1}
 *   gl={{ antialias: true, alpha: true }}
 *   style={{ position: "fixed", inset: 0 }}
 * >
 *   <ambientLight intensity={0.5} />
 *   <mesh>...</mesh>
 * </CloneCanvas>
 */
export function CloneCanvas({ children, ...props }: CanvasProps & { children?: ReactNode }) {
  return (
    <ClientOnly>
      <Canvas {...props}>{children}</Canvas>
    </ClientOnly>
  );
}
