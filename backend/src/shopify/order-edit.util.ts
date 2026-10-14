import { BadRequestException } from '@nestjs/common';

export interface OrderEditActor { id: string; name: string; username: string; role: string; perms: string[]; }
export interface OrderEditInput {
  items?: any[];
  discount?: {
    manualDiscount?: number; manualDiscountType?: string; codesDiscount?: number;
    discountCodeId?: string; discountCode?: string; highValueDiscountOtpId?: string;
  };
  itemConflict?: { source: string; revision: string };
}

// Only the business values that a proposed edit depends on participate in the
// comparison. Comments, stars and receipts can still be added during review.
export function orderEditSnapshot(order: any) {
  return JSON.parse(JSON.stringify({
    items: order.items || [], itemsTotal: order.itemsTotal || 0,
    discount: order.discount || 0, manualDiscount: order.manualDiscount || 0,
    manualDiscountType: order.manualDiscountType || 'fixed', codesDiscount: order.codesDiscount || 0,
    discountCodeId: order.discountCodeId || '', discountCode: order.discountCode || '',
    shipCost: order.shipCost || 0, total: order.total || 0,
    itemSyncConflict: order.itemSyncConflict || null,
    localItemsBaseline: order.localItemsBaseline ?? null,
  }));
}

export function validEditItems(items: any[]): any[] {
  if (!Array.isArray(items) || !items.length || items.length > 500) throw new BadRequestException('الأصناف مطلوبة');
  return items.map(item => {
    const qty = Number(item?.qty), price = Number(item?.price);
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isFinite(price) || price < 0 || !Number.isFinite(qty * price)) {
      throw new BadRequestException('كمية الصنف يجب أن تكون عددًا صحيحًا موجبًا وسعره صالحًا');
    }
    // Do not persist arbitrary client-supplied properties inside the request.
    return { productId: String(item.productId || ''), code: String(item.code || ''),
      name: String(item.name || ''), qty, price, total: qty * price,
      imageUrl: String(item.imageUrl || ''), shopifyName: String(item.shopifyName || ''),
      ...(Number.isFinite(Number(item.shopifyPrice)) ? { shopifyPrice: Number(item.shopifyPrice) } : {}) };
  });
}

export function transactionEditSnapshot(tx: any) {
  const fields = ['ref', 'client', 'phone', 'notes', 'payment', 'items', 'total', 'discount', 'shipCost',
    'shipCo', 'carrierCode', 'shipZone', 'shippingAddress', 'shippingCity', 'shippingGov',
    'deposit', 'deposits', 'depMethod', 'remaining', 'payStatus', 'cancelled', 'deliveryStatus',
    'bostaStatus', 'pickupStatus', 'deliverySource', 'carrierSettlement', 'transactionDate',
    'discountCodeId', 'discountCode', 'discountCodeType', 'manualDiscount', 'manualDiscountType', 'itemsTotal'];
  return JSON.parse(JSON.stringify(Object.fromEntries(fields.map(field => [field, tx[field] ?? null]))));
}

export function validDiscountAmount(value: any): number {
  const amount = value == null ? 0 : Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('قيمة الخصم غير صالحة');
  return amount;
}

export function normalizeInvoiceEdit(tx: any, input: any): Record<string, any> {
  const patch = JSON.parse(JSON.stringify(input));
  if (patch.items) patch.items = validEditItems(patch.items);
  if (['items', 'itemsTotal', 'total', 'discount', 'shipCost', 'deposit', 'remaining'].some(key => key in patch)) {
    const itemsTotal = (patch.items || tx.items || []).reduce((sum: number, item: any) => sum + Number(item.qty) * Number(item.price), 0);
    const discount = validDiscountAmount(patch.discount ?? tx.discount);
    const shipCost = validDiscountAmount(patch.shipCost ?? tx.shipCost);
    const deposit = validDiscountAmount(patch.deposit ?? tx.deposit);
    if (!Number.isFinite(itemsTotal) || discount > itemsTotal) throw new BadRequestException('الخصم يتجاوز إجمالي الأصناف أو إجمالي الأصناف غير صالح');
    patch.itemsTotal = itemsTotal;
    patch.discount = discount;
    patch.shipCost = shipCost;
    patch.total = Math.round((Math.max(0, itemsTotal - discount + shipCost) + Number.EPSILON) * 100) / 100;
    patch.remaining = Math.round((Math.max(0, patch.total - deposit) + Number.EPSILON) * 100) / 100;
    patch.payStatus = patch.remaining <= 0 ? 'مكتمل' : 'معلق';
  }
  return patch;
}
