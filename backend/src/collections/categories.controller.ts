import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
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
  constructor(private readonly categoriesService: CategoriesService) {}

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

  @Put(':id')
  @RequirePerms('categories-edit')
  async update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @RequirePerms('categories-delete')
  async remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }
}
