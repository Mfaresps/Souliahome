import { Connection, Types } from 'mongoose';
import { afterSalesCollectedAt, courierHasParcel } from '../shared/courier-collected.util';

/** Project carrier facts only. Warehouse receipt, cash and case completion remain explicit operations. */
export async function projectAfterSalesShipment(db: Connection, row: any, session?: any) {
  const w = row.workflow, shipment = w?.shipment;
  if (!shipment?.deliveryId) return;
  const status = shipment.carrierStatus || 'CREATED';
  const snapshot = { caseId: String(row._id), caseRef: w.ref, kind: row.requestKind,
    deliveryId: shipment.deliveryId, trackingNumber: shipment.trackingNumber || '',
    status, label: shipment.carrierLabel || status, lastSyncAt: shipment.lastSyncAt || null };
  const transactions = db.collection('transactions');
  // A sale bundled into the exchange waybill follows it like the replacement does.
  const bundled = (shipment.bundled || []).map((b: any) => String(b.transactionId));
  for (const id of [...new Set([row.originalTransactionId, w.replacementTxId, row.returnTxId, ...bundled].filter(Boolean).map(String))]) {
    // ⚠ A bundled sale is an ordinary sale: its `afterSales` is null, and `$set` into a field of null
    //   fails. Its copy of the waybill lives under its own `afterSalesBundle`.
    const set: any = bundled.includes(id) ? { 'afterSalesBundle.shipment': snapshot } : { [`afterSales.shipments.${row._id}`]: snapshot };
    // Never overwrite the original sale's delivery history with its return journey.
    if (id !== String(row.originalTransactionId)) {
      Object.assign(set, { bostaStatus: status, bostaStatusLabel: snapshot.label,
        bostaTrackingNumber: snapshot.trackingNumber, bostaLastSync: snapshot.lastSyncAt });
      // Keep bostaOrderId unset: generic shipping automation must not settle an exchange as a cash sale.
      if (id === String(w.replacementTxId) || bundled.includes(id)) {
        if (status === 'DELIVERED') set.pickupStatus = 'Delivered';
        else if (['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(status)) set.pickupStatus = 'Shipped';
        // The shipped column groups by the day the courier took the waybill from us.
        const collectedAt = courierHasParcel(status) ? afterSalesCollectedAt(w) : '';
        if (collectedAt) set.shippedAt = collectedAt;
      }
    }
    await transactions.updateOne({ _id: new Types.ObjectId(id), ...(bundled.includes(id) ? { 'afterSalesBundle.caseId': String(row._id) } : {}) }, { $set: set }, { session });
  }
}
