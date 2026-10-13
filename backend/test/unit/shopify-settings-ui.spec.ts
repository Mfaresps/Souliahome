import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const script = readFileSync(resolve(__dirname, '../../../frontend/public/shopify-settings.js'), 'utf8');
function view(admin = true) {
  const elements: Record<string, any> = {};
  for (const id of ['stg-shopify-card', 'stg-shopify-secret', 'stg-shopify-store', 'stg-shopify-token', 'stg-shopify-save', 'stg-shopify-test', 'shopify-connection-status']) {
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
});
