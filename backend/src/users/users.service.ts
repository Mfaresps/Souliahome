import { Injectable, NotFoundException, ConflictException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

/** Fields that must never leave the server in a user list. */
const SECRET_USER_FIELDS = '-password -passwordHistory -plainPassword -totpSecret -trustedDevices -totpBackupCodes -totpLastStep -securityEmailPending';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  /**
   * Passwords used to be stored a second time in plain text (`plainPassword`) so an admin
   * could "show" them. Login has always used the bcrypt hash only, so removing the copy
   * changes no login. Idempotent: once cleared, the query matches nothing.
   */
  async onModuleInit(): Promise<void> {
    try {
      const res = await this.userModel.collection.updateMany(
        { plainPassword: { $exists: true } },
        { $unset: { plainPassword: '' } },
      );
      if (res.modifiedCount) this.logger.log(`Removed stored plain-text passwords from ${res.modifiedCount} account(s)`);
    } catch (e) {
      this.logger.warn(`Could not clear plain-text passwords: ${(e as Error)?.message}`);
    }
  }

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().sort({ role: 1, createdAt: 1 }).select(SECRET_USER_FIELDS).exec();
  }

  async findAllForAdmin(): Promise<UserDocument[]> {
    // Never send credentials to the browser — the Users page needs none of them.
    return this.userModel.find().sort({ role: 1, createdAt: 1 }).select(SECRET_USER_FIELDS).exec();
  }

  async findMentionable(): Promise<{ _id: string; name: string; username: string; role: string; active: boolean; avatar: string; jobTitle: string }[]> {
    const docs = await this.userModel.find({ isActive: { $ne: false } }).select('_id name username role isActive avatar jobTitle').lean().exec();
    return docs.map(u => ({
      _id: String(u._id),
      name: u.name || '',
      username: u.username || '',
      role: u.role || 'staff',
      active: u.isActive !== false,
      avatar: u.avatar || '',
      jobTitle: u.jobTitle || '',
    }));
  }

  async findByUsername(username: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ username }).exec();
  }

  /**
   * The set of currently-active user ids, as strings. For callers (duty board,
   * auto-assignment, presence) that hold a userId sourced from another collection
   * (a shift row, a Shopify order's assignedTo) and need to know whether that
   * account is still enabled — a disabled account must disappear from mentions,
   * assignment and "who's online", not just the Users page.
   */
  async findActiveUserIds(): Promise<Set<string>> {
    const docs = await this.userModel.find({ isActive: { $ne: false } }).select('_id').lean().exec();
    return new Set(docs.map((u) => String(u._id)));
  }

  async findAdmins(): Promise<UserDocument[]> {
    return this.userModel.find({ role: 'admin', isActive: { $ne: false } }).exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  async createUser(data: CreateUserDto | { username: string; password: string; name: string; role: string; phone?: string; perms?: string[] }): Promise<UserDocument> {
    const existing = await this.findByUsername(data.username);
    if (existing) {
      throw new ConflictException('اسم المستخدم موجود مسبقاً');
    }
    const hashed = await bcrypt.hash(data.password, 10);
    return this.userModel.create({ ...data, password: hashed });
  }

  async markOnboarded(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id, onboardingPending: true }, { $set: { onboardingPending: false, onboardedAt: new Date() } }).exec();
  }

  async updateUser(id: string, data: UpdateUserDto): Promise<UserDocument> {
    const update: Record<string, unknown> = { ...data };
    // Don't allow changing username via update
    delete update.username;
    delete update.roleId;
    delete update.roleAssignedAt;
    // Access is granted by a role only (AccessRolesService.assign / role edits). A profile
    // edit never writes the tier or the permission list.
    delete update.role;
    delete update.perms;
    // ⚠ A profile edit never changes the password (Nov 27, 2026): every change goes through
    // setPassword (own change with current password + code, staff reset with a code, recovery).
    delete update.password;
    const user = await this.userModel
      .findByIdAndUpdate(id, update, { new: true })
      .select(SECRET_USER_FIELDS)
      .exec();
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }
    return user;
  }

  async removeUser(id: string): Promise<void> {
    const result = await this.userModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException('المستخدم غير موجود');
    }
  }

  async toggleActive(id: string, isActive: boolean): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(id, { isActive }, { new: true })
      .select(SECRET_USER_FIELDS)
      .exec();
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    return user;
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(id, { lastLogin: new Date() }).exec();
  }

  async updateLastSeen(id: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(id, { lastSeen: new Date() }).exec();
  }

  async incrementLoginAttempts(id: string): Promise<number> {
    const user = await this.userModel
      .findByIdAndUpdate(id, { $inc: { loginAttempts: 1 } }, { new: true })
      .exec();
    return user?.loginAttempts ?? 0;
  }

  /** Is plain the current password or one of the previous 4 (= the last 5 used)? */
  async passwordReused(id: string, plain: string): Promise<boolean> {
    const doc: any = await this.userModel.findById(id).select('password passwordHistory').lean().exec();
    if (!doc) return false;
    const hashes = [doc.password, ...(Array.isArray(doc.passwordHistory) ? doc.passwordHistory : [])].filter(Boolean).slice(-5);
    for (const h of hashes) { try { if (await bcrypt.compare(String(plain || ''), h)) return true; } catch { /* unreadable hash */ } }
    return false;
  }

  /** Sets a new password (bcrypt), keeps the previous hash in the history, clears failed attempts. */
  async setPassword(id: string, plain: string): Promise<void> {
    const doc: any = await this.userModel.findById(id).select('password').lean().exec();
    if (!doc) throw new NotFoundException('المستخدم غير موجود');
    const hash = await bcrypt.hash(String(plain), 10);
    const update: any = { $set: { password: hash, passwordChangedAt: new Date(), loginAttempts: 0, passwordResetRequestedAt: null } };
    if (doc.password) update.$push = { passwordHistory: { $each: [doc.password], $slice: -4 } };
    await this.userModel.updateOne({ _id: id }, update).exec();
  }

  async setResetRight(id: string, allowed: boolean): Promise<void> {
    await this.userModel.updateOne({ _id: id, role: 'admin' }, { $set: { canResetStaffPasswords: !!allowed } }).exec();
  }

  async markPasswordResetRequested(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { passwordResetRequestedAt: new Date() } }).exec();
  }

  async setPasswordChangedAt(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { passwordChangedAt: new Date() } }).exec();
  }

  // ─── Security email (admin accounts, Nov 27, 2026) ───────────────────────
  async setSecurityEmailPending(id: string, pending: { email: string; codeHash: string; expiresAt: Date; attempts: number; sentAt: Date } | null): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { securityEmailPending: pending } }).exec();
  }

  async bumpSecurityEmailAttempts(id: string): Promise<number> {
    const doc: any = await this.userModel.findOneAndUpdate(
      { _id: id, securityEmailPending: { $ne: null } },
      { $inc: { 'securityEmailPending.attempts': 1 } },
      { new: true },
    ).select('securityEmailPending').lean().exec();
    return Number(doc?.securityEmailPending?.attempts || 99);
  }

  /** Conditional on the pending code read, so a replaced request cannot be confirmed. */
  async confirmSecurityEmail(id: string, email: string, codeHash: string): Promise<boolean> {
    const res = await this.userModel.updateOne(
      { _id: id, 'securityEmailPending.email': email, 'securityEmailPending.codeHash': codeHash },
      { $set: { securityEmail: email, securityEmailVerifiedAt: new Date(), securityEmailPending: null } },
    ).exec();
    return res.modifiedCount > 0;
  }

  async clearSecurityEmail(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { securityEmail: '', securityEmailVerifiedAt: null, securityEmailPending: null } }).exec();
  }

  async resetLoginAttempts(id: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(id, { loginAttempts: 0, loginLockedUntil: null, loginLockLevel: 0 }).exec();
  }

  /**
   * Starts a temporary sign-in pause once the failed count reaches the limit. Conditional on
   * the count, so simultaneous wrong attempts start ONE pause, not several longer ones.
   * Returns the pause end, or null when another request already started it.
   */
  async startLoginPause(id: string, maxAttempts: number, level: number, minutes: number, now: Date): Promise<Date | null> {
    const until = new Date(now.getTime() + minutes * 60000);
    const res = await this.userModel.updateOne(
      { _id: id, loginAttempts: { $gte: maxAttempts } },
      { $set: { loginAttempts: 0, loginLockedUntil: until, loginLockStartedAt: now, loginLockLevel: level } },
    ).exec();
    return res.modifiedCount ? until : null;
  }

  async lockAccount(id: string, reason: string, lockedBy = 'system'): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(
        id,
        { isActive: false, lockedAt: new Date(), lockReason: reason, lockedBy },
        { new: true },
      )
      .select(SECRET_USER_FIELDS)
      .exec();
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    return user;
  }

  async unlockAccount(id: string, adminId: string): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(
        id,
        { isActive: true, loginAttempts: 0, lockedAt: null, lockReason: '', lockedBy: adminId, loginLockedUntil: null, loginLockLevel: 0, suspendedUntil: null, suspensionReason: '', suspensionDetail: '', loginBlock: null },
        { new: true },
      )
      .select(SECRET_USER_FIELDS)
      .exec();
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    // Blocked sign-in sources of this account (login-guard) are lifted too.
    try {
      await this.userModel.db.collection('loginguard').deleteMany({ userKey: String(user.username || '').trim().toLowerCase(), kind: { $in: ['src', 'acct'] } });
    } catch { /* the account itself is unlocked either way */ }
    return user;
  }

  async findLockedUsers(): Promise<UserDocument[]> {
    return this.userModel
      .find({ $or: [
        { isActive: false, lockedAt: { $ne: null } },
        { loginLockedUntil: { $gt: new Date() } }, // temporary sign-in pause, still running
        { suspendedUntil: { $gt: new Date() } }, // suspended for tampering (abuse-guard)
        { 'loginBlock.hard': true }, // a sign-in source blocked until lifted (login-guard)
        { 'loginBlock.until': { $gt: new Date() } }, // a sign-in source paused
      ] })
      .select(SECRET_USER_FIELDS)
      .sort({ lockedAt: -1, loginLockStartedAt: -1 })
      .exec();
  }

  async countUsers(): Promise<number> {
    return this.userModel.countDocuments().exec();
  }

  async deleteAllUsers(): Promise<void> {
    await this.userModel.deleteMany({}).exec();
  }
}
