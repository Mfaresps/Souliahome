import { SecurityAuditService } from '../../security-audit/security-audit.service';
import { Inject, Optional } from '@nestjs/common';
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMS_KEY } from '../decorators/perms.decorator';

/**
 * Legacy perm strings that still satisfy a newer, finer-grained perm.
 * Keyed by the required perm -> the older strings that also grant it.
 *
 * `categories` was a nav-only perm before the categories-* set existed; honouring it
 * here keeps the guard in step with the frontend's catPerm() alias, so a user carrying
 * the old string can't see a page whose API then 403s. Read-only perms only — a legacy
 * blanket string must never imply a write.
 */
const LEGACY_PERM_ALIASES: Record<string, string[]> = {
  'categories-view': ['categories'],
  // The blanket `suppliers` perm predates the suppliers-* split. It keeps granting the six READ
  // tabs — exactly what a non-admin holding it could already see — so no existing account loses
  // access. It must never appear under an action perm (suppliers-pay, -deposit, -ledger-adjust,
  // -write-off, -reverse, -returns): those were admin-only, and payment was the unguarded hole
  // this split exists to close. Mirrors supPerm()/SUP_TAB_ACTIONS in index.html.
  'suppliers-tab-invoices': ['suppliers'],
  'suppliers-tab-pos': ['suppliers'],
  'suppliers-tab-sreturns': ['suppliers'],
  'suppliers-tab-payments': ['suppliers'],
  'suppliers-tab-ledger': ['suppliers'],
  'suppliers-tab-activity': ['suppliers'],
};

@Injectable()
export class PermsGuard implements CanActivate {
  @Optional() @Inject(SecurityAuditService) private readonly audit?: SecurityAuditService;
  private reportDenied(request: any) {
    if (!request.user?.userId || request.securityDenialAudited) return;
    request.securityDenialAudited = true;
    try {
      void this.audit?.log({ userId: request.user.userId, username: request.user.username || request.user.name || '', violationType: 'unauthorized_access', action: 'Unauthorized access attempt', ipAddress: request.ip }).catch(() => {});
    } catch { /* Keep the permission decision independent of auditing. */ }
  }
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPerms = this.reflector.getAllAndOverride<string[]>(
      PERMS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredPerms || requiredPerms.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const { user } = request;
    if (!user) {
      return false;
    }
    if (user.role === 'admin') {
      return true;
    }
    const perms: string[] = user.perms || [];
    const allowed = requiredPerms.every(
      (p) =>
        perms.includes(p) ||
        (LEGACY_PERM_ALIASES[p] || []).some((alias) => perms.includes(alias)),
    );
    if (!allowed) this.reportDenied(request);
    return allowed;
  }
}
