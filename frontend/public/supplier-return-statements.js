/* «بيانات المرتجعات» — Supplier Return Statements (Nov 13, 2026).
 *
 * A DOCUMENTATION-ONLY record of defective goods found in a supplier's delivery, kept inside the
 * supplier profile (tab «بيانات المرتجعات»). It is NOT «مرتجعات الموردين» (the accounting return):
 * nothing here moves stock, the supplier ledger, the vault, costs, purchase orders or invoices.
 * The server (backend/src/supplier-return-statements) writes only its own two collections.
 *
 * Loaded lazily per supplier — never at boot and never on the dashboard.
 * ⚠ RS_REASONS / RS_STATUSES mirror supplier-return-statement.constants.ts; `code` is stored.
 * ⚠ All clicks are `data-rs-act` delegation: names and notes are typed by people.
 */
(function () {
  'use strict';

  const L = (ar, en) => (typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar);
  const E = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = (n) => Number(n || 0).toLocaleString('en-US');
  const API = '/supplier-return-statements';

  const RS_REASONS = [
    ['manufacturing-defect', 'عيب تصنيع', 'Manufacturing defect'],
    ['shipping-damage', 'تلف أثناء النقل', 'Damaged during shipping'],
    ['wrong-color', 'اختلاف اللون', 'Wrong color'],
    ['wrong-size', 'اختلاف المقاس أو الأبعاد', 'Wrong size'],
    ['material-quality', 'مشكلة في جودة الخامة', 'Material quality issue'],
    ['not-as-agreed', 'غير مطابق للمواصفات المتفق عليها', 'Not as agreed'],
    ['missing-parts', 'نقص في الكمية أو المكونات', 'Missing parts'],
    ['wrong-product', 'منتج خاطئ', 'Wrong product'],
    ['damaged-packaging', 'تلف التغليف', 'Damaged packaging'],
    ['other', 'سبب آخر', 'Other'],
  ];
  const RS_STATUSES = [
    ['draft', 'مسودة', 'Draft'],
    ['sent', 'تم الإرسال للمورد', 'Sent to supplier'],
    ['received', 'استلمه المورد', 'Received by supplier'],
    ['resolved', 'تمت المعالجة', 'Resolved'],
    ['closed', 'مغلق', 'Closed'],
  ];
  const reasonLabel = (c) => { const r = RS_REASONS.find((x) => x[0] === c); return r ? L(r[1], r[2]) : ''; };
  const statusLabel = (c) => { const s = RS_STATUSES.find((x) => x[0] === c); return s ? L(s[1], s[2]) : c; };
  const statusPill = (c) => `<span class="rs-pill is-${E(c)}">${E(statusLabel(c))}</span>`;

  // ── Permissions (admin passes all; view = any statement perm) ───────────────
  const PERMS = ['view', 'create', 'edit', 'status', 'delete', 'export'];
  const adminUser = () => typeof isAdmin === 'function' && isAdmin();
  const can = (a) => adminUser() || (typeof currentUser !== 'undefined' && (currentUser?.perms || []).includes('suppliers-rs-' + a));
  const canView = () => PERMS.some(can);
  const myId = () => (typeof _myUserId === 'function' ? _myUserId() : '');
  const canEditDoc = (d) => d && d.status !== 'closed' && (can('edit') || (d.status === 'draft' && d.createdById === myId() && can('create')));

  // ── Formatting ─────────────────────────────────────────────────────────────
  function fmtDay(v) {
    const s = String(v || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  function fmtWhen(v) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(L('ar-EG-u-nu-latn', 'en-GB'), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function today() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  const lineQty = (d) => (d.lines || []).reduce((s, l) => s + (Number(l.qty) || 0), 0);
  // Prices are a snapshot of the supplier's price, fixed by the server when the line is created.
  // `pricesHidden` = the server left them out (the viewer may not see purchase prices).
  const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const showPrices = (d) => !!d && !d.pricesHidden;
  const lineTotal = (l) => (l.unitPrice != null && l.qty != null ? Math.round(l.unitPrice * l.qty * 100) / 100 : null);
  const docTotal = (d) => (d.lines || []).reduce((s, l) => s + (lineTotal(l) || 0), 0);
  const unpricedCount = (d) => (d.lines || []).filter((l) => l.unitPrice == null).length;
  function priceSourceLabel(l) {
    switch (l.priceSource) {
      case 'invoice': return L(`فاتورة شراء #${l.priceRef || ''}`, `Purchase invoice #${l.priceRef || ''}`);
      case 'po': return L(`أمر شراء ${l.priceRef || ''}`, `PO ${l.priceRef || ''}`);
      case 'supplier': return L('سعر المورد', 'Supplier price');
      case 'card': return L('سعر الكارت', 'Card price');
      default: return '';
    }
  }
  /** The line's photo from the catalogue: the snapshot taken at creation, else the live product. */
  function productImg(l) {
    let url = String(l.imageUrl || '');
    if (!url) {
      const p = (typeof products !== 'undefined' && Array.isArray(products) ? products : []).find((x) => String(x._id) === String(l.productId));
      url = String(p?.imageUrl || '');
    }
    return /^https?:\/\//i.test(url) ? url : '';
  }
  const thumbHtml = (l, cls) => {
    const u = productImg(l);
    return `<span class="${cls}">${u ? `<img src="${E(u)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></svg></span>`;
  };
  const reasonTag = (l) => l.reason ? `<span class="rs-reason-tag">${E(reasonLabel(l.reason))}</span>` : `<span class="rs-muted">${L('السبب غير محدد', 'No reason yet')}</span>`;
  const errMsg = (e) => (e && (e.message || e.error)) || L('تعذّر تنفيذ العملية', 'The action failed');
  const toastOk = (m) => typeof toast === 'function' && toast(m);
  const toastErr = (m) => typeof toast === 'function' && toast(m, true);

  const ICON = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    doc: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    print: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    camera: '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>',
    download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    pdf: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15h6M12 12v6"/>',
  };
  const ico = (k, s = 15) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    supplierId: '', rows: [], loading: false, failed: false, loadedFor: '', loadedAt: 0,
    filter: { q: '', status: '', from: '', to: '' },
    host: null, ed: null, view: null,
  };
  const photoCache = new Map();

  function supplier() {
    return (typeof suppliers !== 'undefined' ? suppliers : []).find((s) => s._id === state.supplierId) || null;
  }

  // ── Panel ─────────────────────────────────────────────────────────────────
  function render(host, supplierId) {
    if (!host) return;
    state.host = host;
    if (!canView()) { host.innerHTML = ''; return; }
    if (state.supplierId !== supplierId) {
      state.supplierId = supplierId; state.rows = []; state.loadedFor = ''; state.failed = false;
      state.filter = { q: '', status: '', from: '', to: '' };
    }
    drawShell();
    // Reload when the supplier changes, or when the list is over a minute old (another user may have added one).
    if (state.loadedFor !== supplierId || (!state.loading && Date.now() - state.loadedAt > 60000)) load();
    else drawTable();
  }

  async function load() {
    const sid = state.supplierId;
    if (state.loading && state.loadingFor === sid) return;
    state.loading = true; state.loadingFor = sid; state.failed = false; drawTable();
    try {
      const rows = await api(`${API}?supplierId=${encodeURIComponent(sid)}`);
      if (sid !== state.supplierId) return;
      state.rows = Array.isArray(rows) ? rows : [];
      state.loadedFor = sid; state.loadedAt = Date.now();
    } catch (_) {
      if (sid !== state.supplierId) return;
      state.failed = true;
    } finally {
      if (sid === state.supplierId) { state.loading = false; drawSummary(); drawTable(); }
    }
  }

  function drawShell() {
    const h = state.host; if (!h) return;
    const f = state.filter;
    h.innerHTML = `
      <div class="rs-panel" data-rs-root>
        <div class="rs-head">
          <div class="rs-head-text">
            <div class="rs-summary" data-rs-summary></div>
            <p class="rs-note">${ico('info', 13)}<span>${L('سجل توثيقي للعيوب المكتشفة عند الاستلام — لا يغيّر المخزون ولا حساب المورد ولا الخزنة. المرتجع المحاسبي في تبويب «مرتجعات الموردين».',
              'A record of defects found on delivery — it does not change stock, the supplier account or the vault. Accounting returns are under «Supplier returns».')}</span></p>
          </div>
          <button type="button" class="btn btn-primary btn-sm rs-new-btn" data-rs-act="new" ${can('create') ? '' : 'disabled title="' + E(L('ليست لديك صلاحية إنشاء بيان', 'You cannot create statements')) + '"'}>${ico('plus', 14)}<span>${L('بيان مرتجع جديد', 'New return statement')}</span></button>
        </div>
        <div class="rs-toolbar">
          <input type="search" class="rs-search" data-rs-filter="q" value="${E(f.q)}" placeholder="${E(L('بحث برقم البيان أو المنتج أو المستند', 'Search by number, product or document'))}" aria-label="${E(L('بحث', 'Search'))}">
          <select class="rs-select" data-rs-filter="status" aria-label="${E(L('الحالة', 'Status'))}">
            <option value="">${L('كل الحالات', 'All statuses')}</option>
            ${RS_STATUSES.map((s) => `<option value="${s[0]}" ${f.status === s[0] ? 'selected' : ''}>${E(L(s[1], s[2]))}</option>`).join('')}
          </select>
          <label class="rs-date"><span>${L('من', 'From')}</span><input type="date" data-rs-filter="from" value="${E(f.from)}"></label>
          <label class="rs-date"><span>${L('إلى', 'To')}</span><input type="date" data-rs-filter="to" value="${E(f.to)}"></label>
        </div>
        <div data-rs-table></div>
      </div>`;
    drawSummary();
  }

  function drawSummary() {
    const el = state.host && state.host.querySelector('[data-rs-summary]'); if (!el) return;
    if (state.loading && !state.loadedFor) { el.innerHTML = `<span class="rs-skel" style="width:180px"></span>`; return; }
    const rows = state.rows, open = rows.filter((r) => !['resolved', 'closed'].includes(r.status)).length;
    const qty = rows.reduce((s, r) => s + lineQty(r), 0);
    el.innerHTML = `<span class="rs-sum-item"><b>${N(rows.length)}</b> ${L('بيان', rows.length === 1 ? 'statement' : 'statements')}</span>
      <span class="rs-sum-dot" aria-hidden="true"></span><span class="rs-sum-item"><b>${N(qty)}</b> ${L('قطعة موثّقة', qty === 1 ? 'piece documented' : 'pieces documented')}</span>
      ${open ? `<span class="rs-sum-dot" aria-hidden="true"></span><span class="rs-sum-item"><b>${N(open)}</b> ${L('مفتوح', 'open')}</span>` : ''}`;
  }

  function filtered() {
    const f = state.filter;
    const norm = (s) => (typeof normalizeUiSearch === 'function' ? normalizeUiSearch(String(s || '')) : String(s || '').toLowerCase());
    const q = norm(f.q).trim();
    return state.rows.filter((r) => {
      if (f.status && r.status !== f.status) return false;
      if (f.from && String(r.date) < f.from) return false;
      if (f.to && String(r.date) > f.to) return false;
      if (!q) return true;
      const blob = [r.number, r.notes, r.linkedDoc?.ref, ...(r.lines || []).flatMap((l) => [l.name, l.code])].join(' ');
      return norm(blob).includes(q);
    });
  }

  function linkedLabel(ld) {
    if (!ld || !ld.id) return '';
    return (ld.kind === 'po' ? L('أمر شراء ', 'PO ') : L('فاتورة شراء ', 'Invoice ')) + (ld.ref || '');
  }

  function drawTable() {
    const el = state.host && state.host.querySelector('[data-rs-table]'); if (!el) return;
    if (state.loading && !state.loadedFor) {
      el.innerHTML = `<div class="rs-table-wrap">${Array.from({ length: 4 }, () => '<div class="rs-skel-row"><span class="rs-skel"></span><span class="rs-skel"></span><span class="rs-skel"></span></div>').join('')}</div>`;
      return;
    }
    if (state.failed) {
      el.innerHTML = `<div class="rs-empty is-error"><p>${L('تعذّر تحميل بيانات المرتجعات', 'Could not load return statements')}</p><button type="button" class="btn btn-outline btn-sm" data-rs-act="retry">${L('إعادة المحاولة', 'Retry')}</button></div>`;
      return;
    }
    if (!state.rows.length) {
      el.innerHTML = `<div class="rs-empty">${ico('doc', 26)}<p>${L('لا توجد بيانات مرتجعات لهذا المورد بعد', 'No return statements for this supplier yet')}</p>
        <small>${L('سجّل المنتجات المعيبة عند الاستلام وأرسل البيان للمورد.', 'Record defective items on delivery and send the statement to the supplier.')}</small></div>`;
      return;
    }
    const rows = filtered();
    if (!rows.length) {
      el.innerHTML = `<div class="rs-empty"><p>${L('لا توجد نتائج تطابق التصفية', 'No statements match these filters')}</p><button type="button" class="btn btn-outline btn-sm" data-rs-act="clear-filters">${L('مسح التصفية', 'Clear filters')}</button></div>`;
      return;
    }
    const priced = state.rows.some(showPrices);
    el.innerHTML = `<div class="rs-table-wrap"><table class="rs-table">
      <thead><tr>
        <th class="rs-c-no">${L('رقم البيان', 'Number')}</th>
        <th class="rs-c-date">${L('التاريخ', 'Date')}</th>
        <th class="rs-c-doc">${L('المستند المرتبط', 'Linked document')}</th>
        <th class="rs-c-items">${L('المنتجات', 'Items')}</th>
        ${priced ? `<th class="rs-c-value">${L('القيمة', 'Value')} <small>EGP</small></th>` : ''}
        <th class="rs-c-status">${L('الحالة', 'Status')}</th>
        <th class="rs-c-by">${L('بواسطة', 'By')}</th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const names = (r.lines || []).map((l) => `${l.name} ×${l.qty ?? '—'}`).join(' · ');
        return `<tr class="rs-row" data-rs-act="open" data-id="${E(r._id)}" tabindex="0">
          <td class="rs-c-no"><bdi class="rs-num">${E(r.number)}</bdi></td>
          <td class="rs-c-date"><bdi>${E(fmtDay(r.date))}</bdi></td>
          <td class="rs-c-doc">${r.linkedDoc?.id ? `<bdi>${E(linkedLabel(r.linkedDoc))}</bdi>` : '<span class="rs-muted">—</span>'}</td>
          <td class="rs-c-items" title="${E(names)}">${N((r.lines || []).length)} ${L('منتج', 'items')} <span class="rs-muted">· ${N(lineQty(r))} ${L('قطعة', 'pcs')}</span></td>
          ${priced ? `<td class="rs-c-value"><bdi>${money(docTotal(r))}</bdi></td>` : ''}
          <td class="rs-c-status">${statusPill(r.status)}</td>
          <td class="rs-c-by rs-muted">${E(r.createdBy || '')}</td>
        </tr>`;
      }).join('')}</tbody></table></div>
      ${rows.length !== state.rows.length ? `<p class="rs-count">${L(`يُعرض ${N(rows.length)} من ${N(state.rows.length)}`, `Showing ${N(rows.length)} of ${N(state.rows.length)}`)}</p>` : ''}`;
  }

  function upsertRow(doc) {
    if (!doc || doc.supplierId !== state.supplierId) return;
    const i = state.rows.findIndex((r) => r._id === doc._id);
    if (i >= 0) state.rows[i] = doc; else state.rows.unshift(doc);
    state.rows.sort((a, b) => (b.seq || 0) - (a.seq || 0));
    drawSummary(); drawTable();
  }

  // ── Editor ────────────────────────────────────────────────────────────────
  function supplierDocs() {
    const s = supplier(); if (!s) return { pos: [], invoices: [] };
    const pos = (typeof purchaseOrders !== 'undefined' ? purchaseOrders : []).filter((p) => p.supplierId === s._id)
      .sort((a, b) => String(b.createdDate || b.createdAt || '').localeCompare(String(a.createdDate || a.createdAt || '')));
    const invoices = (typeof transactions !== 'undefined' ? transactions : []).filter((t) => t.type === 'مشتريات' && !t.archived && !t.cancelled
      && (t.supplierId === s._id || (!t.supplierId && String(t.client || t.supplier || '').trim() === String(s.name || '').trim())))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return { pos, invoices };
  }

  function newLine() { return { lineId: rid(), productId: '', code: '', name: '', qty: 1, reason: '', reasonNote: '', notes: '', attachments: [], _pending: [], _remove: new Set() }; }

  function openEditor(doc) {
    if (doc ? !canEditDoc(doc) : !can('create')) { toastErr(L('ليست لديك صلاحية لهذا الإجراء', 'You do not have permission for this')); return; }
    state.ed = {
      doc: doc || null,
      requestKey: doc ? null : rid() + rid(),
      date: doc ? doc.date : today(),
      linked: doc?.linkedDoc?.id ? `${doc.linkedDoc.kind}:${doc.linkedDoc.id}` : '',
      notes: doc ? doc.notes || '' : '',
      lines: doc ? (doc.lines || []).map((l) => ({ ...l, qty: l.qty ?? '', attachments: [...(l.attachments || [])], _pending: [], _remove: new Set() })) : [newLine()],
      saving: false, dirty: false, error: '',
    };
    const { pos, invoices } = supplierDocs();
    const s = supplier();
    const ld = doc?.linkedDoc;
    const knownLinked = !ld?.id || pos.some((p) => p._id === ld.id) || invoices.some((t) => t._id === ld.id);
    const html = `
      <div class="rs-ed" data-rs-root data-rs-editor>
        <div class="rs-ed-head">
          <div>
            <div class="rs-ed-title">${doc ? `${L('تعديل بيان', 'Edit statement')} <bdi>${E(doc.number)}</bdi>` : L('بيان مرتجع جديد', 'New return statement')}</div>
            <div class="rs-ed-sub">${E(s?.name || '')} · ${L('توثيق فقط — لا أثر على المخزون أو الحسابات', 'Documentation only — no stock or accounting effect')}</div>
          </div>
          <button type="button" class="modal-x" data-rs-act="ed-cancel" aria-label="${E(L('إغلاق', 'Close'))}">${ico('x', 18)}</button>
        </div>
        <div class="rs-ed-body">
          <div class="rs-ed-grid">
            <label class="rs-field"><span>${L('تاريخ البيان', 'Statement date')}</span><input type="date" data-rs-ed="date" value="${E(state.ed.date)}" required></label>
            <label class="rs-field rs-field-wide"><span>${L('أمر / فاتورة الشراء المرتبطة', 'Linked PO / purchase invoice')} <small>${L('اختياري', 'Optional')}</small></span>
              <select data-rs-ed="linked">
                <option value="">${L('— بدون —', '— None —')}</option>
                ${!knownLinked ? `<option value="${E(ld.kind + ':' + ld.id)}" selected>${E(linkedLabel(ld))}</option>` : ''}
                ${pos.length ? `<optgroup label="${E(L('أوامر الشراء', 'Purchase orders'))}">${pos.map((p) => `<option value="po:${E(p._id)}" ${state.ed.linked === 'po:' + p._id ? 'selected' : ''}>${E(p.poNumber)} · ${E(fmtDay(p.createdDate || p.createdAt))}</option>`).join('')}</optgroup>` : ''}
                ${invoices.length ? `<optgroup label="${E(L('فواتير الشراء', 'Purchase invoices'))}">${invoices.map((t) => `<option value="purchase:${E(t._id)}" ${state.ed.linked === 'purchase:' + t._id ? 'selected' : ''}>#${E(t.ref)} · ${E(fmtDay(t.date))}</option>`).join('')}</optgroup>` : ''}
              </select></label>
          </div>
          <div class="rs-ed-section-head"><h4>${L('المنتجات المرتجعة', 'Returned items')}</h4><span class="rs-muted" data-rs-ed-count></span></div>
          <div class="rs-lines" data-rs-lines></div>
          <button type="button" class="rs-add-line" data-rs-act="ed-add-line">${ico('plus', 14)}<span>${L('إضافة منتج', 'Add item')}</span></button>
          <label class="rs-field"><span>${L('ملاحظات عامة', 'General notes')} <small>${L('اختياري', 'Optional')}</small></span>
            <textarea rows="2" maxlength="1000" data-rs-ed="notes" placeholder="${E(L('مثال: تم فحص الشحنة بحضور مندوب المورد', 'e.g. delivery inspected with the supplier’s driver'))}">${E(state.ed.notes)}</textarea></label>
        </div>
        <div class="rs-ed-foot">
          <p class="rs-ed-err" data-rs-ed-err role="alert" hidden></p>
          <span class="rs-ed-hint">${!doc || doc.status === 'draft' ? L('يُحفظ كمسودة — يمكن إكماله لاحقاً.', 'Saved as a draft — you can complete it later.') : ''}</span>
          <button type="button" class="btn btn-outline" data-rs-act="ed-cancel">${L('إلغاء', 'Cancel')}</button>
          <button type="button" class="btn btn-primary" data-rs-act="ed-save">${!doc || doc.status === 'draft' ? L('حفظ المسودة', 'Save draft') : L('حفظ التعديلات', 'Save changes')}</button>
        </div>
      </div>`;
    openModal(html, 'max-width:820px;padding:0;overflow:hidden;max-height:none', { lockDismiss: true });
    drawLines();
  }

  function productLabel(p) { return p ? `${p.name || ''}${p.code ? ' · ' + p.code : ''}` : ''; }

  function drawLines() {
    const host = document.querySelector('[data-rs-lines]'); const ed = state.ed; if (!host || !ed) return;
    host.innerHTML = ed.lines.map((l, i) => {
      const photos = [
        ...(l.attachments || []).filter((a) => !l._remove.has(a.id)).map((a) => `<span class="rs-thumb" data-att="${E(a.id)}"><img alt="" data-rs-photo="${E(a.id)}"><button type="button" class="rs-thumb-x" data-rs-act="ed-photo-remove" data-line="${i}" data-att="${E(a.id)}" aria-label="${E(L('إزالة الصورة', 'Remove photo'))}">${ico('x', 11)}</button></span>`),
        ...l._pending.map((p) => `<span class="rs-thumb is-pending"><img alt="" src="${E(p.url)}"><button type="button" class="rs-thumb-x" data-rs-act="ed-photo-unqueue" data-line="${i}" data-pid="${E(p.id)}" aria-label="${E(L('إزالة الصورة', 'Remove photo'))}">${ico('x', 11)}</button></span>`),
      ].join('');
      const prod = l.productId ? { name: l.name, code: l.code } : null;
      return `<div class="rs-line" data-line="${i}">
        <div class="rs-line-n">${i + 1}</div>
        <div class="rs-line-main">
          <div class="rs-line-row">
            <div class="rs-field rs-prod">
              <span>${L('المنتج', 'Product')}</span>
              <div class="rs-combo">
                <input type="text" autocomplete="off" data-rs-prod="${i}" value="${E(productLabel(prod))}" placeholder="${E(L('ابحث بالاسم أو الكود', 'Search by name or code'))}" role="combobox" aria-expanded="false">
                <div class="rs-combo-list" data-rs-prod-list="${i}" hidden></div>
              </div>
              ${l.code ? `<small class="rs-sku">SKU <bdi>${E(l.code)}</bdi></small>` : ''}
            </div>
            <label class="rs-field rs-qty"><span>${L('الكمية', 'Qty')}</span><input type="number" min="1" step="1" inputmode="numeric" data-rs-line="qty" data-i="${i}" value="${E(l.qty)}"></label>
            <label class="rs-field rs-reason"><span>${L('سبب المرتجع', 'Reason')}</span>
              <select data-rs-line="reason" data-i="${i}">
                <option value="">${L('— اختر —', '— Choose —')}</option>
                ${RS_REASONS.map((r) => `<option value="${r[0]}" ${l.reason === r[0] ? 'selected' : ''}>${E(L(r[1], r[2]))}</option>`).join('')}
              </select></label>
            <button type="button" class="rs-line-del" data-rs-act="ed-del-line" data-i="${i}" title="${E(L('حذف السطر', 'Remove line'))}" aria-label="${E(L('حذف السطر', 'Remove line'))}">${ico('trash', 15)}</button>
          </div>
          ${l.reason === 'other' ? `<label class="rs-field"><span>${L('وصف السبب', 'Describe the reason')} <b class="rs-req">*</b></span><input type="text" maxlength="300" data-rs-line="reasonNote" data-i="${i}" value="${E(l.reasonNote)}" placeholder="${E(L('مطلوب عند اختيار «سبب آخر»', 'Required for «Other»'))}"></label>` : ''}
          <div class="rs-line-row rs-line-row-2">
            <label class="rs-field rs-notes"><span>${L('تفاصيل المشكلة', 'Problem details')} <small>${L('اختياري', 'Optional')}</small></span><input type="text" maxlength="1000" data-rs-line="notes" data-i="${i}" value="${E(l.notes)}" placeholder="${E(L('مثال: خياطة مفكوكة في الطرف', 'e.g. loose stitching on the edge'))}"></label>
            <div class="rs-field rs-photos"><span>${L('صور', 'Photos')} <small>${L('اختياري', 'Optional')}</small></span>
              <div class="rs-thumbs">${photos}<label class="rs-thumb-add" title="${E(L('إضافة صور', 'Add photos'))}">${ico('camera', 16)}<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-rs-photo-input="${i}" hidden></label></div>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
    const c = document.querySelector('[data-rs-ed-count]');
    if (c) c.textContent = ed.lines.length ? L(`${N(ed.lines.length)} منتج · ${N(ed.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0))} قطعة`, `${N(ed.lines.length)} items · ${N(ed.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0))} pcs`) : '';
    host.querySelectorAll('img[data-rs-photo]').forEach((img) => loadPhoto(state.ed.doc?._id, img.dataset.rsPhoto).then((src) => { if (src && img.isConnected) img.src = src; }).catch(() => {}));
  }

  function showEdError(msg) {
    const el = document.querySelector('[data-rs-ed-err]'); if (!el) return;
    el.textContent = msg || ''; el.hidden = !msg;
  }

  function productMatches(q) {
    const list = typeof products !== 'undefined' && Array.isArray(products) ? products : [];
    const norm = (s) => (typeof normalizeUiSearch === 'function' ? normalizeUiSearch(String(s || '')) : String(s || '').toLowerCase());
    const nq = norm(q).trim();
    const active = list.filter((p) => p && p._id && p.name);
    const hits = nq ? active.filter((p) => norm(p.name + ' ' + (p.code || '')).includes(nq)) : active;
    return hits.slice(0, 30);
  }

  function openCombo(i, q) {
    const list = document.querySelector(`[data-rs-prod-list="${i}"]`); const input = document.querySelector(`[data-rs-prod="${i}"]`);
    if (!list) return;
    const hits = productMatches(q);
    list.innerHTML = hits.length ? hits.map((p, k) => `<button type="button" class="rs-combo-opt${k === 0 ? ' is-active' : ''}" data-rs-act="ed-pick" data-i="${i}" data-pid="${E(p._id)}"><span class="rs-combo-name">${E(p.name)}</span>${p.code ? `<bdi class="rs-combo-code">${E(p.code)}</bdi>` : ''}</button>`).join('')
      : `<div class="rs-combo-empty">${L('لا يوجد منتج بهذا الاسم', 'No matching product')}</div>`;
    list.hidden = false; if (input) input.setAttribute('aria-expanded', 'true');
  }
  function closeCombos() {
    document.querySelectorAll('[data-rs-prod-list]').forEach((l) => { l.hidden = true; });
    document.querySelectorAll('[data-rs-prod]').forEach((i) => i.setAttribute('aria-expanded', 'false'));
  }

  function pickProduct(i, pid) {
    const ed = state.ed; const l = ed?.lines[i]; if (!l) return;
    const p = (products || []).find((x) => String(x._id) === String(pid)); if (!p) return;
    l.productId = String(p._id); l.name = p.name || ''; l.code = p.code || '';
    ed.dirty = true; closeCombos(); drawLines();
    const q = document.querySelector(`[data-rs-line="qty"][data-i="${i}"]`); if (q) q.focus();
  }

  function validateEditor(strict) {
    const ed = state.ed;
    if (!ed.date) return L('اختر تاريخ البيان', 'Choose the statement date');
    if (!ed.lines.length && strict) return L('أضف منتجاً واحداً على الأقل', 'Add at least one item');
    for (let i = 0; i < ed.lines.length; i++) {
      const l = ed.lines[i], n = i + 1;
      if (!l.productId) return L(`السطر ${n}: اختر المنتج من القائمة`, `Line ${n}: choose a product from the list`);
      if (l.qty !== '' && l.qty != null && !(Number.isInteger(Number(l.qty)) && Number(l.qty) >= 1)) return L(`السطر ${n}: الكمية يجب أن تكون عدداً صحيحاً أكبر من صفر`, `Line ${n}: quantity must be a whole number above zero`);
      if (l.reason === 'other' && !String(l.reasonNote || '').trim()) return L(`السطر ${n}: اكتب وصف السبب عند اختيار «سبب آخر»`, `Line ${n}: describe the reason for «Other»`);
      if (strict && (!(Number(l.qty) > 0) || !l.reason)) return L(`السطر ${n}: أكمل الكمية والسبب`, `Line ${n}: fill in quantity and reason`);
    }
    return '';
  }

  async function saveEditor() {
    const ed = state.ed; if (!ed || ed.saving) return;
    const strict = !!ed.doc && ed.doc.status !== 'draft';
    const err = validateEditor(strict);
    if (err) { showEdError(err); return; }
    showEdError('');
    ed.saving = true;
    const btn = document.querySelector('[data-rs-act="ed-save"]'); if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    const [kind, id] = ed.linked ? ed.linked.split(':') : ['', ''];
    const body = {
      date: ed.date, notes: ed.notes, linkedDoc: id ? { kind, id } : null,
      lines: ed.lines.map((l) => ({ lineId: l.lineId, productId: l.productId, qty: l.qty === '' ? null : Number(l.qty), reason: l.reason, reasonNote: l.reasonNote, notes: l.notes })),
    };
    let doc;
    try {
      if (ed.doc) doc = await api(`${API}/${encodeURIComponent(ed.doc._id)}`, { method: 'PATCH', body: JSON.stringify({ ...body, revision: ed.doc.revision }) });
      else doc = await api(API, { method: 'POST', body: JSON.stringify({ ...body, supplierId: state.supplierId, requestKey: ed.requestKey }) });
    } catch (e) {
      ed.saving = false; if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
      showEdError(errMsg(e)); return;
    }
    // Photos: removals first (they free slots), then the queued uploads, one at a time.
    let photoFails = 0;
    for (const l of ed.lines) {
      for (const attId of l._remove) {
        try { doc = await api(`${API}/${encodeURIComponent(doc._id)}/photos/${encodeURIComponent(attId)}`, { method: 'DELETE' }); } catch (_) { photoFails++; }
      }
      for (const p of l._pending) {
        const fd = new FormData(); const small = await shrinkPhoto(p.file); fd.append('file', small, (p.file.name || 'photo').replace(/\.\w+$/, '') + '.jpg');
        try { doc = await api(`${API}/${encodeURIComponent(doc._id)}/lines/${encodeURIComponent(l.lineId)}/photos`, { method: 'POST', body: fd }); } catch (_) { photoFails++; }
      }
    }
    ed.lines.forEach((l) => l._pending.forEach((p) => URL.revokeObjectURL(p.url)));
    state.ed = null;
    upsertRow(doc);
    closeModal();
    if (photoFails) toastErr(L(`تم حفظ البيان، لكن تعذّر حفظ ${N(photoFails)} صورة — افتحه وأعد إضافتها`, `Statement saved, but ${N(photoFails)} photo(s) failed — open it and add them again`));
    else toastOk(ed.doc ? L(`تم حفظ تعديلات ${doc.number}`, `${doc.number} updated`) : L(`تم إنشاء البيان ${doc.number}`, `Statement ${doc.number} created`));
    openView(doc._id, doc);
  }

  async function cancelEditor() {
    const ed = state.ed;
    if (ed && ed.dirty && typeof showConfirm === 'function') {
      const ok = await showConfirm(L('ستُفقد التعديلات غير المحفوظة على هذا البيان.', 'Unsaved changes to this statement will be lost.'), { title: L('إغلاق بدون حفظ؟', 'Close without saving?'), confirmLabel: L('إغلاق', 'Close'), danger: true });
      if (!ok) return;
    }
    if (ed) ed.lines.forEach((l) => l._pending.forEach((p) => URL.revokeObjectURL(p.url)));
    state.ed = null; closeModal();
  }

  // ── Photos ────────────────────────────────────────────────────────────────
  /** Shrinks a phone photo (often 3–8 MB) to ≤1600 px JPEG before upload, so the upload is quick;
   *  the server then compresses it to its final ≤90 KB. Falls back to the original file. */
  async function shrinkPhoto(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size < 600 * 1024) { bmp.close && bmp.close(); return file; }
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      return blob && blob.size < file.size ? blob : file;
    } catch (_) { return file; }
  }
  function loadPhoto(statementId, attId) {
    if (!statementId || !attId) return Promise.resolve('');
    const key = statementId + '/' + attId;
    if (!photoCache.has(key)) {
      const task = api(`${API}/${encodeURIComponent(statementId)}/photos/${encodeURIComponent(attId)}`, { background: true })
        .then((r) => r?.data || '').catch((e) => { photoCache.delete(key); throw e; });
      photoCache.set(key, task);
    }
    return photoCache.get(key);
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  async function openView(id, preloaded) {
    let doc = preloaded || state.rows.find((r) => r._id === id);
    try { doc = await api(`${API}/${encodeURIComponent(id)}`); } catch (e) { if (!doc) { toastErr(errMsg(e)); return; } }
    state.view = doc; upsertRow(doc);
    drawView();
  }

  function historyText(h) {
    switch (h.action) {
      case 'created': return L('أنشأ البيان', 'created the statement');
      case 'edited': return L('عدّل البيان', 'edited the statement');
      case 'status': return L(`غيّر الحالة: ${statusLabel(h.from)} ← ${statusLabel(h.to)}`, `changed status: ${statusLabel(h.from)} → ${statusLabel(h.to)}`);
      case 'photo-added': return L('أضاف صورة', 'added a photo');
      case 'photo-removed': return L('حذف صورة', 'removed a photo');
      case 'printed': return L('طبع البيان', 'printed the statement');
      case 'exported': return L('صدّر البيان PDF', 'exported the statement as PDF');
      case 'deleted': return L('حذف البيان', 'deleted the statement');
      default: return h.action;
    }
  }

  function drawView() {
    const d = state.view; if (!d) return;
    const s = supplier();
    const photosCount = (d.lines || []).reduce((n, l) => n + (l.attachments || []).length, 0);
    const editable = canEditDoc(d);
    const html = `
      <div class="rs-view" data-rs-root data-rs-view>
        <div class="rs-ed-head">
          <div>
            <div class="rs-ed-title"><bdi class="rs-num">${E(d.number)}</bdi> ${statusPill(d.status)}</div>
            <div class="rs-ed-sub">${L('بيان مرتجع', 'Return statement')} · ${E(d.supplierName || s?.name || '')} · ${L('أنشأه', 'by')} ${E(d.createdBy || '')} <bdi>${E(fmtWhen(d.createdAt))}</bdi></div>
          </div>
          <button type="button" class="modal-x" data-rs-act="view-close" aria-label="${E(L('إغلاق', 'Close'))}">${ico('x', 18)}</button>
        </div>
        <div class="rs-ed-body">
          <dl class="rs-facts">
            <div><dt>${L('التاريخ', 'Date')}</dt><dd><bdi>${E(fmtDay(d.date))}</bdi></dd></div>
            <div><dt>${L('المستند المرتبط', 'Linked document')}</dt><dd>${d.linkedDoc?.id ? `<bdi>${E(linkedLabel(d.linkedDoc))}</bdi>` : '—'}</dd></div>
            <div><dt>${L('المنتجات', 'Items')}</dt><dd>${N((d.lines || []).length)} · ${N(lineQty(d))} ${L('قطعة', 'pcs')}</dd></div>
            ${showPrices(d) ? `<div class="rs-fact-total"><dt>${L('إجمالي القيمة', 'Total value')}</dt><dd><bdi>${money(docTotal(d))}</bdi> <small>EGP</small>${unpricedCount(d) ? `<small class="rs-muted"> · ${L(`${N(unpricedCount(d))} بدون سعر`, `${N(unpricedCount(d))} unpriced`)}</small>` : ''}</dd></div>` : `<div><dt>${L('الحالة', 'Status')}</dt><dd>${E(statusLabel(d.status))}</dd></div>`}
          </dl>
          ${d.notes ? `<div class="rs-notes-box" dir="auto">${E(d.notes)}</div>` : ''}
          <div class="rs-view-lines">${(d.lines || []).length ? (d.lines || []).map((l, i) => `
            <div class="rs-vline">
              <div class="rs-vline-n">${i + 1}</div>
              ${thumbHtml(l, 'rs-pimg')}
              <div class="rs-vline-main">
                <div class="rs-vline-top"><span class="rs-vline-name">${E(l.name)}</span>${l.code ? `<bdi class="rs-chip">${E(l.code)}</bdi>` : ''}<span class="rs-vline-qty">× ${l.qty != null ? N(l.qty) : '—'}</span></div>
                ${showPrices(d) ? `<div class="rs-vline-price">${l.unitPrice != null
                  ? `<bdi>${money(l.unitPrice)}</bdi> × <bdi>${l.qty != null ? N(l.qty) : '—'}</bdi> = <b><bdi>${lineTotal(l) != null ? money(lineTotal(l)) : '—'}</bdi></b> <small>EGP</small>${priceSourceLabel(l) ? ` <span class="rs-price-src">${E(priceSourceLabel(l))}</span>` : ''}`
                  : `<span class="rs-muted">${L('لا يوجد سعر لهذا المنتج عند المورد', 'No supplier price for this item')}</span>`}</div>` : ''}
                <div class="rs-vline-reason">${reasonTag(l)}${l.reasonNote ? ` <span dir="auto">${E(l.reasonNote)}</span>` : ''}</div>
                ${l.notes ? `<div class="rs-vline-notes" dir="auto">${E(l.notes)}</div>` : ''}
                ${(l.attachments || []).length ? `<div class="rs-thumbs">${l.attachments.map((a) => `<button type="button" class="rs-thumb is-view" data-rs-act="photo-open" data-att="${E(a.id)}" aria-label="${E(L('عرض الصورة', 'View photo'))}"><img alt="" data-rs-photo="${E(a.id)}"></button>`).join('')}</div>` : ''}
              </div>
            </div>`).join('') : `<div class="rs-empty is-inline">${L('لا توجد منتجات في هذه المسودة بعد', 'This draft has no items yet')}</div>`}
          </div>
          ${can('status') ? `<div class="rs-status-box">
            <label class="rs-field"><span>${L('تغيير الحالة', 'Change status')}</span>
              <select data-rs-status-to>${RS_STATUSES.map((x) => `<option value="${x[0]}" ${x[0] === d.status ? 'selected' : ''}>${E(L(x[1], x[2]))}</option>`).join('')}</select></label>
            <label class="rs-field rs-field-wide"><span>${L('ملاحظة', 'Note')} <small>${L('اختياري', 'Optional')}</small></span><input type="text" maxlength="300" data-rs-status-note placeholder="${E(L('مثال: أُرسل على واتساب المورد', 'e.g. sent on the supplier’s WhatsApp'))}"></label>
            <button type="button" class="btn btn-outline btn-sm" data-rs-act="status-apply">${L('تحديث الحالة', 'Update status')}</button>
          </div>` : ''}
          <details class="rs-history">
            <summary>${L('سجل التغييرات', 'Change history')} <span class="rs-muted">(${N((d.history || []).length)})</span></summary>
            <ol>${[...(d.history || [])].reverse().map((h) => `<li><b>${E(h.by || '')}</b> ${E(historyText(h))}${h.note ? ` — <span dir="auto">${E(h.note)}</span>` : ''} <span class="rs-muted"><bdi>${E(fmtWhen(h.at))}</bdi></span></li>`).join('')}</ol>
          </details>
        </div>
        <div class="rs-ed-foot rs-view-foot">
          ${can('delete') ? `<button type="button" class="btn btn-outline btn-sm rs-danger" data-rs-act="delete">${ico('trash', 14)}<span>${L('حذف', 'Delete')}</span></button>` : ''}
          <span class="rs-spacer"></span>
          ${photosCount ? `<button type="button" class="btn btn-outline btn-sm" data-rs-act="photos-download">${ico('download', 14)}<span>${L(`تحميل الصور (${N(photosCount)})`, `Download photos (${N(photosCount)})`)}</span></button>` : ''}
          ${can('export') ? `<button type="button" class="btn btn-outline btn-sm" data-rs-act="print" data-kind="pdf">${ico('pdf', 14)}<span>PDF</span></button>
          <button type="button" class="btn btn-outline btn-sm" data-rs-act="print" data-kind="print">${ico('print', 14)}<span>${L('طباعة', 'Print')}</span></button>` : ''}
          ${editable ? `<button type="button" class="btn btn-primary btn-sm" data-rs-act="edit">${ico('edit', 14)}<span>${L('تعديل', 'Edit')}</span></button>` : ''}
        </div>
      </div>`;
    openModal(html, 'max-width:780px;padding:0;overflow:hidden;max-height:none');
    document.querySelectorAll('[data-rs-view] img[data-rs-photo]').forEach((img) => loadPhoto(d._id, img.dataset.rsPhoto).then((src) => { if (src && img.isConnected) img.src = src; }).catch(() => { img.closest('.rs-thumb')?.classList.add('is-broken'); }));
  }

  async function applyStatus() {
    const d = state.view; if (!d) return;
    const to = document.querySelector('[data-rs-status-to]')?.value;
    const note = document.querySelector('[data-rs-status-note]')?.value || '';
    if (!to || to === d.status) { toastErr(L('اختر حالة مختلفة عن الحالية', 'Choose a different status')); return; }
    const btn = document.querySelector('[data-rs-act="status-apply"]'); if (btn) btn.disabled = true;
    try {
      const doc = await api(`${API}/${encodeURIComponent(d._id)}/status`, { method: 'POST', body: JSON.stringify({ status: to, note }) });
      state.view = doc; upsertRow(doc); drawView();
      toastOk(L(`حالة ${doc.number}: ${statusLabel(to)}`, `${doc.number}: ${statusLabel(to)}`));
    } catch (e) { if (btn) btn.disabled = false; toastErr(errMsg(e)); }
  }

  async function deleteStatement() {
    const d = state.view; if (!d) return;
    const ok = await showConfirm(L(`سيُحذف البيان ${d.number} من قائمة المورد. لا يؤثر الحذف على المخزون أو الحسابات.`, `Statement ${d.number} will be removed from the supplier's list. Deleting it has no effect on stock or accounts.`),
      { title: L('حذف بيان المرتجع؟', 'Delete this return statement?'), confirmLabel: L('حذف', 'Delete'), danger: true });
    if (!ok) return;
    try {
      await api(`${API}/${encodeURIComponent(d._id)}`, { method: 'DELETE' });
      state.rows = state.rows.filter((r) => r._id !== d._id); state.view = null;
      closeModal(); drawSummary(); drawTable();
      toastOk(L(`تم حذف ${d.number}`, `${d.number} deleted`));
    } catch (e) { toastErr(errMsg(e)); }
  }

  async function openPhoto(attId) {
    const d = state.view; if (!d) return;
    let src = '';
    try { src = await loadPhoto(d._id, attId); } catch (e) { toastErr(errMsg(e)); return; }
    const layer = document.createElement('div');
    layer.className = 'rs-lightbox';
    layer.innerHTML = `<img alt="" src="${E(src)}"><button type="button" class="rs-lightbox-x" aria-label="${E(L('إغلاق', 'Close'))}">${ico('x', 20)}</button>`;
    const close = () => { layer.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); } };
    layer.addEventListener('click', (e) => { if (e.target === layer || e.target.closest('.rs-lightbox-x')) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(layer);
  }

  async function downloadPhotos() {
    const d = state.view; if (!d) return;
    let k = 0;
    for (const l of d.lines || []) {
      for (const a of l.attachments || []) {
        try {
          const src = await loadPhoto(d._id, a.id);
          const link = document.createElement('a');
          link.href = src; link.download = `${d.number}_${(l.code || 'item').replace(/[^\w-]+/g, '_')}_${++k}.jpg`;
          document.body.appendChild(link); link.click(); link.remove();
          await new Promise((r) => setTimeout(r, 250));
        } catch (_) { /* keep going */ }
      }
    }
    if (k) toastOk(L(`تم تحميل ${N(k)} صورة`, `${N(k)} photos downloaded`));
  }

  // ── Print / PDF ───────────────────────────────────────────────────────────
  async function printStatement(kind) {
    const d = state.view; if (!d) return;
    if (!can('export')) { toastErr(L('ليست لديك صلاحية الطباعة', 'You cannot print statements')); return; }
    const s = supplier() || {};
    const cfg = window.settings || {};
    const photos = {};
    for (const l of d.lines || []) for (const a of l.attachments || []) { try { photos[a.id] = await loadPhoto(d._id, a.id); } catch (_) { /* printed without it */ } }
    const phones = [s.phone, ...(Array.isArray(s.phones) ? s.phones : [])].filter(Boolean);
    const issuer = [cfg.companyLegalName, cfg.companyAddress, cfg.companyPhone].filter((v) => String(v || '').trim());
    const priced = showPrices(d);
    const rows = (d.lines || []).map((l, i) => {
      const img = productImg(l);
      return `<tr>
      <td class="c">${i + 1}</td>
      <td><div class="prod">${img ? `<img class="pimg" src="${E(img)}" alt="">` : '<span class="pimg"></span>'}<div><div class="nm">${E(l.name)}</div>${l.code ? `<div class="sku"><bdi>${E(l.code)}</bdi></div>` : ''}</div></div></td>
      <td class="c b">${l.qty != null ? N(l.qty) : '—'}</td>
      ${priced ? `<td class="n">${l.unitPrice != null ? `<bdi>${money(l.unitPrice)}</bdi>${priceSourceLabel(l) ? `<div class="sub">${E(priceSourceLabel(l))}</div>` : ''}` : '—'}</td>
      <td class="n b">${lineTotal(l) != null ? `<bdi>${money(lineTotal(l))}</bdi>` : '—'}</td>` : ''}
      <td>${l.reason ? `<span class="rtag">${E(reasonLabel(l.reason))}</span>` : '—'}${l.reasonNote ? `<div class="sub">${E(l.reasonNote)}</div>` : ''}</td>
      <td>${E(l.notes || '')}</td>
    </tr>`;
    }).join('');
    const gallery = (d.lines || []).filter((l) => (l.attachments || []).some((a) => photos[a.id])).map((l, i) => `
      <div class="ph-group"><div class="ph-title">${E(l.name)}${l.code ? ` · <bdi>${E(l.code)}</bdi>` : ''}</div>
        <div class="ph-grid">${l.attachments.filter((a) => photos[a.id]).map((a) => `<img src="${photos[a.id]}" alt="">`).join('')}</div></div>`).join('');
    const ar = L(true, false);
    const html = `<!doctype html><html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${E(d.number)} — ${E(d.supplierName || s.name || '')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@page{size:A4 portrait;margin:0}
html{color-scheme:light;background:#fff}*{box-sizing:border-box}body{margin:0;background:#fff;font-family:'IBM Plex Sans Arabic',system-ui,sans-serif;color:#1f2a24;font-size:11.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;min-height:297mm;padding:14mm 13mm}
.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1f2a24;padding-bottom:10px;margin-bottom:14px}
.top img{height:34px}.issuer{font-size:10px;color:#56635b;margin-top:6px;line-height:1.5}
.title{text-align:end}.title h1{margin:0;font-size:20px;font-weight:700}.title .no{font-size:15px;font-weight:600;margin-top:2px}
.badge{display:inline-block;margin-top:6px;padding:2px 10px;border:1px solid #1f2a24;border-radius:20px;font-size:10px}
.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
.meta div{border:1px solid #d9dfdb;border-radius:6px;padding:7px 9px}.meta dt{font-size:9.5px;color:#6b776f;margin:0 0 2px}.meta dd{margin:0;font-weight:600}
.notice{font-size:10px;color:#56635b;background:#f3f5f4;border-radius:6px;padding:7px 10px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}thead{display:table-header-group}tr{page-break-inside:avoid}
th{background:#f3f5f4;font-weight:600;font-size:10.5px;text-align:start;padding:7px 8px;border-bottom:1px solid #c9d1cc}
td{padding:7px 8px;border-bottom:1px solid #e3e8e5;vertical-align:top}.c{text-align:center}.b{font-weight:700;font-size:13px}
.nm{font-weight:600}.sku,.sub{font-size:9.5px;color:#6b776f;margin-top:2px}bdi{unicode-bidi:isolate}
.prod{display:flex;align-items:center;gap:8px}.pimg{width:13mm;height:13mm;flex-shrink:0;border-radius:4px;border:1px solid #d9dfdb;object-fit:cover;background:#f3f5f4;display:inline-block}
.n{text-align:end;white-space:nowrap;font-variant-numeric:tabular-nums}
.rtag{display:inline-block;padding:2px 8px;border-radius:12px;background:#fff1e3;color:#9a3412;border:1px solid #fdba74;font-weight:600;font-size:10.5px;line-height:1.5}
.totals{margin-top:10px;margin-inline-start:auto;width:72mm;border:1px solid #d9dfdb;border-radius:6px;overflow:hidden}
.totals div{display:flex;justify-content:space-between;padding:6px 10px;border-bottom:1px solid #e3e8e5}.totals div:last-child{border-bottom:none;background:#1f2a24;color:#fff;font-weight:700;font-size:13px}
.unpriced{margin-top:4px;font-size:9.5px;color:#9a3412;text-align:end}
.notes{margin-top:12px;border:1px solid #d9dfdb;border-radius:6px;padding:8px 10px;white-space:pre-wrap}
.total{margin-top:8px;text-align:end;font-weight:600}
.ph{margin-top:16px;page-break-before:auto}.ph h2{font-size:13px;margin:0 0 8px}.ph-group{margin-bottom:10px;page-break-inside:avoid}.ph-title{font-weight:600;margin-bottom:5px}
.ph-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.ph-grid img{width:100%;height:38mm;object-fit:cover;border-radius:4px;border:1px solid #d9dfdb}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:26px}.sign div{border-top:1px solid #9aa59e;padding-top:5px;font-size:10px;color:#56635b}
.foot{margin-top:18px;font-size:9px;color:#8a958e;text-align:center}
</style></head><body><div class="page">
<div class="top"><div><img src="/soulia-logo.svg" alt="SOULIA">${issuer.length ? `<div class="issuer">${issuer.map(E).join('<br>')}</div>` : ''}</div>
<div class="title"><h1>${L('بيان مرتجع للمورد', 'Supplier Return Statement')}</h1><div class="no"><bdi>${E(d.number)}</bdi></div><span class="badge">${E(statusLabel(d.status))}</span></div></div>
<dl class="meta">
<div><dt>${L('المورد', 'Supplier')}</dt><dd>${E(d.supplierName || s.name || '')}</dd></div>
<div><dt>${L('هاتف المورد', 'Supplier phone')}</dt><dd><bdi>${E(phones[0] || '—')}</bdi></dd></div>
<div><dt>${L('تاريخ البيان', 'Date')}</dt><dd><bdi>${E(fmtDay(d.date))}</bdi></dd></div>
<div><dt>${L('المستند المرتبط', 'Linked document')}</dt><dd><bdi>${E(d.linkedDoc?.id ? linkedLabel(d.linkedDoc) : '—')}</bdi></dd></div>
</dl>
<div class="notice">${L('يوثّق هذا البيان المنتجات التي وُجد بها عيب أو اختلاف عند الاستلام، للمتابعة مع المورد.', 'This statement documents items found defective or different on delivery, for follow-up with the supplier.')}</div>
<table><thead><tr><th class="c" style="width:24px">#</th><th>${L('المنتج', 'Product')}</th><th class="c" style="width:44px">${L('الكمية', 'Qty')}</th>${priced ? `<th class="n" style="width:21mm">${L('سعر القطعة', 'Unit price')}<div class="sub">EGP</div></th><th class="n" style="width:21mm">${L('الإجمالي', 'Total')}<div class="sub">EGP</div></th>` : ''}<th style="width:${priced ? '24%' : '30%'}">${L('السبب', 'Reason')}</th><th style="width:${priced ? '17%' : '26%'}">${L('التفاصيل', 'Details')}</th></tr></thead><tbody>${rows}</tbody></table>
${priced ? `<div class="totals"><div><span>${L('إجمالي القطع', 'Total pieces')}</span><bdi>${N(lineQty(d))}</bdi></div><div><span>${L('إجمالي القيمة', 'Total value')}</span><bdi>${money(docTotal(d))} EGP</bdi></div></div>${unpricedCount(d) ? `<div class="unpriced">${L(`${N(unpricedCount(d))} منتج بدون سعر مورد — غير محسوب في الإجمالي`, `${N(unpricedCount(d))} item(s) without a supplier price — not in the total`)}</div>` : ''}`
  : `<div class="total">${L('إجمالي القطع', 'Total pieces')}: ${N(lineQty(d))}</div>`}
${d.notes ? `<div class="notes">${E(d.notes)}</div>` : ''}
${gallery ? `<div class="ph"><h2>${L('صور توثيقية', 'Photos')}</h2>${gallery}</div>` : ''}
<div class="sign"><div>${L('توقيع المستلم (SOULIA)', 'Received by (SOULIA)')}</div><div>${L('توقيع المورد', 'Supplier signature')}</div></div>
<div class="foot">${L('صدر بواسطة', 'Issued by')} ${E((typeof currentUser !== 'undefined' && (currentUser?.name || currentUser?.username)) || '')} · <bdi>${E(fmtWhen(new Date()))}</bdi></div>
</div></body></html>`;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;inset-inline-end:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    const doc = frame.contentDocument; doc.open(); doc.write(html); doc.close();
    const ready = Promise.all([...doc.images].map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; }))));
    const fonts = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
    await Promise.race([Promise.all([ready, fonts]), new Promise((r) => setTimeout(r, 4000))]);
    if (kind === 'pdf') toastOk(L('اختر «حفظ كملف PDF» في نافذة الطباعة', 'Choose «Save as PDF» in the print dialog'));
    const prevTitle = document.title; document.title = `${d.number}`;
    frame.contentWindow.focus(); frame.contentWindow.print();
    document.title = prevTitle;
    setTimeout(() => frame.remove(), 60000);
    api(`${API}/${encodeURIComponent(d._id)}/printed`, { method: 'POST', body: JSON.stringify({ kind }), background: true }).catch(() => {});
  }

  // ── Events (delegated) ────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-rs-act]');
    if (!e.target.closest('.rs-combo')) closeCombos();
    if (!t || !t.closest('[data-rs-root]')) return;
    const act = t.dataset.rsAct, ed = state.ed;
    switch (act) {
      case 'new': openEditor(null); break;
      case 'retry': load(); break;
      case 'clear-filters': state.filter = { q: '', status: '', from: '', to: '' }; drawShell(); drawTable(); break;
      case 'open': openView(t.dataset.id); break;
      case 'ed-cancel': cancelEditor(); break;
      case 'ed-save': saveEditor(); break;
      case 'ed-add-line':
        if (ed.lines.length >= 100) { toastErr(L('الحد الأقصى 100 منتج في البيان', 'At most 100 items per statement')); break; }
        ed.lines.push(newLine()); ed.dirty = true; drawLines();
        { const inputs = document.querySelectorAll('[data-rs-prod]'); inputs[inputs.length - 1]?.focus(); }
        break;
      case 'ed-del-line': {
        const i = Number(t.dataset.i); const l = ed.lines[i]; if (!l) break;
        l._pending.forEach((p) => URL.revokeObjectURL(p.url));
        ed.lines.splice(i, 1); ed.dirty = true; drawLines(); break;
      }
      case 'ed-pick': pickProduct(Number(t.dataset.i), t.dataset.pid); break;
      case 'ed-photo-remove': { const l = ed.lines[Number(t.dataset.line)]; if (l) { l._remove.add(t.dataset.att); ed.dirty = true; drawLines(); } break; }
      case 'ed-photo-unqueue': {
        const l = ed.lines[Number(t.dataset.line)]; if (!l) break;
        const p = l._pending.find((x) => x.id === t.dataset.pid); if (p) URL.revokeObjectURL(p.url);
        l._pending = l._pending.filter((x) => x.id !== t.dataset.pid); drawLines(); break;
      }
      case 'view-close': state.view = null; closeModal(); break;
      case 'edit': { const d = state.view; state.view = null; openEditor(d); break; }
      case 'status-apply': applyStatus(); break;
      case 'delete': deleteStatement(); break;
      case 'photo-open': openPhoto(t.dataset.att); break;
      case 'photos-download': downloadPhotos(); break;
      case 'print': printStatement(t.dataset.kind); break;
    }
  });

  document.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('tr.rs-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openView(row.dataset.id); return; }
    const input = e.target.closest && e.target.closest('[data-rs-prod]');
    if (!input) return;
    const list = document.querySelector(`[data-rs-prod-list="${input.dataset.rsProd}"]`);
    if (!list || list.hidden) { if (e.key === 'ArrowDown') { openCombo(input.dataset.rsProd, input.value); e.preventDefault(); } return; }
    const opts = [...list.querySelectorAll('.rs-combo-opt')];
    let k = opts.findIndex((o) => o.classList.contains('is-active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      k = e.key === 'ArrowDown' ? Math.min(opts.length - 1, k + 1) : Math.max(0, k - 1);
      opts.forEach((o, j) => o.classList.toggle('is-active', j === k)); opts[k]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault(); if (opts[k]) pickProduct(Number(input.dataset.rsProd), opts[k].dataset.pid);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); closeCombos();
    }
  }, true);

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-rs-filter]') && t.dataset.rsFilter === 'q') { state.filter.q = t.value; drawTable(); return; }
    const ed = state.ed; if (!ed) return;
    if (t.closest('[data-rs-editor]')) showEdError('');
    if (t.matches('[data-rs-prod]')) {
      const i = Number(t.dataset.rsProd); const l = ed.lines[i];
      if (l && l.productId) { l.productId = ''; l.code = ''; l.name = ''; }
      ed.dirty = true; openCombo(i, t.value); return;
    }
    if (t.matches('[data-rs-ed]')) { ed[t.dataset.rsEd] = t.value; ed.dirty = true; return; }
    if (t.matches('[data-rs-line]')) {
      const l = ed.lines[Number(t.dataset.i)]; if (!l) return;
      l[t.dataset.rsLine] = t.value; ed.dirty = true;
      if (t.dataset.rsLine === 'qty') {
        const c = document.querySelector('[data-rs-ed-count]');
        if (c) c.textContent = L(`${N(ed.lines.length)} منتج · ${N(ed.lines.reduce((s, x) => s + (Number(x.qty) || 0), 0))} قطعة`, `${N(ed.lines.length)} items · ${N(ed.lines.reduce((s, x) => s + (Number(x.qty) || 0), 0))} pcs`);
      }
    }
  });

  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t.matches && t.matches('[data-rs-prod]') && state.ed && !state.ed.lines[Number(t.dataset.rsProd)]?.productId) openCombo(Number(t.dataset.rsProd), t.value);
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-rs-filter]') && t.dataset.rsFilter !== 'q') { state.filter[t.dataset.rsFilter] = t.value; drawTable(); return; }
    const ed = state.ed; if (!ed) return;
    if (t.matches('[data-rs-ed]')) { ed[t.dataset.rsEd] = t.value; ed.dirty = true; return; }
    if (t.matches('select[data-rs-line="reason"]')) {
      const l = ed.lines[Number(t.dataset.i)]; if (!l) return;
      l.reason = t.value; ed.dirty = true; drawLines();
      if (t.value === 'other') document.querySelector(`[data-rs-line="reasonNote"][data-i="${t.dataset.i}"]`)?.focus();
      return;
    }
    if (t.matches('[data-rs-photo-input]')) {
      const l = ed.lines[Number(t.dataset.rsPhotoInput)]; if (!l) return;
      const room = 6 - ((l.attachments || []).filter((a) => !l._remove.has(a.id)).length + l._pending.length);
      const files = [...t.files].filter((f) => /^image\/(jpeg|png|webp|heic|heif)$/.test(f.type) && f.size <= 20 * 1024 * 1024);
      if (files.length < t.files.length) toastErr(L('بعض الملفات ليست صوراً مدعومة أو أكبر من 20 ميجابايت', 'Some files are not supported images or exceed 20 MB'));
      if (files.length > room) toastErr(L('الحد الأقصى 6 صور لكل منتج', 'At most 6 photos per item'));
      files.slice(0, Math.max(0, room)).forEach((f) => l._pending.push({ id: rid(), file: f, url: URL.createObjectURL(f) }));
      ed.dirty = true; t.value = ''; drawLines();
    }
  });

  // A language switch re-renders the panel (labels are built in JS).
  function refresh() { if (state.host && state.host.isConnected && state.supplierId) { drawShell(); drawTable(); } }

  window.SupplierReturnStatements = { render, refresh, canView, _state: state };
})();
