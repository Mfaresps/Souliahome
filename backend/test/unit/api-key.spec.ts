import {
  generateApiKey, hashApiKey, ipAllowed, normalizeIpList, normalizeRateLimit, normalizeScopes, RateWindow, readApiKey,
} from '../../src/public-api/api-key.util';
import { confirmationBucket } from '../../src/shared/shopify-confirmation-bucket.util';

describe('external API keys', () => {
  it('generates a key whose hash is what is stored, never the key', () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key).toMatch(/^sk_live_[A-Za-z0-9_-]{40,}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).not.toContain(key);
    expect(key.startsWith(prefix)).toBe(true);
    expect(generateApiKey().key).not.toBe(key);
  });

  it('reads the key from X-API-Key or a Bearer sk_live_ header only', () => {
    expect(readApiKey({ 'x-api-key': ' sk_live_abc ' })).toBe('sk_live_abc');
    expect(readApiKey({ authorization: 'Bearer sk_live_xyz' })).toBe('sk_live_xyz');
    expect(readApiKey({ authorization: 'Bearer eyJhbGciOi.jwt' })).toBe('');
    expect(readApiKey({})).toBe('');
  });

  it('keeps known sections only; writing implies reading follow-ups', () => {
    expect(normalizeScopes(['orders', 'delete-everything'])).toEqual(['orders']);
    expect(normalizeScopes(['followups-write'])).toEqual(['followups-write', 'followups']);
    expect(normalizeScopes('orders')).toEqual([]);
  });

  it('bounds the rate limit', () => {
    expect(normalizeRateLimit(5)).toBe(10);
    expect(normalizeRateLimit(10_000)).toBe(600);
    expect(normalizeRateLimit('x')).toBe(120);
  });

  it('matches addresses and IPv4 ranges; empty list allows all', () => {
    const list = normalizeIpList('41.33.10.0/24, 1.2.3.4 bad 300.1.1.1');
    expect(list).toEqual(['41.33.10.0/24', '1.2.3.4']);
    expect(ipAllowed('41.33.10.200', list)).toBe(true);
    expect(ipAllowed('41.33.11.1', list)).toBe(false);
    expect(ipAllowed('::ffff:1.2.3.4', list)).toBe(true);
    expect(ipAllowed('', list)).toBe(false);
    expect(ipAllowed('9.9.9.9', [])).toBe(true);
  });

  it('refuses past the per-minute limit and says how long to wait', () => {
    const w = new RateWindow();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(w.take('k', 3, t0 + i)).toBe(0);
    const wait = w.take('k', 3, t0 + 10);
    expect(wait).toBeGreaterThan(0);
    expect(w.take('k', 3, t0 + 60_001)).toBe(0);
    expect(w.take('other', 3, t0 + 10)).toBe(0);
  });
});

describe('Shopify confirmation buckets (KPI strip rule)', () => {
  it('first match wins: cancelled → deposit → no deposit → follow-up → open', () => {
    expect(confirmationBucket({ status: 'rejected', depositReceipts: [{ status: 'معتمد', amount: 100 }] }, true)).toBe('cancelled');
    expect(confirmationBucket({ status: 'pending', depositReceipts: [{ status: 'معتمد', amount: 100 }] }, true)).toBe('deposit');
    expect(confirmationBucket({ status: 'pending', depositReceipts: [{ status: 'معلق', amount: 100 }] }, false)).toBe('open');
    expect(confirmationBucket({ status: 'approved', depositAmount: 50 }, false)).toBe('deposit');
    expect(confirmationBucket({ status: 'pending', shipWithoutDeposit: true }, true)).toBe('nodep');
    expect(confirmationBucket({ status: 'pending' }, true)).toBe('followup');
    expect(confirmationBucket({ status: 'pending' }, false)).toBe('open');
  });
});
