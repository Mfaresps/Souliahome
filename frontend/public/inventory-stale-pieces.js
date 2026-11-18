/**
 * Review pieces stuck on «مُجهزة» (Nov 15, 2026) — admin only.
 * Lists every prepared piece whose order already left (GET /inventory-units/stale-prepared), with the
 * piece's date, its order and its last history entry. Nothing changes until the admin ticks pieces and
 * approves: each approved piece is corrected on its own (POST /inventory-units/stale-prepared/correct),
 * re-checked by the server, and written into the piece's history. Backend: stale-prepared.util.ts.
 */
(function () {
  'use strict';
  const tr = (en, ar) => (typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar);
  const e = v => (typeof esc === 'function' ? esc(v) : String(v ?? ''));
  const n = v => (typeof fmtN === 'function' ? fmtN(v) : String(v));
  const PAGE = 50;
  const st = { confirming: false, data: null, filter: 'all', q: '', page: 1, selected: new Set(), busy: false, count: null, countAt: 0, result: null };
  const isAdminUser = () => typeof isAdmin === 'function' && isAdmin();

  const PROPOSAL = { delivered: ['Delivered', 'تم التسليم'], shipped: ['With the carrier', 'مع شركة الشحن'] };
  const REVIEW = {
    'order-returned': ['Order returned — check where the piece is', 'الطلب مرتجع — تحقّق من مكان القطعة'],
    'order-cancelled': ['Order cancelled — check where the piece is', 'الطلب ملغى — تحقّق من مكان القطعة'],
    'order-missing': ['Order not found', 'الطلب غير موجود'],
    'line-missing': ['Order line changed', 'سطر الطلب تغيّر'],
  };
  const EVENTS = { prepared: ['Prepared', 'تجهيز'], 'picking-started': ['Picking started', 'بدء التحضير'], reserved: ['Reserved', 'حجز'],
    'scan-validated': ['Barcode verified', 'التحقق من الباركود'], 'label-printed': ['Label printed', 'طباعة ملصق'],
    'label-print-requested': ['Label print requested', 'طلب طباعة ملصق'], registered: ['Registered', 'تسجيل القطعة'] };
  const date = v => {
    if (!v) return '—';
    const d = new Date(v); if (isNaN(d)) return e(String(v).slice(0, 10));
    return e(d.toLocaleDateString(tr('en-GB', 'ar-EG-u-nu-latn'), { day: 'numeric', month: 'short', year: 'numeric' }));
  };
  const el = id => document.getElementById(id);

  function rows() {
    const list = st.data?.rows || [];
    const q = (typeof normalizeUiSearch === 'function' ? normalizeUiSearch(st.q) : st.q.toLowerCase()).trim();
    return list.filter(r => {
      if (st.filter === 'delivered' && r.proposal !== 'delivered') return false;
      if (st.filter === 'shipped' && r.proposal !== 'shipped') return false;
      if (st.filter === 'review' && r.proposal) return false;
      if (!q) return true;
      const blob = [r.manualCode, r.barcode, r.product.name, r.product.code, r.order?.ref, r.order?.client].join(' ');
      return (typeof normalizeUiSearch === 'function' ? normalizeUiSearch(blob) : blob.toLowerCase()).includes(q);
    });
  }

  function orderState(o) {
    if (!o) return '—';
    const parts = [o.pickupStatus, o.bostaStatus].filter(Boolean).map(e);
    const when = o.deliveredAt ? `${tr('Delivered', 'سُلّم')} ${date(o.deliveredAt)}` : o.shippedAt ? `${tr('Shipped', 'شُحن')} ${date(o.shippedAt)}` : '';
    return `${parts.join(' · ')}${when ? `<small>${when}</small>` : ''}`;
  }

  function render() {
    const host = el('isp-body'); if (!host) return;
    if (!st.data) { host.innerHTML = `<p class="isp-empty">${e(tr('Loading…', 'جارٍ التحميل…'))}</p>`; return; }
    const s = st.data.summary, list = rows(), pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (st.page > pages) st.page = pages;
    const view = list.slice((st.page - 1) * PAGE, st.page * PAGE);
    const tab = (key, label, count) => `<button type="button" class="isp-tab${st.filter === key ? ' is-on' : ''}" data-isp-filter="${key}">${e(label)} <b>${n(count)}</b></button>`;
    const selectable = list.filter(r => r.proposal);
    const allOnPage = view.filter(r => r.proposal);
    const pageChecked = allOnPage.length && allOnPage.every(r => st.selected.has(r.unitId));
    host.innerHTML = `
      <p class="isp-lead">${e(tr('These pieces still read «Prepared» although their order already left the warehouse. The proposed status comes from the order. Nothing changes until you tick pieces and approve; every correction is written into the piece history.',
        'هذه القطع ما زالت «مُجهزة» رغم أن طلباتها خرجت من المخزن. الحالة المقترحة مأخوذة من حالة الطلب. لن يتغير شيء حتى تحدد القطع وتعتمد، وكل تصحيح يُسجَّل في سجل القطعة.'))}</p>
      ${st.result ? `<div class="isp-result${st.result.failed.length ? ' has-fail' : ''}" role="status">${e(tr(`${st.result.done} corrected`, `تم تصحيح ${n(st.result.done)} قطعة`))}${st.result.failed.length ? ` · ${e(tr(`${st.result.failed.length} not corrected`, `لم تُصحَّح ${n(st.result.failed.length)}`))}<ul>${st.result.failed.slice(0, 10).map(f => `<li><bdi dir="ltr">${e(f.code)}</bdi> — ${e(f.error)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      <div class="isp-tabs">${tab('all', tr('All', 'الكل'), s.total)}${tab('delivered', tr(...PROPOSAL.delivered), s.delivered)}${tab('shipped', tr(...PROPOSAL.shipped), s.shipped)}${tab('review', tr('Needs a decision', 'تحتاج قرارًا'), s.review)}
        <input type="search" id="isp-q" class="isp-search" value="${e(st.q)}" placeholder="${e(tr('Search piece, product, order…', 'بحث بالقطعة أو المنتج أو الطلب…'))}"></div>
      <div class="isp-table-wrap"><table class="isp-table"><thead><tr>
        <th><input type="checkbox" id="isp-page-check" ${pageChecked ? 'checked' : ''} ${allOnPage.length ? '' : 'disabled'} aria-label="${e(tr('Select page', 'تحديد الصفحة'))}"></th>
        <th>${e(tr('Piece', 'القطعة'))}</th><th>${e(tr('Product', 'المنتج'))}</th><th>${e(tr('Order', 'الطلب'))}</th>
        <th>${e(tr('Order status', 'حالة الطلب'))}</th><th>${e(tr('Piece date', 'تاريخ القطعة'))}</th>
        <th>${e(tr('Last movement', 'آخر حركة'))}</th><th>${e(tr('Proposed', 'التصحيح المقترح'))}</th></tr></thead><tbody>
        ${view.map(r => `<tr class="${r.proposal ? '' : 'is-review'}">
          <td>${r.proposal ? `<input type="checkbox" data-isp-pick="${e(r.unitId)}" ${st.selected.has(r.unitId) ? 'checked' : ''} aria-label="${e(r.manualCode || r.barcode)}">` : ''}</td>
          <td><bdi dir="ltr" class="isp-code">${e(r.manualCode || r.barcode)}</bdi><small>${e(r.warehouseCode)}</small></td>
          <td>${e(r.product.name)}<small><bdi dir="ltr">${e(r.product.code)}</bdi></small></td>
          <td>${r.order ? `<button type="button" class="isp-link" data-isp-order="${e(r.order.id)}"><bdi dir="ltr">#${e(r.order.ref)}</bdi></button><small>${e(r.order.client)}</small>` : '—'}</td>
          <td>${orderState(r.order)}</td>
          <td>${date(r.registeredAt)}</td>
          <td>${r.lastEvent ? `${e(tr(...(EVENTS[r.lastEvent.action] || [r.lastEvent.action, r.lastEvent.action])))}<small>${date(r.lastEvent.at)}${r.lastEvent.by ? ' · ' + e(r.lastEvent.by) : ''}</small>` : '—'}</td>
          <td>${r.proposal ? `<span class="isp-prop">${e(tr('Prepared', 'مُجهزة'))} <span aria-hidden="true">${tr('→', '←')}</span> <b>${e(tr(...PROPOSAL[r.proposal]))}</b></span>` : `<span class="isp-review">${e(tr(...REVIEW[r.review]))}</span>`}</td>
        </tr>`).join('') || `<tr><td colspan="8" class="isp-empty">${e(tr('Nothing here.', 'لا توجد قطع هنا.'))}</td></tr>`}
      </tbody></table></div>
      ${pages > 1 ? `<div class="isp-pager"><button type="button" class="btn btn-outline btn-sm" data-isp-page="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''}>${e(tr('Previous', 'السابق'))}</button><span>${n(st.page)} / ${n(pages)}</span><button type="button" class="btn btn-outline btn-sm" data-isp-page="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''}>${e(tr('Next', 'التالي'))}</button>
        <button type="button" class="isp-link" data-isp-all="1">${e(tr(`Select all ${selectable.length} in this list`, `تحديد كل الـ${n(selectable.length)} في هذه القائمة`))}</button></div>` : ''}`;
    const sel = st.selected.size;
    el('isp-approve').disabled = !sel || st.busy;
    el('isp-approve').textContent = st.busy ? st.busyText : tr(`Approve correction (${sel})`, `اعتماد تصحيح المحدد (${n(sel)})`);
  }

  async function load() {
    st.data = null; render();
    try { st.data = await api('/inventory-units/stale-prepared'); st.count = st.data.summary.total; st.countAt = Date.now(); }
    catch (err) { el('isp-body').innerHTML = `<p class="isp-empty">${e(tr('Could not load: ', 'تعذر التحميل: ') + err.message)}</p><button type="button" class="btn btn-outline btn-sm" data-isp-retry="1">${e(tr('Retry', 'إعادة المحاولة'))}</button>`; return; }
    const known = new Set(st.data.rows.filter(r => r.proposal).map(r => r.unitId));
    for (const id of [...st.selected]) if (!known.has(id)) st.selected.delete(id);
    render(); refreshNotice();
  }

  async function approve() {
    const picked = (st.data?.rows || []).filter(r => r.proposal && st.selected.has(r.unitId));
    if (!picked.length || st.busy) return;
    const reason = el('isp-reason').value.trim();
    if (reason.length < 5) { el('isp-reason').focus(); el('isp-reason-err').hidden = false; return; }
    el('isp-reason-err').hidden = true;
    const delivered = picked.filter(r => r.proposal === 'delivered').length, shipped = picked.length - delivered;
    // Confirmed inside the dialog: a <dialog> sits in the top layer, above the app's showConfirm window.
    if (!st.confirming) {
      st.confirming = true;
      const box = el('isp-confirm');
      box.hidden = false;
      box.querySelector('p').textContent = tr(`Correct ${picked.length} pieces? To «Delivered»: ${delivered} · to «With the carrier»: ${shipped}. Stock, money and orders are not changed; each piece's history records this correction.`,
        `تصحيح ${n(picked.length)} قطعة؟ إلى «تم التسليم»: ${n(delivered)} · إلى «مع شركة الشحن»: ${n(shipped)}. لا يتغير الرصيد ولا الخزنة ولا الطلبات، ويُسجَّل التصحيح في سجل كل قطعة.`);
      box.querySelector('[data-isp-yes]').focus();
      return;
    }
    st.confirming = false; el('isp-confirm').hidden = true;
    st.busy = true; st.result = null;
    const failed = []; let done = 0;
    for (const [i, r] of picked.entries()) {
      st.busyText = tr(`Correcting ${i + 1} / ${picked.length}…`, `جارٍ التصحيح ${n(i + 1)} / ${n(picked.length)}…`); render();
      try {
        await api('/inventory-units/stale-prepared/correct', { method: 'POST', body: JSON.stringify({
          operationKey: `stale-${r.unitId}-${Date.now().toString(36)}`, reason, unitId: r.unitId, expectedVersion: r.version, target: r.proposal }) });
        done++; st.selected.delete(r.unitId);
      } catch (err) { failed.push({ code: r.manualCode || r.barcode, error: err.message }); }
    }
    st.busy = false; st.result = { done, failed };
    await load();
    window.InvOverview?.refreshSoon?.();
  }

  function ensureDialog() {
    if (el('isp-dialog')) return el('isp-dialog');
    const d = document.createElement('dialog');
    d.id = 'isp-dialog'; d.className = 'isp-dialog'; d.setAttribute('aria-labelledby', 'isp-title');
    d.innerHTML = `<header><h2 id="isp-title">${e(tr('Pieces stuck on «Prepared»', 'القطع العالقة على «مُجهزة»'))}</h2><button type="button" class="btn iu-icon-button" data-isp-close="1" aria-label="${e(tr('Close', 'إغلاق'))}">×</button></header>
      <div id="isp-body" class="isp-body"></div>
      <div id="isp-confirm" class="isp-confirm" role="alertdialog" hidden><p></p><button type="button" class="btn btn-outline btn-sm" data-isp-no="1">${e(tr('Back', 'رجوع'))}</button><button type="button" class="btn btn-primary btn-sm" data-isp-yes="1">${e(tr('Confirm correction', 'تأكيد التصحيح'))}</button></div>
      <footer><label class="isp-reason-field">${e(tr('Reason (saved in each piece history)', 'السبب (يُحفظ في سجل كل قطعة)'))}
        <input id="isp-reason" maxlength="300" value="${e(tr('Correction after reviewing the order status', 'تصحيح حالة القطعة بعد مراجعة حالة الطلب'))}"><span id="isp-reason-err" class="isp-err" hidden>${e(tr('Write a reason (5 characters at least).', 'اكتب السبب (5 أحرف على الأقل).'))}</span></label>
        <button type="button" class="btn btn-outline" data-isp-close="1">${e(tr('Close', 'إغلاق'))}</button>
        <button type="button" id="isp-approve" class="btn btn-primary" disabled></button></footer>`;
    document.body.appendChild(d);
    d.addEventListener('click', ev => {
      const t = ev.target.closest('button,input[type=checkbox]'); if (!t) return;
      if (t.dataset.ispClose) { if (!st.busy) d.close(); return; }
      if (t.dataset.ispFilter) { st.filter = t.dataset.ispFilter; st.page = 1; render(); return; }
      if (t.dataset.ispPage) { st.page = Number(t.dataset.ispPage); render(); return; }
      if (t.dataset.ispRetry) { load(); return; }
      if (t.dataset.ispAll) { rows().filter(r => r.proposal).forEach(r => st.selected.add(r.unitId)); render(); return; }
      if (t.dataset.ispOrder) { d.close(); if (typeof openOrderView === 'function') openOrderView(t.dataset.ispOrder); return; }
      if (st.confirming && !t.dataset.ispClose) { st.confirming = false; el('isp-confirm').hidden = true; }
      if (t.dataset.ispPick) { t.checked ? st.selected.add(t.dataset.ispPick) : st.selected.delete(t.dataset.ispPick); render(); return; }
      if (t.id === 'isp-page-check') {
        const list = rows().slice((st.page - 1) * PAGE, st.page * PAGE).filter(r => r.proposal);
        list.forEach(r => (t.checked ? st.selected.add(r.unitId) : st.selected.delete(r.unitId))); render(); return;
      }
      if (t.id === 'isp-approve' || t.dataset.ispYes) { if (t.dataset.ispYes) st.confirming = true; approve(); return; }
      if (t.dataset.ispNo) { st.confirming = false; el('isp-confirm').hidden = true; return; }
    });
    d.addEventListener('input', ev => { if (ev.target.id === 'isp-q') { st.q = ev.target.value; st.page = 1; render(); const q = el('isp-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
    d.addEventListener('cancel', ev => { if (st.busy) ev.preventDefault(); });
    return d;
  }

  function open() {
    if (!isAdminUser()) return;
    const d = ensureDialog(); d.dir = document.documentElement.dir || 'rtl';
    st.result = null; d.showModal(); load();
  }

  /** A one-line notice on the inventory page for admins when stuck pieces exist. */
  async function refreshNotice(force) {
    const host = document.getElementById('inv-stale-notice'); if (!host) return;
    if (!isAdminUser()) { host.hidden = true; return; }
    if (force || st.count === null || Date.now() - st.countAt > 60000) {
      try { const data = await api('/inventory-units/stale-prepared', { background: true }); st.count = data.summary.total; st.countAt = Date.now(); }
      catch { host.hidden = true; return; }
    }
    host.hidden = !st.count;
    host.innerHTML = st.count ? `<span>${e(tr(`${st.count} pieces still read «Prepared» although their orders left the warehouse.`, `${n(st.count)} قطعة ما زالت «مُجهزة» رغم خروج طلباتها من المخزن.`))}</span><button type="button" class="btn btn-outline btn-sm" onclick="window.InventoryStalePieces.open()">${e(tr('Review', 'مراجعة'))}</button>` : '';
  }

  window.InventoryStalePieces = { open, refreshNotice, load };
})();
