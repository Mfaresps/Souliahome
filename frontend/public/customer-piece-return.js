(function () {
  'use strict';
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let dialog, context, serial = 0;
  const can = () => typeof hasPerm === 'function' && hasPerm('inventory-units-view') && hasPerm('inventory-units-condition');
  function storageKey(id) {
    const user = typeof currentUser === 'undefined' ? null : currentUser;
    return 'customer-piece-return:' + String(user?._id || user?.id || user?.userId || user?.username || '') + ':' + id;
  }
  function saved(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
  function save(key, dto) { try { if (dto) sessionStorage.setItem(key, JSON.stringify(dto)); else sessionStorage.removeItem(key); } catch { /* The in-memory request remains retryable. */ } }
  function message(text, success) { const el = dialog.querySelector('[data-cpr-message]'); el.textContent = text; el.className = success ? 'cpr-message is-success' : 'cpr-message'; }
  async function load() {
    const active = context;
    const result = await api('/inventory-units/orders/' + encodeURIComponent(active.id) + '/return-pieces', { background: true });
    if (context !== active || !dialog.open) return;
    if (!Array.isArray(result?.pieces)) throw new Error(tr('Could not load pieces.', 'تعذر تحميل القطع.'));
    active.pieces = result.pieces;
    dialog.querySelector('[data-cpr-warehouse]').textContent = tr('Receipt warehouse: ', 'مخزن الاستلام: ') + (window.SouliaWarehouses?.name(result.warehouseCode) || result.warehouseCode);
    dialog.querySelector('[data-cpr-list]').innerHTML = result.pieces.map(piece => `<label class="cpr-piece"><input type="radio" name="returnPiece" value="${esc(piece.unitId)}"><span><strong dir="auto">${esc(piece.name)}</strong><small dir="ltr">${esc(piece.sku)}</small><code dir="ltr">${esc(piece.manualCode || piece.barcode)}</code></span><small>${piece.received ? tr('Received · awaiting review', 'مستلمة · بانتظار المراجعة') : tr('In original shipment', 'ضمن الشحنة الأصلية')}</small></label>`).join('') || `<p>${tr('No outstanding identified pieces. Previously received pieces cannot be received again.', 'لا توجد قطع محددة الهوية بانتظار الاستلام. القطع المستلمة لا يمكن استلامها مرة أخرى.')}</p>`;
    update();
  }
  function update() {
    if (!context) return;
    const pending = !!context.pending, busy = context.busy;
    dialog.querySelectorAll('input,select,textarea').forEach(el => { el.disabled = pending || busy; });
    const submit = dialog.querySelector('[data-cpr-submit]');
    submit.disabled = busy || (!pending && (!dialog.querySelector('input[name="returnPiece"]:checked') || !dialog.querySelector('[data-cpr-custody]').checked));
    submit.textContent = pending ? tr('Check / retry receipt', 'التحقق وإعادة محاولة الاستلام') : tr('Confirm receipt', 'تأكيد الاستلام');
  }
  async function submit(event) {
    event.preventDefault();
    const active = context;
    if (!active || active.busy || !can()) return;
    const piece = active.pieces.find(p => p.unitId === dialog.querySelector('input[name="returnPiece"]:checked')?.value);
    if (!active.pending) {
      if (!piece || !dialog.querySelector('[data-cpr-custody]').checked) return;
      active.pending = { operationKey: 'return-piece:' + (window.crypto?.randomUUID?.() || Date.now() + ':' + ++serial),
        reason: dialog.querySelector('[data-cpr-note]').value.trim() || tr('Physical receipt without label', 'استلام فعلي بدون ملصق'),
        unitId: piece.unitId, expectedVersion: piece.expectedVersion,
        condition: dialog.querySelector('[data-cpr-condition]').value, physicalPossessionConfirmed: true };
      save(active.key, active.pending);
    }
    active.busy = true; update();
    try {
      const result = await api('/inventory-units/orders/' + encodeURIComponent(active.id) + '/return-pieces', {
        method: 'POST', body: JSON.stringify(active.pending), background: true });
      const identifier = result?.unit?.barcode;
      if (!identifier) throw new Error(tr('Could not verify receipt. Retry the same request.', 'تعذر التحقق من الاستلام. أعد محاولة نفس الطلب.'));
      save(active.key, null); active.pending = null;
      window.InvoiceUnitIdentities?.changed(active.id);
      if (context !== active || !dialog.open) return;
      await load();
      dialog.querySelector('[data-cpr-custody]').checked = false;
      const text = result.pendingSettlement ? tr('Received. Complete the customer return or failed-delivery settlement, then approve this piece for sale.', 'تم الاستلام. أكمل تسوية المرتجع أو فشل التوصيل، ثم اعتمد القطعة للبيع.') : result.unit.status === 'available' ? tr('Received and available for sale with the same identity.', 'تم الاستلام والقطعة متاحة للبيع بنفس الهوية.') : result.unit.status === 'damaged' ? tr('Received as damaged. Blocked from preparation.', 'تم الاستلام كقطعة تالفة، وهي غير متاحة للتحضير.') : tr('Received for review. Not available for sale yet.', 'تم الاستلام للمراجعة. القطعة غير متاحة للبيع حاليًا.');
      message(text, true);
      const print = dialog.querySelector('[data-cpr-print]'); print.hidden = false;
      print.onclick = () => { dialog.close(); window.InventoryUnitLabels?.openStockUnits({ identifier, preview: true }); };
    } catch (error) {
      if (Number(error.status) >= 400 && Number(error.status) < 500 && ![408, 429].includes(Number(error.status))) { save(active.key, null); active.pending = null; }
      if (context === active && dialog.open) message(active.pending ? tr('Receipt could not be confirmed. Retry to check the same operation safely.', 'لم يتأكد الاستلام. أعد المحاولة للتحقق من نفس العملية دون تكرارها.') : (window.InventoryErrors?.translate?.(error) || error.message));
    } finally { active.busy = false; if (context === active) update(); }
  }
  async function open(id) {
    if (!can()) return;
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'ivi-dialog cpr-dialog'; document.body.appendChild(dialog);
      dialog.addEventListener('close', () => { context = null; });
    }
    const key = storageKey(id); context = { id, key, pieces: [], pending: saved(key), busy: false };
    dialog.dir = tr('ltr', 'rtl');
    dialog.innerHTML = `<header class="ivi-dialog-header"><h2 id="cpr-title">${tr('Receive return without label', 'استلام مرتجع بدون ملصق')}</h2><button type="button" data-cpr-close aria-label="${tr('Close', 'إغلاق')}">×</button></header><form class="cpr-form"><div class="ivi-dialog-body"><p class="cpr-intro">${tr('Select the exact piece from the original shipment. Its identity will be kept.', 'اختر القطعة نفسها من الشحنة الأصلية. ستحتفظ بنفس هويتها.')}</p><p class="cpr-help">${tr('Cannot distinguish identical pieces? Keep them aside for review; do not guess an identity.', 'لو القطع متطابقة ولا تستطيع تحديد هويتها، احتفظ بها جانبًا للمراجعة ولا تخمّن الكود.')}</p><small data-cpr-warehouse></small><div data-cpr-list aria-live="polite"></div><label class="cpr-field">${tr('Piece condition', 'حالة القطعة')}<select data-cpr-condition><option value="review">${tr('Needs review', 'تحتاج مراجعة')}</option><option value="sound">${tr('Inspected and sound', 'تم فحصها وهي سليمة')}</option><option value="damaged">${tr('Damaged', 'تالفة')}</option></select></label><label class="cpr-field">${tr('Note (optional)', 'ملاحظة (اختياري)')}<textarea data-cpr-note maxlength="1000" rows="2"></textarea></label><label class="cpr-custody"><input type="checkbox" data-cpr-custody><span>${tr('I physically received and identified this exact piece.', 'استلمت هذه القطعة فعليًا وتأكدت من هويتها.')}</span></label><p class="cpr-message" data-cpr-message role="status"></p></div><footer class="cpr-footer"><button type="submit" data-cpr-submit disabled>${tr('Confirm receipt', 'تأكيد الاستلام')}</button><button type="button" data-cpr-print hidden>${tr('Reprint same identity', 'طباعة نفس الهوية')}</button><button type="button" data-cpr-refresh>${tr('Refresh', 'تحديث')}</button></footer></form>`;
    dialog.setAttribute('aria-labelledby', 'cpr-title');
    dialog.querySelector('form').onsubmit = submit;
    dialog.querySelector('[data-cpr-close]').onclick = () => { if (!context?.busy) dialog.close(); };
    dialog.oncancel = event => { if (context?.busy) event.preventDefault(); };
    dialog.querySelector('form').onchange = update;
    dialog.querySelector('[data-cpr-refresh]').onclick = () => { if (!context?.busy) load().catch(error => message(error.message)); };
    if (!dialog.open) dialog.showModal();
    if (context.pending) message(tr('An earlier receipt is unconfirmed. Retry the same operation before continuing.', 'هناك استلام سابق غير مؤكد. أعد محاولة نفس العملية قبل المتابعة.'));
    try { await load(); } catch (error) { message(error.message); }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-customer-piece-return]');
    if (button) { event.preventDefault(); event.stopPropagation(); void open(button.dataset.customerPieceReturn); }
  });
  window.CustomerPieceReturn = { open };
})();
