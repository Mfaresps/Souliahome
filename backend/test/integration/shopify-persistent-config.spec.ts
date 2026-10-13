import { createHmac } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { SettingsService } from '../../src/settings/settings.service';
import { ShopifyService } from '../../src/shopify/shopify.service';
import { ShopifyAdminService } from '../../src/shopify/shopify-admin.service';
import { SettingsController } from '../../src/settings/settings.controller';
import { ShopifyController } from '../../src/shopify/shopify.controller';
import { RolesGuard } from '../../src/core/guards/roles.guard';
import { Reflector } from '@nestjs/core';

describe('Persistent Shopify configuration', () => {
  const keys = ['SHOPIFY_WEBHOOK_SECRET', 'SHOPIFY_STORE_NAME', 'SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'];
  const originals = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let stored: Record<string, string>;
  let model: any;
  function settingsService() {
    const service = new SettingsService(model, {} as any);
    service.getSettings = jest.fn().mockResolvedValue({ _id: 'settings' });
    return service;
  }
  beforeEach(() => {
    keys.forEach(key => delete process.env[key]);
    stored = {};
    model = {
      findOne: () => ({ select: () => ({ lean: async () => ({ ...stored }) }) }),
      findByIdAndUpdate: jest.fn((_id: string, update: any) => ({ exec: async () => { Object.assign(stored, update.$set); } })),
    };
  });
  afterEach(() => {
    for (const key of keys) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  });
  it('accepts a saved signing key after service restart without any deployment environment or Admin API token', async () => {
    await settingsService().saveShopifyConfig({ webhookSecret: 'persisted-signing-key' });
    const restarted: any = Object.create(ShopifyService.prototype);
    restarted.settingsService = settingsService();
    const raw = Buffer.from('{ "id": 111 }');
    const signature = createHmac('sha256', 'persisted-signing-key').update(raw).digest('base64');
    expect(await restarted.verifyWebhookRequest(raw, signature)).toBe(true);
    expect(await restarted.verifyWebhookRequest(Buffer.from('{"id":111}'), signature)).toBe(false);
    expect(await restarted.verifyWebhookRequest(raw, 'incorrect')).toBe(false);
    expect((await restarted.settingsService.getShopifyConfig()).accessToken).toBe('');
  });
  it('keeps existing secrets when saving other fields or submitting blank password fields', async () => {
    const service = settingsService();
    await service.saveShopifyConfig({ webhookSecret: 'persisted-signing-key', storeName: 'https://My-Store.myshopify.com/', accessToken: 'valid-test-token' });
    await service.saveShopifyConfig({ storeName: 'my-store', webhookSecret: ' ', accessToken: '' });
    expect(await settingsService().getShopifyConfig()).toMatchObject({ webhookSecret: 'persisted-signing-key', storeName: 'my-store', accessToken: 'valid-test-token' });
    expect(model.findByIdAndUpdate.mock.calls[1][1].$set).toEqual({ shopifyStoreName: 'my-store' });
  });
  it('uses saved values ahead of old deployment environment and lets the Admin API see changes immediately', async () => {
    process.env.SHOPIFY_WEBHOOK_SECRET = 'old-environment-key';
    process.env.SHOPIFY_STORE_NAME = 'old-store';
    process.env.SHOPIFY_ACCESS_TOKEN = 'old-token';
    const service = settingsService();
    await service.saveShopifyConfig({ webhookSecret: 'saved-key', storeName: 'saved-store', accessToken: 'saved-token' });
    const admin = new ShopifyAdminService(service);
    expect(await admin.isConfigured()).toBe(true);
    expect(await (admin as any).getConfig()).toEqual({ storeName: 'saved-store', accessToken: 'saved-token' });
    await service.saveShopifyConfig({ accessToken: 'replacement-token' });
    expect((await (admin as any).getConfig()).accessToken).toBe('replacement-token');
    expect((await service.getShopifyConfig()).webhookSecret).toBe('saved-key');
  });
  it('keeps environment support for existing installations', async () => {
    process.env.SHOPIFY_WEBHOOK_SECRET = 'environment-key';
    expect((await settingsService().getShopifyConfig()).webhookSecret).toBe('environment-key');
  });
  it('never returns secrets in settings responses or downloadable configuration backups', async () => {
    const service = settingsService();
    await service.saveShopifyConfig({ webhookSecret: 'private-signing-key', accessToken: 'private-api-token' });
    const safe = service.stripSensitive({ toObject: () => ({ ...stored }) } as any);
    expect(safe).toMatchObject({ shopifyWebhookSecretSet: true, shopifyAccessTokenSet: true });
    expect(safe.shopifyWebhookSecret).toBeUndefined();
    expect(safe.shopifyAccessToken).toBeUndefined();
    const backup = (service as any).backupConfiguration(stored);
    expect(backup.shopifyWebhookSecret).toBeUndefined();
    expect(backup.shopifyAccessToken).toBeUndefined();
  });
  it.each([{ storeName: 'attacker.example/path' }, {}, { accessToken: 'bad\r\nheader' }])('rejects invalid config without changing the stored credentials: %j', async input => {
    await expect(settingsService().saveShopifyConfig(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(stored).toEqual({});
  });
  it('reports webhook and Admin API readiness separately', async () => {
    await settingsService().saveShopifyConfig({ webhookSecret: 'persisted-signing-key' });
    const shopify: any = Object.create(ShopifyService.prototype);
    shopify.settingsService = settingsService();
    shopify.shopifyAdminService = { listOrders: jest.fn().mockResolvedValue({ success: false, error: 'private API response' }) };
    expect(await shopify.getConnectionStatus()).toEqual({ webhookConfigured: true, adminApiConfigured: false, adminApiReachable: null });
    expect(shopify.shopifyAdminService.listOrders).not.toHaveBeenCalled();
    await shopify.settingsService.saveShopifyConfig({ storeName: 'my-store', accessToken: 'expired-test-token' });
    expect(await shopify.getConnectionStatus()).toEqual({ webhookConfigured: true, adminApiConfigured: true, adminApiReachable: false });
  });
  it('restricts saving credentials and checking the integration to administrators', () => {
    const guard = new RolesGuard(new Reflector());
    for (const [controller, handler] of [
      [SettingsController, SettingsController.prototype.saveShopifyConfig],
      [ShopifyController, ShopifyController.prototype.connectionStatus],
    ]) {
      function context(role: string) {
        return { getClass: () => controller, getHandler: () => handler,
          switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) } as any;
      }
      expect(guard.canActivate(context('staff'))).toBe(false);
      expect(guard.canActivate(context('viewer'))).toBe(false);
      expect(guard.canActivate(context('admin'))).toBe(true);
    }
  });
  it('persists app credentials without returning the client secret or including it in downloadable backups', async () => {
    const service = settingsService();
    await service.saveShopifyConfig({ storeName: 'my-store', clientId: 'saved-client-id', clientSecret: 'private-client-secret' });
    await service.saveShopifyConfig({ clientId: 'saved-client-id', clientSecret: '' });
    expect(await settingsService().getShopifyConfig()).toMatchObject({ clientId: 'saved-client-id', clientSecret: 'private-client-secret' });
    const safe = service.stripSensitive({ toObject: () => ({ ...stored }) } as any);
    expect(safe.shopifyClientId).toBe('saved-client-id');
    expect(safe.shopifyClientSecretSet).toBe(true);
    expect(safe.shopifyClientSecret).toBeUndefined();
    expect((service as any).backupConfiguration(stored).shopifyClientSecret).toBeUndefined();
  });
});
