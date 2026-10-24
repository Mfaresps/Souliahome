import { BadRequestException, ConflictException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { randomUUID, createHash } from 'crypto';

export const identityOperationKey = (actorId: string, key: string) => createHash('sha256').update(JSON.stringify({ actor: actorId.toLowerCase(), key })).digest('hex');

export type ReturnedIdentity = { unitId: string; labelState: string; labelAttached: boolean; printOperationKey?: string };

/** Validate before financial cancellation; recheck under the same locks as the identity writes. */
export async function checkReturnedIdentities(transactions: Model<any>, id: string, labels: ReturnedIdentity[] = [], session?: any, actorId?: string) {
  const units = await transactions.db.collection('inventoryunits').find({ 'assignment.transactionId': id }, { session }).toArray();
  if (units.some(u => !['reserved', 'picking', 'prepared', 'shipped'].includes(u.status))) {
    throw new ConflictException('راجع حالة القطع المرتبطة قبل إرجاع الطلب للمخزن');
  }
  if (labels.length !== units.length || new Set(labels.map(l => l.unitId)).size !== units.length || units.some(u =>
    !labels.some(l => l.unitId === String(u._id) && ['intact', 'reprinted'].includes(l.labelState) && l.labelAttached === true))) {
    throw new BadRequestException('أكد استلام كل قطعة وسلامة ملصق هويتها أو إعادة طباعته ولصقه');
  }
  for (const label of labels.filter(l => l.labelState === 'reprinted')) {
    if (!label.printOperationKey) throw new BadRequestException('اطبع نفس هوية القطعة أولًا ثم أكد لصق الملصق');
    const print = await transactions.db.collection('inventoryunitevents').findOne({ unitId: label.unitId,
      operationKey: actorId ? identityOperationKey(actorId, label.printOperationKey) : label.printOperationKey,
      action: { $in: ['label-print-requested', 'label-reprint-requested', 'label-printed', 'label-reprinted'] } }, { session });
    if (!print) throw new BadRequestException('اطبع نفس هوية القطعة أولًا ثم أكد لصق الملصق');
  }
  return units;
}

/** No stock or money entries: cancellation already credits aggregate stock exactly once. */
export async function finishFailedDeliveryIdentities<T>(transactions: Model<any>, id: string, mode: 'stock' | 'reship',
  labels: ReturnedIdentity[], by: string, actorId: string | undefined, finish: (session?: any) => Promise<T>): Promise<T> {
  const connection = transactions.db;
  const assigned = await connection.collection('inventoryunits').findOne({ 'assignment.transactionId': id });
  if (!assigned) return finish();
  if (!/^[a-f\d]{24}$/i.test(actorId || '')) throw new BadRequestException('Authenticated actor required');
  const session = await connection.startSession();
  let result: T;
  try {
    await session.withTransaction(async () => {
      const actor = await connection.collection('users').findOne({ _id: new Types.ObjectId(actorId) }, { session });
      if (!actor || actor.active === false || actor.isActive === false) throw new BadRequestException('Actor is inactive');
      const snapshots = mode === 'stock' ? await checkReturnedIdentities(transactions, id, labels, session, actorId) :
        await connection.collection('inventoryunits').find({ 'assignment.transactionId': id }, { session }).toArray();
      if (snapshots.some(u => !['reserved', 'picking', 'prepared', 'shipped'].includes(u.status))) throw new ConflictException('راجع هوية القطع قبل إعادة الشحن');
      const Unit = connection.model('InventoryUnit'), Event = connection.model('InventoryUnitEvent');
      for (const productId of [...new Set(snapshots.map(u => u.productId))].sort()) {
        await connection.collection('products').updateOne({ _id: new Types.ObjectId(productId) }, { $inc: { unitTrackingRevision: 1 } }, { session });
      }
      const operationKey = `failed-delivery:${mode}:${randomUUID()}`;
      for (const snapshot of snapshots) {
        const unit: any = await Unit.findById(snapshot._id).session(session);
        const fromStatus = unit.status, assignment = unit.assignment;
        const last: any = await Event.findOne({ unitId: String(unit._id) }).sort({ sequence: -1 }).session(session).lean();
        unit.status = mode === 'stock' ? 'available' : 'prepared';
        if (mode === 'stock') unit.assignment = null;
        unit.markModified('status'); await unit.save({ session });
        await new Event({ unitId: String(unit._id), sequence: (last?.sequence || 0) + 1, operationKey,
          action: mode === 'stock' ? 'returned' : 'prepared', fromStatus, toStatus: unit.status,
          transactionId: id, lineId: assignment.lineId, byUserId: actorId, by: actor.name || actor.username || by,
          reason: mode === 'stock' ? 'Failed delivery physically received into warehouse' : 'Failed delivery received for reshipment to same customer',
          details: { failedDelivery: true, physicalPossessionConfirmed: true, previousAssignment: assignment,
            fromWarehouseCode: unit.warehouseCode, toWarehouseCode: unit.warehouseCode,
            label: labels.find(l => l.unitId === String(unit._id)) || null, stockChanged: false },
        }).save({ session });
      }
      result = await finish(session);
    });
    return result!;
  } finally { await session.endSession(); }
}
