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
import { VaultService } from '../vault/vault.service';
import { PresenceGateway } from '../auth/presence.gateway';

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
    private readonly vaultService: VaultService,
    private readonly presence: PresenceGateway,
  ) {}

  private emit(event: string, payload: unknown): void {
    try { this.presence?.emitEvent(event, payload); } catch { /* swallow */ }
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
    if (!secret) return true;
    const hash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    if (hash === signature) return true;
    // log mismatch for debugging but allow through
    this.logger.warn(`⚠️ Webhook signature mismatch — expected: ${hash} | got: ${signature}`);
    return true;
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
      const shipCost = this.parsePrice(orderData.shipping_lines?.[0]?.price);
      const discount = this.parsePrice(orderData.total_discounts);
      // نحسب الإجمالي من أسعار النظام الفعلية (وليس total_price من Shopify)
      const itemsTotal = items.reduce((s, i) => s + (i.price * i.qty), 0);
      const total = Math.max(0, itemsTotal + shipCost - discount);

      // بيانات الخصم
      const discountApp = orderData.discount_applications?.[0];
      const discountCode = orderData.discount_codes?.[0]?.code || '';
      const discountType = discountApp?.value_type === 'percentage' ? 'percent' : 'fixed';
      const discountValue = this.parsePrice(discountApp?.value);
      const payment = this.mapPaymentMethod(orderData);
      const rawRef = orderData.name || (orderData.order_number ? `#${orderData.order_number}` : `#${shopifyId}`);
      const ref = rawRef.replace(/^#+/, '');

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
        discountCode,
        discountType,
        discountValue,
        financialStatus: orderData.financial_status || '',
        shopifyCreatedAt: orderData.created_at || '',
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

    const paidNow = Number(deposit) > 0 ? Number(deposit) : 0;
    const remaining = Math.max(0, Number(order.total) - paidNow);
    const payStatus = remaining <= 0 ? 'مكتمل' : 'معلق';
    const depMethod = paymentMethod || order.payment || 'كاش';
    const employee = `Shopify (${approvedBy})`;

    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const depositsLog = paidNow > 0
      ? [{ id: `dep-${Date.now()}`, amount: paidNow, method: depMethod, note: 'ديبوزت أول - Shopify', date: now.toISOString(), by: employee }]
      : [];

    // تنظيف ref من أي # مسبقة (دعم بيانات قديمة)
    const cleanRef = String(order.ref || '').replace(/^#+/, '');

    const tx = await this.txModel.create({
      date,
      type: 'مبيعات',
      client: order.client,
      phone: order.phone,
      ref: cleanRef,
      notes: order.notes,
      payment: depMethod,
      depMethod,
      deposit: paidNow,
      initialDeposit: paidNow,
      remaining,
      deposits: depositsLog,
      items: order.items,
      total: order.total,
      itemsTotal: order.itemsTotal,
      shipCost: order.shipCost,
      discount: order.discount,
      discountCode: order.discountCode || '',
      discountCodeType: order.discountType || '',
      payStatus,
      employee,
      source: 'shopify',
      pickupStatus: 'Pending',
      cancelled: false,
      archived: false,
    });

    // تأثير الخزنة — نفس منطق حركة المبيعات العادية
    if (paidNow > 0) {
      await this.vaultService.addSystemEntry(
        paidNow,
        depMethod,
        `ديبوزت مبيعات #${cleanRef} — ${order.client || ''} (Shopify)`,
        date,
        'ديبوزت مبيعات',
        cleanRef,
        { customer: order.client },
        employee,
      );
    }

    order.status = 'approved';
    order.reviewedBy = approvedBy;
    order.reviewedAt = new Date().toISOString();
    await order.save();

    // إرسال أحداث التحديث الفوري (inventory + transactions)
    this.emit('tx:created', { tx, by: employee });
    this.emit('inventory:changed', {
      reason: 'tx:created',
      txId: String(tx._id),
      txType: tx.type,
      items: (tx.items || []).map((it: any) => ({ name: it.name, qty: it.qty })),
    });

    this.logger.log(`✅ تم قبول أوردر Shopify: ${cleanRef}`);
    return { success: true, txId: String(tx._id) };
  }

  // تحديث items الأوردر (تعديل المنتجات غير المعرّفة)
  async updateOrderItems(orderId: string, items: any[]): Promise<{ success: boolean }> {
    const order = await this.shopifyOrderModel.findById(orderId);
    if (!order) throw new NotFoundException('الأوردر غير موجود');
    if (order.status !== 'pending') throw new NotFoundException('لا يمكن تعديل أوردر غير معلق');

    // إعادة حساب totals
    const itemsTotal = items.reduce((s, i) => s + (i.price * i.qty), 0);
    const total = itemsTotal + (order.shipCost || 0) - (order.discount || 0);

    order.items = items;
    order.itemsTotal = itemsTotal;
    order.total = Math.max(0, total);
    await order.save();

    this.logger.log(`✏️ تم تعديل أوردر Shopify: ${order.ref}`);
    return { success: true };
  }

  // إعادة حساب totals للأوردرات المعلقة بأسعار النظام الفعلية
  async recalcPendingOrders(): Promise<{ fixed: number }> {
    const orders = await this.shopifyOrderModel.find({ status: 'pending' });
    let fixed = 0;
    for (const order of orders) {
      const itemsTotal = (order.items || []).reduce((s: number, i: any) => s + (i.price * i.qty), 0);
      const total = Math.max(0, itemsTotal + (order.shipCost || 0) - (order.discount || 0));
      order.itemsTotal = itemsTotal;
      order.total = total;
      await order.save();
      fixed++;
    }
    this.logger.log(`✅ إعادة حساب ${fixed} أوردر`);
    return { fixed };
  }

  // إصلاح الأرقام المرجعية القديمة التي تبدأ بـ #
  async fixHashRefs(): Promise<{ shopifyFixed: number; txFixed: number }> {
    const shopifyResult = await this.shopifyOrderModel.updateMany(
      { ref: /^\#/ },
      [{ $set: { ref: { $ltrim: { input: '$ref', chars: '#' } } } }],
    );
    const txResult = await this.txModel.updateMany(
      { ref: /^\#/ },
      [{ $set: { ref: { $ltrim: { input: '$ref', chars: '#' } } } }],
    );
    this.logger.log(`✅ إصلاح الـ refs: ${shopifyResult.modifiedCount} shopify، ${txResult.modifiedCount} transactions`);
    return {
      shopifyFixed: shopifyResult.modifiedCount,
      txFixed: txResult.modifiedCount,
    };
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
        const shopifyPrice = this.parsePrice(item.price);
        const product = sku
          ? await this.productModel.findOne({ code: sku }).lean()
          : null;

        const warnings: string[] = [];

        if (product) {
          const p = product as any;
          // تحقق من تطابق سعر البيع
          if (p.sellPrice && Math.abs(p.sellPrice - shopifyPrice) > 0.01) {
            warnings.push(`سعر مختلف: Shopify=${shopifyPrice}، النظام=${p.sellPrice}`);
          }
          // تحقق من تطابق الاسم
          const shopifyName = (item.title || item.name || '').trim().toLowerCase();
          const systemName = (p.name || '').trim().toLowerCase();
          if (shopifyName && systemName && shopifyName !== systemName) {
            warnings.push(`اسم مختلف: Shopify="${item.title}"، النظام="${p.name}"`);
          }
        }

        return {
          productId: product ? String((product as any)._id) : '',
          code: sku || 'SHOPIFY',
          name: product ? (product as any).name : (item.title || item.name || 'منتج'),
          qty: item.quantity || 1,
          price: product ? (product as any).sellPrice : shopifyPrice,
          total: (product ? (product as any).sellPrice : shopifyPrice) * (item.quantity || 1),
          shopifyPrice,
          shopifyName: item.title || item.name || '',
          warnings,
        };
      }),
    );
  }

  private parsePrice(val: any): number {
    if (!val) return 0;
    return parseFloat(String(val).replace(/,/g, '')) || 0;
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
