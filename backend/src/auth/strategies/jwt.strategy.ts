import { HttpException } from '@nestjs/common';
import { suspensionPayload } from '../../abuse-guard/abuse-guard.service';
import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { requireJwtSecret } from '../jwt-secret.util';
import { UserSessionsService } from '../user-sessions.service';
import { endedMessage, legacyTokenAllowed } from '../user-sessions.util';

interface JwtPayload {
  sub: string;
  username: string;
  /** Session id (usersessions row). Absent on tokens signed before Nov 27, 2026. */
  sid?: string;
  iat?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly usersService: UsersService,
    @Optional() private readonly sessions?: UserSessionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireJwtSecret(process.env.JWT_SECRET),
    });
  }

  async validate(payload: JwtPayload): Promise<Record<string, unknown>> {
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException();
    }
    if (user.isActive === false) {
      throw new UnauthorizedException(
        `🔒 تم تعطيل هذا الحساب — ${user.lockReason || 'تواصل مع المدير لإعادة التفعيل'}`,
      );
    }
    // An ended session (logout, or ended by an admin from «الجلسات والأجهزة») signs this device out.
    // ⚠ Coded SESSION_ENDED so the page shows «your session was ended», not «account disabled».
    if (payload.sid && this.sessions) {
      const state = await this.sessions.check(payload.sid, payload.sub);
      if (!state.ok) throw new UnauthorizedException({ statusCode: 401, message: state.message, code: 'SESSION_ENDED' });
    } else if (!legacyTokenAllowed(payload.iat, (user as any).legacyTokensValidAfter)) {
      throw new UnauthorizedException({ statusCode: 401, message: endedMessage({ endReason: 'revoked-all', endedBy: null }), code: 'SESSION_ENDED' });
    }
    // Temporarily suspended for tampering (abuse-guard): every session stops at once.
    const suspendedUntil = (user as any).suspendedUntil ? new Date((user as any).suspendedUntil) : null;
    if (user.role !== 'admin' && suspendedUntil && suspendedUntil.getTime() > Date.now()) {
      throw new HttpException(suspensionPayload(user as any), 423);
    }
    return {
      userId: payload.sub,
      username: payload.username,
      sid: payload.sid || '',
      name: user.name,
      role: user.role,
      roleId: user.roleId || null,
      phone: user.phone || '',
      avatar: user.avatar || '',
      jobTitle: user.jobTitle || '',
      perms: user.perms || [],
      lastLogin: user.lastLogin || null,
      lastSeen: user.lastSeen || null,
      createdAt: (user as unknown as { createdAt?: Date }).createdAt || null,
      // Inactive users are rejected by the guard above, so this is always true here.
      isActive: true,
      totpEnabled: !!user.totpEnabled,
    };
  }
}
