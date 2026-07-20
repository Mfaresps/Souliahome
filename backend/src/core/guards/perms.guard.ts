import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMS_KEY } from '../decorators/perms.decorator';

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
    return requiredPerms.every((p) => perms.includes(p));
  }
}
