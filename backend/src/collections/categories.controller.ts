import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  Optional,
  ForbiddenException,
} from '@nestjs/common';
import { DiscountOtpService } from '../discount-otp/discount-otp.service';
import { changedFields } from '../shared/cost-visibility.util';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

// Fine-grained `categories-*` perms replace the old blanket @Roles('admin').
// PermsGuard bypasses unconditionally for role === 'admin', so admin access is unchanged.
@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService, @Optional() private readonly otp?: DiscountOtpService) {}

  @Get()
  @RequirePerms('categories-view')
  async findAll() {
    return this.categoriesService.findAll();
  }

  @Get(':id')
  @RequirePerms('categories-view')
  async findOne(@Param('id') id: string) {
    return this.categoriesService.findById(id);
  }

  @Post()
  @RequirePerms('categories-create')
  async create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  /** `categories-edit` saves directly; `categories-edit-otp` needs a manager code (Nov 25, 2026). */
  @Put(':id')
  @RequirePerms('categories-view')
  async update(@Param('id') id: string, @Body() dto: UpdateCategoryDto, @Req() req: any) {
    const { otpId, ...body } = dto as UpdateCategoryDto & { otpId?: string };
    const user = req?.user || {}, perms: string[] = user.perms || [];
    if (user.role === 'admin' || perms.includes('categories-edit')) return this.categoriesService.update(id, body as UpdateCategoryDto);
    if (!perms.includes('categories-edit-otp') || !this.otp) throw new ForbiddenException('ليست لديك صلاحية تعديل التصنيفات');
    const changed = changedFields(await this.categoriesService.findById(id), body as Record<string, unknown>);
    if (!changed.length) return this.categoriesService.findById(id);
    const release = await this.otp.consumeRecordEditOtp(String(otpId || ''), 'category', id, changed);
    try { return await this.categoriesService.update(id, body as UpdateCategoryDto); }
    catch (error) { await release(); throw error; }
  }

  @Delete(':id')
  @RequirePerms('categories-delete')
  async remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }
}
