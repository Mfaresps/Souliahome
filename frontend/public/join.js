/* «إنشاء حسابك» — the page an invitation email opens (/join/<token>). Nov 28, 2026.
 * Standalone (does not load the app): details → password → photo (required) → done.
 * The account is created in ONE request at the end, so a closed tab never leaves half an account. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const LANG_KEY = 'soulia_login_lang';
  let lang = (localStorage.getItem(LANG_KEY) || '').startsWith('en') ? 'en' : 'ar';

  const T = {
    ar: {
      title: 'أهلًا بك في SOULIA',
      sub: (by, role) => `دعاك ${by} للانضمام بدور ${role}. أكمل بياناتك لإنشاء حسابك.`,
      subNoBy: (role) => `دُعيت للانضمام بدور ${role}. أكمل بياناتك لإنشاء حسابك.`,
      steps: ['بياناتك', 'كلمة المرور', 'صورتك'],
      name: 'الاسم الكامل', namePh: 'اسمك كما يظهر لزملائك',
      user: 'اسم المستخدم', userHint: 'أحرف إنجليزية وأرقام فقط، ويُستخدم في تسجيل الدخول. اقترحناه من اسمك ويمكنك تعديله.',
      userOk: 'اسم المستخدم متاح', checking: 'جارٍ التحقق…',
      phone: 'رقم الهاتف', phonePh: '01xxxxxxxxx', phoneBad: 'رقم الهاتف غير صحيح. أدخل رقم محمول مصريًا من 11 رقمًا يبدأ بـ 010 أو 011 أو 012 أو 015.',
      email: 'البريد الإلكتروني', emailNote: 'مؤكَّد من خلال هذه الدعوة',
      next: 'متابعة', back: 'رجوع',
      pass: 'كلمة المرور', pass2: 'تأكيد كلمة المرور', passHint: '8 أحرف على الأقل', pass2Ph: 'أعد كتابة كلمة المرور',
      passShort: 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.', passMismatch: 'كلمتا المرور غير متطابقتين.',
      strength: ['ضعيفة', 'مقبولة', 'جيدة', 'قوية'], show: 'إظهار كلمة المرور', hide: 'إخفاء كلمة المرور',
      photoTitle: 'أضف صورتك الشخصية', photoSub: 'تظهر لزملائك بجانب اسمك في التعليقات والمهام. الصورة مطلوبة لإكمال إنشاء الحساب.',
      upload: 'رفع صورة', change: 'تغيير الصورة', uploading: 'جارٍ رفع الصورة…', photoBad: 'استخدم صورة JPEG أو PNG أو WebP واضحة.',
      photoNeeded: 'ارفع صورتك الشخصية لإكمال إنشاء الحساب.',
      create: 'إنشاء الحساب', creating: 'جارٍ إنشاء الحساب…',
      doneTitle: 'تم إنشاء حسابك بنجاح',
      doneSub: (u) => `يمكنك الآن الدخول باسم المستخدم ${u} وكلمة المرور التي اخترتها.`,
      doneMail: 'أرسلنا رسالة تأكيد إلى بريدك الإلكتروني.',
      login: 'الدخول إلى حسابي', toLogin: 'الذهاب إلى صفحة الدخول',
      nameShort: 'أدخل اسمك الكامل.', network: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.',
      secure: 'اتصال آمن', invalid: 'رابط الدعوة غير صحيح.',
      errTitle: { INVITE_EXPIRED: 'انتهت صلاحية الدعوة', INVITE_USED: 'استُخدمت هذه الدعوة', INVITE_CANCELLED: 'أُلغيت الدعوة', INVITE_INVALID: 'رابط غير صحيح', NETWORK: 'تعذّر الاتصال' },
      retry: 'إعادة المحاولة',
    },
    en: {
      title: 'Welcome to SOULIA',
      sub: (by, role) => `${by} invited you to join as ${role}. Complete your details to create your account.`,
      subNoBy: (role) => `You were invited to join as ${role}. Complete your details to create your account.`,
      steps: ['Your details', 'Password', 'Your photo'],
      name: 'Full name', namePh: 'Your name as colleagues see it',
      user: 'Username', userHint: 'English letters and numbers only; used to sign in. Suggested from your name — you can change it.',
      userOk: 'Username is available', checking: 'Checking…',
      phone: 'Phone number', phonePh: '01xxxxxxxxx', phoneBad: 'Invalid phone number. Enter an 11-digit Egyptian mobile starting with 010, 011, 012 or 015.',
      email: 'Email', emailNote: 'Confirmed by this invitation',
      next: 'Continue', back: 'Back',
      pass: 'Password', pass2: 'Confirm password', passHint: 'At least 8 characters', pass2Ph: 'Type the password again',
      passShort: 'The password must be at least 8 characters.', passMismatch: 'The passwords do not match.',
      strength: ['Weak', 'Fair', 'Good', 'Strong'], show: 'Show password', hide: 'Hide password',
      photoTitle: 'Add your profile photo', photoSub: 'Shown to colleagues next to your name in comments and tasks. A photo is required to finish.',
      upload: 'Upload photo', change: 'Change photo', uploading: 'Uploading…', photoBad: 'Use a clear JPEG, PNG or WebP photo.',
      photoNeeded: 'Upload your profile photo to finish creating the account.',
      create: 'Create account', creating: 'Creating your account…',
      doneTitle: 'Your account has been created',
      doneSub: (u) => `You can now sign in with the username ${u} and the password you chose.`,
      doneMail: 'We sent a confirmation to your email.',
      login: 'Sign in to my account', toLogin: 'Go to sign-in',
      nameShort: 'Enter your full name.', network: 'Could not reach the server. Check your connection and try again.',
      secure: 'Secure connection', invalid: 'This invitation link is not valid.',
      errTitle: { INVITE_EXPIRED: 'Invitation expired', INVITE_USED: 'Invitation already used', INVITE_CANCELLED: 'Invitation cancelled', INVITE_INVALID: 'Invalid link', NETWORK: 'Connection problem' },
      retry: 'Try again',
      errMsg: {
        INVITE_EXPIRED: 'This invitation has expired. Ask your system administrator to send a new one.',
        INVITE_USED: 'This invitation was already used. Sign in with the username you chose.',
        INVITE_CANCELLED: 'This invitation was cancelled.',
        INVITE_INVALID: 'This invitation link is not valid.',
      },
    },
  };
  // Server messages are Arabic; English maps the known ones by code.
  const EN_BY_CODE = {
    USERNAME_TAKEN: 'This username is already taken. Choose another.',
    USERNAME_INVALID: 'Username: 3–30 lowercase English letters, digits, «.» or «_», starting with a letter.',
    PHONE_INVALID: 'Invalid phone number. Enter an 11-digit Egyptian mobile starting with 010, 011, 012 or 015.',
    NAME_INVALID: 'Enter your full name.', PASSWORD_WEAK: 'The password must be at least 8 characters.',
    PASSWORD_MISMATCH: 'The passwords do not match.', PHOTO_REQUIRED: 'Upload your profile photo to finish creating the account.',
    EMAIL_TAKEN: 'This email is now linked to another account. Contact your system administrator.',
    ROLE_GONE: 'The role in this invitation no longer exists. Ask for a new invitation.',
    INVITE_BUSY: 'The account is already being created from this invitation. Refresh in a moment.',
  };
  const t = () => T[lang];
  const msgOf = (e) => (lang === 'en' && (EN_BY_CODE[e.code] || T.en.errMsg?.[e.code])) || e.message || t().network;

  const token = (location.pathname.match(/\/join\/([A-Za-z0-9_-]{24})\/?$/) || [])[1]
    || new URLSearchParams(location.search).get('t') || '';
  const S = { info: null, error: null, step: 1, name: '', username: '', userEdited: false, userState: null, phone: '',
    pass: '', pass2: '', photoUrl: '', busy: false, done: null, err: {} };

  async function call(path, opts) {
    let res;
    try { res = await fetch('/api/join/' + encodeURIComponent(token) + path, opts); }
    catch { throw { code: 'NETWORK', message: t().network }; }
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw { status: res.status, code: body?.code || '', message: body?.message || t().network, field: body?.field };
    return body;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toLatin = (s) => String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  function cleanPhone(raw) {
    let d = toLatin(raw).replace(/[\s\-().]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    if (d.startsWith('0020')) d = d.slice(4);
    if (/^20\d{10}$/.test(d)) d = d.slice(2);
    if (/^1[0125]\d{8}$/.test(d)) d = '0' + d;
    return /^01[0125]\d{8}$/.test(d) ? d : '';
  }
  function strength(p) {
    if (!p) return -1;
    let s = 0;
    if (p.length >= 8) s++;
    if (p.length >= 12) s++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
    if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
    return Math.max(0, Math.min(3, s - (p.length < 8 ? 1 : 0)));
  }

  const ICON = {
    eye: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    camera: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    upload: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };

  function head() {
    const i = S.info;
    const sub = i.invitedBy ? t().sub(`<b>${esc(i.invitedBy)}</b>`, `<b>${esc(i.roleName)}</b>`) : t().subNoBy(`<b>${esc(i.roleName)}</b>`);
    return `<header class="jn-head"><img class="jn-logo" src="/soulia-logo.svg" alt="SOULIA" width="44" height="44"><h1>${esc(t().title)}</h1><p>${sub}</p></header>
      <ol class="jn-steps" aria-label="${esc(t().steps.join(' · '))}">${t().steps.map((s, k) => `<li class="${k + 1 < S.step ? 'is-done' : k + 1 === S.step ? 'is-on' : ''}" ${k + 1 === S.step ? 'aria-current="step"' : ''}><span>${k + 1 < S.step ? ICON.check : k + 1}</span>${esc(s)}</li>`).join('')}</ol>`;
  }
  const errLine = (k) => `<p class="jn-err" id="jn-err-${k}" role="alert"${S.err[k] ? '' : ' hidden'}>${esc(S.err[k] || '')}</p>`;

  function step1() {
    const u = S.userState;
    const userNote = u?.checking ? `<span class="jn-note">${esc(t().checking)}</span>`
      : u?.available ? `<span class="jn-note is-ok">${ICON.check}${esc(t().userOk)}</span>` : '';
    return `<form class="jn-form" id="jn-f1" novalidate>
      <label class="jn-field"><span>${esc(t().name)}</span><input id="jn-name" autocomplete="name" maxlength="60" placeholder="${esc(t().namePh)}" value="${esc(S.name)}">${errLine('name')}</label>
      <label class="jn-field"><span>${esc(t().user)} ${userNote}</span><input id="jn-user" dir="ltr" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="30" value="${esc(S.username)}"><small>${esc(t().userHint)}</small>${errLine('username')}</label>
      <label class="jn-field"><span>${esc(t().phone)}</span><input id="jn-phone" type="tel" dir="ltr" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="${esc(t().phonePh)}" value="${esc(S.phone)}">${errLine('phone')}</label>
      <label class="jn-field"><span>${esc(t().email)}</span><div class="jn-locked"><input dir="ltr" value="${esc(S.info.email)}" readonly aria-readonly="true"><i>${ICON.lock}</i></div><small class="is-ok">${ICON.check}${esc(t().emailNote)}</small></label>
      ${errLine('form')}
      <button class="jn-btn" type="submit">${esc(t().next)}</button>
    </form>`;
  }

  function passField(id, label, value, ph, auto) {
    return `<label class="jn-field"><span>${esc(label)}</span><div class="jn-pass"><input id="${id}" type="password" dir="ltr" autocomplete="${auto}" maxlength="200" placeholder="${esc(ph)}" value="${esc(value)}"><button type="button" class="jn-eye" data-eye="${id}" aria-label="${esc(t().show)}">${ICON.eye}</button></div>`;
  }
  function step2() {
    const s = strength(S.pass);
    return `<form class="jn-form" id="jn-f2" novalidate>
      <input type="text" autocomplete="username" value="${esc(S.username)}" hidden>
      ${passField('jn-pass', t().pass, S.pass, t().passHint, 'new-password')}
        <div class="jn-meter" data-s="${s}" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <small id="jn-meter-label">${s >= 0 ? esc(t().strength[s]) + ' · ' : ''}${esc(t().passHint)}</small>${errLine('password')}</label>
      ${passField('jn-pass2', t().pass2, S.pass2, t().pass2Ph, 'new-password')}${errLine('confirmPassword')}</label>
      <div class="jn-row"><button class="jn-btn is-ghost" type="button" data-back>${esc(t().back)}</button><button class="jn-btn" type="submit">${esc(t().next)}</button></div>
    </form>`;
  }
  function step3() {
    const busy = S.busy === 'photo';
    return `<div class="jn-form">
      <div class="jn-photo">
        <button type="button" class="jn-avatar${S.photoUrl ? ' has-img' : ''}" data-pick aria-label="${esc(S.photoUrl ? t().change : t().upload)}">
          ${S.photoUrl ? `<img src="${esc(S.photoUrl)}" alt="">` : ICON.camera}${busy ? '<span class="jn-spin"></span>' : ''}
        </button>
        <h2>${esc(t().photoTitle)}</h2>
        <p>${esc(t().photoSub)}</p>
        <button type="button" class="jn-btn is-ghost is-sm" data-pick ${busy ? 'disabled' : ''}>${ICON.upload}${esc(busy ? t().uploading : S.photoUrl ? t().change : t().upload)}</button>
        <input type="file" id="jn-file" accept="image/jpeg,image/png,image/webp" hidden>
        ${errLine('photo')}
      </div>
      ${errLine('form')}
      <div class="jn-row"><button class="jn-btn is-ghost" type="button" data-back>${esc(t().back)}</button>
      <button class="jn-btn" type="button" id="jn-create" ${!S.photoUrl || S.busy ? 'disabled' : ''}>${S.busy === 'create' ? '<span class="jn-spin is-light"></span>' + esc(t().creating) : esc(t().create)}</button></div>
    </div>`;
  }
  function done() {
    return `<div class="jn-done"><div class="jn-done-ic">${S.photoUrl ? `<img src="${esc(S.photoUrl)}" alt="">` : ''}<span>${ICON.check}</span></div>
      <h1>${esc(t().doneTitle)}</h1>
      <p>${t().doneSub(`<bdi class="jn-code">${esc(S.done.username)}</bdi>`)}</p>
      <p class="jn-muted">${esc(t().doneMail)}</p>
      <button class="jn-btn" type="button" id="jn-login">${esc(t().login)}</button></div>`;
  }
  function failure() {
    const code = S.error.code || 'INVITE_INVALID';
    const title = t().errTitle[code] || t().errTitle.INVITE_INVALID;
    return `<div class="jn-done is-err"><div class="jn-err-ic">${ICON.warn}</div><h1>${esc(title)}</h1><p>${esc(msgOf(S.error))}</p>
      ${code === 'INVITE_USED' ? `<button class="jn-btn" type="button" id="jn-login">${esc(t().toLogin)}</button>` : ''}
      ${code === 'NETWORK' ? `<button class="jn-btn" type="button" id="jn-retry">${esc(t().retry)}</button>` : ''}</div>`;
  }

  function render(focusSel) {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = (lang === 'ar' ? 'إنشاء حسابك' : 'Create your account') + ' · SOULIA';
    document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    const card = $('#jn-card');
    if (S.error) card.innerHTML = failure();
    else if (!S.info) card.innerHTML = '<div class="jn-loading"><span class="jn-spin"></span></div>';
    else if (S.done) card.innerHTML = done();
    else card.innerHTML = head() + (S.step === 1 ? step1() : S.step === 2 ? step2() : step3()) + `<p class="jn-secure">${ICON.lock}${esc(t().secure)}</p>`;
    // Animate only when the view changes (a new step / result), never on a redraw of the same step.
    const key = S.error ? 'err:' + S.error.code : S.done ? 'done' : S.info ? 'step' + S.step : 'load';
    if (key !== lastKey) { lastKey = key; card.classList.remove('is-in'); void card.offsetWidth; card.classList.add('is-in'); }
    bind();
    const f = focusSel && $(focusSel);
    if (f) f.focus();
  }

  function setErr(k, msg) {
    S.err[k] = msg || '';
    const el = $('#jn-err-' + k);
    if (el) { el.textContent = S.err[k]; el.hidden = !S.err[k]; }
    const input = { name: '#jn-name', username: '#jn-user', phone: '#jn-phone', password: '#jn-pass', confirmPassword: '#jn-pass2' }[k];
    if (input && $(input)) $(input).setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  let nameTimer = 0; let userTimer = 0; let userSeq = 0; let lastKey = '';
  async function checkUsername(opts = {}) {
    const seq = ++userSeq;
    S.userState = { checking: true };
    paintUserNote();
    try {
      const r = await call(`/username?name=${encodeURIComponent(S.name)}&username=${encodeURIComponent(opts.suggestOnly ? '' : S.username)}`);
      if (seq !== userSeq) return null;
      if (opts.suggestOnly && !S.userEdited && r.suggestion) {
        S.username = r.suggestion;
        const u = $('#jn-user'); if (u) u.value = r.suggestion;
        S.userState = { available: true };
        setErr('username', '');
      } else if (!opts.suggestOnly) {
        S.userState = r.available ? { available: true } : null;
        setErr('username', r.available ? '' : (lang === 'en' ? EN_BY_CODE[r.problem?.includes('مستخدم بالفعل') ? 'USERNAME_TAKEN' : 'USERNAME_INVALID'] : r.problem));
      } else S.userState = null;
      paintUserNote();
      return r;
    } catch (e) {
      if (seq === userSeq) { S.userState = null; paintUserNote(); }
      if (e.code?.startsWith('INVITE_')) { S.error = e; render(); }
      return null;
    }
  }
  function paintUserNote() {
    const label = $('#jn-user')?.closest('.jn-field')?.querySelector('span');
    if (!label) return;
    const u = S.userState;
    label.innerHTML = esc(t().user) + ' ' + (u?.checking ? `<span class="jn-note">${esc(t().checking)}</span>` : u?.available ? `<span class="jn-note is-ok">${ICON.check}${esc(t().userOk)}</span>` : '');
  }

  // Shrinks a photo in the browser before upload (the server crops and compresses it again).
  function shrink(file) {
    return new Promise((resolve) => {
      if (!/^image\//.test(file.type)) return resolve(file);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1024; const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => resolve(b || file), 'image/jpeg', 0.88);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  async function uploadPhoto(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { setErr('photo', t().photoBad); return; }
    S.busy = 'photo'; setErr('photo', ''); render();
    try {
      const fd = new FormData();
      fd.append('file', await shrink(file), 'photo.jpg');
      const r = await call('/photo', { method: 'POST', body: fd });
      S.photoUrl = r.url;
    } catch (e) {
      if (e.code?.startsWith('INVITE_')) { S.busy = false; S.error = e; return render(); }
      S.err.photo = e.status === 400 ? t().photoBad : msgOf(e);
    }
    S.busy = false; render();
  }

  async function create() {
    if (!S.photoUrl) { setErr('photo', t().photoNeeded); return; }
    S.busy = 'create'; S.err.form = ''; render();
    try {
      const r = await call('/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: S.name, username: S.username, phone: S.phone, password: S.pass, confirmPassword: S.pass2 }) });
      S.busy = false; S.done = r; render('#jn-login');
    } catch (e) {
      S.busy = false;
      if (e.code?.startsWith('INVITE_') && e.code !== 'INVITE_BUSY') { S.error = e; return render(); }
      const field = e.field;
      const stepOf = { name: 1, username: 1, phone: 1, password: 2, confirmPassword: 2, photo: 3 };
      if (field && stepOf[field]) {
        S.step = stepOf[field]; S.err = { [field]: msgOf(e) }; if (field === 'username') S.userState = null;
        render({ name: '#jn-name', username: '#jn-user', phone: '#jn-phone', password: '#jn-pass', confirmPassword: '#jn-pass2' }[field]);
      } else { S.err.form = msgOf(e); render(); }
    }
  }

  function bind() {
    const card = $('#jn-card');
    card.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => { S.step -= 1; S.err = {}; render(); }));
    $('#jn-retry')?.addEventListener('click', () => { S.error = null; render(); start(); });
    $('#jn-login')?.addEventListener('click', () => {
      // The sign-in page reads this to fill the username.
      try { if (S.done?.username) localStorage.setItem('rem_user', S.done.username); } catch { /* ignore */ }
      location.href = '/';
    });
    const f1 = $('#jn-f1');
    if (f1) {
      $('#jn-name').addEventListener('input', (e) => {
        S.name = e.target.value; setErr('name', '');
        clearTimeout(nameTimer);
        if (!S.userEdited && S.name.trim().length >= 3) nameTimer = setTimeout(() => checkUsername({ suggestOnly: true }), 400);
      });
      $('#jn-user').addEventListener('input', (e) => {
        const v = e.target.value.toLowerCase().replace(/\s+/g, '');
        if (v !== e.target.value) e.target.value = v;
        S.username = v; S.userEdited = !!v; S.userState = null; setErr('username', ''); paintUserNote();
        clearTimeout(userTimer);
        if (v.length >= 3) userTimer = setTimeout(() => checkUsername(), 450);
      });
      $('#jn-phone').addEventListener('input', (e) => { S.phone = e.target.value; setErr('phone', ''); });
      $('#jn-phone').addEventListener('blur', (e) => { const p = cleanPhone(e.target.value); if (p) { S.phone = p; e.target.value = p; } });
      f1.addEventListener('submit', async (e) => {
        e.preventDefault();
        let bad = '';
        if (S.name.trim().length < 3) { setErr('name', t().nameShort); bad = bad || '#jn-name'; }
        const p = cleanPhone(S.phone);
        if (!p) { setErr('phone', t().phoneBad); bad = bad || '#jn-phone'; } else S.phone = p;
        if (!S.username) { const r = await checkUsername({ suggestOnly: true }); if (!r) bad = bad || '#jn-user'; }
        if (S.username && !S.userState?.available) {
          const r = await checkUsername();
          if (!r?.available) bad = bad || '#jn-user';
        }
        if (bad) { $(bad)?.focus(); return; }
        S.step = 2; S.err = {}; render('#jn-pass');
      });
    }
    const f2 = $('#jn-f2');
    if (f2) {
      $('#jn-pass').addEventListener('input', (e) => {
        S.pass = e.target.value; setErr('password', '');
        const s = strength(S.pass);
        $('.jn-meter').dataset.s = s;
        $('#jn-meter-label').textContent = (s >= 0 ? t().strength[s] + ' · ' : '') + t().passHint;
      });
      $('#jn-pass2').addEventListener('input', (e) => { S.pass2 = e.target.value; setErr('confirmPassword', ''); });
      f2.addEventListener('submit', (e) => {
        e.preventDefault();
        if (S.pass.length < 8) { setErr('password', t().passShort); $('#jn-pass').focus(); return; }
        if (S.pass !== S.pass2) { setErr('confirmPassword', t().passMismatch); $('#jn-pass2').focus(); return; }
        S.step = 3; S.err = {}; render();
      });
    }
    card.querySelectorAll('[data-eye]').forEach((b) => b.addEventListener('click', () => {
      const input = $('#' + b.dataset.eye); const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.innerHTML = show ? ICON.eyeOff : ICON.eye;
      b.setAttribute('aria-label', show ? t().hide : t().show);
    }));
    const file = $('#jn-file');
    if (file) {
      card.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { if (!S.busy) file.click(); }));
      file.addEventListener('change', () => uploadPhoto(file.files?.[0]));
      $('#jn-create')?.addEventListener('click', create);
    }
  }

  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    lang = b.dataset.lang; try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
    render();
  }));

  async function start() {
    if (!/^[A-Za-z0-9_-]{24}$/.test(token)) { S.error = { code: 'INVITE_INVALID', message: T.ar.invalid }; return render(); }
    try {
      S.info = await call('');
      if (S.info.photoUrl) S.photoUrl = S.info.photoUrl;
    } catch (e) { S.error = e.code ? e : { code: 'NETWORK', message: t().network }; }
    render('#jn-name');
  }
  start();
})();
