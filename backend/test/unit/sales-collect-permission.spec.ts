/* «تحصيل المبلغ من العميل» (Nov 25, 2026): customer collection needs sales-collect on the route;
   supplier payments keep their own rule inside collect(). */
import { ForbiddenException } from '@nestjs/common';
import { TransactionsController } from '../../src/transactions/transactions.controller';

function setup(type: string) {
  const svc = { findById: jest.fn(async () => ({ _id: 't1', type })), collect: jest.fn(async () => ({ ok: true })) };
  const ctrl = new TransactionsController(svc as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, ctrl };
}
const req = (role: string, perms: string[]) => ({ user: { role, name: 'Mona', perms } });

describe('Customer collection permission', () => {
  it('refuses a sale without the permission and writes nothing', async () => {
    const { svc, ctrl } = setup('مبيعات');
    await expect(ctrl.collect('t1', {} as any, req('staff', ['movements']))).rejects.toThrow(ForbiddenException);
    expect(svc.collect).not.toHaveBeenCalled();
  });
  it('allows a sale with the permission, and an admin', async () => {
    const { svc, ctrl } = setup('مبيعات');
    await ctrl.collect('t1', {} as any, req('staff', ['sales-collect']));
    await ctrl.collect('t1', {} as any, req('admin', []));
    expect(svc.collect).toHaveBeenCalledTimes(2);
  });
  it('leaves supplier payments to their own rule (checked inside collect)', async () => {
    const { svc, ctrl } = setup('مشتريات');
    await ctrl.collect('t1', {} as any, req('staff', ['suppliers-pay']));
    expect(svc.collect).toHaveBeenCalledTimes(1);
  });
});
