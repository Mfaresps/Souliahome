import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmployeeShift, EmployeeShiftDocument } from './schemas/employee-shift.schema';
import { UsersService } from '../users/users.service';
import { CreateEmployeeShiftDto, UpdateEmployeeShiftDto } from './dto/employee-shift.dto';

export interface AssigneeResolution {
  userId: string;
  name: string;
  reason: 'shift' | 'on-call-fallback' | 'unassigned';
}

@Injectable()
export class EmployeeShiftService {
  private readonly logger = new Logger(EmployeeShiftService.name);

  constructor(
    @InjectModel(EmployeeShift.name) private readonly shiftModel: Model<EmployeeShiftDocument>,
    private readonly usersService: UsersService,
  ) {}

  async listShifts(): Promise<EmployeeShiftDocument[]> {
    return this.shiftModel.find().sort({ shiftStart: 1 }).exec();
  }

  async createShift(dto: CreateEmployeeShiftDto, by: string): Promise<EmployeeShiftDocument[]> {
    const user = await this.usersService.findById(dto.userId);
    if (!user) throw new BadRequestException('الموظف غير موجود');
    if (user.role !== 'staff') throw new BadRequestException('لا يمكن جدولة إلا الموظفين (staff)');

    const existing = await this.shiftModel.findOne({ userId: dto.userId }).exec();
    if (existing) throw new ConflictException('يوجد بالفعل جدول وردية لهذا الموظف');

    await this.shiftModel.create({
      userId: dto.userId,
      name: user.name || user.username,
      shiftStart: dto.shiftStart,
      shiftEnd: dto.shiftEnd,
      isActive: dto.isActive !== undefined ? dto.isActive : true,
      isOnCall: false, // set-on-call is a dedicated atomic action, not settable at creation
      createdBy: by,
      updatedBy: by,
    });

    return this.listShifts();
  }

  async updateShift(id: string, dto: UpdateEmployeeShiftDto, by: string): Promise<EmployeeShiftDocument[]> {
    const update: Record<string, unknown> = { ...dto, updatedBy: by };
    delete update.isOnCall; // use setOnCall() to change this, keeps the single-true invariant enforced

    const shift = await this.shiftModel.findByIdAndUpdate(id, update, { new: true }).exec();
    if (!shift) throw new NotFoundException('جدول الوردية غير موجود');

    return this.listShifts();
  }

  async deleteShift(id: string): Promise<EmployeeShiftDocument[]> {
    const result = await this.shiftModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('جدول الوردية غير موجود');
    return this.listShifts();
  }

  async setOnCall(id: string): Promise<EmployeeShiftDocument[]> {
    const target = await this.shiftModel.findById(id).exec();
    if (!target) throw new NotFoundException('جدول الوردية غير موجود');

    await this.shiftModel.updateMany({ _id: { $ne: id } }, { isOnCall: false }).exec();
    await this.shiftModel.findByIdAndUpdate(id, { isOnCall: true }).exec();

    return this.listShifts();
  }

  /**
   * Resolves which employee an incoming Shopify order should be routed to, based on
   * the order's creation time-of-day against configured active shifts, falling back
   * to the designated on-call employee. Never throws — assignment is advisory and
   * must never block webhook ingestion; callers should still wrap calls in try/catch.
   */
  async resolveAssignee(orderCreatedAtIso: string): Promise<AssigneeResolution | null> {
    const orderDate = new Date(orderCreatedAtIso);
    if (isNaN(orderDate.getTime())) return null;

    // shopifyCreatedAt carries the store's own offset (typically Cairo local time already),
    // so the wall-clock hours/minutes of the ISO string represent business-local time-of-day.
    const hh = String(orderDate.getUTCHours()).padStart(2, '0');
    const mm = String(orderDate.getUTCMinutes()).padStart(2, '0');
    const timeOfDay = `${hh}:${mm}`;

    const activeShifts = await this.shiftModel.find({ isActive: true }).exec();
    const matches = activeShifts.filter((s) => this.isWithinShiftWindow(timeOfDay, s.shiftStart, s.shiftEnd));

    if (matches.length === 1) {
      return { userId: matches[0].userId, name: matches[0].name, reason: 'shift' };
    }
    if (matches.length > 1) {
      matches.sort((a, b) => a.shiftStart.localeCompare(b.shiftStart));
      this.logger.warn(
        `Multiple overlapping shifts match order time ${timeOfDay} — using earliest shiftStart (${matches[0].name})`,
      );
      return { userId: matches[0].userId, name: matches[0].name, reason: 'shift' };
    }

    const onCall = await this.shiftModel.findOne({ isOnCall: true }).exec();
    if (onCall) {
      return { userId: onCall.userId, name: onCall.name, reason: 'on-call-fallback' };
    }

    return null;
  }

  /** Tests whether `time` (HH:mm) falls in [start, end), handling overnight-wrapping windows (end < start). */
  private isWithinShiftWindow(time: string, start: string, end: string): boolean {
    if (start === end) return false; // zero-width window, misconfiguration guard
    if (start < end) {
      return time >= start && time < end;
    }
    // overnight wrap, e.g. 22:00 -> 06:00
    return time >= start || time < end;
  }
}
