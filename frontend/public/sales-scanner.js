/* Draft-only scanning. Financial sale + exact physical reservations are saved atomically. */
(function () {
  'use strict';
  const host = document.getElementById('tx-sale-scanner');
  if (!host) return;
  const tr = (en, ar) => currentLang === 'en' ? en : ar;
  const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const warehouse = () => window.SouliaWarehouses?.read('tx') || document.getElementById('tx-warehouse')?.value || 'MAIN';
  const canonicalWarehouse = value => !value || ['main','المخزن الرئيسي'].includes(value) ? 'MAIN' : value;
  const enabled = () => currentPage === 'transaction' && txType === 'مبيعات' && !document.hidden;
  const selections = () => txItems.flatMap(item => item._saleScans || []);
  let manual = false, feedback = null, buffer = '', keyAt = 0, epoch = 0, running = false;
  const jobs = [];
  let searchBurst = null;
  const searchInput = target => target instanceof HTMLInputElement && ['global-search','tx-picker-q'].includes(target.id);
  function flushSearch() {
    const burst = searchBurst; searchBurst = null;
    if (!burst) return;
    clearTimeout(burst.timer);
    if (!burst.input.isConnected) return;
    burst.input.setRangeText(burst.text, burst.input.selectionStart ?? burst.input.value.length, burst.input.selectionEnd ?? burst.input.value.length, 'end');
    burst.input.dispatchEvent(new Event('input', {bubbles:true}));
  }
  function clearSearch() { if (searchBurst) clearTimeout(searchBurst.timer); searchBurst = null; }
  function blocked(target) {
    if (document.querySelector('dialog[open], .modal-overlay.active, #tx-confirm-modal.active, #soulia-modal-overlay.active, #pu-card-orders-modal.active')) return true;
    const picker = document.getElementById('tx-picker-overlay');
    return !!picker?.getClientRects().length && (target?.id !== 'tx-picker-q' || picker._editMode || picker._poMode);
  }
  function ownsKeyboard(event) {
    return enabled() && !_txSaving && !blocked(event.target) &&
      !event.target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') &&
      !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing;
  }
  let pendingRequest = null;
  try { pendingRequest = JSON.parse(sessionStorage.getItem('sale-scanner-request') || 'null'); } catch (_) {}

  function render() {
    host.hidden = txType !== 'مبيعات';
    if (host.hidden) return;
    const active = document.activeElement, typing = active?.id === 'sale-scan-code';
    const draft = typing ? active.value : '';
    host.innerHTML = `<div class="sale-reader-bar"><span class="sale-reader-dot ${running?'is-busy':''}" aria-hidden="true"></span><strong>${running?tr('Checking scan… Keep scanning','جارٍ التحقق… يمكنك متابعة المسح'):tr('Scanner ready — scan a piece or product code','الماسح جاهز — امسح قطعة أو كود صنف')}</strong>${jobs.length>1?`<span>${jobs.length-1} ${tr('waiting','قيد الانتظار')}</span>`:''}<button type="button" data-sale-manual aria-expanded="${manual}">${manual?tr('Close manual entry','إغلاق الإدخال اليدوي'):tr('Manual entry','إدخال يدوي')}</button></div>
      <small>${tr('Scanned piece identities are linked to the order when you save. Product codes add quantity without choosing a physical piece.','تُربط القطع الممسوحة بالطلب عند الحفظ. كود الصنف يضيف الكمية دون اختيار قطعة بعينها.')}</small>
      ${manual?`<form data-sale-form><label for="sale-scan-code">${tr('Piece, pack or product code','كود القطعة أو الباك أو الصنف')}</label><div><input id="sale-scan-code" data-scan-input dir="ltr" autocomplete="off" spellcheck="false" maxlength="160" required value="${html(draft)}"><button type="submit">${tr('Add','إضافة')}</button></div></form>`:''}
      ${feedback?`<div class="sale-reader-feedback ${feedback.error?'is-error':'is-success'}" role="${feedback.error?'alert':'status'}"><b aria-hidden="true">${feedback.error?'!':'✓'}</b> <span>${html(feedback.text)}</span>${feedback.code?` <code dir="ltr">${html(feedback.code)}</code>`:''}${feedback.hint?`<small>${html(feedback.hint)}</small>`:''}</div>`:''}`;
    host.querySelector('[data-sale-manual]').onclick = () => { manual = !manual; buffer = ''; render(); if (manual) host.querySelector('input')?.focus(); };
    host.querySelector('form')?.addEventListener('submit', event => { event.preventDefault(); const input = host.querySelector('input'); const code = input.value; input.value = ''; submit(code); });
    if (typing) { const input = host.querySelector('input'); input?.focus({ preventScroll: true }); if (input) input.setSelectionRange(draft.length,draft.length); }
    document.querySelectorAll('#tx-items .tx-item-card').forEach((card, index) => {
      card.querySelector('.sale-piece-codes')?.remove();
      const scans = txItems[index]?._saleScans || [];
      if (!scans.length) return;
      const wrap = document.createElement('div'); wrap.className = 'sale-piece-codes';
      scans.forEach((scan, scanIndex) => {
        const button = document.createElement('button'); button.type = 'button'; button.dir = 'ltr';
        button.textContent = `✓ ${scan.code}${scan.quantity>1?' ×'+scan.quantity:''} ×`;
        button.setAttribute('aria-label', tr('Remove scanned selection ','إزالة القطعة الممسوحة ') + scan.code);
        button.onclick = () => remove(index,scanIndex); wrap.append(button);
      });
      card.querySelector('.tx-item-info')?.append(wrap);
    });
  }
  function reset(discardRequest = false) { epoch++; jobs.length = 0; buffer = ''; clearSearch(); feedback = null; manual = false; if (discardRequest) { pendingRequest = null; sessionStorage.removeItem('sale-scanner-request'); } render(); }
  function minimum(item) { return (item?._saleScans || []).reduce((sum, scan) => sum + Number(scan.quantity), 0); }
  function remove(index, scanIndex) {
    const item = txItems[index], scan = item?._saleScans?.[scanIndex]; if (!scan) return;
    item._saleScans.splice(scanIndex,1); item.qty = Math.max(0,item.qty-scan.quantity);
    if (!item.qty) txItems.splice(index,1);
    feedback = null; markTxDirty(); renderTxItems(); calcTxSummary(); render();
  }
  function submit(raw) {
    const typed = String(raw || '').trim().replace(/[٠-٩۰-۹]/g, char => String(char.charCodeAt(0) - (char <= '٩' ? 0x660 : 0x6f0)));
    const code = window.BarcodeInput?.normalize(typed) || typed;
    if (!enabled() || !code || _txSaving) return;
    if (code.length>160) {feedback={error:true,text:tr('This code is too long. Scan the piece label or use Manual entry.','الكود أطول من الحد المسموح. امسح ملصق القطعة أو استخدم الإدخال اليدوي.')};render();return;}
    if (/^(SU-|PK-|U-?\d)|^[\d]{9}$|^[a-f\d]{24}$/i.test(code) && jobs.some(job=>job.code===code && job.epoch===epoch)) return;
    if (jobs.length>=32) { feedback={error:true,text:tr('Scan queue is full. Wait, then scan this code again.','طابور المسح ممتلئ. انتظر ثم أعد مسح هذا الكود.'),code};render();return; }
    jobs.push({code,warehouse:warehouse(),epoch});
    if (!running) drain(); else render();
  }
  async function drain() {
    running = true; render();
    while (jobs.length) {
      const job = jobs[0];
      try {
        if (!enabled() || job.epoch!==epoch || job.warehouse!==warehouse()) throw Error(tr('The form or warehouse changed. Scan again in the current sale.','تغيرت المعاملة أو المخزن. أعد المسح في المعاملة الحالية.'));
        const physical = /^(SU-|PK-|U-?\d)|^[\d]{9}$|^[a-f\d]{24}$/i.test(job.code);
        const matches = products.filter(product=>String(product.code)===job.code || product.barcode===job.code);
        let product = !physical && matches.length===1 ? matches[0] : null, quantity = 1, scan = null;
        if (!product) {
          if (!hasPerm('inventory-units-view') || !hasPerm('inventory-units-allocate')) throw Error(tr('Scanning pieces requires inventory view and allocation permissions. You can add a product by its code.','مسح القطع يحتاج صلاحية عرض القطع وتخصيصها. يمكنك إضافة الصنف بكوده.'));
          const { unit } = await api(`/inventory-units/${encodeURIComponent(job.code)}`, { background: true });
          if (!unit || unit.status!=='available' || unit.assignment) throw Error(tr('This piece is unavailable or linked to another order. Scan an available piece.','القطعة غير متاحة أو مرتبطة بطلب آخر. امسح قطعة متاحة.'));
          if (!unit.isPack && unit.packId) throw Error(tr('Scan the sealed pack label, or open the pack before scanning individual pieces.','امسح ملصق الباك المغلق أو افتحه قبل مسح القطع منفردة.'));
          if (canonicalWarehouse(unit.warehouseCode)!==canonicalWarehouse(job.warehouse)) throw Error(tr('This piece belongs to a different warehouse. Choose its warehouse or scan another piece.','القطعة من مخزن مختلف. اختر مخزنها أو امسح قطعة من المخزن الحالي.'));
          product = products.find(row=>String(row._id)===String(unit.productId));
          quantity = unit.isPack ? Number(unit.quantity) : 1;
          if (!product || !Number.isSafeInteger(quantity) || quantity<1 || !/^[a-f\d]{24}$/i.test(String(unit._id))) throw Error(tr('Piece or product data is invalid. Review it in Inventory.','بيانات القطعة أو الصنف غير صحيحة. راجعها في المخزون.'));
          scan = { id:String(unit._id).toLowerCase(),isPack:!!unit.isPack,quantity,code:unit.manualCode||unit.barcode||job.code,productId:product._id,warehouseCode:unit.warehouseCode };
        }
        if (!enabled() || job.epoch!==epoch || job.warehouse!==warehouse()) throw Error(tr('The form changed. Scan this piece again.','تغيرت المعاملة. أعد مسح هذه القطعة.'));
        if (typeof isProductListable === 'function' && !isProductListable(product)) throw Error(tr('This product is inactive. Review it before adding it to a sale.','هذا الصنف غير نشط. راجعه قبل إضافته للبيع.'));
        if (scan && selections().some(previous=>previous.id===scan.id)) throw Error(tr('This piece is already in the invoice. Scan a different piece.','القطعة موجودة بالفعل في الفاتورة. امسح قطعة أخرى.'));
        const item = txItems.find(row=>row.productId===product._id), currentQty=txItems.filter(row=>row.productId===product._id).reduce((sum,row)=>sum+Number(row.qty),0);
        const available = getTxAvailableStock(product._id);
        if (available>=0 && currentQty+quantity>available) throw Error(tr(`Only ${available} pieces are available in this warehouse.`,`المتاح في هذا المخزن ${available} قطعة فقط.`));
        const target = item || { productId:product._id,qty:0,price:product.sellPrice||0 };
        target.qty += quantity;
        if (scan) (target._saleScans ||= []).push(scan);
        if (!item) txItems.push(target);
        _dsbDismissed = false; markTxDirty(); renderTxItems(); calcTxSummary();
        feedback={text:tr(`${product.name} added · ${quantity} piece(s).`, `تمت إضافة ${product.name} · ${quantity} قطعة.`),code:job.code};
      } catch(error) {
        if (job.epoch===epoch) feedback={error:true,text:error.status===404?tr('Code not found. Check the label or enter the product code.','الكود غير مسجل. راجع الملصق أو أدخل كود الصنف.'):error.message||tr('Could not read the code. Try again.','تعذر قراءة الكود. أعد المحاولة.'),code:job.code};
      } finally { if (jobs[0]===job) jobs.shift(); render(); }
    }
    running = false; render();
  }
  function attach(invoice) {
    if (txType!=='مبيعات') return;
    if (running || jobs.length) throw Error(tr('Wait until all scanned pieces have been checked.','انتظر انتهاء التحقق من القطع الممسوحة.'));
    const bindings=[];
    for (const item of txItems) {
      const scans=item._saleScans||[]; if (!scans.length) continue;
      if (minimum(item)>item.qty || scans.some(scan=>scan.productId!==item.productId || canonicalWarehouse(scan.warehouseCode)!==canonicalWarehouse(invoice.warehouseCode))) throw Error(tr('Review scanned pieces: quantity, product or warehouse no longer matches. Remove the relevant code to change it.','راجع القطع الممسوحة: الكمية أو الصنف أو المخزن لا يطابقها. أزل الكود المعني لتعديله.'));
      bindings.push({productId:item.productId,unitIds:scans.filter(scan=>!scan.isPack).map(scan=>scan.id),packIds:scans.filter(scan=>scan.isPack).map(scan=>scan.id)});
    }
    if (bindings.length) {
      const actor = String(currentUser?._id || currentUser?.userId || '');
      const cleanInvoice = {...invoice}; delete cleanInvoice._saleBinding;
      const fingerprint = JSON.stringify({actor,invoice:{...cleanInvoice,date:invoice.transactionDate||invoice.date},bindings});
      if (pendingRequest?.fingerprint !== fingerprint) pendingRequest = { fingerprint, operationKey:`sale-${crypto.randomUUID()}`, invoice:JSON.parse(JSON.stringify(cleanInvoice)), bindings, pieceCount:selections().reduce((sum,scan)=>sum+scan.quantity,0) };
      try { sessionStorage.setItem('sale-scanner-request',JSON.stringify(pendingRequest)); } catch (_) {}
      invoice._saleBinding = pendingRequest;
    }
  }
  async function save(body) {
    const { _saleBinding } = body;
    try {
      const result=await api('/inventory-units/sales',{method:'POST',body:JSON.stringify({operationKey:_saleBinding.operationKey,invoice:_saleBinding.invoice,bindings:_saleBinding.bindings})});
      return result.transaction;
    } catch(error) {
      error.message = error.status === 409 ? tr('A selected piece or order changed. Review the scanned codes, then save again.','تغيرت حالة قطعة أو الطلب. راجع الأكواد الممسوحة ثم أعد الحفظ.')
        : window.InventoryErrors?.translate(error.message,error.code,error.status,error.details) || error.message;
      throw error;
    }
  }
  window.addEventListener('keydown',event=>{
    if (!enabled() || _txSaving || blocked(event.target)) { buffer='';flushSearch();return; }
    if (['Shift','CapsLock'].includes(event.key)) return;
    if (searchInput(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !event.isComposing) {
      const now = performance.now(), key = window.BarcodeInput?.key(event) || event.key;
      if (searchBurst && (searchBurst.input !== event.target || now - searchBurst.at > 70)) flushSearch();
      if (['Enter','Tab'].includes(event.key) && searchBurst) {
        const burst = searchBurst;
        const code = window.BarcodeInput?.normalize(burst.code) || burst.code;
        const known = products.some(product => String(product.code) === code || product.barcode === code);
        const scan = burst.count >= 2 && burst.fast && (known || /^(SU-|PK-|U-?\d)|^\d{9}$|^[a-f\d]{24}$/i.test(code));
        if (scan) {
          clearSearch(); buffer=''; event.preventDefault(); event.stopImmediatePropagation();
          // A completed scan must never trigger search results or submit the invoice.
          event.target.blur(); if (event.target.id === 'global-search') closeSearchDropdown();
          submit(code); return;
        }
        flushSearch(); return;
      }
      if (key.length === 1 && event.key.length === 1 && key !== ' ') {
        event.preventDefault(); event.stopImmediatePropagation(); buffer='';
        if (!searchBurst) searchBurst={input:event.target,text:'',code:'',count:0,at:now,fast:true,timer:null};
        const burst=searchBurst;
        burst.fast = burst.fast && (!burst.count || now-burst.at<=45);
        burst.text+=event.key; burst.code+=key; burst.count++; burst.at=now;
        clearTimeout(burst.timer); burst.timer=setTimeout(flushSearch,70);
        if (burst.count>160) flushSearch();
        return;
      }
      flushSearch(); return;
    }
    if (event.target?.id==='sale-scan-code' && ['Enter','Tab'].includes(event.key) && !event.repeat && !event.isComposing) {
      event.preventDefault();event.stopImmediatePropagation();buffer='';const code=event.target.value;event.target.value='';submit(code);return;
    }
    flushSearch();
    if (event.target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') || event.ctrlKey||event.metaKey||event.altKey||event.repeat||event.isComposing) {buffer='';return;}
    const now=performance.now();if(now-keyAt>200)buffer='';
    if ((event.key==='Enter'||event.key==='Tab')&&buffer.length) {event.preventDefault();event.stopImmediatePropagation();const code=buffer;buffer='';submit(code);}
    else {const key=window.BarcodeInput?.key(event)||event.key;if(key.length===1&&key!==' '){event.preventDefault();event.stopImmediatePropagation();if(buffer.length<161)buffer+=key;keyAt=now;}else buffer='';}
  },true);
  document.addEventListener('change',event=>{if(event.target.id==='tx-warehouse'){epoch++;jobs.length=0;buffer='';feedback=null;render();}});
  new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['lang','dir']});
  document.addEventListener('focusout',event=>{if (searchBurst?.input===event.target) flushSearch();},true);
  document.addEventListener('pointerdown',flushSearch,true);
  window.addEventListener('blur',()=>{buffer='';flushSearch();});
  window.SalesScanner={render,reset,submit,minimum,attach,save,ownsKeyboard};
  render();
})();
