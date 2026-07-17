import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes, randomUUID } from 'crypto';
import { Complaint, ComplaintDocument } from './schemas/complaint.schema';
import {
  CreateComplaintDto,
  ResolveComplaintDto,
  SurveyResponseDto,
  CreateNoteDto,
  UpdateNoteDto,
} from './dto/complaint.dto';

@Injectable()
export class ComplaintsService {
  constructor(
    @InjectModel(Complaint.name)
    private readonly complaintModel: Model<ComplaintDocument>,
  ) {}

  async findAll(): Promise<ComplaintDocument[]> {
    return this.complaintModel.find().sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<ComplaintDocument> {
    const complaint = await this.complaintModel.findById(id).exec();
    if (!complaint) throw new NotFoundException('الشكوى غير موجودة');
    return complaint;
  }

  async findBySurveyToken(token: string): Promise<ComplaintDocument> {
    const complaint = await this.complaintModel.findOne({ surveyToken: token }).exec();
    if (!complaint) throw new NotFoundException('رابط الاستبيان غير صالح');
    return complaint;
  }

  private async generateComplaintNo(transactionRef?: string): Promise<string> {
    const ref = (transactionRef || '').replace(/^#+/, '').trim();
    if (ref) {
      // رقم مرتبط بأوردر: CMP-YYMMDD-REF (مع لاحقة -2, -3.. لو تكررت الشكوى لنفس الأوردر في نفس اليوم)
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const base = `CMP-${yy}${mm}${dd}-${ref}`;
      const existing = await this.complaintModel
        .find({ complaintNo: { $regex: `^${base}(-\\d+)?$` } })
        .select('complaintNo')
        .lean()
        .exec();
      if (!existing.length) return base;
      let maxSuffix = 1;
      for (const e of existing) {
        const m = e.complaintNo.match(/-(\d+)$/);
        const n = m && e.complaintNo !== base ? parseInt(m[1], 10) : 1;
        if (n > maxSuffix) maxSuffix = n;
      }
      return `${base}-${maxSuffix + 1}`;
    }

    // بدون أوردر مرتبط: الترقيم التسلسلي القديم
    const year = new Date().getFullYear();
    const prefix = `CMP-${year}-`;
    const last = await this.complaintModel
      .findOne({ complaintNo: { $regex: `^${prefix}\\d+$` } })
      .sort({ complaintNo: -1 })
      .exec();
    let seq = 1;
    if (last) {
      const parts = last.complaintNo.split('-');
      seq = (parseInt(parts[parts.length - 1], 10) || 0) + 1;
    }
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  async create(
    dto: CreateComplaintDto,
    submittedBy: string,
    submittedById: string,
  ): Promise<ComplaintDocument> {
    const complaintNo = await this.generateComplaintNo(dto.transactionRef);
    return this.complaintModel.create({
      ...dto,
      complaintNo,
      submittedBy,
      submittedById,
      status: 'معلق',
    });
  }

  async resolve(
    id: string,
    dto: ResolveComplaintDto,
    resolvedBy: string,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    if (complaint.status !== 'معلق') {
      throw new BadRequestException('الشكوى مُعالجة بالفعل');
    }
    const surveyToken = randomBytes(24).toString('hex');
    complaint.status = dto.status;
    complaint.managerAction = dto.managerAction || '';
    complaint.actionNote = dto.actionNote || '';
    complaint.resolvedBy = resolvedBy;
    complaint.resolvedAt = new Date().toISOString();
    complaint.inFollowUp = dto.status === 'مقبول';
    complaint.surveyToken = surveyToken;
    return complaint.save();
  }

  async submitSurvey(
    token: string,
    dto: SurveyResponseDto,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findBySurveyToken(token);
    if (complaint.surveyCompletedAt) {
      throw new BadRequestException('تم تعبئة الاستبيان مسبقاً');
    }
    complaint.surveyRating = dto.rating;
    complaint.surveyComment = dto.comment || '';
    complaint.surveyCompletedAt = new Date().toISOString();
    return complaint.save();
  }

  async remove(id: string): Promise<void> {
    const result = await this.complaintModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('الشكوى غير موجودة');
  }

  async countComplaints(): Promise<number> {
    return this.complaintModel.countDocuments().exec();
  }

  async updateProgressStage(
    id: string,
    progressStage: string,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    complaint.progressStage = progressStage || '';
    return complaint.save();
  }

  async addNote(
    id: string,
    dto: CreateNoteDto,
    author: string,
    authorId: string,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    const now = new Date().toISOString();
    complaint.notes.push({
      id: randomUUID(),
      text: dto.text.trim(),
      author,
      authorId,
      createdAt: now,
      updatedAt: now,
    });
    return complaint.save();
  }

  async updateNote(
    id: string,
    noteId: string,
    dto: UpdateNoteDto,
    userId: string,
    isAdmin: boolean,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    const note = complaint.notes.find((n) => n.id === noteId);
    if (!note) throw new NotFoundException('الملاحظة غير موجودة');
    if (!isAdmin && note.authorId !== userId) {
      throw new BadRequestException('لا يمكنك تعديل ملاحظة موظف آخر');
    }
    note.text = dto.text.trim();
    note.updatedAt = new Date().toISOString();
    return complaint.save();
  }

  async removeNote(
    id: string,
    noteId: string,
    userId: string,
    isAdmin: boolean,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    const note = complaint.notes.find((n) => n.id === noteId);
    if (!note) throw new NotFoundException('الملاحظة غير موجودة');
    if (!isAdmin && note.authorId !== userId) {
      throw new BadRequestException('لا يمكنك حذف ملاحظة موظف آخر');
    }
    complaint.notes = complaint.notes.filter((n) => n.id !== noteId);
    return complaint.save();
  }
}
