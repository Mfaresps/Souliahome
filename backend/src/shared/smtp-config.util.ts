/**
 * Which SMTP server a sending account uses (Nov 28, 2026).
 *
 * The sender moved from souliaalerts@gmail.com to no-reply@soulia.store, whose mailbox is on
 * Hostinger (MX mx1/mx2.hostinger.com). The server is picked from the sending address so the
 * Jenkins credential `soulia-smtp` alone decides it:
 *   SMTP_HOST set → that host · @gmail.com / @googlemail.com → smtp.gmail.com · anything else →
 *   smtp.hostinger.com.
 * ⚠ Spaces are removed from the password only for Gmail (its App Password is shown in groups of
 * four); a mailbox password may legitimately contain a space.
 */
export function isGmailAddress(user: string): boolean {
  return /@(gmail|googlemail)\.com$/i.test(String(user || '').trim());
}

export function smtpHostFor(user: string, explicitHost?: string): string {
  const host = String(explicitHost || '').trim();
  if (host) return host;
  return isGmailAddress(user) ? 'smtp.gmail.com' : 'smtp.hostinger.com';
}

export function smtpPassFor(user: string, rawPass?: string): string {
  const pass = String(rawPass || '');
  return isGmailAddress(user) ? pass.replace(/\s+/g, '') : pass.trim();
}
