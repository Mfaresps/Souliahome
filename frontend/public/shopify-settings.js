/* Admin-only Shopify credentials; blank secret inputs keep the saved values. */
function _shopifySettingsText(ar, en) {
  return typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
}

function renderShopifySettings() {
  const card = qs('#stg-shopify-card');
  if (!card) return;
  card.style.display = isAdmin() ? '' : 'none';
  if (!isAdmin()) { card.innerHTML = ''; return; }
  const text = _shopifySettingsText;
  card.innerHTML = `
    <h3 class="stg-provider-heading"><span class="stg-provider-logo stg-provider-shopify" aria-hidden="true"><img src="/shopify-glyph-color-2026-65613845c170.svg" alt="" width="24" height="28"></span><span>Shopify</span></h3>
    <p class="text-xs text-muted">${esc(text('احفظ مفتاح الاستقبال مرة واحدة؛ يظل محفوظًا بعد تحديث البرنامج.', 'Save the signing key once. It stays saved after application updates.'))}</p>
    <p id="shopify-signing-status" role="status" class="text-xs">${esc(settings?.shopifyWebhookSecretSet
      ? text('مفتاح استقبال الأوردرات محفوظ.', 'Order webhook signing key is configured.')
      : text('استقبال الأوردرات متوقف: أدخل مفتاح Shopify الظاهر أسفل قائمة Webhooks.', 'Order webhooks are not configured. Enter the signing key shown below Shopify’s Webhooks list.'))}</p>
    <label for="stg-shopify-secret">${esc(text('مفتاح توقيع Webhooks', 'Webhook signing key'))}</label>
    <input id="stg-shopify-secret" type="password" autocomplete="new-password" dir="ltr" style="width:100%;margin:6px 0 12px" placeholder="${esc(text('اتركه فارغًا للاحتفاظ بالمفتاح المحفوظ', 'Leave blank to keep the saved key'))}">
    <p class="text-xs text-muted">${esc(text('اختياري لاستقبال الأوردرات الجديدة: بيانات Admin API مطلوبة لجلب الأوردرات القديمة ومزامنة حدث تعديل الأوردر.', 'Optional for new order webhooks: Admin API credentials are needed for historical imports and order edit events.'))}</p>
    <label for="stg-shopify-store">${esc(text('اسم المتجر أو رابط myshopify.com', 'Store name or myshopify.com domain'))}</label>
    <input id="stg-shopify-store" type="text" dir="ltr" style="width:100%;margin:6px 0 12px" value="${esc(settings?.shopifyStoreName || '')}">
    <p class="text-xs text-muted">${esc(text('لتطبيق Dev Dashboard: احفظ Client ID وClient secret مرة واحدة، والبرنامج يجدّد التوكن تلقائيًا. ثبّت التطبيق على المتجر بنفس مؤسسة Shopify.', 'For a Dev Dashboard app: save Client ID and Client secret once. The server renews the token automatically. Install the app on a store in the same Shopify organization.'))}</p>
    <label for="stg-shopify-client-id">Client ID</label>
    <input id="stg-shopify-client-id" type="text" autocomplete="off" dir="ltr" style="width:100%;margin:6px 0 12px" value="${esc(settings?.shopifyClientId || '')}">
    <label for="stg-shopify-client-secret">Client secret</label>
    <input id="stg-shopify-client-secret" type="password" autocomplete="new-password" dir="ltr" style="width:100%;margin:6px 0 12px" placeholder="${esc(text('اتركه فارغًا للاحتفاظ بالسر المحفوظ', 'Leave blank to keep the saved secret'))}">
    <details><summary>${esc(text('توكن ثابت لتطبيق Legacy', 'Static token for a legacy app'))}</summary>
    <label for="stg-shopify-token">${esc(text('توكن Admin API', 'Admin API token'))}</label>
    <input id="stg-shopify-token" type="password" autocomplete="new-password" dir="ltr" style="width:100%;margin:6px 0 12px" placeholder="${esc(text('اتركه فارغًا للاحتفاظ بالتوكن المحفوظ', 'Leave blank to keep the saved token'))}">
    </details>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" id="stg-shopify-save" onclick="saveShopifySettings()">${esc(text('حفظ الربط', 'Save connection'))}</button>
      <button class="btn btn-outline btn-sm" id="stg-shopify-test" onclick="testShopifySettings()">${esc(text('فحص الربط المحفوظ', 'Check saved connection'))}</button>
    </div>
    <p class="text-xs text-muted" style="margin-top:12px">${esc(text('بعد الحفظ، استخدم Send test في Shopify للتأكد من وصول الطلب الفعلي.', 'After saving, use Send test in Shopify to verify actual delivery.'))}</p>
    <p id="shopify-connection-status" role="status" class="text-xs"></p>`;
}

async function saveShopifySettings() {
  if (!isAdmin()) return;
  const body = {};
  for (const [key, id] of [['webhookSecret', 'stg-shopify-secret'], ['storeName', 'stg-shopify-store'], ['accessToken', 'stg-shopify-token'], ['clientId', 'stg-shopify-client-id'], ['clientSecret', 'stg-shopify-client-secret']]) {
    const value = (qs('#' + id)?.value || '').trim();
    if (value) body[key] = value;
  }
  if (!Object.keys(body).length) { toast(_shopifySettingsText('أدخل بيانات الربط أولًا.', 'Enter connection settings first.'), true); return; }
  const button = qs('#stg-shopify-save');
  if (button) button.disabled = true;
  try {
    const result = await api('/settings/shopify-config', { method: 'POST', body: JSON.stringify(body) });
    for (const id of ['stg-shopify-secret', 'stg-shopify-token', 'stg-shopify-client-secret']) { const input = qs('#' + id); if (input) input.value = ''; }
    if (result.settings) settings = { ...settings, ...result.settings };
    else {
      // Compatibility with the first backend release. A refresh failure after a
      // successful POST must not tell the administrator that saving failed.
      try { settings = await api('/settings'); }
      catch (_) {
        toast(_shopifySettingsText('تم الحفظ، لكن تعذر تحديث الحالة. حدّث الصفحة للتأكد.', 'Saved, but the status could not be refreshed. Reload the page to check.'), true);
        return;
      }
    }
    renderShopifySettings();
    if (typeof stgRefreshProviderConnections === 'function') stgRefreshProviderConnections(true);
    toast(_shopifySettingsText('تم حفظ ربط Shopify.', 'Shopify connection saved.'));
  } catch (error) {
    const message = _shopifySaveError(error);
    const status = qs('#shopify-connection-status');
    if (status) status.textContent = message;
    toast(message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function _shopifySaveError(error) {
  const text = _shopifySettingsText;
  // Map known server failures without echoing credentials or arbitrary response data.
  if (error?.message === 'Use the Shopify store name or its myshopify.com domain') {
    return text('اسم المتجر غير صحيح. أدخل اسم المتجر أو رابط myshopify.com؛ لتفعيل الاستقبال فقط اترك خانتي المتجر والتوكن فارغتين.', 'Invalid store name. Use the store name or myshopify.com domain; to enable webhooks only, leave the store and token fields blank.');
  }
  if (error?.message === 'Enter a Shopify setting to save') return text('أدخل مفتاح التوقيع في أول خانة ثم احفظ.', 'Enter the signing key in the first field, then save.');
  if (error?.message === 'Invalid Shopify signing secret') return text('مفتاح التوقيع غير صحيح. انسخه من أسفل قائمة Webhooks في Shopify.', 'Invalid signing key. Copy it from below the Webhooks list in Shopify.');
  if (error?.message === 'Invalid Shopify access token') return text('توكن Admin API غير صحيح. يمكن تركه فارغًا لاستقبال الأوردرات الجديدة.', 'Invalid Admin API token. You can leave it blank for new-order webhooks.');
  if (error?.message === 'Invalid Shopify app credentials') return text('بيانات التطبيق غير صحيحة. انسخ Client ID وClient secret من إعدادات التطبيق في Dev Dashboard.', 'Invalid app credentials. Copy Client ID and Client secret from the app settings in Dev Dashboard.');
  if (error?.status === 401) return text('انتهت جلسة الدخول. سجّل الدخول كأدمن وحاول الحفظ مرة أخرى.', 'Your session expired. Sign in as an administrator and try saving again.');
  if (error?.status === 403) return text('حفظ ربط Shopify متاح للأدمن فقط.', 'Only administrators can save the Shopify connection.');
  if (error?.status === 404) return text('مسار الحفظ غير موجود على السيرفر. تأكد من رفع الباك إند مع الواجهة.', 'The save endpoint is missing. Deploy the backend together with the frontend.');
  if (error?.status >= 500) return text('فشل الحفظ داخل السيرفر. راجع لوج الباك إند لمسار إعدادات Shopify.', 'Saving failed on the server. Check the backend log for the Shopify settings endpoint.');
  return text('تعذر الحفظ. راجع الاتصال والبيانات وحاول مرة أخرى.', 'Unable to save. Check the connection and fields, then try again.');
}

async function testShopifySettings() {
  if (!isAdmin()) return;
  const button = qs('#stg-shopify-test');
  const status = qs('#shopify-connection-status');
  if (button) button.disabled = true;
  if (status) status.textContent = _shopifySettingsText('جارٍ الفحص…', 'Checking…');
  try {
    const result = await api('/shopify/connection-status');
    if (typeof stgSetProviderConnectionState === 'function') stgSetProviderConnectionState('shopify', result.adminApiReachable === true ? 'connected' : result.webhookConfigured ? 'webhook' : result.adminApiConfigured ? 'disconnected' : 'unconfigured');
    const text = _shopifySettingsText;
    const messages = [result.webhookConfigured
      ? text('مفتاح الاستقبال محفوظ؛ اختبر وصول الطلب من Shopify باستخدام Send test.', 'Signing key is configured; verify delivery with Send test in Shopify.')
      : text('مفتاح الاستقبال غير مضبوط.', 'Signing key is not configured.')];
    messages.push(!result.adminApiConfigured
      ? text('Admin API غير مضبوط؛ لا يمنع استقبال الأوردرات الجديدة.', 'Admin API is not configured; new order webhooks can still be received.')
      : result.adminApiReachable
        ? text('الاتصال بـ Admin API نجح.', 'Admin API connection passed.')
        : settings?.shopifyClientId || settings?.shopifyClientSecretSet
          ? text('فشل اتصال التطبيق. راجع Client ID وClient secret، وتثبيت التطبيق على المتجر بنفس مؤسسة Shopify وصلاحية read_orders.', 'App connection failed. Check Client ID, Client secret, app installation on a store in the same Shopify organization, and read_orders permission.')
          : text('الاتصال بـ Admin API فشل؛ راجع اسم المتجر والتوكن وصلاحية قراءة الأوردرات.', 'Admin API connection failed; check the store, token and order read permission.'));
    if (status) status.textContent = messages.join(' ');
  } catch (_) {
    if (typeof stgSetProviderConnectionState === 'function') stgSetProviderConnectionState('shopify', 'error');
    if (status) status.textContent = _shopifySettingsText('تعذر الفحص. حاول مرة أخرى.', 'Unable to check. Try again.');
  } finally {
    if (button) button.disabled = false;
  }
}
