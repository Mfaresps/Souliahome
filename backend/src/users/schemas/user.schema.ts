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

  // Account email (non-admin accounts, Nov 27, 2026 — auth/account-email.util.ts). It counts only with
  // `emailVerifiedAt`: an address typed before verification existed has none and is offered for confirmation.
  // ⚠ Written only by UsersService.confirmAccountEmail — a profile edit never sets it.
  @Prop({ default: '' })
  email: string;

  @Prop({ type: Date, default: null })
  emailVerifiedAt: Date | null;

  // An address waiting for its code (the employee's own request or an admin's).
  @Prop({ type: Object, default: null })
  emailPending: { email: string; codeHash: string; expiresAt: Date; attempts: number; sentAt: Date; requestedBy: { id: string; name: string } | null; requestedAt: Date } | null;

  // Codes sent in the last hour (sending limit across every address).
  @Prop({ type: [Date], default: [] })
  emailCodeSends: Date[];

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

  // «خروج من كل الأجهزة» (auth/user-sessions.service.ts): a token WITHOUT a session id (signed
  // before sessions existed) issued before this time is refused. Tokens with a session id are
  // governed by their own `usersessions` row.
  @Prop({ type: Date, default: null })
  legacyTokensValidAfter: Date | null;

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

  // ⚠ Pre-Nov-27 raw device tokens. Never checked again except once by
  // TrustedDevicesService.migrateLegacy; trusted devices live in `trusteddevices` now.
  @Prop({ type: [String], default: [] })
  trustedDevices: string[];

  // Sign-in verification (Nov 27, 2026) — auth/auth-security.util.ts.
  // The last Google Authenticator time step used: a code is accepted once.
  @Prop({ type: Number, default: null })
  totpLastStep: number | null;

  @Prop({ type: Date, default: null })
  totpEnabledAt: Date | null;

  // Ten one-time backup codes, hashed. Shown once when 2FA is set up or regenerated.
  @Prop({ type: [Object], default: [] })
  totpBackupCodes: { hash: string; usedAt: Date | null }[];

  // Admin accounts only: the verified address sign-in and reset codes are sent to.
  @Prop({ type: String, default: '' })
  securityEmail: string;

  @Prop({ type: Date, default: null })
  securityEmailVerifiedAt: Date | null;

  // An address waiting for its confirmation code (never used for sign-in until confirmed).
  @Prop({ type: Object, default: null })
  securityEmailPending: { email: string; codeHash: string; expiresAt: Date; attempts: number; sentAt: Date } | null;

  @Prop({ type: Date, default: null })
  passwordChangedAt: Date | null;

  // Password policy (Nov 27, 2026 — auth/password-policy.service.ts).
  // Bcrypt hashes of the previous passwords (newest last, at most 4: with the current one = last 5).
  @Prop({ type: [String], default: [] })
  passwordHistory: string[];

  // An admin other than the owner («admin») may reset staff passwords only when the owner allows it.
  @Prop({ type: Boolean, default: false })
  canResetStaffPasswords: boolean;

  // A staff member asked for a password reset from the sign-in page (shown to admins until reset).
  @Prop({ type: Date, default: null })
  passwordResetRequestedAt: Date | null;

  // Display summary of blocked sign-in SOURCES (login-guard, Nov 27, 2026) — the account itself is never
  // locked. Read by the «الحسابات المعطّلة والموقوفة» panel; cleared by «فك الإيقاف».
  @Prop({ type: Object, default: null })
  loginBlock: { hard: boolean; until: Date | null; ip: string; device: string; at: Date } | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
