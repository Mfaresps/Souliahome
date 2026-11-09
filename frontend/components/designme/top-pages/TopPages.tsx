'use client';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../lib/cx';
import { useControllable, useReducedMotion, useTween } from '../lib/hooks';
import { Seg, Tip } from '../lib/motion';
import '../designme.css';
import './top-pages.css';

export interface TopPagesPage {
  /** The page's path, like "/pricing" */
  path: string;
  /** Its name, like "Pricing" */
  title: string;
  /** Views over the period */
  views: number;
  /** Change against the period before, in percent, like 24 or -8 */
  change: number;
  /** Shown when you hover the row. Defaults to the site and the path, like "designme.dev/pricing" */
  tip?: string;
}

export type TopPagesSort = 'views' | 'change';

export interface TopPagesProps {
  pages: TopPagesPage[];
  /** Header text */
  title?: string;
  /** After the total, like "last 30 days" */
  period?: string;
  /** Put in front of each path in the row tips, like "designme.dev" */
  site?: string;
  /** How the rows are ordered. Leave it out to let the switch change it */
  sort?: TopPagesSort;
  defaultSort?: TopPagesSort;
  onSortChange?: (sort: TopPagesSort) => void;
  className?: string;
}

const ROW = 50;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** The most visited pages, with their views and change. Rows slide into place when the order changes. */
export function TopPages({ pages, title = 'Top pages', period = 'last 30 days', site, sort, defaultSort = 'views', onSortChange, className }: TopPagesProps) {
  const [by, setBy] = useControllable(sort, defaultSort, onSortChange);
  const reduce = useReducedMotion();
  const total = useTween(pages.reduce((a, p) => a + p.views, 0), 1000, 0);
  const max = Math.max(1, ...pages.map(p => p.views));
  const order = [...pages].sort((a, b) => by === 'views' ? b.views - a.views : b.change - a.change);

  // each track fills in a little after the one above it
  const [filled, setFilled] = useState(0);
  useEffect(() => {
    const ts = pages.map((_, i) => setTimeout(() => setFilled(n => Math.max(n, i + 1)), 200 + i * 70));
    return () => ts.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the rows fade in from a blur, one after another
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reduce || !list.current) return;
    [...list.current.children].forEach((row, i) => row.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 450, delay: i * 50, easing: 'ease-out', fill: 'backwards' }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div data-dm="" className={cx('dm-tpx dm-panel', className)}>
      <div className="dm-tpx-h">
        <div><b>{title}</b><span className="dm-muted dm-tpx-sub"><span className="dm-num dm-tpx-tot">{fmt(total)}</span> views, {period}</span></div>
        <Seg className="dm-tpx-sg" label="Sort" value={by} onChange={setBy} options={[{ value: 'views', label: 'Views' }, { value: 'change', label: 'Change' }]} />
      </div>
      <div className="dm-tpx-list" ref={list} style={{ height: pages.length * ROW }}>
        {pages.map((p, i) => {
          const at = order.indexOf(p);
          return (
            <Tip key={p.path} label={p.tip ?? (site ? site + p.path : p.path)}>
              <div className="dm-tpx-r" style={{ transform: `translateY(${at * ROW}px)` }}>
                <span className="dm-rk">{at + 1}</span>
                <span className="dm-pg">
                  <span className="dm-p">{p.title} <span className="dm-muted">{p.path}</span></span>
                  <span className="dm-tr"><i style={{ width: i < filled ? p.views / max * 100 + '%' : 0 }} /></span>
                </span>
                <span className="dm-n dm-num">{fmt(p.views)}</span>
                <span className={cx('dm-tag dm-ch dm-num', p.change >= 0 ? 'dm-ok' : 'dm-bad')}>{p.change >= 0 ? '+' : '−'}{Math.abs(p.change)}%</span>
              </div>
            </Tip>
          );
        })}
      </div>
    </div>
  );
}
