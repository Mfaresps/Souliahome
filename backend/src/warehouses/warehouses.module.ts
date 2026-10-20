import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, OnModuleInit, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { randomUUID, createHash } from 'crypto';
import { IsArray, IsObject, IsString, MaxLength, ArrayMaxSize, ArrayMinSize, Matches, Equals } from 'class-validator';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { TransactionsModule } from '../transactions/transactions.module';
import { TransactionsService } from '../transactions/transactions.service';
import { MAIN_WAREHOUSE, requireWarehouse, warehouseCode } from './warehouse-storage';

class WarehouseDto {
  @IsString() @MaxLength(80) name: string;
}
class TransferDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,120}$/) operationKey: string;
  @IsString() @MaxLength(120) from: string;
  @IsString() @MaxLength(120) to: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10000) @IsString({ each: true }) productIds: string[];
  @IsString() @MaxLength(1000) reason: string;
  @IsObject() quantities: Record<string, number>;
  @Equals(true) physicalTransferConfirmed: boolean;
}
type Actor = { role?: string; userId?: string; name?: string; username?: string; perms?: string[] };

@Injectable()
class WarehousesService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly transactions: TransactionsService) {}
  async onModuleInit() {
    // Collections and unique indexes must exist before the first atomic transfer.
    for (const name of ['warehouses', 'warehousetransfers']) {
      if (!(await this.connection.db!.listCollections({ name }, { nameOnly: true }).toArray()).length) {
        try { await this.connection.db!.createCollection(name); } catch (error: any) { if (error.codeName !== 'NamespaceExists') throw error; }
      }
    }
    await this.connection.collection('warehouses').createIndex({ code: 1 }, { unique: true });
    await this.connection.collection('warehouses').createIndex({ name: 1 }, { unique: true });
    await this.connection.collection('warehouses').updateOne({ code: MAIN_WAREHOUSE }, { $setOnInsert: { code: MAIN_WAREHOUSE, name: 'المخزن الرئيسي', active: true, isDefault: true, createdAt: new Date() } }, { upsert: true });
    // Preserve named legacy locations rather than silently merging them into MAIN.
    const legacy = await this.connection.collection('inventoryunits').distinct('warehouseCode');
    for (const location of legacy) {
      const code = warehouseCode(location);
      if (code !== MAIN_WAREHOUSE) await this.connection.collection('warehouses').updateOne({ code }, { $setOnInsert: { code, name: code, active: true, isDefault: false, createdAt: new Date() } }, { upsert: true });
    }
  }
  list() { return this.connection.collection('warehouses').find({}, { projection: { code: 1, name: 1, isDefault: 1, active: 1 } }).sort({ isDefault: -1, active: -1, createdAt: 1 }).toArray(); }
  async remove(code: string, actor: Actor) {
    this.admin(actor);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const warehouse = await this.connection.collection('warehouses').findOneAndUpdate({ code, active: { $ne: false } }, { $inc: { revision: 1 } }, { session, returnDocument: 'after', includeResultMetadata: false });
        if (!warehouse) throw new BadRequestException('المخزن غير موجود أو محذوف بالفعل');
        if (warehouse.isDefault || code === MAIN_WAREHOUSE) throw new ConflictException('المخزن الرئيسي الافتراضي مرتبط بالمبيعات والرصيد الافتتاحي ولا يمكن حذفه؛ يمكنك تعديل اسمه');
        const inventory = await this.transactions.getInventory(session);
        const balances = inventory.filter(row => Math.abs(Number(row.warehouseBalances?.[code] || 0)) > 0.000001);
        if (balances.length) throw new ConflictException({ code: 'WAREHOUSE_HAS_STOCK', message: `لا يمكن حذف «${warehouse.name}»: يوجد رصيد ${balances.slice(0, 5).map(row => `${row.code}: ${row.warehouseBalances[code]} قطعة`).join('، ')}. انقل الرصيد أولًا من نافذة نقل المنتجات.`, warehouseCode: code });
        const pieces = await this.connection.collection('inventoryunits').countDocuments({ warehouseCode: code, $or: [{ status: { $in: ['available', 'reserved', 'picking', 'prepared', 'returned', 'inspection-required', 'damaged', 'supplier-return-pending'] } }, { assignment: { $ne: null } }] }, { session });
        if (pieces) throw new ConflictException(`الرصيد المحاسبي صفر، لكن يوجد ${pieces} كود قطعة أو حجز مرتبط بالمخزن. راجع سجل القطع أو انقل القطع قبل الحذف.`);
        await this.connection.collection('warehouses').updateOne({ code }, { $set: { active: false, deletedAt: new Date(), deletedBy: actor.userId, deletedByName: actor.name || actor.username }, $push: { activity: { action: 'deleted', at: new Date(), by: actor.userId } } } as any, { session });
      });
      return { code, deleted: true, historyPreserved: true };
    } finally { await session.endSession(); }
  }
  async restore(code: string, actor: Actor) {
    this.admin(actor);
    const warehouse = await this.connection.collection('warehouses').findOneAndUpdate({ code, active: false }, { $set: { active: true, restoredAt: new Date(), restoredBy: actor.userId }, $push: { activity: { action: 'restored', at: new Date(), by: actor.userId } } } as any, { returnDocument: 'after', includeResultMetadata: false });
    if (!warehouse) throw new BadRequestException('المخزن غير موجود ضمن المخازن المحذوفة');
    return warehouse;
  }
  async save(dto: WarehouseDto, actor: Actor, code?: string) {
    this.admin(actor);
    const name = String(dto.name || '').trim();
    if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new BadRequestException('أدخل اسم مخزن صالحًا');
    const duplicate = await this.connection.collection('warehouses').findOne({ name, ...(code ? { code: { $ne: code } } : {}) });
    if (duplicate) throw new ConflictException('اسم المخزن مستخدم بالفعل');
    try {
      if (code) {
        const updated = await this.connection.collection('warehouses').findOneAndUpdate({ code }, { $set: { name, updatedAt: new Date(), updatedBy: actor.userId } }, { returnDocument: 'after', includeResultMetadata: false });
        if (!updated) throw new BadRequestException('المخزن غير موجود');
        return updated;
      }
      const warehouse = { code: 'WH-' + randomUUID().slice(0, 8).toUpperCase(), name, active: true, isDefault: false, createdAt: new Date(), createdBy: actor.userId };
      await this.connection.collection('warehouses').insertOne(warehouse);
      return warehouse;
    } catch (error: any) { if (error.code === 11000) throw new ConflictException('اسم المخزن مستخدم بالفعل'); throw error; }
  }
  admin(actor: Actor) { if (actor.role !== 'admin') throw new ForbiddenException('إدارة المخازن والنقل متاحة للمدير'); }
  async history(actor: Actor) { this.admin(actor); return this.connection.collection('warehousetransfers').find({}, { projection: { lines: 1, from: 1, to: 1, by: 1, reason: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(30).toArray(); }
  async transfer(dto: TransferDto, actor: Actor) {
    this.admin(actor);
    if (!Types.ObjectId.isValid(actor.userId || '')) throw new ForbiddenException('هوية المستخدم مطلوبة');
    if (!dto.reason?.trim() || !dto.productIds.length || new Set(dto.productIds).size !== dto.productIds.length || dto.productIds.some(id => !/^[a-f\d]{24}$/i.test(id))) throw new BadRequestException('حدد المنتجات وسبب النقل');
    const from = warehouseCode(dto.from), to = warehouseCode(dto.to);
    if (from === to) throw new BadRequestException('اختر مخزنًا مختلفًا للنقل');
    const request = { from, to, productIds: [...dto.productIds].map(id => id.toLowerCase()).sort(), reason: dto.reason.trim(), actor: actor.userId, quantities: dto.quantities };
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const operationId = actor.userId + ':' + dto.operationKey;
    const session = await this.connection.startSession();
    let response: any;
    try {
      await session.withTransaction(async () => {
        const prior = await this.connection.collection('warehousetransfers').findOne({ _id: operationId as any }, { session });
        if (prior) { if (prior.digest !== digest) throw new ConflictException('طلب النقل السابق مختلف؛ راجع سجل النقل'); response = prior; return; }
        await requireWarehouse(this.connection, from, session); await requireWarehouse(this.connection, to, session);
        const now = new Date();
        // Receipts and unit lifecycle writers take this same per-product lock.
        const productIds = request.productIds.map(id => new Types.ObjectId(id));
        const locked = await this.connection.collection('products').updateMany({ _id: { $in: productIds } }, { $inc: { unitTrackingRevision: 1 } }, { session });
        if (locked.matchedCount !== productIds.length) throw new ConflictException('أحد المنتجات لم يعد موجودًا');
        const inventory = await this.transactions.getInventory(session);
        const lines = request.productIds.map(id => {
          const row = inventory.find(item => item._id === id);
          if (!row) throw new ConflictException('المنتج غير موجود');
          if (!String(row.code || '').trim() || inventory.filter(item => String(item.code || '').trim() === String(row.code).trim()).length !== 1) throw new ConflictException('SKU مفقود أو مكرر؛ صحح بيانات المنتج قبل النقل');
          const quantity = Number(row.warehouseBalances?.[from] || 0);
          if (!Number.isFinite(quantity) || quantity <= 0) throw new ConflictException(`لا يوجد رصيد موجب في مخزن المصدر للمنتج ${row.name}`);
          if (!Number.isFinite(dto.quantities[id]) || Math.abs(dto.quantities[id] - quantity) > 0.000001) throw new ConflictException(`تغير رصيد المنتج ${row.name}؛ أغلق نافذة النقل وافتحها لمراجعة الكمية الجديدة`);
          return { productId: id, code: row.code, name: row.name, quantity, fromBefore: quantity, fromAfter: 0, toBefore: Number(row.warehouseBalances?.[to] || 0), toAfter: Number(row.warehouseBalances?.[to] || 0) + quantity };
        });
        const sourceLocations = from === MAIN_WAREHOUSE ? [MAIN_WAREHOUSE, null, '', 'main', 'المخزن الرئيسي'] : [from];
        const pieces: any[] = await this.connection.collection('inventoryunits').find({ productId: { $in: request.productIds }, warehouseCode: { $in: sourceLocations }, status: { $in: ['available', 'reserved', 'picking', 'prepared', 'returned', 'inspection-required', 'damaged', 'supplier-return-pending'] } }, { session }).toArray();
        if (pieces.some(piece => piece.supplierReturnId || piece.assignment || ['reserved', 'picking', 'prepared'].includes(piece.status))) throw new ConflictException('توجد قطع محجوزة أو قيد التحضير؛ حررها قبل نقل المنتج بالكامل');
        for (const line of lines) if (pieces.filter(piece => piece.productId === line.productId).length > line.quantity) throw new ConflictException(`أكواد القطع تتجاوز الرصيد للمنتج ${line.name}؛ راجع الجرد قبل النقل`);
        const actorName = actor.name || actor.username || actor.userId!;
        for (const piece of pieces) {
          const unitId = String(piece._id);
          const previous = await this.connection.collection('inventoryunitevents').findOne({ unitId }, { session, sort: { sequence: -1 } });
          await this.connection.collection('inventoryunitevents').insertOne({ unitId, sequence: (previous?.sequence || 0) + 1, operationKey: 'warehouse:' + operationId, action: 'warehouse-changed', fromStatus: piece.status, toStatus: piece.status, byUserId: actor.userId, by: actorName, reason: request.reason, details: { fromWarehouseCode: piece.warehouseCode, toWarehouseCode: to }, createdAt: now, updatedAt: now }, { session });
        }
        if (pieces.length) await this.connection.collection('inventoryunits').updateMany({ _id: { $in: pieces.map(piece => piece._id) } }, { $set: { warehouseCode: to, updatedAt: now }, $inc: { __v: 1 } }, { session });
        response = { _id: operationId as any, digest, ...request, by: actorName, lines, unitIds: pieces.map(piece => String(piece._id)), createdAt: now };
        const movements = lines.flatMap(line => [
          { warehouseCode: from, qtyDelta: -line.quantity, qtyBefore: line.fromBefore, qtyAfter: line.fromAfter },
          { warehouseCode: to, qtyDelta: line.quantity, qtyBefore: line.toBefore, qtyAfter: line.toAfter },
        ].map(location => ({ ...location, movementId: 'WH-' + randomUUID(), warehouseTransferId: operationId,
          productId: line.productId, productCode: line.code, productName: line.name, type: 'نقل مخزني', sourceType: 'warehouse-transfer',
          sourceTransactionId: '', sourceTransactionRef: '', by: actorName, byUserId: actor.userId, reason: request.reason,
          notes: `نقل من ${from} إلى ${to}`, createdAt: now, updatedAt: now })));
        if (movements.length) await this.connection.collection('inventorymovements').insertMany(movements, { session });
        await this.connection.collection('warehousetransfers').insertOne(response, { session });
      });
      return response;
    } catch (error: any) { if (error.code === 20 || /replica set|Transaction numbers/.test(error.message || '')) throw new ConflictException('النقل يتطلب قاعدة بيانات تدعم المعاملات الذرية'); throw error; }
    finally { await session.endSession(); }
  }
}

@Controller('warehouses') @UseGuards(JwtAuthGuard)
class WarehousesController {
  constructor(private readonly service: WarehousesService) {}
  @Get() list() { return this.service.list(); }
  @Post() create(@Body() dto: WarehouseDto, @Req() req: { user: Actor }) { return this.service.save(dto, req.user); }
  @Delete(':code') remove(@Param('code') code: string, @Req() req: { user: Actor }) { return this.service.remove(code, req.user); }
  @Post(':code/restore') restore(@Param('code') code: string, @Req() req: { user: Actor }) { return this.service.restore(code, req.user); }
  @Patch(':code') rename(@Param('code') code: string, @Body() dto: WarehouseDto, @Req() req: { user: Actor }) { return this.service.save(dto, req.user, code); }
  @Get('transfers') history(@Req() req: { user: Actor }) { return this.service.history(req.user); }
  @Post('transfers') transfer(@Body() dto: TransferDto, @Req() req: { user: Actor }) { return this.service.transfer(dto, req.user); }
}
@Module({ imports: [TransactionsModule], controllers: [WarehousesController], providers: [WarehousesService] })
export class WarehousesModule {}
