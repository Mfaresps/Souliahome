'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** useLayoutEffect in the browser, useEffect while rendering on the server */
export const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// turning reduced motion on mid-visit also finishes what a script is animating in the components right now (CSS animations
// and transitions stop through the CSS, and useReducedMotion() below re-renders what reads it)
if (typeof window !== 'undefined' && typeof matchMedia === 'function') {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener?.('change', () => {
    if (!mq.matches || !document.getAnimations) return;
    for (const a of document.getAnimations()) {
      const t = (a.effect as KeyframeEffect | null)?.target;
      if (a instanceof CSSAnimation || a instanceof CSSTransition || !(t instanceof Element) || !t.closest('[data-dm]')) continue;
      try { a.finish(); } catch { a.cancel(); }
    }
  });
}

/** True when the visitor asked for less motion, following the setting live as it changes */
export function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduce(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

/** Counts whole seconds while `on` is true, starting from `start` */
export function useSeconds(on: boolean, start = 0) {
  const [secs, setSecs] = useState(start);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setSecs(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [on]);
  return secs;
}

/** Eases a number to `target` over `ms`, so counters roll instead of jumping */
export function useTween(target: number, ms = 1000, from = target) {
  const [value, setValue] = useState(from);
  const cur = useRef(from);
  const reduce = useReducedMotion();
  useEffect(() => {
    const a = cur.current, t0 = performance.now(), dur = reduce ? 1 : ms;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.max(0, Math.min(1, (t - t0) / dur)), x = a + (target - a) * (1 - Math.pow(1 - p, 3));
      cur.current = x; setValue(x);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, reduce]);
  return value;
}

/** State that can be controlled by the parent (value + onChange) or left to the component (defaultValue) */
export function useControllable<T>(value: T | undefined, defaultValue: T, onChange?: (v: T) => void) {
  const [inner, setInner] = useState(defaultValue);
  const controlled = value !== undefined;
  const set = useCallback((v: T) => { if (!controlled) setInner(v); onChange?.(v); }, [controlled, onChange]);
  return [controlled ? value : inner, set] as const;
}

/** Copies text to the clipboard and stays true for `ms`, long enough to show a check mark and a "Copied" tip */
export function useCopied(ms = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    try { navigator.clipboard?.writeText(text).catch(() => {}); } catch { /* the page is not allowed to write to the clipboard */ }
    setCopied(true); clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), ms);
  }, [ms]);
  return [copied, copy] as const;
}
