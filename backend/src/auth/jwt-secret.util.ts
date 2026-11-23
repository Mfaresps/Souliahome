/**
 * The JWT secret signs every login token. It used to fall back to a value written in this
 * repository, so a missing JWT_SECRET left the system running with a secret anyone could read
 * (and forge an admin token with). Now a missing secret stops the server at start-up instead.
 */
export function requireJwtSecret(value: string | undefined): string {
  const secret = String(value || '').trim();
  if (!secret) {
    throw new Error('JWT_SECRET is not set — refusing to start without a token signing secret.');
  }
  return secret;
}
