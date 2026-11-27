export interface AuthUserPayload {
  id: string;
  username: string;
  name: string;
  role: string;
  roleId: string | null;
  phone: string;
  avatar: string;
  jobTitle: string;
  perms: string[];
  lastLogin: string | null;
  lastSeen: string | null;
  createdAt: string | null;
  isActive: boolean;
  totpEnabled: boolean;
  onboardingPending: boolean;
}

/**
 * Single source of truth for the user object returned to the client (login,
 * second-step verify, /auth/me). Every field the profile page reads must be here —
 * lastLogin/createdAt used to be omitted, so the UI showed "غير متاح".
 *
 * `lastLoginOverride` lets the login flow report the *previous* login instead
 * of the one being performed right now.
 */
export function buildAuthUserPayload(
  user: Record<string, any>,
  lastLoginOverride?: Date | null,
): AuthUserPayload {
  const iso = (v: unknown): string | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v as string);
    return isNaN(d.getTime()) ? null : d.toISOString();
  };
  return {
    id: user._id ? String(user._id) : String(user.id ?? ''),
    username: user.username || '',
    name: user.name || '',
    role: user.role || '',
    roleId: user.roleId || null,
    phone: user.phone || '',
    avatar: user.avatar || '',
    jobTitle: user.jobTitle || '',
    perms: user.perms || [],
    lastLogin: iso(lastLoginOverride !== undefined ? lastLoginOverride : user.lastLogin),
    lastSeen: iso(user.lastSeen),
    createdAt: iso(user.createdAt),
    isActive: user.isActive !== false,
    totpEnabled: !!user.totpEnabled,
    onboardingPending: !!user.onboardingPending,
  };
}
