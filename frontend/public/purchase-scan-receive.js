/* Receive a purchase by scanning pre-printed supplier QR labels («استلام بالمسح — جرد وفرز»).
 * Draft only: nothing reaches the server until the invoice is saved. The save is one request
 * (POST /inventory-units/purchases/receive-scanned) that writes the invoice, vault, supplier ledger,
 * stock movement, new barcodes for unlabelled lines and the scanned links in ONE database transaction. */
(function () {
  'use strict';
  const tr = (en, ar) => (typeof currentLang !== 'undefined' && currentLang === 'en') ? en : ar;
  const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const SESSION_TTL = 7 * 24 * 3600 * 1000;
  let mode = false, feedback = null, running = false, epoch = 0, buffer = '', keyAt = 0, manual = false;
  const jobs = [];
  const verified = new Set();       // scan ids confirmed against the server during this page load
  let verifying = null;             // in-flight check of restored scans
  let outdated = null;              // { rows } — restored scans that changed on the server; the session cannot continue
  let verifyError = '';

  // ── storage (per user) ──────────────────────────────────────────────────────────────────
  const actorId = () => String((typeof currentUser !== 'undefined' && (currentUser?._id || currentUser?.id || currentUser?.userId || currentUser?.username)) || '');
  const key = suffix => 'soulia-scan-receive:v1:' + encodeURIComponent(actorId()) + suffix;
  const read = suffix => { try { return actorId() ? JSON.parse(localStorage.getItem(key(suffix)) || 'null') : null; } catch (_) { return null; } };
  const write = (suffix, value) => { try { if (!actorId()) return; if (value == null) localStorage.removeItem(key(suffix)); else localStorage.setItem(key(suffix), JSON.stringify(value)); } catch (_) { /* storage unavailable: the draft lives in memory only */ } };
  const storedSession = () => { const s = read(':session'); if (!s || s.v !== 1 || Date.now() - Number(s.savedAt || 0) > SESSION_TTL) return null; return s; };
  const storedPending = () => read(':pending');

  // ── line helpers ────────────────────────────────────────────────────────────────────────
  const isScanLine = item => Array.isArray(item?._prelabelScans) && item._prelabelScans.length > 0;
  const scanCount = item => (item?._prelabelScans || []).reduce((sum, scan) => sum + Number(scan.quantity || 0), 0);
  /** One line per product: its scanned pieces, and the rest of its quantity without a label (new barcodes on save). */
  const looseCount = item => Math.max(0, (Number(item?.qty) || 0) - scanCount(item));
  /** The lowest quantity a line may take: a scanned piece is only removed by removing its code. */
  const minimum = item => active() ? scanCount(item) : 0;
  const allScans = () => (typeof txItems === 'undefined' ? [] : txItems).flatMap(item => item._prelabelScans || []);
  const active = () => typeof txType !== 'undefined' && txType === 'مشتريات' && mode;
  const enabled = () => active() && typeof currentPage !== 'undefined' && currentPage === 'transaction' && !document.hidden;
  const canScan = () => typeof hasPerm === 'function' && hasPerm('inventory-units-receive') && hasPerm('purchase-view');
  const product = id => (typeof products !== 'undefined' ? products : []).find(row => String(row._id) === String(id));
  const priceOf = p => typeof _txPurchasePrice === 'function' ? _txPurchasePrice(p) : Number(p?.buyPrice || 0);
  // randomUUID needs a secure origin; the app is also opened over plain http on the local network.
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const sound = kind => { try { if (typeof _pwScanSound === 'function') _pwScanSound(kind); } catch (_) { /* sound is optional */ } };

  /** Mirrors the scan lines to this device. An empty form never erases a saved session unless the user emptied it. */
  function saveSession(userCleared = false) {
    if (!active()) return;
    const lines = txItems.filter(item => item.productId).map(item => ({ productId: item.productId, qty: Number(item.qty) || 0,
      price: Number(item.price) || 0, autoPrice: item._autoPrice, scans: item._prelabelScans || [] }));
    if (!lines.length) { if (userCleared) write(':session', null); return; }
    write(':session', { v: 1, savedAt: Date.now(), warehouse: window.SouliaWarehouses?.read('tx') || 'MAIN',
      supplier: document.getElementById('tx-supplier')?.value || '', lines });
  }
  /** Called by the item-list functions in index.html after a user action changed the lines. */
  function changed() { saveSession(true); render(); }

  // ── mode ────────────────────────────────────────────────────────────────────────────────
  async function toggle(input) {
    const want = !!input?.checked;
    if (want === mode) return;
    if (want) {
      if (!canScan()) { input.checked = false; toast(tr('Receiving by scan needs purchase view and unit receiving permissions.', 'الاستلام بالمسح يحتاج صلاحية عرض المشتريات واستلام القطع.'), true); return; }
      const other = document.getElementById('tx-track-units');
      if (other?.checked) { other.checked = false; window.togglePurchaseReceiptFields?.('tx'); }
      mode = true;
      const existing = txItems.filter(item => item.productId);
      if (existing.length) toast(tr(`${existing.length} existing line(s) will be received without a label and get new barcodes.`, `${existing.length} صنف موجود سيُستلم بدون ملصق ويُنشأ له باركود جديد.`));
      feedback = null; renderTxItems(); calcTxSummary(); saveSession();
      setTimeout(() => document.getElementById('psr-code')?.focus({ preventScroll: true }), 0);
      return;
    }
    const scanned = allScans().reduce((sum, scan) => sum + Number(scan.quantity || 0), 0);
    if (scanned && !(await showConfirm(tr(`Turning off receiving by scan removes ${scanned} scanned piece(s) from this invoice. Continue?`, `إيقاف الاستلام بالمسح سيحذف ${scanned} قطعة ممسوحة من هذه الفاتورة. هل تريد المتابعة؟`)))) { input.checked = true; return; }
    write(':session', null);
    dropScans();
    mode = false; outdated = null; verifyError = ''; jobs.length = 0; epoch++; feedback = null;
    markTxDirty(); renderTxItems(); calcTxSummary();
  }
  /** Removes every scanned piece from the lines; pieces added without a label stay. */
  function dropScans() {
    txItems = txItems.filter(item => { const loose = looseCount(item); delete item._prelabelScans; item.qty = loose; return !item.productId || loose > 0; });
  }
  function reset() {
    // The stored session is kept: only a successful save, «Discard» or turning the mode off removes it.
    epoch++; jobs.length = 0; buffer = ''; mode = false; feedback = null; outdated = null; verifyError = ''; manual = false; render();
  }

  // ── adding lines ────────────────────────────────────────────────────────────────────────
  /** «إضافة صنف» in scan mode: one more piece WITHOUT a label on the product's line (new barcode on save). */
  function addManual(productId) {
    const p = product(productId);
    if (!p) { toast(tr('Item not found — select again from the list', 'الصنف غير موجود — أعد الاختيار من القائمة'), true); return; }
    const line = txItems.find(item => item.productId === productId);
    if (line) line.qty = (Number(line.qty) || 0) + 1;
    else { const price = priceOf(p); txItems.push({ productId, qty: 1, price, _autoPrice: price }); }
    if (typeof _dsbDismissed !== 'undefined') _dsbDismissed = false;
    markTxDirty(); renderTxItems(); calcTxSummary(); saveSession();
    toast(tr(`«${p.name}» added without a label — a new barcode is created on save.`, `أُضيف «${p.name}» بدون ملصق — يُنشأ له باركود جديد عند الحفظ.`));
  }
  function removeScan(lineIndex, scanIndex) {
    const item = txItems[lineIndex], scan = item?._prelabelScans?.[scanIndex];
    if (!scan || typeof _txSaving !== 'undefined' && _txSaving) return;
    item._prelabelScans.splice(scanIndex, 1);
    if (!item._prelabelScans.length) delete item._prelabelScans;
    item.qty = Math.max(0, (Number(item.qty) || 0) - Number(scan.quantity || 0));
    if (!item.qty) txItems.splice(lineIndex, 1);
    verified.delete(scan.id);
    feedback = { text: tr(`Removed ${scan.code} from this receipt.`, `أُزيل ${scan.code} من الاستلام.`) };
    markTxDirty(); renderTxItems(); calcTxSummary(); saveSession(true);
  }

  // ── scanning ────────────────────────────────────────────────────────────────────────────
  function submit(raw) {
    const typed = String(raw || '').trim().replace(/[٠-٩۰-۹]/g, ch => String(ch.charCodeAt(0) - (ch <= '٩' ? 0x660 : 0x6f0)));
    const code = window.BarcodeInput?.normalize(typed) || typed;
    if (!enabled() || !code || (typeof _txSaving !== 'undefined' && _txSaving)) return;
    if (verifying || outdated) { feedback = { error: true, text: tr('Finish checking the saved session first.', 'أكمل مراجعة الجلسة المحفوظة أولًا.'), code }; render(); return; }
    if (code.length > 160) { feedback = { error: true, text: tr('This code is too long to be a label.', 'الكود أطول من أن يكون ملصقًا.'), code }; sound('warn'); render(); return; }
    if (jobs.some(job => job.code === code && job.epoch === epoch)) return;
    if (jobs.length >= 32) { feedback = { error: true, text: tr('Scan queue is full. Wait, then scan this code again.', 'طابور المسح ممتلئ. انتظر ثم أعد مسح هذا الكود.'), code }; render(); return; }
    jobs.push({ code, epoch });
    if (!running) drain(); else render();
  }
  /** A refusal decided here (not a server or network answer). */
  const refuse = message => Object.assign(new Error(message), { local: true });
  function scanError(error) {
    if (error?.local) return error.message;
    if (error?.status === 404) return tr('Unknown code: it is not a pre-printed supplier label.', 'كود غير معروف: ليس ملصق مورد مطبوعًا مسبقًا.');
    if (error?.status === 400) return tr('Invalid code. Scan the QR or type the U-code of a supplier label.', 'كود غير صالح. امسح رمز QR أو اكتب كود U لملصق مورد.');
    if (!error?.status) return tr('No connection to the server — the code was not added. Scan it again.', 'تعذر الاتصال بالخادم — لم يُضف الكود. أعد مسحه.');
    return error.message || tr('Could not read the code. Try again.', 'تعذر قراءة الكود. أعد المحاولة.');
  }
  async function drain() {
    running = true; render();
    while (jobs.length) {
      const job = jobs[0];
      try {
        if (!enabled() || job.epoch !== epoch) throw refuse(tr('The form changed. Scan again.', 'تغيرت الفاتورة. أعد المسح.'));
        const label = await api('/inventory-units/prelabels/lookup?identifier=' + encodeURIComponent(job.code), { background: true });
        const id = String(label?.unitId || '').toLowerCase(), isPack = !!label?.isPack;
        const quantity = isPack ? Number(label.quantity) : 1;
        if (!/^[a-f\d]{24}$/.test(id) || !Number.isSafeInteger(quantity) || quantity < 1) throw refuse(tr('The label data is invalid.', 'بيانات الملصق غير صحيحة.'));
        if (label.state !== 'unused') throw refuse(tr('Already received on an earlier invoice.', 'مستلم على فاتورة سابقة.'));
        if (!(Number(label.printCount) > 0)) throw refuse(tr('This label was never printed — it cannot be on a piece.', 'هذا الملصق لم تُطلب طباعته — لا يمكن أن يكون على قطعة.'));
        if (!isPack && Number(label.piecesPerPack) > 1) throw refuse(tr('This piece is inside a pack. Scan the pack label.', 'هذه القطعة داخل باك. امسح ملصق الباك.'));
        const p = product(label.productId);
        if (!p) throw refuse(tr(`Product ${label.sku || ''} is not in the product list. Refresh the page.`, `المنتج ${label.sku || ''} غير موجود في قائمة الأصناف. حدّث الصفحة.`));
        if (allScans().some(scan => scan.id === id)) throw refuse(tr('Already scanned in this receipt.', 'مُسح بالفعل في هذا الاستلام.'));
        if (!enabled() || job.epoch !== epoch || verifying || outdated) throw refuse(tr('The form changed. Scan again.', 'تغيرت الفاتورة. أعد المسح.'));
        // Each scan is one more piece received (a pack: all of its pieces) on the product's line.
        let line = txItems.find(item => item.productId === p._id);
        if (!line) { const price = priceOf(p); line = { productId: p._id, qty: 0, price, _autoPrice: price }; txItems.push(line); }
        (line._prelabelScans ||= []).push({ id, isPack, quantity, code: label.manualCode || label.barcode || job.code, productId: String(p._id), batchId: label.batchId });
        line.qty = (Number(line.qty) || 0) + quantity;
        verified.add(id);
        if (typeof _dsbDismissed !== 'undefined') _dsbDismissed = false;
        markTxDirty(); renderTxItems(); calcTxSummary(); saveSession();
        feedback = { text: tr(`${p.name} · +${quantity} (now ${line.qty})`, `${p.name} · +${quantity} (أصبحت ${line.qty})`), code: job.code };
        sound('ok');
      } catch (error) {
        if (job.epoch === epoch) { feedback = { error: true, text: scanError(error), code: job.code }; sound('warn'); }
      } finally { if (jobs[0] === job) jobs.shift(); render(); }
    }
    running = false; render();
  }

  // ── restored scans are re-checked against the server before they can be used ───────────
  const REASONS = {
    linked: () => tr('received on another invoice', 'استُلم على فاتورة أخرى'), unprinted: () => tr('not printed', 'لم يُطبع'),
    'in-pack': () => tr('now inside a pack', 'أصبح داخل باك'), 'not-found': () => tr('no longer registered', 'لم يعد مسجلًا'),
    mismatch: () => tr('label data changed', 'تغيرت بيانات الملصق'), product: () => tr('belongs to another product now', 'أصبح لمنتج آخر'),
  };
  async function check(scans) {
    const unitIds = scans.filter(scan => !scan.isPack).map(scan => scan.id), packIds = scans.filter(scan => scan.isPack).map(scan => scan.id);
    const rows = [];
    for (let i = 0; i < Math.max(unitIds.length, packIds.length); i += 1000) {
      const result = await api('/inventory-units/prelabels/scan-check', { method: 'POST', background: true,
        body: JSON.stringify({ unitIds: unitIds.slice(i, i + 1000), packIds: packIds.slice(i, i + 1000) }) });
      rows.push(...(result.pieces || []), ...(result.packs || []));
    }
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return scans.map(scan => {
      const row = byId.get(scan.id);
      const reason = !row ? 'not-found' : row.state !== 'ok' ? row.state
        : String(row.productId) !== String(scan.productId) ? 'product' : scan.isPack && Number(row.quantity) !== Number(scan.quantity) ? 'mismatch' : '';
      return reason ? { code: scan.code, reason } : null;
    }).filter(Boolean);
  }
  function verifyRestored() {
    const pendingScans = allScans().filter(scan => !verified.has(scan.id));
    if (!active() || verifying || outdated || !pendingScans.length) return;
    verifyError = '';
    const startedEpoch = epoch;
    verifying = check(pendingScans).then(changedRows => {
      if (startedEpoch !== epoch) return;
      if (changedRows.length) outdated = { rows: changedRows };
      else pendingScans.forEach(scan => verified.add(scan.id));
    }).catch(() => { verifyError = tr('Could not check the saved codes with the server. Saving is blocked until they are checked.', 'تعذر التحقق من الأكواد المحفوظة مع الخادم. الحفظ متوقف حتى يتم التحقق.'); })
      .finally(() => { verifying = null; render(); });
    render();
  }
  async function resume() {
    const session = storedSession();
    if (!session || verifying) return;
    if (txItems.some(item => item.productId) && !(await showConfirm(tr('Replace the lines currently in the form with the saved scan session?', 'استبدال الأصناف الموجودة في النموذج بجلسة المسح المحفوظة؟')))) return;
    const lines = session.lines.filter(line => product(line.productId));
    if (lines.length !== session.lines.length) { toast(tr('A product in the saved session no longer exists. The session cannot be resumed.', 'منتج في الجلسة المحفوظة لم يعد موجودًا. لا يمكن استكمالها.'), true); return; }
    const scans = lines.flatMap(line => line.scans || []);
    verifying = Promise.resolve(); render();
    let changedRows;
    try { changedRows = scans.length ? await check(scans) : []; }
    catch (_) { verifying = null; toast(tr('Could not check the saved codes — try again when the connection is back.', 'تعذر التحقق من الأكواد المحفوظة — أعد المحاولة عند عودة الاتصال.'), true); render(); return; }
    verifying = null;
    if (changedRows.length) { outdated = { rows: changedRows, fromStorage: true }; render(); return; }
    scans.forEach(scan => verified.add(scan.id));
    const merged = new Map();
    for (const line of lines) {
      const row = merged.get(line.productId) || { productId: line.productId, qty: 0, price: line.price, _autoPrice: line.autoPrice };
      const own = (line.scans || []).reduce((sum, scan) => sum + Number(scan.quantity || 0), 0);
      row.qty += Math.max(Number(line.qty) || 0, own);
      if (line.scans?.length) (row._prelabelScans ||= []).push(...line.scans);
      merged.set(line.productId, row);
    }
    txItems = [...merged.values()];
    if (session.warehouse && window.SouliaWarehouses) { const select = document.getElementById('tx-warehouse'); if (select) select.value = session.warehouse; }
    feedback = { text: tr('Saved session restored. Continue scanning.', 'تمت استعادة الجلسة المحفوظة. تابع المسح.') };
    markTxDirty(); renderTxItems(); calcTxSummary(); saveSession();
  }
  async function discardSession() {
    if (!(await showConfirm(tr('Discard the saved scan session? Nothing was saved on the server.', 'تجاهل جلسة المسح المحفوظة؟ لم يُحفظ منها شيء على الخادم.')))) return;
    write(':session', null); outdated = null; render();
  }
  /** An outdated session is never continued: its scanned lines are dropped and scanning starts again. */
  function startOver() {
    write(':session', null);
    if (!outdated?.fromStorage) dropScans();
    outdated = null; verifyError = ''; epoch++; jobs.length = 0;
    feedback = { text: tr('Scanned lines removed. Scan the pieces again.', 'حُذفت الأسطر الممسوحة. أعد مسح القطع.') };
    markTxDirty(); renderTxItems(); calcTxSummary(); saveSession();
  }

  // ── save ────────────────────────────────────────────────────────────────────────────────
  /** Builds the receipt request on the invoice body; throws a message when the receipt is not ready. */
  function attach(body) {
    if (!active()) return;
    if (running || jobs.length) throw Error(tr('Wait until every scanned code has been checked.', 'انتظر انتهاء التحقق من كل الأكواد الممسوحة.'));
    if (verifying) throw Error(tr('The saved codes are still being checked.', 'لا يزال التحقق من الأكواد المحفوظة جاريًا.'));
    if (outdated) throw Error(tr('Some scanned codes changed on the server. Start the scanning again.', 'تغيرت بعض الأكواد الممسوحة على الخادم. ابدأ المسح من جديد.'));
    if (verifyError || allScans().some(scan => !verified.has(scan.id))) { verifyRestored(); throw Error(tr('The scanned codes must be checked with the server first.', 'يجب التحقق من الأكواد الممسوحة مع الخادم أولًا.')); }
    const valid = txItems.filter(item => item.productId);
    if (valid.some(item => Number(item.qty) < scanCount(item))) throw Error(tr('A line has fewer pieces than scanned codes. Remove a code to lower it.', 'سطر كميته أقل من أكواده الممسوحة. أزل كودًا لتقليلها.'));
    if (!valid.some(isScanLine)) throw Error(tr('No label was scanned. Scan the pieces, or use «Received in good condition · create barcodes».', 'لم يُمسح أي ملصق. امسح القطع، أو استخدم «استلمت القطع سليمة — إنشاء باركود».'));
    if (body.items.length !== valid.length) throw Error('Invoice lines changed while saving');
    const scans = valid.map((item, lineIndex) => isScanLine(item) ? { lineIndex,
      unitIds: item._prelabelScans.filter(scan => !scan.isPack).map(scan => scan.id),
      packIds: item._prelabelScans.filter(scan => scan.isPack).map(scan => scan.id) } : null).filter(Boolean);
    const invoice = Object.fromEntries(Object.entries(body).filter(([name]) => !name.startsWith('_')));
    const tracking = { physicalPossessionConfirmed: true, inspectionPassed: true, warehouseCode: body.warehouseCode || 'MAIN' };
    const fingerprint = JSON.stringify({ actor: actorId(), invoice: { ...invoice, date: invoice.transactionDate || '' }, scans, tracking });
    let request = storedPending();
    if (request && request.fingerprint !== fingerprint) throw Error(tr('A previous scan receipt was sent and its result is unknown. Retry it from «Pending scan receipt» first.', 'استلام بالمسح سابق أُرسل ونتيجته غير مؤكدة. أعد محاولته من «استلام بالمسح معلق» أولًا.'));
    if (!request) request = { fingerprint, operationKey: 'scanrcv-' + uuid(), invoice, tracking, scans,
      pieces: scans.reduce((sum, row) => sum + row.unitIds.length, 0) + valid.filter(isScanLine).reduce((sum, item) => sum + item._prelabelScans.filter(scan => scan.isPack).reduce((s, scan) => s + scan.quantity, 0), 0),
      unlabelled: valid.reduce((sum, item) => sum + looseCount(item), 0) };
    body._scanReceive = request;
  }
  function confirmHtml(body) {
    const r = body?._scanReceive; if (!r) return '';
    return `<div class="purchase-receipt psr-confirm"><strong>${html(tr('Receive by scanning', 'استلام بالمسح'))}</strong><p>${html(tr(`${r.pieces} scanned piece(s) are linked to their printed labels`, `${r.pieces} قطعة ممسوحة تُربط بملصقاتها المطبوعة`))}${r.unlabelled ? ' · ' + html(tr(`${r.unlabelled} without a label get new barcodes`, `${r.unlabelled} بدون ملصق يُنشأ لها باركود جديد`)) : ''}</p></div>`;
  }
  async function dispatch(request) {
    write(':pending', request);
    try {
      const result = await api('/inventory-units/purchases/receive-scanned', { method: 'POST',
        body: JSON.stringify({ operationKey: request.operationKey, invoice: request.invoice, tracking: request.tracking, scans: request.scans }) });
      if (!result?.transaction?._id || !result?.receipt) throw Object.assign(Error('Invalid receipt response'), { status: 0 });
      write(':pending', null); write(':session', null);
      return result;
    } catch (error) {
      // A definite refusal means the server rolled everything back; an unknown outcome stays pending for an identical retry.
      if ([400, 401, 403, 404, 409, 422].includes(error.status)) {
        write(':pending', null);
        if ([404, 409].includes(error.status)) { verified.clear(); setTimeout(verifyRestored, 0); }
        error.message = window.InventoryErrors?.translate?.(error.message, error.code, error.status, error.details) || error.message;
        throw error;
      }
      renderPending();
      throw Error(tr('The receipt result is unknown. Do not create another invoice — retry it from «Pending scan receipt».', 'نتيجة الاستلام غير مؤكدة. لا تنشئ فاتورة أخرى — أعد المحاولة من «استلام بالمسح معلق».'));
    }
  }
  async function save(body) {
    const result = await dispatch(body._scanReceive);
    return { ...result.transaction, _scanReceipt: result.receipt };
  }
  async function retryPending() {
    const request = storedPending(); if (!request) return;
    try {
      const result = await dispatch(request);
      toast(tr('The pending scan receipt was saved.', 'تم حفظ الاستلام بالمسح المعلق.'));
      if (typeof resetTx === 'function') resetTx();
      try { transactions = await loadTransactionSummaries(); } catch (_) { /* list refreshes on next load */ }
      showSummary(result.receipt);
    } catch (error) { toast(error.message, true); }
    render();
  }
  function renderPending() {
    document.querySelectorAll('[data-psr-pending]').forEach(el => { el.hidden = !storedPending(); });
  }

  // ── summary after save ──────────────────────────────────────────────────────────────────
  function showSummary(receipt) {
    if (!receipt) return;
    const lines = receipt.lines || [];
    const rows = lines.map(line => `<tr><td><strong dir="auto">${html(line.name || product(line.productId)?.name || line.sku || '')}</strong><bdi>${html(line.sku || '')}</bdi></td><td>${Number(line.receivedQty)}</td><td class="psr-sum-tags">${Number(line.linkedUnits)
      ? `<span class="psr-tag is-done">${html(tr(`${line.linkedUnits} scanned`, `${line.linkedUnits} ممسوحة`))}${line.packs ? ' · ' + html(tr(`${line.packs} pack(s)`, `${line.packs} باك`)) : ''}</span>` : ''}${Number(line.createdUnits)
      ? `<span class="psr-tag is-new">${html(tr(`${line.createdUnits} new barcode(s) — print`, `${line.createdUnits} باركود جديد — يحتاج طباعة`))}</span>` : ''}</td></tr>`).join('');
    const needPrint = Number(receipt.createdUnits) > 0;
    openModal(`<section class="purchase-receipt-summary psr-summary"><h3>${html(tr('Receipt by scan saved', 'تم حفظ الاستلام بالمسح'))}</h3>
      <div class="prs-totals"><span>${html(tr('Linked to printed labels', 'مربوطة بملصقات مطبوعة'))}<strong>${Number(receipt.linkedUnits || 0)}</strong></span><span>${html(tr('New barcodes (no label)', 'باركود جديد (بدون ملصق)'))}<strong>${Number(receipt.createdUnits || 0)}</strong></span></div>
      <div class="prs-table"><table><thead><tr><th>${html(tr('Product', 'المنتج'))}</th><th>${html(tr('Qty', 'الكمية'))}</th><th>${html(tr('Barcode', 'الباركود'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="prs-note">${needPrint ? html(tr('Pieces received without a label have new barcodes. Print their labels now, or later from Warehouse management like any receipt.', 'القطع المستلمة بدون ملصق لها باركود جديد. اطبع ملصقاتها الآن، أو لاحقًا من إدارة المخازن مثل أي استلام.'))
        : html(tr('Every piece carries its printed label. Nothing to print.', 'كل القطع تحمل ملصقاتها المطبوعة. لا يوجد ما يُطبع.'))}</p>
      <footer><button type="button" class="btn btn-outline" onclick="closeModal()">${html(tr('Close', 'إغلاق'))}</button>${needPrint && receipt.transactionId && hasPerm('inventory-units-view') ? `<button type="button" class="btn btn-primary" onclick="openPurchaseReceiptLabels('${html(receipt.transactionId)}')">${html(tr('Print new barcodes', 'طباعة الباركود الجديد'))}</button>` : ''}</footer></section>`);
  }

  // ── rendering ───────────────────────────────────────────────────────────────────────────
  function host() {
    let el = document.getElementById('tx-purchase-scanner');
    const items = document.getElementById('tx-items');
    if (!el && items) { el = document.createElement('div'); el.id = 'tx-purchase-scanner'; el.hidden = true; items.before(el); }
    return el;
  }
  function render() {
    const el = host(); if (!el) return;
    const checkbox = document.getElementById('tx-scan-receive');
    if (!mode && typeof txType !== 'undefined' && txType === 'مشتريات' && typeof txItems !== 'undefined' && txItems.some(isScanLine)) mode = true; // restored by a page snapshot
    if (checkbox) checkbox.checked = mode;
    el.hidden = !active();
    decorate();
    if (el.hidden) return;
    if (typeof txItems !== 'undefined' && allScans().some(scan => !verified.has(scan.id)) && !verifying && !outdated && !verifyError) verifyRestored();
    const typing = document.activeElement?.id === 'psr-code', draft = typing ? document.activeElement.value : '';
    const valid = txItems.filter(item => item.productId);
    const scanned = valid.reduce((sum, item) => sum + scanCount(item), 0);
    const loose = valid.reduce((sum, item) => sum + looseCount(item), 0);
    const productsCount = new Set(valid.map(item => item.productId)).size;
    const session = !valid.some(isScanLine) && !outdated ? storedSession() : null;
    const pending = storedPending();
    let body = '';
    if (pending) body += `<div class="sale-reader-feedback is-error psr-pending" data-psr-pending role="alert"><span>${html(tr('A scan receipt was sent and its result is unknown. Retry it — the server will not save it twice.', 'استلام بالمسح أُرسل ونتيجته غير مؤكدة. أعد المحاولة — الخادم لن يحفظه مرتين.'))}</span> <button type="button" data-psr-retry>${html(tr('Retry pending scan receipt', 'إعادة محاولة الاستلام المعلق'))}</button></div>`;
    if (outdated) body += `<div class="sale-reader-feedback is-error psr-outdated" role="alert"><strong>${html(tr('The saved session cannot be continued', 'لا يمكن استكمال الجلسة المحفوظة'))}</strong><span>${html(tr('These codes changed on the server since they were scanned:', 'هذه الأكواد تغيرت على الخادم منذ مسحها:'))}</span><ul>${outdated.rows.slice(0, 12).map(row => `<li><code dir="ltr">${html(row.code)}</code> — ${html((REASONS[row.reason] || REASONS.mismatch)())}</li>`).join('')}${outdated.rows.length > 12 ? `<li>+${outdated.rows.length - 12}</li>` : ''}</ul><button type="button" data-psr-restart>${html(tr('Start scanning again', 'بدء المسح من جديد'))}</button></div>`;
    else if (verifying) body += `<div class="sale-reader-feedback psr-checking" role="status"><span class="sale-reader-dot is-busy" aria-hidden="true"></span>${html(tr('Checking the saved codes with the server…', 'جارٍ التحقق من الأكواد المحفوظة مع الخادم…'))}</div>`;
    else if (verifyError) body += `<div class="sale-reader-feedback is-error" role="alert"><span>${html(verifyError)}</span> <button type="button" data-psr-recheck>${html(tr('Check again', 'إعادة التحقق'))}</button></div>`;
    if (session) {
      const own = line => (line.scans || []).reduce((s, scan) => s + Number(scan.quantity || 0), 0);
      const pieces = session.lines.reduce((sum, line) => sum + own(line), 0);
      const free = session.lines.reduce((sum, line) => sum + Math.max(0, Number(line.qty || 0) - own(line)), 0);
      const at = new Date(session.savedAt).toLocaleString(currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      body += `<div class="psr-resume" role="group"><span>${html(tr(`Saved scan session: ${pieces} scanned · ${free} without label · ${at}`, `جلسة مسح محفوظة: ${pieces} ممسوحة · ${free} بدون ملصق · ${at}`))}</span><button type="button" class="is-primary" data-psr-resume>${html(tr('Resume', 'استكمال'))}</button><button type="button" data-psr-discard>${html(tr('Discard', 'تجاهل'))}</button></div>`;
    }
    const busy = running || verifying;
    el.innerHTML = `<div class="sale-reader-bar"><span class="sale-reader-dot ${busy ? 'is-busy' : ''}" aria-hidden="true"></span><strong>${html(running ? tr('Checking scan… keep scanning', 'جارٍ التحقق… يمكنك متابعة المسح') : tr('Scanner ready — scan the QR on each piece or pack', 'الماسح جاهز — امسح QR على كل قطعة أو باك'))}</strong>${jobs.length > 1 ? `<span>${jobs.length - 1} ${html(tr('waiting', 'قيد الانتظار'))}</span>` : ''}</div>
      <div class="psr-counts" role="status" aria-live="polite"><span><b>${scanned}</b> ${html(tr('scanned', 'ممسوحة'))}</span><span><b>${loose}</b> ${html(tr('without label', 'بدون ملصق'))}</span><span><b>${productsCount}</b> ${html(tr('products', 'منتج'))}</span></div>
      <form data-psr-form><label for="psr-code">${html(tr('QR or U-code of the piece / pack', 'رمز QR أو كود U للقطعة / الباك'))}</label><div><input id="psr-code" dir="ltr" autocomplete="off" spellcheck="false" maxlength="160" value="${html(draft)}" ${outdated || verifying ? 'disabled' : ''} placeholder="${html(tr('Scan or type, then Enter', 'امسح أو اكتب ثم Enter'))}"><button type="submit" ${outdated || verifying ? 'disabled' : ''}>${html(tr('Add', 'إضافة'))}</button></div></form>
      <small>${html(tr('Each scan adds one piece (or a whole pack) to its product. A piece without a label: raise the quantity of its product with + (or «Add item») — it gets a new barcode on save.', 'كل مسحة تضيف قطعة (أو باكًا كاملًا) لمنتجها. قطعة ليس عليها ملصق: زد كمية المنتج بـ + (أو «إضافة صنف») — يُنشأ لها باركود جديد عند الحفظ.'))}</small>
      ${body}
      ${feedback ? `<div class="sale-reader-feedback ${feedback.error ? 'is-error' : 'is-success'}" role="${feedback.error ? 'alert' : 'status'}"><b aria-hidden="true">${feedback.error ? '!' : '✓'}</b> <span>${html(feedback.text)}</span>${feedback.code ? ` <code dir="ltr">${html(feedback.code)}</code>` : ''}</div>` : ''}`;
    const takeCode = () => { const input = el.querySelector('#psr-code'); const code = input.value; input.value = ''; submit(code); input.focus({ preventScroll: true }); };
    el.querySelector('[data-psr-form]').addEventListener('submit', event => { event.preventDefault(); takeCode(); });
    // ⚠ The page's global «Enter in a field submits the form» (handleEnterToSubmit) clicks «Save» on the transaction
    // page. A scanner ends every code with Enter (some with Tab), so the field claims those keys itself; the global
    // handler skips an Enter whose default is prevented.
    el.querySelector('#psr-code').addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) { event.preventDefault(); event.stopPropagation(); if (event.target.value.trim()) takeCode(); }
    });
    el.querySelector('[data-psr-retry]')?.addEventListener('click', retryPending);
    el.querySelector('[data-psr-restart]')?.addEventListener('click', startOver);
    el.querySelector('[data-psr-recheck]')?.addEventListener('click', () => { verifyError = ''; verifyRestored(); });
    el.querySelector('[data-psr-resume]')?.addEventListener('click', resume);
    el.querySelector('[data-psr-discard]')?.addEventListener('click', discardSession);
    if (typing) { const input = el.querySelector('#psr-code'); input?.focus({ preventScroll: true }); input?.setSelectionRange(draft.length, draft.length); }
  }
  function decorate() {
    document.querySelectorAll('#tx-items .tx-item-card').forEach((card, index) => {
      card.querySelector('.psr-line')?.remove();
      const item = typeof txItems !== 'undefined' ? txItems[index] : null;
      if (!active() || !item?.productId) return;
      const scans = item._prelabelScans || [], scanned = scanCount(item), loose = looseCount(item);
      const packs = scans.filter(scan => scan.isPack).length;
      // «−» cannot go below the scanned pieces: those leave only by removing their code.
      const minus = card.querySelector('.tx-item-qty button');
      if (minus) minus.disabled = Number(item.qty) <= Math.max(1, scanned);
      const wrap = document.createElement('div');
      wrap.className = 'sale-line-scan psr-line' + (scanned ? ' is-done' : '');
      const parts = [];
      if (scanned) parts.push(`<span class="psr-tag is-done">${html(tr(`${scanned} scanned`, `${scanned} ممسوحة`))}${packs ? ' · ' + html(tr(`${packs} pack(s)`, `${packs} باك`)) : ''}</span>`);
      if (loose) parts.push(`<span class="psr-tag is-new">${html(tr(`${loose} without label`, `${loose} بدون ملصق`))}</span><span class="psr-hint">${html(tr('new barcode on save', 'يُنشأ لها باركود جديد عند الحفظ'))}</span>`);
      const chips = scans.map((scan, scanIndex) => `<button type="button" dir="ltr" data-psr-unscan="${scanIndex}" aria-label="${html(tr('Remove scanned code ', 'إزالة الكود الممسوح ') + scan.code)}" title="${html(tr('Remove this code from the receipt', 'إزالة هذا الكود من الاستلام'))}">✓ ${html(scan.code)}${scan.isPack ? ' ×' + scan.quantity : ''} ×</button>`).join('');
      wrap.innerHTML = `<div class="sale-line-status psr-split">${parts.join('')}</div>` + (!scans.length ? '' : scans.length > 10
        ? `<details class="psr-codes"><summary>${html(tr(`Show ${scans.length} codes`, `عرض ${scans.length} كود`))}</summary><div class="sale-piece-codes">${chips}</div></details>`
        : `<div class="sale-piece-codes">${chips}</div>`);
      wrap.querySelectorAll('[data-psr-unscan]').forEach(button => { button.onclick = () => removeScan(index, Number(button.dataset.psrUnscan)); });
      card.querySelector('.tx-item-info')?.append(wrap);
    });
  }

  // ── keyboard-wedge scanners type anywhere on the page ───────────────────────────────────
  window.addEventListener('keydown', event => {
    if (!enabled() || (typeof _txSaving !== 'undefined' && _txSaving)) { buffer = ''; return; }
    if (document.querySelector('dialog[open], .modal-overlay.active, #tx-confirm-modal.active, #soulia-modal-overlay.active')) { buffer = ''; return; }
    if (event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) { buffer = ''; return; }
    const now = performance.now(); if (now - keyAt > 200) buffer = '';
    if ((event.key === 'Enter' || event.key === 'Tab') && buffer.length) { event.preventDefault(); event.stopImmediatePropagation(); const code = buffer; buffer = ''; submit(code); return; }
    const k = window.BarcodeInput?.key(event) || event.key;
    if (k.length === 1 && k !== ' ') { if (buffer.length < 161) buffer += k; keyAt = now; } else buffer = '';
  }, true);
  window.addEventListener('blur', () => { buffer = ''; });
  new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'dir'] });

  window.PurchaseScanReceive = { active, toggle, reset, render, changed, addManual, minimum,
    attach, confirmHtml, save, showSummary, submit, retryPending };
  render();
}());
