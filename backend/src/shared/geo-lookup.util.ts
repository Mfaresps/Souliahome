import * as http from 'http';
import type { GeoLocation } from './client-context.util';

/**
 * IP → city/country, via ip-api.com.
 *
 * ⚠ Shared cache with `PresenceGateway`: the live-sessions panel and the audit
 * log resolve the same office IPs over and over, and the free tier is rate
 * limited. One module-level cache means the second lookup of an IP is free.
 *
 * ⚠ NEVER let this reject or throw. It is called from the failed-login path,
 * where the request is already failing for its own reason; a geo timeout must
 * not become the error the user sees. Every branch resolves.
 */

const geoCache = new Map<string, GeoLocation | null>();

/** RFC1918 / loopback — no public geo exists, and asking leaks nothing useful. */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    ip.startsWith('172.')
  );
}

export function fetchGeo(ip: string): Promise<GeoLocation | null> {
  return new Promise((resolve) => {
    if (isPrivateIp(ip)) {
      resolve({ city: 'محلي', region: '', country: 'شبكة داخلية' });
      return;
    }
    if (geoCache.has(ip)) {
      resolve(geoCache.get(ip) ?? null);
      return;
    }
    const url = `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon,isp&lang=ar`;
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.status === 'success') {
            const loc: GeoLocation = {
              city: j.city || '',
              region: j.regionName || '',
              country: j.country || '',
              lat: j.lat,
              lon: j.lon,
              isp: j.isp || '',
            };
            geoCache.set(ip, loc);
            resolve(loc);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** One-line human label — `القاهرة، مصر`. Empty when nothing is known. */
export function formatGeoLabel(loc: GeoLocation | null | undefined): string {
  if (!loc) return '';
  return [loc.city, loc.country].filter(Boolean).join('، ');
}
