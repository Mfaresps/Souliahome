import { TransactionsController } from '../../src/transactions/transactions.controller';

// The receipt routes on a confirmed sale («إضافة عربون» from the edit window) take the employee from the
// controller's receiptActor. JwtStrategy stores the account id as `userId`; reading only `sub` refused
// every request with «تعذّر تحديد الموظف».
describe('TransactionsController.receiptActor', () => {
  const actorOf = (user: unknown) => (TransactionsController.prototype as any).receiptActor.call({}, { user });

  it('reads the account id JwtStrategy sets (userId)', () => {
    const a = actorOf({ userId: 'u-1', username: 'malak', name: 'Malak', role: 'staff' });
    expect(a).toEqual({ id: 'u-1', username: 'malak', name: 'Malak', isAdmin: false });
  });

  it('still accepts the older id fields and flags an admin', () => {
    expect(actorOf({ sub: 'u-2', role: 'admin' })).toMatchObject({ id: 'u-2', isAdmin: true });
  });

  it('no user → empty id (the service refuses it)', () => {
    expect(actorOf(undefined).id).toBe('');
  });
});
