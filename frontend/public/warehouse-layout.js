/* Product locations are stable level IDs; printed codes may be renamed safely. */
(function () {
  'use strict';
  const state = { data: null, warehouse: 'MAIN', zone: '', rack: '', level: '', size: '80x40', query: '', loading: null };
  const byId = value => document.getElementById(value);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const safeImage = value => {
    const source = String(value || '').trim();
    try {
      const url = new URL(source, location.href);
      return source && (['http:', 'https:'].includes(url.protocol) || /^data:image\/(png|jpe?g|webp|gif|avif);base64,/i.test(source)) ? source : '';
    } catch { return ''; }
  };
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const tr = (english, arabic) => en() ? english : arabic;
  const id = node => String(node?._id || '');
  const parent = node => String(node?.parentId || '');
  const all = () => state.data?.locations || [];
  const find = value => all().find(node => id(node) === String(value || ''));
  const warehouse = value => state.data?.warehouses.find(row => row.code === value);
  const children = (kind, parentId, code = state.warehouse) => all().filter(node => node.kind === kind && node.warehouseCode === code && parent(node) === (parentId || '')).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  const productsInApp = () => typeof products !== 'undefined' && Array.isArray(products) ? products : [];
  const stockInApp = () => typeof inventoryCache !== 'undefined' && Array.isArray(inventoryCache) ? inventoryCache : [];
  const printer = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M7 14h10v7H7zM17 11h.01"/></svg>';
  async function load(force = false) {
    if (state.data && !force) return state.data;
    if (!state.loading || force) state.loading = api('/warehouse-layout', { background: true }).then(data => { state.data = data; return data; }).finally(() => { state.loading = null; });
    return state.loading;
  }
  function path(node) {
    if (!node) return [];
    const result = [node];
    while (result[0]?.parentId) { const ancestor = find(parent(result[0])); if (!ancestor) break; result.unshift(ancestor); }
    return result;
  }
  const segment = node => node.kind === 'zone' ? 'ZONE ' + node.code : node.code;
  function format(locationId) {
    const node = find(locationId);
    return node ? [warehouse(node.warehouseCode)?.name || node.warehouseCode, ...path(node).map(segment)].join(' / ') : '';
  }
  function describe(locationId) {
    const node = find(locationId), route = path(node);
    return node ? { warehouse: warehouse(node.warehouseCode)?.name || node.warehouseCode, warehouseCode: node.warehouseCode,
      zone: route.find(row => row.kind === 'zone')?.code || '', rack: route.find(row => row.kind === 'rack')?.code || '', level: route.find(row => row.kind === 'level')?.code || '' } : null;
  }
  function renderLocationCard(host, product, unitWarehouseCode) {
    if (!host) return;
    host.replaceChildren();
    host.classList.add('wl-location-card');
    const heading = document.createElement('div'); heading.className = 'wl-location-heading';
    const caption = document.createElement('span'); caption.textContent = tr('ASSIGNED PRODUCT LOCATION', 'موقع التخزين المخصص للصنف');
    const name = document.createElement('strong'); name.textContent = product?.name || product?.code || tr('Product', 'الصنف');
    heading.append(caption, name); host.append(heading);
    const location = describe(product?.storageLocationId);
    if (!location) { const empty = document.createElement('p'); empty.className = 'wl-location-empty'; empty.textContent = tr('No storage location has been assigned to this product.', 'لم يُحدد موقع تخزين لهذا الصنف.'); host.append(empty); return; }
    const grid = document.createElement('div'); grid.className = 'wl-location-grid';
    for (const [label, value] of [[tr('Warehouse', 'المخزن'), location.warehouse], [tr('Zone', 'منطقة التخزين'), 'ZONE ' + location.zone], [tr('Rack', 'رف التخزين'), location.rack], [tr('Shelf level', 'مستوى الرف'), location.level]]) {
      const item = document.createElement('div'), key = document.createElement('small'), text = document.createElement('bdi');
      key.textContent = label; text.textContent = value || '—'; text.dir = 'auto'; item.append(key, text); grid.append(item);
    }
    host.append(grid);
    if (unitWarehouseCode && unitWarehouseCode !== location.warehouseCode) {
      const note = document.createElement('p'); note.className = 'wl-location-warning'; note.textContent = tr('The piece is currently recorded in a different warehouse. Check its physical location.', 'القطعة مسجلة حاليًا في مخزن آخر؛ تحقق من موقعها الفعلي.'); host.append(note);
    }
  }
  function nextCode(kind, rows) {
    if (kind === 'zone') { for (let letter = 65; letter <= 90; letter++) if (!rows.some(row => row.code === String.fromCharCode(letter))) return String.fromCharCode(letter); return 'AA'; }
    const prefix = kind === 'rack' ? 'R' : 'S', used = new Set(rows.map(row => row.code));
    for (let n = kind === 'level' ? 2 : 1; n < 1000; n++) { const code = prefix + (kind === 'level' ? String(n).padStart(2, '0') : n); if (!used.has(code)) return code; }
    return '';
  }
  const kindName = kind => kind === 'zone' ? tr('Zone', 'منطقة التخزين') : kind === 'rack' ? tr('Rack', 'رف التخزين') : tr('Shelf level', 'مستوى الرف');
  function list(kind, rows, selected) {
    if (!rows.length) return `<p class="wl-empty">${tr('No locations have been added.', 'لم تُضف مواقع تخزين بعد.')}</p>`;
    return rows.map(row => `<div class="wl-row ${selected === id(row) ? 'is-selected' : ''}"><button type="button" class="wl-select" data-select="${esc(id(row))}" aria-pressed="${selected === id(row)}"><span class="wl-code" dir="ltr">${esc(segment(row))}</span><small>${kindName(kind)}</small></button><div class="wl-row-actions"><button type="button" data-label="${esc(id(row))}" title="${tr('Print location label', 'طباعة ملصق الموقع')}" aria-label="${tr('Print', 'طباعة')} ${esc(segment(row))}">${printer}</button>${isAdmin() ? `<button type="button" data-rename="${esc(id(row))}" title="${tr('Edit code', 'تعديل الرمز')}" aria-label="${tr('Edit', 'تعديل')} ${esc(segment(row))}">✎</button><button type="button" data-delete="${esc(id(row))}" title="${tr('Delete location', 'حذف الموقع')}" aria-label="${tr('Delete', 'حذف')} ${esc(segment(row))}">×</button>` : ''}</div></div>`).join('');
  }
  function panel(kind, number, rows, selected, enabled, parentId) {
    const plural = kind === 'zone' ? tr('Zones', 'مناطق التخزين') : kind === 'rack' ? tr('Racks', 'أرفف التخزين') : tr('Shelf levels', 'مستويات الأرفف');
    const noun = kindName(kind);
    return `<section class="wl-panel"><div class="wl-panel-head"><div><span>${number}</span><h2>${plural}</h2></div><small>${rows.length}</small></div>${enabled ? `<div class="wl-list">${list(kind, rows, selected)}</div>${isAdmin() ? `<form data-add="${kind}" class="wl-add"><label>${tr('Add', 'إضافة')} ${noun}<input name="code" required maxlength="12" pattern="[A-Za-z][A-Za-z0-9-]{0,11}" value="${esc(nextCode(kind, rows))}" aria-label="${tr('Code for', 'رمز')} ${noun}"></label><button type="submit">${tr('Add', 'إضافة')}</button></form>` : ''}` : `<p class="wl-empty">${kind === 'rack' ? tr('Select a zone first.', 'اختر منطقة التخزين أولًا.') : tr('Select a rack first.', 'اختر رف التخزين أولًا.')}</p>`}</section>`;
  }
  function rackMap(racks) {
    if (!racks.length) return `<p class="wl-empty">${tr('Add a rack to see its shelf levels here.', 'أضف رفًا لعرض مستوياته هنا.')}</p>`;
    const bayWidth = 154, rowHeight = 72, startX = 24, startY = 42;
    const rowCount = Math.max(3, ...racks.map(rack => children('level', id(rack)).length));
    const bottom = startY + rowCount * rowHeight, endX = startX + racks.length * bayWidth;
    const width = endX + 26, height = bottom + 48;
    const assigned = new Map();
    productsInApp().forEach(product => { const key = String(product.storageLocationId || ''); assigned.set(key, (assigned.get(key) || 0) + 1); });
    const bays = racks.map((rack, index) => {
      const x = startX + index * bayWidth, levels = children('level', id(rack));
      const slots = Array.from({ length: rowCount }, (_, row) => {
        const level = levels[rowCount - row - 1], y = startY + row * rowHeight + 4;
        if (!level) return `<rect class="wl-bay-empty" x="${x + 9}" y="${y}" width="${bayWidth - 18}" height="${rowHeight - 9}" rx="3"/>`;
        const count = assigned.get(id(level)) || 0;
        return `<g class="wl-bay-slot ${state.level === id(level) ? 'is-active' : ''}" data-select="${esc(id(level))}" role="button" tabindex="0" aria-pressed="${state.level === id(level)}" aria-label="${tr('Select shelf level', 'اختر مستوى الرف')} ${esc(level.code)} ${tr('in rack', 'في الرف')} ${esc(rack.code)}"><rect class="wl-bay-hit" x="${x + 9}" y="${y}" width="${bayWidth - 18}" height="${rowHeight - 9}" rx="3"/><text class="wl-bay-code" x="${x + bayWidth - 25}" y="${y + rowHeight / 2 + 2}" text-anchor="end">${esc(level.code)}</text><circle class="wl-bay-count" cx="${x + 25}" cy="${y + rowHeight / 2 - 3}" r="13"/><text class="wl-bay-count-text" x="${x + 25}" y="${y + rowHeight / 2 + 2}" text-anchor="middle">${count}</text></g>`;
      }).join('');
      const braces = `<path class="wl-rack-brace" d="M${x + 13} ${startY + 5}L${x + bayWidth - 13} ${bottom - 7}M${x + bayWidth - 13} ${startY + 5}L${x + 13} ${bottom - 7}"/>`;
      const beams = Array.from({ length: rowCount }, (_, row) => { const y = startY + (row + 1) * rowHeight - 3; return `<path class="wl-rack-beam" d="M${x + 3} ${y}H${x + bayWidth - 3}L${x + bayWidth + 7} ${y - 7}H${x + 13}Z"/>`; }).join('');
      const rackLabel = `<g class="wl-rack-label ${state.rack === id(rack) ? 'is-active' : ''}" data-select="${esc(id(rack))}" role="button" tabindex="0" aria-pressed="${state.rack === id(rack)}" aria-label="${tr('Select rack', 'اختر الرف')} ${esc(rack.code)}"><rect x="${x + 12}" y="${bottom + 18}" width="${bayWidth - 24}" height="25" rx="5"/><text x="${x + bayWidth / 2}" y="${bottom + 35}" text-anchor="middle">${esc(rack.code)}</text></g>`;
      return `<g>${braces}${slots}${beams}${rackLabel}</g>`;
    }).join('');
    const posts = Array.from({ length: racks.length + 1 }, (_, index) => { const x = startX + index * bayWidth; return `<rect class="wl-rack-post" x="${x - 5}" y="${startY - 17}" width="10" height="${bottom - startY + 31}" rx="2"/><path class="wl-rack-post-line" d="M${x - 2} ${startY - 12}V${bottom + 10}"/>`; }).join('');
    return `<div class="wl-rack-map" role="group" aria-label="${tr('Interactive rack layout', 'مخطط الأرفف التفاعلي')}"><svg class="wl-rack-illustration" viewBox="0 0 ${width} ${height}" style="min-width:${Math.max(270, racks.length * bayWidth + 35)}px" role="group" aria-label="${tr('Rack elevation with selectable shelf levels', 'رسم رفوف التخزين مع مستويات قابلة للاختيار')}"><path class="wl-rack-roof" d="M${startX - 6} ${startY - 17}H${endX + 6}L${endX + 18} ${startY - 29}H${startX + 6}Z"/>${bays}${posts}</svg></div><p class="wl-map-legend">${tr('Numbers inside shelves show assigned product types.', 'الأرقام داخل الرفوف تمثل عدد الأصناف المخصصة.')}</p>`;
  }
  function productList() {
    const query = state.query.trim().toLocaleLowerCase();
    const catalog = productsInApp();
    const stock = new Map(stockInApp().map(row => [String(row.code), Number(row.warehouseBalances?.[state.warehouse] ?? (state.warehouse === 'MAIN' ? row.current : 0)) || 0]));
    const matches = query ? catalog.filter(row => `${row.name || ''} ${row.code || ''}`.toLocaleLowerCase().includes(query)).slice(0, 8) : catalog.filter(row => String(row.storageLocationId || '') === state.level).slice(0, 8);
    const count = query ? catalog.filter(row => `${row.name || ''} ${row.code || ''}`.toLocaleLowerCase().includes(query)).length : catalog.filter(row => String(row.storageLocationId || '') === state.level).length;
    return `<div class="wl-products-head"><div><p class="wl-kicker">${tr('INVENTORY VISIBILITY', 'عرض المخزون')}</p><h2>${query ? tr('Product matches', 'نتائج البحث عن الأصناف') : tr('Products assigned to this level', 'الأصناف المخصصة لهذا المستوى')}</h2></div><strong>${count}</strong></div><label class="wl-search-label" for="wl-product-search">${tr('Find a product or SKU', 'ابحث باسم الصنف أو رمزه')}</label><input id="wl-product-search" type="search" autocomplete="off" placeholder="${tr('Search name or SKU…', 'اسم الصنف أو الرمز…')}" value="${esc(state.query)}"><div class="wl-products-list">${matches.length ? matches.map(row => {
      const location = find(row.storageLocationId), current = stock.get(String(row.code));
      const image = safeImage(row.imageUrl || row.images?.[0]);
      return `<button type="button" class="wl-product-result" data-product-location="${esc(id(location))}" ${location ? '' : 'disabled'}><span class="wl-product-thumb">${image ? `<img src="${esc(image)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">` : '<span aria-hidden="true">▣</span>'}</span><span class="wl-product-result-copy"><strong>${esc(row.name || row.code)}</strong><small dir="ltr">${esc(row.code || '—')}</small></span><span class="wl-product-result-end"><b>${current === undefined ? '—' : esc(current)}</b><small>${tr('Warehouse stock', 'رصيد المخزن')}</small><small>${location ? esc(path(location).map(segment).join(' / ')) : tr('Location not assigned', 'الموقع غير محدد')}</small></span></button>`;
    }).join('') : `<p class="wl-empty">${query ? tr('No matching products.', 'لا توجد أصناف مطابقة.') : tr('No products assigned to this level yet.', 'لم تُخصّص أصناف لهذا المستوى بعد.')}</p>`}</div>${count > 8 ? `<small class="wl-more">${tr('Showing the first 8 results. Refine your search.', 'تظهر أول 8 نتائج. حدّد البحث أكثر.')}</small>` : ''}`;
  }
  function renderBody() {
    const root = byId('page-warehouse-layout'); if (!root || !state.data) return;
    if (!warehouse(state.warehouse)) state.warehouse = state.data.warehouses[0]?.code || '';
    const zones = children('zone', ''); if (!zones.some(node => id(node) === state.zone)) state.zone = id(zones[0]);
    const racks = children('rack', state.zone); if (!racks.some(node => id(node) === state.rack)) state.rack = id(racks[0]);
    const levels = children('level', state.rack); if (!levels.some(node => id(node) === state.level)) state.level = id(levels[0]);
    const selected = find(state.level) || find(state.rack) || find(state.zone);
    const route = path(selected).map(segment).join(' / ');
    root.innerHTML = `<div class="wl" dir="${en() ? 'ltr' : 'rtl'}"><header class="wl-header iu-section-heading"><div><h2>${tr('Warehouse locations', 'مواقع التخزين')}</h2><p>${tr('Choose a zone, rack and shelf level to find a product quickly.', 'اختر منطقة التخزين والرف والمستوى للوصول إلى الصنف بسرعة.')}</p></div><label class="wl-warehouse">${tr('Warehouse', 'المخزن')}<select id="wl-warehouse">${state.data.warehouses.map(row => `<option value="${esc(row.code)}" ${row.code === state.warehouse ? 'selected' : ''}>${esc(row.name)}</option>`).join('')}</select></label></header><nav class="wl-quick-nav" aria-label="${tr('Warehouse operations', 'عمليات المخزن')}"><a href="#inventory">${tr('Inventory', 'المخزون')}</a><a href="#inventory/log">${tr('Stock movements', 'حركات المخزون')}</a><a href="#warehouse-management/units">${tr('Barcode scanning', 'فحص الباركود')}</a><a href="#pickup-orders">${tr('Picking and packing', 'الالتقاط والتغليف')}</a></nav><p class="wl-message" id="wl-message" role="status" aria-live="polite"></p><div class="wl-grid">${panel('zone', '01', zones, state.zone, true)}${panel('rack', '02', racks, state.rack, !!state.zone)}${panel('level', '03', levels, state.level, !!state.rack)}</div><div class="wl-workspace"><section class="wl-map-panel"><div class="wl-map-heading"><div><p class="wl-kicker">${tr('LIVE LOCATION MAP', 'مخطط الموقع المباشر')}</p><h2>${tr('Rack layout', 'مخطط الأرفف')}</h2><p>${tr('Select a shelf level. The highlighted slot is the current location.', 'اختر مستوى الرف؛ الموضع المميز هو الموقع المحدد حاليًا.')}</p></div><span class="wl-zone-chip" dir="ltr">${esc(find(state.zone) ? segment(find(state.zone)) : '—')}</span></div>${rackMap(racks)}</section><section class="wl-inventory-panel">${productList()}</section></div><section class="wl-print"><div><p class="wl-kicker">${tr('LOCATION LABEL', 'ملصق موقع التخزين')}</p><h2>${esc(route || '—')}</h2><p>${tr('Print a clear label for the physical shelf.', 'اطبع ملصقًا واضحًا لتثبيته على موقع التخزين الفعلي.')}</p></div><div class="wl-print-controls"><label>${tr('Label size', 'مقاس الملصق')}<select id="wl-size">${state.data.labelSizes.map(size => `<option value="${esc(size.id)}" ${size.id === state.size ? 'selected' : ''}>${size.widthMm} × ${size.heightMm} mm</option>`).join('')}</select></label><button type="button" class="wl-primary" id="wl-print" ${selected ? '' : 'disabled'}>${printer}${tr('Preview and print', 'معاينة وطباعة')}</button></div></section></div>`;
    bind(root);
  }
  function notice(value, error = false) { const target = byId('wl-message'); if (target) { target.textContent = value; target.dataset.error = String(error); } }
  async function refresh() { await load(true); renderBody(); }
  function editDialog(node, action) {
    if (!node) return;
    let dialog = byId('wl-edit-dialog');
    if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'wl-edit-dialog'; dialog.className = 'wl-dialog'; document.body.appendChild(dialog); }
    if (dialog.open) dialog.close();
    const deleting = action === 'delete', noun = kindName(node.kind);
    dialog.dir = en() ? 'ltr' : 'rtl';
    dialog.innerHTML = `<form method="dialog" class="wl-dialog-form"><header><span class="wl-dialog-eyebrow">SOULIA Warehouse Layout</span><h2 id="wl-dialog-title">${deleting ? tr('Delete', 'حذف') : tr('Edit code for', 'تعديل رمز')} ${noun}</h2><p class="wl-dialog-route" dir="auto">${esc(format(id(node)))}</p></header><div class="wl-dialog-body">${deleting ? `<p>${tr('Delete this location after removing child locations and moving assigned products.', 'احذف المواقع الفرعية وانقل الأصناف المرتبطة بهذا الموقع أولًا.')}</p>` : `<label for="wl-dialog-code">${tr('Location code', 'رمز الموقع')}<input id="wl-dialog-code" name="code" required maxlength="12" pattern="[A-Za-z][A-Za-z0-9-]{0,11}" value="${esc(node.code)}" autocomplete="off" dir="ltr"></label><small>${tr('Product assignments remain linked when the code changes.', 'يبقى ارتباط الأصناف بالموقع عند تغيير رمزه.')}</small>`}<p id="wl-dialog-error" role="alert" hidden></p></div><footer><button type="button" class="wl-dialog-cancel">${tr('Cancel', 'إلغاء')}</button><button type="submit" class="wl-dialog-submit ${deleting ? 'is-danger' : ''}">${deleting ? tr('Delete location', 'حذف الموقع') : tr('Save changes', 'حفظ التعديل')}</button></footer></form>`;
    dialog.setAttribute('aria-labelledby', 'wl-dialog-title');
    dialog.querySelector('.wl-dialog-cancel').onclick = () => dialog.close();
    const input = dialog.querySelector('#wl-dialog-code');
    if (input) input.oninput = () => { input.value = input.value.toUpperCase(); dialog.querySelector('#wl-dialog-error').hidden = true; };
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const code = input?.value.trim().toUpperCase();
      if (!deleting && code === node.code) { dialog.close(); return; }
      if (!deleting && !input.checkValidity()) { input.reportValidity(); return; }
      const submit = dialog.querySelector('.wl-dialog-submit'), cancel = dialog.querySelector('.wl-dialog-cancel'); submit.disabled = cancel.disabled = true;
      try { await api('/warehouse-layout/' + id(node), deleting ? { method: 'DELETE' } : { method: 'PATCH', body: JSON.stringify({ code }) }); await refresh(); dialog.close(); }
      catch (error) { const message = dialog.querySelector('#wl-dialog-error'); message.textContent = error.message || tr('Could not save the change.', 'تعذر حفظ التعديل.'); message.hidden = false; }
      finally { submit.disabled = cancel.disabled = false; }
    };
    dialog.showModal(); if (input) { input.focus(); input.select(); }
  }
  function bind(root) {
    byId('wl-warehouse').onchange = event => { state.warehouse = event.target.value; state.zone = state.rack = state.level = ''; renderBody(); };
    byId('wl-size').onchange = event => { state.size = event.target.value; };
    byId('wl-print').onclick = () => print(find(state.level) || find(state.rack) || find(state.zone));
    root.querySelectorAll('[data-select]').forEach(button => {
      button.onclick = () => { const node = find(button.dataset.select); if (!node) return; if (node.kind === 'zone') { state.zone = id(node); state.rack = state.level = ''; } else if (node.kind === 'rack') { state.rack = id(node); state.level = ''; } else state.level = id(node); renderBody(); };
      if (button.tagName.toLowerCase() === 'g') button.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); } };
    });
    root.querySelectorAll('[data-label]').forEach(button => button.onclick = () => print(find(button.dataset.label)));
    root.querySelectorAll('[data-rename]').forEach(button => button.onclick = () => editDialog(find(button.dataset.rename), 'rename'));
    root.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => editDialog(find(button.dataset.delete), 'delete'));
    root.querySelectorAll('[data-product-location]').forEach(button => button.onclick = () => { const node = find(button.dataset.productLocation); if (!node) return; const route = path(node); state.warehouse = node.warehouseCode; state.zone = id(route.find(row => row.kind === 'zone')); state.rack = id(route.find(row => row.kind === 'rack')); state.level = id(node); state.query = ''; renderBody(); root.querySelector('.wl-map-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    byId('wl-product-search').oninput = event => { const position = event.target.selectionStart; state.query = event.target.value; renderBody(); const field = byId('wl-product-search'); field.focus(); field.setSelectionRange(position, position); };
    root.querySelectorAll('[data-add]').forEach(form => form.onsubmit = async event => { event.preventDefault(); const kind = form.dataset.add, code = form.elements.code.value.trim().toUpperCase(); if (!code) return; const button = form.querySelector('button'); button.disabled = true; try { const node = await api('/warehouse-layout', { method: 'POST', body: JSON.stringify({ kind, code, warehouseCode: state.warehouse, ...(kind === 'zone' ? {} : { parentId: kind === 'rack' ? state.zone : state.rack }) }) }); if (kind === 'zone') { state.zone = id(node); state.rack = state.level = ''; } else if (kind === 'rack') { state.rack = id(node); state.level = ''; } else state.level = id(node); await refresh(); } catch (error) { notice(error.message, true); button.disabled = false; } });
  }
  async function render() {
    const root = byId('page-warehouse-layout'); if (!root) return;
    if (state.data) renderBody();
    else root.innerHTML = `<div class="wl wl-loading">${tr('Loading warehouse locations…', 'جارٍ تحميل مواقع التخزين…')}</div>`;
    try {
      await load(true);
      if (root.isConnected && byId('page-warehouse-layout') === root) renderBody();
    } catch (error) {
      if (!root.isConnected || byId('page-warehouse-layout') !== root) return;
      if (state.data) notice(error.message, true);
      else root.innerHTML = `<div class="wl wl-error" role="alert">${esc(error.message)}</div>`;
    }
  }
  function print(node) {
    if (!node) return;
    const size = state.data?.labelSizes.find(row => row.id === state.size); if (!size) return;
    const segments = path(node);
    const target = segment(node);
    const context = segments.slice(0, -1).map(segment).join(' / ');
    const targetType = kindName(node.kind);
    const compact = size.heightMm <= 30;
    let targetSizePt = Math.floor(size.heightMm * 1.42);
    const canvas = document.createElement('canvas'), measure = canvas.getContext('2d');
    if (measure) {
      measure.font = `900 ${targetSizePt}pt Arial`;
      const availablePx = (size.widthMm - 6) * 96 / 25.4;
      const textPx = measure.measureText(target).width;
      if (textPx > availablePx) targetSizePt = Math.max(9, Math.floor(targetSizePt * availablePx / textPx));
    }
    const popup = window.open('', '_blank', 'width=780,height=680'); if (!popup) { notice(tr('Allow the print window to open.', 'اسمح بفتح نافذة الطباعة.'), true); return; }
    const css = `@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;width:${size.widthMm}mm;height:${size.heightMm}mm;font-family:Arial,Tahoma,sans-serif;color:#2d7a4f;background:#fff}.sign{width:100%;height:100%;border:1px solid #2d7a4f;padding:${compact ? '1.5mm 2mm' : '2mm 2.5mm'};display:grid;grid-template-rows:auto minmax(0,1fr) auto;align-items:center;gap:.5mm;text-align:center;overflow:hidden}.meta{width:100%;display:flex;align-items:center;justify-content:space-between;gap:2mm;color:#446256;font-size:${compact ? 6 : 8}pt;line-height:1.1}.brand{font-weight:800;letter-spacing:.08em;white-space:nowrap}.type{font-weight:600;white-space:nowrap}.target{display:block;max-width:100%;min-width:0;justify-self:center;align-self:center;font-family:Arial,Tahoma,sans-serif;font-size:${targetSizePt}pt;line-height:.96;font-weight:900;letter-spacing:-.035em;white-space:nowrap}.context{display:flex;align-items:center;justify-content:center;gap:1.2mm;width:100%;min-width:0;color:#496558;font-size:${compact ? 7 : 10}pt;font-weight:500;line-height:1.1;white-space:nowrap}.context span{min-width:0;overflow:hidden;text-overflow:ellipsis}.context span+span:before{content:'·';padding-inline-end:1.2mm;color:#869b8e}@media print{.sign{border:0}}`;
    popup.document.open(); popup.document.write(`<!doctype html><html lang="${en() ? 'en' : 'ar'}"><head><meta charset="utf-8"><title>SOULIA · ${esc(segments.map(row => row.code).join(' / '))}</title><style>${css}</style></head><body><div class="sign" data-target-kind="${esc(node.kind)}"><div class="meta"><span class="brand">SOULIA HOME</span><span class="type">${esc(targetType)}</span></div><strong class="target" dir="ltr">${esc(target)}</strong><div class="context"><span dir="auto">${esc(warehouse(node.warehouseCode)?.name || node.warehouseCode)}</span>${context ? `<span dir="ltr">${esc(context)}</span>` : ''}</div></div></body></html>`); popup.document.close(); popup.focus(); setTimeout(() => popup.print(), 250);
  }
  function productFields() {
    return `<section class="pm-section wl-product" data-ready="false"><div class="pm-section-title">${tr('Storage location', 'موقع تخزين الصنف')}</div><p class="wl-product-note">${tr('Assign the warehouse, zone, rack and shelf level for this product.', 'حدد المخزن ومنطقة التخزين والرف والمستوى المخصص لهذا الصنف.')}</p><div class="pm-grid pm-grid-3"><div class="pm-field"><label for="pm-storage-warehouse">${tr('Warehouse', 'المخزن')}</label><select id="pm-storage-warehouse"><option value="">${tr('No location assigned', 'الموقع غير محدد')}</option></select></div><div class="pm-field"><label for="pm-storage-zone">${tr('Zone', 'منطقة التخزين')}</label><select id="pm-storage-zone" disabled><option value="">${tr('Select a zone', 'اختر منطقة التخزين')}</option></select></div><div class="pm-field"><label for="pm-storage-rack">${tr('Rack', 'رف التخزين')}</label><select id="pm-storage-rack" disabled><option value="">${tr('Select a rack', 'اختر رف التخزين')}</option></select></div><div class="pm-field"><label for="pm-storage-level">${tr('Shelf level', 'مستوى الرف')}</label><select id="pm-storage-level" disabled><option value="">${tr('Select a level', 'اختر مستوى الرف')}</option></select></div></div><div id="pm-storage-balances" class="wl-product-balances" hidden></div><small id="pm-storage-path" class="wl-product-path"></small><a class="wl-product-link" href="#warehouse-management/layout" onclick="closeModal()">${tr('Manage warehouse locations', 'إدارة مواقع التخزين')}</a></section>`;
  }
  async function mountProduct(product) {
    const level = byId('pm-storage-level'); if (!level) return;
    try {
      await load(); if (!level.isConnected) return;
      const pendingLocation = product?.editRequest?.status === 'معلق'
        ? product.editRequest.changes?.find(change => change.field === 'storageLocationId') : null;
      const selectedLocationId = pendingLocation ? pendingLocation.newValue : product?.storageLocationId;
      const existing = find(selectedLocationId), route = path(existing), wh = byId('pm-storage-warehouse'), zone = byId('pm-storage-zone'), rack = byId('pm-storage-rack');
      if (pendingLocation) {
        const note = level.closest('.wl-product')?.querySelector('.wl-product-note');
        if (note) note.textContent = tr('This location change is awaiting manager approval. The current location remains active until approval.', 'تغيير موقع التخزين بانتظار موافقة المدير. يظل الموقع الحالي معتمدًا حتى الموافقة.');
      }
      const balancesHost = byId('pm-storage-balances');
      let balanceRow = null, balancesLoaded = false;
      function renderBalances() {
        if (!balancesHost || !product?._id) return;
        balancesHost.hidden = false;
        const amounts = state.data.warehouses.map(row => `<span class="wl-product-balance${row.code === wh.value ? ' is-selected' : ''}"><span>${esc(row.name)}</span><strong dir="ltr">${balancesLoaded ? balanceRow ? esc(Number(balanceRow.warehouseBalances?.[row.code] || 0)) : '0' : '—'}</strong></span>`).join('');
        balancesHost.innerHTML = `<div class="wl-product-balances-title">${tr('Product stock by warehouse', 'رصيد الصنف حسب المخزن')}</div><div class="wl-product-balances-grid">${amounts}</div><small>${tr('Purchased quantities are recorded in the receiving warehouse selected on the invoice.', 'تُسجّل الكميات المشتراة في مخزن الاستلام المحدد بفاتورة الشراء.')}</small>`;
      }
      wh.innerHTML = `<option value="">${tr('No location assigned', 'الموقع غير محدد')}</option>` + state.data.warehouses.map(row => `<option value="${esc(row.code)}">${esc(row.name)}</option>`).join('');
      wh.value = existing?.warehouseCode || '';
      function options(select, rows, placeholder) { const value = select.value; select.innerHTML = `<option value="">${placeholder}</option>` + rows.map(row => `<option value="${esc(id(row))}">${esc(segment(row))}</option>`).join(''); select.disabled = !rows.length; if (rows.some(row => id(row) === value)) select.value = value; }
      function update() { options(zone, children('zone', '', wh.value), tr('Select a zone', 'اختر منطقة التخزين')); options(rack, children('rack', zone.value, wh.value), tr('Select a rack', 'اختر رف التخزين')); options(level, children('level', rack.value, wh.value), tr('Select a level', 'اختر مستوى الرف')); byId('pm-storage-path').textContent = level.value ? `${tr('Assigned location', 'الموقع المخصص')}: ${format(level.value)}` : ''; renderBalances(); }
      options(zone, children('zone', '', wh.value), tr('Select a zone', 'اختر منطقة التخزين')); zone.value = id(route.find(row => row.kind === 'zone'));
      options(rack, children('rack', zone.value, wh.value), tr('Select a rack', 'اختر رف التخزين')); rack.value = id(route.find(row => row.kind === 'rack'));
      options(level, children('level', rack.value, wh.value), tr('Select a level', 'اختر مستوى الرف')); level.value = id(existing);
      wh.onchange = () => { zone.value = rack.value = level.value = ''; update(); };
      zone.onchange = () => { rack.value = level.value = ''; update(); };
      rack.onchange = () => { level.value = ''; update(); };
      level.onchange = update; update(); level.closest('.wl-product').dataset.ready = 'true';
      if (product?._id) void api('/transactions/inventory', { background: true }).then(rows => {
        if (!balancesHost?.isConnected) return;
        balanceRow = Array.isArray(rows) ? rows.find(row => String(row._id) === String(product._id) || row.code === product.code) : null;
        balancesLoaded = true; renderBalances();
      }).catch(() => { if (balancesHost?.isConnected) balancesHost.querySelector('small').textContent = tr('Warehouse balances could not be loaded.', 'تعذر تحميل أرصدة المخازن.'); });
    } catch (error) { const hint = byId('pm-storage-path'); if (hint) hint.textContent = error.message; }
  }
  window.SouliaWarehouseLayout = { render, productFields, mountProduct, load, format, describe, renderLocationCard };
  if (typeof currentPage !== 'undefined' && currentPage === 'products') load().then(() => renderProducts()).catch(() => {});
}());
