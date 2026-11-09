'use client';
import { useEffect, useRef, useState, type AnimationEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx';
import { useControllable, useIsoLayoutEffect, useReducedMotion } from '../lib/hooks';
import { Icon } from '../lib/icons';
import { Avatar, Seg, Swap, Think, Tip } from '../lib/motion';
import { usePopover } from '../lib/popover';
import '../designme.css';
import './kanban-board.css';

export type KanbanBoardPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
export type KanbanBoardView = 'board' | 'list';

export interface KanbanBoardColumn {
  key: string;
  /** Like "In progress" */
  title: string;
  /** A shorter name for the tabs of a narrow board and the bulk bar, like "Doing". Defaults to the title */
  short?: string;
  /** A WIP limit: the header shows "2/3", and a warning chip once the column holds more */
  limit?: number;
  /** Cards here are finished: they show no due date, so none of them reads as overdue */
  done?: boolean;
}

export interface KanbanBoardMember {
  id: string;
  name: string;
  initials: string;
  /** An avatar colour, like 'var(--dm-av-l)' */
  color: string;
  /** An agent: a card it is assigned to with a `progress` says what it is doing */
  agent?: boolean;
}

export interface KanbanBoardSubtask {
  title: string;
  done?: boolean;
}

export interface KanbanBoardCard {
  id: string;
  /** The key shown on the card, like "DES-142". Defaults to the id */
  code?: string;
  /** The key of the column it sits in */
  column: string;
  title: string;
  priority?: KanbanBoardPriority;
  /** Grey labels, like ['Design', 'Bug'] */
  labels?: string[];
  /** Member ids, shown as initials avatars */
  assignees?: string[];
  /** The due date, 'YYYY-MM-DD'. Before `today` it reads as overdue, in the bad text colour */
  due?: string;
  /** A checklist: the card shows "3/5" with a thin bar, and the details sheet lets you tick them */
  subtasks?: KanbanBoardSubtask[];
  comments?: number;
  attachments?: number;
  /** 0 to 1 while an agent works on it: an accent edge, the thinking mark, what it is doing and a bar that fills */
  progress?: number;
  /** What the agent is doing now, like "Writing the CSS variables". Defaults to the first open subtask */
  activity?: string;
}

export interface KanbanBoardFilters {
  /** Matches a card's title or code */
  query: string;
  assignees: string[];
  labels: string[];
  priorities: KanbanBoardPriority[];
}

export interface KanbanBoardProps {
  /** The board's name, like "Website refresh" */
  title?: string;
  /** Beside the name, like "Sprint 14". Defaults to how many cards are done, when a column is marked `done` */
  subtitle?: string;
  columns: KanbanBoardColumn[];
  /** The people (and agents) on the board: the facepile in the header, the Assignee filter and each card's people menu */
  members?: KanbanBoardMember[];
  /** The labels the Label filter offers. Defaults to every label on the cards */
  labels?: string[];
  /** The cards, in order: a column shows its cards in the order they come here. Leave it out to let the board keep them */
  cards?: KanbanBoardCard[];
  defaultCards?: KanbanBoardCard[];
  onCardsChange?: (cards: KanbanBoardCard[]) => void;
  /** Called when a card lands in a column (dragged, from its Move to menu, or with the bulk bar), with its place among that column's cards */
  onMove?: (id: string, column: string, index: number) => void;
  /** Called when a card's title, priority, people or subtasks change from the board */
  onChange?: (card: KanbanBoardCard) => void;
  /** Called when a card's title is edited */
  onRename?: (id: string, title: string) => void;
  /** The card whose details sheet is open, or null */
  open?: string | null;
  defaultOpen?: string | null;
  onOpen?: (id: string | null) => void;
  filters?: KanbanBoardFilters;
  defaultFilters?: KanbanBoardFilters;
  onFiltersChange?: (filters: KanbanBoardFilters) => void;
  view?: KanbanBoardView;
  defaultView?: KanbanBoardView;
  onViewChange?: (view: KanbanBoardView) => void;
  /** The keys of folded columns */
  collapsed?: string[];
  defaultCollapsed?: string[];
  onCollapsedChange?: (keys: string[]) => void;
  /** The ids of picked cards (Shift- or Cmd-click, Space or x); picking any shows the bar that moves them together */
  selected?: string[];
  defaultSelected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  /** Called with true when a card starts moving with the pointer and false when it lands, for pausing anything that would move cards meanwhile */
  onDraggingChange?: (dragging: boolean) => void;
  /** Makes the card the + buttons add to a column. It goes to the end of the column with its title ready to type */
  newCard?: (column: string) => KanbanBoardCard;
  /** Today, 'YYYY-MM-DD', for due dates. Defaults to the visitor's today */
  today?: string;
  /** The + buttons' label */
  addLabel?: string;
  /** The column a narrow board shows. A board under 640px wide shows one column at a time, picked with tabs that count each
      column's cards. Defaults to the first column */
  column?: string;
  defaultColumn?: string;
  onColumnChange?: (column: string) => void;
  className?: string;
}

const PRIORITY: Record<KanbanBoardPriority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };
const PRIORITIES = Object.keys(PRIORITY) as KanbanBoardPriority[];
const NO_FILTERS: KanbanBoardFilters = { query: '', assignees: [], labels: [], priorities: [] };
const uid = () => 'card-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const toDay = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFrom = (due: string, today: string) => Math.round((toDay(due).getTime() - toDay(today).getTime()) / 864e5);
const dueText = (n: number, due: string) => n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : toDay(due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Priority as three bars that fill from the left; Urgent is the one in colour */
function PriorityMark({ value = 'none' }: { value?: KanbanBoardPriority }) {
  if (value === 'urgent') return <span className="dm-kbx-pu" aria-hidden="true">!</span>;
  return <span className="dm-kbx-pb" data-p={value === 'medium' ? 'med' : value} aria-hidden="true"><i /><i /><i /></span>;
}

type FilterField = 'assignees' | 'labels' | 'priorities';
type Menu = { kind: 'move' | 'priority' | 'assign' | 'column' | 'filter'; id?: string; col?: string; field?: FilterField; from?: 'card' | 'sheet'; btn: HTMLButtonElement };
interface Drag { id: string; w: number; h: number; x: number; y: number }
interface Spot { column: string; before: string | null }

/** A sprint board where you and the agent move cards, with filters, details and keyboard moves. */
export function KanbanBoard({
  title, subtitle, columns, members = [], labels, cards, defaultCards = [], onCardsChange, onMove, onChange, onRename,
  open, defaultOpen = null, onOpen, filters, defaultFilters = NO_FILTERS, onFiltersChange, view, defaultView = 'board', onViewChange,
  collapsed, defaultCollapsed = [], onCollapsedChange, selected, defaultSelected = [], onSelectedChange, onDraggingChange, newCard,
  today: todayProp, addLabel = 'Add card', column, defaultColumn, onColumnChange, className
}: KanbanBoardProps) {
  const [list, setListState] = useControllable(cards, defaultCards, onCardsChange);
  const latest = useRef(list);
  useEffect(() => { latest.current = list; });
  const setList = (next: KanbanBoardCard[]) => { latest.current = next; setListState(next); };
  const [f, setFilters] = useControllable(filters, defaultFilters, onFiltersChange);
  const [mode, setMode] = useControllable(view, defaultView, onViewChange);
  const [shut, setShut] = useControllable(collapsed, defaultCollapsed, onCollapsedChange);
  const [sel, setSel] = useControllable(selected, defaultSelected, onSelectedChange);
  const [peek, setPeek] = useControllable(open, defaultOpen, onOpen);
  const [shown, setShown] = useControllable(column, defaultColumn ?? columns[0]?.key ?? '', onColumnChange);
  const [today] = useState(() => todayProp ?? iso(new Date()));
  const day = todayProp ?? today;
  const reduce = useReducedMotion();

  const root = useRef<HTMLDivElement>(null), wrap = useRef<HTMLDivElement>(null), bar = useRef<HTMLDivElement>(null), sheet = useRef<HTMLElement>(null);
  const cols = useRef(new Map<string, HTMLDivElement>());
  const els = useRef(new Map<string, HTMLDivElement>());
  const who = (id: string) => members.find(m => m.id === id);
  const colOf = (key: string) => columns.find(c => c.key === key);
  const nameOf = (key: string) => colOf(key)?.title ?? key;
  const codeOf = (c: KanbanBoardCard) => c.code ?? c.id;

  // what a screen reader hears after each change
  const [said, setSaid] = useState({ text: '', n: 0 });
  const say = (text: string) => setSaid(s => ({ text, n: s.n + 1 }));

  // whether the board is narrow (one column at a time); the layout itself follows a container query
  const [narrow, setNarrow] = useState(false);
  useIsoLayoutEffect(() => {
    const el = root.current; if (!el) return;
    const fit = () => setNarrow(el.clientWidth < 640);
    fit(); const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- filters ---------- */
  // a card just added stays on show until the filters change, so it never vanishes as you name it
  const kept = useRef(new Set<string>());
  const filtering = !!(f.query || f.assignees.length || f.labels.length || f.priorities.length);
  const matches = (c: KanbanBoardCard) => kept.current.has(c.id) || ((!f.query || `${c.title} ${codeOf(c)}`.toLowerCase().includes(f.query.toLowerCase()))
    && (!f.assignees.length || (c.assignees ?? []).some(a => f.assignees.includes(a)))
    && (!f.labels.length || (c.labels ?? []).some(l => f.labels.includes(l)))
    && (!f.priorities.length || f.priorities.includes(c.priority ?? 'none')));
  const visible = (key: string) => list.filter(c => c.column === key && matches(c));
  const shownCount = list.filter(matches).length;
  const setF = (next: KanbanBoardFilters) => {
    kept.current.clear(); flip.current = true; setFilters(next);
    const n = latest.current.filter(c => (!next.query || `${c.title} ${codeOf(c)}`.toLowerCase().includes(next.query.toLowerCase())) && (!next.assignees.length || (c.assignees ?? []).some(a => next.assignees.includes(a))) && (!next.labels.length || (c.labels ?? []).some(l => next.labels.includes(l))) && (!next.priorities.length || next.priorities.includes(c.priority ?? 'none'))).length;
    const any = !!(next.query || next.assignees.length || next.labels.length || next.priorities.length);
    say(any ? `${n} of ${latest.current.length} cards shown` : `All ${latest.current.length} cards shown`);
  };
  const toggleIn = <T,>(arr: T[], v: T) => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
  const allLabels = labels ?? [...new Set(list.flatMap(c => c.labels ?? []))];

  /* ---------- the cards glide to their new places after a move, a sort or a filter ---------- */
  const flip = useRef(false);
  const rects = useRef(new Map<string, { x: number; y: number }>());
  useIsoLayoutEffect(() => {
    const base = root.current?.getBoundingClientRect(); if (!base) return;
    const now = new Map<string, { x: number; y: number }>();
    els.current.forEach((el, id) => { const r = el.getBoundingClientRect(); now.set(id, { x: r.left - base.left, y: r.top - base.top }); });
    if (flip.current && !reduce) now.forEach((p, id) => {
      const was = rects.current.get(id); if (!was) return;
      const dx = was.x - p.x, dy = was.y - p.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) els.current.get(id)?.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' });
    });
    flip.current = false; rects.current = now;
  });

  // cards that are new, or moved by someone else, come in with the entrance; a dropped card gets its own little pop
  const mounted = useRef(false);
  const seen = useRef(new Map<string, string>());
  useEffect(() => { mounted.current = true; seen.current = new Map(list.map(c => [c.id, c.column])); });
  const landing = useRef<string | null>(null);
  const enters = (c: KanbanBoardCard) => mounted.current && seen.current.get(c.id) !== c.column && landing.current !== c.id && !flip.current;
  const [dropped, setDropped] = useState<{ id: string; n: number } | null>(null);
  useIsoLayoutEffect(() => {
    if (!dropped) return;
    landing.current = null;
    if (!reduce) els.current.get(dropped.id)?.animate([{ transform: 'scale(1.04)' }, { transform: 'none' }], { duration: 350, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }, [dropped]);

  /* ---------- the narrow board's tabs ---------- */
  useIsoLayoutEffect(() => {
    const el = cols.current.get(shown); if (!el || !narrow || mode !== 'board') return;
    el.classList.remove('dm-enter'); void el.offsetWidth; el.classList.add('dm-enter');
  }, [shown]);

  /* ---------- the keyboard's place: one card is in the Tab order ---------- */
  const [focusId, setFocusId] = useState<string | null>(null);
  const reachable = list.filter(c => matches(c) && (narrow && mode === 'board' ? c.column === shown : !shut.includes(c.column)));
  const tabStop = reachable.find(c => c.id === focusId)?.id ?? reachable[0]?.id;
  const focusCard = (id: string) => { setFocusId(id); requestAnimationFrame(() => els.current.get(id)?.focus()); if (peek && peek !== id) setPeek(id); };

  /* ---------- moving ---------- */
  const place = (all: KanbanBoardCard[], card: KanbanBoardCard, to: string, before: string | null = null) => {
    const rest = all.filter(c => c.id !== card.id), moved = { ...card, column: to };
    const at = before ? rest.findIndex(c => c.id === before) : -1;
    if (at < 0) rest.push(moved); else rest.splice(at, 0, moved);
    return { next: rest, index: rest.filter(c => c.column === to).findIndex(c => c.id === card.id) };
  };
  // a move that takes a column over its limit says so
  const limitNote = (all: KanbanBoardCard[], key: string) => { const c = colOf(key); return c?.limit && all.filter(x => x.column === key).length > c.limit ? `, which is over its limit of ${c.limit}` : ''; };
  const moveMany = (ids: string[], to: string) => {
    let all = latest.current; const moved: [string, number][] = [];
    for (const id of ids) { const card = all.find(c => c.id === id); if (!card || card.column === to) continue; const r = place(all, card, to); all = r.next; moved.push([id, r.index]); }
    if (!moved.length) return;
    flip.current = true; setList(all); moved.forEach(([id, i]) => onMove?.(id, to, i));
    const one = all.find(c => c.id === moved[0][0])!;
    say((moved.length === 1 ? `${codeOf(one)} moved to ${nameOf(to)}` : `${moved.length} cards moved to ${nameOf(to)}`) + limitNote(all, to));
  };
  const update = (id: string, patch: Partial<KanbanBoardCard>) => {
    const next = latest.current.map(c => c.id === id ? { ...c, ...patch } : c); setList(next);
    const card = next.find(c => c.id === id); if (card) onChange?.(card);
  };

  /* ---------- picking ---------- */
  const anchor = useRef<string | null>(null);
  const pick = (id: string, range = false) => {
    const card = latest.current.find(c => c.id === id), a = anchor.current && latest.current.find(c => c.id === anchor.current);
    let next: string[];
    if (range && card && a && a.column === card.column && a.id !== id && sel.includes(a.id)) {
      const L = visible(card.column), i = L.findIndex(c => c.id === a.id), j = L.findIndex(c => c.id === id);
      next = [...new Set([...sel, ...L.slice(Math.min(i, j), Math.max(i, j) + 1).map(c => c.id)])];
    } else next = toggleIn(sel, id);
    anchor.current = id; setSel(next); say(`${next.length} selected`);
  };
  const clearPick = () => { anchor.current = null; setSel([]); say('Selection cleared'); };
  const picked = sel.filter(id => list.some(c => c.id === id));

  /* ---------- menus: Move to, priority, people, a column's actions, a filter ---------- */
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = (o: boolean) => { if (!o) setMenu(null); };
  const pops = {
    move: usePopover({ align: 'end', open: menu?.kind === 'move', onOpenChange: closeMenu }),
    priority: usePopover({ align: 'start', open: menu?.kind === 'priority', onOpenChange: closeMenu }),
    assign: usePopover({ align: 'end', open: menu?.kind === 'assign', onOpenChange: closeMenu }),
    column: usePopover({ align: 'end', open: menu?.kind === 'column', onOpenChange: closeMenu }),
    filter: usePopover({ align: 'start', open: menu?.kind === 'filter', onOpenChange: closeMenu })
  };
  const openMenu = (m: Menu, key = false) => {
    if (menu && menu.btn === m.btn) { setMenu(null); return; }
    const p = pops[m.kind]; p.trigger.ref.current = m.btn;
    if (key) p.openFocused();
    setMenu(m);
  };
  const isOpen = (btn: string) => menu && menu.btn.dataset.kbx === btn;
  const cardOpen = (kind: Menu['kind'], id: string) => !!menu && menu.kind === kind && menu.id === id && menu.from === 'card';
  // picked with the keyboard, the focus goes back to the card (or the sheet's field) once the menu has gone
  const refocus = (id: string) => {
    const m = menu; const p = m && pops[m.kind].pop.ref.current;
    if (!m || !p || !p.contains(document.activeElement)) return;
    setTimeout(() => {
      const field = m.from === 'sheet' && sheet.current?.querySelector<HTMLElement>(`[data-kbx="sheet-${m.kind}"]`);
      if (field && field.isConnected) field.focus({ preventScroll: true }); else focusCard(id);
    }, 160);
  };
  const menuCard = menu?.id ? list.find(c => c.id === menu.id) : undefined;
  const moveTo = (to: string) => {
    const card = menuCard; pops.move.closeSoon(); if (!card) return;
    refocus(card.id); if (card.column === to) return; moveMany([card.id], to); if (narrow && !peek) setShown(to);
  };
  const setPriority = (p: KanbanBoardPriority) => {
    const card = menuCard; pops.priority.closeSoon(); if (!card) return;
    refocus(card.id); update(card.id, { priority: p }); say(`${codeOf(card)} priority ${PRIORITY[p]}`);
  };
  const toggleAssignee = (m: string) => {
    const card = menuCard; if (!card) return;
    const has = (card.assignees ?? []).includes(m);
    update(card.id, { assignees: members.map(x => x.id).filter(x => x === m ? !has : (card.assignees ?? []).includes(x)) });
    say(`${who(m)?.name ?? m} ${has ? 'removed from' : 'assigned to'} ${codeOf(card)}`);
  };
  const columnAction = (a: 'add' | 'all' | 'priority' | 'due' | 'fold') => {
    const key = menu?.col; pops.column.closeSoon(); if (!key) return;
    if (a === 'add') return add(key);
    if (a === 'fold') { setShut([...shut, key]); say(`${nameOf(key)} folded`); return; }
    if (a === 'all') { const next = [...new Set([...sel, ...visible(key).map(c => c.id)])]; setSel(next); say(`${next.length} selected`); return; }
    const rank = a === 'priority' ? (c: KanbanBoardCard) => PRIORITIES.indexOf(c.priority ?? 'none') : (c: KanbanBoardCard) => c.due ? daysFrom(c.due, day) : 1e6;
    const mine = latest.current.filter(c => c.column === key).sort((x, y) => rank(x) - rank(y));
    flip.current = true; setList([...latest.current.filter(c => c.column !== key), ...mine]);
    say(`${nameOf(key)} sorted by ${a === 'priority' ? 'priority' : 'due date'}`);
  };

  /* ---------- the details sheet ---------- */
  const [sheetFor, setSheetFor] = useState<string | null>(peek);
  useEffect(() => { if (peek) setSheetFor(peek); }, [peek]);
  const openSheet = (id: string) => { setFocusId(id); if (peek === id) { setPeek(null); return; } setPeek(id); say(`${codeOf(list.find(c => c.id === id)!)} details open`); };
  const closeSheet = (back = false) => { const id = peek; setPeek(null); if (back && id) focusCard(id); };
  useEffect(() => { if (peek && !list.some(c => c.id === peek)) setPeek(null); }, [list, peek]); // eslint-disable-line react-hooks/exhaustive-deps
  const sheetCard = list.find(c => c.id === (peek ?? sheetFor));
  // opened from the keyboard, the sheet takes the focus on its close button
  const focusSheet = useRef(false);
  useEffect(() => { if (peek && focusSheet.current) { focusSheet.current = false; requestAnimationFrame(() => sheet.current?.querySelector<HTMLElement>('.dm-kbx-pk-x')?.focus({ preventScroll: true })); } }, [peek]);

  /* ---------- adding and renaming ---------- */
  const [editing, setEditing] = useState<string | null>(null);
  const add = (key: string) => {
    const card = newCard?.(key) ?? { id: uid(), column: key, title: 'New card', priority: 'none' as const };
    kept.current.add(card.id); if (shut.includes(key)) setShut(shut.filter(k => k !== key)); if (narrow) setShown(key);
    setList([...latest.current, card]); setEditing(card.id);
  };
  const rename = (id: string, text: string) => {
    const card = latest.current.find(c => c.id === id); setEditing(null); if (!card) return;
    const t = text.trim() || (card.title || 'New card');
    if (t !== card.title) { update(id, { title: t }); onRename?.(id, t); }
    setTimeout(() => els.current.get(id)?.focus({ preventScroll: true }), 0);
  };

  /* ---------- the pointer: drag to move, click to open, Shift-click to pick ---------- */
  const [drag, setDrag] = useState<Drag | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const stop = useRef<() => void>(undefined);
  const swallow = useRef(false);
  useEffect(() => () => stop.current?.(), []);
  const down = (card: KanbanBoardCard) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button || editing === card.id || (e.target as Element).closest('button')) return;
    const rc = e.currentTarget.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, list = mode === 'list', w = list ? Math.min(rc.width, 260) : rc.width;
    const ox = Math.min(sx - rc.left, w - 24), oy = list ? 16 : sy - rc.top;
    let moved = false, at: Spot | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!moved) { moved = true; onDraggingChange?.(true); }
      setDrag({ id: card.id, w, h: rc.height, x: ev.clientX - ox, y: ev.clientY - oy });
      const col = document.elementsFromPoint(ev.clientX, ev.clientY).find(x => [...cols.current.values()].includes(x as HTMLDivElement));
      const key = col && [...cols.current.entries()].find(([, el]) => el === col)?.[0];
      setOver(key ?? null);
      if (!key || !col) return;
      // the placeholder goes before the first card whose middle is below the pointer
      const sibs = [...col.querySelectorAll<HTMLElement>('.dm-kbx-list > .dm-kbx-k:not(.dm-drag)')];
      const after = sibs.find(s => { const b = s.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
      at = { column: key, before: after?.dataset.id ?? null };
      setSpot(at);
    };
    const up = (ev: PointerEvent) => {
      stop.current?.();
      if (!moved) return;
      swallow.current = true; setTimeout(() => { swallow.current = false; }, 0);
      if (at && ev.type === 'pointerup') {
        const now = latest.current.find(c => c.id === card.id)!, was = now.column, r = place(latest.current, now, at.column, at.before);
        setList(r.next); onMove?.(card.id, at.column, r.index);
        if (was !== at.column) say(`${codeOf(now)} moved to ${nameOf(at.column)}` + limitNote(r.next, at.column));
      }
      setDrag(null); setSpot(null); setOver(null);
      landing.current = card.id;
      setDropped(d => ({ id: card.id, n: (d?.n ?? 0) + 1 }));
      onDraggingChange?.(false);
    };
    stop.current = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); stop.current = undefined; };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
  };
  const clickT = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clickT.current), []);
  const click = (card: KanbanBoardCard) => (e: ReactMouseEvent<HTMLDivElement>) => {
    if (swallow.current || (e.target as Element).closest('button') || editing === card.id) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) { pick(card.id, e.shiftKey); return; }
    clearTimeout(clickT.current);
    // a click on the title waits a moment, in case it is the first of a double-click that renames the card
    if ((e.target as Element).closest('.dm-t') && e.detail === 1) { clickT.current = setTimeout(() => openSheet(card.id), 240); return; }
    if (e.detail > 1) return;
    openSheet(card.id);
  };

  /* ---------- the keyboard on a card ---------- */
  // arrows move between cards (up and down in a column, left and right across columns), Enter opens the details, Space or x
  // picks, m opens Move to, p the priority, a the people, F2 renames, Escape closes the details or clears what is picked
  const key = (card: KanbanBoardCard) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key, onCard = e.target === e.currentTarget;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'Home' || k === 'End') {
      e.preventDefault();
      const L = mode === 'list' ? columns.filter(c => !shut.includes(c.key)).flatMap(c => visible(c.key)) : visible(card.column), i = L.findIndex(c => c.id === card.id);
      const to = k === 'Home' ? L[0] : k === 'End' ? L[L.length - 1] : L[i + (k === 'ArrowUp' ? -1 : 1)];
      if (!to) return;
      if (e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) { const next = [...new Set([...sel, card.id, to.id])]; anchor.current = to.id; setSel(next); say(`${next.length} selected`); }
      focusCard(to.id); return;
    }
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && mode === 'board') {
      e.preventDefault();
      const d = k === 'ArrowLeft' ? -1 : 1, i = visible(card.column).findIndex(c => c.id === card.id);
      for (let ci = columns.findIndex(c => c.key === card.column) + d; ci >= 0 && ci < columns.length; ci += d) {
        const c = columns[ci]; if (!narrow && shut.includes(c.key)) continue;
        if (narrow) setShown(c.key);
        const L = visible(c.key); if (L.length) { focusCard(L[Math.min(i, L.length - 1)].id); return; }
        if (narrow) return;
      }
      return;
    }
    if (!onCard) return;
    if (k === 'Enter') { e.preventDefault(); if (peek !== card.id) focusSheet.current = true; openSheet(card.id); return; }
    if (k === ' ' || k === 'x') { e.preventDefault(); pick(card.id); return; }
    if (k === 'F2') { e.preventDefault(); setEditing(card.id); return; }
    const kind = ({ m: 'move', p: 'priority', a: 'assign' } as const)[k.toLowerCase() as 'm' | 'p' | 'a'];
    if (kind) { e.preventDefault(); const btn = e.currentTarget.querySelector<HTMLButtonElement>(`[data-kbx="${kind}"]`); if (btn) openMenu({ kind, id: card.id, from: 'card', btn }, true); return; }
    if (k === 'Escape') { if (peek) { e.preventDefault(); closeSheet(); } else if (sel.length) { e.preventDefault(); clearPick(); } }
  };

  /* ---------- view ---------- */
  const [held, setHeld] = useState<number | undefined>(undefined);
  const switchView = (v: KanbanBoardView) => {
    if (v === mode) return;
    // the list keeps the board's height, so the board stays where it is
    const h = (wrap.current?.getBoundingClientRect().height ?? 0) + (narrow && bar.current ? bar.current.offsetHeight + 10 : 0);
    setHeld(v === 'list' ? Math.round(h) : undefined); setMode(v); say(v === 'list' ? 'List view' : 'Board view');
  };

  /* ---------- drawing a card ---------- */
  const meta = (c: KanbanBoardCard) => {
    const col = colOf(c.column), n = c.subtasks?.length ?? 0, d = c.subtasks?.filter(s => s.done).length ?? 0;
    const days = c.due && !col?.done ? daysFrom(c.due, day) : null;
    const out: ReactNode[] = [];
    if (c.labels?.length) out.push(<span key="l" className="dm-kbx-tags">{c.labels.map(l => <span key={l} className="dm-tag">{l}</span>)}</span>);
    if (days != null && c.due) out.push(<Tip key="d" label={days < 0 ? 'Overdue' : 'Due'}><span className={cx('dm-kbx-mt', days < 0 && 'dm-late')}><Icon name="cal" size="xs" />{dueText(days, c.due)}</span></Tip>);
    if (n) out.push(<Tip key="s" label={`${d} of ${n} subtasks done`}><span className={cx('dm-kbx-mt', d === n && 'dm-ok')}><span className="dm-num">{d}/{n}</span><span className="dm-kbx-sb"><i style={{ width: d / n * 100 + '%' }} /></span></span></Tip>);
    if (c.comments) out.push(<Tip key="c" label={plural(c.comments, 'comment')}><span className="dm-kbx-mt"><Icon name="comment" size="xs" /><span className="dm-num">{c.comments}</span></span></Tip>);
    if (c.attachments) out.push(<Tip key="a" label={plural(c.attachments, 'file')}><span className="dm-kbx-mt"><Icon name="clip" size="xs" /><span className="dm-num">{c.attachments}</span></span></Tip>);
    return out;
  };
  const people = (c: KanbanBoardCard) => (c.assignees ?? []).map(who).filter((m): m is KanbanBoardMember => !!m);
  const activity = (c: KanbanBoardCard) => c.activity ?? c.subtasks?.find(s => !s.done)?.title ?? 'Working';
  const describe = (c: KanbanBoardCard) => {
    const days = c.due && !colOf(c.column)?.done ? daysFrom(c.due, day) : null;
    return `${codeOf(c)}, ${c.title}. ${PRIORITY[c.priority ?? 'none']} priority${people(c).length ? ', ' + people(c).map(m => m.name).join(' and ') : ''}${days != null && c.due ? `, due ${dueText(days, c.due)}${days < 0 ? ', overdue' : ''}` : ''}${c.progress != null ? ', the agent is working on it' : ''}${sel.includes(c.id) ? ', selected' : ''}`;
  };
  const face = (c: KanbanBoardCard, ghost = false) => {
    const ps = people(c), names = ps.map(m => m.name).join(', '), pr = c.priority ?? 'none', working = c.progress != null, p = Math.max(0, Math.min(1, c.progress ?? 0));
    const tab = ghost ? undefined : -1;
    const btn = (kind: Menu['kind'], e: ReactMouseEvent<HTMLButtonElement>) => openMenu({ kind, id: c.id, from: 'card', btn: e.currentTarget }, e.detail === 0);
    return (
      <>
        <div className="dm-kbx-k1">
          <button type="button" className="dm-kbx-sel" role="checkbox" aria-checked={sel.includes(c.id)} aria-label={`Select ${codeOf(c)}`} tabIndex={tab} onClick={() => pick(c.id)}><Icon name="check" size="xs" /></button>
          <Tip label={PRIORITY[pr]} off={!!cardOpen('priority', c.id)}>
            <button type="button" className="dm-kbx-pri" data-kbx="priority" data-kbx-id={c.id} aria-haspopup="menu" aria-expanded={!!cardOpen('priority', c.id)} aria-label={`Priority: ${PRIORITY[pr]}`} tabIndex={tab} onClick={e => btn('priority', e)}><PriorityMark value={pr} /></button>
          </Tip>
          <span className="dm-kbx-id dm-num">{codeOf(c)}</span>
          <span className="dm-kbx-sp" />
          <Tip label={names || 'Assign'} off={!!cardOpen('assign', c.id)}>
            <button type="button" className="dm-kbx-who" data-kbx="assign" aria-haspopup="menu" aria-expanded={!!cardOpen('assign', c.id)} aria-label={`Assignees: ${names || 'none'}`} tabIndex={tab} onClick={e => btn('assign', e)}>
              {ps.length ? ps.map(m => <Avatar key={m.id} initials={m.initials} color={m.color} />) : <span className="dm-none"><Icon name="user" size="xs" /></span>}
            </button>
          </Tip>
          <Tip label="Move to" off={!!cardOpen('move', c.id)}>
            <button type="button" className="dm-kbx-mv" data-kbx="move" aria-haspopup="menu" aria-expanded={!!cardOpen('move', c.id)} aria-label={`Move ${codeOf(c)}`} tabIndex={tab} onClick={e => btn('move', e)}><Icon name="more" size="xs" /></button>
          </Tip>
        </div>
        <Title card={c} editing={!ghost && editing === c.id} onDone={t => rename(c.id, t)} onCancel={() => { setEditing(null); setTimeout(() => els.current.get(c.id)?.focus({ preventScroll: true }), 0); }} />
        {working && <>
          <div className="dm-kbx-ag"><Think /><Swap className="dm-s">{activity(c)}</Swap><span className="dm-pc dm-num">{Math.round(p * 100)}%</span></div>
          <div className="dm-kbx-pr"><i style={{ width: p * 100 + '%' }} /></div>
        </>}
        <div className="dm-kbx-m">{meta(c)}</div>
      </>
    );
  };

  /* ---------- the board ---------- */
  const doneCols = columns.filter(c => c.done).map(c => c.key);
  const sub = subtitle ?? (doneCols.length ? `${list.filter(c => doneCols.includes(c.column)).length} of ${list.length} done` : undefined);
  const chip = (field: FilterField, name: string) => {
    const v = field === 'assignees' ? f.assignees.map(id => who(id)?.name.split(' ')[0] ?? id) : field === 'labels' ? f.labels : f.priorities.map(p => PRIORITY[p]);
    return (
      <button key={field} type="button" data-kbx={`filter-${field}`} className={cx('dm-chip dm-sm dm-kbx-f', v.length > 0 && 'dm-on')} aria-haspopup="menu" aria-expanded={!!isOpen(`filter-${field}`)}
        onClick={e => openMenu({ kind: 'filter', field, btn: e.currentTarget }, e.detail === 0)}>
        <span className="dm-k">{name}{v.length ? ':' : ''}</span><span className="dm-v">{v.length > 1 ? `${v.length} picked` : v[0] ?? ''}</span><Icon name="chev-d" size="xs" />
      </button>
    );
  };
  const ghostCard = drag && list.find(c => c.id === drag.id);
  const fm = menu?.kind === 'filter' ? menu.field : undefined;
  const fOpts: { v: string; label: ReactNode; n: number }[] = fm === 'assignees' ? members.map(m => ({ v: m.id, label: <><Avatar initials={m.initials} color={m.color} /><span>{m.name}</span></>, n: list.filter(c => (c.assignees ?? []).includes(m.id)).length }))
    : fm === 'labels' ? allLabels.map(l => ({ v: l, label: <span>{l}</span>, n: list.filter(c => (c.labels ?? []).includes(l)).length }))
    : fm === 'priorities' ? PRIORITIES.map(p => ({ v: p, label: <><PriorityMark value={p} /><span>{PRIORITY[p]}</span></>, n: list.filter(c => (c.priority ?? 'none') === p).length })) : [];
  const fName = { assignees: 'Assignee', labels: 'Label', priorities: 'Priority' } as const;

  return (
    <div data-dm="" ref={root} className={cx('dm-kbx', mode === 'list' && 'dm-list', picked.length > 0 && 'dm-selecting', className)}
      onKeyDown={e => { if (e.key === 'Escape' && picked.length && !menu && !(e.target as Element).closest('.dm-kbx-k,.dm-kbx-q')) clearPick(); }}>
      <div className="dm-kbx-hd">
        <div className="dm-kbx-ti">{title && <b>{title}</b>}{sub && <span className="dm-num">{sub}</span>}</div>
        {members.length > 0 && (
          <div className={cx('dm-kbx-fp', f.assignees.length > 0 && 'dm-some')} role="group" aria-label="Filter by person">
            {members.map(m => (
              <Tip key={m.id} label={m.name}>
                <button type="button" aria-pressed={f.assignees.includes(m.id)} aria-label={m.name} onClick={() => setF({ ...f, assignees: toggleIn(f.assignees, m.id) })}><Avatar initials={m.initials} color={m.color} /></button>
              </Tip>
            ))}
          </div>
        )}
        <span className="dm-kbx-sp" />
        <label className="dm-kbx-q">
          <Icon name="search" size="xs" />
          <input type="search" placeholder="Search cards" aria-label="Search cards" autoComplete="off" value={f.query}
            onChange={e => setF({ ...f, query: e.target.value })} onKeyDown={e => { if (e.key === 'Escape' && f.query) { e.stopPropagation(); setF({ ...f, query: '' }); } }} />
          {f.query && <button type="button" className="dm-ib dm-kbx-qx" aria-label="Clear the search" onClick={e => { setF({ ...f, query: '' }); (e.currentTarget.previousElementSibling as HTMLInputElement | null)?.focus(); }}><Icon name="x" size="xs" /></button>}
        </label>
        <Seg className="dm-kbx-vw" label="View" value={mode} onChange={switchView}
          options={[{ value: 'board', label: <><Icon name="grid" size="xs" /><span className="dm-lb">Board</span></> }, { value: 'list', label: <><Icon name="list" size="xs" /><span className="dm-lb">List</span></> }]} />
      </div>
      <div className="dm-kbx-fl">
        {members.length > 0 && chip('assignees', 'Assignee')}
        {allLabels.length > 0 && chip('labels', 'Label')}
        {chip('priorities', 'Priority')}
        {filtering && <button type="button" className="dm-pill dm-ghost dm-sm dm-kbx-clr" onClick={() => setF(NO_FILTERS)}>Clear</button>}
        <span className="dm-kbx-sp" />
        <span className="dm-kbx-cnt dm-num">{filtering ? `${shownCount} of ${list.length} cards` : plural(list.length, 'card')}</span>
      </div>
      <div ref={bar} className="dm-kbx-bar">
        <Seg className="dm-kbx-tabs" label="Column" value={shown} onChange={setShown}
          options={columns.map(col => { const n = visible(col.key).length; return { value: col.key, label: <>{col.short ?? col.title}<span key={n} className="dm-n dm-num dm-enter">{n}</span></> }; })} />
        <Tip label={addLabel}><button type="button" className="dm-ib dm-kbx-add" aria-label={addLabel} onClick={() => add(shown)}><Icon name="plus" size="xs" /></button></Tip>
      </div>
      <div className="dm-kbx-bd">
        <div ref={wrap} className="dm-kbx-cols" style={{ ['--dm-kbx-gt' as string]: columns.map(c => shut.includes(c.key) ? '40px' : 'minmax(0,1fr)').join(' '), minHeight: mode === 'list' ? held : undefined }}>
          {columns.map(col => {
            const here = visible(col.key), all = list.filter(c => c.column === col.key).length, folded = shut.includes(col.key), full = !!col.limit && all > col.limit;
            const items: ReactNode[] = [];
            const hole = <div key="dm-kbx-ph" className="dm-kbx-ph" style={{ height: drag?.h }} />;
            for (const c of here) {
              if (spot?.column === col.key && spot.before === c.id && c.id !== drag?.id) items.push(hole);
              items.push(
                <Card key={c.id} card={c} entering={enters(c)} className={cx(c.progress != null && 'dm-agent', drag?.id === c.id && 'dm-drag', sel.includes(c.id) && 'dm-sel', peek === c.id && 'dm-open')}
                  label={describe(c)} tabIndex={c.id === tabStop ? 0 : -1}
                  setRef={el => { if (el) els.current.set(c.id, el); else els.current.delete(c.id); }}
                  onPointerDown={down(c)} onClick={click(c)} onDoubleClick={e => { if ((e.target as Element).closest('.dm-t') && !editing) { clearTimeout(clickT.current); setEditing(c.id); } }}
                  onKeyDown={key(c)} onFocus={e => { if (e.target === e.currentTarget) setFocusId(c.id); }}>
                  {face(c)}
                </Card>
              );
            }
            if (spot?.column === col.key && spot.before == null) items.push(hole);
            return (
              <div key={col.key} className={cx('dm-kbx-c', full && 'dm-wip', folded && 'dm-shut', shown === col.key && 'dm-on', over === col.key && 'dm-over')}
                ref={el => { if (el) cols.current.set(col.key, el); else cols.current.delete(col.key); }}
                onClick={folded && mode === 'board' && !narrow ? e => { if (!(e.target as Element).closest('.dm-kbx-cmn')) setShut(shut.filter(k => k !== col.key)); } : undefined}>
                <div className="dm-kbx-ch">
                  <Tip label={folded ? 'Open' : 'Fold'}>
                    <button type="button" className="dm-ib dm-kbx-tg" aria-expanded={!folded} aria-label={`${folded ? 'Open' : 'Fold'} ${col.title}`}
                      onClick={e => { e.stopPropagation(); setShut(folded ? shut.filter(k => k !== col.key) : [...shut, col.key]); say(`${col.title} ${folded ? 'open' : 'folded'}`); }}><Icon name="chev-d" size="xs" /></button>
                  </Tip>
                  <b>{col.title}</b>
                  <span className="dm-n dm-num">
                    {full ? <Tip label={`Over the limit of ${col.limit}`}><span className="dm-tag dm-warn"><Icon name="alert" size="xs" />{all}/{col.limit}</span></Tip>
                      : filtering && here.length !== all ? `${here.length} of ${all}` : col.limit ? `${all}/${col.limit}` : all}
                  </span>
                  <span className="dm-kbx-sp" />
                  <Tip label={addLabel}><button type="button" className="dm-ib dm-kbx-cadd" aria-label={`${addLabel}: ${col.title}`} onClick={() => add(col.key)}><Icon name="plus" size="xs" /></button></Tip>
                  <Tip label="Column actions" off={!!isOpen(`column-${col.key}`)}>
                    <button type="button" className="dm-ib dm-kbx-cmn" data-kbx={`column-${col.key}`} aria-haspopup="menu" aria-expanded={!!isOpen(`column-${col.key}`)} aria-label={`${col.title} actions`}
                      onClick={e => openMenu({ kind: 'column', col: col.key, btn: e.currentTarget }, e.detail === 0)}><Icon name="more" size="xs" /></button>
                  </Tip>
                </div>
                <div className="dm-kbx-list" role="list" aria-label={col.title}>{items.length ? items : !filtering && <div className="dm-kbx-none">No cards</div>}</div>
              </div>
            );
          })}
        </div>
        {/* nothing matches: one note in the middle of the board */}
        {filtering && !shownCount && (
          <div className="dm-kbx-em"><span className="dm-ic"><Icon name="filter" /></span><b>No cards match</b><span>Try another filter or search.</span>
            <button type="button" className="dm-pill dm-line dm-sm" onClick={() => setF(NO_FILTERS)}>Clear filters</button></div>
        )}
        {/* picked cards move together */}
        <div className={cx('dm-kbx-bk', picked.length > 0 && 'dm-on')} inert={!picked.length}>
          <span className="dm-n dm-num">{picked.length} selected</span><span className="dm-l">Move to</span>
          {columns.map(col => <button key={col.key} type="button" className="dm-pill dm-ghost dm-sm" onClick={() => { const ids = picked; anchor.current = null; setSel([]); moveMany(ids, col.key); }}><span className="dm-lg">{col.title}</span><span className="dm-sh">{col.short ?? col.title}</span></button>)}
          <span className="dm-sep" />
          <Tip label="Clear" kbd="Esc"><button type="button" className="dm-ib" aria-label="Clear the selection" onClick={clearPick}><Icon name="x" size="xs" /></button></Tip>
        </div>
        {/* a card's details */}
        <aside ref={sheet} className={cx('dm-kbx-pk', peek && sheetCard && 'dm-on')} role="dialog" aria-label={sheetCard ? `${codeOf(sheetCard)} details` : 'Card details'} inert={!peek}
          onKeyDown={e => { if (e.key === 'Escape' && !menu) { e.stopPropagation(); closeSheet(true); } }}>
          {sheetCard && sheetView(sheetCard)}
        </aside>
      </div>
      <div className="dm-kbx-sr" aria-live="polite" key={said.n}>{said.text}</div>

      {/* the menus */}
      <div {...pops.move.pop} className={cx(pops.move.pop.className, 'dm-kbx-pop dm-kbx-mp')} role="menu" aria-label="Move to">
        <div className="dm-ph">Move to</div>
        {columns.map(col => (
          <button key={col.key} type="button" className="dm-mi" role="menuitemradio" aria-checked={menuCard?.column === col.key} onClick={() => moveTo(col.key)}>
            <span>{col.title}</span><span className="dm-ck"><Icon name="check" size="xs" /></span>
          </button>
        ))}
      </div>
      <div {...pops.priority.pop} className={cx(pops.priority.pop.className, 'dm-kbx-pop dm-kbx-pm')} role="menu" aria-label="Priority">
        <div className="dm-ph">Priority</div>
        {PRIORITIES.map(p => (
          <button key={p} type="button" className="dm-mi" role="menuitemradio" aria-checked={(menuCard?.priority ?? 'none') === p} onClick={() => setPriority(p)}>
            <PriorityMark value={p} /><span>{PRIORITY[p]}</span><span className="dm-ck"><Icon name="check" size="xs" /></span>
          </button>
        ))}
      </div>
      <div {...pops.assign.pop} className={cx(pops.assign.pop.className, 'dm-kbx-pop dm-kbx-am')} role="menu" aria-label="Assignees">
        <div className="dm-ph">Assignees</div>
        {members.map(m => (
          <button key={m.id} type="button" className="dm-mi" role="menuitemcheckbox" aria-checked={(menuCard?.assignees ?? []).includes(m.id)} onClick={() => toggleAssignee(m.id)}>
            <Avatar initials={m.initials} color={m.color} /><span>{m.name}</span><span className="dm-ck"><Icon name="check" size="xs" /></span>
          </button>
        ))}
      </div>
      <div {...pops.column.pop} className={cx(pops.column.pop.className, 'dm-kbx-pop dm-kbx-cm')} role="menu" aria-label="Column">
        <div className="dm-ph">Column</div>
        <button type="button" className="dm-mi" role="menuitem" onClick={() => columnAction('add')}><Icon name="plus" size="xs" /><span>{addLabel}</span></button>
        <button type="button" className="dm-mi" role="menuitem" onClick={() => columnAction('all')}><Icon name="check" size="xs" /><span>Select all</span></button>
        <button type="button" className="dm-mi" role="menuitem" onClick={() => columnAction('priority')}><Icon name="sort" size="xs" /><span>Sort by priority</span></button>
        <button type="button" className="dm-mi" role="menuitem" onClick={() => columnAction('due')}><Icon name="cal" size="xs" /><span>Sort by due date</span></button>
        <div className="dm-sep" />
        <button type="button" className="dm-mi" role="menuitem" onClick={() => columnAction('fold')}><Icon name="chev-l" size="xs" /><span>Fold column</span></button>
      </div>
      <div {...pops.filter.pop} className={cx(pops.filter.pop.className, 'dm-kbx-pop dm-kbx-fm')} role="menu" aria-label={fm ? fName[fm] : 'Filter'}>
        <div className="dm-ph">{fm ? fName[fm] : 'Filter'}</div>
        {fOpts.map(o => {
          const on = fm ? (f[fm] as string[]).includes(o.v) : false;
          return (
            <button key={o.v} type="button" className="dm-mi" role="menuitemcheckbox" aria-checked={on} onClick={() => { if (fm) setF({ ...f, [fm]: toggleIn(f[fm] as string[], o.v) }); }}>
              {o.label}<span className="dm-r dm-num">{o.n}</span><span className="dm-ck"><Icon name="check" size="xs" /></span>
            </button>
          );
        })}
      </div>

      {ghostCard && drag && typeof document !== 'undefined' && createPortal(
        <div data-dm="" className={cx('dm-kbx-k dm-ghost', ghostCard.progress != null && 'dm-agent')} style={{ left: drag.x, top: drag.y, width: drag.w }} aria-hidden="true">
          {face(ghostCard, true)}
        </div>, document.body)}
    </div>
  );

  /** The details sheet: what the card is, its fields (each opens its menu), the agent's progress, a checklist and its talk and files */
  function sheetView(card: KanbanBoardCard) {
    const ps = people(card), names = ps.map(m => m.name).join(', '), n = card.subtasks?.length ?? 0, d = card.subtasks?.filter(s => s.done).length ?? 0;
    const days = card.due ? daysFrom(card.due, day) : null, late = days != null && days < 0 && !colOf(card.column)?.done, agent = ps.find(m => m.agent);
    const field = (kind: Menu['kind']) => (e: ReactMouseEvent<HTMLButtonElement>) => openMenu({ kind, id: card.id, from: 'sheet', btn: e.currentTarget }, e.detail === 0);
    const p = Math.max(0, Math.min(1, card.progress ?? 0));
    return (
      <>
        <div className="dm-kbx-pk-h"><span className="dm-kbx-id dm-num">{codeOf(card)}</span><span className="dm-kbx-sp" />
          <Tip label="Close" kbd="Esc"><button type="button" className="dm-ib dm-kbx-pk-x" aria-label="Close details" onClick={() => closeSheet(true)}><Icon name="x" size="xs" /></button></Tip></div>
        <div className="dm-kbx-pk-t">{card.title}</div>
        {card.progress != null && (
          <div className="dm-kbx-pk-ag">
            <div className="dm-kbx-ag"><Think /><span className="dm-s">{agent ? `${agent.name}: ` : ''}{activity(card)}</span><span className="dm-pc dm-num">{Math.round(p * 100)}%</span></div>
            <div className="dm-kbx-pr"><i style={{ width: p * 100 + '%' }} /></div>
          </div>
        )}
        <div className="dm-kbx-pk-rows">
          <div className="dm-kbx-pk-r"><span className="dm-k">Status</span><button type="button" className="dm-kbx-pv" data-kbx="sheet-move" aria-haspopup="menu" aria-expanded={!!isOpen('sheet-move')} aria-label={`Status: ${nameOf(card.column)}`} onClick={field('move')}>{nameOf(card.column)}<Icon name="chev-d" size="xs" /></button></div>
          <div className="dm-kbx-pk-r"><span className="dm-k">Priority</span><button type="button" className="dm-kbx-pv" data-kbx="sheet-priority" aria-haspopup="menu" aria-expanded={!!isOpen('sheet-priority')} aria-label={`Priority: ${PRIORITY[card.priority ?? 'none']}`} onClick={field('priority')}><PriorityMark value={card.priority} />{PRIORITY[card.priority ?? 'none']}<Icon name="chev-d" size="xs" /></button></div>
          {members.length > 0 && <div className="dm-kbx-pk-r"><span className="dm-k">Assignees</span><button type="button" className="dm-kbx-pv" data-kbx="sheet-assign" aria-haspopup="menu" aria-expanded={!!isOpen('sheet-assign')} aria-label={`Assignees: ${names || 'none'}`} onClick={field('assign')}>
            {ps.length ? <><span className="dm-avs">{ps.map(m => <Avatar key={m.id} initials={m.initials} color={m.color} />)}</span>{ps.length > 1 ? `${ps.length} people` : ps[0].name}</> : 'Assign'}<Icon name="chev-d" size="xs" /></button></div>}
          {days != null && card.due && <div className="dm-kbx-pk-r"><span className="dm-k">Due</span><span className={cx('dm-kbx-pv', late && 'dm-late')}><Icon name="cal" size="xs" />{dueText(days, card.due)}{late ? ', overdue' : ''}</span></div>}
          {!!card.labels?.length && <div className="dm-kbx-pk-r"><span className="dm-k">Labels</span><span className="dm-kbx-tags">{card.labels.map(l => <span key={l} className="dm-tag">{l}</span>)}</span></div>}
        </div>
        {n > 0 && <>
          <div className="dm-kbx-pk-s"><b>Subtasks</b><span className="dm-num">{d}/{n}</span><span className="dm-kbx-sb"><i style={{ width: d / n * 100 + '%' }} /></span></div>
          <div className="dm-kbx-pk-cl" role="group" aria-label="Subtasks">
            {card.subtasks!.map((s, i) => (
              <button key={i} type="button" className="dm-kbx-ci" role="checkbox" aria-checked={!!s.done} disabled={card.progress != null}
                onClick={() => { const subtasks = card.subtasks!.map((x, j) => j === i ? { ...x, done: !x.done } : x); update(card.id, { subtasks }); say(`${s.title} ${s.done ? 'not done' : 'done'}, ${subtasks.filter(x => x.done).length} of ${n}`); }}>
                <span className="dm-kbx-cb"><Icon name="check" size="xs" /></span><span>{s.title}</span>
              </button>
            ))}
          </div>
        </>}
        <div className="dm-kbx-pk-f">
          <span className="dm-kbx-mt"><Icon name="comment" size="xs" />{card.comments ? plural(card.comments, 'comment') : 'No comments'}</span>
          <span className="dm-kbx-mt"><Icon name="clip" size="xs" />{card.attachments ? plural(card.attachments, 'file') : 'No files'}</span>
        </div>
      </>
    );
  }
}

/** A card's title, written in place while it is being named */
function Title({ card, editing, onDone, onCancel }: { card: KanbanBoardCard; editing: boolean; onDone: (title: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    const t = ref.current; if (!editing || !t) return;
    cancelled.current = false; t.focus(); document.getSelection()?.selectAllChildren(t);
  }, [editing]);
  // keyed by the title, so an edit always starts from what was saved
  return (
    <span key={card.title} ref={ref} className="dm-t" contentEditable={editing} suppressContentEditableWarning
      onBlur={editing ? e => { if (cancelled.current) { e.currentTarget.textContent = card.title; onCancel(); } else onDone(e.currentTarget.textContent ?? ''); } : undefined}
      onKeyDown={editing ? e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); } } : undefined}>{card.title}</span>
  );
}

function Card({ card, entering: enters, className, label, tabIndex, setRef, children, ...on }: {
  card: KanbanBoardCard; entering: boolean; className?: string; label: string; tabIndex: number; setRef: (el: HTMLDivElement | null) => void; children: ReactNode;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void; onClick: (e: ReactMouseEvent<HTMLDivElement>) => void; onDoubleClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void; onFocus: (e: React.FocusEvent<HTMLDivElement>) => void;
}) {
  // a card that arrives after the board appears comes in once, then drops the entrance so a drag can fade it
  const [entering, setEntering] = useState(enters);
  return (
    <div ref={setRef} data-id={card.id} role="listitem" aria-label={label} tabIndex={tabIndex} className={cx('dm-kbx-k', className, entering && 'dm-enter')} {...on}
      onAnimationEnd={(e: AnimationEvent) => { if (e.target === e.currentTarget && entering) setEntering(false); }}>
      {children}
    </div>
  );
}
