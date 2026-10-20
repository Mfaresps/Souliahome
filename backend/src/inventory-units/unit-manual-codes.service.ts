import { BadRequestException, Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Connection, Types } from 'mongoose';
import { OBJECT_ID_PATTERN } from './inventory-unit.constants';

/** Additive human aliases. Immutable unit IDs and existing QR payloads remain valid. */
@Injectable()
export class UnitManualCodesService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private readonly counterId = new Types.ObjectId('000000000000000000000001');
  async onModuleInit() {
    await this.connection.collection('inventoryunitcodes').createIndex({ code: 1 }, { unique: true, name: 'inventory_unit_manual_code_unique' });
    await this.connection.collection('inventoryunitcodecounters').updateOne({ _id: this.counterId }, { $setOnInsert: { sequence: 0 } }, { upsert: true });
  }
  private check(body: string) {
    let sum = 0;
    for (let i = body.length - 1, double = true; i >= 0; i--, double = !double) {
      let digit = Number(body[i]); if (double) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit;
    }
    return String((10 - sum % 10) % 10);
  }
  private digits(value: string) {
    return String(value || '').trim().replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))
      .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0)).toUpperCase().replace(/^U/, '').replace(/[\s\-–—]/g, '');
  }
  private format(code: string) { return `U-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`; }
  async codeFor(unitId: string): Promise<string> {
    const id = new Types.ObjectId(unitId), codes = this.connection.collection('inventoryunitcodes');
    const existing = await codes.findOne({ _id: id });
    if (existing) return this.format(existing.code);
    for (let attempt = 0; attempt < 30; attempt++) {
      const counter: any = await this.connection.collection('inventoryunitcodecounters').findOneAndUpdate({ _id: this.counterId },
        { $inc: { sequence: 1 } }, { returnDocument: 'after', includeResultMetadata: false });
      const sequence = counter?.sequence;
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 99999999) throw new ServiceUnavailableException('Manual unit code counter requires review');
      const body = String(sequence).padStart(8, '0'), code = body + this.check(body);
      try { await codes.insertOne({ _id: id, code, createdAt: new Date() }); return this.format(code); }
      catch (error: any) {
        if (error.code !== 11000) throw error;
        const concurrent = await codes.findOne({ _id: id });
        if (concurrent) return this.format(concurrent.code);
      }
    }
    throw new ServiceUnavailableException('Manual unit codes require coordinated restore review');
  }
  async decorate(units: any[]): Promise<any[]> {
    return Promise.all(units.map(async unit => ({ ...unit, manualCode: await this.codeFor(String(unit._id || unit.unitId)) })));
  }
  async findUnitId(value: string, session?: ClientSession, strict = false): Promise<Types.ObjectId | null> {
    const digits = this.digits(value);
    if (!/^\d{9}$/.test(digits)) return null;
    if (this.check(digits.slice(0, 8)) !== digits[8]) {
      if (strict) throw new BadRequestException('كود القطعة غير صحيح؛ راجع الأرقام ورقم التحقق الأخير');
      return null;
    }
    const row = await this.connection.collection('inventoryunitcodes').findOne({ code: digits }, { session });
    return row?._id || null;
  }
  async filter(value: string, session?: ClientSession): Promise<any> {
    const raw = String(value || '').trim();
    if (OBJECT_ID_PATTERN.test(raw)) return { _id: new Types.ObjectId(raw) };
    if (/^\d{9}$/.test(this.digits(raw))) {
      const id = await this.findUnitId(raw, session, true);
      return id ? { _id: id } : { _id: { $in: [] } };
    }
    return { barcode: /^SU-[A-F\d]{24}$/i.test(raw) ? raw.toUpperCase() : raw };
  }
}
