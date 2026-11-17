import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // R3F/drei ship ESM that Next should transpile for the client bundle.
  transpilePackages: ["three"],
  // The dev-mode "N" badge is painted into the page and shows up in pixel diffs.
  devIndicators: false,
  // NEXT_DIST_DIR=.next-verify builds/serves a second copy (e.g. a verification build on another port) without
  // touching the build a running `next start` is serving.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
