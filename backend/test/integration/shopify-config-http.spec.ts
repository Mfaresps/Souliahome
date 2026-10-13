import mongoose, { Connection } from 'mongoose';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHmac } from 'crypto';
import { SettingsController } from '../../src/settings/settings.controller';
import { SettingsService } from '../../src/settings/settings.service';
import { Settings, SettingsSchema } from '../../src/settings/schemas/settings.schema';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { UsersService } from '../../src/users/users.service';
import { SecurityAuditService } from '../../src/security-audit/security-audit.service';
import { PresenceGateway } from '../../src/auth/presence.gateway';
import { ShopifyService } from '../../src/shopify/shopify.service';

describe('Shopify config HTTP save with real MongoDB', () => {
  let connection: Connection;
  let app: INestApplication;
  let service: SettingsService;
  let url: string;
  const dbName = `soulia_test_shopify_config_${process.pid}_${Date.now()}`;
  beforeAll(async () => {
    connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
    const model = connection.model(Settings.name, SettingsSchema);
    service = new SettingsService(model as any, connection);
    const module = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SettingsService, useValue: service },
        { provide: UsersService, useValue: {} },
        { provide: SecurityAuditService, useValue: {} },
        { provide: PresenceGateway, useValue: {} },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: any) => {
      const req = context.switchToHttp().getRequest();
      const role = req.headers['x-test-role'];
      if (!role) return false;
      req.user = { role }; return true;
    } }).overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()) + '/api/settings/shopify-config';
  }, 15000);
  afterAll(async () => {
    await app?.close();
    if (connection) {
      if (!/^soulia_test_shopify_config_\d+_\d+$/.test(connection.name)) throw new Error('Unexpected test database');
      await connection.dropDatabase(); await connection.close();
    }
  });
  function save(body: any, role = 'admin') {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Role': role }, body: JSON.stringify(body) });
  }
  it('saves the signing key alone through the production validation pipe and verifies it after restart', async () => {
    const key = 'test-only-persistent-signing-key';
    const res = await save({ webhookSecret: key });
    expect(res.status).toBe(201);
    const reply = await res.json();
    expect(reply).toMatchObject({ success: true, settings: { shopifyWebhookSecretSet: true } });
    expect(JSON.stringify(reply)).not.toContain(key);
    const restarted: any = Object.create(ShopifyService.prototype);
    restarted.settingsService = new SettingsService(connection.model(Settings.name), connection);
    const raw = Buffer.from('{}');
    expect(await restarted.verifyWebhookRequest(raw, createHmac('sha256', key).update(raw).digest('base64'))).toBe(true);
  });
  it('accepts the pictured myshopify domain with an empty optional API token', async () => {
    const res = await save({ webhookSecret: 'another-test-key', storeName: 'soulia-2.myshopify.com', accessToken: '' });
    expect(res.status).toBe(201);
    expect((await res.json()).settings).toMatchObject({ shopifyWebhookSecretSet: true, shopifyStoreName: 'soulia-2' });
  });
  it('rejects a custom storefront domain with a useful validation reason and preserves the saved key', async () => {
    const old = await service.getShopifyConfig();
    const res = await save({ webhookSecret: 'must-not-be-written', storeName: 'soulia.store' });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Use the Shopify store name or its myshopify.com domain');
    expect((await service.getShopifyConfig()).webhookSecret).toBe(old.webhookSecret);
  });
  it('denies staff credential writes', async () => {
    const old = await service.getShopifyConfig();
    expect((await save({ webhookSecret: 'unauthorized-key' }, 'staff')).status).toBe(403);
    expect((await service.getShopifyConfig()).webhookSecret).toBe(old.webhookSecret);
  });
  it('stores app credentials in MongoDB and returns configured flags without exposing the secret', async () => {
    const res = await save({ clientId: 'test-app-id', clientSecret: 'private-test-app-secret' });
    expect(res.status).toBe(201);
    const reply = await res.json();
    expect(reply.settings).toMatchObject({ shopifyClientId: 'test-app-id', shopifyClientSecretSet: true });
    expect(JSON.stringify(reply)).not.toContain('private-test-app-secret');
    const restarted = new SettingsService(connection.model(Settings.name), connection);
    expect(await restarted.getShopifyConfig()).toMatchObject({ clientId: 'test-app-id', clientSecret: 'private-test-app-secret' });
    expect((await restarted.getSettingsSafe()).shopifyClientSecret).toBeUndefined();
  });
});
