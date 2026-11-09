'use client';
import { cloneElement, isValidElement, useEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';
import { useIsoLayoutEffect, useReducedMotion } from './hooks';
import { Icon } from './icons';

/* ---------- status glyphs ---------- */
/** Four dots turning: the agent is thinking */
export const Think = ({ on = true, className }: { on?: boolean; className?: string }) => (
  <span className={cx('dm-think', on && 'dm-on', className)} aria-hidden="true"><i /><i /><i /><i /></span>
);
/** A ring spinning: work in progress */
export const Spin = () => <span className="dm-spin" aria-hidden="true" />;
/** A dot with a sweeping ring: reading or searching */
export const Radar = () => <span className="dm-radar" aria-hidden="true" />;
/** A grey dot with a soft ping: the step happening now */
export const Pulse = () => <span className="dm-pulse" aria-hidden="true" />;
/** Three bars rising and falling */
export const Bars = () => <span className="dm-bars3" aria-hidden="true"><i /><i /><i /></span>;
/** A small round dot, coloured by `color` (or currentColor) */
export const Dot = ({ color }: { color?: string }) => <span className="dm-dot" style={color ? { color } : undefined} aria-hidden="true" />;

/* ---------- text that changes ---------- */
/** Text that blurs out and back in when it changes */
export function Swap({ children, className, style }: { children: string; className?: string; style?: CSSProperties }) {
  const [shown, setShown] = useState(children);
  const [out, setOut] = useState(false);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (children === shown) { setOut(false); return; }
    setOut(true);
    const t = setTimeout(() => { setShown(children); setOut(false); }, reduce ? 0 : 170);
    return () => clearTimeout(t);
  }, [children, shown, reduce]);
  return <span className={cx('dm-sw', out && 'dm-out', className)} style={style}>{shown}</span>;
}

/* ---------- layout ---------- */
/** A panel that folds open and shut by its height */
export function Fold({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  return <div className={cx('dm-fold', !open && 'dm-shut', className)} inert={!open} aria-hidden={!open}><div>{children}</div></div>;
}

/** Segmented control with a sliding knob */
export function Seg<T extends string>({ options, value, onChange, label, className }: {
  // T comes from value, so options and onChange are checked against it rather than widening it
  options: { value: NoInfer<T>; label: ReactNode }[]; value: T; onChange: (v: NoInfer<T>) => void; label: string; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<CSSProperties>({});
  useIsoLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const place = () => { const b = el.querySelector<HTMLElement>('[aria-pressed="true"]'); if (b) setKnob({ left: b.offsetLeft, width: b.offsetWidth }); };
    place();
    const ro = new ResizeObserver(place); ro.observe(el);
    return () => ro.disconnect();
  }, [value, options.length]);
  return (
    <div className={cx('dm-seg2', className)} role="group" aria-label={label} ref={ref}>
      <span className="dm-knob" style={knob} />
      {options.map(o => <button type="button" key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

/* ---------- tooltip ---------- */
// when the last visible tip closed, shared by every Tip on the page
let tipSeen = -Infinity;
type Handlers = { onPointerEnter?: (e: PointerEvent) => void; onPointerLeave?: (e: PointerEvent) => void; onFocus?: (e: FocusEvent) => void; onBlur?: (e: FocusEvent) => void; ref?: Ref<Element> };
const setRef = (ref: Ref<Element> | undefined, node: Element | null) => { if (typeof ref === 'function') ref(node); else if (ref) (ref as RefObject<Element | null>).current = node; };

/** Shows `label` above the element it wraps, after a short pause, the same way the site does.
    `kbd` adds a shortcut after the label, `open` shows it straight away (for feedback like "Copied"),
    and `off` keeps it hidden, for example while the button's own menu is open.
    A single HTML element is used as is, so the tip adds nothing to the layout; anything else gets a display:contents wrapper. */
export function Tip({ label, kbd, open: forced, off, side = 'top', children }: { label: string; kbd?: string; open?: boolean; off?: boolean; side?: 'top' | 'bottom'; children: ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number; r: DOMRect } | null>(null);
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tip = useRef<HTMLDivElement>(null);
  const target = useRef<Element | null>(null);
  // whether the pointer is on the target: a tip opened from code and then let go stays while the pointer is on it
  const over = useRef(false);
  const open = (el: Element | null | undefined, now = false) => {
    if (!el) return; clearTimeout(timer.current);
    // moving straight from one tip to the next shows it at once, as on the site
    timer.current = setTimeout(() => setAt({ x: 0, y: 0, r: el.getBoundingClientRect() }), now || performance.now() - tipSeen < 120 ? 0 : 380);
  };
  const close = () => { clearTimeout(timer.current); if (tip.current) tipSeen = performance.now(); setShow(false); setAt(null); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (forced) open(target.current, true); else if (!over.current) close(); }, [forced]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (off) close(); }, [off]);
  // a new label can change the width, so place it again
  useIsoLayoutEffect(() => { setAt(a => a && { ...a, x: 0, y: 0 }); }, [label, kbd]);
  // place it above the target, or below when there is no room (side="bottom" tries below first, for a target with a
  // header just above it), then fade it in
  useIsoLayoutEffect(() => {
    const t = tip.current; if (!at || !t || (at.x || at.y)) return;
    const w = t.offsetWidth, h = t.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, at.r.left + at.r.width / 2 - w / 2));
    const up = at.r.top - h - 8, down = at.r.bottom + 8;
    const y = side === 'bottom' ? (down + h > innerHeight - 8 ? up : down) : (up < 8 ? down : up);
    setAt({ ...at, x, y }); requestAnimationFrame(() => setShow(true));
  }, [at]);

  const enterEl = (el: Element | null) => { over.current = true; if (!off) open(el); };
  const leave = () => { over.current = false; if (!forced) close(); };
  const focus = (el: Element) => { if (!off && el.matches(':focus-visible')) open(el, true); };
  const portal = at && typeof document !== 'undefined' && createPortal(
    <div ref={tip} className={cx('dm-tip', show && 'dm-show')} role="tooltip" data-dm="" style={{ left: at.x, top: at.y }}>{label}{kbd && <span className="dm-kbd">{kbd}</span>}</div>, document.body);

  if (isValidElement<Handlers>(children) && typeof children.type === 'string') {
    const own = children.props;
    return <>{cloneElement(children, {
      ref: (node: Element | null) => { target.current = node; setRef(own.ref, node); },
      onPointerEnter: (e: PointerEvent) => { own.onPointerEnter?.(e); enterEl(e.currentTarget as Element); },
      onPointerLeave: (e: PointerEvent) => { own.onPointerLeave?.(e); leave(); },
      onFocus: (e: FocusEvent) => { own.onFocus?.(e); focus(e.target as Element); },
      onBlur: (e: FocusEvent) => { own.onBlur?.(e); leave(); }
    })}{portal}</>;
  }
  return (
    <span ref={el => { target.current = el?.firstElementChild ?? null; }} style={{ display: 'contents' }}
      onPointerEnter={e => enterEl(e.currentTarget.firstElementChild)} onPointerLeave={leave}
      onFocus={e => focus(e.target)} onBlur={leave}>
      {children}{portal}
    </span>
  );
}

/** The ink for initials on an avatar colour: each of the eight avatar colours, 'var(--dm-av-b)' to 'var(--dm-av-t)', has its
    own (white, or a dark ink of its hue where white would fail contrast). Any other colour returns undefined, and the
    initials stay white */
export const avatarInk = (color: string) => /^var\(--dm-av-[a-z]\)$/.test(color) ? color.replace(')', '-ink)') : undefined;

/** A round avatar with initials, on a colour like 'var(--dm-av-l)' */
export const Avatar = ({ initials, color, size, className }: { initials: string; color: string; size?: number; className?: string }) => (
  <span className={cx('dm-av', className)} style={{ background: color, color: avatarInk(color), ...(size && { width: size, height: size }) }} aria-hidden="true">{initials}</span>
);

/* ---------- sources ---------- */
export type SourceKind = 'figma' | 'web' | 'ts' | 'tsx' | 'css' | 'csv' | 'pdf';
export interface Source { label: string; kind?: SourceKind; tip?: string; onClick?: () => void }
const FT: Partial<Record<SourceKind, string>> = { tsx: 'dm-re', csv: 'dm-csv', pdf: 'dm-pdf' };
/** A file or link chip, with its type in front */
export function SourceChip({ source, className, style, tipSide }: { source: Source; className?: string; style?: CSSProperties; tipSide?: 'top' | 'bottom' }) {
  const { label, kind, tip, onClick } = source;
  const mark = kind === 'figma' ? <Icon name="figma" size="xs" /> : kind === 'web' ? <Icon name="globe" size="xs" />
    : kind ? <span className={cx('dm-ft', FT[kind])}>{kind.toUpperCase()}</span> : null;
  const chip = <button type="button" className={cx('dm-fchip dm-lnk', className)} style={style} onClick={onClick}>{mark}{label}</button>;
  return tip ? <Tip label={tip} side={tipSide}>{chip}</Tip> : chip;
}

/** Plays the entrance animation, `delay` ms late, the first time it renders */
export const enter = (delay = 0): { className: string; style: CSSProperties } => ({ className: 'dm-enter', style: { animationDelay: delay + 'ms' } });
