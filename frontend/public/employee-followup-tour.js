(function (root) {
  'use strict';
  let mounted = null, active = null, frame = 0;
  const tr = (ar, english) => currentLang === 'en' ? english : ar;
  const storageKey = () => 'soulia:followup-tour:v1:' + String(currentUser?._id || currentUser?.id || '');
  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey()) || '{}');
      return { seen: saved.seen === true, completed: saved.completed === true,
        index: Number.isInteger(saved.index) ? Math.max(0, Math.min(6, saved.index)) : 0 };
    } catch (_) { return { seen: false, completed: false, index: 0 }; }
  }
  function persist() { if (mounted) { try { localStorage.setItem(mounted.key, JSON.stringify(mounted.state)); } catch (_) {} } }
  function steps(host, options) {
    const reason = host.querySelector('[name=reason]')?.closest('label');
    const channel = host.querySelector('[name=channel]')?.closest('label');
    const note = host.querySelector('[name=note]')?.closest('label');
    return [
      { target: host.querySelector('.employee-session-order'), title: tr('ابدأ بالعميل الصحيح', 'Start with the right customer'),
        text: tr('راجع رقم الطلب واسم العميل، ثم استخدم أيقونة الاتصال أو Vrobo بجواره. فتح وسيلة التواصل وحده لا يسجّل نتيجة المكالمة.', 'Check the order number and customer name, then use the phone or Vrobo icon. Opening a contact channel does not automatically record a call outcome.') },
      { target: host.querySelector('.employee-session-context'), title: tr('اقرأ آخر ما حدث', 'Read the latest activity'),
        text: tr('راجع آخر تعليق ونتيجة آخر تواصل قبل الاتصال، لتكمل ما اتفق عليه زميلك. اضغط التعليق لفتح المسار كاملًا.', 'Review the latest comment and contact outcome before calling, so you can continue the previous agreement. Click the comment to open the full trail.') },
      { target: reason, title: tr('حدّد الخطوة القادمة', 'Choose the next step'),
        text: options.confirmation
          ? tr('اختر إعادة التواصل للتأكيد، متابعة العربون، تأكيد البيانات أو تأجيل العميل حسب ما حدث. سداد العربون يُسجّل من الطلب نفسه.', 'Choose confirmation contact, deposit follow-up, order details or customer postponement. Record an actual deposit on the order itself.')
          : options.shippingIssue
          ? tr('اختر سبب المتابعة المناسب لمشكلة التوصيل: انتظار الناقل أو رد العميل أو المرتجع. موعد المتابعة لا يعني إغلاق المشكلة.', 'Choose the relevant delivery follow-up: carrier, customer reply or return. Scheduling a follow-up does not resolve the delivery issue.')
          : tr('اختر الخطوة التي تناسب اتفاقك مع العميل، حتى يعرف من يتابع بعدك سبب الانتظار.', 'Choose the next step agreed with the customer so the next person understands why the request is waiting.') },
      { target: channel, title: tr('سجّل وسيلة التواصل الفعلية', 'Record the actual channel'),
        text: tr('اختر اتصال أو Vrobo حسب الوسيلة التي استخدمتها. الضغط على أيقونة التواصل يختار القناة تلقائيًا.', 'Choose Phone or Vrobo to match the channel you used. Clicking a contact icon selects that channel automatically.') },
      { target: note, title: tr('اكتب نتيجة واضحة', 'Write a clear outcome'),
        text: tr('اكتب ما حدث والخطوة المتفق عليها، مثل: «العميل طلب اتصالًا بعد ساعة لإرسال العربون». لا تكتفِ بكلمة «تمام».', 'Record what happened and the agreed action, for example: “Customer requested a call in one hour to arrange the deposit.” Avoid an unclear note such as “OK”.') },
      { target: host.querySelector('.employee-session-reminder'), title: tr('حدّد متى ترجع للعميل', 'Plan when to follow up'),
        text: tr('اختر 10 دقايق أو نصف ساعة أو ساعة أو ساعتين؛ تُحسب المدة من وقت الحفظ. «تحديد موعد» يتيح اختيار تاريخ ووقت محددين.', 'Choose 10 minutes, 30 minutes, one hour or two hours, counted from saving. Choose date lets you set a specific date and time.') },
      { target: host.querySelector('.employee-session-controls'), title: tr('احفظ ثم انتقل للتالي', 'Save and move to the next request'),
        text: tr('«حفظ المتابعة والتالي» يسجّل التعليق والتذكير ثم يعرض الطلب التالي. «تخطي الآن» لا يسجّل إنجازًا، ويمكن الرجوع للطلب في جلسة جديدة.', 'Save follow-up & next records the note and reminder, then shows the next request. Skip for now does not count as followed up; revisit the request in a new session.') },
    ].filter(step => step.target);
  }
  function updateToolbar() {
    if (!mounted) return;
    const { toolbar, state, host } = mounted;
    const button = toolbar.querySelector('[data-tour-start]');
    button.textContent = tr('شرح سريع', 'Quick tour');
    button.setAttribute('aria-expanded', String(active?.mode === 'tour'));
    button.title = active?.mode === 'tour' ? tr('إغلاق الجولة', 'Close tour')
      : state.completed ? tr('إعادة الجولة', 'Restart tour') : state.index > 0 ? tr('استكمال الجولة', 'Continue tour') : tr('ابدأ الجولة', 'Start tour');
    host.querySelectorAll('.employee-field-help').forEach(item => { item.hidden = false; });
  }
  function close(restoreFocus = true) {
    if (!active) return;
    const previous = active;
    active = null;
    previous.panel.remove(); previous.spot.remove();
    previous.trigger?.setAttribute('aria-expanded', 'false');
    previous.trigger?.removeAttribute('aria-controls');
    root.removeEventListener('resize', schedulePosition);
    root.visualViewport?.removeEventListener('resize', schedulePosition);
    root.visualViewport?.removeEventListener('scroll', schedulePosition);
    document.removeEventListener('scroll', schedulePosition, true);
    document.removeEventListener('keydown', keydown, true);
    cancelAnimationFrame(frame);
    updateToolbar();
    if (restoreFocus && previous.trigger?.isConnected && mounted?.host.closest('#modal-overlay.active')) previous.trigger.focus({ preventScroll: true });
  }
  function schedulePosition() { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); }
  function position() {
    if (!active || !mounted) return;
    const { target, panel, spot } = active;
    if (!target.isConnected || !mounted.host.closest('#modal-overlay.active')) { close(false); return; }
    const viewport = root.visualViewport;
    const leftLimit = (viewport?.offsetLeft || 0) + 10, topLimit = (viewport?.offsetTop || 0) + 10;
    const rightLimit = leftLimit + (viewport?.width || innerWidth) - 20;
    const bottomLimit = topLimit + (viewport?.height || innerHeight) - 20;
    const rect = target.getBoundingClientRect(), body = mounted.host.querySelector('.employee-session-body').getBoundingClientRect();
    const top = Math.max(rect.top - 4, body.top, topLimit), bottom = Math.min(rect.bottom + 4, body.bottom, bottomLimit);
    Object.assign(spot.style, { left: Math.max(leftLimit, rect.left - 4) + 'px', top: top + 'px',
      width: Math.max(0, Math.min(rect.right + 4, rightLimit) - Math.max(leftLimit, rect.left - 4)) + 'px', height: Math.max(0, bottom - top) + 'px' });
    panel.style.width = Math.min(316, rightLimit - leftLimit) + 'px';
    panel.style.maxHeight = Math.max(120, bottomLimit - topLimit) + 'px';
    const height = panel.getBoundingClientRect().height, width = panel.getBoundingClientRect().width;
    const below = bottom + 10 + height <= bottomLimit;
    const y = below ? bottom + 10 : Math.max(topLimit, top - height - 10);
    const x = Math.max(leftLimit, Math.min(rect.left + rect.width / 2 - width / 2, rightLimit - width));
    Object.assign(panel.style, { left: x + 'px', top: Math.min(y, bottomLimit - height) + 'px' });
  }
  function keydown(event) {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (active.mode !== 'tour' || !active.panel.contains(event.target) || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === (currentLang === 'en' ? 'ArrowRight' : 'ArrowLeft');
    move(next ? 1 : -1);
  }
  function move(delta) {
    if (!mounted || active?.mode !== 'tour') return;
    const index = mounted.state.index + delta;
    if (index < 0) return;
    if (index >= mounted.steps.length) { mounted.state.completed = true; persist(); close(); return; }
    mounted.state.index = index; persist();
    show(mounted.steps[index], 'tour', mounted.toolbar.querySelector('[data-tour-start]'));
  }
  function start() {
    if (!mounted) return;
    mounted.invite?.remove();
    mounted.state.seen = true;
    if (mounted.state.completed) mounted.state.index = 0;
    mounted.state.completed = false;
    mounted.state.index = Math.min(mounted.state.index, mounted.steps.length - 1);
    persist();
    show(mounted.steps[mounted.state.index], 'tour', mounted.toolbar.querySelector('[data-tour-start]'));
  }
  function show(step, mode, trigger) {
    if (!mounted || !step?.target) return;
    close(false);
    const body = mounted.host.querySelector('.employee-session-body');
    const rect = step.target.getBoundingClientRect(), bounds = body.getBoundingClientRect();
    if (rect.top < bounds.top + 8 || rect.bottom > bounds.bottom - 8) body.scrollTop += rect.top - bounds.top - Math.max(8, (body.clientHeight - Math.min(rect.height, body.clientHeight)) / 2);
    const spot = document.createElement('div'); spot.className = 'employee-tour-spotlight'; spot.setAttribute('aria-hidden', 'true');
    const panel = document.createElement('aside'); panel.className = 'employee-tour-popover'; panel.id = 'employee-followup-tour-card';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-labelledby', 'employee-tour-title'); panel.dir = currentLang === 'en' ? 'ltr' : 'rtl';
    const count = mounted.steps.length, index = mounted.state.index;
    panel.innerHTML = `<header><span>${esc(mode === 'tour' ? `${index + 1} ${tr('من', 'of')} ${count}` : tr('شرح الحقل', 'Field help'))}</span><button type="button" data-tour-close aria-label="${escHtml(tr('إخفاء الشرح', 'Hide help'))}">×</button></header><h4 id="employee-tour-title" tabindex="-1">${esc(step.title)}</h4><p>${esc(step.text)}</p>${mode === 'tour' ? `<progress value="${index + 1}" max="${count}" aria-label="${escHtml(tr('تقدّم الجولة', 'Tour progress'))}"></progress><footer><button type="button" data-tour-prev${index ? '' : ' disabled'}>${esc(tr('السابق', 'Previous'))}</button><button type="button" data-tour-skip>${esc(tr('تخطي الجولة', 'Skip tour'))}</button><button type="button" data-tour-next>${esc(index === count - 1 ? tr('إنهاء الجولة', 'Finish tour') : tr('التالي', 'Next'))}</button></footer>` : `<footer><button type="button" data-tour-full>${esc(tr('الجولة الكاملة', 'Full tour'))}</button><button type="button" data-tour-close>${esc(tr('فهمت', 'Got it'))}</button></footer>`}`;
    document.body.append(spot, panel);
    active = { target: step.target, panel, spot, mode, trigger };
    trigger?.setAttribute('aria-expanded', 'true'); trigger?.setAttribute('aria-controls', panel.id);
    panel.querySelectorAll('[data-tour-close]').forEach(button => button.addEventListener('click', () => close()));
    panel.querySelector('[data-tour-prev]')?.addEventListener('click', () => move(-1));
    panel.querySelector('[data-tour-next]')?.addEventListener('click', () => move(1));
    panel.querySelector('[data-tour-skip]')?.addEventListener('click', () => { persist(); close(); });
    panel.querySelector('[data-tour-full]')?.addEventListener('click', start);
    root.addEventListener('resize', schedulePosition);
    root.visualViewport?.addEventListener('resize', schedulePosition);
    root.visualViewport?.addEventListener('scroll', schedulePosition);
    document.addEventListener('scroll', schedulePosition, true);
    document.addEventListener('keydown', keydown, true);
    position(); updateToolbar();
    panel.querySelector('h4').focus({ preventScroll: true });
  }
  function addFieldHelp(target, heading, info) {
    if (!target || !heading) return;
    if (heading.tagName === 'LABEL') {
      const wrapper = document.createElement('span'); wrapper.className = 'employee-tour-field-heading';
      [...heading.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).forEach(node => wrapper.append(node));
      heading.prepend(wrapper); heading = wrapper;
    }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'employee-field-help'; button.textContent = '?';
    button.setAttribute('aria-label', tr('شرح: ', 'Help: ') + info.title); button.setAttribute('aria-expanded', 'false'); button.title = info.title;
    heading.append(button);
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation();
      if (active?.trigger === button) close(); else show({ ...info, target }, 'field', button);
    });
  }
  function mount(host, options = {}) {
    close(false);
    mounted?.observer.disconnect();
    if (!host?.querySelector('form') || !String(currentUser?._id || currentUser?.id || '')) { mounted = null; return; }
    const state = read(), firstVisit = !state.seen, toolbar = document.createElement('div'); toolbar.className = 'employee-tour-toolbar';
    toolbar.innerHTML = '<button type="button" data-tour-start></button>';
    host.querySelector('header').prepend(toolbar);
    mounted = { host, toolbar, state, key: storageKey(), steps: steps(host, options), observer: null, invite: null };
    toolbar.querySelector('[data-tour-start]').addEventListener('click', () => { if (active?.mode === 'tour') close(); else start(); });
    const items = mounted.steps;
    addFieldHelp(items[0]?.target, host.querySelector('.employee-session-name'), items[0]);
    addFieldHelp(host.querySelector('.employee-session-latest'), host.querySelector('.employee-session-latest h4'), { title: tr('آخر تعليق', 'Latest comment'), text: tr('هذا آخر تعليق كتبه أحد الموظفين. اضغط الفقاعة لقراءة المسار كاملًا قبل التواصل مع العميل.', 'This is the latest staff comment. Click the bubble to read the full trail before contacting the customer.') });
    addFieldHelp(host.querySelector('.employee-session-contact-history'), host.querySelector('.employee-session-contact-history h4'), { title: tr('آخر تواصل مسجّل', 'Last recorded contact'), text: tr('تظهر هنا وسيلة آخر تواصل ونتيجة المكالمة إن كانت مسجّلة. عدم وجود سجل لا يعني أن العميل لم يُتصل به من خارج النظام.', 'This shows the latest recorded channel and call outcome. An empty log does not rule out contact outside the system.') });
    [2, 3, 4].forEach(index => addFieldHelp(items[index]?.target, items[index]?.target, items[index]));
    addFieldHelp(items[5]?.target, host.querySelector('.employee-session-reminder legend'), items[5]);
    addFieldHelp(items[6]?.target, items[6]?.target, items[6]);
    if (firstVisit) {
      const invite = document.createElement('div'); invite.className = 'employee-tour-invite';
      invite.innerHTML = `<p>${esc(tr('أول مرة هنا؟ تعرّف على خطوات متابعة العميل في جولة سريعة اختيارية.', 'First time here? Take an optional quick tour of the customer follow-up steps.'))}</p><div><button type="button" data-tour-begin>${esc(tr('ابدأ الشرح', 'Take the tour'))}</button><button type="button" data-tour-later>${esc(tr('ليس الآن', 'Not now'))}</button></div>`;
      host.querySelector('.employee-session-progress').after(invite); mounted.invite = invite; state.seen = true; persist();
      invite.querySelector('[data-tour-begin]').addEventListener('click', start);
      invite.querySelector('[data-tour-later]').addEventListener('click', () => invite.remove());
    }
    mounted.observer = new MutationObserver(() => { if (!host.isConnected || !host.closest('#modal-overlay.active')) { close(false); mounted?.observer.disconnect(); } });
    mounted.observer.observe(host.closest('#modal-overlay'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    updateToolbar();
  }
  root.EmployeeFollowUpTour = { mount };
})(window);
