(function (root) {
  'use strict';
  let session = null;
  const owner = () => String(currentUser?._id || currentUser?.id || '');
  const en = () => currentLang === 'en';
  const label = (ar, english) => en() ? english : ar;
  const queue = () => myFollowUpPriorities(false).filter(row => row.f.id && !row.f.isConfirmation);
  const reasonsFor = row => row.shippingIssue
    ? ['carrier_delay', 'awaiting_customer', 'customer_postponed', 'awaiting_return']
    : row.f.reason === 'عملية تأكيد الطلب'
      ? ['confirmation_contact', 'awaiting_deposit', 'confirm_details', 'customer_postponed']
      : ['awaiting_customer', 'customer_postponed'];
  const localTime = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const newRequestId = () => {
    if (root.crypto.randomUUID) return root.crypto.randomUUID();
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  };
  const remaining = () => {
    if (!session || session.owner !== owner()) return [];
    const active = new Map(queue().map(row => [String(row.f.id), row]));
    return session.ids.filter(id => !session.saved.has(id) && !session.skipped.has(id)).map(id => active.get(id)).filter(Boolean);
  };
  const draftFor = row => {
    const id = String(row.f.id);
    if (!session.drafts.has(id)) session.drafts.set(id, {
      reason: reasonsFor(row)[0], channel: 'phone', note: '',
      reminderMode: 'relative', reminderMinutes: 30,
      until: localTime(new Date(Date.now() + 30 * 60000)), requestId: newRequestId(), pendingPayload: null,
    });
    const draft = session.drafts.get(id);
    if (!reasonsFor(row).includes(draft.reason)) draft.reason = reasonsFor(row)[0];
    return draft;
  };

  function mountChoiceMenus(host) {
    host.querySelectorAll('.employee-session-fields select').forEach(select => {
      const fieldLabel = select.closest('label');
      const caption = fieldLabel.textContent.replace(select.textContent, '').trim();
      const wrapper = document.createElement('div');
      wrapper.className = 'employee-session-choice';
      const menuId = 'employee-session-options-' + select.name;
      wrapper.innerHTML = `<button type="button" class="employee-session-choice-toggle" role="combobox" aria-label="${escHtml(caption)}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${menuId}"><span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button><div class="employee-session-choice-menu" id="${menuId}" role="listbox" aria-label="${escHtml(caption)}" hidden>${Array.from(select.options).map((option, index) => `<button type="button" role="option" tabindex="-1" id="${menuId}-${index}" data-choice-index="${index}"><span>${esc(option.textContent)}</span><span class="employee-session-choice-check" aria-hidden="true">✓</span></button>`).join('')}</div>`;
      select.after(wrapper);
      select.hidden = true;
      select.tabIndex = -1;
      const toggle = wrapper.querySelector('.employee-session-choice-toggle');
      const menu = wrapper.querySelector('[role=listbox]');
      const options = Array.from(menu.children);
      let active = select.selectedIndex;
      const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.removeAttribute('aria-activedescendant'); };
      const highlight = () => {
        options.forEach((option, index) => option.classList.toggle('is-active', index === active));
        toggle.setAttribute('aria-activedescendant', options[active].id);
        options[active].scrollIntoView({ block: 'nearest' });
      };
      const sync = () => {
        toggle.querySelector('span').textContent = select.selectedOptions[0]?.textContent || '';
        options.forEach((option, index) => option.setAttribute('aria-selected', String(index === select.selectedIndex)));
      };
      const open = () => {
        host.querySelectorAll('.employee-session-choice-toggle[aria-expanded=true]').forEach(other => { if (other !== toggle) other.click(); });
        active = select.selectedIndex;
        menu.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        const bounds = toggle.getBoundingClientRect();
        const available = host.querySelector('.employee-session-body').getBoundingClientRect();
        const below = Math.min(innerHeight, available.bottom) - bounds.bottom - 12;
        const above = bounds.top - Math.max(0, available.top) - 12;
        const opensAbove = below < 180 && above > below;
        wrapper.classList.toggle('opens-above', opensAbove);
        menu.style.maxHeight = Math.max(88, Math.min(220, opensAbove ? above : below)) + 'px';
        highlight();
      };
      const choose = index => {
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync(); close(); toggle.focus({ preventScroll: true });
      };
      toggle.addEventListener('click', () => menu.hidden ? open() : close());
      toggle.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === 'Tab') { close(); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (menu.hidden) open();
          else active = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
          highlight();
        } else if (['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          if (menu.hidden) open(); else choose(active);
        }
      });
      menu.addEventListener('pointerdown', event => event.preventDefault());
      menu.addEventListener('click', event => {
        const option = event.target.closest('[data-choice-index]');
        if (option) choose(Number(option.dataset.choiceIndex));
      });
      host.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target)) close(); });
      wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
      select.addEventListener('change', sync);
      host.querySelector('.employee-session-form').addEventListener('change', sync);
      sync();
    });
  }

  function contactSummary(f) {
    const contact = f.latestContact;
    const outcome = contact?.outcome === 'answered' ? label('تم الرد', 'Answered')
      : contact?.outcome === 'no_answer' ? label('لم يتم الرد', 'No answer') : '';
    const channel = contact?.channel === 'vrobo' ? 'Vrobo' : label('اتصال هاتفي', 'Phone call');
    const result = contact?.outcome === 'answered' ? 'answered' : contact?.outcome === 'no_answer' ? 'no_answer' : 'recorded';
    const icon = contact?.channel === 'vrobo'
      ? '<path d="M21 11.5a8.5 8.5 0 0 1-12 7.7L3 21l1.8-6A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8 10h8M8 14h5"/>'
      : '<path d="m6 3-3 2c0 8 5 13 13 16l3-3-4-4-3 2c-3-1-5-3-6-6l2-3Z"/>'
        + (result === 'answered' ? '<path d="m14 5 2 2 5-5"/>' : result === 'no_answer' ? '<path d="m15 3 6 6m0-6-6 6"/>' : '<path d="M16 4h5m-2-2 2 2-2 2"/>');
    const when = contact?.at && Number.isFinite(new Date(contact.at).getTime())
      ? new Intl.DateTimeFormat(en() ? 'en-GB' : 'ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(contact.at)) : '';
    return `<section class="employee-session-contact-history"><h4>${esc(label('آخر تواصل مسجّل', 'Last recorded contact'))}</h4>${contact
      ? `<div class="employee-session-result-line"><span class="employee-session-result-icon" data-outcome="${result}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span><strong>${esc(channel)}${outcome ? ` · ${esc(outcome)}` : ''}</strong></div><div>${contact.authorName ? `<span dir="auto">${esc(contact.authorName)}</span>` : ''}${when ? `<time datetime="${escHtml(contact.at)}" title="${escHtml(fmtDateTime(contact.at))}">${esc(when)}</time>` : ''}</div>`
      : `<p>${esc(label('لا يوجد تواصل مسجّل بعد', 'No contact recorded yet'))}</p>`}</section>`;
  }

  root.startMyFollowUpSession = function () {
    if (isAdmin() || !_requirePageAccess('followups') || !owner()) return;
    if (!session || session.owner !== owner() || !remaining().length) {
      session = { owner: owner(), ids: queue().map(row => String(row.f.id)), saved: new Set(), skipped: new Set(), drafts: new Map(), busy: false, currentId: '', lastSaved: '' };
    }
    render();
  };

  function render() {
    if (!session || session.owner !== owner()) return;
    const rows = remaining(), row = rows[0], total = session.ids.length;
    const noLongerDue = Math.max(0, total - rows.length - session.saved.size - session.skipped.size);
    session.currentId = row ? String(row.f.id) : '';
    const summary = `<div class="employee-session-progress"><div><span>${esc(label('تمت متابعتها', 'Followed up'))} <bdi>${fmtN(session.saved.size)}</bdi></span><span>${esc(label('متبقي', 'Remaining'))} <bdi>${fmtN(rows.length)}</bdi></span>${session.skipped.size ? `<span>${esc(label('تم تخطيها', 'Skipped'))} <bdi>${fmtN(session.skipped.size)}</bdi></span>` : ''}${noLongerDue ? `<span>${esc(label('لم تعد مستحقة', 'No longer due'))} <bdi>${fmtN(noLongerDue)}</bdi></span>` : ''}</div><progress value="${total - rows.length}" max="${Math.max(1, total)}" aria-label="${escHtml(label('تقدّم جلسة المتابعة', 'Follow-up session progress'))}"></progress></div>`;
    const confirmationCount = myPendingConfirmationCount();
    const empty = `<div class="employee-session-empty"><span aria-hidden="true">✓</span><h3>${esc(label(total ? 'انتهت متابعات الجلسة' : 'لا توجد متابعات مستحقة الآن', total ? 'Session follow-ups finished' : 'No follow-ups due now'))}</h3><p>${esc(label('الطلبات المجدولة ترجع إلى الأولوية في موعدها. يمكنك الرجوع للمتابعات التي تخطّيتها في جلسة جديدة.', 'Scheduled requests return to your priorities when due. Start a new session to revisit skipped requests.'))}</p>${session.saved.size ? `<p class="employee-session-saved">${esc(label('تم تسجيل نتيجة التواصل وموعد الخطوة القادمة للطلبات التي تابعتها.', 'Contact notes and next follow-up times were saved.'))}</p>` : ''}${confirmationCount && _canAccessPage('shopify-orders') ? `<button type="button" class="btn btn-outline" data-session-confirm>${esc(label('مراجعة طلبات التأكيد', 'Review confirmation orders'))} <bdi>${fmtN(confirmationCount)}</bdi></button>` : ''}<button type="button" class="btn btn-primary" data-session-close>${esc(label('العودة لمهامي', 'Back to my tasks'))}</button></div>`;
    let body = empty;
    if (row) {
      const f = row.f, draft = draftFor(row);
      const reminderAt = draft.reminderMode === 'custom' ? new Date(draft.until) : new Date(Date.now() + draft.reminderMinutes * 60000);
      const reminderPreview = Number.isFinite(reminderAt.getTime()) ? fmtDateTime(reminderAt.toISOString()) : label('اختر موعدًا قادمًا', 'Choose a future time');
      const reasons = reasonsFor(row);
      const reasonLabels = { confirmation_contact: label('إعادة التواصل للتأكيد', 'Contact to confirm'), awaiting_deposit: label('متابعة سداد العربون', 'Follow up deposit'), confirm_details: label('تأكيد بيانات الطلب', 'Confirm details'), awaiting_customer: label('انتظار رد العميل', 'Await reply'), customer_postponed: label('العميل طلب التأجيل', 'Customer postponed'), carrier_delay: label('انتظار الناقل', 'Await carrier'), awaiting_return: label('انتظار المرتجع', 'Await return') };
      body = `<div class="employee-session-order"><div><bdi>#${esc(f.orderRef || f.ticketNo || '—')}</bdi><span class="employee-session-name"><strong dir="auto">${esc(f.clientName || '')}</strong>${renderMyFollowUpContacts(f, true)}</span></div><span>${esc(row.shippingIssue ? myDeliveryIssueLabel(f) : _fuStatusLabel(f.status || ''))}</span>${myFollowUpWaitLabel(row.minutes) ? `<small>${esc(myFollowUpWaitLabel(row.minutes))}</small>` : ''}<button type="button" class="employee-session-trail" data-session-trail>${esc(label('مسار المتابعة', 'Follow-up trail'))} ↗</button></div>
        <div class="employee-session-context"><section class="employee-session-latest"><h4>${esc(label('آخر تعليق', 'Latest comment'))}</h4>${f.latestComment ? renderMyFollowUpComment(f) : `<p>${esc(label('لا توجد تعليقات بعد', 'No comments yet'))}</p>`}</section>${contactSummary(f)}</div>
        <form class="employee-session-form"><section class="employee-session-entry"><div class="employee-session-fields"><label>${esc(label('الخطوة القادمة', 'Next step'))}<select name="reason">${reasons.map(reason => `<option value="${reason}" title="${escHtml(myDeferReasonLabel(reason))}"${reason === draft.reason ? ' selected' : ''}>${esc(reasonLabels[reason])}</option>`).join('')}</select></label><label>${esc(label('قناة التواصل', 'Contact channel'))}<select name="channel"><option value="phone"${draft.channel === 'phone' ? ' selected' : ''}>${esc(label('اتصال', 'Phone'))}</option><option value="vrobo"${draft.channel === 'vrobo' ? ' selected' : ''}>Vrobo</option></select></label></div>
        <label>${esc(label('ما الذي تم مع العميل؟', 'What happened with the customer?'))}<textarea name="note" rows="2" required minlength="3" maxlength="400" placeholder="${escHtml(label('اكتب نتيجة التواصل والخطوة المتفق عليها…', 'Record the contact outcome and agreed next step…'))}">${esc(draft.note)}</textarea></label></section>
        <fieldset class="employee-session-reminder"><legend>${esc(label('فكّرني أتواصل مع العميل بعد', 'Remind me to contact the customer in'))}</legend><div class="employee-session-times" role="group" aria-label="${escHtml(label('موعد التذكير', 'Reminder time'))}">${[10, 30, 60, 120].map(minutes => `<button type="button" data-session-minutes="${minutes}" aria-pressed="${draft.reminderMode === 'relative' && draft.reminderMinutes === minutes}">${esc(minutes === 10 ? label('10 دقايق', '10 min') : minutes === 30 ? label('نصف ساعة', '30 min') : minutes === 60 ? label('ساعة', '1 hour') : label('ساعتين', '2 hours'))}</button>`).join('')}<button type="button" data-session-custom aria-pressed="${draft.reminderMode === 'custom'}">${esc(label('تحديد موعد', 'Choose date'))}</button></div><span class="employee-session-reminder-preview" aria-live="polite">${esc(label('المتابعة القادمة: ', 'Next follow-up: '))}<span data-reminder-preview>${esc(reminderPreview)}</span></span><label class="employee-session-custom-time"${draft.reminderMode === 'custom' ? '' : ' hidden'}>${esc(label('تاريخ ووقت المتابعة', 'Follow-up date and time'))}<input name="until" type="datetime-local"${draft.reminderMode === 'custom' ? ' required' : ' disabled'} min="${localTime(new Date(Date.now() + 60000))}" value="${escHtml(draft.until)}"></label></fieldset>
        <p class="employee-session-error" role="alert" hidden></p><div class="employee-session-controls"><button type="submit" class="btn btn-primary"><span>${esc(label('حفظ المتابعة والتالي', 'Save follow-up & next'))}</span><span class="employee-session-next-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></span></button><button type="button" class="btn btn-outline" data-session-skip>${esc(label('تخطي الآن', 'Skip for now'))}</button></div></form>`;
    }
    openModal(`<section class="employee-session"><header><div><h3 tabindex="-1">${esc(label('إنجاز المتابعات', 'Follow-up session'))}</h3><p>${esc(label('تواصل، سجّل النتيجة، وحدّد الخطوة القادمة.', 'Contact the customer, record the outcome and plan the next step.'))}</p></div><button type="button" class="modal-x" data-session-close aria-label="${escHtml(t('close'))}">×</button></header>${summary}<div class="employee-session-body">${session.lastSaved ? `<p class="employee-session-success" role="status">${esc(session.lastSaved)}</p>` : ''}${body}</div></section>`, 'width:calc(100vw - 24px);max-width:540px;padding:0;overflow:hidden;max-height:calc(100dvh - 32px)');
    const host = document.querySelector('.employee-session');
    host.querySelectorAll('[data-session-close]').forEach(button => button.addEventListener('click', closeModal));
    host.querySelector('[data-session-confirm]')?.addEventListener('click', () => { closeModal(); openMyConfirmationOrders(); });
    if (!row) return;
    const id = String(row.f.id), form = host.querySelector('form'), draft = draftFor(row);
    const resetPending = () => { if (draft.pendingPayload) { draft.pendingPayload = null; draft.requestId = newRequestId(); } };
    const remember = () => {
      const values = { reason: form.elements.reason.value, channel: form.elements.channel.value, note: form.elements.note.value, until: form.elements.until.value };
      if (Object.keys(values).some(key => values[key] !== draft[key])) resetPending();
      Object.assign(draft, values);
      const date = new Date(draft.until);
      if (draft.reminderMode === 'custom') host.querySelector('[data-reminder-preview]').textContent = Number.isFinite(date.getTime()) ? fmtDateTime(date.toISOString()) : label('اختر موعدًا قادمًا', 'Choose a future time');
    };
    form.addEventListener('input', remember);
    form.addEventListener('change', remember);
    host.querySelector('[data-session-trail]').addEventListener('click', () => { remember(); closeModal(); openMyFollowUpTrail(id); });
    host.querySelector('.employee-session-latest')?.addEventListener('click', event => { if (event.target.closest('.employee-comment-message:not(:disabled)')) { remember(); closeModal(); } }, true);
    host.querySelector('.employee-session-name .employee-sample-contacts').addEventListener('click', event => {
      const link = event.target.closest('.employee-contact-shortcut');
      if (link) { form.elements.channel.value = link.classList.contains('is-vrobo') ? 'vrobo' : 'phone'; form.elements.channel.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    const syncReminder = () => {
      const custom = draft.reminderMode === 'custom';
      form.querySelector('.employee-session-custom-time').hidden = !custom;
      form.elements.until.disabled = !custom; form.elements.until.required = custom;
      form.querySelectorAll('[data-session-minutes]').forEach(button => button.setAttribute('aria-pressed', String(!custom && Number(button.dataset.sessionMinutes) === draft.reminderMinutes)));
      form.querySelector('[data-session-custom]').setAttribute('aria-pressed', String(custom));
      if (!custom) host.querySelector('[data-reminder-preview]').textContent = fmtDateTime(new Date(Date.now() + draft.reminderMinutes * 60000).toISOString());
    };
    form.querySelectorAll('[data-session-minutes]').forEach(button => button.addEventListener('click', () => {
      resetPending(); draft.reminderMode = 'relative'; draft.reminderMinutes = Number(button.dataset.sessionMinutes);
      form.elements.until.value = localTime(new Date(Date.now() + draft.reminderMinutes * 60000));
      syncReminder(); remember();
    }));
    form.querySelector('[data-session-custom]').addEventListener('click', () => {
      resetPending(); draft.reminderMode = 'custom';
      syncReminder(); remember(); form.elements.until.focus({ preventScroll: true });
    });
    form.querySelector('[data-session-skip]').addEventListener('click', () => { if (!session.busy) { remember(); session.skipped.add(id); session.lastSaved = ''; render(); } });
    form.addEventListener('submit', event => { event.preventDefault(); remember(); save(row, form, host); });
    mountChoiceMenus(host);
    root.EmployeeFollowUpTour?.mount(host, { confirmation: row.f.reason === 'عملية تأكيد الطلب', shippingIssue: !!row.shippingIssue });
  }

  async function save(row, form, host) {
    const state = session, id = String(row.f.id);
    if (!state || state.busy || !form.reportValidity()) return;
    const error = form.querySelector('.employee-session-error'), draft = draftFor(row);
    const until = draft.pendingPayload ? new Date(draft.pendingPayload.until)
      : draft.reminderMode === 'custom' ? new Date(draft.until) : new Date(Date.now() + draft.reminderMinutes * 60000);
    if (!draft.note.trim() || !Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) {
      error.hidden = false; error.textContent = label('اكتب نتيجة التواصل واختر موعدًا قادمًا.', 'Record the outcome and choose a future time.'); return;
    }
    if (!remaining().some(item => String(item.f.id) === id)) { render(); return; }
    state.busy = true;
    error.hidden = true;
    form.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = true; });
    try {
      draft.pendingPayload = draft.pendingPayload || {
        reason: draft.reason, channel: draft.channel, until: until.toISOString(), requestId: draft.requestId,
        note: `${draft.channel === 'vrobo' ? 'Vrobo' : label('اتصال', 'Phone')}: ${draft.note.trim()}`,
      };
      await api('/followups/' + encodeURIComponent(id) + '/defer', { method: 'POST', body: JSON.stringify(draft.pendingPayload) });
      if (session !== state || state.owner !== owner()) return;
      state.saved.add(id); state.drafts.delete(id);
      state.lastSaved = label('تم حفظ المتابعة. الموعد القادم: ', 'Follow-up saved. Next reminder: ') + fmtDateTime(until.toISOString());
      await loadMyWorkspace();
    } catch (err) {
      if (host.isConnected) { error.hidden = false; error.textContent = err.message || label('تعذّر حفظ المتابعة. أعد المحاولة.', 'Could not save the follow-up. Try again.'); }
    } finally {
      state.busy = false;
      if (session === state && state.owner === owner() && document.querySelector('#modal-overlay.active .employee-session')) {
        if (state.saved.has(id)) render();
        else if (document.querySelector('.employee-session') === host) {
          form.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = false; });
          form.elements.until.disabled = draft.reminderMode !== 'custom';
        }
        else render();
      }
    }
  }

  root.refreshMyFollowUpSession = function () {
    if (!session || session.owner !== owner() || session.busy || !document.querySelector('#modal-overlay.active .employee-session')) return;
    if (session.currentId && !remaining().some(row => String(row.f.id) === session.currentId)) render();
  };
})(window);
