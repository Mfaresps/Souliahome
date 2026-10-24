import { Connection, Types } from 'mongoose';

/** Project carrier facts only. Warehouse receipt, cash and case completion remain explicit operations. */
export async function projectAfterSalesShipment(db: Connection, row: any, session?: any) {
  const w = row.workflow, shipment = w?.shipment;
  if (!shipment?.deliveryId) return;
  const status = shipment.carrierStatus || 'CREATED';
  const snapshot = { caseId: String(row._id), caseRef: w.ref, kind: row.requestKind,
    deliveryId: shipment.deliveryId, trackingNumber: shipment.trackingNumber || '',
    status, label: shipment.carrierLabel || status, lastSyncAt: shipment.lastSyncAt || null };
  const transactions = db.collection('transactions');
  for (const id of [...new Set([row.originalTransactionId, w.replacementTxId, row.returnTxId].filter(Boolean).map(String))]) {
    const set: any = { [`afterSales.shipments.${row._id}`]: snapshot };
    // Never overwrite the original sale's delivery history with its return journey.
    if (id !== String(row.originalTransactionId)) {
      Object.assign(set, { bostaStatus: status, bostaStatusLabel: snapshot.label,
        bostaTrackingNumber: snapshot.trackingNumber, bostaLastSync: snapshot.lastSyncAt });
      // Keep bostaOrderId unset: generic shipping automation must not settle an exchange as a cash sale.
      if (id === String(w.replacementTxId)) {
        if (status === 'DELIVERED') set.pickupStatus = 'Delivered';
        else if (['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(status)) set.pickupStatus = 'Shipped';
      }
    }
    await transactions.updateOne({ _id: new Types.ObjectId(id) }, { $set: set }, { session });
  }
}
