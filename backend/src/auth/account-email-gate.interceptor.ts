import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { SecurityMailerService } from './security-mailer.service';
import { accountEmailGateAllows } from './account-email.util';

/**
 * «أضف بريدك الإلكتروني» on the server (owner, Nov 28, 2026). An active employee with no confirmed
 * account email, while mail can be sent, reaches only the routes `accountEmailGateAllows` lists until the
 * address is confirmed — the window in the page is no longer the only thing holding them.
 *
 * Runs after the guards (APP_INTERCEPTOR), so `req.user` is the JwtStrategy result; a route without a
 * session (webhooks, the join page, sign-in) has no `req.user` and is never touched. Admins use their
 * security email and are never held here.
 */
@Injectable()
export class AccountEmailGateInterceptor implements NestInterceptor {
  constructor(private readonly mailer: SecurityMailerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const u = req?.user;
    if (!u || u.role === 'admin' || u.emailVerified !== false) return next.handle();
    if (!this.mailer.configured()) return next.handle();
    if (accountEmailGateAllows(req.method, req.originalUrl || req.url || '')) return next.handle();
    // ⚠ Not counted as a refused write by the tampering protection (abuse-guard onHttpError).
    req._accountEmailHeld = true;
    throw new ForbiddenException({
      message: 'أضف بريدك الإلكتروني وأكّده أولًا لمتابعة استخدام النظام.',
      code: 'ACCOUNT_EMAIL_REQUIRED',
    });
  }
}
