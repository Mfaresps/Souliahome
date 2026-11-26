import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * External API keys (e.g. Instinct) — pure rules, no I/O.
 *
 * ⚠ The plain key is shown ONCE when it is created or rotated. Only its SHA-256 is stored, so a
 * leaked database (or backup) never leaks a usable key. A key is 32 random bytes; a plain hash
 * (no salt) is enough for that much entropy and lets the guard find the key in one indexed query.
 */
export const API_KEY_PREFIX = 'sk_live_';

/** What a key may reach. `code` is stored on the key — never rename one. */
export const API_SCOPES = [
  { code: 'orders', ar: 'الأوردرات', en: 'Orders', write: false },
  { code: 'shipping', ar: 'حالة الشحن ومشاكل الشحن', en: 'Shipping status & problems', write: false },
  { code: 'followups', ar: 'المتابعات', en: 'Follow-ups', write: false },
  { code: 'followups-write', ar: 'إضافة ملاحظة متابعة', en: 'Add follow-up notes', write: true },
  { code: 'mentions', ar: 'إشعارات المنشن والرد عليها', en: 'Mentions', write: false },
  { code: 'complaints', ar: 'الشكاوى', en: 'Complaints', write: false },
  { code: 'inventory', ar: 'المخزون', en: 'Inventory', write: false },
  { code: 'reports', ar: 'التقارير والمؤشرات', en: 'Reports & KPIs', write: false },
  { code: 'reports-financial', ar: 'التقارير المالية (الأرباح والمصاريف والمشتريات)', en: 'Financial reports (profit, expenses, purchases)', write: false },
  { code: 'products', ar: 'المنتجات ومبيعاتها', en: 'Products & product sales', write: false },
  { code: 'purchasing', ar: 'اقتراحات الشراء', en: 'Purchase suggestions', write: false },
  { code: 'stock-analysis', ar: 'تحليل احتياج المخزون للأوردرات', en: 'Order stock analysis', write: false },
  { code: 'purchasing-write', ar: 'طلب أمر شراء', en: 'Request purchase orders', write: true },
  { code: 'returns', ar: 'المرتجعات والاستبدال', en: 'Returns & exchanges', write: false },
  { code: 'assistant-write', ar: 'الرد على أسئلة الموظفين في مساعد SOULIA', en: 'Reply to staff questions in the SOULIA chat', write: true },
] as const;
export type ApiScope = (typeof API_SCOPES)[number]['code'];
export const API_SCOPE_CODES: string[] = API_SCOPES.map((s) => s.code);

export const DEFAULT_RATE_LIMIT = 120; // requests per minute per key
export const MIN_RATE_LIMIT = 10;
export const MAX_RATE_LIMIT = 600;

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, hash: hashApiKey(key), prefix: key.slice(0, API_KEY_PREFIX.length + 6) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(String(key || ''), 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** The key from `X-API-Key`, or `Authorization: Bearer sk_live_…`. */
export function readApiKey(headers: Record<string, unknown> | undefined): string {
  const h = (name: string) => {
    const v = headers?.[name];
    return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
  };
  const direct = h('x-api-key').trim();
  if (direct) return direct;
  const auth = h('authorization').trim();
  const m = /^Bearer\s+(sk_live_\S+)$/i.exec(auth);
  return m ? m[1] : '';
}

export function normalizeScopes(input: unknown): string[] {
  const list = Array.isArray(input) ? input.map(String) : [];
  const out = API_SCOPE_CODES.filter((c) => list.includes(c));
  // Writing a note without reading the follow-up it lands on makes no sense.
  if (out.includes('followups-write') && !out.includes('followups')) out.push('followups');
  if (out.includes('purchasing-write') && !out.includes('purchasing')) out.push('purchasing');
  if (out.includes('reports-financial') && !out.includes('reports')) out.push('reports');
  return out;
}

export function normalizeRateLimit(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RATE_LIMIT;
  return Math.min(MAX_RATE_LIMIT, Math.max(MIN_RATE_LIMIT, n));
}

/** IPv4 / IPv6 addresses and IPv4 CIDR ranges, one per entry; invalid entries are dropped. */
export function normalizeIpList(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item || '').trim();
    if (!s) continue;
    if (/^(\d{1,3}\.){3}\d{1,3}(\/(\d|[12]\d|3[0-2]))?$/.test(s) && s.split('/')[0].split('.').every((p) => Number(p) <= 255)) out.push(s);
    else if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) out.push(s.toLowerCase());
  }
  return [...new Set(out)].slice(0, 50);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** An empty list allows every address. */
export function ipAllowed(ip: string, list: string[] | undefined): boolean {
  if (!list || !list.length) return true;
  const addr = String(ip || '').replace(/^::ffff:/, '').trim().toLowerCase();
  if (!addr) return false;
  for (const entry of list) {
    if (!entry.includes('/')) { if (entry === addr) return true; continue; }
    const [base, bitsS] = entry.split('/');
    const bits = Number(bitsS);
    const a = ipv4ToInt(addr), b = ipv4ToInt(base);
    if (a === null || b === null) continue;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

/**
 * Requests per minute per key, in memory (one process — same as the abuse guard).
 * Sliding 60-second window.
 */
export class RateWindow {
  private hits = new Map<string, number[]>();
  constructor(private readonly windowMs = 60_000) {}

  /** Records one request; returns how many seconds to wait when over the limit, else 0. */
  take(id: string, limit: number, now = Date.now()): number {
    const from = now - this.windowMs;
    const list = (this.hits.get(id) || []).filter((t) => t > from);
    if (list.length >= limit) {
      this.hits.set(id, list);
      return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
    }
    list.push(now);
    this.hits.set(id, list);
    if (this.hits.size > 500) for (const [k, v] of this.hits) if (!v.length || v[v.length - 1] <= from) this.hits.delete(k);
    return 0;
  }

  count(id: string, now = Date.now()): number {
    return (this.hits.get(id) || []).filter((t) => t > now - this.windowMs).length;
  }
}
