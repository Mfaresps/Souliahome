import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import puppeteer, { ElementHandle } from 'puppeteer';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { trackingMongo } from '../helpers/tracking-mongo';
import { SettingsSchema } from '../../src/settings/schemas/settings.schema';
import { BrandLogoSchema } from '../../src/settings/schemas/brand-logo.schema';
import { SettingsService } from '../../src/settings/settings.service';
import { BrandingService } from '../../src/settings/branding.service';
import { BrandingController } from '../../src/settings/branding.controller';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { PresenceGateway } from '../../src/auth/presence.gateway';

describe('Persistent branding library and public appearance', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>, service: BrandingService, app: INestApplication, base: string;
  let logos: any, settings: any, settingsService: SettingsService, first: any, second: any;
  const presence = { emitEvent: jest.fn() };
  const headers = { 'x-test-role': 'admin' };
  beforeAll(async () => {
    mongo = await trackingMongo(false);
    settings = mongo.connection.model('Settings', SettingsSchema);
    logos = mongo.connection.model('BrandLogo', BrandLogoSchema);
    await Promise.all([settings.createCollection(), logos.createCollection()]);
    await logos.init();
    await settings.create({ vaultPass: 'fixture-vault', vaultCash: 123, shopifyWebhookSecret: 'fixture-webhook' });
    settingsService = new SettingsService(settings, mongo.connection);
    service = new BrandingService(logos, settings, settingsService);
    const module = await Test.createTestingModule({ controllers: [BrandingController], providers: [
      { provide: BrandingService, useValue: service }, { provide: PresenceGateway, useValue: presence }
    ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
      const req = context.switchToHttp().getRequest();
      const role = req.headers['x-test-role'];
      if (!role) throw new UnauthorizedException();
      req.user = { role }; return true;
    } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1'); base = (await app.getUrl()) + '/api/branding';
  }, 30000);
  afterAll(async () => { await app?.close(); await mongo?.close(); });

  async function upload(name: string) {
    const image = await sharp({ create: { width: 320, height: 120, channels: 4, background: '#12845a' } }).png().toBuffer();
    const form = new FormData(); form.append('name', name); form.append('file', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'logo.png');
    const response = await fetch(base + '/logos', { method: 'POST', headers, body: form });
    expect(response.status).toBe(201);
    return response.json();
  }

  it('saves named images permanently and keeps every previous upload across service instances', async () => {
    first = await upload('شعار البداية'); second = await upload('Header logo');
    const reopened = new BrandingService(logos, settings, settingsService);
    const library = await reopened.library();
    expect(library.logos.map(logo => logo.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(library.logos.find(logo => logo.id === first.id)?.name).toBe('شعار البداية');
    expect(library.selection).toEqual({ splash: null, header: null, tab: null });
    expect(JSON.stringify(library)).not.toContain('imageBase64');
    expect((await sharp(await reopened.image(first.id, false)).metadata()).format).toBe('webp');
  });

  it('selects each placement independently and exposes only the chosen artwork before login', async () => {
    const response = await fetch(base + '/selection', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ splash: first.id, header: second.id, tab: first.id }) });
    expect(response.status).toBe(200);
    const snapshot = await (await fetch(base)).json();
    expect(snapshot.selection).toEqual({ splash: first.id, header: second.id, tab: first.id });
    expect(snapshot.logos).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toMatch(/imageBase64|iconBase64|vaultPass|webhook/i);
    expect(presence.emitEvent).toHaveBeenCalledWith('branding:changed', expect.objectContaining({ selection: snapshot.selection }));
    const icon = await fetch(base + '/logos/' + first.id + '/icon');
    expect(icon.headers.get('content-type')).toContain('image/png');
    expect(icon.headers.get('x-content-type-options')).toBe('nosniff');
    expect(icon.headers.get('cache-control')).toContain('immutable');
    const meta = await sharp(Buffer.from(await icon.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([64, 64]);
    const current = await settings.findOne().lean();
    expect(current.vaultCash).toBe(123); expect(current.shopifyWebhookSecret).toBe('fixture-webhook');
  });

  it('rejects missing logos without changing the saved choices', async () => {
    const before = await service.snapshot();
    await expect(service.select({ splash: randomUUID(), header: null, tab: null })).rejects.toThrow();
    await expect(service.select({ splash: undefined, header: null, tab: null } as any)).rejects.toThrow();
    expect((await service.snapshot()).selection).toEqual(before.selection);
  });

  it('renames and reuses an old logo, then resets to the original without deleting anything', async () => {
    const imageBefore = await service.image(first.id, false);
    await service.rename(first.id, 'الشعار القديم');
    expect((await service.library()).logos.find(logo => logo.id === first.id)?.name).toBe('الشعار القديم');
    await service.select({ splash: second.id, header: first.id, tab: second.id });
    await service.select({ splash: first.id, header: first.id, tab: first.id });
    await service.select({ splash: null, header: null, tab: null });
    expect((await service.snapshot()).selection).toEqual({ splash: null, header: null, tab: null });
    expect(await logos.countDocuments()).toBe(2);
    expect((await service.image(first.id, false)).equals(imageBefore)).toBe(true);
  });

  it('restricts the library and all changes to administrators, with no storage for rejected uploads', async () => {
    expect((await fetch(base + '/library')).status).toBe(401);
    expect((await fetch(base + '/library', { headers: { 'x-test-role': 'staff' } })).status).toBe(403);
    expect((await fetch(base + '/selection', { method: 'PUT', headers: { 'x-test-role': 'staff', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    await expect(service.upload(undefined, 'name')).rejects.toThrow();
    await expect(service.rename(first.id, '   ')).rejects.toThrow();
    const form = new FormData(); form.append('name', 'Invalid'); form.append('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'fake.png');
    expect((await fetch(base + '/logos', { method: 'POST', headers, body: form })).status).toBe(400);
    expect(await logos.countDocuments()).toBe(2);
    expect((await fetch(base + '/logos/' + randomUUID() + '/image')).status).toBe(404);
  });

  it('falls back to original artwork for dangling references from older or incomplete restores', async () => {
    await settings.updateOne({}, { $set: { branding: { splash: randomUUID(), header: null, tab: null } } });
    expect((await service.snapshot()).selection.splash).toBeNull();
  });

  it('uploads, names, previews, applies and reuses images through the real UI and HTTP API', async () => {
    const browser = await puppeteer.launch({ headless: true });
    const root = resolve(__dirname, '../../../frontend/public');
    const html = readFileSync(resolve(root, 'index.html'), 'utf8');
    const start = html.indexOf('<div class="page" id="page-settings">');
    const end = html.indexOf('</div><!-- /page-settings -->', start) + '</div><!-- /page-settings -->'.length;
    const navigation = html.slice(html.indexOf('const STG_INNER_PAGES ='), html.indexOf('/* Show/hide promotions placeholder'));
    const artwork = resolve(__dirname, '../../../artifacts'); mkdirSync(artwork, { recursive: true });
    const fixture = resolve(artwork, 'branding-upload-fixture.svg');
    writeFileSync(fixture, '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><rect x="0" y="10" width="100" height="100" rx="20" fill="#1d9b66"/><path d="m24 60 18 18 34-40" fill="none" stroke="white" stroke-width="12"/><rect x="125" y="35" width="200" height="18" rx="8" fill="#1d9b66"/><rect x="125" y="68" width="140" height="15" rx="7" fill="#e8b34c"/></svg>');
    try {
      const page = await browser.newPage(); const errors: string[] = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/soulia-logo.svg' || pathname === '/favicon.png') return void request.respond({ status: 200,
          contentType: pathname.endsWith('svg') ? 'image/svg+xml' : 'image/png', body: readFileSync(resolve(root, pathname.slice(1))) });
        void request.continue();
      });
      await page.goto(base);
      await page.setContent('<html dir="rtl"><head><meta charset="utf-8"><link rel="icon" href="/favicon.png"></head><body><div id="splash-screen" style="display:none"><img class="splash-logo" src="/soulia-logo.svg"></div><div id="header" style="display:none"><div class="logo"><img src="/soulia-logo.svg"></div></div><div id="main">' + html.slice(start, end) + '</div></body></html>');
      await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)![1] });
      for (const file of ['navigation-shell.css', 'settings-responsive.css', 'branding.css']) await page.addStyleTag({ path: resolve(root, file) });
      await page.evaluate(() => {
        const w = window as any; w.qs = (s: string) => document.querySelector(s); w.qsa = (s: string) => Array.from(document.querySelectorAll(s));
        w.isAdmin = () => true; w.currentLang = 'ar'; w.settings = {}; w.t = (key: string) => key;
        w.api = async (path: string, options: any = {}) => {
          const headers: any = { 'x-test-role': 'admin' };
          if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
          const response = await fetch('/api' + path, { ...options, headers }); const value = await response.json();
          if (!response.ok) throw new Error(value.message); return value;
        };
        document.querySelector('#page-settings')!.classList.add('active');
      });
      await page.addScriptTag({ content: navigation });
      await page.addScriptTag({ path: resolve(root, 'branding.js') });
      await page.evaluate(() => { const w = window as any; w.SouliaBranding.renderSettings(); w.stgOpenInnerPage('appearance', document.querySelector('[data-inner-tab="appearance"]')); });
      await page.waitForFunction(() => (document.querySelector('#brand-upload-form button') as HTMLButtonElement)?.disabled === false);
      await page.type('#brand-upload-name', 'شعار الربيع');
      await (await page.$('#brand-upload-file') as ElementHandle<HTMLInputElement>).uploadFile(fixture);
      await page.click('#brand-upload-form button');
      await page.waitForFunction(() => document.querySelectorAll('.brand-library-item').length === 3);
      const uploaded = (await service.library()).logos.find(logo => logo.name === 'شعار الربيع')!;
      expect(uploaded).toBeDefined();
      expect((await service.snapshot()).selection.splash).toBeNull(); // Uploading does not silently replace active artwork.
      for (const slot of ['splash', 'header', 'tab']) await page.select('#brand-select-' + slot, uploaded.id);
      expect(await page.$eval('#brand-preview-tab', el => el.getAttribute('src'))).toContain(uploaded.id + '/icon');
      await page.click('#brand-save-selection');
      await page.waitForFunction(id => document.querySelector('#header .logo img')?.getAttribute('src')?.includes(id), {}, uploaded.id);
      expect((await service.snapshot()).selection).toEqual({ splash: uploaded.id, header: uploaded.id, tab: uploaded.id });
      expect(await page.$eval('link[rel=icon]', el => el.getAttribute('href'))).toContain(uploaded.id + '/icon');
      expect(await page.$eval('#splash-screen img', el => el.classList.contains('soulia-custom-brand'))).toBe(true);
      await page.$eval('#brand-name-' + uploaded.id, el => { (el as HTMLInputElement).value = ''; });
      await page.type('#brand-name-' + uploaded.id, 'شعار محفوظ');
      await page.click('[data-brand-rename="' + uploaded.id + '"]');
      await page.waitForFunction(() => Array.from(document.querySelectorAll('#brand-select-header option')).some(el => el.textContent === 'شعار محفوظ'));
      expect((await service.library()).logos).toHaveLength(3);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewport({ width, height: 1000 });
        for (const dir of ['rtl', 'ltr']) {
          await page.evaluate(dir => { document.documentElement.dir = dir; }, dir);
          await new Promise(done => setTimeout(done, 350));
          const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('#stg-branding-card,.brand-slots,.brand-slot,.brand-upload-fields,.brand-upload-fields input,.brand-library-item'))
            .filter(el => el.getClientRects().length).filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(el => el.className));
          expect(overflow).toEqual([]);
          const switchHeights = await page.$$eval('.stg-appearance-toggles input[type=checkbox]', els => els.map(el => el.getBoundingClientRect().height));
          expect(switchHeights.every(height => height <= 22)).toBe(true);
        }
      }
      await page.setViewport({ width: 1440, height: 1100 }); await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
      await new Promise(done => setTimeout(done, 400));
      await page.screenshot({ path: resolve(artwork, 'appearance-branding-desktop.png'), fullPage: true });
      await page.setViewport({ width: 390, height: 844 }); await new Promise(done => setTimeout(done, 400));
      await page.screenshot({ path: resolve(artwork, 'appearance-branding-mobile.png'), fullPage: true });
      const startup = await browser.newPage(); await startup.goto(base);
      await startup.setContent('<html><head><link rel="icon" href="/favicon.png"></head><body><div id="splash-screen"><img class="splash-logo" src="/soulia-logo.svg"></div><div id="header"><div class="logo"><img src="/soulia-logo.svg"></div></div></body></html>');
      await startup.addScriptTag({ path: resolve(root, 'branding.js') });
      await startup.waitForFunction(id => document.querySelector('#splash-screen img')?.getAttribute('src')?.includes(id), {}, uploaded.id);
      expect(await startup.$eval('link[rel=icon]', el => el.getAttribute('href'))).toContain(uploaded.id + '/icon');
      await startup.evaluate(() => {
        const sidebar = document.createElement('a'); sidebar.className = 'shell-brand-home';
        sidebar.innerHTML = '<img src="/soulia-logo.svg">'; document.body.append(sidebar);
      });
      await startup.waitForFunction(id => document.querySelector('.shell-brand-home img')?.getAttribute('src')?.includes(id), {}, uploaded.id);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 60000);
});
