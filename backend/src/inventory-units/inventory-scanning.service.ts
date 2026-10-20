import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { createHash } from 'crypto';
import { InventoryUnitsService, TrackingActor } from './inventory-units.service';
import { InventoryUnit } from './schemas/inventory-unit.schema';
import { InventoryUnitEvent } from './schemas/inventory-unit-event.schema';
import { InventoryUnitOperation } from './schemas/inventory-unit-operation.schema';
import { EligibleScanQueryDto, SCAN_INTENTS, ScanContextDto, ScanRequestDto } from './inventory-scan.dto';
import { OBJECT_ID_PATTERN } from './inventory-unit.constants';

// Eligibility is advisory until the EXISTING lifecycle action revalidates and commits.
// Scans append audit evidence only; they never infer custody or mutate stock/state.
@Injectable()
export class InventoryScanningService {
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel(InventoryUnit.name) private readonly units: Model<any>,
    @InjectModel(InventoryUnitEvent.name) private readonly events: Model<any>,
    @InjectModel(InventoryUnitOperation.name) private readonly operations: Model<any>,
    private readonly tracking: InventoryUnitsService) {}

  private id(value: string) {
    if (!OBJECT_ID_PATTERN.test(value || '')) throw new BadRequestException('Invalid identifier');
    return new Types.ObjectId(value);
  }
  private permission(actor: TrackingActor, value: string) {
    if (!actor?.userId || !OBJECT_ID_PATTERN.test(actor.userId) || (actor.role !== 'admin' && !actor.perms?.includes(value))) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `Permission required: ${value}` });
    }
  }
  private context(dto: ScanContextDto, actor: TrackingActor, manual = false) {
    this.permission(actor, 'inventory-units-view');
    if (!(SCAN_INTENTS as readonly string[]).includes(dto.intent) || !/^[A-Za-z0-9:_-]{8,120}$/.test(dto.sessionKey || '')) throw new BadRequestException('Invalid scan context');
    const permissions: Record<string, string> = { inspect: 'inventory-units-condition', reserve: 'inventory-units-allocate', picking: 'inventory-units-allocate', prepare: 'inventory-units-allocate', return: 'inventory-units-condition', count: 'inventory-units-reconcile' };
    if (permissions[dto.intent]) this.permission(actor, permissions[dto.intent]);
    if (manual) this.permission(actor, 'inventory-units-manual-select');
    if (dto.intent !== 'lookup' && !dto.productId) throw new BadRequestException('Expected product is required');
    if (dto.productId) this.id(dto.productId);
    if (dto.transactionId) this.id(dto.transactionId);
    if (['reserve', 'picking', 'prepare', 'return'].includes(dto.intent) && (!dto.transactionId || !dto.lineId?.trim())) throw new BadRequestException('Exact transaction and stable line ID required');
  }
  private states(intent: string): string[] | undefined {
    return ({ inspect: ['inspection-required', 'returned'], reserve: ['available'], picking: ['reserved'], prepare: ['picking'], return: ['shipped', 'delivered'] } as Record<string, string[]>)[intent];
  }
  private async check(unit: any, dto: ScanContextDto, actor: TrackingActor, session?: ClientSession, catalog?: any[]): Promise<string | null> {
    if (!unit) return 'UNKNOWN_BARCODE';
    if (dto.productId && unit.productId !== dto.productId.toLowerCase()) return 'WRONG_PRODUCT';
    const products = this.connection.collection('products');
    const product = catalog ? catalog.find(row => String(row._id) === unit.productId) : await products.findOne({ _id: this.id(unit.productId) }, { session });
    if (!product || !String(product.code || '').trim()) return 'UNAVAILABLE_UNIT';
    const codes = catalog || await products.find({}, { session, projection: { code: 1 } }).toArray();
    if (codes.filter(row => String(row.code || '').trim() === String(product.code).trim()).length !== 1) return 'UNAVAILABLE_UNIT';
    if (await this.events.exists({ unitId: String(unit._id), byUserId: actor.userId!.toLowerCase(),
      action: { $in: ['scan-validated', 'manual-selection-confirmed'] }, 'details.sessionKey': dto.sessionKey }).session(session || null)) return 'DUPLICATE_SCAN';
    if (this.states(dto.intent) && !this.states(dto.intent)!.includes(unit.status)) return 'INVALID_UNIT_STATE';
    if (['inspect', 'reserve'].includes(dto.intent) && unit.assignment) return 'UNAVAILABLE_UNIT';
    if (['picking', 'prepare', 'return'].includes(dto.intent) &&
      (unit.assignment?.transactionId !== dto.transactionId?.toLowerCase() || unit.assignment?.lineId !== dto.lineId)) return 'UNAVAILABLE_UNIT';
    if ((unit.origin?.purchaseOrderId || unit.origin?.purchaseLineId) && !['lookup', 'count', 'return'].includes(dto.intent)) {
      const purchase = await this.connection.collection('transactions').findOne({ _id: this.id(unit.origin.purchaseTransactionId), type: 'مشتريات', cancelled: { $ne: true }, archived: { $ne: true } }, { session });
      const line = purchase?.items?.find((row: any) => row.lineId === unit.origin.purchaseLineId && String(row.code || '').trim() === String(product.code).trim());
      const count = await this.units.countDocuments({ 'origin.purchaseTransactionId': unit.origin.purchaseTransactionId, 'origin.purchaseLineId': unit.origin.purchaseLineId }).session(session || null);
      if (!line || !Number.isSafeInteger(line.qty) || count !== line.qty) return 'UNAVAILABLE_UNIT';
    }
    if (['reserve', 'picking', 'prepare', 'return'].includes(dto.intent)) {
      // Existing physical return action permits dispatched goods after financial cancellation.
      // Identifying those goods must not assert custody or undo that cancellation.
      const sale = await this.connection.collection('transactions').findOne({ _id: this.id(dto.transactionId!), type: 'مبيعات',
        ...(dto.intent === 'return' ? {} : { cancelled: { $ne: true }, archived: { $ne: true } }) }, { session });
      const lines = (sale?.items || []).filter((row: any) => row.lineId === dto.lineId && String(row.code || '').trim() === String(product.code).trim());
      if (lines.length !== 1 || !Number.isSafeInteger(lines[0].qty) || lines[0].qty < 1) return 'UNAVAILABLE_UNIT';
      if (dto.intent === 'reserve') {
        const claimed = await this.units.find({ 'assignment.transactionId': dto.transactionId!.toLowerCase(), 'assignment.lineId': dto.lineId,
          status: { $in: ['reserved', 'picking', 'prepared', 'shipped', 'delivered', 'lost', 'damaged'] } }).select('_id').session(session || null).lean();
        const shipped = await this.events.distinct('unitId', { action: 'shipped', transactionId: dto.transactionId!.toLowerCase(), lineId: dto.lineId }).session(session || null);
        if (new Set([...claimed.map((row: any) => String(row._id)), ...shipped]).size >= lines[0].qty) return 'UNAVAILABLE_UNIT';
      }
    }
    return null;
  }
  async validate(dto: ScanRequestDto, actor: TrackingActor) {
    const manual = dto.inputMethod === 'manual-selection';
    this.context(dto, actor, manual);
    if (!['keyboard', 'camera', 'manual-entry', 'manual-selection'].includes(dto.inputMethod) || !dto.identifier || dto.identifier.length > 160 || /[\x00-\x1f\x7f]/.test(dto.identifier)) throw new BadRequestException('Invalid scan input; no control characters allowed');
    if (manual && (dto.manualSelectionConfirmed !== true || !dto.reason?.trim())) throw new BadRequestException('Explicit manual selection confirmation and reason required');
    return this.tracking.scanOperation(dto, actor, async (session, name) => {
      if (/^PK/i.test(dto.identifier) || /^\d{7}$/.test(dto.identifier)) {
        const result = await this.tracking.lookupPack(dto.identifier, session);
        if (!result) return { outcome: 'rejected', code: 'UNKNOWN_BARCODE', stockChanged: false, lifecycleChanged: false };
        if (dto.intent !== 'lookup') return { outcome: 'rejected', code: 'UNAVAILABLE_UNIT', stockChanged: false, lifecycleChanged: false };
        return { outcome: 'accepted', code: 'VALIDATED', unit: result.unit, eligibilityOnly: true, stockChanged: false, lifecycleChanged: false };
      }
      const unit: any = await this.units.findOne(await this.tracking.identifierFilter(dto.identifier, session)).session(session).lean();
      // Same lock order as lifecycle writes: product first; concurrent audit sequences retry safely.
      if (unit) await this.connection.collection('products').updateOne({ _id: this.id(unit.productId) }, { $inc: { unitTrackingRevision: 1 } }, { session });
      const code = await this.check(unit, dto, actor, session);
      if (code) return { outcome: 'rejected', code, stockChanged: false, lifecycleChanged: false };
      const last: any = await this.events.findOne({ unitId: String(unit._id) }).sort({ sequence: -1 }).session(session).lean();
      await new this.events({ unitId: String(unit._id), sequence: (last?.sequence || 0) + 1,
        operationKey: createHash('sha256').update(JSON.stringify({ actor: actor.userId!.toLowerCase(), key: dto.operationKey })).digest('hex'),
        action: manual ? 'manual-selection-confirmed' : 'scan-validated', fromStatus: unit.status, toStatus: unit.status,
        byUserId: actor.userId, by: name, reason: dto.reason,
        details: { sessionKey: dto.sessionKey, intent: dto.intent, inputMethod: dto.inputMethod,
          expectedProductId: dto.productId || null, transactionId: dto.transactionId || null, lineId: dto.lineId || null,
          manualSelectionConfirmed: manual, custodyConfirmed: false } }).save({ session });
      const [identified] = await this.tracking.withManualCodes([unit]);
      return { outcome: 'accepted', code: 'VALIDATED', unit: { _id: String(unit._id), barcode: unit.barcode, manualCode: identified.manualCode, productId: unit.productId, status: unit.status, version: unit.__v },
        supplierReturn: await this.tracking.supplierReturnInfo(unit, session), stockChanged: false, lifecycleChanged: false, eligibilityOnly: true };
    });
  }
  async operation(key: string, actor: TrackingActor) {
    this.permission(actor, 'inventory-units-view');
    if (!/^[A-Za-z0-9:_-]{8,120}$/.test(key)) throw new BadRequestException('Invalid operation key');
    const operationId = createHash('sha256').update(JSON.stringify({ actor: actor.userId!.toLowerCase(), key })).digest('hex');
    const receipt: any = await this.operations.findOne({ _id: operationId, actorId: actor.userId!.toLowerCase(), kind: 'scan-validation' }).lean();
    // Absence may mean the request is still executing. It never authorizes a new key.
    return receipt ? { state: 'resolved', result: receipt.result } : { state: 'unresolved', operationKey: key, retrySameRequest: true };
  }
  async eligible(dto: EligibleScanQueryDto, actor: TrackingActor) {
    this.context(dto, actor, true);
    if (dto.q && (dto.q.length > 160 || /[\x00-\x1f\x7f]/.test(dto.q))) throw new BadRequestException('Invalid search');
    const filter: any = {};
    if (dto.productId) filter.productId = dto.productId.toLowerCase();
    if (this.states(dto.intent)) filter.status = { $in: this.states(dto.intent) };
    if (dto.cursor) filter._id = { $gt: this.id(dto.cursor) };
    if (dto.q) filter.$and = [await this.tracking.identifierFilter(dto.q)];
    const candidates: any[] = await this.units.find(filter).sort({ _id: 1 }).limit(51).lean();
    const catalog = await this.connection.collection('products').find({}, { projection: { code: 1 }, maxTimeMS: 5000 }).toArray();
    const rows = []; let examined = 0;
    for (const unit of candidates.slice(0, 50)) {
      examined++;
      if (!await this.check(unit, dto, actor, undefined, catalog)) rows.push({ _id: String(unit._id), barcode: unit.barcode, productId: unit.productId, status: unit.status });
      if (rows.length === 20) break;
    }
    return { units: await this.tracking.withManualCodes(rows), nextCursor: examined < candidates.length ? String(candidates[examined - 1]._id) : null, eligibilityOnly: true };
  }
}
