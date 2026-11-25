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

  @Prop({ default: '' })
  email: string;

  @Prop()
  avatar: string;

  @Prop({ default: '' })
  jobTitle: string;

  @Prop({ type: [String], default: [] })
  perms: string[];

  @Prop({ type: String, default: null, index: true })
  roleId: string | null;

  @Prop({ type: Date, default: null })
  roleAssignedAt: Date | null;

  @Prop({ default: true })
  isActive: boolean;

  @Prop()
  lastLogin: Date;

  @Prop({ type: Date })
  lastSeen: Date;

  // Security lockout fields
  @Prop({ default: 0 })
  loginAttempts: number;

  @Prop({ type: Date, default: null })
  lockedAt: Date;

  @Prop({ default: '' })
  lockReason: string;

  @Prop({ default: '' })
  lockedBy: string; // 'system' or admin userId

  // Temporary sign-in pause after repeated wrong passwords (auth/login-lockout.util.ts).
  // The account stays active; only new sign-ins wait until `loginLockedUntil`.
  @Prop({ type: Date, default: null })
  loginLockedUntil: Date | null;

  @Prop({ type: Date, default: null })
  loginLockStartedAt: Date | null;

  @Prop({ type: Number, default: 0 })
  loginLockLevel: number;

  // First-sign-in welcome + tour («جولة تعريفية»). True only for accounts created from the user window
  // after Nov 24, 2026 — existing accounts never see it. Cleared by POST /users/me/onboarding-done.
  @Prop({ type: Boolean, default: false })
  onboardingPending: boolean;

  @Prop({ type: Date, default: null })
  onboardedAt: Date | null;

  // Temporary suspension for tampering (abuse-guard, Nov 25, 2026). Enforced by JwtStrategy on every
  // request (423). Cleared by «فك الإيقاف» (UsersService.unlockAccount).
  @Prop({ type: Date, default: null })
  suspendedUntil: Date | null;

  @Prop({ type: Date, default: null })
  suspendedAt: Date | null;

  @Prop({ type: Number, default: 0 })
  suspensionLevel: number;

  @Prop({ type: String, default: '' })
  suspensionReason: string;

  @Prop({ type: String, default: '' })
  suspensionDetail: string;

  // TOTP 2FA fields
  @Prop({ default: null })
  totpSecret: string;

  @Prop({ default: false })
  totpEnabled: boolean;

  @Prop({ type: [String], default: [] })
  trustedDevices: string[]; // array of device tokens
}

export const UserSchema = SchemaFactory.createForClass(User);
