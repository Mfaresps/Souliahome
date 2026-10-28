import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
@Injectable()
export class ComplaintsAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const user = context.switchToHttp().getRequest().user;
    return !!user && (user.role === 'admin' || (user.perms || []).some((p: string) => ['complaints','transaction'].includes(p)));
  }
}
