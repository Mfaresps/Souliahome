import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ConflictException } from '@nestjs/common';
import { resolvePurchaseLine } from '../purchase-line-membership';
import { HydratedDocument, Types } from 'mongoose';
import { INVENTORY_UNIT_STATUSES, InventoryUnitStatus, OBJECT_ID_PATTERN, inventoryUnitBarcode } from '../inventory-unit.constants';
import { referenceExists, retainRecords } from '../inventory-unit-integrity';

@Schema({ _id: false })
export class InventoryUnitOrigin {
  @Prop({ required: true, enum: ['purchase', 'opening-stock', 'legacy-unknown'] })
  kind: string;

  /** Existing purchase Transaction is the receipt/batch boundary. Never create a duplicate purchase. */
  @Prop({ type: String, ref: 'Transaction', match: OBJECT_ID_PATTERN, lowercase: true })
  purchaseTransactionId?: string;

  @Prop({ type: String, trim: true })
  purchaseLineId?: string;

  @Prop({ type: String, ref: 'PurchaseOrder', match: OBJECT_ID_PATTERN, lowercase: true })
  purchaseOrderId?: string;

  /** Opening balance lives on Product; no fictitious opening-stock collection is introduced. */
  @Prop({ type: String, ref: 'Product', match: OBJECT_ID_PATTERN, lowercase: true })
  openingStockProductId?: string;

  /** Approved physical-count/cutover reference, not an invented supplier or purchase reference. */
  @Prop({ type: String, trim: true })
  reconciliationRef?: string;
}
const OriginSchema = SchemaFactory.createForClass(InventoryUnitOrigin);

@Schema({ _id: false })
export class InventoryUnitAssignment {
  @Prop({ required: true, type: String, ref: 'Transaction', match: OBJECT_ID_PATTERN, lowercase: true })
  transactionId: string;

  /** Future stable line identity. Array position/name/SKU is deliberately not a line identity. */
  @Prop({ required: true, type: String, trim: true })
  lineId: string;
}
const AssignmentSchema = SchemaFactory.createForClass(InventoryUnitAssignment);

export type InventoryUnitDocument = HydratedDocument<InventoryUnit>;

@Schema({ timestamps: true, collection: 'inventoryunits', autoCreate: false, autoIndex: false, optimisticConcurrency: true })
export class InventoryUnit {
  // Mongoose supplies ObjectId _id. MongoDB makes it unique and immutable at database level.
  @Prop({ required: true, immutable: true, type: String, ref: 'Product', match: OBJECT_ID_PATTERN, lowercase: true })
  productId: string;

  @Prop({ required: true, immutable: true, type: String,
    default: function (this: { _id: Types.ObjectId }) { return inventoryUnitBarcode(this._id); },
    match: /^SU-[A-F\d]{24}$/ })
  barcode: string;

  @Prop({ required: true, type: String, enum: INVENTORY_UNIT_STATUSES, default: 'inspection-required' })
  status: InventoryUnitStatus;

  /** Nullable operator-supplied location key. Soulia currently has no Warehouse model/registry. */
  @Prop({ type: String, default: null, trim: true, minlength: 1 })
  warehouseCode: string | null;

  @Prop({ required: true, immutable: true, type: OriginSchema })
  origin: InventoryUnitOrigin;

  @Prop({ type: AssignmentSchema, default: null })
  assignment: InventoryUnitAssignment | null;

  @Prop({ type: String, match: OBJECT_ID_PATTERN, default: null })
  supplierReturnId: string | null;

  /** Active sealed pack membership. Opening a pack clears membership, never stock. */
  @Prop({ type: String, match: OBJECT_ID_PATTERN, default: null })
  packId: string | null;

  @Prop({ required: true, immutable: true, type: String, ref: 'User', match: OBJECT_ID_PATTERN, lowercase: true })
  registeredByUserId: string;

  @Prop({ required: true, immutable: true })
  registeredBy: string;
}

export const InventoryUnitSchema = SchemaFactory.createForClass(InventoryUnit);
InventoryUnitSchema.index({ barcode: 1 }, { unique: true, name: 'inventory_unit_barcode_unique' });
InventoryUnitSchema.index({ productId: 1, status: 1, warehouseCode: 1 }, { name: 'inventory_unit_stock_lookup' });
InventoryUnitSchema.index({ 'origin.purchaseTransactionId': 1, productId: 1 }, { name: 'inventory_unit_purchase_lookup' });
InventoryUnitSchema.index({ 'origin.purchaseOrderId': 1 }, { name: 'inventory_unit_purchase_order_lookup' });
InventoryUnitSchema.index({ 'origin.reconciliationRef': 1 }, { name: 'inventory_unit_reconciliation_lookup' });
InventoryUnitSchema.index({ 'assignment.transactionId': 1, 'assignment.lineId': 1, status: 1 }, { name: 'inventory_unit_assignment_lookup' });

InventoryUnitSchema.pre('validate', function () {
  if (!this.isNew && this.isModified('origin')) this.invalidate('origin', 'Unit provenance is immutable after registration');
  if (this.barcode !== inventoryUnitBarcode(this._id)) this.invalidate('barcode', 'Barcode must identify this immutable unit _id');
  const origin = this.origin;
  if (origin?.kind === 'purchase') {
    if (!origin.purchaseTransactionId || origin.openingStockProductId) this.invalidate('origin', 'Purchase origin requires only its purchase transaction');
  } else if (origin) {
    if (origin.purchaseTransactionId || origin.purchaseLineId || origin.purchaseOrderId) this.invalidate('origin', 'Unknown/opening provenance must not claim a purchase');
    if (!origin.reconciliationRef?.trim()) this.invalidate('origin.reconciliationRef', 'An approved reconciliation reference is required');
    if (origin.kind === 'opening-stock' && origin.openingStockProductId !== this.productId) this.invalidate('origin', 'Opening stock must reference the same Product');
    if (origin.kind === 'legacy-unknown' && origin.openingStockProductId) this.invalidate('origin', 'Unknown provenance cannot claim opening-stock history');
  }
  if (['reserved', 'picking', 'prepared', 'shipped', 'delivered'].includes(this.status) && !this.assignment) {
    this.invalidate('assignment', 'This status requires an order-line assignment');
  }
  if (this.status === 'available' && this.assignment) this.invalidate('assignment', 'Available units cannot remain assigned');
});

InventoryUnitSchema.pre('save', async function () {
  const options = this.$session() ? { session: this.$session() } : {};
  const product: any = await (this.constructor as any).db.collection('products').findOne({ _id: new Types.ObjectId(this.productId) }, options);
  if (!product) throw new Error('Inventory unit Product does not exist');
  if (this.isNew && !await referenceExists(this, 'users', { _id: new Types.ObjectId(this.registeredByUserId) })) throw new Error('Registering User does not exist');
  if (this.origin.kind === 'purchase') {
    if (this.origin.purchaseOrderId && !await referenceExists(this, 'purchaseorders', {
      _id: new Types.ObjectId(this.origin.purchaseOrderId), linkedTransactionId: this.origin.purchaseTransactionId,
    })) throw new Error('Unit purchase order does not reference its purchase transaction');
    const purchase: any = await (this.constructor as any).db.collection('transactions').findOne(
      { _id: new Types.ObjectId(this.origin.purchaseTransactionId!), type: 'مشتريات',
        ...(this.isNew ? { cancelled: { $ne: true }, archived: { $ne: true } } : {}) },
      { ...(this.$session() ? { session: this.$session() } : {}) },
    );
    if (!purchase || /-RET$/i.test(String(purchase.ref || '').trim()) ||
      String(purchase.notes || '').includes('مرتجع معتمد (طلب كان معلقاً)') ||
      String(purchase.notes || '').startsWith('استبدال — مرتجع:')) throw new Error('Origin must reference a live supplier purchase');
    const matches = this.isNew ? (purchase.items || []).some((item: any) => String(item.code || '').trim() === String(product.code || '').trim() &&
      (!this.origin.purchaseLineId || item.lineId === this.origin.purchaseLineId)) :
      !!resolvePurchaseLine(purchase.items || [], this.origin.purchaseLineId, String(product.code || '').trim());
    if (!matches) {
      throw new ConflictException({ code: 'PURCHASE_ORIGIN_MISMATCH', message: 'لا يمكن ربط القطعة ببند واضح لنفس المنتج في فاتورة شرائها. راجع الفاتورة قبل التجميع' });
    }
  }
  if (this.assignment) {
    const sale: any = await (this.constructor as any).db.collection('transactions').findOne({
      _id: new Types.ObjectId(this.assignment.transactionId), type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true },
    }, options);
    if (!sale || !(sale.items || []).some((item: any) => item.lineId === this.assignment!.lineId &&
      String(item.code || '').trim() === String(product.code || '').trim())) throw new Error('Assignment must reference a live sale line for the same product');
  }
});
retainRecords(InventoryUnitSchema, 'Inventory units must be retained; validate/save a document or retire it instead of deleting/replacing it');
