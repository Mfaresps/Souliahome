/* QR label generator tab inside Warehouse management. Receipt scanning stays in PreprintedLabels. */
(function () {
  'use strict';
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paths = { plus: 'M12 5v14M5 12h14', back: 'M5 12h14m-6-6 6 6-6 6', search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6', print: 'M6 9V3h12v6M6 18H3V9h18v9h-3M6 14h12v7H6z', check: 'm5 12 5 5L20 7', close: 'm6 6 12 12M6 18 18 6', product: 'M3 7 12 3l9 4v10l-9 4-9-4V7zm0 0 9 4 9-4M12 11v10', calendar: 'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16', labels: 'M4 5h16v14H4zM8 9h8M8 13h8', linked: 'M10 13a5 5 0 0 0 7 .4l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.4l-3 3a5 5 0 0 0 7 7l2-2', unused: 'M4 7h16M4 12h16M4 17h10', open: 'M5 12h14m-6-6 6 6-6 6' };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.back}"/></svg>`;
  const button = (id, name, text, primary = false) => `<button type="button" id="sl-${id}" class="sl-button${primary ? ' sl-primary' : ''}" aria-label="${esc(text)}">${icon(name)}<span>${text}</span></button>`;
  const num = value => new Intl.NumberFormat('en-GB').format(Number(value || 0));
  const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Intl.DateTimeFormat(tr('en-GB', 'ar-EG-u-nu-latn'), { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670ـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function productImageUrl(value) {
    const source = typeof value === 'string' ? value.trim() : '';
    if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(source)) return source;
    try { const url = new URL(source, location.href); return source && ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
  }
  function productPicture(product) {
    const source = productImageUrl(product.imageUrl) || productImageUrl(product.images?.[0]);
    return `<span class="sl-product-image">${icon('product')}${source ? `<img src="${esc(source)}" alt="" loading="lazy" decoding="async">` : ''}</span>`;
  }
  function hideBrokenProductImages(host) {
    host?.querySelectorAll('.sl-product-image img').forEach(image => {
      image.addEventListener('error', () => { image.hidden = true; }, { once: true });
      if (image.complete && !image.naturalWidth) image.hidden = true;
    });
  }
  const state = { query: '', page: 1, total: 0, pages: 1, batches: [], products: null, productQuery: '', productPage: 1, selected: null, quantity: 10, sizes: [], busy: false, pendingIssue: null, pendingPrint: null, draftCoverChoice: null, coverChoiceByBatch: new Map(), scroll: 0, focusBatch: null };
  const selectedBatches = new Map();
  let bulkMode = 'unprinted', bulkSize = '', bulkReview = null, bulkRequest = 0, pendingBulk = null;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let root, generation = 0, listRequest = 0, timer, navigationRequest = 0, animateNextShell = false;
  const get = id => root?.querySelector('#sl-' + id);
  const visible = token => token === generation && root?.isConnected && root?.closest('#page-barcodes')?.classList.contains('active') && location.hash.startsWith('#warehouse-management/supplier-labels');
  const message = (text, error = false) => { const el = get('message'); if (el) { el.textContent = text; el.dataset.error = String(error); } };
  const request = (path, body) => api('/inventory-units' + path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  const coverStorageKey = batchId => 'soulia_supplier_batch_cover:' + batchId;
  function coverChoiceFor(batchId) {
    if (state.coverChoiceByBatch.has(batchId)) return state.coverChoiceByBatch.get(batchId);
    try { const stored = localStorage.getItem(coverStorageKey(batchId)); if (stored) return stored === 'yes'; } catch { /* Printing still works when storage is unavailable. */ }
    return true;
  }
  function askBatchCover() {
    return new Promise(resolve => {
      const prompt = document.createElement('dialog'); let choice = null;
      prompt.className = 'iu-reprint-confirm iu-cover-choice'; prompt.dir = tr('ltr', 'rtl');
      prompt.setAttribute('aria-label', tr('Choose batch cover', 'اختيار ورقة تعريف الدفعة'));
      prompt.innerHTML = `<h2>${tr('Print a batch cover sheet?', 'هل تريد طباعة ورقة تعريف الدفعة؟')}</h2><p>${tr('One cover sheet will print before the product labels.', 'ستُطبع 1 ورقة تعريف قبل ملصقات المنتجات.')}</p><footer><button type="button" data-cancel>${tr('Cancel', 'إلغاء')}</button><button type="button" data-include-covers="no">${tr('No, labels only', 'لا، الملصقات فقط')}</button><button type="button" data-include-covers="yes">${tr('Yes, with cover sheet', 'نعم، مع ورقة التعريف')}</button></footer>`;
      document.body.append(prompt);
      prompt.addEventListener('close', () => { prompt.remove(); resolve(choice); }, { once: true });
      prompt.querySelector('[data-cancel]').onclick = () => prompt.close();
      for (const button of prompt.querySelectorAll('[data-include-covers]')) button.onclick = () => {
        choice = button.dataset.includeCovers === 'yes'; prompt.close();
      };
      prompt.showModal(); prompt.querySelector('[data-include-covers="yes"]').focus();
    });
  }
  function busy(value) {
    state.busy = value; root?.setAttribute('aria-busy', String(value));
    root?.querySelectorAll('button,input,select').forEach(el => {
      if (value) { if (!('slDisabled' in el.dataset)) el.dataset.slDisabled = String(el.disabled); el.disabled = true; }
      else if ('slDisabled' in el.dataset) { el.disabled = el.dataset.slDisabled === 'true' || el.dataset.locked === 'true'; delete el.dataset.slDisabled; }
    });
    if (!value && state.rerender) queueMicrotask(() => { if (!state.busy && root?.classList.contains('active')) { state.rerender = false; render(); } });
  }
  async function go(path = '', replace = false) {
    if (state.busy) return;
    const request = ++navigationRequest, oldShell = root?.querySelector('.sl-workspace');
    let exit;
    if (oldShell && !reducedMotion()) {
      exit = oldShell.animate([{ opacity: 1 }, { opacity: .12 }], { duration: 90, easing: 'ease-in', fill: 'forwards' });
      await exit.finished.catch(() => {});
    }
    if (request !== navigationRequest || state.busy) { exit?.cancel(); return; }
    const hash = '#warehouse-management/supplier-labels' + (path ? '/' + path : '');
    if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', hash);
    if (path) window.scrollTo({ top: 0, behavior: 'instant' });
    animateNextShell = true;
    void render();
    animateNextShell = false;
  }
  function shell(title, subtitle, actions = '') {
    root.innerHTML = `<div class="sl-workspace"><header class="sl-header iu-section-heading"><div><h2 tabindex="-1" id="sl-title">${title}</h2><p>${subtitle}</p></div><div class="sl-actions">${actions}</div></header><p id="sl-message" class="sl-message" role="status" aria-live="polite"></p><div id="sl-content"></div></div>`;
    if (animateNextShell && !reducedMotion()) root.querySelector('.sl-workspace').animate([{ opacity: .12, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
    get('title').focus({ preventScroll: true });
  }
  async function render() {
    root = document.getElementById('page-supplier-labels');
    if (!root) return;
    if (!root.dataset.slImageFallback) {
      root.addEventListener('error', event => { if (event.target.matches?.('.sl-product-image img')) event.target.hidden = true; }, true);
      root.dataset.slImageFallback = 'true';
    }
    if (!hasPerm('inventory-units-view') || !hasPerm('inventory-units-print')) { root.textContent = tr('You do not have access to QR label printing.', 'لا تملك صلاحية طباعة ملصقات QR.'); return; }
    if (state.busy) { ++generation; state.rerender = true; return; }
    clearTimeout(timer); const token = ++generation; ++listRequest;
    const parts = location.hash.slice(1).split('/').slice(1);
    if (parts[1] === 'new') await createView(token);
    else if (parts[1] === 'print') await bulkView(token);
    else if (parts[1] === 'batch' && /^[a-f\d]{24}$/i.test(parts[2] || '')) await detailView(parts[2], token);
    else await listView(token);
    if (visible(token) && !reducedMotion()) get('content')?.animate([{ opacity: .86, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 160, easing: 'ease-out' });
  }
  async function listView(token) {
    shell(tr('QR Label Generator', 'مولّد ملصقات QR'), tr('Reserve identities before purchase. They enter stock only when linked to an invoice.', 'هويات محفوظة قبل الشراء؛ تدخل المخزون فقط عند ربطها بفاتورة.'), button('new', 'plus', tr('New batch', 'دفعة جديدة'), true));
    get('new').onclick = () => go('new');
    get('content').innerHTML = `<section class="sl-sheet"><div class="sl-toolbar"><label class="sl-search"><span>${tr('Search batches', 'البحث في الدفعات')}</span><div>${icon('search')}<input id="sl-query" type="search" value="${esc(state.query)}" placeholder="${tr('Product, SKU or full batch ID', 'اسم المنتج، كوده أو رقم الدفعة الكامل')}" autocomplete="off"></div></label>${button('refresh', 'refresh', tr('Refresh', 'تحديث'))}</div><div id="sl-list" aria-live="polite"><p class="sl-empty">${tr('Loading batches…', 'جارٍ تحميل الدفعات…')}</p></div><nav id="sl-paging" class="sl-pagination" aria-label="${tr('Batch pages', 'صفحات الدفعات')}"></nav></section>`;
    get('query').oninput = () => { state.query = get('query').value; state.page = 1; ++listRequest; clearTimeout(timer); timer = setTimeout(() => loadList(token), 250); };
    get('refresh').onclick = () => loadList(token);
    get('list').insertAdjacentHTML('beforebegin', '<div id="sl-selection-bar" class="sl-selection-bar"></div>');
    drawSelectionBar();
    await loadList(token);
    if (visible(token) && state.focusBatch) { root.querySelector(`[data-batch="${state.focusBatch}"]`)?.focus({ preventScroll: true }); window.scrollTo(0, state.scroll); state.focusBatch = null; }
  }
  async function loadList(token) {
    const serial = ++listRequest;
    get('list')?.setAttribute('aria-busy', 'true');
    try {
      const data = await request('/prelabels/batches/page?' + new URLSearchParams({ page: String(state.page), limit: '12', q: state.query.trim() }));
      if (!visible(token) || serial !== listRequest) return;
      state.batches = data.batches; state.total = data.total; state.page = data.page; state.pages = data.totalPages;
      if (!data.batches.length && state.page > 1) { state.page = Math.max(1, data.totalPages); return loadList(token); }
      message(''); drawList();
    } catch (e) {
      if (!visible(token) || serial !== listRequest) return;
      message(e.message, true);
      get('list').innerHTML = `<div class="sl-empty">${tr('Could not load batches.', 'تعذر تحميل الدفعات.')} ${button('retry', 'refresh', tr('Retry', 'إعادة المحاولة'))}</div>`;
      get('paging').innerHTML = ''; get('retry').onclick = () => loadList(token);
    } finally { if (visible(token) && serial === listRequest) get('list')?.removeAttribute('aria-busy'); }
  }
  function drawList() {
    const headings = [tr('Product / batch', 'المنتج / الدفعة'), tr('Issued', 'الإصدار'), tr('Labels', 'الملصقات'), tr('Print requested', 'طُلبت طباعتها'), tr('Linked', 'مرتبطة'), tr('Unused', 'غير مستخدمة'), tr('Action', 'الإجراء')];
    const headerIcons = ['product', 'calendar', 'labels', 'print', 'linked', 'unused', 'open'];
    get('list').innerHTML = state.batches.length ? `<div class="sl-table-wrap"><table class="sl-table"><caption>${tr(`${num(state.total)} batches · newest first`, `${num(state.total)} دفعة · الأحدث أولًا`)}</caption><thead><tr>${headings.map((x, index) => `<th scope="col"><span class="sl-th">${icon(headerIcons[index])}<span>${x}</span></span></th>`).join('')}</tr></thead><tbody>${state.batches.map(b => `<tr><td class="sl-identity"><strong dir="auto">${esc(b.productName)}</strong><small dir="auto">${esc(b.sku)}</small><code title="${esc(b.batchId)}">${esc(b.batchId.slice(-8).toUpperCase())}</code></td><td data-label="${headings[1]}"><time>${esc(date(b.createdAt))}</time><small>${esc(b.createdBy || '—')}</small></td>${[['quantity',2],['printed',3],['linked',4],['unused',5]].map(([key,index]) => `<td class="sl-number" data-label="${headings[index]}">${num(b[key])}</td>`).join('')}<td class="sl-row-action"><button class="sl-button" type="button" data-batch="${esc(b.batchId)}">${icon('open')}<span>${tr('Open', 'فتح')}</span><span class="sl-sr"> ${esc(b.productName)}</span></button></td></tr>`).join('')}</tbody></table></div>` : `<div class="sl-empty"><h2>${state.query ? tr('No matching batches', 'لا توجد دفعات مطابقة') : tr('Your first supplier batch', 'أول دفعة للمورد')}</h2><p>${state.query ? tr('Try a product name, SKU or the complete batch ID.', 'جرّب اسم المنتج أو كوده أو رقم الدفعة كاملًا.') : tr('Create a batch, print its labels and send them to your supplier.', 'أنشئ دفعة، واطبع ملصقاتها، ثم سلّمها للمورد.')}</p></div>`;
    root.querySelectorAll('[data-batch]').forEach(el => {
      el.onclick = () => { state.focusBatch = el.dataset.batch; state.scroll = window.scrollY; go('batch/' + el.dataset.batch); };
      el.closest('tr').onclick = event => { if (!event.target.closest('button,input,label,a')) el.click(); };
    });
    root.querySelectorAll('[data-batch]').forEach(el => {
      const b = state.batches.find(b => b.batchId === el.dataset.batch), cell = el.closest('tr').querySelector('.sl-identity');
      const content = document.createElement('div'); content.className = 'sl-identity-copy';
      while (cell.firstChild) content.append(cell.firstChild);
      const main = document.createElement('div'); main.className = 'sl-identity-main';
      const imageUrl = productImageUrl(b.imageUrl);
      main.innerHTML = `<span class="sl-product-image">${icon('product')}${imageUrl ? `<img src="${esc(imageUrl)}" alt="" loading="lazy" decoding="async">` : ''}</span>`;
      main.append(content); cell.append(main);
      const name = content.querySelector('strong');
      name.innerHTML = `<button type="button" class="sl-product-link" data-open-batch="${esc(b.batchId)}" dir="auto">${esc(b.productName)}</button>`;
      name.querySelector('button').onclick = el.onclick;
      cell.insertAdjacentHTML('afterbegin', `<label class="sl-batch-select"><input class="sl-batch-check" type="checkbox" data-select-batch="${esc(b.batchId)}" aria-label="${esc(tr('Select batch: ', 'تحديد دفعة: ') + b.productName + ' · ' + b.batchId.slice(-8))}" ${selectedBatches.has(b.batchId) ? 'checked' : ''} ${!b.unused ? 'disabled' : ''}></label>`);
      cell.querySelector('input').onchange = e => {
        if (e.target.checked && selectedBatches.size >= 20) { e.target.checked = false; return message(tr('Select up to 20 batches.', 'يمكن تحديد حتى 20 دفعة في المرة.'), true); }
        if (e.target.checked) selectedBatches.set(b.batchId, b); else selectedBatches.delete(b.batchId);
        el.closest('tr').classList.toggle('sl-selected-row', e.target.checked); drawSelectionBar();
      };
      el.closest('tr').classList.toggle('sl-selected-row', selectedBatches.has(b.batchId));
    });
    drawSelectionBar();
    get('paging').innerHTML = `<span>${num(state.total ? (state.page - 1) * 12 + 1 : 0)}–${num(Math.min(state.page * 12, state.total))} ${tr('of', 'من')} ${num(state.total)}</span><div>${button('prev', 'back', tr('Previous', 'السابق'))}<span>${num(state.page)} / ${num(state.pages)}</span>${button('next', 'back', tr('Next', 'التالي'))}</div>`;
    get('prev').disabled = state.page <= 1; get('next').disabled = state.page >= state.pages;
    get('prev').onclick = () => { state.page = Math.max(1, state.page - 1); loadList(generation); };
    get('next').onclick = () => { state.page = Math.min(state.pages, state.page + 1); loadList(generation); };
  }
  function drawSelectionBar() {
    if (!get('selection-bar')) return;
    const available = state.batches.filter(b => b.unused > 0), count = selectedBatches.size;
    get('selection-bar').classList.toggle('is-empty', !count);
    get('selection-bar').innerHTML = `<label class="sl-page-select"><input type="checkbox" id="sl-select-page" ${available.length ? '' : 'disabled'}><span>${tr('Select this page', 'تحديد هذه الصفحة')}</span></label><span class="sl-selected-count" role="status">${count ? tr(`${num(count)} batches selected (including other pages)`, `${num(count)} دفعة محددة، بما فيها الصفحات الأخرى`) : tr('Select batches to print together', 'حدد دفعات لطباعتها معًا')}</span><div class="sl-selection-actions">${count ? button('clear-selection','close',tr('Clear','إلغاء التحديد')) : ''}${button('review-print','print',tr('Review printing','مراجعة الطباعة'))}</div>`;
    get('review-print').disabled = !count && !pendingBulk;
    get('review-print').onclick = () => go('print');
    if (get('clear-selection')) get('clear-selection').onclick = () => { selectedBatches.clear(); drawList(); };
    const input = get('select-page'), checked = available.filter(b => selectedBatches.has(b.batchId)).length;
    input.checked = available.length > 0 && checked === available.length; input.indeterminate = checked > 0 && checked < available.length;
    input.onchange = () => {
      if (input.checked && new Set([...selectedBatches.keys(), ...available.map(b => b.batchId)]).size > 20) { input.checked = false; return message(tr('Select up to 20 batches.', 'يمكن تحديد حتى 20 دفعة في المرة.'), true); }
      for (const b of available) { if (input.checked) selectedBatches.set(b.batchId, b); else selectedBatches.delete(b.batchId); }
      drawList();
    };
  }

  async function bulkView(token) {
    shell(tr('Review batch printing', 'مراجعة طباعة الدفعات'), tr('One print window for all selected batches. Linked identities are excluded.', 'نافذة طباعة واحدة للدفعات المحددة. الهويات المرتبطة بفواتير تُستبعد.'), button('bulk-back','back',tr('Back to batches','رجوع للدفعات')));
    get('bulk-back').onclick = () => go();
    if (!selectedBatches.size && !pendingBulk) { get('content').innerHTML = `<div class="sl-sheet sl-empty">${tr('Choose batches from the list first.', 'حدد الدفعات من السجل أولًا.')}</div>`; return; }
    get('content').innerHTML = `<section class="sl-sheet"><div class="sl-bulk-options"><label class="sl-field">${tr('What to print','الملصقات المطلوبة')}<select id="sl-bulk-mode"><option value="unprinted">${tr('Unprinted only','غير المطبوع فقط')}</option><option value="all-unused">${tr('All, including reprints','الكل — يشمل إعادة الطباعة')}</option></select></label><label class="sl-field">${tr('Label size','مقاس الملصق')}<select id="sl-bulk-size"></select></label></div><p class="sl-muted">${tr('Unprinted means no earlier print request was recorded. The system cannot verify paper output. Up to 1,000 labels per job.', 'غير المطبوع يعني أنه لم يُسجل له طلب طباعة سابق. النظام لا يتحقق من خروج الورق فعليًا. حتى 1,000 ملصق في الطلب.')}</p><div id="sl-bulk-review" aria-live="polite"></div><div id="sl-bulk-warning"></div><div class="sl-bulk-footer"><span id="sl-bulk-progress" role="status"></span>${button('bulk-print','print',tr('Print selected labels','طباعة الملصقات المحددة'),true)}</div></section>`;
    try {
      if (!state.sizes.length) state.sizes = (await request('/config')).labelSizes;
      if (!visible(token)) return;
      if (pendingBulk) { bulkMode = pendingBulk.payload.mode; bulkSize = pendingBulk.payload.sizeId; }
      get('bulk-mode').value = bulkMode;
      get('bulk-size').innerHTML = state.sizes.map(s => `<option value="${esc(s.id)}">${s.widthMm} × ${s.heightMm} mm</option>`).join('');
      if (bulkSize) get('bulk-size').value = bulkSize; bulkSize = get('bulk-size').value;
      get('bulk-mode').onchange = () => { bulkMode = get('bulk-mode').value; reviewBulk(token); };
      get('bulk-size').onchange = () => { bulkSize = get('bulk-size').value; reviewBulk(token); };
      get('bulk-print').onclick = () => printBulk(token);
      if (pendingBulk) { bulkReview = pendingBulk.review; showBulkReview(); }
      else await reviewBulk(token);
    } catch(e) { if (visible(token)) { message(e.message,true); get('bulk-print').disabled = true; get('bulk-review').innerHTML = button('bulk-retry','refresh',tr('Retry','إعادة المحاولة')); get('bulk-retry').onclick = () => render(); } }
  }
  async function reviewBulk(token) {
    const serial = ++bulkRequest; bulkReview = null;
    get('bulk-print').disabled = true; get('bulk-warning').innerHTML = '';
    get('bulk-review').setAttribute('aria-busy','true');
    get('bulk-progress').textContent = tr('Checking label history…','جارٍ مراجعة سجل الملصقات…');
    try {
      const selection = { batchIds: [...selectedBatches.keys()].sort(), mode: bulkMode, sizeId: bulkSize };
      const result = await request('/prelabels/bulk/preview', selection);
      if (!visible(token) || serial !== bulkRequest) return;
      bulkReview = { ...result, selection }; message(''); showBulkReview();
    } catch(e) { if (visible(token) && serial === bulkRequest) { message(e.message,true); get('bulk-review').innerHTML = button('bulk-retry','refresh',tr('Retry review','إعادة المراجعة')); get('bulk-retry').onclick = () => reviewBulk(token); get('bulk-progress').textContent = ''; } }
    finally { if (visible(token) && serial === bulkRequest) get('bulk-review').removeAttribute('aria-busy'); }
  }
  function showBulkReview() {
    const r = bulkReview;
    get('bulk-mode').disabled = get('bulk-size').disabled = !!pendingBulk;
    get('bulk-review').innerHTML = `<div class="sl-bulk-totals"><strong>${num(r.total)} ${tr('labels','ملصق')}</strong><span>${num(r.summary.length)} ${tr('batches','دفعة')} · ${num(r.reprints)} ${tr('previously requested','سبق طلب طباعتها')}</span></div><div class="sl-bulk-rows">${r.summary.map(b => `<article><div><strong dir="auto">${esc(b.productName)}</strong><small dir="auto">${esc(b.sku)} · ${esc(b.batchId.slice(-8).toUpperCase())}</small><small>${num(b.reprints)} ${tr('reprints','إعادة طباعة')} · ${num(b.linked)} ${tr('linked, excluded','مرتبطة ومستبعدة')}</small></div><b>${num(b.printable)} <small>${tr('labels','ملصق')}</small></b></article>`).join('')}</div>`;
    get('bulk-progress').textContent = !r.total ? tr('There are no eligible labels for this option.','لا توجد ملصقات متاحة لهذا الخيار.') : r.total > r.maxLabels ? tr('Select fewer batches: maximum 1,000 labels per job.','قلل عدد الدفعات المحددة: الحد الأقصى 1,000 ملصق للطلب.') : pendingBulk ? tr('Retry the previous job','أعد طلب الطباعة السابق') : r.reprints ? tr('Confirm reprinting to continue','أكّد إعادة الطباعة للمتابعة') : tr('Ready for printing','جاهز للطباعة');
    get('bulk-warning').innerHTML = pendingBulk ? `<p class="sl-reprint-warning" role="alert">${tr('The previous print request is unresolved. Retry restores that same job without recording another request.','لم تكتمل متابعة طلب الطباعة السابق. إعادة المحاولة تستعيد نفس الطلب دون تسجيل طلب جديد.')}</p>` : r.reprints ? `<div class="sl-reprint-warning" role="alert"><strong>${tr(`${num(r.reprints)} labels were requested before`, `تنبيه: ${num(r.reprints)} ملصق سبق طلب طباعتها`)}</strong><p>${tr('Reprints keep the same U identities. Never attach duplicate copies to different pieces.','إعادة الطباعة تستخدم نفس هويات U. لا تلصق نسختين من نفس الكود على قطعتين مختلفتين.')}</p><label class="sl-reprint-confirm"><input type="checkbox" id="sl-reprint-confirm"><span>${tr('I want to reprint these same labels.','أؤكد إعادة طباعة هذه الملصقات نفسها.')}</span></label></div>` : '';
    get('bulk-print').disabled = !r.total || r.total > r.maxLabels || (!pendingBulk && r.reprints > 0);
    get('bulk-print').querySelector('span').textContent = pendingBulk ? tr('Retry same print job','إعادة نفس طلب الطباعة') : tr('Preview & print','معاينة وطباعة');
    if (get('reprint-confirm')) get('reprint-confirm').onchange = () => { get('bulk-print').disabled = !get('reprint-confirm').checked || !r.total || r.total > r.maxLabels; if (r.total <= r.maxLabels) get('bulk-progress').textContent = get('reprint-confirm').checked ? tr('Ready for printing','جاهز للطباعة') : tr('Confirm reprinting to continue','أكّد إعادة الطباعة للمتابعة'); };
  }
  function printBulk(token) {
    if (state.busy || !bulkReview || get('bulk-print').disabled) return;
    const review = pendingBulk?.review || bulkReview;
    openLabelPreview({
      kind: 'bulk', sizeId: pendingBulk?.payload.sizeId || review.selection.sizeId,
      pending: pendingBulk?.payload, confirmed: !!get('reprint-confirm')?.checked,
      async load(sizeId) {
        if (pendingBulk?.preview) return { data:pendingBulk.preview, review:pendingBulk.review, base:pendingBulk.payload };
        const selection = { ...review.selection, sizeId };
        const fresh = { ...await request('/prelabels/bulk/preview',selection), selection };
        const data = await request('/prelabels/bulk/labels', { ...selection, selectionHash:fresh.selectionHash });
        return { data, review:fresh, base:{ ...selection, selectionHash:fresh.selectionHash } };
      },
      endpoint:'/prelabels/bulk/print',
      savePending(payload, loaded) { pendingBulk = { payload, review:loaded.review, preview:loaded.data }; },
      clearPending() { pendingBulk = null; },
      async refresh() {
        if (!visible(token)) return;
        if (pendingBulk) { bulkReview=pendingBulk.review; showBulkReview(); }
        else await reviewBulk(token);
      },
    });
  }
  async function createView(token) {
    shell(tr('New QR label batch', 'دفعة ملصقات QR جديدة'), tr('Choose the product, then reserve the number of labels you need.', 'اختر المنتج ثم احجز عدد الملصقات المطلوب.'), button('cancel', 'back', tr('Back to batches', 'رجوع للدفعات')));
    get('cancel').onclick = () => go();
    get('content').innerHTML = `<div class="sl-create-grid"><section class="sl-sheet"><h2>${tr('Choose a product', 'اختيار المنتج')}</h2><label class="sl-search"><span>${tr('Product name or SKU', 'اسم المنتج أو كوده')}</span><div>${icon('search')}<input id="sl-product-query" type="search" autocomplete="off" value="${esc(state.productQuery)}" placeholder="${tr('Search all products…', 'ابحث في كل المنتجات…')}"></div></label><p id="sl-result-count" class="sl-muted" role="status"></p><div id="sl-products"><p class="sl-empty">${tr('Loading products…', 'جارٍ تحميل المنتجات…')}</p></div><nav id="sl-product-paging" class="sl-pagination"></nav></section><section class="sl-sheet sl-create-summary"><h2>${tr('Batch summary', 'ملخص الدفعة')}</h2><div id="sl-selection"></div><label class="sl-field">${tr('Number of labels', 'عدد الملصقات')}<input id="sl-quantity" type="number" min="1" max="1000" step="1" value="${state.quantity}"><small>${tr('1–1,000 labels per batch', 'من 1 إلى 1,000 ملصق للدفعة')}</small></label><p class="sl-note">${tr('Each piece gets a unique U identity, using the same identity system as regular pieces. No invoice or stock is created here.', 'كل قطعة لها هوية U مستقلة بنفس نظام القطع العادية. هذه الخطوة لا تنشئ فاتورة أو مخزونًا.')}</p>${button('issue', 'plus', tr('Create batch', 'إنشاء الدفعة'), true)}</section></div>`;
    get('product-query').oninput = () => { state.productQuery = get('product-query').value; state.productPage = 1; drawProducts(); };
    get('product-query').onkeydown = e => { if (e.key === 'ArrowDown') { e.preventDefault(); root.querySelector('[data-product]')?.focus(); } };
    get('quantity').oninput = () => { state.quantity = get('quantity').value; };
    get('issue').onclick = issue; drawSelection();
    try { if (!state.products) state.products = (await api('/products')).filter(p => p.isActive !== false); if (visible(token)) drawProducts(); }
    catch (e) { if (visible(token)) { message(e.message, true); get('products').innerHTML = button('products-retry', 'refresh', tr('Retry products', 'إعادة تحميل المنتجات')); get('products-retry').onclick = () => render(); } }
  }
  function drawSelection() {
    const p = state.selected;
    get('selection').innerHTML = p ? `<div class="sl-selected"><span>${tr('Selected product', 'المنتج المختار')}</span><div class="sl-selected-identity">${productPicture(p)}<div><strong dir="auto">${esc(p.name)}</strong><code dir="auto">${esc(p.code)}</code></div></div></div>` : `<p class="sl-muted">${tr('Select a product from the results.', 'اختر منتجًا من نتائج البحث.')}</p>`;
    hideBrokenProductImages(get('selection'));
    get('issue').disabled = !p; get('issue').dataset.locked = String(!p);
  }
  function drawProducts() {
    if (!get('products') || !state.products) return;
    const q = normalize(state.productQuery), terms = q.split(' ').filter(Boolean);
    const compact = q.replace(/\s/g, '');
    const matches = state.products.map(p => {
      const name = normalize(p.name), code = normalize(p.code), compactCode = code.replace(/\s/g, ''), compactName = name.replace(/\s/g, '');
      const text = name + ' ' + code;
      const found = !q || terms.every(term => text.includes(term)) || compactCode.includes(compact) || compactName.includes(compact);
      const score = code === q || compactCode === compact ? 4 : name === q ? 3 : code.startsWith(q) || compactCode.startsWith(compact) ? 2 : name.startsWith(q) ? 1 : 0;
      return { p, found, score };
    }).filter(row => row.found).sort((a,b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
    const pages = Math.max(1, Math.ceil(matches.length / 8)); state.productPage = Math.min(pages, state.productPage);
    const rows = matches.slice((state.productPage - 1) * 8, state.productPage * 8);
    get('result-count').textContent = tr(`${num(matches.length)} products`, `${num(matches.length)} منتج`);
    get('products').innerHTML = rows.length ? rows.map(({p}) => `<button type="button" class="sl-product${state.selected?._id === p._id ? ' is-selected' : ''}" data-product="${esc(p._id)}" aria-pressed="${state.selected?._id === p._id}">${productPicture(p)}<span class="sl-product-copy"><strong dir="auto">${esc(p.name)}</strong><small dir="auto">${esc(p.code)}</small></span>${state.selected?._id === p._id ? icon('check') : `<span class="sl-pick">${tr('Choose', 'اختيار')}</span>`}</button>`).join('') : `<p class="sl-empty">${tr('No matching products. Try part of the name or SKU.', 'لا توجد منتجات مطابقة. جرّب جزءًا من الاسم أو الكود.')}</p>`;
    hideBrokenProductImages(get('products'));
    root.querySelectorAll('[data-product]').forEach(el => {
      el.onclick = () => { state.selected = state.products.find(p => p._id === el.dataset.product); drawSelection(); drawProducts(); if (matchMedia('(max-width:760px)').matches) { get('quantity').focus({ preventScroll: true }); get('selection').scrollIntoView({ block: 'center' }); } else root.querySelector(`[data-product="${el.dataset.product}"]`)?.focus({ preventScroll: true }); };
      el.onkeydown = e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling)?.focus(); } };
    });
    get('product-paging').innerHTML = pages > 1 ? `<span>${state.productPage} / ${pages}</span><div>${button('product-prev','back',tr('Previous','السابق'))}${button('product-next','back',tr('Next','التالي'))}</div>` : '';
    if (pages > 1) { get('product-prev').disabled = state.productPage === 1; get('product-next').disabled = state.productPage === pages; get('product-prev').onclick = () => { state.productPage--; drawProducts(); }; get('product-next').onclick = () => { state.productPage++; drawProducts(); }; }
  }
  async function issue() {
    if (state.busy) return;
    const quantity = Number(get('quantity').value), productId = state.selected?._id;
    if (!productId || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return message(tr('Choose a product and 1–1,000 labels.', 'اختر منتجًا وعددًا صحيحًا من 1 إلى 1,000.'), true);
    const token = generation;
    if (state.draftCoverChoice === null) {
      const choice = await askBatchCover();
      if (choice === null || !visible(token)) return;
      state.draftCoverChoice = choice;
    }
    const payload = state.pendingIssue?.productId === productId && state.pendingIssue.quantity === quantity ? state.pendingIssue : { productId, quantity, operationKey: crypto.randomUUID(), reason: 'Supplier labels issued before purchase' };
    state.pendingIssue = payload; busy(true); message(tr('Creating batch…', 'جارٍ إنشاء الدفعة…'));
    try {
      const result = await request('/prelabels/batches', payload); state.pendingIssue = null;
      state.coverChoiceByBatch.set(result.batchId, state.draftCoverChoice);
      try { localStorage.setItem(coverStorageKey(result.batchId), state.draftCoverChoice ? 'yes' : 'no'); } catch { /* The current page keeps the choice. */ }
      state.draftCoverChoice = null;
      busy(false); state.query = ''; state.page = 1;
      if (visible(token)) { go('batch/' + result.batchId, true); }
    } catch (e) { if (visible(token)) message(e.message + tr(' Retry the same request if its result is uncertain.', ' أعد نفس الطلب عند عدم وضوح النتيجة.'), true); }
    finally { busy(false); }
  }
  async function detailView(id, token, page = 1) {
    shell(tr('Batch details & printing', 'تفاصيل الدفعة والطباعة'), tr('The same identities are kept when you reprint.', 'إعادة الطباعة تحتفظ بنفس الهويات.'), button('back', 'back', tr('Back to batches', 'رجوع للدفعات')));
    get('back').onclick = () => go();
    get('content').innerHTML = `<div class="sl-sheet sl-empty">${tr('Loading batch…', 'جارٍ تحميل الدفعة…')}</div>`;
    try {
      const [data, config] = await Promise.all([request(`/prelabels/batches/${id}?page=${page}&limit=20`), state.sizes.length ? { labelSizes: state.sizes } : request('/config')]);
      if (!visible(token)) return; state.sizes = config.labelSizes;
      const b = data.batch;
      get('content').innerHTML = `<section class="sl-batch-heading"><div><h2 dir="auto">${esc(b.productName)}</h2><p dir="auto">${esc(b.sku)}</p></div><div><span>${tr('Batch ID', 'رقم الدفعة')}</span><code dir="ltr">${esc(b.batchId)}</code></div></section><div class="sl-counts">${[['quantity','Labels','ملصق'],['printed','Print requested','طُلبت طباعتها'],['linked','Linked','مرتبطة'],['unused','Unused','غير مستخدمة']].map(([key,en,ar]) => `<div><span>${tr(en,ar)}</span><strong>${num(b[key])}</strong></div>`).join('')}</div><div class="sl-detail-grid"><section class="sl-sheet"><h2>${tr('Print labels', 'طباعة الملصقات')}</h2>${b.unused ? `<div class="sl-print-range"><label class="sl-field">${tr('Start at label', 'ابدأ من الملصق رقم')}<input id="sl-start" type="number" min="1" max="${b.quantity}" value="${b.firstUnprinted || b.firstUnused || 1}"></label><label class="sl-field">${tr('Number to print', 'عدد الملصقات للطباعة')}<input id="sl-print-quantity" type="number" min="1" max="100" value="${Math.min(100,b.quantity - (b.firstUnprinted || b.firstUnused || 1) + 1)}"></label></div><label class="sl-field">${tr('Label size', 'مقاس الملصق')}<select id="sl-size">${state.sizes.map(s => `<option value="${esc(s.id)}">${s.widthMm} × ${s.heightMm} mm</option>`).join('')}</select></label><p id="sl-range-note" class="sl-note"></p><p class="sl-muted">${tr('Up to 100 labels per print request. Check the physical output before handing it to the supplier.', 'حتى 100 ملصق في المرة. راجع الورق المطبوع قبل تسليمه للمورد.')}</p>${button('print','print',tr('Preview & print','طباعة'),true)}` : `<p class="sl-note">${tr('All labels are linked. Reprint active pieces from Warehouse management.', 'كل الملصقات مرتبطة. أعد طباعة القطع المفعلة من إدارة المخازن.')}</p>`}</section><div class="sl-detail-record"><section class="sl-sheet"><h2>${tr('Issuance record', 'سجل الإصدار')}</h2><dl class="sl-facts">${[[tr('Issued at','تاريخ الإصدار'),date(b.createdAt)],[tr('Issued by','أصدرها'),b.createdBy || '—'],[tr('Origin','الأصل'),b.source === 'internal-prepurchase' ? tr('Before purchase','إصدار قبل الشراء') : b.source || '—'],[tr('Label numbers','أرقام الملصقات'),`1–${num(b.quantity)}`],[tr('Print requests','طلبات الطباعة'),num(b.printRequests)],[tr('Last print request','آخر طلب طباعة'),date(b.lastPrintRequestedAt)]].map(([label,value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section><section class="sl-sheet"><h2>${tr('Linked purchase invoices','فواتير الشراء المرتبطة')} <span class="sl-muted">(${num(data.linkedPurchaseTotal)})</span></h2>${data.linkedPurchases.length ? data.linkedPurchases.map(p => `<div class="sl-invoice"><div><strong>#${esc(p.ref || p.transactionId)}</strong><p>${esc(p.supplier || '—')}${p.cancelled ? ' · ' + tr('Cancelled','ملغاة') : ''}</p><small>${tr('Invoice date','تاريخ الفاتورة')}: ${esc(date(p.invoiceDate))}</small><small>${tr('Linked at','تاريخ الربط')}: ${esc(date(p.lastLinkedAt))}</small><code>${esc(p.transactionId)}</code></div><span>${num(p.quantity)} ${tr('pieces','قطعة')}</span></div>`).join('') : `<p class="sl-muted">${tr('No purchase invoice linked yet. The identities are reserved only.','لم تُربط بفاتورة شراء بعد؛ الهويات محفوظة فقط.')}</p>`}<nav id="sl-invoice-pages" class="sl-pagination"></nav></section></div></div>`;
      if (b.unused) {
        const updateRange = () => { const start = Number(get('start').value), count = Number(get('print-quantity').value); get('range-note').textContent = tr(`Labels ${num(start)} to ${num(start + count - 1)} from this batch. These are sheet positions, not the piece's U identity.`, `الملصقات من ${num(start)} إلى ${num(start + count - 1)} في هذه الدفعة. هذه أرقام ترتيب؛ هوية القطعة هي كود U.`); };
        get('start').oninput = updateRange; get('print-quantity').oninput = updateRange; updateRange();
        get('print').querySelector('span').textContent = tr('Preview & print', '\u0645\u0639\u0627\u064a\u0646\u0629 \u0648\u0637\u0628\u0627\u0639\u0629');
        get('print').onclick = () => printBatch(b, token);
        get('print').insertAdjacentHTML('afterend', button('print-unprinted','print',tr('Unprinted labels only','غير المطبوع فقط')));
        get('print-unprinted').onclick = () => { if (state.busy) return; selectedBatches.clear(); selectedBatches.set(b.batchId,b); bulkMode = 'unprinted'; go('print'); };
      }
      const pages = Math.ceil(data.linkedPurchaseTotal / data.linkedPurchaseLimit);
      if (pages > 1) { get('invoice-pages').innerHTML = button('invoice-prev','back',tr('Previous','السابق')) + `<span>${page} / ${pages}</span>` + button('invoice-next','back',tr('Next','التالي')); get('invoice-prev').disabled = page === 1; get('invoice-next').disabled = page === pages; get('invoice-prev').onclick = () => detailView(id, ++generation, page - 1); get('invoice-next').onclick = () => detailView(id, ++generation, page + 1); }
    } catch (e) { if (visible(token)) { message(e.message, true); get('content').innerHTML = `<div class="sl-sheet sl-empty">${button('detail-retry','refresh',tr('Retry batch','إعادة تحميل الدفعة'))}</div>`; get('detail-retry').onclick = () => render(); } }
  }
  function openLabelPreview(job) {
    if (document.getElementById('sl-print-preview')?.open) return;
    const opener = document.activeElement, openerId = opener?.id;
    const dialog = document.createElement('dialog'); dialog.id = 'sl-print-preview'; dialog.className = 'sl-preview-dialog';
    dialog.setAttribute('aria-labelledby','slp-title');
    dialog.innerHTML = `<div class="sl-preview-shell"><header><div><h2 id="slp-title">${tr('Label preview','معاينة الملصقات')}</h2><p id="slp-summary">${tr('Loading preview…','جارٍ تحميل المعاينة…')}</p></div><button type="button" id="slp-close" aria-label="${tr('Close preview','إغلاق المعاينة')}">${icon('close')}</button></header><div class="sl-preview-toolbar"><label>${tr('Label size','مقاس الملصق')}<select id="slp-size">${state.sizes.map(s=>`<option value="${esc(s.id)}">${s.widthMm} × ${s.heightMm} mm</option>`).join('')}</select></label><label>${tr('Preview zoom','تكبير المعاينة')}<select id="slp-zoom"><option value="1">100%</option><option value="1.5" selected>150%</option><option value="2">200%</option></select></label></div><p id="slp-status" role="status" aria-live="polite"></p><div id="slp-warning"></div><iframe id="slp-frame" title="${tr('Printable QR labels','ملصقات QR الجاهزة للطباعة')}"></iframe><footer><button type="button" id="slp-reload">${icon('refresh')}<span>${tr('Refresh preview','تحديث المعاينة')}</span></button><button type="button" id="slp-print" class="slp-primary" disabled>${icon('print')}<span>${tr('Print','طباعة')}</span></button></footer></div>`;
    document.body.append(dialog);
    const field = id => dialog.querySelector('#slp-'+id);
    let revision = 0, loaded = null, ready = false, sending = false, printed = false, pending = job.pending, changed = false;
    const status = (text,error=false) => { field('status').textContent=text; field('status').dataset.error=String(error); };
    const controls = () => {
      field('close').disabled=sending;
      field('reload').disabled=sending || !!pending;
      field('size').disabled=sending || !!pending;
      field('print').disabled=!ready || sending || printed || (!!field('confirm') && !field('confirm').checked && !pending);
      field('print').querySelector('span').textContent = sending ? tr('Preparing print…','جارٍ تجهيز الطباعة…') : printed ? tr('Print dialog opened','تم فتح الطباعة') : pending ? tr('Retry same request','إعادة نفس الطلب') : tr('Print','طباعة');
    };
    dialog.addEventListener('cancel',e=>{ if(sending) e.preventDefault(); });
    field('close').onclick=()=>dialog.close();
    dialog.addEventListener('close',async()=>{
      revision++; dialog.remove();
      if(changed) await job.refresh();
      if(opener?.isConnected) opener.focus({preventScroll:true}); else if(openerId) document.getElementById(openerId)?.focus({preventScroll:true});
    },{once:true});
    const zoom = () => { if (field('frame').contentDocument?.body) field('frame').contentDocument.body.style.zoom=field('zoom').value; };
    field('zoom').onchange=zoom;
    async function load() {
      const current=++revision; ready=false; printed=false; loaded=null; controls();
      field('warning').innerHTML=''; field('frame').hidden=true;
      status(tr('Preparing the preview. No print request is recorded yet.','جارٍ تجهيز المعاينة؛ لم يُسجل طلب طباعة بعد.'));
      try {
        const next=await job.load(field('size').value);
        if(!dialog.open || current!==revision) return;
        loaded=next;
        const {data}=loaded, template=window.InventoryUnitLabels;
        if(!template?.labelHtml || !data.labels?.length || data.labels.some(l=>l.barcode!=='SU-'+String(l.unitId).toUpperCase()) || new Set(data.labels.map(l=>l.unitId)).size!==data.labels.length) throw new Error(tr('Invalid preview identities. Refresh the preview.','هويات المعاينة غير صالحة؛ حدّث المعاينة.'));
        const size=data.size;
        const sheets = job.includeCovers !== false ? template.groupedLabelSheets(data) : data.labels.map(label => ({ label }));
        const coverCount = sheets.length - data.labels.length;
        const sheetHtml = sheets.map(({label,cover})=>`<section class="slp-paper"${cover ? ` data-batch-cover="${esc(cover.batchId)}"` : ''}>${cover ? template.batchCoverHtml(cover,size) : template.labelHtml(label,size)}</section>`).join('');
        const frame=field('frame'); frame.hidden=false;
        await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error(tr('Preview loading timed out. Retry.','انتهت مهلة تحميل المعاينة؛ أعد المحاولة.'))),15000);
          frame.onload=()=>{clearTimeout(timeout);resolve();};
          frame.srcdoc=`<!doctype html><html dir="ltr"><head><meta charset="utf-8"><title>SOULIA · supplier QR</title><link rel="stylesheet" href="${location.origin}/inventory-units.css?v=20261103-batch-separators"><style>html,body{margin:0;background:#edf1ef}body{display:flex;flex-wrap:wrap;align-content:flex-start;justify-content:center;gap:12px;padding:14px;box-sizing:border-box}.slp-paper{flex:none;width:${size.widthMm}mm;height:${size.heightMm}mm;background:white;box-shadow:0 1px 4px #0002}.slp-paper .iu-label{width:${size.widthMm}mm;height:${size.heightMm}mm}@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}@media print{html,body{width:${size.widthMm}mm;margin:0!important;padding:0!important;display:block!important;zoom:1!important;background:white}.slp-paper{margin:0;box-shadow:none;break-after:page;overflow:hidden}.slp-paper:last-child{break-after:auto}}</style></head><body>${sheetHtml}</body></html>`;
        });
        if(!dialog.open || current!==revision) return;
        if(!frame.contentDocument.querySelector('link')?.sheet) throw new Error(tr('Label styles failed to load. Refresh the preview.','تعذر تحميل تنسيق الملصقات؛ حدّث المعاينة.'));
        await template.waitForLayout(frame.contentDocument);
        if(!dialog.open || current!==revision) return;
        frame.contentWindow.addEventListener('keydown',e=>{if(e.key==='Escape' && !sending) dialog.close();});
        const repeats=data.labels.filter(l=>l.printCount>0).length;
        field('summary').textContent=tr(`${num(data.labels.length)} labels · ${size.widthMm} × ${size.heightMm} mm`,`${num(data.labels.length)} ملصق · ${size.widthMm} × ${size.heightMm} مم`);
        if (coverCount) field('summary').textContent += tr(` · ${num(coverCount)} batch separator sheets`, ` · ${num(coverCount)} ورقة فاصلة لتعريف الدفعات`);
        field('warning').innerHTML=repeats && !pending ? `<label class="slp-confirm"><input type="checkbox" id="slp-confirm" ${job.confirmed?'checked':''}><span>${tr(`${num(repeats)} labels were requested before. I confirm reprinting the same identities.`,`${num(repeats)} ملصق سبق طلب طباعتها. أؤكد إعادة طباعة نفس الهويات.`)}</span></label>` : '';
        if(field('confirm')) field('confirm').onchange=controls;
        zoom(); ready=true;
        status(pending ? tr('Retry resumes the same recorded request without adding another.','إعادة المحاولة تستكمل نفس الطلب دون تسجيل طلب جديد.') : tr('Review the labels, then press Print. Previewing alone does not count as printing.','راجع الملصقات ثم اضغط طباعة. المعاينة وحدها لا تُحسب طباعة.'));
      } catch(e) { if(dialog.open && current===revision) status(e.message,true); }
      finally { if(dialog.open && current===revision) controls(); }
    }
    field('size').value=job.sizeId;
    field('size').onchange=load; field('reload').onclick=load;
    field('print').onclick=async()=>{
      if(!ready || sending || printed || field('print').disabled) return;
      sending=true; controls();
      // The iframe is already loaded and validated before committing a request.
      const payload=pending || {...loaded.base,allowReprint:loaded.data.labels.some(l=>l.printCount>0),operationKey:crypto.randomUUID(),reason:'Operator printed reviewed supplier labels'};
      pending=payload; job.savePending(payload,loaded); changed=true;
      status(tr('Recording this print request…','جارٍ تسجيل طلب الطباعة…'));
      try {
        const result=await request(job.endpoint,payload), expected=new Map(loaded.data.labels.map(l=>[l.unitId,l]));
        if(result.size.id!==loaded.data.size.id || result.labels.length!==expected.size || new Set(result.labels.map(l=>l.unitId)).size!==expected.size || result.labels.some(l=>expected.get(l.unitId)?.barcode!==l.barcode || expected.get(l.unitId)?.manualCode!==l.manualCode)) throw new Error(tr('The printed identities differ from this preview. Reopen the preview.','هويات الطباعة تختلف عن المعاينة؛ أعد فتح المعاينة.'));
        field('frame').contentWindow.focus(); field('frame').contentWindow.print();
        printed=true; pending=null; job.clearPending();
        status(tr('Print dialog opened. Check the physical output; cancelling the system dialog does not erase the request record.','تم فتح نافذة الطباعة. تحقق من خروج الورق؛ إلغاء نافذة النظام لا يلغي سجل الطلب.'));
      } catch(e) {
        if([400,403,404,409].includes(e.status)) {pending=null;job.clearPending();ready=false;}
        status(e.message+tr(' Retry here or refresh the preview.',' أعد المحاولة هنا أو حدّث المعاينة.'),true);
      } finally { sending=false; controls(); }
    };
    dialog.showModal(); void load();
  }
  function printBatch(batch, token) {
    if (state.busy) return;
    const start = Number(get('start').value), quantity = Number(get('print-quantity').value), sizeId = get('size').value;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(quantity) || start < 1 || quantity < 1 || quantity > 100 || start + quantity - 1 > batch.quantity || !sizeId) return message(tr('Review the range and label size.', '\u0631\u0627\u062c\u0639 \u0627\u0644\u0646\u0637\u0627\u0642 \u0648\u0645\u0642\u0627\u0633 \u0627\u0644\u0645\u0644\u0635\u0642.'), true);
    const pending = state.pendingPrint;
    openLabelPreview({
      kind:'single', sizeId, includeCovers: coverChoiceFor(batch.batchId),
      pending:pending?.batchId === batch.batchId && pending.start === start && pending.quantity === quantity && pending.sizeId === sizeId ? pending : null,
      async load(selectedSize) {
        const base = { batchId:batch.batchId, start, quantity, sizeId:selectedSize };
        const data = await request(`/prelabels/batches/${batch.batchId}/preview`, { start, quantity, sizeId:selectedSize });
        return { data, base:{ ...base, selectionHash:data.selectionHash } };
      },
      endpoint:`/prelabels/batches/${batch.batchId}/print`,
      savePending(payload) { state.pendingPrint = payload; },
      clearPending() { state.pendingPrint = null; },
      async refresh() { if (visible(token)) await detailView(batch.batchId,token); },
    });
  }
  window.SupplierLabels = { render, isBusy: () => state.busy };
  // The initial authenticated route can resolve before this script arrives.
  // Mount it now if onPageEnter already made the workspace active.
  if (document.getElementById('page-supplier-labels')?.classList.contains('active')) void render();
}());
