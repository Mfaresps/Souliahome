/* Warehouse identities and transfers. Quantities and audit records are owned by the server. */
(function () {
  'use strict';
  const tr = (en, ar) => currentLang === 'en' ? en : ar;
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let warehouses = [], pending = null, actor = '', selectedWarehouse = 'MAIN', selectedProducts = new Set(), transferRequest = null, busy = false;
  const activeWarehouses = () => warehouses.filter(warehouse => warehouse.active !== false);
  const transactionField = el('tx-warehouse')?.closest('.wh-transaction-field');
  const symbol = kind => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${kind === 'arrow' ? '<path d="M4 12h16m-6-6 6 6-6 6"/>' : kind === 'swap' ? '<path d="M4 8h16l-4-4M20 16H4l4 4"/>' : kind === 'delete' ? '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>' : '<path d="m3 7 9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10"/>'}</svg>`;
  const name = code => warehouses.find(w => w.code === code)?.name || (!code || ['MAIN', 'main', 'المخزن الرئيسي'].includes(code) ? 'المخزن الرئيسي' : code);
  const options = (value = 'MAIN', all = false) => `${all ? `<option value="">${tr('All warehouses', 'كل المخازن')}</option>` : ''}${(warehouses.length ? activeWarehouses() : [{ code: 'MAIN', name: 'المخزن الرئيسي' }]).map(w => `<option value="${esc(w.code)}" ${w.code === value ? 'selected' : ''}>${esc(w.name)}${w.isDefault ? tr(' · Default', ' · الافتراضي') : ''}</option>`).join('')}`;
  async function load(force = false) {
    const token = localStorage.getItem('token');
    if (!token) return [];
    if (actor !== token) { actor = token; warehouses = []; selectedWarehouse = 'MAIN'; selectedProducts.clear(); transferRequest = null; }
    if (pending) return pending;
    if (warehouses.length && !force) return warehouses;
    pending = api('/warehouses', { background: true }).then(rows => { if (actor !== token) return []; if (!Array.isArray(rows)) throw new Error(tr('Invalid warehouse list', 'تعذر قراءة المخازن')); warehouses = rows; fillSelects(); return rows; }).finally(() => { pending = null; });
    return pending;
  }
  function fillSelects() {
    document.querySelectorAll('[data-warehouse-name]').forEach(node => { const text = name(node.dataset.warehouseName); if (node.textContent !== text) node.textContent = text; });
    document.querySelectorAll('select[data-warehouse-select]').forEach(select => {
      const signature = JSON.stringify([currentLang, warehouses.map(w => [w.code, w.name, w.isDefault, w.active]), !!select.dataset.allowAll]);
      if (select.dataset.whOptions === signature) { enhanceSelect(select); return; }
      const value = select.dataset.preferredWarehouse || select.value || (select.dataset.allowAll ? '' : 'MAIN');
      const markup = options(value, !!select.dataset.allowAll);
      if (select.innerHTML !== markup) { select.innerHTML = markup; select.value = value; if (!select.value && !select.dataset.allowAll) select.value = 'MAIN'; }
      select.dataset.whOptions = signature;
      if (select.dataset.preferredWarehouse && select.value === select.dataset.preferredWarehouse) delete select.dataset.preferredWarehouse;
      enhanceSelect(select);
    });
  }
  function enhanceSelect(select) {
    if (select.id === 'wh-to' && el('wh-from')) [...select.options].forEach(option => { option.disabled = option.value === el('wh-from').value; });
    if (!select.nextElementSibling?.classList.contains('wh-picker')) {
      select.classList.add('wh-native-select'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
      const picker = document.createElement('details'); picker.className = 'wh-picker';
      picker.innerHTML = `<summary>${symbol('box')}<span class="wh-picker-value"></span><svg class="wh-picker-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg></summary><div class="wh-picker-menu"><input type="search" class="wh-picker-search" autocomplete="off" aria-label="${tr('Search warehouses', 'البحث في المخازن')}" placeholder="${tr('Search warehouses…', 'بحث عن مخزن…')}"><div class="wh-picker-options" role="listbox" aria-label="${tr('Warehouses', 'المخازن')}"></div><p class="wh-picker-empty" hidden>${tr('No matching warehouse', 'لا يوجد مخزن مطابق')}</p></div>`;
      select.after(picker);
      picker.querySelector('summary').onclick = event => { if (select.disabled) event.preventDefault(); };
      picker.ontoggle = () => {
        if (!picker.open) return;
        if (select.disabled) { picker.open = false; return; }
        document.querySelectorAll('.wh-picker[open]').forEach(other => { if (other !== picker) other.open = false; });
        const rect = picker.getBoundingClientRect(), boundary = picker.closest('.wh-dialog-body')?.getBoundingClientRect();
        const below = (boundary?.bottom || innerHeight) - rect.bottom - 12, above = rect.top - (boundary?.top || 0) - 12;
        picker.classList.toggle('opens-up', below < 230 && above > below);
        picker.querySelector('.wh-picker-options').style.maxHeight = Math.max(80, Math.min(220, Math.max(above, below) - 62)) + 'px';
      };
      picker.querySelector('.wh-picker-search').oninput = event => {
        const query = event.target.value.trim().toLocaleLowerCase(); let found = false;
        picker.querySelectorAll('[data-wh-option]').forEach(button => { button.hidden = !button.textContent.toLocaleLowerCase().includes(query); found ||= !button.hidden; });
        picker.querySelector('.wh-picker-empty').hidden = found;
      };
      picker.querySelector('.wh-picker-options').onclick = event => {
        const button = event.target.closest('[data-wh-option]'); if (!button || button.disabled || select.disabled) return;
        event.preventDefault(); select.value = button.dataset.whOption; picker.open = false; select.dispatchEvent(new Event('change', { bubbles: true })); enhanceSelect(select); picker.querySelector('summary').focus({ preventScroll: true });
      };
      picker.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); picker.open = false; picker.querySelector('summary').focus(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target.matches('input') || select.disabled) return;
        event.preventDefault(); picker.open = true;
        const buttons = [...picker.querySelectorAll('[data-wh-option]:not([hidden]):not(:disabled)')], index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      };
    }
    const picker = select.nextElementSibling, summary = picker.querySelector('summary');
    if (select.disabled) picker.open = false;
    const text = select.selectedOptions[0]?.textContent || tr('Choose a warehouse', 'اختر المخزن');
    if (picker.querySelector('.wh-picker-value').textContent !== text) picker.querySelector('.wh-picker-value').textContent = text;
    summary.setAttribute('aria-disabled', String(select.disabled));
    summary.setAttribute('aria-label', (select.getAttribute('aria-label') || tr('Warehouse', 'المخزن')) + ': ' + text);
    const signature = JSON.stringify([...select.options].map(option => [option.value, option.textContent, option.disabled, option.selected]));
    if (picker.dataset.options !== signature) {
      picker.dataset.options = signature;
      picker.querySelector('.wh-picker-options').innerHTML = [...select.options].map(option => `<button type="button" role="option" aria-selected="${option.selected}" data-wh-option="${esc(option.value)}" ${option.disabled ? 'disabled' : ''}><span>${esc(option.textContent)}</span><span aria-hidden="true">${option.selected ? '✓' : ''}</span></button>`).join('');
      picker.querySelector('.wh-picker-search').value = ''; picker.querySelector('.wh-picker-empty').hidden = true;
    }
  }
  function field(prefix) { return `<label class="wh-field">${tr('Warehouse', 'المخزن')}<select id="${prefix}-warehouse" data-warehouse-select>${options(prefix === 'adj' ? selectedWarehouse || 'MAIN' : 'MAIN')}</select><small>${tr('Stock is recorded in the selected warehouse.', 'تُسجل حركة المخزون في المخزن المختار.')}</small></label>`; }
  function read(prefix) { return el(prefix + '-warehouse')?.value || 'MAIN'; }
  function inventoryRows(rows, location = selectedWarehouse) {
    if (!location) return rows;
    return rows.map(row => { const current = Number(row.warehouseBalances?.[location] || 0); return { ...row, current, status: current <= 0 ? 'zero' : current <= (row.minStock || 10) ? 'low' : 'ok' }; });
  }
  function invoiceChip(tx) {
    const code = tx.warehouseCode || 'MAIN';
    return `<div class="wh-invoice-chip"><span>${tr('Invoice warehouse', 'مخزن الفاتورة')}</span><strong data-warehouse-name="${esc(code)}" dir="auto">${esc(name(code))}</strong></div>`;
  }
  function mount() {
    const page = el('page-inventory');
    if (page && !el('wh-inventory-toolbar')) {
      const bar = document.createElement('section'); bar.id = 'wh-inventory-toolbar'; bar.className = 'wh-toolbar';
      bar.innerHTML = `<label class="wh-field"><span>${tr('Warehouse balance', 'رصيد المخزن')}</span><select id="wh-inventory-filter" data-warehouse-select data-allow-all="true">${options(selectedWarehouse, true)}</select></label>`;
      const target = [...page.querySelectorAll('#inv-toolbar .fx-toolbar-row')].pop(); if (target) target.insertBefore(bar, target.querySelector('.fx-results-count')); else page.querySelector('.inv-page-header')?.after(bar);
      el('wh-inventory-filter').onchange = event => { selectedWarehouse = event.target.value; page.classList.toggle('wh-filtered', !!selectedWarehouse); renderInventory(); };
    }
    if (page && !el('wh-header-actions')) {
      const actions = document.createElement('div'); actions.id = 'wh-header-actions'; actions.className = 'wh-header-actions';
      actions.innerHTML = `<button type="button" class="btn btn-outline btn-sm" data-wh-action="manage">${symbol('box')}<span>${tr('Manage warehouses', 'إدارة المخازن')}</span></button><button type="button" class="btn btn-outline btn-sm" data-wh-action="transfer">${symbol('swap')}<span>${tr('Transfer products', 'نقل المنتجات')}</span></button>`;
      page.querySelector('.inv-header-actions')?.prepend(actions);
      actions.onclick = event => { const action = event.target.closest('[data-wh-action]')?.dataset.whAction; if (action === 'manage') manage(); if (action === 'transfer') transfer(); };
    }
    const txFields = el('tx-fields');
    if (txFields && transactionField && transactionField.parentElement !== txFields) txFields.insertBefore(transactionField, txFields.querySelector('#tx-receipt'));
    if (transactionField) transactionField.hidden = typeof txType !== 'undefined' && txType === 'مرتجع';
    page?.querySelectorAll('[data-wh-action]').forEach(button => { button.hidden = !isAdmin(); });
    if (el('wh-header-actions')) el('wh-header-actions').hidden = !isAdmin();
    fillSelects();
    const txLabel = el('wh-tx-label'), txHint = el('wh-tx-hint');
    if (txLabel) { const label = typeof txType !== 'undefined' && txType === 'مشتريات' ? tr('Receiving warehouse', 'مخزن الاستلام') : tr('Dispatch warehouse', 'مخزن الصرف'); if (txLabel.textContent !== label) txLabel.textContent = label; }
    if (txHint) {
      const incoming = typeof txType !== 'undefined' && txType !== 'مبيعات';
      const text = incoming ? tr('Stock is received in: ', 'يُضاف المخزون إلى: ') + name(read('tx')) : tr('Stock is deducted from: ', 'يُخصم المخزون من: ') + name(read('tx'));
      if (txHint.textContent !== text) txHint.textContent = text;
    }
    window.updateSaleWarehouseCaption?.();
    if (document.querySelector('[data-warehouse-select]')) load().catch(() => {});
  }
  function dialog(title, body, footer = '') {
    let dialog = el('wh-dialog');
    if (dialog?.open && busy) return dialog;
    if (dialog) { dialog.close(); dialog.remove(); }
    dialog = document.createElement('dialog'); dialog.id = 'wh-dialog'; dialog.className = 'wh-dialog'; dialog.dir = currentLang === 'en' ? 'ltr' : 'rtl';
    dialog.innerHTML = `<header><h2>${esc(title)}</h2><button type="button" class="btn btn-outline" data-wh-close aria-label="${tr('Close', 'إغلاق')}">×</button></header><div class="wh-dialog-body">${body}<p id="wh-error" role="status" aria-live="polite"></p></div>${footer ? `<footer>${footer}</footer>` : ''}`;
    dialog.onclick = event => { if (event.target.closest('[data-wh-close]') && !busy) dialog.close(); };
    dialog.oncancel = event => { if (busy) event.preventDefault(); };
    document.body.appendChild(dialog); dialog.showModal(); return dialog;
  }
  function setBusy(value) {
    busy = value;
    el('wh-dialog')?.querySelectorAll('input,select,button').forEach(control => {
      if (value && control.dataset.whDisabled === undefined) { control.dataset.whDisabled = String(control.disabled); control.disabled = true; }
      if (!value && control.dataset.whDisabled !== undefined) { control.disabled = control.dataset.whDisabled === 'true'; delete control.dataset.whDisabled; }
    });
    fillSelects();
  }
  async function manage() {
    if (busy) return;
    try {
      await load();
      const card = w => `<form data-wh-rename="${esc(w.code)}" class="wh-warehouse-card"><div class="wh-warehouse-card-head">${symbol('box')}<span>${esc(w.isDefault ? tr('Default warehouse', 'المخزن الافتراضي') : tr('Warehouse', 'مخزن'))}</span><bdi>${esc(w.code)}</bdi></div><label class="wh-field"><span>${tr('Warehouse name', 'اسم المخزن')}</span><input name="name" value="${esc(w.name)}" maxlength="80" required></label><div class="wh-warehouse-card-actions"><button class="btn btn-outline" type="submit">${tr('Save name', 'حفظ الاسم')}</button><button class="btn wh-delete-button" type="button" data-wh-delete="${esc(w.code)}" ${w.isDefault || w.code === 'MAIN' ? 'disabled' : ''} title="${esc(w.isDefault || w.code === 'MAIN' ? tr('The default warehouse is required for sales and opening stock.', 'المخزن الافتراضي مطلوب للمبيعات والرصيد الافتتاحي.') : tr('Delete empty warehouse', 'حذف المخزن الخالي'))}">${symbol('delete')}${tr('Delete', 'حذف')}</button></div>${w.isDefault ? `<small class="wh-note">${tr('The default warehouse is protected. You can rename it.', 'المخزن الافتراضي محمي من الحذف ويمكن تعديل اسمه.')}</small>` : ''}<div class="wh-delete-confirm" hidden><strong>${tr('Delete this warehouse?', 'حذف هذا المخزن؟')}</strong><p>${tr('It must be empty and have no assigned pieces. Invoices and movement history are preserved.', 'يجب أن يكون خاليًا من الأرصدة والقطع المرتبطة. تبقى الفواتير وسجلات الحركة محفوظة.')}</p><div><button type="button" class="btn wh-delete-button" data-wh-delete-confirm="${esc(w.code)}">${tr('Confirm deletion', 'تأكيد الحذف')}</button><button type="button" class="btn btn-outline" data-wh-transfer-code="${esc(w.code)}">${tr('Transfer this warehouse stock', 'نقل رصيد هذا المخزن')}</button><button type="button" class="btn btn-outline" data-wh-delete-cancel>${tr('Cancel', 'إلغاء')}</button></div></div></form>`;
      const removed = warehouses.filter(w => w.active === false);
      const modal = dialog(tr('Manage warehouses', 'إدارة المخازن'), `<p class="wh-note">${tr('Name your warehouses and manage where stock is stored.', 'سمِّ المخازن ونظّم أماكن حفظ المخزون.')}</p><div class="wh-warehouse-list">${activeWarehouses().map(card).join('')}</div><form id="wh-create-form"><div><h3>${tr('Add a warehouse', 'إضافة مخزن')}</h3><p class="wh-note">${tr('It becomes available in purchases and stock transfers.', 'يظهر في المشتريات ونقل المخزون بمجرد إضافته.')}</p></div><label class="wh-field"><span>${tr('Warehouse name', 'اسم المخزن')}</span><input name="name" maxlength="80" required placeholder="${tr('For example: branch warehouse', 'مثال: مخزن الفرع')}"></label><button class="btn btn-primary" type="submit">${tr('Add warehouse', 'إضافة المخزن')}</button></form>${removed.length ? `<details class="wh-deleted-list"><summary>${tr('Deleted warehouses', 'المخازن المحذوفة')} (${removed.length})</summary>${removed.map(w => `<div><span dir="auto">${esc(w.name)}</span><button type="button" class="btn btn-outline" data-wh-restore="${esc(w.code)}">${tr('Restore', 'استعادة')}</button></div>`).join('')}</details>` : ''}<details id="wh-history"><summary>${tr('Recent transfers', 'آخر حركات النقل')}</summary><div id="wh-history-rows"></div></details>`);
      modal.onsubmit = async event => {
        event.preventDefault(); if (busy) return;
        const form = event.target, code = form.dataset.whRename;
        try { setBusy(true); await api('/warehouses' + (code ? '/' + encodeURIComponent(code) : ''), { method: code ? 'PATCH' : 'POST', body: JSON.stringify({ name: form.elements.name.value.trim() }) }); await load(true); setBusy(false); await manage(); }
        catch (error) { el('wh-error').textContent = error.message; } finally { setBusy(false); }
      };
      const closeHandler = modal.onclick;
      modal.onclick = async event => {
        closeHandler(event);
        const button = event.target.closest('button'); if (!button || button.disabled || busy) return;
        if (button.hasAttribute('data-wh-delete')) { button.closest('form').querySelector('.wh-delete-confirm').hidden = false; return; }
        if (button.hasAttribute('data-wh-delete-cancel')) { button.closest('.wh-delete-confirm').hidden = true; return; }
        if (button.dataset.whTransferCode) { modal.close(); await transfer(button.dataset.whTransferCode); return; }
        const code = button.dataset.whDeleteConfirm || button.dataset.whRestore;
        if (!code) return;
        try {
          setBusy(true); el('wh-error').textContent = '';
          await api('/warehouses/' + encodeURIComponent(code) + (button.dataset.whRestore ? '/restore' : ''), { method: button.dataset.whRestore ? 'POST' : 'DELETE' });
          if (selectedWarehouse === code) { selectedWarehouse = 'MAIN'; if (el('wh-inventory-filter')) el('wh-inventory-filter').value = 'MAIN'; }
          await load(true); setBusy(false); await manage(); if (typeof currentPage !== 'undefined' && currentPage === 'inventory') renderInventory();
          toast(button.dataset.whRestore ? tr('Warehouse restored.', 'تمت استعادة المخزن.') : tr('Warehouse deleted. Its history is preserved.', 'تم حذف المخزن مع الاحتفاظ بسجله.'));
        } catch (error) { el('wh-error').textContent = error.message; } finally { setBusy(false); }
      };
      el('wh-history').ontoggle = async event => {
        if (!event.target.open) return;
        try { const rows = await api('/warehouses/transfers', { background: true }); if (!el('wh-history-rows')) return; el('wh-history-rows').innerHTML = rows.map(row => `<article><div class="wh-history-route"><bdi>${esc(name(row.from))}</bdi><span class="wh-flow-arrow">${symbol('arrow')}</span><bdi>${esc(name(row.to))}</bdi></div><span>${esc(new Date(row.createdAt).toLocaleString(currentLang === 'en' ? 'en-GB' : 'ar-EG'))} · ${esc(row.by)}</span><p>${row.lines.length} ${tr('products', 'منتجات')} · ${row.lines.reduce((sum, line) => sum + line.quantity, 0)} ${tr('pieces', 'قطعة')}</p><small>${esc(row.reason)}</small></article>`).join('') || `<p>${tr('No transfers yet', 'لا توجد حركات نقل بعد')}</p>`; } catch (error) { if (el('wh-error')) el('wh-error').textContent = error.message; }
      };
    } catch (error) { toast(error.message, true); }
  }
  async function transfer(sourceCode) {
    if (busy) return;
    try {
      await load();
      if (activeWarehouses().length < 2) { await manage(); el('wh-error').textContent = tr('Add another warehouse first, then open Transfer products.', 'أضف مخزنًا آخر أولًا، ثم افتح نقل المنتجات.'); return; }
      const inventory = await api('/transactions/inventory', { background: true });
      const from = sourceCode || selectedWarehouse || 'MAIN', to = activeWarehouses().find(w => w.code !== from)?.code;
      selectedProducts = new Set();
      const modal = dialog(tr('Transfer products between warehouses', 'نقل المنتجات بين المخازن'), `<p class="wh-note">${tr('Transfer the entire source balance of each selected product. Tracked pieces move with their original barcodes. Reserved pieces block the transfer.', 'يُنقل كامل رصيد كل منتج محدد من المصدر، وتنتقل القطع بأكوادها الأصلية. القطع المحجوزة تمنع نقل المنتج.')}</p><h3 class="wh-step-heading"><b>1</b>${tr('Choose warehouses', 'اختيار المخازن')}</h3><div class="wh-transfer-locations"><label class="wh-field"><span>${tr('From · source warehouse', 'من · مخزن المصدر')}</span><select id="wh-from" data-warehouse-select aria-label="${tr('Source warehouse', 'مخزن المصدر')}">${options(from)}</select></label><div class="wh-flow-middle"><span class="wh-flow-arrow">${symbol('arrow')}</span><button type="button" id="wh-swap" class="btn btn-outline" aria-label="${tr('Swap source and destination', 'تبديل المصدر والوجهة')}" title="${tr('Swap source and destination', 'تبديل المصدر والوجهة')}">${symbol('swap')}</button></div><label class="wh-field"><span>${tr('To · destination warehouse', 'إلى · مخزن الوجهة')}</span><select id="wh-to" data-warehouse-select aria-label="${tr('Destination warehouse', 'مخزن الوجهة')}">${options(to)}</select></label></div><h3 class="wh-step-heading"><b>2</b>${tr('Choose products', 'تحديد المنتجات')}</h3><label class="wh-field">${tr('Find products', 'بحث المنتجات')}<input id="wh-transfer-query" type="search" placeholder="${tr('Product name or SKU', 'اسم المنتج أو SKU')}"></label><div class="wh-transfer-tools"><label><input id="wh-select-all" type="checkbox">${tr('Select all matching products', 'تحديد كل المنتجات المطابقة')}</label><strong id="wh-selected-count"></strong></div><div id="wh-transfer-products"></div><h3 class="wh-step-heading"><b>3</b>${tr('Review and confirm', 'المراجعة والتأكيد')}</h3><label class="wh-field"><span>${tr('Transfer reference / reason', 'مرجع / سبب النقل')}</span><input id="wh-transfer-reason" maxlength="1000" required></label><label class="wh-confirm"><input id="wh-transfer-confirm" type="checkbox">${tr('I confirm the physical transfer of the displayed quantities to the destination warehouse.', 'أؤكد النقل الفعلي للكميات المعروضة إلى مخزن الوجهة.')}</label>`, `<span id="wh-transfer-feedback" class="wh-footer-feedback"></span><button class="btn btn-outline" type="button" data-wh-close>${tr('Cancel', 'إلغاء')}</button><button class="btn btn-primary" id="wh-transfer-submit" type="button">${tr('Confirm transfer', 'تأكيد النقل')}</button>`);
      modal.classList.add('wh-transfer-dialog');
      const available = () => inventory.filter(row => Number(row.warehouseBalances?.[el('wh-from').value] || 0) > 0);
      const matches = () => { const q = el('wh-transfer-query').value.trim().toLocaleLowerCase(); return available().filter(row => (row.name + ' ' + row.code).toLocaleLowerCase().includes(q)); };
      const counts = () => {
        const destination = el('wh-to');
        [...destination.options].forEach(option => { option.disabled = option.value === el('wh-from').value; });
        if (destination.value === el('wh-from').value) destination.value = [...destination.options].find(option => !option.disabled)?.value || '';
        enhanceSelect(el('wh-from')); enhanceSelect(destination);
        const rows = available().filter(row => selectedProducts.has(row._id)), pieces = rows.reduce((sum, row) => sum + row.warehouseBalances[el('wh-from').value], 0);
        el('wh-selected-count').textContent = tr(`${rows.length} products · ${pieces} pieces`, `${rows.length} منتج · ${pieces} قطعة`);
        const visible = matches(), checked = visible.filter(row => selectedProducts.has(row._id)).length;
        el('wh-select-all').checked = visible.length > 0 && checked === visible.length; el('wh-select-all').indeterminate = checked > 0 && checked < visible.length;
        el('wh-transfer-feedback').textContent = rows.length ? tr(`${rows.length} products · ${pieces} pieces`, `${rows.length} منتج · ${pieces} قطعة`) : tr('Select products to continue', 'حدد المنتجات للمتابعة');
        el('wh-transfer-submit').disabled = !rows.length || !el('wh-transfer-confirm').checked || el('wh-from').value === el('wh-to').value;
      };
      const render = () => {
        el('wh-transfer-products').innerHTML = matches().map(row => `<label><input type="checkbox" data-wh-product="${esc(row._id)}" ${selectedProducts.has(row._id) ? 'checked' : ''}><span><strong dir="auto">${esc(row.name)}</strong><small>SKU ${esc(row.code)}</small></span><b>${row.warehouseBalances[el('wh-from').value]} ${tr('pieces', 'قطعة')}</b></label>`).join('') || `<p class="wh-note">${tr('No positive stock matches this warehouse and search.', 'لا توجد منتجات برصيد موجب تطابق المخزن والبحث.')}</p>`; counts();
      };
      el('wh-transfer-products').onchange = event => { const id = event.target.dataset.whProduct; if (!id) return; event.target.checked ? selectedProducts.add(id) : selectedProducts.delete(id); transferRequest = null; el('wh-transfer-confirm').checked = false; counts(); };
      el('wh-transfer-query').oninput = render;
      el('wh-from').onchange = () => { selectedProducts.clear(); transferRequest = null; el('wh-transfer-confirm').checked = false; render(); };
      el('wh-swap').onclick = () => { const source = el('wh-from').value; el('wh-from').value = el('wh-to').value; [...el('wh-to').options].forEach(option => { option.disabled = false; }); el('wh-to').value = source; selectedProducts.clear(); transferRequest = null; el('wh-transfer-confirm').checked = false; render(); };
      el('wh-to').onchange = () => { transferRequest = null; el('wh-transfer-confirm').checked = false; counts(); };
      el('wh-select-all').onchange = event => { matches().forEach(row => event.target.checked ? selectedProducts.add(row._id) : selectedProducts.delete(row._id)); transferRequest = null; el('wh-transfer-confirm').checked = false; render(); };
      el('wh-transfer-confirm').onchange = counts;
      el('wh-transfer-reason').oninput = () => { transferRequest = null; };
      el('wh-transfer-submit').onclick = async () => {
        if (busy || !selectedProducts.size || !el('wh-transfer-confirm').checked) return;
        const reason = el('wh-transfer-reason').value.trim();
        if (!reason) { el('wh-error').textContent = tr('Enter a transfer reference or reason.', 'أدخل مرجعًا أو سببًا للنقل.'); el('wh-transfer-reason').focus(); return; }
        transferRequest ||= { operationKey: crypto.randomUUID(), from: el('wh-from').value, to: el('wh-to').value, productIds: [...selectedProducts].sort(), reason, physicalTransferConfirmed: true, quantities: Object.fromEntries(inventory.filter(row => selectedProducts.has(row._id)).map(row => [row._id, Number(row.warehouseBalances?.[el('wh-from').value] || 0)])) };
        try { setBusy(true); el('wh-error').textContent = ''; const result = await api('/warehouses/transfers', { method: 'POST', body: JSON.stringify(transferRequest) }); transferRequest = null; modal.close(); toast(tr(`Transferred ${result.lines.length} products.`, `تم نقل ${result.lines.length} منتج.`)); await loadInventory(); if (typeof currentPage !== 'undefined' && currentPage === 'barcodes') await window.renderBarcodeManagement?.(); }
        catch (error) { el('wh-error').textContent = error.message + tr(' Retry preserves the same transfer request.', ' إعادة المحاولة تحتفظ بنفس طلب النقل.'); }
        finally { setBusy(false); counts(); }
      };
      render();
    } catch (error) { toast(error.message, true); }
  }
  window.SouliaWarehouses = { load, name, options, field, read, inventoryRows, invoiceChip, mount, manage, transfer };
  document.addEventListener('click', event => { document.querySelectorAll('.wh-picker[open]').forEach(picker => { if (!picker.contains(event.target)) picker.open = false; }); });
  document.addEventListener('reset', () => setTimeout(mount, 0));
  document.addEventListener('change', event => {
    if (event.target.matches('[data-warehouse-select]')) mount();
    if (event.target.id === 'tx-warehouse') window.refreshSaleWarehouseStock?.(true);
  });
  const originalRender = window.renderInventory;
  if (originalRender) window.renderInventory = function (...args) { const result = originalRender.apply(this, args); mount(); return result; };
  let timer;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(mount, 70); }).observe(document.body, { childList: true, subtree: true });
  mount();
}());
