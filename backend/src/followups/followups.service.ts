import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FollowUp, FollowUpDocument } from './schemas/followup.schema';
import { CreateFollowUpDto, UpdateFollowUpDto } from './dto/followup.dto';

@Injectable()
export class FollowUpsService {
  constructor(
    @InjectModel(FollowUp.name) private model: Model<FollowUpDocument>,
  ) {}

  findAll() {
    return this.model.find().sort({ createdAt: -1 }).lean();
  }

  findById(id: string) {
    return this.model.findById(id).lean();
  }

  create(dto: CreateFollowUpDto) {
    return this.model.create(dto);
  }

  update(id: string, dto: UpdateFollowUpDto) {
    return this.model.findByIdAndUpdate(id, dto, { new: true }).lean();
  }

  markNotified(id: string) {
    return this.model.findByIdAndUpdate(id, { notified: true }, { new: true }).lean();
  }

  remove(id: string) {
    return this.model.findByIdAndDelete(id);
  }
}
