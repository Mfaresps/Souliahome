/* Supplier labels issued before a purchase. A code becomes a normal unit only on invoice linking. */
(function () {
  'use strict';
  const tr = (en, ar) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const iconPaths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 15h12v6H6zM18 12h.01"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-5L4 8M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2M16 16h4v4"/>',
    details: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    prev: '<path d="m9 18 6-6-6-6"/>',
    next: '<path d="m15 18-6-6 6-6"/>',
    scan: '<path d="M4 9V5a1 1 0 0 1 1-1h4m6 0h4a1 1 0 0 1 1 1v4M4 15v4a1 1 0 0 0 1 1h4m6 0h4a1 1 0 0 0 1-1v-4M4 12h16"/>',
    codes: '<path d="M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M8 16v4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 .4l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.4l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    camera: '<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="3"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    close: '<path d="M5 5l14 14M19 5 5 19"/>',
  };
  const actionIcon = name => `<svg class="pl-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${iconPaths[name]}</svg>`;
  const buttonStyles = [
    ['#pl-close', 'close', '', ''], ['#pl-issue', 'plus', 'Create batch', 'إنشاء دفعة'],
    ['#pl-print', 'print', 'Print', 'طباعة'], ['#pl-refresh', 'refresh', 'Refresh', 'تحديث'],
    ['.pl-detail-button', 'details', 'Details', 'التفاصيل'], ['#pl-detail-print', 'print', 'Print batch', 'طباعة الدفعة'],
    ['.pl-back', 'back', 'Back', 'رجوع'], ['#pl-prev, #pl-detail-prev', 'prev', 'Previous', 'السابق'],
    ['#pl-next, #pl-detail-next', 'next', 'Next', 'التالي'], ['#pl-link', 'link', 'Link codes', 'ربط الأكواد'],
    ['#pl-scan-submit', 'scan', 'Receive piece', 'استلام القطعة'], ['#pl-camera', 'camera', 'Camera', 'الكاميرا'],
    ['#pl-done', 'check', 'Done', 'تم'], ['#pl-later', 'clock', 'Later', 'لاحقًا'],
    ['#pl-method-back', 'back', 'Change method', 'تغيير الطريقة'],
  ];
  function decorateButtons() {
    if (!dialog) return;
    for (const [selector, glyph, en, ar] of buttonStyles) {
      for (const button of dialog.querySelectorAll(selector)) {
        if (button.dataset.plIconized) continue;
        button.dataset.plIconized = 'true'; button.classList.add('pl-icon-button');
        button.innerHTML = actionIcon(glyph) + (en ? `<span>${tr(en, ar)}</span>` : '');
      }
    }
    for (const [id, glyph] of [['choose-scan', 'scan'], ['choose-range', 'codes']]) {
      const button = dialog.querySelector('#pl-' + id);
      if (button && !button.dataset.plIconized) {
        button.dataset.plIconized = 'true'; button.classList.add('pl-method-button');
        button.insertAdjacentHTML('afterbegin', actionIcon(glyph));
      }
    }
  }
  const key = () => crypto.randomUUID();
  const post = (path, body) => api('/inventory-units' + path, { method: 'POST', body: JSON.stringify(body) });
  let dialog, mode, linkMethod = null, batches = [], invoice, chosenBatch, pendingLink, busy = false;
  let preferredLineIndex = null;
  let scanSession = null, cameraLastCode = '', cameraLastAt = 0;
  let cameraStream, cameraControls, cameraGeneration = 0;
  const field = id => dialog.querySelector('#pl-' + id);
  const notice = (message, error = false) => { field('message').textContent = message; field('message').dataset.error = String(error); };
  function ensureDialog() {
    if (dialog?.isConnected) return;
    dialog = document.createElement('dialog'); dialog.id = 'prelabels-dialog'; dialog.className = 'pl-dialog';
    dialog.innerHTML = `<div class="pl-shell"><header class="pl-head"><div><small>SOULIA HOME · QR</small><h2 id="pl-title"></h2><p id="pl-subtitle"></p></div><button type="button" id="pl-close" aria-label="${tr('Close', 'إغلاق')}">×</button></header><div class="pl-body" id="pl-body"></div><p id="pl-message" role="status" aria-live="polite"></p></div>`;
    document.body.append(dialog);
    new MutationObserver(decorateButtons).observe(dialog, { childList: true, subtree: true });
    decorateButtons();
    field('close').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { stopCamera(); pendingLink = null; scanSession = null; });
  }
  function stopCamera() {
    cameraGeneration++;
    try { cameraControls?.stop(); } catch { /* Release the stream below. */ }
    cameraControls = null; cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; cameraLastCode = ''; cameraLastAt = 0;
    if (field('video')) field('video').hidden = true;
    const label = field('camera')?.querySelector('span'); if (label) label.textContent = tr('Camera', 'الكاميرا');
  }
  function setBusy(value) {
    busy = value; dialog?.querySelectorAll('button,input,select').forEach(control => { if (control.id !== 'pl-close') control.disabled = value; });
    dialog?.setAttribute('aria-busy', String(value));
    if (!value) updateScanProgress();
  }
  function scanFeedback(kind, text) {
    const result = field('scan-result');
    if (result) { result.hidden = false; result.dataset.kind = kind; result.setAttribute('role', kind === 'error' ? 'alert' : 'status'); result.textContent = text; }
    notice(text, kind === 'error');
  }
  function updateScanProgress() {
    if (!scanSession || !field('scan-progress')) return;
    const { scanned, target, finished } = scanSession;
    field('scan-done').textContent = String(scanned);
    field('scan-target').textContent = String(target);
    field('scan-left').textContent = tr(`${Math.max(0, target - scanned)} left to scan`, `متبقي ${Math.max(0, target - scanned)} للمسح`);
    field('scan-progress').value = scanned;
    field('scan-status').textContent = finished ? (scanned === target ? tr('All pieces received', 'اكتمل استلام القطع') : tr('Scanning stopped before completion', 'توقف المسح قبل اكتمال العدد')) : tr('Scan the next attached label', 'امسح الملصق المثبت على القطعة التالية');
    for (const id of ['scan-code', 'scan-submit', 'camera', 'scan-finish']) if (field(id)) field(id).disabled = busy || finished;
    if (field('scan-resume')) { field('scan-resume').hidden = !finished || scanned >= target; field('scan-resume').disabled = busy; }
  }
  function finishScanSession() {
    if (!scanSession || busy || scanSession.finished) return;
    stopCamera(); scanSession.finished = true; updateScanProgress();
    const { scanned, target } = scanSession;
    scanFeedback(scanned === target ? 'success' : 'error', scanned === target
      ? tr(`All ${target} pieces were received successfully.`, `تم استلام جميع القطع ${target} بنجاح.`)
      : tr(`Scanning stopped: ${scanned} of ${target} received; ${target - scanned} still need scanning.`, `لم يكتمل الاستلام: تم مسح ${scanned} من ${target}، وما زال ${target - scanned} بحاجة إلى مسح.`));
  }
  const loadLinkOptions = id => api('/inventory-units/purchases/' + encodeURIComponent(id) + '/prelabels/options');
  function renderLinkForm() {
    const line = invoice?.lines?.[Number(field('line')?.value || 0)];
    const matching = batches.filter(batch => batch.sku === line?.sku && batch.unused > 0);
    const selectedId = chosenBatch?.batchId;
    if (linkMethod === 'scan') {
      stopCamera();
      scanSession = { lineIndex: Number(field('line').value), target: Math.max(0, Number(line.quantity) - Number(line.createdUnits || 0)), scanned: 0,
        awaitingInspection: 0, accepted: new Set(), acceptedCodes: new Set(), pendingCode: '', pendingLabelKey: '', finished: false };
    } else scanSession = null;
    const old = field('link-controls'); if (old) old.remove();
    field('body').insertAdjacentHTML('beforeend', `<section class="pl-panel pl-link-controls" id="pl-link-controls" data-method="${linkMethod}">
      <h3>${linkMethod === 'scan' ? tr('Receive by scanning', 'استلام بالمسح') : tr('Link stored code range', 'ربط نطاق الأكواد المحفوظة')}</h3>
      <div class="pl-bulk-only"><label>${tr('Stored batch', 'الدفعة المحفوظة')}<select id="pl-link-batch">${matching.map(batch => `<option value="${esc(batch.batchId)}">${esc(batch.productName)} · ${esc(batch.batchId.slice(-8).toUpperCase())} · ${batch.unused} ${tr('unused', 'غير مستخدم')}</option>`).join('')}</select></label><div class="pl-range"><label>${tr('First number', 'أول رقم')}<input id="pl-link-start" type="number" min="1" value="1"></label><label>${tr('Quantity', 'العدد')}<input id="pl-link-quantity" type="number" min="1" max="1000" value="${Math.min(10, Math.max(1, Number(line?.quantity || 1) - Number(line?.createdUnits || 0)))}"></label></div></div>
      <div class="pl-scan-dashboard pl-scan-only"><div class="pl-scan-metric"><div><span>${tr('Pieces to receive', 'القطع المطلوب مسحها')}</span><strong dir="ltr"><b id="pl-scan-done">0</b><small> / <b id="pl-scan-target">${Math.max(0, Number(line.quantity) - Number(line.createdUnits || 0))}</b></small></strong></div><em id="pl-scan-left"></em></div><progress id="pl-scan-progress" value="0" max="${Math.max(1, Number(line.quantity) - Number(line.createdUnits || 0))}" aria-label="${tr('Receiving progress', 'تقدم الاستلام')}"></progress><p id="pl-scan-status">${tr('Scan the first attached label', 'ابدأ بمسح أول ملصق مثبت على قطعة')}</p></div>
      <div class="pl-checks"><label class="pl-confirm-row"><input id="pl-possession" type="checkbox"><span>${tr('I counted these pieces and have them in the invoice warehouse.', 'عددت هذه القطع وهي موجودة فعليًا في مخزن الفاتورة.')}</span></label><label class="pl-confirm-row"><input id="pl-labels-confirmed" type="checkbox"><span>${tr('The exact numbered labels are attached to these pieces.', 'الملصقات ذات هذه الأرقام بالضبط ملصقة على القطع.')}</span></label><label class="pl-confirm-row"><input id="pl-inspection" type="checkbox"><span>${tr('I checked their condition; make them available now.', 'فحصت سلامتها؛ اجعلها متاحة الآن.')}</span></label></div>
      <button type="button" class="pl-primary pl-bulk-only" id="pl-link">${tr('Link selected identities', 'ربط الهويات المحددة')}</button>
      <div class="pl-scan pl-scan-only"><label>${tr('Scan one attached QR label', 'امسح QR الملصق المثبت على القطعة')}<input id="pl-scan-code" dir="ltr" autocomplete="off" placeholder="SU-..."></label><button type="button" id="pl-scan-submit">${tr('Receive scanned piece', 'استلام القطعة الممسوحة')}</button><button type="button" id="pl-camera">${tr('Phone camera', 'كاميرا الهاتف')}</button></div><p class="pl-scan-result pl-scan-only" id="pl-scan-result" role="status" aria-live="polite" aria-atomic="true" hidden></p><video id="pl-video" playsinline muted hidden></video>
      <div class="pl-scan-actions pl-scan-only"><button type="button" id="pl-scan-finish">${tr('Finish scanning', 'إنهاء المسح')}</button><button type="button" id="pl-scan-resume" hidden>${tr('Continue scanning', 'متابعة المسح')}</button></div>
      <p class="pl-help">${tr('The linked codes become normal inventory units immediately. The purchase stock is not posted again.', 'تصبح الأكواد المرتبطة هويات قطع عادية فورًا. لا تُضاف كمية الشراء مرة أخرى.')}</p></section>`);
    field('link-batch').value = selectedId && matching.some(batch => batch.batchId === selectedId) ? selectedId : matching[0]?.batchId || '';
    chosenBatch = matching.find(batch => batch.batchId === field('link-batch').value) || null;
    field('link-start').value = String(chosenBatch?.firstUnused || 1);
    field('link-batch').onchange = () => { chosenBatch = matching.find(batch => batch.batchId === field('link-batch').value) || null; field('link-start').value = String(chosenBatch?.firstUnused || 1); };
    field('link').onclick = linkRange;
    for (const id of ['possession', 'labels-confirmed', 'inspection']) field(id).addEventListener('change', () => {
      if (linkMethod === 'scan' && field('possession').checked && field('labels-confirmed').checked)
        field('scan-code').focus({ preventScroll: true });
    });
    field('scan-submit').onclick = scanPiece;
    field('scan-code').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); scanPiece(); } };
    field('camera').onclick = startCamera;
    field('scan-finish').onclick = finishScanSession;
    field('scan-resume').onclick = () => { if (!scanSession || busy) return; scanSession.finished = false; updateScanProgress(); scanFeedback('info', tr('Continue scanning the remaining pieces.', 'تابع مسح القطع المتبقية.')); field('scan-code').focus(); };
    updateScanProgress();
    if (linkMethod === 'scan') field('scan-code').focus({ preventScroll: true });
  }
  async function scanPiece() {
    if (busy || !invoice || linkMethod !== 'scan' || !scanSession) return;
    if (scanSession.finished) return scanFeedback('error', tr('This scan session has ended. Choose another product or continue scanning.', 'انتهت جلسة المسح. اختر منتجًا آخر أو تابع المسح.'));
    const identifier = field('scan-code').value.trim(), lineIndex = Number(field('line').value), line = invoice.lines[lineIndex];
    if (!identifier) return scanFeedback('error', tr('Scan a QR label first.', 'امسح رمز QR أولًا.'));
    if (!field('possession').checked || !field('labels-confirmed').checked) return scanFeedback('error', tr('Confirm physical possession and the attached labels first.', 'أكّد الحيازة الفعلية والملصقات المثبتة أولًا.'));
    if (scanSession.pendingCode && scanSession.pendingCode !== identifier) return scanFeedback('error', tr('Retry the previous scan before scanning a different piece.', 'أعد محاولة مسح القطعة السابقة قبل الانتقال إلى قطعة أخرى.'));
    if (scanSession.pendingCode === identifier && pendingLink) return linkScannedPiece();
    setBusy(true);
    let lookupFailed = false;
    try {
      const label = await api('/inventory-units/prelabels/lookup?identifier=' + encodeURIComponent(identifier));
      const labelKey = String(label.batchId) + ':' + Number(label.ordinal);
      if (scanSession.accepted.has(labelKey)) throw new Error(tr('This piece was counted already. Scan a different label.', 'هذه القطعة محسوبة بالفعل. امسح ملصق قطعة أخرى.'));
      if (label.sku !== line.sku) throw new Error(tr('This QR belongs to a different invoice product.', 'رمز QR يخص منتجًا آخر غير بند الفاتورة.'));
      if (label.state !== 'unused' || label.printCount < 1) throw new Error(tr('This QR was linked already or never printed.', 'رمز QR مرتبط سابقًا أو لم تُطلب طباعته.'));
      let batch = batches.find(row => row.batchId === label.batchId);
      if (!batch) { batch = { batchId: label.batchId, productId: label.productId, sku: label.sku, productName: label.productName,
        quantity: label.batchQuantity, unused: 1 }; batches.unshift(batch); }
      chosenBatch = batch;
      if (!Array.from(field('link-batch').options).some(option => option.value === batch.batchId))
        field('link-batch').add(new Option(`${batch.productName} · ${batch.batchId.slice(-8).toUpperCase()}`, batch.batchId));
      field('link-batch').value = batch.batchId; field('link-start').value = String(label.ordinal); field('link-quantity').value = '1';
      scanSession.pendingCode = identifier; scanSession.pendingLabelKey = labelKey;
      field('scan-code').value = '';
    } catch (e) {
      scanFeedback('error', e.status === 404
        ? tr('QR label not found. Check the code and scan again.', 'لم يُعثر على هذا الملصق. تأكد من الكود ثم أعد المسح.')
        : e.message);
      lookupFailed = true;
    } finally { setBusy(false); }
    if (lookupFailed) { field('scan-code').focus({ preventScroll: true }); field('scan-code').select(); return; }
    await linkScannedPiece();
  }
  async function linkScannedPiece() {
    if (busy || !scanSession || !chosenBatch || !invoice) return;
    const lineIndex = scanSession.lineIndex, start = Number(field('link-start').value);
    const payload = { batchId: chosenBatch.batchId, lineIndex, start, quantity: 1, physicalPossessionConfirmed: true,
      physicalLabelsConfirmed: true, inspectionPassed: field('inspection').checked,
      reason: 'Physical count and exact preprinted label range confirmed' };
    const matchingRetry = pendingLink?.invoiceId === invoice.transactionId && JSON.stringify(pendingLink.payload, Object.keys(payload).sort()) === JSON.stringify(payload, Object.keys(payload).sort());
    payload.operationKey = matchingRetry ? pendingLink.payload.operationKey : key();
    pendingLink = { invoiceId: invoice.transactionId, payload };
    setBusy(true);
    let saved = false, selectCode = false;
    try {
      const result = await post(`/purchases/${invoice.transactionId}/prelabels/link`, payload);
      if (Number(result.linked) !== 1) throw new Error(tr('The scan result was unexpected. Reopen this invoice to check it.', 'نتيجة المسح غير متوقعة. أعد فتح الفاتورة للتحقق منها.'));
      saved = true; pendingLink = null;
      scanSession.scanned += 1; scanSession.accepted.add(scanSession.pendingLabelKey); scanSession.acceptedCodes.add(scanSession.pendingCode);
      if (result.status !== 'available') scanSession.awaitingInspection += 1;
      scanSession.pendingCode = ''; scanSession.pendingLabelKey = '';
      const options = await loadLinkOptions(invoice.transactionId);
      if (!options.receipt) throw new Error(tr('The piece was saved but its invoice summary could not be loaded.', 'حُفظت القطعة لكن تعذر تحديث ملخص الفاتورة.'));
      invoice = options.receipt; batches = options.batches;
      const line = invoice.lines[lineIndex], option = field('line').options[lineIndex];
      if (option && line) { option.textContent = `${line.name || line.sku} · ${line.createdUnits}/${line.quantity}`; option.disabled = line.quantity <= line.createdUnits; }
      window.InventoryUnitLabels?.receiptChanged(invoice.transactionId);
      const complete = scanSession.scanned >= scanSession.target;
      const otherRemaining = invoice.lines.reduce((sum, item, index) => sum + (index === lineIndex ? 0 : Math.max(0, Number(item.quantity) - Number(item.createdUnits || 0))), 0);
      const nextProduct = otherRemaining ? tr(' Choose the next invoice product.', ' اختر المنتج التالي في الفاتورة.') : '';
      if (complete) { scanSession.finished = true; stopCamera(); }
      updateScanProgress();
      scanFeedback('success', complete
        ? scanSession.awaitingInspection === 0
          ? tr(`All ${scanSession.target} pieces of this product were received and are available.`, `تم استلام جميع قطع هذا المنتج ${scanSession.target} وأصبحت متاحة.`) + nextProduct
          : scanSession.awaitingInspection === scanSession.target
            ? tr(`All ${scanSession.target} pieces of this product were received and await inspection.`, `تم استلام جميع قطع هذا المنتج ${scanSession.target} وهي بانتظار الفحص.`) + nextProduct
            : tr(`All ${scanSession.target} pieces of this product were received; ${scanSession.awaitingInspection} await inspection.`, `تم استلام جميع قطع هذا المنتج ${scanSession.target}؛ ${scanSession.awaitingInspection} منها بانتظار الفحص.`) + nextProduct
        : tr(`Piece received successfully (${scanSession.scanned} of ${scanSession.target}). Scan the next piece.`, `تم استلام القطعة بنجاح (${scanSession.scanned} من ${scanSession.target}). امسح القطعة التالية.`));
    } catch (e) {
      if (saved) { scanSession.finished = true; stopCamera(); updateScanProgress(); }
      else {
        field('scan-code').value = scanSession.pendingCode;
        if (e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) {
          scanSession.pendingCode = ''; scanSession.pendingLabelKey = ''; pendingLink = null;
        }
      }
      scanFeedback('error', saved
        ? tr(`${scanSession.scanned} piece(s) were saved, but the invoice could not be refreshed. Reopen it to verify the remaining count.`, `تم حفظ ${scanSession.scanned} قطعة، لكن تعذر تحديث الفاتورة. أعد فتحها للتحقق من العدد المتبقي.`)
        : e.message + (pendingLink
          ? tr(' Retry the same code to check this request.', ' أعد مسح الكود نفسه للتحقق من الطلب.')
          : tr(' Check this piece or scan another label.', ' راجع هذه القطعة أو امسح ملصقًا آخر.')));
      selectCode = !saved;
    } finally {
      setBusy(false);
      if (scanSession && !scanSession.finished && !cameraStream) {
        field('scan-code').focus({ preventScroll: true });
        if (selectCode) field('scan-code').select();
      }
    }
  }
  async function startCamera() {
    if (!scanSession || scanSession.finished) return scanFeedback('error', tr('Start a scan session for an invoice product first.', 'ابدأ جلسة مسح لمنتج من الفاتورة أولًا.'));
    if (!field('possession').checked || !field('labels-confirmed').checked) return scanFeedback('error', tr('Confirm physical possession and attached labels before using the camera.', 'أكّد الحيازة الفعلية والملصقات المثبتة قبل تشغيل الكاميرا.'));
    if (cameraStream) { stopCamera(); scanFeedback('info', tr('Camera stopped. The scanner field is ready.', 'توقفت الكاميرا. حقل المسح جاهز.')); field('scan-code').focus(); return; }
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) return scanFeedback('error', tr('Camera access requires a secure page.', 'الكاميرا تحتاج صفحة آمنة وصلاحية الوصول.'));
    const generation = ++cameraGeneration;
    try {
      const decoder = window.ZXingBrowser || await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = '/vendor/zxing-browser-0.2.1.min.js';
        script.onload = () => resolve(window.ZXingBrowser); script.onerror = () => reject(new Error(tr('QR camera decoder unavailable.', 'تعذر تشغيل قارئ QR بالكاميرا.'))); document.head.append(script);
      });
      if (generation !== cameraGeneration || !dialog.open) return;
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (generation !== cameraGeneration || !dialog.open) { acquired.getTracks().forEach(track => track.stop()); return; }
      cameraStream = acquired;
      const video = field('video'); video.hidden = false;
      const label = field('camera')?.querySelector('span'); if (label) label.textContent = tr('Stop camera', 'إيقاف الكاميرا');
      const reader = new decoder.BrowserQRCodeReader();
      const controls = await reader.decodeFromStream(cameraStream, video, result => {
        if (!result || busy || generation !== cameraGeneration) return;
        const code = result.getText();
        if (scanSession?.finished || scanSession?.acceptedCodes.has(code)) return;
        if (code === cameraLastCode && (!scanSession?.pendingCode || Date.now() - cameraLastAt < 2500)) return;
        cameraLastCode = code; cameraLastAt = Date.now(); field('scan-code').value = code; void scanPiece();
      });
      if (cameraStream) cameraControls = controls; else controls.stop();
    } catch (e) {
      stopCamera();
      const message = e.name === 'NotAllowedError'
        ? tr('Camera permission was denied. Allow access or use the scanner field.', 'تم رفض إذن الكاميرا. اسمح بالوصول أو استخدم حقل المسح.')
        : e.name === 'NotFoundError'
          ? tr('No camera was found. Connect a camera or use the scanner field.', 'لم يُعثر على كاميرا. وصّل كاميرا أو استخدم حقل المسح.')
          : e.name === 'NotReadableError'
            ? tr('The camera is busy. Close other camera apps and try again.', 'الكاميرا مشغولة. أغلق التطبيقات التي تستخدمها ثم أعد المحاولة.')
            : e.message;
      scanFeedback('error', message);
    }
  }
  async function linkRange() {
    if (busy || !chosenBatch || !invoice) return notice(tr('Choose a stored batch for this product.', 'اختر دفعة محفوظة لهذا المنتج.'), true);
    const lineIndex = Number(field('line').value), line = invoice.lines[lineIndex], start = Number(field('link-start').value), quantity = Number(field('link-quantity').value);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(quantity) || start < 1 || quantity < 1 || quantity > 1000 || start + quantity - 1 > chosenBatch.quantity || quantity > line.quantity - line.createdUnits)
      return notice(tr('The range exceeds the batch or invoice remainder.', 'النطاق يتجاوز الدفعة أو المتبقي في الفاتورة.'), true);
    if (!field('possession').checked || !field('labels-confirmed').checked) return notice(tr('Confirm the physical count and exact attached labels.', 'أكّد العدد الفعلي والملصقات المطابقة.'), true);
    setBusy(true);
    try {
      const payload = { batchId: chosenBatch.batchId, lineIndex, start, quantity, physicalPossessionConfirmed: true,
        physicalLabelsConfirmed: true, inspectionPassed: field('inspection').checked,
        reason: 'Physical count and exact preprinted label range confirmed' };
      const matchingRetry = pendingLink?.invoiceId === invoice.transactionId && JSON.stringify(pendingLink.payload, Object.keys(payload).sort()) === JSON.stringify(payload, Object.keys(payload).sort());
      payload.operationKey = matchingRetry ? pendingLink.payload.operationKey : key();
      pendingLink = { invoiceId: invoice.transactionId, payload };
      const result = await post(`/purchases/${invoice.transactionId}/prelabels/link`, payload);
      pendingLink = null;
      const options = await loadLinkOptions(invoice.transactionId);
      invoice = options.receipt; batches = options.batches;
      if (!invoice) throw new Error(tr('Invoice was saved but its receipt summary could not be loaded. Reopen it to check the result.', 'تم حفظ الفاتورة لكن تعذر تحميل ملخص الاستلام. أعد فتحها للتحقق من النتيجة.'));
      const confirmed = { possession: field('possession').checked, labels: field('labels-confirmed').checked, inspection: field('inspection').checked };
      stopCamera(); renderLinkView();
      if (field('possession')) {
        field('possession').checked = confirmed.possession; field('labels-confirmed').checked = confirmed.labels;
        field('inspection').checked = confirmed.inspection;
        if (linkMethod === 'scan') field('scan-code').focus();
      }
      window.InventoryUnitLabels?.receiptChanged(invoice.transactionId);
      notice(result.status === 'available' ? tr(`${result.linked} identities linked and available.`, `تم ربط ${result.linked} هوية وأصبحت متاحة.`) : tr(`${result.linked} identities linked and awaiting inspection.`, `تم ربط ${result.linked} هوية وهي بانتظار الفحص.`));
    } catch (e) { notice(e.message + (pendingLink ? tr(' Retry with the same operation key if the result is uncertain.', ' عند عدم وضوح النتيجة أعد المحاولة بمفتاح العملية نفسه.') : ''), true); }
    finally { setBusy(false); }
  }
  function renderLinkView() {
    mode = 'link'; field('title').textContent = tr('Receive preprinted QR labels', 'استلام ملصقات QR المطبوعة مسبقًا');
    const remaining = invoice.lines.reduce((sum, line) => sum + Math.max(0, Number(line.quantity) - Number(line.createdUnits || 0)), 0);
    if (!remaining) {
      field('subtitle').textContent = tr('All invoice pieces have identities.', 'جميع قطع الفاتورة لها هويات مسجلة.');
      field('body').innerHTML = `<section class="pl-panel pl-complete-panel"><div class="pl-invoice"><strong>${tr('Purchase invoice', 'فاتورة مشتريات')} #${esc(invoice.ref)}</strong><span>${esc(invoice.supplier)}</span></div><p class="pl-complete-copy">${tr('Every invoice piece already has an identity. There are no remaining pieces to link to preprinted QR labels. Unused batches remain available for another invoice.', 'كل قطع الفاتورة لها هويات مسجلة بالفعل، فلا توجد قطع متبقية لربط QR مطبوع مسبقًا. الدفعات غير المستخدمة تظل متاحة لفاتورة أخرى.')}</p><div class="pl-complete-actions"><button type="button" class="pl-primary" id="pl-done">${tr('Done', 'تم')}</button></div></section>`;
      field('done').onclick = () => dialog.close(); return;
    }
    if (!linkMethod) {
      field('subtitle').textContent = tr('Choose how to receive the printed identities for this invoice.', 'اختر طريقة استلام الهويات المطبوعة لهذه الفاتورة.');
      field('body').innerHTML = `<section class="pl-panel"><div class="pl-invoice"><strong>${tr('Purchase invoice', 'فاتورة مشتريات')} #${esc(invoice.ref)}</strong><span>${esc(invoice.supplier)}</span></div><p class="pl-help">${tr(`${remaining} invoice pieces still need identities.`, `${remaining} قطعة في الفاتورة لا تزال تحتاج إلى ربط هوية.`)}</p><div class="pl-methods"><button type="button" id="pl-choose-scan"><strong>${tr('Receive by scanning', 'استلام بالمسح')}</strong><span>${tr('Scan the QR attached to each piece. Each scan links one stored identity.', 'امسح QR المثبت على كل قطعة؛ كل مسحة تربط هوية محفوظة واحدة.')}</span></button><button type="button" id="pl-choose-range"><strong>${tr('Use stored codes', 'من الأكواد المحفوظة')}</strong><span>${tr('Choose a previously printed batch and exact numbered range after counting the pieces.', 'اختر دفعة مطبوعة سابقًا ونطاق أرقام محددًا بعد عد القطع.')}</span></button></div><button type="button" class="pl-later" id="pl-later">${tr('Receive later', 'الاستلام لاحقًا')}</button></section>`;
      field('choose-scan').onclick = () => { linkMethod = 'scan'; renderLinkView(); field('scan-code')?.focus(); };
      field('choose-range').onclick = () => { linkMethod = 'range'; renderLinkView(); };
      field('later').onclick = () => dialog.close(); return;
    }
    field('subtitle').textContent = linkMethod === 'scan' ? tr('Scan a printed code attached to a piece in the invoice warehouse.', 'امسح كودًا مطبوعًا ومثبتًا على قطعة في مخزن الفاتورة.') : tr('Select a previously printed batch and the exact numbered range.', 'اختر دفعة مطبوعة سابقًا ونطاق الأرقام المحدد.');
    const firstOpenLine = invoice.lines.findIndex(line => line.quantity > line.createdUnits);
    const preferred = invoice.lines.findIndex(line => line.lineIndex === preferredLineIndex && line.quantity > line.createdUnits);
    const selectedLine = preferred >= 0 ? preferred : firstOpenLine;
    field('body').innerHTML = `<section class="pl-panel"><div class="pl-invoice"><strong>${tr('Purchase invoice', 'فاتورة مشتريات')} #${esc(invoice.ref)}</strong><span>${esc(invoice.supplier)}</span></div><label>${tr('Invoice product', 'منتج الفاتورة')}<select id="pl-line">${invoice.lines.map((line, index) => `<option value="${index}" ${index === selectedLine ? 'selected' : ''} ${line.quantity <= line.createdUnits ? 'disabled' : ''}>${esc(line.name || line.sku)} · ${line.createdUnits}/${line.quantity}</option>`).join('')}</select></label><p class="pl-help">${tr('Only the unlinked quantity can be selected. Existing identities remain unchanged.', 'يمكن اختيار الكمية التي لا هويات لها فقط. الهويات الموجودة لا تتغير.')}</p></section>`;
    field('body').insertAdjacentHTML('beforeend', `<button type="button" class="pl-back" id="pl-method-back">${tr('Change receiving method', 'تغيير طريقة الاستلام')}</button>`);
    field('method-back').onclick = () => { stopCamera(); scanSession = null; linkMethod = null; chosenBatch = null; renderLinkView(); };
    field('line').onchange = () => { preferredLineIndex = invoice.lines[Number(field('line').value)]?.lineIndex ?? null; chosenBatch = null; renderLinkForm(); };
    renderLinkForm();
  }
  function openIssue() {
    if (hasPerm('inventory-units-print') && hasPerm('inventory-units-view')) {
      if (location.hash !== '#warehouse-management/supplier-labels') history.pushState(null, '', '#warehouse-management/supplier-labels');
      navigateTo('barcodes', false);
    }
  }
  async function openLink(id, lineIndex = null) {
    if (!hasPerm('purchase-view') || !hasPerm('inventory-units-receive')) return;
    preferredLineIndex = Number.isSafeInteger(lineIndex) ? lineIndex : null;
    ensureDialog(); dialog.showModal(); field('body').innerHTML = ''; notice(tr('Loading invoice and stored labels…', 'جارٍ تحميل الفاتورة والملصقات المحفوظة…'));
    try {
      const options = await loadLinkOptions(id);
      invoice = options.receipt; if (!invoice || invoice.cancelled) throw new Error(tr('An active purchase invoice is required.', 'يلزم فاتورة مشتريات فعالة.'));
      batches = options.batches; chosenBatch = null; scanSession = null; linkMethod = null; renderLinkView(); notice('');
    } catch (e) { notice(e.message, true); }
  }
  window.PreprintedLabels = { openIssue, openLink };
}());
