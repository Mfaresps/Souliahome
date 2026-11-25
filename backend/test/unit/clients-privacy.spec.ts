/* Client list privacy (Nov 25, 2026): page 2+ needs «تصفح قائمة العملاء كاملة». */
import { ForbiddenException } from '@nestjs/common';
import { ClientsController } from '../../src/clients/clients.controller';
import { normalizeRolePermissions } from '../../src/users/access-role-permissions';

describe('Client list privacy', () => {
  const svc = { list: jest.fn(async (page: number, includeTotal: boolean) => ({ rows: [], page, includeTotal })) };
  const ctrl = new ClientsController(svc as any);
  const staff = (...perms: string[]) => ({ user: { role: 'staff', perms: ['clients', ...perms] } });
  beforeEach(() => svc.list.mockClear());

  it('page 1 is open; page 2+ is refused without the permission, even with a search', async () => {
    await ctrl.list('1', '', staff());
    expect(svc.list).toHaveBeenCalledWith(1, false, '');
    await expect(ctrl.list('2', '', staff())).rejects.toThrow(ForbiddenException);
    await expect(ctrl.list('2', 'a', staff())).rejects.toThrow(ForbiddenException);
    const err = await ctrl.list('3', '', staff()).catch(e => e);
    expect((err.getResponse() as any).code).toBe('CLIENTS_PRIVATE');
    expect(String((err.getResponse() as any).message)).toContain('خصوصية');
    expect(svc.list).toHaveBeenCalledTimes(1);
  });

  it('the permission (and admin) browse every page with the total', async () => {
    await ctrl.list('7', '', staff('clients-browse'));
    expect(svc.list).toHaveBeenLastCalledWith(7, true, '');
    await ctrl.list('9', '', { user: { role: 'admin' } });
    expect(svc.list).toHaveBeenLastCalledWith(9, true, '');
  });

  it('browsing implies viewing clients', () => {
    expect(normalizeRolePermissions(['clients-browse'])).toContain('clients');
  });
});
