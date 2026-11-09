'use client';
import { useEffect, useRef, useState } from 'react';

/** Formats a count the way the charts print them, like 12,400 */
export const formatCount = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Hands `value` to `count` items one after another, `step` ms apart, so bars and rows redraw in a wave.
 * Returns what each item shows now: null until the first wave reaches it. The first wave waits `delay` ms,
 * the way the site's charts draw a moment after they appear; later changes start straight away.
 */
export function useStagger<T extends string | number>(value: T, count: number, step: number, delay = 0) {
  const [shown, setShown] = useState<(T | null)[]>(() => Array(count).fill(null));
  // set once a wave has reached the first item, so a remount in Strict Mode still waits the first time
  const started = useRef(false);
  useEffect(() => {
    const wait = started.current ? 0 : delay;
    const timers = Array.from({ length: count }, (_, i) => setTimeout(() => {
      started.current = true;
      setShown(s => { const next = Array.from({ length: count }, (_, k) => s[k] ?? null); next[i] = value; return next; });
    }, wait + i * step));
    return () => timers.forEach(clearTimeout);
  }, [value, count, step]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown.length === count ? shown : Array.from({ length: count }, (_, k) => shown[k] ?? null);
}
