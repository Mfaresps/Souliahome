import * as fs from 'fs';
import * as path from 'path';

/**
 * The employee dashboard — the staff-facing half of the Performance Hub.
 *
 * ⚠ The functions under test live in `frontend/public/index.html`. They are
 * EXTRACTED from the shipped file and evaluated here rather than copied into
 * this spec: a copy keeps passing after the real one breaks, which is exactly
 * what `test/unit/returns.spec.ts` does wrong. Same technique as
 * `amount-to-words.spec.ts`.
 *
 * ⚠ Scope rule, revised 8 Sep 2026 (owner decision): SHIPMENT STATE is shared —
 * staff and admin read the same `transactions` array, because whoever answers a
 * customer asking about a parcel needs to see it even when it is not theirs.
 *
 * What stays scoped, and is still locked down below: «أوردراتي المسندة»,
 * «طلبات تحتاج متابعة» and the KPI figures — those come from server-scoped
 * endpoints (`my-workspace` / `my-roster`) keyed on the JWT, never from a
 * frontend filter. The privacy boundary is the response, not the renderer.
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
  throw new Error(`Unbalanced braces while extracting ${name}`);
}

describe('staff dashboard — row source is scoped by role', () => {
  const src = readIndex();

  /**
   * Rebuilds the row-source + bucketing block of `_renderStaffDashboard` from the
   * shipped source, with the DOM/network parts stubbed. The `allTx` / `salesTx` /
   * `shipping` / `issues` / `delivered` expressions are the real ones.
   */
  function runRowSource(opts: {
    adminMode: boolean;
    transactions: any[];
    workspace: any;
    period?: string;
  }) {
    const body = extractFn(src, '_renderStaffDashboard');
    // Keep only the row-source and bucketing section — everything after the
    // delivered[] computation touches the DOM.
    const from = body.indexOf('const allTx');
    const to = body.indexOf("qs('#dash-tab-count-shipping')");
    if (from < 0 || to < 0) {
      throw new Error('The allTx/bucketing block moved — update this extractor.');
    }
    const block = body.slice(from, to);

    const shipStatus = extractFn(src, '_dashShipStatus');
    const issueSettled = extractFn(src, '_dashShipIssueSettled');
    const isOpenIssue = extractFn(src, '_dashIsOpenIssue');
    const periodMatches = extractFn(src, '_dashPeriodMatches');

    const harness = `
      ${shipStatus}
      ${issueSettled}
      ${isOpenIssue}
      ${periodMatches}
      const ISSUE_SHIP_KEYS = ['RETURNED','FAILED_ATTEMPT','DELIVERY_FAILED'];
      const _DASH_PERIOD_DAYS = { '7d':7,'14d':14,'30d':30,'60d':60,'90d':90 };
      const t = (k) => k;                       // labels are irrelevant to bucketing
      const _dashDeliveredPeriod = ${JSON.stringify(opts.period || 'all')};
      const adminMode = ${JSON.stringify(opts.adminMode)};
      const transactions = ${JSON.stringify(opts.transactions)};
      const _myWorkspace = ${JSON.stringify(opts.workspace)};
      ${block}
      return { allTx, salesTx, shipping, issues, delivered };
    `;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(harness)() as {
      allTx: any[];
      salesTx: any[];
      shipping: any[];
      issues: any[];
      delivered: any[];
    };
  }

  const mine = {
    _id: 'tx-mine',
    type: 'مبيعات',
    ref: '1001',
    client: 'Mine',
    cancelled: false,
    bostaStatus: 'IN_TRANSIT',
    date: '2026-09-01',
  };
  const colleague = {
    _id: 'tx-theirs',
    type: 'مبيعات',
    ref: '2002',
    client: 'Theirs',
    cancelled: false,
    bostaStatus: 'IN_TRANSIT',
    date: '2026-09-01',
  };

  it('shipping is company-wide for staff too — the same rows the admin sees', () => {
    // ⚠ Owner decision (8 Sep 2026): shipment STATE is shared operational information,
    // not a secret between colleagues — whoever answers a customer asking about a
    // parcel needs to see it even when it is not assigned to them. Both roles read
    // the same `transactions` array, so the two views cannot drift apart.
    const res = runRowSource({
      adminMode: false,
      transactions: [mine, colleague],
      workspace: { shipments: [mine] },   // present, and deliberately NOT the source
    });
    expect(res.shipping.map((x: any) => x.tx.ref).sort()).toEqual(['1001', '2002']);
  });

  it('an admin sees exactly the same rows as a staff member', () => {
    const asStaff = runRowSource({ adminMode: false, transactions: [mine, colleague], workspace: null });
    const asAdmin = runRowSource({ adminMode: true, transactions: [mine, colleague], workspace: null });
    expect(asStaff.shipping.map((x: any) => x.tx.ref).sort())
      .toEqual(asAdmin.shipping.map((x: any) => x.tx.ref).sort());
  });

  it('does not depend on the workspace payload arriving — no empty first paint', () => {
    // ⚠ The bug this replaces: reading `_myWorkspace.shipments` painted an EMPTY card
    // on first render, because that payload lands after the first paint. Reading the
    // boot-loaded `transactions` removes the race entirely.
    const res = runRowSource({
      adminMode: false,
      transactions: [mine, colleague],
      workspace: null,
    });
    expect(res.allTx).toHaveLength(2);
    expect(res.shipping).toHaveLength(2);
  });

  it('classifies a staff row exactly as it classifies an admin row', () => {
    // Same order, same bucket, whichever role is looking — classification must never
    // depend on who is viewing.
    const returned = { ...mine, bostaStatus: 'RETURNED', shipIssueState: 'open' };
    const asStaff = runRowSource({ adminMode: false, transactions: [returned], workspace: null });
    const asAdmin = runRowSource({ adminMode: true, transactions: [returned], workspace: null });
    expect(asStaff.issues).toHaveLength(1);
    expect(asAdmin.issues).toHaveLength(1);
    expect(asStaff.shipping).toHaveLength(0);
    expect(asAdmin.shipping).toHaveLength(0);
  });

  it('a delivered order lands in delivered, not in shipping', () => {
    const done = { ...mine, bostaStatus: 'DELIVERED', deliveredAt: '2026-09-02T10:00:00.000Z' };
    const res = runRowSource({ adminMode: false, transactions: [done], workspace: null });
    expect(res.delivered).toHaveLength(1);
    expect(res.shipping).toHaveLength(0);
  });

  it('a cancelled order is excluded from every bucket', () => {
    const dead = { ...mine, cancelled: true };
    const res = runRowSource({ adminMode: false, transactions: [dead], workspace: null });
    expect(res.salesTx).toHaveLength(0);
  });
});

describe('staff dashboard — the panels are wired and admin-guarded', () => {
  const src = readIndex();

  it('every staff panel is hidden for an admin', () => {
    // Each renderer owns its own guard, because these are globals reachable from
    // applyLang() and several navigation paths — not only from loadDashboard().
    for (const fn of ['renderMyKpis', 'renderMyShift', 'renderMyFollowUps']) {
      expect(extractFn(src, fn)).toContain('isAdmin()');
    }
  });

  it('the company-level shipping figures are admin-only', () => {
    /* Owner decision (8 Sep 2026): staff read the same shipment ROWS as the admin,
       but not the company SCORECARD. «وصل بنجاح» (lifetime total) and «نسبة النجاح»
       are performance metrics, not operational facts — showing them turns a work
       queue into a report card. What stays for staff: how many are in transit and
       how many have a problem, which is what they act on. */
    /* ⚠ `extractFn` brace-matches from the first `{`, which for a destructured
       parameter list is the parameter itself — so it returns only the signature.
       Slice the source between this function and the next instead. */
    const from = src.indexOf('function renderDashShipKpis(');
    const to = src.indexOf('function renderDashAttention(', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const fn = src.slice(from, to);
    expect(fn).toContain('isAdmin()');
    // Both the delivered tile and the success-rate block hang off the same gate,
    // so one cannot be exposed while the other is hidden.
    expect(fn).toContain('showTotals ?');
    expect(fn).toContain('showTotals && rate !== null');
  });

  it('staff get a delivery filter, capped at one week', () => {
    /* Owner decision (8 Sep 2026): staff may filter deliveries over a SHORT range —
       اليوم / أمس / آخر ٣ أيام / آخر ٧ أيام — but not the long ranges or «الكل»,
       which answer "how is the company doing" rather than "what happened this week". */
    const list = src.match(/const _DASH_STAFF_PERIODS = \[([^\]]*)\]/);
    expect(list).not.toBeNull();
    const allowed = (list as RegExpMatchArray)[1];
    for (const p of ['today', 'yesterday', '3d', '7d']) expect(allowed).toContain(p);
    // The unbounded option must NOT be reachable — it would void the cap entirely.
    expect(allowed).not.toContain("'all'");
    for (const p of ['14d', '30d', '60d', '90d']) expect(allowed).not.toContain(`'${p}'`);
    expect(src).toContain("'3d': 3");                       // the new range actually resolves
  });

  it('the cap is enforced in the setter, not only by hiding buttons', () => {
    /* ⚠ `_setDashDeliveredPeriod` is a global reachable from the console, so a hidden
       button is presentation, not a limit. The guard must reject the value itself. */
    const fn = extractFn(src, '_setDashDeliveredPeriod');
    expect(fn).toMatch(/!isAdmin\(\)\s*&&\s*!_DASH_STAFF_PERIODS\.includes\(period\)/);
    // And a staff member left on a now-forbidden range is moved to one they can see.
    const sync = extractFn(src, '_syncShipAdminBits');
    expect(sync).toContain('_DASH_STAFF_PERIODS.includes(_dashDeliveredPeriod)');
    expect(sync).toContain("_dashDeliveredPeriod = '7d'");
  });

  it('the delivered TAB COUNT is hidden too — it is the same number as the KPI', () => {
    /* ⚠ Hiding «وصل بنجاح» while the tab badge beside it still printed the same
       figure (444) was cosmetic, not a real restriction. Both the badge and the
       "N orders" line under it are gated, and the tab itself stays clickable: a
       staff member still needs to open a delivered shipment a customer asks about. */
    const from = src.indexOf("qs('#dash-tab-count-shipping')");
    const to = src.indexOf('const byTab =', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const block = src.slice(from, to);
    expect(block).toContain("qs('#dash-tab-count-delivered')");
    /* ⚠ Assert the GATE, not merely that `isAdmin()` appears somewhere in the block —
       it appears for the total line too, so a bare `toContain('isAdmin()')` still
       passed when the badge was reverted to printing the number unconditionally. */
    expect(block).toContain("showTotals ? String(delivered.length) : ''");
    expect(block).toMatch(/delCountEl\.style\.display\s*=\s*showTotals/);
    // The per-tab total line must also skip the delivered tab for staff.
    expect(block).toContain("_dashShipTab === 'delivered'");
  });

  it('the period control stays visible for staff — only its long ranges are removed', () => {
    /* Superseded the earlier rule that hid the control outright: staff DO get a filter,
       just a short one. What is pinned here is that the trimming happens per BUTTON,
       so the admin keeps the full set from the very same markup. */
    const fn = extractFn(src, '_syncShipAdminBits');
    expect(fn).toContain("qs('#dash-ship-period')");
    expect(fn).toContain("querySelectorAll('.ds-period-btn')");
    expect(fn).toContain('_DASH_STAFF_PERIODS.includes(b.dataset.period)');
    // The container itself is no longer blanket-hidden.
    expect(fn).not.toMatch(/per\.style\.display\s*=\s*adm\s*\?/);
  });

  it('loadMyWorkspace records failure instead of turning it into an empty state', () => {
    // LOAD_FAIL rule: "could not load" must never render as "you have no work".
    const fn = extractFn(src, 'loadMyWorkspace');
    expect(fn).toContain('_myWsFailed = true');
    expect(fn).toContain('/employee-performance/my-workspace');
    expect(fn).toContain('/employee-performance/my-roster');
  });

  it('the KPI cards read the scoped payload, never a global array', () => {
    const fn = extractFn(src, 'renderMyKpis');
    expect(fn).toContain('_myWorkspace');
    expect(fn).not.toMatch(/\btransactions\b/);
    expect(fn).not.toMatch(/\bfollowUps\b/);
  });

  it('the follow-ups panel reads the scoped payload, never the global followUps', () => {
    const fn = extractFn(src, 'renderMyFollowUps');
    expect(fn).toContain('_myWorkspace');
    // `followUps` (the global holding every employee's tickets) must not appear.
    expect(fn).not.toMatch(/[^_.]\bfollowUps\b/);
  });

  it('the shift grid highlights today and states the no-shift case', () => {
    const shell = extractFn(src, 'renderMyShift');
    const table = extractFn(src, '_myShiftTableHtml');
    expect(shell).toContain('dsMeNoShift');
    // Reads its own roster payload, not the admin-only global shift list.
    expect(shell).toContain('_myRoster');
    expect(shell).not.toMatch(/\bemployeeShifts\b/);
    expect(table).toContain('todayWeekday');
    expect(table).not.toMatch(/\bemployeeShifts\b/);
  });

  it('the week grid reuses the admin table classes rather than a second design', () => {
    // ⚠ The staff grid and the admin grid must look identical. Reusing `sm-*` and the
    // shift-kind helpers is what guarantees it: a private copy would diverge the first
    // time either side was restyled, and the same shift would then read two different
    // ways to the employee and to their manager.
    const table = extractFn(src, '_myShiftTableHtml');
    expect(table).toContain('sm-tbl');
    expect(table).toContain('sm-cell');
    expect(table).toContain('_shiftKind');
    expect(table).toContain('_wsKindIcon');
  });

  it('the User Hub schedule renders through the SAME builders as the dashboard', () => {
    const uh = extractFn(src, 'renderUhShift');
    expect(uh).toContain('_myShiftHeadHtml');
    expect(uh).toContain('_myShiftTableHtml');
    expect(uh).toContain('isAdmin()');
  });

  it('the roster is refreshed on a timer so "on shift now" cannot go stale', () => {
    // A panel still saying "you are working now" an hour after the shift ended is
    // worse than no panel. The same tick moves the today-highlight past midnight.
    expect(extractFn(src, '_dutyTimerSync')).toContain('loadMyRoster');
    const load = extractFn(src, 'loadMyRoster');
    expect(load).toContain('/employee-performance/my-roster');
  });

  it('follow-ups render as clickable tickets that open the specific ticket', () => {
    const fn = extractFn(src, 'renderMyFollowUps');
    expect(fn).toContain('ds-fu-tk');
    expect(fn).toContain('openMyFollowUp');
    // Lands on the ticket, not on an unfiltered list the employee must search again.
    const open = extractFn(src, 'openMyFollowUp');
    expect(open).toContain('fu-search');
    expect(open).toContain('followups');
  });
});

describe('staff dashboard — translation keys exist in both languages', () => {
  const src = readIndex();

  it('every dsMe*/dsMyShift/dsHour key used is defined with a non-empty ar and en', () => {
    // ⚠ A key whose value is legitimately '' in one language falls back to Arabic,
    // because t() evaluates `entry[lang] || entry.ar` — the vltAcctPrefix trap.
    const keys = [
      'dsMeAssigned', 'dsMeAssignedSub', 'dsMePoints', 'dsMeDelivered',
      'dsMeFollowUps', 'dsMeFollowUpsKpi', 'dsMeFollowUpsSub', 'dsMeTrendVsPrev', 'dsMeTrendFlat',
      'dsMeLoadError', 'dsMeNoFollowUps', 'dsMeFuTruncated', 'dsMeAutoFu',
      'dsMyShiftTitle', 'dsMeOnShift', 'dsMeOffShift', 'dsMeOnLeave',
      'dsMeRemaining', 'dsMeToday', 'dsMeDayOff', 'dsMeOnCall',
      'dsMeShiftInactive', 'dsMeNoShift', 'dsMeUpcomingLeave',
      'dsHourShort', 'dsMinShort', 'dsHourMinShort',
    ];
    for (const k of keys) {
      const m = new RegExp(`\\b${k}:\\{ar:'([^']*)',en:'([^']*)'\\}`).exec(src);
      expect(m ? `${k}` : `${k} MISSING`).toBe(k);
      expect(m![1].length).toBeGreaterThan(0);
      expect(m![2].length).toBeGreaterThan(0);
    }
  });
});
