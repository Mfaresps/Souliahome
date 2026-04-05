import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { Complaint, ComplaintDocument } from './schemas/complaint.schema';
import { CreateComplaintDto, ResolveComplaintDto, SurveyResponseDto } from './dto/complaint.dto';

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

  private async generateComplaintNo(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `CMP-${year}-`;
    const last = await this.complaintModel
      .findOne({ complaintNo: { $regex: `^${prefix}` } })
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
    const complaintNo = await this.generateComplaintNo();
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
}
