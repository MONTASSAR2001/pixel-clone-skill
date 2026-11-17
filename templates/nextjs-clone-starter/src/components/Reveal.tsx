"use client";

import { motion, type HTMLMotionProps } from "framer-motion";

type Bezier = [number, number, number, number];

interface RevealProps extends HTMLMotionProps<"div"> {
  /** Values come from capture_motion_timeline keyframes. Nothing here is a design default. */
  from: { opacity?: number; x?: number; y?: number; scale?: number; rotate?: number };
  duration: number; // seconds
  ease: Bezier; // exact cubic-bezier from the target
  delay?: number; // seconds
  /** IntersectionObserver amount (0..1) that reproduces the target's trigger scroll position. */
  amount?: number;
  once?: boolean;
}

export function Reveal({ from, duration, ease, delay = 0, amount = 0.2, once = true, ...rest }: RevealProps) {
  return (
    <motion.div
      initial={from}
      whileInView={{ opacity: 1, x: 0, y: 0, scale: 1, rotate: 0 }}
      viewport={{ once, amount }}
      transition={{ duration, ease, delay }}
      {...rest}
    />
  );
}
