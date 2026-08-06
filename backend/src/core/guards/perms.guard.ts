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
};

@Injectable()
export class PermsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPerms = this.reflector.getAllAndOverride<string[]>(
      PERMS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredPerms || requiredPerms.length === 0) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      return false;
    }
    if (user.role === 'admin') {
      return true;
    }
    const perms: string[] = user.perms || [];
    return requiredPerms.every(
      (p) =>
        perms.includes(p) ||
        (LEGACY_PERM_ALIASES[p] || []).some((alias) => perms.includes(alias)),
    );
  }
}
