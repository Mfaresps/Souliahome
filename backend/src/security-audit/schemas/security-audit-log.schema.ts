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
  | 'account_unlocked'
  | 'export_excel';

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

  // ─── Request origin ────────────────────────────────────────────────────
  // Captured at the moment of the event. A lockout row that says only
  // "4 failed attempts" cannot tell an admin whether it was the employee
  // fumbling their own password on their own phone or someone else entirely.
  //
  // ⚠ Every one of these defaults to '' and is written best-effort. They are
  // forensic context on an event that has already happened — a missing
  // User-Agent must never turn a failed login into a server error.

  @Prop({ default: '' })
  userAgent: string; // raw UA — kept verbatim so a future parser can re-read it

  @Prop({ default: '' })
  device: string; // كمبيوتر | موبايل | تابلت

  @Prop({ default: '' })
  browser: string; // Chrome | Edge | Firefox | Safari | …

  @Prop({ default: '' })
  os: string; // Windows | Android | iOS | macOS | Linux

  @Prop({ default: '' })
  location: string; // "القاهرة، مصر" — resolved from ipAddress, may be empty

  @Prop({ default: '' })
  isp: string; // network operator, when the geo lookup returns one

  @Prop({ default: '' })
  resolvedBy: string; // admin userId who resolved/unlocked

  @Prop({ type: Date, default: null })
  resolvedAt: Date;
}

export const SecurityAuditLogSchema = SchemaFactory.createForClass(SecurityAuditLog);
SecurityAuditLogSchema.index({ userId: 1, createdAt: -1 });
SecurityAuditLogSchema.index({ violationType: 1, createdAt: -1 });
