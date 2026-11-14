import { createHash, timingSafeEqual } from 'crypto';

/**
 * Live → local sync rules. Pure, so they can be tested without a server.
 *
 * Two roles, never on the same machine:
 *  - EXPORTER (the live server): `LIVE_SYNC_EXPORT_TOKEN` set → `GET /api/settings/sync-export`
 *    answers a request carrying that token in `x-soulia-sync-token`. Unset → the route is 404.
 *  - IMPORTER (the local copy): `LIVE_SYNC_URL` + `LIVE_SYNC_TOKEN` set, and its own database
 *    on this machine (loopback) → the «مزامنة من النسخة الحية» button works.
 *
 * ⚠ The importer check on MONGODB_URI is what keeps the live server from ever wiping itself:
 * live talks to Mongo through the Docker service name (`mongodb`), never 127.0.0.1.
 */
export const LIVE_SYNC_HEADER = 'x-soulia-sync-token';
export const LIVE_SYNC_MIN_TOKEN = 32;

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time compare (on digests, so unequal lengths do not leak through timing). */
export function syncTokenMatches(expected: string | undefined, given: unknown): boolean {
  if (!expected || expected.length < LIVE_SYNC_MIN_TOKEN) return false;
  if (typeof given !== 'string' || !given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}

export function exportEnabled(env: NodeJS.ProcessEnv): boolean {
  return String(env.LIVE_SYNC_EXPORT_TOKEN || '').trim().length >= LIVE_SYNC_MIN_TOKEN;
}

export function isLoopbackMongoUri(uri: string | undefined): boolean {
  // mongodb+srv is always a remote cluster. new URL() cannot be used: it rejects the
  // multi-host form a replica set uses ("localhost:27018,localhost:27019").
  const m = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(String(uri || '').trim());
  if (!m) return false;
  return m[1].split(',').every(h => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h.trim()));
}

export interface LiveSyncConfig {
  enabled: boolean;
  /** Why the button is off, in words the settings card can show. */
  reason?: string;
  url?: string;
  token?: string;
  /** Host only — never the token. Safe to send to the browser. */
  source?: string;
}

export function liveSyncConfig(env: NodeJS.ProcessEnv): LiveSyncConfig {
  const rawUrl = String(env.LIVE_SYNC_URL || '').trim();
  const token = String(env.LIVE_SYNC_TOKEN || '').trim();
  if (!rawUrl || !token) {
    return { enabled: false, reason: 'not-configured' };
  }
  if (exportEnabled(env)) {
    // A server that exports is a live server; it must never import over itself.
    return { enabled: false, reason: 'exporter' };
  }
  if (!isLoopbackMongoUri(env.MONGODB_URI)) {
    return { enabled: false, reason: 'not-local-db' };
  }
  if (token.length < LIVE_SYNC_MIN_TOKEN) {
    return { enabled: false, reason: 'weak-token' };
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { enabled: false, reason: 'bad-url' }; }
  const local = /^(localhost|127\.0\.0\.1)$/i.test(url.hostname);
  // The token and the whole database travel on this connection: plain http only to this machine.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { enabled: false, reason: 'https-required' };
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return { enabled: true, url: base, token, source: url.host };
}

/** The export endpoint on the live server, given LIVE_SYNC_URL (with or without a trailing /api). */
export function exportUrl(base: string): string {
  return /\/api$/i.test(base) ? `${base}/settings/sync-export` : `${base}/api/settings/sync-export`;
}

/**
 * A downloaded copy is accepted only if it is a complete backup that carries real data.
 * An empty or truncated reply must never replace the local database.
 */
export function checkLiveBackup(backup: any): { documents: number; transactions: number } {
  if (!backup || typeof backup !== 'object' || backup.formatVersion !== 2) {
    throw new Error('النسخة القادمة من النظام الحي ليست بالصيغة المتوقعة');
  }
  if (!backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) {
    throw new Error('النسخة القادمة من النظام الحي لا تحتوي على بيانات');
  }
  let documents = 0;
  for (const rows of Object.values(backup.data)) {
    if (!Array.isArray(rows)) throw new Error('النسخة القادمة من النظام الحي تالفة');
    documents += rows.length;
  }
  const transactions = Array.isArray(backup.data.transactions) ? backup.data.transactions.length : 0;
  const users = Array.isArray(backup.data.users) ? backup.data.users.length : 0;
  if (!transactions || !users) {
    throw new Error('النسخة القادمة من النظام الحي فارغة — لم يتم استبدال البيانات المحلية');
  }
  return { documents, transactions };
}
