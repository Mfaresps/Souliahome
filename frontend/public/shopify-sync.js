/* Outbound Shopify sync. All writes require an explicit preview or the saved auto setting. */
(() => {
  const text = (ar, en) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const $ = (s, root = document) => root.querySelector(s);
  const h = value => esc(String(value ?? ''));
  const call = (path, body) => api('/shopify/sync/' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  const date = value => value ? new Date(value).toLocaleString(text('ar-EG-u-nu-latn', 'en-GB')) : '—';
  const shipping = value => text(({ CREATED: 'تم إنشاء الشحنة', PICKED_UP: 'استلمها المندوب', IN_TRANSIT: 'في الطريق',
    OUT_FOR_DELIVERY: 'خرج للتسليم', DELIVERED: 'تم التسليم', FAILED_ATTEMPT: 'محاولة تسليم غير ناجحة',
    CUSTOMER_POSTPONED: 'تأجيل بطلب العميل', RETURNED: 'مرتجع', CANCELLED: 'الشحنة ملغية', DELETED: 'الشحنة محذوفة' })[value] || value || '—', value || '—');
  const state = job => ({ pending: text('في الانتظار', 'Queued'), running: text('جارٍ الإرسال', 'Sending'),
    error: text('تعذر الإرسال · إعادة تلقائية', 'Failed · automatic retry'), review: text('يحتاج مراجعة', 'Needs review'),
    synced: text('تم تأكيد حالة الشحن في Shopify', 'Shipping verified in Shopify'), metadata_only: text('بيانات تشغيلية فقط · الشحن لم يُزامَن', 'Operational data only · shipping not synced'), paused: text('متوقف', 'Paused') }[job?.status] || text('لم تتم المزامنة', 'Not synced'));
  const button = (label, action, extra = '') => `<button type="button" class="btn btn-outline btn-sm" data-ss-action="${action}" ${extra}>${h(label)}</button>`;
  let dialog, timer, busy = false, pageCursor = '', nextCursor = '', preview = null, opener;
  let requestSequence = 0;

  function errorMessage(error) {
    return error?.status === 403 ? text('متاح للأدمن فقط.', 'Administrators only.')
      : error?.message || text('تعذر الاتصال. حاول مرة أخرى.', 'Unable to connect. Try again.');
  }
  function statusLine(s) {
    return `${s.enabled ? text('المزامنة التلقائية مفعّلة', 'Automatic sync is on') : text('المزامنة التلقائية متوقفة', 'Automatic sync is off')}
      · ${text('آخر نجاح', 'Last success')}: ${date(s.lastSuccessAt)}`;
  }
  window.renderShopifySyncSettings = async () => {
    const card = $('#stg-shopify-card');
    if (!card || !isAdmin()) return;
    $('#shopify-sync-settings', card)?.remove();
    const box = document.createElement('section');
    box.id = 'shopify-sync-settings'; box.className = 'ss-settings';
    box.innerHTML = `<h4>${h(text('إرسال التحديثات إلى Shopify', 'Send updates to Shopify'))}</h4><p role="status">${h(text('جارٍ تحميل الحالة…', 'Loading…'))}</p>`;
    card.append(box);
    try {
      const s = await call('status');
      if (!box.isConnected) return;
      box.innerHTML = `<h4>${h(text('إرسال التحديثات إلى Shopify', 'Send updates to Shopify'))}</h4>
        <p role="status">${h(statusLine(s))}</p>
        ${s.domain ? `<p dir="ltr">${h(s.domain)}</p>` : ''}
        ${s.identityChanged ? `<p class="ss-error">${h(text('بيانات الربط تغيّرت؛ احفظ إعداد المزامنة للتحقق من المتجر الجديد.', 'Connection changed. Save sync settings to verify the new store.'))}</p>` : ''}
        ${s.lastScanError ? `<p class="ss-error">${h(s.lastScanError)}</p>` : ''}
        <label><input type="checkbox" id="ss-auto" ${s.enabled ? 'checked' : ''}> ${h(text('مزامنة تغييرات الطلبات تلقائيًا', 'Automatically sync order changes'))}</label>
        <label><input type="checkbox" id="ss-auto-payment" ${s.includePayments ? 'checked' : ''}> ${h(text('تضمين السداد الكامل عند تأكيد التحصيل', 'Include full payment when collection is confirmed'))}</label>
        <p class="ss-note">${h(text('أول تفعيل يبدأ من التغييرات الجديدة. الطلبات القديمة تحتاج معاينة ومزامنة من الزر أدناه. الإيقاف يمنع الإرسال التلقائي، وتظل المزامنة اليدوية متاحة.', 'First activation starts with new changes. Preview and sync older orders using the button below. Turning this off stops automatic sends; manual sync remains available.'))}</p>
        <p class="ss-note">${h(text('العربون الجزئي يُرسل كمعلومة فقط. تسجيل السداد الكامل يغيّر حالة الدفع الفعلية في المتجر المتصل.', 'Partial deposits are sent as information only. Recording full payment changes the actual payment status in the connected store.'))}</p>
        <div class="ss-actions">${button(text('حفظ إعداد المزامنة', 'Save sync settings'), 'save')}${button(text('مزامنة الطلبات القديمة', 'Sync older orders'), 'open')}</div>`;
      box.onclick = async event => {
        const b = event.target.closest('[data-ss-action]'); if (!b) return;
        if (b.dataset.ssAction === 'open') { window.openShopifySync(); return; }
        if (!isAdmin()) return;
        b.disabled = true;
        try {
          await call('config', { enabled: $('#ss-auto', box).checked, includePayments: $('#ss-auto-payment', box).checked });
          await window.renderShopifySyncSettings();
          toast(text('تم حفظ إعداد المزامنة.', 'Sync settings saved.'));
        } catch (e) { toast(errorMessage(e), true); b.disabled = false; }
      };
    } catch (e) { box.innerHTML = `<p class="ss-error">${h(errorMessage(e))}</p>`; }
  };

  function message(value, bad = false) {
    const el = $('#ss-message', dialog); if (el) { el.textContent = value; el.className = bad ? 'ss-error' : ''; }
  }
  function setBusy(value) {
    busy = value;
    if (!dialog) return;
    dialog.querySelectorAll('button:not([data-ss-action="close"]), input, select').forEach(el => { el.disabled = value || el.hasAttribute('data-ss-unavailable'); });
    if (!value) {
      const next = $('#ss-next', dialog); if (next) next.disabled = !nextCursor;
      const execute = $('#ss-execute', dialog); if (execute) execute.disabled = !preview?.results.some(r => r.token && !r.issues.length && r.actions.length);
    }
  }
  async function refreshRows() {
    const seq = ++requestSequence;
    const query = new URLSearchParams();
    const ref = $('#ss-ref', dialog).value.trim(), filter = $('#ss-filter', dialog).value;
    if (ref) query.set('ref', ref); if (pageCursor) query.set('cursor', pageCursor); if (filter) query.set('state', filter);
    const selected = new Set([...dialog.querySelectorAll('[data-ss-id]:checked')].map(el => el.dataset.ssId));
    const [data, s] = await Promise.all([call('orders?' + query), call('status')]);
    if (!dialog?.open || seq !== requestSequence) return;
    nextCursor = data.nextCursor;
    $('#ss-status', dialog).textContent = statusLine(s);
    $('#ss-rows', dialog).innerHTML = data.rows.length ? data.rows.map(row => `<tr>
      <td><input type="checkbox" data-ss-id="${h(row.id)}" aria-label="${h(text('اختيار الطلب ', 'Select order ') + row.ref)}" ${selected.has(row.id) ? 'checked' : ''}></td>
      <td><strong>#${h(row.ref)}</strong><small>${h(shipping(row.shipping))}</small></td>
      <td><span class="ss-badge" data-state="${h(row.sync?.status || '')}">${h(state(row.sync))}</span><small>${h(date(row.sync?.lastSuccessAt))}</small>
        ${row.sync?.error ? `<p class="ss-error">${h(row.sync.error)}</p>` : ''}
        ${(row.sync?.warnings || []).map(w => `<small>${h(w)}</small>`).join('')}
        ${row.sync?.nextAttemptAt && row.sync.status === 'error' ? `<small>${h(text('المحاولة التالية: ', 'Next retry: ') + date(row.sync.nextAttemptAt))}</small>` : ''}
        ${row.sync?.log?.length ? `<details><summary>${h(text('سجل المحاولات', 'Attempt history'))}</summary>${row.sync.log.map(l => `<small>${h(date(l.at))} — ${h(l.message)}</small>`).join('')}</details>` : ''}</td>
      <td>${row.sync && ['error', 'review', 'paused'].includes(row.sync.status) ? button(text('إعادة التحقق والمحاولة', 'Recheck and retry'), 'retry', `data-job="${h(row.sync.id)}"`) : '—'}</td>
      </tr>`).join('') : `<tr><td colspan="4">${h(text('لا توجد طلبات مطابقة.', 'No matching orders.'))}</td></tr>`;
    setBusy(busy);
  }
  function clearPreview() { preview = null; $('#ss-preview', dialog).innerHTML = ''; }
  async function showPreview() {
    const ids = [...dialog.querySelectorAll('[data-ss-id]:checked')].map(el => el.dataset.ssId);
    if (!ids.length || ids.length > 10) { message(text('اختر من 1 إلى 10 طلبات في كل دفعة.', 'Select 1–10 orders per batch.'), true); return; }
    clearPreview();
    preview = await call('preview', { transactionIds: ids, includePayments: $('#ss-payment', dialog).checked });
    $('#ss-preview', dialog).innerHTML = `<h3>${h(text('معاينة الإرسال', 'Send preview'))}</h3><p>${h(text('سيتم الإرسال إلى المتجر: ', 'Updates will be sent to: '))}<b dir="ltr">${h(preview.domain)}</b></p>
      <p class="ss-note">${h(text('راجع التغييرات وحدد الطلبات التي تريد إرسالها. المعاينة صالحة لمدة 15 دقيقة.', 'Review the changes and select orders to send. Preview expires in 15 minutes.'))}</p>
      ${preview.results.map(r => `<article class="ss-preview-item"><label><input type="checkbox" data-ss-token="${h(r.token || '')}" ${!r.token || r.issues.length || !r.actions.length ? 'disabled data-ss-unavailable' : ''}> <b>#${h(r.ref || r.transactionId)}</b></label>
        ${r.actions.length ? `<ul>${r.actions.map(a => `<li>${h(a)}</li>`).join('')}</ul>` : ''}
        ${r.matched ? `<p>${h(text('متطابق بالفعل؛ لا يوجد إرسال مطلوب.', 'Already matches; no send needed.'))}</p>` : ''}
        ${r.issues.map(i => `<p class="ss-error">${h(i)}</p>`).join('')}${r.warnings.map(w => `<p class="ss-note">${h(w)}</p>`).join('')}</article>`).join('')}
      ${button(text('إرسال التغييرات المحددة إلى Shopify', 'Send selected changes to Shopify'), 'execute', 'id="ss-execute"')}`;
    message(text('المعاينة جاهزة؛ لم يتم إرسال تغييرات.', 'Preview ready. No changes have been sent.'));
    $('#ss-preview', dialog).scrollIntoView({ block: 'nearest' });
  }
  window.openShopifySync = async (ref = '') => {
    if (!isAdmin() || busy) return;
    if (dialog?.open) { dialog.focus(); return; }
    opener = document.activeElement;
    dialog?.remove(); dialog = document.createElement('dialog');
    dialog.className = 'ss-dialog'; dialog.setAttribute('aria-labelledby', 'ss-title');
    dialog.dir = text('rtl', 'ltr'); pageCursor = ''; nextCursor = ''; preview = null;
    dialog.innerHTML = `<div class="ss-top"><h2 id="ss-title">${h(text('مزامنة الطلبات القديمة', 'Sync older orders'))}</h2>${button(text('إغلاق', 'Close'), 'close')}</div>
      <p id="ss-status" role="status"></p><p class="ss-note">${h(text('تُرسل حالة الشحن ورقم التتبع للطلبات المرتبطة. الطلبات التي تحتاج مراجعة تظهر بسبب واضح. للطلبات الأقدم من 60 يومًا قد يلزم منح صلاحية قراءة كل الطلبات للتطبيق.', 'Sends shipping status and tracking for linked orders. Orders needing review show a reason. Orders older than 60 days may require the app’s read-all-orders permission.'))}</p>
      <div class="ss-actions"><label>${h(text('رقم الطلب', 'Order number'))}<input id="ss-ref" value="${h(ref)}" placeholder="2882" maxlength="80"></label>
      <label>${h(text('حالة المزامنة', 'Sync status'))}<select id="ss-filter"><option value="">${h(text('الكل', 'All'))}</option>${['pending','running','error','review','synced','metadata_only'].map(s => `<option value="${s}">${h(state({status:s}))}</option>`).join('')}</select></label>
      ${button(text('بحث / تحديث', 'Search / refresh'), 'search')}</div>
      <label class="ss-payment"><input type="checkbox" id="ss-payment"> ${h(text('تضمين السداد الكامل المؤكد في المعاينة (يغيّر حالة الدفع)', 'Include confirmed full payment in preview (changes payment status)'))}</label>
      <div class="ss-actions">${button(text('معاينة المحدد', 'Preview selected'), 'preview')}${button(text('أول صفحة', 'First page'), 'first')}${button(text('الصفحة التالية', 'Next page'), 'next', 'id="ss-next"')}</div>
      <div class="ss-table-wrap"><table><thead><tr><th>${h(text('اختيار', 'Select'))}</th><th>${h(text('الطلب', 'Order'))}</th><th>${h(text('نتيجة المزامنة', 'Sync result'))}</th><th>${h(text('إجراء', 'Action'))}</th></tr></thead><tbody id="ss-rows"></tbody></table></div>
      <p id="ss-message" role="status" aria-live="polite"></p><section id="ss-preview"></section>`;
    document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('close', () => { clearInterval(timer); requestSequence++; opener?.focus?.(); });
    dialog.addEventListener('change', event => {
      if (event.target.matches('#ss-payment, [data-ss-id]')) clearPreview();
    });
    dialog.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.id === 'ss-ref') { event.preventDefault(); $('[data-ss-action="search"]', dialog).click(); } });
    dialog.addEventListener('click', async event => {
      const b = event.target.closest('[data-ss-action]'); if (!b) return;
      const action = b.dataset.ssAction;
      if (action === 'close') { dialog.close(); return; }
      if (busy || !isAdmin()) return;
      setBusy(true); message(text('جارٍ التنفيذ…', 'Working…'));
      try {
        if (['search', 'first', 'next'].includes(action)) { pageCursor = action === 'next' ? nextCursor : ''; clearPreview(); await refreshRows(); message(''); }
        if (action === 'preview') await showPreview();
        if (action === 'execute') {
          const tokens = [...dialog.querySelectorAll('[data-ss-token]:checked')].map(el => el.dataset.ssToken);
          if (!tokens.length) message(text('حدد التغييرات التي توافق على إرسالها أولًا.', 'Select the changes you approve for sending.'), true);
          else {
            const result = await call('execute', { tokens });
            const errors = result.results.filter(r => r.error);
            clearPreview(); await refreshRows();
            message(text('تمت إضافة الطلبات المقبولة إلى قائمة الإرسال. ', 'Accepted orders queued for sending. ') + errors.map(r => r.error).join(' '), errors.length > 0);
          }
        }
        if (action === 'retry') {
          await call('jobs/' + encodeURIComponent(b.dataset.job) + '/retry', {});
          await refreshRows(); message(text('تمت جدولة إعادة التحقق والمحاولة.', 'Recheck and retry queued.'));
        }
      } catch (e) { message(errorMessage(e), true); }
      finally { setBusy(false); }
    });
    setBusy(true);
    try { await refreshRows(); } catch (e) { message(errorMessage(e), true); }
    finally { setBusy(false); }
    if (dialog.open) timer = setInterval(() => { if (dialog?.open && !busy && !preview && !document.hidden) refreshRows().catch(e => message(errorMessage(e), true)); }, 15000);
  };

  // Invoice entry point is mounted after each invoice render; each response belongs to its own node.
  window.mountShopifyOrderSync = async (tx, wrap) => {
    if (!isAdmin() || !tx?.shopifyOrderId || !wrap) return;
    wrap.querySelector('.ss-order')?.remove();
    const box = document.createElement('div'); box.className = 'ss-order';
    box.innerHTML = `<strong>Shopify</strong><span role="status">${h(text('جارٍ تحميل المزامنة…', 'Loading sync…'))}</span>${button(text('معاينة المزامنة / إعادة المحاولة', 'Preview sync / retry'), 'open')}`;
    wrap.prepend(box);
    $('button', box).onclick = () => window.openShopifySync(String(tx.ref || ''));
    try { const job = await call('orders/' + encodeURIComponent(tx._id)); $('[role="status"]', box).textContent = state(job) + ' · ' + date(job?.lastSuccessAt); }
    catch (e) { $('[role="status"]', box).textContent = errorMessage(e); }
  };

  // Auth and language can change without a full reload.
  function header() {
    const b = $('#sp-sync-old'); if (!b) return;
    b.hidden = !isAdmin(); b.textContent = text('مزامنة الطلبات القديمة', 'Sync older orders');
  }
  header(); setInterval(header, 2000);
})();
