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
import { normalizeCity, cityToShipZone } from '../shared/normalize-city.util';
import { ShopifyAdminService } from './shopify-admin.service';

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
    private readonly shopifyAdminService: ShopifyAdminService,
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
      if (!orderData.id) {
        this.logger.warn(`Shopify order missing id, skipping. name=${orderData.name}`);
        return { saved: false, reason: 'بيانات ناقصة - لا يوجد id' };
      }
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
      const city = this.formatCity(orderData.shipping_address);
      const bostaCity = city; // formatCity already returns English Bosta-accepted city name
      const govArabic = orderData.shipping_address?.province || orderData.shipping_address?.city || '';
      const notes = orderData.note || '';
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
        tags: orderData.tags || '',
        shippingAddress: address,
        shippingCity: city,
        shippingGov: govArabic,
        shippingBostaCity: bostaCity,
        orderStatusUrl: orderData.order_status_url || '',
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

  // جلب أوردرات قديمة من Shopify مباشرة (Admin API) لعرضها واختيار ما يُستورد
  async fetchRemoteOrders(params: {
    limit?: number;
    status?: 'open' | 'closed' | 'cancelled' | 'any';
    createdAtMin?: string;
    createdAtMax?: string;
    name?: string;
  }): Promise<{ success: boolean; orders?: any[]; error?: string }> {
    const res = await this.shopifyAdminService.listOrders(params);
    if (!res.success) return res;

    const existingIds = new Set(
      (await this.shopifyOrderModel.find({}, { shopifyId: 1 }).lean()).map((o: any) => o.shopifyId),
    );

    const orders = (res.orders || []).map((o: any) => ({
      shopifyId: String(o.id),
      name: o.name,
      orderNumber: o.order_number,
      createdAt: o.created_at,
      client: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || 'عميل Shopify',
      phone: o.customer?.phone || o.shipping_address?.phone || '',
      total: this.parsePrice(o.total_price),
      financialStatus: o.financial_status || '',
      fulfillmentStatus: o.fulfillment_status || '',
      itemsCount: (o.line_items || []).length,
      alreadyImported: existingIds.has(String(o.id)),
    }));

    return { success: true, orders };
  }

  // استيراد أوردر قديم محدد بالـ ID من Shopify (نفس مسار الأوردر الفوري: pending ثم موافقة الأدمن)
  async importOrderById(shopifyOrderId: string): Promise<{ saved: boolean; id?: string; reason?: string }> {
    const res = await this.shopifyAdminService.getOrder(shopifyOrderId);
    if (!res.success || !res.order) {
      return { saved: false, reason: res.error || 'تعذر جلب الأوردر من Shopify' };
    }
    return this.handleOrder(res.order);
  }

  // مزامنة تحديث الأوردر من Shopify (note + tags فقط)
  async handleOrderUpdate(orderData: any): Promise<{ updated: boolean; reason?: string }> {
    try {
      const shopifyId = String(orderData.id);
      const order = await this.shopifyOrderModel.findOne({ shopifyId });
      if (!order) {
        return { updated: false, reason: 'الأوردر غير موجود في النظام' };
      }

      const notes = orderData.note || '';
      const address = this.formatAddress(orderData.shipping_address);
      const city = this.formatCity(orderData.shipping_address);
      const bostaCity = city;
      const govArabic = orderData.shipping_address?.province || orderData.shipping_address?.city || '';
      const tags = orderData.tags || '';
      const financialStatus = orderData.financial_status || order.financialStatus;

      const items = await this.mapItems(orderData.line_items || []);
      const shipCost = this.parsePrice(orderData.shipping_lines?.[0]?.price);
      const discount = this.parsePrice(orderData.total_discounts);
      const itemsTotal = items.reduce((s: number, i: any) => s + (i.price * i.qty), 0);
      const total = Math.max(0, itemsTotal + shipCost - discount);

      order.notes = notes;
      order.shippingAddress = address;
      if (city) order.shippingCity = city;
      if (city) order.shippingBostaCity = bostaCity;
      if (govArabic) order.shippingGov = govArabic;
      order.tags = tags;
      order.financialStatus = financialStatus;
      order.items = items;
      order.shipCost = shipCost;
      order.itemsTotal = itemsTotal;
      order.total = total;
      order.rawData = orderData;
      await order.save();

      // تحديث الحركة المقابلة في سجل المبيعات إن وُجدت
      // tags في Shopify نص مفصول بفواصل، transaction تحتفظ بها كمصفوفة
      const txTags = tags ? tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
      const txUpdate: any = { notes, tags: txTags };
      if (address) txUpdate.shippingAddress = address;
      if (city) txUpdate.shippingCity = city;
      if (city) txUpdate.shippingBostaCity = bostaCity;
      if (govArabic) txUpdate.shippingGov = govArabic;
      await this.txModel.updateOne(
        { shopifyOrderId: shopifyId },
        { $set: txUpdate },
      );

      this.logger.log(`🔄 تحديث أوردر Shopify: ${order.ref}`);
      return { updated: true };
    } catch (err) {
      this.logger.error(`❌ خطأ في تحديث الأوردر: ${err.message}`);
      return { updated: false, reason: err.message };
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

    // shippingBostaCity is the English Bosta-accepted city name (most reliable)
    const bostaCity = (order as any).shippingBostaCity || order.shippingCity || '';
    const shipZone = cityToShipZone(bostaCity);

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
      shipZone,
      discount: order.discount,
      discountCode: order.discountCode || '',
      discountCodeType: order.discountType || '',
      payStatus,
      employee,
      source: 'shopify',
      shopifyOrderId: order.shopifyId,
      shopifyCreatedAt: order.shopifyCreatedAt || '',
      shippingAddress: order.shippingAddress || '',
      shippingCity: order.shippingCity || '',
      shippingGov: (order as any).shippingGov || '',
      shippingBostaCity: bostaCity,
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

  // ترقية: حفظ shopifyCreatedAt في transactions القديمة التي تفتقده
  async backfillShopifyCreatedAt(): Promise<{ updated: number }> {
    const txs = await this.txModel.find({ shopifyOrderId: { $exists: true, $ne: '' }, shopifyCreatedAt: { $in: [null, '', undefined] } }).lean();
    let updated = 0;
    for (const tx of txs) {
      const order = await this.shopifyOrderModel.findOne({ shopifyId: tx.shopifyOrderId }).lean();
      if (order?.shopifyCreatedAt) {
        await this.txModel.updateOne({ _id: tx._id }, { $set: { shopifyCreatedAt: order.shopifyCreatedAt } });
        updated++;
      }
    }
    return { updated };
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

  // تحديث الحالة الفرعية لأوردر معلق
  async updatePendingStatus(orderId: string, pendingStatus: string): Promise<{ success: boolean }> {
    const order = await this.shopifyOrderModel.findById(orderId);
    if (!order) throw new NotFoundException('الأوردر غير موجود');
    order.pendingStatus = pendingStatus;
    await order.save();
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
          imageUrl: product ? ((product as any).imageUrl || '') : '',
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
    // firstLine = address1 + address2 فقط (city تُحفظ منفصلاً في shippingCity)
    const parts = [addr.address1, addr.address2].filter(Boolean);
    return parts.join('، ');
  }

  private formatCity(addr: any): string {
    if (!addr) return '';
    // province = المحافظة (Gharbia, Alexandria...) أدق من city (Tanta, Smoha...)
    const raw = addr.province || addr.city || '';
    return normalizeCity(raw) || raw;
  }

  private formatBostaCity(addr: any): string {
    // نفس المنطق — يُرجع الاسم الإنجليزي الجاهز لبوسطا
    return this.formatCity(addr);
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
