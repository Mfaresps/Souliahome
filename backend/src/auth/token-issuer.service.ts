import { Injectable, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ClientContext } from '../shared/client-context.util';
import { UserSessionsService } from './user-sessions.service';
import type { SessionMethod } from './user-sessions.util';

/**
 * Signs the token for a finished sign-in and records it as a session (its id goes in the token
 * as `sid`). If the session row cannot be written the token is signed WITHOUT a sid — a sid with
 * no row would be refused on the next request, i.e. a sign-in that fails silently.
 * ⚠ The only place a sign-in token is created: password-only sign-in (AuthService) and every
 * second-step finish (SignInVerificationService) go through here.
 */
@Injectable()
export class TokenIssuerService {
  constructor(
    private readonly jwtService: JwtService,
    @Optional() private readonly sessions?: UserSessionsService,
  ) {}

  async issue(user: Record<string, any>, method: SessionMethod, client?: ClientContext): Promise<string> {
    const base = { sub: String(user._id), username: user.username };
    if (!this.sessions) return this.jwtService.sign(base);
    const sid = this.sessions.newSessionId();
    const token = this.jwtService.sign({ ...base, sid });
    try {
      const decoded = this.jwtService.decode(token) as { exp?: number } | null;
      const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 86_400_000);
      await this.sessions.create({ sid, user: { _id: user._id, username: user.username, name: user.name, role: user.role }, client, method, expiresAt });
      return token;
    } catch {
      return this.jwtService.sign(base);
    }
  }
}
