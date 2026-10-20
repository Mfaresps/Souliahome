/* Shared online-only identity validation. No unit creation, allocation or stock mutation. */
(function () {
  'use strict';
  const messages = {
    VALIDATED: ['Piece identified', 'تم التعرف على القطعة'],
    UNKNOWN_BARCODE: ['Unknown barcode or Unit ID.', 'الباركود أو معرف الوحدة غير معروف.'],
    WRONG_PRODUCT: ['This unit belongs to another product.', 'هذه الوحدة تخص صنفًا آخر.'],
    INVALID_UNIT_STATE: ['The unit state is not eligible for this operation.', 'حالة الوحدة لا تسمح بهذه العملية.'],
    DUPLICATE_SCAN: ['This unit was already scanned in this session.', 'تم مسح الوحدة بالفعل في جلسة المسح الحالية.'],
    UNAVAILABLE_UNIT: ['Unit unavailable; check assignment, source and reconciliation.', 'الوحدة غير متاحة؛ راجع التخصيص والمصدر والتسوية.'],
    PERMISSION_DENIED: ['Permission denied. Contact an administrator.', 'الصلاحية غير متاحة. تواصل مع المسؤول.'],
    UNRESOLVED: ['Network error or timeout: outcome unknown. Keep this request and check or retry it.', 'خطأ شبكة أو انتهاء مهلة: النتيجة غير معروفة. احتفظ بالطلب واستعلم عنه أو أعد محاولته.'],
    RESTORED_PENDING: ['A previous scan request is saved. Checking its result with the server.', 'يوجد طلب مسح سابق محفوظ. جار الاستعلام عن نتيجته من الخادم.'],
    REQUEST_PENDING: ['No confirmed result is available yet. Check again or retry the same saved request; do not start another request.', 'لم تتوفر نتيجة مؤكدة للطلب السابق بعد. استعلم مجددًا أو اضغط «إعادة محاولة المسح»؛ لا تبدأ طلبًا آخر.'],
    INVALID_INPUT: ['Enter a barcode or Unit ID without control characters.', 'أدخل الباركود أو معرف الوحدة دون رموز تحكم.'],
    BUSY: ['Resolve the current request before scanning another unit.', 'احسم نتيجة الطلب الحالي قبل مسح وحدة أخرى.'],
    CAMERA_DENIED: ['Camera permission denied. Use keyboard or manual entry.', 'تم رفض إذن الكاميرا. استخدم القارئ أو الإدخال اليدوي.'],
    CAMERA_UNSUPPORTED: ['Camera unavailable. HTTPS and a supported camera/browser are required.', 'الكاميرا غير متاحة. يلزم HTTPS وكاميرا ومتصفح يدعمانها.'],
    CAMERA_ERROR: ['Camera could not start or decode. Use manual entry or retry.', 'تعذر تشغيل الكاميرا أو قراءة الصورة. استخدم الإدخال اليدوي أو أعد المحاولة.'],
    STORAGE_ERROR: ['Cannot preserve the request safely. Scanning is blocked until browser session storage is available.', 'تعذر حفظ الطلب بأمان. المسح متوقف حتى تتاح مساحة تخزين الجلسة.'],
    REQUEST_REJECTED: ['Request rejected by the server.', 'رفض الخادم الطلب.'],
    NETWORK_ERROR: ['Could not load eligible units. Check the network and retry.', 'تعذر تحميل الوحدات المؤهلة. تحقق من الشبكة وأعد المحاولة.']
  };
  const text = (code, lang) => (messages[code] || messages.REQUEST_REJECTED)[lang === 'en' ? 0 : 1];
  const uuid = () => {
    if (!globalThis.crypto?.randomUUID) throw new Error('Secure context required');
    return globalThis.crypto.randomUUID();
  };
  function normalize(value, suffix = 'none') {
    if (typeof value !== 'string') throw new Error('INVALID_INPUT');
    // Strip the configured terminator, then correct recognized physical piece codes.
    if (suffix === 'Enter') value = value.replace(/[\r\n]+$/, '');
    else if (suffix === 'Tab') value = value.replace(/\t+$/, '');
    else if (suffix !== 'none') throw new Error('INVALID_INPUT');
    if (!value || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('INVALID_INPUT');
    value = window.BarcodeInput?.normalize(value) ?? value;
    return value;
  }
  class ScanClient {
    constructor({ api, actorId, workflowKey, context = { intent: 'lookup' }, storage, timeoutMs = 15000, onFeedback = () => {} }) {
      if (!actorId || !workflowKey || !api) throw new Error('Actor, workflow key and authenticated API required');
      this.api = api; this.timeoutMs = timeoutMs; this.feedback = onFeedback;
      this.storageKey = 'soulia-scan:v1:' + encodeURIComponent(actorId) + ':' + encodeURIComponent(workflowKey);
      this.context = JSON.parse(JSON.stringify(context)); this.busy = false; this.destroyed = false;
      try {
        this.storage = storage || globalThis.sessionStorage;
        const saved = JSON.parse(this.storage.getItem(this.storageKey) || 'null');
        // A workflow must resolve an old pending request before changing its context.
        if (saved?.pending && JSON.stringify(saved.context) !== JSON.stringify(this.context)) throw new Error('Pending scan context differs; restore the original context to resolve it');
        this.sessionKey = saved && JSON.stringify(saved.context) === JSON.stringify(this.context) ? saved.sessionKey : uuid(); this.pending = saved?.pending || null;
        this.hadUnresolved = !!this.pending;
        this.persist();
      } catch (error) { this.storageError = true; this.feedback('STORAGE_ERROR', error.message); }
    }
    persist() {
      this.storage.setItem(this.storageKey, JSON.stringify({ context: this.context, sessionKey: this.sessionKey, pending: this.pending }));
    }
    notify(code, result) { if (!this.destroyed) this.feedback(code, result); }
    async request(path, options) {
      const controller = new AbortController(); let timer;
      try {
        return await Promise.race([
          this.api('/inventory-units/scans' + path, { ...options, signal: controller.signal }),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Unresolved timeout')); }, this.timeoutMs); })
        ]);
      } finally { clearTimeout(timer); }
    }
    async submit(value, inputMethod = 'manual-entry', extra = {}) {
      if (this.busy || this.pending) { this.notify('BUSY'); return; }
      if (this.storageError || this.destroyed) { this.notify('STORAGE_ERROR'); return; }
      let identifier;
      try { identifier = normalize(value, inputMethod === 'keyboard' ? extra.suffix || 'Enter' : 'none'); }
      catch { this.notify('INVALID_INPUT'); return; }
      this.pending = { ...this.context, sessionKey: this.sessionKey, identifier, inputMethod, operationKey: uuid(),
        reason: inputMethod === 'manual-selection' ? extra.reason : 'Operator requested online unit identity validation',
        ...(inputMethod === 'manual-selection' ? { manualSelectionConfirmed: extra.confirmed === true } : {}) };
      this.hadUnresolved = false;
      try { this.persist(); } catch { this.storageError = true; this.notify('STORAGE_ERROR'); return; }
      return this.retry();
    }
    async resolve(queryOnly) {
      if (!this.pending || this.busy || this.storageError || this.destroyed) return;
      this.busy = true;
      try {
        const response = queryOnly ? await this.request('/operations/' + encodeURIComponent(this.pending.operationKey)) :
          await this.request('/validate', { method: 'POST', body: JSON.stringify(this.pending) });
        // A newer mount may now own this storage slot. Never clear its pending request.
        if (this.destroyed) return;
        if (queryOnly && response.state !== 'resolved') { this.hadUnresolved = true; this.notify('REQUEST_PENDING'); return; }
        const result = queryOnly ? response.result : response;
        if (!['accepted', 'rejected'].includes(result?.outcome) || !result.operationId || !result.code) throw new Error('Invalid server response');
        const prior = this.pending, priorSession = this.sessionKey; this.pending = null;
        // Lookup scans are independent reads; the next scan needs no manual session reset.
        // Operational contexts keep their session-wide duplicate protection.
        if (this.context.intent === 'lookup') this.sessionKey = uuid();
        try { this.persist(); } catch { this.pending = prior; this.sessionKey = priorSession; this.storageError = true; this.notify('STORAGE_ERROR'); return; }
        this.notify(result.code, result); return result;
      } catch (error) {
        if (this.destroyed) return;
        // Only a definitive validation/auth denial proves this request was rejected.
        // 5xx, disconnects, timeout, malformed responses and conflicts retain the exact key/payload.
        // A denial on a later attempt cannot prove an earlier uncertain attempt failed.
        if ([400, 401, 403, 422].includes(error.status) && !queryOnly && !this.hadUnresolved) {
          const prior = this.pending; this.pending = null;
          try { this.persist(); } catch { this.pending = prior; this.storageError = true; this.notify('STORAGE_ERROR'); return; }
          this.notify([401, 403].includes(error.status) ? 'PERMISSION_DENIED' : 'REQUEST_REJECTED');
        } else {
          this.hadUnresolved = true;
          this.notify([401, 403].includes(error.status) ? 'PERMISSION_DENIED' : 'UNRESOLVED');
        }
      } finally { this.busy = false; }
    }
    retry() { return this.resolve(false); }
    check() { return this.resolve(true); }
    async eligible(q = '', cursor = '') {
      const query = new URLSearchParams({ ...this.context, sessionKey: this.sessionKey, q, ...(cursor ? { cursor } : {}) });
      return this.request('/eligible?' + query);
    }
    destroy() { this.destroyed = true; }
  }
  let library;
  function loadCameraLibrary() {
    if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
    if (!library) library = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/vendor/zxing-browser-0.2.1.min.js';
      script.onload = () => window.ZXingBrowser ? resolve(window.ZXingBrowser) : reject(new Error('Decoder unavailable'));
      script.onerror = () => { script.remove(); library = null; reject(new Error('Decoder unavailable')); }; document.head.append(script);
    });
    return library;
  }
  function mount(root, options) {
    const lang = options.lang || 'ar', tr = (en, ar) => lang === 'en' ? en : ar;
    root.classList.add('iu-scanner');
    root.innerHTML = `<h2>${tr('Scan a physical unit', 'مسح وحدة فعلية')}</h2>
      <p class="iu-scanner-device" data-scan-device data-state="waiting" role="status" aria-live="polite">${tr('Barcode scanner: waiting for a scan', 'قارئ الباركود: في انتظار المسح')}</p>
      <form data-scan-form><label>${tr('Barcode / Unit ID', 'الباركود / معرف الوحدة')}<input data-scan-input autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="160" dir="ltr"></label>
      <label>${tr('Scanner suffix', 'لاحقة القارئ')}<select data-scan-suffix><option value="Enter">Enter / CR / LF</option><option value="Tab">Tab</option><option value="none">${tr('None — use Validate', 'بدون — استخدم تحقق')}</option></select></label><button class="btn btn-outline" data-scan-submit>${tr('Validate', 'تحقق')}</button></form>
      <div class="iu-scanner-actions"><button type="button" class="btn btn-outline" data-scan-camera>${tr('Start camera', 'تشغيل الكاميرا')}</button><button type="button" class="btn btn-outline" data-scan-stop disabled>${tr('Stop camera', 'إيقاف الكاميرا')}</button>
      <button type="button" class="btn btn-outline" data-scan-check hidden disabled>${tr('Check pending request', 'التحقق من نتيجة المسح')}</button><button type="button" class="btn btn-outline" data-scan-retry hidden disabled>${tr('Retry same request', 'إعادة محاولة المسح')}</button></div>
      <video data-scan-video playsinline muted hidden></video><p data-scan-message role="status" aria-live="polite" tabindex="-1"></p><p data-scan-pending dir="ltr"></p>
      <details data-scan-manual ${options.canManualSelect ? '' : 'hidden'}><summary>${tr('Select an eligible unit manually', 'اختيار وحدة مؤهلة يدويًا')}</summary>
      <label>${tr('Exact barcode / Unit ID (optional)', 'باركود / معرف وحدة مطابق (اختياري)')}<input data-scan-filter maxlength="160"></label><button class="btn btn-outline" type="button" data-scan-load>${tr('Load eligible units', 'تحميل الوحدات المؤهلة')}</button>
      <label>${tr('Eligible units', 'الوحدات المؤهلة')}<select data-scan-choice><option value="">${tr('Load and select a unit', 'حمّل واختر وحدة')}</option></select></label><button type="button" class="btn btn-outline" data-scan-more hidden>${tr('Next eligible units', 'الوحدات المؤهلة التالية')}</button>
      <label>${tr('Override reason', 'سبب الاختيار اليدوي')}<input data-scan-reason maxlength="1000"></label><label><input type="checkbox" data-scan-confirm>${tr('I confirm this exact unit selection.', 'أؤكد اختيار هذه الوحدة بعينها.')}</label><button type="button" class="btn btn-outline" data-scan-select>${tr('Confirm manual selection', 'تأكيد الاختيار اليدوي')}</button></details>`;
    const get = name => root.querySelector('[data-scan-' + name + ']');
    let stopped = false, controls, stream, cameraGeneration = 0, cameraStarting = false, nextCursor = '', filter = '';
    let client, processing = false, lastCameraValue = '', lastCameraSeen = 0;
    const scanQueue = [];
    function update() {
      if (!client || stopped) return;
      const blocked = client.busy || !!client.pending || client.storageError;
      const inputBlocked = client.storageError || (!!client.pending && client.hadUnresolved);
      get('submit').disabled = inputBlocked; get('input').disabled = inputBlocked; get('select').disabled = blocked;
      get('camera').disabled = blocked || cameraStarting || !!stream;
      get('check').disabled = get('retry').disabled = !client.pending || client.busy || client.storageError;
      const needsRecovery = !!client.pending && !!client.hadUnresolved;
      get('check').hidden = get('retry').hidden = !needsRecovery;
      get('pending').hidden = !needsRecovery;
      get('pending').textContent = client.pending ? 'Request: ' + client.pending.operationKey : '';
    }
    function feedback(code, result) {
      get('message').textContent = text(code, lang) + (result?.unit ? ' ' + (result.unit.manualCode || result.unit.barcode) : '');
      if (code === 'VALIDATED') {
        const label = document.createElement('span'); label.textContent = text(code, lang);
        const identity = document.createElement('bdi'); identity.dir = 'ltr'; identity.textContent = result?.unit?.manualCode || result?.unit?.barcode || '';
        get('message').replaceChildren(label, identity);
      }
      get('message').dataset.level = code === 'VALIDATED' ? 'success' : ['DUPLICATE_SCAN', 'UNRESOLVED', 'RESTORED_PENDING', 'REQUEST_PENDING', 'BUSY'].includes(code) ? 'warning' : 'error';
      if (code === 'VALIDATED' && ['returned-to-supplier', 'supplier-return-pending'].includes(result?.unit?.status)) {
        get('message').textContent = (window.SupplierReturnPieces?.returnMessage(result.supplierReturn, result.unit.status === 'supplier-return-pending') || tr('Piece linked to a supplier return', 'القطعة مرتبطة بمرتجع مورد')) + ' · ' + (result.unit.manualCode || result.unit.barcode);
        get('message').dataset.level = 'warning';
      }
      options.onResult?.(code, result); update();
    }
    client = new ScanClient({ ...options, onFeedback: feedback });
    async function drainQueue() {
      if (processing || stopped || client.busy || client.pending || client.storageError) return;
      processing = true;
      try {
        while (!stopped && scanQueue.length && !client.pending && !client.storageError) {
          const scan = scanQueue.shift();
          const task = client.submit(scan.value, scan.method, scan.extra); update(); await task; update();
        }
      } finally {
        processing = false;
        if (!stopped && !client.pending && !client.storageError) get('input').focus();
      }
    }
    function run(value, method, extra) {
      if (stopped || client.storageError || (client.pending && client.hadUnresolved)) { feedback('BUSY'); return; }
      try { normalize(value, method === 'keyboard' ? extra?.suffix || 'Enter' : 'none'); }
      catch { feedback('INVALID_INPUT'); get('input').focus(); return; }
      scanQueue.push({ value, method, extra });
      if (method !== 'camera') get('input').value = '';
      void drainQueue();
    }
    get('form').onsubmit = event => { event.preventDefault(); run(get('input').value, 'manual-entry'); };
    let recentKeys = [], scannerDetected = false, physicalKeys = '', physicalKeyAt = 0;
    function showDeviceState(detected) {
      if (detected) scannerDetected = true;
      const device = get('device');
      device.dataset.state = scannerDetected ? 'detected' : 'waiting';
      device.textContent = scannerDetected
        ? tr('Barcode scanner detected — last scan received', 'تم اكتشاف قارئ الباركود — وصل آخر مسح')
        : tr('Barcode scanner: waiting for a scan', 'قارئ الباركود: في انتظار المسح');
    }
    get('input').onkeydown = event => {
      const now = performance.now();
      if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.repeat) {
        let key = event.key;
        if (/^Key[A-Z]$/.test(event.code || '')) key = event.code.slice(3);
        else if (/^(?:Digit|Numpad)\d$/.test(event.code || '')) key = event.code.slice(-1);
        else if (['Minus','NumpadSubtract'].includes(event.code)) key = '-';
        if (key.length === 1) {
          if (now - physicalKeyAt > 250) physicalKeys = '';
          physicalKeys = (physicalKeys + key).slice(-160);physicalKeyAt = now;
        } else if (!['Shift','CapsLock','Enter','Tab'].includes(event.key)) physicalKeys = '';
      }
      if (event.isComposing || event.repeat || event.ctrlKey || event.altKey || event.metaKey) { if (event.repeat && ['Enter', 'Tab'].includes(event.key)) event.preventDefault(); return; }
      if (event.key.length === 1) {
        const now = performance.now();
        recentKeys = recentKeys.filter(time => now - time < 500);
        recentKeys.push(now);
      }
      if (event.key === get('suffix').value && ['Enter', 'Tab'].includes(event.key)) {
        if (recentKeys.length >= 4 && recentKeys[recentKeys.length - 1] - recentKeys[recentKeys.length - 4] < 300) showDeviceState(true);
        recentKeys = [];
        const recognized = /^(?:(?:SU|PK)-[A-F\d]{24}|PK-?\d{6}-?\d|[A-F\d]{24}|U-?\d{4}-?\d{4}-?\d|\d{9})$/i;
        const value = window.BarcodeInput?.normalize(get('input').value) ?? get('input').value;
        const physical = window.BarcodeInput?.normalize(physicalKeys) ?? physicalKeys;
        const scan = !recognized.test(value) && now - physicalKeyAt < 250 && recognized.test(physical) ? physical : value;
        physicalKeys = '';
        event.preventDefault(); run(scan, 'keyboard', { suffix: get('suffix').value });
      }
      else if (event.key === 'Enter') event.preventDefault();
    };
    async function resolvePending(method) {
      const task = client[method](); update(); await task;
      if (stopped) return;
      update(); if (!client.pending && !client.storageError) { get('input').value = ''; get('input').focus(); void drainQueue(); }
    }
    for (const method of ['check', 'retry']) get(method).onclick = () => resolvePending(method);
    function stopCamera() {
      cameraGeneration++; cameraStarting = false;
      try { controls?.stop(); } catch { /* Always release our own tracks even if decoder cleanup fails. */ } finally {
        controls = null; stream?.getTracks().forEach(track => track.stop()); stream = null;
        get('video').srcObject = null; get('video').hidden = true; get('stop').disabled = true; update();
      }
    }
    get('stop').onclick = stopCamera;
    get('camera').onclick = async () => {
      if (cameraStarting || stream || client.pending || stopped) return;
      if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) { feedback('CAMERA_UNSUPPORTED'); return; }
      const generation = ++cameraGeneration; cameraStarting = true; get('stop').disabled = false; update();
      try {
        const decoder = await loadCameraLibrary();
        if (stopped || generation !== cameraGeneration) return;
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
        if (stopped || generation !== cameraGeneration) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired; get('video').hidden = false;
        const reader = new decoder.BrowserQRCodeReader();
        const active = await reader.decodeFromStream(stream, get('video'), (result, error, scannerControls) => {
          if (stopped || generation !== cameraGeneration || !result) return;
          // Keep the camera running, but do not submit the same code on every frame.
          const value = result.getText(), now = performance.now();
          const repeatedFrame = value === lastCameraValue && now - lastCameraSeen < 1500;
          if (repeatedFrame) { lastCameraSeen = now; return; }
          if (client.busy || client.pending || processing || scanQueue.length || client.storageError) return;
          lastCameraValue = value; lastCameraSeen = now;
          run(value, 'camera');
        });
        if (stopped || generation !== cameraGeneration) active.stop(); else controls = active;
      } catch (error) {
        if (!stopped && generation === cameraGeneration) { stopCamera(); feedback(['NotAllowedError', 'SecurityError'].includes(error.name) ? 'CAMERA_DENIED' : error.name === 'NotFoundError' ? 'CAMERA_UNSUPPORTED' : 'CAMERA_ERROR'); }
      } finally { if (generation === cameraGeneration) cameraStarting = false; update(); }
    };
    async function loadEligible(cursor = '') {
      if (!options.canManualSelect) return;
      get('load').disabled = get('more').disabled = true;
      try {
        const data = await client.eligible(filter, cursor); const choice = get('choice'); choice.replaceChildren(new Option(tr('Choose a unit', 'اختر وحدة'), ''));
        for (const unit of data.units) choice.append(new Option((unit.manualCode || unit.barcode) + ' · ' + unit.status, unit._id));
        nextCursor = data.nextCursor || ''; get('more').hidden = !nextCursor;
        if (!data.units.length) get('message').textContent = tr('No eligible units on this page.', 'لا توجد وحدات مؤهلة في هذه الصفحة.');
      } catch (error) { feedback([401, 403].includes(error.status) ? 'PERMISSION_DENIED' : 'NETWORK_ERROR'); }
      finally { get('load').disabled = get('more').disabled = false; }
    }
    get('load').onclick = () => { filter = window.BarcodeInput?.normalize(get('filter').value) ?? get('filter').value; loadEligible(); };
    get('more').onclick = () => loadEligible(nextCursor);
    get('select').onclick = () => {
      if (!get('choice').value || !get('confirm').checked || !get('reason').value.trim()) { get('message').textContent = tr('Select a server-listed unit, confirm it and enter a reason.', 'اختر وحدة من قائمة الخادم وأكدها وأدخل السبب.'); get('message').focus(); return; }
      run(get('choice').value, 'manual-selection', { confirmed: true, reason: get('reason').value }); get('confirm').checked = false;
    };
    const visibility = () => { if (document.hidden) stopCamera(); };
    const pagehide = () => stopCamera();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
    const observer = new MutationObserver(() => {
      const page = root.closest('[id^="page-"]');
      if (!root.isConnected || root.closest('[hidden],.hidden') || (page && getComputedStyle(page).display === 'none')) destroy();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    function destroy() { if (stopped) return; stopped = true; stopCamera(); client.destroy(); observer.disconnect(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); }
    if (client.storageError) feedback('STORAGE_ERROR');
    else if (client.pending) {
      feedback('RESTORED_PENDING');
      // Read only: reopening never automatically repeats a scan or creates a new operation.
      void resolvePending('check');
    }
    update(); if (!client.pending && !client.storageError) get('input').focus();
    return { client, destroy, stopCamera };
  }
  window.SouliaScanner = { ScanClient, normalize, mount };
}());
