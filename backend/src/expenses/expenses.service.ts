import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Expense, ExpenseDocument } from './schemas/expense.schema';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { VaultService } from '../vault/vault.service';

@Injectable()
export class ExpensesService {
  constructor(
    @InjectModel(Expense.name)
    private readonly expenseModel: Model<ExpenseDocument>,
    private readonly vaultService: VaultService,
  ) {}

  async findAll(): Promise<ExpenseDocument[]> {
    return this.expenseModel.find().sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<ExpenseDocument> {
    const expense = await this.expenseModel.findById(id).exec();
    if (!expense) {
      throw new NotFoundException('المصروف غير موجود');
    }
    return expense;
  }

  async create(dto: CreateExpenseDto): Promise<ExpenseDocument> {
    return this.expenseModel.create({ ...dto, status: 'معلق' });
  }

  /**
   * Creates an expense already approved and posts one vault deduction (e.g. exchange refund on return approval).
   */
  async createApproved(
    dto: CreateExpenseDto,
    approvedBy: string,
  ): Promise<ExpenseDocument> {
    const nowIso = new Date().toISOString();
    const expense = await this.expenseModel.create({
      ...dto,
      status: 'معتمد',
      approvedBy,
      approvedAt: nowIso,
    });
    await this.vaultService.addSystemEntry(
      -(expense.amount || 0),
      expense.account || 'كاش',
      `مصروف: ${expense.desc} (${expense.category || ''})`,
      (expense.date || nowIso).split('T')[0],
      'مصروف',
      String(expense._id),
    );
    return expense;
  }

  async update(id: string, dto: UpdateExpenseDto): Promise<ExpenseDocument> {
    const expense = await this.expenseModel.findById(id).exec();
    if (!expense) {
      throw new NotFoundException('المصروف غير موجود');
    }
    if (expense.status === 'معتمد') {
      throw new BadRequestException('لا يمكن تعديل مصروف معتمد');
    }
    Object.assign(expense, dto);
    return expense.save();
  }

  async approve(id: string, approvedBy: string): Promise<ExpenseDocument> {
    const expense = await this.expenseModel.findById(id).exec();
    if (!expense) {
      throw new NotFoundException('المصروف غير موجود');
    }
    if (expense.status === 'معتمد') {
      throw new BadRequestException('المصروف معتمد بالفعل');
    }
    if (expense.status === 'مرفوض') {
      throw new BadRequestException('المصروف مرفوض، لا يمكن اعتماده');
    }
    expense.status = 'معتمد';
    expense.approvedBy = approvedBy;
    expense.approvedAt = new Date().toISOString();
    const saved = await expense.save();
    await this.vaultService.addSystemEntry(
      -(expense.amount || 0),
      expense.account || 'كاش',
      `مصروف: ${expense.desc} (${expense.category || ''})`,
      (expense.date || new Date().toISOString()).split('T')[0],
      'مصروف',
      String(expense._id),
    );
    return saved;
  }

  async reject(id: string, approvedBy: string): Promise<ExpenseDocument> {
    const expense = await this.expenseModel.findById(id).exec();
    if (!expense) {
      throw new NotFoundException('المصروف غير موجود');
    }
    if (expense.status === 'معتمد') {
      throw new BadRequestException('المصروف معتمد بالفعل ولا يمكن رفضه');
    }
    expense.status = 'مرفوض';
    expense.approvedBy = approvedBy;
    expense.approvedAt = new Date().toISOString();
    return expense.save();
  }

  async remove(id: string): Promise<void> {
    const result = await this.expenseModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException('المصروف غير موجود');
    }
  }
}
