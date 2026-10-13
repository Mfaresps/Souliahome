import { SecurityAuditService } from '../../security-audit/security-audit.service';
import { Inject, Optional } from '@nestjs/common';
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
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
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const { user } = request;
    if (!user || !user.role) {
      return false;
    }
    const allowed = requiredRoles.includes(user.role);
    if (!allowed) this.reportDenied(request);
    return allowed;
  }
}
