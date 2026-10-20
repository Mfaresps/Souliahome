import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { InventoryUnitsService, TrackingActor } from './inventory-units.service';
import { ManualPurchaseReceiptDto } from './manual-purchase.dto';
import { TransactionsService } from '../transactions/transactions.service';
import { CreateTransactionDto } from '../transactions/dto/transaction.dto';
import { OBJECT_ID_PATTERN } from './inventory-unit.constants';

/** Opt-in, physically confirmed direct purchase. No synthetic purchase order or extra stock ledger. */
@Injectable()
export class ManualPurchaseReceivingService {
  constructor(@InjectConnection() private readonly connection: Connection,
    private readonly units: InventoryUnitsService, private readonly transactions: TransactionsService) {}

  async receive(dto: ManualPurchaseReceiptDto, actor: TrackingActor) {
    if (actor?.role !== 'admin' && !actor?.perms?.includes('inventory-units-receive')) throw new ForbiddenException('Unit receiving permission required');
    const invoice = dto.invoice, tracking = dto.tracking;
    if (!invoice || invoice.type !== 'مشتريات' || !tracking || tracking.physicalPossessionConfirmed !== true || !tracking.warehouseCode?.trim()) throw new BadRequestException('Supplier purchase, confirmed physical receipt and warehouse required');
    if (invoice.manualDepositReceiptId) throw new BadRequestException('Customer deposit receipts cannot be attached to supplier receiving');
    if (!invoice.ref?.trim() || !invoice.client?.trim() || !invoice.items?.length) throw new BadRequestException('Supplier, reference and received items required');
    let quantity = 0, itemsTotal = 0;
    for (const line of invoice.items) {
      if (!Number.isSafeInteger(line.qty) || line.qty < 1 || !Number.isFinite(line.price) || !Number.isFinite(line.total) || line.price < 0 || Math.abs(line.total - line.qty * line.price) > 0.000001) throw new BadRequestException('Invalid whole-piece quantities or invoice line totals');
      quantity += line.qty; itemsTotal += line.qty * line.price;
    }
    if (quantity > 10000) throw new BadRequestException('Maximum 10000 tracked pieces per receipt');
    const discount = Number(invoice.discount || 0), deposit = Number(invoice.deposit || 0), credit = Number(invoice.creditApplied || 0);
    const total = itemsTotal - discount, remaining = Math.max(0, total - deposit - credit);
    if (![itemsTotal, discount, deposit, credit, total, remaining, invoice.total].every(Number.isFinite) || discount < 0 || deposit < 0 || credit < 0 || total < 0 || deposit + credit - total > 0.000001 ||
      Math.abs(invoice.total - total) > 0.000001 || invoice.itemsTotal != null && Math.abs(invoice.itemsTotal - itemsTotal) > 0.000001 ||
      invoice.remaining != null && Math.abs(invoice.remaining - remaining) > 0.000001 || Number(invoice.shipCost || 0) !== 0 ||
      invoice.payStatus && invoice.payStatus !== (remaining <= 0 ? 'مكتمل' : 'معلق')) throw new BadRequestException('Purchase totals, deposit, credit or remaining amount do not match the existing invoice rules');

    const required = ['transactions', 'settings', 'vaultentries', 'supplierledgerentries', 'inventorymovements', 'products', 'users', 'suppliers'];
    const existing = await this.connection.db!.listCollections({}, { nameOnly: true }).toArray();
    if (required.some(name => !existing.some(row => row.name === name))) throw new ServiceUnavailableException('Initialize existing purchase financial collections before atomic receiving');
    const indexes = await this.connection.collection('inventorymovements').listIndexes().toArray();
    if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify({ movementId: 1 }) && index.unique && !index.sparse && !index.partialFilterExpression)) throw new ServiceUnavailableException('Unique inventory movement index required');

    const request = { operationKey: dto.operationKey, reason: tracking.reason?.trim() || 'Physical receipt confirmed; no receipt reference supplied', invoice, tracking };
    return this.units.manualPurchaseOperation(request, actor, async (session, name, context) => {
      if (await this.connection.collection('settings').countDocuments({}, { session }) !== 1) throw new ConflictException('Exactly one initialized financial settings record required');
      await this.connection.collection('settings').updateOne({}, { $inc: { purchaseReceivingRevision: 1 } }, { session });
      const suppliers = await this.connection.collection('suppliers').find({}, { session }).toArray();
      const matching = suppliers.filter(row => String(row.name || '').trim().toLowerCase() === invoice.client!.trim().toLowerCase());
      if (matching.length !== 1 || invoice.supplierId && String(matching[0]._id) !== invoice.supplierId) throw new ConflictException('Supplier identity/name ambiguous or mismatched');
      await this.connection.collection('suppliers').updateOne({ _id: matching[0]._id }, { $inc: { receivingRevision: 1 } }, { session });
      const products = await this.connection.collection('products').find({}, { session, projection: { code: 1 } }).toArray();
      const lines = invoice.items.map(line => {
        const matches = products.filter(row => String(row.code || '').trim() === String(line.code || '').trim());
        if (!line.code.trim() || matches.length !== 1 || line.productId && String(matches[0]._id) !== line.productId) throw new ConflictException('Missing/duplicate SKU or mismatched product identity');
        return { ...line, productId: String(matches[0]._id), lineId: randomUUID() };
      });
      const payload = { ...invoice, warehouseCode: invoice.warehouseCode || tracking.warehouseCode || 'MAIN', items: lines, supplierId: String(matching[0]._id), employee: name } as CreateTransactionDto;
      const transaction = await this.transactions.create(payload, actor.role, undefined, name, context);
      const receipt = await this.units.createReceiptUnits(transaction.toObject(), undefined, tracking.warehouseCode, request, actor, name, session, tracking.inspectionPassed === true);
      return { transaction: transaction.toObject(), receipt, enforcementEnabled: false };
    });
  }

  async summary(id: string) {
    if (!OBJECT_ID_PATTERN.test(id)) throw new BadRequestException('Invalid purchase identifier');
    const purchase = await this.connection.collection('transactions').findOne({ _id: new Types.ObjectId(id), type: 'مشتريات' });
    if (!purchase) throw new NotFoundException('Purchase not found');
    const units = await this.connection.collection('inventoryunits').find({ 'origin.purchaseTransactionId': id.toLowerCase() }, { projection: { origin: 1 } }).toArray();
    const requested = await this.connection.collection('inventoryunitevents').distinct('unitId', { unitId: { $in: units.map(row => String(row._id)) }, action: { $in: ['label-print-requested', 'label-reprint-requested'] } });
    const lines = (purchase.items || []).map((line: any) => ({ lineId: line.lineId, sku: line.code, receivedQty: line.qty, createdUnits: units.filter(row => row.origin.purchaseLineId === line.lineId).length }));
    const unresolvedErrors: string[] = [];
    if (purchase.cancelled || purchase.archived) unresolvedErrors.push('Purchase reversed/archived; retain identities and review physical custody');
    if (units.length && lines.some((line: any) => line.createdUnits !== line.receivedQty)) unresolvedErrors.push('Current purchase lines differ from unit identities; reconciliation required');
    return { transactionId: id.toLowerCase(), lines, createdUnits: units.length, labelRequests: requested.length, physicalPrintingVerified: false, unresolvedErrors, enforcementEnabled: false };
  }
}
