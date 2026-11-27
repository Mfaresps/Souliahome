/* Employee account email (Nov 27, 2026) — window.SouliaAccountEmail.
 *
 * Every non-admin account links one email address, confirmed by a 6-digit code sent to it.
 *  - gate():  after sign-in, an account with no confirmed address gets a mandatory window
 *             («أضف بريدك الإلكتروني») — it cannot be closed, only signed out of.
 *  - openOwn(): «حسابي» → add / change the address (changing needs the current password).
 *  - renderCard(host): the «البريد الإلكتروني» card on «حسابي».
 *  - statusHtml(u) / adminBlockHtml(u) / adminRequest(id): the Users page and the user window.
 * Server: /auth/security/account-email (backend/src/auth/account-email.service.ts).
 * The card reuses the verification card classes of auth-security.css (.sv-*).
 */
(() => {
  const L = () => (typeof currentLang !== 'undefined' && currentLang === 'en' ? 'en' : 'ar');
  const T = (ar, en) => (L() === 'en' ? en : ar);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BASE = '/auth/security/account-email';
  const call = (path, opts = {}) => api(BASE + path, opts);
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body || {}) });
  const digits = (v) => String(v || '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/\D/g, '');
  const signedInAdmin = () => typeof currentUser !== 'undefined' && currentUser?.role === 'admin';
  const ICON_MAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>';
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_WAIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  // Server texts are Arabic; English is chosen by code (and a 503 reaches us as a generic text).
  const ERR = {
    EMAIL_INVALID: ['عنوان البريد الإلكتروني غير صحيح.', 'The email address is not valid.'],
    EMAIL_SAME: ['هذا هو البريد المؤكَّد الحالي.', 'This is already the confirmed address.'],
    EMAIL_TAKEN: ['هذا البريد الإلكتروني مرتبط بحساب آخر في النظام.', 'This email is already linked to another account.'],
    PASSWORD_WRONG: ['كلمة المرور الحالية غير صحيحة.', 'The current password is incorrect.'],
    SMTP_NOT_CONFIGURED: ['إرسال البريد الإلكتروني غير متاح حاليًا. تواصل مع مدير النظام.', 'Email sending is not available right now. Contact your system administrator.'],
    EMAIL_SEND_FAILED: ['تعذّر إرسال رسالة التأكيد. تأكد من صحة العنوان أو حاول بعد قليل.', 'The confirmation email could not be sent. Check the address or try again shortly.'],
    CODE_EXPIRED: ['انتهت صلاحية الرمز. اطلب رمزًا جديدًا.', 'The code has expired. Request a new one.'],
    CODE_LOCKED: ['أُوقف هذا الرمز بعد 5 محاولات خاطئة. اطلب رمزًا جديدًا.', 'This code was stopped after 5 wrong attempts. Request a new one.'],
    NO_PENDING: ['لا يوجد بريد بانتظار التأكيد.', 'There is no address waiting for confirmation.'],
    PENDING_CHANGED: ['تغيّر الطلب أثناء التأكيد. أعد المحاولة.', 'The request changed while confirming. Try again.'],
    ADMIN_USES_SECURITY_EMAIL: ['يستخدم حساب المدير «بريد الأمان» من الإعدادات ← الأمان.', 'Admin accounts use the security email in Settings → Security.'],
    ADMIN_ACCOUNT: ['يضيف المدير «بريد الأمان» لحسابه بنفسه من الإعدادات ← الأمان.', 'An admin adds their own security email in Settings → Security.'],
  };
  function errText(e) {
    const c = e?.code || '';
    const d = e?.details || {};
    if (c === 'CODE_WRONG') {
      const n = Number(d.attemptsLeft);
      if (Number.isFinite(n)) return T(`الرمز غير صحيح. تبقّت ${n} ${n === 1 ? 'محاولة' : 'محاولات'}.`, `The code is incorrect. ${n} attempt${n === 1 ? '' : 's'} left.`);
      return T('الرمز غير صحيح.', 'The code is incorrect.');
    }
    if (c === 'EMAIL_RATE_LIMITED') {
      const s = Number(d.waitSec) || 60;
      return s > 90
        ? T(`تجاوزت عدد الرموز المسموح به. حاول بعد ${Math.ceil(s / 60)} دقيقة.`, `Too many codes requested. Try again in ${Math.ceil(s / 60)} min.`)
        : T(`يمكنك طلب رمز جديد بعد ${s} ثانية.`, `You can request a new code in ${s} s.`);
    }
    if (ERR[c]) return T(ERR[c][0], ERR[c][1]);
    return (L() === 'ar' && e?.message) || T('تعذّر إتمام الطلب. حاول مرة أخرى.', 'The request could not be completed. Try again.');
  }

  // ─── Dialog ───────────────────────────────────────────────────────────────
  let ov = null;
  let S = null; // { step, st, mandatory, sentTo, byAdmin, ttlMin, busy, resendUntil, timer }

  const brandHtml = () => {
    const src = document.querySelector('#login-form-panel .lfp-logo')?.getAttribute('src') || '/soulia-startup-flat.svg';
    return `<div class="sv-brand"><img src="${E(src)}" alt="SOULIA" draggable="false"></div>`;
  };
  const btn = (act, label, cls = 'is-primary is-wide') => `<button type="button" class="sv-btn ${cls}" data-act="${act}"><span class="sv-btn-spin" aria-hidden="true"></span><span class="sv-btn-txt">${E(label)}</span></button>`;
  const otpHtml = () => `<div class="sv-otp" id="ae-otp" dir="ltr" role="group" aria-label="${E(T('رمز التأكيد', 'Confirmation code'))}">${[0, 1, 2, 3, 4, 5].map((i) => `<input class="sv-otp-box" type="text" inputmode="numeric" maxlength="6" ${i === 0 ? 'autocomplete="one-time-code"' : 'autocomplete="off"'} aria-label="${E(T(`الرقم ${i + 1} من 6`, `Digit ${i + 1} of 6`))}">`).join('')}</div>`;

  function footHtml() {
    return S.mandatory
      ? `<div class="sv-foot"><button type="button" class="sv-link sv-back" data-act="logout">${E(T('تسجيل الخروج', 'Sign out'))}</button></div>`
      : `<div class="sv-foot"><button type="button" class="sv-link sv-back" data-act="close">${E(T('إلغاء', 'Cancel'))}</button></div>`;
  }

  function emailStepHtml() {
    const st = S.st || {};
    const changing = !!st.email;
    const prefill = S.typed ?? (st.pending?.email || st.unverifiedEmail || '');
    const title = changing ? T('تغيير البريد الإلكتروني', 'Change your email') : T('أضف بريدك الإلكتروني', 'Add your email');
    const sub = changing
      ? T('أدخل العنوان الجديد وكلمة المرور الحالية. سنرسل رمز تأكيد إلى العنوان الجديد، ويبقى بريدك الحالي مرتبطًا بحسابك حتى تأكيد الجديد.',
        'Enter the new address and your current password. We will send a confirmation code to the new address; your current email stays linked until the new one is confirmed.')
      : T('لإكمال إعداد حسابك، أضف بريدك الإلكتروني. سنرسل إليه رمز تأكيد مكوّنًا من 6 أرقام.',
        'To finish setting up your account, add your email address. We will send it a 6-digit confirmation code.');
    return `${brandHtml()}<h2 class="sv-title" id="ae-title">${E(title)}</h2><p class="sv-sub">${E(sub)}</p>
      ${changing ? `<div class="ae-current">${ICON_OK}<span>${E(T('البريد الحالي', 'Current email'))}: <bdi dir="ltr">${E(st.email)}</bdi></span></div>` : ''}
      <label class="sv-label" for="ae-email">${E(changing ? T('البريد الإلكتروني الجديد', 'New email address') : T('البريد الإلكتروني', 'Email address'))}</label>
      <input class="sv-input" id="ae-email" type="email" dir="ltr" autocomplete="email" inputmode="email" spellcheck="false" maxlength="200" placeholder="name@example.com" value="${E(prefill)}">
      ${changing ? `<label class="sv-label" for="ae-pass">${E(T('كلمة المرور الحالية', 'Current password'))}</label>
      <input class="sv-input" id="ae-pass" type="password" autocomplete="current-password" maxlength="200">` : ''}
      <p class="ae-note">${E(T('يُستخدم هذا البريد لإرسال الإشعارات والتنبيهات الرسمية من النظام، ولا يظهر إلا لك ولمدير النظام.', 'This address is used for official notifications and alerts from the system, and is visible only to you and the system administrator.'))}</p>
      <p class="sv-err" id="ae-err" role="alert" hidden></p>
      ${btn('send', T('إرسال رمز التأكيد', 'Send confirmation code'))}
      ${footHtml()}`;
  }

  function codeStepHtml() {
    const who = S.byAdmin
      ? T(`أرسل مدير النظام${S.byAdmin === true ? '' : ` (${S.byAdmin})`} رمز تأكيد مكوّنًا من 6 أرقام إلى`, `Your system administrator${S.byAdmin === true ? '' : ` (${S.byAdmin})`} sent a 6-digit confirmation code to`)
      : T('أرسلنا رمز تأكيد مكوّنًا من 6 أرقام إلى', 'We sent a 6-digit confirmation code to');
    const ttl = S.ttlMin >= 120 ? T(`${Math.round(S.ttlMin / 60)} ساعة`, `${Math.round(S.ttlMin / 60)} hours`) : T(`${S.ttlMin} دقائق`, `${S.ttlMin} minutes`);
    return `${brandHtml()}<h2 class="sv-title" id="ae-title">${E(T('تحقق من بريدك الإلكتروني', 'Check your email'))}</h2>
      <p class="sv-sub">${E(who)} <bdi dir="ltr" class="sv-mono">${E(S.sentTo)}</bdi>.<br>${E(T(`الرمز صالح لمدة ${ttl} ويُستخدم مرة واحدة.`, `The code is valid for ${ttl} and can be used once.`))}</p>
      ${otpHtml()}
      <p class="sv-err" id="ae-err" role="alert" hidden></p>
      <div class="ae-spam">${ICON_MAIL}<span>${E(T('لم تصلك الرسالة؟ تحقّق من مجلد الرسائل غير المرغوب فيها (Spam) أو «العروض الترويجية»، فقد تصل الرسالة إليه. وقد يستغرق وصولها دقيقة.', 'No email yet? Check your Spam or Promotions folder — the message may land there. It can take a minute to arrive.'))}</span></div>
      ${btn('confirm', T('تأكيد البريد الإلكتروني', 'Confirm email'))}
      <div class="sv-resend"><button type="button" class="sv-link" data-act="resend" id="ae-resend"></button><span class="ae-dot" aria-hidden="true">·</span><button type="button" class="sv-link" data-act="edit">${E(T('تغيير العنوان', 'Use another address'))}</button></div>
      ${footHtml()}`;
  }

  function doneStepHtml() {
    return `<div class="ae-done-ic">${ICON_OK}</div><h2 class="sv-title" id="ae-title">${E(T('تم تأكيد بريدك الإلكتروني', 'Your email is confirmed'))}</h2>
      <p class="sv-sub">${E(T('رُبط البريد', 'The address'))} <bdi dir="ltr" class="sv-mono">${E(S.sentTo)}</bdi> ${E(T('بحسابك بنجاح، وستصلك عليه الإشعارات الرسمية من النظام.', 'is now linked to your account. Official notifications from the system will be sent to it.'))}</p>
      ${btn('finish', T('متابعة', 'Continue'))}`;
  }

  function render() {
    if (!ov) return;
    const card = ov.querySelector('.sv-card');
    card.innerHTML = S.step === 'code' ? codeStepHtml() : S.step === 'done' ? doneStepHtml() : emailStepHtml();
    if (S.step === 'code') { bindOtp(); tickResend(); setTimeout(() => ov?.querySelector('.sv-otp-box')?.focus(), 40); }
    else if (S.step === 'email') setTimeout(() => { const i = ov?.querySelector('#ae-email'); if (i) { i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} } }, 40);
    else setTimeout(() => ov?.querySelector('[data-act="finish"]')?.focus(), 40);
  }

  function setErr(msg) {
    const el = ov?.querySelector('#ae-err');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  function setBusy(act, on) {
    S.busy = on;
    const b = ov?.querySelector(`[data-act="${act}"]`);
    if (b) { b.classList.toggle('is-loading', on); b.disabled = on; b.setAttribute('aria-busy', String(on)); }
  }

  const boxes = () => (ov ? [...ov.querySelectorAll('.sv-otp-box')] : []);
  const codeValue = () => boxes().map((b) => b.value).join('');
  function shakeCode() {
    const root = ov?.querySelector('#ae-otp');
    boxes().forEach((b) => { b.value = ''; b.classList.remove('is-filled'); });
    if (root) { root.classList.remove('is-error'); void root.offsetWidth; root.classList.add('is-error'); }
    boxes()[0]?.focus();
  }
  function bindOtp() {
    const root = ov.querySelector('#ae-otp');
    const bx = boxes();
    const mark = () => bx.forEach((b) => b.classList.toggle('is-filled', !!b.value));
    const done = () => { if (codeValue().length === 6) confirm(); };
    const spread = (from, text) => {
      let i = from;
      for (const ch of text) { if (i > 5) break; bx[i].value = ch; i++; }
      mark();
      (bx[Math.min(i, 5)] || bx[5]).focus();
      done();
    };
    bx.forEach((b, i) => {
      b.addEventListener('input', () => {
        root.classList.remove('is-error'); setErr('');
        const v = digits(b.value);
        if (v.length > 1) { b.value = ''; spread(i, v); return; }
        b.value = v; mark();
        if (v && i < 5) bx[i + 1].focus();
        done();
      });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !b.value && i > 0) { e.preventDefault(); bx[i - 1].value = ''; bx[i - 1].focus(); mark(); }
        else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); bx[i - 1].focus(); }
        else if (e.key === 'ArrowRight' && i < 5) { e.preventDefault(); bx[i + 1].focus(); }
        else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      });
      b.addEventListener('paste', (e) => {
        const text = digits((e.clipboardData || window.clipboardData)?.getData('text') || '');
        if (!text) return;
        e.preventDefault();
        bx.forEach((x) => { x.value = ''; });
        spread(0, text.slice(0, 6));
      });
      b.addEventListener('focus', () => { try { b.select(); } catch (_) {} });
    });
  }

  function tickResend() {
    clearInterval(S.timer);
    const paint = () => {
      const b = ov?.querySelector('#ae-resend');
      if (!b) { clearInterval(S.timer); return; }
      const left = Math.max(0, Math.ceil((S.resendUntil - Date.now()) / 1000));
      b.disabled = left > 0 || S.busy;
      b.textContent = left > 0 ? T(`إعادة الإرسال بعد ${left} ث`, `Resend in ${left}s`) : T('إعادة إرسال الرمز', 'Resend code');
      if (!left) clearInterval(S.timer);
    };
    paint();
    S.timer = setInterval(paint, 1000);
  }

  function toCode(res, byAdmin) {
    S.busy = false; // the send finished; the code step starts free
    S.step = 'code';
    S.sentTo = res.sentTo || S.sentTo;
    S.byAdmin = byAdmin || false;
    S.ttlMin = Number(res.expiresInMin) || 5;
    S.resendUntil = Date.now() + (Number(res.resendIn) || 60) * 1000;
    if (res.state) S.st = res.state;
    render();
  }

  async function send() {
    if (S.busy) return;
    const input = ov.querySelector('#ae-email');
    const email = String(input?.value || '').trim().toLowerCase();
    S.typed = input?.value || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setErr(ERR.EMAIL_INVALID[L() === 'en' ? 1 : 0]); input?.focus(); return; }
    const pass = ov.querySelector('#ae-pass');
    if (pass && !pass.value) { setErr(T('أدخل كلمة المرور الحالية.', 'Enter your current password.')); pass.focus(); return; }
    setErr(''); setBusy('send', true);
    try {
      // The address an admin already typed: a fresh code to it (no retyping).
      const res = S.st?.pending?.email === email && !pass
        ? await post('/resend')
        : await post('/request', { email, password: pass?.value || '' });
      toCode(res, false);
    } catch (e) {
      setBusy('send', false);
      setErr(errText(e));
      if (e?.code === 'PASSWORD_WRONG') { pass.value = ''; pass.focus(); } else input?.focus();
    }
  }

  async function resend() {
    if (S.busy) return;
    S.busy = true; tickResend();
    try {
      const res = await post('/resend');
      S.busy = false;
      toCode(res, false);
      toastSafe(T('أُرسل رمز جديد إلى بريدك الإلكتروني.', 'A new code was sent to your email.'));
    } catch (e) { S.busy = false; tickResend(); setErr(errText(e)); }
  }

  async function confirm() {
    if (S.busy) return;
    const code = codeValue();
    if (code.length !== 6) { setErr(T('أدخل الرمز المكوّن من 6 أرقام.', 'Enter the 6-digit code.')); boxes()[code.length]?.focus(); return; }
    setErr(''); setBusy('confirm', true);
    try {
      const res = await post('/confirm', { code });
      S.sentTo = res.email || S.sentTo;
      S.st = res.state || S.st;
      try {
        if (typeof currentUser !== 'undefined' && currentUser) { currentUser.email = S.sentTo; currentUser.emailVerified = true; }
        if (typeof updateHeader === 'function') updateHeader();
      } catch (_) {}
      S.busy = false;
      S.step = 'done';
      render();
      refreshCard();
    } catch (e) {
      setBusy('confirm', false);
      setErr(errText(e));
      if (e?.code === 'CODE_EXPIRED' || e?.code === 'CODE_LOCKED') { S.resendUntil = 0; tickResend(); }
      shakeCode();
    }
  }

  function close() {
    if (!ov) return;
    clearInterval(S?.timer);
    document.removeEventListener('keydown', ov._key, true);
    ov.remove();
    ov = null;
    const after = S?.after;
    S = null;
    if (typeof after === 'function') { try { after(); } catch (_) {} }
  }

  function open(st, opts = {}) {
    if (ov) close();
    S = { step: 'email', st, mandatory: !!opts.mandatory, after: opts.after, busy: false, resendUntil: 0 };
    // An address an admin already sent a code to, still valid: straight to the code.
    const p = st?.pending;
    if (p?.email && p.codeLive && opts.startAtCode !== false) {
      S.step = 'code'; S.sentTo = p.email; S.byAdmin = p.byAdmin ? (p.requestedBy || true) : false;
      const left = Math.max(1, Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 60000));
      S.ttlMin = p.byAdmin ? 48 * 60 : Math.min(5, left);
      S.resendUntil = Date.now() + (Number(st.resendIn) || 0) * 1000;
    }
    ov = document.createElement('div');
    ov.id = 'ae-ov';
    ov.className = 'sv-ov ae-ov';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'ae-title');
    ov.dir = L() === 'en' ? 'ltr' : 'rtl';
    ov.lang = L();
    ov.innerHTML = '<div class="sv-stack"><div class="sv-card"></div></div>';
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const a = b.dataset.act;
      if (a === 'send') send();
      else if (a === 'confirm') confirm();
      else if (a === 'resend') resend();
      else if (a === 'edit') { clearInterval(S.timer); S.step = 'email'; S.typed = S.sentTo || ''; render(); }
      else if (a === 'close' || a === 'finish') close();
      else if (a === 'logout') { close(); if (typeof doLogout === 'function') doLogout(); }
    });
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && S.step === 'email' && (e.target.id === 'ae-email' || e.target.id === 'ae-pass')) { e.preventDefault(); send(); }
    });
    // ⚠ Mandatory: Escape does nothing (owner: the window cannot be skipped).
    ov._key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!S.mandatory || S.step === 'done') close(); } };
    document.addEventListener('keydown', ov._key, true);
    document.body.appendChild(ov);
    render();
  }

  const toastSafe = (m, bad) => { try { if (typeof toast === 'function') toast(m, bad); } catch (_) {} };
  async function loadState() { return call(''); }

  /** After sign-in. Resolves true when the mandatory window was opened (the tour waits for it). */
  async function gate() {
    if (typeof currentUser === 'undefined' || !currentUser || signedInAdmin()) return false;
    let st;
    try { st = await loadState(); } catch (_) { return false; }
    if (!st?.required) return false;
    // Another window (a confirm, the invoice overlay) must not sit over this one.
    const wait = () => new Promise((r) => setTimeout(r, 400));
    for (let i = 0; i < 20 && (document.querySelector('#modal-overlay.active, .sv-ov:not(.ae-ov)')); i++) await wait();
    open(st, { mandatory: true, after: () => { try { window.SouliaOnboarding?.maybeStart(); } catch (_) {} } });
    return true;
  }

  async function openOwn() {
    try {
      const st = await loadState();
      if (st?.admin) { toastSafe(T('يستخدم حساب المدير «بريد الأمان» من الإعدادات ← الأمان.', 'Admin accounts use the security email in Settings → Security.')); return; }
      if (!st?.mailConfigured) { toastSafe(ERR.SMTP_NOT_CONFIGURED[L() === 'en' ? 1 : 0], true); return; }
      open(st, { mandatory: false, startAtCode: true });
    } catch (e) { toastSafe(errText(e), true); }
  }

  // ─── «حسابي» card ────────────────────────────────────────────────────────
  let cardHost = null;
  async function renderCard(host) {
    host = host || cardHost || document.getElementById('uh-email-card');
    if (!host) return;
    cardHost = host;
    if (!host.dataset.ready) host.innerHTML = `<h2 class="uh-card-title">${E(T('البريد الإلكتروني', 'Email address'))}</h2><div class="ae-skel"></div>`;
    let st;
    try { st = await loadState(); } catch (_) {
      host.innerHTML = `<h2 class="uh-card-title">${E(T('البريد الإلكتروني', 'Email address'))}</h2><p class="uh-card-desc">${E(T('تعذّر تحميل بيانات البريد الإلكتروني.', 'The email details could not be loaded.'))}</p>`;
      return;
    }
    host.dataset.ready = '1';
    const title = `<h2 class="uh-card-title">${E(T('البريد الإلكتروني', 'Email address'))}</h2>`;
    if (st.admin) {
      host.innerHTML = `${title}<p class="uh-card-desc">${E(T('يستخدم حساب المدير «بريد الأمان» المُعدّ من الإعدادات ← الأمان.', 'Admin accounts use the security email set in Settings → Security.'))}</p>
        <div class="ae-row">${st.securityEmail ? `<span class="ae-chip is-ok">${ICON_OK}${E(T('مؤكَّد', 'Confirmed'))}</span><bdi dir="ltr" class="ae-addr">${E(st.securityEmail)}</bdi>` : `<span class="ae-chip is-none">${E(T('لم يُضف بعد', 'Not added yet'))}</span>`}</div>`;
      return;
    }
    const when = st.verifiedAt ? new Date(st.verifiedAt).toLocaleDateString(L() === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const p = st.pending;
    host.innerHTML = `${title}<p class="uh-card-desc">${E(T('تصلك على هذا البريد الإشعارات والتنبيهات الرسمية من النظام. يتطلب تغييره كلمة المرور الحالية ورمز تأكيد يُرسل إلى العنوان الجديد.', 'Official notifications from the system are sent to this address. Changing it needs your current password and a code sent to the new address.'))}</p>
      <div class="ae-row">
        ${st.email ? `<span class="ae-chip is-ok">${ICON_OK}${E(T('مؤكَّد', 'Confirmed'))}</span><bdi dir="ltr" class="ae-addr">${E(st.email)}</bdi>${when ? `<span class="ae-when">${E(T('منذ', 'since'))} ${E(when)}</span>` : ''}`
          : `<span class="ae-chip is-none">${E(T('لم يُضف بعد', 'Not added yet'))}</span>`}
      </div>
      ${p ? `<div class="ae-row ae-pend">${ICON_WAIT}<span>${E(T('بانتظار التأكيد', 'Waiting for confirmation'))}: <bdi dir="ltr">${E(p.email)}</bdi></span>
        <button type="button" class="uh-btn uh-btn-ghost ae-mini" onclick="SouliaAccountEmail.openOwn()">${E(T('إدخال الرمز', 'Enter code'))}</button>
        <button type="button" class="ae-link-danger" onclick="SouliaAccountEmail.cancelOwn()">${E(T('إلغاء الطلب', 'Cancel request'))}</button></div>` : ''}
      <div class="uh-actions"><button type="button" class="uh-btn ${st.email ? 'uh-btn-ghost' : 'uh-btn-primary'}" onclick="SouliaAccountEmail.openOwn()" ${st.mailConfigured ? '' : 'disabled title="' + E(ERR.SMTP_NOT_CONFIGURED[L() === 'en' ? 1 : 0]) + '"'}>${E(st.email ? T('تغيير البريد الإلكتروني', 'Change email') : T('إضافة بريد إلكتروني', 'Add email'))}</button></div>`;
  }
  function refreshCard() { if (cardHost && document.body.contains(cardHost)) renderCard(cardHost); }

  async function cancelOwn() {
    try { await call('/pending', { method: 'DELETE' }); toastSafe(T('أُلغي طلب تأكيد البريد.', 'The confirmation request was cancelled.')); refreshCard(); }
    catch (e) { toastSafe(errText(e), true); }
  }

  // ─── Users page + user window (admin) ───────────────────────────────────
  /** One small mark on the users table: confirmed / waiting / none. */
  function statusHtml(u) {
    if (!u) return '';
    if (u.role === 'admin') {
      return u.securityEmail && u.securityEmailVerifiedAt
        ? `<span class="ae-tag is-ok" title="${E(T('بريد الأمان', 'Security email') + ': ' + u.securityEmail)}">${ICON_OK}<bdi dir="ltr">${E(u.securityEmail)}</bdi></span>` : '';
    }
    if (u.email && u.emailVerifiedAt) return `<span class="ae-tag is-ok" title="${E(T('بريد مؤكَّد', 'Confirmed email'))}">${ICON_OK}<bdi dir="ltr">${E(u.email)}</bdi></span>`;
    const p = u.emailPending?.email;
    if (p) return `<span class="ae-tag is-wait" title="${E(T('أُرسل رمز التأكيد، بانتظار أن يُدخله الموظف', 'Code sent — waiting for the employee to enter it'))}">${ICON_WAIT}<span>${E(T('بانتظار تأكيد البريد', 'Email awaiting confirmation'))}</span></span>`;
    return `<span class="ae-tag is-none">${E(T('لم يُضف البريد', 'No email yet'))}</span>`;
  }

  /** The «البريد الإلكتروني» field of the user window. */
  function adminBlockHtml(u) {
    if (!u) {
      return `<div class="form-group um2-full"><label for="um-email">${E(T('البريد الإلكتروني', 'Email'))} <span class="um2-hint" style="display:inline">(${E(T('اختياري', 'optional'))})</span></label>
        <input type="email" id="um-email" dir="ltr" placeholder="name@example.com" autocomplete="off" spellcheck="false">
        <div class="um2-hint">${E(T('سيُرسل رمز تأكيد إلى هذا البريد، ويُدخله الموظف عند أول تسجيل دخول. لا يُربط البريد إلا بعد تأكيده. لا يُستخدم لحسابات المديرين.', 'A confirmation code is sent to this address and the employee enters it at first sign-in. It is linked only once confirmed. Not used for admin accounts.'))}</div></div>`;
    }
    if (u.role === 'admin') {
      return `<div class="form-group um2-full"><label>${E(T('البريد الإلكتروني', 'Email'))}</label><div class="ae-um">${statusHtml(u) || `<span class="ae-tag is-none">${E(T('لم يُضف بريد الأمان', 'No security email yet'))}</span>`}
        <span class="um2-hint">${E(T('يُدار بريد الأمان لحساب المدير من الإعدادات ← الأمان.', 'An admin account’s security email is managed in Settings → Security.'))}</span></div></div>`;
    }
    const p = u.emailPending?.email;
    return `<div class="form-group um2-full" id="um-email-block"><label>${E(T('البريد الإلكتروني', 'Email'))}</label>
      <div class="ae-um">${statusHtml(u)}${p ? ` <span class="ae-um-pend">${E(T('بانتظار', 'Waiting'))}: <bdi dir="ltr">${E(p)}</bdi>${u.emailPending?.requestedBy?.name ? ' · ' + E(T('طلبه', 'requested by')) + ' ' + E(u.emailPending.requestedBy.name) : ''}</span>
        <button type="button" class="ae-link-danger" onclick="SouliaAccountEmail.adminCancel('${E(u._id)}')">${E(T('إلغاء الطلب', 'Cancel request'))}</button>` : ''}</div>
      <div class="ae-um-form">
        <input type="email" id="um-email-new" dir="ltr" placeholder="${E(u.email && u.emailVerifiedAt ? T('بريد جديد name@example.com', 'New address name@example.com') : 'name@example.com')}" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-outline btn-sm" id="um-email-send" onclick="SouliaAccountEmail.adminRequest('${E(u._id)}')">${E(T('إرسال رمز التأكيد', 'Send code'))}</button>
      </div>
      <div class="um2-hint">${E(T('يُرسل الرمز إلى العنوان الجديد، ويؤكّده الموظف بنفسه عند تسجيل الدخول. يبقى البريد الحالي مرتبطًا حتى التأكيد.', 'The code goes to the new address and the employee confirms it at sign-in. The current email stays linked until then.'))}</div>
      <p class="ae-um-err" id="um-email-err" role="alert" hidden></p></div>`;
  }

  async function reloadUsers() {
    try { if (typeof users !== 'undefined') users = await api('/users'); } catch (_) {}
    try { if (typeof renderUsers === 'function') renderUsers(); } catch (_) {}
  }
  function repaintUserWindow(id) {
    const blk = document.getElementById('um-email-block');
    const u = (typeof users !== 'undefined' && Array.isArray(users)) ? users.find((x) => String(x._id) === String(id)) : null;
    if (blk && u) blk.outerHTML = adminBlockHtml(u);
  }

  async function adminRequest(id) {
    const input = document.getElementById('um-email-new');
    const err = document.getElementById('um-email-err');
    const btnEl = document.getElementById('um-email-send');
    const email = String(input?.value || '').trim().toLowerCase();
    const show = (m) => { if (err) { err.textContent = m || ''; err.hidden = !m; } };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { show(ERR.EMAIL_INVALID[L() === 'en' ? 1 : 0]); input?.focus(); return; }
    show('');
    if (btnEl) btnEl.disabled = true;
    try {
      const r = await post('/user/' + encodeURIComponent(id), { email });
      toastSafe(T(`أُرسل رمز التأكيد إلى ${r.sentTo}. سيُطلب من الموظف إدخاله عند تسجيل الدخول.`, `A confirmation code was sent to ${r.sentTo}. The employee will be asked for it at sign-in.`));
      await reloadUsers();
      repaintUserWindow(id);
    } catch (e) { show(errText(e)); if (btnEl) btnEl.disabled = false; }
  }

  async function adminCancel(id) {
    try { await call('/user/' + encodeURIComponent(id) + '/pending', { method: 'DELETE' }); toastSafe(T('أُلغي طلب تأكيد البريد.', 'The confirmation request was cancelled.')); await reloadUsers(); repaintUserWindow(id); }
    catch (e) { toastSafe(errText(e), true); }
  }

  /** After POST /users: what happened to the address typed in the new-account window. */
  function inviteToast(res, typed) {
    if (!typed) return;
    const inv = res?.emailInvite;
    if (inv?.sent) toastSafe(T(`أُرسل رمز تأكيد البريد إلى ${inv.sentTo}. يُدخله الموظف عند أول تسجيل دخول.`, `A confirmation code was sent to ${inv.sentTo}. The employee enters it at first sign-in.`));
    else if (inv?.message) toastSafe(T('أُنشئ الحساب، لكن لم يُرسل رمز تأكيد البريد: ', 'The account was created, but the email code was not sent: ') + inv.message, true);
  }

  // Live: an employee confirmed (Users page refreshes); my own address changed elsewhere (card).
  let liveTimer = null;
  function onEmailChanged() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (typeof currentPage !== 'undefined' && currentPage === 'users') reloadUsers(); }, 600);
  }
  function bindSocket(sock) {
    if (!sock || sock._aeBound) return;
    sock._aeBound = true;
    sock.on('users:email-changed', onEmailChanged);
    sock.on('account-email:changed', () => refreshCard());
  }

  window.SouliaAccountEmail = { gate, openOwn, renderCard, cancelOwn, statusHtml, adminBlockHtml, adminRequest, adminCancel, inviteToast, bindSocket };
})();
