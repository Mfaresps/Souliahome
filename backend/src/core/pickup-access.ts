import { ForbiddenException } from '@nestjs/common';

export function assertPickupEditable(user?: { role?: string; perms?: string[] }): void {
  if (user?.role === 'admin') return;
  const perms = user?.perms || [];
  if (perms.includes('pickup-orders') && perms.includes('pickup-orders-edit')) return;
  throw new ForbiddenException('طلبات الاستلام للمشاهدة فقط؛ ليس لديك صلاحية التعديل');
}
