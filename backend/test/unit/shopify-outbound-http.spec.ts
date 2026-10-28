import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ShopifySyncController } from '../../src/shopify/sync/sync.controller';
import { ShopifySyncService } from '../../src/shopify/sync/sync.service';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { SyncApiError } from '../../src/shopify/sync/sync-api.service';

describe('Shopify outbound endpoint authorization and validation', () => {
  let app: INestApplication, url: string;
  const service = { status: jest.fn(async () => ({ enabled: false })), preview: jest.fn(async (..._args: any[]) => ({ results: [] })),
    execute: jest.fn(async () => ({ results: [] })), configure: jest.fn(async (..._args: any[]) => ({ enabled: false })) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ShopifySyncController], providers: [{ provide: ShopifySyncService, useValue: service }] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx: any) => { const r = ctx.switchToHttp().getRequest(); r.user = { userId: 'actor', role: r.headers['x-role'] }; return !!r.user.role; } }).compile();
    app = module.createNestApplication(); app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1'); url = (await app.getUrl()) + '/shopify/sync/';
  });
  afterAll(async () => { await app?.close(); });
  function post(route: string, body: any, role = 'admin') {
    return fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': role }, body: JSON.stringify(body) });
  }
  it('denies staff and unauthenticated callers', async () => {
    expect((await fetch(url + 'status')).status).toBe(403);
    expect((await post('config', { enabled: true, includePayments: false }, 'staff')).status).toBe(403);
    expect(service.configure).not.toHaveBeenCalled();
  });
  it('requires actual booleans so the string false cannot enable sending', async () => {
    expect((await post('config', { enabled: 'false', includePayments: false })).status).toBe(400);
    expect((await post('config', { enabled: true })).status).toBe(400);
  });
  it('rejects empty, oversized and malformed selections', async () => {
    for (const transactionIds of [[], ['bad-id'], Array(11).fill('507f1f77bcf86cd799439011')]) {
      expect((await post('preview', { transactionIds, includePayments: false })).status).toBe(400);
    }
    expect((await post('execute', { tokens: ['bad-token'] })).status).toBe(400);
  });
  it('binds preview to the authenticated actor, never a body-supplied actor', async () => {
    const ids = ['507f1f77bcf86cd799439011'];
    expect((await post('preview', { transactionIds: ids, includePayments: false, by: 'other' })).status).toBe(201);
    expect(service.preview).toHaveBeenLastCalledWith(ids, false, 'actor');
  });
  it('returns actionable safe API errors', async () => {
    service.configure.mockRejectedValueOnce(new SyncApiError('صلاحيات التطبيق غير كافية.'));
    const res = await post('config', { enabled: true, includePayments: false });
    expect(res.status).toBe(400); expect((await res.json()).message).toBe('صلاحيات التطبيق غير كافية.');
  });
});
