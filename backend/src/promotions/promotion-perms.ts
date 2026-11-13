/**
 * Promotions page permissions (Nov 12, 2026) — «العروض والخصومات».
 * Before this page existed every write here was @Roles('admin'). Each area is now its own
 * delegable perm; `promotions-view` opens the page. ⚠ Mirrored by PROMO_PERMS / promoPerm() in
 * frontend/public/index.html and by the RBAC group in roles-permissions.js.
 */
export const PROMOTION_PERMS = [
  'promotions-view',
  'promotions-offers',
  'promotions-codes',
  'promotions-bundles',
  'promotions-tags',
  'promotions-audit',
] as const;

type PromoUser = { role?: string; perms?: string[] } | null | undefined;

/** Any promotions perm opens the page read-only — whoever manages codes must be able to see them. */
export function canViewPromotions(user: PromoUser): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user.perms || []).some((p) => (PROMOTION_PERMS as readonly string[]).includes(p));
}
