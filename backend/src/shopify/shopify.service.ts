import { Injectable, Logger } from '@nestjs/common';
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

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
    if (!secret) return true; // في بيئة التطوير بدون secret نقبل الطلب
    const hash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    return hash === signature;
  }

  async handleOrder(orderData: any): Promise<{ saved: boolean; id?: string; reason?: string }> {
    try {
      // تجنب تكرار نفس الأوردر
      const ref = `shopify-${orderData.id}`;
      const exists = await this.txModel.findOne({ ref }).lean();
      if (exists) {
        return { saved: false, reason: 'مكرر - تم الحفظ مسبقاً' };
      }

      // تحويل المنتجات
      const items = await this.mapItems(orderData.line_items || []);

      // بيانات العميل
      const customer = orderData.customer || {};
      const clientName = [customer.first_name, customer.last_name]
        .filter(Boolean)
        .join(' ') || 'عميل Shopify';
      const clientPhone = customer.phone || orderData.shipping_address?.phone || '';

      // العنوان في الملاحظات
      const address = this.formatAddress(orderData.shipping_address);
      const shopifyNotes = orderData.note || '';
      const notes = [address, shopifyNotes].filter(Boolean).join(' | ');

      // الشحن
      const shipCost = parseFloat(
        orderData.shipping_lines?.[0]?.price || '0',
      );

      // الخصم
      const discount = parseFloat(orderData.total_discounts || '0');

      // الإجمالي
      const total = parseFloat(orderData.total_price || '0');
      const itemsTotal = parseFloat(orderData.subtotal_price || '0');

      // حالة الدفع
      const financialStatus = orderData.financial_status || '';
      const isPaid = financialStatus === 'paid';
      const payStatus = isPaid ? 'مكتمل' : 'معلق';
      const deposit = isPaid ? total : 0;
      const remaining = isPaid ? 0 : total;

      // طريقة الدفع
      const payment = this.mapPaymentMethod(orderData);

      const date = new Date(orderData.created_at || Date.now())
        .toLocaleDateString('ar-EG', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });

      const tx = await this.txModel.create({
        date,
        type: 'مبيعات',
        client: clientName,
        phone: clientPhone,
        ref,
        notes,
        payment,
        deposit,
        initialDeposit: deposit,
        remaining,
        items,
        total,
        itemsTotal,
        shipCost,
        discount,
        payStatus,
        employee: 'Shopify',
        pickupStatus: 'Pending',
        cancelled: false,
        archived: false,
      });

      this.logger.log(`✅ تم حفظ أوردر Shopify: ${ref}`);
      return { saved: true, id: String(tx._id) };
    } catch (err) {
      this.logger.error(`❌ خطأ في حفظ أوردر Shopify: ${err.message}`);
      return { saved: false, reason: err.message };
    }
  }

  private async mapItems(lineItems: any[]) {
    return Promise.all(
      lineItems.map(async (item) => {
        const sku = item.sku || '';
        // ابحث عن المنتج بالـ SKU (كود المنتج)
        const product = sku
          ? await this.productModel.findOne({ code: sku }).lean()
          : null;

        return {
          productId: product ? String(product._id) : '',
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
    const parts = [
      addr.address1,
      addr.address2,
      addr.city,
      addr.province,
      addr.country,
    ].filter(Boolean);
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
