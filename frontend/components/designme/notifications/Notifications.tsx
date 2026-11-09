'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { useControllable } from '../lib/hooks';
import { Icon, type IconName } from '../lib/icons';
import { Avatar, enter, Seg } from '../lib/motion';
import '../designme.css';
import './notifications.css';

export interface NotificationsItem {
  id: string;
  /** Which filter it belongs to, like 'agent' or 'mention' */
  kind: string;
  /** What happened. Wrap the subject in <b>, like <><b>Pricing audit</b> finished</> */
  text: ReactNode;
  /** Like "4 min ago" */
  time: string;
  /** An icon on a tinted tile, for things the agent did */
  icon?: IconName;
  /** The icon's colour, like 'var(--dm-ok)' */
  color?: string;
  /** An avatar instead of an icon, for people */
  avatar?: { initials: string; color: string };
  read?: boolean;
}

export interface NotificationsFilter {
  /** 'all' shows everything; anything else shows the items of that kind */
  value: string;
  label: string;
}

export interface NotificationsProps {
  /** Newest first. A new id at the top drops in and bumps the count */
  items?: NotificationsItem[];
  defaultItems?: NotificationsItem[];
  /** Called when items are read or unread, one at a time or all at once */
  onItemsChange?: (items: NotificationsItem[]) => void;
  filters?: NotificationsFilter[];
  /** The open filter. Leave it out to let the switch change it */
  filter?: string;
  defaultFilter?: string;
  onFilterChange?: (filter: string) => void;
  title?: string;
  markAllLabel?: string;
  emptyLabel?: string;
  className?: string;
}

const FILTERS: NotificationsFilter[] = [{ value: 'all', label: 'All' }, { value: 'agent', label: 'Agent' }, { value: 'mention', label: 'Mentions' }];

/** An inbox where agent updates and mentions arrive live. Click one to mark it read or unread. */
export function Notifications({ items, defaultItems = [], onItemsChange, filters = FILTERS, filter, defaultFilter = 'all', onFilterChange, title = 'Inbox', markAllLabel = 'Mark all read', emptyLabel = 'Nothing here yet', className }: NotificationsProps) {
  const [list, setList] = useControllable(items, defaultItems, onItemsChange);
  const [cur, setCur] = useControllable(filter, defaultFilter, onFilterChange);
  const shown = list.filter(x => cur === 'all' || x.kind === cur);
  const unread = list.filter(x => !x.read).length;

  // the rows painted together (on first show and on each filter) stagger in; ones that arrive later drop in on their own
  const [paint, setPaint] = useState(() => ({ filter: cur, ids: shown.map(x => x.id) }));
  if (paint.filter !== cur) setPaint({ filter: cur, ids: shown.map(x => x.id) });
  // a new item bumps the count
  const [known, setKnown] = useState(() => new Set(list.map(x => x.id)));
  const [bump, setBump] = useState(0);
  const fresh = list.filter(x => !known.has(x.id));
  if (fresh.length) { setKnown(new Set([...known, ...fresh.map(x => x.id)])); setBump(b => b + 1); }

  // Mark all read clears the dots one row after another
  const [pending, setPending] = useState<string[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const markAll = () => {
    const rows = shown.filter(x => !x.read).map(x => x.id);
    setPending(rows);
    rows.forEach((id, i) => timers.current.push(setTimeout(() => setPending(p => p.filter(x => x !== id)), i * 50)));
    setList(list.map(x => (x.read ? x : { ...x, read: true })));
  };
  const toggle = (id: string) => setList(list.map(x => (x.id === id ? { ...x, read: !x.read } : x)));

  return (
    <div data-dm="" className={cx('dm-ntx dm-panel', className)}>
      <div className="dm-ntx-h">
        <b>{title}</b>
        <span key={bump} className={cx('dm-ntx-ct dm-num', !unread && 'dm-z', bump > 0 && 'dm-bump')} aria-label={`${unread} unread`}>{unread}</span>
        <span className="dm-ntx-sp" />
        <button type="button" className="dm-pill dm-ghost dm-sm dm-ntx-all" onClick={markAll}>{markAllLabel}</button>
      </div>
      <div className="dm-ntx-tabs"><Seg label="Filter" value={cur} onChange={setCur} options={filters} /></div>
      <div key={paint.filter} className="dm-ntx-list">
        {shown.length ? shown.map(x => {
          const at = paint.ids.indexOf(x.id), e = at >= 0 ? enter(at * 40) : null;
          return (
            <button type="button" key={x.id} className={cx('dm-ntx-n', x.read && !pending.includes(x.id) && 'dm-read', e ? e.className : 'dm-new')} style={e?.style}
              aria-pressed={!!x.read} onClick={() => toggle(x.id)}>
              <span className="dm-ic" style={x.avatar ? undefined : { color: x.color, background: `color-mix(in srgb,${x.color ?? 'currentColor'} 13%,transparent)` }}>
                {x.avatar ? <Avatar initials={x.avatar.initials} color={x.avatar.color} /> : <Icon name={x.icon ?? 'bell'} size="xs" />}
              </span>
              <span className="dm-t">{x.text}<span>{x.time}</span></span>
              <span className="dm-u" />
            </button>
          );
        }) : <div className="dm-ntx-e">{emptyLabel}</div>}
      </div>
    </div>
  );
}
