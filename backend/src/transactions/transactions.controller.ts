import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import {
  CreateTransactionDto,
  UpdateTransactionDto,
  CancelTransactionDto,
  CollectTransactionDto,
  BulkDeleteDto,
  PostDiscountDto,
  RequestCancelDto,
  ReviewCancelDto,
} from './dto/transaction.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { ExpensesService } from '../expenses/expenses.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly expensesService: ExpensesService,
  ) {}

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transactionsService.findAll(
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Get('dashboard')
  async getDashboard() {
    const expenses = await this.expensesService.findAll();
    const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);
    return this.transactionsService.getDashboard(expenseTotal);
  }

  @Get('inventory')
  async getInventory() {
    return this.transactionsService.getInventory();
  }

  @Get('reports')
  async getReports(@Query('from') from?: string, @Query('to') to?: string) {
    const expenses = await this.expensesService.findAll();
    let filteredExpenses = expenses;
    if (from) filteredExpenses = filteredExpenses.filter((e) => e.date >= from);
    if (to) filteredExpenses = filteredExpenses.filter((e) => e.date <= to);
    const expenseTotal = filteredExpenses.reduce((s, e) => s + e.amount, 0);
    return this.transactionsService.getReports(from, to, expenseTotal);
  }

  @Get('archived')
  async findArchived() {
    return this.transactionsService.findArchived();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.transactionsService.findById(id);
  }

  @Post()
  async create(@Body() dto: CreateTransactionDto) {
    return this.transactionsService.create(dto);
  }

  @Roles('admin')
  @Post('bulk-delete')
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const archivedBy = req.user.name || req.user.username || '';
    const count = await this.transactionsService.bulkRemove(dto.ids, archivedBy);
    return { message: `تم تجميد ${count} حركة`, deletedCount: count };
  }

  @Post(':id/restore')
  async restore(@Param('id') id: string) {
    return this.transactionsService.restore(id);
  }

  @Post(':id/request-cancel')
  async requestCancel(
    @Param('id') id: string,
    @Body() dto: RequestCancelDto,
  ) {
    return this.transactionsService.requestCancel(
      id,
      dto.reason,
      dto.requestedBy,
    );
  }

  @Roles('admin')
  @Post(':id/approve-cancel')
  async approveCancel(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const reviewedBy = req.user.name || req.user.username || '';
    return this.transactionsService.approveCancel(id, reviewedBy);
  }

  @Roles('admin')
  @Post(':id/reject-cancel')
  async rejectCancel(
    @Param('id') id: string,
    @Body() dto: ReviewCancelDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const reviewedBy = req.user.name || req.user.username || '';
    return this.transactionsService.rejectCancel(id, reviewedBy, dto.rejectedReason);
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelTransactionDto,
  ) {
    return this.transactionsService.cancel(id, dto);
  }

  @Post(':id/collect')
  async collect(
    @Param('id') id: string,
    @Body() dto: CollectTransactionDto,
  ) {
    return this.transactionsService.collect(id, dto);
  }

  @Roles('admin')
  @Post(':id/post-discount')
  async applyPostDiscount(
    @Param('id') id: string,
    @Body() dto: PostDiscountDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const appliedBy = req.user.name || req.user.username || '';
    return this.transactionsService.applyPostDiscount(
      id,
      dto.amount,
      dto.vaultAccount,
      appliedBy,
      dto.notes,
    );
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTransactionDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const editedBy = req.user.name || req.user.username || '';
    return this.transactionsService.update(id, dto, editedBy);
  }

  @Post(':id/comments')
  async addComments(
    @Param('id') id: string,
    @Body() body: { comments: Array<any> },
  ) {
    return this.transactionsService.addComments(id, body.comments);
  }

  @Roles('admin')
  @Delete('clear')
  async clearAll() {
    await this.transactionsService.clearAll();
    return { message: 'تم مسح كل الحركات' };
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const archivedBy = req.user.name || req.user.username || '';
    await this.transactionsService.remove(id, archivedBy);
    return { message: 'تم تجميد الحركة' };
  }
}
