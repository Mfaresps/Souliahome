/*
 * «الجهات المحفوظة» في نموذج المصروف — شركة الإعلان، الموظف، الاشتراك.
 *
 * When the category is اعلانات / مرتبات / اشتراكات the expense form asks WHO it pays and
 * WHICH PERIOD it covers. The party is saved once (`/expenses/payees`) and picked again every
 * month; its usual amount and vault fill in; the description is written for you
 * («إعلانات Nova Media — لشهر نوفمبر 2026») until you edit it yourself.
 *
 * ⚠ Mirrors backend/src/expenses/expense-payee.util.ts: XP_KIND_BY_CAT, XP_PLATFORMS, XP_CYCLES.
 * ⚠ Never opens openModal() — the expense form lives in #modal-overlay and would be replaced.
 */
(function () {
  'use strict';

  const XP_KIND_BY_CAT = { 'اعلانات': 'ads', 'مرتبات': 'salary', 'اشتراكات': 'subscription' };
  const XP_PLATFORMS = [
    { code: 'meta', ar: 'Meta (فيسبوك وإنستجرام)', en: 'Meta (Facebook & Instagram)', short: 'Meta' },
    { code: 'tiktok', ar: 'TikTok', en: 'TikTok', short: 'TikTok' },
    { code: 'google', ar: 'Google', en: 'Google', short: 'Google' },
    { code: 'snapchat', ar: 'Snapchat', en: 'Snapchat', short: 'Snapchat' },
    { code: 'influencer', ar: 'مؤثرون', en: 'Influencers', short: '' },
    { code: 'other', ar: 'أخرى', en: 'Other', short: '' },
  ];
  const XP_CYCLES = [
    { code: 'monthly', ar: 'شهري', en: 'Monthly', months: 1 },
    { code: 'quarterly', ar: 'ربع سنوي', en: 'Quarterly', months: 3 },
    { code: 'yearly', ar: 'سنوي', en: 'Yearly', months: 12 },
  ];
  const ACCOUNTS = ['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'];

  const KIND_TEXT = {
    ads: {
      title: ['شركة الإعلان والفترة', 'Ad agency and period'],
      noun: ['شركة الإعلان', 'Ad agency'],
      ph: ['ابحث عن شركة الإعلان أو اكتب اسمًا جديدًا…', 'Search an agency or type a new name…'],
      add: ['إضافة شركة إعلان', 'Add ad agency'],
      need: ['اختر شركة الإعلان أو أضفها', 'Choose the ad agency or add it'],
      amount: ['الميزانية المعتادة', 'Usual budget'],
    },
    salary: {
      title: ['الموظف وشهر المرتب', 'Employee and salary month'],
      noun: ['الموظف', 'Employee'],
      ph: ['ابحث عن الموظف…', 'Search an employee…'],
      add: ['إضافة موظف', 'Add employee'],
      need: ['اختر الموظف أو أضفه', 'Choose the employee or add them'],
      amount: ['المرتب الشهري', 'Monthly salary'],
    },
    subscription: {
      title: ['الاشتراك والفترة', 'Subscription and period'],
      noun: ['الخدمة', 'Service'],
      ph: ['ابحث عن الخدمة (مثل Shopify) أو اكتب اسمًا جديدًا…', 'Search a service (e.g. Shopify) or type a new one…'],
      add: ['إضافة اشتراك', 'Add subscription'],
      need: ['اختر الاشتراك أو أضفه', 'Choose the subscription or add it'],
      amount: ['سعر الاشتراك', 'Subscription price'],
    },
  };

  const en = () => (typeof currentLang !== 'undefined' && currentLang === 'en');
  const text = (ar, e) => (en() ? e : ar);
  const tx = (pair) => (en() ? pair[1] : pair[0]);
  const h = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const admin = () => (typeof isAdmin === 'function' ? isAdmin() : false);
  const money = (v) => (typeof fmtJ === 'function' ? fmtJ(v) : h(v));
  const locale = () => (en() ? 'en-US' : 'ar-EG-u-nu-latn');
  const todayStr = () => (typeof today === 'function' ? today() : new Date().toISOString().slice(0, 10));

  /* ── dates ──────────────────────────────────────────────────────────── */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
  const parse = (s) => { const [y, m, d] = String(s).split('-').map(Number); return { y, m, d }; };
  function monthRange(monthStr, months) {
    const { y, m } = parse(monthStr + '-01');
    const endIdx = m - 1 + (months || 1) - 1;
    const ey = y + Math.floor(endIdx / 12), em = (endIdx % 12) + 1;
    return { from: ymd(y, m, 1), to: ymd(ey, em, lastDay(ey, em)) };
  }
  function shiftMonth(monthStr, delta) {
    const { y, m } = parse(monthStr + '-01');
    const idx = m - 1 + delta;
    const ny = y + Math.floor(idx / 12), nm = ((idx % 12) + 12) % 12 + 1;
    return `${ny}-${pad(nm)}`;
  }
  const monthName = (y, m, withYear) => new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale(), { month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });

  /** «لشهر نوفمبر 2026» / «لفترة 1 – 15 نوفمبر 2026» — the period as it reads in a title. */
  function periodText(from, to, bare) {
    if (!from || !to) return '';
    const a = parse(from), b = parse(to);
    const fullStart = a.d === 1, fullEnd = b.d === lastDay(b.y, b.m);
    let body;
    if (fullStart && fullEnd) {
      if (a.y === b.y && a.m === b.m) {
        body = monthName(a.y, a.m, true);
        return bare ? body : text(`لشهر ${body}`, `for ${body}`);
      }
      body = a.y === b.y ? `${monthName(a.y, a.m)} – ${monthName(b.y, b.m, true)}` : `${monthName(a.y, a.m, true)} – ${monthName(b.y, b.m, true)}`;
    } else if (a.y === b.y && a.m === b.m) {
      body = `${a.d} – ${b.d} ${monthName(a.y, a.m, true)}`;
    } else {
      const dm = (p, yr) => new Date(Date.UTC(p.y, p.m - 1, p.d)).toLocaleDateString(locale(), { day: 'numeric', month: 'long', ...(yr ? { year: 'numeric' } : {}), timeZone: 'UTC' });
      body = `${dm(a, a.y !== b.y)} – ${dm(b, true)}`;
    }
    return bare ? body : text(`لفترة ${body}`, `for ${body}`);
  }
  const overlap = (aF, aT, bF, bT) => !!(aF && aT && bF && bT) && aF <= bT && bF <= aT;

  /* ── state ──────────────────────────────────────────────────────────── */
  let cache = null, cacheAt = 0, loadError = '', loading = null;
  let S = null; // per open form

  function invalidate() { cache = null; cacheAt = 0; }
  function load(force) {
    if (!force && cache && Date.now() - cacheAt < 60000) return Promise.resolve(cache);
    if (loading) return loading;
    loading = api('/expenses/payees?archived=1', { background: true })
      .then(rows => { cache = Array.isArray(rows) ? rows : []; cacheAt = Date.now(); loadError = ''; return cache; })
      .catch(e => { loadError = e?.message || text('تعذّر تحميل الجهات المحفوظة', 'Could not load saved parties'); throw e; })
      .finally(() => { loading = null; });
    return loading;
  }
  const payeesOf = (kind) => (cache || []).filter(p => p.kind === kind && p.active !== false);
  const findPayee = (id) => (cache || []).find(p => String(p._id) === String(id)) || null;
  const platformOf = (code) => XP_PLATFORMS.find(p => p.code === code);
  const cycleOf = (code) => XP_CYCLES.find(c => c.code === code) || XP_CYCLES[0];
  const cycleMonths = () => (S?.kind === 'subscription' && S.payee ? cycleOf(S.payee.billingCycle).months : 1);

  function kindForCategory(cat) { return XP_KIND_BY_CAT[String(cat || '').trim()] || null; }

  /* ── title + amount suggestions ─────────────────────────────────────── */
  function autoTitle() {
    if (!S?.payee || !S.from || !S.to) return '';
    const name = S.payee.name;
    const when = periodText(S.from, S.to);
    if (S.kind === 'ads') {
      const plat = platformOf(S.payee.platform)?.short;
      const who = plat && plat.toLowerCase() !== String(name).toLowerCase() ? `${name} (${plat})` : name;
      return text(`إعلانات ${who} — ${when}`, `Ads — ${who} — ${when}`);
    }
    if (S.kind === 'salary') return text(`مرتب ${name} — ${when}`, `Salary — ${name} — ${when}`);
    return text(`اشتراك ${name} — ${when}`, `Subscription — ${name} — ${when}`);
  }
  function applyTitle() {
    const desc = $('#em-desc');
    if (!desc || !S) return;
    const title = autoTitle();
    if (!title) return;
    if (!S.descManual || desc.value.trim() === '' || desc.value === S.lastTitle) {
      desc.value = title;
      S.descManual = false;
      desc.classList.remove('is-invalid');
    }
    S.lastTitle = title;
    const prev = $('#xp-title-preview');
    if (prev) prev.innerHTML = S.descManual
      ? `${text('العنوان المقترح:', 'Suggested title:')} <bdi>${h(title)}</bdi> <button type="button" class="xp-link" data-xp="use-title">${text('استخدمه', 'Use it')}</button>`
      : `${text('يُكتب العنوان تلقائيًا — يمكنك تعديله.', 'The title is written for you — you can edit it.')}`;
  }
  /* ── amount field (formatted text — see _expAmountValue in index.html) ── */
  const amountNow = () => (typeof _expAmountValue === 'function' ? _expAmountValue() : (Number($('#em-amount')?.value) || 0));
  function setAmount(n) {
    const amt = $('#em-amount');
    if (!amt) return;
    amt.value = typeof _expFmtAmount === 'function' ? _expFmtAmount(n) : String(n);
    amt.classList.remove('is-invalid');
    const w = $('#em-amount-words');
    if (w && typeof _expAmountWords === 'function') w.textContent = _expAmountWords(n);
  }

  /* ── salary breakdown ─────────────────────────────────────────────────── */
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const num = (v) => (typeof _expAmountValue === 'function' ? _expAmountValue(String(v ?? '')) : (Number(v) || 0));
  /** May this form carry a breakdown? An admin, on a salary expense with a picked employee. */
  const salaryAllowed = () => !!(S && S.kind === 'salary' && S.payee && admin() && !S.payee.amountHidden);
  const salaryOn = () => salaryAllowed() && S.sal && S.sal.on;
  function salNew(p, from) {
    return {
      on: true, base: Number(p?.amount) || 0, points: 0, pointValue: Number(p?.pointValue) || 0,
      overtime: 0, overtimeNote: '', deductions: 0, deductionsNote: '', pointsMonth: '', fetching: false, fetchError: '',
      ...(from || {}),
    };
  }
  function salCalc(s) {
    const bonus = r2(Math.max(0, Number(s.points) || 0) * (Number(s.pointValue) || 0));
    const net = r2((Number(s.base) || 0) + bonus + (Number(s.overtime) || 0) - (Number(s.deductions) || 0));
    return { bonus, net };
  }
  const salMonth = () => (S?.from ? S.from.slice(0, 7) : todayStr().slice(0, 7));
  const monthLabel = (ym) => { const { y, m } = parse(ym + '-01'); return monthName(y, m, true); };
  /** Writes the net into the amount (read-only while the breakdown is on) and refreshes the totals. */
  function salApply() {
    const amt = $('#em-amount');
    if (!amt) return;
    if (salaryOn()) {
      const { bonus, net } = salCalc(S.sal);
      setAmount(net);
      amt.readOnly = true;
      amt.classList.add('is-derived');
      const b = $('#xp-s-bonus'); if (b) b.innerHTML = money(bonus);
      const n = $('#xp-s-net'); if (n) n.innerHTML = money(net);
      const neg = $('#xp-s-neg'); if (neg) neg.hidden = net > 0;
    } else {
      amt.readOnly = false;
      amt.classList.remove('is-derived');
    }
    syncSaveAmount();
  }

  function applyPayeeDefaults(p) {
    const amt = $('#em-amount');
    const amount = Number(p?.amount) || 0;
    if (S.kind === 'salary' && admin() && !p.amountHidden) {
      S.sal = salNew(p);
    } else if (amt && amount > 0 && !p.amountHidden) {
      const cur = String(amt.value || '').trim();
      if (!cur || amountNow() === Number(S.amountAuto)) { setAmount(amount); S.amountAuto = amount; }
    }
    const acc = $('#em-account');
    if (acc && p?.account && ACCOUNTS.includes(p.account) && (!S.accountTouched)) acc.value = p.account;
    render();
  }

  /** «حفظ المبلغ كمرتب/سعر معتاد» — shown when the typed amount differs from the saved one. */
  function syncSaveAmount() {
    const box = $('#xp-save-amount-row');
    if (!box || !S) return;
    const p = S.payee;
    const withSal = salaryOn();
    // With a breakdown the employee's usual figures are the base salary and the point rate.
    const amount = withSal ? (Number(S.sal.base) || 0) : amountNow();
    const allowed = p && (S.kind !== 'salary' || admin()) && !p.amountHidden;
    const differs = Math.abs(amount - (Number(p?.amount) || 0)) > 0.004
      || (withSal && Math.abs((Number(S.sal.pointValue) || 0) - (Number(p?.pointValue) || 0)) > 0.004);
    const show = !!(allowed && amount > 0 && differs);
    box.hidden = !show;
    if (!show) return;
    // The choice lives in S: the section is re-drawn on every period change.
    const cb = $('#xp-save-amount');
    if (cb) cb.checked = S.saveAmount !== null ? S.saveAmount : !(Number(p.amount) > 0);
    const lbl = $('#xp-save-amount-lbl');
    if (lbl) lbl.innerHTML = S.kind === 'salary'
      ? (withSal
        ? text(`حفظ المرتب الأساسي ${money(amount)} وقيمة النقطة ${money(S.sal.pointValue)} لـ <bdi>${h(p.name)}</bdi>`, `Save base ${money(amount)} and point value ${money(S.sal.pointValue)} for <bdi>${h(p.name)}</bdi>`)
        : text(`تحديث مرتب <bdi>${h(p.name)}</bdi> المسجّل إلى ${money(amount)}`, `Update <bdi>${h(p.name)}</bdi>'s saved salary to ${money(amount)}`))
      : text(`حفظ ${money(amount)} كمبلغ معتاد لـ <bdi>${h(p.name)}</bdi>`, `Save ${money(amount)} as <bdi>${h(p.name)}</bdi>'s usual amount`);
  }

  /* ── rendering ──────────────────────────────────────────────────────── */
  function payeeMeta(p) {
    const parts = [];
    if (p.kind === 'ads') { const pl = platformOf(p.platform); if (pl && pl.code !== 'other') parts.push(h(en() ? pl.en : pl.ar)); }
    if (p.kind === 'subscription') parts.push(h(tx([cycleOf(p.billingCycle).ar, cycleOf(p.billingCycle).en])));
    if (p.kind === 'salary' && p.amountHidden) parts.push(text('المرتب يراه المدير فقط', 'Salary visible to managers only'));
    else if (Number(p.amount) > 0) parts.push(`${h(tx(KIND_TEXT[p.kind].amount))} ${money(p.amount)}`);
    if (p.account) parts.push(h(typeof _payMethodLabel === 'function' ? _payMethodLabel(p.account) : p.account));
    return parts.join(' · ');
  }
  const kindIcon = (kind) => ({
    ads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/></svg>',
    salary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg>',
    subscription: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  }[kind] || '');

  function pickerHtml() {
    const K = KIND_TEXT[S.kind];
    if (loadError && !cache) {
      return `<div class="xp-msg is-error">${h(loadError)} <button type="button" class="xp-link" data-xp="retry">${text('إعادة المحاولة', 'Retry')}</button>
        <div class="xp-sub">${text('يمكنك الحفظ بدون جهة الآن واختيارها لاحقًا من التعديل.', 'You can save without it now and pick it later by editing.')}</div></div>`;
    }
    if (!cache) return `<div class="xp-skel"></div>`;
    if (S.mode === 'form') return formHtml();
    if (S.payee) {
      const p = S.payee;
      const archived = p.active === false;
      return `<div class="xp-sel${archived ? ' is-archived' : ''}">
        <span class="xp-ico">${kindIcon(S.kind)}</span>
        <div class="xp-sel-body"><b><bdi>${h(p.name)}</bdi></b>${archived ? `<span class="xp-tag">${text('مؤرشفة', 'Archived')}</span>` : ''}<div class="xp-sub">${payeeMeta(p) || '&nbsp;'}</div></div>
        <div class="xp-sel-acts">
          ${admin() && findPayee(p._id) ? `<button type="button" class="xp-btn" data-xp="edit">${text('تعديل', 'Edit')}</button>` : ''}
          <button type="button" class="xp-btn" data-xp="change">${text('تغيير', 'Change')}</button>
        </div>
      </div>`;
    }
    if (S.kind === 'salary') {
      // Salaries: every ACTIVE employee account is offered (owner, Nov 26) — not only names saved before.
      const cands = salaryCandidates();
      return `<div class="xp-search">
        <input type="text" id="xp-q" autocomplete="off" placeholder="${h(tx(K.ph))}" value="${h(S.q || '')}" aria-label="${h(tx(K.noun))}" role="combobox" aria-expanded="false" aria-controls="xp-list">
        <div class="xp-list" id="xp-list" role="listbox" hidden></div>
      </div>
      ${cands.length ? `<div class="xp-recent xp-emps"><span class="xp-sub">${text('الموظفون النشطون:', 'Active employees:')}</span>${cands.slice(0, 16).map(c => `<button type="button" class="xp-chip${c.type === 'user' ? ' is-new' : ''}" data-xp="${c.type === 'user' ? 'pick-user' : 'pick'}" data-id="${h(c.id)}" title="${h(c.sub || '')}"><bdi>${h(c.name)}</bdi></button>`).join('')}</div>`
        : `<div class="xp-sub xp-empty-hint">${admin() ? text('لا يوجد حساب موظف نشط — أضف الموظف من «المستخدمون» أو اكتب اسمه.', 'No active employee account — add one under Users or type a name.') : text('لا يوجد موظف مسجَّل — يضيفه المدير.', 'No employee registered — a manager adds them.')}</div>`}
      ${S.need ? `<div class="xp-msg is-error" role="alert">${h(tx(K.need))}</div>` : ''}`;
    }
    const recent = payeesOf(S.kind).slice(0, 6);
    return `<div class="xp-search">
        <input type="text" id="xp-q" autocomplete="off" placeholder="${h(tx(K.ph))}" value="${h(S.q || '')}" aria-label="${h(tx(K.noun))}" role="combobox" aria-expanded="false" aria-controls="xp-list">
        <div class="xp-list" id="xp-list" role="listbox" hidden></div>
      </div>
      ${recent.length ? `<div class="xp-recent"><span class="xp-sub">${text('الأكثر استخدامًا:', 'Recently used:')}</span>${recent.map(p => `<button type="button" class="xp-chip" data-xp="pick" data-id="${h(p._id)}"><bdi>${h(p.name)}</bdi></button>`).join('')}</div>`
        : `<div class="xp-sub xp-empty-hint">${text(`لا توجد ${tx(K.noun)} محفوظة بعد — اكتب الاسم ثم «${tx(K.add)}».`, `No saved ${tx(K.noun).toLowerCase()} yet — type the name, then “${tx(K.add)}”.`)}</div>`}
      ${S.need ? `<div class="xp-msg is-error" role="alert">${h(tx(K.need))}</div>` : ''}`;
  }

  function formHtml() {
    const K = KIND_TEXT[S.kind];
    const f = S.form;
    const editing = !!f.id;
    const userOpts = (typeof users !== 'undefined' && Array.isArray(users) ? users : [])
      .filter(u => u && u.isActive !== false)
      .map(u => `<option value="${h(u._id)}" ${String(f.userId) === String(u._id) ? 'selected' : ''}>${h(u.name || u.username)}</option>`).join('');
    const amountField = `<div class="form-group"><label for="xp-f-amount">${h(tx(K.amount))}${S.kind === 'salary' ? ' *' : ''}</label>
      <div class="xp-amt"><input type="number" id="xp-f-amount" min="0" step="0.01" value="${h(f.amount || '')}" placeholder="0.00"><span>EGP</span></div></div>`;
    let extra = '';
    if (S.kind === 'ads') {
      extra = `<div class="form-group xp-span"><label>${text('المنصة', 'Platform')}</label><div class="xp-seg">${XP_PLATFORMS.map(p => `<button type="button" class="xp-seg-btn${f.platform === p.code ? ' is-on' : ''}" data-xp="f-platform" data-v="${p.code}" aria-pressed="${f.platform === p.code}">${h(en() ? p.en : p.ar)}</button>`).join('')}</div></div>${amountField}`;
    } else if (S.kind === 'subscription') {
      extra = `<div class="form-group"><label>${text('دورة الدفع', 'Billing cycle')}</label><div class="xp-seg">${XP_CYCLES.map(c => `<button type="button" class="xp-seg-btn${f.billingCycle === c.code ? ' is-on' : ''}" data-xp="f-cycle" data-v="${c.code}" aria-pressed="${f.billingCycle === c.code}">${h(en() ? c.en : c.ar)}</button>`).join('')}</div></div>${amountField}`;
    } else {
      extra = `${amountField}<div class="form-group"><label for="xp-f-pv">${text('قيمة النقطة (للمكافأة)', 'Value per point (bonus)')}</label>
        <div class="xp-amt"><input type="text" inputmode="decimal" id="xp-f-pv" value="${h(f.pointValue || '')}" placeholder="0"><span>EGP</span></div></div>
        <div class="form-group xp-span"><label for="xp-f-user">${text('حسابه على النظام — لجلب نقاط الأداء', 'System account — to read performance points')}</label>
        <select id="xp-f-user"><option value="">${text('— بدون حساب —', '— No account —')}</option>${userOpts}</select></div>`;
    }
    return `<div class="xp-form" role="group" aria-label="${h(editing ? text('تعديل', 'Edit') : tx(K.add))}">
      <div class="xp-form-head">${kindIcon(S.kind)}<b>${editing ? text(`تعديل ${tx(K.noun)}`, `Edit ${tx(K.noun).toLowerCase()}`) : h(tx(K.add))}</b></div>
      <div class="xp-form-grid">
        <div class="form-group xp-span"><label for="xp-f-name">${text('الاسم', 'Name')} *</label><input type="text" id="xp-f-name" maxlength="80" value="${h(f.name || '')}"></div>
        ${extra}
        <div class="form-group"><label for="xp-f-account">${text('يُدفع عادةً من', 'Usually paid from')}</label>
          <select id="xp-f-account"><option value="">${text('— بدون —', '— None —')}</option>${ACCOUNTS.map(a => `<option value="${h(a)}" ${f.account === a ? 'selected' : ''}>${h(typeof _payMethodLabel === 'function' ? _payMethodLabel(a) : a)}</option>`).join('')}</select></div>
      </div>
      ${f.error ? `<div class="xp-msg is-error" role="alert">${h(f.error)}</div>` : ''}
      <div class="xp-form-acts">
        <button type="button" class="btn btn-primary btn-sm" data-xp="f-save" ${f.busy ? 'disabled' : ''}>${f.busy ? text('جارٍ الحفظ…', 'Saving…') : text('حفظ', 'Save')}</button>
        <button type="button" class="btn btn-outline btn-sm" data-xp="f-cancel">${text('إلغاء', 'Cancel')}</button>
        ${editing ? `<button type="button" class="xp-link is-danger" data-xp="f-archive">${text('أرشفة (إخفاء من القائمة)', 'Archive (hide from the list)')}</button>` : ''}
      </div>
    </div>`;
  }

  function periodHtml() {
    const cur = todayStr().slice(0, 7);
    const prev = shiftMonth(cur, -1);
    const next = shiftMonth(cur, 1);
    const months = cycleMonths();
    const chip = (key, label) => `<button type="button" class="xp-seg-btn${S.periodKey === key ? ' is-on' : ''}" data-xp="period" data-v="${key}" aria-pressed="${S.periodKey === key}">${label}</button>`;
    const mLabel = (m) => { const { y, m: mm } = parse(m + '-01'); return h(monthName(y, mm)); };
    const monthsWord = (n) => text(`${n} ${n <= 10 ? 'أشهر' : 'شهرًا'}`, `${n} months`);
    const ahead = S.from && S.from.slice(0, 7) > cur;
    return `<div class="xp-period">
      <label class="xp-label">${S.kind === 'salary' ? text('شهر المرتب', 'Salary month') : text('الفترة التي يغطيها المصروف', 'Period this expense covers')}</label>
      <div class="xp-seg">
        ${chip('prev', text(`الشهر السابق (${mLabel(prev)})`, `Last month (${mLabel(prev)})`))}
        ${chip('cur', text(`الشهر الحالي (${mLabel(cur)})`, `This month (${mLabel(cur)})`))}
        ${chip('next', text(`الشهر القادم (${mLabel(next)})`, `Next month (${mLabel(next)})`))}
        ${chip('multi', text('عدة أشهر', 'Several months'))}
        ${chip('month', text('شهر آخر', 'Other month'))}
        ${chip('custom', text('فترة مخصصة', 'Custom dates'))}
      </div>
      ${S.periodKey === 'month' ? `<div class="xp-period-row"><label>${text('الشهر', 'Month')} <input type="month" id="xp-month" value="${h(S.from ? S.from.slice(0, 7) : cur)}"></label></div>` : ''}
      ${S.periodKey === 'multi' ? `<div class="xp-period-row">
          <label>${text('من شهر', 'From')} <input type="month" id="xp-mstart" value="${h(S.from ? S.from.slice(0, 7) : cur)}"></label>
          <span class="xp-sub">${text('لمدة', 'for')}</span>
          <div class="xp-seg">${[2, 3, 6, 12].map(n => `<button type="button" class="xp-seg-btn${S.multiN === n ? ' is-on' : ''}" data-xp="period-n" data-v="${n}" aria-pressed="${S.multiN === n}">${monthsWord(n)}</button>`).join('')}</div>
        </div>` : ''}
      ${S.periodKey === 'custom' ? (window.SouliaDateRange?.open
        // The app's range calendar. (A bare from/to <input type=date> pair is auto-replaced by an icon-only
        // trigger that never shows the dates — what the form used to show.)
        ? `<div class="xp-period-row"><button type="button" class="xp-range-btn" data-xp="range" aria-haspopup="dialog">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
            <span>${S.from && S.to ? `<bdi>${h(periodText(S.from, S.to, true))}</bdi>` : text('اختر من — إلى', 'Pick from — to')}</span>
            <small>${text('تغيير', 'Change')}</small></button></div>`
        : `<div class="xp-period-row"><div><label>${text('من', 'From')}</label> <input type="date" id="xp-from" value="${h(S.from)}"></div><div><label>${text('إلى', 'To')}</label> <input type="date" id="xp-to" value="${h(S.to)}"></div></div>`) : ''}
      <div class="xp-period-sum">${S.from && S.to
        ? `${text('يغطي:', 'Covers:')} <b><bdi>${h(periodText(S.from, S.to, true))}</bdi></b>${months > 1 && !['custom', 'multi'].includes(S.periodKey) ? ` <span class="xp-sub">· ${text(`${monthsWord(months)} حسب دورة الاشتراك`, `${monthsWord(months)}, by the billing cycle`)}</span>` : ''}${ahead ? ` <span class="xp-ahead">${text('دفع مقدّم — فترة لم تبدأ بعد', 'Paid in advance — period not started yet')}</span>` : ''}`
        : `<span class="xp-msg is-error">${text('حدد الفترة', 'Set the period')}</span>`}</div>
    </div>`;
  }

  /** «تفاصيل المرتب»: base + points × value + overtime − deductions = net (the expense amount). */
  function salaryHtml() {
    if (!salaryAllowed() || S.mode === 'form') return '';
    if (!S.sal) S.sal = salNew(S.payee);
    const s = S.sal;
    if (!s.on) {
      return `<div class="xp-sal is-off"><button type="button" class="xp-link" data-xp="sal-on">${text('تفصيل المرتب (أساسي، نقاط أداء، أوفر تايم، خصومات)', 'Break down the salary (base, points, overtime, deductions)')}</button></div>`;
    }
    const { bonus, net } = salCalc(s);
    const month = salMonth();
    const linked = !!S.payee.userId;
    const stale = s.pointsMonth && s.pointsMonth !== month;
    const field = (id, label, value, opts = {}) => `<label class="xp-sal-f${opts.cls ? ' ' + opts.cls : ''}"><span>${label}</span>
      <span class="xp-amt"><input type="text" inputmode="decimal" id="${id}" value="${h(value === 0 && opts.blankZero ? '' : value)}" placeholder="0">${opts.unit === false ? '' : `<span>${opts.unit || 'EGP'}</span>`}</span></label>`;
    const note = (id, value, ph) => `<input type="text" class="xp-sal-note" id="${id}" maxlength="200" value="${h(value)}" placeholder="${h(ph)}">`;
    return `<div class="xp-sal" role="group" aria-label="${h(text('تفاصيل المرتب', 'Salary details'))}">
      <div class="xp-sal-head"><b>${text('تفاصيل المرتب', 'Salary details')}</b>
        <button type="button" class="xp-link" data-xp="sal-off">${text('إدخال المبلغ مباشرة', 'Enter the amount directly')}</button></div>
      <div class="xp-sal-row">${field('xp-s-base', text('المرتب الأساسي', 'Base salary'), s.base)}</div>
      <div class="xp-sal-row is-points">
        ${field('xp-s-points', text('نقاط الأداء', 'Performance points'), s.points, { unit: text('نقطة', 'pts'), blankZero: true })}
        <span class="xp-sal-op">×</span>
        ${field('xp-s-pv', text('قيمة النقطة', 'Value per point'), s.pointValue, { blankZero: true })}
        <span class="xp-sal-op">=</span>
        <div class="xp-sal-out"><span>${text('مكافأة الأداء', 'Performance bonus')}</span><b id="xp-s-bonus">${money(bonus)}</b></div>
      </div>
      <div class="xp-sal-fetch">
        <button type="button" class="xp-btn" data-xp="sal-fetch" ${linked && !s.fetching ? '' : 'disabled'}>${s.fetching ? text('جارٍ الجلب…', 'Reading…') : text(`جلب نقاط ${monthLabel(month)}`, `Read ${monthLabel(month)} points`)}</button>
        <span class="xp-sub">${!linked
          ? text('اربط الموظف بحسابه على النظام (تعديل) لجلب نقاطه.', 'Link the employee to a system account (Edit) to read their points.')
          : s.fetchError ? `<span class="xp-msg is-error">${h(s.fetchError)}</span>`
          : stale ? `<span class="xp-msg is-warn">${text(`النقاط المسجّلة لشهر ${monthLabel(s.pointsMonth)} — اجلب نقاط ${monthLabel(month)}`, `Points are for ${monthLabel(s.pointsMonth)} — read ${monthLabel(month)}`)}</span>`
          : s.pointsMonth ? text(`النقاط من سجل الأداء لشهر ${monthLabel(s.pointsMonth)}`, `Points from the performance log, ${monthLabel(s.pointsMonth)}`) : ''}</span>
      </div>
      <div class="xp-sal-row">${field('xp-s-ot', text('أوفر تايم (+)', 'Overtime (+)'), s.overtime, { blankZero: true })}${note('xp-s-otn', s.overtimeNote, text('مثال: 10 ساعات إضافية', 'e.g. 10 extra hours'))}</div>
      <div class="xp-sal-row">${field('xp-s-ded', text('خصومات وجزاءات (−)', 'Deductions & penalties (−)'), s.deductions, { blankZero: true, cls: 'is-neg' })}${note('xp-s-dedn', s.deductionsNote, text('السبب، مثال: تأخير يومين', 'Reason, e.g. late two days'))}</div>
      <div class="xp-sal-total"><span>${text('صافي المرتب المستحق', 'Net salary due')}</span><b id="xp-s-net">${money(net)}</b></div>
      <div class="xp-msg is-error" id="xp-s-neg" ${net > 0 ? 'hidden' : ''}>${text('الصافي يجب أن يكون أكبر من صفر', 'The net must be above zero')}</div>
    </div>`;
  }

  function render() {
    const slot = $('#em-xp-slot');
    if (!slot) return;
    if (!S || !S.kind) {
      slot.innerHTML = '';
      const amt = $('#em-amount'); if (amt) { amt.readOnly = false; amt.classList.remove('is-derived'); }
      return;
    }
    const K = KIND_TEXT[S.kind];
    const focusQ = document.activeElement?.id === 'xp-q';
    slot.innerHTML = `<div class="exp-form-section xp" id="em-xp" data-kind="${S.kind}">
      <div class="exp-form-section-title">${h(tx(K.title))}</div>
      <div class="xp-picker">${pickerHtml()}</div>
      ${periodHtml()}
      ${salaryHtml()}
      <div class="xp-save-amount" id="xp-save-amount-row" hidden><label><input type="checkbox" id="xp-save-amount"> <span id="xp-save-amount-lbl"></span></label></div>
      <div class="xp-title-preview xp-sub" id="xp-title-preview"></div>
    </div>`;
    if (focusQ) { const q = $('#xp-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
    if (S.mode === 'form') setTimeout(() => $('#xp-f-name')?.focus(), 0);
    if (typeof _pmEnhanceSelects === 'function') _pmEnhanceSelects(slot); // the app's own list, as everywhere else
    applyTitle();
    salApply();
  }

  /* ── search list ────────────────────────────────────────────────────── */
  const norm = (s) => String(s || '').normalize('NFKC').replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim().toLowerCase();
  /* ── employees for «مرتبات»: active accounts + saved salary records ── */
  const allUsers = () => (typeof users !== 'undefined' && Array.isArray(users) ? users : []).filter(u => u && u._id);
  const userJob = (u) => (u?.jobTitle ? (typeof jobTitleLabel === 'function' ? jobTitleLabel(u.jobTitle) : u.jobTitle) : '');
  /**
   * Saved salary records whose account is not disabled, then (admins) every ACTIVE account that has
   * no record yet — picking one of those creates its record, linked to the account.
   */
  function salaryCandidates() {
    const byId = new Map(allUsers().map(u => [String(u._id), u]));
    const out = [];
    const linked = new Set();
    for (const p of payeesOf('salary')) {
      const u = p.userId ? byId.get(String(p.userId)) : null;
      if (u && u.isActive === false) continue; // the employee's account is disabled
      if (p.userId) linked.add(String(p.userId));
      out.push({ type: 'pick', id: p._id, name: p.name, sub: userJob(u) || payeeMeta(p).replace(/<[^>]+>/g, '') });
    }
    if (admin()) {
      for (const u of allUsers()) {
        if (u.isActive === false || linked.has(String(u._id))) continue;
        out.push({ type: 'user', id: String(u._id), name: u.name || u.username, sub: userJob(u) });
      }
    }
    return out;
  }
  /** An active account with no salary record yet → create the record (linked) and pick it. */
  async function pickUser(userId) {
    if (!admin()) return;
    const u = allUsers().find(x => String(x._id) === String(userId));
    if (!u) return;
    const name = String(u.name || u.username || '').trim();
    try {
      let saved;
      try {
        saved = await api('/expenses/payees', { method: 'POST', body: JSON.stringify({ kind: 'salary', name, userId: String(u._id), amount: 0 }) });
      } catch (e) {
        // A record with this name already exists (typed earlier, not linked): link it to the account.
        await load(true).catch(() => {});
        const same = payeesOf('salary').find(p => norm(p.name) === norm(name));
        if (!same) throw e;
        saved = same.userId ? same : await api('/expenses/payees/' + encodeURIComponent(same._id), { method: 'PUT', body: JSON.stringify({ userId: String(u._id) }) });
      }
      await load(true).catch(() => { cache = [...(cache || []).filter(p => p._id !== saved._id), saved]; });
      pick(saved._id);
    } catch (e) {
      toast(e?.message || text('تعذّر اختيار الموظف', 'Could not pick the employee'), true);
    }
  }

  function drawList() {
    const list = $('#xp-list'), q = $('#xp-q');
    if (!list || !q) return;
    const term = norm(q.value);
    let all, exact;
    if (S.kind === 'salary') {
      all = salaryCandidates();
      exact = all.some(c => norm(c.name) === term);
      S.items = (term ? all.filter(c => norm(c.name).includes(term)) : all).slice(0, 10).map(c => ({ type: c.type, id: c.id, name: c.name, sub: c.sub }));
    } else {
      all = payeesOf(S.kind);
      exact = all.some(p => norm(p.name) === term);
      S.items = (term ? all.filter(p => norm(p.name).includes(term)) : all).slice(0, 8).map(p => ({ type: 'pick', id: p._id }));
    }
    const hasHits = S.items.length > 0;
    const canAdd = !!term && !exact && (S.kind !== 'salary' || admin());
    if (canAdd) S.items.push({ type: 'add' });
    if (S.active >= S.items.length) S.active = 0;
    if (!term && !hasHits) { list.hidden = true; q.setAttribute('aria-expanded', 'false'); return; }
    list.innerHTML = S.items.map((it, i) => {
      const cls = `xp-opt${i === S.active ? ' is-active' : ''}`;
      if (it.type === 'add') return `<div class="${cls} is-add" role="option" data-i="${i}" aria-selected="${i === S.active}">+ ${S.kind === 'salary'
        ? text(`إضافة «<bdi>${h(q.value.trim())}</bdi>» (موظف بلا حساب على النظام)`, `Add “<bdi>${h(q.value.trim())}</bdi>” (no system account)`)
        : text(`إضافة «<bdi>${h(q.value.trim())}</bdi>»`, `Add “<bdi>${h(q.value.trim())}</bdi>”`)}</div>`;
      if (it.type === 'user') return `<div class="${cls}" role="option" data-i="${i}" aria-selected="${i === S.active}"><b><bdi>${h(it.name)}</bdi></b><span class="xp-sub">${h(it.sub || text('حساب نشط', 'Active account'))} · ${text('لم يُسجَّل مرتبه بعد', 'salary not set yet')}</span></div>`;
      const p = findPayee(it.id);
      return `<div class="${cls}" role="option" data-i="${i}" aria-selected="${i === S.active}"><b><bdi>${h(p.name)}</bdi></b><span class="xp-sub">${it.sub ? h(it.sub) + ' · ' : ''}${payeeMeta(p)}</span></div>`;
    }).join('') || `<div class="xp-opt is-empty">${S.kind === 'salary' && !admin() ? text('لا يوجد موظف بهذا الاسم — يضيفه المدير.', 'No employee by that name — a manager adds them.') : text('لا نتائج', 'No results')}</div>`;
    list.hidden = false;
    q.setAttribute('aria-expanded', 'true');
  }
  function chooseItem(i) {
    const it = S.items?.[i];
    if (!it) return;
    if (it.type === 'add') openForm(null, $('#xp-q')?.value.trim());
    else if (it.type === 'user') pickUser(it.id);
    else pick(it.id);
  }

  /* ── actions ────────────────────────────────────────────────────────── */
  function setPeriod(key, value) {
    const cur = todayStr().slice(0, 7);
    const months = cycleMonths();
    S.periodKey = key;
    if (key === 'cur') Object.assign(S, monthRange(cur, months));
    else if (key === 'prev') Object.assign(S, monthRange(shiftMonth(cur, -1), months));
    else if (key === 'next') Object.assign(S, monthRange(shiftMonth(cur, 1), months));
    else if (key === 'multi') {
      // Several whole months from a start month (past, current or future — paying ahead).
      S.multiN = S.multiN || 3;
      Object.assign(S, monthRange(value || (S.from ? S.from.slice(0, 7) : cur), S.multiN));
    }
    else if (key === 'month' && value) Object.assign(S, monthRange(value, months));
    else if (key === 'month' && !S.from) Object.assign(S, monthRange(cur, months));
  }
  function pick(id) {
    const p = findPayee(id);
    if (!p) return;
    S.payee = p; S.q = ''; S.need = false; S.mode = 'pick'; S.saveAmount = null;
    // A quarterly/yearly subscription stretches the chosen month to its cycle.
    if (S.periodKey !== 'custom') setPeriod(S.periodKey || 'cur', S.from ? S.from.slice(0, 7) : null);
    render();
    applyPayeeDefaults(p);
  }
  function openForm(payee, name) {
    if (S.kind === 'salary' && !admin()) { toast(text('إضافة الموظفين للمدير فقط', 'Only a manager adds employees'), true); return; }
    S.mode = 'form';
    S.form = payee
      ? { id: payee._id, name: payee.name, amount: payee.amount || '', pointValue: payee.pointValue || '', account: payee.account || '', platform: payee.platform || 'other', billingCycle: payee.billingCycle || 'monthly', userId: payee.userId || '' }
      : { name: name || '', amount: '', account: $('#em-account')?.value || '', platform: 'meta', billingCycle: 'monthly', userId: '' };
    render();
  }
  function readForm() {
    const f = S.form;
    f.name = $('#xp-f-name')?.value ?? f.name;
    const amt = $('#xp-f-amount'); if (amt) f.amount = amt.value;
    const acc = $('#xp-f-account'); if (acc) f.account = acc.value;
    const usr = $('#xp-f-user'); if (usr) f.userId = usr.value;
    const pv = $('#xp-f-pv'); if (pv) f.pointValue = pv.value;
  }
  async function saveForm() {
    readForm();
    const f = S.form;
    const name = String(f.name || '').trim();
    if (name.length < 2) { f.error = text('اكتب الاسم (حرفان على الأقل)', 'Type the name (at least 2 letters)'); render(); return; }
    if (S.kind === 'salary' && !(num(f.amount) > 0)) { f.error = text('اكتب المرتب الشهري', 'Enter the monthly salary'); render(); return; }
    const body = { kind: S.kind, name, amount: num(f.amount), account: f.account || '' };
    if (S.kind === 'ads') body.platform = f.platform || 'other';
    if (S.kind === 'subscription') body.billingCycle = f.billingCycle || 'monthly';
    if (S.kind === 'salary') { body.userId = f.userId || ''; body.pointValue = num(f.pointValue); }
    f.busy = true; f.error = ''; render();
    try {
      const saved = f.id
        ? await api('/expenses/payees/' + encodeURIComponent(f.id), { method: 'PUT', body: JSON.stringify(body) })
        : await api('/expenses/payees', { method: 'POST', body: JSON.stringify(body) });
      await load(true).catch(() => { cache = [...(cache || []).filter(p => p._id !== saved._id), saved]; });
      S.mode = 'pick'; S.form = null;
      if (S.payee && f.id === S.payee._id) S.payee = findPayee(saved._id) || saved;
      pick(saved._id);
      toast(f.id ? text('تم حفظ التعديل', 'Saved') : text(`تمت إضافة «${saved.name}»`, `Added “${saved.name}”`));
    } catch (e) {
      f.busy = false;
      f.error = e?.message || text('تعذّر الحفظ', 'Could not save');
      // Already saved under this name: reload and pick it instead.
      if (/مسجّل بالفعل|already/i.test(f.error)) {
        await load(true).catch(() => {});
        const same = payeesOf(S.kind).find(p => norm(p.name) === norm(name));
        if (same && !f.id) { S.mode = 'pick'; S.form = null; pick(same._id); toast(text(`«${same.name}» موجودة بالفعل — تم اختيارها`, `“${same.name}” already exists — selected`)); return; }
      }
      render();
    }
  }
  async function archiveForm() {
    const f = S.form;
    if (!f?.id) return;
    const ok = typeof showConfirm === 'function'
      ? await showConfirm(text(`إخفاء «<bdi>${h(f.name)}</bdi>» من القائمة؟ المصروفات السابقة تبقى كما هي، ويمكن إضافتها من جديد بنفس الاسم لاحقًا.`, `Hide “<bdi>${h(f.name)}</bdi>” from the list? Past expenses keep it; adding the same name later brings it back.`), { title: text('أرشفة', 'Archive'), icon: 'warn' })
      : true;
    if (!ok) return;
    try {
      await api('/expenses/payees/' + encodeURIComponent(f.id), { method: 'PUT', body: JSON.stringify({ active: false }) });
      await load(true).catch(() => {});
      S.mode = 'pick'; S.form = null; S.payee = null; render();
      toast(text('تمت الأرشفة', 'Archived'));
    } catch (e) { f.error = e?.message || ''; render(); }
  }

  function onClick(ev) {
    const el = ev.target.closest('[data-xp]');
    if (!el || !S) return;
    const act = el.dataset.xp;
    if (act === 'pick') pick(el.dataset.id);
    else if (act === 'pick-user') pickUser(el.dataset.id);
    else if (act === 'change') { S.payee = null; S.sal = null; S.mode = 'pick'; render(); $('#xp-q')?.focus(); }
    else if (act === 'edit') openForm(S.payee);
    else if (act === 'retry') { loadError = ''; render(); load(true).then(render, render); }
    else if (act === 'period') { setPeriod(el.dataset.v); render(); }
    else if (act === 'range' && window.SouliaDateRange?.open) {
      SouliaDateRange.open(el, {
        from: S.from, to: S.to,
        onApply: (a, b) => { if (a && b) { S.from = a <= b ? a : b; S.to = a <= b ? b : a; render(); } },
        onClear: () => {},
      });
    }
    else if (act === 'period-n') { S.multiN = Number(el.dataset.v) || 3; setPeriod('multi', S.from ? S.from.slice(0, 7) : null); render(); }
    else if (act === 'use-title') { S.descManual = false; applyTitle(); }
    else if (act === 'f-platform') { readForm(); S.form.platform = el.dataset.v; render(); }
    else if (act === 'f-cycle') { readForm(); S.form.billingCycle = el.dataset.v; render(); }
    else if (act === 'f-save') saveForm();
    else if (act === 'f-cancel') { S.mode = 'pick'; S.form = null; render(); }
    else if (act === 'f-archive') archiveForm();
    else if (act === 'sal-on') { S.sal = S.sal || salNew(S.payee); S.sal.on = true; render(); }
    else if (act === 'sal-off') { if (S.sal) S.sal.on = false; render(); $('#em-amount')?.focus(); }
    else if (act === 'sal-fetch') fetchPoints();
  }

  /** Reads the employee's points for the period's month from the performance log. */
  async function fetchPoints() {
    if (!salaryOn() || !S.payee.userId) return;
    const month = salMonth();
    const s = S.sal;
    s.fetching = true; s.fetchError = ''; render();
    try {
      const r = await api(`/employee-performance/points/${encodeURIComponent(S.payee.userId)}?month=${month}`);
      if (!S || S.sal !== s) return;
      s.points = Number(r?.points) || 0;
      s.pointsMonth = r?.month || month;
      toast(text(`نقاط ${monthLabel(s.pointsMonth)}: ${s.points}`, `${monthLabel(s.pointsMonth)} points: ${s.points}`));
    } catch (e) {
      s.fetchError = e?.message || text('تعذّر جلب النقاط', 'Could not read the points');
    } finally {
      s.fetching = false;
      if (S && S.sal === s) render();
    }
  }
  function onMouseDown(ev) {
    const opt = ev.target.closest('.xp-opt[data-i]');
    if (opt) { ev.preventDefault(); chooseItem(Number(opt.dataset.i)); }
  }
  function onInput(ev) {
    const id = ev.target.id;
    if (id === 'xp-q') { S.q = ev.target.value; S.active = 0; drawList(); }
    else if (id === 'xp-month' && ev.target.value) { setPeriod('month', ev.target.value); render(); }
    else if (id === 'xp-mstart' && ev.target.value) { setPeriod('multi', ev.target.value); render(); }
    else if (id === 'xp-from' || id === 'xp-to') {
      // Update the summary and title only — re-drawing would close the date picker mid-choice.
      S[id === 'xp-from' ? 'from' : 'to'] = ev.target.value;
      const sum = $('.xp-period-sum');
      if (sum) sum.innerHTML = S.from && S.to && S.from <= S.to
        ? `${text('يغطي:', 'Covers:')} <b><bdi>${h(periodText(S.from, S.to, true))}</bdi></b>`
        : `<span class="xp-msg is-error">${S.from && S.to ? text('بداية الفترة بعد نهايتها', 'The period starts after it ends') : text('حدد الفترة', 'Set the period')}</span>`;
      applyTitle();
    }
    else if (id === 'xp-save-amount') S.saveAmount = ev.target.checked;
    else if (id && id.startsWith('xp-s-') && S.sal) {
      // Update the figures in place — a full re-draw would steal the caret mid-number.
      const key = { 'xp-s-base': 'base', 'xp-s-points': 'points', 'xp-s-pv': 'pointValue', 'xp-s-ot': 'overtime', 'xp-s-ded': 'deductions', 'xp-s-otn': 'overtimeNote', 'xp-s-dedn': 'deductionsNote' }[id];
      if (!key) return;
      if (key.endsWith('Note')) S.sal[key] = ev.target.value;
      else if (key === 'points') {
        const raw = String(ev.target.value).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d.-]/g, '');
        S.sal.points = Number(raw) || 0; S.sal.pointsMonth = S.sal.pointsMonth || '';
      } else S.sal[key] = num(ev.target.value);
      salApply();
    }
  }
  function onKeyDown(ev) {
    const id = ev.target.id;
    if (id === 'xp-q') {
      const list = $('#xp-list');
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (list?.hidden) drawList();
        const n = S.items?.length || 0;
        if (n) { S.active = (S.active + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n; drawList(); }
      } else if (ev.key === 'Enter') {
        ev.preventDefault(); ev.stopPropagation();
        if (S.items?.length) chooseItem(S.active || 0);
      } else if (ev.key === 'Escape' && list && !list.hidden) {
        ev.preventDefault(); ev.stopPropagation(); list.hidden = true;
      }
    } else if (ev.target.closest('.xp-form') && ev.key === 'Enter' && ev.target.tagName === 'INPUT') {
      ev.preventDefault(); ev.stopPropagation(); saveForm();
    } else if (ev.target.closest('.xp-form') && ev.key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation(); S.mode = 'pick'; S.form = null; render();
    }
  }
  function onFocus(ev) { if (ev.target.id === 'xp-q') drawList(); }
  function onBlur(ev) { if (ev.target.id === 'xp-q') setTimeout(() => { const l = $('#xp-list'); if (l && document.activeElement?.id !== 'xp-q') l.hidden = true; }, 120); }

  /* ── public ─────────────────────────────────────────────────────────── */
  /** Called right after the expense modal opens. `e` = the expense being edited (or null). */
  function mount(e) {
    const slot = $('#em-xp-slot');
    if (!slot) return;
    const cat = $('#em-cat')?.value || e?.category || '';
    S = {
      kind: kindForCategory(cat), editing: !!e, payee: null, mode: 'pick', q: '', active: 0, items: [],
      from: e?.periodFrom || '', to: e?.periodTo || '', periodKey: '', descManual: !!(e && e.desc), lastTitle: '',
      amountAuto: '', accountTouched: !!e, need: false, saveAmount: null,
    };
    if (S.from && S.to) {
      const cur = todayStr().slice(0, 7);
      const a = parse(S.from), b = parse(S.to);
      const wholeMonth = a.d === 1 && b.d === lastDay(b.y, b.m);
      const span = (b.y - a.y) * 12 + (b.m - a.m) + 1;
      const start = S.from.slice(0, 7);
      if (!wholeMonth) S.periodKey = 'custom';
      else if (span > 1) { S.periodKey = 'multi'; S.multiN = span; }
      else S.periodKey = start === cur ? 'cur' : start === shiftMonth(cur, -1) ? 'prev' : start === shiftMonth(cur, 1) ? 'next' : 'month';
    }
    if (e?.payeeId) S.payee = { _id: e.payeeId, name: e.payeeName || '', kind: e.payeeKind || S.kind, amount: 0 };
    if (!slot.dataset.xpWired) {
      slot.dataset.xpWired = '1';
      slot.addEventListener('click', onClick);
      slot.addEventListener('mousedown', onMouseDown);
      slot.addEventListener('input', onInput);
      slot.addEventListener('keydown', onKeyDown);
      slot.addEventListener('focusin', onFocus);
      slot.addEventListener('focusout', onBlur);
    }
    const desc = $('#em-desc');
    desc?.addEventListener('input', () => { if (S) S.descManual = desc.value !== S.lastTitle; applyTitle(); });
    $('#em-amount')?.addEventListener('input', syncSaveAmount);
    $('#em-account')?.addEventListener('change', () => { if (S) S.accountTouched = true; });
    if (S.kind && !S.periodKey) setPeriod('cur');
    render();
    load().then(() => {
      if (!S) return;
      if (S.payee) {
        const real = findPayee(S.payee._id);
        if (real) S.payee = real;
        if (e?.salary && S.kind === 'salary') S.sal = salNew(S.payee, { ...e.salary, on: true });
        else if (e && S.kind === 'salary') S.sal = salNew(S.payee, { on: false });
        if (e && S.descManual && e.desc === autoTitle()) S.descManual = false;
      }
      render();
    }, () => render());
  }

  /** Category select changed. */
  function onCategory() {
    if (!S) return;
    const kind = kindForCategory($('#em-cat')?.value);
    if (kind === S.kind) return;
    // Switching away from a payee category clears the auto title it wrote.
    const desc = $('#em-desc');
    if (desc && !S.descManual && desc.value === S.lastTitle) desc.value = '';
    S.kind = kind; S.payee = null; S.sal = null; S.mode = 'pick'; S.q = ''; S.need = false; S.lastTitle = '';
    if (kind && !S.from) setPeriod('cur');
    else if (kind && S.periodKey !== 'custom') setPeriod(S.periodKey || 'cur', S.from.slice(0, 7));
    render();
  }

  /**
   * Fields to send with the expense. `{error}` stops the save (with the section scrolled into view).
   * A brand-new expense in one of the three categories must name its party — unless the list
   * could not load (offline): then it saves without one rather than block the work.
   */
  function collect(id) {
    if (!S) return { fields: {} };
    // Outside the three categories: no party and no period (clears them if the category changed).
    if (!S.kind) return { fields: { payeeId: '', periodFrom: '', periodTo: '' } };
    if (S.mode === 'form') return { error: text('احفظ الجهة الجديدة أو ألغِها أولًا', 'Save or cancel the new entry first') };
    if (!S.from || !S.to) return { error: text('حدد الفترة التي يغطيها المصروف', 'Set the period this expense covers') };
    if (S.from > S.to) return { error: text('بداية الفترة بعد نهايتها', 'The period starts after it ends') };
    if (!S.payee && cache && !id) {
      S.need = true; render(); $('#em-xp')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return { error: tx(KIND_TEXT[S.kind].need) };
    }
    const cb = $('#xp-save-amount');
    const saveAmount = !!(cb && !$('#xp-save-amount-row')?.hidden && cb.checked);
    let salary;
    if (salaryOn()) {
      const { net } = salCalc(S.sal);
      if (!(net > 0)) return { error: text('صافي المرتب يجب أن يكون أكبر من صفر', 'The net salary must be above zero') };
      const s = S.sal;
      salary = {
        base: r2(s.base), points: Number(s.points) || 0, pointValue: r2(s.pointValue), pointsMonth: s.pointsMonth || '',
        overtime: r2(s.overtime), overtimeNote: String(s.overtimeNote || '').trim(),
        deductions: r2(s.deductions), deductionsNote: String(s.deductionsNote || '').trim(),
      };
    } else if (S.kind === 'salary' && admin() && id) {
      salary = null; // the breakdown was switched off on an edit: drop the stored one
    }
    return { fields: {
      payeeId: S.payee?._id || '', periodFrom: S.from, periodTo: S.to,
      ...(salary !== undefined ? { salary } : {}),
      ...(saveAmount ? { updatePayeeAmount: true } : {}),
    } };
  }

  /** Same party already paid for an overlapping period? Ask before recording it twice. */
  async function confirmDuplicate(body, id) {
    if (!body?.payeeId || !body.periodFrom) return true;
    const list = (typeof expenses !== 'undefined' && Array.isArray(expenses) ? expenses : [])
      .filter(x => x && x._id !== id && String(x.payeeId || '') === String(body.payeeId) && x.status !== 'مرفوض'
        && overlap(x.periodFrom, x.periodTo, body.periodFrom, body.periodTo));
    if (!list.length) return true;
    const rows = list.slice(0, 4).map(x => `<li><bdi>${h(x.desc || x.expenseNo || '')}</bdi> · ${h(typeof _statusLabel === 'function' ? _statusLabel(x.status) : x.status)}${admin() ? ` · ${money(x.amount)}` : ''}</li>`).join('');
    const msg = `${text(`يوجد بالفعل مصروف لـ «<bdi>${h(body.payeeName || S?.payee?.name || '')}</bdi>» يغطي نفس الفترة:`, `There is already an expense for “<bdi>${h(S?.payee?.name || '')}</bdi>” covering this period:`)}<ul class="xp-dup">${rows}</ul>${text('هل تريد تسجيل مصروف آخر لها؟', 'Record another one anyway?')}`;
    return typeof showConfirm === 'function'
      ? showConfirm(msg, { title: text('مصروف مكرر محتمل', 'Possible duplicate'), icon: 'warn', html: true })
      : true;
  }

  /** Two rows for the expense details window (party + period). */
  function detailHtml(e) {
    if (!e || (!e.payeeName && !e.periodFrom)) return '';
    const kind = e.payeeKind || kindForCategory(e.category);
    const label = kind ? tx(KIND_TEXT[kind].noun) : text('الجهة', 'Party');
    const field = (l, v) => `<div class="exp-detail-field"><div class="exp-detail-field-label">${h(l)}</div><div class="exp-detail-field-val">${v}</div></div>`;
    let out = '';
    if (e.payeeName) {
      const p = findPayee(e.payeeId);
      const plat = kind === 'ads' && p ? platformOf(p.platform) : null;
      out += field(label, `<bdi>${h(e.payeeName)}</bdi>${plat && plat.code !== 'other' ? ` <span class="xp-sub">· ${h(en() ? plat.en : plat.ar)}</span>` : ''}`);
    }
    if (e.periodFrom && e.periodTo) out += field(text('الفترة', 'Period'), `<bdi>${h(periodText(e.periodFrom, e.periodTo, true))}</bdi>`);
    const s = e.salary;
    if (s) {
      const rows = salaryLines(s, en()).map(l => `<div class="xp-dsal-row${l.neg ? ' is-neg' : ''}${l.total ? ' is-total' : ''}"><span>${h(l.label)}${l.sub ? `<small>${h(l.sub)}</small>` : ''}</span><b dir="ltr">${l.neg ? '−' : ''}${h(fmt2(l.amount))}</b></div>`).join('');
      out += `<div class="exp-detail-field" style="grid-column:1/-1"><div class="exp-detail-field-label">${text('تفاصيل المرتب', 'Salary details')}</div><div class="xp-dsal">${rows}</div></div>`;
    }
    return out;
  }

  /* ── salary slip + cheque (print) ───────────────────────────────────── */
  const fmt2 = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt0 = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  /** The lines of a breakdown, in order; zero lines (other than base and net) are left out. */
  function salaryLines(s, english) {
    const L = (ar, enT) => (english ? enT : ar);
    const lines = [{ label: L('المرتب الأساسي', 'Base salary'), amount: s.base }];
    if (Number(s.pointsBonus) > 0 || Number(s.points) > 0) {
      lines.push({ label: L('مكافأة الأداء', 'Performance bonus'), amount: s.pointsBonus,
        sub: L(`${fmt0(s.points)} نقطة`, `${fmt0(s.points)} points`) }); // the per-point rate is not printed (owner)
    }
    if (Number(s.overtime) > 0) lines.push({ label: L('العمل الإضافي (أوفر تايم)', 'Overtime'), amount: s.overtime, sub: s.overtimeNote || '' });
    if (Number(s.deductions) > 0) lines.push({ label: L('الخصومات والجزاءات', 'Deductions & penalties'), amount: s.deductions, sub: s.deductionsNote || '', neg: true });
    lines.push({ label: L('صافي المرتب المستحق', 'Net salary due'), amount: s.net, total: true });
    return lines;
  }

  function salaryDocHtml(e) {
    const st = (typeof settings !== 'undefined' && settings) || {};
    const company = String(st.companyLegalName || '').trim() || 'Soulia home';
    const p = findPayee(e.payeeId);
    const ulist = typeof users !== 'undefined' && Array.isArray(users) ? users : [];
    const u = (p?.userId && ulist.find(x => String(x._id) === String(p.userId)))
      || ulist.find(x => norm(x.name || x.username) === norm(e.payeeName || '')) || null;
    const job = u?.jobTitle ? (typeof jobTitleLabel === 'function' ? jobTitleLabel(u.jobTitle) : u.jobTitle) : '';
    const name = e.payeeName || '';
    const net = Number(e.salary?.net ?? e.amount) || 0;
    const s = e.salary || { base: net, points: 0, pointValue: 0, pointsBonus: 0, overtime: 0, deductions: 0, net };
    const monthTxt = (y, m) => new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('ar-EG-u-nu-latn', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const period = e.periodFrom && e.periodTo ? (() => {
      const a = parse(e.periodFrom), b = parse(e.periodTo);
      if (a.d === 1 && b.d === lastDay(b.y, b.m) && a.y === b.y && a.m === b.m) return `شهر ${monthTxt(a.y, a.m)}`;
      const dm = (q) => new Date(Date.UTC(q.y, q.m - 1, q.d)).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      return `الفترة من ${dm(a)} إلى ${dm(b)}`;
    })() : '';
    const day = String(e.date || '').slice(0, 10);
    const dp = /^\d{4}-\d{2}-\d{2}$/.test(day) ? parse(day) : (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; })();
    const dateTxt = new Date(Date.UTC(dp.y, dp.m - 1, dp.d)).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const method = String(e.account || 'كاش');
    const methodLbl = typeof _payMethodLabel === 'function' ? _payMethodLabel(method) : method;
    const words = typeof amountToArabicWords === 'function' ? amountToArabicWords(net) : '';
    // The cheque carries a serial (digits only) — never the label «رقم المصروف», and no status (owner, Nov 26).
    const serial = (String(e.expenseNo || '').replace(/\D/g, '') || '0').slice(-6).padStart(6, '0');
    const lines = salaryLines(s, false);
    const logo = typeof _invLogoSvg === 'function' ? _invLogoSvg(26) : '';
    const rows = lines.map(l => `<div class="ln${l.total ? ' is-total' : ''}${l.neg ? ' is-neg' : ''}"><span>${h(l.label)}${l.sub ? ` <small>${h(l.sub)}</small>` : ''}</span><b class="n">${l.neg ? '− ' : ''}${fmt2(l.amount)}</b></div>`).join('');
    const box = (v) => String(v).split('').map(c => `<i>${h(c)}</i>`).join('');
    const fileTitle = typeof _expPrintTitle === 'function' ? _expPrintTitle(e) : `مرتب ${name} — ${period}`;
    return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${h(fileTitle)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap');
@page{size:A4 portrait;margin:0}
*{box-sizing:border-box}
body{margin:0;font-family:'IBM Plex Sans Arabic',Tahoma,sans-serif;color:#111827;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;min-height:297mm;padding:15mm 15mm 12mm}
.n{unicode-bidi:isolate;direction:ltr;display:inline-block}
.hd{display:flex;align-items:flex-end;justify-content:space-between;padding-bottom:10px;border-bottom:1.5px solid #1f5f3d}
.hd h1{margin:0;font-size:19px}
.hd .sub{font-size:12px;color:#4b5563;margin-top:3px}
.hd .co{text-align:left;font-size:11px;color:#4b5563}
.who{display:flex;justify-content:space-between;align-items:baseline;gap:18px;margin:14px 0 10px}
.who .nm b{font-size:16px;font-weight:700}
.who .job{color:#6b7280;font-size:12px;margin-inline-start:10px}
.who .dt{font-size:12px;color:#374151;white-space:nowrap}
.page{display:flex;flex-direction:column}
.sigs{margin-top:22mm;display:grid;grid-template-columns:1fr 1fr;gap:30mm}
.sigs div{border-top:1px solid #374151;padding-top:5px;text-align:center}
.sigs b{display:block;font-size:12.5px}
.sigs span{display:block;font-size:10.5px;color:#6b7280;margin-top:2px}
.sum{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:12.5px}
.ln{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:7px 12px;border-bottom:1px solid #f0f1f3}
.ln small{color:#6b7280;font-size:10.5px;margin-inline-start:6px}
.ln b{font-weight:500;font-variant-numeric:tabular-nums}
.ln.is-neg b{color:#b91c1c}
.ln.is-total{background:#f2f8f4;border-bottom:none;font-weight:700;font-size:13.5px}
.ln.is-total b{font-weight:700}
.chq{position:relative;margin-top:14mm;height:84mm;border:1.6px solid #1f3b2d;border-radius:4px;padding:9mm 10mm 0;overflow:hidden;
  background:
    repeating-linear-gradient(45deg,rgba(31,95,61,.035) 0 2px,transparent 2px 7px),
    repeating-linear-gradient(-45deg,rgba(31,95,61,.035) 0 2px,transparent 2px 7px),
    linear-gradient(180deg,#f5faf6,#e9f3ec)}
.chq::before{content:'';position:absolute;inset:2.2mm;border:.6px solid rgba(31,59,45,.45);border-radius:2px;pointer-events:none}
.chq .top{display:flex;justify-content:space-between;align-items:flex-start}
.chq .bank{font-size:15px;font-weight:700;color:#1f3b2d}
.chq .bank small{display:block;font-size:10.5px;font-weight:500;color:#4b5563;margin-top:1px}
.chq .meta{text-align:left;font-size:10.5px;color:#374151}
.chq .ser{font-family:'Courier New',monospace;font-size:13px;letter-spacing:1.5px;color:#1f3b2d;direction:ltr}
.chq .date{display:flex;gap:6px;justify-content:flex-end;margin-top:5px;direction:ltr}
.chq .date .g{text-align:center}
.chq .date .g em{display:block;font-style:normal;font-size:8.5px;color:#6b7280;margin-bottom:1px}
.chq .date i{display:inline-block;width:13px;height:18px;line-height:18px;border:1px solid #1f3b2d;margin:0 -.5px;background:#fff;font-style:normal;font-size:11.5px;text-align:center;font-family:'Courier New',monospace;font-weight:700}
.chq .row{display:flex;align-items:baseline;gap:8px;margin-top:6.5mm;font-size:13px}
.chq .row > span{white-space:nowrap;color:#1f3b2d;font-weight:600}
.chq .fill{flex:1;border-bottom:1px solid #1f3b2d;padding:0 6px 2px;font-weight:600;font-size:13.5px;min-height:20px}
.chq .fill.words{font-size:12.5px;font-weight:500}
.chq .amt{flex:0 0 auto;border:1.6px solid #1f3b2d;background:#fff;padding:3px 10px;font-family:'Courier New',monospace;font-weight:700;font-size:15px;letter-spacing:.5px}
.chq .foot{position:absolute;left:10mm;right:10mm;bottom:15mm;display:flex;justify-content:space-between;align-items:flex-end}
.chq .crossed{font-size:9.5px;color:#1f3b2d;border-top:1px solid #1f3b2d;border-bottom:1px solid #1f3b2d;padding:2px 10px;transform:rotate(-8deg);font-weight:600}
.chq .sign{width:62mm;text-align:center;border-top:1px solid #1f3b2d;padding-top:3px;font-size:10.5px;color:#374151}
.chq .micr{position:absolute;left:0;right:0;bottom:0;height:10mm;display:flex;align-items:center;justify-content:center;gap:12mm;direction:ltr;
  font-family:'Courier New',monospace;font-size:13px;letter-spacing:2.5px;color:#111827;border-top:.6px dashed rgba(31,59,45,.35);background:rgba(255,255,255,.55)}
.rcv{margin-top:12mm;font-size:12px;color:#374151}
.rcv p{margin:0 0 14mm}
.rcv .sg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16mm}
.rcv .sg div{border-top:1px solid #9ca3af;padding-top:4px;text-align:center;font-size:11px}
</style></head><body><div class="page">
<div class="hd"><div><h1>إشعار صرف مرتب</h1><div class="sub">${h(period)}</div></div><div class="co">${logo}</div></div>
<div class="who">
  <div class="nm"><b>${h(name)}</b>${job ? `<span class="job"> · ${h(job)}</span>` : ''}</div>
  <div class="dt">${h(dateTxt)} · ${method === 'كاش' ? 'صُرف نقدًا' : `تحويل عن طريق ${h(methodLbl)}`}</div>
</div>
<div class="sum">${rows}</div>
<div class="chq">
  <div class="top">
    <div class="bank">${logo}</div>
    <div class="meta"><div class="ser">${h(serial)}</div>
      <div class="date"><div class="g"><em>DAY</em>${box(String(dp.d).padStart(2, '0'))}</div><div class="g"><em>MONTH</em>${box(String(dp.m).padStart(2, '0'))}</div><div class="g"><em>YEAR</em>${box(String(dp.y))}</div></div></div>
  </div>
  <div class="row"><span>ادفعوا لأمر</span><div class="fill">${h(name)}</div></div>
  <div class="row"><span>مبلغًا وقدره</span><div class="fill words">${h(words)}</div><div class="amt"><span class="n">EGP #${fmt2(net)}#</span></div></div>
  <div class="row"><span>وذلك عن</span><div class="fill">مرتب ${h(period)}</div></div>
  <div class="foot"><div class="crossed">يُصرف للمستفيد الأول</div></div>
  <div class="micr"><span>${h(serial)}</span><span>${h(String(dp.y) + String(dp.m).padStart(2, '0'))}</span><span>${h(fmt2(net).replace(/,/g, ''))}</span></div>
</div>
<div class="sigs">
  <div><b>المستلم</b><span>استلمتُ المبلغ المذكور أعلاه كاملًا</span></div>
  <div><b>المدير</b><span>عن ${h(company)}</span></div>
</div>
</div></body></html>`;
  }

  async function printSalary(id) {
    let e = (typeof expenses !== 'undefined' && Array.isArray(expenses) ? expenses : []).find(x => x._id === id);
    try { e = await api('/expenses/' + encodeURIComponent(id)); } catch (_) { /* use the copy in memory */ }
    if (!e) return;
    await load().catch(() => {});
    const html = salaryDocHtml(e);
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open(); doc.write(html); doc.close();
    const ready = Promise.race([doc.fonts ? doc.fonts.ready : Promise.resolve(), new Promise(r => setTimeout(r, 2500))]);
    await ready;
    // «حفظ كملف PDF» names the file after the page title — printing from a frame, some browsers read the
    // top page's title, so it carries the expense's name for the moment of printing.
    const pageTitle = document.title;
    document.title = doc.title || pageTitle;
    let finished = false;
    const done = () => { if (finished) return; finished = true; document.title = pageTitle; setTimeout(() => frame.remove(), 500); };
    frame.contentWindow.addEventListener('afterprint', done, { once: true });
    window.addEventListener('afterprint', done, { once: true });
    setTimeout(done, 120000);
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }

  /** Short «Nova Media · نوفمبر 2026» line under an expense row. */
  function rowTagHtml(e) {
    if (!e || (!e.payeeName && !e.periodFrom)) return '';
    const bits = [];
    if (e.payeeName) bits.push(`<bdi>${h(e.payeeName)}</bdi>`);
    if (e.periodFrom && e.periodTo) bits.push(`<bdi>${h(periodText(e.periodFrom, e.periodTo, true))}</bdi>`);
    return `<span class="xp-row-tag">${bits.join(' · ')}</span>`;
  }

  window.SouliaExpensePayees = {
    mount, onCategory, collect, confirmDuplicate, detailHtml, rowTagHtml, invalidate, load, periodText,
    printSalary, salaryDocHtml, salaryLines,
    kindForCategory, close: () => { S = null; },
  };
  // Warm the list once signed in, so the picker opens without a wait.
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { try { if (localStorage.getItem('token')) load().catch(() => {}); } catch (_) {} });
})();
