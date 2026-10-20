import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { ProductsController } from '../../src/products/products.controller';
import { ProductsService } from '../../src/products/products.service';
import { ProductAnalyticsService } from '../../src/products/product-analytics.service';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { productsSkuFixture } from '../helpers/products-sku.fixture';

describe('Product SKU HTTP permissions and validation', () => {
  let app: INestApplication, base: string, f: ReturnType<typeof productsSkuFixture>;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ProductsController], providers: [
      { provide: ProductsService, useValue: Object.fromEntries(
        ['create', 'update', 'importProducts', 'bulkUpdate', 'remove', 'bulkDelete', 'batchDeleteByCodes',
          'requestProductEdit', 'approveProductEdit', 'rejectProductEdit', 'syncProductRefs'].map(key =>
          [key, (...args: any[]) => (f.service as any)[key](...args)])) },
      { provide: ProductAnalyticsService, useValue: {} },
    ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
      const req = context.switchToHttp().getRequest();
      const user = req.headers['x-test-user'];
      if (!user) throw new UnauthorizedException();
      req.user = { userId: 'authenticated-id', name: 'Authenticated Actor', username: 'actor',
        role: user === 'admin' ? 'admin' : user === 'viewer' ? 'viewer' : 'staff',
        perms: user === 'manager' ? ['products-sku-manage'] : user === 'cost-editor' ? ['purchase-edit-price'] : [] };
      return true;
    } }).compile();
    app = module.createNestApplication(); app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  beforeEach(() => { f = productsSkuFixture(); });
  afterAll(async () => { await app?.close(); });
  function request(method: string, route: string, user?: string, body?: any) {
    return fetch(base + '/products' + route, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  it('requires authentication before creating any SKU', async () => {
    expect((await request('POST', '', undefined, { name: 'New' })).status).toBe(401);
    expect(f.productModel.create).not.toHaveBeenCalled();
  });
  it.each(['staff', 'viewer'])('does not infer SKU authority from %s role or UI/OTP access', async user => {
    expect((await request('POST', '', user, { name: 'New' })).status).toBe(403);
    expect((await request('POST', '/import', user, { items: [{ code: 'A', name: 'New' }] })).status).toBe(403);
    expect(f.productModel.create).not.toHaveBeenCalled();
  });
  it.each(['admin', 'manager'])('allows %s to create a SKU with authenticated attribution', async user => {
    const result = await request('POST', '', user, { name: 'New', code: 'EXPLICIT', createdBy: 'Forged' });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ code: 'EXPLICIT', createdBy: 'Authenticated Actor' });
  });
  it.each(['admin', 'manager'])('allows %s to import matching SKU updates', async user => {
    const p = f.seed();
    expect((await request('POST', '/import', user, { items: [{ code: p.code, name: p.name, size: 'Large' }] })).status).toBe(201);
    expect(p.size).toBe('Large'); expect(p.code).toBe('ORIGINAL');
  });
  it.each(['admin', 'manager', 'staff'])('no role can change an existing SKU (%s)', async user => {
    const p = f.seed();
    expect((await request('PUT', '/' + p._id, user, { code: 'OTHER', colors: ['Red'] })).status).toBe(400);
    expect(f.productModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });
  it('leaves ordinary non-SKU edits available without SKU permission', async () => {
    const p = f.seed();
    const result = await request('PUT', '/' + p._id, 'staff', { code: p.code, colors: ['Red'], size: 'Large', sellPrice: 90 });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ code: p.code, size: 'Large', sellPrice: 90 });
  });
  it('preserves existing purchase-price permission separately from SKU permission', async () => {
    const p = f.seed();
    expect((await request('PUT', '/' + p._id, 'manager', { buyPrice: 99 })).status).toBe(403);
    expect((await request('PUT', '/' + p._id, 'cost-editor', { buyPrice: 99 })).status).toBe(200);
  });
  it('rejects bulk SKU injection instead of silently stripping it', async () => {
    const p = f.seed();
    expect((await request('POST', '/bulk-update', 'admin', { ids: [p._id], code: 'NEW', sellPrice: 9 })).status).toBe(400);
    expect(f.productModel.updateMany).not.toHaveBeenCalled();
  });
  it('uses authenticated edit-request identity and permits non-SKU requests', async () => {
    const p = f.seed();
    expect((await request('POST', '/' + p._id + '/request-edit', 'staff', {
      requestedBy: 'Forged', requestedById: 'forged-id', requestedByUsername: 'forged', changes: { colors: ['Red'] },
    })).status).toBe(201);
    expect(p.editRequest).toMatchObject({ requestedBy: 'Authenticated Actor', requestedById: 'authenticated-id', requestedByUsername: 'actor' });
  });
  it('retains admin-only review and rejects legacy SKU approvals even for admins', async () => {
    const p = f.seed({ editRequest: { status: 'معلق', changes: [{ field: 'code', newValue: 'NEW' }] } });
    expect((await request('POST', '/' + p._id + '/approve-edit', 'manager', {})).status).toBe(403);
    expect((await request('POST', '/' + p._id + '/approve-edit', 'admin', {})).status).toBe(400);
    expect(p.save).not.toHaveBeenCalled();
  });
  it.each([['DELETE', '/id'], ['POST', '/bulk-delete'], ['POST', '/batch-delete']])('protects %s %s with SKU authority', async (method, route) => {
    expect((await request(method, route, 'staff', method === 'POST' ? { ids: ['id'], codes: ['A'] } : undefined)).status).toBe(403);
  });
  it('does not grant historical-reference repair through the new staff permission', async () => {
    expect((await request('POST', '/sync-product-refs', 'manager', {})).status).toBe(403);
  });
});
