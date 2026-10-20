import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const helpers = html.slice(html.indexOf('let _supLedgerBalances = null;'), html.indexOf('/* ── Suppliers Payments Log'));
const enter = html.slice(html.indexOf("    case 'suppliers': {"), html.indexOf("    case 'supplier-profile':", html.indexOf("    case 'suppliers': {")));

function view() {
  const elements: Record<string, any> = {
    '#sup-search': { value: '' }, '#sup-sort': { value: 'name' },
    '#sup-count-label': {}, '#suppliers-grid': { innerHTML: '' },
  };
  let resolveRequest: (value: any) => void = () => {};
  let rejectRequest: (reason: any) => void = () => {};
  const api = jest.fn(() => new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; }));
  const context: any = {
    api, console: { error: jest.fn() }, currentPage: 'suppliers', currentSupplierId: null,
    suppliers: [{ _id: 'supplier-1', name: 'Supplier' }], supplierReturns: [],
    qs: (selector: string) => elements[selector],
    getSupplierPurchases: () => [{ total: 900, remaining: 750, payStatus: 'pending' }],
    getSupplierReturnsAdjustment: () => ({ purchased: 0, refund: 0, debtOffset: 0 }),
    getSupplierTotalPaid: () => 150, isStatusPending: () => true,
    supplierPhoneList: () => [], isAdmin: () => false,
    t: (key: string) => key, fmtN: String, fmtJ: (n: number) => `EGP ${n}`,
    esc: String, escHtml: String,
    _populateSuppliersPaymentsDropdown: jest.fn(),
  };
  runInNewContext(helpers + '\nfunction enterSuppliers() { switch (currentPage) {\n' + enter + '\n} }', context);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { context, elements, api, resolve: (v: any) => resolveRequest(v), reject: (e: any) => rejectRequest(e), flush,
    card: () => elements['#suppliers-grid'].innerHTML as string };
}

describe('Supplier card ledger loading', () => {
  it('shows a neutral placeholder until the authoritative balance arrives, then reuses it on re-entry', async () => {
    const v = view();
    v.context.enterSuppliers();
    expect(v.card()).toContain('aria-busy="true"');
    expect(v.card()).not.toContain('⚠');
    expect(v.card()).not.toContain('EGP 750');
    expect(v.card()).not.toContain('is-debt');
    v.resolve({ 'supplier-1': { debt: 510, credit: 0, balance: 510 } });
    await v.flush();
    expect(v.card()).toContain('EGP 510');
    expect(v.card()).not.toContain('aria-busy="true"');
    expect(v.card()).not.toContain('⚠');
    v.context.enterSuppliers();
    expect(v.api).toHaveBeenCalledTimes(1);
    expect(v.card()).toContain('EGP 510');
  });

  it('marks an estimate only after an actual failure and clears the warning while retrying', async () => {
    const v = view();
    v.context.enterSuppliers();
    v.reject(new Error('Ledger unavailable'));
    await v.flush();
    expect(v.card()).toContain('⚠');
    expect(v.card()).toContain('~EGP 750');
    expect(v.card()).not.toContain('aria-busy="true"');
    v.context.enterSuppliers();
    expect(v.card()).not.toContain('⚠');
    expect(v.card()).toContain('aria-busy="true"');
    v.resolve({ 'supplier-1': { debt: 0, credit: 0, balance: 0 } });
    await v.flush();
    expect(v.card()).toContain('supPaidPill');
    expect(v.card()).not.toContain('EGP 750');
    expect(v.card()).not.toContain('⚠');
  });

  it('keeps loaded balances during a refresh and does not repaint another page after navigation', async () => {
    const v = view();
    v.context.enterSuppliers();
    v.context.currentPage = 'inventory';
    const before = v.card();
    v.resolve({ 'supplier-1': { debt: 510 } });
    await v.flush();
    expect(v.card()).toBe(before);
    v.context.currentPage = 'suppliers';
    v.context.enterSuppliers();
    const refresh = v.context.refreshSupplierBalances();
    v.context.renderSuppliers();
    expect(v.card()).toContain('EGP 510');
    expect(v.card()).not.toContain('aria-busy="true"');
    v.resolve({ 'supplier-1': { debt: 420 } });
    await refresh;
    expect(v.card()).toContain('EGP 420');
  });
});
