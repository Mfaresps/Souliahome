import {
  checkLiveBackup, exportEnabled, exportUrl, isLoopbackMongoUri, liveSyncConfig, syncTokenMatches,
} from '../../src/settings/live-sync.util';

const KEY = 'k'.repeat(40);
const LOCAL = { MONGODB_URI: 'mongodb://127.0.0.1:27018/soulia?replicaSet=souliaDev' };

describe('live sync rules', () => {
  it('compares the key exactly and refuses short or missing keys', () => {
    expect(syncTokenMatches(KEY, KEY)).toBe(true);
    expect(syncTokenMatches(KEY, KEY + 'x')).toBe(false);
    expect(syncTokenMatches(KEY, undefined)).toBe(false);
    expect(syncTokenMatches('short', 'short')).toBe(false);
    expect(syncTokenMatches(undefined, KEY)).toBe(false);
  });

  it('exports only with a long key', () => {
    expect(exportEnabled({})).toBe(false);
    expect(exportEnabled({ LIVE_SYNC_EXPORT_TOKEN: 'abc' })).toBe(false);
    expect(exportEnabled({ LIVE_SYNC_EXPORT_TOKEN: KEY })).toBe(true);
  });

  it('treats only this machine as a local database', () => {
    expect(isLoopbackMongoUri('mongodb://localhost:27018/soulia')).toBe(true);
    expect(isLoopbackMongoUri('mongodb://127.0.0.1:27018,localhost:27019/soulia?replicaSet=x')).toBe(true);
    // live: Docker service name, with credentials
    expect(isLoopbackMongoUri('mongodb://admin:pw@mongodb:27017/soulia?authSource=admin')).toBe(false);
    expect(isLoopbackMongoUri('mongodb+srv://cluster.example.net/soulia')).toBe(false);
    expect(isLoopbackMongoUri('mongodb://localhost:27018,db.example.net:27017/soulia')).toBe(false);
    expect(isLoopbackMongoUri(undefined)).toBe(false);
  });

  it('enables the button only on a local copy with a URL and a long key', () => {
    expect(liveSyncConfig(LOCAL).reason).toBe('not-configured');
    const ok = liveSyncConfig({ ...LOCAL, LIVE_SYNC_URL: 'https://admin.example.com/', LIVE_SYNC_TOKEN: KEY });
    expect(ok).toMatchObject({ enabled: true, url: 'https://admin.example.com', source: 'admin.example.com' });
  });

  it('never lets the live server import over itself', () => {
    const live = {
      MONGODB_URI: 'mongodb://admin:pw@mongodb:27017/soulia?authSource=admin',
      LIVE_SYNC_URL: 'https://admin.example.com', LIVE_SYNC_TOKEN: KEY,
    };
    expect(liveSyncConfig(live)).toMatchObject({ enabled: false, reason: 'not-local-db' });
    expect(liveSyncConfig({ ...LOCAL, LIVE_SYNC_URL: 'https://a.example.com', LIVE_SYNC_TOKEN: KEY, LIVE_SYNC_EXPORT_TOKEN: KEY }))
      .toMatchObject({ enabled: false, reason: 'exporter' });
  });

  it('requires https except to this machine, and a long key', () => {
    expect(liveSyncConfig({ ...LOCAL, LIVE_SYNC_URL: 'http://admin.example.com', LIVE_SYNC_TOKEN: KEY }).reason).toBe('https-required');
    expect(liveSyncConfig({ ...LOCAL, LIVE_SYNC_URL: 'http://localhost:8080', LIVE_SYNC_TOKEN: KEY }).enabled).toBe(true);
    expect(liveSyncConfig({ ...LOCAL, LIVE_SYNC_URL: 'https://a.example.com', LIVE_SYNC_TOKEN: 'short' }).reason).toBe('weak-token');
  });

  it('builds the export URL with or without /api', () => {
    expect(exportUrl('https://a.example.com')).toBe('https://a.example.com/api/settings/sync-export');
    expect(exportUrl('https://a.example.com/api')).toBe('https://a.example.com/api/settings/sync-export');
  });

  it('refuses an empty, broken or wrong-format copy', () => {
    const good = { formatVersion: 2, data: { transactions: [{}, {}], users: [{}], products: [] } };
    expect(checkLiveBackup(good)).toEqual({ documents: 3, transactions: 2 });
    expect(() => checkLiveBackup({ formatVersion: 1, data: good.data })).toThrow();
    expect(() => checkLiveBackup({ formatVersion: 2, data: { transactions: [], users: [{}] } })).toThrow(/فارغة/);
    expect(() => checkLiveBackup({ formatVersion: 2, data: { transactions: [{}], users: [] } })).toThrow(/فارغة/);
    expect(() => checkLiveBackup({ formatVersion: 2, data: { transactions: 'x', users: [{}] } })).toThrow();
    expect(() => checkLiveBackup(null)).toThrow();
  });
});
