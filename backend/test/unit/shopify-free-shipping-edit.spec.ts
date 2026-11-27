/**
 * «شحن مجاني» and the discount room in the REAL ShopifyService.prepareOrderEdit (Nov 27, 2026), with light fakes.
 * The money rule itself: shopify-order-total.spec.ts.
 */
import { ShopifyService } from '../../src/shopify/shopify.service';
import { orderEditSnapshot } from '../../src/shopify/order-edit.util';

export {};

// #3266: one basket 2050, Shopify discount 2050 (the whole item), shipping 120 → total 120.
const order = (extra: any = {}) => ({
  _id: 'o1', ref: '3266', status: 'pending', cancelled: false, shopifyCreatedAt: '2026-11-27T10:00:00+02:00',
  items: [{ productId: 'p1', code: 'BLA-BEI', name: 'Laundry Basket', qty: 1, price: 2050, total: 2050 }],
  itemsTotal: 2050, discount: 2050, shippingDiscount: 0, manualDiscount: 0, codesDiscount: 0, shipCost: 120, total: 120,
  rawData: { current_total_price: '120.00' }, ...extra,
});
function service(limit = 200) {
  const s: any = Object.create(ShopifyService.prototype);
  s.productModel = { find: () => ({ lean: async () => [] }) };
  s.transactionsService = { settleOfferRemovalsOrThrow: (items: any[]) => ({ items, added: [] }) };
  s.settingsService = { getSettings: async () => ({ otpEnabled: true, highValueDiscountLimit: limit }) };
  s.discountOtpService = { assertOtpForTransaction: async (_id: string, amount: number) => { s.otpAmount = amount; throw new Error('OTP_REQUIRED'); } };
  s.logger = { warn: () => {}, log: () => {} };
  return s;
}
const staff = { id: 'u1', name: 'Reem', username: 'reem', role: 'staff', perms: [] as string[] };
const admin = { ...staff, id: 'a1', name: 'Admin', role: 'admin' };
const errOf = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.getResponse?.() || { message: e.message }; } };
const disc = (x: any) => ({ discount: { manualDiscount: 0, manualDiscountType: 'fixed', codesDiscount: 0, ...x } });

describe('Shopify edit window — «شحن مجاني»', () => {
  it('an extra discount with no room left is refused instead of being shown and silently dropped', async () => {
    const e: any = await errOf(service().prepareOrderEdit(order(), disc({ manualDiscount: 120 }), admin));
    expect(e.code).toBe('DISCOUNT_OVER_ROOM');
    expect(e.room).toBe(0);
  });

  it('free shipping takes the total to 0, records who chose it, and the difference from Shopify', async () => {
    const { patch, changes } = await service().prepareOrderEdit(order(), disc({ freeShipping: true }), admin);
    expect(patch.total).toBe(0);
    expect(patch.freeShipping).toMatchObject({ amount: 120, by: 'Admin', byId: 'a1' });
    expect(patch.shopifyDivergence).toMatchObject({ shopifyTotal: 120, erpTotal: 0, diff: -120 });
    expect(changes.join(' ')).toMatch(/تفعيل الشحن المجاني/);
  });

  it('staff without «طلب شحن مجاني» cannot ask for it', async () => {
    const e: any = await errOf(service().prepareOrderEdit(order(), disc({ freeShipping: true }), staff));
    expect(e.message).toMatch(/طلب شحن مجاني/);
  });

  it('staff with direct edit still send free shipping to a manager; other edits stay direct', async () => {
    const s = service(1000);
    const updates: any[] = [];
    s.shopifyOrderModel = { findById: async () => order(), findOneAndUpdate: async (_f: any, u: any) => { updates.push(u); return { total: 0 }; } };
    s.notifications = { enqueue: async () => {} };
    s.emit = () => {};
    const directStaff = { ...staff, perms: ['shopify-orders', 'shopify-edit-direct', 'shopify-free-shipping'] };
    const sent = await s.submitOrderEdit('o1', disc({ freeShipping: true }), directStaff);
    expect(sent.pendingApproval).toBe(true);
    expect(updates[0].$set.editRequest.status).toBe('معلق');
    expect(updates[0].$set.freeShipping).toBeUndefined();
    // Not a free-shipping change → applied directly, as before.
    s.shopifyOrderModel.findById = async () => order({ discount: 1000, total: 1170 });
    const direct = await s.submitOrderEdit('o1', disc({ manualDiscount: 50 }), directStaff);
    expect(direct.pendingApproval).toBe(false);
  });

  it('the waived shipping counts toward the manager-approval limit for staff', async () => {
    const s = service(100);
    const e: any = await errOf(s.prepareOrderEdit(order(), disc({ freeShipping: true }), { ...staff, perms: ['shopify-free-shipping'] }));
    expect(e.message).toBe('OTP_REQUIRED');
    expect(s.otpAmount).toBe(120);
  });

  it('turning it off brings the shipping back', async () => {
    const on = order({ freeShipping: { amount: 120, by: 'Admin' }, total: 0 });
    const { patch, changes } = await service().prepareOrderEdit(on, disc({ freeShipping: false }), admin);
    expect(patch.freeShipping).toBeNull();
    expect(patch.total).toBe(120);
    expect(changes.join(' ')).toMatch(/إلغاء الشحن المجاني/);
  });

  it('an unrelated edit keeps free shipping (and is not blocked by it)', async () => {
    const on = order({ freeShipping: { amount: 120, by: 'Admin' }, total: 0 });
    const { patch } = await service().prepareOrderEdit(on, { items: [{ productId: 'p1', code: 'BLA-BEI', name: 'Laundry Basket', qty: 2, price: 2050 }] }, admin);
    // items 4100, Shopify 2050 → 2050, no shipping.
    expect(patch.total).toBe(2050);
    expect(patch.freeShipping).toBeUndefined();
  });

  it('refused on an order with no shipping', async () => {
    const e: any = await errOf(service().prepareOrderEdit(order({ shipCost: 0, total: 0 }), disc({ freeShipping: true }), admin));
    expect(e.message).toMatch(/لا يوجد شحن/);
  });

  it('the snapshot gains the key only when on, so requests stored before keep matching', () => {
    expect('freeShipping' in orderEditSnapshot(order())).toBe(false);
    expect(orderEditSnapshot(order({ freeShipping: { amount: 120 } })).freeShipping).toBe(true);
  });
});
