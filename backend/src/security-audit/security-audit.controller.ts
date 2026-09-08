import { Controller, Get, Post, Body, Param, Req, UseGuards } from '@nestjs/common';
import { SecurityAuditService } from './security-audit.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { UsersService } from '../users/users.service';
import { MentionsService } from '../mentions/mentions.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('security-audit')
export class SecurityAuditController {
  constructor(
    private readonly auditService: SecurityAuditService,
    private readonly usersService: UsersService,
    private readonly mentionsService: MentionsService,
  ) {}

  @Roles('admin')
  @Get('logs')
  async getAllLogs() {
    return this.auditService.findAll();
  }

  /**
   * Locked accounts, each with the attempts that locked it.
   *
   * The origin (browser / OS / IP / location) lives on the audit log, not on
   * the user record, so it is joined here. This is the first screen an admin
   * sees after a lockout — making them scroll to the log below to answer
   * "who was this?" is the gap this closes.
   *
   * ⚠ Never throws on the join: a locked account must still be listed (and
   * therefore still be unlockable) even if its history cannot be read.
   */
  @Roles('admin')
  @Get('locked-users')
  async getLockedUsers() {
    const locked = await this.usersService.findLockedUsers();
    return Promise.all(
      locked.map(async (u) => {
        const plain = typeof (u as any).toObject === 'function' ? (u as any).toObject() : u;
        let attempts: unknown[] = [];
        try {
          attempts = await this.auditService.findLockoutAttempts(
            u._id.toString(),
            (u as any).lockedAt ?? null,
          );
        } catch {
          attempts = [];
        }
        return { ...plain, attempts };
      }),
    );
  }

  @Roles('admin')
  @Get('unresolved')
  async getUnresolved() {
    return this.auditService.findUnresolved();
  }

  @Roles('admin')
  @Get('user/:userId')
  async getUserLogs(@Param('userId') userId: string) {
    return this.auditService.findForUser(userId);
  }

  @Roles('admin')
  @Post('unlock/:userId')
  async unlockUser(
    @Param('userId') userId: string,
    @Req() req: any,
    @Body() body: { reason?: string },
  ) {
    const admin = req.user;
    const user = await this.usersService.unlockAccount(userId, admin.userId);

    await this.auditService.log({
      userId,
      username: user.username,
      violationType: 'account_unlocked',
      action: `تم إلغاء تعطيل الحساب بواسطة المدير ${admin.name || admin.username}`,
      detail: body.reason || '',
    });

    // Notify all admins of the unlock
    try {
      const allUsers = await this.usersService.findAll();
      const adminUsers = allUsers.filter(u => u.role === 'admin');
      await this.mentionsService.createMany(
        adminUsers.map(a => ({
          targetUserId: a._id.toString(),
          targetUsername: a.username,
          targetName: a.name,
          fromUserId: admin.userId || 'system',
          fromName: admin.name || admin.username || 'admin',
          txId: '',
          commentText: `✅ تم إلغاء تعطيل حساب "${user.name || user.username}" بواسطة ${admin.name || admin.username}${body.reason ? ' — ' + body.reason : ''}`,
          read: false,
        })),
      );
    } catch (_) {
      // notification failure must not break unlock
    }

    return { success: true, user };
  }
}
