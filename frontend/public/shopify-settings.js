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
    <h3 style="margin:0 0 8px">Shopify</h3>
    <p class="text-xs text-muted">${esc(text('احفظ مفتاح الاستقبال مرة واحدة؛ يظل محفوظًا بعد تحديث البرنامج.', 'Save the signing key once. It stays saved after application updates.'))}</p>
    <p id="shopify-signing-status" role="status" class="text-xs">${esc(settings?.shopifyWebhookSecretSet
      ? text('مفتاح استقبال الأوردرات محفوظ.', 'Order webhook signing key is configured.')
      : text('استقبال الأوردرات متوقف: أدخل مفتاح Shopify الظاهر أسفل قائمة Webhooks.', 'Order webhooks are not configured. Enter the signing key shown below Shopify’s Webhooks list.'))}</p>
    <label for="stg-shopify-secret">${esc(text('مفتاح توقيع Webhooks', 'Webhook signing key'))}</label>
    <input id="stg-shopify-secret" type="password" autocomplete="new-password" dir="ltr" style="width:100%;margin:6px 0 12px" placeholder="${esc(text('اتركه فارغًا للاحتفاظ بالمفتاح المحفوظ', 'Leave blank to keep the saved key'))}">
    <p class="text-xs text-muted">${esc(text('اختياري لاستقبال الأوردرات الجديدة: بيانات Admin API مطلوبة لجلب الأوردرات القديمة ومزامنة حدث تعديل الأوردر.', 'Optional for new order webhooks: Admin API credentials are needed for historical imports and order edit events.'))}</p>
    <label for="stg-shopify-store">${esc(text('اسم المتجر أو رابط myshopify.com', 'Store name or myshopify.com domain'))}</label>
    <input id="stg-shopify-store" type="text" dir="ltr" style="width:100%;margin:6px 0 12px" value="${esc(settings?.shopifyStoreName || '')}">
    <label for="stg-shopify-token">${esc(text('توكن Admin API', 'Admin API token'))}</label>
    <input id="stg-shopify-token" type="password" autocomplete="new-password" dir="ltr" style="width:100%;margin:6px 0 12px" placeholder="${esc(text('اتركه فارغًا للاحتفاظ بالتوكن المحفوظ', 'Leave blank to keep the saved token'))}">
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
  for (const [key, id] of [['webhookSecret', 'stg-shopify-secret'], ['storeName', 'stg-shopify-store'], ['accessToken', 'stg-shopify-token']]) {
    const value = (qs('#' + id)?.value || '').trim();
    if (value) body[key] = value;
  }
  if (!Object.keys(body).length) { toast(_shopifySettingsText('أدخل بيانات الربط أولًا.', 'Enter connection settings first.'), true); return; }
  const button = qs('#stg-shopify-save');
  if (button) button.disabled = true;
  try {
    await api('/settings/shopify-config', { method: 'POST', body: JSON.stringify(body) });
    for (const id of ['stg-shopify-secret', 'stg-shopify-token']) { const input = qs('#' + id); if (input) input.value = ''; }
    settings = await api('/settings');
    renderShopifySettings();
    toast(_shopifySettingsText('تم حفظ ربط Shopify.', 'Shopify connection saved.'));
  } catch (_) {
    toast(_shopifySettingsText('تعذر الحفظ. راجع البيانات وحاول مرة أخرى.', 'Unable to save. Check the fields and try again.'), true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function testShopifySettings() {
  if (!isAdmin()) return;
  const button = qs('#stg-shopify-test');
  const status = qs('#shopify-connection-status');
  if (button) button.disabled = true;
  if (status) status.textContent = _shopifySettingsText('جارٍ الفحص…', 'Checking…');
  try {
    const result = await api('/shopify/connection-status');
    const text = _shopifySettingsText;
    const messages = [result.webhookConfigured
      ? text('مفتاح الاستقبال محفوظ؛ اختبر وصول الطلب من Shopify باستخدام Send test.', 'Signing key is configured; verify delivery with Send test in Shopify.')
      : text('مفتاح الاستقبال غير مضبوط.', 'Signing key is not configured.')];
    messages.push(!result.adminApiConfigured
      ? text('Admin API غير مضبوط؛ لا يمنع استقبال الأوردرات الجديدة.', 'Admin API is not configured; new order webhooks can still be received.')
      : result.adminApiReachable
        ? text('الاتصال بـ Admin API نجح.', 'Admin API connection passed.')
        : text('الاتصال بـ Admin API فشل؛ راجع اسم المتجر والتوكن وصلاحية قراءة الأوردرات.', 'Admin API connection failed; check the store, token and order read permission.'));
    if (status) status.textContent = messages.join(' ');
  } catch (_) {
    if (status) status.textContent = _shopifySettingsText('تعذر الفحص. حاول مرة أخرى.', 'Unable to check. Try again.');
  } finally {
    if (button) button.disabled = false;
  }
}
