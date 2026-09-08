import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmployeeLeave, EmployeeLeaveDocument } from './schemas/employee-leave.schema';
import { UsersService } from '../users/users.service';
import { CreateEmployeeLeaveDto } from './dto/employee-leave.dto';

@Injectable()
export class EmployeeLeaveService {
  constructor(
    @InjectModel(EmployeeLeave.name) private readonly leaveModel: Model<EmployeeLeaveDocument>,
    private readonly usersService: UsersService,
  ) {}

  async listLeaves(): Promise<EmployeeLeaveDocument[]> {
    return this.leaveModel.find().sort({ fromDate: -1 }).exec();
  }

  async createLeave(dto: CreateEmployeeLeaveDto, by: string): Promise<EmployeeLeaveDocument[]> {
    const user = await this.usersService.findById(dto.userId);
    if (!user) throw new BadRequestException('الموظف غير موجود');

    // Plain string comparison is valid here because both are enforced 'YYYY-MM-DD'
    // by the DTO's regex — same reasoning as dateWindowQuery's day-level bound.
    if (dto.toDate < dto.fromDate) {
      throw new BadRequestException('تاريخ النهاية لا يمكن أن يسبق تاريخ البداية');
    }

    await this.leaveModel.create({
      userId: dto.userId,
      name: user.name || user.username,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      reason: dto.reason || '',
      createdBy: by,
    });

    return this.listLeaves();
  }

  /** The employee a leave row belongs to, or ''. Same reason as findShiftOwner: resolve before delete. */
  async findLeaveOwner(id: string): Promise<string> {
    try {
      const doc = await this.leaveModel.findById(id).select('userId').lean().exec();
      return doc ? String((doc as { userId?: string }).userId || '') : '';
    } catch {
      return '';
    }
  }

  async deleteLeave(id: string): Promise<EmployeeLeaveDocument[]> {
    const result = await this.leaveModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('الإجازة غير موجودة');
    return this.listLeaves();
  }

  /**
   * One employee's own leave: anything still covering `fromDay` or starting after it.
   *
   * ⚠ Scoped by userId in the query — a staff-facing screen must never receive a
   * colleague's leave rows and be trusted to hide them. Past leave is excluded
   * because the panel answers "when am I next off?", not "what did I take?".
   *
   * Plain string comparison is valid: both sides are enforced 'YYYY-MM-DD' — the
   * same day-level reasoning as dateWindowQuery. Never store an ISO timestamp here.
   */
  async listUpcomingForUser(userId: string, fromDay: string): Promise<EmployeeLeaveDocument[]> {
    try {
      return await this.leaveModel
        .find({ userId, toDate: { $gte: fromDay } })
        .sort({ fromDate: 1 })
        .lean()
        .exec() as unknown as EmployeeLeaveDocument[];
    } catch {
      // The roster panel must still render its shifts if leave lookup fails —
      // same advisory-failure rule as listUserIdsOnLeave below.
      return [];
    }
  }

  /** Every userId on leave covering the given 'YYYY-MM-DD' day. Never throws — see callers. */
  async listUserIdsOnLeave(dateStr: string): Promise<Set<string>> {
    try {
      const rows = await this.leaveModel
        .find({ fromDate: { $lte: dateStr }, toDate: { $gte: dateStr } })
        .select('userId')
        .lean()
        .exec();
      return new Set(rows.map((r) => String(r.userId)));
    } catch {
      // Assignment is advisory — a leave-lookup failure must fall back to "nobody is on
      // leave" rather than block routing entirely.
      return new Set();
    }
  }
}
