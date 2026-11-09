'use client';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cx } from './cx';
import { useControllable, useIsoLayoutEffect } from './hooks';

export interface PopoverOptions {
  /** Line the popover up with the trigger's start edge (the default) or its end edge */
  align?: 'start' | 'end';
  /** Open above or below the trigger. Left out, it opens below unless there is no room */
  side?: 'up' | 'down';
  /** Whether it is open. Leave it out to let the trigger toggle it */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A menu or panel that opens from a button, placed the way designme.dev places them: under the trigger, or above it
 * when there is no room, and closed by a click outside, Escape or a resize. A menu (`role="menu"` or `"listbox"` on the pop)
 * works from the keyboard: Enter, Space or the down arrow opens it on its picked or first item, the up arrow on its last, the
 * arrows move and wrap, Home and End jump, Tab closes it, and closing gives the focus back to the trigger.
 *
 * Spread `trigger` on the button and `pop` on an element with the dm-pop class that is always rendered
 * (it fades in and out, so it needs to be there to measure). Its nearest positioned ancestor is what it is placed in.
 *
 *   const menu = usePopover({ align: 'end' });
 *   <button {...menu.trigger}>Model</button>
 *   <div {...menu.pop} className={cx(menu.pop.className, 'dm-my-menu')} role="menu">…</div>
 */
export function usePopover({ align = 'start', side, open, defaultOpen = false, onOpenChange }: PopoverOptions = {}) {
  const [isOpen, setOpen] = useControllable(open, defaultOpen, onOpenChange);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const set = useRef(setOpen);
  useEffect(() => { set.current = setOpen; });
  // where the focus goes as it opens: the picked item or the first ('first'), the last ('last'), or nowhere (null)
  const focusTo = useRef<'first' | 'last' | null>(null);
  // whether the focus was inside as it closed, so it goes back to the trigger rather than to the page
  const inside = useRef(false);

  useIsoLayoutEffect(() => {
    const b = btn.current, p = pop.current; if (!isOpen || !b || !p) return;
    const host = (p.offsetParent || p.parentElement) as HTMLElement;
    const hr = host.getBoundingClientRect(), br = b.getBoundingClientRect();
    const up = side === 'up' || (side !== 'down' && br.bottom + p.offsetHeight + 12 > innerHeight && br.top - p.offsetHeight > 12);
    let x = align === 'end' ? br.right - hr.left - p.offsetWidth : br.left - hr.left;
    x = Math.max(-hr.left + 8, Math.min(x, innerWidth - hr.left - p.offsetWidth - 8));
    setPlace({ left: x, top: up ? br.top - hr.top - p.offsetHeight - 6 : br.bottom - hr.top + 6, ['--dm-origin' as string]: `${up ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}` });
  }, [isOpen, align, side]);

  // opened from the keyboard, a menu takes the focus; closed with the focus inside, the trigger gets it back
  useIsoLayoutEffect(() => {
    const p = pop.current;
    if (isOpen) {
      const to = focusTo.current; focusTo.current = null;
      if (to && p && isMenu(p)) {
        const it = menuItems(p), on = it.find(x => x.getAttribute('aria-checked') === 'true' || x.getAttribute('aria-selected') === 'true');
        (to === 'last' ? it[it.length - 1] : on || it[0])?.focus({ preventScroll: true });
      }
      return;
    }
    if (inside.current || (p && p.contains(document.activeElement))) { inside.current = false; btn.current?.focus({ preventScroll: true }); }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!pop.current?.contains(t) && !btn.current?.contains(t)) set.current(false); };
    const key = (e: KeyboardEvent) => {
      const p = pop.current, t = e.target as HTMLElement;
      if (e.key === 'Escape') { set.current(false); btn.current?.focus(); return; }
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !p || !p.contains(t) || !isMenu(p)) return;
      // Tab moves on from the trigger and closes the menu
      if (e.key === 'Tab') { btn.current?.focus({ preventScroll: true }); inside.current = false; set.current(false); return; }
      // a field in a menu (a search, a web address) keeps its own keys
      if (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable) return;
      const to = step(menuItems(p), document.activeElement, e.key);
      if (to) { e.preventDefault(); to.focus({ preventScroll: true }); }
    };
    const track = (e: FocusEvent) => { inside.current = !!pop.current?.contains(e.target as Node); };
    // a real resize closes it; a page's own resize events (a layout settling) leave it open
    const resize = (e: UIEvent) => { if (e.isTrusted) set.current(false); };
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key); document.addEventListener('focusin', track); addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); document.removeEventListener('focusin', track); removeEventListener('resize', resize); };
  }, [isOpen]);

  const close = () => setOpen(false);
  return {
    open: isOpen,
    setOpen,
    close,
    /** Closes a moment after a choice, so the pick shows before the menu fades, as on designme.dev */
    closeSoon: () => setTimeout(() => set.current(false), 120),
    /** Opens it with the focus on the picked item or the first ('first'), or on the last ('last'), as the keyboard does */
    openFocused: (where: 'first' | 'last' = 'first') => { focusTo.current = where; setOpen(true); },
    trigger: {
      ref: btn, 'aria-expanded': isOpen, 'aria-haspopup': 'menu' as const,
      /** Enter or Space (a click with no pointer) opens a menu with the focus on its picked item, or its first */
      onClick: (e?: { detail?: number }) => { if (!isOpen && e && e.detail === 0) focusTo.current = 'first'; setOpen(!isOpen); },
      /** The down and up arrows open a menu on its first or last item */
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const p = pop.current; if (!p || !isMenu(p)) return;
        e.preventDefault();
        const where = e.key === 'ArrowUp' ? 'last' : 'first';
        if (isOpen) { const it = menuItems(p); (where === 'last' ? it[it.length - 1] : it[0])?.focus({ preventScroll: true }); }
        else { focusTo.current = where; setOpen(true); }
      }
    },
    pop: { ref: pop, className: cx('dm-pop', isOpen && 'dm-open'), style: place, inert: !isOpen }
  };
}

/* the keyboard in a popover menu, the WAI-ARIA menu button pattern: up and down move through the items and wrap at the ends
   (left and right too, in a grid like an emoji picker, where up and down move a row), and Home and End go to the first and
   last. A popover that is a dialog or a form leaves the keys to its component. Components with menus of their own use the
   same helpers */
export const isMenu = (p: HTMLElement) => /^(menu|listbox)$/.test(p.getAttribute('role') || '');
/** Puts the focus on a menu's picked item or its first ('first'), or on its last ('last') */
export function focusMenu(p: HTMLElement, where: 'first' | 'last' = 'first') {
  const it = menuItems(p), on = it.find(x => x.getAttribute('aria-checked') === 'true' || x.getAttribute('aria-selected') === 'true');
  (where === 'last' ? it[it.length - 1] : on || it[0])?.focus({ preventScroll: true });
}
/** The item an arrow key, Home or End moves to from the focused one, or null for any other key */
export const menuStep = (p: HTMLElement, key: string) => step(menuItems(p), document.activeElement, key);
const menuItems = (p: HTMLElement) => Array.from(p.querySelectorAll<HTMLElement>('button,[role^="menuitem"],[role="option"]'))
  .filter(el => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length > 0 && !el.closest('[hidden]'));
function step(items: HTMLElement[], el: Element | null, key: string) {
  const n = items.length, i = items.indexOf(el as HTMLElement); if (!n) return null;
  if (key === 'Home') return items[0];
  if (key === 'End') return items[n - 1];
  const top = items[0].getBoundingClientRect().top, cols = items.filter(x => Math.abs(x.getBoundingClientRect().top - top) < 2).length, grid = cols > 1 && cols < n;
  const d = ({ ArrowDown: grid ? cols : 1, ArrowUp: grid ? -cols : -1, ArrowRight: grid || cols === n ? 1 : 0, ArrowLeft: grid || cols === n ? -1 : 0 } as Record<string, number>)[key];
  if (!d) return null;
  if (i < 0) return d > 0 ? items[0] : items[n - 1];
  return items[((i + d) % n + n) % n];
}
