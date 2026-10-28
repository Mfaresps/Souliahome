import { notifyApproval } from '../notifications/admin-events';
import { NotificationsService } from '../notifications/notifications.service';
import { Inject as PushInject, Optional as PushOptional } from '@nestjs/common';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Expense, ExpenseDocument } from './schemas/expense.schema';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { VaultService } from '../vault/vault.service';

@Injectable()
export class ExpensesService {
  @PushOptional() @PushInject(NotificationsService) private readonly notifications?: NotificationsService;
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

  private generateExpenseNo(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 4).toUpperCase();
    return `EXP-${ts}${rand}`;
  }

  async create(dto: CreateExpenseDto): Promise<ExpenseDocument> {
    const expenseNo = dto.expenseNo || this.generateExpenseNo();
    const created = await this.expenseModel.create({ ...dto, status: 'معلق', expenseNo });
    await notifyApproval(this.notifications, 'approval:expense:' + created._id + ':pending', expenseNo, 'expense:' + created._id, { actorName: created.employee, actionKey: 'expense', status: 'pending' });
    return created;
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
    await notifyApproval(this.notifications, 'approval:expense:' + expense._id + ':approved', expense.expenseNo || String(expense._id), 'expense:' + expense._id, { actorName: expense.employee || approvedBy, actionKey: 'expense', status: 'approved' });
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
    // Check vault balance before deducting
    await this.vaultService.assertSufficientBalance(
      expense.account || 'كاش',
      expense.amount || 0,
    );
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
    await notifyApproval(this.notifications, 'approval:expense:' + id + ':approved', expense.expenseNo, 'expense:' + id, { actorName: expense.employee, actionKey: 'expense', status: 'approved' });
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
    const saved = await expense.save();
    await notifyApproval(this.notifications, 'approval:expense:' + id + ':rejected', expense.expenseNo, 'expense:' + id, { actorName: expense.employee, actionKey: 'expense', status: 'rejected' });
    return saved;
  }

  getAttachmentsDir(): string {
    const dir = path.join(process.cwd(), 'uploads', 'expenses');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async remove(id: string, isAdmin = false): Promise<void> {
    const expense = await this.expenseModel.findById(id).exec();
    if (!expense) {
      throw new NotFoundException('المصروف غير موجود');
    }
    if (expense.complaintId) throw new BadRequestException('هذا المصروف إثبات دفع لشكوى؛ لا يمكن إلغاؤه بمعزل عن ملف العميل');
    if (expense.status === 'معتمد') {
      if (!isAdmin) {
        throw new BadRequestException('لا يمكن حذف مصروف معتمد — يحتاج صلاحية أدمن');
      }
      // Reverse vault deduction
      await this.vaultService.addSystemEntry(
        +(expense.amount || 0),
        expense.account || 'كاش',
        `إلغاء مصروف: ${expense.desc} (${expense.category || ''})`,
        new Date().toISOString().split('T')[0],
        'إلغاء مصروف',
        String(expense._id),
      );
    }
    // Delete attachment file if exists
    if (expense.attachment) {
      const filePath = path.join(this.getAttachmentsDir(), path.basename(expense.attachment));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await this.expenseModel.findByIdAndDelete(id).exec();
  }

  async bulkRemovePending(ids: string[]): Promise<number> {
    const result = await this.expenseModel
      .deleteMany({ _id: { $in: ids }, status: 'معلق' })
      .exec();
    return result.deletedCount || 0;
  }
}
