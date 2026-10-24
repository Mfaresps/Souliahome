(function () {
  'use strict';
  let settings, loading = false, token = '', generation = 0, renderedLanguage = '';
  const english = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const text = (ar, en) => english() ? en : ar;
  const englishLabels = {
    performance: ['Points & weekly performance', 'Your earned/deducted points and weekly summary.'],
    otp: ['OTP requests', 'Employee, requested action, reference and active OTP code. Admin only.'],
    approval: ['Modifications & approvals', 'Requests, pending approvals and approved or rejected actions.'],
    shopifyChange: ['Shopify order changes', 'Changed address, price, quantity, products and other order fields.'],
    security: ['Security alerts', 'Failed logins, OTP failures and supported security events.'],
    enabled: ['Enable notifications', 'Pause delivery without changing your category preferences.'],
    deposit: ['New deposit', 'Deposit amounts, employee names and order references.'],
    comment: ['Comments & follow-ups', 'The commenter’s name and a short excerpt.'],
    followup: ['New follow-up', 'When a new follow-up ticket is created.'],
    order: ['New order', 'When a new order is first saved in SOULIA.'],
    orderEdit: ['Order edit decisions', 'Approval or rejection of your requested order changes.'],
    deliveryProblem: ['Delivery issues', 'Failed attempts or returns before delivery.'],
    delivered: ['Successful delivery', 'Confirmed delivery updates from your carrier.'],
    mention: ['Mentions', 'When a colleague mentions you in a comment.'],
  };
  const translations = {
    'تم حفظ الإعدادات.': 'Preferences saved.',
    'هذا المتصفح لا يدعم الإشعارات، أو الاتصال ليس HTTPS.': 'Push notifications require a supported browser and HTTPS.',
    'الإذن مرفوض — اسمحي بالإشعارات من إعدادات الجهاز.': 'Permission denied. Allow notifications in your device settings.',
    'هذا الجهاز مشترك في الإشعارات.': 'Notifications are enabled on this device.',
    'هذا الجهاز غير مشترك بعد.': 'This device is not connected yet.',
    'الإرسال غير جاهز: يلزم ضبط مفاتيح VAPID على السيرفر.': 'Notifications are not configured on the server yet.',
    'تعذر قراءة حالة الجهاز.': 'Unable to check device status.',
    'أضيفي SOULIA إلى الشاشة الرئيسية وافتحيه منها أولًا.': 'Add SOULIA to your Home Screen and open it from there first.',
    'لم يتم منح إذن الإشعارات. يمكنك تغييره من إعدادات الجهاز.': 'Notification permission was not granted. Change it in your device settings.',
    'تم تفعيل الإشعارات لهذا الجهاز.': 'Notifications enabled on this device.',
    'تم إلغاء اشتراك هذا الجهاز.': 'This device has been disconnected.',
    'تمت إضافة الإشعار التجريبي لطابور الإرسال.': 'Test notification queued for delivery.',
    'الإشارة غير متاحة لهذا الحساب.': 'This mention is not available to this account.',
  };
  const labels = {
    performance: ['النقاط والأداء الأسبوعي', 'نقاطك المضافة والمخصومة وملخص أدائك الأسبوعي.'],
    otp: ['طلبات OTP', 'الموظف والإجراء والمرجع وكود OTP الساري. للأدمن فقط.'],
    approval: ['التعديلات والموافقات', 'الطلبات المعلقة والإجراءات المقبولة أو المرفوضة.'],
    shopifyChange: ['تعديلات طلبات شوبيفاي', 'تغييرات العنوان والسعر والكمية والمنتجات وبيانات الطلب.'],
    security: ['تنبيهات الأمان', 'محاولات الدخول الفاشلة وفشل OTP والأحداث الأمنية المسجلة.'],
    enabled: ['تفعيل جميع الإشعارات', 'إيقافها يحفظ اختيارات الأنواع كما هي.'],
    deposit: ['عربون جديد', 'اسم الموظف وقيمة العربون ورقم الطلب.'],
    comment: ['تعليق أو تعليق متابعة', 'اسم صاحب التعليق ومقتطف مختصر من محتواه.'],
    followup: ['متابعة جديدة', 'عند إنشاء تذكرة متابعة جديدة في النظام.'],
    order: ['طلب جديد', 'عند تسجيل الطلب لأول مرة في النظام.'],
    orderEdit: ['قرار تعديل الطلب', 'إشعار قبول أو رفض التعديل الذي طلبته.'],
    deliveryProblem: ['مشكلة في التسليم', 'محاولة فاشلة أو مرتجع قبل التسليم وفق حالات Bosta.'],
    delivered: ['تم التسليم بنجاح', 'عند تأكيد التسليم من شركة الشحن.'],
    mention: ['إشارة إليك (منشن)', 'عندما يشير أحد الزملاء إليك في تعليق.'],
  };
  const supported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const iphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function activationGuide() {
    const mobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent) || iphone();
    const first = iphone() && !standalone()
      ? text('على الآيفون: افتح SOULIA في Safari، ثم مشاركة ← إضافة إلى الشاشة الرئيسية. افتح النظام من الأيقونة الجديدة (iOS 16.4 أو أحدث).', 'On iPhone: open SOULIA in Safari, choose Share → Add to Home Screen, then launch its icon (iOS 16.4 or later).')
      : mobile ? text('افتح SOULIA من متصفح الهاتف أو من أيقونة التطبيق المثبتة على الشاشة الرئيسية.', 'Open SOULIA in your phone browser or from the installed Home Screen icon.')
      : text('افتح SOULIA من متصفح يدعم الإشعارات مثل Chrome أو Edge أو Safari، وسجّل الدخول.', 'Open SOULIA in a supported browser such as Chrome, Edge or Safari, and sign in.');
    return '<div class="push-activation-guide"><h4>' + text('خطوات تفعيل الإشعارات', 'Activate notifications') + '</h4><ol><li><span>STEP 01</span><p>' + first + '</p></li><li><span>STEP 02</span><p>' + text('اضغط «تفعيل الإشعارات»، ثم اختر «السماح» في رسالة المتصفح. إذا سبق رفض الإذن، اسمح بالإشعارات من إعدادات الموقع أو الجهاز ثم حاول مجددًا.', 'Click Enable notifications, then choose Allow in the browser prompt. If permission was denied earlier, allow notifications in site or device settings and try again.') + '</p></li></ol></div>';
  }
  function errorMessage(error) {
    if (/push service|push server|registration failed/i.test(error?.message || '')) return text(
      'تعذر تسجيل الجهاز لدى خدمة إشعارات المتصفح. جرّبي متصفحًا عاديًا دون وضع التصفح الخاص، وتحققي من اتصال الإنترنت وإعدادات الإشعارات. يمكنك أيضًا التجربة على شبكة أو متصفح آخر.',
      'Your browser could not connect to its push service. Use a regular browser window, check your connection and notification settings, or try another network or browser.');
    return error?.message || text('تعذر إكمال العملية. حاولي مرة أخرى.', 'Unable to complete the action. Please try again.');
  }
  function message(text, error) {
    const el = document.getElementById('push-feedback');
    if (el) { el.textContent = english() ? translations[text] || text : text; el.dataset.error = String(!!error); }
  }
  async function deviceStatus() {
    const el = document.getElementById('push-device-status');
    if (!el) return;
    if (!supported()) { el.textContent = text('هذا المتصفح لا يدعم الإشعارات، أو الاتصال ليس HTTPS.', 'Push notifications require a supported browser and HTTPS.'); el.dataset.state = 'unsupported'; return; }
    if (!settings?.configured) {
      el.dataset.state = 'unconfigured';
      el.textContent = text('الإشعارات غير جاهزة على الخادم. اضغط التفعيل للتحقق مجددًا.', 'Notifications are not ready on the server. Click Enable to check again.');
      document.querySelectorAll('#notification-settings [data-push-action]').forEach(button => button.disabled = button.dataset.pushAction !== 'enable');
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    document.querySelectorAll('#notification-settings [data-push-action]').forEach(button => {
      button.disabled = !settings?.configured || !supported() || (button.dataset.pushAction !== 'enable' && !subscription);
    });
    const connected = !!subscription && Notification.permission !== 'denied' && settings.preferences.enabled && settings.devices > 0;
    document.querySelectorAll('#notification-settings [data-push-action="enable"], #notification-settings .push-activation-guide').forEach(element => element.hidden = connected);
    el.dataset.state = Notification.permission === 'denied' ? 'denied' : subscription ? 'connected' : 'disconnected';
    el.textContent = Notification.permission === 'denied' ? text('الإذن مرفوض — اسمحي بالإشعارات من إعدادات الجهاز.', 'Permission denied. Allow notifications in your device settings.') : subscription ? text('هذا الجهاز مشترك في الإشعارات.', 'Notifications are enabled on this device.') : text('هذا الجهاز غير مشترك بعد.', 'This device is not connected yet.');
  }
  function render() {
    const panel = document.getElementById('notification-settings');
    panel.replaceChildren();
    panel.dir = english() ? 'ltr' : 'rtl'; panel.lang = english() ? 'en' : 'ar'; renderedLanguage = panel.lang;
    const icons = {
      performance: '<path d="M12 3l3 6 6 1-4 5 1 6-6-3-6 3 1-6-4-5 6-1z"/>',
      otp: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
      approval: '<path d="M9 3h6v4H9zM6 5H4v16h16V5h-2M8 14l3 3 5-6"/>',
      shopifyChange: '<path d="M4 7h16v14H4zM8 7V5a4 4 0 0 1 8 0v2M9 13h6M12 10v6"/>',
      security: '<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM12 8v5M12 16h.01"/>',
      enabled: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
      deposit: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>',
      comment: '<path d="M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3zM7 8h10M7 12h7"/>',
      followup: '<path d="M9 5h6M9 3h6v4H9zM6 5H4v16h16V5h-2M8 12h8M8 16h5"/>',
      order: '<path d="M4 7h16v14H4zM8 7V5a4 4 0 0 1 8 0v2M8 11v1M16 11v1"/>',
      deliveryProblem: '<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>',
      delivered: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
      mention: '<circle cx="12" cy="12" r="4"/><path d="M16 8v7a2 2 0 0 0 4 0v-3a8 8 0 1 0-3 6"/>',
    };
    const icon = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;
    const header = document.createElement('div'); header.className = 'push-heading';
    header.innerHTML = `<span class="push-heading-icon">${icon('enabled')}</span><div><h3>${text('إعدادات الإشعارات', 'Notification settings')}</h3><p>${text('اختاري التنبيهات التي تهمك وأديري أجهزتك.', 'Choose what you hear about and manage your devices.')}</p></div>`; panel.append(header);
    const grid = document.createElement('div'); grid.className = 'push-category-grid';
    for (const [key, [title, explanation]] of Object.entries(english() ? englishLabels : labels)) {
      if (key !== 'enabled' && !(settings.allowedTypes || ['deposit', 'comment', 'followup', 'order', 'deliveryProblem', 'delivered', 'mention']).includes(key)) continue;
      const row = document.createElement('label'); row.className = 'push-setting-row' + (key === 'enabled' ? ' push-master' : ''); row.dataset.category = key;
      const symbol = document.createElement('span'); symbol.className = 'push-category-icon'; symbol.innerHTML = icon(key);
      const copy = document.createElement('span'); copy.className = 'push-setting-copy'; const heading = document.createElement('strong'); heading.textContent = title;
      const description = document.createElement('small'); description.textContent = explanation; copy.append(heading, description); row.title = explanation;
      const toggle = document.createElement('span'); toggle.className = 'push-switch';
      const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.setAttribute('aria-label', title); input.checked = !!settings.preferences[key]; input.dataset.preference = key;
      const track = document.createElement('span'); track.className = 'push-switch-track'; track.setAttribute('aria-hidden', 'true'); toggle.append(input, track);
      input.addEventListener('change', async () => {
        input.disabled = true; const previous = !input.checked;
        try { settings = await api('/notifications/preferences', { method: 'PATCH', body: JSON.stringify({ [key]: input.checked }) }); message('تم حفظ الإعدادات.'); if (key === 'enabled' && !input.checked) { offeredTo = ''; try { localStorage.removeItem(promptKey()); } catch (_) {} } await deviceStatus(); }
        catch (error) { input.checked = previous; message(error.message, true); }
        finally { input.disabled = false; }
      }); row.append(symbol, copy, toggle); (key === 'enabled' ? panel : grid).append(row);
    }
    const categoriesTitle = document.createElement('h4'); categoriesTitle.className = 'push-section-title'; categoriesTitle.textContent = text('أنواع الإشعارات', 'Notification categories'); panel.append(categoriesTitle, grid);
    const languageRow = document.createElement('div'); languageRow.className = 'push-language-row';
    const languageLabel = document.createElement('label'); languageLabel.htmlFor = 'push-language'; languageLabel.innerHTML = `<strong>${text('لغة الإشعارات', 'Notification language')}</strong><small>${text('اللغة المستخدمة في التنبيهات المرسلة إلى أجهزتك.', 'The language of notifications sent to your devices.')}</small>`;
    const languageSelect = document.createElement('select'); languageSelect.id = 'push-language';
    languageSelect.innerHTML = '<option value="ar">العربية</option><option value="en">English</option>'; languageSelect.value = settings.language || (english() ? 'en' : 'ar');
    languageSelect.addEventListener('change', async () => { languageSelect.disabled = true; try { settings = await api('/notifications/preferences', { method: 'PATCH', body: JSON.stringify({ language: languageSelect.value }) }); message('تم حفظ الإعدادات.'); } catch (error) { languageSelect.value = settings.language || 'ar'; message(error.message, true); } finally { languageSelect.disabled = false; } });
    if (currentUser.role === 'admin') {
      languageRow.append(languageLabel, languageSelect); panel.append(languageRow);
      const managed = document.createElement('div'); managed.className = 'push-language-row';
      const label = document.createElement('label'); label.htmlFor = 'push-employee-language';
      label.innerHTML = '<strong>' + text('لغة إشعارات الموظفين', 'Employee notification language') + '</strong><small>' + text('اختيار المدير يطبق على جميع الموظفين. لا يمكن للموظف تغييره.', 'Your choice applies to all employees. Employees cannot change it.') + '</small>';
      const select = document.createElement('select'); select.id = 'push-employee-language'; select.className = 'push-language-select';
      select.innerHTML = '<option value="ar">العربية</option><option value="en">English</option>'; select.value = settings.employeeLanguage || 'ar';
      select.onchange = async () => { select.disabled = true; try { settings = await api('/notifications/preferences', { method: 'PATCH', body: JSON.stringify({ employeeLanguage: select.value }) }); message(text('تم حفظ لغة إشعارات الموظفين.', 'Employee notification language saved.')); } catch (error) { select.value = settings.employeeLanguage || 'ar'; message(error.message, true); } finally { select.disabled = false; } };
      managed.append(label, select); panel.append(managed);
    } else {
      const value = document.createElement('span'); value.className = 'push-managed-language'; value.textContent = (settings.language === 'en' ? 'English' : 'العربية') + ' · ' + text('يحددها المدير', 'Set by your administrator');
      languageRow.append(languageLabel, value); panel.append(languageRow);
    }
    const device = document.createElement('div'); device.className = 'push-device-card';
    const deviceTitle = document.createElement('h4'); deviceTitle.textContent = text('هذا الجهاز', 'This device'); device.append(deviceTitle);
    const status = document.createElement('p'); status.id = 'push-device-status'; device.append(status);
    const actions = document.createElement('div'); actions.className = 'push-actions';
    for (const [label, action] of [[text('تفعيل إشعارات هذا الجهاز', 'Enable on this device'), enable], [text('إرسال إشعار تجريبي', 'Send a test'), test], [text('إلغاء اشتراك هذا الجهاز', 'Disconnect device'), disable]]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'push-action' + (action === enable ? ' push-action-primary' : action === disable ? ' push-action-quiet' : ''); button.textContent = label;
      button.dataset.pushAction = action === enable ? 'enable' : action === test ? 'test' : 'disable';
      button.disabled = !supported() || (action !== enable && !settings.configured);
      button.addEventListener('click', async () => { button.disabled = true; try { await action(); } catch (error) { message(errorMessage(error), true); } finally { button.disabled = false; await deviceStatus().catch(() => message(text('تعذر قراءة حالة الجهاز.', 'Unable to check device status.'), true)); } }); actions.append(button);
    }
    device.insertAdjacentHTML('beforeend', activationGuide()); device.append(actions); panel.append(device);
    const hint = document.createElement('details'); hint.className = 'push-install-help';
    hint.innerHTML = `<summary>${text('تفعيل الإشعارات على الآيفون', 'How to enable notifications on iPhone')}</summary><p>${text('من Safari: مشاركة ← إضافة إلى الشاشة الرئيسية. افتحي SOULIA من الأيقونة، ثم فعّلي إشعارات هذا الجهاز. يتطلب iOS 16.4 أو أحدث.', 'In Safari, tap Share → Add to Home Screen. Open SOULIA from its icon, then enable notifications on this device. Requires iOS 16.4 or later.')}</p>`; panel.append(hint);
    const feedback = document.createElement('p'); feedback.id = 'push-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); panel.append(feedback);
    if (!settings.configured) message(text('الإشعارات غير جاهزة على الخادم. اضغط التفعيل للتحقق مجددًا.', 'Notifications are not ready on the server. Click Enable to check again.'), true);
    deviceStatus().catch(() => message('تعذر قراءة حالة الجهاز.', true));
  }
  async function enable() {
    const activationToken = localStorage.getItem('token');
    const wasEnabled = settings.preferences.enabled && settings.devices > 0;
    if (!supported()) throw new Error(text('هذا المتصفح لا يدعم الإشعارات، أو الاتصال ليس HTTPS.', 'Push notifications require a supported browser and HTTPS.'));
    if (!settings.configured) {
      settings = await api('/notifications'); render();
      if (!settings.configured) throw new Error(text('الإشعارات غير جاهزة على الخادم. يلزم تحديث الخادم أو استكمال إعداد الإشعارات.', 'Notifications are not ready on the server. Update the server or complete notification setup.'));
      message(text('الإشعارات جاهزة الآن. اضغط تفعيل إشعارات هذا الجهاز للسماح بها.', 'Notifications are ready. Click Enable on this device to grant permission.')); return;
    }
    if (iphone() && !standalone()) throw new Error('أضيفي SOULIA إلى الشاشة الرئيسية وافتحيه منها أولًا.');
    // Permission is requested directly inside the explicit click, before network work.
    const permission = await Notification.requestPermission();
    if (activationToken !== localStorage.getItem('token')) throw new Error(text('تغير الحساب؛ افتح إعدادات الإشعارات مجددًا.', 'The account changed; reopen notification settings.'));
    if (permission !== 'granted') throw new Error('لم يتم منح إذن الإشعارات. يمكنك تغييره من إعدادات الجهاز.');
    await navigator.serviceWorker.register('/push-sw.js', { scope: '/', updateViaCache: 'none' });
    const registration = await navigator.serviceWorker.ready;
    const bytes = Uint8Array.from(atob(settings.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    let subscription = await registration.pushManager.getSubscription();
    const existingKey = subscription?.options?.applicationServerKey;
    if (existingKey) {
      const currentKey = new Uint8Array(existingKey);
      if (currentKey.length !== bytes.length || currentKey.some((value, i) => value !== bytes[i])) { await subscription.unsubscribe(); subscription = null; }
    }
    const hadSubscription = !!subscription;
    subscription = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    if (activationToken !== localStorage.getItem('token')) throw new Error(text('تغير الحساب؛ افتح إعدادات الإشعارات مجددًا.', 'The account changed; reopen notification settings.'));
    await api('/notifications/subscriptions', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
    if (activationToken !== localStorage.getItem('token')) return;
    settings = await api('/notifications/preferences', { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    try { localStorage.setItem(promptKey(), 'enabled'); } catch (_) {}
    render(); message(text('تم تفعيل الإشعارات بنجاح 🎉🥳', 'Notifications enabled successfully 🎉🥳'));
    if (!wasEnabled || !hadSubscription) {
      const en = settings.language === 'en';
      try { await registration.showNotification(en ? '🎉 Notifications enabled successfully 🥳' : '🎉 تم تفعيل الإشعارات بنجاح 🥳', {
        body: en ? 'Your selected notifications will now reach this device.' : 'ستصلك الإشعارات التي اخترتها على هذا الجهاز.',
        icon: '/push-icon-192.png', tag: 'soulia-notifications-activated', lang: en ? 'en' : 'ar', dir: en ? 'ltr' : 'rtl', data: { url: '/' },
      }); } catch (_) { /* Activation remains successful if the browser cannot display its confirmation. */ }
    }
  }
  async function disable() {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await api('/notifications/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) });
      await subscription.unsubscribe();
    }
    offeredTo = ''; try { localStorage.removeItem(promptKey()); } catch (_) {}
    message('تم إلغاء اشتراك هذا الجهاز.');
  }
  async function test() {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!await registration?.pushManager.getSubscription()) throw new Error(text('فعّلي إشعارات هذا الجهاز أولًا؛ الاختبار يحتاج اشتراكًا ناجحًا.', 'Enable notifications on this device first; a successful subscription is required to test.'));
    await api('/notifications/test', { method: 'POST' }); message('تمت إضافة الإشعار التجريبي لطابور الإرسال.');
  }
  window.souliaPushLogout = async function () {
    if (!supported()) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 3000);
        try { await fetch('/api/notifications/subscriptions', { method: 'DELETE', signal: abort.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') }, body: JSON.stringify({ endpoint: subscription.endpoint }), keepalive: true }); }
        finally { clearTimeout(timeout); }
      }
    } catch (_) { /* Account delivery remains protected by backend authorization. */ }
  };
  async function sync() {
    const next = localStorage.getItem('token') || '';
    if (next !== token) { token = next; settings = null; generation++; offeredTo = ''; }
    const panel = document.getElementById('notification-settings');
    const active = typeof currentUser !== 'undefined' && ['admin', 'staff', 'viewer'].includes(currentUser?.role);
    panel.hidden = !active;
    const shortcut = document.getElementById('push-settings-shortcut'); if (shortcut) shortcut.hidden = !active;
    if (!active && dialog.open) dialog.close();
    if (!active && offer.open) offer.close();
    const profileShortcut = document.getElementById('push-profile-shortcut'); if (profileShortcut) profileShortcut.hidden = !active;
    if (!active || !token || loading || settings) return;
    loading = true; const revision = generation;
    try { const result = await api('/notifications'); if (revision === generation) {
      settings = result;
      if (currentUser.role === 'admin' && !settings.language) settings = await api('/notifications/preferences', { method: 'PATCH', body: JSON.stringify({ language: english() ? 'en' : 'ar' }) });
      if (revision === generation) render();
    } }
    catch (error) { panel.textContent = text('تعذر تحميل إعدادات الإشعارات: ', 'Unable to load notification settings: ') + error.message; }
    finally { loading = false; }
  }
  const panelHome = document.getElementById('notification-settings').parentElement;
  const dialog = document.createElement('dialog'); dialog.className = 'push-settings-dialog push-preferences-dialog'; dialog.setAttribute('aria-label', 'إعدادات الإشعارات');
  const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btn-outline'; close.textContent = 'إغلاق'; close.addEventListener('click', () => dialog.close()); dialog.append(close);
  dialog.addEventListener('close', () => { panelHome.prepend(document.getElementById('notification-settings')); }); document.body.append(dialog);
  window.souliaOpenPushSettings = function () {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    if (offer.open) offer.close();
    document.getElementById('notif-panel')?.classList.remove('show');
    dialog.append(document.getElementById('notification-settings'));
    if (!dialog.open) dialog.showModal();
    sync();
  };
  const offer = document.createElement('dialog'); offer.id = 'push-onboarding'; offer.className = 'push-settings-dialog push-onboarding-dialog';
  document.body.append(offer);
  let checkingOffer = false, offeredTo = '', offerBusy = false;
  function promptKey() { return 'soulia-push-prompt:' + String(currentUser?.userId || currentUser?._id || currentUser?.username || ''); }
  function dismissOffer() {
    try { localStorage.setItem(promptKey(), 'dismissed'); } catch (_) {}
    offer.close();
  }
  offer.addEventListener('cancel', event => { if (offerBusy) event.preventDefault(); else dismissOffer(); });
  async function checkOffer() {
    if (checkingOffer || !settings || !window.souliaPushAppReady || typeof currentUser === 'undefined' || !currentUser || !token || document.hidden) return;
    const key = promptKey();
    if (offeredTo === key || localStorage.getItem(key) === 'dismissed' || dialog.open || offer.open || document.querySelector('dialog[open],.modal-overlay.active,#inv-detail-overlay.active')) return;
    if (!supported() && !iphone()) return;
    checkingOffer = true; const revision = generation;
    try {
      const registration = supported() ? await navigator.serviceWorker.getRegistration('/') : null;
      const subscription = await registration?.pushManager.getSubscription();
      if (revision !== generation || !currentUser || token !== localStorage.getItem('token')) return;
      if (subscription && Notification.permission !== 'denied' && settings.devices > 0 && settings.preferences.enabled) {
        offeredTo = key; try { localStorage.setItem(key, 'enabled'); } catch (_) {} return;
      }
      offeredTo = key;
      const install = iphone() && !standalone();
      offer.innerHTML = `<h3>${text('فعّل إشعارات SOULIA', 'Enable SOULIA notifications')}</h3><p>${text('تابع التعليقات والمتابعات والطلبات والتسليم والمشكلات والمنشنات حتى والنظام مقفول.', 'Receive comments, follow-ups, orders, delivery issues and mentions even while SOULIA is closed.')}</p>
        ${activationGuide()}
        ${install ? `<p>${text('على الآيفون: افتح من Safari ← مشاركة ← إضافة إلى الشاشة الرئيسية، ثم افتح SOULIA من الأيقونة وفعّل الإشعارات. يتطلب iOS 16.4 أو أحدث.', 'On iPhone: Safari → Share → Add to Home Screen. Open SOULIA from its icon, then enable notifications. Requires iOS 16.4 or later.')}</p>` : ''}
        <p id="push-onboarding-feedback" role="status" aria-live="polite"></p>
        <div class="push-onboarding-actions"><button class="btn btn-primary" type="button" id="push-onboarding-enable">${install ? text('فتح إعدادات التفعيل', 'Open activation settings') : text('تفعيل الإشعارات', 'Enable notifications')}</button><button class="btn btn-outline" type="button" id="push-onboarding-later">${text('تجاهل الآن', 'Not now')}</button></div>
        <small>${text('يمكنك تفعيلها لاحقًا من صفحة المستخدم ← إعدادات الإشعارات.', 'You can enable them later from your profile → Notification settings.')}</small>`;
      offer.setAttribute('aria-label', text('تفعيل إشعارات SOULIA', 'Enable SOULIA notifications'));
      offer.querySelector('#push-onboarding-later').onclick = dismissOffer;
      offer.querySelector('#push-onboarding-enable').onclick = async () => {
        if (install) { window.souliaOpenPushSettings(); return; }
        if (offerBusy) return;
        offerBusy = true; const currentRevision = generation;
        offer.querySelectorAll('button').forEach(button => button.disabled = true);
        try {
          await enable();
          if (generation !== currentRevision) return;
          const registration = await navigator.serviceWorker.getRegistration('/');
          const subscription = await registration?.pushManager.getSubscription();
          if (!subscription || !settings.preferences.enabled) {
            offer.querySelector('#push-onboarding-feedback').textContent = document.getElementById('push-feedback')?.textContent || text('اضغط التفعيل مجددًا بعد تجهيز الخدمة.', 'Click Enable again when the service is ready.'); return;
          }
          localStorage.setItem(key, 'enabled');
          offer.innerHTML = `<h3>${text('تم تفعيل الإشعارات بنجاح 🎉🥳', 'Notifications enabled successfully 🎉🥳')}</h3><p>${text('سيصلك الآن ما فعّلته من تعليقات ومتابعات وطلبات وتسليم ومشكلات ومنشنات على هذا الجهاز.', 'Your selected comments, follow-ups, orders, deliveries, issues and mentions will now reach this device.')}</p><button class="btn btn-primary" type="button" id="push-onboarding-done">${text('تم', 'Done')}</button>`;
          offer.querySelector('#push-onboarding-done').onclick = () => offer.close();
        } catch (error) { if (offer.querySelector('#push-onboarding-feedback')) offer.querySelector('#push-onboarding-feedback').textContent = errorMessage(error); }
        finally { offerBusy = false; offer.querySelectorAll('button').forEach(button => button.disabled = false); }
      };
      offer.showModal();
    } finally { checkingOffer = false; }
  }
  const header = document.querySelector('#notif-panel .notif-header');
  if (header) {
    const button = document.createElement('button'); button.id = 'push-settings-shortcut'; button.className = 'push-settings-icon'; button.type = 'button'; button.title = text('إعدادات الإشعارات', 'Notification settings'); button.setAttribute('aria-label', button.title); button.hidden = true;
    button.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3-.6 2.2-2 .9-2-.6-2.4 4.1 1.6 1.6v2.3l-1.6 1.6 2.4 4.1 2-.6 2 .9.6 2.2h5l.6-2.2 2-.9 2 .6 2.4-4.1-1.6-1.6v-2.3l1.6-1.6-2.4-4.1-2 .6-2-.9-.6-2.2z"/><circle cx="12" cy="12" r="3"/></svg>';
    button.addEventListener('click', () => window.souliaOpenPushSettings()); (header.querySelector('.notif-header-top > div') || header.querySelector('.notif-header-top') || header).append(button);
  }
  setInterval(() => {
    const title = text('إعدادات الإشعارات', 'Notification settings'); dialog.setAttribute('aria-label', title); close.textContent = text('إغلاق', 'Close');
    const shortcut = document.getElementById('push-settings-shortcut'); if (shortcut) { shortcut.title = title; shortcut.setAttribute('aria-label', title); }
    const profileShortcut = document.getElementById('push-profile-shortcut'); if (profileShortcut) profileShortcut.textContent = title;
    if (settings && renderedLanguage !== (english() ? 'en' : 'ar')) render();
    sync();
    checkOffer().catch(() => {});
  }, 2000);
})();
