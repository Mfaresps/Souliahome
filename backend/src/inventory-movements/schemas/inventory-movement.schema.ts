import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { restrictInventoryParentDeletion } from '../../inventory-units/inventory-unit-integrity';

export type InventoryMovementDocument = HydratedDocument<InventoryMovement>;

export type InventoryMovementType =
  | 'نقل مخزني'
  | 'مبيعات'
  | 'مشتريات'
  | 'مرتجع مبيعات'
  | 'مرتجع مشتريات'
  | 'تسوية مخزون';

export type InventoryMovementSourceType =
  | 'warehouse-transfer'
  | 'transaction-create'
  | 'transaction-update'
  | 'transaction-cancel'
  | 'transaction-restore'
  | 'manual-adjustment';

@Schema({ timestamps: true })
export class InventoryMovement {
  @Prop({ default: '' })
  afterSalesId: string;
  @Prop({ default: '' })
  afterSalesRef: string;
  @Prop({ default: '' })
  originalInvoiceRef: string;
  @Prop({ default: '' })
  lifecycle: string;
  @Prop({ default: 0 })
  physicalQty: number;
  @Prop({ default: 0 })
  quarantinedQty: number;
  @Prop({ type: [String], default: [] })
  unitIds: string[];
  @Prop({ default: '' })
  warehouseTransferId: string;
  @Prop({ type: String, default: '' })
  warehouseCode: string;
  /** Random, unique per-row transaction ID for this movement — independent of any linked
   * transaction's own ref (see sourceTransactionRef). Never reused across rows. */
  @Prop({ required: true, unique: true })
  movementId: string;

  @Prop({ required: true })
  productId: string;

  @Prop({ required: true })
  productCode: string;

  @Prop({ required: true })
  productName: string;

  @Prop({ required: true })
  type: InventoryMovementType;

  @Prop({ required: true })
  qtyDelta: number;

  @Prop({ required: true })
  qtyBefore: number;

  @Prop({ required: true })
  qtyAfter: number;

  @Prop({ default: '' })
  sourceTransactionId: string;

  @Prop({ default: '' })
  sourceTransactionRef: string;

  @Prop({ required: true })
  sourceType: InventoryMovementSourceType;

  @Prop({ required: true })
  by: string;

  @Prop({ default: '' })
  byUserId: string;

  @Prop({ default: '' })
  reason: string;

  @Prop({ default: '' })
  notes: string;
}

export const InventoryMovementSchema = SchemaFactory.createForClass(InventoryMovement);
restrictInventoryParentDeletion(InventoryMovementSchema, [], ['inventoryMovementId']);
InventoryMovementSchema.index({ movementId: 1 }, { unique: true });
InventoryMovementSchema.index({ productCode: 1, createdAt: -1 });
InventoryMovementSchema.index({ type: 1, createdAt: -1 });
InventoryMovementSchema.index({ sourceTransactionId: 1 });
InventoryMovementSchema.index({ by: 1, createdAt: -1 });
