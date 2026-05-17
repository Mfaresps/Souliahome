import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SecurityAuditLogDocument = HydratedDocument<SecurityAuditLog>;

export type ViolationType =
  | 'failed_login'
  | 'account_locked'
  | 'otp_violation'
  | 'vault_violation'
  | 'unauthorized_access'
  | 'settings_tampering'
  | 'account_unlocked';

@Schema({ timestamps: true })
export class SecurityAuditLog {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  username: string;

  @Prop({ required: true })
  violationType: ViolationType;

  @Prop({ required: true })
  action: string; // human-readable description in Arabic

  @Prop({ default: '' })
  detail: string; // extra context

  @Prop({ default: '' })
  ipAddress: string;

  @Prop({ default: '' })
  resolvedBy: string; // admin userId who resolved/unlocked

  @Prop({ type: Date, default: null })
  resolvedAt: Date;
}

export const SecurityAuditLogSchema = SchemaFactory.createForClass(SecurityAuditLog);
SecurityAuditLogSchema.index({ userId: 1, createdAt: -1 });
SecurityAuditLogSchema.index({ violationType: 1, createdAt: -1 });
