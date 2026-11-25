/* Bulk-browsing protection (Nov 25, 2026): depth limit, short searches, masked phones, paging
   pause, and the request → approve → grant → expiry flow on a scratch Mongo database. */
import mongoose from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import { BrowseAccessService, maskPhone, maskRowPhones } from '../../src/browse-access/browse-access.service';
import { TransactionsController } from '../../src/transactions/transactions.controller';
import { ClientsController } from '../../src/clients/clients.controller';
import { InventoryMovementsController } from '../../src/inventory-movements/inventory-movements.controller';

const URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27018/soulia_test_browse_access';
let conn: mongoose.Connection;
const staff = { userId: 'u1', role: 'staff', name: 'Mona', username: 'mona', perms: ['movements', 'clients'] };
const admin = { userId: 'a1', role: 'admin', name: 'Owner', username: 'admin', perms: [] };

beforeAll(async () => { conn = await mongoose.createConnection(URI, { serverSelectionTimeoutMS: 4000 }).asPromise(); await conn.dropDatabase(); });
afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

function service() {
  const mentions = { createMany: jest.fn(async (rows: any[]) => rows.map((r, i) => ({ ...r, _id: 'm' + i }))) };
  const users = { findAll: jest.fn(async () => [{ _id: 'a1', role: 'admin', username: 'admin', name: 'Owner' }, { _id: 'u1', role: 'staff' }]) };
  const audit = { log: jest.fn(async () => ({})) };
  return { svc: new BrowseAccessService(conn as any, mentions as any, users as any, audit as any, undefined), mentions, audit };
}

describe('phones in lists', () => {
  it('masks all but the first and last three digits; permission holders see them', () => {
    expect(maskPhone('01012345678')).toBe('010•••••678');
    const rows = [{ phone: '01012345678', phones: ['01198765432'] }];
    expect(maskRowPhones(rows, staff)[0]).toMatchObject({ phone: '010•••••678', phones: ['011•••••432'], phoneMasked: true });
    expect(maskRowPhones(rows, { ...staff, perms: ['customers-phone-view'] })[0].phone).toBe('01012345678');
  });
});

describe('transactions log depth and search', () => {
  it('first 5 pages, short searches ignored, phones masked; page 6 refused', async () => {
    const { svc } = service();
    const tx = { findMovementsPage: jest.fn(async (q: any) => ({ pageRows: [{ phone: '01012345678' }], q })) };
    const ctrl = new TransactionsController(tx as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, svc);
    const r: any = await ctrl.movementsPage({ page: 5, search: 'ab' } as any, { user: staff } as any);
    expect(r.q.search).toBe('');
    expect(r.pageRows[0].phone).toBe('010•••••678');
    await expect(ctrl.movementsPage({ page: 6 } as any, { user: staff } as any)).rejects.toThrow(ForbiddenException);
    const ok: any = await ctrl.movementsPage({ page: 40, search: 'ab' } as any, { user: { ...staff, userId: 'u9', perms: ['movements', 'movements-browse'] } } as any);
    expect(ok.q.page).toBe(40);
  });

  it('a larger page size does not reach past the first 5 × 20 rows', async () => {
    const { svc } = service();
    const tx = { findMovementsPage: jest.fn(async (q: any) => ({ pageRows: [], q })) };
    const ctrl = new TransactionsController(tx as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, svc);
    const r: any = await ctrl.movementsPage({ page: 5, limit: 100 } as any, { user: { ...staff, userId: 'lim' } } as any);
    expect(r.q.limit).toBe(20);
    const small: any = await ctrl.movementsPage({ page: 1, limit: 10 } as any, { user: staff } as any);
    expect(small.q.limit).toBe(10);
    const ok: any = await ctrl.movementsPage({ page: 5, limit: 100 } as any, { user: { ...staff, userId: 'u8', perms: ['movements', 'movements-browse'] } } as any);
    expect(ok.q.limit).toBe(100);
  });

  it('stock movement log: 5 pages of 20, page 1 up to 100, short searches ignored', async () => {
    const { svc } = service();
    const inv = { findAll: jest.fn(async (filters: any, page: number, limit: number) => ({ filters, page, limit })) };
    const ctrl = new InventoryMovementsController(inv as any, svc);
    const user = { ...staff, userId: 'inv1', perms: ['inventory'] };
    const call = (page: string, limit: string, code?: string, u: any = user) =>
      (ctrl.findAll as any)(page, limit, code, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { user: u });
    expect((await call('3', '100')).limit).toBe(20);
    expect((await call('1', '100', 'Code 21')).limit).toBe(100);
    expect((await call('1', '20', 'ab')).filters.productCode).toBeUndefined();
    await expect(call('6', '20')).rejects.toThrow(ForbiddenException);
    const ok: any = await call('9', '100', undefined, { ...user, userId: 'inv2', perms: ['inventory', 'inventory-log-browse'] });
    expect(ok).toMatchObject({ page: 9, limit: 100 });
  });

  it('pauses paging after 30 page turns in an hour and tells the admins once', async () => {
    const { svc, mentions, audit } = service();
    const user = { ...staff, userId: 'pager' };
    for (let i = 0; i < 30; i++) await svc.trackPaging(user, 'movements');
    const err = await svc.trackPaging(user, 'movements').catch(e => e);
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse().code).toBe('BROWSE_PAUSED');
    await expect(svc.trackPaging(user, 'movements')).rejects.toBeTruthy(); // still paused
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(mentions.createMany).toHaveBeenCalledTimes(1);
    await svc.trackPaging(admin, 'movements'); // admins are never counted
  });
});

describe('request → approve → grant', () => {
  it('one open request; admins notified; approval opens the scope until it expires', async () => {
    const { svc, mentions } = service();
    expect(await svc.canBrowse(staff, 'clients')).toBe(false);
    const req1 = await svc.request(staff, 'clients', 'مراجعة');
    const req2 = await svc.request(staff, 'clients', 'again');
    expect((req2 as any).id).toBe((req1 as any).id);
    expect(mentions.createMany.mock.calls[0][0][0].targetUserId).toBe('a1');
    expect((await svc.pending()).length).toBe(1);
    await svc.decide((req1 as any).id, admin, true, 8);
    expect(await svc.canBrowse(staff, 'clients')).toBe(true);
    expect(await svc.canBrowse(staff, 'movements')).toBe(false);
    expect((await svc.mine(staff)).clients.grantUntil).toBeTruthy();
    await expect(svc.decide((req1 as any).id, admin, false)).rejects.toThrow('لم يعد معلقًا');
    // the employee is told
    expect(mentions.createMany.mock.calls.at(-1)[0][0].targetUserId).toBe('u1');
    // expiry: move the grant into the past
    await conn.collection('browseaccessrequests').updateOne({ _id: new mongoose.Types.ObjectId((req1 as any).id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const fresh = service().svc;
    expect(await fresh.canBrowse(staff, 'clients')).toBe(false);
  });

  it('the client list follows the grant', async () => {
    const { svc } = service();
    const user = { ...staff, userId: 'u5' };
    const list = { list: jest.fn(async (page: number, total: boolean, q: string) => ({ rows: [{ phone: '01012345678' }], page, total, q })) };
    const ctrl = new ClientsController(list as any, svc);
    await expect(ctrl.list('2', '', { user })).rejects.toThrow(ForbiddenException);
    const r: any = await ctrl.list('1', 'ab', { user });
    expect(r.q).toBe('');
    const req = await svc.request(user, 'clients', '');
    await svc.decide((req as any).id, admin, true, 1);
    const ok: any = await service().svc.canBrowse(user, 'clients');
    expect(ok).toBe(true);
  });
});
