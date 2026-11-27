/* Shopify orders — «تأجيل التواصل» (confirmation deferral) and «فحص العنوان» (Nov 25, 2026).
 *
 * Confirmation deferral: the customer has NOT confirmed yet and asked to be contacted
 * later. Different from «تأجيل الشحن» (a confirmed customer who wants delivery later):
 * it never blocks confirming and ends by itself once the order leaves «pending».
 * Server: PATCH/DELETE /shopify/orders/:id/confirmation-deferral; reminder at the time.
 * ⚠ SCD_REASONS mirrors CONFIRMATION_DEFERRAL_REASONS (backend confirmation-deferral.util.ts).
 *
 * Address check: shown in the confirm dialog. Errors (no phone / invalid phone / no
 * address / no governorate) disable «تأكيد» until the operator ticks that the data was
 * reviewed with the customer; warnings only inform. Bulk confirm skips orders with errors.
 * ⚠ Browser-side rule only — the server does not re-check the address.
 */
(function () {
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const tx = (ar, e) => (en() ? e : ar);
  const H = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SCD_REASONS = [
    ['call_later', 'طلب العميل الاتصال لاحقًا', 'Customer asked to be called later'],
    ['no_answer', 'لا يرد على الهاتف', 'No answer'],
    ['consulting', 'يستشير شخصًا آخر', 'Consulting someone else'],
    ['awaiting_payment', 'ينتظر موعد الدفع', 'Waiting for payday'],
    ['busy', 'العميل مشغول الآن', 'Customer busy right now'],
    ['other', 'سبب آخر', 'Other reason'],
  ];
  const reasonLabel = code => { const r = SCD_REASONS.find(x => x[0] === code); return r ? (en() ? r[2] : r[1]) : ''; };

  /* Unconfirmed orders only (owner, Nov 25, 2026). ⚠ = orderAwaitsConfirmation (backend confirmation-deferral.util.ts). */
  function awaitsConfirmation(o) {
    if (!o || o.status !== 'pending' || o.cancelled || o.shopifyCancelled) return false;
    if (o.shipWithoutDeposit === true || o.confirmationApproved) return false;
    /* A Shopify «confirmed» tag does not count (owner, Nov 27, 2026). */
    return !(o.depositReceipts || []).some(r => ['معتمد', 'معلق'].includes(r?.status) && Number(r?.amount) > 0);
  }
  function active(o) {
    return awaitsConfirmation(o) && ['scheduled', 'due'].includes(o.confirmationDeferral?.status);
  }
  function isDue(o) { return active(o) && Date.parse(o.confirmationDeferral.dueAt || '') <= Date.now(); }

  /* Short, language-aware time: «اليوم 8:00م», «غدًا 11:00ص», «28/11 6:00م». Cairo wall clock. */
  function whenShort(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const loc = en() ? 'en-GB' : 'ar-EG-u-nu-latn';
    const ymd = x => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(x);
    const time = new Intl.DateTimeFormat(loc, { timeZone: 'Africa/Cairo', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
    const today = ymd(new Date()), tomorrow = ymd(new Date(Date.now() + 86400000));
    if (ymd(d) === today) return tx('اليوم ', 'Today ') + time;
    if (ymd(d) === tomorrow) return tx('غدًا ', 'Tomorrow ') + time;
    return new Intl.DateTimeFormat(loc, { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit' }).format(d) + ' ' + time;
  }
  function whenFull(iso) {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(en() ? 'en-GB' : 'ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(d) : '';
  }
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2"/><path d="M17 3v4h4"/><path d="M21 3l-4 4"/></svg>';

  function badgeHtml(o) {
    if (!active(o)) return '';
    const d = o.confirmationDeferral, due = isDue(o);
    const title = [due ? tx('حان موعد التواصل مع العميل', 'Time to contact the customer') : tx('تأجيل التواصل حتى ', 'Contact postponed until ') + whenFull(d.dueAt),
      reasonLabel(d.reasonCode), d.note, d.createdBy ? tx('بواسطة ', 'by ') + d.createdBy : '',
      d.count > 1 ? tx(`التأجيل رقم ${d.count}`, `Postponed ${d.count} times`) : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="scd-tag is-icon${due ? ' is-due' : ''}" title="${H(title)}" aria-label="${H(title)}" onclick="event.stopPropagation();openSpConfirmDeferral('${H(String(o._id))}')">${ICON}${d.count > 1 ? `<i>${d.count}</i>` : ''}</button>`;
  }

  function menuItemHtml(o, tag = 'div') {
    if (!awaitsConfirmation(o)) return '';
    return `<${tag} ${tag === 'button' ? 'type="button" ' : ''}class="dd-item" onclick="openSpConfirmDeferral('${H(String(o._id))}')">${ICON.replace('<svg ', '<svg class="scd-mi" ')}<span>${H(active(o) ? tx('تعديل موعد التواصل', 'Change call-back time') : tx('تأجيل التواصل مع العميل', 'Postpone customer contact'))}</span></${tag}>`;
  }

  /* Quick view: ONE compact block holding both postpones, one slim row each.
     «تأجيل التواصل» = before confirming · «تأجيل الشحن» = after confirming. */
  const SHIP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 9h16"/><circle cx="15.5" cy="15.5" r="3.5"/><path d="M15.5 13.5v2l1.3.8"/></svg>';
  const SHIP_REASON_KEY = { customer_request: 'spPostponeReasonCustomer', stock_shortage: 'spPostponeReasonStock', customer_unavailable: 'spPostponeReasonUnavailable',
    address_confirmation: 'spPostponeReasonAddress', payment_pending: 'spPostponeReasonPayment', operations_capacity: 'spPostponeReasonCapacity', other: 'spPostponeReasonOther' };
  function row(kind, icon, label, sub, chip, actions) {
    return `<div class="scd-pp-row is-${kind}${chip ? ' is-on' : ''}"><span class="scd-pp-ic">${icon}</span><span class="scd-pp-txt"><b>${H(label)}</b><small>${sub}</small></span>${chip}<span class="scd-pp-act">${actions}</span></div>`;
  }
  function peekHtml(o, opts = {}) {
    if (!o || o.status !== 'pending' || o.cancelled) return '';
    const id = H(String(o._id)), rows = [];
    const btn = (label, fn, cls = '') => `<button type="button"${cls ? ` class="${cls}"` : ''} onclick="${fn}('${id}')">${H(label)}</button>`;
    // 1 — contact (before confirming) — unconfirmed orders only
    if (!awaitsConfirmation(o)) { /* confirmed: no contact row */ }
    else if (active(o)) {
      const d = o.confirmationDeferral, due = isDue(o);
      const sub = [reasonLabel(d.reasonCode), d.createdBy].filter(Boolean).map(H).join(' · ') + (d.note ? ` · <bdi dir="auto">${H(d.note)}</bdi>` : '');
      rows.push(row('contact', ICON, tx('تأجيل التواصل', 'Contact postponed'), sub,
        `<span class="scd-pp-chip${due ? ' is-due' : ''}"><bdi>${H(due ? tx('حان الموعد', 'Due now') : whenShort(d.dueAt))}</bdi></span>`,
        btn(tx('تغيير', 'Change'), 'openSpConfirmDeferral') + btn(tx('إلغاء', 'Remove'), 'cancelSpConfirmDeferral', 'is-remove')));
    } else {
      rows.push(row('contact', ICON, tx('تأجيل التواصل', 'Postpone contact'), H(tx('قبل التأكيد', 'Before confirming')), '',
        btn(tx('تحديد موعد', 'Set time'), 'openSpConfirmDeferral')));
    }
    // 2 — shipping (after confirming) — same rules as before: perm + confirmable order
    const ship = typeof _spPostponementActive === 'function' && _spPostponementActive(o) ? o.shippingPostponement : null;
    if (ship || opts.canShip) {
      const T = k => (typeof t === 'function' ? t(k) : k);
      if (ship) {
        const due = Date.parse(ship.dueAt || '') <= Date.now();
        const date = typeof _spFormatShippingDue === 'function' ? _spFormatShippingDue(ship.dueAt) : '';
        const sub = [SHIP_REASON_KEY[ship.reasonCode] ? T(SHIP_REASON_KEY[ship.reasonCode]) : '', ship.createdBy].filter(Boolean).map(H).join(' · ') + (ship.reason ? ` · <bdi dir="auto">${H(ship.reason)}</bdi>` : '');
        rows.push(row('ship', SHIP_ICON, T('spPostponeTitle'), sub,
          `<span class="scd-pp-chip is-ship${due ? ' is-due' : ''}"><bdi dir="ltr">${H(due ? T('spPostponeDueBadge') : date)}</bdi></span>`,
          opts.canShip ? btn(tx('تغيير', 'Change'), 'openSpShippingPostponement') + btn(tx('إلغاء', 'Remove'), 'cancelSpShippingPostponement', 'is-remove') : ''));
      } else {
        rows.push(row('ship', SHIP_ICON, T('spPostpone'), H(tx('بعد التأكيد', 'After confirming')), '',
          btn(tx('تحديد موعد', 'Set date'), 'openSpShippingPostponement')));
      }
    }
    if (!rows.length) return '';
    return `<section class="sp-pk-sec scd-pp" aria-label="${H(tx('التأجيل', 'Postpone'))}">${rows.join('')}</section>`;
  }

  /* Quick-view header: both postpones as icon buttons beside the order menu (Nov 25, 2026).
     Not set → a quiet icon. Set → a small pill with its time (amber; red once due); the full
     reason / author / note is in the tooltip, and a click opens the dialog (change or remove). */
  function headHtml(o, opts = {}) {
    if (!o || o.status !== 'pending' || o.cancelled) return '';
    const id = H(String(o._id)), out = [];
    const ico = svg => svg.replace('<svg ', '<svg class="scd-hb-ic" ');
    const name = kind => kind === 'ship' ? tx('تأجيل شحن', 'Delay ship') : tx('تأجيل تواصل', 'Call later');
    const btn = (kind, fn, svg, label, tip, time, due) => `<button type="button" class="scd-hb is-${kind}${time ? ' is-on' : ''}${due ? ' is-due' : ''}" onclick="${fn}('${id}')" aria-label="${H(label)}" title="${H(tip)}">${ico(svg)}<bdi class="scd-hb-l">${H(time || name(kind))}</bdi></button>`;
    if (active(o)) {
      const d = o.confirmationDeferral, due = isDue(o);
      const tip = [tx('تأجيل التواصل حتى ', 'Contact postponed until ') + whenShort(d.dueAt), reasonLabel(d.reasonCode), d.createdBy, d.note].filter(Boolean).join(' · ');
      out.push(btn('contact', 'openSpConfirmDeferral', ICON, tx('تعديل تأجيل التواصل', 'Change contact postponement'), tip, due ? tx('حان الموعد', 'Due') : whenShort(d.dueAt), due));
    } else {
      out.push(btn('contact', 'openSpConfirmDeferral', ICON, tx('تأجيل التواصل', 'Postpone contact'), tx('تأجيل التواصل مع العميل — قبل التأكيد', 'Postpone customer contact — before confirming'), '', false));
    }
    const ship = typeof _spPostponementActive === 'function' && _spPostponementActive(o) ? o.shippingPostponement : null;
    if (ship || opts.canShip) {
      const T = k => (typeof t === 'function' ? t(k) : k);
      if (ship) {
        const due = Date.parse(ship.dueAt || '') <= Date.now();
        const date = typeof _spFormatShippingDue === 'function' ? _spFormatShippingDue(ship.dueAt) : '';
        const tip = [T('spPostponeTitle') + ' · ' + date, SHIP_REASON_KEY[ship.reasonCode] ? T(SHIP_REASON_KEY[ship.reasonCode]) : '', ship.createdBy, ship.reason].filter(Boolean).join(' · ');
        out.push(opts.canShip
          ? btn('ship', 'openSpShippingPostponement', SHIP_ICON, tx('تعديل تأجيل الشحن', 'Change shipping postponement'), tip, due ? T('spPostponeDueBadge') : date, due)
          : `<span class="scd-hb is-ship is-on${due ? ' is-due' : ''}" title="${H(tip)}">${ico(SHIP_ICON)}<bdi class="scd-hb-l">${H(due ? T('spPostponeDueBadge') : date)}</bdi></span>`);
      } else {
        out.push(btn('ship', 'openSpShippingPostponement', SHIP_ICON, tx('تأجيل الشحن', 'Postpone shipping'), tx('تأجيل الشحن — بعد التأكيد', 'Postpone shipping — after confirming'), '', false));
      }
    }
    return `<span class="scd-hbs" role="group" aria-label="${H(tx('التأجيل', 'Postpone'))}">${out.join('')}</span>`;
  }

  /* ── Dialog ── */
  function cairoInput(ms) { ms = Math.ceil(ms / 300000) * 300000; return typeof _spCairoInputValue === 'function' ? _spCairoInputValue(new Date(ms).toISOString()) : ''; }
  /* Picker state — the app's own calendar (same as «تأجيل الشحن») + a 12h time row. Cairo wall clock. */
  const pick = { date: '', month: '', h: 11, m: 0, pm: false };
  const todayCairo = () => cairoAt(0, 0).slice(0, 10);
  function setPick(local) { // 'YYYY-MM-DDTHH:MM'
    const mm = String(local || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/); if (!mm) return;
    const h24 = Number(mm[2]); pick.date = mm[1]; pick.month = mm[1].slice(0, 7);
    pick.pm = h24 >= 12; pick.h = h24 % 12 || 12; pick.m = Math.floor(Number(mm[3]) / 5) * 5;
  }
  const pickLocal = () => `${pick.date}T${String((pick.h % 12) + (pick.pm ? 12 : 0)).padStart(2, '0')}:${String(pick.m).padStart(2, '0')}`;
  function calendarHtml() {
    const [y, mo] = pick.month.split('-').map(Number), first = new Date(Date.UTC(y, mo - 1, 1));
    const loc = en() ? 'en-GB' : 'ar-EG-u-nu-latn', today = todayCairo(), maxDay = cairoAt(14, 0).slice(0, 10);
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    let cells = ''; for (let i = 0; i < first.getUTCDay(); i++) cells += '<span class="sp-calendar-empty"></span>';
    for (let d = 1; d <= days; d++) {
      const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells += `<button type="button" class="sp-calendar-day${date === pick.date ? ' is-selected' : ''}${date === today ? ' is-today' : ''}" ${date < today || date > maxDay ? 'disabled' : ''} onclick="_scdDay('${date}')">${d}</button>`;
    }
    const wk = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + i))));
    return `<div class="sp-calendar-head"><button type="button" aria-label="${H(tx('الشهر السابق', 'Previous month'))}" onclick="_scdMonth(-1)">${en() ? '&#x2039;' : '&#x203A;'}</button><strong>${H(new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first))}</strong><button type="button" aria-label="${H(tx('الشهر التالي', 'Next month'))}" onclick="_scdMonth(1)">${en() ? '&#x203A;' : '&#x2039;'}</button></div><div class="sp-calendar-grid sp-calendar-weekdays">${wk.map(x => `<span>${H(x)}</span>`).join('')}</div><div class="sp-calendar-grid">${cells}</div>`;
  }
  /* Time: two small value buttons (hour · minute) that open a compact number grid,
     then the ص / م switch. Native <select>s took the app's global select style and looked broken. */
  let timeOpen = '';
  function timeHtml() {
    const two = n => String(n).padStart(2, '0');
    const val = (k, v, label) => `<button type="button" class="scd-tv${timeOpen === k ? ' is-open' : ''}" aria-haspopup="true" aria-expanded="${timeOpen === k}" aria-label="${H(label)}" onclick="_scdTimeOpen('${k}')"><bdi>${v}</bdi><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
    const grid = timeOpen === 'h'
      ? Array.from({ length: 12 }, (_, i) => i + 1).map(n => `<button type="button" class="${n === pick.h ? 'is-on' : ''}" onclick="_scdTime('h',${n})">${n}</button>`).join('')
      : timeOpen === 'm'
        ? Array.from({ length: 12 }, (_, i) => i * 5).map(n => `<button type="button" class="${n === pick.m ? 'is-on' : ''}" onclick="_scdTime('m',${n})">${two(n)}</button>`).join('')
        : '';
    return `<span class="scd-time-l">${H(tx('الساعة', 'Time'))}</span>
      <span class="scd-time-f" dir="ltr">${val('h', pick.h, tx('الساعة', 'Hour'))}<b>:</b>${val('m', two(pick.m), tx('الدقائق', 'Minutes'))}<span class="scd-ampm" role="group"><button type="button" aria-pressed="${!pick.pm}" onclick="_scdTime('pm',0)">${H(tx('ص', 'AM'))}</button><button type="button" aria-pressed="${pick.pm}" onclick="_scdTime('pm',1)">${H(tx('م', 'PM'))}</button></span></span>
      ${grid ? `<div class="scd-tgrid" role="listbox" aria-label="${H(timeOpen === 'h' ? tx('الساعة', 'Hour') : tx('الدقائق', 'Minutes'))}">${grid}</div>` : ''}`;
  }
  function redrawPicker(fromQuick) {
    const cal = document.getElementById('scd-calendar'), tm = document.getElementById('scd-time');
    if (cal) cal.innerHTML = calendarHtml();
    if (tm) tm.innerHTML = timeHtml();
    if (!fromQuick) document.querySelectorAll('.scd-quick button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === pickLocal())));
  }
  window._scdDay = date => { pick.date = date; redrawPicker(); };
  window._scdMonth = delta => { const [y, m] = pick.month.split('-').map(Number), n = new Date(Date.UTC(y, m - 1 + delta, 1)); pick.month = `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`; redrawPicker(); };
  window._scdTime = (k, v) => { if (k === 'pm') pick.pm = !!Number(v); else pick[k] = Number(v); timeOpen = ''; redrawPicker(); };
  window._scdTimeOpen = k => { timeOpen = timeOpen === k ? '' : k; redrawPicker(true); document.querySelector('.scd-tgrid .is-on')?.focus(); };

  function cairoAt(dayOffset, hour) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + dayOffset * 86400000)).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, '0')}:00`;
  }
  function quickTimes() {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const list = [[cairoInput(Date.now() + 3600000), tx('بعد ساعة', 'In 1 hour')], [cairoInput(Date.now() + 3 * 3600000), tx('بعد 3 ساعات', 'In 3 hours')]];
    if (h < 19) list.push([cairoAt(0, 20), tx('الليلة 8 م', 'Tonight 8 PM')]);
    list.push([cairoAt(1, 11), tx('غدًا 11 ص', 'Tomorrow 11 AM')], [cairoAt(1, 18), tx('غدًا 6 م', 'Tomorrow 6 PM')]);
    return list;
  }
  function close() { document.getElementById('scd-modal')?.remove(); }

  async function open(id) {
    const order = (typeof _spOrderById === 'function' && _spOrderById(id)) || await (typeof _spEnsureFullOrder === 'function' ? _spEnsureFullOrder(id).catch(() => null) : null);
    if (!order) return;
    if (!awaitsConfirmation(order)) { toast(tx('تأجيل التواصل متاح للطلبات غير المؤكدة فقط', 'Only unconfirmed orders can be postponed'), true); return; }
    close();
    const old = active(order) ? order.confirmationDeferral : null;
    const quick = quickTimes();
    const initial = old ? cairoInput(Date.parse(old.dueAt)) : quick[2][0];
    setPick(initial);
    timeOpen = '';
    const m = document.createElement('div');
    m.id = 'scd-modal'; m.className = 'sp-postpone-overlay';
    m.innerHTML = `<form class="sp-postpone-dialog scd-dialog" onsubmit="saveSpConfirmDeferral(event,'${H(String(id))}')">
      <header><div><span class="sp-postpone-eyebrow">Shopify &#183; #${H(String(order.ref || '').replace(/^#+/, ''))}${order.client ? ' &#183; ' + H(order.client) : ''}</span><h3>${H(tx('تأجيل التواصل مع العميل', 'Postpone customer contact'))}</h3></div><button type="button" class="sp-postpone-close" onclick="document.getElementById('scd-modal').remove()" aria-label="${H(tx('إغلاق', 'Close'))}">&times;</button></header>
      <p class="scd-intro">${H(tx('لم يُؤكَّد الطلب بعد — يُحسب ضمن «متابعة» ويصلك تنبيه في الموعد.', 'Not confirmed yet — counted under «Follow-up»; you are reminded at the time.'))}</p>
      ${old && old.count ? `<p class="scd-count">${H(tx(`سبق تأجيل التواصل ${old.count} ${old.count === 1 ? 'مرة' : 'مرات'}`, `Already postponed ${old.count} time${old.count === 1 ? '' : 's'}`))}</p>` : ''}
      <div class="scd-cols"><div class="scd-col">
      <span class="sp-postpone-field-label">${H(tx('السبب', 'Reason'))}</span>
      <div class="scd-reasons" role="radiogroup">${SCD_REASONS.map(([code]) => `<label class="scd-chip"><input type="radio" name="scd-reason" value="${code}" ${old?.reasonCode === code ? 'checked' : ''} onchange="document.getElementById('scd-note-wrap').classList.toggle('is-required', this.value==='other')"><span>${H(reasonLabel(code))}</span></label>`).join('')}</div>
      <label id="scd-note-wrap" class="scd-note${old?.reasonCode === 'other' ? ' is-required' : ''}"><span>${H(tx('ملاحظة', 'Note'))}<em>${H(tx('(اختيارية — مطلوبة مع «سبب آخر»)', '(optional — required for «Other»)'))}</em></span><textarea id="scd-note" maxlength="240" rows="3" dir="auto" placeholder="${H(tx('مثال: الاتصال بعد الساعة 7 مساءً', 'e.g. call after 7 PM'))}">${H(old?.note || '')}</textarea></label>
      </div><div class="scd-col">
      <span class="sp-postpone-field-label">${H(tx('موعد التواصل', 'Contact at'))}</span>
      <div class="scd-quick">${quick.map(([v, l]) => `<button type="button" data-v="${H(v)}" aria-pressed="${v === initial}" onclick="_scdPickTime(this)">${H(l)}</button>`).join('')}</div>
      <div class="sp-postpone-calendar scd-cal" id="scd-calendar">${calendarHtml()}</div>
      <div class="sp-postpone-time-row scd-time" id="scd-time">${timeHtml()}</div>
      </div></div>
      <p class="scd-err" role="alert"></p>
      <footer>${old ? `<button type="button" class="sp-postpone-remove" onclick="cancelSpConfirmDeferral('${H(String(id))}')">${H(tx('إلغاء التأجيل', 'Remove postponement'))}</button>` : ''}<button type="button" class="sp-postpone-secondary" onclick="document.getElementById('scd-modal').remove()">${H(tx('إلغاء', 'Cancel'))}</button><button type="submit" class="sp-postpone-primary">${H(tx('حفظ الموعد', 'Save time'))}</button></footer></form>`;
    m.addEventListener('click', e => { if (e.target === m) close(); });
    m.addEventListener('keydown', e => { if (e.key !== 'Escape') return; e.stopPropagation(); if (timeOpen) { timeOpen = ''; redrawPicker(true); return; } close(); });
    document.body.append(m);
    m.querySelector('.scd-dialog')?.setAttribute('tabindex', '-1'); m.querySelector('.scd-dialog')?.focus({ preventScroll: true });
  }

  window._scdPickTime = btn => {
    setPick(btn.dataset.v); redrawPicker(true);
    document.querySelectorAll('.scd-quick button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  };

  async function save(event, id) {
    event.preventDefault();
    const form = event.target, err = form.querySelector('.scd-err'), btn = form.querySelector('[type="submit"]');
    const reasonCode = form.querySelector('input[name="scd-reason"]:checked')?.value || '';
    const note = (document.getElementById('scd-note')?.value || '').trim();
    const dueAt = typeof _spCairoLocalToISO === 'function' ? _spCairoLocalToISO(pickLocal()) : '';
    if (!reasonCode) { err.textContent = tx('اختر سبب التأجيل.', 'Choose a reason.'); return; }
    if (reasonCode === 'other' && note.length < 3) { err.textContent = tx('اكتب السبب في الملاحظة.', 'Write the reason in the note.'); document.getElementById('scd-note')?.focus(); return; }
    if (!dueAt || Date.parse(dueAt) <= Date.now() + 60000) { err.textContent = tx('اختر موعدًا قادمًا.', 'Choose a future time.'); return; }
    if (Date.parse(dueAt) > Date.now() + 14 * 86400000) { err.textContent = tx('الموعد يجب أن يكون خلال 14 يومًا.', 'Choose a time within 14 days.'); return; }
    btn.disabled = true; err.textContent = '';
    try {
      const r = await api(`/shopify/orders/${encodeURIComponent(id)}/confirmation-deferral`, { method: 'PATCH', body: JSON.stringify({ dueAt, reasonCode, note }) });
      const o = typeof _spOrderById === 'function' && _spOrderById(id);
      if (o && r?.confirmationDeferral) o.confirmationDeferral = r.confirmationDeferral;
      close();
      toast(tx('تم تأجيل التواصل حتى ', 'Contact postponed until ') + whenShort(dueAt));
      if (typeof loadShopifyOrders === 'function') await loadShopifyOrders();
      if (document.getElementById('sp-peek') && typeof _spPeekRender === 'function') _spPeekRender();
    } catch (e) { err.textContent = e.message || tx('تعذّر حفظ الموعد.', 'Could not save.'); btn.disabled = false; }
  }

  async function cancel(id) {
    const ok = typeof showConfirm === 'function'
      ? await showConfirm(tx('إلغاء تأجيل التواصل؟ يعود الطلب إلى قائمة التأكيد العادية.', 'Remove the postponement? The order returns to the normal confirmation list.'))
      : confirm(tx('إلغاء تأجيل التواصل؟', 'Remove the postponement?'));
    if (!ok) return;
    try {
      await api(`/shopify/orders/${encodeURIComponent(id)}/confirmation-deferral`, { method: 'DELETE' });
      const o = typeof _spOrderById === 'function' && _spOrderById(id);
      if (o?.confirmationDeferral) o.confirmationDeferral = { ...o.confirmationDeferral, status: 'cancelled' };
      close();
      toast(tx('تم إلغاء تأجيل التواصل', 'Postponement removed'));
      if (typeof loadShopifyOrders === 'function') await loadShopifyOrders();
      if (document.getElementById('sp-peek') && typeof _spPeekRender === 'function') _spPeekRender();
    } catch (e) { toast(e.message || tx('تعذّر الإلغاء', 'Could not remove'), true); }
  }

  /* ── Address check ── */
  const latin = s => String(s || '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0));
  const normAr = s => latin(s).replace(/[أإآا]/g, 'ا').replace(/[ةه]/g, 'ه').replace(/ى/g, 'ي').replace(/[ً-ٟـ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  function normPhone(raw) {
    let d = latin(raw).replace(/\D/g, '');
    if (d.startsWith('0020')) d = d.slice(4); else if (d.startsWith('20') && d.length >= 12) d = d.slice(2);
    if (d.startsWith('1') && d.length === 10) d = '0' + d;
    return d;
  }
  function knownGov(...values) {
    const groups = typeof CITY_GROUPS !== 'undefined' && Array.isArray(CITY_GROUPS) ? CITY_GROUPS : null;
    if (!groups) return true; // list not loaded: say nothing rather than a false warning
    const wanted = values.map(normAr).filter(Boolean);
    return groups.some(g => wanted.some(v => {
      const label = normAr(g.label), en = String(g.bostaEn || '').toLowerCase();
      return v === label || v === en || v.includes(label) || (en && v.includes(en)) || g.cities.some(c => normAr(c) === v);
    }));
  }

  function check(o) {
    const errors = [], warnings = [];
    if (!o) return { errors, warnings };
    const raw = o.rawData?.shipping_address || {};
    const phone = normPhone(o.phone || o.clientPhone || raw.phone);
    if (!phone) errors.push(tx('لا يوجد رقم هاتف للعميل', 'No customer phone number'));
    else if (!/^01[0125]\d{8}$/.test(phone)) errors.push(tx(`رقم الهاتف غير صحيح (${phone}) — يجب أن يكون 11 رقمًا يبدأ بـ 010 أو 011 أو 012 أو 015`, `Invalid phone (${phone}) — 11 digits starting 010, 011, 012 or 015`));
    const addr = String(o.shippingAddress || '').replace(/^العنوان:\s*/, '').trim() || [raw.address1, raw.address2].filter(Boolean).join('، ');
    const gov = String(o.shippingGov || raw.province || '').trim();
    const city = String(o.shippingCity || raw.city || '').trim();
    const bosta = String(o.shippingBostaCity || '').trim();
    if (!addr) errors.push(tx('لا يوجد عنوان تفصيلي', 'No street address'));
    else {
      const words = normAr(addr).split(/[\s،,\-]+/).filter(w => w.length > 1);
      if (addr.length < 12 || words.length < 3) warnings.push(tx('العنوان قصير — تأكد من اسم الشارع والمنطقة', 'The address is short — check the street and area'));
      if (!/\d/.test(latin(addr))) warnings.push(tx('لا يحتوي العنوان على رقم عمارة أو شقة', 'No building or flat number in the address'));
      const n = normAr(addr);
      if ([gov, city].some(v => v && normAr(v) === n)) warnings.push(tx('العنوان هو اسم المدينة فقط', 'The address is only the city name'));
    }
    if (!gov && !bosta) errors.push(tx('المحافظة غير محددة', 'No governorate'));
    else if (!bosta && !knownGov(gov, city)) warnings.push(tx(`المحافظة «${gov}» غير موجودة في قائمة مدن الشحن`, `Governorate «${gov}» is not in the shipping list`));
    if (!city) warnings.push(tx('المنطقة / المدينة غير محددة', 'No city / area'));
    return { errors, warnings, phone, addr, gov, city };
  }

  function checkHtml(o) {
    const r = check(o);
    const blocked = r.errors.length > 0;
    const state = blocked ? 'is-error' : r.warnings.length ? 'is-warn' : 'is-ok';
    const head = blocked ? tx('بيانات التوصيل غير مكتملة', 'Delivery details incomplete')
      : r.warnings.length ? tx('راجع العنوان قبل التأكيد', 'Review the address before confirming') : tx('بيانات التوصيل مكتملة', 'Delivery details look complete');
    const line = (cls, text) => `<li class="${cls}">${H(text)}</li>`;
    const place = [r.gov, r.city].filter(Boolean).join(' · ');
    return `<div id="sp-addr-check" class="scd-addr ${state}" data-blocked="${blocked ? '1' : '0'}">
      <div class="scd-addr-h"><b>${H(head)}</b><button type="button" class="scd-addr-edit" onclick="_spdHide(document.getElementById('shopify-confirm-modal'));editShopifyOrder('${H(String(o._id))}')">${H(tx('تعديل البيانات', 'Edit details'))}</button></div>
      <div class="scd-addr-facts">${r.phone ? `<span><small>${H(tx('الهاتف', 'Phone'))}</small><bdi dir="ltr">${H(r.phone)}</bdi></span>` : ''}${place ? `<span><small>${H(tx('المنطقة', 'Area'))}</small><bdi>${H(place)}</bdi></span>` : ''}${r.addr ? `<span class="is-wide"><small>${H(tx('العنوان', 'Address'))}</small><bdi>${H(r.addr)}</bdi></span>` : ''}</div>
      ${r.errors.length || r.warnings.length ? `<ul>${r.errors.map(x => line('is-error', x)).join('')}${r.warnings.map(x => line('is-warn', x)).join('')}</ul>` : ''}
      ${blocked ? `<label class="scd-addr-ack"><input type="checkbox" id="sp-addr-ack" onchange="SouliaAddrCheck.sync()"><span>${H(tx('راجعتُ البيانات مع العميل وأريد المتابعة', 'I reviewed these details with the customer'))}</span></label>` : ''}
    </div>`;
  }

  /* True when the open confirm dialog's address gate is satisfied. */
  function gateOk() {
    const box = document.getElementById('sp-addr-check');
    return !box || box.dataset.blocked !== '1' || !!document.getElementById('sp-addr-ack')?.checked;
  }
  function sync() {
    const btn = document.getElementById('shopify-approve-btn'), modal = document.getElementById('shopify-confirm-modal');
    if (!btn || !modal?._orderId) return;
    const o = typeof _spOrderById === 'function' ? _spOrderById(modal._orderId) : null;
    const base = !!o && !(typeof _spDepositBlockReason === 'function' && _spDepositBlockReason(o)) && (typeof _spStockVerdict !== 'function' || _spStockVerdict(o).ok);
    btn.disabled = !(base && gateOk());
  }

  window.SouliaConfirmDeferral = { awaitsConfirmation, active, isDue, badgeHtml, menuItemHtml, peekHtml, headHtml, reasonLabel };
  window.SouliaAddrCheck = { check, checkHtml, gateOk, sync };
  window._spConfirmDeferralActive = active;
  window.openSpConfirmDeferral = open;
  window.saveSpConfirmDeferral = save;
  window.cancelSpConfirmDeferral = cancel;
})();
