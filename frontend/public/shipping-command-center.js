/* Shipping is a view over the shared order resolver and issue lifecycle.
 * No shipment state is written here; existing order actions own mutations. */
(function () {
  'use strict';
  const PAGE_SIZE = 20;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { stage: 'all', q: '', carrier: '', sort: 'date-desc', page: 1 };
  let rows = [], mounted = false, timer, account = '', restored = false;
  const tr = (ar, en) => currentLang === 'en' ? en : ar;
  const $ = id => document.getElementById(id);
  const html = (id, value) => { const el = $(id); if (el && el.innerHTML !== value) el.innerHTML = value; };
  const text = (id, value) => { const el = $(id); if (el && el.textContent !== value) el.textContent = value; };
  const labels = () => ({
    all: tr('كل الطلبات', 'All orders'), Preparing: SouliaOrderStatus.text('Preparing', currentLang),
    Ready: SouliaOrderStatus.text('Ready', currentLang), Shipped: SouliaOrderStatus.text('Shipped', currentLang),
    IN_TRANSIT: SouliaOrderStatus.text('IN_TRANSIT', currentLang),
    OUT_FOR_DELIVERY: SouliaOrderStatus.text('OUT_FOR_DELIVERY', currentLang),
    DELIVERED: SouliaOrderStatus.text('DELIVERED', currentLang), issues: tr('مشاكل الشحن', 'Shipping issues'),
    waiting: tr('بانتظار التجهيز', 'Awaiting prep'), other: tr('حالات أخرى', 'Other statuses'),
    delayed: tr('شحنات متأخرة', 'Delayed shipments'), failed: tr('تعذّر التسليم', 'Failed deliveries'),
    pickup: tr('بانتظار استلام المندوب', 'Pending pickup'),
  });
  const stages = () => ['Preparing', 'Ready', 'Shipped', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', ...(isAdmin() ? ['DELIVERED'] : []), 'issues'];
  const tone = key => key === 'issues' || key === 'failed' ? 'issue' : key === 'DELIVERED' ? 'delivered' : key === 'Ready' || key === 'delayed' || key === 'pickup' ? 'ready' : 'shipping';
  const icon = key => _trkIcon(key === 'DELIVERED' ? 'delivered' : key === 'issues' ? 'stopped' : key === 'Ready' ? 'created' : 'transit');
  const timestamp = value => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const dateLabel = value => {
    const at = timestamp(value);
    return at === null ? '—' : new Intl.DateTimeFormat(currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn',
      { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Cairo' }).format(at);
  };
  // Registration and last sync are not courier hand-off dates. Missing shipment
  // dates stay unknown; re-syncing a parcel must never reset its age.
  function shipmentAge(tx, meta) {
    if (['Pending', 'Preparing', 'Ready'].includes(meta.key)) return null;
    const at = timestamp(tx.shippedAt);
    return at === null ? null : Math.max(0, Math.floor((Date.now() - at) / 86400000));
  }
  function model(source) {
    const seen = new Set();
    const stageKeys = new Set(stages());
    return (source || []).flatMap(tx => {
      if (!tx || tx.type !== 'مبيعات' || tx.cancelled || tx.archived || seen.has(String(tx._id))) return [];
      seen.add(String(tx._id));
      const meta = _orderStateMeta(tx);
      if (['CANCELLED', 'customer_cancelled'].includes(meta.key) || (!isAdmin() && meta.key === 'DELIVERED')) return [];
      const issue = meta.key !== 'DELIVERED' && _dashIsOpenIssue(tx, meta);
      const stage = issue ? 'issues' : ['PICKED_UP', 'Shipped'].includes(meta.key) ? 'Shipped'
        : meta.key === 'CUSTOMER_POSTPONED' ? 'IN_TRANSIT' : meta.key === 'Pending' ? 'waiting'
        : stageKeys.has(meta.key) ? meta.key : 'other';
      const carrier = String(tx.shipCo || meta.carrier || '').trim();
      return [{ tx, meta, stage, carrier, issue, age: shipmentAge(tx, meta),
        search: [tx.ref, tx.client, tx.phone, tx.bostaTrackingNumber].filter(Boolean).join(' ').toLocaleLowerCase() }];
    });
  }
  function matches(row, stage) {
    if (stage === 'delayed') return row.meta.delayed === true;
    if (stage === 'failed') return row.issue && ISSUE_SHIP_KEYS.includes(row.meta.key);
    if (stage === 'pickup') return row.stage === 'Ready';
    return stage === 'all' || row.stage === stage;
  }
  function readURL() {
    const params = new URL(location.href).searchParams;
    state.stage = Object.hasOwn(labels(), params.get('shipStage')) ? params.get('shipStage') : 'all';
    if (!isAdmin() && state.stage === 'DELIVERED') state.stage = 'all';
    state.q = (params.get('shipSearch') || '').slice(0, 150);
    state.carrier = params.get('shipCarrier') || '';
    state.sort = ['date-desc', 'date-asc', 'status-asc', 'status-desc'].includes(params.get('shipSort')) ? params.get('shipSort') : 'date-desc';
    state.page = Math.max(1, Math.min(100000, Number.parseInt(params.get('shipPage'), 10) || 1));
  }
  function writeURL() {
    const url = new URL(location.href);
    const values = { shipStage: state.stage === 'all' ? '' : state.stage, shipSearch: state.q,
      shipCarrier: state.carrier, shipSort: state.sort === 'date-desc' ? '' : state.sort, shipPage: state.page === 1 ? '' : state.page };
    Object.entries(values).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  }
  function select(stage, clear = false) {
    if (!Object.hasOwn(labels(), stage) || (stage === 'DELIVERED' && !isAdmin())) return;
    state.stage = stage; state.page = 1;
    if (clear) { state.q = ''; state.carrier = ''; }
    writeURL(); paint();
  }
  function syncFilters() {
    for (const id of ['scc-carrier', 'scc-status', 'scc-sort']) {
      const field = $(id);
      const snapshot = JSON.stringify([field.innerHTML, field.value, currentLang]);
      const previousButton = field.parentElement.querySelector('.fsel-btn');
      if (field._shippingOptions !== snapshot && previousButton?.classList.contains('is-open')) {
        fselClose(); previousButton.focus({ preventScroll: true });
      }
      field._shippingOptions = snapshot;
      fselInit(field, { size: 'lg' });
      fselSync(field);
      const button = field.parentElement.querySelector('.fsel-btn');
      button.id = id + '-trigger';
      field.tabIndex = -1;
      field.setAttribute('aria-hidden', 'true');
      field.closest('label').htmlFor = button.id;
      const caption = button.querySelector('.fsel-lbl');
      caption.id = id + '-value';
      button.setAttribute('aria-labelledby', id + '-label ' + caption.id);
      // Shared selects treat any non-empty value as active; our defaults are
      // named values, so keep the unfiltered/default controls neutral.
      button.classList.toggle('is-active', field.value !== ({ 'scc-carrier': '', 'scc-status': 'all', 'scc-sort': 'date-desc' }[id]));
      if (button.dataset.shippingFilter) continue;
      button.dataset.shippingFilter = '1';
      button.addEventListener('click', () => setupFilterPanel(field, button));
      button.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        if (button.getAttribute('aria-expanded') !== 'true') button.click();
        else document.getElementById(id + '-listbox')?.querySelector('.fsel-search input,.fsel-opt.is-sel,.fsel-opt')?.focus({ preventScroll: true });
      });
    }
  }
  function setupFilterPanel(field, button) {
    if (button.getAttribute('aria-expanded') !== 'true') return;
    const panel = [...document.querySelectorAll('.fsel-panel-portal')].at(-1);
    if (!panel) return;
    panel.id = field.id + '-listbox';
    panel.classList.add('scc-filter-panel');
    panel.dir = currentLang === 'en' ? 'ltr' : 'rtl';
    panel.setAttribute('aria-labelledby', field.id + '-label');
    button.setAttribute('aria-controls', panel.id);
    const search = panel.querySelector('input');
    if (search) search.setAttribute('aria-label', tr('بحث في الخيارات', 'Search options'));
    else panel.querySelector('.fsel-opt.is-sel,.fsel-opt')?.focus({ preventScroll: true });
    panel.addEventListener('click', event => {
      if (event.target.closest('.fsel-opt')) button.focus({ preventScroll: true });
    });
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        fselClose(); button.focus({ preventScroll: true }); return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (event.target === search && ['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const options = [...panel.querySelectorAll('.fsel-opt')];
      const index = options.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) : index < 0 ? options.length - 1 : Math.max(0, index - 1);
      options[next]?.focus({ preventScroll: true });
      options[next]?.scrollIntoView({ block: 'nearest' });
    });
  }
  function mount() {
    if (mounted) return;
    mounted = true;
    const root = $('shipping-command-center');
    root.addEventListener('click', event => {
      const stage = event.target.closest('[data-ship-stage]');
      if (stage) { select(stage.dataset.shipStage); return; }
      const page = event.target.closest('[data-ship-page]');
      if (page) { state.page += Number(page.dataset.shipPage); writeURL(); paintTable(); return; }
      const sort = event.target.closest('[data-ship-sort]');
      if (sort) { state.sort = sort.dataset.shipSort + (state.sort === sort.dataset.shipSort + '-asc' ? '-desc' : '-asc'); state.page = 1; writeURL(); paint(); }
      if (event.target.closest('[data-ship-clear]')) { Object.assign(state, { stage: 'all', q: '', carrier: '', page: 1 }); writeURL(); paint(); }
    });
    $('scc-search').addEventListener('input', event => {
      state.q = event.target.value; state.page = 1;
      clearTimeout(timer); timer = setTimeout(() => { writeURL(); paintTable(); }, 120);
    });
    for (const [id, key] of [['scc-carrier', 'carrier'], ['scc-status', 'stage'], ['scc-sort', 'sort']]) {
      $(id).addEventListener('change', event => { state[key] = event.target.value; state.page = 1; writeURL(); paint(); });
    }
    $('scc-body').addEventListener('focusout', () => queueMicrotask(() => {
      if ([...$('scc-body').children].some(row => row._shippingDeferred)) paintTable();
    }));
    $('dash-attn').addEventListener('click', event => {
      const button = event.target.closest('[data-ship-attention]');
      if (button) { select(button.dataset.shipAttention, true); $('scc-table-title').scrollIntoView({ block: 'nearest', behavior: 'auto' }); }
    });
    window.addEventListener('popstate', () => { if (currentPage === 'dashboard') { readURL(); paint(); } });
  }
  function render(source) {
    if (!$('shipping-command-center')) return;
    const key = String(currentUser?._id || currentUser?.id || '') + ':' + String(currentUser?.role || '');
    if (account !== key) { account = key; restored = false; }
    if (!restored) { readURL(); restored = true; }
    if (!isAdmin() && state.stage === 'DELIVERED') state.stage = 'all';
    rows = model(source);
    if ($('scc-loading')) $('scc-loading').hidden = true;
    $('shipping-command-center').setAttribute('aria-busy', 'false');
    mount(); paint();
  }
  function paint() {
    const names = labels(), list = stages();
    const unavailable = !rows.length && typeof loadFailed === 'function' && loadFailed('transactions');
    const count = key => unavailable ? '—' : fmtN(counts[key]);
    const counts = Object.fromEntries(Object.keys(names).map(key => [key, rows.filter(row => matches(row, key)).length]));
    text('scc-title', tr('مركز عمليات الشحن', 'Shipping command center'));
    text('scc-scope', tr('الطلبات المتاحة · اختر حالة للمتابعة', 'Available orders · select a status to follow up'));
    text('scc-orders-link', tr('إدارة التجهيز والاستلام', 'Manage preparation & pickup'));
    $('scc-orders-link').hidden = !hasPerm('pickup-orders');
    text('scc-pipeline-title', tr('مسار الشحن', 'Shipping pipeline'));
    text('scc-pipeline-total', unavailable ? tr('بيانات الشحن غير متاحة', 'Shipping data unavailable') : tr('إجمالي الطلبات المتاحة', 'Available orders') + ' · ' + fmtN(rows.length));
    html('dash-ship-kpis', [...(isAdmin() ? ['DELIVERED'] : []), 'IN_TRANSIT', 'Ready', 'issues'].map(key =>
      `<button type="button" class="scc-kpi" data-tone="${tone(key)}" data-ship-stage="${key}" aria-pressed="${state.stage === key}">
        <span class="scc-kpi-label">${esc(names[key])}${icon(key)}</span><strong>${esc(count(key))}</strong>
        <span class="scc-kpi-note">${esc(key === 'issues' ? tr('تحتاج معالجة', 'Need resolution') : key === 'Ready' ? tr('بانتظار المندوب', 'Awaiting courier') : key === 'DELIVERED' ? tr('تم التسليم للعميل', 'Received by customer') : tr('عبر شبكة الشحن', 'Moving through carrier network'))}</span>
      </button>`).join(''));
    // Additional real states remain visible, so the distribution always sums to
    // its denominator, including unprepared orders and resolved exceptions.
    const distribution = [...(counts.waiting ? ['waiting'] : []), ...list, ...(counts.other ? ['other'] : [])];
    html('scc-distribution', distribution.filter(key => counts[key]).map(key => `<button type="button" data-ship-stage="${key}" data-tone="${tone(key)}" style="flex-grow:${counts[key]}" title="${esc(names[key])}: ${esc(fmtN(counts[key]))}" aria-label="${esc(names[key])}: ${esc(fmtN(counts[key]))}"></button>`).join(''));
    html('scc-stages', ['all', ...distribution].map(key => `<button type="button" data-ship-stage="${key}" aria-pressed="${state.stage === key}" data-tone="${tone(key)}"><span>${esc(names[key])}</span><strong>${esc(count(key))}</strong></button>`).join(''));
    text('scc-table-title', tr('طلبات الشحن', 'Shipping orders'));
    text('scc-search-label', tr('بحث الطلبات', 'Search orders'));
    $('scc-search').placeholder = tr('رقم الطلب، العميل أو رقم التتبع…', 'Order, customer or tracking number…');
    if ($('scc-search').value !== state.q) $('scc-search').value = state.q;
    text('scc-carrier-label', tr('شركة الشحن', 'Shipping company'));
    const carriers = [...new Set(rows.map(row => row.carrier).filter(Boolean))].sort();
    if (state.carrier && !carriers.includes(state.carrier)) carriers.push(state.carrier);
    html('scc-carrier', `<option value="">${esc(t('puAllShipCos'))}</option>` + carriers.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join(''));
    $('scc-carrier').value = state.carrier;
    text('scc-status-label', tr('حالة الشحن', 'Shipping status'));
    html('scc-status', Object.entries(names).filter(([key]) => isAdmin() || key !== 'DELIVERED').map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join(''));
    $('scc-status').value = state.stage;
    text('scc-sort-label', tr('ترتيب الطلبات', 'Sort orders'));
    html('scc-sort', [['date-desc', tr('الأحدث أولًا', 'Newest first')], ['date-asc', tr('الأقدم أولًا', 'Oldest first')], ['status-asc', tr('الحالة: تصاعدي', 'Status: ascending')], ['status-desc', tr('الحالة: تنازلي', 'Status: descending')]].map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join(''));
    $('scc-sort').value = state.sort;
    syncFilters();
    text('scc-reset', tr('مسح الفلاتر', 'Clear filters'));
    paintTable(); attention();
  }
  function paintTable() {
    const names = labels(), query = state.q.trim().toLocaleLowerCase().replace(/^#/, '');
    const filtered = rows.filter(row => matches(row, state.stage) && (!state.carrier || row.carrier === state.carrier) && (!query || row.search.includes(query)));
    const rank = ['waiting', 'Preparing', 'Ready', 'Shipped', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'issues', 'other'];
    filtered.sort((a, b) => {
      const direction = state.sort.endsWith('asc') ? 1 : -1;
      if (state.sort.startsWith('status')) return direction * (rank.indexOf(a.stage) - rank.indexOf(b.stage)) || String(a.tx._id).localeCompare(String(b.tx._id));
      const at = timestamp(a.tx.date || a.tx.createdAt), bt = timestamp(b.tx.date || b.tx.createdAt);
      if (at === null || bt === null) return at === bt ? 0 : at === null ? 1 : -1;
      return direction * (at - bt) || String(a.tx._id).localeCompare(String(b.tx._id));
    });
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const previousPage = state.page;
    state.page = Math.max(1, Math.min(pages, state.page));
    if (state.page !== previousPage) writeURL();
    const start = (state.page - 1) * PAGE_SIZE, visible = filtered.slice(start, start + PAGE_SIZE);
    text('scc-result', `${names[state.stage]} · ${fmtN(filtered.length)} ${tr('طلب', 'orders')}`);
    const sortHead = (key, label) => `<th scope="col" aria-sort="${state.sort.startsWith(key) ? state.sort.endsWith('asc') ? 'ascending' : 'descending' : 'none'}"><button type="button" data-ship-sort="${key}">${esc(label)} <span aria-hidden="true">${state.sort === key + '-asc' ? '↑' : state.sort === key + '-desc' ? '↓' : '↕'}</span></button></th>`;
    html('scc-head', `<tr><th scope="col">${esc(tr('رقم الطلب', 'Order number'))}</th><th scope="col">${esc(tr('العميل', 'Customer'))}</th><th scope="col">${esc(tr('شركة الشحن', 'Shipping company'))}</th>${sortHead('date', tr('تاريخ الطلب', 'Order date'))}<th scope="col" class="scc-number">${esc(tr('أيام منذ الشحن', 'Days since shipment'))}</th>${sortHead('status', tr('حالة الشحن', 'Shipping status'))}<th scope="col">${esc(tr('إجراءات', 'Actions'))}</th></tr>`);
    // Keyed reconciliation preserves open menus, focus and scroll on unchanged
    // socket updates. Only one page of rows is ever mounted.
    const body = $('scc-body'), existing = new Map([...body.children].map(el => [el.dataset.orderId, el]));
    const arriving = !body.children.length; // Cascade Reveal on the first fill only
    let cursor = body.firstElementChild;
    for (const row of visible) {
      const id = String(row.tx._id), markup = rowHTML(row);
      let el = existing.get(id);
      if (!el) { el = document.createElement('tr'); el.dataset.orderId = id; }
      if (el._shippingHTML !== markup) {
        // Keep an actively used action menu intact until it closes.
        if (!el.contains(document.activeElement)) { el.innerHTML = markup; el._shippingHTML = markup; el._shippingDeferred = false; }
        else el._shippingDeferred = true;
      }
      if (el !== cursor) body.insertBefore(el, cursor);
      cursor = el.nextElementSibling; existing.delete(id);
    }
    existing.forEach(el => el.remove());
    if (arriving && visible.length) window.souliaCascade?.(body);
    const failed = typeof loadFailed === 'function' && loadFailed('transactions');
    $('scc-empty').hidden = visible.length > 0;
    html('scc-empty', `<strong>${esc(failed ? tr('تعذّر تحديث الطلبات', 'Could not refresh orders') : rows.length ? tr('لا توجد طلبات تطابق الفلاتر', 'No orders match these filters') : tr('لا توجد طلبات شحن حاليًا', 'No shipping orders yet'))}</strong><p>${esc(failed ? tr('أعد المحاولة لتحميل بيانات الشحن.', 'Retry to load shipping data.') : tr('ستظهر هنا الطلبات المسجلة وحالات شحنها.', 'Registered orders and their shipping progress appear here.'))}</p>${failed ? `<button type="button" onclick="reloadAllData()">${esc(tr('إعادة المحاولة', 'Retry'))}</button>` : rows.length ? `<button type="button" data-ship-clear>${esc(tr('مسح الفلاتر', 'Clear filters'))}</button>` : ''}`);
    text('scc-data-state', failed && rows.length ? tr('تعذّر التحديث · تظهر آخر بيانات متاحة', 'Refresh failed · showing last available data') : '');
    text('scc-page-info', `${fmtN(filtered.length ? start + 1 : 0)}–${fmtN(Math.min(start + PAGE_SIZE, filtered.length))} ${tr('من', 'of')} ${fmtN(filtered.length)}`);
    text('scc-prev', tr('السابق', 'Previous')); text('scc-next', tr('التالي', 'Next'));
    $('scc-prev').disabled = state.page <= 1; $('scc-next').disabled = state.page >= pages;
    $('scc-pagination').hidden = pages === 1 && filtered.length === 0;
  }
  function rowHTML(row) {
    const { tx, meta, age } = row, id = esc(JSON.stringify(String(tx._id)));
    const actions = _dashShippingActions(tx, meta);
    const tracking = tx.bostaTrackingNumber;
    return `<td><button type="button" class="scc-order-link" onclick="openOrderView(${id})"><bdi>#${esc(tx.ref || '—')}</bdi></button></td>
      <td class="scc-customer" title="${esc(tx.client || '')}">${esc(tx.client || '—')}</td>
      <td><span>${esc(row.carrier || '—')}</span>${tracking ? `<a class="scc-tracking" href="https://bosta.co/ar-eg/tracking-shipments?shipment-number=${encodeURIComponent(tracking)}" target="_blank" rel="noopener" aria-label="${esc(tr('تتبع الشحنة', 'Track shipment') + ' ' + tracking)}"><bdi>${esc(tracking)}</bdi> ↗</a>` : ''}</td>
      <td class="scc-date"><time datetime="${esc(tx.date || tx.createdAt || '')}">${esc(dateLabel(tx.date || tx.createdAt))}</time>${age === null ? '' : `<span class="scc-age-inline"> · <bdi>${esc(fmtN(age))}</bdi> ${esc(tr('يوم منذ الشحن', 'd since shipped'))}</span>`}</td>
      <td class="scc-number" title="${esc(age === null ? tr('تاريخ الشحن الفعلي غير مسجل', 'Actual shipment date not recorded') : dateLabel(tx.shippedAt))}">${age === null ? '—' : esc(fmtN(age))}</td>
      <td><div class="scc-status-cell">${SouliaOrderStatus.badge(meta, { compact: true, hideCarrier: true })}${actions.extras ? `<span class="scc-extras">${actions.extras}</span>` : ''}</div></td>
      <td><div class="scc-actions">${actions.bostaBizBtn}${actions.menu}</div></td>`;
  }
  function attention() {
    const el = $('dash-attn'); if (!el) return;
    $('dash-attn-section').style.display = '';
    const names = labels();
    const items = ['issues', 'delayed', 'failed', 'pickup'].map(key => ({ key, count: rows.filter(row => matches(row, key)).length })).filter(item => item.count);
    const low = isAdmin() && Array.isArray(inventoryCache) ? inventoryCache.filter(item => item.isActive !== false && ['low', 'منخفض'].includes(item.status)).length : 0;
    const unavailable = !rows.length && typeof loadFailed === 'function' && loadFailed('transactions');
    html('dash-attn', items.map(({ key, count }) => `<button type="button" class="scc-attention-row" data-ship-attention="${key}" data-tone="${tone(key)}"><span>${esc(names[key])}</span><strong>${esc(fmtN(count))}</strong><span aria-hidden="true">${currentLang === 'en' ? '›' : '‹'}</span></button>`).join('')
      + (low ? `<button type="button" class="scc-attention-row" onclick="SouliaShipping.lowStock()"><span>${esc(t('dsAttnLowStock'))}</span><strong>${esc(fmtN(low))}</strong><span aria-hidden="true">${currentLang === 'en' ? '›' : '‹'}</span></button>` : '')
      + (unavailable ? `<p class="scc-quiet">${esc(tr('تنبيهات الشحن غير متاحة حتى يتم تحميل الطلبات.', 'Shipping alerts are unavailable until orders load.'))}</p>` : !items.length && !low ? `<p class="scc-quiet">${esc(tr('لا توجد تنبيهات شحن مفتوحة.', 'No open shipping alerts.'))}</p>` : '')
      + (items.length ? `<p class="scc-quiet">${esc(tr('قد يظهر الطلب في أكثر من تنبيه.', 'An order may appear in more than one alert.'))}</p>` : ''));
  }
  async function lowStock() {
    if (!isAdmin() || !hasPerm('inventory')) return;
    await navigateTo('inventory');
    fxResetAll('inv');
    setInvFilter('low', document.querySelector('#inv-toolbar [data-status="low"]'));
  }
  function manageTeam() {
    if (!isAdmin() || !hasPerm('settings')) return;
    localStorage.setItem('stg_active_inner_page', 'workforce');
    navigateTo('settings');
  }
  function openMenu(event) {
    const trigger = event.currentTarget;
    toggleActionMenu(event);
    const portal = document.querySelector('.dd-menu-portal');
    if (!portal) return;
    portal.querySelector('button')?.focus();
    portal.addEventListener('keydown', key => {
      if (key.key === 'Escape') { key.preventDefault(); closeAllMenus(); trigger.focus(); }
    });
  }
  window.SouliaShipping = { render, attention, select, lowStock, manageTeam, openMenu, model, shipmentAge };
})();
