/* «فلاتر وترتيب سجل المعاملات» (Nov 25, 2026): without it the server drops every filter but
   search / type / status / paging. */
import { TransactionsController } from '../../src/transactions/transactions.controller';
import { stripMovementFilters } from '../../src/transactions/movements-page.util';
import { normalizeRolePermissions } from '../../src/users/access-role-permissions';

const full = {
  page: 2, limit: 25, search: '3312', type: 'مبيعات', status: 'معلق', sort: 'total-desc',
  dateFrom: '2026-11-01', dateTo: '2026-11-20', dateField: 'createdAt', amountMin: '100', amountMax: '900',
  discountOnly: true, discountCode: 'SAVE10', tag: 'عاجل', employee: ['Mona'], method: ['كاش'],
  drawerStatus: ['مكتمل'], bosta: ['DELIVERED'], pickup: ['Ready'], operation: ['x'],
};

describe('Transactions filters permission', () => {
  it('strips everything but search, type, status and paging (newest first)', () => {
    expect(stripMovementFilters(full as any)).toEqual({
      page: 2, limit: 25, search: '3312', type: 'مبيعات', status: 'معلق', sort: 'date-desc',
      showExcluded: undefined, excludedIds: undefined, recentUpdates: undefined,
    });
  });

  it('the controller applies it unless the account holds the permission', async () => {
    const svc = { findMovementsPage: jest.fn(async (state: any) => state) };
    const ctrl = new TransactionsController(svc as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const staff = await ctrl.movementsPage(full as any, { user: { role: 'staff', perms: ['movements'] } }) as any;
    expect(staff.sort).toBe('date-desc');
    expect(staff.dateFrom).toBeUndefined();
    expect(staff.employee).toBeUndefined();
    expect(staff.search).toBe('3312');
    const allowed = await ctrl.movementsPage(full as any, { user: { role: 'staff', perms: ['movements', 'movements-filters'] } }) as any;
    expect(allowed).toEqual(full);
    const admin = await ctrl.movementsPage(full as any, { user: { role: 'admin' } }) as any;
    expect(admin.sort).toBe('total-desc');
  });

  it('implies viewing the log', () => {
    expect(normalizeRolePermissions(['movements-filters'])).toContain('movements');
  });
});
