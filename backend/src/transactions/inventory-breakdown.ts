/**
 * Inventory breakdown (Nov 15, 2026) — what the stock balance is made of, per product and warehouse.
 *
 * The stock balance (`getInventory().current`) is unchanged and stays the single source of the
 * figure. A sale deducts it when the invoice is created, so the balance already excludes pieces
 * that are sold but still on the shelf. This adds the facts the balance cannot show:
 *
 *   on hand        = balance + reserved
 *   reserved       = confirmed sales not yet handed to the carrier (Pending / Preparing / Ready)
 *   issue          = damaged + lost + awaiting inspection, while their loss is still inside the balance
 *   ready to sell  = max(0, balance − issue)          (so on hand = ready + reserved + issue)
 *   incoming       = purchase orders not received yet (no warehouse on a PO, so per product only)
 *
 * Display only — nothing here is written, and no write may decide on these figures.
 * Unconfirmed Shopify orders are deliberately left out (owner's decision): they never deducted stock.
 */
import { warehouseCode } from '../warehouses/warehouse-storage';

export const DISPATCHED_BOSTA_STATES = new Set([
  'PICKED_UP', 'IN_TRANSIT', 'RECEIVED_AT_WAREHOUSE', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED',
  'RETURNED_TO_BUSINESS', 'CUSTOMER_POSTPONED', 'EXCEPTION',
]);

/** A confirmed sale whose pieces are still in the warehouse. */
export function saleAwaitingDispatch(sale: any): boolean {
  if (!sale || sale.type !== 'مبيعات' || sale.cancelled || sale.archived) return false;
  if (sale.shippedAt || sale.deliveredAt) return false;
  if (['Shipped', 'Delivered'].includes(String(sale.pickupStatus || ''))) return false;
  if (DISPATCHED_BOSTA_STATES.has(String(sale.bostaStatus || '').toUpperCase())) return false;
  if (sale.afterSalesBundle?.shipment || sale.afterSales?.shipments?.length) return false;
  return true;
}

export const ISSUE_STATUSES = ['damaged', 'lost', 'inspection-required', 'returned'] as const;

export interface WarehouseBreakdown {
  reserved: number;
  reservedOrders: { id: string; ref: string; client: string; qty: number; stage: string }[];
  damaged: number;
  lost: number;
  inspection: number;
}
export interface ProductBreakdown {
  byWarehouse: Record<string, WarehouseBreakdown>;
  incoming: number;
  incomingOrders: { id: string; poNumber: string; supplier: string; qty: number; status: string; expected: string }[];
}

const MAX_LISTED = 30;

export function buildInventoryBreakdown(input: {
  products: { _id: any; code?: string }[];
  sales: any[];
  units: { _id: any; productId: string; status: string; warehouseCode?: string }[];
  writtenOff: Set<string>;
  customerDamaged: Set<string>;
  purchaseOrders: any[];
}): Record<string, ProductBreakdown> {
  const byCode = new Map<string, string>();
  for (const p of input.products) {
    const code = String(p.code || '').trim();
    if (code && !byCode.has(code)) byCode.set(code, String(p._id));
  }
  const out: Record<string, ProductBreakdown> = {};
  const product = (id: string) => (out[id] ||= { byWarehouse: {}, incoming: 0, incomingOrders: [] });
  const wh = (id: string, code: unknown) => {
    const row = product(id), key = warehouseCode(code);
    return (row.byWarehouse[key] ||= { reserved: 0, reservedOrders: [], damaged: 0, lost: 0, inspection: 0 });
  };

  for (const sale of input.sales) {
    if (!saleAwaitingDispatch(sale)) continue;
    const perProduct = new Map<string, number>();
    for (const item of sale.items || []) {
      const id = byCode.get(String(item?.code || '').trim());
      const qty = Number(item?.qty) || 0;
      if (id && qty > 0) perProduct.set(id, (perProduct.get(id) || 0) + qty);
    }
    for (const [id, qty] of perProduct) {
      const row = wh(id, sale.warehouseCode);
      row.reserved += qty;
      if (row.reservedOrders.length < MAX_LISTED) row.reservedOrders.push({
        id: String(sale._id), ref: String(sale.ref || ''), client: String(sale.client || ''), qty,
        stage: String(sale.pickupStatus || 'Pending'),
      });
    }
  }

  for (const unit of input.units) {
    const id = String(unit._id);
    if (!(ISSUE_STATUSES as readonly string[]).includes(unit.status)) continue;
    // Already outside the balance: written off by an adjustment, or a damaged customer return
    // (a تالف return never re-entered stock). Counting them would subtract them twice.
    if (input.writtenOff.has(id)) continue;
    if (unit.status === 'damaged' && input.customerDamaged.has(id)) continue;
    const row = wh(String(unit.productId), unit.warehouseCode);
    if (unit.status === 'damaged') row.damaged++;
    else if (unit.status === 'lost') row.lost++;
    else row.inspection++;
  }

  for (const po of input.purchaseOrders) {
    if (po.status === 'مستلم' || po.linkedTransactionId) continue;
    const perProduct = new Map<string, number>();
    for (const item of po.items || []) {
      const id = byCode.get(String(item?.productCode || '').trim());
      const qty = Number(item?.qty) || 0;
      if (id && qty > 0) perProduct.set(id, (perProduct.get(id) || 0) + qty);
    }
    for (const [id, qty] of perProduct) {
      const row = product(id);
      row.incoming += qty;
      if (row.incomingOrders.length < MAX_LISTED) row.incomingOrders.push({
        id: String(po._id), poNumber: String(po.poNumber || ''), supplier: String(po.supplierName || ''),
        qty, status: String(po.status || ''), expected: String(po.expectedDeliveryDate || ''),
      });
    }
  }
  return out;
}

/** Reads what `buildInventoryBreakdown` needs. `db` is the Mongo connection's db. */
export async function loadInventoryBreakdown(db: any): Promise<Record<string, ProductBreakdown>> {
  const [products, sales, units, writeoffs, purchaseOrders] = await Promise.all([
    db.collection('products').find({}, { projection: { code: 1 } }).toArray(),
    db.collection('transactions').find({ type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true },
      shippedAt: { $in: [null, ''] }, deliveredAt: { $in: [null, ''] }, pickupStatus: { $nin: ['Shipped', 'Delivered'] } },
      { projection: { type: 1, ref: 1, client: 1, warehouseCode: 1, pickupStatus: 1, bostaStatus: 1, shippedAt: 1, deliveredAt: 1,
        'items.code': 1, 'items.qty': 1, 'afterSalesBundle.shipment': 1, 'afterSales.shipments': 1 } }).toArray(),
    db.collection('inventoryunits').find({ status: { $in: [...ISSUE_STATUSES] } },
      { projection: { productId: 1, status: 1, warehouseCode: 1 } }).toArray(),
    db.collection('inventorywriteoffs').find({}, { projection: { unitId: 1 } }).toArray(),
    db.collection('purchaseorders').find({ status: { $ne: 'مستلم' } },
      { projection: { poNumber: 1, supplierName: 1, status: 1, expectedDeliveryDate: 1, linkedTransactionId: 1, items: 1 } }).toArray(),
  ]);
  const damagedIds = units.filter((u: any) => u.status === 'damaged').map((u: any) => String(u._id));
  const returned = damagedIds.length ? await db.collection('inventoryunitevents')
    .find({ unitId: { $in: damagedIds }, action: { $in: ['returned', 'inspection-passed', 'repaired', 'found'] } },
      { projection: { unitId: 1, action: 1, sequence: 1 } }).toArray() : [];
  // A damaged piece is a customer's damaged return when its latest return is newer than its latest
  // approved inspection — the same rule the «repaired» action uses.
  const latest = new Map<string, any>();
  for (const e of returned) {
    const prev = latest.get(String(e.unitId));
    if (!prev || Number(e.sequence || 0) > Number(prev.sequence || 0)) latest.set(String(e.unitId), e);
  }
  const customerDamaged = new Set([...latest].filter(([, e]) => e.action === 'returned').map(([id]) => id));
  return buildInventoryBreakdown({
    products, sales, units, purchaseOrders,
    writtenOff: new Set(writeoffs.map((w: any) => String(w.unitId))), customerDamaged,
  });
}
