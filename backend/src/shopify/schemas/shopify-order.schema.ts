import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShopifyOrderDocument = HydratedDocument<ShopifyOrder>;

@Schema({ timestamps: true })
export class ShopifyOrder {
  @Prop({ required: true, unique: true })
  shopifyId: string;

  @Prop({ required: true })
  ref: string;

  @Prop({ default: '' })
  client: string;

  @Prop({ default: '' })
  phone: string;

  @Prop({ default: '' })
  notes: string;

  @Prop({ default: '' })
  payment: string;

  @Prop({ default: 0 })
  total: number;

  @Prop({ default: 0 })
  itemsTotal: number;

  @Prop({ default: 0 })
  shipCost: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop({ default: '' })
  discountCode: string;

  @Prop({ default: '' })
  discountType: string; // 'percent' | 'fixed'

  @Prop({ default: 0 })
  discountValue: number;

  @Prop({ default: '' })
  financialStatus: string;

  @Prop({ default: '' })
  shopifyCreatedAt: string;

  @Prop({ type: [Object], default: [] })
  items: Array<{
    productId: string;
    code: string;
    name: string;
    qty: number;
    price: number;
    total: number;
    imageUrl: string;
    shopifyPrice: number;
    shopifyName: string;
  }>;

  @Prop({ default: 'pending' })
  status: string; // 'pending' | 'approved' | 'rejected'

  @Prop({ default: '' })
  pendingStatus: string; // '' | 'msg_sent' | 'awaiting_transfer' | 'no_reply'

  @Prop({ default: false })
  cancelled: boolean;

  @Prop({ default: '' })
  cancelledBy: string;

  @Prop({ default: '' })
  cancelledAt: string;

  @Prop({ default: '' })
  cancelReason: string;

  @Prop({ default: '' })
  reviewedBy: string;

  @Prop({ default: '' })
  reviewedAt: string;

  @Prop({ default: '' })
  rejectReason: string;

  @Prop({ default: '' })
  tags: string;

  @Prop({ default: '' })
  shippingAddress: string;

  @Prop({ default: '' })
  shippingCity: string;

  @Prop({ default: '' })
  shippingGov: string;

  @Prop({ default: '' })
  shippingBostaCity: string;

  @Prop({ default: '' })
  orderStatusUrl: string;

  @Prop({ type: Object })
  rawData: Record<string, unknown>;
}

export const ShopifyOrderSchema = SchemaFactory.createForClass(ShopifyOrder);
