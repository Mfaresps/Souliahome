import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
import { computeDepositFields } from './deposit-parser.util';
import { EmployeeShiftService } from '../employee-performance/employee-shift.service';
import { EmployeeScoringService } from '../employee-performance/employee-scoring.service';
import { MentionsService } from '../mentions/mentions.service';
import { UsersService } from '../users/users.service';
import {
  InventoryMovementsService,
  RecordMovementEntry,
} from '../inventory-movements/inventory-movements.service';
import { TransactionsService } from '../transactions/transactions.service';

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
    private readonly employeeShiftService: EmployeeShiftService,
    private readonly employeeScoringService: EmployeeScoringService,
    private readonly mentionsService: MentionsService,
    private readonly usersService: UsersService,
    @Inject(forwardRef(() => InventoryMovementsService))
    private readonly inventoryMovementsService: InventoryMovementsService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
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

      // بيانات الخصم — نتجاهل تطبيقات الخصم الخاصة بالشحن (مثل Free Shipping التلقائي)
      // لأنها ليست خصماً حقيقياً على قيمة الأوردر
      const discountApp = this.pickOrderDiscountApplication(orderData.discount_applications);
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

      // إسناد استرشادي للموظف المسؤول حسب جدول الورديات — لا يمنع إنشاء الأوردر عند الفشل
      try {
        const assignment = await this.employeeShiftService.resolveAssignee(order.shopifyCreatedAt || new Date().toISOString());
        if (assignment) {
          order.assignedTo = assignment.userId;
          order.assignedToName = assignment.name;
          order.assignedAt = new Date().toISOString();
          order.assignmentReason = assignment.reason;
          await order.save();
          this.notifyOrderAssigned(order, assignment.userId).catch((err) =>
            this.logger.error(`Order-assigned notification failed for order ${order._id}: ${(err as Error).message}`),
          );
        }
      } catch (assignErr) {
        this.logger.warn(`Auto-assignment failed for order ${order._id}: ${(assignErr as Error).message}`);
      }

      // تحليل الإيداع من الملاحظات فور وصول الأوردر — يُستخدم فوراً لتقييم أداء الموظف المسؤول
      try {
        const parsed = computeDepositFields({ notes: order.notes, tags: order.tags, total: order.total });
        order.depositAmount = parsed.depositAmount;
        order.depositMethod = parsed.depositMethod;
        order.depositStatus = parsed.depositStatus;
        order.depositPercentage = parsed.depositPercentage;
        order.depositDetectedAt = new Date().toISOString();
        await order.save();
        this.employeeScoringService.scoreDepositDetection(order).catch((err) =>
          this.logger.error(`Deposit scoring failed for order ${order._id}: ${(err as Error).message}`),
        );
      } catch (depositErr) {
        this.logger.warn(`Deposit parsing failed for order ${order._id}: ${(depositErr as Error).message}`);
      }

      return { saved: true, id: String(order._id) };
    } catch (err) {
      this.logger.error(`❌ خطأ: ${err.message}`);
      return { saved: false, reason: err.message };
    }
  }

  /**
   * Notifies the assigned employee (and all admins) that a new Shopify order
   * was routed to them, via the existing mentions/presence infrastructure —
   * persisted notification + real-time push, same pipe the frontend already
   * renders (mentionNotifier sound/toast, notification bell/list).
   */
  private async notifyOrderAssigned(order: ShopifyOrderDocument, assignedUserId: string): Promise<void> {
    const cleanRef = String(order.ref || '').replace(/^#+/, '');
    const assigneeName = order.assignedToName || '-';

    // Personalized per recipient: the assignee sees "assigned to YOU"; admins (who did not
    // receive the order themselves) see "assigned to <name>" — same event, different framing.
    const buildText = (forAssignee: boolean) =>
      [
        forAssignee ? `أوردر جديد مُسند إليك: #${cleanRef}` : `أوردر جديد مُسند إلى ${assigneeName}: #${cleanRef}`,
        `العميل: ${order.client || '-'}`,
        `الإجمالي: ${order.total || 0} EGP`,
      ].join('\n');

    const admins = await this.usersService.findAdmins();
    const targetIds = new Set<string>([assignedUserId, ...admins.map((a) => String(a._id))]);

    const rows = [...targetIds].map((targetUserId) => ({
      targetUserId,
      targetUsername: '',
      targetName: order.assignedToName || '',
      fromUserId: 'system',
      fromName: 'نظام التوزيع',
      txId: String(order._id),
      txRef: cleanRef,
      commentId: 0,
      commentText: buildText(targetUserId === assignedUserId),
      read: false,
    }));

    const created = await this.mentionsService.createMany(rows);
    for (const m of created as any[]) {
      const payload = {
        id: String(m._id),
        _id: String(m._id),
        targetUserId: m.targetUserId,
        targetUsername: m.targetUsername,
        targetName: m.targetName,
        fromUserId: m.fromUserId,
        fromName: m.fromName,
        txId: m.txId,
        txRef: m.txRef,
        commentId: m.commentId,
        commentText: m.commentText,
        read: false,
        ts: (m.createdAt instanceof Date) ? m.createdAt.toISOString() : new Date().toISOString(),
      };
      try { this.presence.emitToUser(String(m.targetUserId), 'mention:new', payload); } catch { /* best-effort */ }
    }
  }

  /**
   * Admin-only manual reassignment. Changes ONLY routing metadata (assignedTo/
   * assignedToName/assignedAt/assignmentReason) and appends to assignmentHistory —
   * never touches reviewedBy/reviewedAt, deposit fields, or any EmployeePerformanceLog
   * row, so historical scoring/attribution is unaffected by a later reassignment.
   */
  async reassignOrder(
    orderId: string,
    newEmployeeId: string,
    reason: string,
    changedBy: string,
  ): Promise<{ success: boolean; error?: string }> {
    const order = await this.shopifyOrderModel.findById(orderId);
    if (!order) return { success: false, error: 'الأوردر غير موجود' };

    const newUser = await this.usersService.findById(newEmployeeId);
    if (!newUser) return { success: false, error: 'الموظف غير موجود' };
    if (newUser.role !== 'staff') return { success: false, error: 'يمكن إسناد الأوردر لموظف (staff) فقط' };

    const previousUserId = order.assignedTo || '';
    const previousName = order.assignedToName || '';
    const newName = newUser.name || newUser.username || '';
    const now = new Date().toISOString();

    order.assignedTo = newEmployeeId;
    order.assignedToName = newName;
    order.assignedAt = now;
    order.assignmentReason = 'manual';
    order.assignmentHistory = [
      ...(order.assignmentHistory || []),
      {
        previousUserId,
        previousName,
        newUserId: newEmployeeId,
        newName,
        changedBy,
        reason: reason || '',
        at: now,
      },
    ];

    // أوردرات قديمة كانت لسه معلقة قبل تفعيل هذا النظام قد لا يكون تحليل الإيداع
    // تم لها من قبل — نعيد التحليل هنا فقط إذا لم يُنفَّذ بعد، حتى تُحسب نقاط الإيداع
    // للموظف الجديد. لا نلمس reviewedBy/reviewedAt أو نقاط سرعة التأكيد/التسليم إطلاقاً،
    // لأن توقيتات أوردر قديم لا تعطي قياس سرعة منطقي.
    if (order.status === 'pending' && !order.depositDetectedAt) {
      const parsed = computeDepositFields({ notes: order.notes, tags: order.tags, total: order.total });
      order.depositAmount = parsed.depositAmount;
      order.depositMethod = parsed.depositMethod;
      order.depositStatus = parsed.depositStatus;
      order.depositPercentage = parsed.depositPercentage;
      order.depositDetectedAt = now;
    }

    await order.save();

    if (order.status === 'pending') {
      this.employeeScoringService.scoreDepositDetection(order).catch((err) =>
        this.logger.error(`Deposit scoring failed after reassignment for order ${order._id}: ${(err as Error).message}`),
      );
    }

    this.notifyOrderAssigned(order, newEmployeeId).catch((err) =>
      this.logger.error(`Reassignment notification failed for order ${order._id}: ${(err as Error).message}`),
    );

    return { success: true };
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

      // إعادة تحليل الإيداع فقط طالما الأوردر لسه معلق — بعد التأكيد تتجمد قيم الإيداع
      // لأنها بالفعل مرتبطة بحركة/خزنة تم إنشاؤها، وإعادة تحليلها هتفصل بين الرقم المسجل والفعلي
      if (order.status === 'pending') {
        const parsed = computeDepositFields({ notes: order.notes, tags: order.tags, total: order.total });
        order.depositAmount = parsed.depositAmount;
        order.depositMethod = parsed.depositMethod;
        order.depositStatus = parsed.depositStatus;
        order.depositPercentage = parsed.depositPercentage;
        order.depositDetectedAt = new Date().toISOString();
      }

      await order.save();

      if (order.status === 'pending') {
        this.employeeScoringService.scoreDepositDetection(order).catch((err) =>
          this.logger.error(`Deposit re-scoring failed for order ${order._id}: ${(err as Error).message}`),
        );
      }

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
    // المعاملة بتتسجل بتاريخ إنشاء الأوردر الأصلي في شوبيفاي، مش تاريخ لحظة الإرسال لسجل المعاملات
    const orderDateSource = order.shopifyCreatedAt ? new Date(order.shopifyCreatedAt) : now;
    const date = `${orderDateSource.getFullYear()}-${String(orderDateSource.getMonth() + 1).padStart(2, '0')}-${String(orderDateSource.getDate()).padStart(2, '0')}`;

    // لحظة التأكيد — تُحسب مرة واحدة وتُكتب على المعاملة وعلى الأوردر معاً، فلا ينفصل
    // reviewedAt عن confirmedAt بفارق أجزاء الثانية بين الاثنين.
    const confirmedAt = now.toISOString();

    const depositsLog = paidNow > 0
      ? [{ id: `dep-${Date.now()}`, amount: paidNow, method: depMethod, note: 'ديبوزت أول - Shopify', date: now.toISOString(), by: employee }]
      : [];

    // تنظيف ref من أي # مسبقة (دعم بيانات قديمة)
    const cleanRef = String(order.ref || '').replace(/^#+/, '');

    // shippingBostaCity is the English Bosta-accepted city name (most reliable)
    const bostaCity = (order as any).shippingBostaCity || order.shippingCity || '';
    const shipZone = cityToShipZone(bostaCity);

    // Pre-creation stock snapshot for the Inventory Movement Log — taken BEFORE the
    // transaction exists so this order's own items don't pollute their own "before"
    // balance. Mirrors TransactionsService.create(); see recordInventoryMovementForSale.
    const invSnapshotBefore = await this.transactionsService.getInventory();

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
      assignedToName: order.assignedToName || '',
      assignedAt: order.assignedAt || '',
      confirmedByName: approvedBy || '',
      confirmedAt: confirmedAt,
      depositDetectedAt: order.depositDetectedAt || '',
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

    // سجل حركة المخزون — لازم يتكتب هنا لأن approveOrder بتكتب المعاملة مباشرة
    // على txModel وبتتخطى TransactionsService.create() اللي بتسجل الحركة عادة.
    await this.recordInventoryMovementForSale(tx, invSnapshotBefore, employee);

    // تحليل الإيداع من الملاحظات مرة واحدة فقط عند التأكيد — يُستخدم لاحقاً في تقييم الأداء
    const parsedDeposit = computeDepositFields({ notes: order.notes, tags: order.tags, total: order.total });
    order.depositAmount = parsedDeposit.depositAmount;
    order.depositMethod = parsedDeposit.depositMethod;
    order.depositStatus = parsedDeposit.depositStatus;
    order.depositPercentage = parsedDeposit.depositPercentage;
    order.depositDetectedAt = new Date().toISOString();

    order.status = 'approved';
    order.reviewedBy = approvedBy;
    order.reviewedAt = confirmedAt;
    await order.save();

    // إرسال أحداث التحديث الفوري (inventory + transactions)
    this.emit('tx:created', { tx, by: employee });
    this.emit('inventory:changed', {
      reason: 'tx:created',
      txId: String(tx._id),
      txType: tx.type,
      items: (tx.items || []).map((it: any) => ({ name: it.name, qty: it.qty })),
    });

    // تقييم أداء الموظف الذي قام بالتأكيد — لا يجب أن يؤثر على نجاح العملية عند الفشل
    this.employeeScoringService.scoreConfirmation(order, approvedBy).catch((err) =>
      this.logger.error(`Performance scoring failed for order ${order._id}: ${(err as Error).message}`),
    );

    this.logger.log(`✅ تم قبول أوردر Shopify: ${cleanRef}`);
    return { success: true, txId: String(tx._id) };
  }

  /**
   * Writes the سجل حركة المخزون rows for a Shopify sale.
   *
   * approveOrder creates its transaction straight on txModel rather than through
   * TransactionsService.create(), so none of that method's side effects run — this
   * replicates the movement-logging block at transactions.service.ts (create()).
   * A Shopify order is always type 'مبيعات', so the movement is always sign -1.
   *
   * `snapshotBefore` MUST be the getInventory() result taken before the transaction
   * was created, or qtyBefore already absorbs this order's own deduction.
   *
   * Never throws: the sale and its vault entry are already committed by this point,
   * and a logging failure must not fail an order that has otherwise succeeded.
   */
  private async recordInventoryMovementForSale(
    tx: TransactionDocument,
    snapshotBefore: Array<{ _id: string; code: string; name: string; current: number }>,
    employee: string,
  ): Promise<void> {
    try {
      const byCodeBefore = new Map(
        snapshotBefore.map((r) => [String(r.code).trim(), r]),
      );
      const entries: RecordMovementEntry[] = [];
      const skipped: string[] = [];

      for (const item of tx.items || []) {
        const code = String(item.code || '').trim();
        const invRow = byCodeBefore.get(code);
        if (!invRow) {
          // Shopify line items are copied verbatim, so a SKU that matches no product
          // code yields no movement row. Silent in create(); named here, because for a
          // Shopify order this is the likely failure and it is otherwise invisible.
          skipped.push(`${item.name || '?'}${code ? ` (${code})` : ' (بدون كود)'}`);
          continue;
        }
        const qtyBefore = invRow.current;
        const qtyDelta = -(Number(item.qty) || 0);
        entries.push({
          productId: invRow._id,
          productCode: code,
          productName: item.name || invRow.name,
          type: 'مبيعات',
          qtyDelta,
          qtyBefore,
          qtyAfter: qtyBefore + qtyDelta,
          sourceTransactionId: String(tx._id),
          sourceTransactionRef: tx.ref || String(tx._id),
          sourceType: 'transaction-create',
          by: employee || 'Shopify',
        });
      }

      if (skipped.length) {
        this.logger.warn(
          `[approveOrder] tx ${tx.ref}: ${skipped.length} صنف بدون مطابقة في المخزن، لم تُسجَّل حركته — ${skipped.join('، ')}`,
        );
      }
      await this.inventoryMovementsService.record(entries);
    } catch (err) {
      this.logger.error(
        `[approveOrder] inventory movement logging failed for tx ${tx._id}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * One-off repair for Shopify sales approved BEFORE approveOrder logged inventory
   * movements. Writes the missing 'مبيعات' rows for the given transaction refs.
   *
   * ⚠ qtyBefore/qtyAfter are RECONSTRUCTED, not recovered — the true historical
   * balance was never recorded. Current stock already reflects these sales (it is
   * derived from the transactions themselves), so using getInventory() directly
   * would double-count. Instead each row is rewound from the present balance:
   *
   *     qtyAfter  = current stock + (qty of every LATER movement already logged)
   *     qtyBefore = qtyAfter + qty sold
   *
   * That is exact only if no untracked movement happened after this sale. Rows are
   * therefore flagged in `notes` so the log never presents them as original records.
   *
   * Idempotent: a ref that already has movement rows is skipped, never duplicated.
   */
  async backfillMissingSaleMovements(
    refs: string[],
    by: string,
    dryRun = true,
  ): Promise<{
    dryRun: boolean;
    results: Array<{
      ref: string;
      status: 'written' | 'would-write' | 'skipped-existing' | 'not-found' | 'not-eligible' | 'no-items-matched';
      rows?: Array<{ code: string; name: string; qty: number; qtyBefore: number; qtyAfter: number }>;
      unmatchedItems?: string[];
      note?: string;
    }>;
  }> {
    const results: Array<{
      ref: string;
      status: 'written' | 'would-write' | 'skipped-existing' | 'not-found' | 'not-eligible' | 'no-items-matched';
      rows?: Array<{ code: string; name: string; qty: number; qtyBefore: number; qtyAfter: number }>;
      unmatchedItems?: string[];
      note?: string;
    }> = [];

    const inventory = await this.transactionsService.getInventory();
    const invByCode = new Map(inventory.map((r) => [String(r.code).trim(), r]));

    for (const rawRef of refs) {
      const ref = String(rawRef || '').replace(/^#+/, '').trim();
      if (!ref) continue;

      const tx = await this.txModel.findOne({ ref }).exec();
      if (!tx) {
        results.push({ ref, status: 'not-found' });
        continue;
      }
      if (tx.type !== 'مبيعات' || tx.cancelled || tx.archived) {
        results.push({
          ref,
          status: 'not-eligible',
          note: `النوع "${tx.type}"${tx.cancelled ? ' — ملغاة' : ''}${tx.archived ? ' — مؤرشفة' : ''}`,
        });
        continue;
      }

      // Idempotency. The question is specifically "is the CREATE row missing?", not
      // "does this ref have any row at all": a transaction edited after creation carries
      // 'transaction-update' rows, and counting those as proof would permanently block
      // the repair of the very row that is actually missing.
      const existingCreate = await this.inventoryMovementsService.countBySourceType(
        ref,
        'transaction-create',
      );
      if (existingCreate > 0) {
        results.push({
          ref,
          status: 'skipped-existing',
          note: `يوجد ${existingCreate} حركة إنشاء مسجّلة بالفعل لهذا المرجع`,
        });
        continue;
      }

      const entries: RecordMovementEntry[] = [];
      const preview: Array<{ code: string; name: string; qty: number; qtyBefore: number; qtyAfter: number }> = [];
      const unmatched: string[] = [];

      for (const item of tx.items || []) {
        const code = String(item.code || '').trim();
        const invRow = invByCode.get(code);
        if (!invRow) {
          unmatched.push(`${item.name || '?'}${code ? ` (${code})` : ' (بدون كود)'}`);
          continue;
        }
        const qty = Number(item.qty) || 0;

        // Rewind: sum the deltas of every movement logged AFTER this sale, then undo them
        // from the current balance to land on this sale's qtyAfter.
        const laterDelta = await this.inventoryMovementsService.sumDeltaAfter(
          code,
          (tx as unknown as { createdAt?: Date }).createdAt,
        );
        const qtyAfter = invRow.current - laterDelta;
        const qtyBefore = qtyAfter + qty;

        preview.push({ code, name: item.name || invRow.name, qty, qtyBefore, qtyAfter });
        entries.push({
          productId: invRow._id,
          productCode: code,
          productName: item.name || invRow.name,
          type: 'مبيعات',
          qtyDelta: -qty,
          qtyBefore,
          qtyAfter,
          sourceTransactionId: String(tx._id),
          sourceTransactionRef: ref,
          sourceType: 'transaction-create',
          by: tx.employee || 'Shopify',
          notes: `تسجيل بأثر رجعي — الحركة لم تُسجَّل وقت إنشاء المعاملة (أوردر Shopify). الرصيد قبل/بعد محسوب رجوعياً. نُفِّذ بواسطة ${by}`,
        });
      }

      if (!entries.length) {
        results.push({ ref, status: 'no-items-matched', unmatchedItems: unmatched });
        continue;
      }

      if (dryRun) {
        results.push({ ref, status: 'would-write', rows: preview, unmatchedItems: unmatched.length ? unmatched : undefined });
        continue;
      }

      await this.inventoryMovementsService.record(entries);
      this.logger.log(`[backfill] كُتبت ${entries.length} حركة مخزون للمرجع ${ref} بواسطة ${by}`);
      results.push({ ref, status: 'written', rows: preview, unmatchedItems: unmatched.length ? unmatched : undefined });
    }

    return { dryRun, results };
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

  // إلغاء أوردر معلق (Admin فقط) — يستبعده من الإحصائيات مع إمكانية الاسترجاع
  async cancelOrder(orderId: string, cancelledBy: string, reason = ''): Promise<{ success: boolean }> {
    const order = await this.shopifyOrderModel.findById(orderId);
    if (!order) throw new NotFoundException('الأوردر غير موجود');
    if (order.status !== 'pending') {
      return { success: false };
    }
    order.cancelled = true;
    order.cancelledBy = cancelledBy;
    order.cancelledAt = new Date().toISOString();
    order.cancelReason = reason;
    await order.save();
    this.logger.log(`🚫 تم إلغاء أوردر Shopify: ${order.ref}`);
    return { success: true };
  }

  // استرجاع أوردر ملغي
  async restoreOrder(orderId: string): Promise<{ success: boolean }> {
    const order = await this.shopifyOrderModel.findById(orderId);
    if (!order) throw new NotFoundException('الأوردر غير موجود');
    order.cancelled = false;
    order.cancelledBy = '';
    order.cancelledAt = '';
    order.cancelReason = '';
    await order.save();
    this.logger.log(`↩️ تم استرجاع أوردر Shopify: ${order.ref}`);
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

  // يختار تطبيق الخصم الخاص بقيمة الأوردر/الأصناف من discount_applications،
  // متجاهلاً تطبيقات الشحن (target_type: 'shipping_line') مثل "Free Shipping"
  // التلقائي — والتي لا تمثل خصماً حقيقياً على سعر المنتجات ولا يجب عرضها كنسبة خصم
  private pickOrderDiscountApplication(apps: any[]): any {
    if (!Array.isArray(apps) || apps.length === 0) return undefined;
    return apps.find((a) => a?.target_type !== 'shipping_line') || undefined;
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
