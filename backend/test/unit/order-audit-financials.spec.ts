import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
const root = resolve(__dirname, '../../../frontend/public');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const helpers = readFileSync(resolve(root, 'order-audit-financials.js'), 'utf8');
const renderers = html.slice(html.indexOf('function auditFinScopeRows('), html.indexOf('function renderAuditShipping('));
const rows = [
  { orderNumber: '1', registered: true, syncStatus: 'synced', orderTotal: 1000, netProfit: 200 },
  { orderNumber: '2', syncStatus: 'pending', depositApproved: 100, orderTotal: 2000 },
  { orderNumber: '3', syncStatus: 'pending', depositPending: 200, depositApproved: 100, shipWithoutDeposit: true, orderTotal: 3000 },
  { orderNumber: '4', syncStatus: 'pending', shipWithoutDeposit: true, orderTotal: 4000 },
  { orderNumber: '5', syncStatus: 'pending', orderTotal: 5000 },
  { orderNumber: '6', syncStatus: 'cancelled', cancelled: false, orderTotal: 6000 },
  { orderNumber: '7', syncStatus: 'missing', orderTotal: 0 },
];
function view() {
  const el = { innerHTML: '' };
  const context: any = { window:{}, document: { addEventListener: jest.fn(), getElementById: () => null }, qs: () => el,
    fmtJ: (n: number) => `EGP ${n}`, fmtNum: String, currentAuditData: { rows } };
  runInNewContext(helpers + '\n' + renderers, context);
  return { context, el };
}
describe('Order audit financial multi-selection', () => {
  it('includes approved and pending receipts, and keeps the no-deposit shipping choice exclusive', () => {
    const { context: c } = view();
    expect(c.auditFinScopeRows({ rows }, 'pending-deposit').map((r: any) => r.orderNumber)).toEqual(['2', '3']);
    expect(c.auditFinScopeRows({ rows }, 'pending-without-deposit').map((r: any) => r.orderNumber)).toEqual(['4']);
    expect(c.auditFinScopeRows({ rows }, 'pending-no-choice').map((r: any) => r.orderNumber)).toEqual(['5']);
  });
  it('unions selected categories without duplicate orders and preserves legacy all/pending scopes', () => {
    const { context: c } = view();
    expect(c.auditFinScopeRows({ rows }, ['synced', 'pending-deposit', 'pending-without-deposit', 'pending-deposit']).map((r: any) => r.orderNumber)).toEqual(['1', '2', '3', '4']);
    expect(c.auditFinScopeRows({ rows }, 'all')).toHaveLength(7);
    expect(c.auditFinScopeRows({ rows }, 'pending')).toHaveLength(4);
    expect(c.auditFinScopeRows({ rows }, 'cancelled')[0].orderNumber).toBe('6');
    expect(c.auditFinScopeRows({ rows }, [])).toEqual([]);
  });
  it('aggregates the chosen rows, preserves the choice on new results, and bases profit margin on registered sales', () => {
    const { context: c, el } = view();
    c.renderAuditFinancials({ rows }, ['synced', 'pending-deposit', 'pending-without-deposit']);
    expect(el.innerHTML).toContain('<strong>4</strong>');
    expect(el.innerHTML).toContain('EGP 10000');
    expect(el.innerHTML).toContain('20%');
    expect(el.innerHTML).toContain('الربح وهامش الربح يشملان الطلبات المسجّلة فقط');
    c.renderAuditFinancials({ rows: rows.slice(0, 3) });
    expect(el.innerHTML).toContain('<strong>3</strong>');
    c.renderAuditFinancials({ rows }, []);
    expect(el.innerHTML).toContain('<strong>0</strong>');
    expect(el.innerHTML).toContain('اختر حالة واحدة على الأقل');
  });
});
