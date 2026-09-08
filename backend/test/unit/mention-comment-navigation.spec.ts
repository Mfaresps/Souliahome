import * as fs from 'fs';
import * as path from 'path';

export {};

/**
 * Clicking an @mention must land on the comment it refers to, highlighted.
 *
 * ⚠ The functions under test live in `frontend/public/index.html` and are
 * EXTRACTED from the shipped file, never copied into this spec — a copy keeps
 * passing after the real one breaks, which is exactly what
 * `test/unit/returns.spec.ts` does wrong. Same technique as
 * `amount-to-words.spec.ts` and `staff-dashboard.spec.ts`.
 *
 * Two defects this locks in:
 *
 * 1. `highlightInvComment` opened with a hard `return false` unless the LEGACY
 *    modal (`#inv-detail-overlay`) was active. The Movements table's entry point
 *    is now the full page `renderInvoiceViewPage`, so on that surface the
 *    mention arrived at the invoice with no highlight at all.
 *
 * 2. On the full page the comments sit inside a TAB of «سجل النشاط». A tab that
 *    is not active is `display:none`, so the element exists but `scrollIntoView`
 *    does nothing — the employee lands on the invoice and never sees the comment
 *    they were called to. The tab has to be switched first, through
 *    `switchInvLogTab` so the remembered-tab state stays consistent.
 */

const INDEX_HTML = path.resolve(__dirname, '../../../frontend/public/index.html');

function readIndex(): string {
  return fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');
}

/** Pull one `function name(...) {...}` out of the shipped file by brace-matching. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in index.html — was it renamed?`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

/** `async function name(...)` — the mention click handler is async. */
function extractAsyncFn(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in index.html — was it renamed?`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

describe('mention → comment navigation (extracted from index.html)', () => {
  const src = readIndex();

  describe('highlightInvComment — works on BOTH invoice surfaces', () => {
    /**
     * Builds a DOM shaped like the full order page: the comment lives inside a
     * non-active `.inv2-log-pane`, which is what `buildInvCommentsSection`
     * produces once `renderInvoiceViewPage` puts it in the activity-log tabs.
     */
    function buildHarness(opts: { surface: 'page' | 'modal'; paneActive?: boolean; commentId?: number }) {
      const cid = opts.commentId ?? 7;
      const paneActive = opts.paneActive ?? false;

      const switched: Array<{ key: string }> = [];
      const scrolled: string[] = [];
      const classLists = new Map<string, Set<string>>();
      const pulseTeardowns: Array<() => void> = [];

      const mk = (id: string, cls: string[] = []) => {
        const set = new Set(cls);
        classLists.set(id, set);
        const el: any = {
          _id: id,
          dataset: {} as Record<string, string>,
          offsetWidth: 1,
          classList: {
            add: (c: string) => set.add(c),
            remove: (c: string) => set.delete(c),
            contains: (c: string) => set.has(c),
            toggle: (c: string, on?: boolean) => (on ? set.add(c) : set.delete(c)),
          },
          scrollIntoView: () => scrolled.push(id),
          querySelector: () => null,
          _parents: [] as any[],
        };
        el.closest = (sel: string) => {
          const want = sel.replace(/^\./, '');
          for (const p of el._parents) if (p._cls.includes(want)) return p;
          return null;
        };
        return el;
      };

      // pane (tab) → section body → item → text[data-comment-id]
      const pane: any = mk('pane', paneActive ? ['active'] : []);
      pane._cls = ['inv2-log-pane'];
      pane.dataset.logPane = 'comments';

      const sectionBody: any = mk('sectionBody', ['expanded']);
      sectionBody._cls = ['inv-section-body'];
      sectionBody.previousElementSibling = mk('sectionHeader', ['expanded']);

      const item: any = mk('item');
      item._cls = ['inv-cmt-item'];

      const textEl: any = mk('text');
      textEl._cls = ['tx-cmt-text'];

      const tabBtn: any = mk('tabBtn');
      tabBtn._cls = ['inv2-log-tab'];

      const card: any = mk('card');
      card._cls = ['inv2-card'];
      card.querySelector = (sel: string) =>
        sel.includes('inv2-log-tab') && sel.includes('comments') ? tabBtn : null;

      // closest() walks outward: text → item → sectionBody → pane → card
      textEl._parents = [item, sectionBody, pane, card];
      item._parents = [sectionBody, pane, card];
      pane._parents = [card];

      const surfaceEl: any = mk('surface');
      surfaceEl._cls = ['surface'];
      surfaceEl.querySelector = (sel: string) =>
        sel === `[data-comment-id="${cid}"]` ? textEl : null;

      const overlayActive = opts.surface === 'modal';
      const overlay: any = mk('overlay', overlayActive ? ['active'] : []);
      overlay._cls = ['overlay'];

      const qs = (sel: string) => {
        if (sel === '#inv-detail-overlay') return overlay;
        if (sel === '#inv-detail-content') return overlayActive ? surfaceEl : null;
        if (sel === '#inv-view-content') return opts.surface === 'page' ? surfaceEl : null;
        return null;
      };

      const sandbox = {
        qs,
        currentPage: opts.surface === 'page' ? 'invoice-view' : 'movements',
        switchInvLogTab: (btn: any, key: string) => {
          switched.push({ key });
          classLists.get('pane')!.add('active');
        },
        /* The real code adds `comment-mention-highlight`, then removes it on a
           4s timer. Firing every timeout synchronously would run that cleanup
           immediately and hide the pulse, so only the short (scroll) delay runs
           here and the long teardown is captured rather than executed. */
        setTimeout: (fn: () => void, ms?: number) => {
          if ((ms ?? 0) >= 1000) { pulseTeardowns.push(fn); return 0 as any; }
          fn();
          return 0 as any;
        },
        requestAnimationFrame: (fn: () => void) => { fn(); return 0 as any; },
      };

      const code = `
        ${extractFn(src, '_invCommentSurface')}
        ${extractFn(src, 'highlightInvComment')}
        return highlightInvComment(CID);
      `;
      const keys = Object.keys(sandbox);
      const run = new Function(...keys, 'CID', code);
      const result = run(...keys.map(k => (sandbox as any)[k]), cid);

      return { result, switched, scrolled, classLists, pulseTeardowns };
    }

    it('highlights a comment on the FULL ORDER PAGE (the regression)', () => {
      // Before the fix this returned false immediately: the legacy modal overlay
      // is not active on the full page, so nothing was ever highlighted.
      const { result, scrolled, classLists, pulseTeardowns } = buildHarness({ surface: 'page' });
      expect(result).toBe(true);
      expect(scrolled).toContain('text');
      expect(classLists.get('item')!.has('comment-mention-highlight')).toBe(true);
      // ...and the pulse is temporary, not a class left on the row forever
      pulseTeardowns.forEach(fn => fn());
      expect(classLists.get('item')!.has('comment-mention-highlight')).toBe(false);
    });

    it('switches to the comments tab when that pane is not the active one', () => {
      // The element exists but is display:none inside an inactive tab, so
      // scrolling to it would land the employee on an invoice showing something
      // else entirely.
      const { switched } = buildHarness({ surface: 'page', paneActive: false });
      expect(switched).toEqual([{ key: 'comments' }]);
    });

    it('goes through switchInvLogTab, not a raw display flip', () => {
      // The remembered-tab state (_invLogActiveTab / _invLogTabFor) lives inside
      // switchInvLogTab. Poking .style.display directly would desync it, so a
      // later re-render would snap back to a different tab.
      const fn = extractFn(src, 'highlightInvComment');
      expect(fn).toContain('switchInvLogTab');
      expect(fn).not.toMatch(/style\.display\s*=/);
    });

    it('does not switch tabs when the comments pane is already active', () => {
      const { switched, result } = buildHarness({ surface: 'page', paneActive: true });
      expect(result).toBe(true);
      expect(switched).toEqual([]);
    });

    it('still highlights inside the LEGACY modal — the old path is not broken', () => {
      const { result, scrolled } = buildHarness({ surface: 'modal' });
      expect(result).toBe(true);
      expect(scrolled).toContain('text');
    });

    it('returns false when neither surface is showing', () => {
      const { result } = buildHarness({ surface: 'modal', commentId: 7 });
      expect(result).toBe(true); // sanity: the harness itself finds it
      // now a surface that is genuinely closed
      const sandbox = {
        qs: () => null,
        currentPage: 'movements',
        switchInvLogTab: () => {},
        setTimeout: (fn: () => void) => { fn(); return 0 as any; },
      };
      const code = `
        ${extractFn(src, '_invCommentSurface')}
        ${extractFn(src, 'highlightInvComment')}
        return highlightInvComment(7);
      `;
      const keys = Object.keys(sandbox);
      const out = new Function(...keys, code)(...keys.map(k => (sandbox as any)[k]));
      expect(out).toBe(false);
    });
  });

  describe('onMentionNotifClick — routes to the full order page', () => {
    const handler = extractAsyncFn(src, 'onMentionNotifClick');

    it('opens the shared full order page, not the legacy modal', () => {
      // Both the Movements table and the mention must land the two colleagues on
      // the SAME screen with a shareable URL — openOrderView is that entry point.
      expect(handler).toContain('openOrderView(txId)');
    });

    it('the DEFAULT path ends in openOrderView + highlight, not showInvoiceDetail', () => {
      /* ⚠ A bare toContain('openOrderView(txId)') passes vacuously — the masked-
         purchase guard above also calls it. This asserts the LAST statements of
         the handler, which is the branch every ordinary mention actually takes.
         Verified to fail when that tail is reverted to the old
         `navigateTo('movements') + showInvoiceDetail(txId, cid)`. */
      const tail = handler.slice(-160).replace(/\s+/g, ' ');
      expect(tail).toContain('openOrderView(txId); goHighlight();');
      expect(tail).not.toContain('showInvoiceDetail');
      expect(tail).not.toContain("navigateTo('movements')");
    });

    it('keeps the legacy modal path only when that modal is already open', () => {
      // Not a fallback: it exists so a user already looking at the old modal for
      // this same invoice is not yanked onto another screen.
      expect(handler).toMatch(/inv-detail-overlay[\s\S]*?showInvoiceDetail\(txId, cid\)/);
    });

    it('re-renders before highlighting when the page is already on this order', () => {
      // ensureTxFresh may have just fetched the mentioned comment; the page was
      // rendered before that, so the target would not be in the DOM yet.
      expect(handler).toContain('refreshInvoiceView(txId)');
    });

    it('does not chase a comment into the restricted-purchase screen', () => {
      // openOrderView diverts a masked purchase to showRestrictedPurchaseDetail,
      // which has no comments to scroll to.
      expect(handler).toContain('purchaseDetailsHidden');
    });

    it('still routes follow-up mentions to the follow-up thread', () => {
      // The follow-up branch must keep winning before the transaction branch —
      // its txId is a followup _id, not a transaction _id.
      const fuIdx = handler.indexOf('goToFuAndHighlight');
      const txIdx = handler.indexOf('openOrderView(txId)');
      expect(fuIdx).toBeGreaterThan(-1);
      expect(fuIdx).toBeLessThan(txIdx);
    });
  });
});
