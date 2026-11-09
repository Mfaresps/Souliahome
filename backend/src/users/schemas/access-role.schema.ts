import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AccessRoleDocument = HydratedDocument<AccessRole>;

@Schema({ timestamps: true })
export class AccessRole {
  @Prop({ required: true, unique: true, trim: true })
  slug: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: '', trim: true })
  description: string;

  @Prop({ enum: ['staff', 'viewer'], default: 'staff' })
  baseRole: 'staff' | 'viewer';

  @Prop({ type: [String], default: [] })
  perms: string[];

  @Prop({ default: false })
  system: boolean;
}

export const AccessRoleSchema = SchemaFactory.createForClass(AccessRole);
