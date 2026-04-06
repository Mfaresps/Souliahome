import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import {
  CreateExpenseDto,
  UpdateExpenseDto,
  ApproveExpenseDto,
} from './dto/expense.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get()
  async findAll() {
    return this.expensesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.expensesService.findById(id);
  }

  @Post()
  async create(@Body() dto: CreateExpenseDto) {
    return this.expensesService.create(dto);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    return this.expensesService.update(id, dto);
  }

  @Roles('admin')
  @Post(':id/approve')
  async approve(@Param('id') id: string, @Req() req: { user: { name: string; username: string } }) {
    const approvedBy = req.user.name || req.user.username;
    return this.expensesService.approve(id, approvedBy);
  }

  @Roles('admin')
  @Post(':id/reject')
  async reject(@Param('id') id: string, @Req() req: { user: { name: string; username: string } }) {
    const approvedBy = req.user.name || req.user.username;
    return this.expensesService.reject(id, approvedBy);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.expensesService.remove(id);
    return { message: 'تم حذف المصروف' };
  }

  @Post('bulk-delete')
  async bulkDelete(@Body() body: { ids?: string[] }) {
    if (!body.ids || !body.ids.length) {
      throw new BadRequestException('ids مطلوبة');
    }
    const count = await this.expensesService.bulkRemovePending(body.ids);
    return { message: `تم حذف ${count} مصروف`, count };
  }
}
