'use client';
import { useEffect, useRef, useState, type AnimationEvent } from 'react';
import { cx } from '../lib/cx';
import { useControllable, useReducedMotion } from '../lib/hooks';
import { Icon } from '../lib/icons';
import { Avatar, enter, Seg, Spin, Tip } from '../lib/motion';
import '../designme.css';
import './ticket-list.css';

export type TicketListPriority = 'urgent' | 'high' | 'normal' | 'low';
export type TicketListStatus = 'open' | 'done';

export interface TicketListTicket {
  id: string;
  /** What it is about, like "Figma frames not syncing" */
  title: string;
  /** Who asked, like "Lumen Labs" */
  from: string;
  /** What they wrote. Shown after the customer while the ticket is shut, and above the reply when it opens */
  question?: string;
  /** The reply the agent suggests. People can edit it before sending */
  reply?: string;
  /** The coloured dot in front: urgent red, high amber, normal accent, low grey */
  priority?: TicketListPriority;
  /** Who it is assigned to, shown as a small avatar */
  assignee: { initials: string; color: string };
  /** How long it has waited, like "4m" */
  waiting: string;
  status: TicketListStatus;
}

export interface TicketListProps {
  /** The tickets. Leave it out to let Send and solve move them to Solved by itself */
  tickets?: TicketListTicket[];
  defaultTickets?: TicketListTicket[];
  onTicketsChange?: (tickets: TicketListTicket[]) => void;
  /** Which tickets show. Leave it out to let the switch change it */
  filter?: TicketListStatus;
  defaultFilter?: TicketListStatus;
  onFilterChange?: (filter: TicketListStatus) => void;
  /** The id of the open ticket, or null. Leave it out to let the rows open and shut */
  open?: string | null;
  defaultOpen?: string | null;
  onOpenChange?: (id: string | null) => void;
  /** Sends the reply, edited or not. Return a promise and the button spins until it settles; then the ticket fades out and is solved */
  onSend?: (ticket: TicketListTicket, reply: string) => void | Promise<void>;
  title?: string;
  /** The switch's two labels */
  filterLabels?: Record<TicketListStatus, string>;
  /** Shown when no ticket matches the filter */
  emptyLabel?: string;
  replyLabel?: string;
  editLabel?: string;
  sendLabel?: string;
  className?: string;
}

const PRIORITY: Record<TicketListPriority, { label: string; color: string }> = {
  urgent: { label: 'Urgent', color: 'var(--dm-bad)' },
  high: { label: 'High', color: 'var(--dm-warn)' },
  normal: { label: 'Normal', color: 'var(--dm-accent)' },
  low: { label: 'Low', color: 'var(--dm-faint)' }
};

// how long a solved ticket takes to fade, then to fold its height away
const FADE = 330, FOLD = 260;

function Ticket({ ticket, index, isOpen, leaving, busy, onToggle, onSend, labels }: {
  ticket: TicketListTicket; index: number; isOpen: boolean; leaving: boolean; busy: boolean;
  onToggle: () => void; onSend: (reply: string) => void; labels: { reply: string; edit: string; send: string };
}) {
  // rows come in one after another, then drop the entrance so a later fade-out starts on time
  const [entering, setEntering] = useState(true);
  const text = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // a solved ticket fades, then folds its height away, so the tickets under it slide up instead of jumping
  useEffect(() => {
    const el = row.current; if (!leaving || !el || reduce) return;
    el.style.overflow = 'hidden';
    const a = el.animate([{ height: el.offsetHeight + 'px' }, { height: '0px' }], { duration: FOLD, delay: FADE, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
    return () => a.cancel();
  }, [leaving, reduce]);
  const p = PRIORITY[ticket.priority ?? 'normal'];
  const edit = () => {
    const el = text.current; if (!el) return;
    el.focus();
    const sel = document.getSelection(); sel?.selectAllChildren(el); sel?.collapseToEnd();
  };
  return (
    <div ref={row} className={cx('dm-tkx-t', isOpen && 'dm-open', entering && 'dm-enter', leaving && 'dm-leave')} style={entering ? enter(index * 40).style : undefined}
      onAnimationEnd={(e: AnimationEvent) => { if (e.target === e.currentTarget && entering) setEntering(false); }}>
      <button type="button" className="dm-tkx-r" aria-expanded={isOpen} onClick={leaving ? undefined : onToggle}>
        <Tip label={p.label}><span className="dm-pr"><span className="dm-dot" style={{ color: p.color }} /></span></Tip>
        <span className="dm-t"><b>{ticket.title}</b><span>{ticket.from}{ticket.question && !isOpen ? ' · ' + ticket.question : ''}</span></span>
        <span className="dm-m"><span className="dm-w">{ticket.waiting}</span><Avatar initials={ticket.assignee.initials} color={ticket.assignee.color} /></span>
      </button>
      {isOpen && (
        <div className="dm-tkx-d">
          <div className="dm-tkx-q dm-enter" style={enter(0).style}>{ticket.question}</div>
          <div className="dm-tkx-s dm-enter" style={enter(50).style}>
            <div className="dm-lb"><Icon name="spark" size="xs" />{labels.reply}</div>
            <div ref={text} className="dm-tx" contentEditable suppressContentEditableWarning spellCheck={false}>{ticket.reply}</div>
          </div>
          <div className="dm-tkx-a dm-enter" style={enter(100).style}>
            <button type="button" className="dm-pill dm-ghost dm-sm" onClick={edit}><Icon name="edit" size="xs" />{labels.edit}</button>
            <button type="button" className="dm-pill dm-accent dm-sm" aria-busy={busy} onClick={() => { if (!busy) onSend(text.current?.textContent ?? ticket.reply ?? ''); }}>
              {busy ? <Spin /> : <><Icon name="send" size="xs" />{labels.send}</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Support tickets the agent has triaged, with suggested replies. */
export function TicketList({ tickets, defaultTickets = [], onTicketsChange, filter, defaultFilter = 'open', onFilterChange, open, defaultOpen = null, onOpenChange, onSend,
  title = 'Support', filterLabels = { open: 'Open', done: 'Solved' }, emptyLabel = 'All caught up', replyLabel = 'Suggested reply', editLabel = 'Edit', sendLabel = 'Send and solve', className }: TicketListProps) {
  const [list, setList] = useControllable(tickets, defaultTickets, onTicketsChange);
  const [shown, setShown] = useControllable(filter, defaultFilter, onFilterChange);
  const [openId, setOpen] = useControllable(open, defaultOpen, onOpenChange);
  const [busy, setBusy] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // the latest list, for when a send settles after other changes
  const latest = useRef(list);
  useEffect(() => { latest.current = list; });

  const send = async (t: TicketListTicket, reply: string) => {
    setBusy(t.id);
    try { await onSend?.(t, reply); } catch { if (alive.current) setBusy(null); return; }
    if (!alive.current) return;
    setLeaving(t.id);
    await new Promise(res => setTimeout(res, reduce ? 0 : FADE + FOLD));
    if (!alive.current) return;
    setBusy(null); setLeaving(null); setOpen(null);
    setList(latest.current.map(x => x.id === t.id ? { ...x, status: 'done', reply } : x));
  };
  const rows = list.filter(t => t.status === shown);

  return (
    <div data-dm="" className={cx('dm-tkx dm-panel', className)}>
      <div className="dm-tkx-h">
        <b>{title}</b>
        <Seg className="dm-tkx-sg" label="Filter" value={shown} onChange={v => { setOpen(null); setShown(v); }}
          options={[{ value: 'open', label: filterLabels.open }, { value: 'done', label: filterLabels.done }]} />
      </div>
      {/* a new filter brings its rows in again */}
      <div className="dm-tkx-list" key={shown}>
        {rows.length ? rows.map((t, i) => (
          <Ticket key={t.id} ticket={t} index={i} isOpen={openId === t.id} leaving={leaving === t.id} busy={busy === t.id}
            onToggle={() => setOpen(openId === t.id ? null : t.id)} onSend={reply => send(t, reply)}
            labels={{ reply: replyLabel, edit: editLabel, send: sendLabel }} />
        )) : <div className="dm-tkx-e">{emptyLabel}</div>}
      </div>
    </div>
  );
}
