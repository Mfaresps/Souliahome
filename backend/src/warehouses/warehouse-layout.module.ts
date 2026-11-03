import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, OnModuleInit, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { IsIn, IsMongoId, IsOptional, IsString, Matches } from 'class-validator';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { LABEL_SIZES } from '../inventory-units/inventory-unit.constants';

const nodes = 'warehouselayoutnodes';
const codePattern = /^(?:[A-Z][A-Z0-9-]{0,11}|S\d{2,3})$/;
type Actor = { role?: string };

class LayoutNodeDto {
  @IsIn(['zone', 'rack', 'level']) kind: 'zone' | 'rack' | 'level';
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,120}$/) warehouseCode: string;
  @IsOptional() @IsMongoId() parentId?: string;
  @IsString() @Matches(codePattern) code: string;
}
class RenameNodeDto {
  @IsString() @Matches(codePattern) code: string;
}

@Injectable()
export class WarehouseLayoutService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  async onModuleInit() { await this.collection().createIndex({ warehouseCode: 1, parentId: 1, code: 1 }, { unique: true }); }
  private admin(actor: Actor) { if (actor?.role !== 'admin') throw new ForbiddenException('إدارة مخطط المخزن للمدير فقط'); }
  private collection() { return this.connection.collection(nodes); }
  async list() {
    const [warehouses, locations] = await Promise.all([
      this.connection.collection('warehouses').find({ active: { $ne: false } }, { projection: { code: 1, name: 1, isDefault: 1 } }).sort({ isDefault: -1, name: 1 }).toArray(),
      this.collection().find({}).sort({ kind: 1, code: 1 }).toArray(),
    ]);
    return { warehouses, locations, labelSizes: LABEL_SIZES.map(({ id, widthMm, heightMm }) => ({ id, widthMm, heightMm })) };
  }
  private async warehouse(code: string) {
    if (!await this.connection.collection('warehouses').findOne({ code, active: { $ne: false } })) throw new BadRequestException('المخزن غير موجود أو غير نشط');
  }
  private async parent(kind: string, warehouseCode: string, parentId?: string) {
    if (kind === 'zone') {
      if (parentId) throw new BadRequestException('منطقة التخزين تتبع المخزن مباشرة');
      return null;
    }
    const parent = parentId && await this.collection().findOne({ _id: new Types.ObjectId(parentId), warehouseCode });
    if (!parent || parent.kind !== (kind === 'rack' ? 'zone' : 'rack')) throw new BadRequestException('الموقع الأب غير صالح');
    return parent;
  }
  async create(dto: LayoutNodeDto, actor: Actor) {
    this.admin(actor);
    await this.warehouse(dto.warehouseCode);
    const parent = await this.parent(dto.kind, dto.warehouseCode, dto.parentId);
    const code = dto.code.trim().toUpperCase();
    if (!codePattern.test(code)) throw new BadRequestException('رمز الموقع غير صالح');
    try {
      const result = await this.collection().insertOne({ warehouseCode: dto.warehouseCode, parentId: parent?._id || null, kind: dto.kind, code, createdAt: new Date() });
      return this.collection().findOne({ _id: result.insertedId });
    } catch (error: any) {
      if (error.code === 11000) throw new ConflictException('رمز الموقع موجود في هذا القسم');
      throw error;
    }
  }
  async rename(id: string, dto: RenameNodeDto, actor: Actor) {
    this.admin(actor);
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف الموقع غير صالح');
    const code = dto.code.trim().toUpperCase();
    if (!codePattern.test(code)) throw new BadRequestException('رمز الموقع غير صالح');
    try {
      const result = await this.collection().findOneAndUpdate({ _id: new Types.ObjectId(id) }, { $set: { code } }, { returnDocument: 'after' });
      if (!result) throw new BadRequestException('الموقع غير موجود');
      return result;
    } catch (error: any) {
      if (error.code === 11000) throw new ConflictException('رمز الموقع موجود في هذا القسم');
      throw error;
    }
  }
  async remove(id: string, actor: Actor) {
    this.admin(actor);
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف الموقع غير صالح');
    const _id = new Types.ObjectId(id);
    if (!await this.collection().findOne({ _id })) throw new BadRequestException('الموقع غير موجود');
    if (await this.collection().findOne({ parentId: _id })) throw new ConflictException('احذف المواقع الفرعية أولًا');
    if (await this.connection.collection('products').findOne({ storageLocationId: id })) throw new ConflictException('الموقع مرتبط بمنتجات؛ غيّر مواقعها أولًا');
    await this.collection().deleteOne({ _id });
    return { removed: true };
  }
}

@Controller('warehouse-layout') @UseGuards(JwtAuthGuard)
class WarehouseLayoutController {
  constructor(private readonly service: WarehouseLayoutService) {}
  @Get() list() { return this.service.list(); }
  @Post() create(@Body() dto: LayoutNodeDto, @Req() req: { user: Actor }) { return this.service.create(dto, req.user); }
  @Patch(':id') rename(@Param('id') id: string, @Body() dto: RenameNodeDto, @Req() req: { user: Actor }) { return this.service.rename(id, dto, req.user); }
  @Delete(':id') remove(@Param('id') id: string, @Req() req: { user: Actor }) { return this.service.remove(id, req.user); }
}

@Module({ controllers: [WarehouseLayoutController], providers: [WarehouseLayoutService] })
export class WarehouseLayoutModule {}
