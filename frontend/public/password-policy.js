/* Password policy dialogs (Nov 27, 2026) — window.SouliaPassword.
   Server: backend/src/auth/password-policy.service.ts.
   - openChangeOwn(): admin's own password — ① current password ② new password twice (8+, not one
     of the last 5) ③ verification code ④ done → every device is signed out, so the page signs out too.
   - openResetStaff(user): an allowed admin sets a staff password — ① generate (14 characters) or type
     ② code ③ done: a generated password is shown ONCE here and never again.
   ⚠ One window, every step inside it (owner's rule): the code is asked here, never in a second window.
   Uses the PIN dialog's classes (.spin-*, index.html). */
(function () {
  'use strict';
  const T = (ar, en) => (typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar);
  const E = (v) => (typeof esc === 'function' ? esc(v) : String(v == null ? '' : v));
  let D = null;          // dialog state
  let allowed = null;    // cached «may I reset staff passwords?»

  const ICON_KEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>';
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  /** A strong random password (crypto), 14 characters, every character class present. */
  function generate(length = 14) {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%*?-_'];
    const all = sets.join('');
    const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
    const out = sets.map((s) => s[rnd(s.length)]);
    while (out.length < Math.max(12, length)) out.push(all[rnd(all.length)]);
    for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    return out.join('');
  }
  function score(pw) {
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    return Math.min(4, s);
  }

  async function canResetStaff(force) {
    if (allowed !== null && !force) return allowed;
    try { allowed = !!(await api('/auth/security/staff-password/allowed', { background: true })).allowed; }
    catch (_) { allowed = false; }
    return allowed;
  }

  // ── dialog shell ─────────────────────────────────────────────────────────
  function stepsHtml() {
    const at = D.steps.indexOf(D.step);
    return `<ol class="spin-steps">${D.steps.map((k, i) => `<li class="${i < at ? 'is-done' : i === at ? 'is-on' : ''}"><span>${i < at ? '✓' : i + 1}</span>${E(D.labels[k])}</li>`).join('')}</ol>`;
  }
  function open(cfg) {
    D = { busy: false, err: '', challenge: null, methods: null, method: '', emailSent: '', ...cfg };
    openModal(`<div class="spin-dlg pwp-dlg" role="dialog" aria-labelledby="pwp-title">
      <div class="spin-head">
        <span class="spin-ic">${ICON_KEY}</span>
        <div><h3 id="pwp-title">${E(D.title)}</h3><p>${E(D.sub)}</p></div>
        <button type="button" class="modal-x" data-pwp="close" aria-label="${E(T('إغلاق', 'Close'))}">×</button>
      </div>
      <div id="pwp-steps"></div>
      <div class="spin-body" id="pwp-body"></div>
      <div class="spin-err" id="pwp-err" role="alert" hidden></div>
      <div class="spin-foot" id="pwp-foot"></div>
    </div>`, 'max-width:540px;padding:0', { lockDismiss: true });
    document.querySelector('.pwp-dlg [data-pwp="close"]').addEventListener('click', close);
    render();
  }
  function close() { if (D && D.busy) return; const after = D && D.afterClose; D = null; closeModal(); if (after) after(); }
  function err(msg) { if (D) D.err = msg || ''; const el = document.getElementById('pwp-err'); if (el) { el.textContent = msg || ''; el.hidden = !msg; } }
  function busy(on, label) {
    if (!D) return;
    D.busy = on;
    const b = document.getElementById('pwp-next');
    if (!b) return;
    if (on) { b.dataset.label = b.textContent; b.disabled = true; if (label) b.textContent = label; }
    else if (b.dataset.label) { b.textContent = b.dataset.label; delete b.dataset.label; }
  }
  function foot(backLabel, nextLabel, enabled) {
    return `<button type="button" class="btn btn-outline" id="pwp-back">${E(backLabel)}</button>
      <button type="button" class="btn btn-primary" id="pwp-next" ${enabled ? '' : 'disabled'}>${E(nextLabel)}</button>`;
  }
  function pwField(id, label, autocomplete) {
    return `<div class="pwp-field"><label for="${id}">${E(label)}</label>
      <div class="pwp-input"><input type="password" id="${id}" autocomplete="${autocomplete}" dir="ltr" spellcheck="false">
      <button type="button" class="pwp-eye" data-eye="${id}" aria-label="${E(T('إظهار / إخفاء', 'Show / hide'))}">${EYE}</button></div></div>`;
  }
  function bindEyes(root) {
    root.querySelectorAll('[data-eye]').forEach((b) => b.addEventListener('click', () => {
      const i = document.getElementById(b.dataset.eye); if (!i) return;
      i.type = i.type === 'password' ? 'text' : 'password'; b.classList.toggle('is-on', i.type === 'text');
    }));
  }

  function render() {
    if (!D) return;
    const body = document.getElementById('pwp-body'), ft = document.getElementById('pwp-foot');
    document.getElementById('pwp-steps').innerHTML = stepsHtml();
    D.renderers[D.step](body, ft);
    const back = document.getElementById('pwp-back'); if (back) back.addEventListener('click', () => { if (!D.busy) D.back(); });
    err(D.err);
  }
  function go(step) { if (!D) return; D.err = ''; D.step = step; render(); }

  // ── shared: new password twice ───────────────────────────────────────────
  function newPasswordStep(body, ft, { minLen, onNext, backLabel, onBack }) {
    body.innerHTML = `${pwField('pwp-new', T('كلمة المرور الجديدة', 'New password'), 'new-password')}
      <div class="sv-meter pwp-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      ${pwField('pwp-new2', T('تأكيد كلمة المرور', 'Confirm password'), 'new-password')}
      <div class="pwp-match" id="pwp-match" aria-live="polite"></div>
      <ul class="spin-notes"><li>${E(T(`${minLen} أحرف على الأقل، ويُفضَّل الجمع بين الحروف الكبيرة والصغيرة والأرقام والرموز.`, `At least ${minLen} characters; mix upper and lower case, numbers and symbols.`))}</li>
        <li>${E(T('يجب أن تختلف عن آخر 5 كلمات مرور.', 'It must differ from the last 5 passwords.'))}</li></ul>`;
    ft.innerHTML = foot(backLabel, T('متابعة', 'Continue'), false);
    bindEyes(body);
    const a = document.getElementById('pwp-new'), b = document.getElementById('pwp-new2'), next = document.getElementById('pwp-next'), m = document.getElementById('pwp-match');
    const sync = () => {
      const s = score(a.value);
      body.querySelectorAll('.pwp-meter i').forEach((x, i) => x.classList.toggle('is-on', i < s));
      body.querySelector('.pwp-meter').dataset.s = s;
      const ok = a.value.length >= minLen && a.value === b.value;
      m.textContent = b.value ? (a.value === b.value ? T('✓ كلمتا المرور متطابقتان', '✓ Passwords match') : T('كلمتا المرور غير متطابقتين', 'Passwords do not match')) : '';
      m.className = 'pwp-match ' + (b.value ? (a.value === b.value ? 'is-ok' : 'is-bad') : '');
      if (!D.busy) next.disabled = !ok;
    };
    a.addEventListener('input', () => { err(''); sync(); }); b.addEventListener('input', () => { err(''); sync(); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !next.disabled) { e.preventDefault(); next.click(); } });
    next.addEventListener('click', () => onNext(a.value));
    setTimeout(() => a.focus(), 60);
  }

  // ── shared: the verification code, inside the dialog ─────────────────────
  async function startVerify(action) {
    const d = await api('/auth/security/step-up', { method: 'POST', body: JSON.stringify({ action }) });
    D.challenge = d.challenge; D.methods = d.methods || {}; D.emailSent = '';
    D.method = D.methods.totp ? 'totp' : 'email';
  }
  function verifyStep(body, ft, { onDone, backLabel, onBack }) {
    const m = D.methods || {};
    const both = m.totp && m.email;
    const lead = D.method === 'email'
      ? (D.emailSent ? T(`أدخل الرمز المكوّن من 6 أرقام المُرسَل إلى ${D.emailSent}. الرمز صالح 5 دقائق.`, `Enter the 6-digit code sent to ${D.emailSent}. It is valid for 5 minutes.`) : T(`سنرسل رمز تحقق إلى ${m.email || 'بريد الأمان'}.`, `We will send a code to ${m.email || 'your security email'}.`))
      : T('أدخل الرمز المكوّن من 6 أرقام من تطبيق Google Authenticator.', 'Enter the 6-digit code from Google Authenticator.');
    const needSend = D.method === 'email' && !D.emailSent;
    body.innerHTML = `${both ? `<div class="spin-methods" role="tablist">
        <button type="button" data-m="totp" class="${D.method === 'totp' ? 'is-on' : ''}">${E(T('تطبيق المصادقة', 'Authenticator app'))}</button>
        <button type="button" data-m="email" class="${D.method === 'email' ? 'is-on' : ''}">${E(T('البريد الإلكتروني', 'Email'))}</button></div>` : ''}
      <p class="spin-lead">${E(lead)}</p>
      ${needSend ? `<button type="button" class="btn btn-outline spin-send" id="pwp-send">${E(T('إرسال الرمز', 'Send code'))}</button>`
        : `<input type="text" id="pwp-code" class="spin-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" placeholder="••••••" aria-label="${E(T('رمز التحقق', 'Verification code'))}">
           ${D.method === 'email' ? `<button type="button" class="spin-link" id="pwp-resend">${E(T('إعادة إرسال الرمز', 'Resend code'))}</button>` : ''}`}`;
    ft.innerHTML = foot(backLabel, T('تأكيد', 'Confirm'), false);
    body.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { if (D.busy || D.method === b.dataset.m) return; D.method = b.dataset.m; D.err = ''; render(); if (D.method === 'email' && !D.emailSent) sendEmail(); }));
    const send = document.getElementById('pwp-send') || document.getElementById('pwp-resend');
    if (send) send.addEventListener('click', sendEmail);
    const code = document.getElementById('pwp-code'), next = document.getElementById('pwp-next');
    const submit = async () => {
      if (!D || D.busy) return;
      const v = (code?.value || '').trim();
      if (v.length !== 6) { err(T('أدخل الرمز المكوّن من 6 أرقام.', 'Enter the 6-digit code.')); return; }
      err(''); busy(true, T('جارٍ التحقق…', 'Verifying…'));
      try {
        if (!D.challenge) await startVerify(D.action);
        const res = await api('/auth/challenge/verify', { method: 'POST', body: JSON.stringify({ challenge: D.challenge, method: D.method, code: v }) });
        if (res && res.done === false) {
          busy(false); D.method = D.method === 'totp' ? 'email' : 'totp';
          D.err = T('تم قبول الرمز. أكمل التحقق بالوسيلة الثانية.', 'Code accepted. Complete the second method.'); render();
          if (D.method === 'email') sendEmail();
          return;
        }
        await onDone(D.challenge);
      } catch (e) {
        busy(false);
        if (/^CHALLENGE_/.test(e.code || '')) { D.challenge = null; D.emailSent = ''; }
        err(/^CHALLENGE_/.test(e.code || '') ? T('انتهت صلاحية التحقق. أدخل رمزًا جديدًا.', 'The verification expired. Enter a new code.') : e.message);
        if (code) { code.value = ''; code.classList.add('is-error'); code.focus(); setTimeout(() => code.classList.remove('is-error'), 600); }
        if (!D.challenge) startVerify(D.action).then(() => render()).catch(() => {});
      }
    };
    if (code) {
      code.addEventListener('input', () => {
        code.value = code.value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, '').slice(0, 6);
        if (!D.busy) next.disabled = code.value.length !== 6;
        if (code.value.length === 6) submit();
      });
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      setTimeout(() => code.focus(), 60);
    }
    next.addEventListener('click', submit);
  }
  async function sendEmail() {
    if (!D || D.busy) return;
    err(''); D.busy = true;
    try {
      if (!D.challenge) await startVerify(D.action);
      const r = await api('/auth/challenge/email', { method: 'POST', body: JSON.stringify({ challenge: D.challenge }) });
      D.emailSent = r.sentTo || (D.methods && D.methods.email) || '';
      D.busy = false; render();
    } catch (e) {
      D.busy = false;
      if (/^CHALLENGE_/.test(e.code || '')) D.challenge = null;
      err(e.code === 'EMAIL_RATE_LIMITED' ? T('طُلب رمز قبل قليل. يمكنك طلب رمز جديد بعد دقيقة.', 'A code was just requested. You can request another in a minute.') : e.message);
    }
  }
  function verifyUnavailable(e) {
    return e.code === 'STEP_UP_UNAVAILABLE'
      ? T('لا توجد وسيلة تحقق مفعّلة لحسابك. أعدّ تطبيق المصادقة من الإعدادات ← الأمان ← التحقق بخطوتين، ثم أعد المحاولة.', 'No verification method is set up for your account. Set up an authenticator app in Settings ← Security, then try again.')
      : e.message;
  }

  // ── ① own password (admins) ──────────────────────────────────────────────
  function openChangeOwn() {
    open({
      action: 'password-change',
      title: T('تغيير كلمة المرور', 'Change password'),
      sub: T('يتطلب التغيير كلمة المرور الحالية ورمز تحقق، وسيُسجَّل خروجك من جميع الأجهزة بعده.', 'The change requires your current password and a verification code; you will be signed out of every device afterwards.'),
      steps: ['current', 'new', 'verify', 'done'],
      labels: { current: T('الحالية', 'Current'), new: T('الجديدة', 'New'), verify: T('التحقق', 'Verify'), done: T('تم', 'Done') },
      current: '', next: '',
      back() { if (this.step === 'current') close(); else if (this.step === 'new') go('current'); else if (this.step === 'verify') go('new'); },
      renderers: {
        current(body, ft) {
          body.innerHTML = `${pwField('pwp-cur', T('كلمة المرور الحالية', 'Current password'), 'current-password')}
            <p class="spin-hint">${E(T('للتأكد من أنك صاحب الحساب.', 'To confirm it is you.'))}</p>`;
          ft.innerHTML = foot(T('إلغاء', 'Cancel'), T('متابعة', 'Continue'), false);
          bindEyes(body);
          const i = document.getElementById('pwp-cur'), next = document.getElementById('pwp-next');
          i.addEventListener('input', () => { err(''); if (!D.busy) next.disabled = !i.value; });
          i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && i.value) { e.preventDefault(); next.click(); } });
          next.addEventListener('click', async () => {
            if (D.busy) return;
            busy(true, T('جارٍ التحقق…', 'Checking…'));
            try {
              await api('/auth/security/password/check', { method: 'POST', body: JSON.stringify({ currentPassword: i.value }) });
              busy(false); D.current = i.value; go('new');
            } catch (e) { busy(false); err(e.message); i.value = ''; i.focus(); next.disabled = true; }
          });
          setTimeout(() => i.focus(), 60);
        },
        new(body, ft) {
          newPasswordStep(body, ft, {
            minLen: 8, backLabel: T('رجوع', 'Back'), onBack: () => go('current'),
            onNext: async (pw) => {
              if (pw === D.current) { err(T('كلمة المرور الجديدة مطابقة للحالية. اختر كلمة مرور مختلفة.', 'The new password is the same as the current one.')); return; }
              busy(true, T('جارٍ التحضير…', 'Preparing…'));
              try {
                await api('/auth/security/password/validate', { method: 'POST', body: JSON.stringify({ newPassword: pw }) });
                await startVerify('password-change');
                busy(false); D.next = pw; go('verify');
                if (D.method === 'email') sendEmail();
              } catch (e) { busy(false); err(verifyUnavailable(e)); }
            },
          });
        },
        verify(body, ft) {
          verifyStep(body, ft, {
            backLabel: T('رجوع', 'Back'), onBack: () => go('new'),
            onDone: async (stepUp) => {
              try {
                await api('/auth/security/password', { method: 'POST', body: JSON.stringify({ currentPassword: D.current, newPassword: D.next, stepUp }) });
              } catch (e) {
                if (e.code === 'CURRENT_PASSWORD_WRONG' || e.code === 'CURRENT_PASSWORD_PAUSED') { busy(false); D.err = e.message; go('current'); return; }
                throw e;
              }
              busy(false); D.current = ''; D.next = '';
              D.afterClose = () => { if (typeof doLogout === 'function') doLogout(); };
              go('done');
            },
          });
        },
        done(body, ft) {
          body.innerHTML = `<div class="spin-done"><span class="spin-done-ic">${ICON_OK}</span><b>${E(T('تم تغيير كلمة المرور', 'Password changed'))}</b>
            <p>${E(T('أُنهيت جميع جلساتك وأُلغيت الأجهزة الموثوقة، وأُرسل تنبيه إلى بريد الأمان. سجّل الدخول بكلمة المرور الجديدة.', 'Every session ended and trusted devices were removed; an alert was sent to your security email. Sign in with the new password.'))}</p></div>`;
          ft.innerHTML = `<button type="button" class="btn btn-primary" id="pwp-next">${E(T('تسجيل الدخول مجددًا', 'Sign in again'))}</button>`;
          document.getElementById('pwp-next').addEventListener('click', close);
        },
      },
      step: 'current',
    });
  }

  // ── ② staff password (allowed admins) ────────────────────────────────────
  async function openResetStaff(user) {
    if (!user) return;
    if (!(await canResetStaff())) {
      toast(T('إعادة تعيين كلمات مرور الموظفين متاحة للمدير الرئيسي، أو لمدير منحه هذه الصلاحية.', 'Only the owner, or an admin the owner allowed, can reset staff passwords.'), true);
      return;
    }
    const who = user.name || user.username;
    open({
      action: 'staff-password', userId: String(user._id),
      title: T('إعادة تعيين كلمة المرور', 'Reset password'),
      sub: T(`لحساب ${who} (@${user.username}). سيُسجَّل خروجه من جميع الأجهزة.`, `For ${who} (@${user.username}). They will be signed out of every device.`),
      steps: ['choose', 'verify', 'done'],
      labels: { choose: T('كلمة المرور', 'Password'), verify: T('التحقق', 'Verify'), done: T('تم', 'Done') },
      mode: 'generate', typed: '', result: '',
      back() { if (this.step === 'choose') close(); else if (this.step === 'verify') go('choose'); },
      renderers: {
        choose(body, ft) {
          const gen = D.mode === 'generate';
          body.innerHTML = `<div class="pwp-modes" role="radiogroup">
              <label class="pwp-mode${gen ? ' is-on' : ''}"><input type="radio" name="pwp-mode" value="generate" ${gen ? 'checked' : ''}><b>${E(T('توليد كلمة مرور قوية', 'Generate a strong password'))}</b><span>${E(T('14 حرفًا عشوائيًا، تُعرض لك مرة واحدة بعد الحفظ.', '14 random characters, shown to you once after saving.'))}</span></label>
              <label class="pwp-mode${gen ? '' : ' is-on'}"><input type="radio" name="pwp-mode" value="manual" ${gen ? '' : 'checked'}><b>${E(T('تعيين كلمة مرور', 'Set a password'))}</b><span>${E(T('تكتبها بنفسك مرتين.', 'Type it yourself, twice.'))}</span></label>
            </div><div id="pwp-manual"></div>`;
          body.querySelectorAll('input[name="pwp-mode"]').forEach((r) => r.addEventListener('change', () => { D.mode = r.value; D.err = ''; render(); }));
          const proceed = async (typed) => {
            busy(true, T('جارٍ التحضير…', 'Preparing…'));
            try {
              if (typed) await api('/auth/security/password/validate', { method: 'POST', body: JSON.stringify({ newPassword: typed, userId: D.userId }) });
              await startVerify('staff-password');
              busy(false); D.typed = typed || ''; go('verify');
              if (D.method === 'email') sendEmail();
            } catch (e) { busy(false); err(verifyUnavailable(e)); }
          };
          if (gen) {
            ft.innerHTML = foot(T('إلغاء', 'Cancel'), T('متابعة', 'Continue'), true);
            document.getElementById('pwp-next').addEventListener('click', () => proceed(''));
          } else {
            const host = document.getElementById('pwp-manual');
            const tmpFt = document.createElement('div');
            newPasswordStep(host, tmpFt, { minLen: 8, backLabel: T('إلغاء', 'Cancel'), onBack: close, onNext: (pw) => proceed(pw) });
            ft.innerHTML = ''; while (tmpFt.firstChild) ft.appendChild(tmpFt.firstChild);
          }
        },
        verify(body, ft) {
          verifyStep(body, ft, {
            backLabel: T('رجوع', 'Back'), onBack: () => go('choose'),
            onDone: async (stepUp) => {
              const r = await api(`/auth/security/staff-password/${encodeURIComponent(D.userId)}`, { method: 'POST', body: JSON.stringify(D.typed ? { password: D.typed, stepUp } : { generate: true, stepUp }) });
              busy(false); D.result = r.password || ''; D.typed = '';
              go('done');
              if (typeof users !== 'undefined') api('/users').then((u) => { users = u; if (typeof renderUsers === 'function') renderUsers(); }).catch(() => {});
            },
          });
        },
        done(body, ft) {
          body.innerHTML = `<div class="spin-done"><span class="spin-done-ic">${ICON_OK}</span><b>${E(T('تم تعيين كلمة المرور', 'Password set'))}</b>
            ${D.result ? `<div class="pwp-once"><code dir="ltr" id="pwp-once">${E(D.result)}</code><button type="button" class="btn btn-outline btn-sm" id="pwp-copy">${E(T('نسخ', 'Copy'))}</button></div>
              <p class="pwp-once-warn">${E(T('انسخ كلمة المرور الآن وسلّمها للموظف. لن تُعرض مرة أخرى.', 'Copy the password now and give it to the employee. It will not be shown again.'))}</p>` : ''}
            <p>${E(T(`سُجّل خروج ${who} من جميع الأجهزة، وسُجّلت العملية في سجل الأمان.`, `${who} was signed out of every device, and the change was recorded in the security log.`))}</p></div>`;
          ft.innerHTML = `<button type="button" class="btn btn-primary" id="pwp-next">${E(T('تم', 'Done'))}</button>`;
          document.getElementById('pwp-next').addEventListener('click', () => { D.result = ''; close(); });
          const cp = document.getElementById('pwp-copy');
          if (cp) cp.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(D.result); } catch (_) {
              const r = document.createRange(); r.selectNodeContents(document.getElementById('pwp-once'));
              const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); s.removeAllRanges();
            }
            cp.textContent = T('تم النسخ', 'Copied');
          });
        },
      },
      step: 'choose',
    });
  }

  /** After creating an account with a generated password: show it once. */
  function showOnce(user, password) {
    open({
      title: T('تم إنشاء الحساب', 'Account created'),
      sub: T(`${user.name || user.username} (@${user.username})`, `${user.name || user.username} (@${user.username})`),
      steps: ['done'], labels: { done: T('كلمة المرور', 'Password') }, result: password, back() { close(); },
      renderers: {
        done(body, ft) {
          body.innerHTML = `<div class="spin-done"><span class="spin-done-ic">${ICON_OK}</span><b>${E(T('كلمة المرور الأولى للحساب', 'The account’s first password'))}</b>
            <div class="pwp-once"><code dir="ltr" id="pwp-once">${E(D.result)}</code><button type="button" class="btn btn-outline btn-sm" id="pwp-copy">${E(T('نسخ', 'Copy'))}</button></div>
            <p class="pwp-once-warn">${E(T('انسخها الآن وسلّمها للموظف. لن تُعرض مرة أخرى.', 'Copy it now and give it to the employee. It will not be shown again.'))}</p></div>`;
          ft.innerHTML = `<button type="button" class="btn btn-primary" id="pwp-next">${E(T('تم', 'Done'))}</button>`;
          document.getElementById('pwp-next').addEventListener('click', () => { D.result = ''; close(); });
          document.getElementById('pwp-copy').addEventListener('click', async (ev) => {
            try { await navigator.clipboard.writeText(D.result); ev.target.textContent = T('تم النسخ', 'Copied'); } catch (_) { ev.target.textContent = T('انسخ يدويًا', 'Copy manually'); }
          });
        },
      },
      step: 'done',
    });
  }

  async function setRight(userId, allow) {
    await api(`/auth/security/staff-password-right/${encodeURIComponent(userId)}`, { method: 'POST', body: JSON.stringify({ allowed: !!allow }) });
  }

  window.SouliaPassword = { openChangeOwn, openResetStaff, showOnce, generate, canResetStaff, setRight };
})();
