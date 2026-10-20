import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { TransactionsService } from '../transactions/transactions.service';
import { InventoryUnitsService, TrackingActor } from './inventory-units.service';
import { ScannedSaleDto } from './scanned-sale.dto';
import { warehouseCode } from '../warehouses/warehouse-storage';

/** One financial sale and its physical reservations, committed together. No stock is posted twice. */
@Injectable()
export class ScannedSaleService {
  constructor(@InjectConnection() private readonly connection: Connection,
    private readonly tracking: InventoryUnitsService, private readonly transactions: TransactionsService) {}

  async create(dto: ScannedSaleDto, actor: TrackingActor) {
    const invoice = dto.invoice;
    if (invoice.type !== 'مبيعات' || !invoice.items?.length || !dto.bindings?.length) throw new BadRequestException('A sale and scanned pieces are required');
    let itemsTotal = 0;
    for (const line of invoice.items) {
      if (!Number.isSafeInteger(line.qty) || line.qty < 1 || !Number.isFinite(line.price) || line.price < 0 || !Number.isFinite(line.total) || Math.abs(line.total - line.qty * line.price) > .000001) throw new BadRequestException('Invalid sale quantities or line totals');
      itemsTotal += line.total;
    }
    const discount = Number(invoice.discount || 0), shipping = Number(invoice.shipCost || 0), deposit = Number(invoice.deposit || 0);
    const total = itemsTotal - discount + shipping;
    if (![discount, shipping, deposit, total, invoice.total].every(Number.isFinite) || discount < 0 || discount > itemsTotal || shipping < 0 || deposit < 0 || deposit > total || Math.abs(invoice.total - total) > .000001 ||
      invoice.itemsTotal != null && Math.abs(invoice.itemsTotal - itemsTotal) > .000001 || invoice.remaining != null && Math.abs(invoice.remaining - (total - deposit)) > .000001) throw new BadRequestException('Sale totals do not match its items and payment');
    const request = { ...dto, reason: 'Scanned physical pieces linked while saving a new sale' };
    return this.tracking.packOperation('new-sale', request, actor, async (session, name, context) => {
      // Serialize this path's stock check and money writes with its physical identity claims.
      const settings = await this.connection.collection('settings').findOneAndUpdate({}, { $inc: { scannedSaleRevision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
      if (!settings) throw new ConflictException('Initialize financial settings before saving scanned sales');
      const lines: any[] = [];
      for (const line of invoice.items) {
        const matches = await this.connection.collection('products').find({ code: line.code }, { session }).toArray();
        if (matches.length !== 1 || line.productId !== String(matches[0]._id) || lines.some(row => row.productId === line.productId)) throw new ConflictException('Missing, duplicate or mismatched sale product');
        await this.connection.collection('products').updateOne({ _id: matches[0]._id }, { $inc: { unitTrackingRevision: 1 } }, { session });
        lines.push({ ...line, lineId: randomUUID() });
      }
      const claimed = new Set<string>(), reservations: any[] = [], seenProducts = new Set<string>();
      for (const binding of dto.bindings) {
        const line = lines.find(row => row.productId === binding.productId);
        if (!line || seenProducts.has(binding.productId)) throw new BadRequestException('Invalid or duplicate scanned product binding');
        seenProducts.add(binding.productId);
        const ids = (binding.unitIds || []).map(id => ({ id: id.toLowerCase(), packId: undefined as string | undefined }));
        for (const packId of binding.packIds || []) {
          const pack: any = await this.connection.collection('inventorypacks').findOneAndUpdate({ _id: new Types.ObjectId(packId), state: 'sealed' }, { $inc: { revision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
          if (!pack || pack.productId !== binding.productId || !Number.isSafeInteger(pack.quantity) || pack.unitIds?.length !== pack.quantity || warehouseCode(pack.warehouseCode) !== warehouseCode(invoice.warehouseCode)) throw new ConflictException('Pack changed, is open, or belongs to another product/warehouse');
          ids.push(...pack.unitIds.map((id: string) => ({ id: String(id).toLowerCase(), packId: String(pack._id) })));
        }
        if (!ids.length || ids.length > line.qty || claimed.size + ids.length > 1000) throw new BadRequestException('Scanned piece count exceeds the invoice quantity or limit');
        for (const entry of ids) {
          if (claimed.has(entry.id)) throw new ConflictException('The same piece was scanned more than once');
          claimed.add(entry.id);
          const unit: any = await this.connection.collection('inventoryunits').findOne({ _id: new Types.ObjectId(entry.id) }, { session });
          if (!unit || unit.status !== 'available' || unit.assignment || unit.productId !== binding.productId || (unit.packId || undefined) !== entry.packId || warehouseCode(unit.warehouseCode) !== warehouseCode(invoice.warehouseCode)) throw new ConflictException('A scanned piece is no longer available in this warehouse');
          reservations.push({ ...entry, version: unit.__v || 0, lineId: line.lineId });
        }
      }
      const payload = { ...invoice, items: lines, employee: name };
      const receipt = invoice.manualDepositReceiptId ? { draftId: invoice.manualDepositReceiptId, actor: { id: actor.userId!, username: actor.username || '', name, isAdmin: actor.role === 'admin' } } : undefined;
      const transaction = await this.transactions.create(payload, actor.role, receipt, name, context, true);
      for (const row of reservations) await this.tracking.actionInSession(row.id, {
        operationKey: dto.operationKey, reason: request.reason, action: 'reserve', expectedVersion: row.version,
        transactionId: String(transaction._id), lineId: row.lineId, physicalPossessionConfirmed: true,
      }, actor, session, name, row.packId, context);
      return { transaction: transaction.toObject(), transactionId: String(transaction._id), reservedPieces: reservations.length };
    });
  }
}
