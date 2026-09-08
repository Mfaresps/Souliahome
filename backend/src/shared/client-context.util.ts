/**
 * Request-origin fingerprint — who connected, from where, on what.
 *
 * ⚠ There is exactly ONE parser in this codebase. `PresenceGateway` (live
 * sessions) and the security audit log (failed logins / lockouts) both read
 * from here. Two copies would drift, and the two panels would then describe
 * the same browser differently — which is precisely the thing an admin
 * comparing "who is online" against "who tried to log in" is looking for.
 *
 * Nothing here throws: this is forensic metadata attached to a request that is
 * already succeeding or already failing on its own merits. A malformed or
 * absent User-Agent must never turn a failed login into a 500.
 */

export interface GeoLocation {
  city: string;
  region: string;
  country: string;
  lat?: number;
  lon?: number;
  isp?: string;
}

export interface ClientContext {
  ipAddress: string;
  userAgent: string;
  device: string;
  browser: string;
  os: string;
}

/** Minimal shape both an Express request and a Socket.IO handshake satisfy. */
export interface HeaderCarrier {
  headers?: Record<string, unknown>;
  ip?: string;
  address?: string;
  socket?: { remoteAddress?: string };
}

const hdr = (carrier: HeaderCarrier | undefined, name: string): string => {
  const v = carrier?.headers?.[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
};

/**
 * The client IP behind nginx.
 *
 * ⚠ `X-Forwarded-For` is a CHAIN (`client, proxy1, proxy2`) — the originating
 * client is the FIRST entry. Taking the last one reports our own reverse proxy
 * for every request, so every audit row would read the same IP and the field
 * would be worthless.
 */
export function extractIpFrom(carrier: HeaderCarrier | undefined): string {
  const xff = hdr(carrier, 'x-forwarded-for');
  if (xff) return xff.split(',')[0].trim().replace(/^::ffff:/, '');
  const real = hdr(carrier, 'x-real-ip');
  if (real) return real.replace(/^::ffff:/, '');
  const direct = carrier?.ip || carrier?.address || carrier?.socket?.remoteAddress || '';
  return String(direct).replace(/^::ffff:/, '');
}

/**
 * Device / browser / OS from the User-Agent string.
 *
 * ⚠ Order is load-bearing in all three ladders. Every Chromium browser still
 * carries `Safari/` in its UA and Edge carries `Chrome/`, so the most specific
 * token must be tested first — reordering these silently relabels every Edge
 * session as Chrome and every Chrome session as Safari.
 */
export function parseUserAgent(ua: string): { device: string; browser: string; os: string } {
  const u = ua || '';

  let device = 'كمبيوتر';
  if (/iPad|Tablet/i.test(u)) device = 'تابلت';
  else if (/Mobile|Android|iPhone/i.test(u)) device = 'موبايل';

  let browser = 'متصفح';
  if (/Edg\//i.test(u)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(u)) browser = 'Opera';
  else if (/SamsungBrowser\//i.test(u)) browser = 'Samsung Internet';
  else if (/Chrome\//i.test(u)) browser = 'Chrome';
  else if (/Firefox\//i.test(u)) browser = 'Firefox';
  else if (/Safari\//i.test(u)) browser = 'Safari';

  let os = '';
  if (/Windows/i.test(u)) os = 'Windows';
  else if (/Android/i.test(u)) os = 'Android';
  else if (/iPhone|iPad|iPod|iOS/i.test(u)) os = 'iOS';
  else if (/Mac OS/i.test(u)) os = 'macOS';
  else if (/Linux/i.test(u)) os = 'Linux';

  return { device, browser, os };
}

/** Everything the audit log needs about where a request came from. */
export function buildClientContext(carrier: HeaderCarrier | undefined): ClientContext {
  const userAgent = hdr(carrier, 'user-agent');
  const parsed = parseUserAgent(userAgent);
  return {
    ipAddress: extractIpFrom(carrier),
    userAgent,
    device: parsed.device,
    browser: parsed.browser,
    os: parsed.os,
  };
}
