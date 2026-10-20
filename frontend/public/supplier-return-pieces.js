(function () {
  'use strict';
  const tr = (en, ar) => currentLang === 'en' ? en : ar;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let queue = Promise.resolve();
  function reasonText(value) {
    const reasons = { 'تلف المنتج': 'Damaged product', 'منتج خاطئ': 'Wrong product', 'مشكلة جودة': 'Quality issue', 'أخرى': 'Other' };
    return currentLang === 'en' ? reasons[value] || value || '—' : value || '—';
  }
  function returnMessage(info, pending) {
    const label = pending ? tr('Reserved for supplier return', 'محجوزة لمرتجع مورد') : tr('Returned to supplier', 'مرتجعة للمورد');
    return [label, info?.returnNumber, info?.reason && reasonText(info.reason), info?.reasonDetails].filter(Boolean).join(' · ');
  }
  function validate() {
    if (!srWizard) return '';
    if (srWizard.pieceScansPending) return tr('Wait for the current piece scans to finish.', 'انتظر اكتمال التحقق من القطع الممسوحة.');
    for (const product of srWizard.products.filter(row => row.qty > 0)) {
      if ((product.units || []).length !== product.qty) return tr(`${product.name}: scan ${product.qty} individual pieces (${(product.units || []).length} linked).`, `${product.name}: امسح ${product.qty} قطعة منفصلة (المرتبط حاليًا ${(product.units || []).length}).`);
    }
    return '';
  }
  function feedback(text, error = false) {
    const el = document.getElementById('sr-piece-feedback'); if (!el) return;
    el.textContent = text; el.dataset.error = String(error);
  }
  function list() {
    const host = document.getElementById('sr-piece-list'); if (!host || !srWizard) return;
    host.innerHTML = srWizard.products.filter(p => p.qty > 0).map(p => `<article><div class="sr-piece-line"><strong>${esc(p.name)}</strong><bdi>${(p.units || []).length} / ${p.qty}</bdi></div><div class="sr-piece-tags">${(p.units || []).map(unit => `<span><bdi>${esc(unit.manualCode || unit.barcode)}</bdi><button type="button" data-sr-remove="${esc(unit.unitId)}" aria-label="${tr('Remove piece','إزالة القطعة')}">×</button></span>`).join('') || `<small>${tr('Scan or enter each piece code','امسح كود كل قطعة أو أدخله يدويًا')}</small>`}</div></article>`).join('');
    host.querySelectorAll('[data-sr-remove]').forEach(button => { button.onclick = () => {
      for (const p of srWizard.products) {
        p.units = (p.units || []).filter(unit => unit.unitId !== button.dataset.srRemove);
        if (p.autoScanQuantity) p.qty = p.units.length;
      }
      srWizard.products = srWizard.products.filter(p => !p.autoScanQuantity || p.qty > 0);
      _srwRenderProductRows(); list();
    }; });
  }
  async function process(value, wizard) {
    if (srWizard !== wizard || !document.getElementById('sr-piece-scan')) return;
    try {
      const data = await api('/supplier-returns/pieces/' + encodeURIComponent(window.BarcodeInput?.normalize(value) ?? value) + '?' + new URLSearchParams({ supplierId: wizard.supplier._id }), { background: true });
      if (srWizard !== wizard) return;
      const unit = data.unit, id = String(unit._id || unit.unitId);
      if (wizard.products.some(p => (p.units || []).some(row => row.unitId === id))) throw new Error(tr('This piece is already selected. Scan another piece.', 'هذه القطعة محددة بالفعل. امسح قطعة أخرى.'));
      if (unit.status === 'returned-to-supplier' || (unit.status === 'supplier-return-pending' && unit.supplierReturnId !== wizard.editingId)) throw new Error(returnMessage(data.supplierReturn, unit.status === 'supplier-return-pending'));
      if (unit.assignment || unit.packId || (!['available','inspection-required','returned','damaged'].includes(unit.status) && unit.supplierReturnId !== wizard.editingId)) throw new Error(tr('The piece is assigned, in a sealed pack, or unavailable. Release it or open its pack first.', 'القطعة مرتبطة بطلب أو داخل باك مغلق أو غير متاحة. حررها أو افتح الباك أولًا.'));
      const location = unit.warehouseCode || 'MAIN';
      if (location !== (wizard.warehouseCode || 'MAIN')) throw new Error(tr('This piece belongs to another warehouse. Select its warehouse first.', 'القطعة من مخزن آخر. اختر مخزنها أولًا.'));
      const code = data.product?.code;
      let p = wizard.products.find(p => p.code === code);
      if (!p) {
        if (wizard.linkingOnly) throw new Error(tr('This product is not included in this return.', 'هذا المنتج ليس ضمن المرتجع.'));
        const candidate = (wizard._candidates || []).find(p => p.code === code);
        if (!candidate) throw new Error(tr('This product is not available to return to this supplier.', 'المنتج غير متاح للإرجاع لهذا المورد.'));
        p = { code, name: candidate.name, image: candidate.image, available: candidate.available, cost: 0, qty: 0, note: '', purchaseLines: [], units: [], autoScanQuantity: true };
        wizard.products.push(p);
      }
      p.units ||= [];
      if (p.autoScanQuantity && p.units.length >= p.available) throw new Error(tr('The returnable quantity is complete.', 'اكتملت الكمية المتاحة للإرجاع.'));
      if (!p.autoScanQuantity && p.units.length >= p.qty) throw new Error(tr('This product quantity is complete. Increase its return quantity if needed.', 'اكتملت كمية الصنف. زِد كمية المرتجع إذا كنت تحتاج قطعة إضافية.'));
      p.units.push({ unitId: id, barcode: unit.barcode, manualCode: unit.manualCode || '', warehouseCode: location });
      if (p.autoScanQuantity) p.qty = p.units.length;
      _srwRenderProductRows(); list();
      feedback(tr('✓ Piece added: ', '✓ تمت إضافة القطعة: ') + (unit.manualCode || unit.barcode));
    } catch (error) { if (srWizard === wizard) feedback(error.message, true); }
  }
  function render() {
    const host = document.getElementById('srw-piece-picker'); if (!host || !srWizard) return;
    const wizard = srWizard;
    host.innerHTML = `<section class="sr-piece-picker"><div class="sr-piece-heading"><strong>${tr('Returned piece identities','هويات القطع المرتجعة')}</strong><small>${tr('Scan the barcode or enter the short piece code','امسح الباركود أو أدخل كود القطعة القصير')}</small></div><label>${tr('Return warehouse','مخزن المرتجع')}<select id="sr-piece-warehouse" data-warehouse-select>${window.SouliaWarehouses?.options(wizard.warehouseCode || 'MAIN') || '<option value="MAIN">المخزن الرئيسي</option>'}</select></label><div class="sr-piece-entry"><input id="sr-piece-scan" data-supplier-return-scan dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="U-0000-0001-8"><button type="button" class="btn btn-primary" id="sr-piece-add">${tr('Add piece','إضافة قطعة')}</button></div><p id="sr-piece-feedback" role="status" aria-live="polite"></p><div id="sr-piece-list"></div><small>${tr('Selected pieces are held for this return after saving. Stock and accounts change only on completion.', 'بعد الحفظ تُحجز القطع لهذا المرتجع. يتغير المخزون والحسابات عند الإتمام فقط.')}</small></section>`;
    function scan() {
      const input = document.getElementById('sr-piece-scan'), value = input.value.trim(); if (!value) { input.focus(); return; }
      input.value = ''; input.focus();
      wizard.pieceScansPending = (wizard.pieceScansPending || 0) + 1;
      queue = queue.catch(() => {}).then(() => process(value, wizard)).finally(() => { wizard.pieceScansPending = Math.max(0, wizard.pieceScansPending - 1); });
    }
    document.getElementById('sr-piece-add').onclick = scan;
    document.getElementById('sr-piece-scan').onkeydown = event => { if (['Enter','Tab'].includes(event.key)) { event.preventDefault(); scan(); } };
    document.getElementById('sr-piece-warehouse').onchange = event => {
      wizard.warehouseCode = event.target.value;
      for (const p of wizard.products) p.units = [];
      list(); feedback(tr('Warehouse changed. Scan the pieces in this warehouse.', 'تم تغيير المخزن. امسح القطع الموجودة في المخزن المختار.'));
    };
    list();
  }
  function history(record) {
    return `<section class="sr-piece-history"><h4>${tr('Returned piece identities','هويات القطع المرتجعة')}</h4>${(record.items || []).map(item => `<article><strong>${esc(item.name || item.code)}</strong><div class="sr-piece-tags">${(item.units || []).map(unit => `<bdi>${esc(unit.manualCode || unit.barcode)}</bdi>`).join('') || `<small>${tr('No identities recorded for this historical return','لا توجد هويات مسجلة لهذا المرتجع القديم')}</small>`}</div></article>`).join('')}<p>${esc(reasonText(record.reason))}${record.reasonDetails ? ' · ' + esc(record.reasonDetails) : ''}</p></section>`;
  }
  function openLinking(record, onLinked) {
    _srwReset(record); srWizard.supplier = suppliers.find(s => s._id === record.supplierId);
    srWizard.reason = record.reason; srWizard.reasonDetails = record.reasonDetails || ''; srWizard.warehouseCode = record.warehouseCode || 'MAIN';
    srWizard.linkingOnly = true; srWizard.step = 2;
    srWizard.afterPieceLink = onLinked;
    srWizard.products = (record.items || []).map(item => ({ ...item, available: item.qty, units: (item.units || []).map(unit => ({ ...unit })), purchaseLines: [] }));
    _srwOpenModal();
  }
  async function saveLinks() {
    const err = validate(); if (err) { toast(err, true); return; }
    const wizard = srWizard, button = document.getElementById('srw-next-btn'); if (button) button.disabled = true;
    try {
      const result = await api('/supplier-returns/' + wizard.editingId + '/pieces', { method:'PUT', body:JSON.stringify({ warehouseCode: wizard.warehouseCode,
        items: wizard.products.map(p => ({ code:p.code, qty:p.qty, unitIds:(p.units || []).map(unit => unit.unitId) })) }) });
      const index = supplierReturns.findIndex(r => r._id === result._id); if (index >= 0) supplierReturns[index] = result;
      closeModal(); srWizard = null;
      if (wizard.afterPieceLink) await wizard.afterPieceLink(result._id); else await completeSupplierReturn(result._id);
    } catch(error) { toast(error.message,true); }
    finally { if (button) button.disabled = false; }
  }
  window.SupplierReturnPieces = { render, list, validate, history, openLinking, saveLinks, reasonText, returnMessage };
})();
