(function () {
  'use strict';
  const tr = (en, ar) => currentLang === 'en' ? en : ar;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let context;
  async function load(id) {
    id = String(id);
    const host = document.getElementById('fd-identities');
    const active = context = { id, host, ready: false, pieces: [], busy: false };
    if (host) host.textContent = tr('Loading piece identities…', 'جارٍ تحميل هويات القطع…');
    try {
      const data = await api('/transactions/' + encodeURIComponent(id) + '/failed-delivery/identities', { background: true });
      if (context !== active || host && !host.isConnected) return;
      if (!Array.isArray(data.receiptIdentities)) throw new Error(tr('Update the backend to review identities.', 'حدّث الباك إند لمراجعة الهويات.'));
      active.pieces = data.receiptIdentities;
      if (!active.pieces.length) {
        if (host) host.textContent = tr('Shipped without piece identities — return to stock without labels or printing.', 'اتشحن بدون هويات قطع — يرجع للمخزن بدون توثيق هوية أو طباعة.');
        active.ready = true;
        return;
      }
      if (!host) throw new Error(tr('Reopen this window to review the identities linked to this order.', 'أعد فتح النافذة لمراجعة الهويات المرتبطة بهذا الطلب.'));
      host.innerHTML = active.pieces.length ? `<p>${tr('Confirm physical receipt. Is each identity label still readable?', 'أكد استلام القطع فعليًا. هل ملصق هوية كل قطعة ما زال واضحًا؟')}</p>
        <label>${tr('Label size', 'مقاس الملصق')} <select data-fdi-size>${['50x30','60x40','80x50','100x70'].map(size => `<option value="${size}">${size} mm</option>`).join('')}</select></label>` + active.pieces.map((piece, i) => `
        <div class="fd-block" data-fdi-piece="${i}"><code dir="ltr">${esc(piece.manualCode || piece.barcode)}</code>
        <select class="fd-note" aria-label="${tr('Identity label condition', 'حالة ملصق الهوية')}" data-fdi-state>
          <option value="">${tr('Choose label condition', 'اختر حالة الهوية')}</option>
          <option value="intact">${tr('Present and readable', 'موجودة وواضحة')}</option>
          <option value="reprinted">${tr('Obscured / missing — reprint same identity', 'مطموسة أو مفقودة — طباعة نفس الهوية')}</option></select>
        <button type="button" class="btn" data-fdi-print hidden>${tr('Print same identity', 'طباعة نفس الهوية')}</button>
        <label style="display:block;margin-top:8px"><input type="checkbox" data-fdi-attached> ${tr('I received this exact piece and verified / attached its readable identity label.', 'استلمت هذه القطعة وتأكدت من هويتها ولصقت الملصق الواضح عليها.')}</label></div>`).join('') : '';
      host.querySelectorAll('[data-fdi-piece]').forEach(row => {
        const piece = active.pieces[Number(row.dataset.fdiPiece)], select = row.querySelector('select'), button = row.querySelector('button');
        select.onchange = () => { button.hidden = select.value !== 'reprinted'; row.querySelector('input').checked = false; };
        button.onclick = () => print(active, piece, button);
      });
      active.ready = true;
    } catch (error) {
      if (context !== active || host && !host.isConnected) return;
      active.error = error.message;
      if (!host) return;
      host.textContent = error.message + ' ';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.textContent = tr('Retry', 'إعادة المحاولة');
      retry.onclick = () => load(id); host.appendChild(retry);
    }
  }
  function collect(id) {
    if (context?.id === String(id) && context.error) throw new Error(context.error);
    if (!context || context.id !== String(id) || !context.ready || context.busy) throw new Error(tr('Wait for identity review to finish.', 'انتظر اكتمال مراجعة الهويات.'));
    return context.pieces.map((piece, i) => {
      const row = context.host.querySelector(`[data-fdi-piece="${i}"]`), state = row.querySelector('select').value;
      if (!state || !row.querySelector('input').checked || state === 'reprinted' && !piece.printRequested) throw new Error(tr('Review every label, print obscured identities and confirm attachment.', 'راجع كل هوية، واطبع الهوية المطموسة وأكد لصقها على القطعة.'));
      return { unitId: piece.unitId, labelState: state, labelAttached: true,
        ...(state === 'reprinted' ? { printOperationKey: piece.printRequest.operationKey } : {}) };
    });
  }
  async function collectForReturn(id) {
    id = String(id);
    if (!context || context.id !== id || !context.ready) await load(id);
    return collect(id);
  }
  async function print(active, piece, button) {
    if (active.busy) return;
    const popup = window.open('', '_blank', 'width=850,height=750');
    if (!popup) { toast(tr('Allow the print window to open.', 'اسمح بفتح نافذة الطباعة.'), true); return; }
    active.busy = true; button.disabled = true;
    try {
      const labels = window.InventoryUnitLabels, ids = [piece.unitId], sizeId = active.host.querySelector('[data-fdi-size]').value;
      if (piece.printRequest?.sizeId !== sizeId) piece.printRequest = null;
      piece.printRequest ||= { unitIds: ids, sizeId, operationKey: 'failed-delivery-label:' + crypto.randomUUID(), allowReprint: true,
        reason: 'Obscured identity on physically received failed delivery; reprint same identity' };
      const batch = labels.validateBatch(await api('/inventory-units/labels/requests', { method: 'POST', body: JSON.stringify(piece.printRequest) }), ids, sizeId);
      const size = batch.size;
      popup.document.open();
      popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>SOULIA</title><link rel="stylesheet" href="${location.origin}/inventory-units.css"><style>@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}html,body{margin:0;padding:0;width:${size.widthMm}mm;background:white}.iu-label{margin:0!important;transform:none!important}</style></head><body>${batch.labels.map(label => labels.labelHtml(label, size)).join('')}</body></html>`);
      popup.document.close();
      await new Promise((resolve, reject) => {
        const css = popup.document.querySelector('link'), timeout = setTimeout(() => reject(new Error(tr('Print style timed out.', 'تعذر تحميل تنسيق الطباعة.'))), 15000);
        const finish = () => { clearTimeout(timeout); resolve(); };
        if (css.sheet) finish(); else { css.onload = finish; css.onerror = () => { clearTimeout(timeout); reject(new Error(tr('Print style unavailable.', 'تنسيق الطباعة غير متاح.'))); }; }
      });
      await labels.waitForLayout(popup.document);
      if (popup.closed) throw new Error(tr('Print window closed. Try again.', 'أغلقت نافذة الطباعة. حاول مرة أخرى.'));
      popup.focus(); popup.print(); piece.printRequested = true;
      toast(tr('Confirm printing and attach the same identity label before returning the piece to stock.', 'تأكد من الطباعة والصق نفس الهوية على القطعة قبل إرجاعها للمخزن.'));
    } catch (error) { if (!popup.closed) popup.close(); toast(error.message, true); }
    finally { active.busy = false; button.disabled = false; }
  }
  window.FailedDeliveryIdentities = { load, collect, collectForReturn };
})();
