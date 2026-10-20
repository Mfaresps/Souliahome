import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { resolvePurchaseLine } from './purchase-line-membership';

/** Preserve receipt lineage. A posted physical piece is removed through a return,
 * never by deleting its purchase line or reusing its identity for another SKU. */
export async function normalizePurchaseEdit(db: any, invoice: any, submitted: any[]) {
  const original: any[] = invoice.items || [], sku = (row: any) => String(row.code || '').trim();
  const units = await db.collection('inventoryunits').find({ 'origin.purchaseTransactionId': String(invoice._id) },
    { projection: { productId: 1, origin: 1 } }).toArray();
  const products = await db.collection('products').find({}, { projection: { code: 1 } }).toArray();
  const productSku = new Map(products.map((p: any) => [String(p._id), sku(p)]));
  const ids = new Set<string>();
  const items = submitted.map(row => {
    const exact = row.lineId ? original.find(old => old.lineId === row.lineId) : null;
    const matching = original.filter(old => sku(old) === sku(row));
    const source = exact || (matching.length === 1 && submitted.filter(next => sku(next) === sku(row)).length === 1 ? matching[0] : null);
    const lineId = source?.lineId || randomUUID();
    if (ids.has(lineId)) throw new ConflictException({ code: 'PURCHASE_LINE_AMBIGUOUS', message: 'تكررت هوية سطر الشراء؛ حدّث الفاتورة وراجع المنتجات' });
    ids.add(lineId);
    return { ...row, lineId };
  });
  for (const old of original) {
    const sameSku = original.filter(row => sku(row) === sku(old));
    const linked = units.filter((unit: any) => resolvePurchaseLine(original, unit.origin.purchaseLineId, String(productSku.get(String(unit.productId)) || '')) === old ||
      !unit.origin.purchaseLineId && productSku.get(String(unit.productId)) === sku(old));
    if (!linked.length) continue;
    const next = old.lineId ? items.find(row => row.lineId === old.lineId) : items.find(row => sku(row) === sku(old));
    const legacyAmbiguous = sameSku.length > 1 && linked.some((unit: any) => !unit.origin.purchaseLineId);
    if (legacyAmbiguous && JSON.stringify(original.filter(row => sku(row) === sku(old)).map(row => row.qty)) !== JSON.stringify(items.filter(row => sku(row) === sku(old)).map(row => row.qty))) {
      throw new ConflictException({ code: 'PURCHASE_LINE_AMBIGUOUS', message: 'بنود متكررة لها أكواد قديمة غير موزعة؛ راجع ربط القطع أولًا' });
    }
    if (legacyAmbiguous) continue;
    if (!next || sku(next) !== sku(old) || Number(next.qty) < linked.length) {
      throw new ConflictException({ code: 'PURCHASE_CODED_REDUCTION', message: `لا يمكن حذف ${old.name || sku(old)} أو تقليل كميته عن ${linked.length} قطعة مسجلة. للقطع المرتجعة استخدم مرتجع المورد وحدد أكوادها`,
        sku: sku(old), registeredUnits: linked.length });
    }
  }
  // Previously orphaned records must not be hidden by another edit.
  const totals = new Map<string, number>();
  for (const row of items) totals.set(sku(row), (totals.get(sku(row)) || 0) + Number(row.qty));
  const counts = new Map<string, number>();
  for (const unit of units) { const code = String(productSku.get(String(unit.productId)) || ''); counts.set(code, (counts.get(code) || 0) + 1); }
  for (const [code, count] of counts) if ((totals.get(code) || 0) < count) throw new ConflictException({ code: 'PURCHASE_CODED_REDUCTION',
    message: `الصنف ${code} له ${count} هوية مسجلة. راجع الفاتورة والقطع قبل تقليل الكمية أو حذف المنتج`, sku: code, registeredUnits: count });
  return items;
}
