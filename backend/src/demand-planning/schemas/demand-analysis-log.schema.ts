import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DemandAnalysisLogDocument = HydratedDocument<DemandAnalysisLog>;

/**
 * Immutable audit trail for the demand-planning layer.
 *
 * One entry per user action:
 *   'تحليل احتياج المخزون'   — an analysis was run over a set of orders
 *   'إضافة إلى أمر شراء'      — quantities were pushed into an existing PO
 *   'إنشاء أمر شراء من التحليل' — a new PO was created out of the analysis
 */
@Schema({ timestamps: true })
export class DemandAnalysisLog {
  @Prop({ required: true })
  action: string;

  @Prop({ default: '' })
  by: string;

  @Prop({ default: '' })
  byUsername: string;

  @Prop({ required: true })
  at: string;

  /** Number of transactions included in the analysis */
  @Prop({ default: 0 })
  ordersCount: number;

  /** Distinct SKUs analysed */
  @Prop({ default: 0 })
  skuCount: number;

  /** Sum of all required quantities */
  @Prop({ default: 0 })
  totalRequiredQty: number;

  /** Sum of all shortages found */
  @Prop({ default: 0 })
  totalShortageQty: number;

  /** Transaction ids the analysis covered */
  @Prop({ type: [String], default: [] })
  transactionIds: string[];

  /** Order refs — human readable, survives transaction deletion */
  @Prop({ type: [String], default: [] })
  orderRefs: string[];

  /** Per-SKU snapshot of the analysis at the moment it ran */
  @Prop({ type: [Object], default: [] })
  lines: Array<{
    sku: string;
    name: string;
    required: number;
    available: number;
    reserved: number;
    shortage: number;
    suggestedPurchase: number;
  }>;

  /** Set for PO actions — which purchase order received the quantities */
  @Prop({ default: '' })
  poId: string;

  @Prop({ default: '' })
  poNumber: string;

  @Prop({ default: '' })
  supplierId: string;

  @Prop({ default: '' })
  supplierName: string;

  /** Free-text detail for the activity feed */
  @Prop({ default: '' })
  detail: string;
}

export const DemandAnalysisLogSchema =
  SchemaFactory.createForClass(DemandAnalysisLog);
DemandAnalysisLogSchema.index({ at: -1 });
DemandAnalysisLogSchema.index({ action: 1, at: -1 });
