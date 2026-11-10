/* Customer list and profile. All analysis comes from the complete server-side order history. */
window.SouliaClients = (() => {
  const CLIENTS_PAGE_SIZE = 30;
  let rows = [], loading = null, loadedAt = 0, loadedRevision = '', profile = null, serial = 0;
  let account = '', dataEpoch = 0;
  let refreshTimer = 0, profileStale = false;
  const profileCache = new Map(), profileTasks = new Map(), ticketCache = new Map(), ticketTasks = new Map();
  const orderSummaries = new Map();
  let summaryRefreshTimer = 0;
  let ticketsOpen = false, listScroll = 0, restoreListScroll = false;
  let navigationState = null;
  const connectedSockets = new WeakSet();
  let filter = 'all', query = '';
  const $ = selector => document.querySelector(selector);
  const tr = (ar, en) => currentLang === 'en' ? en : ar;
  const e = value => esc(String(value ?? ''));
  const enc = value => encodeURIComponent(String(value));
  const n = value => fmtN(value);
  const revision = () => String(typeof _apiWriteRevision === 'undefined' ? '' : _apiWriteRevision)
    + ':' + String(typeof _transactionLiveRevision === 'undefined' ? '' : _transactionLiveRevision);
  const labels = {
    delivered: ['تم الاستلام', 'Delivered'], failed: ['فشل الاستلام', 'Failed delivery'],
    cancelledBefore: ['إلغاء قبل التسجيل', 'Cancelled before registration'], cancelledAfter: ['إلغاء بعد التسجيل', 'Cancelled after registration'],
    active: ['طلبات جارية', 'In progress'], returns: ['مرتجع بعد الاستلام', 'After-sales returns'],
    unknown: ['نتيجة غير مسجّلة', 'Outcome not recorded'],
    all: ['كل الطلبات', 'All orders'], insufficient: ['سجل غير كافٍ للتقييم', 'Not enough history'],
    reliable: ['منتظم في الاستلام', 'Reliable recipient'], valued: ['عميل مميز', 'Valued customer'],
    confirmFirst: ['تأكيد قبل الشحن', 'Confirm before shipping'], depositRecommended: ['يُفضّل عربون قبل الشحن', 'Deposit recommended'],
    documentedFake: ['بيانات غير صحيحة مسجّلة', 'Invalid details recorded'],
    refused: ['رفض الاستلام', 'Customer refused delivery'], unreachable: ['تعذّر الوصول للعميل', 'Customer unreachable'],
    'bad-address': ['عنوان غير صحيح', 'Incorrect address'], 'courier-error': ['خطأ شركة الشحن', 'Courier error'], lost: ['فقد الشحنة', 'Shipment lost'],
  };
  const label = key => labels[key] ? tr(...labels[key]) : key;
  const tone = p => ['documentedFake', 'depositRecommended'].includes(p.assessment) ? 'risk'
    : p.assessment === 'confirmFirst' ? 'warning' : ['reliable', 'valued'].includes(p.assessment) ? 'good' : 'neutral';
  const badge = p => `<span class="cp-badge cp-${tone(p)}">${e(label(p.assessment))}</span>`;
  const routeKey = () => {
    const parts = location.hash.slice(1).split('/');
    if (parts[0] !== 'clients' || parts[1] !== 'profile') return '';
    try { return decodeURIComponent(parts.slice(2).join('/')); } catch { return ''; }
  };
  const pathFor = p => p.profilePath || '#clients/profile/' + enc(p.key);
  const matches = (p, key) => p && (p.key === key || p.code === key || p.code && key.endsWith('~' + p.code));
  const backLink = () => navBackBtnHtml({ forPage: 'clients', cls: 'cp-back' });
  function syncAccount() {
    const session = localStorage.getItem('token') || String(currentUser?._id || currentUser?.username || '');
    if (account === session) return;
    account = session; dataEpoch++; serial++; rows = []; loading = null; loadedAt = 0; profile = null;
    profileCache.clear(); profileTasks.clear(); ticketCache.clear(); ticketTasks.clear();
    orderSummaries.clear(); clearTimeout(summaryRefreshTimer);
    selectedClientNames.clear();
  }
  function cached(reference) {
    const item = profileCache.get(reference);
    return item && item.expires > Date.now() && item.revision === revision() ? item.data : null;
  }
  function remember(data, reference) {
    const item = { data, expires: Date.now() + 30000, revision: revision() };
    const named = decodeURIComponent(pathFor(data).split('/').pop());
    [data.key, data.code, named, reference].filter(Boolean).forEach(key => profileCache.set(key, item));
    while (profileCache.size > 80) profileCache.delete(profileCache.keys().next().value);
    return data;
  }
  async function getProfile(reference, force = false) {
    syncAccount();
    const known = !force && cached(reference);
    if (known) return known;
    if (profileTasks.has(reference)) return profileTasks.get(reference);
    const lookup = /^order:(transaction|shopify):(.+)$/.exec(reference);
    if (!force && lookup) {
      for (const item of new Set(profileCache.values())) {
        if (item.expires <= Date.now() || item.revision !== revision()) continue;
        if (item.data.history.some(r => lookup[1] === 'transaction' ? r.source === 'transaction' && r.id === lookup[2]
          : r.orderId === lookup[2] || r.source === 'shopify' && r.id === lookup[2])) return remember(item.data, reference);
      }
    }
    const url = lookup ? '/clients/order-profile?id=' + enc(lookup[2]) + '&source=' + lookup[1]
      : '/clients/profile?key=' + enc(reference);
    const epoch = dataEpoch;
    const task = api(url).then(data => {
      if (!data?.stats || !Array.isArray(data.history)) throw new Error(tr('بيانات العميل غير متاحة', 'Customer data unavailable'));
      return epoch === dataEpoch ? remember(data, reference) : data;
    }).finally(() => { if (profileTasks.get(reference) === task) profileTasks.delete(reference); });
    profileTasks.set(reference, task);
    return task;
  }
  function view(detail) {
    $('#clients-list-view').hidden = detail;
    $('#clients-profile-view').hidden = !detail;
  }
  function failure(message, retry = 'refresh') {
    return `<div class="cp-empty" role="alert"><p>${e(message)}</p><button class="btn btn-outline" data-cp="${retry}">${tr('إعادة المحاولة', 'Retry')}</button></div>`;
  }
  async function load(force = false) {
    if (loading) return loading;
    if (!force && loadedAt && Date.now() - loadedAt < 30000 && loadedRevision === revision()) return rows;
    const requestedRevision = revision();
    const epoch = dataEpoch;
    loading = api('/clients').then(data => {
      if (epoch !== dataEpoch) return rows;
      if (!Array.isArray(data)) throw new Error(tr('تعذّر تحميل بيانات العملاء', 'Unable to load clients'));
      rows = data; loadedAt = Date.now(); loadedRevision = requestedRevision;
      return rows;
    }).finally(() => { if (epoch === dataEpoch) loading = null; });
    return loading;
  }
  async function renderList() {
    if (!$('#clients-list-view')) return;
    syncAccount();
    const key = routeKey();
    if (key) {
      view(true);
      if (profileStale || !cached(key) || !matches(profile, key) || !$('#clients-profile-view').querySelector('.cp-profile')) await showProfile(key);
      else paintProfile();
      return;
    }
    serial++; profile = null; view(false);
    const host = $('#clients-grid');
    if (!loadedAt && !rows.length) host.innerHTML = `<div class="cp-empty" role="status">${tr('جارٍ تحميل العملاء…', 'Loading clients…')}</div>`;
    const epoch = dataEpoch;
    try { await load(); }
    catch (error) { if (epoch === dataEpoch) host.innerHTML = failure(error.message); return; }
    if (epoch !== dataEpoch || currentPage !== 'clients' || routeKey()) return;
    const tokens = normalizeUiSearch($('#clients-search')?.value || '').split(/\s+/).filter(Boolean);
    const debt = $('#clients-has-remaining')?.value;
    const sort = $('#clients-order-filter')?.value;
    let data = rows.filter(p => {
      const blob = normalizeUiSearch([p.name, ...p.phones, p.email].join(' '));
      return tokens.every(token => blob.includes(token)) && (debt === '1' ? p.money.remaining > 0 : debt === '0' ? p.money.remaining <= 0
        : debt === 'no-invoice' ? p.stats.invoices === 0 : true);
    });
    data.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'total' ? b.money.total - a.money.total
      : sort === 'remaining' ? b.money.remaining - a.money.remaining : b.stats.orders - a.stats.orders);
    clientsPage = Math.max(1, Math.min(clientsPage, Math.ceil(data.length / CLIENTS_PAGE_SIZE) || 1));
    const pageRows = data.slice((clientsPage - 1) * CLIENTS_PAGE_SIZE, clientsPage * CLIENTS_PAGE_SIZE);
    const isList = $('#clients-view-mode')?.value === 'list';
    host.className = isList ? 'cp-list' : 'cp-client-grid'; host.style.display = '';
    const select = p => `<input type="checkbox" data-cp-select="${e(p.key)}" aria-label="${e(tr('تحديد ', 'Select ') + p.name)}" ${selectedClientNames.has(p.key) ? 'checked' : ''}>`;
    const name = p => `<a class="cp-client-name" href="${e(pathFor(p))}" data-cp-open="${e(p.key)}">${e(p.name)}</a><small class="cp-name-orders">${n(p.stats.orders)} ${tr('طلبات', 'orders')}</small>${p.stats.invoices === 0 ? `<small class="cp-no-invoice">${tr('بدون فاتورة حتى الآن', 'No invoice yet')}</small>` : ''}`;
    const rate = p => p.stats.deliveryRate === null ? '—' : n(p.stats.deliveryRate) + '%';
    host.innerHTML = !pageRows.length ? `<div class="cp-empty">${tr('لا يوجد عملاء مطابقون', 'No matching clients')}</div>` : isList
      ? `<div class="cp-table-scroll"><table class="cp-table"><thead><tr><th></th><th>${tr('العميل', 'Client')}</th><th>${tr('التقييم', 'Assessment')}</th><th>${tr('نجاح الاستلام', 'Delivery success')}</th><th>${tr('المتبقي', 'Due')}</th></tr></thead><tbody>${pageRows.map(p => `<tr><td>${select(p)}</td><td>${name(p)}<small><bdi>${e(p.phone || p.email || '—')}</bdi></small></td><td>${badge(p)}</td><td>${rate(p)}</td><td>${fmtJ(p.money.remaining)}</td></tr>`).join('')}</tbody></table></div>`
      : pageRows.map(p => `<article class="cp-client-card" data-cp-card="${e(p.key)}"><div class="cp-card-top"><span class="cp-avatar" aria-hidden="true">${e(p.name.slice(0, 1))}</span><div>${name(p)}<small><bdi>${e(p.phone || p.email || tr('بدون بيانات تواصل', 'No contact details'))}</bdi></small></div>${select(p)}</div>${badge(p)}<footer>${tr('آخر طلب', 'Last order')} · ${e(fmtDate(p.lastOrder))}</footer></article>`).join('');
    renderPagination('clients-pagination', data.length, clientsPage, CLIENTS_PAGE_SIZE, 'setClientsPage');
    updateClientsSelBar();
    if (restoreListScroll) { restoreListScroll = false; requestAnimationFrame(() => window.scrollTo(0, listScroll)); }
  }
  function open(key) {
    if (!_requirePageAccess('clients')) return;
    if (currentPage === 'clients' && !routeKey()) { listScroll = window.scrollY; restoreListScroll = true; }
    const known = cached(key) || rows.find(p => matches(p, key));
    const path = known ? pathFor(known) : '#clients/profile/' + enc(key);
    const invoiceOpen = $('#inv-detail-overlay')?.classList.contains('active');
    const destination = new URL(location.href); destination.hash = path;
    ['sale','purchase','return','tx','invoice'].forEach(param => destination.searchParams.delete(param));
    if (location.href !== destination.href) history.pushState(null, '', destination);
    if (invoiceOpen) closeInvoiceDetail();
    if (currentPage !== 'clients') navigateTo('clients', false);
    else showProfile(routeKey());
    window.scrollTo(0, 0);
  }
  async function showProfile(key) {
    syncAccount();
    const request = ++serial;
    const requestEpoch = dataEpoch;
    if (navigationState?.reference === key) {
      filter = navigationState.filter; query = navigationState.query; ticketsOpen = navigationState.ticketsOpen; navigationState = null;
    } else if (!matches(profile, key)) { filter = 'all'; query = ''; ticketsOpen = false; }
    profile = null; view(true);
    const fast = cached(key);
    if (!fast) $('#clients-profile-view').innerHTML = backLink() + `<div class="cp-empty" role="status">${tr('جارٍ تحميل بروفايل العميل…', 'Loading customer profile…')}</div>`;
    try {
      const data = fast || await getProfile(key);
      if (request !== serial || routeKey() !== key || currentPage !== 'clients') return;
      if (requestEpoch !== dataEpoch) return showProfile(key);
      if (location.hash !== pathFor(data)) history.replaceState(null, '', pathFor(data));
      profile = data; profileStale = false; paintProfile();
      $('#clients-profile-view h1')?.focus({ preventScroll: true });
    } catch (error) {
      if (request !== serial || routeKey() !== key) return;
      $('#clients-profile-view').innerHTML = backLink() + failure(error.message, 'retry-profile');
    }
  }
  function reason(row) {
    if (row.reasonCode && typeof cancelReasonLabel === 'function') {
      const title = cancelReasonLabel(row.reasonCode);
      return row.reason && currentLang !== 'en' && row.reason !== title ? row.reason : title;
    }
    return row.reason && row.reason !== row.failureCode ? row.reason : (row.failureCode ? label(row.failureCode) : '');
  }
  function evidence(p) {
    const s = p.stats;
    if (s.fake) return tr(`سُجّل ${s.fake} طلب ببيانات وهمية أو غير صحيحة. راجع التفاصيل قبل الشحن.`, `${s.fake} order(s) recorded with invalid details. Review before shipping.`);
    if (s.recentCustomerIssues) return tr(`${s.recentCustomerIssues} إلغاء أو تعثّر استلام بسبب يخص العميل، ضمن آخر ${s.recentOrders} طلبات محسومة.`, `${s.recentCustomerIssues} customer-related issue(s) in the last ${s.recentOrders} resolved orders.`);
    if (['valued', 'reliable'].includes(p.assessment)) return tr(`استلم ${s.delivered} طلبات بنجاح؛ لا توجد مشكلات تخص العميل في آخر ${s.recentOrders} طلبات محسومة.`, `${s.delivered} successful deliveries; no customer-related issues in the last ${s.recentOrders} resolved orders.`);
    return tr('البيانات الحالية لا تكفي للحكم على انتظام العميل.', 'The available history is insufficient to assess consistency.');
  }
  function paintProfile() {
    const p = profile, s = p.stats;
    if (navigationState && matches(p, navigationState.reference)) navigationState = null;
    const stat = (value, title, cls = '') => `<div class="cp-metric ${cls}"><strong>${value}</strong><span>${title}</span></div>`;
    const contact = p.phones.length ? p.phones.map(phone => {
      const digits = phone.replace(/\D/g, '');
      const wa = /^01[0125]\d{8}$/.test(digits) ? '2' + digits : /^1[0125]\d{8}$/.test(digits) ? '20' + digits : digits.replace(/^00/, '');
      return `<div class="cp-phone"><a dir="ltr" href="tel:${e(digits)}">${e(phone)}</a><div><a class="cp-text-action" href="https://wa.me/${e(wa)}" target="_blank" rel="noopener">${tr('واتساب', 'WhatsApp')}</a><button class="cp-text-action" data-cp-copy="${e(phone)}">${tr('نسخ', 'Copy')}</button></div></div>`;
    }).join('') : `<p class="cp-muted">${tr('لا يوجد رقم مسجّل', 'No phone recorded')}</p>`;
    const segments = ['delivered', 'failed', 'cancelledBefore', 'cancelledAfter', 'active', ...(s.unknown ? ['unknown'] : [])];
    $('#clients-profile-view').innerHTML = `<div class="cp-profile">
      ${backLink()}
      <header class="cp-header"><div class="cp-identity"><span class="cp-avatar cp-avatar-large" aria-hidden="true">${e(p.name.slice(0, 1))}</span><div><h1 tabindex="-1">${e(p.name)}</h1><div class="cp-header-meta"><span class="cp-name-orders">${n(s.orders)} ${tr('طلبات', 'orders')}</span><bdi class="cp-code">${e(p.code || '')}</bdi><button class="cp-text-action" data-cp="copy-profile">${tr('نسخ الرابط', 'Copy link')}</button></div><p>${tr('عميل منذ', 'Customer since')} ${e(fmtDate(p.firstOrder))} <span>·</span> ${tr('آخر طلب', 'Last order')} ${e(fmtDate(p.lastOrder))}</p></div></div>${badge(p)}</header>
      <div class="cp-layout"><aside class="cp-sidebar">
        <section class="cp-panel"><h2>${tr('بيانات التواصل', 'Contact details')}</h2>${contact}
          <form id="cp-email-form"><label for="cp-email">${tr('البريد الإلكتروني', 'Email')}</label><div class="cp-email-input"><input id="cp-email" name="email" type="email" maxlength="254" dir="ltr" autocomplete="email" value="${e(p.email || '')}" placeholder="name@example.com"><button class="btn btn-outline btn-sm" type="submit">${tr('حفظ', 'Save')}</button></div><small id="cp-email-status" role="status">${p.emailSource === 'shopify' ? tr('من بيانات Shopify', 'From Shopify') : p.emailSource === 'manual' ? tr('تم تحديثه يدويًا', 'Updated manually') : tr('يُجلب من Shopify عند توفره', 'Imported from Shopify when available')}</small></form>
        </section>
        <section class="cp-panel"><h2>${tr('العناوين المستخدمة', 'Previous addresses')} <span class="cp-count">${n(p.addresses.length)}</span></h2>${p.addresses.length ? p.addresses.map((a, i) => `<article class="cp-address">${i === 0 ? `<span class="cp-muted">${tr('آخر عنوان مستخدم', 'Most recently used')}</span>` : ''}<h3 class="cp-address-location">${e([...new Set([a.gov, a.city].filter(Boolean))].join(' · ') || tr('العنوان', 'Address'))}</h3><p>${e(a.address || '—')}</p><div><time>${e(fmtDate(a.date))}</time><button class="cp-text-action" data-cp-copy="${e([a.address, a.city, a.gov].filter(Boolean).join('، '))}">${tr('نسخ', 'Copy')}</button></div></article>`).join('') : `<p class="cp-muted">${tr('لا توجد عناوين مسجّلة', 'No addresses recorded')}</p>`}</section>
      </aside><div class="cp-main">
        <section class="cp-panel cp-behavior"><div class="cp-section-title"><h2>${tr('سجل الاستلام', 'Delivery history')}</h2><span class="cp-muted">${n(s.orders)} ${tr('طلب فعلي', 'actual orders')}</span></div>
          <div class="cp-delivery-summary"><div class="cp-success"><strong>${s.deliveryRate === null ? '—' : n(s.deliveryRate) + '%'}</strong><span>${tr('نجاح الاستلام', 'Delivery success')}</span><small>${tr('من الشحنات المحسومة فقط', 'Resolved shipments only')}</small></div><div class="cp-evidence"><p>${e(evidence(p))}</p><div class="cp-outcome-bar" aria-hidden="true">${segments.filter(k => s[k]).map(k => `<span class="cp-segment-${k}" style="flex:${s[k]}"></span>`).join('')}</div><div class="cp-outcomes">${segments.map(k => `<button class="cp-outcome" data-cp-filter="${k}"><i class="cp-dot cp-segment-${k}" aria-hidden="true"></i><b>${n(s[k])}</b> ${label(k)}</button>`).join('')}</div></div></div>
          <details class="cp-method"><summary>${tr('كيف يُحسب التقييم؟', 'How is this assessed?')}</summary><p>${tr('نسبة الاستلام = التسليم المؤكد ÷ (التسليم المؤكد + فشل التسليم النهائي). تُستبعد الطلبات الجارية والإلغاء قبل الشحن. لا يُعد الدفع إثباتًا للتسليم. لا تُحسب أخطاء الشركة أو الشحن أو الأسباب المجهولة ضد العميل. التقييم يراجع آخر 10 طلبات محسومة: تنبيه بعد واقعة تخص العميل، وتوصية عربون بعد واقعتين بنسبة 40% على الأقل من هذه الطلبات. انتظام بعد 3 استلامات بنسبة 80%، وتميّز بعد 5 بنسبة 90% دون وقائع حديثة تخص العميل. المرتجع بعد الاستلام منفصل. الطلبات التجريبية والمكررة وأخطاء الإدخال مستبعدة.', 'Delivery rate = confirmed deliveries ÷ (confirmed deliveries + final failed deliveries). In-progress orders and pre-shipping cancellations are excluded. Payment is not delivery proof. Company, courier and unknown causes do not count against the customer. Assessment uses the last 10 resolved orders: one customer-related incident prompts confirmation; two at a rate of at least 40% prompt a deposit recommendation. Reliable: 3 deliveries at 80%; valued: 5 at 90%, without recent customer-related incidents. After-sales returns are separate. Test, duplicate and data-entry-error orders are excluded.')}</p></details>
        </section>
        <section class="cp-finances" aria-label="${tr('ملخص الحساب', 'Account summary')}">${stat(fmtJ(p.money.total), tr('قيمة الفواتير', 'Invoice total'))}${stat(fmtJ(p.money.paid), tr('المدفوع فعليًا', 'Actual payments'))}${stat(fmtJ(p.money.remaining), tr('المتبقي', 'Due'), p.money.remaining > 0 ? 'cp-due' : '')}${stat(fmtJ(p.money.returns), tr('مرتجعات معتمدة', 'Approved returns'))}</section>
        ${hasPerm('complaints') ? `<details class="cp-panel cp-tickets" id="cp-ticket-panel" ${ticketsOpen ? 'open' : ''}><summary><span>${tr('التذاكر', 'Tickets')}<small>${tr('المتابعات والشكاوى', 'Follow-ups & complaints')}</small></span><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 5 7 7-7 7"/></svg></summary><div class="cp-ticket-body"><div class="cp-ticket-actions"><label for="cp-ticket-order">${tr('الطلب المرتبط', 'Related order')}</label><select id="cp-ticket-order">${p.history.filter(r => !r.excluded).map(r => `<option value="${e(r.source + ':' + r.id)}">#${e(r.ref)} · ${e(fmtDate(r.date))}</option>`).join('')}</select><button type="button" class="btn btn-outline btn-sm" data-cp="new-ticket">${tr('إضافة تذكرة', 'Add ticket')}</button></div><div id="cp-ticket-results"></div></div></details>` : ''}
        <section class="cp-panel cp-orders"><div class="cp-section-title"><h2>${tr('الفواتير والطلبات', 'Invoices & orders')}</h2><input id="cp-order-search" type="search" aria-label="${tr('بحث برقم الطلب', 'Search order number')}" placeholder="${tr('بحث برقم الطلب…', 'Search order number…')}" value="${e(query)}"></div><div class="cp-filters" role="group" aria-label="${tr('تصفية الطلبات', 'Filter orders')}">${['all', ...segments, 'returns'].map(k => `<button type="button" data-cp-filter="${k}" aria-pressed="${filter === k}">${label(k)} <span>${n(k === 'all' ? p.history.length : s[k])}</span></button>`).join('')}</div><div id="cp-order-results"></div></section>
      </div></div></div>`;
    paintOrders();
    if (ticketsOpen) loadTickets();
    if (typeof syncNavigationShell === 'function') syncNavigationShell();
  }
  function paintOrders() {
    if (!profile) return;
    const isReturn = filter === 'returns';
    const data = (isReturn ? profile.returns : profile.history).filter(r => (isReturn || filter === 'all' || r.outcome === filter)
      && normalizeUiSearch(r.ref).includes(normalizeUiSearch(query)));
    document.querySelectorAll('#clients-profile-view [data-cp-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cpFilter === filter)));
    $('#cp-order-results').innerHTML = data.length ? `<div class="cp-table-scroll"><table class="cp-table"><thead><tr><th>${tr('الطلب', 'Order')}</th><th>${tr('التاريخ', 'Date')}</th><th>${tr('الإجمالي', 'Total')}</th>${isReturn ? '' : `<th>${tr('المدفوع', 'Paid')}</th><th>${tr('المتبقي', 'Due')}</th>`}<th>${tr('النتيجة والسبب', 'Outcome & reason')}</th></tr></thead><tbody>${data.map(r => `<tr class="${r.excluded ? 'cp-excluded' : ''}"><td>${r.id ? `<a href="${r.source === 'shopify' ? '#shopify-orders' : '#transactions/orders/view/sales-' + enc(r.ref)}" class="cp-invoice-link" data-cp-invoice="${e(r.id)}" data-cp-source="${e(r.source || 'transaction')}"><bdi>#${e(r.ref || '—')}</bdi></a>` : e(r.ref)}${r.source === 'shopify' ? `<small>Shopify · ${tr('بدون فاتورة', 'Not registered')}</small>` : ''}</td><td>${e(fmtDate(r.date))}</td><td data-cp-amount data-label="${tr('الإجمالي', 'Total')}">${fmtJ(r.total)}</td>${isReturn ? '' : `<td data-cp-amount data-label="${tr('المدفوع', 'Paid')}">${fmtJ(r.paid)}</td><td data-cp-amount data-label="${tr('المتبقي', 'Due')}">${fmtJ(r.remaining)}</td>`}<td><span class="cp-result cp-result-${e(r.outcome || 'returns')}">${e(isReturn ? label('returns') : label(r.outcome))}</span>${r.excluded ? `<small>${tr('مستبعد من التقييم', 'Excluded from assessment')}</small>` : ''}${reason(r) ? `<small class="cp-order-reason">${e(reason(r))}</small>` : !isReturn && ['failed', 'cancelledBefore', 'cancelledAfter'].includes(r.outcome) ? `<small>${tr('السبب غير مسجّل', 'Reason not recorded')}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="cp-empty">${tr('لا توجد طلبات في هذا القسم', 'No orders in this section')}</div>`;
  }
  async function loadTickets(force = false) {
    const p = profile, host = $('#cp-ticket-results');
    if (!p || !host || !hasPerm('complaints')) return;
    const saved = ticketCache.get(p.key);
    if (!force && saved && saved.expires > Date.now() && saved.revision === revision()) { paintTickets(saved.data); return; }
    host.innerHTML = `<p class="cp-muted" role="status">${tr('جارٍ تحميل التذاكر…', 'Loading tickets…')}</p>`;
    try {
      let task = ticketTasks.get(p.key);
      if (!task) {
        const epoch = dataEpoch;
        task = api('/clients/tickets?key=' + enc(p.key)).then(data => {
          if (!Array.isArray(data?.rows)) throw new Error(tr('تعذّر تحميل التذاكر', 'Unable to load tickets'));
          if (epoch === dataEpoch) ticketCache.set(p.key, { data, expires: Date.now() + 30000, revision: revision() });
          while (ticketCache.size > 20) ticketCache.delete(ticketCache.keys().next().value);
          return data;
        }).finally(() => { if (ticketTasks.get(p.key) === task) ticketTasks.delete(p.key); });
        ticketTasks.set(p.key, task);
      }
      const data = await task;
      if (profile?.key === p.key && host.isConnected) paintTickets(data);
    } catch (error) { if (host.isConnected) host.innerHTML = failure(error.message, 'tickets-retry'); }
  }
  function paintTickets(data) {
    const host = $('#cp-ticket-results');
    if (!host) return;
    host.innerHTML = data.rows.length ? `<div class="cp-ticket-list">${data.rows.map(t => `<article class="cp-ticket"><div><a class="cp-invoice-link" href="#${t.kind === 'followup' ? 'complaints/fu/view/' : 'complaints/view/'}${enc(t.number)}" data-cp-ticket="${e(t.number)}" data-cp-kind="${e(t.kind)}"><bdi>${e(t.number)}</bdi></a><span class="cp-muted">${t.kind === 'followup' ? tr('متابعة', 'Follow-up') : tr('شكوى', 'Complaint')}</span><span class="cp-ticket-status">${e(t.status)}</span></div><p>${e(t.subject)}</p><small>${e([t.ref ? '#' + t.ref : '', t.assignedTo, fmtDate(t.date)].filter(Boolean).join(' · '))}</small></article>`).join('')}</div>${data.hasMore ? `<a class="cp-text-action" href="#complaints">${tr('عرض بقية التذاكر في خدمة العملاء', 'View remaining tickets in Customer Care')}</a>` : ''}`
      : `<p class="cp-muted cp-ticket-empty">${tr('لا توجد متابعات أو شكاوى مسجّلة لهذا العميل.', 'No follow-ups or complaints recorded for this customer.')}</p>`;
  }
  async function newTicket() {
    if (!profile || !_requirePageAccess('complaints')) return;
    const selected = $('#cp-ticket-order')?.value;
    const row = profile.history.find(r => r.source + ':' + r.id === selected);
    if (!row) return;
    try {
      if (row.source === 'shopify') { await openShopifyOrderFollowup(row.ref, row.id); return; }
      const data = await api('/transactions/' + enc(row.id));
      const i = transactions.findIndex(r => String(r._id) === row.id);
      if (i >= 0) transactions[i] = data; else transactions.push(data);
      openAddTicketModal(row.id);
    } catch (error) { toast(error.message, true); }
  }
  function customerLink(tx, source = 'transaction') {
    if (!hasPerm('clients')) return e(tx.client || '—');
    const reference = 'order:' + source + ':' + tx._id;
    const known = cached(reference);
    return `<a class="cp-invoice-customer" href="${e(known ? pathFor(known) : '#clients/profile/' + enc(reference))}" data-cp-customer="${e(reference)}">${e(tx.client || '—')}</a>`;
  }
  async function invoice(id, source) {
    try {
      if (source === 'shopify') {
        if (!_requirePageAccess('shopify-orders')) return;
        const ready = await window.souliaLibraryReady('shopifyOrders');
        if (!ready) throw new Error(tr('تعذّر فتح الطلب', 'Unable to open order'));
        const data = await api('/shopify/orders/detail/' + enc(id));
        const i = _shopifyOrders.findIndex(r => String(r._id) === id);
        if (i >= 0) _shopifyOrders[i] = data; else _shopifyOrders.push(data);
        openSpOrderPeek(id);
      } else {
        if (!_requirePageAccess('invoice-view')) return;
        const data = await api('/transactions/' + enc(id));
        const i = transactions.findIndex(r => String(r._id) === id);
        if (i >= 0) transactions[i] = data; else transactions.push(data);
        openOrderView(id);
      }
    } catch (error) { toast(error.message, true); }
  }
  async function orderEvidence(order, panel) {
    if (!hasPerm('clients') || !panel) return;
    syncAccount();
    const host = panel.querySelector('.cp-order-evidence');
    if (!host) return;
    const reference = 'order:shopify:' + order._id, entry = orderSummaryEntry(order);
    const paint = p => {
      if (!p || !host.isConnected || panel.dataset.order !== String(order._id)) return;
      const html = orderSummaryContent(p, order);
      if (host.innerHTML !== html) host.innerHTML = html;
      const link = panel.querySelector('.sp-pk-client [data-cp-customer]');
      if (link) link.href = pathFor(p);
    };
    paint(entry.data);
    if (entry.data && entry.epoch === dataEpoch && entry.signature === summarySignature(order) && Date.now() - entry.checkedAt < 30000) return;
    if (!entry.task && (Date.now() < entry.retryAt || Date.now() - entry.startedAt < 1000)) {
      if (!entry.retryAt) scheduleOrderSummary(1000 - (Date.now() - entry.startedAt));
      return;
    }
    try {
      if (!entry.task) {
        const epoch = dataEpoch, signature = summarySignature(order);
        entry.startedAt = Date.now();
        entry.task = getProfile(reference, entry.force || !!entry.data && entry.signature !== signature).then(p => {
          if (orderSummaries.get(reference) !== entry || epoch !== dataEpoch) return null;
          Object.assign(entry, { data: p, checkedAt: Date.now(), epoch, signature, retryAt: 0, force: false });
          return p;
        }).finally(() => { entry.task = null; });
      }
      const p = await entry.task;
      if (orderSummaries.get(reference) !== entry) return;
      if (p) paint(p); else scheduleOrderSummary(1000);
    } catch {
      if (orderSummaries.get(reference) !== entry) return;
      entry.retryAt = Date.now() + 10000;
      if (!entry.data && host.isConnected) host.innerHTML = `<span class="cp-badge cp-neutral">${tr('غير متاح', 'Unavailable')}</span>`;
    }
  }
  function scheduleOrderSummary(delay = 200) {
    clearTimeout(summaryRefreshTimer);
    summaryRefreshTimer = setTimeout(() => {
      const panel = $('#sp-peek .sp-peek');
      const order = panel && typeof _spOrderById === 'function' && _spOrderById(panel.dataset.order);
      if (order) orderEvidence(order, panel);
    }, Math.max(0, delay));
  }
  const summarySignature = order => JSON.stringify([order.status, order.cancelled, order.deliveredAt, order.bostaShippingStatus, order.cancelReasonCode]);
  function orderSummaryEntry(order) {
    const reference = 'order:shopify:' + order._id;
    const identity = JSON.stringify([String(order.phone || '').replace(/\D/g, ''), order.shopifyCustomerId, order.shopifyId]);
    let entry = orderSummaries.get(reference);
    if (!entry || entry.identity !== identity) {
      const force = !!entry;
      entry = { identity, data: null, epoch: -1, checkedAt: 0, startedAt: 0, retryAt: 0, task: null, force };
      orderSummaries.set(reference, entry);
      while (orderSummaries.size > 50) orderSummaries.delete(orderSummaries.keys().next().value);
    }
    return entry;
  }
  function orderSummaryContent(p, order) {
    const history = p.history.filter(r => !r.excluded).slice().reverse();
    const position = history.findIndex(r => r.source === 'shopify' && r.id === String(order._id)
      || r.orderId === String(order._id) || order.shopifyId && r.shopifyId === String(order.shopifyId));
    const count = position + 1;
    const suffix = count % 100 >= 11 && count % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[count % 10] || 'th');
    const title = count ? tr(`الطلب ${n(count)}`, `${n(count)}${suffix.toUpperCase()} order`)
      : p.stats.orders ? tr(`${n(p.stats.orders)} طلبات`, `${n(p.stats.orders)} orders`) : tr('طلب مستبعد', 'Excluded order');
    const fullTitle = count ? tr(`الطلب رقم ${n(count)}`, `${n(count)}${suffix} order`) : title;
    const previous = position >= 0 ? history.slice(0, position) : history;
    const delivered = previous.filter(r => r.outcome === 'delivered').length;
    const failed = previous.filter(r => r.outcome === 'failed').length;
    const cancelled = previous.filter(r => ['cancelledBefore', 'cancelledAfter'].includes(r.outcome)).length;
    const parts = [];
    const add = (text, kind = '') => parts.push({ text, kind });
    if (delivered) add(tr(delivered === 1 ? 'استلم طلبًا سابقًا' : delivered === 2 ? 'استلم طلبين سابقًا'
      : `استلم ${n(delivered)} ${delivered <= 10 ? 'طلبات' : 'طلبًا'} سابقًا`, `${n(delivered)} ${delivered === 1 ? 'order' : 'orders'} delivered before`), 'delivered');
    if (failed) add(tr(`${n(failed)} تعثّر`, `${n(failed)} failed`));
    if (cancelled) add(tr(`${n(cancelled)} ملغي`, `${n(cancelled)} cancelled`));
    const rate = delivered + failed ? Math.round(delivered / (delivered + failed) * 100) : null;
    if (rate !== null) add(tr(`نجاح ${n(rate)}%`, `${n(rate)}% success`), rate >= 80 ? 'positive' : '');
    if (p.assessment === 'documentedFake') add(tr('بيانات غير صحيحة', 'Invalid details'));
    else if (p.assessment === 'depositRecommended') add(tr('يُفضّل عربون', 'Deposit advised'));
    else if (p.assessment === 'confirmFirst') add(tr('تأكيد قبل الشحن', 'Confirm before shipping'));
    const summary = parts.map(part => part.text).join(' · ');
    const check = '<svg class="cp-summary-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></svg>';
    const content = parts.map(part => `<span class="cp-summary-part${part.kind ? ' cp-summary-' + part.kind : ''}">${part.kind === 'delivered' ? check : ''}${e(part.text)}</span>`).join(' <span class="cp-summary-divider" aria-hidden="true">·</span> ');
    return `<span class="cp-badge cp-${tone(p)}" title="${e(fullTitle)}" aria-label="${e(fullTitle)}">${e(title)}</span>${summary ? `<small class="cp-order-summary" title="${e(summary)}">${content}</small>` : ''}`;
  }
  function orderSummary(order) {
    if (!hasPerm('clients')) return '';
    syncAccount();
    const entry = orderSummaryEntry(order);
    const p = entry.data || !entry.force && cached('order:shopify:' + order._id);
    return `<span class="cp-order-evidence" role="status" aria-atomic="true" aria-label="${tr('سجل استلام العميل', 'Customer delivery history')}">${p ? orderSummaryContent(p, order) : `<span class="cp-badge cp-neutral">${tr('سجل العميل', 'Customer history')}</span>`}</span>`;
  }
  document.addEventListener('click', event => {
    if (event.target.closest('a') && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    const customer = event.target.closest('[data-cp-customer]');
    if (customer) { event.preventDefault(); if ($('#sp-peek')) closeSpOrderPeek(); open(customer.dataset.cpCustomer); return; }
    const ticket = event.target.closest('[data-cp-ticket]');
    if (ticket) {
      event.preventDefault();
      if (!_requirePageAccess('complaints')) return;
      if (ticket.dataset.cpKind === 'followup') openFuTicketBySlug(ticket.dataset.cpTicket);
      else openComplaintBySlug(ticket.dataset.cpTicket, true);
      return;
    }
    const openButton = event.target.closest('[data-cp-open]');
    if (openButton) { event.preventDefault(); if ($('#sp-peek')) closeSpOrderPeek(); open(openButton.dataset.cpOpen); return; }
    const inv = event.target.closest('[data-cp-invoice]');
    if (inv) { event.preventDefault(); invoice(inv.dataset.cpInvoice, inv.dataset.cpSource); return; }
    const card = event.target.closest('[data-cp-card]');
    if (card && !event.target.closest('a,button,input,label')) { open(card.dataset.cpCard); return; }
    const btn = event.target.closest('[data-cp-filter]');
    if (btn) { filter = btn.dataset.cpFilter; paintOrders(); return; }
    const copy = event.target.closest('[data-cp-copy]');
    if (copy) { _copyTextWithFallback(copy.dataset.cpCopy).then(ok => toast(ok ? tr('تم النسخ', 'Copied') : tr('تعذّر النسخ', 'Copy failed'), !ok)); return; }
    const action = event.target.closest('[data-cp]')?.dataset.cp;
    if (action === 'refresh') { loadedAt = 0; renderList(); }
    if (action === 'retry-profile') showProfile(routeKey());
    if (action === 'tickets-retry') loadTickets(true);
    if (action === 'new-ticket') newTicket();
    if (action === 'copy-profile' && profile) {
      const url = new URL(location.href); url.hash = pathFor(profile);
      ['sale', 'purchase', 'return', 'tx', 'invoice'].forEach(key => url.searchParams.delete(key));
      _copyTextWithFallback(url.toString()).then(ok => toast(ok ? tr('تم نسخ رابط العميل', 'Customer link copied') : tr('تعذّر النسخ', 'Copy failed'), !ok));
    }
  });
  document.addEventListener('toggle', event => {
    if (event.target.id === 'cp-ticket-panel') {
      ticketsOpen = event.target.open;
      if (ticketsOpen) loadTickets();
    }
  }, true);
  document.addEventListener('change', event => {
    const key = event.target.dataset.cpSelect;
    if (key) toggleClientSelect(key, event.target.checked);
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'cp-order-search') { query = event.target.value; paintOrders(); }
  });
  document.addEventListener('submit', async event => {
    if (event.target.id !== 'cp-email-form') return;
    event.preventDefault();
    const form = event.target, key = profile?.key, status = form.querySelector('[role="status"]'), button = form.querySelector('button');
    if (!key || !form.reportValidity()) return;
    button.disabled = true; status.textContent = tr('جارٍ الحفظ…', 'Saving…');
    try {
      const email = form.querySelector('input').value.trim();
      await api('/clients/email?key=' + enc(key), { method: 'PATCH', body: JSON.stringify({ email }) });
      if (profile?.key === key) { profile.email = email; profile.emailSource = 'manual'; }
      if (profile?.key === key) remember(profile);
      rows.forEach(p => { if (p.key === key) p.email = email; });
      loadedAt = 0; status.textContent = tr('تم حفظ البريد الإلكتروني', 'Email saved');
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  function changed() {
    // Orders create the profile as soon as they are saved, independently of invoicing.
    // Invalidate in-flight reads too, so an earlier response cannot hide a new arrival.
    dataEpoch++; loading = null; loadedAt = 0; profileStale = true;
    profileCache.clear(); profileTasks.clear(); ticketCache.clear(); ticketTasks.clear();
    orderSummaries.forEach(entry => { entry.retryAt = 0; });
    scheduleOrderSummary();
    clearTimeout(refreshTimer);
    if (currentPage === 'clients' && !routeKey()) {
      refreshTimer = setTimeout(() => {
        if (currentPage === 'clients' && !routeKey() && hasPerm('clients')) renderList();
      }, 150);
    }
  }
  function bindSocket(connection) {
    if (!connection || connectedSockets.has(connection)) return;
    connectedSockets.add(connection);
    ['connect', 'shopify:order-created', 'shopify:order-cancelled', 'shopify:phone-changed',
      'shopify:client-changed', 'shopify:edit-changed', 'tx:created', 'tx:updated', 'tx:cancelled', 'tx:deleted',
      'followup:changed', 'complaint:changed']
      .forEach(event => connection.on(event, changed));
  }
  return { renderList, open, orderEvidence, orderSummary, bindSocket, customerLink,
    captureNavigationState(url = location.href) {
      const parts = new URL(url, location.href).hash.slice(1).split('/');
      let reference = ''; try { if (parts[1] === 'profile') reference = decodeURIComponent(parts.slice(2).join('/')); } catch (_) {}
      return { reference, filter, query, ticketsOpen, clientsPage, name: profile?.name || '' };
    },
    restoreNavigationState(state) {
      if (!state) return;
      clientsPage = state.clientsPage; filter = state.filter; query = state.query; ticketsOpen = state.ticketsOpen;
      navigationState = state;
    },
    currentProfile: () => currentPage === 'clients' && routeKey()
      ? matches(profile, routeKey()) ? profile : rows.find(p => matches(p, routeKey())) : null,
    exportRows: () => rows.map(p => ({ key: p.key, name: p.name, phone: p.phone, email: p.email,
      orders: p.stats.orders, total: p.money.total, remaining: p.money.remaining })),
  };
})();
