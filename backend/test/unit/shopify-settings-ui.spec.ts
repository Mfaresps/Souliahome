import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const script = readFileSync(resolve(__dirname, '../../../frontend/public/shopify-settings.js'), 'utf8');
function view(admin = true) {
  const elements: Record<string, any> = {};
  for (const id of ['stg-shopify-card', 'stg-shopify-secret', 'stg-shopify-store', 'stg-shopify-token', 'stg-shopify-client-id', 'stg-shopify-client-secret', 'stg-shopify-save', 'stg-shopify-test', 'shopify-connection-status']) {
    elements['#' + id] = { value: '', innerHTML: '', textContent: '', disabled: false, style: {} };
  }
  const api = jest.fn(async (url: string, _options: any = {}) => url === '/settings' ? { shopifyWebhookSecretSet: true, shopifyAccessTokenSet: true, shopifyStoreName: 'saved-store' } : { success: true });
  const context: any = { currentLang: 'en', settings: { shopifyStoreName: 'saved-store' },
    isAdmin: () => admin, qs: (id: string) => elements[id], esc: String, api, toast: jest.fn() };
  runInNewContext(script, context);
  return { context, elements, api };
}
describe('Shopify browser settings', () => {
  it('shows the Admin API as optional for new-order delivery and keeps password inputs empty', () => {
    const { context, elements } = view();
    context.renderShopifySettings();
    expect(elements['#stg-shopify-card'].innerHTML).toContain('Optional for new order webhooks');
    expect(elements['#stg-shopify-card'].innerHTML).toContain('type="password"');
    expect(elements['#stg-shopify-secret'].value).toBe('');
    expect(elements['#stg-shopify-token'].value).toBe('');
  });
  it('hides the card and does not save or check anything for staff', async () => {
    const { context, elements, api } = view(false);
    context.renderShopifySettings();
    await context.saveShopifySettings(); await context.testShopifySettings();
    expect(elements['#stg-shopify-card'].style.display).toBe('none');
    expect(api).not.toHaveBeenCalled();
  });
  it('omits empty passwords instead of overwriting stored secrets and clears supplied secrets after save', async () => {
    const { context, elements, api } = view();
    elements['#stg-shopify-secret'].value = 'new-signing-key';
    elements['#stg-shopify-store'].value = 'saved-store';
    await context.saveShopifySettings();
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ webhookSecret: 'new-signing-key', storeName: 'saved-store' });
    expect(elements['#stg-shopify-secret'].value).toBe('');
    expect(elements['#stg-shopify-save'].disabled).toBe(false);
  });
  it('preserves the entered value on failed save and does not announce success', async () => {
    const { context, elements, api } = view();
    api.mockRejectedValueOnce(new Error('failed'));
    elements['#stg-shopify-secret'].value = 'retry-signing-key';
    await context.saveShopifySettings();
    expect(elements['#stg-shopify-secret'].value).toBe('retry-signing-key');
    expect(context.toast).toHaveBeenCalledWith(expect.stringContaining('Unable to save'), true);
    expect(elements['#stg-shopify-save'].disabled).toBe(false);
  });
  it('separates a saved signing key from a rejected Admin API and asks for actual Shopify delivery testing', async () => {
    const { context, elements, api } = view();
    api.mockResolvedValueOnce({ webhookConfigured: true, adminApiConfigured: true, adminApiReachable: false } as any);
    await context.testShopifySettings();
    expect(elements['#shopify-connection-status'].textContent).toContain('Send test');
    expect(elements['#shopify-connection-status'].textContent).toContain('Admin API connection failed');
    expect(elements['#stg-shopify-test'].disabled).toBe(false);
  });
  it('uses the confirmed save response without a second request that could falsely report save failure', async () => {
    const { context, elements, api } = view();
    elements['#stg-shopify-secret'].value = 'new-signing-key';
    api.mockResolvedValueOnce({ success: true, settings: { shopifyWebhookSecretSet: true, shopifyStoreName: '' } } as any);
    await context.saveShopifySettings();
    expect(api).toHaveBeenCalledTimes(1);
    expect(context.settings.shopifyWebhookSecretSet).toBe(true);
    expect(elements['#stg-shopify-card'].innerHTML).toContain('signing key is configured');
    expect(elements['#stg-shopify-secret'].value).toBe('');
  });
  it('reports a successful save separately from a failed status refresh on older backends', async () => {
    const { context, elements, api } = view();
    elements['#stg-shopify-secret'].value = 'new-signing-key';
    api.mockResolvedValueOnce({ success: true } as any).mockRejectedValueOnce(new Error('refresh failed'));
    await context.saveShopifySettings();
    expect(context.toast).toHaveBeenCalledWith(expect.stringContaining('Saved, but'), true);
    expect(elements['#stg-shopify-secret'].value).toBe('');
  });
  it('explains an invalid store domain without repeating any supplied secret', async () => {
    const { context, elements, api } = view();
    elements['#stg-shopify-secret'].value = 'private-signing-key';
    api.mockRejectedValueOnce(new Error('Use the Shopify store name or its myshopify.com domain'));
    await context.saveShopifySettings();
    expect(elements['#shopify-connection-status'].textContent).toContain('myshopify.com');
    expect(elements['#shopify-connection-status'].textContent).toContain('leave the store and token fields blank');
    expect(elements['#shopify-connection-status'].textContent).not.toContain('private-signing-key');
    expect(elements['#stg-shopify-secret'].value).toBe('private-signing-key');
  });
  it('saves Dev Dashboard credentials once and clears the client secret after success', async () => {
    const { context, elements, api } = view();
    elements['#stg-shopify-client-id'].value = 'app-client-id';
    elements['#stg-shopify-client-secret'].value = 'private-app-secret';
    api.mockResolvedValueOnce({ success: true, settings: { shopifyClientId: 'app-client-id', shopifyClientSecretSet: true } } as any);
    await context.saveShopifySettings();
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ clientId: 'app-client-id', clientSecret: 'private-app-secret' });
    expect(elements['#stg-shopify-client-secret'].value).toBe('');
    expect(elements['#stg-shopify-card'].innerHTML).not.toContain('private-app-secret');
    expect(elements['#stg-shopify-card'].innerHTML).toContain('renews the token automatically');
  });
});
