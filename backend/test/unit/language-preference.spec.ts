import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const source = html.slice(html.indexOf("const LANG_PREF_KEY ="), html.indexOf('/* ═══════════════ USER HUB'));
function fixture(admin = true, storageFails = false, store = new Map<string, string>()) {
  const context: any = {
    currentLang: 'ar', settings: { lang: 'ar', langEnabled: true },
    isAdmin: () => admin, qs: () => null, t: (key: string) => key,
    toast: jest.fn(), applyLang: jest.fn(), syncLangButton: jest.fn(),
    api: jest.fn(async () => ({})),
    localStorage: {
      getItem: (key: string) => { if (storageFails) throw Error('denied'); return store.get(key) || null; },
      setItem: (key: string, value: string) => { if (storageFails) throw Error('denied'); store.set(key, value); },
      removeItem: (key: string) => store.delete(key),
    },
  };
  runInNewContext(source, context);
  return { context, store };
}

describe('Language preference stability', () => {
  it.each([['ar', 'en'], ['en', 'ar']])('keeps admin choice %s → %s after stale policy and reload', (old, next) => {
    const { context: c, store } = fixture();
    store.set('soulia_lang_pref', old);
    c.currentLang = old;
    c.changeLang(next);
    c.settings.lang = old;
    c.handleLangPolicy({ force: true });
    expect(c.currentLang).toBe(next);
    const reload = fixture(true, false, store).context;
    reload.bootLangFromCache();
    expect(reload.currentLang).toBe(next);
    expect(reload.resolveLang()).toBe(next);
  });

  it('serializes rapid admin changes and ignores old echoes while saving', async () => {
    const { context: c } = fixture();
    let release!: () => void;
    c.api.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    c.changeLang('en');
    c.changeLang('ar');
    await Promise.resolve();
    expect(c.api).toHaveBeenCalledTimes(1);
    c.settings.lang = 'en';
    c.handleLangPolicy();
    expect(c.currentLang).toBe('ar');
    release();
    // Await the actual final queued save, without timers.
    await runInNewContext('_langSaveQueue', c);
    expect(c.api.mock.calls.map((call: any[]) => JSON.parse(call[1].body).lang)).toEqual(['en', 'ar']);
  });

  it('retains a session choice when browser storage is unavailable', () => {
    const { context: c } = fixture(false, true);
    c.changeLang('en');
    c.handleLangPolicy();
    expect(c.currentLang).toBe('en');
    expect(c.api).not.toHaveBeenCalled();
  });

  it('still enforces the system language for staff', () => {
    const { context: c } = fixture(false);
    c.changeLang('en');
    c.settings.langEnabled = false;
    c.clearLangPref();
    c.handleLangPolicy();
    c.changeLang('en');
    expect(c.currentLang).toBe('ar');
    expect(c.api).not.toHaveBeenCalled();
  });

  it('applies forced admin language over an old device preference and recovers after save failure', async () => {
    const { context: c, store } = fixture();
    store.set('soulia_lang_pref', 'ar');
    c.api.mockRejectedValueOnce(Error('offline'));
    c.setForcedLang('en');
    await runInNewContext('_langSaveQueue', c);
    c.handleLangPolicy();
    expect(c.currentLang).toBe('en');
    expect(c.toast).toHaveBeenCalledWith('langPolicySaveFailed', true);
    c.changeLang('ar');
    await runInNewContext('_langSaveQueue', c);
    expect(c.api).toHaveBeenCalledTimes(2);
  });
});
