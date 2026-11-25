/* Product / category edit modes, price permissions, cost visibility and delivery-issue routes
   (Nov 25, 2026). Real controllers and the real OTP spend rule over fakes. */
import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProductsController } from '../../src/products/products.controller';
import { CategoriesController } from '../../src/collections/categories.controller';
import { TransactionsController } from '../../src/transactions/transactions.controller';
import { DiscountOtpService } from '../../src/discount-otp/discount-otp.service';
import { PermsGuard } from '../../src/core/guards/perms.guard';
import { PERMS_KEY } from '../../src/core/decorators/perms.decorator';
import { canSeeCost, changedFields, maskAnalyticsCost, maskCost } from '../../src/shared/cost-visibility.util';
import { normalizeRolePermissions } from '../../src/users/access-role-permissions';

const stored = () => ({ _id: 'p1', name: 'Basket', sellPrice: 500, buyPrice: 200, avgCost: 210, features: ['b', 'a'], imageUrl: 'old.jpg' });
const user = (...perms: string[]) => ({ user: { role: 'staff', name: 'Mona', perms: ['products', ...perms] } });

function setup() {
  const svc = { findById: jest.fn(async () => stored()), findAll: jest.fn(async () => [stored()]), update: jest.fn(async (_id: string, body: any) => ({ ...stored(), ...body })) };
  const release = jest.fn(async () => undefined);
  const otp = { consumeRecordEditOtp: jest.fn(async () => release) };
  const ctrl = new ProductsController(svc as any, {} as any, {} as any, undefined, otp as any);
  return { svc, otp, release, ctrl };
}

describe('Product edit modes', () => {
  it('view only cannot save anything', async () => {
    const { ctrl, svc } = setup();
    await expect(ctrl.update('p1', { name: 'New' } as any, user() as any)).rejects.toThrow(ForbiddenException);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('direct edit saves details; prices need their own permission', async () => {
    const { ctrl, svc } = setup();
    await ctrl.update('p1', { name: 'New', imageUrl: 'new.jpg' } as any, user('products-edit') as any);
    expect(svc.update).toHaveBeenCalledTimes(1);
    await expect(ctrl.update('p1', { sellPrice: 450 } as any, user('products-edit') as any)).rejects.toThrow('سعر البيع');
    await ctrl.update('p1', { sellPrice: 450 } as any, user('products-edit', 'products-price-sell') as any);
    await expect(ctrl.update('p1', { buyPrice: 150 } as any, user('products-edit', 'products-price-sell') as any)).rejects.toThrow('سعر الشراء');
    // An unchanged price sent back by the form is not a change.
    await ctrl.update('p1', { name: 'X', sellPrice: 500, buyPrice: 200 } as any, user('products-edit') as any);
    expect(svc.update).toHaveBeenCalledTimes(3);
  });

  it('manager-code edit spends a code bound to this product and exactly the changed fields', async () => {
    const { ctrl, svc, otp } = setup();
    const r = await ctrl.update('p1', { name: 'New', imageUrl: 'new.jpg', features: ['a', 'b'], otpId: 'a'.repeat(24) } as any, user('products-edit-otp') as any);
    expect(otp.consumeRecordEditOtp).toHaveBeenCalledWith('a'.repeat(24), 'product', 'p1', ['imageUrl', 'name']); // features only re-ordered
    expect(svc.update.mock.calls[0][1]).not.toHaveProperty('otpId');
    expect(r).toBeTruthy();
    await expect(ctrl.update('p1', { sellPrice: 1 } as any, user('products-edit-otp') as any)).rejects.toThrow('سعر البيع');
  });

  it('a refused code saves nothing; a failed save gives the code back', async () => {
    const { ctrl, svc, otp, release } = setup();
    otp.consumeRecordEditOtp.mockRejectedValueOnce(new BadRequestException('كود التحقق غير صحيح'));
    await expect(ctrl.update('p1', { name: 'New' } as any, user('products-edit-otp') as any)).rejects.toThrow('كود');
    expect(svc.update).not.toHaveBeenCalled();
    svc.update.mockRejectedValueOnce(new Error('db down'));
    await expect(ctrl.update('p1', { name: 'New', otpId: 'b'.repeat(24) } as any, user('products-edit-otp') as any)).rejects.toThrow('db down');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('sale-price permission alone changes the sale price and nothing else', async () => {
    const { ctrl, svc } = setup();
    await ctrl.update('p1', { sellPrice: 480 } as any, user('products-price-sell') as any);
    expect(svc.update).toHaveBeenCalledWith('p1', { sellPrice: 480 }, 'Mona');
    await expect(ctrl.update('p1', { sellPrice: 470, name: 'X' } as any, user('products-price-sell') as any)).rejects.toThrow(ForbiddenException);
  });
});

describe('Cost visibility', () => {
  it('strips purchase price and average cost unless the account may see cost', async () => {
    const { ctrl } = setup();
    const staff = await ctrl.findAll(user() as any) as any[];
    expect(staff[0]).not.toHaveProperty('buyPrice');
    expect(staff[0]).not.toHaveProperty('avgCost');
    expect(staff[0].sellPrice).toBe(500);
    const seer = await ctrl.findAll(user('products-cost-view') as any) as any[];
    expect(seer[0].buyPrice).toBe(200);
    expect(canSeeCost({ role: 'admin' })).toBe(true);
    expect(canSeeCost({ role: 'staff', perms: ['purchase-edit-price'] })).toBe(true);
    expect(maskCost([{ buyPrice: 1, sellPrice: 2 }], { role: 'staff', perms: [] })).toEqual([{ sellPrice: 2 }]);
    const card = maskAnalyticsCost({ product: { buyPrice: 1 }, summary: { netProfit: 5, netCost: 3, totalRevenueFromSales: 9 }, invoices: { purchases: [1] } }, { role: 'staff', perms: [] }) as any;
    expect(card.product.buyPrice).toBeUndefined();
    expect(card.summary).toEqual({ totalRevenueFromSales: 9 });
    expect(card.invoices.purchases).toEqual([]);
  });

  it('editing the purchase price implies seeing it; every product action implies viewing', () => {
    expect(normalizeRolePermissions(['purchase-edit-price'])).toContain('products-cost-view');
    for (const key of ['products-edit-otp', 'products-price-sell', 'products-cost-view']) expect(normalizeRolePermissions([key])).toContain('products');
    expect(normalizeRolePermissions(['categories-edit-otp'])).toContain('categories-view');
  });

  it('changedFields ignores unchanged values and the code itself', () => {
    expect(changedFields(stored(), { name: 'Basket', sellPrice: 500, otpId: 'x', features: ['a', 'b'] })).toEqual([]);
    expect(changedFields(stored(), { name: 'B2', sellPrice: '450' as any })).toEqual(['name', 'sellPrice']);
  });
});

describe('Record-edit code (DiscountOtpService.consumeRecordEditOtp)', () => {
  function svcWith(doc: any) {
    const s: any = Object.create(DiscountOtpService.prototype);
    const claims: any[] = [];
    s.otpModel = {
      findById: () => ({ lean: () => ({ exec: async () => doc }) }),
      findOneAndUpdate: (filter: any, update: any) => ({ exec: async () => { if (doc.txId) return null; claims.push(update); doc.txId = update.$set.txId; return doc; } }),
      updateOne: (filter: any, update: any) => ({ exec: async () => { if (filter.txId === doc.txId) doc.txId = update.$set.txId; } }),
    };
    return { s, claims };
  }
  const base = () => ({ kind: 'record-edit', status: 'used', txId: '', editTxId: 'product:p1', txType: 'imageUrl,name' });
  const id = 'c'.repeat(24);

  it('spends once, only for its record and its fields', async () => {
    const doc = base();
    const { s } = svcWith(doc);
    await expect(s.consumeRecordEditOtp(id, 'product', 'p2', ['name'])).rejects.toThrow('لسجل آخر');
    await expect(s.consumeRecordEditOtp(id, 'category', 'p1', ['name'])).rejects.toThrow('لسجل آخر');
    await expect(s.consumeRecordEditOtp(id, 'product', 'p1', ['name', 'sellPrice'])).rejects.toThrow('تغيّر');
    const release = await s.consumeRecordEditOtp(id, 'product', 'p1', ['name']);
    await expect(s.consumeRecordEditOtp(id, 'product', 'p1', ['name'])).rejects.toThrow('تم استخدام');
    await release();
    expect(doc.txId).toBe('');
  });

  it('refuses an unverified code and a missing one', async () => {
    const { s } = svcWith({ ...base(), status: 'unused' });
    await expect(s.consumeRecordEditOtp(id, 'product', 'p1', ['name'])).rejects.toThrow('لم يتم التحقق');
    await expect(s.consumeRecordEditOtp('', 'product', 'p1', ['name'])).rejects.toThrow(ForbiddenException);
  });
});

describe('Category edit with a manager code', () => {
  it('direct for categories-edit, code for categories-edit-otp, refused otherwise', async () => {
    const cats = { findById: jest.fn(async () => ({ _id: 'c1', name: 'Old', isActive: true })), update: jest.fn(async () => ({})) };
    const otp = { consumeRecordEditOtp: jest.fn(async () => async () => undefined) };
    const ctrl = new CategoriesController(cats as any, otp as any);
    await ctrl.update('c1', { name: 'New' } as any, { user: { role: 'staff', perms: ['categories-edit'] } });
    expect(otp.consumeRecordEditOtp).not.toHaveBeenCalled();
    await ctrl.update('c1', { name: 'New', otpId: 'd'.repeat(24) } as any, { user: { role: 'staff', perms: ['categories-edit-otp'] } });
    expect(otp.consumeRecordEditOtp).toHaveBeenCalledWith('d'.repeat(24), 'category', 'c1', ['name']);
    await expect(ctrl.update('c1', { name: 'New' } as any, { user: { role: 'staff', perms: ['categories-view'] } })).rejects.toThrow(ForbiddenException);
    expect(cats.update).toHaveBeenCalledTimes(2);
  });
});

describe('Delivery-issue routes', () => {
  const guard = new PermsGuard(new Reflector());
  const allow = (method: string, perms: string[]) => guard.canActivate({
    getHandler: () => (TransactionsController.prototype as any)[method], getClass: () => TransactionsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role: 'staff', perms } }) }),
  } as unknown as ExecutionContext);
  const proto: any = TransactionsController.prototype;
  const handler = (path: string) => Object.getOwnPropertyNames(proto).find(n => {
    const fn = proto[n]; return typeof fn === 'function' && Reflect.getMetadata('path', fn) === path;
  })!;

  it.each([[':id/failed-delivery/close', 'delivery-issues-close'], [':id/failed-delivery/awaiting', 'delivery-issues-follow'], [':id/failed-delivery/reship', 'delivery-issues-follow']])('%s needs %s', (path, perm) => {
    const name = handler(path);
    expect(Reflect.getMetadata(PERMS_KEY, proto[name])).toEqual([perm]);
    expect(allow(name, [perm])).toBe(true);
    expect(allow(name, ['movements', 'pickup-orders'])).toBe(false);
    expect(allow(name, [perm === 'delivery-issues-close' ? 'delivery-issues-follow' : 'delivery-issues-close'])).toBe(false);
  });
});

describe('Supplier identity and the smart product card (Nov 25, 2026 b)', () => {
  const withSupplier = () => ({ ...stored(), supplier: 'Talla Home', supplierId: 's1' });

  it('the supplier is not sent to an account that may not see it', async () => {
    const svc = { findAll: jest.fn(async () => [withSupplier()]), findById: jest.fn(async () => withSupplier()) };
    const ctrl = new ProductsController(svc as any, {} as any, {} as any, undefined, undefined);
    const staff = (await ctrl.findAll({ user: { role: 'staff', perms: ['products'] } } as any)) as any[];
    expect(staff[0]).not.toHaveProperty('supplier');
    expect(staff[0]).not.toHaveProperty('supplierId');
    const buyer = (await ctrl.findAll({ user: { role: 'staff', perms: ['products', 'purchase-view'] } } as any)) as any[];
    expect(buyer[0].supplier).toBe('Talla Home');
    const viewer = (await ctrl.findAll({ user: { role: 'staff', perms: ['products', 'products-supplier-view'] } } as any)) as any[];
    expect(viewer[0].supplier).toBe('Talla Home');
  });

  it('a save by someone who cannot see the supplier never changes or wipes it', async () => {
    const svc = { findById: jest.fn(async () => withSupplier()), update: jest.fn(async (_id: string, _body: any) => ({})) };
    const ctrl = new ProductsController(svc as any, {} as any, {} as any, undefined, undefined);
    await ctrl.update('p1', { name: 'New', supplier: '' } as any, { user: { role: 'staff', name: 'M', perms: ['products', 'products-edit'] } } as any);
    expect(svc.update.mock.calls[0][1]).not.toHaveProperty('supplier');
    await expect(ctrl.bulkUpdate({ ids: ['p1'], supplier: 'X' } as any, { user: { role: 'staff', perms: ['products', 'products-edit'] } } as any)).rejects.toThrow(ForbiddenException);
  });

  it('the supplier list is for its readers only, on every account', async () => {
    const { SuppliersController } = require('../../src/suppliers/suppliers.controller');
    const svc = { findAll: jest.fn(async () => [{ name: 'Talla Home', phone: '010' }]), findById: jest.fn(async () => ({})) };
    const ctrl = new SuppliersController(svc as any, {} as any);
    await expect(ctrl.findAll({ user: { role: 'staff', perms: ['products', 'inventory'] } })).rejects.toThrow(ForbiddenException);
    await expect(ctrl.findOne('s1', { user: { role: 'staff', perms: ['products'] } })).rejects.toThrow(ForbiddenException);
    await expect(ctrl.findAll({ user: { role: 'staff', perms: ['products-supplier-view'] } })).resolves.toHaveLength(1);
    await expect(ctrl.findAll({ user: { role: 'admin' } })).resolves.toHaveLength(1);
  });

  it('the smart product card needs its permission', () => {
    const guard = new PermsGuard(new Reflector());
    const can = (method: string, perms: string[]) => guard.canActivate({
      getHandler: () => (ProductsController.prototype as any)[method], getClass: () => ProductsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: 'staff', perms } }) }),
    } as unknown as ExecutionContext);
    for (const m of ['getProductCard', 'searchProductsForAnalytics']) {
      expect(Reflect.getMetadata(PERMS_KEY, (ProductsController.prototype as any)[m])).toEqual(['products-analytics']);
      expect(can(m, ['products', 'inventory'])).toBe(false);
      expect(can(m, ['products-analytics'])).toBe(true);
    }
  });
});
