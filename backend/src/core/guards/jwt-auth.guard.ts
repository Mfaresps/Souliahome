import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { managedRoleRequiredPermissions } from './managed-role-access';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = await super.canActivate(context);
    if (!authenticated) return false;
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user?.roleId || user.role === 'admin') return true;
    const required = managedRoleRequiredPermissions(request.path || request.url, request.method, request.body);
    const businessWrite = !['GET','HEAD','OPTIONS'].includes(request.method)
      && required !== null
      && !(String(request.path || request.url).endsWith('/transactions/movements-page'));
    if (user.role === 'viewer' && businessWrite) {
      throw new ForbiddenException('Viewer role cannot change business data');
    }
    if (required && !required.some(key => user.perms?.includes(key))) {
      throw new ForbiddenException('Permission required for this module');
    }
    return true;
  }
}
