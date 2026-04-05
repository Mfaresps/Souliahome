import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true })
  username: string;

  @Prop({ required: true })
  password: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, enum: ['admin', 'staff', 'viewer'] })
  role: string;

  @Prop()
  phone: string;

  @Prop()
  avatar: string;

  @Prop({ type: [String], default: [] })
  perms: string[];
}

export const UserSchema = SchemaFactory.createForClass(User);
