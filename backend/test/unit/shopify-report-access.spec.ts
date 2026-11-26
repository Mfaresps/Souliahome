import { ShopifyService } from '../../src/shopify/shopify.service';
import { invalidateReadCaches } from '../../src/shared/read-cache.util';
import { normalizeRolePermissions } from '../../src/users/access-role-permissions';
import {
  shopifyReportDays, shopifyReportMinMs, shopifyReportAllows, canShareShopifyReport, canSeeShopifyDepositTotals,
} from '../../src/shared/shopify-report-access.util';

export {};

const query = (rows: any[]) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(),
  then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) });

// 26 Nov 2026 14:00 in Cairo (UTC+2).
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const cairoMidnight = (day: number) => Date.UTC(2026, 10, day, -2, 0, 0);

describe('Shopify report permissions', () => {
  it('takes the widest range held; admin sees any period, nothing = no reports', () => {
    expect(shopifyReportDays({ role: 'staff', perms: ['shopify-orders'] })).toBe(0);
    expect(shopifyReportDays({ role: 'staff', perms: ['shopify-reports-today', 'shopify-reports-7d'] })).toBe(7);
    expect(shopifyReportDays({ role: 'admin', perms: [] })).toBe(Infinity);
    expect(shopifyReportMinMs({ role: 'staff', perms: [] }, NOW)).toBeNull();
  });

  it('opens the window at Cairo midnight, N-1 days back', () => {
    expect(shopifyReportMinMs({ perms: ['shopify-reports-today'] }, NOW)).toBe(cairoMidnight(26));
    expect(shopifyReportMinMs({ perms: ['shopify-reports-3d'] }, NOW)).toBe(cairoMidnight(24));
    const today = { perms: ['shopify-reports-today'] };
    expect(shopifyReportAllows(today, cairoMidnight(26), NOW)).toBe(true);
    expect(shopifyReportAllows(today, cairoMidnight(25), NOW)).toBe(false);
    expect(shopifyReportAllows(today, NaN, NOW)).toBe(false);
  });

  it('share needs a range; deposit totals are admin-only', () => {
    expect(canShareShopifyReport({ perms: ['shopify-reports-share'] })).toBe(false);
    expect(canShareShopifyReport({ perms: ['shopify-reports-share', 'shopify-reports-3d'] })).toBe(true);
    expect(canSeeShopifyDepositTotals({ perms: ['shopify-orders'] })).toBe(false);
    expect(canSeeShopifyDepositTotals({ role: 'admin', perms: [] })).toBe(true);
  });

  it('role saves: share brings the narrowest window, every key brings the Shopify page', () => {
    const perms = normalizeRolePermissions(['shopify-reports-share']);
    expect(perms).toEqual(expect.arrayContaining(['shopify-reports-today', 'shopify-orders']));
    expect(normalizeRolePermissions(['shopify-reports-7d', 'shopify-reports-share'])).not.toContain('shopify-reports-today');
  });
});

describe('summary page follows the report window', () => {
  beforeEach(invalidateReadCaches);
  const realNow = Date.now;
  afterEach(() => { Date.now = realNow; });

  function service() {
    const at = (day: number) => new Date(cairoMidnight(day) + 3600e3);
    const orders = [
      { _id: 'a', status: 'pending', createdAt: at(26), items: [], total: 100, depositReceipts: [{ id: 'r', status: 'معتمد', amount: 50, method: 'Instapay' }] },
      { _id: 'b', status: 'pending', createdAt: at(25), items: [], total: 100, depositReceipts: [] },
      { _id: 'c', status: 'pending', createdAt: at(20), items: [], total: 100, depositReceipts: [] },
    ];
    const s: any = Object.create(ShopifyService.prototype);
    s.shopifyOrderModel = { find: jest.fn(() => query(orders)) };
    s.txModel = { find: jest.fn(() => query([])) };
    s.transactionsService = { getInventory: jest.fn(async () => []) };
    s.followUpsService = { findDashboardSummary: jest.fn(async () => []) };
    return s;
  }
  const todayQuery = { tab: 'all', kpiFrom: new Date(cairoMidnight(26)).toISOString(), kpiTo: new Date(cairoMidnight(27)).toISOString(),
    kpiPrevFrom: new Date(cairoMidnight(25)).toISOString(), kpiPrevTo: new Date(NOW - 864e5).toISOString() };
  const weekQuery = { tab: 'all', kpiFilter: 'received', kpiFrom: new Date(cairoMidnight(20)).toISOString(), kpiTo: new Date(cairoMidnight(27)).toISOString() };

  it('today-only: today\'s figures, no comparison with yesterday, older periods refused', async () => {
    Date.now = () => NOW;
    const viewer = { role: 'staff', perms: ['shopify-orders', 'shopify-reports-today'] };
    const today = await service().getOrdersSummaryPage(todayQuery, 'u', viewer);
    expect(today.kpiStats.received).toBe(1);
    expect(today.kpiStats.prevReceived).toBeNull();
    invalidateReadCaches();
    const week = await service().getOrdersSummaryPage(weekQuery, 'u', viewer);
    expect(week.kpiStats).toBeNull();
    expect(week.kpiDenied).toBe(true);
    // The KPI filter is ignored too — the list stays whole, so its size gives nothing away.
    expect(week.total).toBe(3);
  });

  it('no report key: no figures and no deposit amounts', async () => {
    Date.now = () => NOW;
    const r = await service().getOrdersSummaryPage(todayQuery, 'u', { role: 'staff', perms: ['shopify-orders'] });
    expect(r.kpiStats).toBeNull();
    expect(r.depositSummary.instapay).toBeNull();
    expect(r.depositSummary.paidCount).toBe(1);
  });

  it('admin (and internal callers) see everything', async () => {
    Date.now = () => NOW;
    const r = await service().getOrdersSummaryPage(weekQuery, 'u', { role: 'admin', perms: [] });
    expect(r.kpiStats.received).toBe(3);
    expect(r.total).toBe(3);
    expect(r.depositSummary.instapay).toBe(50);
  });
});
