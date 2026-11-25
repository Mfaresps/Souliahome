/* Bulk-browsing protection, page side (Nov 25, 2026). Server: backend/src/browse-access/.
   · SouliaBrowseAccess.load()        → GET /browse-access/mine (permission / grant / pending per scope)
   · SouliaBrowseAccess.can(scope)    → permission or an unexpired manager grant
   · SouliaBrowseAccess.lock(scope)   → the lock window: «صفحات محمية» + «طلب صلاحية التصفح»
   · SouliaBrowseAccess.renderAdmin() → «طلبات تصفح البيانات» on the approvals page (admins)
   Scopes: 'movements' and 'inventory-log' (first 5 pages free), 'clients' (first page free). */
(function () {
  'use strict';
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const tr = (a, e) => (en() ? e : a);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const PERM = { movements: 'movements-browse', clients: 'clients-browse', 'inventory-log': 'inventory-log-browse' };
  const LABEL = { movements: ['سجل المعاملات', 'the transactions log'], clients: ['قائمة العملاء', 'the client list'], 'inventory-log': ['سجل حركة المخزون', 'the stock movement log'] };
  let state = {};
  let loading = null;

  function load() {
    if (typeof api !== 'function' || typeof currentUser === 'undefined' || !currentUser) return Promise.resolve(state);
    if (loading) return loading;
    loading = api('/browse-access/mine').then(r => { state = r || {}; return state; }).catch(() => state).finally(() => { loading = null; });
    return loading;
  }
  function can(scope) {
    if (typeof isAdmin === 'function' && isAdmin()) return true;
    if (typeof hasPerm === 'function' && hasPerm(PERM[scope])) return true;
    const g = state[scope]?.grantUntil;
    return !!g && new Date(g).getTime() > Date.now();
  }
  function freePages(scope) { return state[scope]?.freePages || (scope === 'clients' ? 1 : 5); }

  /* The lock window. Resolves when closed. */
  async function lock(scope) {
    await load();
    if (can(scope)) return true;
    const pending = !!state[scope]?.pending;
    const pages = freePages(scope);
    const what = LABEL[scope][en() ? 1 : 0];
    return new Promise(resolve => {
      const d = document.createElement('dialog');
      d.className = 'bra-dlg'; d.dir = en() ? 'ltr' : 'rtl';
      d.innerHTML = `<div class="bra-card">
        <div class="bra-ico">${LOCK}</div>
        <h3>${tr('صفحات محمية', 'Protected pages')}</h3>
        <p>${en()
          ? `To protect data privacy you can browse the first ${pages === 1 ? 'page' : pages + ' pages'} of ${what} only. To reach a specific record, use search — or ask a manager for browsing access.`
          : `حفاظًا على خصوصية البيانات، يمكنك تصفّح ${pages === 1 ? 'الصفحة الأولى' : 'أول ' + pages + ' صفحات'} فقط من ${what}. للوصول إلى سجل محدد استخدم البحث، أو اطلب صلاحية التصفح من المدير.`}</p>
        ${pending
          ? `<div class="bra-pending">${tr('طلبك بانتظار موافقة المدير. ستصلك رسالة عند الرد.', 'Your request is waiting for a manager. You will be notified.')}</div>`
          : `<label class="bra-reason"><span>${tr('سبب الطلب (اختياري)', 'Reason (optional)')}</span><textarea maxlength="300" rows="2" placeholder="${tr('مثال: مراجعة طلبات الشهر الماضي', 'e.g. reviewing last month’s orders')}"></textarea></label>`}
        <div class="bra-foot">
          <button type="button" class="btn btn-outline btn-sm" data-act="close">${tr('إغلاق', 'Close')}</button>
          <button type="button" class="btn btn-outline btn-sm" data-act="search">${tr('ابحث', 'Search')}</button>
          ${pending ? '' : `<button type="button" class="btn btn-primary btn-sm" data-act="request">${LOCK}<span>${tr('طلب صلاحية التصفح', 'Request browsing access')}</span></button>`}
        </div></div>`;
      document.body.append(d);
      const finish = v => { try { d.close(); } catch (_) {} d.remove(); resolve(v); };
      d.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
      d.addEventListener('click', async e => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'close') finish(false);
        else if (b.dataset.act === 'search') {
          finish(false);
          const box = document.querySelector(scope === 'clients' ? '#clients-search' : scope === 'inventory-log' ? '#invLog-search-input' : '#mov-search');
          if (box) { box.focus(); box.select?.(); }
        } else if (b.dataset.act === 'request') {
          b.disabled = true;
          try {
            await api('/browse-access/request', { method: 'POST', body: JSON.stringify({ scope, reason: d.querySelector('textarea')?.value || '' }) });
            state[scope] = { ...(state[scope] || {}), pending: true };
            if (typeof toast === 'function') toast(tr('أُرسل طلبك إلى المدير', 'Your request was sent to a manager'));
            finish(false);
          } catch (err) { b.disabled = false; if (typeof toast === 'function') toast(err?.message || tr('تعذّر إرسال الطلب', 'Could not send the request'), true); }
        }
      });
      d.showModal();
    });
  }

  /* Approvals page: pending browsing requests, approve for 1 / 8 / 24 h or reject. */
  async function renderAdmin() {
    const host = document.getElementById('appr-browse-requests');
    if (!host) return;
    if (!(typeof isAdmin === 'function' && isAdmin())) { host.innerHTML = ''; return; }
    let rows = [];
    try { rows = await api('/browse-access/pending'); } catch (_) { host.innerHTML = ''; return; }
    if (!rows.length) { host.innerHTML = ''; return; }
    const when = v => { try { return new Date(v).toLocaleString(en() ? 'en-GB' : 'ar-EG-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return ''; } };
    host.innerHTML = `<section class="bra-admin"><h3>${LOCK}<span>${tr('طلبات تصفح البيانات', 'Data browsing requests')}</span><b>${rows.length}</b></h3>
      ${rows.map(r => `<div class="bra-row" data-id="${esc(r.id)}">
        <div class="bra-who"><strong>${esc(r.userName || '—')}</strong><span>${esc(tr('يطلب تصفح ', 'asks to browse ') + (en() ? LABEL[r.scope]?.[1] || r.scope : r.scopeLabel))} · ${esc(when(r.createdAt))}</span>${r.reason ? `<em dir="auto">${esc(r.reason)}</em>` : ''}</div>
        <div class="bra-acts">
          ${[1, 8, 24].map(h => `<button type="button" class="btn btn-sm btn-outline" data-approve="${h}">${en() ? `Allow ${h}h` : `سماح ${h === 1 ? 'ساعة' : h <= 10 ? h + ' ساعات' : h + ' ساعة'}`}</button>`).join('')}
          <button type="button" class="btn btn-sm bra-reject" data-reject>${tr('رفض', 'Reject')}</button>
        </div></div>`).join('')}</section>`;
    host.onclick = async e => {
      const b = e.target.closest('[data-approve],[data-reject]'); if (!b) return;
      const id = b.closest('.bra-row')?.dataset.id; if (!id) return;
      b.disabled = true;
      try {
        await api(`/browse-access/${encodeURIComponent(id)}/${b.dataset.reject !== undefined ? 'reject' : 'approve'}`, { method: 'POST', body: JSON.stringify({ hours: Number(b.dataset.approve) || 1 }) });
        if (typeof toast === 'function') toast(b.dataset.reject !== undefined ? tr('رُفض الطلب', 'Request rejected') : tr('تمت الموافقة', 'Approved'));
        renderAdmin();
      } catch (err) { b.disabled = false; if (typeof toast === 'function') toast(err?.message || '', true); }
    };
  }

  window.SouliaBrowseAccess = { load, can, lock, renderAdmin, freePages };
})();
