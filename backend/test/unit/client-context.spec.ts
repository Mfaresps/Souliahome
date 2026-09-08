import {
  buildClientContext,
  parseUserAgent,
  extractIpFrom,
} from '../../src/shared/client-context.util';
import { isPrivateIp, formatGeoLabel } from '../../src/shared/geo-lookup.util';

/**
 * Locks in the request-origin fingerprint attached to every security audit row.
 *
 * Before this, a lockout row said only «تم تعطيل الحساب تلقائياً بعد 4 محاولات
 * دخول فاشلة» — the schema had an `ipAddress` field that nothing displayed, and
 * no device data at all. An admin could not tell an employee mistyping their own
 * password on their own phone from an actual attack from an unknown machine.
 *
 * Every assertion here guards a rule that is easy to break by "tidying" the
 * regex ladders, since a wrong answer still looks like a plausible browser name.
 */
describe('client-context — request origin fingerprint', () => {
  const UA = {
    chromeWin:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    edgeWin:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    operaWin:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
    samsung:
      'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
    safariIphone:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    safariIpad:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1',
    chromeAndroid:
      'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    firefoxLinux:
      'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    safariMac:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  };

  describe('browser — the specificity ladder is load-bearing', () => {
    // ⚠ Every Chromium browser carries `Safari/` in its UA, and Edge/Opera/Samsung
    // additionally carry `Chrome/`. Reordering these tests silently relabels every
    // Edge session as Chrome and every Chrome session as Safari — a wrong answer
    // that still reads as a real browser name, so nothing looks broken.
    it('reports Edge as Edge, not Chrome', () => {
      expect(parseUserAgent(UA.edgeWin).browser).toBe('Edge');
    });
    it('reports Opera as Opera, not Chrome', () => {
      expect(parseUserAgent(UA.operaWin).browser).toBe('Opera');
    });
    it('reports Samsung Internet, not Chrome', () => {
      expect(parseUserAgent(UA.samsung).browser).toBe('Samsung Internet');
    });
    it('reports Chrome as Chrome, not Safari', () => {
      expect(parseUserAgent(UA.chromeWin).browser).toBe('Chrome');
    });
    it('reports real Safari as Safari', () => {
      expect(parseUserAgent(UA.safariMac).browser).toBe('Safari');
    });
    it('reports Firefox', () => {
      expect(parseUserAgent(UA.firefoxLinux).browser).toBe('Firefox');
    });
  });

  describe('device', () => {
    // ⚠ The tablet test must run before the mobile test: some tablet UAs also
    // carry "Mobile", so a mobile-first ladder files every tablet as a phone.
    it('classifies an iPad as a tablet, not a phone', () => {
      expect(parseUserAgent(UA.safariIpad).device).toBe('تابلت');
    });
    it('classifies an iPhone as mobile', () => {
      expect(parseUserAgent(UA.safariIphone).device).toBe('موبايل');
    });
    it('classifies an Android phone as mobile', () => {
      expect(parseUserAgent(UA.chromeAndroid).device).toBe('موبايل');
    });
    it('defaults to desktop', () => {
      expect(parseUserAgent(UA.chromeWin).device).toBe('كمبيوتر');
    });
  });

  describe('os', () => {
    it('detects Windows', () => expect(parseUserAgent(UA.chromeWin).os).toBe('Windows'));
    it('detects Android', () => expect(parseUserAgent(UA.chromeAndroid).os).toBe('Android'));
    it('detects iOS', () => expect(parseUserAgent(UA.safariIphone).os).toBe('iOS'));
    it('detects macOS', () => expect(parseUserAgent(UA.safariMac).os).toBe('macOS'));
    it('detects Linux', () => expect(parseUserAgent(UA.firefoxLinux).os).toBe('Linux'));
    // ⚠ Android UAs also contain "Linux" — Android must be tested first, or every
    // phone in the log is reported as a Linux desktop.
    it('does not report an Android phone as Linux', () => {
      expect(parseUserAgent(UA.chromeAndroid).os).not.toBe('Linux');
    });
  });

  describe('a missing User-Agent must never throw', () => {
    // This runs on the failed-login path. An exception here would turn a wrong
    // password into a 500 — and would do it for exactly the malformed clients a
    // brute-force script sends.
    it.each([
      ['empty', ''],
      ['undefined', undefined as unknown as string],
      ['null', null as unknown as string],
    ])('handles a %s UA', (_name, ua) => {
      expect(() => parseUserAgent(ua)).not.toThrow();
      const p = parseUserAgent(ua);
      expect(p.browser).toBe('متصفح');
      expect(p.os).toBe('');
    });

    it('handles a carrier with no headers at all', () => {
      expect(() => buildClientContext(undefined)).not.toThrow();
      expect(buildClientContext(undefined)).toEqual({
        ipAddress: '',
        userAgent: '',
        device: 'كمبيوتر',
        browser: 'متصفح',
        os: '',
      });
    });
  });

  describe('extractIpFrom', () => {
    // ⚠ X-Forwarded-For is a chain `client, proxy1, proxy2`. Taking the LAST
    // entry reports our own nginx for every request, so every audit row would
    // carry the same address and the field would be worthless.
    it('takes the FIRST entry of an X-Forwarded-For chain', () => {
      expect(
        extractIpFrom({ headers: { 'x-forwarded-for': '197.55.1.9, 10.0.0.5, 172.18.0.3' } }),
      ).toBe('197.55.1.9');
    });
    it('falls back to x-real-ip', () => {
      expect(extractIpFrom({ headers: { 'x-real-ip': '197.55.1.9' } })).toBe('197.55.1.9');
    });
    it('strips the IPv4-mapped IPv6 prefix', () => {
      expect(extractIpFrom({ headers: { 'x-real-ip': '::ffff:197.55.1.9' } })).toBe('197.55.1.9');
      expect(extractIpFrom({ ip: '::ffff:127.0.0.1' })).toBe('127.0.0.1');
    });
    it('falls back to the direct socket address', () => {
      expect(extractIpFrom({ socket: { remoteAddress: '10.1.2.3' } })).toBe('10.1.2.3');
    });
    it('returns empty rather than throwing when nothing is available', () => {
      expect(extractIpFrom({})).toBe('');
    });
    it('tolerates a header delivered as an array', () => {
      expect(extractIpFrom({ headers: { 'x-forwarded-for': ['197.55.1.9, 10.0.0.5'] } })).toBe(
        '197.55.1.9',
      );
    });
  });

  describe('geo helpers', () => {
    it.each(['127.0.0.1', '::1', '192.168.1.7', '10.0.0.4', '172.18.0.3', ''])(
      'treats %s as private — no public lookup',
      (ip) => expect(isPrivateIp(ip)).toBe(true),
    );
    it('treats a public address as public', () => expect(isPrivateIp('197.55.1.9')).toBe(false));

    it('formats a label from city and country', () => {
      expect(formatGeoLabel({ city: 'القاهرة', region: 'Cairo', country: 'مصر' })).toBe(
        'القاهرة، مصر',
      );
    });
    it('omits the missing half rather than printing a stray separator', () => {
      expect(formatGeoLabel({ city: '', region: '', country: 'مصر' })).toBe('مصر');
    });
    it('returns empty for an unresolved lookup', () => {
      expect(formatGeoLabel(null)).toBe('');
    });
  });

  it('buildClientContext reads headers only — never the request body', () => {
    // A client that could name its own browser/IP could forge the very audit
    // trail it is being recorded in.
    const carrier = {
      headers: { 'user-agent': UA.edgeWin, 'x-forwarded-for': '197.55.1.9, 10.0.0.5' },
      body: { browser: 'Firefox', ipAddress: '1.1.1.1' },
    };
    expect(buildClientContext(carrier)).toEqual({
      ipAddress: '197.55.1.9',
      userAgent: UA.edgeWin,
      device: 'كمبيوتر',
      browser: 'Edge',
      os: 'Windows',
    });
  });
});
