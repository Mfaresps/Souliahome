/* First sign-in welcome + tour («جولة تعريفية», Nov 24, 2026).
   Shown once to an account created from the user window (server flag `onboardingPending`, sent with
   the login / auth-me payload). Steps: welcome → what SOULIA is → the sections this account can open
   → its permissions with their details (names + ⓘ text from roles-permissions.js) → tips.
   Finishing or skipping calls POST /users/me/onboarding-done. It can be replayed from the profile
   menu («جولة تعريفية») without touching the server.
   ⚠ Reads only currentUser.perms / role and the static catalog — /roles is admin-only. */
(function () {
  'use strict';
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const tr = (a, e) => (en() ? e : a);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const admin = () => typeof isAdmin === 'function' && isAdmin();

  /* One line per sidebar section: what it is for. */
  const SECTION_INFO = {
    dashboard: ['ملخص اليوم: الطلبات الجديدة، ما ينتظر التجهيز، والتنبيهات.', 'Today at a glance: new orders, what waits for preparation, alerts.'],
    transaction: ['إنشاء فاتورة مبيعات أو مرتجع، وفاتورة شراء لمن يملك صلاحيتها.', 'Create a sale or a return — and a purchase invoice if you may.'],
    'shopify-orders': ['طلبات المتجر الواردة: التواصل مع العميل، العربون، ثم التأكيد.', 'Incoming store orders: contact the customer, deposit, then confirm.'],
    movements: ['كل الفواتير المسجلة: البحث، الفتح، الطباعة، والتحصيل.', 'Every recorded invoice: search, open, print and collect.'],
    inventory: ['الأرصدة: الصالح للبيع، المحجوز، ما يحتاج مراجعة، والوارد.', 'Stock: ready to sell, reserved, needs attention, incoming.'],
    barcodes: ['باركود كل قطعة: البحث، الاستلام، الطباعة، والجرد.', 'A barcode per piece: search, receive, print, count.'],
    products: ['بيانات الأصناف وأسعارها وصورها.', 'Product details, prices and photos.'],
    promotions: ['عروض الأسعار وأكواد الخصم والباقات.', 'Price offers, discount codes and bundles.'],
    categories: ['تنظيم الأصناف في تصنيفات ومجموعات.', 'Organise products into categories and collections.'],
    complaints: ['شكاوى العملاء ومتابعة الطلبات حتى تُحل.', 'Customer complaints and order follow-ups until resolved.'],
    csp: ['ردود جاهزة لخدمة العملاء تنسخها بضغطة.', 'Ready-made customer-service replies, copied in one click.'],
    clients: ['العملاء وسجل مشترياتهم.', 'Customers and their purchase history.'],
    'pickup-orders': ['لوحة التجهيز والشحن: معلّق ← قيد التجهيز ← جاهز ← تم الشحن.', 'Preparation board: pending → preparing → ready → shipped.'],
    approvals: ['الطلبات التي تنتظر قرارًا: مصاريف، مرتجعات، إلغاءات.', 'Requests waiting for a decision: expenses, returns, cancellations.'],
    suppliers: ['الموردون وفواتيرهم ومدفوعاتهم ومديونيتهم.', 'Suppliers, their invoices, payments and balances.'],
    expenses: ['تسجيل المصاريف وإرفاق إيصالاتها.', 'Record expenses with their receipts.'],
    reports: ['تقارير المبيعات والطلبات والشحن.', 'Sales, order and shipping reports.'],
    vault: ['الخزنة وحساباتها وسجل كل حركة نقدية.', 'The cash register, its accounts and every cash movement.'],
    users: ['حسابات الموظفين وأدوارهم.', 'Employee accounts and their roles.'],
    settings: ['إعدادات النظام والتكاملات.', 'System settings and integrations.'],
  };

  const firstName = () => String((currentUser && (currentUser.name || currentUser.username)) || '').trim().split(/\s+/)[0] || '';
  const roleLabel = () => {
    if (admin()) return tr('مدير النظام', 'System admin');
    let r = '';
    try { r = window.SouliaRBAC && currentUser.roleId ? window.SouliaRBAC.roleName({ slug: currentUser.roleId, name: '' }) : ''; } catch (_) {}
    if (!r && typeof userTitleLabel === 'function') r = userTitleLabel(currentUser);
    return r;
  };
  const sections = () => (typeof NAV_ITEMS === 'undefined' ? [] : NAV_ITEMS.filter(n => !n.sep && !n.hidden && (typeof _navItemAllowed === 'function' ? _navItemAllowed(n) : true)));
  const navLabel = n => (en() ? n.labelEn || n.label : n.label);

  /* Permissions this account holds, grouped like the Roles page. */
  function permGroups() {
    const R = window.SouliaRBAC;
    if (!R || typeof R.groups !== 'function') return [];
    const mine = new Set((currentUser && currentUser.perms) || []);
    return R.groups().map(g => ({ title: g.title, keys: g.keys.filter(k => mine.has(k)) })).filter(g => g.keys.length);
  }

  let dlg = null, step = 0, steps = [], replay = false;
  const ICO = {
    orders: '<path d="M3 7h18l-2 12H5z"/><path d="M8 7V5a4 4 0 0 1 8 0v2"/>',
    stock: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v9"/>',
    money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a5 5 0 0 1 10 0v1"/><path d="M16 4a3 3 0 0 1 0 6M21 20v-1a5 5 0 0 0-3-4.6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 12 0v1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>',
  };
  const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k]}</svg>`;

  function buildSteps() {
    const list = sections();
    const groups = permGroups();
    const R = window.SouliaRBAC || {};
    const name = k => (R.permName ? R.permName(k) : k);
    const info = k => (R.permInfo ? R.permInfo(k) : '');
    const role = roleLabel();
    const avatar = (currentUser && currentUser.avatar && typeof sanitizeUrl === 'function') ? sanitizeUrl(currentUser.avatar) : '';
    const initials = firstName().slice(0, 2).toUpperCase();
    return [
      { title: tr(`أهلًا بك في SOULIA، ${firstName()}`, `Welcome to SOULIA, ${firstName()}`),
        body: `<div class="onb-hero"><span class="onb-avatar">${avatar ? `<img src="${esc(avatar)}" alt="">` : esc(initials)}</span>
          <p class="onb-lead">${tr('سعداء بانضمامك إلى الفريق. هذا حسابك على نظام إدارة SOULIA.', 'Glad to have you on the team. This is your account on the SOULIA management system.')}</p>
          ${role ? `<p class="onb-role">${tr('دورك', 'Your role')}: <b>${esc(role)}</b></p>` : ''}
          <p class="onb-muted">${tr('في أقل من دقيقة سنعرّفك على النظام وعلى الأقسام والصلاحيات المتاحة لك.', 'In under a minute we will show you the system and what you can access.')}</p></div>` },
      { title: tr('ما هو SOULIA؟', 'What is SOULIA?'),
        body: `<p class="onb-muted">${tr('نظام واحد يدير عمل المتجر كله، من وصول الطلب حتى تحصيل ثمنه:', 'One system that runs the whole store, from an order arriving to its money being collected:')}</p>
          <ul class="onb-pillars">
            <li>${svg('orders')}<div><b>${tr('الطلبات', 'Orders')}</b><span>${tr('طلبات Shopify والفواتير، ثم التجهيز والشحن مع بوسطة.', 'Shopify orders and invoices, then preparation and shipping with Bosta.')}</span></div></li>
            <li>${svg('stock')}<div><b>${tr('المخزون', 'Stock')}</b><span>${tr('أرصدة الأصناف وباركود لكل قطعة.', 'Product balances and a barcode for every piece.')}</span></div></li>
            <li>${svg('money')}<div><b>${tr('الحسابات', 'Money')}</b><span>${tr('الخزنة والمصاريف والموردون والتقارير.', 'Cash register, expenses, suppliers and reports.')}</span></div></li>
            <li>${svg('people')}<div><b>${tr('العملاء', 'Customers')}</b><span>${tr('الشكاوى والمتابعات وسجل كل عميل.', 'Complaints, follow-ups and each customer’s history.')}</span></div></li>
          </ul>
          <p class="onb-muted">${tr('ترى في القائمة الجانبية الأقسام المسموح لك بها فقط.', 'The sidebar shows only the sections you are allowed to open.')}</p>` },
      { title: tr('الأقسام المتاحة لك', 'Your sections'),
        body: list.length ? `<p class="onb-muted">${tr(`لديك ${list.length} ${list.length === 1 ? 'قسم' : 'أقسام'} في القائمة الجانبية. اضغط على أي قسم لفتحه بعد الجولة.`, `You have ${list.length} section${list.length === 1 ? '' : 's'} in the sidebar. Click one to open it after the tour.`)}</p>
          <div class="onb-sections">${list.map(n => `<button type="button" class="onb-sec" data-go="${esc(n.id)}"><span class="onb-sec-ico">${n.icon || ''}</span><span><b>${esc(navLabel(n))}</b><small>${esc((SECTION_INFO[n.id] || ['', ''])[en() ? 1 : 0])}</small></span></button>`).join('')}</div>`
          : `<p class="onb-muted">${tr('لم تُمنح أي قسم بعد. تواصل مع مدير النظام ليعيّن لك دورًا.', 'No section has been granted yet. Ask your administrator to assign you a role.')}</p>` },
      { title: tr('صلاحياتك', 'Your permissions'),
        body: admin()
          ? `<p class="onb-lead">${tr('لديك وصول كامل لكل أجزاء النظام بصفتك مدير النظام.', 'As a system admin you have full access to every part of the system.')}</p><p class="onb-muted">${tr('الصلاحيات الحساسة مثل الخزنة والمدفوعات تبقى مسجّلة باسمك في سجلات التدقيق.', 'Sensitive actions such as cash and payments are recorded under your name in the audit logs.')}</p>`
          : groups.length ? `<p class="onb-muted">${tr('هذا ما يسمح لك به دورك، وتحت كل صلاحية حدودها. ما لا يظهر هنا غير متاح لك، وتراه في النظام معطّلًا.', 'This is what your role allows, with each permission’s limits. Anything not listed is not available to you and appears disabled.')}</p>
            <div class="onb-perms">${groups.map((g, i) => `<details class="onb-pg"${i === 0 ? ' open' : ''}><summary><b>${esc(g.title)}</b><span class="onb-count">${g.keys.length}</span></summary><ul>${g.keys.map(k => `<li><b>${esc(name(k))}</b>${info(k) ? `<span>${esc(info(k))}</span>` : ''}</li>`).join('')}</ul></details>`).join('')}</div>`
          : `<p class="onb-muted">${tr('لا توجد صلاحيات على حسابك بعد.', 'Your account has no permissions yet.')}</p>` },
      { title: tr('نصائح للبدء', 'Getting started'),
        body: `<ul class="onb-tips">
            <li>${svg('search')}<div><b>${tr('البحث في الأعلى', 'Search at the top')}</b><span>${tr('ابحث عن أي طلب أو صنف أو عميل برقمه أو اسمه أو هاتفه، أو امسح باركود القطعة.', 'Find any order, product or customer by number, name or phone — or scan a piece’s barcode.')}</span></div></li>
            <li>${svg('spark')}<div><b>${tr('مساعد SOULIA', 'SOULIA assistant')}</b><span>${tr('اسأل عن أي رقم، مثل «مبيعات اليوم» أو «أوردر 3312». الاختصار Ctrl + /.', 'Ask about any figure, e.g. “today’s sales” or “order 3312”. Shortcut Ctrl + /.')}</span></div></li>
            <li>${svg('bell')}<div><b>${tr('الإشعارات', 'Notifications')}</b><span>${tr('يصلك تنبيه عند إسناد طلب إليك أو ذكرك في تعليق بـ @.', 'You are notified when an order is assigned to you or someone mentions you with @.')}</span></div></li>
            <li>${svg('user')}<div><b>${tr('حسابك', 'Your account')}</b><span>${tr('من صورتك في الأعلى: صورتك الشخصية، اللغة، الوضع الداكن، وإعادة هذه الجولة.', 'From your photo at the top: profile photo, language, dark mode, and replaying this tour.')}</span></div></li>
          </ul>` },
    ];
  }

  function render() {
    const s = steps[step], last = step === steps.length - 1;
    dlg.dir = en() ? 'ltr' : 'rtl';
    dlg.innerHTML = `<div class="onb-card">
      <div class="onb-top"><span class="onb-step">${tr(`الخطوة ${step + 1} من ${steps.length}`, `Step ${step + 1} of ${steps.length}`)}</span>
        ${last ? '' : `<button type="button" class="onb-skip" data-act="skip">${tr('تخطي الجولة', 'Skip tour')}</button>`}</div>
      <div class="onb-dots" aria-hidden="true">${steps.map((_, i) => `<i class="${i === step ? 'is-on' : i < step ? 'is-done' : ''}"></i>`).join('')}</div>
      <h2 class="onb-title" id="onb-title">${esc(s.title)}</h2>
      <div class="onb-body">${s.body}</div>
      <div class="onb-foot">
        ${step > 0 ? `<button type="button" class="onb-btn" data-act="back">${tr('السابق', 'Back')}</button>` : '<span></span>'}
        <button type="button" class="onb-btn is-primary" data-act="${last ? 'done' : 'next'}">${last ? tr('ابدأ العمل', 'Start working') : step === 0 ? tr('ابدأ الجولة', 'Start the tour') : tr('التالي', 'Next')}</button>
      </div></div>`;
    dlg.setAttribute('aria-labelledby', 'onb-title');
    const primary = dlg.querySelector('.onb-btn.is-primary');
    if (primary) primary.focus();
  }

  async function finish(goTo) {
    if (dlg) { dlg.close(); dlg.remove(); dlg = null; }
    if (!replay && currentUser && currentUser.onboardingPending) {
      currentUser.onboardingPending = false;
      try { localStorage.setItem('user', JSON.stringify(currentUser)); } catch (_) {}
      try { await api('/users/me/onboarding-done', { method: 'POST', body: '{}' }); } catch (_) { /* shown again next sign-in — harmless */ }
    }
    if (goTo && typeof navigateTo === 'function') navigateTo(goTo);
  }

  function start(isReplay) {
    if (dlg || !currentUser) return;
    replay = !!isReplay;
    steps = buildSteps(); step = 0;
    dlg = document.createElement('dialog');
    dlg.className = 'onb-dialog';
    document.body.append(dlg);
    dlg.addEventListener('click', e => {
      const b = e.target.closest('[data-act],[data-go]'); if (!b) return;
      if (b.dataset.go) { finish(b.dataset.go); return; }
      const a = b.dataset.act;
      if (a === 'next') { step = Math.min(steps.length - 1, step + 1); render(); }
      else if (a === 'back') { step = Math.max(0, step - 1); render(); }
      else if (a === 'skip' || a === 'done') finish();
    });
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); }); // Escape = skip
    render();
    dlg.showModal();
  }

  /* Called once the splash is gone. Waits while another window is open so it never covers a form. */
  function maybeStart(tries = 0) {
    if (!currentUser || !currentUser.onboardingPending || dlg) return;
    const busy = document.querySelector('dialog[open]') || document.querySelector('#modal-overlay.active') || document.getElementById('splash-screen');
    if (busy && tries < 20) { setTimeout(() => maybeStart(tries + 1), 1500); return; }
    start(false);
  }

  window.SouliaOnboarding = { start: () => start(true), maybeStart };
})();
