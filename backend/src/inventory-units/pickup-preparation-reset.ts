import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';

/** Returning to Pending invalidates current custody claims, never the immutable audit or stock ledger. */
export async function resetPickupPreparation(transactions: Model<any>, ids: string[], by: string, actorId?: string, sourceRef?: string): Promise<string[]> {
  const connection = transactions.db;
  const session = await connection.startSession();
  let changed: string[] = [];
  try {
    await session.withTransaction(async () => {
      changed = [];
      const orders: any[] = await transactions.find({ _id: { $in: ids }, type: 'مبيعات',
        ...(sourceRef !== undefined ? { cancelled: { $ne: true }, archived: { $ne: true } } : {}),
        pickupStatus: { $in: sourceRef !== undefined ? ['Ready', 'Picked-Up'] : ['Ready', 'Picked-Up', 'Preparing'] } }).session(session).lean();
      if (sourceRef !== undefined && (orders.length !== ids.length || orders.some(o =>
        (o.pickupRef || `noref-${o._id}`) !== sourceRef || (o.bostaStatus && !['CREATED', 'VALIDATION_ERROR'].includes(o.bostaStatus))))) {
        throw new ConflictException('تغيّرت حالة الطلب أو مجموعته. حدّث القائمة وحاول مرة أخرى.');
      }
      if (!orders.length) return;
      if (orders.some(o => o.shippedAt || o.deliveredAt || o.bostaStatus === 'DELIVERED')) {
        throw new ConflictException('لا يمكن إعادة طلب تم شحنه إلى Pending. سجّل استلام المرتجع أولًا.');
      }
      const orderIds = orders.map(o => String(o._id));
      const snapshots = await connection.collection('inventoryunits').find({ 'assignment.transactionId': { $in: orderIds } }, { session }).toArray();
      if (snapshots.some(u => !['reserved', 'picking', 'prepared'].includes(u.status))) {
        throw new ConflictException('حالة إحدى القطع لا تسمح بإلغاء التحضير. راجع القطع المسلّمة أو التالفة أولًا.');
      }
      let verifiedActor: any;
      if (snapshots.length) {
        if (!/^[a-f\d]{24}$/i.test(actorId || '')) throw new BadRequestException('Authenticated actor required');
        verifiedActor = await connection.collection('users').findOne({ _id: new Types.ObjectId(actorId) }, { session });
        if (!verifiedActor || verifiedActor.active === false || verifiedActor.isActive === false) throw new BadRequestException('Actor no longer exists or is inactive');
      }
      for (const productId of [...new Set(snapshots.map(u => u.productId))].sort()) {
        await connection.collection('products').updateOne({ _id: new Types.ObjectId(productId) }, { $inc: { unitTrackingRevision: 1 } }, { session });
      }
      const now = new Date().toISOString(), operationKey = `pickup-reset:${randomUUID()}`;
      // Lock the orders too: a concurrent scan/preparation must retry against Pending.
      for (const order of orders) {
        const exceptions = (order.pickingExceptions || []).map((entry: any) => entry.active === true ? {
          ...entry, active: false, undoneBy: by, undoneByUserId: actorId, undoneAt: now, undoReason: 'Order returned to Pending',
        } : entry);
        await transactions.updateOne({ _id: order._id }, {
          $set: { pickupStatus: 'Pending', pickupDate: null, pickupBy: null, pickupRef: null, prepChecked: false, pickingExceptions: exceptions },
          $inc: { unitTrackingRevision: 1 },
          $unset: { prepNote: 1, prepShipCo: 1, prepCreatedAt: 1, prepCreatedBy: 1 },
          $push: { pickupHistory: { action: 'undo', date: now, by, scansReset: true } },
        }, { session });
      }
      if (snapshots.length) {
        const Unit = connection.model('InventoryUnit'), Event = connection.model('InventoryUnitEvent');
        const name = verifiedActor.name || verifiedActor.username || by;
        for (const snapshot of snapshots) {
          const unit: any = await Unit.findById(snapshot._id).session(session);
          const fromStatus = unit.status, assignment = unit.assignment;
          const last: any = await Event.findOne({ unitId: String(unit._id) }).sort({ sequence: -1 }).session(session).lean();
          unit.status = 'available'; unit.assignment = null;
          await unit.save({ session });
          await new Event({ unitId: String(unit._id), sequence: (last?.sequence || 0) + 1, operationKey,
            action: 'picking-undone', fromStatus, toStatus: 'available', transactionId: assignment.transactionId, lineId: assignment.lineId,
            byUserId: actorId, by: name, reason: 'Order returned to Pending; preparation reset',
            details: { pickupReset: true, previousAssignment: assignment, packId: unit.packId || null, stockChanged: false },
          }).save({ session });
        }
        const packIds = [...new Set(snapshots.map(u => u.packId).filter(Boolean))];
        if (packIds.length) await connection.collection('inventorypacks').updateMany({ _id: { $in: packIds.map(id => new Types.ObjectId(id)) } }, {
          $push: { history: { action: 'pickup-reset', at: now, by: name, byUserId: actorId, transactionIds: orderIds } } as any,
          $inc: { revision: 1 },
        }, { session });
      }
      changed = orderIds;
    });
    return changed;
  } finally { await session.endSession(); }
}
