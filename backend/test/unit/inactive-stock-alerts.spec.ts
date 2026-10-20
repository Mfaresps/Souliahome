import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { TransactionsService } from '../../src/transactions/transactions.service';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const rows = () => [
  { code: 'inactive-low', name: 'Inactive low', current: 1, minStock: 5, status: 'low', isActive: false },
  { code: 'inactive-zero', name: 'Inactive zero', current: 0, minStock: 5, status: 'zero', isActive: false },
  { code: 'active-low', name: 'Active low', current: 1, minStock: 5, status: 'low', isActive: true },
  { code: 'active-zero', name: 'Active zero', current: 0, minStock: 5, status: 'zero', isActive: true },
  { code: 'legacy-low', name: 'Legacy low', current: 1, minStock: 5, status: 'low' },
  { code: 'active-ok', name: 'Available', current: 20, minStock: 5, status: 'ok', isActive: true },
];

it('excludes inactive low and empty products from notifications and restores alerts on reactivation', () => {
  const source = html.slice(html.indexOf('function buildStockNotifs()'), html.indexOf('function buildNotifications()'));
  const c: any = { currentUser: { role: 'admin' }, inventoryCache: rows(), ICON: () => '', t: (s: string) => s };
  runInNewContext(source, c);
  expect(c.buildStockNotifs().map((n: any) => n.id)).toEqual(['stock-low-active-low', 'stock-out-active-zero', 'stock-low-legacy-low']);
  c.inventoryCache[0].isActive = true;
  expect(c.buildStockNotifs().map((n: any) => n.id)).toContain('stock-low-inactive-low');
  c.inventoryCache[0].isActive = false;
  expect(c.buildStockNotifs().map((n: any) => n.id)).not.toContain('stock-low-inactive-low');
});

it('uses active products for dashboard alert counts and lists while retaining all inventory records', async () => {
  const inventory = rows();
  const service: any = Object.create(TransactionsService.prototype);
  const chain: any = { exec: jest.fn(async () => []) };
  chain.sort = chain.limit = () => chain;
  service.getInventory = jest.fn(async () => inventory);
  service.transactionModel = { find: () => chain };
  service.returnRequestModel = { find: () => chain };
  service.productsService = { findAll: async () => [] };
  service.getSettledSupplierReturnsTotal = async () => 0;
  service.getTotalSupplierDebt = async () => 0;
  const result = await service.getDashboard();
  expect(result.totalProducts).toBe(6);
  expect(result.lowStockCount).toBe(3);
  expect(result.lowStockItems.map((r: any) => r.code)).toEqual(['active-low', 'active-zero', 'legacy-low']);
  inventory[0].isActive = true;
  expect((await service.getDashboard()).lowStockCount).toBe(4);
});

it('excludes inactive products from inventory shortage counts and filters, and keeps their stock visible in All', () => {
  const source = html.slice(html.indexOf('function renderInventory()'), html.indexOf('function openInventoryDetail('));
  const elements = new Map<string, any>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', value: '', style: {}, closest: () => null, querySelectorAll: () => [] });
    return elements.get(selector);
  };
  const c: any = {
    inventoryCache: rows(), window: {}, settings: {}, isAdmin: () => true,
    qs: element, qsa: () => [], fmtN: String, fmtJ: String, t: (s: string) => s, ICON: () => '', esc: String, escHtml: String,
    normalizeUiSearch: (s: string) => s, fxState: { inv: {} }, invFilter: 'all', invPage: 1,
    _fxInRange: () => true, _fxMatchSupplier: () => true, _fxMatchSpecs: () => true, _fxApplySort: (_: string, data: any) => data,
    _fxBuildChips: () => {}, renderEmptyState: () => '', productThumbHtml: () => '', renderPagination: () => {},
  };
  runInNewContext(source, c);
  c.renderInventory();
  expect(element('#inv-count-all').textContent).toBe('6');
  expect(element('#inv-count-low').textContent).toBe('2');
  expect(element('#inv-count-zero').textContent).toBe('1');
  expect(element('#inv-tbody').innerHTML).toContain('inactive-low');
  expect(element('#inv-tbody').innerHTML).toContain('inactiveBadge');
  c.invFilter = 'low'; c.renderInventory();
  expect(element('#inv-tbody').innerHTML).not.toContain('inactive-low');
  expect(element('#inv-tbody').innerHTML).toContain('active-low');
  c.invFilter = 'zero'; c.renderInventory();
  expect(element('#inv-tbody').innerHTML).not.toContain('inactive-zero');
  expect(element('#inv-tbody').innerHTML).toContain('active-zero');
});
