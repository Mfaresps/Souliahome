import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { createHash, randomUUID } from 'crypto';
import { ReturnRequest } from '../returns/schemas/return-request.schema';
import { ReturnsValidationService } from '../returns/returns-validation.service';
import { TransactionsService } from '../transactions/transactions.service';
import { InventoryUnitsService } from '../inventory-units/inventory-units.service';
import { VaultService } from '../vault/vault.service';
import { BostaService } from '../bosta/bosta.service';
import { DatabaseWriteContext } from '../shared/database-write-context';
import { normalizeVaultAccountLabel } from '../returns/returns.constants';
import { DEFAULT_AFTER_SALES_POLICY, afterSalesQuote, money, requireOperation } from './after-sales.policy';
import { identityOperationKey } from '../inventory-units/failed-delivery-identities';
import { NotificationsService } from '../notifications/notifications.service';
import { projectAfterSalesShipment } from './after-sales-shipment';
import { returnLineCost } from '../shared/line-cost.util';
import { currentUnitCost } from '../shared/avg-cost.util';
import { linkComplaintCase, recordComplaintExecution } from '../complaints/complaint-workflow';
import { advanceRemaining, advanceView, bundledSaleCod, bundledSaleShipCharged, bundledShipmentCod, bundledTransactionIds, caseBundleBlock, pendingDepositRequests, phoneKey, saleBundleBlock } from '../shared/after-sales-bundle.util';

@Injectable()
export class AfterSalesService {
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel(ReturnRequest.name) private readonly cases: Model<any>,
    private readonly transactions: TransactionsService, private readonly validation: ReturnsValidationService,
    private readonly tracking: InventoryUnitsService, private readonly vault: VaultService, private readonly bosta: BostaService,
    @Optional() private readonly notifications?: NotificationsService) {}
  private async nextReference(kind: 'AS' | 'RT' | 'SALE', ctx: DatabaseWriteContext) {
    const year = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric' });
    for (;;) {
      const result: any = await this.connection.collection('aftersalescounters').findOneAndUpdate(
        { _id: `${year}:${kind}` as any }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: 'after', session: ctx.session });
      const counter = result?.value || result;
      const suffix = String(counter.sequence).padStart(6, '0');
      const ref = kind === 'SALE' ? `${year}8${suffix}` : `${kind}-${year}-${suffix}`;
      const used = kind === 'AS' ? await this.cases.exists({ 'workflow.ref': ref }).session(ctx.session)
        : await this.connection.collection('transactions').findOne({ ref }, { session: ctx.session, projection: { _id: 1 } });
      if (!used) return ref;
    }
  }
  private async publishEvent(row: any, action: string, by: string, key: string, ctx: DatabaseWriteContext) {
    await projectAfterSalesShipment(this.connection, row, ctx.session);
    const w = row.workflow, last = w.history[w.history.length - 1];
    const event = { ...last, action, by, eventId: `${row._id}:${key}`, caseId: String(row._id), caseRef: w.ref,
      stage: w.stage, kind: row.requestKind, originalRef: row.originalRef, replacementRef: w.replacementRef || '', returnRef: row.returnTxRef || '',
      settlement: action.startsWith('settlement:') ? (action === 'settlement:refund' ? w.refund : action === 'settlement:collection' ? w.collection : w.carrierSettlement) : undefined };
    await recordComplaintExecution(this.connection, row, event, ctx.session);
    const ids = [...new Set([row.originalTransactionId, w.replacementTxId, row.returnTxId, ...bundledTransactionIds(row)].filter(Boolean).map(String))].map(id => this.id(id));
    await this.connection.collection('transactions').updateMany({ _id: { $in: ids }, 'afterSalesEvents.eventId': { $ne: event.eventId } },
      { $push: { afterSalesEvents: event } } as any, { session: ctx.session });
    ctx.afterCommit.push(() => { for (const id of ids) this.transactions.notifyAfterSalesTransactionChanged(String(id)); });
    if (this.notifications) ctx.afterCommit.push(() => this.notifications!.enqueue(
      action === 'requested' || action.startsWith('settlement:') ? 'approval' : 'order', `after-sales:${event.eventId}`, w.ref,
      `after-sales:${row._id}`, undefined, undefined, { afterSalesAction: action, actorName: by }));
  }
  private id(value: string) { if (!/^[a-f\d]{24}$/i.test(value || '')) throw new BadRequestException('رقم السجل غير صالح'); return new Types.ObjectId(value); }
  private permit(actor: any, permission: string) {
    if (!actor?.userId || actor.role !== 'admin' && !actor.perms?.includes(permission)) throw new ForbiddenException('الصلاحية المطلوبة: ' + permission);
  }
  async policy(session?: any) {
    const settings = await this.connection.collection('settings').findOne({}, { session, projection: { afterSalesPolicy: 1 } });
    return { ...DEFAULT_AFTER_SALES_POLICY, ...settings?.afterSalesPolicy };
  }
  shippingCities() { return this.bosta.afterSalesCities(); }
  shippingDistricts(cityId: string) { return this.bosta.afterSalesDistricts(cityId); }
  async savePolicy(body: any, actor: any) {
    if (actor.role !== 'admin') throw new ForbiddenException();
    const current = await this.policy(), next: any = { ...current };
    for (const key of ['normalDays', 'defectDays', 'exchangeFee', 'returnFee']) {
      const value = Number(body[key]);
      if (!Number.isFinite(value) || value < 0 || value > 30000 || key.endsWith('Days') && !Number.isInteger(value)) throw new BadRequestException('إعدادات السياسة غير صالحة');
      next[key] = value;
    }
    if (next.normalDays < 14 || next.defectDays < 30) throw new BadRequestException('الحد الأدنى للمهلة 14 يومًا و30 يومًا للعيوب');
    next.customerFeesEnabled = body.customerFeesEnabled === true;
    next.feePolicyNote = String(body.feePolicyNote || '').trim().slice(0, 1000);
    next.businessLocationId = String(body.businessLocationId || '').trim().slice(0, 120);
    if (next.customerFeesEnabled && !next.feePolicyNote) throw new BadRequestException('حدد الحالات المسموح فيها برسوم العميل في السياسة');
    next.version = current.version + 1; next.updatedAt = new Date().toISOString(); next.updatedBy = actor.name || actor.username;
    await this.connection.collection('settings').updateOne({}, { $set: { afterSalesPolicy: next } });
    return next;
  }
  async list(invoiceId?: string, q?: string) {
    const filter: any = { 'workflow.version': 2 };
    if (invoiceId) filter.$or = [{ originalTransactionId: String(this.id(invoiceId)) }, { 'workflow.replacementTxId': invoiceId }];
    if (q?.trim()) {
      const rx = new RegExp(q.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = [{ $or: ['client', 'phone', 'originalRef', 'returnTxRef', 'workflow.replacementRef', 'workflow.ref', 'workflow.shipment.trackingNumber'].map(key => ({ [key]: rx })) }];
    }
    return this.cases.find(filter).sort({ createdAt: -1 }).limit(250).lean();
  }
  async get(id: string) {
    const row: any = await this.cases.findOne({ _id: this.id(id), 'workflow.version': 2 }).lean();
    if (!row) throw new NotFoundException('طلب خدمة ما بعد البيع غير موجود');
    return this.describe(row);
  }
  /** Enrich the committed response without fetching the same case again. */
  async describe(row: any) {
    // Fetch both invoices in one round trip, without their items, carrier payloads
    // or event histories. Reuse this fresh replacement state for rollback checks.
    const invoiceIds = [row.originalTransactionId, row.workflow.replacementTxId].filter(Boolean).map(value => this.id(String(value)));
    const invoices = await this.connection.collection('transactions').find({ _id: { $in: invoiceIds } }, { projection: {
      shippingAddress: 1, shippingBostaCity: 1, shippingGov: 1, phone: 1, client: 1,
      ...this.rollbackReplacementProjection,
    } }).toArray();
    const originalAddress = invoices.find(tx => String(tx._id) === String(row.originalTransactionId));
    const replacement = invoices.find(tx => String(tx._id) === String(row.workflow.replacementTxId)) || null;
    row.addressHint = { firstLine: originalAddress?.shippingAddress || '', city: originalAddress?.shippingBostaCity || originalAddress?.shippingGov || '', phone: originalAddress?.phone || row.phone || '', customerName: originalAddress?.client || row.client || '' };
    if (row.workflow.replacementTxId) {
      row.workflow.replacementPickupStatus = replacement?.pickupStatus || 'Pending';
      row.workflow.replacementPrepared = replacement?.prepChecked === true;
      row.advance = advanceView(row.workflow.quote?.collectDue, replacement);
    }
    if (originalAddress && row.requestKind === 'exchange') {
      const originalRemaining = Math.max(0, Number(originalAddress.remaining) || 0);
      const exchangeRemaining = money(Math.max(0, Number(row.workflow.quote?.collectDue || 0) - Number(row.advance?.paid || 0) - Number(row.workflow.collection?.amount || 0)));
      row.accounting = { originalTotal: Number(originalAddress.total) || 0, originalPaid: Number(originalAddress.deposit) || 0,
        originalRemaining, exchangeDifference: Number(row.workflow.quote?.collectDue) || 0,
        exchangePaid: money(Number(row.advance?.paid || 0) + Number(row.workflow.collection?.amount || 0)), exchangeRemaining,
        combinedRemaining: money(originalRemaining + exchangeRemaining) };
    }
    row.rollback = await this.rollbackOption(row, undefined, replacement);
    if ((row.workflow.bundledSales || []).length) {
      row.bundleView = await this.bundledView(row);
      row.bundleCod = row.workflow.shipment?.cod ?? bundledShipmentCod(row.advance ? row.advance.left : row.workflow.quote?.collectDue, row.bundleView);
    }
    row.bundleBlock = caseBundleBlock(row);
    return row;
  }
  private readonly bundleProjection = { ref: 1, client: 1, phone: 1, date: 1, total: 1, itemsTotal: 1, discount: 1, deposit: 1, remaining: 1,
    shipCost: 1, shippingDiscount: 1, payStatus: 1, prepChecked: 1, pickupStatus: 1, cancelled: 1, archived: 1, warehouseCode: 1, type: 1,
    depositRequests: 1, afterSalesBundle: 1, afterSales: 1, bostaOrderId: 1, bostaTrackingNumber: 1, shippedAt: 1, deliveredAt: 1,
    carrierSettlement: 1, shopifyOrderId: 1, createdAt: 1,
    'items.code': 1, 'items.name': 1, 'items.qty': 1, 'items.price': 1, 'items.total': 1, 'items.imageUrl': 1 };
  /** The live state of each bundled sale: the case stores only the link, the money stays on the sale. */
  private async bundledView(row: any, session?: any) {
    const ids = (row.workflow.bundledSales || []).map((b: any) => this.id(String(b.transactionId)));
    const rows = await this.connection.collection('transactions').find({ _id: { $in: ids } }, { session, projection: this.bundleProjection }).toArray();
    const byId = new Map(rows.map(tx => [String(tx._id), tx]));
    return (row.workflow.bundledSales || []).map((b: any) => {
      const tx: any = byId.get(String(b.transactionId));
      const shipped = (row.workflow.shipment?.bundled || []).find((s: any) => String(s.transactionId) === String(b.transactionId));
      return { transactionId: String(b.transactionId), ref: tx?.ref || b.ref, client: tx?.client || '', date: tx?.date || '',
        total: Number(tx?.total || 0), discount: Number(tx?.discount || 0), deposit: Number(tx?.deposit || 0), remaining: Number(tx?.remaining || 0),
        cod: shipped ? shipped.cod : bundledSaleCod(tx), prepared: tx?.prepChecked === true, pickupStatus: tx?.pickupStatus || 'Pending',
        pendingDeposits: pendingDepositRequests(tx), cancelled: !tx || !!tx.cancelled, linked: tx?.afterSalesBundle?.caseId === String(row._id),
        collected: !!tx?.afterSalesBundle?.collection, items: (tx?.items || []).map((i: any) => ({ code: i.code, name: i.name, qty: i.qty, total: i.total, imageUrl: i.imageUrl || '' })),
        at: b.at, by: b.by };
    });
  }
  /** Unshipped sales of the same customer that may ride the exchange waybill. */
  async bundleCandidates(id: string) {
    const row: any = await this.cases.findOne({ _id: this.id(id), 'workflow.version': 2 }).lean();
    if (!row) throw new NotFoundException('طلب خدمة ما بعد البيع غير موجود');
    const key = phoneKey(row.phone), or: any[] = [];
    if (String(row.client || '').trim()) or.push({ client: String(row.client).trim() });
    if (key) or.push({ phone: { $regex: key.slice(-9) + '$' } });
    if (!or.length) return { blocked: caseBundleBlock(row), candidates: [] };
    const exclude = [row.originalTransactionId, row.workflow.replacementTxId, ...(row.workflow.bundledSales || []).map((b: any) => b.transactionId)]
      .filter(Boolean).map(value => this.id(String(value)));
    const rows = await this.connection.collection('transactions').find({ type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true },
      _id: { $nin: exclude }, $or: or, bostaOrderId: { $in: [null, ''] }, deliveredAt: { $in: [null, ''] }, shippedAt: { $in: [null, ''] },
      pickupStatus: { $nin: ['Shipped', 'Delivered', 'Picked-Up'] } }, { projection: this.bundleProjection }).sort({ createdAt: -1 }).limit(30).toArray();
    return { blocked: caseBundleBlock(row), candidates: rows.map((tx: any) => ({ transactionId: String(tx._id), ref: tx.ref, client: tx.client, date: tx.date,
      total: Number(tx.total || 0), discount: Number(tx.discount || 0), deposit: Number(tx.deposit || 0), remaining: Number(tx.remaining || 0),
      prepared: tx.prepChecked === true, pickupStatus: tx.pickupStatus || 'Pending', pendingDeposits: pendingDepositRequests(tx),
      items: (tx.items || []).map((i: any) => ({ code: i.code, name: i.name, qty: i.qty, imageUrl: i.imageUrl || '' })),
      block: saleBundleBlock(tx, row) })) };
  }
  /** Ship a new sale of the same customer inside this exchange waybill. Its money stays on the sale. */
  bundle(id: string, body: any, actor: any) {
    this.permit(actor, 'shopify-prepare-ship');
    return this.mutate(id, 'sale-bundled', body, actor, async (row, ctx, by) => {
      const caseBlock = caseBundleBlock(row);
      if (caseBlock) throw new ConflictException(caseBlock);
      const txId = String(this.id(String(body.transactionId || '')));
      const transactions = this.connection.collection('transactions');
      const tx: any = await transactions.findOne({ _id: this.id(txId) }, { session: ctx.session });
      const block = saleBundleBlock(tx, row);
      if (block) throw new ConflictException(block);
      const at = new Date().toISOString();
      const result = await transactions.updateOne({ _id: this.id(txId), cancelled: { $ne: true }, 'afterSalesBundle.caseId': { $exists: false },
        bostaOrderId: { $in: [null, ''] }, shippedAt: { $in: [null, ''] }, deliveredAt: { $in: [null, ''] } },
        { $set: { afterSalesBundle: { caseId: String(row._id), caseRef: row.workflow.ref, originalRef: row.originalRef, at, by } }, $inc: { unitTrackingRevision: 1 } },
        { session: ctx.session });
      if (!result.modifiedCount) throw new ConflictException('تغيّر الطلب الآن؛ حدّث الصفحة وأعد المحاولة');
      row.workflow.bundledSales = [...(row.workflow.bundledSales || []), { transactionId: txId, ref: tx.ref, at, by }];
      body.note = String(body.note || '').trim() || `#${tx.ref}`;
      ctx.afterCommit.push(() => this.transactions.notifyAfterSalesTransactionChanged(txId));
    });
  }
  unbundle(id: string, body: any, actor: any) {
    this.permit(actor, 'shopify-prepare-ship');
    return this.mutate(id, 'sale-unbundled', body, actor, async (row, ctx) => {
      if (row.workflow.shipment) throw new ConflictException('أُنشئت شحنة الاستبدال؛ لا يمكن فصل طلب منها');
      const txId = String(this.id(String(body.transactionId || '')));
      const entry = (row.workflow.bundledSales || []).find((b: any) => String(b.transactionId) === txId);
      if (!entry) throw new NotFoundException('الطلب غير مضموم لهذه الشحنة');
      await this.releaseBundled(row, [txId], ctx);
      body.note = String(body.note || '').trim() || `#${entry.ref}`;
    });
  }
  /** Detach bundled sales: each goes back to being an ordinary order that ships on its own. */
  private async releaseBundled(row: any, ids: string[], ctx: DatabaseWriteContext) {
    if (!ids.length) return;
    await this.connection.collection('transactions').updateMany({ _id: { $in: ids.map(value => this.id(value)) }, 'afterSalesBundle.caseId': String(row._id) },
      { $unset: { afterSalesBundle: 1 }, $inc: { unitTrackingRevision: 1 } }, { session: ctx.session });
    row.workflow.bundledSales = (row.workflow.bundledSales || []).filter((b: any) => !ids.includes(String(b.transactionId)));
    for (const value of ids) ctx.afterCommit.push(() => this.transactions.notifyAfterSalesTransactionChanged(value));
  }
  private readonly rollbackReplacementProjection = {
    pickupStatus: 1, prepChecked: 1, cancelled: 1, archived: 1, ref: 1, total: 1, deposit: 1, remaining: 1, deposits: 1, depositRequests: 1,
    'afterSales.caseId': 1, 'afterSales.role': 1, 'afterSales.shipmentPending': 1, 'afterSales.collection': 1,
    bostaOrderId: 1, shippedAt: 1, deliveredAt: 1, bostaStatus: 1, unitTrackingRevision: 1,
  };
  private async rollbackOption(row: any, session?: any, loadedReplacement?: any) {
    const w = row.workflow;
    const blocked = (reason: string) => ({ available: false as const, reason });
    if (['closed', 'cancelled'].includes(w.stage)) return blocked('الطلب مغلق؛ لا توجد خطوة تنفيذ مفتوحة للتراجع');
    if (w.refund || w.collection || w.carrierSettlement) return blocked('يوجد دفع أو تحصيل فعلي؛ يجب عكس التسوية المالية بإجراء مستقل أولًا');
    if (w.receivedAt || w.replacementDeliveredAt || row.returnTxId) return blocked('يوجد استلام أو تسليم فعلي؛ راجع حركة المخزون قبل التراجع');
    if (w.shipment) return blocked('يوجد طلب شحن؛ يلزم إلغاء البوليصة أو مطابقتها مع بوسطة أولًا');
    let replacement: any = null, pieces: any[] = [];
    if (w.replacementTxId) {
      // Mutations omit loadedReplacement and re-read inside their transaction.
      replacement = loadedReplacement !== undefined ? loadedReplacement : await this.connection.collection('transactions').findOne(
        { _id: this.id(w.replacementTxId) }, { session, projection: this.rollbackReplacementProjection });
      if (!replacement || replacement.cancelled || replacement.archived || replacement.afterSales?.caseId !== String(row._id) || replacement.afterSales?.role !== 'replacement') return blocked('فاتورة البديل غير فعالة أو غير مرتبطة بهذا الطلب');
      if (replacement.afterSales.shipmentPending || replacement.bostaOrderId || replacement.shippedAt || replacement.deliveredAt ||
        ['Shipped', 'Delivered'].includes(replacement.pickupStatus) || (replacement.bostaStatus && !['CREATED', 'VALIDATION_ERROR'].includes(replacement.bostaStatus))) return blocked('البديل دخل الشحن؛ راجع البوليصة قبل التراجع');
      pieces = await this.connection.collection('inventoryunits').find({ 'assignment.transactionId': w.replacementTxId }, { session, projection: { status: 1, __v: 1 } }).sort({ _id: 1 }).toArray();
      if (pieces.some(unit => !['reserved', 'picking', 'prepared'].includes(unit.status))) return blocked('حالة إحدى قطع البديل تتطلب مراجعة المخزون قبل التراجع');
    }
    const step = !w.approvedAt ? 'request' : replacement && (pieces.length || replacement.prepChecked || ['Preparing', 'Ready', 'Picked-Up'].includes(replacement.pickupStatus)) ? 'preparation' : 'approval';
    const token = createHash('sha256').update(JSON.stringify({ step, history: w.history, replacementId: w.replacementTxId,
      status: replacement?.pickupStatus, checked: replacement?.prepChecked, revision: replacement?.unitTrackingRevision, pieces })).digest('hex');
    return { available: true as const, step, token, reason: step === 'request' ? 'التراجع عن تسجيل الطلب سيُلغي الطلب الحالي ويتيح تقديم طلب جديد.' :
      step === 'preparation' ? 'سيعود البديل إلى انتظار التجهيز وتُلغى اختيارات القطع وتجهيزها، مع الاحتفاظ بالاعتماد.' :
        'سيعود الطلب إلى انتظار الاعتماد. تُلغى فاتورة البديل الحالية ويُعاد رصيدها، مع الاحتفاظ بالسجل.' };
  }
  rollback(id: string, body: any, actor: any) {
    if (actor?.role !== 'admin') throw new ForbiddenException('التراجع عن خطوات الطلب متاح للمسؤول فقط');
    if (!String(body.note || '').trim() || body.confirmed !== true) throw new BadRequestException('حدد سبب التراجع وأكد الخطوة المطلوبة');
    return this.mutate(id, 'step-rolled-back', body, actor, async (row, ctx, by) => {
      const option = await this.rollbackOption(row, ctx.session);
      if (!option.available) throw new ConflictException(option.reason);
      if (option.token !== body.expectedToken || option.step !== body.step) throw new ConflictException('تغيرت خطوات الطلب؛ حدّث الملف قبل التراجع');
      const w = row.workflow, replacementId = w.replacementTxId;
      if (option.step === 'request') {
        await this.releaseBundled(row, (w.bundledSales || []).map((b: any) => String(b.transactionId)), ctx);
        row.status = 'مرفوض'; w.stage = 'cancelled'; w.cancelledAt = new Date().toISOString(); w.cancelledBy = by;
      } else if (option.step === 'preparation') {
        await this.transactions.undoAfterSalesPreparation(replacementId, String(row._id), by, actor.userId, ctx);
        w.replacementPrepared = false; w.replacementPickupStatus = 'Pending';
      } else {
        if (replacementId) {
          await this.transactions.cancelAfterSalesReplacement(replacementId, String(row._id), body.note, by, ctx);
          w.revertedReplacements = [...(w.revertedReplacements || []), { transactionId: replacementId, ref: w.replacementRef, by, at: new Date().toISOString() }];
          delete w.replacementTxId; delete w.replacementRef; delete w.replacementPrepared; delete w.replacementPickupStatus;
        }
        delete w.approvedAt; delete w.approvedBy; w.stage = 'requested'; row.status = 'معلق';
      }
      w.lastRollback = { step: option.step, by, note: body.note, at: new Date().toISOString() };
      if (replacementId) ctx.afterCommit.push(() => this.transactions.notifyUnitIdentitiesChanged(replacementId));
    });
  }
  async invoice(id: string) {
    const tx = await this.transactions.findById(String(this.id(id)));
    if (tx.type !== 'مبيعات' || tx.cancelled) throw new BadRequestException('يلزم فاتورة مبيعات فعالة');
    const [identities, cases, policy, products, prior, inventory] = await Promise.all([
      this.tracking.invoiceIdentities(id), this.list(id), this.policy(),
      this.connection.collection('products').find({ archived: { $ne: true } }, { projection: { code: 1, name: 1, sellPrice: 1, imageUrl: 1, images: 1, isActive: 1 } }).limit(3000).toArray(),
      this.cases.find({ originalTransactionId: id, status: { $in: ['معلق', 'معتمد'] }, reversedAt: null }).lean(),
      this.transactions.getInventory(),
    ]);
    const inventoryByCode = new Map(inventory.map(item => [item.code, item]));
    return { invoice: tx, identities, cases, policy, products: products.map(p => ({ ...p, imageUrl: p.imageUrl || p.images?.[0] || '',
      available: Number(inventoryByCode.get(p.code)?.warehouseBalances?.[tx.warehouseCode || 'MAIN'] || 0) })), prior };
  }
  async quote(body: any, session?: any) {
    if (body.fulfillmentChannel && !['bosta','direct'].includes(body.fulfillmentChannel)) throw new BadRequestException('طريقة التنفيذ غير صالحة');
    const original: any = await this.connection.collection('transactions').findOne({ _id: this.id(body.originalTransactionId), type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true } }, { session });
    if (!original || !(original.deliveredAt || original.bostaStatus === 'DELIVERED' || original.pickupStatus === 'Delivered')) throw new BadRequestException('الطلب يجب أن يكون مسلّمًا للعميل؛ فشل التوصيل له مسار مستقل');
    if (original.afterSales?.caseId && !await this.cases.exists({ _id: this.id(original.afterSales.caseId), 'workflow.stage': 'closed' }).session(session || null)) throw new ConflictException('أكمل تسوية الاستبدال السابق قبل فتح طلب جديد على البديل');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) throw new BadRequestException('اختر القطع المطلوبة');
    const prior: any[] = await this.cases.find({ originalTransactionId: String(original._id), status: { $in: ['معلق', 'معتمد'] }, reversedAt: null })
      .select('items total requestKind workflow.selectedUnits workflow.ref').session(session || null).lean();
    const policy = await this.policy(session), seen = new Set<number>();
    if (body.kind === 'exchange' && (!Array.isArray(body.exchangeItems) || !body.exchangeItems.length || body.exchangeItems.length > 100)) throw new BadRequestException('اختر المنتج البديل');
    // A quote used to issue two reads per returned line and another per replacement.
    // Read only the selected catalog rows and assigned identities, once per quote.
    // Keep reads sequential when a MongoDB transaction session is supplied.
    const codes = [...new Set(body.items.map((selected: any) => original.items?.[Number(selected.lineIndex)]?.code).filter(Boolean))];
    const replacementIds = body.kind === 'exchange' ? body.exchangeItems.map((selected: any) => this.id(selected.productId)) : [];
    const catalog = await this.connection.collection('products').find({ $or: [{ code: { $in: codes } }, { _id: { $in: replacementIds }, archived: { $ne: true } }] },
      { session, projection: { code: 1, name: 1, imageUrl: 1, images: 1, sellPrice: 1, buyPrice: 1, avgCost: 1, isActive: 1, archived: 1 } }).toArray();
    const byCode = new Map(catalog.map(product => [product.code, product]));
    const costAt = new Date().toISOString();
    const byId = new Map(catalog.map(product => [String(product._id), product]));
    const assignedUnits = await this.connection.collection('inventoryunits').find({ productId: { $in: catalog.filter(product => codes.includes(product.code)).map(product => String(product._id)) },
      'assignment.transactionId': String(original._id) }, { session, projection: { productId: 1, 'assignment.lineId': 1, packId: 1 } }).toArray();
    const gross = (original.items || []).reduce((n: number, line: any) => n + Number(line.total || 0), 0);
    const ratio = gross > 0 ? Math.max(0, 1 - Math.min(gross, Number(original.discount || 0)) / gross) : 1;
    const items: any[] = [];
    for (const selected of body.items) {
      const index = Number(selected.lineIndex), qty = Number(selected.qty), line = original.items?.[index];
      if (!Number.isInteger(index) || seen.has(index) || !line || !Number.isSafeInteger(qty) || qty < 1 || qty > line.qty) throw new BadRequestException('القطعة أو الكمية غير صالحة');
      seen.add(index);
      const used = prior.flatMap(r => r.items || []).filter(i => i.lineIndex === index || i.lineIndex == null && i.code === line.code).reduce((n, i) => n + Number(i.qty), 0);
      if (qty + used > Number(line.qty)) {
        const open = prior.find(r => (r.items || []).some((i: any) => i.lineIndex === index || i.lineIndex == null && i.code === line.code));
        if (open) throw new ConflictException(`يوجد بالفعل طلب ${open.requestKind === 'exchange' ? 'استبدال' : 'استرجاع'} مفتوح على هذه القطعة${open.workflow?.ref ? ' (' + open.workflow.ref + ')' : ''}. افتح الطلب الحالي وأكمله، أو ألغِه أولًا ثم أنشئ طلبًا جديدًا.`);
        throw new ConflictException('الكمية المطلوبة تتجاوز المتبقي في بند الفاتورة');
      }
      const unitIds: string[] = Array.isArray(selected.unitIds) ? selected.unitIds.map((id: string) => String(this.id(id))) : [];
      if (new Set(unitIds).size !== unitIds.length || unitIds.length > qty) throw new BadRequestException('هويات القطع مكررة أو تتجاوز الكمية');
      const product = byCode.get(line.code);
      const assigned = product ? assignedUnits.filter(unit => unit.productId === String(product._id) && (!line.lineId || unit.assignment?.lineId === line.lineId)) : [];
      if (assigned.length && unitIds.length !== Math.min(qty, assigned.length)) throw new BadRequestException('حدد هويات القطع المرتبطة بالفاتورة قبل المتابعة');
      if (unitIds.some(id => !assigned.some(u => String(u._id) === id)) || prior.some(r => r.workflow?.selectedUnits?.some((id: string) => unitIds.includes(id)))) throw new ConflictException('هوية غير مرتبطة بالفاتورة أو لها طلب سابق');
      if (assigned.some(u => unitIds.includes(String(u._id)) && u.packId)) throw new ConflictException('افتح الباك في إدارة المخازن قبل استلام قطعه منفردة');
      items.push({ lineIndex: index, lineId: line.lineId, productId: product ? String(product._id) : '', code: line.code, name: line.name || product?.name || line.code, imageUrl: line.imageUrl || product?.imageUrl || product?.images?.[0] || '',
        qty, price: money(Number(line.total || line.price * line.qty) / line.qty * ratio), total: money(Number(line.total || line.price * line.qty) / line.qty * qty * ratio), unitIds, condition: 'سليم',
        // تكلفة سطر البيع الأصلي (shared/line-cost.util.ts) — بتعدّي مع `...line` لحد الاستلام والتالف.
        ...returnLineCost(line, product ? currentUnitCost(product as any) : null, costAt) });
    }
    this.validation.assertQtyWithinRemaining(original, items, prior);
    const credit = money(items.reduce((n, item) => n + item.total, 0));
    // Customer payment held by the courier is a receivable, not cash in our vault.
    const carrierHeld = original.deliverySource === 'BOSTA' && original.codCollectionStatus === 'CODWaitingCollection' ? Math.min(Number(original.remaining || 0), Number(original.bostaOriginalCod || 0)) : 0;
    const paid = Number(original.total || 0) - Number(original.remaining || 0) + carrierHeld;
    if (credit > money(paid - prior.reduce((n, r) => n + Number(r.total || 0), 0) - Number(original.afterSales?.complaintRefunded || 0)) + .01) throw new BadRequestException('قيمة المرتجع تتجاوز الرصيد المتبقي بعد المبالغ المدفوعة والمرتجعات السابقة');
    const exchangeItems: any[] = [];
    if (body.kind === 'exchange') {
      if (!Array.isArray(body.exchangeItems) || !body.exchangeItems.length || body.exchangeItems.length > 100) throw new BadRequestException('اختر المنتج البديل');
      for (const selected of body.exchangeItems) {
        const product: any = byId.get(String(this.id(selected.productId)));
        const qty = Number(selected.qty);
        if (!product || product.archived === true || product.isActive === false || !Number.isSafeInteger(qty) || qty < 1 || exchangeItems.some(i => i.productId === String(product._id))) throw new BadRequestException('البديل أو الكمية غير صالح');
        // A like-for-like exchange keeps the paid value, including the original discount.
        // Sum matching invoice lines so rounding or split lines cannot create a price difference.
        const same = items.filter(i => i.productId === String(product._id));
        const sameQuantity = same.reduce((n, i) => n + i.qty, 0) === qty;
        const total = sameQuantity ? money(same.reduce((n, i) => n + i.total, 0)) : money(Number(product.sellPrice) * qty);
        const price = sameQuantity ? money(total / qty) : Number(product.sellPrice);
        if (!Number.isFinite(price) || price < 0) throw new BadRequestException('سعر البديل غير مضبوط');
        exchangeItems.push({ productId: String(product._id), code: product.code, name: product.name, imageUrl: product.imageUrl || product.images?.[0] || '', qty, price, total, lineId: randomUUID() });
      }
    }
    const replacement = money(exchangeItems.reduce((n, row) => n + row.total, 0));
    if (body.kind === 'exchange' && body.reason !== 'customer-choice' && replacement > credit && body.upgradeAccepted !== true) throw new BadRequestException('البديل أغلى؛ يلزم موافقة العميل على فرق الترقية أو اختيار بديل بلا تكلفة');
    const defaultFee = body.fulfillmentChannel === 'direct' ? 0 : (body.kind === 'exchange' ? policy.exchangeFee : policy.returnFee);
    const fee = body.reason === 'customer-choice' && policy.customerFeesEnabled ? Number(body.customerFee ?? defaultFee) : 0;
    if (fee > 0 && !String(body.feeBasis || '').trim()) throw new BadRequestException('حدد سبب انطباق رسوم العميل وفق السياسة');
    const quote = afterSalesQuote(body.kind, body.reason, credit, replacement, fee);
    const deliveredAt = original.deliveredAt;
    const days = deliveredAt ? Math.max(0, Math.floor((Date.now() - new Date(deliveredAt).getTime()) / 86400000)) : null;
    const allowedDays = body.reason === 'customer-choice' ? policy.normalDays : policy.defectDays;
    return { original, items, exchangeItems, quote, policy, days, allowedDays, requiresReview: days === null || days > allowedDays };
  }
  private async atomic(work: (context: DatabaseWriteContext) => Promise<any>) {
    const session = await this.connection.startSession(); let result: any, effects: DatabaseWriteContext['afterCommit'] = [];
    try {
      await session.withTransaction(async () => { effects = []; result = await work({ session, afterCommit: effects }); }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      for (const effect of effects) { try { await effect(); } catch { /* Already committed; refresh will recover notifications. */ } }
      return result;
    } finally { await session.endSession(); }
  }
  private async actor(actor: any, context: DatabaseWriteContext) {
    const user = await this.connection.collection('users').findOne({ _id: this.id(actor.userId) }, { session: context.session });
    if (!user || user.active === false || user.isActive === false) throw new ForbiddenException('المستخدم غير نشط');
    return String(user.name || user.username || actor.userId);
  }
  private history(row: any, action: string, by: string, details: any = {}) {
    row.workflow.history.push({ action, by, at: new Date().toISOString(), ...details });
  }
  private async mutate(id: string, action: string, body: any, actor: any, work: (row: any, ctx: DatabaseWriteContext, by: string) => Promise<void>) {
    requireOperation(body);
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, body, actor: actor.userId })).digest('hex');
    return this.atomic(async context => {
      const row: any = await this.cases.findOne({ _id: this.id(id), 'workflow.version': 2 }).session(context.session);
      if (!row) throw new NotFoundException();
      const previous = row.workflow.operations.find((op: any) => op.key === body.operationKey);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new ConflictException('مفتاح العملية مستخدم لبيانات أخرى'); return row.toObject(); }
      const by = await this.actor(actor, context);
      if (row.workflow.stage === 'cancelled' || row.workflow.stage === 'closed') throw new ConflictException('الطلب مغلق؛ لا يمكن تكرار الأثر');
      await this.connection.collection('settings').updateOne({}, { $inc: { afterSalesRevision: 1 } }, { session: context.session });
      const original = await this.connection.collection('transactions').updateOne({ _id: this.id(row.originalTransactionId), cancelled: { $ne: true } }, { $inc: { unitTrackingRevision: 1 } }, { session: context.session });
      if (!original.matchedCount) throw new ConflictException('الفاتورة الأصلية غير فعالة');
      await work(row, context, by);
      this.history(row, action, by, { note: String(body.note || '').slice(0, 1000), ...(action === 'step-rolled-back' ? { step: body.step } : {}) });
      row.workflow.operations.push({ key: body.operationKey, fingerprint });
      this.closeIfComplete(row);
      row.markModified('workflow'); await row.save({ session: context.session });
      await this.publishEvent(row, action, by, fingerprint, context);
      context.afterCommit.push(() => this.transactions.notifyUnitIdentitiesChanged(row.originalTransactionId));
      context.afterCommit.push(() => this.transactions.notifyAfterSalesChanged?.(String(row._id), row.originalTransactionId));
      if (row.workflow.replacementTxId) context.afterCommit.push(() => this.transactions.notifyUnitIdentitiesChanged(row.workflow.replacementTxId));
      return row.toObject();
    });
  }
  private closeIfComplete(row: any) {
    const w = row.workflow;
    if (w.receivedAt && (row.requestKind === 'return' || w.replacementDeliveredAt) &&
      (!w.shipment || w.shipment.status === 'created') && (!w.quote.refundDue || w.refund) && (!w.quote.collectDue || w.collection) && (w.fulfillmentChannel === 'direct' || w.carrierSettlement) && !w.exception) w.stage = 'closed';
  }
  async create(body: any, actor: any) {
    this.permit(actor, 'transaction'); requireOperation(body);
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return this.atomic(async ctx => {
      const by = await this.actor(actor, ctx), originalId = String(this.id(body.originalTransactionId));
      await this.connection.collection('transactions').updateOne({ _id: this.id(originalId) }, [{ $set: {
        unitTrackingRevision: { $add: [{ $ifNull: ['$unitTrackingRevision', 0] }, 1] },
        afterSales: { $mergeObjects: [{ $ifNull: ['$afterSales', {}] }, { hasCases: true }] },
      } }], { session: ctx.session });
      const previous: any = await this.cases.findOne({ originalTransactionId: originalId, 'workflow.createKey': body.operationKey }).session(ctx.session);
      if (previous) { if (previous.workflow.createFingerprint !== fingerprint) throw new ConflictException('مفتاح الطلب مستخدم لبيانات أخرى'); return previous.toObject(); }
      const data = await this.quote(body, ctx.session), caseId = new Types.ObjectId();
      const row: any = new this.cases({ _id: caseId, originalTransactionId: originalId, originalRef: data.original.ref,
        originalDate: data.original.date, client: data.original.client, phone: data.original.phone || '', items: data.items, total: data.quote.credit,
        itemsTotal: data.quote.credit, requestKind: body.kind, exchangeItems: data.exchangeItems, exchangeTotal: data.quote.replacement,
        priceDifference: money(data.quote.collectDue - data.quote.refundDue), reason: body.reason, reasonDetails: String(body.note || '').slice(0, 1000),
        requestedBy: by, status: 'معلق', maxRefundable: data.quote.credit,
        workflow: { version: 2, ref: await this.nextReference('AS', ctx), createKey: body.operationKey, createFingerprint: fingerprint,
          stage: 'requested', fulfillmentChannel:body.fulfillmentChannel || 'bosta', quote: data.quote, policy: data.policy, requiresReview: data.requiresReview, days: data.days, allowedDays: data.allowedDays,
          selectedUnits: data.items.flatMap(i => i.unitIds), selectedLines: data.items, warehouseCode: data.original.warehouseCode || 'MAIN',
          feeBasis: String(body.feeBasis || '').slice(0, 1000), upgradeAccepted: body.upgradeAccepted === true,
          operations: [], history: [{ action: 'requested', at: new Date().toISOString(), by }] } });
      if (body.complaintId) {
        await linkComplaintCase(this.connection, body.complaintId, row, { ...actor, name: by }, body.expectedComplaintRevision, ctx.session);
        row.markModified('workflow');
      }
      await row.save({ session: ctx.session });
      await this.publishEvent(row, 'requested', by, fingerprint, ctx);
      ctx.afterCommit.push(() => this.transactions.notifyUnitIdentitiesChanged(originalId));
      ctx.afterCommit.push(() => this.transactions.notifyAfterSalesChanged?.(String(row._id), originalId));
      return row.toObject();
    });
  }
  approve(id: string, body: any, actor: any) {
    return this.mutate(id, 'approved', body, actor, async (row, ctx, by) => {
      if (row.workflow.stage !== 'requested') throw new ConflictException('تم اتخاذ قرار الطلب بالفعل');
      if (row.workflow.requiresReview && !String(body.note || '').trim()) throw new BadRequestException('حدد سبب قبول الطلب خارج المهلة أو بدون تاريخ استلام');
      if (row.requestKind === 'exchange') {
        const original: any = await this.connection.collection('transactions').findOne({ _id: this.id(row.originalTransactionId) }, { session: ctx.session });
        const q = row.workflow.quote, ref = await this.nextReference('SALE', ctx);
        const doc: any = { date: new Date().toISOString(), type: 'مبيعات', ref, client: row.client, phone: row.phone, items: row.exchangeItems,
          itemsTotal: q.replacement, total: money(q.replacement + q.customerFee), deposit: q.creditApplied, remaining: q.collectDue,
          payStatus: q.collectDue ? 'معلق' : 'مكتمل', shipCost: q.customerFee, discount: 0, payment: 'تسوية استبدال', employee: by,
          warehouseCode: row.workflow.warehouseCode, pickupStatus: 'Pending', prepChecked: false, shipCo: row.workflow.fulfillmentChannel === 'direct' ? 'استلام مباشر' : original.shipCo || 'Bosta',
          prepNote: `استبدال فاتورة #${row.originalRef}`, prepShipCo: row.workflow.fulfillmentChannel === 'direct' ? 'استلام مباشر' : 'Bosta',
          shippingAddress: original.shippingAddress, shippingCity: original.shippingCity, shippingGov: original.shippingGov, shippingBostaCity: original.shippingBostaCity,
          notes: `بديل مرتبط بطلب ${row.workflow.ref} وفاتورة #${row.originalRef}`,
          afterSales: { caseId: String(row._id), caseRef: row.workflow.ref, kind: row.requestKind, originalRef: row.originalRef, originalTransactionId: row.originalTransactionId, role: 'replacement', returnedQty: row.items.reduce((n: number, i: any) => n + Number(i.qty), 0), replacementQty: row.exchangeItems.reduce((n: number, i: any) => n + Number(i.qty), 0), creditApplied: q.creditApplied } };
        const replacement = await this.transactions.create(doc, 'admin', undefined, by, ctx, false, true);
        row.workflow.replacementTxId = String(replacement._id); row.workflow.replacementRef = replacement.ref;
      }
      row.workflow.stage = 'approved'; row.workflow.approvedBy = by; row.workflow.approvedAt = new Date().toISOString();
    });
  }
  cancel(id: string, body: any, actor: any) {
    return this.mutate(id, 'cancelled', body, actor, async (row, ctx, by) => {
      if (row.workflow.shipment || row.workflow.receivedAt) throw new ConflictException('الطلب دخل التنفيذ؛ راجع الشحنة والاستلام قبل إلغائه');
      if (!String(body.note || '').trim()) throw new BadRequestException('حدد سبب الإلغاء أو الرفض');
      if (row.workflow.replacementTxId) {
        const txId = row.workflow.replacementTxId;
        const units = await this.connection.collection('inventoryunits').find({ 'assignment.transactionId': txId }, { session: ctx.session }).toArray();
        if (units.length) throw new ConflictException('ألغ تحضير البديل وأعد القطع للمخزن أولًا');
        await this.transactions.cancelAfterSalesReplacement(txId, String(row._id), body.note, by, ctx);
      }
      await this.releaseBundled(row, (row.workflow.bundledSales || []).map((b: any) => String(b.transactionId)), ctx);
      row.status = 'مرفوض'; row.rejectedReason = body.note; row.workflow.stage = 'cancelled';
      const other = await this.cases.exists({ _id: { $ne: row._id }, originalTransactionId: row.originalTransactionId,
        'workflow.version': 2, 'workflow.stage': { $ne: 'cancelled' } }).session(ctx.session);
      if (!other) await this.connection.collection('transactions').updateOne({ _id: this.id(row.originalTransactionId) }, { $unset: { 'afterSales.hasCases': 1 } }, { session: ctx.session });
    });
  }
  async ship(id: string, body: any, actor: any) {
    this.permit(actor, 'shopify-prepare-ship');
    const reserved: any = await this.mutate(id, 'shipment-requested', body, actor, async (row, ctx) => {
      let exchangeDue = Number(row.workflow.quote?.collectDue || 0);
      if (row.workflow.fulfillmentChannel === 'direct') throw new ConflictException('طلب استلام وتسليم مباشر؛ لا يحتاج إنشاء بوليصة');
      if (!row.workflow.approvedAt || row.workflow.shipment || row.workflow.receivedAt && row.requestKind !== 'exchange') throw new ConflictException('الشحنة موجودة أو الطلب غير معتمد أو المرتجع مستلم بالفعل');
      if (row.requestKind === 'exchange') {
        const replacement: any = await this.connection.collection('transactions').findOne({ _id: this.id(row.workflow.replacementTxId), cancelled: { $ne: true } }, { session: ctx.session });
        if (!replacement?.prepChecked) throw new ConflictException('أكمل مسح وتجهيز البديل في شاشة التجهيز أولًا');
        const summary = await this.tracking.pickingSummary(row.workflow.replacementTxId);
        if (summary.lines.some((line: any) => line.units.length + line.skippedCount < line.qty || line.units.some((u: any) => u.status !== 'prepared'))) throw new ConflictException('هويات البديل غير مكتملة');
        if (summary.lines.some((line: any) => line.units.some((unit: any) => row.workflow.selectedUnits.includes(unit.unitId)))) throw new ConflictException('اختر قطعة بديلة بهوية مختلفة عن القطعة الراجعة');
        // A deposit on the difference still waiting for a manager would change the COD after it is sent.
        if (pendingDepositRequests(replacement)) throw new ConflictException('عربون على فرق الاستبدال بانتظار موافقة المدير؛ اعتمده أو ارفضه قبل الشحن');
        exchangeDue = advanceRemaining(row.workflow.quote.collectDue, replacement);
      }
      // Sales bundled into this waybill: each must be prepared, and its remaining final (no deposit
      // still waiting for a manager), because that remaining is what Bosta will collect for it.
      const bundled: any[] = [], transactions = this.connection.collection('transactions');
      // What Bosta collects for the exchange itself: the difference minus any deposit already paid on it.
      for (const b of row.workflow.bundledSales || []) {
        const tx: any = await transactions.findOne({ _id: this.id(String(b.transactionId)) }, { session: ctx.session });
        const ref = tx?.ref || b.ref;
        if (!tx || tx.cancelled || tx.archived || tx.afterSalesBundle?.caseId !== String(row._id)) throw new ConflictException(`الطلب المضموم #${ref} لم يعد صالحًا؛ افصله من الشحنة`);
        if (tx.bostaOrderId || tx.shippedAt || tx.deliveredAt) throw new ConflictException(`الطلب المضموم #${ref} خرج للشحن بالفعل؛ افصله من الشحنة`);
        if (pendingDepositRequests(tx)) throw new ConflictException(`عربون الطلب المضموم #${ref} بانتظار موافقة المدير؛ اعتمده أو ارفضه قبل الشحن`);
        if (!tx.prepChecked) throw new ConflictException(`أكمل تجهيز الطلب المضموم #${ref} قبل الشحن`);
        const bundledSummary = await this.tracking.pickingSummary(String(tx._id));
        if (bundledSummary.lines.some((line: any) => line.units.length + line.skippedCount < line.qty || line.units.some((u: any) => u.status !== 'prepared'))) throw new ConflictException(`هويات الطلب المضموم #${ref} غير مكتملة`);
        bundled.push({ transactionId: String(tx._id), ref: tx.ref, cod: bundledSaleCod(tx), total: Number(tx.total || 0), shipCharged: bundledSaleShipCharged(tx) });
      }
      row.workflow.shipment = { status: 'creating', businessReference: row.workflow.ref, requestedAt: new Date().toISOString() };
      if (row.requestKind === 'exchange') {
        row.workflow.shipment.exchangeCod = exchangeDue;
        row.workflow.shipment.cod = bundledShipmentCod(exchangeDue, bundled);
      }
      if (bundled.length) {
        row.workflow.shipment.bundled = bundled;
        await transactions.updateMany({ _id: { $in: bundled.map(b => this.id(b.transactionId)) } },
          { $set: { 'afterSalesBundle.shipmentPending': true }, $inc: { unitTrackingRevision: 1 } }, { session: ctx.session });
      }
      row.workflow.customerDistrictName = String(body.customerDistrictName || '').trim().slice(0, 150);
      if (body.addressMode === 'original') delete row.workflow.customerAddress;
      if (body.addressMode === 'original') delete row.workflow.customerAddress;
      if (body.customerAddress) {
        const a = body.customerAddress;
        if (!/^[\w-]{3,100}$/.test(a.cityId || '') || !/^[\w-]{3,100}$/.test(a.districtId || '') || String(a.firstLine || '').trim().length < 6) throw new BadRequestException('اختر المحافظة والمنطقة وأدخل عنوان العميل بالتفصيل');
        row.workflow.customerAddress = { cityId: a.cityId, districtId: a.districtId, firstLine: String(a.firstLine).trim().slice(0, 500),
          ...(a.phone !== undefined ? { phone: String(a.phone).trim().slice(0, 40) } : {}),
          ...(a.customerName !== undefined ? { customerName: String(a.customerName).trim().slice(0, 150) } : {}) };
      }
      if (row.workflow.replacementTxId) await this.connection.collection('transactions').updateOne({ _id: this.id(row.workflow.replacementTxId) },
        { $set: { 'afterSales.shipmentPending': true }, $inc: { unitTrackingRevision: 1 } }, { session: ctx.session });
    });
    if (reserved.workflow.shipment?.status !== 'creating') return reserved;
    // Claim once outside the external call. Ambiguous requests must be reconciled, never blindly sent twice.
    const claim: any = await this.cases.findOneAndUpdate({ _id: this.id(id), 'workflow.shipment.status': 'creating', 'workflow.shipment.sent': { $ne: true } },
      { $set: { 'workflow.shipment.sent': true } }, { new: true }).lean();
    if (!claim) return this.get(id);
    try {
      const result = await this.bosta.createAfterSalesShipment(claim);
      await this.mutate(id, 'shipment-created', { operationKey: body.operationKey + ':created', ...result }, actor, async row => {
        if (row.workflow.shipment?.status !== 'creating') throw new ConflictException('راجع البوليصة المرتبطة بالطلب');
        Object.assign(row.workflow.shipment, { deliveryId: result.deliveryId, trackingNumber: result.trackingNumber, status: 'created' });
        row.workflow.stage = 'shipping'; row.returnShipCo = 'Bosta'; row.returnTrackingNumber = result.trackingNumber;
      });
    } catch (error: any) {
      if (error.beforeSend) {
        await this.cases.updateOne({ _id: this.id(id), 'workflow.shipment.status': 'creating' }, { $unset: { 'workflow.shipment': 1 } });
        if (claim.workflow.replacementTxId) await this.connection.collection('transactions').updateOne({ _id: this.id(claim.workflow.replacementTxId) }, { $unset: { 'afterSales.shipmentPending': 1 } });
        const bundledIds = (claim.workflow.shipment?.bundled || []).map((b: any) => this.id(String(b.transactionId)));
        if (bundledIds.length) await this.connection.collection('transactions').updateMany({ _id: { $in: bundledIds }, 'afterSalesBundle.caseId': String(claim._id) }, { $unset: { 'afterSalesBundle.shipmentPending': 1 } });
        throw new BadRequestException(error.message);
      }
      await this.cases.updateOne({ _id: this.id(id) }, { $set: { 'workflow.shipment.status': 'reconcile', 'workflow.shipment.error': error.message,
        'workflow.exception': 'تعذر تأكيد إنشاء الشحنة. راجع بوسطة واربط البوليصة الموجودة قبل إعادة المحاولة.' } });
      throw new ConflictException('تعذر تأكيد إنشاء الشحنة؛ افتح الطلب لمراجعة بوسطة وربط البوليصة دون تكرارها');
    }
    this.transactions.notifyAfterSalesChanged?.(id, claim.originalTransactionId);
    return this.get(id);
  }
  async sync(id: string) {
    const row: any = await this.get(id);
    if (!row.workflow.shipment?.deliveryId) throw new BadRequestException('لا توجد بوليصة مؤكدة');
    const detail = await this.bosta.fetchAfterSalesShipment(row.workflow.shipment.deliveryId);
    await this.bosta.applyAfterSalesUpdate(detail);
    return this.get(id);
  }
  async linkShipment(id: string, body: any, actor: any) {
    const detail = await this.bosta.fetchAfterSalesShipment(String(body.deliveryId || ''));
    const remote: any = detail.data || detail;
    const row: any = await this.get(id);
    if (String(remote.businessReference || '') !== row.workflow.ref) throw new ConflictException('مرجع بوليصة بوسطة لا يطابق هذا الطلب');
    if (String(remote._id || remote.id || '') !== String(body.deliveryId) || !remote.trackingNumber) throw new ConflictException('بيانات البوليصة غير مكتملة');
    if (remote.type != null && !(row.requestKind === 'exchange' ? ['30', 'EXCHANGE'] : ['25', 'CUSTOMER_RETURN_PICKUP']).includes(String(remote.type).toUpperCase())) throw new ConflictException('نوع بوليصة بوسطة لا يطابق الطلب');
    return this.mutate(id, 'shipment-linked', body, actor, async r => {
      if (!['creating', 'reconcile'].includes(r.workflow.shipment?.status)) throw new ConflictException('الطلب ليس بانتظار مطابقة الشحنة');
      r.workflow.shipment = { ...r.workflow.shipment, status: 'created', deliveryId: String(remote._id || remote.id), trackingNumber: String(remote.trackingNumber || '') };
      r.returnShipCo = 'Bosta'; r.returnTrackingNumber = r.workflow.shipment.trackingNumber; r.workflow.stage = 'shipping'; r.workflow.exception = null;
    });
  }
  receive(id: string, body: any, actor: any) {
    this.permit(actor, 'inventory-units-condition');
    return this.mutate(id, 'received-and-inspected', body, actor, async (row, ctx, by) => {
      const w = row.workflow;
      if (w.receivedAt || !w.approvedAt || body.physicalPossessionConfirmed !== true) throw new ConflictException('يلزم طلب معتمد وتأكيد استلام فعلي غير مكرر');
      if (!Array.isArray(body.items) || body.items.length !== w.selectedLines.length) throw new BadRequestException('راجع كل بنود المرتجع');
      const labels: any[] = Array.isArray(body.identities) ? body.identities : [];
      const items: any[] = [], seen = new Set<number>();
      for (const receipt of body.items) {
        const line = w.selectedLines.find((i: any) => i.lineIndex === receipt.lineIndex);
        if (!line || seen.has(receipt.lineIndex) || !['سليم', 'تالف', 'مفقود', 'mixed'].includes(receipt.condition)) throw new BadRequestException('حالة الاستلام غير صالحة');
        seen.add(receipt.lineIndex);
        // ⚠ A piece lost by the carrier on its way back is stored as «تالف» + lostInTransit: every
        //   stock / profit / credit reader treats anything that is not «تالف» as sound, so a new
        //   condition code would put a piece that never arrived back on sale.
        if (receipt.condition === 'مفقود') { items.push({ ...line, condition: 'تالف', lostInTransit: true }); continue; }
        if (receipt.condition !== 'mixed') { items.push({ ...line, condition: receipt.condition }); continue; }
        const damagedQty = Number(receipt.damagedQty || 0), lostQty = Number(receipt.lostQty || 0), soundQty = line.qty - damagedQty - lostQty;
        if (![damagedQty, lostQty, soundQty].every(n => Number.isSafeInteger(n) && n >= 0) || damagedQty + lostQty < 1) throw new BadRequestException('حدد عدد القطع التالفة أو المفقودة بين قطع البند');
        const assigned = labels.filter(label => line.unitIds.includes(label.unitId));
        if (assigned.some(label => !['سليم', 'تالف', 'مفقود'].includes(label.condition))) throw new BadRequestException('حدد حالة كل هوية في البند المختلط');
        const idsOf = (c: string) => assigned.filter(label => label.condition === c).map(label => label.unitId);
        const soundIds = idsOf('سليم'), damagedIds = idsOf('تالف'), lostIds = idsOf('مفقود');
        if (damagedIds.length > damagedQty || soundIds.length > soundQty || lostIds.length > lostQty) throw new BadRequestException('حالات الهويات لا تطابق الكميات المفحوصة');
        const damagedTotal = money(line.total * damagedQty / line.qty), lostTotal = money(line.total * lostQty / line.qty);
        if (soundQty) items.push({ ...line, qty: soundQty, total: money(line.total - damagedTotal - lostTotal), condition: 'سليم', unitIds: soundIds });
        if (damagedQty) items.push({ ...line, qty: damagedQty, total: damagedTotal, condition: 'تالف', unitIds: damagedIds });
        if (lostQty) items.push({ ...line, qty: lostQty, total: lostTotal, condition: 'تالف', lostInTransit: true, unitIds: lostIds });
      }
      const lostUnitIds = new Set<string>(items.filter(i => i.lostInTransit).flatMap(i => i.unitIds || []));
      // A lost piece has no label to check — it never reached the warehouse.
      if (labels.length !== w.selectedUnits.length || new Set(labels.map(l => l.unitId)).size !== labels.length || w.selectedUnits.some((id: string) => !lostUnitIds.has(id) && !labels.some(l => l.unitId === id && ['intact', 'reprinted'].includes(l.labelState) && l.labelAttached === true))) throw new BadRequestException('راجع ملصق كل هوية وأكد لصقه');
      for (const label of labels.filter(l => l.labelState === 'reprinted' && !lostUnitIds.has(l.unitId))) {
        if (!label.printOperationKey || !await this.connection.collection('inventoryunitevents').findOne({ unitId: label.unitId, operationKey: identityOperationKey(actor.userId, label.printOperationKey), action: { $in: ['label-print-requested', 'label-reprint-requested'] }, createdAt: { $gte: row.createdAt } }, { session: ctx.session })) throw new BadRequestException('اطبع الهوية المطموسة قبل إتاحتها للمخزن');
      }
      const doc: any = { date: new Date().toISOString(), type: 'مرتجع', ref: await this.nextReference('RT', ctx), client: row.client, phone: row.phone,
        items, itemsTotal: w.quote.credit, total: w.quote.credit, deposit: 0, remaining: 0, payStatus: 'مكتمل', discount: 0, shipCost: 0,
        warehouseCode: w.warehouseCode, employee: by, returnRequestId: String(row._id), returnShipCo: row.returnShipCo, returnTrackingNumber: row.returnTrackingNumber,
        notes: `مرتجع ${w.ref} — تسوية النقدية من ملف خدمة ما بعد البيع`, afterSales: { caseId: String(row._id), caseRef: w.ref, kind: row.requestKind, originalRef: row.originalRef, originalTransactionId: row.originalTransactionId, role: 'return' } };
      const tx = await this.transactions.create(doc, 'admin', undefined, by, ctx, false, true);
      row.returnTxId = String(tx._id); row.returnTxRef = tx.ref; row.status = 'معتمد'; row.approvedAt = new Date().toISOString(); row.approvedBy = by; row.items = items;
      row.damagedValue = money(items.filter(i => i.condition === 'تالف').reduce((n, i) => n + i.total, 0));
      row.lostInTransitValue = money(items.filter(i => i.lostInTransit).reduce((n, i) => n + i.total, 0));
      await row.save({ session: ctx.session });
      ctx.afterSalesCaseId = String(row._id);
      for (const label of labels) {
        const unit: any = await this.connection.collection('inventoryunits').findOne({ _id: this.id(label.unitId) }, { session: ctx.session });
        if (!unit || unit.assignment?.transactionId !== row.originalTransactionId) throw new ConflictException('هوية القطعة لم تعد مرتبطة بالفاتورة الأصلية');
        const line = items.find(i => i.unitIds.includes(label.unitId));
        const lost = lostUnitIds.has(label.unitId);
        const reason = lost ? `After-sales ${w.ref}: lost by the carrier on its way back — never reached the warehouse` : `After-sales ${w.ref}: physical receipt and inspection`;
        await this.tracking.actionInSession(label.unitId, { operationKey: body.operationKey + ':return', reason, action: 'return', expectedVersion: unit.__v, physicalPossessionConfirmed: true }, actor, ctx.session, by, undefined, ctx);
        const fresh: any = await this.connection.collection('inventoryunits').findOne({ _id: unit._id }, { session: ctx.session });
        await this.tracking.actionInSession(label.unitId, { operationKey: body.operationKey + ':inspect', reason, action: lost ? 'lost' : line.condition === 'سليم' ? 'inspect' : 'damage',
          expectedVersion: fresh.__v, physicalPossessionConfirmed: !lost, inspectionPassed: true, ...(lost ? { physicalCountConfirmed: true } : {}) }, actor, ctx.session, by, undefined, ctx);
      }
      w.receivedAt = new Date().toISOString(); w.receivedBy = by; w.labelChecks = labels; w.stage = 'settlement';
    });
  }
  delivery(id: string, body: any, actor: any) {
    return this.mutate(id, 'replacement-delivered', body, actor, async (row, ctx, by) => {
      if (row.requestKind !== 'exchange' || row.workflow.fulfillmentChannel !== 'direct' && !row.workflow.shipment?.deliveryId || !row.workflow.approvedAt || body.confirmed !== true || !String(body.note || '').trim()) throw new BadRequestException('أكد تسليم البديل المعتمد مع مرجع إثبات التسليم');
      if (row.workflow.fulfillmentChannel === 'direct') {
        const replacement: any = await this.connection.collection('transactions').findOne({_id:this.id(row.workflow.replacementTxId)},{session:ctx.session});
        if (!replacement?.prepChecked) throw new ConflictException('أكمل تجهيز وفحص البديل قبل التسليم المباشر');
        const summary=await this.tracking.pickingSummary(row.workflow.replacementTxId);
        if (summary.lines.some((line:any)=>line.units.length+line.skippedCount<line.qty||line.units.some((u:any)=>u.status!=='prepared'))) throw new ConflictException('هويات البديل غير مكتملة للتسليم');
      }
      if (row.workflow.replacementDeliveredAt) throw new ConflictException('تم تأكيد تسليم البديل');
      row.workflow.replacementDeliveredAt = new Date().toISOString(); row.workflow.deliveryEvidence = body.note;
      const txId = row.workflow.replacementTxId;
      const units = await this.connection.collection('inventoryunits').find({ 'assignment.transactionId': txId }, { session: ctx.session }).toArray();
      for (const unit of units) {
        if (!['prepared', 'shipped', 'delivered'].includes(unit.status)) throw new ConflictException('هوية البديل غير جاهزة للتسليم');
        let version = unit.__v;
        if (unit.status === 'prepared') {
          await this.tracking.actionInSession(unit.barcode, { operationKey: body.operationKey + ':ship', reason: body.note, expectedVersion: version, action: 'ship', physicalPossessionConfirmed: true }, actor, ctx.session, by, undefined, ctx);
          const fresh = await this.connection.collection('inventoryunits').findOne({ _id: unit._id }, { session: ctx.session }); version = fresh!.__v;
        }
        if (unit.status !== 'delivered') await this.tracking.actionInSession(unit.barcode, { operationKey: body.operationKey + ':deliver', reason: body.note, expectedVersion: version, action: 'deliver', physicalPossessionConfirmed: true }, actor, ctx.session, by, undefined, ctx);
      }
      await this.connection.collection('transactions').updateOne({ _id: this.id(txId) }, { $set: { deliveredAt: row.workflow.replacementDeliveredAt, pickupStatus: 'Delivered', deliverySource: 'MANUAL' } }, { session: ctx.session });
      await this.transactions.recordAfterSalesDelivery(txId, by, ctx);
      // The whole difference was paid in advance: nothing is left to collect.
      if (row.workflow.quote.collectDue && !row.workflow.collection) {
        const paid: any = await this.connection.collection('transactions').findOne({ _id: this.id(txId) }, { session: ctx.session });
        if (advanceRemaining(row.workflow.quote.collectDue, paid) <= 0) row.workflow.collection = { amount: 0, prepaid: true,
          advance: money(row.workflow.quote.collectDue), at: new Date().toISOString(), by };
      }
      // The bundled sales were in the same parcel: delivered with it.
      for (const b of row.workflow.shipment?.bundled || []) {
        const bundledId = String(b.transactionId);
        const bundledUnits = await this.connection.collection('inventoryunits').find({ 'assignment.transactionId': bundledId }, { session: ctx.session }).toArray();
        for (const unit of bundledUnits) {
          if (!['prepared', 'shipped', 'delivered'].includes(unit.status)) throw new ConflictException(`هوية في الطلب المضموم #${b.ref} غير جاهزة للتسليم`);
          let version = unit.__v;
          if (unit.status === 'prepared') {
            await this.tracking.actionInSession(unit.barcode, { operationKey: body.operationKey + ':bundle-ship', reason: body.note, expectedVersion: version, action: 'ship', physicalPossessionConfirmed: true }, actor, ctx.session, by, undefined, ctx);
            const fresh = await this.connection.collection('inventoryunits').findOne({ _id: unit._id }, { session: ctx.session }); version = fresh!.__v;
          }
          if (unit.status !== 'delivered') await this.tracking.actionInSession(unit.barcode, { operationKey: body.operationKey + ':bundle-deliver', reason: body.note, expectedVersion: version, action: 'deliver', physicalPossessionConfirmed: true }, actor, ctx.session, by, undefined, ctx);
        }
        await this.connection.collection('transactions').updateOne({ _id: this.id(bundledId), 'afterSalesBundle.caseId': String(row._id) },
          { $set: { deliveredAt: row.workflow.replacementDeliveredAt, pickupStatus: 'Delivered', deliverySource: 'MANUAL', 'afterSalesBundle.deliveredAt': row.workflow.replacementDeliveredAt } }, { session: ctx.session });
        ctx.afterCommit.push(() => this.transactions.notifyAfterSalesTransactionChanged(bundledId));
      }
    });
  }
  settle(id: string, body: any, actor: any) {
    return this.mutate(id, 'settlement:' + body.kind, body, actor, async (row, ctx, by) => {
      const w = row.workflow, q = w.quote, method = normalizeVaultAccountLabel(body.method);
      if (!method || !String(body.reference || '').trim() || body.confirmed !== true) throw new BadRequestException('حدد الخزنة ومرجع الحركة وأكد تنفيذها فعليًا');
      let amount = 0, source = 'تحصيل';
      if (body.kind === 'refund') {
        if (!w.receivedAt || w.refund || !q.refundDue || row.requestKind === 'exchange' && !w.replacementDeliveredAt) throw new ConflictException('رد المبلغ غير مستحق أو تم تنفيذه');
        amount = -q.refundDue; source = 'رد مرتجع';
      } else if (body.kind === 'collection') {
        if (!w.replacementDeliveredAt || w.collection || !q.collectDue) throw new ConflictException('التحصيل غير مستحق أو تم تنفيذه');
        // Through Bosta the difference is the shipment's COD — it arrives in Bosta's transfer («carrier»).
        if (w.fulfillmentChannel !== 'direct') throw new BadRequestException('فرق العميل تحصّله بوسطة مع الشحنة — سجّله في تسوية بوسطة عند وصول التحويل');
        const replacementTx: any = await this.connection.collection('transactions').findOne({ _id: this.id(w.replacementTxId) }, { session: ctx.session });
        if (pendingDepositRequests(replacementTx)) throw new ConflictException('عربون على فرق الاستبدال بانتظار موافقة المدير؛ اعتمده أو ارفضه أولًا');
        amount = advanceRemaining(q.collectDue, replacementTx);
        if (amount <= 0) throw new ConflictException('فرق الاستبدال مدفوع بالكامل كعربون');
      } else if (body.kind === 'carrier') {
        if (w.fulfillmentChannel === 'direct') throw new BadRequestException('التنفيذ المباشر لا توجد له تسوية ناقل');
        if (!w.receivedAt || row.requestKind === 'exchange' && !w.replacementDeliveredAt || w.carrierSettlement) throw new ConflictException('تسوية الناقل بعد اكتمال الشحنة والاستلام ولمرة واحدة');
        const cost = Number(body.actualCost);
        if (!Number.isFinite(cost) || cost < 0) throw new BadRequestException('تكلفة بوسطة غير صالحة');
        // Bundled sales: Bosta collected their remaining in the same waybill, so the same transfer carries it.
        const bundled: any[] = w.shipment?.bundled || [];
        const bundledDue = money(bundled.reduce((n: number, b: any) => n + Number(b.cod || 0), 0));
        const exchangeDue = money(Number(w.shipment?.exchangeCod ?? q.collectDue));
        if ((exchangeDue > 0 && !w.collection || bundledDue > 0) && body.includesCollection !== true) throw new BadRequestException('حدد أن تحويل بوسطة يشمل ما حصّلته من العميل (فرق الاستبدال والطلبات المضمومة)');
        amount = money((body.includesCollection === true && !w.collection ? exchangeDue : 0) + bundledDue - cost);
        row.actualShipCost = cost;
        w.carrierSettlement = { cost, method, reference: body.reference, at: new Date().toISOString(), by };
        if (!w.collection && q.collectDue && (body.includesCollection === true || exchangeDue <= 0)) w.collection = { amount: exchangeDue, method, reference: body.reference, viaCarrier: true,
          ...(exchangeDue < q.collectDue ? { advance: money(q.collectDue - exchangeDue) } : {}), at: new Date().toISOString(), by };
        // A return has no sale leg of its own. Store its shipping delta on the original sale for existing profit reports.
        const financialId = w.replacementTxId || row.originalTransactionId;
        // One carrier fee covers the whole parcel, so it is compared with ALL shipping the customer paid
        // (exchange fee + each bundled sale's shipping) and booked once, on the replacement.
        const customerShip = money(q.customerFee + bundled.reduce((n: number, b: any) => n + Number(b.shipCharged || 0), 0));
        await this.connection.collection('transactions').updateOne({ _id: this.id(financialId) }, { $inc: { shipLoss: Math.max(0, money(cost - customerShip)), shipSaving: Math.max(0, money(customerShip - cost)) } }, { session: ctx.session });
      } else throw new BadRequestException('نوع التسوية غير صالح');
      const entry = amount ? await this.vault.addSystemEntry(amount, method, `خدمة ما بعد البيع ${w.ref} — ${body.kind} — ${body.reference}`,
        new Date().toISOString().slice(0, 10), source, w.ref, { customer: row.client }, by, { afterSalesId: String(row._id), reference: body.reference,
          afterSales: { kind: body.kind, caseRef: w.ref, originalRef: row.originalRef, originalTransactionId: row.originalTransactionId,
            replacementRef: w.replacementRef || '', returnRef: row.returnTxRef || '', paymentReference: body.reference,
            creditApplied: q.creditApplied, net: amount, carrierCost: body.kind === 'carrier' ? w.carrierSettlement.cost : 0,
            bundledSales: body.kind === 'carrier' ? (w.shipment?.bundled || []).map((b: any) => ({ ref: b.ref, cod: b.cod })) : [],
            grossCollection: body.kind === 'carrier' ? money(amount + w.carrierSettlement.cost) : body.kind === 'collection' ? amount : 0 } }, ctx) : null;
      if (body.kind === 'collection') w.collection = { amount, method, reference: body.reference, at: new Date().toISOString(), by,
        ...(amount < q.collectDue ? { advance: money(q.collectDue - amount) } : {}) };
      const snapshot = { amount: Math.abs(amount), method, reference: body.reference, vaultEntryId: entry ? String(entry._id) : null, at: new Date().toISOString(), by };
      if (body.kind === 'refund') w.refund = snapshot;
      if (body.kind === 'collection') w.collection = { ...w.collection, ...snapshot };
      if (body.kind === 'carrier') {
        w.carrierSettlement = { ...w.carrierSettlement, vaultEntryId: snapshot.vaultEntryId, net: amount };
        // Each bundled sale is now paid: what Bosta collected for it closes its remaining.
        const transactions = this.connection.collection('transactions');
        for (const b of w.shipment?.bundled || []) {
          const tx: any = await transactions.findOne({ _id: this.id(String(b.transactionId)), 'afterSalesBundle.caseId': String(row._id) }, { session: ctx.session });
          if (!tx || tx.afterSalesBundle?.collection) continue;
          const collection = { amount: Number(b.cod || 0), method, reference: body.reference, viaCarrier: true, caseRef: w.ref, vaultEntryId: snapshot.vaultEntryId, at: snapshot.at, by };
          await transactions.updateOne({ _id: tx._id, 'afterSalesBundle.collection': { $exists: false } }, { $set: {
            deposit: money(Number(tx.deposit || 0) + Number(b.cod || 0)), remaining: 0, payStatus: 'مكتمل', collectMethod: method,
            collectedAt: snapshot.at.slice(0, 10), 'afterSalesBundle.collection': collection } }, { session: ctx.session });
          ctx.afterCommit.push(() => this.transactions.notifyAfterSalesTransactionChanged(String(tx._id)));
        }
      }
      if (w.replacementTxId && w.collection) await this.connection.collection('transactions').updateOne({ _id: this.id(w.replacementTxId) }, { $set: { deposit: money(q.creditApplied + q.collectDue), remaining: 0, payStatus: 'مكتمل', collectMethod: method,
        'afterSales.collection': w.collection } }, { session: ctx.session });
    });
  }
  exception(id: string, body: any, actor: any) {
    this.permit(actor, 'transaction');
    return this.mutate(id, body.resolve === true ? 'exception-resolved' : 'exception', body, actor, async row => {
      if (!String(body.note || '').trim()) throw new BadRequestException('حدد المشكلة أو إجراء معالجتها');
      if (body.resolve === true && actor.role !== 'admin') throw new ForbiddenException();
      row.workflow.exception = body.resolve === true ? null : body.note;
    });
  }
  async report(from?: string, to?: string) {
    const filter: any = { 'workflow.version': 2 };
    for (const day of [from, to]) if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)) throw new BadRequestException('تاريخ التقرير غير صالح');
    if (from && to && from > to) throw new BadRequestException('تاريخ البداية بعد النهاية');
    const localDay = { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: 'Africa/Cairo' } };
    if (from || to) filter.$expr = { $and: [...(from ? [{ $gte: [localDay, from] }] : []), ...(to ? [{ $lte: [localDay, to] }] : [])] };
    const rows: any[] = await this.cases.find(filter).sort({ createdAt: -1 }).lean();
    return { rows, summary: rows.reduce((out, row) => {
      const w = row.workflow; if (w.stage === 'cancelled') { out.cancelled++; return out; }
      out.total++; out[row.requestKind === 'exchange' ? 'exchanges' : 'returns']++;
      if (w.stage === 'closed') out.closed++; else out.open++;
      out.refunded += Number(w.refund?.amount || 0); out.collected += Number(w.collection?.amount || 0);
      out.refundPending += w.refund ? 0 : Number(w.quote.refundDue || 0); out.collectPending += w.collection ? 0 : Number(w.quote.collectDue || 0);
      out.carrierCost += Number(w.carrierSettlement?.cost || 0); out.damagedValue += Number(row.damagedValue || 0);
      return out;
    }, { total: 0, returns: 0, exchanges: 0, closed: 0, open: 0, cancelled: 0, refunded: 0, collected: 0, refundPending: 0, collectPending: 0, carrierCost: 0, damagedValue: 0 }) };
  }
}
