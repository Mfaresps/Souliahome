import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { INVENTORY_UNIT_ACTIONS, INVENTORY_UNIT_STATUSES, OBJECT_ID_PATTERN } from '../inventory-unit.constants';
import { referenceExists, retainRecords } from '../inventory-unit-integrity';

export type InventoryUnitEventDocument = HydratedDocument<InventoryUnitEvent>;

/** Identity/lifecycle audit only. Never included in the existing aggregate stock arithmetic. */
@Schema({ timestamps: true, collection: 'inventoryunitevents', autoCreate: false, autoIndex: false, versionKey: false })
export class InventoryUnitEvent {
  @Prop({ required: true, type: String, ref: 'InventoryUnit', match: OBJECT_ID_PATTERN, lowercase: true })
  unitId: string;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  sequence: number;

  /** Unique per unit + operation. Future writer must compare payloads on retry, not blindly ignore E11000. */
  @Prop({ required: true, trim: true })
  operationKey: string;

  @Prop({ required: true, enum: INVENTORY_UNIT_ACTIONS })
  action: string;

  @Prop({ type: String, enum: [...INVENTORY_UNIT_STATUSES, null], default: null })
  fromStatus: string | null;

  @Prop({ required: true, enum: INVENTORY_UNIT_STATUSES })
  toStatus: string;

  @Prop({ type: String, ref: 'InventoryMovement', match: OBJECT_ID_PATTERN, lowercase: true })
  inventoryMovementId?: string;

  @Prop({ type: String, ref: 'Transaction', match: OBJECT_ID_PATTERN, lowercase: true })
  transactionId?: string;

  @Prop({ type: String, trim: true })
  lineId?: string;

  @Prop({ required: true, type: String, ref: 'User', match: OBJECT_ID_PATTERN, lowercase: true })
  byUserId: string;

  @Prop({ required: true })
  by: string;

  @Prop({ default: '' })
  reason: string;

  @Prop({ default: '' })
  notes: string;

  /** Server-built custody/location snapshots; optional so historical events remain valid. */
  @Prop({ type: Object, default: null })
  details?: Record<string, any> | null;
}

export const InventoryUnitEventSchema = SchemaFactory.createForClass(InventoryUnitEvent);
InventoryUnitEventSchema.index({ unitId: 1, sequence: 1 }, { unique: true, name: 'inventory_unit_event_sequence_unique' });
InventoryUnitEventSchema.index({ unitId: 1, operationKey: 1 }, { unique: true, name: 'inventory_unit_event_operation_unique' });
InventoryUnitEventSchema.index({ transactionId: 1, createdAt: -1 }, { name: 'inventory_unit_event_transaction_lookup' });
InventoryUnitEventSchema.index({ inventoryMovementId: 1 }, { name: 'inventory_unit_event_movement_lookup' });

InventoryUnitEventSchema.pre('save', async function () {
  if (!this.isNew) throw new Error('Inventory unit events are append-only');
  if (!await referenceExists(this, 'users', { _id: new Types.ObjectId(this.byUserId) })) throw new Error('Event User does not exist');
  const options = this.$session() ? { session: this.$session() } : {};
  const unit: any = await (this.constructor as any).db.collection('inventoryunits').findOne({ _id: new Types.ObjectId(this.unitId) }, options);
  if (!unit) throw new Error('Event InventoryUnit does not exist');
  if (this.transactionId && !await referenceExists(this, 'transactions', { _id: new Types.ObjectId(this.transactionId) })) throw new Error('Event Transaction does not exist');
  if (this.inventoryMovementId) {
    const movement: any = await (this.constructor as any).db.collection('inventorymovements').findOne({ _id: new Types.ObjectId(this.inventoryMovementId) }, options);
    if (!movement) throw new Error('Event InventoryMovement does not exist');
    if (String(movement.productId) !== unit.productId) throw new Error('Event movement must reference the same product');
  }
});
retainRecords(InventoryUnitEventSchema, 'Inventory unit events are append-only', true);
