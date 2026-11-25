import { ForbiddenException } from '@nestjs/common';

/** Pick-Up actions (Nov 24, 2026). `pickup-orders-edit` is the pre-split key, still honoured. */
export type PickupAction = 'prepare' | 'move' | 'cancel' | 'bosta' | 'bosta-cancel';

export function hasPickupAction(user: { role?: string; perms?: string[] } | undefined, action: PickupAction): boolean {
  if (user?.role === 'admin') return true;
  const perms = user?.perms || [];
  if (!perms.includes('pickup-orders')) return false;
  return perms.includes(`pickup-orders-${action}`) || perms.includes('pickup-orders-edit');
}

const DENIED: Record<PickupAction, string> = {
  prepare: 'ليست لديك صلاحية تحضير الطلبات',
  move: 'ليست لديك صلاحية نقل الكروت',
  cancel: 'ليست لديك صلاحية إلغاء الكارت',
  bosta: 'ليست لديك صلاحية طلب بوسطة للشحن',
  'bosta-cancel': 'ليست لديك صلاحية إلغاء شحنة بوسطة',
};

export function assertPickupEditable(user?: { role?: string; perms?: string[] }, action: PickupAction = 'prepare'): void {
  if (hasPickupAction(user, action)) return;
  throw new ForbiddenException(DENIED[action]);
}
