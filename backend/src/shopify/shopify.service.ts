import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import {
  Product,
  ProductDocument,
} from '../products/schemas/product.schema';
import {
  ShopifyOrder,
  ShopifyOrderDocument,
} from './schemas/shopify-order.schema';

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ShopifyOrder.name)
    private readonly shopifyOrderModel: Model<ShopifyOrderDocument>,
  ) {}

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
    if (!secret) return true;
    const hash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    return hash === signature;
  }

  // استقبال الأوردر من Shopify وحفظه للمراجعة
  async handleOrder(orderData: any): Promise<{ saved: boolean; id?: string; reason?: string }> {
    try {
      const shopifyId = String(orderData.id);
      this.logger.log(`Shopify order fields: id=${orderData.id}, name=${orderData.name}, order_number=${orderData.order_number}`);

      // تجنب التكرار
      const exists = await this.shopifyOrderModel.findOne({ shopifyId }).lean();
      if (exists) {
        return { saved: false, reason: 'مكرر - تم الحفظ مسبقاً' };
      }

      const items = await this.mapItems(orderData.line_items || []);
      const customer = orderData.customer || {};
      const clientName = [customer.first_name, customer.last_name]
        .filter(Boolean).join(' ') || 'عميل Shopify';
      const clientPhone = customer.phone || orderData.shipping_address?.phone || '';
      const address = this.formatAddress(orderData.shipping_address);
      const shopifyNotes = orderData.note || '';
      const notes = [address, shopifyNotes].filter(Boolean).join(' | ');
      const shipCost = parseFloat(orderData.shipping_lines?.[0]?.price || '0');
      const discount = parseFloat(orderData.total_discounts || '0');
      const total = parseFloat(orderData.total_price || '0');
      const itemsTotal = parseFloat(orderData.subtotal_price || '0');
      const payment = this.mapPaymentMethod(orderData);
      const ref = orderData.order_number ? `#${orderData.order_number}` : (orderData.name || `#${shopifyId}`);

      const order = await this.shopifyOrderModel.create({
        shopifyId,
        ref,
        client: clientName,
        phone: clientPhone,
        notes,
        payment,
        total,
        itemsTotal,
        shipCost,
        discount,
        financialStatus: orderData.financial_status || '',
        items,
        status: 'pending',
        rawData: orderData,
      });

      this.logger.log(`📦 أوردر Shopify جديد بانتظار المراجعة: ${ref}`);
      return { saved: true, id: String(order._id) };
    } catch (err) {
      this.logger.error(`❌ خطأ: ${err.message}`);
      return { saved: false, reason: err.message };
    }
  }

  // جلب كل الأوردرات المعلقة
  async getPendingOrders(): Promise<ShopifyOrderDocument[]> {
    return this.shopifyOrderModel.find({ status: 'pending' }).sort({ createdAt: -1 }).lean() as any;
  }

  // جلب كل الأوردرات
  async getAllOrders(): Promise<ShopifyOrderDocument[]> {
    return this.shopifyOrderModel.find().sort({ createdAt: -1 }).lean() as any;
  }

  // قبول الأوردر وتحويله لحركة مبيعات
  async approveOrder(orderId: string, approvedBy: string, deposit = 0, paymentMethod?: string): Promise<{ success: boolean; txId?: string }> {
    const order = await this.shopifyOrderModel.findById(orderId);
    if (!order) throw new NotFoundException('الأوردر غير موجود');
    if (order.status !== 'pending') {
      return { success: false };
    }

    const paidNow = deposit > 0 ? deposit : 0;
    const remaining = Math.max(0, order.total - paidNow);
    const payStatus = remaining <= 0 ? 'مكتمل' : 'معلق';

    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const tx = await this.txModel.create({
      date,
      type: 'مبيعات',
      client: order.client,
      phone: order.phone,
      ref: order.ref,
      notes: order.notes,
      payment: paymentMethod || order.payment,
      deposit: paidNow,
      initialDeposit: paidNow,
      remaining,
      items: order.items,
      total: order.total,
      itemsTotal: order.itemsTotal,
      shipCost: order.shipCost,
      discount: order.discount,
      payStatus,
      employee: `Shopify (${approvedBy})`,
      pickupStatus: 'Pending',
      cancelled: false,
      archived: false,
    });

    order.status = 'approved';
    order.reviewedBy = approvedBy;
    order.reviewedAt = new Date().toISOString();
    await order.save();

    this.logger.log(`✅ تم قبول أوردر Shopify: ${order.ref}`);
    return { success: true, txId: String(tx._id) };
  }

  // رفض الأوردر
  async rejectOrder(orderId: string, rejectedBy: string, reason: string): Promise<{ success: boolean }> {
    const order = await this.shopifyOrderModel.findById(orderId);
    if (!order) throw new NotFoundException('الأوردر غير موجود');

    order.status = 'rejected';
    order.reviewedBy = rejectedBy;
    order.reviewedAt = new Date().toISOString();
    order.rejectReason = reason;
    await order.save();

    this.logger.log(`❌ تم رفض أوردر Shopify: ${order.ref}`);
    return { success: true };
  }

  private async mapItems(lineItems: any[]) {
    return Promise.all(
      lineItems.map(async (item) => {
        const sku = item.sku || '';
        const product = sku
          ? await this.productModel.findOne({ code: sku }).lean()
          : null;
        return {
          productId: product ? String((product as any)._id) : '',
          code: sku || 'SHOPIFY',
          name: item.title || item.name || 'منتج',
          qty: item.quantity || 1,
          price: parseFloat(item.price || '0'),
          total: parseFloat(item.price || '0') * (item.quantity || 1),
        };
      }),
    );
  }

  private formatAddress(addr: any): string {
    if (!addr) return '';
    const parts = [addr.address1, addr.address2, addr.city, addr.province, addr.country].filter(Boolean);
    return parts.length ? `العنوان: ${parts.join('، ')}` : '';
  }

  private mapPaymentMethod(order: any): string {
    const gateway = order.payment_gateway || '';
    if (gateway.includes('cash')) return 'كاش';
    if (gateway.includes('vodafone') || gateway.includes('fawry')) return 'فودافون كاش';
    if (gateway.includes('instapay')) return 'Instapay';
    if (gateway.includes('bank') || gateway.includes('transfer')) return 'تحويل بنكي';
    return 'كاش';
  }
}
