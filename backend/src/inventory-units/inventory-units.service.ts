import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { DatabaseWriteContext } from '../shared/database-write-context';
import { UnitManualCodesService } from './unit-manual-codes.service';
import { manualPackCode, packCodeFilter } from './pack-manual-codes';
import { pickingExceptions } from './picking-exceptions';
import { purchaseLineOrigins, resolvePurchaseLine } from './purchase-line-membership';
import { requireWarehouse, warehouseCode as normalizeWarehouseCode } from '../warehouses/warehouse-storage';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, ClientSession } from 'mongoose';
import { createHash, randomUUID } from 'crypto';
import * as QRCode from 'qrcode';
import { InventoryUnit } from './schemas/inventory-unit.schema';
import { InventoryUnitEvent } from './schemas/inventory-unit-event.schema';
import { InventoryUnitOperation } from './schemas/inventory-unit-operation.schema';
import { INVENTORY_UNIT_STATUSES, OBJECT_ID_PATTERN, LABEL_SIZES } from './inventory-unit.constants';
import { migrateInventoryUnitIndexes } from './inventory-unit-index.migration';
import { TransactionsService } from '../transactions/transactions.service';
import { CountAttestationDto, CountReviewDto, IdentifyPurchaseLineDto, LabelRequestDto, LegacyStockIdentifyDto, OrderPickExceptionDto, OrderPickScanDto, ReceiveCustomerPieceDto, RegisterUnitDto, TrackingRequestDto, UnitActionDto } from './inventory-unit.dto';

export type TrackingActor = { userId?: string; name?: string; username?: string; role?: string; perms?: string[] };
type PurchaseReceiptLine = { lineIndex: number; lineId: string; sku: string; name: string; imageUrl: string; quantity: number; createdUnits: number; onHandUnits: number; unassignedUnits: number; printedUnits: number; printRequests: number; change?: any };
type PurchaseReceipt = { transactionId: string; ref: string; date: any; supplier: string; warehouseCode: string; cancelled: boolean; lines: PurchaseReceiptLine[] };
type PurchaseReceiptPage = { receipts: PurchaseReceipt[]; total: number; page: number; limit: number };
export { LABEL_SIZES } from './inventory-unit.constants';
const allocatedStatuses = ['reserved', 'picking', 'prepared', 'shipped', 'delivered', 'lost', 'damaged'];
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class InventoryUnitsService {
  private readonly logger = new Logger(InventoryUnitsService.name);
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(InventoryUnit.name) private readonly units: Model<any>,
    @InjectModel(InventoryUnitEvent.name) private readonly events: Model<any>,
    @InjectModel(InventoryUnitOperation.name) private readonly operations: Model<any>,
    private readonly transactions: TransactionsService,
    private readonly manualCodes: UnitManualCodesService,
  ) {}

  private id(value: string) {
    if (!OBJECT_ID_PATTERN.test(String(value || ''))) throw new BadRequestException('Invalid identifier');
    return new Types.ObjectId(value);
  }
  identifierFilter(identifier: string, session?: ClientSession) { return this.manualCodes.filter(identifier, session); }
  async supplierReturnInfo(unit: any, session?: ClientSession) {
    let id = unit.supplierReturnId;
    if (!id && unit.status === 'returned-to-supplier') {
      const fact: any = await this.events.findOne({ unitId: String(unit._id), action: 'supplier-returned' }).sort({ sequence: -1 }).session(session || null).lean();
      id = fact?.details?.supplierReturnId;
    }
    if (!id || !OBJECT_ID_PATTERN.test(String(id))) return null;
    const row: any = await this.connection.collection('supplierreturnorders').findOne({ _id: this.id(id) }, { session,
      projection: { returnNumber: 1, reason: 1, reasonDetails: 1, status: 1, supplierName: 1, reversal: 1 } });
    return row ? { id: String(row._id), returnNumber: row.returnNumber, reason: row.reason, reasonDetails: row.reasonDetails || '',
      status: row.status, supplierName: row.supplierName, reversed: !!row.reversal } : null;
  }

  async reserveSupplierReturnUnits(items: any[], inputItems: any[], record: any, actorId: string, by: string, context: DatabaseWriteContext) {
    const session = context.session, location = await requireWarehouse(this.connection, record.warehouseCode, session);
    record.warehouseCode = location;
    const ids = inputItems.flatMap(item => item.unitIds || []).map(id => String(id).toLowerCase());
    if (!ids.length || new Set(ids).size !== ids.length) throw new ConflictException({ code: 'SR_DUPLICATE_PIECE', message: 'Scan each return piece exactly once' });
    const rows: any[] = await this.units.find({ _id: { $in: ids.map(id => this.id(id)) } }).session(session);
    if (rows.length !== ids.length) throw new ConflictException({ code: 'SR_PIECE_MISSING', message: 'Return piece not found' });
    for (const id of [...new Set<string>(rows.map(unit => unit.productId))].sort()) await this.lockProduct(id, session);
    const supplier: any = await this.connection.collection('suppliers').findOne({ _id: this.id(record.supplierId) }, { session });
    for (const item of items) {
      const input = inputItems.filter(row => String(row.code).trim() === String(item.code).trim());
      if (input.length !== 1 || !Number.isSafeInteger(item.qty) || item.qty < 1 || input[0].unitIds?.length !== item.qty) {
        throw new ConflictException({ code: 'SR_PIECE_COUNT', message: 'Scan every piece in the return quantity' });
      }
      item.unitIds = input[0].unitIds.map((id: string) => id.toLowerCase()); item.units = [];
      for (const id of item.unitIds) {
        const unit = rows.find(row => String(row._id) === id);
        const product: any = await this.connection.collection('products').findOne({ _id: this.id(unit.productId) }, { session });
        if (String(product?.code || '').trim() !== String(item.code).trim()) throw new ConflictException({ code: 'SR_WRONG_PRODUCT', message: 'Return piece does not match the product' });
        if (unit.assignment || unit.supplierReturnId || unit.packId || !['available', 'inspection-required', 'damaged', 'returned'].includes(unit.status)) {
          throw new ConflictException({ code: 'SR_PIECE_UNAVAILABLE', message: 'Return piece is assigned, packed or unavailable' });
        }
        if (normalizeWarehouseCode(unit.warehouseCode) !== location) throw new ConflictException({ code: 'SR_WRONG_WAREHOUSE', message: 'Return piece belongs to another warehouse' });
        if (unit.origin?.purchaseTransactionId) {
          const source: any = await this.connection.collection('transactions').findOne({ _id: this.id(unit.origin.purchaseTransactionId) }, { session });
          if (!source || source.cancelled || source.archived || source.type !== 'مشتريات' ||
              (source.supplierId ? String(source.supplierId) !== String(record.supplierId) : String(source.client || '').trim() !== String(supplier?.name || '').trim()) ||
              (record.allocationMethod === 'single-invoice' && record.originalTransactionId && String(source._id) !== String(record.originalTransactionId))) {
            throw new ConflictException({ code: 'SR_WRONG_SUPPLIER', message: 'Return piece does not belong to this supplier or source invoice' });
          }
        }
        const previousStatus = unit.status;
        item.units.push({ unitId: id, barcode: unit.barcode, manualCode: await this.manualCodes.codeFor(id), previousStatus, warehouseCode: location });
        unit.status = 'supplier-return-pending'; unit.supplierReturnId = String(record._id); await unit.save({ session });
        await this.event(unit, 'supplier-return-reserved', previousStatus, { operationKey: `sr-hold-${record._id}-${randomUUID()}`, reason: record.reason },
          { userId: actorId }, by, session, { details: { supplierReturnId: String(record._id), returnNumber: record.returnNumber, reason: record.reason, reasonDetails: record.reasonDetails || '', stockChanged: false } });
      }
    }
    const inventory = await this.transactions.getInventory(session);
    for (const item of items) {
      const row = inventory.find(row => String(row.code).trim() === String(item.code).trim());
      if (Number(row?.warehouseBalances?.[location] || 0) < item.qty) throw new ConflictException({ code: 'SR_STOCK_SHORTAGE', message: 'Insufficient stock in the return warehouse' });
    }
    context.afterCommit.push(() => this.transactions.notifyUnitIdentitiesChanged?.());
  }

  async finishSupplierReturnUnits(record: any, actorId: string, by: string, context: DatabaseWriteContext, release = false) {
    const session = context.session, snapshots = (record.items || []).flatMap((item: any) => item.units || []);
    if (!snapshots.length) {
      if (release) return;
      throw new ConflictException({ code: 'SR_PIECE_COUNT', message: 'Scan every piece in the return quantity' });
    }
    await requireWarehouse(this.connection, record.warehouseCode, session);
    if (!release && (record.items || []).some((item: any) => item.units?.length !== item.qty)) throw new ConflictException({ code: 'SR_PIECE_COUNT', message: 'Scan every piece in the return quantity' });
    const rows: any[] = await this.units.find({ _id: { $in: snapshots.map((row: any) => this.id(row.unitId)) } }).session(session);
    for (const id of [...new Set<string>(rows.map(unit => unit.productId))].sort()) await this.lockProduct(id, session);
    for (const snapshot of snapshots) {
      const unit = rows.find(row => String(row._id) === snapshot.unitId);
      if (!unit || unit.status !== 'supplier-return-pending' || unit.supplierReturnId !== String(record._id)) throw new ConflictException({ code: 'SR_PIECE_CHANGED', message: 'Return piece state changed' });
      const from = unit.status;
      unit.status = release ? snapshot.previousStatus : 'returned-to-supplier';
      if (release) unit.supplierReturnId = null;
      await unit.save({ session });
      await this.event(unit, release ? 'supplier-return-released' : 'supplier-returned', from,
        { operationKey: `sr-${release ? 'release' : 'complete'}-${record._id}-${randomUUID()}`, reason: record.reason }, { userId: actorId }, by, session,
        { details: { supplierReturnId: String(record._id), returnNumber: record.returnNumber, reason: record.reason, reasonDetails: record.reasonDetails || '',
          supplierId: record.supplierId, warehouseCode: record.warehouseCode || 'MAIN', stockChanged: false } });
    }
    context.afterCommit.push(() => this.transactions.notifyUnitIdentitiesChanged?.());
  }
  async withManualCodes(units: any[]) {
    const [identified, counts] = await Promise.all([this.manualCodes.decorate(units),
      this.labelPrintCounts(units.map(unit => String(unit._id || unit.unitId)))]);
    return identified.map(unit => ({ ...unit, printCount: counts.get(String(unit._id || unit.unitId)) || 0 }));
  }
  private require(actor: TrackingActor, permission: string) {
    if (!actor?.userId || !OBJECT_ID_PATTERN.test(actor.userId)) throw new ForbiddenException('Authenticated actor required');
    if (actor.role !== 'admin' && !actor.perms?.includes(permission)) throw new ForbiddenException(`Permission required: ${permission}`);
  }
  config() { return { statuses: INVENTORY_UNIT_STATUSES, labelSizes: LABEL_SIZES, symbology: 'QR', enforcementEnabled: false,
    physicalPrintingVerified: false, printEventMeaning: 'request-recorded-not-physical-print' }; }

  async readiness() {
    let transactionsSupported = false;
    let indexes: any;
    const blockers: string[] = [];
    try {
      const hello = await this.connection.db!.admin().command({ hello: 1 });
      transactionsSupported = !!(hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes != null && hello.maxWireVersion >= 8;
      if (!transactionsSupported) blockers.push('MongoDB replica set or mongos with sessions/transactions required');
      indexes = await migrateInventoryUnitIndexes(this.connection.db!);
      if (indexes.collections.some((row: any) => !row.exists || row.missing.length)) blockers.push('Explicit tracking index migration required');
    } catch { blockers.push('Database capability/index verification failed'); }
    return { writesReady: !blockers.length, transactionsSupported, indexes, blockers, enforcementEnabled: false };
  }

  private async write(kind: string, dto: TrackingRequestDto, actor: TrackingActor, permission: string,
    work: (session: ClientSession, actorName: string, context: DatabaseWriteContext) => Promise<any>) {
    this.require(actor, permission);
    if (!/^[A-Za-z0-9:_-]{8,120}$/.test(dto.operationKey || '') || !dto.reason?.trim()) throw new BadRequestException('Operation key and reason required');
    const ready = await this.readiness();
    if (!ready.writesReady) throw new ServiceUnavailableException(ready.blockers.join('; '));
    const operationId = digest({ actor: actor.userId!.toLowerCase(), key: dto.operationKey });
    const fingerprint = digest({ kind, dto });
    const session = await this.connection.startSession();
    let result: any;
    let afterCommit: DatabaseWriteContext['afterCommit'] = [];
    try {
      // withTransaction retries transient write conflicts and ambiguous commits. No external effects in callback.
      await session.withTransaction(async () => {
        afterCommit = [];
        const user = await this.connection.collection('users').findOne({ _id: this.id(actor.userId!) }, { session });
        if (!user || user.isActive === false) throw new ForbiddenException('Actor no longer exists or is inactive');
        const actorName = String(user.name || user.username || actor.name || actor.username || actor.userId);
        const previous = await this.operations.findById(operationId).session(session).lean() as any;
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ConflictException('Idempotency key reused with different payload');
          result = previous.result; return;
        }
        result = { ...await work(session, actorName, { session, afterCommit }), operationId };
        await new this.operations({ _id: operationId, fingerprint, kind, actorId: actor.userId!.toLowerCase(), actorName, result }).save({ session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 15000 });
      for (const effect of afterCommit) {
        try { await effect(); } catch { this.logger.warn('Committed receipt notification requires refresh; financial transaction was not retried'); }
      }
      if (result?.unit || result?.transactionId) {
        try { this.transactions.notifyUnitIdentitiesChanged?.(result.transactionId || result.unit?.assignment?.transactionId || undefined,
          result.unit?.unitId || result.unit?._id?.toString()); } catch { this.logger.warn('Committed unit action notification requires refresh'); }
      }
      return result;
    } catch (error: any) {
      // Two first uses of a key can race on the receipt's primary key. Replay only an identical committed receipt.
      if (error.code === 11000) {
        const previous: any = await this.operations.findById(operationId).lean();
        if (previous?.fingerprint === fingerprint) return previous.result;
        throw new ConflictException('Concurrent duplicate operation or identity; reload before retrying');
      }
      if (error.name === 'VersionError') throw new ConflictException('Unit changed; reload before retrying');
      throw error;
    } finally { await session.endSession(); }
  }

  private async lockProduct(productId: string, session: ClientSession) {
    // Tracking-only revision serializes admission and events for this SKU. Never changes stock or prices.
    const product = await this.connection.collection('products').findOneAndUpdate({ _id: this.id(productId) },
      { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
    if (!product) throw new NotFoundException('Product not found');
    const codes = await this.connection.collection('products').find({}, { session, projection: { code: 1 } }).toArray();
    const duplicates = codes.filter(row => String(row.code || '').trim() === String(product.code || '').trim()).length;
    if (!String(product.code || '').trim() || duplicates !== 1) throw new ConflictException('Missing/duplicate SKU blocks tracking writes');
    return product;
  }
  private async event(unit: any, action: string, fromStatus: string | null, dto: TrackingRequestDto,
    actor: TrackingActor, name: string, session: ClientSession, extra: any = {}) {
    const previous: any = await this.events.findOne({ unitId: String(unit._id) }).sort({ sequence: -1 }).session(session).lean();
    await new this.events({ unitId: String(unit._id), sequence: (previous?.sequence || 0) + 1,
      operationKey: digest({ actor: actor.userId!.toLowerCase(), key: dto.operationKey }), action, fromStatus, toStatus: unit.status,
      byUserId: actor.userId, by: name, reason: dto.reason, ...extra }).save({ session });
  }

  async search(query: Record<string, string>, sourceFilter: Record<string, any> = {}) {
    const page = Math.max(1, Math.min(10000, Number(query.page) || 1));
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 30));
    if (!Number.isInteger(page) || !Number.isInteger(limit)) throw new BadRequestException('Invalid pagination');
    const filter: any = { ...sourceFilter };
    if (query.reconciliationRef) {
      if (query.reconciliationRef.length > 120) throw new BadRequestException('Invalid search');
      filter['origin.reconciliationRef'] = query.reconciliationRef;
    }
    if (query.warehouseCode) filter.warehouseCode = { $in: normalizeWarehouseCode(query.warehouseCode) === 'MAIN' ? ['MAIN', 'main', 'المخزن الرئيسي', '', null] : [normalizeWarehouseCode(query.warehouseCode)] };
    if (query.status) {
      if (!(INVENTORY_UNIT_STATUSES as readonly string[]).includes(query.status)) throw new BadRequestException('Unknown unit status');
      filter.status = query.status;
    }
    if (query.productId) filter.productId = String(this.id(query.productId));
    if (query.purchaseTransactionId) filter['origin.purchaseTransactionId'] = String(this.id(query.purchaseTransactionId));
    if (query.purchaseLineId) {
      if (!query.purchaseTransactionId || query.purchaseLineId.length > 120 || /[\x00-\x1f\x7f]/.test(query.purchaseLineId)) throw new BadRequestException('A valid purchase invoice and line identity are required');
      filter['origin.purchaseLineId'] = query.purchaseLineId;
    }
    const needle = String(query.q || '').trim();
    if (needle.length > 160) throw new BadRequestException('Search too long');
    const pattern = { $regex: escapeRegex(needle), $options: 'i' };
    const matchingInvoices = needle ? await this.connection.collection('transactions').find({ type: 'مشتريات', ref: { $regex: escapeRegex(needle.replace(/^#/, '')), $options: 'i' } },
      { projection: { _id: 1, ref: 1, 'items.code': 1 }, maxTimeMS: 5000 }).toArray() : [];
    const invoiceSkus = [...new Set(matchingInvoices.flatMap(invoice => (invoice.items || []).map((item: any) => String(item.code || '').trim())).filter(Boolean))];
    const productFilter: any = needle ? { $or: ['name', 'code', 'colors', 'size'].map(key => ({ [key]: pattern })) } : {};
    if (query.productId) productFilter._id = this.id(query.productId);
    const products = await this.connection.collection('products').find(productFilter, { projection: { name: 1, code: 1, colors: 1, size: 1 }, maxTimeMS: 5000 }).sort({ _id: 1 }).toArray();
    const manualId = needle ? await this.manualCodes.findUnitId(needle) : null;
    if (needle) filter.$or = [{ barcode: pattern }, { productId: { $in: products.map(product => String(product._id)) } },
      { 'origin.purchaseTransactionId': { $in: matchingInvoices.map(invoice => String(invoice._id)) } },
      ...(OBJECT_ID_PATTERN.test(needle) ? [{ _id: this.id(needle) }] : []), ...(manualId ? [{ _id: manualId }] : [])];
    const [rows, total] = await Promise.all([this.units.find(filter).sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.units.countDocuments(filter)]);
    const productIds = [...new Set(rows.map((row: any) => row.productId))];
    const associated = await this.connection.collection('products').find({ _id: { $in: productIds.map(id => this.id(id)) } },
      { projection: { name: 1, code: 1, colors: 1, size: 1 } }).toArray();
    const purchaseIds = [...new Set(rows.map((row: any) => row.origin?.purchaseTransactionId).filter(id => OBJECT_ID_PATTERN.test(String(id))))];
    const purchases = purchaseIds.length ? await this.connection.collection('transactions').find({ _id: { $in: purchaseIds.map(id => this.id(String(id))) }, type: 'مشتريات' },
      { projection: { ref: 1 }, maxTimeMS: 5000 }).toArray() : [];
    const invoiceRefs = new Map(purchases.map(invoice => [String(invoice._id), String(invoice.ref || '')]));
    const invoiceProducts = invoiceSkus.length ? await this.connection.collection('products').find({ code: { $in: invoiceSkus }, ...(query.productId ? { _id: this.id(query.productId) } : {}) },
      { projection: { name: 1, code: 1, colors: 1, size: 1 }, maxTimeMS: 5000 }).toArray() : [];
    const catalogue = [...new Map([...products,...invoiceProducts].map(product => [String(product._id),product])).values()];
    return { products: catalogue.slice(0, 100), productsTruncated: catalogue.length > 100, invoiceMatch: matchingInvoices.length > 0,
      units: await this.withManualCodes(rows.map((row: any) => ({ ...row, invoiceRef: invoiceRefs.get(String(row.origin?.purchaseTransactionId)) || '', product: associated.find(product => String(product._id) === row.productId) || null }))), total, page, limit };
  }

  /** Recent supplier invoices and their exact per-line physical identity coverage for Barcode management. */
  purchaseReceipts(): Promise<PurchaseReceipt[]>;
  purchaseReceipts(query: Record<string, string>): Promise<PurchaseReceiptPage | PurchaseReceipt[]>;
  async purchaseReceipts(query: Record<string, string> = {}): Promise<PurchaseReceiptPage | PurchaseReceipt[]> {
    const purchaseType = '\u0645\u0634\u062a\u0631\u064a\u0627\u062a';
    const paged = query.page !== undefined;
    const page = Number(query.page || 1), limit = Number(query.limit || (paged ? 20 : 50));
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('Invalid receipt pagination');
    const filter: any = { type: purchaseType, archived: { $ne: true } };
    if (query.transactionId) filter._id = this.id(query.transactionId);
    const needle = String(query.q || '').trim();
    if (needle.length > 160) throw new BadRequestException('Search too long');
    if (needle) filter.$or = ['ref', 'client', 'supplier', 'items.code', 'items.name', 'items.productName']
      .map(field => ({ [field]: { $regex: escapeRegex(needle), $options: 'i' } }));
    const invoices = await this.connection.collection('transactions').find(filter, {
      projection: { ref: 1, date: 1, createdAt: 1, client: 1, supplier: 1, items: 1, cancelled: 1, warehouseCode: 1, editHistory: 1 },
    }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    const invoiceIds = invoices.map(row => String(row._id).toLowerCase());
    const unitRows: any[] = invoiceIds.length ? await this.units.find({ 'origin.purchaseTransactionId': { $in: invoiceIds } })
      .select('_id productId origin status packId').lean() : [];
    const printCounts = await this.labelPrintCounts(unitRows.map(unit => String(unit._id)));
    const packIds = [...new Set(unitRows.map(unit=>unit.packId).filter(id=>OBJECT_ID_PATTERN.test(String(id||''))))];
    const printedPacks = packIds.length ? await this.connection.collection('inventorypacks').find({_id:{$in:packIds.map(id=>this.id(String(id)))},state:'sealed',printCount:{$gt:0}},
      {projection:{unitIds:1,quantity:1}}).toArray() : [];
    const packCoverage = new Map(printedPacks.filter(pack=>pack.unitIds?.length===pack.quantity).map(pack=>[String(pack._id),new Set((pack.unitIds||[]).map(String))]));
    const productIds = [...new Set(unitRows.map(unit => unit.productId))];
    const invoiceSkus = [...new Set(invoices.flatMap((invoice: any) => (invoice.items || []).map((line: any) => String(line.code || '').trim())).filter(Boolean))];
    const productFilters: any[] = [];
    if (productIds.length) productFilters.push({ _id: { $in: productIds.map(id => this.id(id)) } });
    if (invoiceSkus.length) productFilters.push({ code: { $in: invoiceSkus } });
    const products: any[] = productFilters.length ? await this.connection.collection('products')
      .find({ $or: productFilters }, { projection: { code: 1, name: 1, imageUrl: 1, images: 1 } }).toArray() : [];
    const receipts = invoices.map((invoice: any) => {
      const sku = (row: any) => String(row.code || '').trim();
      const quantities = (items: any[]) => JSON.stringify(Object.entries((items || []).reduce((sum: any, row: any) => {
        sum[sku(row)] = (sum[sku(row)] || 0) + Number(row.qty || 0); return sum;
      }, {})).sort());
      const edit: any = [...(invoice.editHistory || [])].reverse().find(row => Array.isArray(row.before?.items) &&
        Array.isArray(row.after?.items) && quantities(row.before.items) !== quantities(row.after.items));
      const previous: any[] = edit?.before?.items || [];
      const removedProducts = previous.filter(row => !(invoice.items || []).some((line: any) => sku(line) === sku(row)))
        .map(row => ({ sku: sku(row), name: row.name || sku(row), previousQuantity: Number(row.qty || 0) }));
      const invoiceUnits = unitRows.filter(unit => unit.origin?.purchaseTransactionId === String(invoice._id));
      const represented = new Set<string>();
      return {
      transactionId: String(invoice._id).toLowerCase(), ref: String(invoice.ref || ''), date: invoice.date || invoice.createdAt || null,
      quantityEditedAt: edit?.editedAt || null, removedProducts,
      supplier: String(invoice.client || invoice.supplier || ''), warehouseCode: normalizeWarehouseCode(invoice.warehouseCode), cancelled: invoice.cancelled === true,
      lines: (invoice.items || []).map((line: any, lineIndex: number) => {
        const invoiceUnits = unitRows.filter(unit => unit.origin?.purchaseTransactionId === String(invoice._id).toLowerCase());
        const exact = line.lineId ? invoiceUnits.filter(unit => unit.origin?.purchaseLineId === line.lineId &&
          products.some(product => String(product._id) === unit.productId && String(product.code || '').trim() === String(line.code || '').trim())) : [];
        const sku = String(line.code || '').trim();
        const matchingProducts = products.filter(product => String(product.code || '').trim() === sku);
        const product = matchingProducts.length === 1 ? matchingProducts[0] : null;
        const imageUrl = [line.imageUrl, product?.imageUrl, ...(Array.isArray(product?.images) ? product.images : [])]
          .find(value => typeof value === 'string' && value.trim()) || '';
        const skuLineCount = (invoice.items || []).filter((item: any) => String(item.code || '').trim() === sku).length;
        const unassigned = skuLineCount === 1 ? invoiceUnits.filter(unit => !(invoice.items || []).some((row: any) => row.lineId && row.lineId === unit.origin?.purchaseLineId) &&
          String(products.find(product => String(product._id) === unit.productId)?.code || '').trim() === sku) : [];
        [...exact, ...unassigned].forEach(unit => represented.add(String(unit._id)));
        const old = previous.find(row => line.lineId && row.lineId === line.lineId) ||
          (previous.filter(row => String(row.code || '').trim() === sku).length === 1 ? previous.find(row => String(row.code || '').trim() === sku) : null);
        const oldQty = Number(old?.qty || 0), delta = Number(line.qty || 0) - oldQty;
        const change = edit && delta ? { kind: !old ? 'added' : delta > 0 ? 'increased' : 'decreased', previousQuantity: oldQty, delta } : null;
        const onHand = (unit: any) => ['available', 'reserved', 'picking', 'prepared', 'returned', 'inspection-required', 'damaged', 'supplier-return-pending'].includes(unit.status);
        return { lineIndex, lineId: typeof line.lineId === 'string' ? line.lineId : '', sku: String(line.code || ''),
          name: String(line.name || line.productName || product?.name || ''), imageUrl, quantity: Number(line.qty) || 0, change,
          createdUnits: exact.length + unassigned.length, onHandUnits: [...exact, ...unassigned].filter(onHand).length, unassignedUnits: unassigned.length,
          printedUnits: [...exact, ...unassigned].filter(unit => (printCounts.get(String(unit._id)) || 0) > 0 || packCoverage.get(String(unit.packId))?.has(String(unit._id))).length,
          printRequests: [...exact, ...unassigned].reduce((sum, unit) => sum + (printCounts.get(String(unit._id)) || 0), 0) };
      }),
      get orphanedUnits() { return invoiceUnits.filter(unit => !represented.has(String(unit._id))).length; },
    }; });
    return paged ? { receipts, total: await this.connection.collection('transactions').countDocuments(filter), page, limit } : receipts;
  }

  /** Resolve the exact source line; fuzzy SKU search must never choose another product's labels. */
  async purchaseLineUnits(transactionId: string, lineIndex: number, query: Record<string, string> = {}) {
    if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) throw new BadRequestException('Invalid purchase line');
    const purchaseId = String(this.id(transactionId));
    const invoice = await this.connection.collection('transactions').findOne({ _id: this.id(purchaseId), type: '\u0645\u0634\u062a\u0631\u064a\u0627\u062a', archived: { $ne: true } });
    if (!invoice) throw new NotFoundException('Purchase invoice not found');
    const line = Array.isArray(invoice.items) ? invoice.items[lineIndex] : null;
    if (!line) throw new NotFoundException('Purchase line not found');
    const sku = String(line.code || '').trim();
    if (!sku) throw new ConflictException('Purchase line has no product SKU');
    const products = await this.connection.collection('products').find({ code: { $regex: '^\\s*' + escapeRegex(sku) + '\\s*$' } }, { projection: { _id: 1 } }).toArray();
    if (products.length !== 1) throw new ConflictException('Missing or duplicate SKU prevents exact unit selection');
    return this.search({ page: query.page, limit: query.limit }, { 'origin.purchaseTransactionId': purchaseId,
      productId: String(products[0]._id), ...purchaseLineOrigins(invoice.items, line) });
  }

  identifyPurchaseLine(transactionId: string, lineIndex: number, dto: IdentifyPurchaseLineDto, actor: TrackingActor) {
    const purchaseId = String(this.id(transactionId));
    return this.write(`purchase-line-identify:${purchaseId}:${lineIndex}`, dto, actor, 'inventory-units-receive', async (session, name) => {
      dto = { ...dto, warehouseCode: await requireWarehouse(this.connection, dto.warehouseCode, session) };
      if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || !dto.physicalPossessionConfirmed || !dto.reason?.trim() || !dto.warehouseCode?.trim()) {
        throw new BadRequestException('Physical possession, exact on-hand count, warehouse and evidence are required');
      }
      const purchase: any = await this.connection.collection('transactions').findOneAndUpdate({ _id: this.id(purchaseId),
        type: '\u0645\u0634\u062a\u0631\u064a\u0627\u062a', cancelled: { $ne: true }, archived: { $ne: true } },
      { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
      if (!purchase || /-RET$/i.test(String(purchase.ref || '').trim())) throw new ConflictException('Live supplier purchase invoice required');
      const lines = Array.isArray(purchase.items) ? purchase.items.map((item: any) => ({ ...item })) : [];
      const line = lines[lineIndex];
      if (!line || String(line.code || '').trim() !== String(dto.sku || '').trim() || line.qty !== dto.expectedQuantity ||
        !Number.isSafeInteger(line.qty) || line.qty < 1) throw new ConflictException('Purchase invoice line changed; reload before registration');
      const matchingSkuLines = lines.filter((item: any) => String(item.code || '').trim() === String(line.code || '').trim());
      const ids = new Set<string>();
      for (const item of lines) {
        if (!item.lineId) continue;
        if (typeof item.lineId !== 'string' || ids.has(item.lineId)) throw new ConflictException('Invoice has invalid or duplicate line identities');
        ids.add(item.lineId);
      }
      if (!line.lineId) {
        if (matchingSkuLines.length > 1) throw new ConflictException('Repeated SKU lines need reconciliation before line-specific barcode registration');
        line.lineId = randomUUID(); ids.add(line.lineId); lines[lineIndex] = line;
        await this.connection.collection('transactions').updateOne({ _id: purchase._id }, { $set: { items: lines } }, { session });
      }
      const products = await this.connection.collection('products').find({}, { session, projection: { _id: 1, code: 1 } }).toArray();
      const productMatches = products.filter((product: any) => String(product.code || '').trim() === String(line.code || '').trim());
      if (productMatches.length !== 1) throw new ConflictException('Missing or duplicate SKU prevents barcode registration');
      const product = await this.lockProduct(String(productMatches[0]._id), session);
      const invoiceUnits = await this.units.find({ productId: String(product._id), 'origin.purchaseTransactionId': purchaseId }).session(session).lean();
      const genericUnits = invoiceUnits.filter((unit: any) => !lines.some((row: any) => row.lineId && row.lineId === unit.origin?.purchaseLineId));
      if (matchingSkuLines.length > 1 && genericUnits.length) throw new ConflictException('Existing units cannot be safely assigned between repeated SKU lines');
      const physicallyPresent = (unit: any) => ['available', 'reserved', 'picking', 'prepared', 'returned', 'inspection-required', 'damaged', 'supplier-return-pending'].includes(unit.status);
      const attributedCount = invoiceUnits.filter((unit: any) => resolvePurchaseLine(lines, unit.origin?.purchaseLineId, String(line.code || '').trim()) === line && physicallyPresent(unit)).length;
      const purchaseQty = matchingSkuLines.reduce((sum: number, item: any) => sum + Number(item.qty || 0), 0);
      const allProductInvoiceUnits = await this.units.countDocuments({ productId: String(product._id), 'origin.purchaseTransactionId': purchaseId }).session(session);
      if (!Number.isSafeInteger(purchaseQty) || purchaseQty < line.qty || allProductInvoiceUnits > purchaseQty) throw new ConflictException('Purchase identity quantity exceeds its invoice lines; reconcile before adding units');
      if (dto.physicalQuantity < attributedCount || dto.physicalQuantity > line.qty) throw new BadRequestException(`Confirmed physical quantity must be between ${attributedCount} and ${line.qty}`);
      const missing = dto.physicalQuantity - attributedCount;
      if (!missing) throw new ConflictException('The confirmed physical units already have identities');
      if (allProductInvoiceUnits + missing > purchaseQty) throw new ConflictException('Barcode registration would exceed the invoice quantity');
      await this.assertWarehouseRegistration(String(product._id), dto.warehouseCode, missing, session);
      const now = new Date(), pieces: any[] = [], events: any[] = [];
      for (let i = 0; i < missing; i++) {
        const unit = new this.units({ productId: String(product._id), status: 'inspection-required', warehouseCode: dto.warehouseCode.trim(),
          origin: { kind: 'purchase', purchaseTransactionId: purchaseId, purchaseLineId: line.lineId, reconciliationRef: `post-invoice:${purchaseId}` },
          registeredByUserId: actor.userId, registeredBy: name });
        await unit.validate();
        const event = new this.events({ unitId: String(unit._id), sequence: 1,
          operationKey: digest({ actor: actor.userId!.toLowerCase(), key: dto.operationKey }), action: 'registered', fromStatus: null,
          toStatus: unit.status, transactionId: purchaseId, lineId: line.lineId, byUserId: actor.userId, by: name, reason: dto.reason,
          details: { warehouseCode: dto.warehouseCode.trim(), physicalPossessionConfirmed: true, physicalQuantity: dto.physicalQuantity, registrationKind: 'post-invoice' } });
        await event.validate();
        pieces.push({ ...unit.toObject(), __v: 0, createdAt: now, updatedAt: now });
        events.push({ ...event.toObject(), createdAt: now, updatedAt: now });
      }
      await this.units.collection.insertMany(pieces, { session, ordered: true });
      await this.events.collection.insertMany(events, { session, ordered: true });
      return { transactionId: purchaseId, lineId: line.lineId, sku: line.code, expectedQuantity: line.qty,
        previouslyIdentified: attributedCount, createdUnits: pieces.length, unitIds: pieces.map(piece => String(piece._id)),
        status: 'inspection-required', warehouseCode: dto.warehouseCode.trim(), stockChanged: false, physicalPrintingVerified: false };
    });
  }

  async lookup(identifier: string) {
    const packCode = identifier.trim().replace(/^\][A-Za-z]\d/, '').toUpperCase();
    if (/^PK/i.test(packCode) || /^\d{7}$/.test(packCode)) identifier = packCode;
    if (/^PK/i.test(identifier) || /^\d{7}$/.test(identifier)) {
      const result = await this.lookupPack(identifier);
      if (!result) throw new NotFoundException('Pack not found');
      return result;
    }
    const unit: any = await this.units.findOne(await this.identifierFilter(identifier)).lean();
    if (!unit) throw new NotFoundException('Unit not found');
    const order: any = unit.assignment?.transactionId && OBJECT_ID_PATTERN.test(String(unit.assignment.transactionId))
      ? await this.connection.collection('transactions').findOne({ _id: this.id(unit.assignment.transactionId), type: 'مبيعات' },
        { projection: { ref: 1, date: 1, createdAt: 1, client: 1, pickupStatus: 1, prepChecked: 1, cancelled: 1, archived: 1 } }) : null;
    const assignmentOrder = order ? { transactionId: String(order._id), ref: String(order.ref || ''), client: String(order.client || ''),
      date: order.date || null, createdAt: order.createdAt || null, pickupStatus: order.pickupStatus || '', prepChecked: order.prepChecked === true, cancelled: order.cancelled === true, archived: order.archived === true } : null;
    const purchase: any = unit.origin?.purchaseTransactionId ? await this.connection.collection('transactions').findOne({ _id: this.id(unit.origin.purchaseTransactionId), type: 'مشتريات' },
      { projection: { ref: 1, date: 1, createdAt: 1 } }) : null;
    const purchaseInvoice = purchase ? { transactionId: String(purchase._id), ref: purchase.ref || '', date: purchase.date || null, createdAt: purchase.createdAt || null } : null;
    const [identified] = await this.withManualCodes([unit]);
    return { unit: identified, assignmentOrder, purchaseInvoice, supplierReturn: await this.supplierReturnInfo(unit), events: await this.events.find({ unitId: String(unit._id) }).sort({ sequence: -1 }).limit(200).lean() };
  }

  async lookupPack(identifier: string, session?: ClientSession) {
    const pack: any = await this.connection.collection('inventorypacks').findOne(packCodeFilter(identifier), { session });
    if (!pack) return null;
    const members: any[] = await this.units.find({ _id: { $in: pack.unitIds.map((id: string) => this.id(id)) } }).session(session || null).lean();
    const valid = members.length === pack.quantity && members.every(u => u.packId === String(pack._id));
    const statuses = new Set(members.map(u => u.status));
    const assignment = members[0]?.assignment;
    const sameAssignment = assignment && members.every(u => u.assignment?.transactionId === assignment.transactionId && u.assignment?.lineId === assignment.lineId);
    const order: any = sameAssignment ? await this.connection.collection('transactions').findOne({ _id: this.id(assignment.transactionId) }, { session, projection: { ref: 1, client: 1, pickupStatus: 1, prepChecked: 1 } }) : null;
    return { unit: { _id: String(pack._id), barcode: pack.barcode, manualCode: await manualPackCode(this.connection,pack,session), productId: pack.productId,
      warehouseCode: pack.warehouseCode, packId: String(pack._id), quantity: pack.quantity, isPack: true,
      status: pack.state === 'opened' ? 'opened' : !valid ? 'inconsistent' : statuses.size === 1 ? members[0].status : 'mixed',
      assignment: sameAssignment ? assignment : null },
      pack: { id: String(pack._id), state: pack.state, quantity: pack.quantity }, supplierReturn: null,
      assignmentOrder: order ? { transactionId: String(order._id), ref: order.ref || '', client: order.client || '', pickupStatus: order.pickupStatus || '', prepChecked: order.prepChecked === true } : null, events: [] };
  }

  purchaseOperation(id: string, dto: TrackingRequestDto, actor: TrackingActor,
    work: (session: ClientSession, name: string, context: DatabaseWriteContext) => Promise<any>) {
    return this.write(`purchase-receive:${String(this.id(id))}`, dto, actor, 'purchase-create', work);
  }

  scanOperation(dto: TrackingRequestDto, actor: TrackingActor,
    work: (session: ClientSession, name: string) => Promise<any>) {
    return this.write('scan-validation', dto, actor, 'inventory-units-view', work);
  }

  packOperation(kind: string, dto: TrackingRequestDto, actor: TrackingActor,
    work: (session: ClientSession, actorName: string, context: DatabaseWriteContext) => Promise<any>, permission = 'inventory-units-allocate') {
    return this.write(`pack-${kind}`,dto,actor,permission,work);
  }

  async packOperationResult(key: string, actor: TrackingActor) {
    this.require(actor,'inventory-units-view');
    if (!/^[A-Za-z0-9:_-]{8,120}$/.test(key)) throw new BadRequestException('Invalid operation key');
    const receipt:any=await this.operations.findOne({_id:digest({actor:actor.userId!.toLowerCase(),key}),kind:'pack-create'}).lean();
    return receipt ? {state:'resolved',result:receipt.result} : {state:'unresolved'};
  }

  manualPurchaseOperation(dto: TrackingRequestDto, actor: TrackingActor,
    work: (session: ClientSession, name: string, context: DatabaseWriteContext) => Promise<any>) {
    return this.write('manual-purchase-receive', dto, actor, 'purchase-create', work);
  }

  /** Validated bulk writer: references are verified once inside the receipt transaction, never inferred from balances. */
  async createReceiptUnits(purchase: any, purchaseOrderId: string | undefined, warehouseCode: string, dto: TrackingRequestDto,
    actor: TrackingActor, name: string, session: ClientSession, inspectionPassed = false) {
    this.require(actor, 'inventory-units-receive');
    warehouseCode = await requireWarehouse(this.connection, warehouseCode, session);
    if (normalizeWarehouseCode(purchase.warehouseCode) !== warehouseCode) throw new ConflictException('مخزن القطع يجب أن يطابق مخزن فاتورة الشراء');
    const total = purchase.items.reduce((sum: number, item: any) => sum + item.qty, 0);
    if (!Number.isSafeInteger(total) || total <= 0 || total > 10000 || !warehouseCode?.trim()) throw new BadRequestException('استلام التتبع يتطلب موقعاً صريحاً و1–10000 قطعة صحيحة العدد');
    const products = new Map<string, any>();
    for (const id of [...new Set<string>(purchase.items.map((item: any) => item.productId))].sort()) products.set(id, await this.lockProduct(id, session));
    if (await this.units.exists({ 'origin.purchaseTransactionId': String(purchase._id) }).session(session)) throw new ConflictException('Invoice already has tracked units; reconcile rather than duplicating');
    const pieces: any[] = [], events: any[] = [], now = new Date();
    for (const line of purchase.items) {
      const product = products.get(line.productId);
      if (!product || String(product.code).trim() !== String(line.code).trim() || !line.lineId || !Number.isSafeInteger(line.qty) || line.qty < 1) throw new ConflictException('Invalid purchase line identity/product/quantity');
      for (let i = 0; i < line.qty; i++) {
        const unit = new this.units({ productId: String(product._id), status: inspectionPassed === true ? 'available' : 'inspection-required', warehouseCode: warehouseCode.trim(),
          origin: { kind: 'purchase', purchaseTransactionId: String(purchase._id), purchaseLineId: line.lineId, purchaseOrderId,
            reconciliationRef: `receipt:${purchaseOrderId || purchase._id}` }, registeredByUserId: actor.userId, registeredBy: name });
        await unit.validate();
        const event = new this.events({ unitId: String(unit._id), sequence: 1, operationKey: digest({ actor: actor.userId!.toLowerCase(), key: dto.operationKey }),
          action: 'registered', fromStatus: null, toStatus: unit.status, transactionId: String(purchase._id), lineId: line.lineId,
          byUserId: actor.userId, by: name, reason: dto.reason, details: { purchaseOrderId, warehouseCode: warehouseCode.trim(), physicalPossessionConfirmed: true,
            inspectionPassed: inspectionPassed === true, inspectionAtReceipt: inspectionPassed === true } });
        await event.validate();
        pieces.push({ ...unit.toObject(), __v: 0, createdAt: now, updatedAt: now });
        events.push({ ...event.toObject(), createdAt: now, updatedAt: now });
      }
    }
    // Raw inserts intentionally follow complete document/cross-reference validation above; normal model bulk APIs stay blocked.
    await this.units.collection.insertMany(pieces, { session, ordered: true });
    await this.events.collection.insertMany(events, { session, ordered: true });
    return { createdUnits: pieces.length, unitIds: pieces.map(piece => String(piece._id)), status: inspectionPassed === true ? 'available' : 'inspection-required', warehouseCode: warehouseCode.trim(),
      lines: purchase.items.map((line: any) => ({ lineId: line.lineId, productId: line.productId, sku: line.code, receivedQty: line.qty, createdUnits: line.qty })),
      printStatus: 'not-requested', physicalPrintingVerified: false, unresolvedErrors: [] };
  }

  private async assertWarehouseRegistration(productId: string, location: string, count: number, session: ClientSession) {
    const inventory = await this.transactions.getInventory(session);
    const row = inventory.find(item => item._id === productId);
    const aliases = location === 'MAIN' ? ['MAIN', 'main', 'المخزن الرئيسي', '', null] : [location];
    const represented = await this.units.countDocuments({ productId, warehouseCode: { $in: aliases }, assignment: null,
      status: { $in: ['available', 'returned', 'inspection-required', 'damaged', 'supplier-return-pending'] } }).session(session);
    if (represented + count > Number(row?.warehouseBalances?.[location] || 0)) throw new ConflictException('أكواد القطع تتجاوز الرصيد المتاح في المخزن المختار؛ راجع المخزن والجرد');
  }

  async legacyStockSummary(productId: string, warehouseCode: string, session?: ClientSession) {
    const product: any = await this.connection.collection('products').findOne({ _id: this.id(productId) }, { session,
      projection: { name: 1, code: 1, imageUrl: 1 } });
    if (!product) throw new NotFoundException('Product not found');
    const location = await requireWarehouse(this.connection, warehouseCode, session);
    const inventory = await this.transactions.getInventory(session);
    const row = inventory.find(item => String(item._id) === String(product._id));
    const balance = Number(row?.warehouseBalances?.[location] || 0);
    const aliases = location === 'MAIN' ? ['MAIN', 'main', 'المخزن الرئيسي', '', null] : [location];
    const units = await this.units.find({ productId: String(product._id), warehouseCode: { $in: aliases },
      status: { $in: ['available', 'returned', 'inspection-required', 'damaged', 'supplier-return-pending', 'reserved', 'picking', 'prepared'] } })
      .select('_id status assignment').session(session || null).lean();
    const registered = units.filter((unit: any) => !unit.assignment).length;
    return { product: { _id: String(product._id), name: product.name, code: product.code, imageUrl: product.imageUrl || '' },
      warehouseCode: location, balance, registered, assigned: units.length - registered,
      missing: Math.max(0, balance - registered), discrepancy: registered > balance || !Number.isSafeInteger(balance) || balance < 0 };
  }

  identifyLegacyStock(dto: LegacyStockIdentifyDto, actor: TrackingActor) {
    return this.write('legacy-stock-identify', dto, actor, 'inventory-units-register', async (session, name) => {
      const product = await this.lockProduct(dto.productId, session);
      const summary = await this.legacyStockSummary(String(product._id), dto.warehouseCode, session);
      const fail = (code: string) => { throw new ConflictException({ code, message: code }); };
      if (!dto.physicalPossessionConfirmed || !dto.inspectionPassed) fail('LEGACY_CONFIRMATION_REQUIRED');
      if (summary.balance !== dto.expectedBalance || summary.registered !== dto.expectedRegistered) fail('LEGACY_STOCK_CHANGED');
      if (summary.discrepancy) fail('LEGACY_STOCK_MISMATCH');
      if (dto.physicalQuantity > summary.balance || dto.physicalQuantity < summary.registered) fail('LEGACY_COUNT_OUT_OF_RANGE');
      const count = dto.physicalQuantity - summary.registered;
      if (count < 1) fail('LEGACY_ALREADY_CODED');
      if (count > 100) fail('LEGACY_BATCH_LIMIT');
      await this.assertWarehouseRegistration(String(product._id), summary.warehouseCode, count, session);
      const reference = `legacy-stock:${digest({ actor: actor.userId, key: dto.operationKey }).slice(0, 24)}`;
      const pieces: any[] = [], events: any[] = [], now = new Date();
      for (let i = 0; i < count; i++) {
        const unit = new this.units({ productId: String(product._id), status: 'available', warehouseCode: summary.warehouseCode,
          origin: { kind: 'legacy-unknown', reconciliationRef: reference }, registeredByUserId: actor.userId, registeredBy: name });
        await unit.validate();
        const event = new this.events({ unitId: String(unit._id), sequence: 1, action: 'registered', fromStatus: null, toStatus: 'available',
          operationKey: digest({ actor: actor.userId!.toLowerCase(), key: dto.operationKey }), byUserId: actor.userId, by: name, reason: dto.reason,
          details: { source: 'legacy-stock', warehouseCode: summary.warehouseCode, physicalPossessionConfirmed: true, inspectionPassed: true,
            physicalQuantity: dto.physicalQuantity, previousRegistered: summary.registered, balanceAtRegistration: summary.balance } });
        await event.validate();
        pieces.push({ ...unit.toObject(), __v: 0, createdAt: now, updatedAt: now });
        events.push({ ...event.toObject(), createdAt: now, updatedAt: now });
      }
      // Product/user/warehouse were verified inside this transaction; no purchase provenance is inferred.
      await this.units.collection.insertMany(pieces, { session, ordered: true });
      await this.events.collection.insertMany(events, { session, ordered: true });
      return { reference, productId: String(product._id), warehouseCode: summary.warehouseCode, createdUnits: count,
        unitIds: pieces.map(piece => String(piece._id)), registered: summary.registered + count, balance: summary.balance,
        stockChanged: false, status: 'available' };
    });
  }

  register(dto: RegisterUnitDto, actor: TrackingActor) {
    return this.write('register', dto, actor, 'inventory-units-register', async (session, name) => {
      dto = { ...dto, warehouseCode: await requireWarehouse(this.connection, dto.warehouseCode, session) };
      if (!dto.physicalPossessionConfirmed || !dto.countReference?.trim() || !Number.isSafeInteger(dto.observedPhysicalCount) || dto.observedPhysicalCount < 1) throw new BadRequestException('Positive physical count, count reference and possession confirmation required');
      const product = await this.lockProduct(dto.productId, session);
      const earlier: any = await this.operations.findOne({ kind: 'register', 'result.unit.productId': String(product._id),
        'result.attestation.reference': dto.countReference.trim() }).session(session).lean();
      if (earlier && earlier.result.attestation.observedPhysicalCount !== dto.observedPhysicalCount) throw new ConflictException('Physical count reference reused with a different observed count');
      const existing = await this.units.countDocuments({ productId: String(product._id), 'origin.reconciliationRef': dto.countReference.trim() }).session(session);
      if (existing >= dto.observedPhysicalCount) throw new ConflictException('Registration exceeds this attested physical count');
      const origin: any = { kind: dto.originKind, reconciliationRef: dto.countReference.trim() };
      if (dto.originKind === 'purchase') {
        origin.purchaseTransactionId = dto.purchaseTransactionId;
        const purchase = await this.connection.collection('transactions').findOne({ _id: this.id(dto.purchaseTransactionId!) }, { session });
        if (!purchase || purchase.cancelled || purchase.archived || purchase.type !== 'مشتريات' || /-RET$/i.test(String(purchase.ref || '').trim()) ||
          String(purchase.notes || '').includes('مرتجع معتمد (طلب كان معلقاً)') || String(purchase.notes || '').startsWith('استبدال — مرتجع:')) throw new BadRequestException('Live supplier receipt required');
        const quantity = (purchase?.items || []).filter((item: any) => String(item.code || '').trim() === String(product.code).trim()).reduce((sum: number, item: any) => sum + Number(item.qty), 0);
        const registered = await this.units.countDocuments({ productId: String(product._id), 'origin.purchaseTransactionId': dto.purchaseTransactionId?.toLowerCase() }).session(session);
        if (!Number.isSafeInteger(quantity) || registered >= quantity) throw new ConflictException('Receipt quantity exhausted or invalid');
      } else if (dto.purchaseTransactionId) throw new BadRequestException('Unknown/opening history cannot claim a purchase');
      if (dto.originKind === 'opening-stock') {
        const existingOpening = await this.units.countDocuments({ productId: String(product._id), 'origin.kind': 'opening-stock' }).session(session);
        if (!Number.isSafeInteger(product.openingBalance) || product.openingBalance <= existingOpening) throw new ConflictException('Verified opening-stock quantity exhausted or invalid');
        origin.openingStockProductId = String(product._id);
      }
      await this.assertWarehouseRegistration(String(product._id), dto.warehouseCode!, 1, session);
      const unit = new this.units({ productId: String(product._id), origin, status: 'inspection-required', warehouseCode: dto.warehouseCode?.trim() || null,
        registeredByUserId: actor.userId, registeredBy: name });
      await unit.save({ session });
      await this.event(unit, 'registered', null, dto, actor, name, session);
      return { unit: unit.toObject(), attestation: { reference: dto.countReference.trim(), observedPhysicalCount: dto.observedPhysicalCount }, stockChanged: false, enforcementEnabled: false };
    });
  }

  identifyLines(transactionId: string, dto: TrackingRequestDto, actor: TrackingActor) {
    return this.write(`identify-lines:${transactionId}`, dto, actor, 'inventory-units-allocate', async session => {
      const collection = this.connection.collection('transactions');
      const sale = await collection.findOne({ _id: this.id(transactionId), type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true } }, { session });
      if (!sale) throw new ConflictException('Live sale required');
      const ids = new Set<string>();
      const items = sale.items.map((item: any) => {
        const lineId = item.lineId || randomUUID();
        if (typeof lineId !== 'string' || ids.has(lineId)) throw new ConflictException('Invalid/duplicate existing sale line IDs');
        ids.add(lineId); return { ...item, lineId };
      });
      await collection.updateOne({ _id: sale._id }, { $set: { items }, $inc: { unitTrackingRevision: 1 } }, { session });
      return { transactionId, items, stockChanged: false };
    });
  }

  async pickingSummary(transactionId: string) {
    const sale: any = await this.connection.collection('transactions').findOne({ _id: this.id(transactionId), type: 'مبيعات' },
      { projection: { items: 1, prepChecked: 1, pickingExceptions: 1 } });
    if (!sale) throw new NotFoundException('Live sale not found');
    const items = (sale.items || []).map((line: any) => ({ ...line, lineId: line.lineId || null }));
    const lineIds = items.map((line: any) => line.lineId).filter(Boolean);
    const units = lineIds.length ? await this.units.find({ 'assignment.transactionId': String(sale._id), 'assignment.lineId': { $in: lineIds },
      status: { $in: allocatedStatuses } }).select('_id barcode productId status assignment packId __v updatedAt').lean() : [];
    const catalog = await this.connection.collection('products').find({}, { projection: { _id: 1, name: 1, code: 1 } }).toArray();
    const identified = await this.withManualCodes(units);
    const packIds = [...new Set(units.map((unit:any)=>unit.packId).filter(Boolean))];
    const packs = packIds.length ? await this.connection.collection('inventorypacks').find({_id:{$in:packIds.map(id=>this.id(String(id)))}}).toArray() : [];
    const packCodes = new Map(await Promise.all(packs.map(async pack=>[String(pack._id),await manualPackCode(this.connection,pack)] as const)));
    return { transactionId: String(sale._id), prepChecked: sale.prepChecked === true,
      lines: await Promise.all(items.map(async (line: any) => {
        const product = catalog.find(row => String(row.code || '').trim() === String(line.code || '').trim());
        const matches = identified.filter((unit: any) => unit.assignment?.lineId === line.lineId &&
          String(catalog.find(row => String(row._id) === unit.productId)?.code || '').trim() === String(line.code || '').trim());
        const availableCount = product ? await this.units.countDocuments({ productId: String(product._id), status: 'available', assignment: null }) : 0;
        return { lineId: line.lineId, productId: line.productId || product?._id?.toString() || null,
          sku: line.code, qty: line.qty, availableCount, exceptions: pickingExceptions(sale, line), skippedCount: pickingExceptions(sale, line).length, units: matches.map((unit: any) => ({ unitId: String(unit._id), barcode: unit.barcode, packId: unit.packId || null, packManualCode:packCodes.get(String(unit.packId)) || null, manualCode: unit.manualCode, status: unit.status, version: unit.__v, updatedAt: unit.updatedAt })) };
      })) };
  }

  /** Invoice view uses live assignments plus immutable dispatch/return facts. Undo never deletes audit history. */
  // A physical receipt never posts money or stock a second time. Only an existing
  // cancellation / approved return can supply the entitlement to resell a piece.
  private async customerReturnCredited(unit: any, saleId: string, session: ClientSession) {
    const sale: any = await this.connection.collection('transactions').findOne({ _id: this.id(saleId), type: 'مبيعات' }, { session });
    if (!sale || normalizeWarehouseCode(sale.warehouseCode) !== normalizeWarehouseCode(unit.warehouseCode)) return false;
    if (sale.cancelled && sale.failedDelivery?.outcome !== 'lost') return true;
    const product: any = await this.connection.collection('products').findOne({ _id: this.id(unit.productId) }, { session });
    const requests = await this.connection.collection('returnrequests').find({ originalTransactionId: saleId, status: 'معتمد',
      $or: [{ reversedAt: { $exists: false } }, { reversedAt: null }, { reversedAt: '' }] }, { session }).toArray();
    let credit = 0;
    for (const request of requests) {
      if (!OBJECT_ID_PATTERN.test(String(request.returnTxId || ''))) continue;
      const tx: any = await this.connection.collection('transactions').findOne({ _id: this.id(request.returnTxId),
        type: { $in: ['مرتجع', 'مرتجع مبيعات'] }, cancelled: { $ne: true }, archived: { $ne: true } }, { session });
      if (!tx || normalizeWarehouseCode(tx.warehouseCode) !== normalizeWarehouseCode(unit.warehouseCode)) continue;
      credit += (tx.items || []).filter((line: any) => String(line.code || '').trim() === String(product?.code || '').trim() && line.condition !== 'تالف')
        .reduce((sum: number, line: any) => sum + Math.max(0, Number(line.qty) || 0), 0);
    }
    const released = await this.events.distinct('unitId', { action: 'inspection-passed',
      'details.customerReturnSaleId': saleId, 'details.productId': String(unit.productId) }).session(session);
    const consumed = new Set(released.map(String));
    // Include receipts released by older versions, before the settlement marker
    // existed, so a partial refund cannot make a second physical piece sellable.
    const receipts: any[] = await this.events.find({ transactionId: saleId, action: 'returned' }).session(session).lean();
    for (const receipt of receipts) {
      if (consumed.has(String(receipt.unitId))) continue;
      const sameProduct = await this.units.exists({ _id: this.id(receipt.unitId), productId: String(unit.productId) }).session(session);
      if (!sameProduct) continue;
      const inspected = await this.events.exists({ unitId: receipt.unitId, action: 'inspection-passed', sequence: { $gt: receipt.sequence } }).session(session);
      if (inspected) consumed.add(String(receipt.unitId));
    }
    return credit > consumed.size;
  }

  async customerReturnCandidates(transactionId: string) {
    const data = await this.invoiceIdentities(transactionId);
    const rows: any[] = [];
    for (const line of data.lines) for (const identity of [...line.current, ...line.history]) {
      if (identity.matchesProduct === false) continue;
      if (!(identity.active && ['shipped', 'delivered'].includes(identity.orderStatus)) &&
        !(identity.returnedAt && identity.status === 'returned')) continue;
      const unit: any = await this.units.findById(identity.unitId).lean();
      if (!unit || unit.packId || (identity.returnedAt && unit.assignment)) continue;
      if (identity.returnedAt) {
        const last: any = await this.events.findOne({ unitId: identity.unitId, action: 'returned' }).sort({ sequence: -1 }).lean();
        if (last?.transactionId !== data.transactionId) continue;
      }
      const product: any = await this.connection.collection('products').findOne({ _id: this.id(unit.productId) }, { projection: { name: 1 } });
      rows.push({ ...identity, name: product?.name || line.sku, sku: line.sku, lineId: line.lineId, expectedVersion: unit.__v,
        received: !!identity.returnedAt });
    }
    return { transactionId: data.transactionId, warehouseCode: data.warehouseCode, pieces: rows };
  }

  receiveCustomerPiece(transactionId: string, dto: ReceiveCustomerPieceDto, actor: TrackingActor) {
    const saleId = String(this.id(transactionId));
    dto = { ...dto, reason: dto.reason?.trim() || 'استلام مرتجع بدون ملصق' };
    return this.write(`customer-piece-return:${saleId}`, dto, actor, 'inventory-units-condition', async (session, name, context) => {
      if (!dto.physicalPossessionConfirmed) throw new BadRequestException({ code: 'RETURN_CUSTODY_REQUIRED', message: 'أكد استلام القطعة فعليًا أولًا' });
      const unit: any = await this.units.findById(this.id(dto.unitId)).session(session);
      if (!unit) throw new NotFoundException('Unit not found');
      await this.lockProduct(unit.productId, session);
      if (unit.packId || unit.__v !== dto.expectedVersion) throw new ConflictException({ code: 'RETURN_PIECE_CHANGED', message: 'تغيرت بيانات القطعة؛ حدّث القائمة أولًا' });
      const sale: any = await this.connection.collection('transactions').findOneAndUpdate({ _id: this.id(saleId), type: 'مبيعات' },
        { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
      if (!sale) throw new NotFoundException('Sales invoice not found');
      let received = false;
      if (unit.status === 'returned' && !unit.assignment) {
        const last: any = await this.events.findOne({ unitId: String(unit._id), action: 'returned' }).sort({ sequence: -1 }).session(session).lean();
        if (last?.transactionId !== saleId) throw new ConflictException({ code: 'RETURN_WRONG_ORDER', message: 'هذه القطعة لا تخص مرتجع هذا الطلب' });
        if (dto.condition === 'review') throw new ConflictException({ code: 'RETURN_ALREADY_RECEIVED', message: 'تم استلام هذه القطعة بالفعل' });
        received = true;
      } else {
        if (unit.assignment?.transactionId !== saleId || !['prepared', 'shipped', 'delivered'].includes(unit.status)) {
          throw new ConflictException({ code: 'RETURN_WRONG_ORDER', message: 'القطعة ليست ضمن شحنة هذا الطلب أو تم استلامها بالفعل' });
        }
        const product: any = await this.connection.collection('products').findOne({ _id: this.id(unit.productId) }, { session });
        if (!sale.items?.some((line: any) => line.lineId === unit.assignment.lineId && String(line.code || '').trim() === String(product?.code || '').trim())) {
          throw new ConflictException({ code: 'RETURN_WRONG_ORDER', message: 'تغير صنف الفاتورة؛ راجع هوية القطعة قبل الاستلام' });
        }
        await this.actionInSession(String(unit._id), { ...dto, action: 'return' }, actor, session, name, undefined, context);
      }
      const fresh: any = await this.units.findById(unit._id).session(session);
      let pendingSettlement = false;
      if (dto.condition === 'damaged') {
        await this.actionInSession(String(unit._id), { ...dto, operationKey: dto.operationKey + ':condition', expectedVersion: fresh.__v, action: 'damage' }, actor, session, name, undefined, context);
      } else if (dto.condition === 'sound') {
        if (await this.customerReturnCredited(fresh, saleId, session)) {
          await this.actionInSession(String(unit._id), { ...dto, operationKey: dto.operationKey + ':condition', expectedVersion: fresh.__v, action: 'inspect', inspectionPassed: true }, actor, session, name, undefined, context);
        } else pendingSettlement = true;
      }
      const result: any = await this.units.findById(unit._id).session(session).lean();
      return { unit: result, transactionId: saleId, receivedPreviously: received, pendingSettlement, stockChanged: false };
    });
  }

  async invoiceIdentities(transactionId: string) {
    const sale: any = await this.connection.collection('transactions').findOne({ _id: this.id(transactionId), type: 'مبيعات' },
      { projection: { items: 1, warehouseCode: 1, pickupStatus: 1, shippedAt: 1, deliveredAt: 1, bostaStatus: 1, cancelled: 1, pickingExceptions: 1 } });
    if (!sale) throw new NotFoundException('Sales invoice not found');
    const id = String(sale._id);
    const [assigned, facts] = await Promise.all([
      this.units.find({ 'assignment.transactionId': id }).lean(),
      this.events.find({ transactionId: id, action: { $in: ['picking-started', 'picking-undone', 'prepared', 'shipped', 'delivered', 'returned', 'released'] } })
        .sort({ sequence: 1 }).lean(),
    ]);
    const historyIds = [...new Set(facts.filter((event: any) => ['shipped', 'delivered', 'returned'].includes(event.action)).map((event: any) => event.unitId))];
    const historical: any[] = historyIds.length ? await this.units.find({ _id: { $in: historyIds.map(unitId => this.id(String(unitId))) } }).lean() : [];
    const byId = new Map<string, any>([...assigned, ...historical].map((unit: any) => [String(unit._id), unit]));
    for (const unit of await this.withManualCodes([...byId.values()])) byId.set(String(unit._id), unit);
    const productIds = [...new Set([...byId.values()].map(unit => String(unit.productId)))];
    const products = productIds.length ? await this.connection.collection('products').find({ _id: { $in: productIds.map(productId => this.id(productId)) } }, { projection: { code: 1 } }).toArray() : [];
    const matchesProduct = (unit: any, line: any) => line.productId ? String(line.productId) === String(unit.productId) :
      products.some(product => String(product._id) === String(unit.productId) && String(product.code || '').trim() === String(line.code || '').trim());
    const makeIdentity = (unit: any, lineId: string, active: boolean) => {
      const events: any[] = facts.filter((event: any) => event.unitId === String(unit._id) && event.lineId === lineId);
      const last = (action: string) => { const matches = events.filter(event => event.action === action); return matches[matches.length - 1]; };
      const returned = last('returned'), shipped = last('shipped'), delivered = last('delivered');
      const prepared = last('prepared'), picked = last('picking-started');
      // Order status may confirm dispatch before a separate identity lifecycle event is written.
      // Expose that provenance explicitly; never mutate physical identity history during a read.
      const orderDelivered = sale.pickupStatus === 'Delivered' || sale.bostaStatus === 'DELIVERED';
      const orderShipped = !!sale.shippedAt || ['Shipped', 'Delivered'].includes(sale.pickupStatus);
      const fromOrder = active && unit.status === 'prepared' && !returned && (orderShipped || orderDelivered);
      const orderStatus = returned ? 'returned' : delivered ? 'delivered' : shipped ? 'shipped' : fromOrder ? (orderDelivered ? 'delivered' : 'shipped') : unit.status;
      return { unitId: String(unit._id), barcode: unit.barcode, manualCode: byId.get(String(unit._id))?.manualCode, status: unit.status, orderStatus, active,
        statusSource: returned || shipped || delivered ? 'unit-event' : fromOrder ? 'order' : 'unit',
        scannedAt: picked?.createdAt || null, scannedBy: picked?.by || null, preparedAt: prepared?.createdAt || null,
        shippedAt: shipped?.createdAt || returned?.details?.orderShippedAt || (fromOrder ? sale.shippedAt || null : null),
        deliveredAt: delivered?.createdAt || (fromOrder && orderDelivered ? sale.deliveredAt || null : null),
        returnedAt: returned?.createdAt || null, returnedBy: returned?.by || null,
        returnWarehouseCode: returned?.details?.toWarehouseCode || returned?.details?.fromWarehouseCode || null,
        warehouseCode: unit.warehouseCode || null };
    };
    const lines = (sale.items || []).map((line: any) => {
      const lineId = line.lineId || null;
      // A reservation restored by undo is not a scanned invoice identity.
      const current = lineId ? assigned.filter((unit: any) => unit.assignment?.lineId === lineId && matchesProduct(unit, line) &&
        ['picking', 'prepared', 'shipped', 'delivered', 'damaged', 'lost'].includes(unit.status)).map((unit: any) => makeIdentity(unit, lineId, true)) : [];
      const currentIds = new Set(current.map((unit: any) => unit.unitId));
      const dispatchedIds = [...new Set(facts.filter((event: any) => event.lineId === lineId && ['shipped', 'delivered', 'returned'].includes(event.action)).map((event: any) => event.unitId))];
      const history = dispatchedIds.filter(unitId => !currentIds.has(String(unitId)) && byId.has(String(unitId)))
        .map(unitId => ({ ...makeIdentity(byId.get(String(unitId)), lineId, false), matchesProduct: matchesProduct(byId.get(String(unitId)), line) }));
      const mismatchedAssignments = lineId ? assigned.filter((unit: any) => unit.assignment?.lineId === lineId &&
        ['picking', 'prepared', 'shipped', 'delivered'].includes(unit.status) && !matchesProduct(unit, line)).length : 0;
      return { lineId, sku: line.code, productId: line.productId || null, qty: line.qty, current, history,
        skippedCount: pickingExceptions(sale, line).length, mismatchedAssignments };
    });
    const lineIds = new Set(lines.map((line: any) => line.lineId).filter(Boolean));
    const removedLines = [...new Set(facts.filter((event: any) => event.lineId && !lineIds.has(event.lineId) &&
      ['shipped', 'delivered', 'returned'].includes(event.action)).map((event: any) => event.lineId))].map(lineId => ({ lineId,
        identities: [...new Set(facts.filter((event: any) => event.lineId === lineId && ['shipped', 'delivered', 'returned'].includes(event.action)).map((event: any) => event.unitId))]
          .filter(unitId => byId.has(String(unitId))).map(unitId => makeIdentity(byId.get(String(unitId)), String(lineId), false)) }));
    return { transactionId: id, warehouseCode: sale.warehouseCode || 'MAIN', lines, removedLines };
  }

  pickException(transactionId: string, dto: OrderPickExceptionDto, actor: TrackingActor) {
    return this.write(`order-pick-exception:${String(this.id(transactionId))}`, dto, actor, 'inventory-units-allocate', async (session, name, context) => {
      if (!dto.lineId?.trim() || !['skip', 'undo'].includes(dto.action)) throw new BadRequestException('Exact line and exception action required');
      const collection = this.connection.collection('transactions');
      const sale: any = await collection.findOneAndUpdate({ _id: this.id(transactionId), type: 'مبيعات', pickupStatus: 'Preparing', cancelled: { $ne: true }, archived: { $ne: true }, shippedAt: { $in: [null, ''] }, deliveredAt: { $in: [null, ''] },
        ...(dto.action === 'skip' ? { prepChecked: { $ne: true } } : {}) },
        { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
      if (!sale) {
        const current: any = await collection.findOne({ _id: this.id(transactionId), type: 'مبيعات' }, { session,
          projection: { cancelled: 1, archived: 1, pickupStatus: 1, prepChecked: 1, shippedAt: 1, deliveredAt: 1 } });
        const code = !current ? 'ORDER_NOT_FOUND' : current.cancelled || current.archived ? 'ORDER_INACTIVE' :
          current.shippedAt || current.deliveredAt || ['Shipped', 'Delivered', 'Picked-Up'].includes(current.pickupStatus) ? 'ORDER_DISPATCHED' :
          current.prepChecked && dto.action === 'skip' ? 'ORDER_ALREADY_PREPARED' : 'ORDER_NOT_PREPARING';
        throw new ConflictException({ code, message: 'An active order awaiting preparation is required' });
      }
      const lines = (sale.items || []).filter((line: any) => line.lineId === dto.lineId);
      if (lines.length !== 1 || !Number.isSafeInteger(lines[0].qty) || lines[0].qty < 1) throw new ConflictException('Exact live sale line required');
      const line = lines[0], active = pickingExceptions(sale, line);
      const entries = sale.pickingExceptions || [];
      let entry: any;
      if (dto.action === 'skip') {
        const quantity = dto.quantity ?? 1;
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new BadRequestException('A positive whole piece quantity is required');
        const assigned = await this.units.countDocuments({ 'assignment.transactionId': String(sale._id), 'assignment.lineId': dto.lineId, status: { $in: allocatedStatuses } }).session(session);
        if (assigned + active.length >= line.qty) throw new ConflictException('This line already has its full quantity accounted for');
        if (quantity > line.qty - assigned - active.length) throw new ConflictException('Damaged-label quantity exceeds the remaining pieces');
        for (let i = 0; i < quantity; i++) {
          entry = { id: randomUUID(), kind: 'damaged-label', lineId: dto.lineId, sku: String(line.code || '').trim(), quantity: 1, active: true, reason: dto.reason.trim(), byUserId: actor.userId, by: name, at: new Date().toISOString() };
          entries.push(entry);
        }
      } else {
        entry = active.find((row: any) => row.id === dto.exceptionId);
        if (!entry) throw new ConflictException('Active damaged-label exception not found');
        Object.assign(entry, { active: false, undoneBy: name, undoneByUserId: actor.userId, undoneAt: new Date().toISOString(), undoReason: dto.reason.trim() });
      }
      const reopenedPreparation = dto.action === 'undo' && sale.prepChecked === true;
      const history = reopenedPreparation ? { action: 'prep-check-undo', date: new Date().toISOString(), by: name, prepChecked: false, note: dto.reason.trim().slice(0,300) } : null;
      await collection.updateOne({ _id: sale._id }, { $set: { pickingExceptions: entries, ...(dto.action === 'undo' ? { prepChecked: false } : {}) },
        ...(history ? { $push: { pickupHistory: history } as any } : {}) }, { session });
      if (reopenedPreparation) context.afterCommit.push(() => this.transactions.notifyPickingReopened?.(String(sale._id), sale.pickupRef || null, [...(sale.pickupHistory || []),history]));
      return { transactionId: String(sale._id), lineId: dto.lineId, exception: entry, skippedCount: pickingExceptions({ pickingExceptions: entries }, line).length, prepChecked: false, reopenedPreparation, stockChanged: false, barcodeMatched: false };
    });
  }

  pickScan(transactionId: string, dto: OrderPickScanDto, actor: TrackingActor) {
    return this.write(`order-pick-scan:${String(this.id(transactionId))}`, dto, actor, 'inventory-units-allocate', (session,name)=>this.pickUnitInSession(transactionId,dto,actor,session,name));
  }

  async pickUnitInSession(transactionId: string, dto: OrderPickScanDto, actor: TrackingActor, session: ClientSession, name: string, packId?: string) {
      if (!dto.physicalPossessionConfirmed || !dto.reason?.trim() || !dto.lineId?.trim() || !dto.identifier?.trim() || /[\x00-\x1f\x7f]/.test(dto.identifier)) {
        throw new BadRequestException('Physical unit scan, exact order line and reason are required');
      }
      const unit: any = await this.units.findOne(await this.identifierFilter(dto.identifier, session)).session(session);
      if (!unit) throw new NotFoundException('Barcode is not registered');
      if (unit.packId && unit.packId !== packId) throw new ConflictException('Scan the sealed pack label, or open the pack before scanning a single piece');
      const product = await this.lockProduct(unit.productId, session);
      if (['supplier-return-pending', 'returned-to-supplier'].includes(unit.status)) throw new ConflictException({
        code: unit.status === 'returned-to-supplier' ? 'UNIT_RETURNED_TO_SUPPLIER' : 'UNIT_PENDING_SUPPLIER_RETURN',
        message: 'This piece is linked to a supplier return', supplierReturn: await this.supplierReturnInfo(unit, session) });
      const sale: any = await this.connection.collection('transactions').findOneAndUpdate({ _id: this.id(transactionId), type: 'مبيعات', pickupStatus: 'Preparing', cancelled: { $ne: true }, archived: { $ne: true }, prepChecked: { $ne: true } },
        { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
      if (!sale) throw new ConflictException('Live sale required');
      const lines = (sale.items || []).filter((line: any) => line.lineId === dto.lineId && String(line.code || '').trim() === String(product.code || '').trim());
      if (normalizeWarehouseCode(unit.warehouseCode) !== normalizeWarehouseCode(sale.warehouseCode)) throw new ConflictException('القطعة من مخزن مختلف عن المخزن المحدد في فاتورة العميل');
      if (lines.length !== 1 || !Number.isSafeInteger(lines[0].qty) || lines[0].qty < 1) throw new ConflictException('Barcode does not match one exact sale line');
      if (unit.status === 'picking' || unit.status === 'prepared') throw new ConflictException({
        code: unit.assignment?.transactionId === String(sale._id) ? 'DUPLICATE_SCAN' : 'UNIT_ASSIGNED_ELSEWHERE',
        message: 'DUPLICATE_SCAN: this unit is already picked for an order' });
      const wasAvailable = unit.status === 'available' && !unit.assignment;
      const assigned = unit.assignment ? { transactionId: unit.assignment.transactionId, lineId: unit.assignment.lineId } : null;
      if (unit.status === 'available' && !assigned) {
        unit.assignment = { transactionId: String(sale._id), lineId: dto.lineId };
      } else if (!(unit.status === 'reserved' && assigned?.transactionId === String(sale._id) && assigned?.lineId === dto.lineId)) {
        throw new ConflictException('Unit is not available for this exact order line');
      }
      const claimed = await this.units.countDocuments({ 'assignment.transactionId': String(sale._id), 'assignment.lineId': dto.lineId,
        status: { $in: allocatedStatuses } }).session(session);
      const skipped = pickingExceptions(sale, lines[0]).length;
      if (claimed + skipped > lines[0].qty || (wasAvailable && claimed + skipped >= lines[0].qty)) throw new ConflictException('Sale line already has its full quantity allocated');
      if (unit.origin.purchaseTransactionId || unit.origin.purchaseLineId) {
        const source = await this.connection.collection('transactions').findOne({ _id: this.id(unit.origin.purchaseTransactionId), type: 'مشتريات', cancelled: { $ne: true }, archived: { $ne: true } }, { session });
        const sourceLine = source ? resolvePurchaseLine(source.items || [], unit.origin.purchaseLineId, String(product.code || '').trim()) : null;
        const sourceQty = sourceLine ? await this.units.countDocuments({ 'origin.purchaseTransactionId': unit.origin.purchaseTransactionId,
          productId: unit.productId, ...purchaseLineOrigins(source?.items || [], sourceLine) }).session(session) : 0;
        if (!sourceLine || !Number.isSafeInteger(sourceLine.qty) || sourceQty !== sourceLine.qty) throw new ConflictException('Purchase receipt needs reconciliation before picking');
      }
      const from = unit.status; unit.status = 'picking'; unit.markModified('status'); await unit.save({ session });
      await this.event(unit, 'picking-started', from, dto, actor, name, session, { transactionId: String(sale._id), lineId: dto.lineId,
        notes: dto.reason.trim(), details: { physicalPossessionConfirmed: true, inputMethod: 'barcode', custodyConfirmed: true } });
      return { outcome: 'accepted', unit: { unitId: String(unit._id), barcode: unit.barcode, manualCode: await this.manualCodes.codeFor(String(unit._id)), productId: unit.productId, status: unit.status, version: unit.__v },
        transactionId: String(sale._id), lineId: dto.lineId, sku: product.code, stockChanged: false };
  }

  async actionOptions(identifier: string, actor: TrackingActor, query = '') {
    this.require(actor, 'inventory-units-view');
    const { unit } = await this.lookup(identifier);
    const product: any = await this.connection.collection('products').findOne({ _id: this.id(unit.productId) }, { projection: { code: 1 } });
    const allowed = (permission: string) => actor.role === 'admin' || actor.perms?.includes(permission);
    const actions: string[] = [];
    if (allowed('inventory-units-allocate')) {
      if (unit.status === 'available' && !unit.assignment) actions.push('reserve');
      if (['reserved', 'picking', 'prepared'].includes(unit.status)) actions.push('release');
    }
    if (allowed('inventory-units-condition')) {
      if (!unit.assignment && ['inspection-required', 'returned'].includes(unit.status)) actions.push('inspect');
      if (!unit.assignment && ['available', 'inspection-required', 'returned'].includes(unit.status)) actions.push('damage', 'lost');
      if (unit.status === 'prepared') actions.push('ship');
      if (unit.status === 'shipped') actions.push('deliver');
      if (['shipped', 'delivered'].includes(unit.status)) actions.push('return');
      if (allowed('suppliers-returns') && !unit.assignment && unit.origin?.kind === 'purchase' &&
        ['available', 'inspection-required', 'returned', 'damaged'].includes(unit.status)) actions.push('supplier-return');
      if (allowed('suppliers-returns') && unit.status === 'returned-to-supplier') {
        const last: any = await this.events.findOne({ unitId: String(unit._id), action: 'supplier-returned' }).sort({ sequence: -1 }).lean();
        if (last?.details?.supplierReturnId && await this.connection.collection('supplierreturnorders').findOne({
          _id: this.id(last.details.supplierReturnId), 'reversal.reversedAt': { $exists: true } })) actions.push('receive-supplier-return');
      }
    }
    const sales: any[] = [], supplierReturns: any[] = [];
    if (unit.assignment && ['reserved', 'picking', 'prepared'].includes(unit.status)) {
      const order: any = await this.connection.collection('transactions').findOne({ _id: this.id(unit.assignment.transactionId) },
        { projection: { shippedAt: 1, pickupStatus: 1, bostaStatus: 1 } });
      const dispatched = order && (order.shippedAt || ['Shipped', 'Delivered'].includes(order.pickupStatus) || order.bostaStatus === 'DELIVERED');
      if (dispatched) {
        const index = actions.indexOf('release'); if (index >= 0) actions.splice(index, 1);
        if (unit.status === 'prepared' && allowed('inventory-units-condition')) actions.push('return');
      }
    }
    const sku = String(product?.code || '').trim();
    if (actions.includes('reserve') && sku) {
      const filter: any = { type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true },
        pickupStatus: { $in: ['Pending', 'Preparing', '', null] }, shippedAt: null, prepChecked: { $ne: true },
        'items.code': sku, warehouseCode: normalizeWarehouseCode(unit.warehouseCode) === 'MAIN' ? { $in: ['MAIN', '', null] } : unit.warehouseCode };
      if (query.trim()) filter.$or = ['ref', 'client'].map(key => ({ [key]: { $regex: escapeRegex(query.trim().slice(0, 100)), $options: 'i' } }));
      const orders = await this.connection.collection('transactions').find(filter, { projection: { ref: 1, client: 1, items: 1, pickingExceptions: 1 } }).sort({ _id: -1 }).limit(50).toArray();
      for (const order of orders) for (const line of order.items || []) {
        if (String(line.code || '').trim() !== sku || !line.lineId || !Number.isSafeInteger(line.qty) || line.qty < 1) continue;
        const claimed = await this.units.find({ 'assignment.transactionId': String(order._id), 'assignment.lineId': line.lineId,
          status: { $in: allocatedStatuses } }).select('_id').lean();
        const dispatched = await this.events.distinct('unitId', { action: 'shipped', transactionId: String(order._id), lineId: line.lineId });
        const remaining = line.qty - new Set([...claimed.map((u: any) => String(u._id)), ...dispatched]).size - pickingExceptions(order, line).length;
        if (remaining > 0) sales.push({ transactionId: String(order._id), lineId: line.lineId, ref: order.ref, client: order.client, remaining });
      }
    }
    if (actions.includes('supplier-return') && sku) {
      const returns = await this.connection.collection('supplierreturnorders').find({ status: 'مكتمل', reversal: null,
        items: { $elemMatch: { code: sku, 'allocations.sourceTransactionId': unit.origin.purchaseTransactionId } } },
        { projection: { returnNumber: 1, supplierName: 1, items: 1, linkedTransactionId: 1 } }).sort({ _id: -1 }).limit(50).toArray();
      for (const row of returns) {
        const tx = OBJECT_ID_PATTERN.test(row.linkedTransactionId || '') ? await this.connection.collection('transactions').findOne({
          _id: this.id(row.linkedTransactionId), type: 'مرتجع مشتريات', cancelled: { $ne: true }, archived: { $ne: true } }) : null;
        if (!tx || normalizeWarehouseCode(tx.warehouseCode) !== normalizeWarehouseCode(unit.warehouseCode)) continue;
        const qty = (row.items || []).filter((it: any) => String(it.code || '').trim() === sku).flatMap((it: any) => it.allocations || [])
          .filter((a: any) => a.sourceTransactionId === unit.origin.purchaseTransactionId).reduce((n: number, a: any) => n + Number(a.qty || 0), 0);
        const linked = await this.events.distinct('unitId', { action: 'supplier-returned', 'details.supplierReturnId': String(row._id),
          'details.purchaseTransactionId': unit.origin.purchaseTransactionId, 'details.productId': unit.productId });
        const remaining = qty - linked.length;
        if (Number.isSafeInteger(remaining) && remaining > 0) supplierReturns.push({ id: String(row._id), ref: row.returnNumber, supplier: row.supplierName, remaining });
      }
    }
    return { actions, sales, supplierReturns };
  }

  action(identifier: string, dto: UnitActionDto, actor: TrackingActor) {
    dto = { ...dto, reason: dto.reason?.trim() || 'تم تنفيذ الإجراء دون ملاحظة إضافية' };
    const permission = ['reserve', 'release', 'picking', 'prepare', 'undo-picking'].includes(dto.action) ? 'inventory-units-allocate' : 'inventory-units-condition';
    return this.write(`action:${identifier}`, dto, actor, permission, (session,name,context)=>this.actionInSession(identifier,dto,actor,session,name,undefined,context));
  }

  async actionInSession(identifier: string, dto: UnitActionDto, actor: TrackingActor, session: ClientSession, name: string, packId?: string, context?: DatabaseWriteContext) {
      const unit: any = await this.units.findOne(await this.identifierFilter(identifier, session)).session(session);
      if (!unit) throw new NotFoundException('Unit not found');
      if (unit.packId && unit.packId !== packId && !['inspect','prepare','ship','deliver'].includes(dto.action)) throw new ConflictException('Open the sealed pack before acting on one piece');
      const product = await this.lockProduct(unit.productId, session);
      if ((unit.origin.purchaseOrderId || unit.origin.purchaseLineId) && ['inspect', 'reserve', 'picking', 'prepare', 'ship', 'deliver'].includes(dto.action)) {
        const source = await this.connection.collection('transactions').findOneAndUpdate({ _id: this.id(unit.origin.purchaseTransactionId),
          type: 'مشتريات', cancelled: { $ne: true }, archived: { $ne: true } }, { $inc: { unitTrackingRevision: 1 } },
          { session, returnDocument: 'after', includeResultMetadata: false });
        const line = source ? resolvePurchaseLine(source.items || [], unit.origin.purchaseLineId, String(product.code || '').trim()) : null;
        const represented = line ? await this.units.countDocuments({ 'origin.purchaseTransactionId': unit.origin.purchaseTransactionId,
          productId: unit.productId, ...purchaseLineOrigins(source?.items || [], line) }).session(session) : 0;
        if (!source || !line || !Number.isSafeInteger(line.qty) || represented !== line.qty) throw new ConflictException('Receipt reversed, edited or archived; financial/custody reconciliation required before making units available');
      }
      if (unit.__v !== dto.expectedVersion) throw new ConflictException('Stale unit version');
      const from = unit.status;
      const previousAssignment = unit.assignment ? { transactionId: unit.assignment.transactionId, lineId: unit.assignment.lineId } : null;
      const previousWarehouse = unit.warehouseCode;
      let action: string;
      let supplierReturnDetails: Record<string, any> = {};
      let returnDetails: Record<string, any> = {};
      const possession = () => { if (!dto.physicalPossessionConfirmed) throw new BadRequestException('Physical custody confirmation required'); };
      if (['release', 'undo-picking'].includes(dto.action) && unit.assignment) {
        const order: any = await this.connection.collection('transactions').findOneAndUpdate({ _id: this.id(unit.assignment.transactionId), type: 'مبيعات' },
          { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
        if (order && (order.shippedAt || ['Shipped', 'Delivered'].includes(order.pickupStatus) || order.bostaStatus === 'DELIVERED')) {
          throw new ConflictException('تم شحن الطلب؛ لا يمكن إزالة هوية القطعة بالتراجع. سجّل استلام مرتجع فعليًا عند رجوعها');
        }
        if (dto.action === 'undo-picking') {
          if (!order || order.pickupStatus !== 'Preparing' || order.cancelled || order.archived || order.deliveredAt) throw new ConflictException('An active order awaiting preparation is required');
          if (order.prepChecked) {
            const entry = { action: 'prep-check-undo', date: new Date().toISOString(), by: name, prepChecked: false, note: dto.reason.trim().slice(0,300) };
            await this.connection.collection('transactions').updateOne({ _id: order._id }, { $set: { prepChecked: false }, $push: { pickupHistory: entry } as any }, { session });
            context?.afterCommit.push(() => this.transactions.notifyPickingReopened?.(String(order._id),order.pickupRef || null,[...(order.pickupHistory || []),entry]));
          }
        }
      }
      if (['ship', 'deliver'].includes(dto.action)) {
        if (!unit.assignment) throw new ConflictException('القطعة غير مرتبطة بطلب عميل');
        const sale: any = await this.connection.collection('transactions').findOneAndUpdate({ _id: this.id(unit.assignment.transactionId),
          type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true } }, { $inc: { unitTrackingRevision: 1 } },
          { session, returnDocument: 'after', includeResultMetadata: false });
        if (!sale || normalizeWarehouseCode(sale.warehouseCode) !== normalizeWarehouseCode(unit.warehouseCode) ||
          !sale.items?.some((line: any) => line.lineId === unit.assignment.lineId && String(line.code || '').trim() === String(product.code || '').trim())) {
          throw new ConflictException('الطلب المرتبط ملغى أو تغيرت بياناته؛ راجع الطلب قبل تأكيد التسليم');
        }
      }
      if (dto.action === 'reserve') {
        if (from !== 'available' || unit.assignment) throw new ConflictException('Unit is not available');
        if (typeof dto.lineId !== 'string' || !dto.lineId.trim()) throw new BadRequestException('Stable sale line ID required; identify missing IDs explicitly');
        const sale = await this.connection.collection('transactions').findOneAndUpdate({ _id: this.id(dto.transactionId!), type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true },
          pickupStatus: { $in: ['Pending', 'Preparing', '', null] }, shippedAt: null, prepChecked: { $ne: true } },
          { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
        const lines = (sale?.items || []).filter((item: any) => item.lineId === dto.lineId && String(item.code || '').trim() === String(product.code).trim());
        if (sale && normalizeWarehouseCode(unit.warehouseCode) !== normalizeWarehouseCode(sale.warehouseCode)) throw new ConflictException('القطعة من مخزن مختلف عن فاتورة العميل');
        if (lines.length !== 1 || !Number.isSafeInteger(lines[0].qty) || lines[0].qty <= 0) throw new ConflictException('Exact live sale line for this product required');
        const claimed = await this.units.find({ 'assignment.transactionId': String(sale!._id), 'assignment.lineId': dto.lineId, status: { $in: allocatedStatuses } }).select('_id').session(session).lean();
        // A return does not reopen the original sale's dispatch entitlement. Reshipment needs a separately reviewed sale/replacement.
        const dispatched = await this.events.distinct('unitId', { action: 'shipped', transactionId: String(sale!._id), lineId: dto.lineId }).session(session);
        if (new Set([...claimed.map((row: any) => String(row._id)), ...dispatched]).size + pickingExceptions(sale, lines[0]).length >= lines[0].qty) throw new ConflictException('Sale line quantity already allocated/dispatched');
        unit.assignment = { transactionId: String(sale!._id), lineId: dto.lineId }; unit.status = 'reserved'; action = 'reserved';
      } else if (dto.action === 'release') {
        possession();
        if (!['reserved', 'picking', 'prepared'].includes(from)) throw new ConflictException('Only on-premises allocations can be released');
        unit.assignment = null; unit.status = 'inspection-required'; action = 'released';
      } else if (dto.action === 'picking' || dto.action === 'prepare') {
        possession();
        if (from !== (dto.action === 'picking' ? 'reserved' : 'picking')) throw new ConflictException('Invalid preparation transition');
        unit.status = dto.action === 'picking' ? 'picking' : 'prepared'; action = dto.action === 'picking' ? 'picking-started' : 'prepared';
      } else if (dto.action === 'undo-picking') {
        if (!['picking','prepared'].includes(from) || !dto.transactionId || !dto.lineId || unit.assignment?.transactionId !== dto.transactionId.toLowerCase() || unit.assignment?.lineId !== dto.lineId) {
          throw new ConflictException('Only the last active pick for this exact order line can be undone');
        }
        // Printing and read-only scans do not invalidate an otherwise active pick.
        const lifecycle: any[] = await this.events.find({ unitId: String(unit._id),
          $expr: { $ne: ['$fromStatus', '$toStatus'] } }).sort({ sequence: -1 }).limit(2).session(session).lean();
        const last = lifecycle[from === 'prepared' ? 1 : 0];
        if ((from === 'prepared' && lifecycle[0]?.action !== 'prepared') || last?.action !== 'picking-started' || !['available', 'reserved'].includes(last.fromStatus) || last.transactionId !== dto.transactionId.toLowerCase() || last.lineId !== dto.lineId) throw new ConflictException('Pick history changed; reload before undoing');
        if (last.fromStatus === 'available') { unit.assignment = null; unit.status = 'available'; }
        else unit.status = 'reserved';
        action = 'picking-undone';
      } else if (dto.action === 'inspect') {
        if (!dto.physicalPossessionConfirmed) throw new BadRequestException('Physical inspection confirmation required');
        if (!['inspection-required', 'returned'].includes(from) || dto.inspectionPassed !== true || unit.assignment) throw new ConflictException('Unassigned quarantined unit and passed inspection required');
        if (from === 'returned') {
          const receipt: any = await this.events.findOne({ unitId: String(unit._id), action: 'returned' }).sort({ sequence: -1 }).session(session).lean();
          if (!receipt?.transactionId || !await this.customerReturnCredited(unit, receipt.transactionId, session)) {
            throw new ConflictException({ code: 'RETURN_SETTLEMENT_REQUIRED', message: 'القطعة مستلمة؛ أكمل تسوية المرتجع أو فشل التوصيل قبل إتاحتها للبيع' });
          }
          returnDetails = { customerReturnSaleId: receipt.transactionId, productId: String(unit.productId) };
        }
        unit.status = 'available'; action = 'inspection-passed';
      } else if (dto.action === 'damage' || dto.action === 'lost') {
        if (unit.assignment || !['available', 'inspection-required', 'returned'].includes(from)) throw new ConflictException('Assigned units require reviewed custody recovery before condition changes');
        if (dto.action === 'damage') possession();
        if (dto.action === 'lost' && dto.physicalCountConfirmed !== true) throw new BadRequestException('A confirmed physical count documenting the loss is required');
        unit.status = dto.action === 'damage' ? 'damaged' : 'lost'; action = dto.action === 'damage' ? 'damaged' : 'lost';
      } else if (dto.action === 'return') {
        possession();
        if (from === 'prepared' && unit.assignment) {
          const order: any = await this.connection.collection('transactions').findOneAndUpdate({ _id: this.id(unit.assignment.transactionId), type: 'مبيعات' },
            { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
          if (!order || !(order.shippedAt || ['Shipped', 'Delivered'].includes(order.pickupStatus) || order.bostaStatus === 'DELIVERED') ||
            !order.items?.some((line: any) => line.lineId === unit.assignment.lineId && String(line.code || '').trim() === String(product.code || '').trim())) {
            throw new ConflictException('يلزم إثبات شحن الطلب المرتبط قبل تسجيل رجوع هذه القطعة');
          }
          returnDetails = { orderShipmentConfirmed: true, orderShippedAt: order.shippedAt || null };
        } else if (!['shipped', 'delivered'].includes(from)) throw new ConflictException('Only physically returned dispatched units can be received');
        unit.assignment = null; unit.status = 'returned'; action = 'returned';
      } else if (dto.action === 'ship' || dto.action === 'deliver') {
        if (!dto.physicalPossessionConfirmed) throw new BadRequestException('Handover/delivery confirmation required');
        if (from !== (dto.action === 'ship' ? 'prepared' : 'shipped')) throw new ConflictException('Invalid dispatch transition');
        unit.status = dto.action === 'ship' ? 'shipped' : 'delivered'; action = unit.status;
      } else if (dto.action === 'receive-supplier-return') {
        this.require(actor, 'suppliers-returns');
        possession();
        if (from !== 'returned-to-supplier' || unit.assignment) throw new ConflictException('يلزم قطعة سبق تسليمها للمورد');
        const last: any = await this.events.findOne({ unitId: String(unit._id), action: 'supplier-returned' }).sort({ sequence: -1 }).session(session).lean();
        const sr: any = last?.details?.supplierReturnId ? await this.connection.collection('supplierreturnorders').findOneAndUpdate({
          _id: this.id(last.details.supplierReturnId), 'reversal.reversedAt': { $exists: true } }, { $inc: { unitTrackingRevision: 1 } },
          { session, returnDocument: 'after', includeResultMetadata: false }) : null;
        const reversed = sr && OBJECT_ID_PATTERN.test(sr.linkedTransactionId || '') ? await this.connection.collection('transactions').findOne({
          _id: this.id(sr.linkedTransactionId), cancelled: true }, { session }) : null;
        if (!sr || !reversed) throw new ConflictException('اعكس مرتجع المورد ماليًا أولًا ثم أكّد استلام القطعة فعليًا');
        supplierReturnDetails = { supplierReturnId: String(sr._id), supplierReturnRef: sr.returnNumber, supplierReturnRecovery: true };
        unit.supplierReturnId = null;
        unit.status = 'inspection-required'; action = 'inspection-required';
      } else if (dto.action === 'supplier-return') {
        this.require(actor, 'suppliers-returns');
        possession();
        if (unit.assignment || unit.origin.kind !== 'purchase' || !['available', 'inspection-required', 'returned', 'damaged'].includes(from) || !dto.supplierReturnId) {
          throw new ConflictException('يلزم قطعة مشتراة غير مرتبطة بطلب ومرتجع مورد مكتمل');
        }
        const sr: any = await this.connection.collection('supplierreturnorders').findOneAndUpdate({ _id: this.id(dto.supplierReturnId),
          status: 'مكتمل', reversal: null }, { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
        const tx: any = sr && OBJECT_ID_PATTERN.test(sr.linkedTransactionId || '') ? await this.connection.collection('transactions').findOneAndUpdate({
          _id: this.id(sr.linkedTransactionId), type: 'مرتجع مشتريات', cancelled: { $ne: true }, archived: { $ne: true } },
          { $inc: { unitTrackingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false }) : null;
        if (!sr || !tx || normalizeWarehouseCode(tx.warehouseCode) !== normalizeWarehouseCode(unit.warehouseCode)) {
          throw new ConflictException('اختر مرتجع مورد مكتملًا وغير معكوس من نفس المخزن');
        }
        const sku = String(product.code || '').trim();
        const quantities = (sr.items || []).filter((it: any) => String(it.code || '').trim() === sku).flatMap((it: any) => it.allocations || [])
          .filter((a: any) => a.sourceTransactionId === unit.origin.purchaseTransactionId);
        const quantity = quantities.reduce((sum: number, row: any) => sum + Number(row.qty || 0), 0);
        const linked = await this.events.distinct('unitId', { action: 'supplier-returned', 'details.supplierReturnId': String(sr._id),
          'details.purchaseTransactionId': unit.origin.purchaseTransactionId, 'details.productId': unit.productId }).session(session);
        const txQuantity = (tx.items || []).filter((it: any) => String(it.code || '').trim() === sku).reduce((sum: number, it: any) => sum + Number(it.qty || 0), 0);
        const allLinked = await this.events.distinct('unitId', { action: 'supplier-returned', 'details.supplierReturnId': String(sr._id), 'details.productId': unit.productId }).session(session);
        const source: any = await this.connection.collection('transactions').findOne({ _id: this.id(unit.origin.purchaseTransactionId),
          type: 'مشتريات', cancelled: { $ne: true }, archived: { $ne: true } }, { session });
        if (!source || !source.supplierId || String(source.supplierId) !== String(sr.supplierId) || !Number.isSafeInteger(txQuantity) || allLinked.length >= txQuantity ||
          !Number.isSafeInteger(quantity) || quantity < 1 || linked.length >= quantity) throw new ConflictException('القطعة لا تطابق مورد ومصدر المرتجع أو تم ربط كامل كميته بالفعل');
        supplierReturnDetails = { supplierReturnId: String(sr._id), supplierReturnRef: sr.returnNumber,
          supplierReturnTransactionId: String(tx._id), purchaseTransactionId: unit.origin.purchaseTransactionId, productId: unit.productId };
        unit.status = 'returned-to-supplier'; action = 'supplier-returned';
      } else if (dto.action === 'warehouse') {
        throw new ConflictException('استخدم نقل المخزون بين المخازن للحفاظ على تطابق الأرصدة وأكواد القطع');
      } else throw new BadRequestException('Unsupported action');
      // Always increment the version, including location changes or same-state audit writes.
      unit.markModified('status');
      await unit.save({ session });
      await this.event(unit, action, from, dto, actor, name, session, { notes: dto.evidenceReference || '',
        details: { fromWarehouseCode: previousWarehouse, toWarehouseCode: unit.warehouseCode,
          fromAssignment: previousAssignment, toAssignment: unit.assignment?.toObject?.() || unit.assignment,
          physicalPossessionConfirmed: dto.physicalPossessionConfirmed === true, physicalCountConfirmed: dto.physicalCountConfirmed === true,
          inspectionPassed: dto.inspectionPassed === true, ...supplierReturnDetails, ...returnDetails },
        ...(unit.assignment || previousAssignment ? { transactionId: (unit.assignment || previousAssignment).transactionId, lineId: (unit.assignment || previousAssignment).lineId } : {}) });
      return { unit: unit.toObject(), stockChanged: false, transactionId: unit.assignment?.transactionId || previousAssignment?.transactionId || null };
  }

  private async labelPrintCounts(ids: string[], session?: ClientSession): Promise<Map<string, number>> {
    const query = this.events.aggregate([
      { $match: { unitId: { $in: ids }, action: { $in: ['label-print-requested', 'label-reprint-requested', 'label-printed', 'label-reprinted'] } } },
      { $group: { _id: '$unitId', count: { $sum: 1 } } },
    ]);
    if (session) query.session(session);
    const rows = await query;
    return new Map(rows.map(row => [String(row._id), Number(row.count || 0)]));
  }

  private async labelData(unit: any, product: any, session?: ClientSession, printCount = 0) {
    // The invoice date or ObjectId timestamp cannot prove physical receipt.
    const receipt: any = unit.origin?.kind === 'purchase' ? await this.events.findOne({ unitId: String(unit._id),
      action: 'registered', 'details.physicalPossessionConfirmed': true }).select('createdAt').session(session || null).lean() : null;
    const date = receipt?.createdAt ? new Date(receipt.createdAt) : null;
    const purchase = unit.origin?.purchaseTransactionId ? await this.connection.collection('transactions').findOne({_id:this.id(unit.origin.purchaseTransactionId),type:'مشتريات'},{session,projection:{date:1}}) : null;
    return { unitId: String(unit._id), barcode: unit.barcode, manualCode: await this.manualCodes.codeFor(String(unit._id)), printCount, productName: product.name, sku: product.code,
      invoiceDate: purchase?.date || null,
      sellPrice: typeof product.sellPrice === 'number' && Number.isFinite(product.sellPrice) && product.sellPrice >= 0 ? product.sellPrice : null,
      receivedDate: date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) : null,
      svg: await QRCode.toString(unit.barcode, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }) };
  }

  async labels(dto: LabelRequestDto, actor: TrackingActor) {
    const size = LABEL_SIZES.find(row => row.id === dto.sizeId);
    if (!size || !Array.isArray(dto.unitIds) || !dto.unitIds.length || dto.unitIds.length > 100 || new Set(dto.unitIds.map(id => String(id).toLowerCase())).size !== dto.unitIds.length) throw new BadRequestException('Select a supported size and 1–100 distinct units');
    // Sort lock order to avoid batch deadlocks; result order is stable and deduplicated.
    const ids = dto.unitIds.map(id => String(this.id(id))).sort();
    return this.write('label-request', { ...dto, unitIds: ids } as LabelRequestDto, actor, 'inventory-units-print', async (session, name) => {
      const selected: any[] = [];
      for (const id of ids) {
        const unit: any = await this.units.findById(id).session(session).lean();
        if (!unit) throw new NotFoundException('Label unit not found');
        selected.push(unit);
      }
      const products = new Map<string, any>();
      for (const id of [...new Set(selected.map(unit => unit.productId))].sort()) products.set(id, await this.lockProduct(id, session));
      const counts = await this.labelPrintCounts(ids, session);
      if (dto.allowReprint !== true && ids.some(id => (counts.get(id) || 0) > 0)) throw new ConflictException({
        code: 'LABEL_REPRINT_CONFIRMATION_REQUIRED', message: 'سبق طلب طباعة ملصق ضمن التحديد. حدّث المعاينة وأكّد إعادة الطباعة أولًا' });
      const labels: any[] = [];
      for (const unit of selected) {
        const prior = (counts.get(String(unit._id)) || 0) > 0;
        await this.event(unit, prior ? 'label-reprint-requested' : 'label-print-requested', unit.status, dto, actor, name, session,
          { notes: `Browser print request; physical printing unverified; template=${size.id}`,
            details: { reprintConfirmed: prior && dto.allowReprint === true, previousPrintCount: counts.get(String(unit._id)) || 0, template: size.id } });
        const product = products.get(unit.productId);
        labels.push({ ...await this.labelData(unit, product, session, (counts.get(String(unit._id)) || 0) + 1), reprint: prior });
      }
      return { labels, size, symbology: 'QR', physicalPrintingVerified: false, stockChanged: false };
    });
  }

  async preview(dto: LabelRequestDto) {
    const size = LABEL_SIZES.find(row => row.id === dto.sizeId);
    if (!size || !dto.unitIds?.length || dto.unitIds.length > 100 || new Set(dto.unitIds.map(id => id.toLowerCase())).size !== dto.unitIds.length) throw new BadRequestException('Select a supported size and distinct units');
    const labels = [];
    const counts = await this.labelPrintCounts(dto.unitIds.map(id => String(this.id(id))));
    for (const id of dto.unitIds) {
      const unit: any = await this.units.findById(this.id(id)).lean();
      if (!unit) throw new NotFoundException('Unit not found');
      const product = await this.connection.collection('products').findOne({ _id: this.id(unit.productId) });
      if (!product) throw new ConflictException('Unit product missing');
      labels.push(await this.labelData(unit, product, undefined, counts.get(String(unit._id)) || 0));
    }
    return { labels, size, symbology: 'QR', physicalPrintingVerified: false };
  }

  async reconciliation() {
    // Existing authoritative calculation, not a second implementation of inventory arithmetic.
    const inventory = await this.transactions.getInventory();
    const units: any[] = await this.units.find({}).lean();
    const sales = await this.connection.collection('transactions').find({ type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true } }, { projection: { items: 1 } }).toArray();
    const rows = inventory.map(stock => {
      const pieces = units.filter(unit => unit.productId === stock._id);
      const available = pieces.filter(unit => unit.status === 'available').length;
      const onPremisesAllocated = pieces.filter(unit => ['reserved', 'picking', 'prepared'].includes(unit.status)).length;
      const staleAssignments = pieces.filter(unit => unit.assignment && !sales.some(sale => String(sale._id) === unit.assignment.transactionId && sale.items?.some((line: any) =>
        line.lineId === unit.assignment.lineId && String(line.code || '').trim() === String(stock.code || '').trim()))).length;
      const sku = String(stock.code || '').trim();
      const invalidSku = !sku || inventory.filter(other => String(other.code || '').trim() === sku).length !== 1;
      const excessAllocations = sales.reduce((sum, sale) => sum + (sale.items || []).filter((line: any) => String(line.code || '').trim() === sku &&
        pieces.filter(unit => unit.assignment?.transactionId === String(sale._id) && unit.assignment?.lineId === line.lineId).length > Number(line.qty)).length, 0);
      return { productId: stock._id, sku: stock.code, name: stock.name, aggregateAvailable: stock.current,
        available, onPremisesAllocated, quarantined: pieces.filter(unit => ['inspection-required', 'returned', 'damaged', 'lost', 'supplier-return-pending'].includes(unit.status)).length,
        unknownProvenance: pieces.filter(unit => unit.origin.kind === 'legacy-unknown').length,
        difference: available - stock.current, staleAssignments, invalidSku, excessAllocations,
        passesQuantityCheck: Number.isSafeInteger(stock.current) && stock.current >= 0 && available === stock.current && !staleAssignments && !invalidSku && !excessAllocations };
    });
    return { rows, orphanUnitIds: units.filter(unit => !inventory.some(row => row._id === unit.productId)).map(unit => String(unit._id)),
      generatedAt: new Date().toISOString(), snapshotAtomic: false, enforcementEnabled: false, activationAllowed: false,
      blockers: ['Physical count/custody evidence must be reviewed', 'Live legacy writers are not coordinated with tracking; quiescent cutover required',
        'Deployment transaction/index capabilities and recovery require verification', 'No automatic stock adjustment or barcode enforcement is authorized'] };
  }

  async attestCount(dto: CountAttestationDto, actor: TrackingActor) {
    if (!dto.physicalPossessionConfirmed || !dto.countReference?.trim()) throw new BadRequestException('Physical count confirmation/reference required');
    const report = await this.reconciliation();
    const row = report.rows.find(item => item.productId === dto.productId.toLowerCase());
    if (!row) throw new NotFoundException('Product not found');
    return this.write('physical-count', dto, actor, 'inventory-units-reconcile', async session => {
      await this.lockProduct(dto.productId, session);
      const discrepancy = dto.observedUnallocated !== row.aggregateAvailable || dto.observedUnallocated !== row.available || dto.observedAllocatedOnPremises !== row.onPremisesAllocated || !row.passesQuantityCheck;
      return { count: dto, report: row, discrepancy, disposition: discrepancy ? 'blocked-needs-review' : 'count-attested-not-activated', activationAllowed: false,
        stockChanged: false, reportGeneratedAt: report.generatedAt };
    });
  }

  async countHistory(productId?: string) {
    const filter: any = { kind: 'physical-count' };
    if (productId) filter['result.count.productId'] = String(this.id(productId));
    const found: any[] = await this.operations.find(filter).sort({ createdAt: -1, _id: -1 }).limit(101).lean();
    const counts = found.slice(0, 100);
    const reviews = await this.operations.find({ kind: 'count-evidence-review', 'result.countOperationId': { $in: counts.map(count => count._id) } }).lean();
    return { counts, reviews, limit: 100, truncated: found.length > 100 };
  }

  reviewCount(dto: CountReviewDto, actor: TrackingActor) {
    return this.write('count-evidence-review', dto, actor, 'inventory-units-reconcile-approve', async session => {
      const count: any = await this.operations.findById(dto.countOperationId).session(session).lean();
      if (!count || count.kind !== 'physical-count') throw new NotFoundException('Count receipt not found');
      await this.lockProduct(count.result.count.productId, session);
      const existing = await this.operations.findOne({ kind: 'count-evidence-review', 'result.countOperationId': dto.countOperationId }).session(session).lean();
      if (existing) throw new ConflictException('Count evidence already reviewed; record a new count for a new review');
      return { countOperationId: dto.countOperationId, decision: dto.decision, originalDiscrepancy: count.result.discrepancy,
        disposition: dto.decision === 'reject-evidence' ? 'recount-required' : count.result.discrepancy ? 'evidence-accepted-discrepancy-still-blocked' : 'evidence-accepted-not-activated',
        activationAllowed: false, stockChanged: false };
    });
  }
}
