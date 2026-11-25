/* «واجهة API الخارجية» — control panel for external API keys (e.g. Instinct).
 * Settings ← التكاملات وواجهات API ← API. Admin only; the server enforces it too (/api/api-keys).
 * Draws into #api-access-root. Uses the app's api(), toast(), showConfirm(), pinBoxesHtml(), users.
 * ⚠ A plain key is in memory only while its reveal dialog is open — never stored, never logged. */
(function () {
  'use strict';
  const L = (ar, en) => (typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NUM = (n) => Number(n || 0).toLocaleString('en-US');
  const when = (v) => {
    if (!v) return L('لم يُستخدم بعد', 'Never used');
    const d = new Date(v); const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return L('الآن', 'just now');
    if (s < 3600) return L(`منذ ${Math.floor(s / 60)} د`, `${Math.floor(s / 60)}m ago`);
    if (s < 86400) return L(`منذ ${Math.floor(s / 3600)} س`, `${Math.floor(s / 3600)}h ago`);
    return d.toLocaleString(L('ar-EG-u-nu-latn', 'en-GB'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const full = (v) => (v ? new Date(v).toLocaleString(L('ar-EG-u-nu-latn', 'en-GB')) : '');
  const ICON = {
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M15 8l2 2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  };

  const state = { data: null, loading: false, error: '', log: null, logFilter: { keyId: '', result: '', method: '', page: 1 }, dialog: null };

  function scopeLabel(code) {
    const s = (state.data?.scopes || []).find((x) => x.code === code);
    return s ? L(s.ar, s.en) : code;
  }
  function statusOf(k) {
    if (k.status === 'revoked') return { cls: 'is-revoked', t: L('ملغي', 'Revoked') };
    if (k.expired) return { cls: 'is-expired', t: L('منتهي', 'Expired') };
    if (k.status === 'paused') return { cls: 'is-paused', t: L('موقوف مؤقتًا', 'Paused') };
    return { cls: 'is-active', t: L('يعمل', 'Active') };
  }
  const phoneLabel = (v) => ({ detail: L('كاملة في التفاصيل فقط', 'Full in details only'), masked: L('مخفية دائمًا', 'Always masked'), full: L('كاملة دائمًا', 'Always full') }[v] || v);

  async function load() {
    state.loading = true; state.error = '';
    try { state.data = await api('/api-keys', { deduplicate: false }); }
    catch (e) { state.error = e?.message || L('تعذّر تحميل المفاتيح', 'Could not load keys'); }
    state.loading = false;
  }
  async function loadLog() {
    const f = state.logFilter;
    const q = new URLSearchParams({ limit: '25', page: String(f.page) });
    if (f.keyId) q.set('keyId', f.keyId);
    if (f.result) q.set('result', f.result);
    if (f.method) q.set('method', f.method);
    try { state.log = await api('/api-keys/log?' + q.toString(), { deduplicate: false }); }
    catch (e) { state.log = { error: e?.message || 'error' }; }
  }

  function root() { return document.getElementById('api-access-root'); }

  async function render(force) {
    const el = root(); if (!el) return;
    if (typeof isAdmin === 'function' && !isAdmin()) { el.innerHTML = ''; return; }
    if (!state.data || force) {
      if (!state.data) el.innerHTML = `<div class="apx-skel"><i></i><i></i><i></i></div>`;
      await Promise.all([load(), loadLog()]);
    }
    draw();
  }

  function draw() {
    const el = root(); if (!el) return;
    if (state.error && !state.data) {
      el.innerHTML = `<div class="apx-error">${E(state.error)} <button class="btn btn-outline btn-sm" data-apx="reload">${L('إعادة المحاولة', 'Retry')}</button></div>`;
      return;
    }
    const d = state.data;
    const keys = d.keys || [];
    const live = keys.filter((k) => k.status !== 'revoked');
    const tot = live.reduce((a, k) => ({ t: a.t + k.last24h.total, e: a.e + k.last24h.errors, w: a.w + k.last24h.writes }), { t: 0, e: 0, w: 0 });
    el.innerHTML = `
      <div class="apx-master ${d.enabled ? 'is-on' : 'is-off'}">
        <div class="apx-master-main">
          <label class="apx-switch" title="${E(L('إيقاف أو تشغيل كل مفاتيح API مرة واحدة', 'Stop or start every API key at once'))}">
            <input type="checkbox" data-apx="master" ${d.enabled ? 'checked' : ''}><span></span>
          </label>
          <div>
            <strong>${d.enabled ? L('الوصول عبر API يعمل', 'API access is on') : L('الوصول عبر API متوقف بالكامل', 'API access is stopped')}</strong>
            <small>${d.enabled ? L('المفاتيح النشطة تعمل وفق صلاحياتها. الإيقاف من هنا يوقف كل المفاتيح فورًا.', 'Active keys work within their sections. Switching off stops every key at once.') : L('كل الطلبات تُرفض الآن (503). المفاتيح محفوظة كما هي.', 'Every request is refused now (503). Keys are kept as they are.')}</small>
          </div>
        </div>
        <div class="apx-kpis">
          <div><b>${NUM(live.filter((k) => k.status === 'active' && !k.expired).length)}</b><span>${L('مفتاح نشط', 'Active keys')}</span></div>
          <div><b>${NUM(tot.t)}</b><span>${L('طلب · 24 ساعة', 'Requests · 24h')}</span></div>
          <div><b>${NUM(tot.w)}</b><span>${L('ملاحظة مكتوبة', 'Notes written')}</span></div>
          <div class="${tot.e ? 'is-warn' : ''}"><b>${NUM(tot.e)}</b><span>${L('مرفوض / خطأ', 'Refused / errors')}</span></div>
          <div class="${d.rejectedUnknown24h ? 'is-warn' : ''}" title="${E(L('طلبات بمفتاح غير موجود أو بدون مفتاح', 'Requests with no key or an unknown key'))}"><b>${NUM(d.rejectedUnknown24h)}</b><span>${L('مفتاح مجهول', 'Unknown key')}</span></div>
        </div>
      </div>

      <div class="apx-bar">
        <h4>${L('المفاتيح', 'Keys')}</h4>
        <button class="btn btn-primary btn-sm" data-apx="new">${ICON.plus}<span>${L('مفتاح جديد', 'New key')}</span></button>
      </div>
      ${keys.length ? keys.filter((k) => k.status !== 'revoked').map(keyCard).join('') + (keys.some((k) => k.status === 'revoked') ? `<details class="apx-revoked"><summary>${L('مفاتيح ملغاة', 'Revoked keys')} (${keys.filter((k) => k.status === 'revoked').length})</summary>${keys.filter((k) => k.status === 'revoked').map(keyCard).join('')}</details>` : '') : `<div class="apx-empty">${ICON.key}<p>${L('لا توجد مفاتيح بعد. أنشئ مفتاحًا لتطبيق Instinct واربطه بحسابه في النظام.', 'No keys yet. Create one for Instinct and link it to its account.')}</p></div>`}

      ${logHtml()}
      ${docsHtml()}`;
  }

  function keyCard(k) {
    const st = statusOf(k);
    const dead = k.status === 'revoked';
    const scopes = (state.data.scopes || []).map((s) => {
      const on = k.scopes.includes(s.code);
      return `<button type="button" class="apx-scope ${on ? 'is-on' : ''} ${s.write ? 'is-write' : ''}" data-apx="scope" data-id="${k.id}" data-scope="${s.code}" ${dead ? 'disabled' : ''} aria-pressed="${on}" title="${E(s.write ? L('كتابة: إضافة ملاحظة متابعة فقط', 'Write: adding a follow-up note only') : L('قراءة فقط', 'Read only'))}">
        <span class="apx-dot"></span>${E(L(s.ar, s.en))}${s.write ? `<em>${L('كتابة', 'write')}</em>` : ''}</button>`;
    }).join('');
    const rate = k.rateLimit || 0;
    const nowPct = rate ? Math.min(100, Math.round((k.requestsLastMinute / rate) * 100)) : 0;
    return `
      <article class="apx-key ${st.cls}" data-key="${k.id}">
        <header>
          <div class="apx-key-id">
            <span class="apx-key-ic">${ICON.key}</span>
            <div><strong>${E(k.name)}</strong><code dir="ltr">${E(k.prefix)}…</code></div>
            <span class="apx-pill ${st.cls}">${st.t}</span>
          </div>
          <div class="apx-key-actions">
            ${dead ? '' : (k.status === 'paused'
              ? `<button class="btn btn-sm apx-go" data-apx="resume" data-id="${k.id}">${ICON.play}<span>${L('تشغيل', 'Resume')}</span></button>`
              : `<button class="btn btn-sm apx-stop" data-apx="pause" data-id="${k.id}">${ICON.pause}<span>${L('إيقاف مؤقت', 'Pause')}</span></button>`)}
            ${dead ? '' : `<button class="btn btn-outline btn-sm" data-apx="edit" data-id="${k.id}">${L('الإعدادات', 'Settings')}</button>
            <button class="btn btn-outline btn-sm" data-apx="rotate" data-id="${k.id}">${L('تجديد المفتاح', 'Rotate')}</button>
            <button class="btn btn-outline btn-sm apx-danger" data-apx="revoke" data-id="${k.id}">${L('إلغاء', 'Revoke')}</button>`}
          </div>
        </header>
        <div class="apx-facts">
          <div><span>${L('يكتب باسم', 'Writes as')}</span><b>${E(k.linkedUserName || '—')}</b></div>
          <div><span>${L('آخر استخدام', 'Last used')}</span><b title="${E(full(k.lastUsedAt))}">${E(when(k.lastUsedAt))}${k.lastUsedIp ? ` · <bdi dir="ltr">${E(k.lastUsedIp)}</bdi>` : ''}</b></div>
          <div><span>${L('آخر 24 ساعة', 'Last 24h')}</span><b>${NUM(k.last24h.total)} ${L('طلب', 'req')}${k.last24h.errors ? ` · <i class="apx-err">${NUM(k.last24h.errors)} ${L('مرفوض', 'refused')}</i>` : ''}</b></div>
          <div><span>${L('الحد', 'Limit')}</span><b>${NUM(k.requestsLastMinute)} / ${NUM(rate)} ${L('في الدقيقة', 'per min')}</b><i class="apx-meter"><i style="width:${nowPct}%"></i></i></div>
        </div>
        <div class="apx-scopes" role="group" aria-label="${E(L('الأقسام المسموحة', 'Allowed sections'))}">${scopes}</div>
        <div class="apx-sec">
          <span>${L('التليفونات', 'Phones')}: <b>${E(phoneLabel(k.phoneAccess))}</b></span>
          <span>${L('عناوين IP', 'IP addresses')}: <b>${k.ipAllowlist.length ? k.ipAllowlist.map((x) => `<bdi dir="ltr">${E(x)}</bdi>`).join('، ') : L('أي عنوان', 'Any')}</b></span>
          <span>${L('ينتهي', 'Expires')}: <b>${k.expiresAt ? E(full(k.expiresAt)) : L('بدون انتهاء', 'Never')}</b></span>
          <span>Webhook: <b>${k.webhookUrl ? `<bdi dir="ltr">${E(k.webhookUrl)}</bdi>${k.webhookLastError ? ` <i class="apx-err" title="${E(k.webhookLastError)}">${L('فشل آخر إرسال', 'last delivery failed')}</i>` : k.webhookLastAt ? ` <i class="apx-ok">${L('آخر إرسال', 'last sent')} ${E(when(k.webhookLastAt))}</i>` : ''}` : L('غير مفعّل (Instinct يسأل كل دقيقة)', 'Off (Instinct polls)')}</b>
            ${k.webhookUrl && !dead ? `<button class="apx-link" data-apx="test-hook" data-id="${k.id}">${L('إرسال تجربة', 'Send test')}</button>` : ''}</span>
        </div>
        ${k.history?.length ? `<details class="apx-hist"><summary>${L('سجل التغييرات', 'Change history')} (${k.history.length})</summary><ul>${k.history.map((h) => `<li><b>${E(histLabel(h.action))}</b> · ${E(h.by || '')} · <span title="${E(full(h.at))}">${E(when(h.at))}</span>${h.detail ? `<small dir="ltr">${E(h.detail)}</small>` : ''}</li>`).join('')}</ul></details>` : ''}
      </article>`;
  }
  const histLabel = (a) => ({ created: L('أُنشئ', 'Created'), updated: L('عُدّل', 'Updated'), paused: L('أُوقف مؤقتًا', 'Paused'), resumed: L('شُغّل', 'Resumed'), rotated: L('جُدّد المفتاح', 'Rotated'), revoked: L('أُلغي', 'Revoked') }[a] || a);

  function logHtml() {
    const f = state.logFilter; const lg = state.log;
    const keys = state.data?.keys || [];
    const rows = lg?.rows || [];
    const pages = lg?.total ? Math.ceil(lg.total / (lg.limit || 25)) : 1;
    return `
      <section class="apx-log">
        <div class="apx-bar"><h4>${L('سجل الطلبات', 'Request log')}</h4>
          <div class="apx-filters">
            <select data-apx="log-key"><option value="">${L('كل المفاتيح', 'All keys')}</option>${keys.map((k) => `<option value="${k.id}" ${f.keyId === k.id ? 'selected' : ''}>${E(k.name)}</option>`).join('')}</select>
            <select data-apx="log-result"><option value="">${L('كل النتائج', 'All results')}</option><option value="ok" ${f.result === 'ok' ? 'selected' : ''}>${L('ناجح', 'Succeeded')}</option><option value="errors" ${f.result === 'errors' ? 'selected' : ''}>${L('مرفوض / خطأ', 'Refused / errors')}</option></select>
            <select data-apx="log-method"><option value="">${L('قراءة وكتابة', 'Reads & writes')}</option><option value="GET" ${f.method === 'GET' ? 'selected' : ''}>${L('قراءة', 'Reads')}</option><option value="POST" ${f.method === 'POST' ? 'selected' : ''}>${L('كتابة', 'Writes')}</option></select>
            <button class="btn btn-outline btn-sm" data-apx="log-refresh">${L('تحديث', 'Refresh')}</button>
          </div></div>
        ${lg?.error ? `<div class="apx-error">${E(lg.error)}</div>` : rows.length ? `
        <div class="apx-table-wrap"><table class="apx-table">
          <thead><tr><th>${L('الوقت', 'Time')}</th><th>${L('المفتاح', 'Key')}</th><th>${L('الطلب', 'Request')}</th><th>${L('النتيجة', 'Result')}</th><th>${L('المدة', 'Time')}</th><th>IP</th></tr></thead>
          <tbody>${rows.map((r) => `<tr class="${r.status >= 400 ? 'is-bad' : ''}">
            <td title="${E(full(r.at))}">${E(when(r.at))}</td>
            <td>${E(r.keyName || (r.prefix ? r.prefix + '…' : L('بدون مفتاح', 'No key')))}</td>
            <td dir="ltr" class="apx-path"><b>${E(r.method)}</b> ${E(r.path)}${r.query ? `<small>?${E(r.query)}</small>` : ''}${r.detail ? `<small>${E(r.detail)}</small>` : ''}</td>
            <td><span class="apx-code ${r.status >= 400 ? 'is-bad' : 'is-ok'}">${E(r.status)}</span>${r.code ? `<small dir="ltr">${E(r.code)}</small>` : ''}</td>
            <td dir="ltr">${NUM(r.ms)} ms</td>
            <td dir="ltr">${E(r.ip || '—')}</td></tr>`).join('')}</tbody></table></div>
        <div class="apx-pager"><span>${L(`${NUM(lg.total)} طلب`, `${NUM(lg.total)} requests`)}</span>
          <button class="btn btn-outline btn-sm" data-apx="log-prev" ${f.page <= 1 ? 'disabled' : ''}>${L('السابق', 'Previous')}</button>
          <span>${NUM(f.page)} / ${NUM(pages)}</span>
          <button class="btn btn-outline btn-sm" data-apx="log-next" ${f.page >= pages ? 'disabled' : ''}>${L('التالي', 'Next')}</button></div>`
        : `<div class="apx-empty is-small">${L('لا توجد طلبات مسجلة لهذا الاختيار.', 'No requests for this selection.')}</div>`}
        <p class="apx-note">${L('يُحفظ السجل 90 يومًا. المفتاح نفسه لا يُسجَّل أبدًا.', 'Kept for 90 days. The key itself is never logged.')}</p>
      </section>`;
  }

  function docsHtml() {
    const base = location.origin + '/api/v1';
    const rows = [
      ['GET', '/me', L('بيانات المفتاح وصلاحياته', 'The key and its sections'), ''],
      ['GET', '/orders?from=&to=&status=&confirmation=&followup=none', L('الأوردرات (حتى 31 يومًا) — followup=none للأوردرات بدون متابعة', 'Orders (≤31 days) — followup=none for orders without a follow-up'), 'orders'],
      ['GET', '/orders/{ref}', L('تفاصيل أوردر برقمه', 'One order by number'), 'orders'],
      ['GET', '/orders/{ref}/shipping', L('حالة الشحن ومشاكله وأحداث شركة الشحن', 'Shipping status, problems and carrier events'), 'shipping'],
      ['GET', '/shipping/problems?state=attempt|open|awaiting', L('الأوردرات التي عليها مشكلة شحن', 'Orders with a shipping problem'), 'shipping'],
      ['GET', '/orders/{ref}/followups', L('متابعات الأوردر وملاحظاتها', 'The order\'s follow-ups and notes'), 'followups'],
      ['GET', '/followups?status=open&updatedSince=', L('المتابعات', 'Follow-ups'), 'followups'],
      ['POST', '/followups/{id}/notes', L('إضافة ملاحظة {text, author, requestId}', 'Add a note {text, author, requestId}'), 'followups-write'],
      ['POST', '/orders/{ref}/followup-notes', L('ملاحظة على المتابعة المفتوحة للأوردر', 'Note on the order\'s open follow-up'), 'followups-write'],
      ['GET', '/mentions?since=&unread=1', L('ردود الموظفين والمنشن لحساب التكامل', 'Employee replies and mentions for the account'), 'mentions'],
      ['GET', '/complaints?categoryGroup=&category=', L('الشكاوى بالتصنيف', 'Complaints by category'), 'complaints'],
      ['GET', '/inventory?q=&state=', L('المخزون (صالح للبيع، محجوز، وارد)', 'Stock (ready, reserved, incoming)'), 'inventory'],
      ['GET', '/reports/daily?date=YYYY-MM-DD', L('تقرير المبيعات اليومي', 'Daily sales report'), 'reports'],
    ];
    return `<details class="apx-docs"><summary>${L('دليل الاستخدام للمطوّر', 'Developer reference')}</summary>
      <p>${L('كل الطلبات على HTTPS مع الهيدر', 'Every request over HTTPS with the header')} <code dir="ltr">X-API-Key: sk_live_…</code>. ${L('لا يوجد أي مسار للحذف أو التعديل أو الإلغاء.', 'There is no delete, edit or cancel route.')}</p>
      <div class="apx-table-wrap"><table class="apx-table"><tbody>${rows.map(([m, p, t, s]) => `<tr><td dir="ltr"><b>${m}</b> ${E(p)}</td><td>${E(t)}</td><td>${s ? `<span class="apx-tag">${E(scopeLabel(s))}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <pre dir="ltr">curl -H "X-API-Key: sk_live_…" "${E(base)}/orders?followup=none"

curl -X POST -H "X-API-Key: sk_live_…" -H "Content-Type: application/json" \\
  -d '{"text":"تم التواصل مع العميل","author":"Instinct","requestId":"msg-1001"}' \\
  "${E(base)}/followups/{id}/notes"</pre>
      <p>${L('الأخطاء ترجع بـ code ثابت: API_KEY_INVALID، API_KEY_PAUSED، SCOPE_NOT_ALLOWED، IP_NOT_ALLOWED، RATE_LIMITED (مع Retry-After)، API_DISABLED، ORDER_NOT_FOUND، NO_OPEN_FOLLOWUP.', 'Errors carry a stable code: API_KEY_INVALID, API_KEY_PAUSED, SCOPE_NOT_ALLOWED, IP_NOT_ALLOWED, RATE_LIMITED (with Retry-After), API_DISABLED, ORDER_NOT_FOUND, NO_OPEN_FOLLOWUP.')}</p>
      <p>${L('الـ Webhook يُرسل POST بالحدث mention.created وتوقيع X-Soulia-Signature = sha256=HMAC(السر، جسم الطلب).', 'The webhook POSTs mention.created, signed X-Soulia-Signature = sha256=HMAC(secret, body).')}</p>
    </details>`;
  }

  // ── Dialog ───────────────────────────────────────────────────────────────────────────────────
  function dialog(html, onReady) {
    let dlg = document.getElementById('apx-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'apx-dialog';
      dlg.className = 'apx-dialog';
      document.body.appendChild(dlg);
      dlg.addEventListener('click', (e) => { if (e.target === dlg && !dlg.dataset.lock) dlg.close(); });
      dlg.addEventListener('cancel', (e) => { if (dlg.dataset.lock) e.preventDefault(); });
      dlg.addEventListener('close', () => { dlg.innerHTML = ''; delete dlg.dataset.lock; });
      const box = () => dlg.querySelector('.apx-tipbox');
      const hideTip = () => { const b = box(); if (b) b.hidden = true; dlg.querySelectorAll('.apx-tip.is-open').forEach((t) => t.classList.remove('is-open')); };
      const showTip = (t) => {
        const b = box(); if (!b || !t.dataset.tip) return;
        hideTip(); t.classList.add('is-open');
        b.textContent = t.dataset.tip; b.hidden = false;
        // Fixed and clamped to the screen: the card scrolls, so an absolute bubble would be cut at its edge.
        const r = t.getBoundingClientRect(); const w = b.offsetWidth; const h = b.offsetHeight;
        const vw = document.documentElement.clientWidth; const vh = window.innerHeight;
        const rtl = dlg.dir === 'rtl';
        let left = rtl ? r.right - w : r.left; left = Math.max(8, Math.min(left, vw - w - 8));
        let top = r.bottom + 6; if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
        b.style.left = left + 'px'; b.style.top = top + 'px';
      };
      dlg.addEventListener('mouseover', (e) => { const t = e.target.closest('.apx-tip'); if (t) showTip(t); });
      dlg.addEventListener('mouseout', (e) => { const t = e.target.closest('.apx-tip'); if (t && !t.contains(e.relatedTarget) && document.activeElement !== t) hideTip(); });
      dlg.addEventListener('focusin', (e) => { const t = e.target.closest('.apx-tip'); if (t) showTip(t); else hideTip(); });
      // A tap on the mark must not tick the checkbox or focus the field of its <label>. It always
      // opens (a touch tap fires mouseover first, so a toggle would close it at once); a tap
      // anywhere else closes it.
      dlg.addEventListener('click', (e) => { const t = e.target.closest('.apx-tip'); if (!t) { hideTip(); return; } e.preventDefault(); e.stopPropagation(); showTip(t); }, true);
      dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box() && !box().hidden) { e.preventDefault(); e.stopPropagation(); hideTip(); } else if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.apx-tip')) { e.preventDefault(); showTip(e.target.closest('.apx-tip')); } }, true);
      dlg.addEventListener('scroll', hideTip, true);
    }
    dlg.dir = L('rtl', 'ltr');
    dlg.innerHTML = `<div class="apx-dlg">${html}</div><div class="apx-tipbox" role="tooltip" hidden></div>`;
    if (!dlg.open) dlg.showModal();
    // The PIN cells are drawn by _pinSync; without it the field reads as empty until clicked.
    dlg.querySelectorAll('.pinbx-input').forEach((i) => { try { _pinSync(i); } catch (_) {} });
    const card = dlg.querySelector('.apx-dlg'); if (card) card.scrollTop = 0;
    // showModal focuses the first focusable element — a «!» mark would open its tip on its own.
    const first = dlg.querySelector('#apx-form input:not(.pinbx-input), #apx-pin');
    if (first) try { first.focus({ preventScroll: true }); } catch (_) {}
    onReady && onReady(dlg);
    return dlg;
  }
  const closeDialog = () => { const d = document.getElementById('apx-dialog'); if (d?.open) { delete d.dataset.lock; d.close(); } };

  function userOptions(selected) {
    const list = (typeof users !== 'undefined' && Array.isArray(users) ? users : []).filter((u) => u && u.isActive !== false);
    return `<option value="">${L('— اختر الحساب —', '— Choose an account —')}</option>` + list.map((u) => {
      const id = String(u._id || u.id || '');
      return `<option value="${E(id)}" ${id === selected ? 'selected' : ''}>${E(u.name || u.username)}${u.username ? ` (@${E(u.username)})` : ''}</option>`;
    }).join('');
  }
  const toLocalInput = (v) => { if (!v) return ''; const d = new Date(v); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

  const SCOPE_HELP = {
    orders: ['قائمة الأوردرات وتفاصيل كل أوردر: العميل، الأصناف، الإجمالي، العربون، وحالة التأكيد.', 'Order list and details: customer, items, total, deposit and confirmation state.'],
    shipping: ['حالة الشحنة ورقم التتبع، ومحاولات التسليم الفاشلة وسببها، والشحنات الراجعة.', 'Parcel status and tracking, failed delivery attempts and their reason, returns.'],
    followups: ['المتابعات المفتوحة والمغلقة، والمسؤول عنها، وكل الملاحظات المكتوبة فيها.', 'Open and closed follow-ups, who owns them, and every note in them.'],
    'followups-write': ['إضافة ملاحظة على متابعة باسم الحساب المختار. هذه هي الكتابة الوحيدة الممكنة.', 'Add a note to a follow-up as the chosen account. The only write possible.'],
    mentions: ['ردود الموظفين على ملاحظات الحساب، وأي منشن موجّه إليه، ليرد عليها.', 'Employee replies to the account notes and mentions of it, so it can answer.'],
    complaints: ['الشكاوى بتصنيفها وحالتها وأولويتها، والإجراء المتخذ فيها.', 'Complaints with their category, status, priority and the action taken.'],
    inventory: ['الكميات الصالحة للبيع والمحجوزة والواردة لكل منتج، بدون أي أسعار.', 'Ready, reserved and incoming quantities per product — no prices.'],
    reports: ['أرقام مبيعات يوم واحد وأوردرات Shopify الواردة فيه، بدون الأرباح.', 'One day of sales figures and incoming Shopify orders — no profit.'],
  };
  const PHONE_HELP = {
    detail: ['القوائم تُظهر الرقم مخفيًا (010•••••678)، وتفاصيل الأوردر الواحد تُظهره كاملًا للتواصل مع العميل.', 'Lists show 010•••••678; a single order shows the full number to contact the customer.'],
    masked: ['الرقم يظهر مخفيًا في كل مكان، فلا يستطيع التطبيق الاتصال بالعميل.', 'Masked everywhere, so the app cannot contact the customer.'],
    full: ['الرقم يظهر كاملًا في القوائم والتفاصيل. استخدمه فقط إذا كان التطبيق يحتاج كل الأرقام.', 'Full in lists and details. Use only if the app needs every number.'],
  };
  /** A «!» mark beside a label; its text shows on hover, focus or tap (apx-tipbox, see dialog()). */
  const tip = (ar, en, id) => `<span class="apx-tip" tabindex="0" role="button" aria-label="${E(L(ar, en))}" data-tip="${E(L(ar, en))}"${id ? ` id="${id}"` : ''}>!</span>`;

  function keyForm(k) {
    const isNew = !k;
    const pin = isNew ? ['', ''] : [' يتطلب الرقم السري عند تغييره.', ' Needs the PIN to change.'];
    const lbl = (ar, en, tAr, tEn, id) => `<span class="apx-lbl">${E(L(ar, en))}${tip(tAr, tEn, id)}</span>`;
    const scopes = (state.data.scopes || []).map((s) => {
      const h = SCOPE_HELP[s.code] || ['', ''];
      const on = isNew ? !s.write : k.scopes.includes(s.code);
      return `<label class="apx-check ${s.write ? 'is-write' : ''}"><input type="checkbox" name="scope" value="${s.code}" ${on ? 'checked' : ''}>
        <span>${E(L(s.ar, s.en))}</span>${s.write ? `<em>${L('كتابة', 'write')}</em>` : ''}${tip(h[0], h[1])}</label>`;
    }).join('');
    const phone = k?.phoneAccess || 'detail';
    return `
      <header class="apx-dlg-head">
        <h3>${isNew ? L('مفتاح API جديد', 'New API key') : L(`إعدادات «${k.name}»`, `«${k.name}» settings`)}</h3>
        <p>${isNew ? L('المفتاح يسمح لتطبيق خارجي مثل Instinct بالوصول إلى الأقسام التي تختارها فقط، ويظهر مرة واحدة بعد الإنشاء.', 'The key lets an outside app such as Instinct reach only the sections you choose. It is shown once after it is created.') : L('التعديلات تسري من الطلب التالي مباشرة.', 'Changes apply from the next request.')}</p>
      </header>
      <form id="apx-form" autocomplete="off">
        <div class="apx-grid">
          <label class="apx-field">${lbl('اسم المفتاح', 'Key name', 'اسم يميّز المفتاح في اللوحة وسجل الطلبات، مثل اسم التطبيق. لا يغيّر أي صلاحية.', 'Identifies the key in the panel and the log, e.g. the app name. Grants nothing.')}
            <input name="name" maxlength="60" value="${E(k?.name || 'Instinct')}" required></label>
          <label class="apx-field">${lbl('يكتب باسم الحساب', 'Writes as account', 'الحساب الذي تظهر به ملاحظات المتابعة، وتصل إليه ردود الموظفين والمنشن. اختر الحساب الذي أنشأته لـ Instinct.' + pin[0], 'Follow-up notes appear under this account, and replies and mentions to it reach the app. Pick the account made for Instinct.' + pin[1])}
            <select name="linkedUserId" required>${userOptions(k?.linkedUserId || '')}</select></label>
        </div>
        ${isNew ? `<fieldset class="apx-field"><legend>${lbl('الأقسام المسموحة', 'Allowed sections', 'ما يستطيع المفتاح الوصول إليه. لا يوجد أي حذف أو تعديل أو إلغاء لأوردر عبر الـ API، ويمكن تشغيل أي قسم أو إيقافه لاحقًا من بطاقة المفتاح.', 'What the key can reach. Nothing can delete, edit or cancel an order through the API; each section can be switched later from the key card.')}</legend>
          <div class="apx-checks">${scopes}</div></fieldset>` : ''}
        <div class="apx-grid">
          <label class="apx-field">${lbl('حد الطلبات في الدقيقة', 'Requests per minute', 'أقصى عدد طلبات يرسلها التطبيق في الدقيقة (10–600). ما يزيد يُرفض مؤقتًا حتى ينتظر. القيمة 120 تكفي للمتابعة المعتادة.', 'Most requests the app may send per minute (10–600). Beyond it, requests are refused until it waits. 120 suits normal follow-up.')}
            <input name="rateLimit" type="number" min="10" max="600" value="${E(k?.rateLimit || 120)}"></label>
          <label class="apx-field">${lbl('أرقام تليفونات العملاء', 'Customer phone numbers', PHONE_HELP[phone][0], PHONE_HELP[phone][1], 'apx-phone-hint')}
            <select name="phoneAccess" data-apx-phone>${['detail', 'masked', 'full'].map((v) => `<option value="${v}" ${phone === v ? 'selected' : ''}>${E(phoneLabel(v))}</option>`).join('')}</select></label>
        </div>
        <div class="apx-grid">
          <label class="apx-field">${lbl('عناوين IP المسموحة', 'Allowed IP addresses', 'إذا أعطتك Instinct عناوين خوادمها فاكتبها هنا مفصولة بفاصلة، فلا يعمل المفتاح من أي مكان آخر حتى لو تسرّب. اتركه فارغًا للسماح بأي عنوان.' + pin[0], 'If Instinct gives you its server addresses, list them here (comma-separated) so the key works nowhere else, even if leaked. Empty allows any address.' + pin[1])}
            <input name="ipAllowlist" dir="ltr" placeholder="${E(L('فارغ = أي عنوان', 'Empty = any address'))}" value="${E((k?.ipAllowlist || []).join(', '))}"></label>
          <label class="apx-field">${lbl('تاريخ انتهاء المفتاح', 'Key expiry', 'يتوقف المفتاح تلقائيًا في هذا الموعد، وهذا مفيد لفترة تجربة أو عقد محدد المدة. اتركه فارغًا ليعمل حتى تلغيه.' + pin[0], 'The key stops by itself at this time — useful for a trial or a fixed-term contract. Empty = works until revoked.' + pin[1])}
            <input name="expiresAt" type="datetime-local" value="${E(toLocalInput(k?.expiresAt))}"></label>
        </div>
        <label class="apx-field">${lbl('رابط Webhook للمنشن (اختياري)', 'Mention webhook URL (optional)', 'إذا أعطتك Instinct رابطًا، يرسل له النظام كل رد أو منشن خلال 15 ثانية من حدوثه، موقّعًا بسر يظهر لك مرة واحدة. اتركه فارغًا ليسأل التطبيق بنفسه كل دقيقة.' + pin[0], 'If Instinct gives you a URL, every reply or mention is sent to it within 15 seconds, signed with a secret shown once. Empty = the app asks every minute.' + pin[1])}
          <input name="webhookUrl" dir="ltr" placeholder="https://…" value="${E(k?.webhookUrl || '')}"></label>
        <div class="apx-field apx-pin">${isNew
          ? lbl('الرقم السري للنظام', 'System PIN', 'للتأكد من أنك مدير النظام. مطلوب لإنشاء المفتاح.', 'Confirms you are the admin. Needed to create the key.')
          : lbl('الرقم السري للنظام', 'System PIN', 'مطلوب فقط إذا غيّرت الحساب أو عناوين IP أو تاريخ الانتهاء أو رابط الـ Webhook.', 'Needed only if you change the account, IP addresses, expiry or webhook URL.')}
          ${pinBoxesHtml('apx-pin', { start: true })}</div>
        <p class="apx-form-err" role="alert" hidden></p>
        <div class="apx-dlg-actions">
          <button type="button" class="btn btn-outline" data-apx-close>${L('إلغاء', 'Cancel')}</button>
          <button type="submit" class="btn btn-primary">${isNew ? L('إنشاء المفتاح', 'Create key') : L('حفظ', 'Save')}</button>
        </div>
      </form>`;
  }

  function readForm(form, k) {
    const fd = new FormData(form);
    const body = {
      name: String(fd.get('name') || ''),
      linkedUserId: String(fd.get('linkedUserId') || ''),
      rateLimit: Number(fd.get('rateLimit')) || 120,
      phoneAccess: String(fd.get('phoneAccess') || 'detail'),
      ipAllowlist: String(fd.get('ipAllowlist') || '').split(/[\s,،]+/).filter(Boolean),
      expiresAt: fd.get('expiresAt') ? new Date(String(fd.get('expiresAt'))).toISOString() : null,
      webhookUrl: String(fd.get('webhookUrl') || '').trim(),
      pin: String(document.getElementById('apx-pin')?.value || ''),
    };
    if (!k) { body.scopes = fd.getAll('scope').map(String); return body; }
    // Send only what changed, so an untouched sensitive field never asks for the PIN.
    const out = { pin: body.pin };
    if (body.name !== k.name) out.name = body.name;
    if (body.linkedUserId !== k.linkedUserId) out.linkedUserId = body.linkedUserId;
    if (body.rateLimit !== k.rateLimit) out.rateLimit = body.rateLimit;
    if (body.phoneAccess !== (k.phoneAccess || 'detail')) out.phoneAccess = body.phoneAccess;
    if (body.ipAllowlist.join(',') !== (k.ipAllowlist || []).join(',')) out.ipAllowlist = body.ipAllowlist;
    const prevExp = k.expiresAt ? new Date(k.expiresAt).toISOString().slice(0, 16) : '';
    const nextExp = body.expiresAt ? body.expiresAt.slice(0, 16) : '';
    if (prevExp !== nextExp) out.expiresAt = body.expiresAt;
    if (body.webhookUrl !== (k.webhookUrl || '')) out.webhookUrl = body.webhookUrl;
    return out;
  }

  function openForm(k) {
    dialog(keyForm(k), (dlg) => {
      dlg.dataset.lock = '1';
      const form = dlg.querySelector('#apx-form');
      dlg.querySelector('[data-apx-close]').onclick = closeDialog;
      const ph = form.querySelector('[data-apx-phone]');
      ph.onchange = () => { const h = PHONE_HELP[ph.value]; const el = form.querySelector('#apx-phone-hint'); if (h && el) { el.dataset.tip = L(h[0], h[1]); el.setAttribute('aria-label', L(h[0], h[1])); } };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const err = form.querySelector('.apx-form-err');
        const btn = form.querySelector('[type=submit]');
        const body = readForm(form, k);
        if (!k && !body.scopes.length) { err.textContent = L('اختر قسمًا واحدًا على الأقل.', 'Choose at least one section.'); err.hidden = false; return; }
        btn.disabled = true; err.hidden = true;
        try {
          const res = k ? await api(`/api-keys/${k.id}`, { method: 'PATCH', body: JSON.stringify(body) })
            : await api('/api-keys', { method: 'POST', body: JSON.stringify(body) });
          await load(); draw();
          if (!k || res.webhookSecret) reveal(res.key, res.webhookSecret, res.item);
          else { closeDialog(); toast(L('تم حفظ إعدادات المفتاح', 'Key settings saved')); }
        } catch (ex) {
          err.textContent = ex?.message || L('تعذّر الحفظ', 'Could not save'); err.hidden = false;
          if (/الرقم السري|PIN/i.test(ex?.message || '') && typeof _pinState === 'function') _pinState('apx-pin', 'err');
        } finally { btn.disabled = false; }
      };
    });
  }

  function reveal(key, secret, item) {
    const base = location.origin + '/api/v1';
    dialog(`
      <h3>${key ? L('انسخ المفتاح الآن', 'Copy the key now') : L('سر الـ Webhook الجديد', 'New webhook secret')}</h3>
      <p class="apx-warn">${L('لن يظهر هذا مرة أخرى. احفظه في إعدادات Instinct مباشرة؛ إذا ضاع جدّد المفتاح.', 'It will not be shown again. Paste it into Instinct now; if it is lost, rotate the key.')}</p>
      ${key ? `<label class="apx-field"><span>${L('مفتاح API', 'API key')} · ${E(item?.name || '')}</span><div class="apx-secret"><code dir="ltr">${E(key)}</code><button class="btn btn-outline btn-sm" data-copy="${E(key)}">${ICON.copy}<span>${L('نسخ', 'Copy')}</span></button></div></label>` : ''}
      ${secret ? `<label class="apx-field"><span>${L('سر توقيع الـ Webhook', 'Webhook signing secret')}</span><div class="apx-secret"><code dir="ltr">${E(secret)}</code><button class="btn btn-outline btn-sm" data-copy="${E(secret)}">${ICON.copy}<span>${L('نسخ', 'Copy')}</span></button></div></label>` : ''}
      ${key ? `<pre dir="ltr">curl -H "X-API-Key: ${E(key)}" "${E(base)}/me"</pre>` : ''}
      <div class="apx-dlg-actions"><button class="btn btn-primary" data-apx-close>${L('حفظته', 'I saved it')}</button></div>`, (dlg) => {
      dlg.dataset.lock = '1';
      dlg.querySelector('[data-apx-close]').onclick = closeDialog;
      dlg.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy, b)));
    });
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove();
    }
    const span = btn.querySelector('span'); if (span) { const t = span.textContent; span.textContent = L('تم النسخ', 'Copied'); setTimeout(() => (span.textContent = t), 1400); }
  }

  function askPin(title, text, confirmLabel, danger, run) {
    dialog(`
      <h3>${E(title)}</h3><p>${text}</p>
      <div class="apx-field apx-pin"><span>${L('الرقم السري للنظام', 'System PIN')}</span>${pinBoxesHtml('apx-pin', { start: true })}</div>
      <p class="apx-form-err" role="alert" hidden></p>
      <div class="apx-dlg-actions"><button class="btn btn-outline" data-apx-close>${L('إلغاء', 'Cancel')}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-apx-ok>${E(confirmLabel)}</button></div>`, (dlg) => {
      dlg.querySelector('[data-apx-close]').onclick = closeDialog;
      const ok = dlg.querySelector('[data-apx-ok]'); const err = dlg.querySelector('.apx-form-err');
      ok.onclick = async () => {
        ok.disabled = true; err.hidden = true;
        try { await run(String(document.getElementById('apx-pin')?.value || '')); }
        catch (ex) { err.textContent = ex?.message || 'error'; err.hidden = false; if (typeof _pinState === 'function') _pinState('apx-pin', 'err'); }
        finally { ok.disabled = false; }
      };
      setTimeout(() => document.getElementById('apx-pin')?.focus(), 30);
    });
  }

  const findKey = (id) => (state.data?.keys || []).find((k) => k.id === id);

  async function act(name, el) {
    const id = el.dataset.id; const k = id ? findKey(id) : null;
    try {
      if (name === 'reload') return render(true);
      if (name === 'new') return openForm(null);
      if (name === 'edit') return openForm(k);
      if (name === 'master') {
        const on = el.checked;
        if (!on) {
          const yes = await showConfirm(L('سيتوقف كل مفتاح API فورًا ويُرفض أي طلب حتى تعيد التشغيل. المتابعة؟', 'Every API key stops at once and every request is refused until you switch it back on. Continue?'), { title: L('إيقاف الوصول عبر API', 'Stop API access'), danger: true, confirmLabel: L('إيقاف الكل', 'Stop all') });
          if (!yes) { el.checked = true; return; }
        }
        await api('/api-keys/enabled', { method: 'POST', body: JSON.stringify({ enabled: on }) });
        toast(on ? L('تم تشغيل الوصول عبر API', 'API access is on') : L('تم إيقاف الوصول عبر API بالكامل', 'API access stopped'));
        await load(); return draw();
      }
      if (name === 'pause' || name === 'resume') {
        await api(`/api-keys/${id}/${name}`, { method: 'POST' });
        toast(name === 'pause' ? L(`أُوقف «${k.name}» — يُرفض أي طلب به الآن`, `«${k.name}» paused`) : L(`عاد «${k.name}» للعمل`, `«${k.name}» resumed`));
        await load(); return draw();
      }
      if (name === 'scope') {
        const code = el.dataset.scope;
        const next = k.scopes.includes(code) ? k.scopes.filter((s) => s !== code) : [...k.scopes, code];
        if (!next.length) return toast(L('يجب أن يبقى قسم واحد على الأقل — أو أوقف المفتاح مؤقتًا', 'Keep at least one section — or pause the key'), true);
        el.disabled = true;
        await api(`/api-keys/${id}`, { method: 'PATCH', body: JSON.stringify({ scopes: next }) });
        await load(); draw();
        return toast(next.includes(code) ? L(`فُتح قسم «${scopeLabel(code)}»`, `«${scopeLabel(code)}» enabled`) : L(`أُغلق قسم «${scopeLabel(code)}»`, `«${scopeLabel(code)}» disabled`));
      }
      if (name === 'rotate') {
        return askPin(L('تجديد المفتاح', 'Rotate key'), L(`سيتوقف المفتاح الحالي لـ «${E(k.name)}» فورًا ويظهر مفتاح جديد مرة واحدة. حدّثه في Instinct مباشرة.`, `The current key of «${E(k.name)}» stops at once and a new key is shown once.`), L('تجديد', 'Rotate'), false, async (pin) => {
          const res = await api(`/api-keys/${id}/rotate`, { method: 'POST', body: JSON.stringify({ pin }) });
          await load(); draw(); reveal(res.key, null, res.item);
        });
      }
      if (name === 'revoke') {
        return askPin(L('إلغاء المفتاح نهائيًا', 'Revoke key'), L(`لن يعمل «${E(k.name)}» مرة أخرى ولا يمكن إرجاعه. للإيقاف المؤقت استخدم «إيقاف مؤقت».`, `«${E(k.name)}» will never work again. To stop it for now, use Pause.`), L('إلغاء نهائي', 'Revoke'), true, async (pin) => {
          await api(`/api-keys/${id}/revoke`, { method: 'POST', body: JSON.stringify({ pin }) });
          closeDialog(); toast(L('تم إلغاء المفتاح', 'Key revoked')); await load(); draw();
        });
      }
      if (name === 'test-hook') {
        el.disabled = true;
        const r = await api(`/api-keys/${id}/test-webhook`, { method: 'POST' });
        toast(r.ok ? L('وصلت رسالة التجربة إلى الـ Webhook', 'Test delivered') : L(`فشل الإرسال: ${r.error}`, `Delivery failed: ${r.error}`), !r.ok);
        await load(); return draw();
      }
      if (name === 'log-refresh') { await loadLog(); return draw(); }
      if (name === 'log-prev' || name === 'log-next') { state.logFilter.page += name === 'log-next' ? 1 : -1; await loadLog(); return draw(); }
    } catch (ex) {
      toast(ex?.message || L('تعذّر تنفيذ الطلب', 'Request failed'), true);
      if (name === 'master') el.checked = !el.checked;
      el.disabled = false;
    }
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('#api-access-root [data-apx]');
    if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
    e.preventDefault(); act(el.dataset.apx, el);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('#api-access-root [data-apx]');
    if (!el) return;
    const n = el.dataset.apx;
    if (n === 'master') return act('master', el);
    const map = { 'log-key': 'keyId', 'log-result': 'result', 'log-method': 'method' };
    if (map[n]) { state.logFilter[map[n]] = el.value; state.logFilter.page = 1; loadLog().then(draw); }
  });

  window.SouliaApiAccess = {
    render,
    /** For the provider tab badge: 'connected' | 'unconfigured' | 'disconnected' | 'error'. */
    async connectionState() {
      try {
        const d = await api('/api-keys', { deduplicate: false });
        state.data = d;
        if (!d.enabled) return 'disconnected';
        return d.keys.some((k) => k.status === 'active' && !k.expired) ? 'connected' : 'unconfigured';
      } catch { return 'error'; }
    },
  };
})();
