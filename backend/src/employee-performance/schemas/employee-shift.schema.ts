import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EmployeeShiftDocument = HydratedDocument<EmployeeShift>;

@Schema({ timestamps: true })
export class EmployeeShift {
  @Prop({ required: true, unique: true })
  userId: string; // ref User._id — one shift config per staff member

  @Prop({ required: true })
  name: string; // denormalized display name

  @Prop({ required: true })
  shiftStart: string; // 'HH:mm', 24h

  @Prop({ required: true })
  shiftEnd: string; // 'HH:mm'; end < start means an overnight-wrapping shift

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isOnCall: boolean; // fallback/default assignee for orders outside any shift window

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ default: '' })
  updatedBy: string;
}

export const EmployeeShiftSchema = SchemaFactory.createForClass(EmployeeShift);
