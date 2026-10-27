import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const start = html.indexOf('const _fuDayFormatter =');
const end = html.indexOf('\n/*', html.indexOf('function renderFuKpi(', start));
const renderStart = html.indexOf('function renderFollowUps()');
// Execute the real rendering entry point through its no-table early return.
const renderEnd = html.indexOf('  updateFuFilterBadge();', renderStart);

function fixture(rows: any[] = [], filters: Record<string, string> = {}) {
  const elements: any = { '#fu-kpi': { innerHTML: '' } };
  for (const name of ['search', 'status-filter', 'user-filter', 'from', 'to']) {
    elements['#fu-' + name] = { value: filters[name] || '' };
  }
  const context: any = {
    followUps: rows, qs: (selector: string) => elements[selector],
    t: (key: string) => key, _fuStatusLabel: (s: string) => s,
    esc: (s: string) => s, fmtN: (n: number) => String(n),
    initFilterSelects: () => {}, fselSyncAll: () => {}, document: {},
    _fuIsSettled: (f: any) => f.cancelled || ['تم حل المشكلة', 'تمت المتابعة', 'تمت عملية التأكيد', 'العميل ألغى الطلب'].includes(f.status),
  };
  runInNewContext(html.slice(start, end) + '\n' + html.slice(renderStart, renderEnd) + '\n}', context);
  return { context, elements };
}

describe('follow-up KPIs', () => {
  const now = '2026-10-27T12:00:00Z';
  const row = (status: string, extra = {}) => ({ status, createdAt: now, ...extra });

  it('includes the current default waiting status and all legacy waiting statuses', () => {
    const statuses = ['في انتظار العميل', 'في انتظار المتابعة', 'قيد المتابعة', 'بانتظار العميل',
      'في انتظار المتابعة مع العميل', 'العميل لم يرد', 'العميل مازال متردد', 'العميل أجل الطلب'];
    expect(fixture().context._fuKpiCounts(statuses.map(s => row(s)), now))
      .toEqual({ newToday: 8, waiting: 8, returns: 0, solved: 0 });
  });

  it('excludes cancelled tickets from their previous status while preserving creation counts', () => {
    const rows = ['في انتظار العميل', 'سيتم ارتجاع الشحنة', 'تم حل المشكلة', 'تمت عملية التأكيد']
      .map(s => row(s, { cancelled: true }));
    rows.push(row('العميل ألغى الطلب', { cancelled: false }));
    expect(fixture().context._fuKpiCounts(rows, now))
      .toEqual({ newToday: 5, waiting: 0, returns: 0, solved: 0 });
  });

  it('counts resolutions and returns separately from pending and order cancellations', () => {
    const rows = ['تم حل المشكلة', 'تمت المتابعة', 'تمت عملية التأكيد', 'سيتم ارتجاع الشحنة',
      'في انتظار العميل', 'العميل ألغى الطلب'].map(s => row(s));
    expect(fixture().context._fuKpiCounts(rows, now))
      .toEqual({ newToday: 6, waiting: 1, returns: 1, solved: 3 });
  });

  it.each([
    ['2026-10-27', '2026-10-26T20:59:59Z', '2026-10-26T21:00:00Z', '2026-10-27T20:59:59Z', '2026-10-27T21:00:00Z'],
    ['2026-12-27', '2026-12-26T21:59:59Z', '2026-12-26T22:00:00Z', '2026-12-27T21:59:59Z', '2026-12-27T22:00:00Z'],
  ])('uses Cairo calendar boundaries for new today and date filters on %s', (day, before, first, last, after) => {
    const rows = [before, first, last, after, '', 'invalid'].map(createdAt => row('في انتظار العميل', { createdAt }));
    const { context } = fixture(rows, { from: day, to: day });
    expect(context._fuKpiCounts(rows, day + 'T12:00:00Z').newToday).toBe(2);
    expect(context._fuFilteredRows().map((f: any) => f.createdAt)).toEqual([first, last]);
  });

  it('applies search, assignee, status and dates to the same population', () => {
    const rows = [
      row('في انتظار العميل', { responsibleName: 'Mona', orderRef: 'ABC-1' }),
      row('تم حل المشكلة', { responsibleName: 'Mona', orderRef: 'ABC-2' }),
      row('في انتظار العميل', { responsibleName: 'Ali', orderRef: 'ABC-3' }),
      row('في انتظار العميل', { responsibleName: 'Mona', orderRef: 'XYZ-1' }),
      row('في انتظار العميل', { responsibleName: 'Mona', orderRef: 'ABC-4', createdAt: '2026-10-25T12:00:00Z' }),
    ];
    const { context } = fixture(rows, { search: ' abc ', 'user-filter': 'Mona',
      'status-filter': 'في انتظار العميل', from: '2026-10-27', to: '2026-10-27' });
    expect(context._fuFilteredRows().map((f: any) => f.orderRef)).toEqual(['ABC-1']);
  });

  it('refreshes rendered KPIs when filters or statuses change, including empty results', () => {
    const { context, elements } = fixture([row('في انتظار العميل', { responsibleName: 'Mona' })]);
    const values = () => Array.from(elements['#fu-kpi'].innerHTML.matchAll(/class="fu-kpi-val">(\d+)</g), (m: any) => Number(m[1]));
    context.renderFollowUps();
    expect(values().slice(1)).toEqual([1, 0, 0]);
    elements['#fu-user-filter'].value = 'Ali';
    context.renderFollowUps();
    expect(values()).toEqual([0, 0, 0, 0]);
    elements['#fu-user-filter'].value = '';
    context.followUps[0].status = 'تم حل المشكلة';
    context.renderFollowUps();
    expect(values().slice(1)).toEqual([0, 0, 1]);
  });

  it('counts all matching records across pages', () => {
    const { context, elements } = fixture(Array.from({ length: 85 }, () => row('في انتظار العميل')));
    context._fuPage = 2;
    context._fuPerPage = 40;
    context.renderFollowUps();
    expect(elements['#fu-kpi'].innerHTML).toContain('class="fu-kpi-val">85<');
    expect(context._fuKpiCounts([], now)).toEqual({ newToday: 0, waiting: 0, returns: 0, solved: 0 });
  });
});
