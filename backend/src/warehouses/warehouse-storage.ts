import { BadRequestException } from '@nestjs/common';
import { ClientSession, Connection, Types } from 'mongoose';

export const MAIN_WAREHOUSE = 'MAIN';
export function warehouseCode(value: unknown): string {
  const code = String(value || '').trim();
  return !code || ['main', 'المخزن الرئيسي'].includes(code) ? MAIN_WAREHOUSE : code;
}
export async function requireWarehouse(connection: Connection, value: unknown, session?: ClientSession): Promise<string> {
  const code = warehouseCode(value);
  const warehouse = session
    ? await connection.collection('warehouses').findOneAndUpdate({ code, active: { $ne: false } }, { $inc: { usageRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false })
    : await connection.collection('warehouses').findOne({ code, active: { $ne: false } });
  if (!warehouse) throw new BadRequestException('المخزن غير موجود أو غير نشط');
  return warehouse.code;
}

/** Read-only compatibility for complete receipts posted before invoice warehouse metadata existed. */
export async function legacyReceiptLocations(connection: Connection, transactions: any[], session?: ClientSession): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const ids = transactions.filter(tx => tx.type === 'مشتريات' && Types.ObjectId.isValid(String(tx._id))).map(tx => new Types.ObjectId(String(tx._id)));
  if (!ids.length) return result;
  const invoices = await connection.collection('transactions').find({ _id: { $in: ids }, warehouseCode: { $in: [null, ''] } }, { session, projection: { items: 1 } }).toArray();
  if (!invoices.length) return result;
  const units = await connection.collection('inventoryunits').find({ 'origin.purchaseTransactionId': { $in: invoices.map(tx => String(tx._id)) } }, { session, projection: { origin: 1 } }).toArray();
  if (!units.length) return result;
  const registrations = await connection.collection('inventoryunitevents').find({ unitId: { $in: units.map(unit => String(unit._id)) }, action: 'registered', 'details.physicalPossessionConfirmed': true }, { session, projection: { unitId: 1, details: 1 } }).toArray();
  for (const invoice of invoices) {
    const lines: any[] = invoice.items || [];
    const receiptUnits = units.filter(unit => unit.origin?.purchaseTransactionId === String(invoice._id));
    // Ambiguous, partial or duplicate receipts retain their existing fallback; never infer a source from today's location.
    if (!lines.length || lines.some(line => !line.lineId || !Number.isSafeInteger(line.qty) || line.qty <= 0) || new Set(lines.map(line => line.lineId)).size !== lines.length) continue;
    if (receiptUnits.length !== lines.reduce((sum, line) => sum + line.qty, 0) || lines.some(line => receiptUnits.filter(unit => unit.origin?.purchaseLineId === line.lineId).length !== line.qty)) continue;
    const locations: string[] = [];
    for (const unit of receiptUnits) {
      const evidence = registrations.filter(event => event.unitId === String(unit._id));
      if (evidence.length !== 1 || !String(evidence[0].details?.warehouseCode || '').trim()) break;
      locations.push(warehouseCode(evidence[0].details.warehouseCode));
    }
    if (locations.length === receiptUnits.length && new Set(locations).size === 1) result.set(String(invoice._id), locations[0]);
  }
  return result;
}
