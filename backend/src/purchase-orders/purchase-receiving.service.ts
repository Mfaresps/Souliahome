import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { InventoryUnitsService, TrackingActor } from '../inventory-units/inventory-units.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CreateTransactionDto } from '../transactions/dto/transaction.dto';
import { ConvertPoToInvoiceDto } from './dto/purchase-order.dto';
import { OBJECT_ID_PATTERN } from '../inventory-units/inventory-unit.constants';

/** PO invoice conversion is the existing stock/financial receipt event. No second purchase/payment is posted. */
@Injectable()
export class PurchaseReceivingService {
  constructor(@InjectConnection() private readonly connection: Connection,
    private readonly units: InventoryUnitsService, private readonly transactions: TransactionsService) {}

  private async verifyStorage() {
    const required = ['purchaseorders', 'transactions', 'settings', 'vaultentries', 'supplierledgerentries', 'inventorymovements', 'products', 'users', 'suppliers'];
    const existing = await this.connection.db!.listCollections({}, { nameOnly: true }).toArray();
    if (required.some(name => !existing.some(row => row.name === name))) throw new ServiceUnavailableException('يجب تجهيز مجموعات الشراء والخزنة وسجل المورد قبل الاستلام الذري؛ لن تُنشأ تلقائياً داخل المعاملة');
    for (const [collection, key] of [['purchaseorders', 'poNumber'], ['inventorymovements', 'movementId']]) {
      const indexes = await this.connection.collection(collection).listIndexes().toArray();
      if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ [key]: 1 }) && index.unique && !index.sparse && !index.partialFilterExpression)) {
        throw new ServiceUnavailableException(`فهرس التفرد مطلوب قبل الاستلام: ${collection}.${key}`);
      }
    }
  }

  async convert(id: string, dto: ConvertPoToInvoiceDto, actor: TrackingActor) {
    if (!OBJECT_ID_PATTERN.test(id)) throw new BadRequestException('معرف أمر الشراء غير صالح');
    if (dto.tracking && actor.role !== 'admin' && !actor.perms?.includes('inventory-units-receive')) throw new ForbiddenException('صلاحية استلام الوحدات مطلوبة');
    if (dto.tracking && (!dto.tracking.physicalPossessionConfirmed || !dto.tracking.warehouseCode?.trim() || !dto.items?.length)) throw new BadRequestException('أكّد الحيازة الفعلية والموقع والكميات المستلمة صراحةً');
    await this.verifyStorage();
    const operationKey = dto.tracking?.operationKey || `po-convert:${id.toLowerCase()}`;
    const request = { operationKey, reason: dto.tracking?.reason?.trim() || (dto.tracking ? 'Physical receipt confirmed; no receipt reference supplied' : 'Explicit purchase order invoice conversion'), invoice: { ...dto, createdBy: undefined } };
    return this.units.purchaseOperation(id, request, actor, async (session, name, context) => {
      // Every PO conversion locks the existing singleton settings document, including zero-payment receipts.
      // This serializes reference allocation and receipt payments across different POs without changing balances.
      if (await this.connection.collection('settings').countDocuments({}, { session }) !== 1) throw new ConflictException('يلزم مستند إعدادات مالية واحد مجهّز قبل الاستلام');
      const settings = await this.connection.collection('settings').findOneAndUpdate({}, { $inc: { purchaseReceivingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
      if (!settings) throw new ConflictException('الإعدادات المالية غير موجودة');
      const po = await this.connection.collection('purchaseorders').findOneAndUpdate({ _id: new Types.ObjectId(id), status: 'مستلم', linkedTransactionId: { $in: ['', null] } },
        { $inc: { receivingRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
      if (!po) throw new ConflictException('أمر الشراء غير مستلم أو محوّل بالفعل؛ لا تُكرر الفاتورة');
      const poItems = (po.items || []).map((item: any) => ({ ...item, lineId: item.lineId || randomUUID() }));
      if (new Set(poItems.map((item: any) => item.lineId)).size !== poItems.length) throw new ConflictException('معرفات سطور أمر الشراء مكررة');
      const source = dto.items?.length ? dto.items : poItems;
      const used = new Set<number>();
      const lines: any[] = [];
      let quantityDifference = false;
      for (const item of source as any[]) {
        const code = item.code || item.productCode || '';
        const price = item.price ?? item.unitPrice ?? 0, qty = item.qty || 0;
        const line: any = { productId: item.productId || '', code, name: item.name || item.productName || '', qty, price, total: qty * price };
        if (dto.tracking) {
          if (!Number.isSafeInteger(qty) || qty < 1) throw new BadRequestException('كل كمية تتبع يجب أن تكون عدداً صحيحاً موجباً');
          const matches = poItems.map((poLine: any, index: number) => ({ poLine, index })).filter(({ poLine }: any) => String(poLine.productCode || '').trim() === String(code).trim());
          const selected = item.purchaseOrderLineIndex == null ? (matches.length === 1 ? matches[0] : null) : matches.find((row: any) => row.index === item.purchaseOrderLineIndex);
          if (!selected || used.has(selected.index)) throw new ConflictException('اربط كل صنف بسطر أمر الشراء الصحيح مرة واحدة');
          used.add(selected.index); quantityDifference ||= qty !== selected.poLine.qty;
          const products = await this.connection.collection('products').find({}, { session, projection: { code: 1 } }).toArray();
          const matching = products.filter(product => String(product.code || '').trim() === String(code).trim());
          if (!String(code).trim() || matching.length !== 1 || item.productId && item.productId !== String(matching[0]._id)) throw new ConflictException('SKU مفقود/مكرر أو علاقة الصنف غير صحيحة');
          line.productId = String(matching[0]._id); line.lineId = randomUUID(); line.purchaseOrderLineId = selected.poLine.lineId;
        }
        lines.push(line);
      }
      if (dto.tracking && used.size !== poItems.length) quantityDifference = true;
      if (dto.tracking && quantityDifference && dto.tracking.acceptQuantityDifference !== true) throw new BadRequestException('اعتماد اختلاف كمية الاستلام عن أمر الشراء مطلوب');
      const itemsTotal = lines.reduce((sum, item) => sum + item.total, 0);
      const discount = Math.max(0, Math.min(dto.discount ?? 0, itemsTotal));
      const total = itemsTotal - discount, deposit = Math.min(dto.deposit ?? 0, total), account = dto.depMethod || 'كاش';
      const today = new Date().toISOString().split('T')[0];
      let supplierId = '';
      if (dto.tracking) {
        // Preserve the old name-based resolution, refusing ambiguity rather than silently moving debt to another supplier.
        const suppliers = await this.connection.collection('suppliers').find({}, { session }).toArray();
        const matches = suppliers.filter(supplier => String(supplier.name || '').trim().toLowerCase() === String(po.supplierName || '').trim().toLowerCase());
        if (matches.length !== 1 || String(matches[0]._id) !== po.supplierId) throw new ConflictException('علاقة المورد غير مؤكدة؛ راجع تطابق المورد قبل الاستلام');
        supplierId = po.supplierId;
        await this.connection.collection('suppliers').updateOne({ _id: matches[0]._id }, { $inc: { receivingRevision: 1 } }, { session });
      }
      const txDto = { date: dto.date || today, transactionDate: dto.date || today, type: 'مشتريات', client: po.supplierName,
        warehouseCode: dto.warehouseCode || dto.tracking?.warehouseCode || 'MAIN',
        ...(supplierId ? { supplierId } : {}), ref: dto.ref, notes: dto.notes || `محوّل من أمر شراء ${po.poNumber}`, items: lines,
        itemsTotal, total, discount, deposit, remaining: Math.max(0, total - deposit), payStatus: deposit >= total ? 'مكتمل' : 'معلق',
        depMethod: account, payment: account, employee: name, purchaseOtpId: dto.purchaseOtpId || '', invoiceImages: dto.invoiceImages || [] } as CreateTransactionDto;
      const transaction = await this.transactions.create(txDto, actor.role, undefined, undefined, context);
      const poUpdate: any = { linkedTransactionId: String(transaction._id), updatedAt: new Date(), ...(dto.tracking ? { items: poItems, unitReceiptOperationKey: operationKey } : {}) };
      const history = { status: 'محوّل إلى فاتورة', changedBy: name, changedAt: new Date().toISOString(), note: `فاتورة رقم ${dto.ref}` };
      const updated = await this.connection.collection('purchaseorders').findOneAndUpdate({ _id: po._id }, { $set: poUpdate, $push: { statusHistory: history } } as any,
        { session, returnDocument: 'after', includeResultMetadata: false });
      const receipt = dto.tracking ? await this.units.createReceiptUnits(transaction.toObject(), id.toLowerCase(), dto.tracking.warehouseCode, request, actor, name, session, dto.tracking.inspectionPassed === true) :
        { createdUnits: 0, unitIds: [], trackingRequested: false, printStatus: 'not-applicable', unresolvedErrors: [] };
      return { po: updated, transaction: transaction.toObject(), receipt, quantityDifference, enforcementEnabled: false };
    });
  }

  async summary(id: string) {
    if (!OBJECT_ID_PATTERN.test(id)) throw new BadRequestException('Invalid purchase order ID');
    const po = await this.connection.collection('purchaseorders').findOne({ _id: new Types.ObjectId(id) });
    if (!po) throw new NotFoundException('Purchase order not found');
    const tx = OBJECT_ID_PATTERN.test(po.linkedTransactionId || '') ? await this.connection.collection('transactions').findOne({ _id: new Types.ObjectId(po.linkedTransactionId) }) : null;
    const units = await this.connection.collection('inventoryunits').find({ 'origin.purchaseOrderId': id.toLowerCase() }, { projection: { barcode: 1, origin: 1, status: 1 } }).toArray();
    const requested = await this.connection.collection('inventoryunitevents').distinct('unitId', { unitId: { $in: units.map(unit => String(unit._id)) }, action: { $in: ['label-print-requested', 'label-reprint-requested', 'label-printed', 'label-reprinted'] } });
    const errors: string[] = [];
    if (tx?.cancelled || tx?.archived) errors.push('الفاتورة ملغاة/مؤرشفة: لا تُحذف الوحدات؛ يلزم فحص الحيازة ومراجعة إجراءات العكس الحالية');
    const lines = (tx?.items || []).map((line: any) => ({ lineId: line.lineId, sku: line.code, receivedQty: line.qty,
      invoiceLinePrice: line.price, createdUnits: units.filter(unit => unit.origin.purchaseLineId === line.lineId).length }));
    if (units.length && lines.some((line: any) => line.createdUnits !== line.receivedQty)) errors.push('كميات الوحدات لا تطابق السطور الحالية للفاتورة؛ مراجعة مطلوبة');
    return { purchaseOrderId: id.toLowerCase(), transactionId: po.linkedTransactionId || null, supplierId: po.supplierId,
      posted: !!tx, reversedOrArchived: !!(tx?.cancelled || tx?.archived), lines, createdUnits: units.length, labelRequests: requested.length,
      labelsWithoutRequests: units.length - requested.length, physicalPrintingVerified: false, unresolvedErrors: errors, enforcementEnabled: false };
  }
}
