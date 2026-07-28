import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OrderAuditDocument = HydratedDocument<OrderAudit>;

/**
 * Persistent log of every Order Range Audit that was generated.
 * One document per generated report — never mutated except for the
 * per-missing-order review actions (reviewed flag / investigation note).
 */
@Schema({ timestamps: true })
export class OrderAudit {
  /** First Shopify order number in the audited range */
  @Prop({ required: true })
  fromOrder: number;

  /** Last Shopify order number in the audited range */
  @Prop({ required: true })
  toOrder: number;

  /** (toOrder - fromOrder + 1) */
  @Prop({ default: 0 })
  expectedCount: number;

  /** Orders found registered inside Soulia (transactions) */
  @Prop({ default: 0 })
  registeredCount: number;

  /** Orders present in the Shopify mirror but never turned into a transaction */
  @Prop({ default: 0 })
  missingCount: number;

  /** registeredCount / expectedCount * 100 */
  @Prop({ default: 0 })
  syncRate: number;

  /** Ordered list of missing order numbers, e.g. ['2238','2245'] */
  @Prop({ type: [String], default: [] })
  missingOrders: string[];

  /** Financial rollup captured at generation time (immutable snapshot) */
  @Prop({ type: Object, default: {} })
  financials: {
    totalSales?: number;
    totalProductCost?: number;
    totalShippingCost?: number;
    totalProfit?: number;
    avgOrderValue?: number;
  };

  /** 'clean' when nothing is missing, otherwise 'gaps_found' */
  @Prop({ default: 'clean' })
  result: string;

  /** Username that generated the report */
  @Prop({ default: '' })
  generatedBy: string;

  /** 'manual' | 'auto' — auto = produced by the daily monitor cron */
  @Prop({ default: 'manual' })
  source: string;

  /**
   * Per-missing-order review state, keyed by order number.
   * Written by the "Mark as Reviewed" / "Add Investigation Note" actions.
   */
  @Prop({ type: [Object], default: [] })
  reviews: Array<{
    orderNumber: string;
    reviewed: boolean;
    note: string;
    by: string;
    at: string;
  }>;
}

export const OrderAuditSchema = SchemaFactory.createForClass(OrderAudit);
OrderAuditSchema.index({ createdAt: -1 });
OrderAuditSchema.index({ fromOrder: 1, toOrder: 1 });
