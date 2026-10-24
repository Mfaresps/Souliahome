import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class AfterSalesAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const user = context.switchToHttp().getRequest().user;
    if (!user?.userId) return false;
    if (user.role === 'admin') return true;
    const handler = context.getHandler().name;
    const perms: string[] = user.perms || [];
    if (handler === 'report') return perms.includes('reports');
    if (['quote', 'create'].includes(handler)) return perms.includes('transaction');
    if (handler === 'sync') return perms.includes('shopify-prepare-ship');
    return ['transaction', 'movements', 'reports', 'inventory-units-condition', 'shopify-prepare-ship'].some(p => perms.includes(p));
  }
}
