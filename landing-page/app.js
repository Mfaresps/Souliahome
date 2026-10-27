(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const stages = [
    { icon: 'box', title: 'بداية منظمة لكل طلب.', description: 'راجع بيانات العميل والمنتجات، وأكّد الطلب وحدد مسؤول المتابعة قبل بدء التجهيز.', rows: [['مرجع الطلب', '<b dir="ltr">#DEMO-0248</b>'], ['حالة الطلب', '<span class="stage-status">تم التأكيد</span>'], ['الخطوة التالية', '<b>إرسال إلى التحضير</b>']] },
    { icon: 'scan', title: 'القطعة الصح. كل مرة.', description: 'راجع المخزون المتاح، وامسح باركود القطع أثناء التحضير لمطابقتها مع تفاصيل الطلب.', rows: [['القطع المطلوبة', '<b>قطعتان</b>'], ['مطابقة الباركود', `<span class="stage-status">اكتملت المطابقة ${icon('check')}</span>`], ['الخطوة التالية', '<b>جاهز للشحن</b>']] },
    { icon: 'truck', title: 'خطوة أقرب للعميل.', description: 'جهّز الشحنة، وراجع بيانات التوصيل وتابع الحالة من خلال تكامل الشحن بعد ربط الحساب.', rows: [['شركة الشحن', '<b dir="ltr">bosta</b>'], ['حالة توضيحية للشحنة', '<span class="stage-status">قيد التوصيل</span>'], ['الخطوة التالية', '<b>متابعة التسليم</b>']] },
    { icon: 'wallet', title: 'تسليم الطلب مش النهاية.', description: 'تابع التحصيل والحركة المالية، واحتفظ بسياق العميل عند أي متابعة أو طلب استبدال أو إرجاع.', rows: [['حالة توضيحية للطلب', '<span class="stage-status">تم التسليم</span>'], ['المتابعة المالية', '<b>مراجعة التحصيل</b>'], ['خدمة العملاء', '<b>متابعة ما بعد البيع</b>']] },
  ];
  const tours = {
    orders: { icon: 'box', title: 'كل طلب له مسار واضح.', description: 'من بيانات العميل إلى حالة التسليم، اجمع تفاصيل الطلب وخطوات متابعته في مساحة واحدة.', items: ['مراجعة الطلبات وبيانات المنتجات والعملاء', 'تعيين مسؤول للمتابعة وتأكيد الطلب', 'الانتقال إلى التحضير والشحن ومتابعة الحالة'] },
    stock: { icon: 'scan', title: 'اعرف اللي عندك، واللي اتحرك.', description: 'نظّم مخازنك ومنتجاتك وتابع حركة القطع، مع أدوات الباركود لتسهيل الاستلام والتحضير.', items: ['إدارة المنتجات وأرصدة المخازن', 'تتبع القطع باستخدام الباركود', 'مراجعة حركة المخزون والجرد'] },
    finance: { icon: 'wallet', title: 'أرقام مرتبطة بشغلك.', description: 'اجمع العمليات المالية اليومية في سياق يمكن مراجعته، من المصروف والتحصيل إلى حسابات الموردين.', items: ['متابعة الخزائن والتحصيل والمصروفات', 'مراجعة حسابات الموردين والمشتريات', 'الرجوع إلى المعاملات ومؤشرات الطلبات'] },
    team: { icon: 'users', title: 'كل شخص يعرف مسؤوليته.', description: 'اجمع الفريق حول نفس تفاصيل العمل، مع أدوار وصلاحيات واضحة وتوزيع مسؤوليات المتابعة.', items: ['تحديد أدوار وصلاحيات أعضاء الفريق', 'توزيع متابعة الطلبات على الموظفين', 'متابعة الأداء وحالات خدمة العملاء'] },
  };

  // This presentation never reads authentication storage or calls the application API.
  let activeStage = -1;
  const journey = $('#journey');
  const sticky = $('.journey-sticky');
  function showStage(index) {
    if (activeStage === index) return;
    activeStage = index;
    const stage = stages[index];
    $('#stage-content').innerHTML = `<div class="stage-view"><div class="stage-view-icon">${icon(stage.icon)}</div><h3>${stage.title}</h3><p>${stage.description}</p><div class="stage-detail">${stage.rows.map(([label, value]) => `<div class="stage-detail-row"><span>${label}</span>${value}</div>`).join('')}</div></div>`;
    $$('.journey-step').forEach((button, i) => {
      button.classList.toggle('active', index === i);
      button.setAttribute('aria-pressed', String(index === i));
    });
    $('.stage-count').textContent = `0${index + 1} — 04`;
    $('.stage-percentage').textContent = `${(index + 1) * 25}%`;
    $('.stage-progress i').style.width = `${(index + 1) * 25}%`;
  }
  showStage(0);

  let manualStage = false;
  let manualTimer;
  $$('.journey-step').forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.dataset.step);
    showStage(index);
    if (motion.matches) return;
    manualStage = true;
    clearTimeout(manualTimer);
    const travel = Math.max(1, journey.offsetHeight - sticky.offsetHeight);
    const y = journey.offsetTop + travel * ((index + 0.35) / stages.length);
    window.scrollTo({ top: y, behavior: 'smooth' });
    manualTimer = setTimeout(() => { manualStage = false; requestTick(); }, 1000);
  }));

  const header = $('.site-header');
  const hero = $('.hero');
  const product = $('.product-window');
  const notes = $$('.float-note');
  let tickRequested = false;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function updateScroll() {
    tickRequested = false;
    const y = window.scrollY;
    header.classList.toggle('is-scrolled', y > 40);
    const available = document.documentElement.scrollHeight - window.innerHeight;
    $('.reading-progress').style.transform = `scaleX(${available > 0 ? clamp(y / available, 0, 1) : 0})`;
    if (!motion.matches) {
      if (y < hero.offsetHeight + window.innerHeight) {
        const progress = clamp(y / Math.max(1, hero.offsetHeight * 0.6), 0, 1);
        product.style.setProperty('--console-tilt', `${5 * (1 - progress)}deg`);
        product.style.setProperty('--console-y', `${-14 * progress}px`);
        notes.forEach((note, index) => note.style.setProperty('--note-y', `${progress * (index ? -24 : 20)}px`));
      }
      if (!manualStage) {
        const travel = Math.max(1, journey.offsetHeight - sticky.offsetHeight);
        const progress = clamp((y - journey.offsetTop) / travel, 0, 0.999);
        showStage(Math.floor(progress * stages.length));
      }
    }
  }
  function requestTick() { if (!tickRequested) { tickRequested = true; requestAnimationFrame(updateScroll); } }
  window.addEventListener('scroll', requestTick, { passive: true });
  window.addEventListener('resize', requestTick, { passive: true });
  motion.addEventListener('change', requestTick);

  if ('IntersectionObserver' in window && !motion.matches) {
    document.documentElement.classList.add('motion-ready');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -20px 0px' });
    $$('.reveal').forEach((element) => observer.observe(element));
    // Keep reveals accessible when motion preferences change mid-session.
    motion.addEventListener('change', () => {
      if (motion.matches) { $$('.reveal').forEach((element) => element.classList.add('is-visible')); observer.disconnect(); }
    });
  }

  const menu = $('.menu-toggle');
  const mobileNav = $('#mobile-nav');
  function closeMenu() {
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'فتح القائمة');
    mobileNav.hidden = true;
  }
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'إغلاق القائمة' : 'فتح القائمة');
    mobileNav.hidden = !open;
  });
  $$('#mobile-nav a').forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !mobileNav.hidden) { closeMenu(); menu.focus(); } });
  document.addEventListener('click', (event) => { if (!header.contains(event.target)) closeMenu(); });
  window.matchMedia('(min-width: 601px)').addEventListener('change', closeMenu);

  const dialog = $('.demo-dialog');
  let lastTrigger;
  let previousOverflow;
  const tabs = $$('.demo-tabs button');
  function selectTab(key, focus = false) {
    const tour = tours[key] || tours.orders;
    tabs.forEach((tab) => {
      const selected = tab.dataset.tab === key;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    $('#demo-panel').setAttribute('aria-labelledby', `tab-${key}`);
    $('#demo-panel').innerHTML = `<div class="demo-panel-inner"><span class="feature-icon">${icon(tour.icon)}</span><h3>${tour.title}</h3><p>${tour.description}</p><ul>${tour.items.map((item) => `<li>${icon('check')}<span>${item}</span></li>`).join('')}</ul></div>`;
  }
  $$('[data-demo]').forEach((button) => button.addEventListener('click', () => {
    lastTrigger = button;
    selectTab(button.dataset.demo || 'orders');
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    $('.close-dialog').focus();
    closeMenu();
  }));
  $('.close-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => { document.body.style.overflow = previousOverflow || ''; lastTrigger?.focus({ preventScroll: true }); });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowLeft') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowRight') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); selectTab(tabs[next].dataset.tab, true); }
    });
  });
  $$('.faq-list details').forEach((detail) => detail.addEventListener('toggle', () => {
    if (detail.open) $$('.faq-list details').forEach((other) => { if (other !== detail) other.open = false; });
  }));
  $('#year').textContent = new Date().getFullYear();
  requestTick();
})();
