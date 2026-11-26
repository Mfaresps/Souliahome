import { notifyApproval } from '../notifications/admin-events';
import { NotificationsService } from '../notifications/notifications.service';
import { Inject as PushInject, Optional as PushOptional } from '@nestjs/common';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Expense, ExpenseDocument } from './schemas/expense.schema';
import { ExpensePayee, ExpensePayeeDocument } from './schemas/expense-payee.schema';
import { CreateExpenseDto, UpdateExpenseDto, ExpensePayeeDto } from './dto/expense.dto';
import { VaultService } from '../vault/vault.service';
import {
  AD_PLATFORMS, BILLING_CYCLES, PAYEE_KINDS, PayeeKind, SalaryBreakdown,
  checkPeriod, cleanSalaryBreakdown, payeeKindForCategory, payeeNameKey,
} from './expense-payee.util';

const VAULT_ACCOUNTS = ['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'];

export interface ExpenseActor { name?: string; isAdmin?: boolean }

@Injectable()
export class ExpensesService {
  @PushOptional() @PushInject(NotificationsService) private readonly notifications?: NotificationsService;
  constructor(
    @InjectModel(Expense.name)
    private readonly expenseModel: Model<ExpenseDocument>,
    @InjectModel(ExpensePayee.name)
    private readonly payeeModel: Model<ExpensePayeeDocument>,
    private readonly vaultService: VaultService,
  ) {}

  // ─── Saved parties (expensepayees) ──────────────────────────────────────────

  /** A salary is private: only an admin reads an employee's stored amount. */
  private presentPayee(p: any, isAdmin: boolean) {
    const o = typeof p?.toObject === 'function' ? p.toObject() : { ...p };
    o._id = String(o._id);
    delete o.nameKey;
    if (o.kind === 'salary' && !isAdmin) { o.amount = 0; o.amountHidden = true; }
    return o;
  }

  async listPayees(kind: string | undefined, includeArchived: boolean, isAdmin: boolean) {
    const filter: any = {};
    if (kind) {
      if (!PAYEE_KINDS.includes(kind as PayeeKind)) throw new BadRequestException('نوع الجهة غير معروف');
      filter.kind = kind;
    }
    if (!includeArchived) filter.active = { $ne: false };
    const rows = await this.payeeModel.find(filter).sort({ lastUsedAt: -1, name: 1 }).lean().exec();
    return rows.map(r => this.presentPayee(r, isAdmin));
  }

  private cleanPayeeFields(kind: PayeeKind, dto: ExpensePayeeDto, current?: ExpensePayeeDocument) {
    const out: any = {};
    if (dto.name !== undefined) {
      const name = String(dto.name || '').replace(/\s+/g, ' ').trim();
      if (name.length < 2) throw new BadRequestException('اكتب اسمًا من حرفين على الأقل');
      if (name.length > 80) throw new BadRequestException('الاسم أطول من 80 حرفًا');
      out.name = name;
      out.nameKey = payeeNameKey(name);
    }
    if (dto.amount !== undefined) {
      const amount = Math.round((Number(dto.amount) || 0) * 100) / 100;
      if (amount < 0) throw new BadRequestException('المبلغ لا يكون سالبًا');
      out.amount = amount;
    }
    if (dto.account !== undefined) {
      const account = String(dto.account || '').trim();
      if (account && !VAULT_ACCOUNTS.includes(account)) throw new BadRequestException('طريقة الدفع غير معروفة');
      out.account = account;
    }
    if (dto.notes !== undefined) out.notes = String(dto.notes || '').trim().slice(0, 300);
    if (kind === 'ads' && (dto.platform !== undefined || !current)) {
      const platform = String(dto.platform || 'other');
      if (!AD_PLATFORMS.includes(platform)) throw new BadRequestException('منصة الإعلان غير معروفة');
      out.platform = platform;
    }
    if (kind === 'subscription' && (dto.billingCycle !== undefined || !current)) {
      const cycle = String(dto.billingCycle || 'monthly');
      if (!BILLING_CYCLES.includes(cycle)) throw new BadRequestException('دورة الاشتراك غير معروفة');
      out.billingCycle = cycle;
    }
    if (kind === 'salary' && dto.pointValue !== undefined) {
      const pv = Math.round((Number(dto.pointValue) || 0) * 100) / 100;
      if (pv < 0) throw new BadRequestException('قيمة النقطة لا تكون سالبة');
      out.pointValue = pv;
    }
    if (kind === 'salary' && dto.userId !== undefined) {
      const userId = String(dto.userId || '').trim();
      if (userId && !Types.ObjectId.isValid(userId)) throw new BadRequestException('حساب الموظف غير صحيح');
      out.userId = userId;
    }
    return out;
  }

  async createPayee(dto: ExpensePayeeDto, actor: ExpenseActor) {
    const kind = String(dto.kind || '') as PayeeKind;
    if (!PAYEE_KINDS.includes(kind)) throw new BadRequestException('نوع الجهة غير معروف');
    if (kind === 'salary' && !actor.isAdmin) throw new ForbiddenException('إضافة موظف إلى المرتبات للمدير فقط');
    if (dto.name === undefined) throw new BadRequestException('اكتب الاسم');
    const fields = this.cleanPayeeFields(kind, dto);
    // An archived party with the same name comes back instead of failing on the unique index.
    const existing = await this.payeeModel.findOne({ kind, nameKey: fields.nameKey }).exec();
    if (existing) {
      if (existing.active !== false) {
        throw new ConflictException({ message: `«${existing.name}» مسجّل بالفعل`, code: 'PAYEE_EXISTS', payeeId: String(existing._id) });
      }
      Object.assign(existing, fields, { active: true });
      await existing.save();
      return this.presentPayee(existing, !!actor.isAdmin);
    }
    try {
      const created = await this.payeeModel.create({ kind, ...fields, active: true, createdBy: actor.name || '' });
      return this.presentPayee(created, !!actor.isAdmin);
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException({ message: 'هذا الاسم مسجّل بالفعل', code: 'PAYEE_EXISTS' });
      throw e;
    }
  }

  async updatePayee(id: string, dto: ExpensePayeeDto, actor: ExpenseActor) {
    if (!actor.isAdmin) throw new ForbiddenException('تعديل الجهات المحفوظة للمدير فقط');
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('الجهة غير موجودة');
    const payee = await this.payeeModel.findById(id).exec();
    if (!payee) throw new NotFoundException('الجهة غير موجودة');
    const fields = this.cleanPayeeFields(payee.kind as PayeeKind, dto, payee);
    if (fields.nameKey && fields.nameKey !== payee.nameKey) {
      const clash = await this.payeeModel.findOne({ kind: payee.kind, nameKey: fields.nameKey, _id: { $ne: payee._id } }).lean().exec();
      if (clash) throw new ConflictException({ message: `«${clash.name}» مسجّل بالفعل`, code: 'PAYEE_EXISTS' });
    }
    Object.assign(payee, fields);
    if (dto.active !== undefined) payee.active = !!dto.active;
    await payee.save();
    return this.presentPayee(payee, true);
  }

  /**
   * Ties an expense to its saved party and period. Throws on a payee of the wrong kind, a
   * missing one, or (for a new expense) an archived one. Outside the three categories the
   * payee is cleared; the period is kept for any category.
   */
  private async resolvePayee(category: string, payeeId: string, periodFrom: string, periodTo: string, creating: boolean) {
    const period = checkPeriod(periodFrom, periodTo);
    if ('error' in period) throw new BadRequestException(period.error);
    const kind = payeeKindForCategory(category);
    const id = String(payeeId || '').trim();
    if (!kind || !id) return { payee: null, fields: { payeeId: '', payeeName: '', payeeKind: '', periodFrom: period.from, periodTo: period.to } };
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('الجهة غير موجودة');
    const payee = await this.payeeModel.findById(id).exec();
    if (!payee) throw new BadRequestException('الجهة غير موجودة — اخترها من القائمة من جديد');
    if (payee.kind !== kind) throw new BadRequestException('الجهة المختارة لا تتبع هذه الفئة');
    if (creating && payee.active === false) throw new BadRequestException(`«${payee.name}» مؤرشفة — أعد تفعيلها أولًا`);
    return { payee, fields: { payeeId: id, payeeName: payee.name, payeeKind: kind, periodFrom: period.from, periodTo: period.to } };
  }

  /**
   * The salary breakdown, or null. Only a «مرتبات» expense carries one; when it does, the
   * amount the expense posts is the net computed here, never the figure the browser sent.
   */
  private resolveSalary(raw: any, fallback: any): SalaryBreakdown | null {
    const source = raw === undefined ? fallback : raw;
    if (!source) return null;
    const clean = cleanSalaryBreakdown(source);
    if ('error' in clean) throw new BadRequestException(clean.error);
    return clean;
  }

  /** After a successful save: last used, default vault, and (when asked) the default amount. */
  private async touchPayee(payee: ExpensePayeeDocument | null, expense: { amount?: number; account?: string; salary?: any }, saveAmount: boolean, actor: ExpenseActor) {
    if (!payee) return;
    const set: any = { lastUsedAt: new Date().toISOString() };
    if (!payee.account && expense.account) set.account = expense.account;
    if (saveAmount && (payee.kind !== 'salary' || actor.isAdmin)) {
      // With a breakdown, the employee's usual figures are the base salary and the point rate.
      if (expense.salary) { set.amount = expense.salary.base; set.pointValue = expense.salary.pointValue; }
      else set.amount = Math.round((Number(expense.amount) || 0) * 100) / 100;
    }
    await this.payeeModel.updateOne({ _id: payee._id }, { $set: set }).exec().catch(() => undefined);
  }

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

  async create(dto: CreateExpenseDto, actor: ExpenseActor = {}): Promise<ExpenseDocument> {
    const { updatePayeeAmount, payeeId, periodFrom, periodTo, salary: rawSalary, ...rest } = dto;
    const { payee, fields } = await this.resolvePayee(rest.category, payeeId || '', periodFrom || '', periodTo || '', true);
    const salary = payeeKindForCategory(rest.category) === 'salary' ? this.resolveSalary(rawSalary, null) : null;
    const expenseNo = rest.expenseNo || this.generateExpenseNo();
    const created = await this.expenseModel.create({ ...rest, ...fields, salary, ...(salary ? { amount: salary.net } : {}), status: 'معلق', expenseNo });
    await this.touchPayee(payee, created, !!updatePayeeAmount, actor);
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

  async update(id: string, dto: UpdateExpenseDto, actor: ExpenseActor = {}): Promise<ExpenseDocument> {
    const expense = await this.expenseModel.findById(id).exec();
    if (!expense) {
      throw new NotFoundException('المصروف غير موجود');
    }
    if (expense.status === 'معتمد') {
      throw new BadRequestException('لا يمكن تعديل مصروف معتمد');
    }
    const { updatePayeeAmount, payeeId, periodFrom, periodTo, salary: rawSalary, ...rest } = dto;
    const category = rest.category ?? expense.category;
    const samePayee = payeeId === undefined || String(payeeId || '') === String(expense.payeeId || '');
    const { payee, fields } = await this.resolvePayee(
      category,
      payeeId !== undefined ? payeeId : (expense.payeeId || ''),
      periodFrom !== undefined ? periodFrom : (expense.periodFrom || ''),
      periodTo !== undefined ? periodTo : (expense.periodTo || ''),
      !samePayee, // keeping an archived payee on an old expense is fine; choosing one is not
    );
    // undefined = keep the stored breakdown; null = drop it; an object = recompute it.
    const salary = payeeKindForCategory(category) === 'salary'
      ? this.resolveSalary(rawSalary, expense.salary)
      : null;
    Object.assign(expense, rest, fields, { salary });
    if (salary) expense.amount = salary.net;
    const saved = await expense.save();
    await this.touchPayee(payee, saved, !!updatePayeeAmount, actor);
    return saved;
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
