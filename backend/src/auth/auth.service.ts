import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { MentionsService } from '../mentions/mentions.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';
import { LoginDto } from './dto/login.dto';

const MAX_LOGIN_ATTEMPTS = 5;

// In-memory user status tracker
const usersStatus: Record<string, { status: 'online' | 'offline'; lastSeen: Date }> = {};

export interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    username: string;
    name: string;
    role: string;
    phone: string;
    avatar: string;
    perms: string[];
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly mentionsService: MentionsService,
    private readonly auditService: SecurityAuditService,
  ) {}

  async login(loginDto: LoginDto, ipAddress?: string): Promise<LoginResponse> {
    const user = await this.usersService.findByUsername(loginDto.username);

    if (!user) {
      // Unknown username — still audit so we catch brute-force on valid names
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
    }

    // Already locked
    if (user.isActive === false) {
      await this.auditService.log({
        userId: user._id.toString(),
        username: user.username,
        violationType: 'failed_login',
        action: 'محاولة تسجيل دخول على حساب مُعطَّل',
        detail: `السبب: ${user.lockReason || 'محظور'}`,
        ipAddress,
      });
      throw new UnauthorizedException(
        `🔒 تم تعطيل هذا الحساب — ${user.lockReason || 'تواصل مع المدير لإعادة التفعيل'}`,
      );
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.password);

    if (!isPasswordValid) {
      const attempts = await this.usersService.incrementLoginAttempts(user._id.toString());

      await this.auditService.log({
        userId: user._id.toString(),
        username: user.username,
        violationType: 'failed_login',
        action: `فشل تسجيل الدخول — المحاولة ${attempts} من ${MAX_LOGIN_ATTEMPTS}`,
        detail: 'كلمة مرور خاطئة',
        ipAddress,
      });

      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        const lockReason = `تم تعطيل الحساب تلقائياً بعد ${MAX_LOGIN_ATTEMPTS} محاولات دخول فاشلة`;
        await this.usersService.lockAccount(user._id.toString(), lockReason, 'system');

        await this.auditService.log({
          userId: user._id.toString(),
          username: user.username,
          violationType: 'account_locked',
          action: lockReason,
          detail: `IP: ${ipAddress || 'غير معروف'}`,
          ipAddress,
        });

        await this._notifyAdmins(
          user.username,
          user.name,
          `🚨 تم تعطيل حساب "${user.name || user.username}" تلقائياً بعد ${MAX_LOGIN_ATTEMPTS} محاولات دخول فاشلة. IP: ${ipAddress || 'غير معروف'}`,
        );

        throw new UnauthorizedException(
          `🔒 تم تعطيل حسابك بعد ${MAX_LOGIN_ATTEMPTS} محاولات فاشلة — تواصل مع المدير لإعادة التفعيل`,
        );
      }

      const remaining = MAX_LOGIN_ATTEMPTS - attempts;
      throw new UnauthorizedException(
        `كلمة المرور غير صحيحة — تبقى ${remaining} محاولة قبل تعطيل الحساب`,
      );
    }

    // Successful login — reset counter
    await this.usersService.resetLoginAttempts(user._id.toString());
    await this.usersService.updateLastLogin(user._id.toString());

    const payload = { sub: user._id.toString(), username: user.username };
    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user._id.toString(),
        username: user.username,
        name: user.name,
        role: user.role,
        phone: user.phone || '',
        avatar: user.avatar || '',
        perms: user.perms || [],
      },
    };
  }

  private async _notifyAdmins(_username: string, _name: string, message: string): Promise<void> {
    try {
      const allUsers = await this.usersService.findAll();
      const admins = allUsers.filter(u => u.role === 'admin');
      if (!admins.length) return;
      await this.mentionsService.createMany(
        admins.map(a => ({
          targetUserId: a._id.toString(),
          targetUsername: a.username,
          targetName: a.name,
          fromUserId: 'system',
          fromName: 'نظام الأمان',
          commentText: message,
          read: false,
        })),
      );
    } catch {
      // Non-fatal — don't break login flow
    }
  }

  async setUserStatus(
    userId: string,
    status: 'online' | 'offline',
  ): Promise<{ message: string }> {
    usersStatus[userId] = {
      status,
      lastSeen: new Date(),
    };
    return { message: `تم تحديث الحالة إلى ${status === 'online' ? 'متصل' : 'غير متصل'}` };
  }

  async getUsersStatus(): Promise<{
    online: Record<string, { status: string; lastSeen: string }>;
  }> {
    const online: Record<string, { status: string; lastSeen: string }> = {};
    for (const [userId, status] of Object.entries(usersStatus)) {
      online[userId] = {
        status: status.status,
        lastSeen: status.lastSeen.toISOString(),
      };
    }
    return { online };
  }
}
