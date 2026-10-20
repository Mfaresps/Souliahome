import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { retainRecords } from '../inventory-unit-integrity';

/** Durable request receipt, committed with its events. Never expires or posts accounting. */
@Schema({ collection: 'inventoryunitoperations', autoCreate: false, autoIndex: false, versionKey: false })
export class InventoryUnitOperation {
  @Prop({ type: String, required: true, match: /^[a-f\d]{64}$/ }) _id: string;
  @Prop({ required: true, match: /^[a-f\d]{64}$/ }) fingerprint: string;
  @Prop({ required: true }) kind: string;
  @Prop({ required: true, type: String, ref: 'User', match: /^[a-f\d]{24}$/, lowercase: true }) actorId: string;
  @Prop({ required: true }) actorName: string;
  @Prop({ required: true, type: Object }) result: Record<string, any>;
  @Prop({ required: true, default: Date.now }) createdAt: Date;
}
export const InventoryUnitOperationSchema = SchemaFactory.createForClass(InventoryUnitOperation);
InventoryUnitOperationSchema.index({ actorId: 1, createdAt: -1 }, { name: 'inventory_unit_operation_actor' });
InventoryUnitOperationSchema.index({ kind: 1, 'result.unit.productId': 1, 'result.attestation.reference': 1 }, { name: 'inventory_unit_operation_count' });
retainRecords(InventoryUnitOperationSchema, 'Tracking operation receipts are append-only', true);
