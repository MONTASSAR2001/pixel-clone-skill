"use client";

/**
 * Error boundary for replay layers: a failure in one layer (WebGL unavailable, malformed keyframe, GPU reset) is logged
 * and that layer renders nothing, instead of replacing the whole page with Next's error screen.
 */
import { Component, type ReactNode } from "react";

export class ReplayBoundary extends Component<{ name: string; children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[replay] ${this.props.name} failed; the rest of the page keeps running.`, error);
    const w = window as unknown as { __replay?: Record<string, unknown> };
    if (w.__replay) w.__replay.error = `${this.props.name}: ${String((error as Error)?.message ?? error)}`;
  }
  render() {
    return this.state.failed ? this.props.fallback ?? null : this.props.children;
  }
}
