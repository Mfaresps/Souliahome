import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { PromotionAuditService } from '../promotions/promotion-audit.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tags')
export class TagsController {
  constructor(
    private readonly tagsService: TagsService,
    @Optional() private readonly promoAudit?: PromotionAuditService,
  ) {}

  @Get()
  async findAll() {
    return this.tagsService.findAll();
  }

  // ⚠ Stays open to any signed-in user: the transaction form creates a tag inline while tagging.
  @Post()
  async create(@Body() createTagDto: CreateTagDto) {
    return this.tagsService.create(createTagDto);
  }

  // Was @Roles('admin'); managing the master list now belongs to the promotions page perm.
  @Patch(':id')
  @UseGuards(PermsGuard)
  @RequirePerms('promotions-tags')
  async update(@Param('id') id: string, @Body() updateTagDto: UpdateTagDto, @Req() req: any) {
    const tag: any = await this.tagsService.update(id, updateTagDto);
    void this.promoAudit?.recordManage(req.user, { kind: 'tag', action: 'updated', ref: id, label: tag?.name || id,
      reason: updateTagDto?.category !== undefined ? `category: ${updateTagDto.category || '—'}` : '' });
    return tag;
  }

  @Delete(':id')
  @UseGuards(PermsGuard)
  @RequirePerms('promotions-tags')
  async remove(@Param('id') id: string, @Req() req: any) {
    const before: any = (await this.tagsService.findAll()).find((t: any) => String(t._id) === String(id));
    const res = await this.tagsService.remove(id);
    if (res?.deleted) void this.promoAudit?.recordManage(req.user, { kind: 'tag', action: 'deleted', ref: id, label: before?.name || id });
    return res;
  }
}
