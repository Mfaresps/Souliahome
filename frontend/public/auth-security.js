/* Sign-in verification + account security («التحقق من الجهاز الجديد», Nov 27, 2026).
   Server: backend/src/auth/sign-in-verification.service.ts — rules in auth-security.util.ts.

   - A right password on an account that needs a second step returns a CHALLENGE (never a
     token). This screen finishes it with ONE of: Google Authenticator · a code sent to the
     account's security email · approval from one of its trusted devices · a backup code.
   - «الوثوق بهذا الجهاز لمدة 30 يومًا» (trusted device) stores a random token per account name
     (localStorage `soulia_dt:<username>`); only its hash is on the server.
   - Forgot password (admin accounts): username → the factors the account has (email AND
     Google when both exist) → new password. Every session and trusted device then ends.
   - Trusted devices show «طلب دخول إلى حسابك» (socket `auth:login-approval` or a push) and
     approve by picking the number shown on the new device.
   - Settings ← الأمان: Google Authenticator, backup codes, security email (admins), devices.
   ⚠ Wrong codes are 401s: api() keeps the session for /auth/challenge|security|totp|… unless
     the code is SESSION_ENDED (index.html _apiRequest). */
(function () {
  'use strict';
  // Before sign-in: the login page's language (loginLang); signed in: the app's (currentLang).
  const L = () => ((typeof currentUser !== 'undefined' && currentUser) ? (typeof currentLang !== 'undefined' && currentLang === 'en' ? 'en' : 'ar') : loginLang());
  const T = (ar, en) => (L() === 'en' ? en : ar);
  const E = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const loc = () => (L() === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn');
  const fmtDate = (iso, time = true) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(loc(), { day: 'numeric', month: 'short', year: 'numeric', ...(time ? { hour: 'numeric', minute: '2-digit' } : {}) });
  };
  const digits = (v) => String(v || '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/\D/g, '');
  const toastMsg = (m, err) => { if (typeof toast === 'function') toast(m, err); };

  const ICON = {
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    app: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/><path d="M12 7v4l2.5 1.5"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6 8.5-6"/></svg>',
    device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="13" height="10" rx="1.5"/><path d="M6 18h6M9 14v4"/><rect x="17" y="8" width="4.5" height="10" rx="1"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  };

  // ── Device token ────────────────────────────────────────────────────────────
  const DT = 'soulia_dt:';
  const dtKey = (u) => DT + String(u || '').trim().toLowerCase();
  function deviceTokenFor(username) {
    const u = String(username || '').trim();
    // Pre-Nov-27 keys are sent once; the server converts them and returns a new token.
    return localStorage.getItem(dtKey(u)) || localStorage.getItem('device_token_' + u) || localStorage.getItem('device_token') || '';
  }
  function saveDeviceToken(username, token) {
    const u = String(username || '').trim();
    if (!u || !/^[a-f0-9]{64}$/.test(String(token || ''))) return;
    localStorage.setItem(dtKey(u), token);
    localStorage.removeItem('device_token_' + u);
    localStorage.removeItem('device_token');
  }
  function forgetDeviceToken(username) { localStorage.removeItem(dtKey(username)); }
  function currentDeviceToken() {
    const u = typeof currentUser !== 'undefined' && currentUser ? currentUser.username : '';
    return u ? (localStorage.getItem(dtKey(u)) || '') : '';
  }
  const devHeaders = () => { const t = currentDeviceToken(); return t ? { 'X-Device-Token': t } : {}; };

  // ── Login-page language («عربي | English», Nov 27, 2026) ─────────────────────
  // Before sign-in the page, the verification card, «نسيت كلمة المرور» and the backup codes follow
  // the language picked on the login page (localStorage soulia_login_lang); once signed in, the app's
  // own language (currentLang). The app's language preference is not touched by this switch.
  const LOGIN_LANG_KEY = 'soulia_login_lang';
  function loginLang() {
    const saved = localStorage.getItem(LOGIN_LANG_KEY);
    if (saved === 'ar' || saved === 'en') return saved;
    const app = localStorage.getItem('soulia_lang_pref');
    if (app === 'ar' || app === 'en') return app;
    return /^ar/i.test(navigator.language || '') ? 'ar' : 'en';
  }
  const LOGIN_TEXT = {
    title: ['مرحبًا بعودتك', 'Welcome back'],
    sub: ['الدخول مقصور على المصرّح لهم فقط', 'Authorized access only'],
    user: ['اسم المستخدم', 'Username'],
    userPh: ['أدخل اسم المستخدم', 'Enter your username'],
    pass: ['كلمة المرور', 'Password'],
    passPh: ['أدخل كلمة المرور', 'Enter your password'],
    show: ['إظهار كلمة المرور', 'Show password'],
    hide: ['إخفاء كلمة المرور', 'Hide password'],
    caps: ['مفتاح الأحرف الكبيرة (Caps Lock) مفعّل', 'Caps Lock is active'],
    remember: ['تذكّرني', 'Remember me'],
    saved: ['محفوظ', 'Saved'],
    signIn: ['تسجيل دخول آمن', 'Secure Sign In'],
    signingIn: ['جارٍ تسجيل الدخول…', 'Signing in…'],
    forgot: ['نسيت كلمة المرور؟', 'Forgot password?'],
    userRequired: ['أدخل اسم المستخدم.', 'Enter your username.'],
    passRequired: ['أدخل كلمة المرور.', 'Enter your password.'],
    checking: ['جارٍ التحقق من أنك لست برنامجًا آليًا…', 'Checking you’re not a robot…'],
    captchaFailed: ['تعذّر إكمال التحقق من أنك لست برنامجًا آليًا. تحقّق من الاتصال بالإنترنت، ثم أعد المحاولة.', 'The robot check could not be completed. Check your internet connection and try again.'],
    unlock: ['فتح القفل برمز التحقق', 'Unlock with a verification code'],
    unlocked: ['تم فتح القفل عن هذا الجهاز. سجّل الدخول بكلمة المرور.', 'This device is unlocked. Sign in with your password.'],
    kicker: ['إدارة العمليات التجارية', 'BUSINESS OPERATIONS'],
    story: ['أدِر أعمالك<br>من مكان واحد.', 'Run your business.<br>All in one place.'],
    storySub: ['الطلبات والمخزون والحسابات وفريق العمل في مساحة عمل واحدة.', 'Orders, inventory, finance and your team — in one workspace.'],
  };
  function loginText(key) {
    const v = LOGIN_TEXT[key];
    return v ? v[loginLang() === 'en' ? 1 : 0] : key;
  }
  /** Server sign-in errors are Arabic; the English login page states them in English. */
  function loginError(msg) {
    const m = String(msg || '');
    if (loginLang() !== 'en' || m.includes('🔒')) return m;
    if (/بيانات الدخول غير صحيحة/.test(m)) return 'Incorrect sign-in details.';
    if (/تم حظر محاولات تسجيل الدخول/.test(m)) return 'Sign-in attempts from this device are blocked after repeated failures. Contact your administrator or unlock with a verification code.';
    let y = /تم إيقاف محاولات تسجيل الدخول من هذا الجهاز مؤقتًا.*?بعد (\d+) دقيقة/.exec(m);
    if (y) return `Sign-in attempts from this device are paused. Try again in ${y[1]} minutes.`;
    if (/عدد كبير من المحاولات/.test(m)) return 'Too many attempts from this device. Try again in a minute.';
    if (/يلزم التحقق من أنك لست برنامجًا آليًا/.test(m)) return 'Please confirm you’re not a robot.';
    if (/أُرسل طلب إلى مدير النظام لإلغاء القفل/.test(m)) return 'A request to lift the lock was sent to your administrator. Try again once they approve it or after the lock ends.';
    if (/لا تتوفر وسيلة لفك القفل/.test(m)) return 'No unlock method is available here. Wait for the lock to end or contact your administrator.';
    if (/اسم المستخدم أو كلمة المرور غير صحيحة/.test(m)) return 'Incorrect username or password.';
    let x = /كلمة المرور غير صحيحة.*?(\d+)/.exec(m);
    if (x) return `Incorrect password. ${x[1]} attempt${x[1] === '1' ? '' : 's'} left before sign-in is paused.`;
    x = /بعد (\d+) دقيقة/.exec(m);
    if (x) return `Sign-in to this account is temporarily paused after repeated failed attempts. Try again in ${x[1]} minutes.`;
    if (/الخادم غير متاح/.test(m)) return 'The server is unavailable. Please try again shortly.';
    return m;
  }
  function applyLoginLang(lang) {
    if (lang) localStorage.setItem(LOGIN_LANG_KEY, lang);
    const l = loginLang();
    const page = document.getElementById('login-page');
    if (!page) return;
    page.setAttribute('dir', l === 'en' ? 'ltr' : 'rtl');
    page.setAttribute('lang', l);
    // ⚠ index.html used to set the form's own dir from the APP language — an English page then read right to left.
    page.querySelector('#login-form')?.removeAttribute('dir');
    const set = (sel, key, attr) => { const el = page.querySelector(sel); if (!el) return; if (attr) el.setAttribute(attr, loginText(key)); else el.textContent = loginText(key); };
    set('.lfp-title', 'title'); set('.lfp-sub', 'sub');
    set('label[for="login-user"]', 'user'); set('#login-user', 'userPh', 'placeholder');
    set('label[for="login-pass"]', 'pass'); set('#login-pass', 'passPh', 'placeholder');
    const tg = page.querySelector('#login-pass-toggle');
    if (tg) { const k = tg.getAttribute('aria-pressed') === 'true' ? 'hide' : 'show'; tg.setAttribute('aria-label', loginText(k)); tg.title = loginText(k); }
    set('#login-caps-warning', 'caps'); set('.lfp-remember > span:last-child', 'remember');
    set('#login-saved-badge > span', 'saved'); set('.lfp-forgot span', 'forgot');
    const btn = page.querySelector('.lfp-btn-login');
    const label = page.querySelector('#login-submit-label');
    if (label) label.textContent = loginText(btn && btn.getAttribute('aria-busy') === 'true' ? 'signingIn' : 'signIn');
    const story = page.querySelector('.startup-login-story');
    if (story) {
      const k = story.querySelector('.startup-login-kicker'), h = story.querySelector('h2'), p = story.querySelector('p');
      [k, h, p].forEach((el) => el && el.setAttribute('lang', l));
      if (k) k.textContent = loginText('kicker');
      if (h) h.innerHTML = loginText('story');
      if (p) p.textContent = loginText('storySub');
    }
    page.querySelectorAll('.lfp-lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === l)));
    if (ov && !V?.busy && V && !userSignedIn()) renderVerify();
  }
  function initLoginLang() {
    const panel = document.getElementById('login-form-panel');
    if (panel && !panel.querySelector('.lfp-lang')) {
      const sw = document.createElement('div');
      sw.className = 'lfp-lang';
      sw.setAttribute('role', 'group');
      sw.setAttribute('aria-label', 'Language / اللغة');
      sw.innerHTML = '<button type="button" data-lang="ar" lang="ar">العربية</button><button type="button" data-lang="en" lang="en">English</button>';
      sw.addEventListener('click', (e) => { const b = e.target.closest('button[data-lang]'); if (b) applyLoginLang(b.dataset.lang); });
      panel.prepend(sw);
    }
    applyLoginLang();
  }
  const userSignedIn = () => typeof currentUser !== 'undefined' && !!currentUser;

  // ── Shared overlay ──────────────────────────────────────────────────────────
  const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  let ov = null;
  /** One centred card; `opts.secure` adds «اتصال آمن» under it. Before sign-in it is a full page. */
  function openOverlay(id, html, onEsc, opts = {}) {
    closeOverlay();
    ov = document.createElement('div');
    ov.id = id;
    ov.className = 'sv-ov' + (userSignedIn() ? '' : ' is-page');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.dir = L() === 'en' ? 'ltr' : 'rtl';
    ov.lang = L();
    const secure = opts.secure === false || userSignedIn() ? '' : `<div class="sv-secure">${LOCK}<span>${E(T('اتصال آمن', 'Secure connection'))}</span></div>`;
    ov.innerHTML = `<div class="sv-stack"><div class="sv-card">${html}</div>${secure}</div>`;
    ov._esc = (e) => { if (e.key === 'Escape' && onEsc) { e.preventDefault(); e.stopPropagation(); onEsc(); } };
    document.addEventListener('keydown', ov._esc, true);
    document.body.appendChild(ov);
    return ov;
  }
  function closeOverlay() {
    if (!ov) return;
    document.removeEventListener('keydown', ov._esc, true);
    ov.remove();
    ov = null;
  }
  // The login page's own logo (a custom uploaded logo when Settings has one — branding.js).
  const brandHtml = () => {
    const src = document.querySelector('#login-form-panel .lfp-logo')?.getAttribute('src') || '/soulia-startup-flat.svg';
    return `<div class="sv-brand"><img src="${E(src)}" alt="SOULIA" draggable="false"></div>`;
  };
  /** Card head: logo, title, optional one-line description. */
  const headHtml = (title, sub) => `${brandHtml()}<h2 class="sv-title">${E(title)}</h2>${sub ? `<p class="sv-sub">${sub}</p>` : ''}`;
  const btnHtml = (act, label, attrs = '') => `<button type="button" class="sv-btn is-primary is-wide" ${act ? `data-act="${act}"` : ''} ${attrs}><span class="sv-btn-spin" aria-hidden="true"></span><span class="sv-btn-txt">${E(label)}</span></button>`;

  // ── Six-box code entry ──────────────────────────────────────────────────────
  // One box per digit: typing moves forward, Backspace back, a pasted or autofilled code is spread
  // over the boxes. Arabic-Indic digits are accepted. `onDone` runs when the sixth digit lands.
  function otpHtml(id) {
    const boxes = [0, 1, 2, 3, 4, 5].map((i) => `<input class="sv-otp-box" type="text" inputmode="numeric" maxlength="6" ${i === 0 ? 'autocomplete="one-time-code"' : 'autocomplete="off"'} aria-label="${E(T(`الرقم ${i + 1} من 6`, `Digit ${i + 1} of 6`))}">`).join('');
    return `<div class="sv-otp" id="${id}" dir="ltr" role="group" aria-label="${E(T('رمز التحقق', 'Verification code'))}">${boxes}</div>`;
  }
  function otpBoxes(root) { return root ? [...root.querySelectorAll('.sv-otp-box')] : []; }
  function otpValue(root) { return otpBoxes(root).map((b) => b.value).join(''); }
  function otpClear(root, shake) {
    const boxes = otpBoxes(root);
    boxes.forEach((b) => { b.value = ''; b.classList.remove('is-filled'); });
    if (shake && root) { root.classList.remove('is-error'); void root.offsetWidth; root.classList.add('is-error'); }
    if (boxes[0]) boxes[0].focus();
  }
  function otpBind(root, onDone) {
    const boxes = otpBoxes(root);
    const mark = () => boxes.forEach((b) => b.classList.toggle('is-filled', !!b.value));
    const spread = (from, text) => {
      let i = from;
      for (const ch of text) { if (i > 5) break; boxes[i].value = ch; i++; }
      mark();
      (boxes[Math.min(i, 5)] || boxes[5]).focus();
      if (otpValue(root).length === 6) onDone();
    };
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => {
        root.classList.remove('is-error');
        setErr('');
        const v = digits(b.value);
        if (v.length > 1) { b.value = ''; spread(i, v); return; }
        b.value = v;
        mark();
        if (v && i < 5) boxes[i + 1].focus();
        if (otpValue(root).length === 6) onDone();
      });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !b.value && i > 0) { e.preventDefault(); boxes[i - 1].value = ''; boxes[i - 1].focus(); mark(); }
        else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); boxes[i - 1].focus(); }
        else if (e.key === 'ArrowRight' && i < 5) { e.preventDefault(); boxes[i + 1].focus(); }
        else if (e.key === 'Enter') { e.preventDefault(); onDone(true); }
      });
      b.addEventListener('paste', (e) => {
        const text = digits((e.clipboardData || window.clipboardData)?.getData('text') || '');
        if (!text) return;
        e.preventDefault();
        boxes.forEach((x) => { x.value = ''; });
        spread(0, text.slice(0, 6));
      });
      b.addEventListener('focus', () => { try { b.select(); } catch (_) {} });
    });
  }
  const codeInput = (id, opts = {}) => `<input id="${id}" class="sv-input sv-backup-input" type="text" maxlength="12" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="xxxx-xxxx" dir="ltr" aria-label="${E(opts.label || T('رمز احتياطي', 'Backup code'))}">`;

  /** Error text in the card's language (the server writes Arabic; English is mapped by code). */
  function errText(e) {
    if (!e) return T('حدث خطأ غير متوقع. حاول مرة أخرى.', 'Something went wrong. Try again.');
    if (L() === 'ar') return e.message || T('حدث خطأ غير متوقع. حاول مرة أخرى.', '');
    const d = e.details || {};
    const map = {
      CODE_WRONG: `Incorrect code. Attempts remaining: ${d.attemptsLeft ?? ''}.`.replace(' .', '.'),
      CHALLENGE_INVALID: 'Your verification session has ended. Sign in again.',
      CHALLENGE_EXPIRED: 'Verification timed out. Sign in again.',
      CHALLENGE_LOCKED: 'This attempt was stopped after too many incorrect codes. Sign in again.',
      CHALLENGE_USED: 'This verification was already used. Sign in again.',
      EMAIL_RATE_LIMITED: d.waitSec ? `You can request a new code in ${d.waitSec} seconds.` : 'Too many codes were requested. Try again later or use another method.',
      EMAIL_SEND_FAILED: 'The email couldn’t be sent. Try again shortly or use another method.',
      SMTP_NOT_CONFIGURED: 'Email delivery isn’t available right now. Use another method.',
      METHOD_NOT_ALLOWED: 'This verification method isn’t available.',
      SETUP_REQUIRED: 'Finish setting up 2-Step Verification first.',
      NUMBER_MISMATCH: 'The number didn’t match the one on the other device, so the request was denied.',
      STEP_UP_UNAVAILABLE: 'No verification method is set up for your account. Enable Google Authenticator or add a security email first.',
      STEP_UP_REQUIRED: 'Verify your identity with a verification code first.',
      PASSWORD_WRONG: 'The current password is incorrect.',
      VERIFY_FIRST: 'Complete the verification steps first.',
      BACKEND_UNAVAILABLE: 'The server is unavailable. Please try again shortly.',
    };
    if (map[e.code]) return map[e.code];
    if (/لا يمكن إعادة تعيين كلمة المرور/.test(e.message || '')) return 'This account’s password can’t be reset here. Contact your administrator.';
    if (/لا توجد وسيلة تحقق مفعّلة/.test(e.message || '')) return 'No verification method is set up for this account. Ask another administrator to set a new password.';
    if (/رمز التحقق غير صحيح/.test(e.message || '')) return 'Incorrect code. Make sure you scanned the QR code shown now.';
    if (/كلمة المرور/.test(e.message || '') && /8/.test(e.message || '')) return 'Use at least 8 characters.';
    return e.message || 'Something went wrong. Try again.';
  }

  // ── Verification (sign-in, reset, step-up) ──────────────────────────────────
  let V = null; // current verification state

  const METHOD_META = {
    totp: { ar: 'رمز التطبيق', en: 'Authenticator', alt_ar: 'تطبيق المصادقة', alt_en: 'Authenticator app' },
    email: { ar: 'البريد الإلكتروني', en: 'Email', alt_ar: 'رمز عبر البريد الإلكتروني', alt_en: 'Email code' },
    approval: { ar: 'جهاز موثوق', en: 'Trusted device', alt_ar: 'جهاز موثوق', alt_en: 'Trusted device' },
    backup: { ar: 'رمز احتياطي', en: 'Backup code', alt_ar: 'رمز احتياطي', alt_en: 'Backup code' },
  };

  function allowedMethods() {
    if (!V) return [];
    const has = (m) => (m === 'email' ? !!V.methods.email : !!V.methods[m]);
    const open = (V.requirement || []).filter((g) => !g.some((m) => V.done.includes(m)));
    // A reset with two factors goes one step at a time: only the first open step's methods.
    const set = new Set();
    (V.purpose === 'reset' ? open.slice(0, 1) : open).forEach((g) => g.forEach((m) => { if (has(m)) set.add(m); }));
    return ['totp', 'email', 'approval', 'backup'].filter((m) => set.has(m));
  }

  /**
   * data = the /auth/login reply ({challenge, methods, setupRequired, account}), the
   * /auth/forgot-password/start reply or a step-up. ctx = {username, purpose, onDone(res), onCancel, subtitle}.
   */
  function verify(data, ctx) {
    stopTimers();
    const methods = data.methods || { totp: true, email: null, approval: false, backup: false };
    const requirement = data.requirement || [['totp', 'email', 'approval', 'backup'].filter((m) => (m === 'email' ? !!methods.email : !!methods[m]))];
    V = {
      challenge: data.challenge, methods, requirement, done: [], purpose: ctx.purpose || 'login',
      username: ctx.username || data.account?.username || '',
      setup: !!(data.setupRequired || data.requireTotpSetup), onDone: ctx.onDone, onCancel: ctx.onCancel, subtitle: ctx.subtitle || '',
      // «الوثوق بهذا الجهاز لمدة 30 يومًا» is opt-in (unticked by default).
      trust: false,
      method: '', emailSent: null, resendAt: 0, approval: null, busy: false, dead: false, err: '', setupData: null,
    };
    V.method = allowedMethods()[0] || 'totp';
    renderVerify();
    if (V.setup) startSetup();
  }

  function stepInfo() {
    if (V.purpose !== 'reset' || V.requirement.length < 2) return '';
    const total = V.requirement.length;
    const doneN = V.requirement.filter((g) => g.some((m) => V.done.includes(m))).length;
    return `<div class="sv-steps">${E(T(`الخطوة ${Math.min(doneN + 1, total)} من ${total}`, `Step ${Math.min(doneN + 1, total)} of ${total}`))}</div>`;
  }

  function renderVerify() {
    if (!V) return;
    const reset = V.purpose === 'reset';
    const stepup = V.purpose === 'stepup' || V.purpose === 'unlock';
    const methods = V.setup ? [] : allowedMethods();
    const title = V.setup ? T('إعداد التحقق بخطوتين', 'Set up 2-Step Verification')
      : reset ? T('إعادة تعيين كلمة المرور', 'Reset password')
        : V.purpose === 'unlock' ? T('فتح قفل تسجيل الدخول', 'Unlock sign-in')
          : stepup ? T('تأكيد الهوية', 'Confirm your identity')
          : T('التحقق بخطوتين', '2-Step Verification');
    const sub = V.setup ? E(T('يجب تفعيل التحقق بخطوتين لحسابك قبل المتابعة.', '2-Step Verification must be enabled for your account before you continue.'))
      : V.purpose === 'unlock' ? E(T('أكّد هويتك لفتح القفل عن هذا الجهاز، ثم سجّل الدخول بكلمة المرور.', 'Verify your identity to unlock this device, then sign in with your password.'))
        : stepup ? E(V.subtitle) : '';
    // One method at a time; the others are a small line of links under the button (the pattern of
    // Google / Microsoft sign-in pages) — never a row of large tabs.
    const others = V.dead ? [] : methods.filter((m) => m !== V.method);
    const alt = !others.length ? ''
      : V.showAlt
        ? `<div class="sv-alt-list" role="list">${others.map((m) => `<button type="button" role="listitem" class="sv-alt-row" data-m="${m}"><span>${E(T(METHOD_META[m].alt_ar, METHOD_META[m].alt_en))}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${L() === 'en' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'}"/></svg></button>`).join('')}</div>`
        : `<div class="sv-alt"><button type="button" class="sv-alt-link" data-alt-toggle aria-expanded="false">${E(T('طريقة تحقق أخرى', 'Try another way'))}</button></div>`;
    const trust = !reset && !stepup && !V.dead
      ? `<label class="sv-trust"><input type="checkbox" id="sv-trust" ${V.trust ? 'checked' : ''}><span>${E(T('الوثوق بهذا الجهاز لمدة 30 يومًا', 'Trust this device for 30 days'))}</span></label>` : '';
    const back = reset || stepup ? T('إلغاء', 'Cancel') : T('العودة إلى تسجيل الدخول', 'Back to sign in');
    const html = `${headHtml(title, sub)}
      ${stepInfo()}
      <div class="sv-panel" id="sv-panel">${V.setup ? (V.setupData ? setupHtml(V.setupData) : '<div class="sv-wait"><span class="sv-spin"></span></div>') : panelHtml()}</div>
      ${trust}
      ${alt}
      <div class="sv-foot"><button type="button" class="sv-link sv-back" data-act="back">${E(back)}</button></div>`;
    if (!ov || ov.id !== 'sv-verify') openOverlay('sv-verify', html, () => { if (!V?.busy) cancelVerify(); });
    else { ov.dir = L() === 'en' ? 'ltr' : 'rtl'; ov.lang = L(); ov.querySelector('.sv-card').innerHTML = html; const s = ov.querySelector('.sv-secure span'); if (s) s.textContent = T('اتصال آمن', 'Secure connection'); }
    bindVerify();
  }

  const errHtml = () => `<div class="sv-err" id="sv-err" role="alert"${V && V.err ? '' : ' hidden'}>${E(V ? V.err : '')}</div>`;
  const masked = (v) => `<bdi dir="ltr" class="sv-mono">${E(v)}</bdi>`;

  function panelHtml() {
    const m = V.method;
    if (V.dead) {
      return `${errHtml()}${V.purpose === 'login' ? btnHtml('restart', T('تسجيل الدخول مرة أخرى', 'Sign in again')) : ''}`;
    }
    if (m === 'totp') {
      return `<p class="sv-hint">${T('أدخل الرمز المكوّن من 6 أرقام من تطبيق <bdi>Google Authenticator</bdi>.', 'Enter the 6-digit code from <bdi>Google Authenticator</bdi>.')}</p>
        ${otpHtml('sv-code')}${errHtml()}
        ${btnHtml('submit', T('تأكيد', 'Confirm'))}`;
    }
    if (m === 'backup') {
      return `<p class="sv-hint">${E(T('أدخل أحد الرموز الاحتياطية التي حفظتها عند إعداد التحقق بخطوتين. يُستخدم كل رمز مرة واحدة.', 'Enter one of the backup codes you saved when you set up 2-Step Verification. Each code works once.'))}</p>
        ${codeInput('sv-code')}${errHtml()}
        ${btnHtml('submit', T('تأكيد', 'Confirm'))}`;
    }
    if (m === 'email') {
      if (!V.emailSent) {
        return `<p class="sv-hint">${E(T('سيُرسل رمز التحقق إلى', 'A verification code will be sent to'))} ${masked(V.methods.email)}.</p>
          ${errHtml()}
          ${btnHtml('send-email', T('إرسال الرمز', 'Send code'))}`;
      }
      return `<p class="sv-hint">${E(T('أُرسل رمز التحقق إلى', 'A verification code was sent to'))} ${masked(V.emailSent)}.</p>
        ${otpHtml('sv-code')}${errHtml()}
        ${btnHtml('submit', T('تأكيد', 'Confirm'))}
        <div class="sv-resend"><button type="button" class="sv-link" data-act="send-email" id="sv-resend">${resendLabel()}</button></div>`;
    }
    if (m === 'approval') {
      const a = V.approval;
      if (!a || a.status === 'expired') {
        return `<p class="sv-hint">${E(T('سيُرسل طلب موافقة إلى أجهزتك الموثوقة.', 'A sign-in request will be sent to your trusted devices.'))}</p>
          ${a?.status === 'expired' ? `<p class="sv-note">${E(T('انتهت صلاحية الطلب السابق.', 'The previous request expired.'))}</p>` : ''}
          ${errHtml()}
          ${btnHtml('request-approval', T('إرسال الطلب', 'Send request'))}`;
      }
      return `<p class="sv-hint">${E(T('اختر الرقم التالي على جهازك الموثوق للموافقة:', 'Select this number on your trusted device to approve:'))}</p>
        <div class="sv-number" dir="ltr" aria-live="polite">${E(a.number)}</div>
        <div class="sv-waiting"><span class="sv-spin"></span><span id="sv-countdown">${waitLabel()}</span></div>
        ${errHtml()}`;
    }
    return '';
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  function resendLabel() {
    const wait = V ? Math.max(0, Math.ceil((V.resendAt - Date.now()) / 1000)) : 0;
    return wait ? E(T(`إعادة الإرسال خلال ${mmss(wait)}`, `Resend in ${mmss(wait)}`)) : E(T('إعادة إرسال الرمز', 'Resend code'));
  }
  function waitLabel() {
    const left = V?.approval ? Math.max(0, Math.ceil((new Date(V.approval.expiresAt).getTime() - Date.now()) / 1000)) : 0;
    return E(T(`في انتظار الموافقة (${mmss(left)})`, `Waiting for approval (${mmss(left)})`));
  }

  function bindVerify() {
    if (!ov) return;
    const toggle = $('[data-alt-toggle]', ov);
    if (toggle) toggle.addEventListener('click', () => { if (V.busy) return; V.showAlt = true; renderVerify(); setTimeout(() => $('.sv-alt-row', ov)?.focus(), 30); });
    ov.querySelectorAll('.sv-tab, .sv-alt-row').forEach((b) => b.addEventListener('click', () => {
      if (V.busy) return;
      V.method = b.dataset.m; V.err = ''; V.showAlt = false;
      renderVerify();
    }));
    ov.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, b)));
    const otp = $('#sv-code.sv-otp', ov);
    if (otp) otpBind(otp, () => submitCode());
    const backup = $('#sv-code.sv-backup-input', ov);
    if (backup) {
      backup.addEventListener('input', () => setErr(''));
      backup.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCode(); } });
    }
    const resend = $('#sv-resend', ov);
    if (resend) { resend.disabled = Date.now() < V.resendAt; if (resend.disabled) startResendTimer(); }
    const trust = $('#sv-trust', ov);
    if (trust) trust.addEventListener('change', () => { V.trust = trust.checked; });
    if (V.setup && V.setupData) bindSetupPanel();
    focusCode();
  }
  function focusCode() {
    setTimeout(() => {
      if (!ov) return;
      const first = $('#sv-code .sv-otp-box', ov) || $('#sv-code', ov) || $('#sv-setup-code .sv-otp-box', ov);
      if (first) first.focus();
    }, 40);
  }
  function setErr(msg) {
    if (V) V.err = msg || '';
    const el = ov && $('#sv-err', ov);
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  /** Busy: every control disabled; the primary button shows a spinner and «جارٍ التحقق…». */
  function busy(on) {
    if (V) V.busy = on;
    if (!ov) return;
    ov.querySelectorAll('.sv-btn, .sv-tab, .sv-alt-link, .sv-alt-row, .sv-link, .sv-otp-box').forEach((b) => { if (on) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; } else { b.disabled = b.dataset.wasDisabled === '1'; } });
    ov.querySelectorAll('.sv-btn.is-primary').forEach((b) => {
      const txt = b.querySelector('.sv-btn-txt');
      b.classList.toggle('is-loading', on);
      b.setAttribute('aria-busy', String(on));
      if (txt) { if (on) { txt.dataset.label = txt.textContent; txt.textContent = T('جارٍ التحقق…', 'Verifying…'); } else if (txt.dataset.label) txt.textContent = txt.dataset.label; }
    });
  }

  function act(name, btn) {
    if (name === 'back') return cancelVerify();
    if (name === 'restart') { cancelVerify(); const p = document.getElementById('login-pass'); if (p) { p.value = ''; p.focus(); } return; }
    if (name === 'submit') return submitCode();
    if (name === 'send-email') return sendEmail(btn);
    if (name === 'request-approval') return requestApproval();
  }

  function cancelVerify() {
    const cancelled = V && V.onCancel;
    stopTimers();
    V = null;
    closeOverlay();
    if (cancelled) cancelled();
  }

  /**
   * «تأكيد الهوية» before a sensitive change (system PIN, security email). Resolves with a confirmation
   * token the change route spends once, or null when the person cancels.
   */
  const STEP_UP_TEXT = {
    'system-pin': ['لتغيير الرقم السري للنظام، أدخل رمز التحقق.', 'Enter a verification code to change the system PIN.'],
    'security-email': ['لتغيير بريد التحقق، أدخل رمزًا من وسيلة التحقق الحالية.', 'Enter a code from your current verification method to change your security email.'],
    'totp-disable': ['لتعطيل Google Authenticator، أدخل الرمز المُرسل إلى بريد التحقق.', 'To disable Google Authenticator, enter the code sent to your security email.'],
  };
  async function stepUp(action) {
    let data;
    try {
      data = await api('/auth/security/step-up', { method: 'POST', body: JSON.stringify({ action }) });
    } catch (e) {
      toastMsg(errText(e), true);
      return null;
    }
    const text = STEP_UP_TEXT[action] || ['أدخل رمز التحقق للمتابعة.', 'Enter a verification code to continue.'];
    return new Promise((resolve) => {
      verify(data, {
        purpose: 'stepup', username: data.account?.username, subtitle: T(text[0], text[1]),
        onDone: ({ challenge }) => resolve(challenge), onCancel: () => resolve(null),
      });
    });
  }

  function failed(e) {
    const code = e?.code || '';
    if (/^CHALLENGE_/.test(code)) {
      V.dead = true; V.err = errText(e);
      stopTimers();
      renderVerify();
      return;
    }
    setErr(errText(e));
    const otp = ov && $('#sv-code.sv-otp', ov);
    if (otp) otpClear(otp, true);
    const backup = ov && $('#sv-code.sv-backup-input', ov);
    if (backup) { backup.value = ''; backup.focus(); }
  }

  async function submitCode() {
    if (!V || V.busy) return;
    const otp = ov && $('#sv-code.sv-otp', ov);
    const backup = ov && $('#sv-code.sv-backup-input', ov);
    const value = V.method === 'backup' ? (backup ? backup.value.trim() : '') : otpValue(otp);
    if (V.method === 'backup' ? value.replace(/[^a-z0-9]/gi, '').length !== 8 : value.length !== 6) {
      setErr(V.method === 'backup' ? T('الرمز الاحتياطي مكوّن من 8 أحرف، مثل k7pd-3mxa.', 'A backup code has 8 characters, for example k7pd-3mxa.') : T('أدخل الرمز المكوّن من 6 أرقام.', 'Enter the 6-digit code.'));
      if (otp) otp.classList.add('is-error');
      return;
    }
    busy(true);
    try {
      const res = await api('/auth/challenge/verify', { method: 'POST', body: JSON.stringify({ challenge: V.challenge, method: V.method, code: value, trustDevice: V.purpose === 'login' && V.trust }) });
      busy(false);
      progressed(res, V.method);
    } catch (e) {
      busy(false);
      failed(e);
    }
  }

  function progressed(res, method) {
    if (!V) return;
    if (res && res.accessToken) return finished(res);
    if (res && (res.resetReady || res.stepUpReady || res.unlocked)) { const done = V.onDone; const v = V; stopTimers(); V = null; closeOverlay(); if (done) done({ challenge: v.challenge }); return; }
    if (res && res.done === false) {
      V.done = Array.from(new Set([...V.done, method]));
      V.method = allowedMethods()[0] || V.method;
      V.err = '';
      renderVerify();
    }
  }

  function finished(res) {
    const v = V;
    stopTimers();
    V = null;
    if (res.deviceToken) saveDeviceToken(v.username, res.deviceToken);
    const go = () => { closeOverlay(); if (v.onDone) v.onDone(res); };
    if (res.backupCodes && res.backupCodes.length) return showBackupCodes(res.backupCodes, go);
    go();
  }

  async function sendEmail() {
    if (!V || V.busy) return;
    busy(true);
    try {
      const r = await api('/auth/challenge/email', { method: 'POST', body: JSON.stringify({ challenge: V.challenge }) });
      V.emailSent = r.sentTo || V.methods.email;
      V.resendAt = Date.now() + (Number(r.resendIn) || 60) * 1000;
      busy(false);
      V.err = '';
      renderVerify();
    } catch (e) {
      busy(false);
      if (e?.code === 'EMAIL_RATE_LIMITED' && V.emailSent) { setErr(errText(e)); return; }
      failed(e);
    }
  }

  let resendTimer = null, approvalTimer = null, approvalPoll = null;
  function stopTimers() {
    clearInterval(resendTimer); clearInterval(approvalTimer); clearTimeout(approvalPoll);
    resendTimer = approvalTimer = approvalPoll = null;
  }
  function startResendTimer() {
    clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      const b = ov && $('#sv-resend', ov);
      if (!V || !b) { clearInterval(resendTimer); return; }
      const wait = Date.now() < V.resendAt;
      b.disabled = wait || V.busy;
      b.innerHTML = resendLabel();
      if (!wait) clearInterval(resendTimer);
    }, 1000);
  }

  async function requestApproval() {
    if (!V || V.busy) return;
    busy(true);
    try {
      const r = await api('/auth/challenge/approval', { method: 'POST', body: JSON.stringify({ challenge: V.challenge }) });
      busy(false);
      V.approval = { status: 'pending', number: r.number, expiresAt: r.expiresAt };
      V.err = '';
      renderVerify();
      startApprovalWatch();
    } catch (e) {
      busy(false);
      failed(e);
    }
  }
  function startApprovalWatch() {
    clearInterval(approvalTimer);
    approvalTimer = setInterval(() => {
      if (!V?.approval || V.approval.status !== 'pending') { clearInterval(approvalTimer); return; }
      const el = ov && $('#sv-countdown', ov);
      if (el) el.innerHTML = waitLabel();
    }, 1000);
    const poll = async () => {
      if (!V || V.method !== 'approval' || V.approval?.status !== 'pending') return;
      try {
        const r = await api('/auth/challenge/approval/status', { method: 'POST', body: JSON.stringify({ challenge: V.challenge, trustDevice: V.trust }) });
        if (!V) return;
        if (r.status === 'approved') return finished(r);
        if (r.status === 'denied') {
          V.dead = true; V.err = T('تم رفض طلب تسجيل الدخول من جهازك الموثوق.', 'The sign-in request was denied on your trusted device.');
          stopTimers(); renderVerify(); return;
        }
        if (r.status === 'expired') { V.approval.status = 'expired'; stopTimers(); renderVerify(); return; }
      } catch (e) {
        if (/^CHALLENGE_/.test(e?.code || '')) return failed(e);
      }
      approvalPoll = setTimeout(poll, 2000);
    };
    approvalPoll = setTimeout(poll, 2000);
  }

  // Forced Google Authenticator setup inside the challenge.
  async function startSetup() {
    try {
      const r = await api('/auth/challenge/setup-init', { method: 'POST', body: JSON.stringify({ challenge: V.challenge }) });
      if (!V) return;
      V.setupData = r;
      renderVerify();
    } catch (e) { failed(e); }
  }
  function bindSetupPanel() {
    bindSetup(async (code) => {
      const res = await api('/auth/challenge/setup-confirm', { method: 'POST', body: JSON.stringify({ challenge: V.challenge, code, trustDevice: V.trust }) });
      finished(res);
    });
  }
  function setupHtml(r) {
    return `<ol class="sv-setup-steps">
        <li>${T('ثبّت تطبيق <bdi>Google Authenticator</bdi> على هاتفك.', 'Install <bdi>Google Authenticator</bdi> on your phone.')}</li>
        <li>${E(T('في التطبيق، اختر «+» ثم «مسح رمز QR»، وامسح الرمز التالي.', 'In the app, tap «+», then «Scan a QR code», and scan this code.'))}</li>
        <li>${E(T('أدخل الرمز المكوّن من 6 أرقام الظاهر في التطبيق.', 'Enter the 6-digit code shown in the app.'))}</li>
      </ol>
      <div class="sv-qr"><img src="${E(r.qrCode)}" alt="QR"></div>
      <details class="sv-secret"><summary>${E(T('تعذّر المسح؟ أدخل مفتاح الإعداد يدويًا', 'Can’t scan? Enter the setup key manually'))}</summary><code dir="ltr">${E(String(r.secret || '').replace(/(.{4})/g, '$1 ').trim())}</code></details>
      ${otpHtml('sv-setup-code')}${errHtml()}
      ${btnHtml('', T('تفعيل', 'Enable'), 'id="sv-setup-ok"')}`;
  }
  function bindSetup(confirmFn) {
    const root = $('#sv-setup-code'), ok = $('#sv-setup-ok');
    if (!root || !ok) return;
    const run = async () => {
      const code = otpValue(root);
      if (code.length !== 6) { setErr(T('أدخل الرمز المكوّن من 6 أرقام.', 'Enter the 6-digit code.')); root.classList.add('is-error'); return; }
      if (ok.classList.contains('is-loading')) return;
      const txt = ok.querySelector('.sv-btn-txt'); const label = txt.textContent;
      ok.disabled = true; ok.classList.add('is-loading'); txt.textContent = T('جارٍ التحقق…', 'Verifying…');
      try { await confirmFn(code); } catch (e) {
        ok.disabled = false; ok.classList.remove('is-loading'); txt.textContent = label;
        if (/^CHALLENGE_/.test(e?.code || '') && V) return failed(e);
        setErr(errText(e)); otpClear(root, true);
      }
    };
    otpBind(root, run);
    ok.addEventListener('click', run);
    setTimeout(() => otpBoxes(root)[0]?.focus(), 50);
  }

  // ── Backup codes (shown once) ───────────────────────────────────────────────
  function showBackupCodes(codes, onClose) {
    const text = codes.join('\n');
    const html = `${headHtml(T('الرموز الاحتياطية', 'Backup codes'), E(T('احفظ هذه الرموز في مكان آمن. يمكنك استخدام أي منها لتسجيل الدخول إذا لم يتوفر هاتفك، ويُستخدم كل رمز مرة واحدة فقط. لن تظهر هذه الرموز مرة أخرى.', 'Keep these codes somewhere safe. Use any of them to sign in if your phone isn’t available; each code works once. They won’t be shown again.')))}
      <div class="sv-codes" dir="ltr">${codes.map((c) => `<code>${E(c)}</code>`).join('')}</div>
      <div class="sv-row">
        <button type="button" class="sv-btn" data-b="copy">${E(T('نسخ', 'Copy'))}</button>
        <button type="button" class="sv-btn" data-b="download">${E(T('تنزيل', 'Download'))}</button>
      </div>
      <label class="sv-trust"><input type="checkbox" id="sv-saved"><span>${E(T('حفظتُ هذه الرموز في مكان آمن', 'I have saved these codes'))}</span></label>
      <div class="sv-foot is-block">${btnHtml('', T('متابعة', 'Continue'), 'data-b="done" disabled')}</div>`;
    const o = openOverlay('sv-backup', html, null);
    o.querySelector('#sv-saved').addEventListener('change', (e) => { o.querySelector('[data-b="done"]').disabled = !e.target.checked; });
    o.querySelector('[data-b="copy"]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toastMsg(T('تم نسخ الرموز', 'Codes copied')); }
      catch (_) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toastMsg(T('تم نسخ الرموز', 'Codes copied')); } catch (__) {} ta.remove(); }
    });
    o.querySelector('[data-b="download"]').addEventListener('click', () => {
      const blob = new Blob([`SOULIA — backup codes\n${new Date().toISOString().slice(0, 10)}\n\n${text}\n`], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'soulia-backup-codes.txt'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    o.querySelector('[data-b="done"]').addEventListener('click', () => { closeOverlay(); if (onClose) onClose(); });
  }

  // ── Forgot password ─────────────────────────────────────────────────────────
  function forgotPassword() {
    stopTimers();
    V = null;
    const html = `${headHtml(T('إعادة تعيين كلمة المرور', 'Reset password'), E(T('أدخل اسم المستخدم. حسابات المديرين تُستعاد برمز يُرسل إلى بريد الأمان المسجّل، أما حسابات الموظفين فيُرسل طلبها إلى مدير النظام.', 'Enter your username. Admin accounts are recovered with a code sent to the registered security email; staff accounts send a request to the administrator.')))}
      <label class="sv-label" for="fp2-user">${E(T('اسم المستخدم', 'Username'))}</label>
      <input id="fp2-user" class="sv-input" type="text" autocomplete="username" dir="ltr" value="${E(document.getElementById('login-user')?.value || '')}">
      <div class="sv-err" id="sv-err" role="alert" hidden></div>
      <div class="sv-foot is-block">${btnHtml('', T('متابعة', 'Continue'), 'id="fp2-next"')}<button type="button" class="sv-link" id="fp2-cancel">${E(T('العودة إلى تسجيل الدخول', 'Back to sign in'))}</button></div>`;
    const o = openOverlay('sv-forgot', html, closeOverlay);
    const user = o.querySelector('#fp2-user'), next = o.querySelector('#fp2-next');
    const go = async () => {
      const username = user.value.trim();
      if (!username) { setErr(T('أدخل اسم المستخدم.', 'Enter your username.')); return; }
      next.disabled = true; next.classList.add('is-loading');
      try {
        const r = await api('/auth/forgot-password/start', { method: 'POST', body: JSON.stringify({ username }) });
        // Staff (and unknown names — the same answer, so no account is revealed): a request to the admins.
        if (r && r.requestSent) {
          const body = o.querySelector('.sv-card');
          body.innerHTML = `${headHtml(T('تم إرسال طلبك', 'Request sent'), E(T('أُرسل طلب إعادة تعيين كلمة المرور إلى مدير النظام. سيعيّن لك كلمة مرور جديدة ويبلغك بها.', 'Your password reset request was sent to the administrator, who will set a new password and give it to you.')))}
            <p class="sv-sub">${E(T('لا يمكن لحسابات الموظفين تغيير كلمة المرور بنفسها؛ يتولى ذلك مدير النظام.', 'Staff accounts cannot change their own password; the administrator does it.'))}</p>
            <div class="sv-foot is-block"><button type="button" class="sv-btn is-primary is-wide" id="fp2-back">${E(T('العودة إلى تسجيل الدخول', 'Back to sign in'))}</button></div>`;
          body.querySelector('#fp2-back').addEventListener('click', closeOverlay);
          return;
        }
        verify(r, { purpose: 'reset', username, onDone: ({ challenge }) => newPassword(challenge, username) });
      } catch (e) { next.disabled = false; next.classList.remove('is-loading'); setErr(errText(e)); }
    };
    next.addEventListener('click', go);
    user.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    o.querySelector('#fp2-cancel').addEventListener('click', closeOverlay);
    setTimeout(() => { user.focus(); user.select(); }, 50);
  }

  function strength(pw) {
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    return Math.min(4, s);
  }
  function newPassword(challenge, username) {
    const html = `${headHtml(T('كلمة مرور جديدة', 'New password'), E(T('استخدم 8 أحرف على الأقل. سيُسجَّل خروجك من جميع الأجهزة بعد الحفظ.', 'Use at least 8 characters. You will be signed out of all devices after saving.')))}
      <label class="sv-label" for="np-1">${E(T('كلمة المرور الجديدة', 'New password'))}</label>
      <input id="np-1" class="sv-input" type="password" autocomplete="new-password" dir="ltr">
      <div class="sv-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <label class="sv-label" for="np-2">${E(T('تأكيد كلمة المرور', 'Confirm password'))}</label>
      <input id="np-2" class="sv-input" type="password" autocomplete="new-password" dir="ltr">
      <div class="sv-err" id="sv-err" role="alert" hidden></div>
      <div class="sv-foot is-block">${btnHtml('', T('حفظ كلمة المرور', 'Save password'), 'id="np-save"')}</div>`;
    const o = openOverlay('sv-newpass', html, null);
    const p1 = o.querySelector('#np-1'), p2 = o.querySelector('#np-2'), save = o.querySelector('#np-save');
    p1.addEventListener('input', () => { const s = strength(p1.value); o.querySelectorAll('.sv-meter i').forEach((b, i) => b.classList.toggle('is-on', i < s)); o.querySelector('.sv-meter').dataset.s = s; setErr(''); });
    const run = async () => {
      if (p1.value.length < 8) { setErr(T('يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.', 'Use at least 8 characters.')); return; }
      if (p1.value !== p2.value) { setErr(T('كلمتا المرور غير متطابقتين.', 'The passwords don’t match.')); return; }
      save.disabled = true; save.classList.add('is-loading');
      try {
        await api('/auth/forgot-password/reset', { method: 'POST', body: JSON.stringify({ challenge, newPassword: p1.value }) });
        forgetDeviceToken(username);
        closeOverlay();
        toastMsg(T('تم تغيير كلمة المرور. سجّل الدخول بكلمة المرور الجديدة.', 'Your password was changed. Sign in with the new password.'));
        const u = document.getElementById('login-user'), p = document.getElementById('login-pass');
        if (u) u.value = username;
        if (p) { p.value = ''; p.focus(); }
      } catch (e) { save.disabled = false; save.classList.remove('is-loading'); setErr(errText(e)); }
    };
    save.addEventListener('click', run);
    p2.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    setTimeout(() => p1.focus(), 50);
  }

  // ── «لست برنامجًا آليًا»: proof of work ──────────────────────────────────────
  // SHA-256 in plain JS (crypto.subtle is missing on plain-http LAN pages). The server sends a signed
  // challenge; the browser finds a nonce whose hash starts with `difficulty` zero bits (≈0.3–1 s).
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256(bytes) {
    const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
    m.set(bytes); m[l] = 0x80;
    const bits = l * 8; m[n - 4] = bits >>> 24; m[n - 3] = (bits >>> 16) & 255; m[n - 2] = (bits >>> 8) & 255; m[n - 1] = bits & 255;
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const w = new Uint32Array(64);
    const r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (m[o + i * 4] << 24) | (m[o + i * 4 + 1] << 16) | (m[o + i * 4 + 2] << 8) | m[o + i * 4 + 3];
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        w[i] = (w[i - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + w[i - 7] + (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) { out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255; }
    return out;
  }
  function zeroBits(buf) {
    let bits = 0;
    for (const byte of buf) { if (byte === 0) { bits += 8; continue; } let b = byte; while ((b & 0x80) === 0) { bits++; b <<= 1; } break; }
    return bits;
  }
  async function solvePow(p) {
    const enc = new TextEncoder();
    const need = Math.max(1, Number(p?.difficulty) || 15);
    for (let n = 0; n < 50_000_000; n++) {
      if (zeroBits(sha256(enc.encode(`${p.challenge}:${n}`))) >= need) return { challenge: p.challenge, nonce: String(n) };
      if (n % 4000 === 3999) await new Promise((res) => setTimeout(res, 0)); // keep the page responsive
    }
    throw new Error('pow');
  }

  // ── Cloudflare Turnstile (when the server has its keys) ────────────────────────
  // The server answers 428 CAPTCHA_REQUIRED with {captcha:{siteKey}}. The widget sits under the
  // password field and usually passes without a click («interaction-only»); its token goes with the
  // next sign-in request. A token is good for one request — every new challenge resets the widget.
  let tsLoading = null;
  let tsWidget = null;
  let tsWait = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (tsLoading) return tsLoading;
    tsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.defer = true;
      const timer = setTimeout(() => reject(new Error('captcha-load')), 12000);
      s.onload = () => { clearTimeout(timer); window.turnstile ? resolve(window.turnstile) : reject(new Error('captcha-load')); };
      s.onerror = () => { clearTimeout(timer); reject(new Error('captcha-load')); };
      document.head.appendChild(s);
    }).catch((e) => { tsLoading = null; throw e; });
    return tsLoading;
  }
  async function captchaToken(c) {
    const ts = await loadTurnstile();
    let slot = document.getElementById('login-captcha');
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'login-captcha';
      slot.className = 'lfp-captcha';
      const btn = document.querySelector('#login-form .lfp-btn-login');
      if (btn && btn.parentNode) btn.parentNode.insertBefore(slot, btn); else document.getElementById('login-form')?.appendChild(slot);
    }
    slot.hidden = false;
    return new Promise((resolve, reject) => {
      // Up to 2 minutes: the visitor may have to tick the box.
      const timer = setTimeout(() => { tsWait = null; reject(new Error('captcha-timeout')); }, 120000);
      tsWait = {
        ok: (tok) => { clearTimeout(timer); tsWait = null; resolve(tok); },
        fail: () => { clearTimeout(timer); tsWait = null; reject(new Error('captcha-error')); },
      };
      if (tsWidget !== null) { ts.reset(tsWidget); return; }
      tsWidget = ts.render(slot, {
        sitekey: c.siteKey,
        action: 'login',
        appearance: 'interaction-only',
        theme: 'light',
        language: loginLang() === 'en' ? 'en' : 'ar',
        callback: (tok) => tsWait && tsWait.ok(tok),
        'error-callback': () => { if (tsWait) tsWait.fail(); return true; },
        'expired-callback': () => { try { ts.reset(tsWidget); } catch { /* the next challenge resets it */ } },
      });
    });
  }

  /** «فتح القفل برمز التحقق» from the login page. */
  async function unlockStart(username) {
    const u = String(username || document.getElementById('login-user')?.value || '').trim();
    const errEl = document.getElementById('login-error');
    try {
      const r = await api('/auth/login-unlock/start', { method: 'POST', body: JSON.stringify({ username: u }) });
      verify(r, {
        purpose: 'unlock', username: u,
        onDone: () => {
          if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
          toastMsg(loginText('unlocked'));
          const p = document.getElementById('login-pass'); if (p) { p.value = ''; p.focus(); }
        },
      });
    } catch (e) {
      if (errEl) { errEl.textContent = loginError(e.message || ''); errEl.style.display = 'block'; }
    }
  }

  // ── «محاولات دخول فاشلة على حسابك — هل هذا أنت؟» ────────────────────────────
  let alertOpen = '';
  async function checkLoginAlerts(focusId) {
    if (!userSignedIn()) return false;
    let r;
    try { r = await api('/auth/login-alerts', { background: true }); } catch (_) { return false; }
    const list = r?.alerts || [];
    if (!list.length) { if (focusId) toastMsg(T('سبق الرد على هذا التنبيه.', 'This alert was already answered.')); return false; }
    showLoginAlert(list.find((x) => x.id === focusId) || list[0]);
    return true;
  }
  function showLoginAlert(a) {
    if (alertOpen === a.id && document.getElementById('sv-loginalert')) return;
    if (document.getElementById('sv-approve')) return; // an approval request is answered first
    alertOpen = a.id;
    const html = `${headHtml(T('محاولات دخول فاشلة على حسابك', 'Failed sign-in attempts on your account'), E(a.kind === 'blocked'
      ? T('حظرنا المحاولات من هذا المصدر بعد كلمات مرور خاطئة متكررة. حسابك لم يُقفل.', 'We blocked attempts from this source after repeated wrong passwords. Your account is not locked.')
      : T('أوقفنا المحاولات من هذا المصدر مؤقتًا بعد كلمات مرور خاطئة متكررة. حسابك لم يُقفل.', 'We paused attempts from this source after repeated wrong passwords. Your account is not locked.')))}
      <dl class="sv-facts">
        <div><dt>${E(T('الجهاز', 'Device'))}</dt><dd><bdi>${E(a.device || '—')}</bdi></dd></div>
        <div><dt>IP</dt><dd><bdi dir="ltr">${E(a.ip || '—')}</bdi></dd></div>
        <div><dt>${E(T('الوقت', 'Time'))}</dt><dd>${E(fmtDate(a.createdAt))}</dd></div>
      </dl>
      <p class="sv-hint">${E(T('هل كانت هذه المحاولات منك؟', 'Were these attempts made by you?'))}</p>
      <div class="sv-foot is-block">
        <button type="button" class="sv-btn is-primary is-wide" data-x="not-me">${E(T('لا، لست أنا — احظر هذا المصدر', 'No, it wasn’t me — block this source'))}</button>
        <button type="button" class="sv-btn is-wide" data-x="me">${E(T('نعم، كانت مني', 'Yes, it was me'))}</button>
        <button type="button" class="sv-link" data-x="later">${E(T('لاحقًا', 'Later'))}</button>
      </div>`;
    const o = openOverlay('sv-loginalert', html, () => { closeOverlay(); alertOpen = ''; });
    const decide = async (decision) => {
      o.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await api('/auth/login-alerts/' + encodeURIComponent(a.id), { method: 'POST', body: JSON.stringify({ decision }) });
        closeOverlay(); alertOpen = '';
        toastMsg(decision === 'me'
          ? T('تم رفع الإيقاف عن هذا المصدر.', 'The source was unblocked.')
          : T('تم حظر هذا المصدر، وسيُطلب التحقق من جميع أجهزتك لمدة 24 ساعة. ننصح بتغيير كلمة المرور.', 'The source is blocked and every device must verify for 24 hours. We recommend changing your password.'), decision !== 'me');
      } catch (e) { closeOverlay(); alertOpen = ''; toastMsg(e.message, true); }
    };
    o.querySelector('[data-x="not-me"]').addEventListener('click', () => decide('not-me'));
    o.querySelector('[data-x="me"]').addEventListener('click', () => decide('me'));
    o.querySelector('[data-x="later"]').addEventListener('click', () => { closeOverlay(); alertOpen = ''; });
  }

  // ── Approving a sign-in on a trusted device ─────────────────────────────────
  let approveOpen = '';
  async function checkApprovals(focusId) {
    if (typeof currentUser === 'undefined' || !currentUser || !currentDeviceToken()) return false;
    let r;
    try { r = await api('/auth/login-approvals', { headers: devHeaders(), background: true }); } catch (_) { return false; }
    if (!r?.trusted || !r.requests?.length) {
      if (focusId) toastMsg(T('انتهت صلاحية طلب تسجيل الدخول هذا.', 'This sign-in request has expired.'), true);
      return false;
    }
    const req = r.requests.find((x) => x.id === focusId) || r.requests[0];
    showApprove(req);
    return true;
  }
  function showApprove(req) {
    if (approveOpen === req.id && document.getElementById('sv-approve')) return;
    approveOpen = req.id;
    const html = `${headHtml(T('هل تحاول تسجيل الدخول؟', 'Are you trying to sign in?'))}
      <dl class="sv-facts">
        <div><dt>${E(T('الجهاز', 'Device'))}</dt><dd><bdi>${E(req.device)}</bdi></dd></div>
        <div><dt>IP</dt><dd><bdi dir="ltr">${E(req.ip || '—')}</bdi></dd></div>
        <div><dt>${E(T('الوقت', 'Time'))}</dt><dd>${E(fmtDate(req.requestedAt))}</dd></div>
      </dl>
      <p class="sv-sub">${E(T('إذا كنت أنت، فاختر الرقم الظاهر على الجهاز الآخر. وإذا لم تكن أنت، فاضغط «لا، لست أنا» ثم غيّر كلمة المرور فورًا.', 'If it’s you, tap the number shown on the other device. If not, tap «No, it’s not me» and change your password right away.'))}</p>
      <div class="sv-choices" dir="ltr">${(req.choices || []).map((n) => `<button type="button" class="sv-choice" data-n="${E(n)}">${E(n)}</button>`).join('')}</div>
      <div class="sv-err" id="sv-err" role="alert" hidden></div>
      <div class="sv-foot is-block"><button type="button" class="sv-btn is-danger-ghost is-wide" data-d="deny">${E(T('لا، لست أنا', 'No, it’s not me'))}</button><button type="button" class="sv-link" data-d="later">${E(T('لاحقًا', 'Later'))}</button></div>`;
    const o = openOverlay('sv-approve', html, () => { closeOverlay(); approveOpen = ''; });
    const decide = async (decision, number) => {
      o.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await api('/auth/login-approvals/' + encodeURIComponent(req.id), { method: 'POST', headers: devHeaders(), body: JSON.stringify({ decision, number }) });
        closeOverlay(); approveOpen = '';
        toastMsg(decision === 'approve' ? T('تمت الموافقة على تسجيل الدخول.', 'Sign-in approved.') : T('تم رفض محاولة تسجيل الدخول.', 'Sign-in attempt denied.'), decision !== 'approve');
      } catch (e) {
        closeOverlay(); approveOpen = '';
        toastMsg(e.message, true);
      }
    };
    o.querySelectorAll('.sv-choice').forEach((b) => b.addEventListener('click', () => decide('approve', b.dataset.n)));
    o.querySelector('[data-d="deny"]').addEventListener('click', () => decide('deny', ''));
    o.querySelector('[data-d="later"]').addEventListener('click', () => { closeOverlay(); approveOpen = ''; });
  }
  function bindSocket() {
    if (typeof socket === 'undefined' || !socket || socket.__svBound) return;
    socket.__svBound = true;
    socket.on('auth:login-approval', (p) => { checkApprovals(p && p.id); });
    socket.on('auth:login-alert', (p) => { checkLoginAlerts(p && p.id); });
    socket.on('auth:login-approval-done', (p) => {
      if (p && p.id === approveOpen && document.getElementById('sv-approve')) { closeOverlay(); approveOpen = ''; }
    });
  }
  let lastToken = '';
  setInterval(() => {
    bindSocket();
    const t = localStorage.getItem('token') || '';
    if (t && t !== lastToken && typeof currentUser !== 'undefined' && currentUser) { lastToken = t; checkApprovals().then((shown) => { if (!shown) checkLoginAlerts(); }); }
    if (!t) lastToken = '';
  }, 1500);

  // ── Settings ← الأمان: my account security ─────────────────────────────────
  let card = null;
  /** «mf*****s@gmail.com» — the card shows only part of the security email (owner, Nov 27).
   *  ⚠ Same format as maskEmail in backend auth-security.util.ts (the verification dialogs). */
  function maskMail(v) {
    const s = String(v || ''), at = s.lastIndexOf('@');
    if (at < 1) return s;
    const name = s.slice(0, at);
    const keep = name.length <= 3 ? name.slice(0, 1) : name.slice(0, 2);
    const tail = name.length > 3 ? name.slice(-1) : '';
    return keep + '*****' + tail + s.slice(at);
  }

  async function renderSecurityCard(hostId, opts = {}) {
    const host = document.getElementById(hostId || 'auth-security-root');
    if (!host) return;
    // Settings redraws itself on live updates; an open form (email) must survive that.
    const form = host.querySelector('#svs-email-form');
    if (!opts.force && form && !form.hidden) return;
    if (!host.dataset.ready) host.innerHTML = `<div class="svs-card"><div class="sv-wait"><span class="sv-spin"></span></div></div>`;
    try {
      card = await api('/auth/security', { headers: devHeaders(), deduplicate: false });
    } catch (e) {
      host.innerHTML = `<div class="svs-card"><p class="sv-err">${E(T('تعذّر تحميل إعدادات الأمان', 'Could not load security settings'))} — ${E(e.message)}</p><button type="button" class="sv-btn" id="svs-retry">${E(T('إعادة المحاولة', 'Retry'))}</button></div>`;
      host.querySelector('#svs-retry')?.addEventListener('click', () => renderSecurityCard(hostId, { force: true }));
      return;
    }
    // A refresh that started before the person opened a form must not draw over it.
    const formNow = host.querySelector('#svs-email-form');
    if (!opts.force && formNow && !formNow.hidden) return;
    host.dataset.ready = '1';
    const c = card;
    const isAdminAcct = c.role === 'admin';
    // Layout (Nov 27, 2026): a status summary, then one row per method — name, one line, state, action
    // at the row's end — the way account-security pages read in Google / Microsoft accounts.
    const state = (on, a, b) => `<span class="svs-state ${on ? 'is-on' : 'is-off'}">${on ? ICON.check : ''}${E(on ? a : b)}</span>`;
    const row = (icon, title, sub, st, actions, extra = '') => `<div class="svs-row">
        <span class="svs-ic">${icon}</span>
        <div class="svs-row-main"><div class="svs-title">${title}</div><div class="svs-sub">${sub}</div>${extra}</div>
        <div class="svs-row-end">${st}<div class="svs-row-act">${actions}</div></div>
      </div>`;
    const hasMethod = c.totpEnabled || (isAdminAcct && !!c.securityEmail);
    const status = hasMethod
      ? `<div class="svs-status is-ok"><span class="svs-status-ic">${ICON.shield}</span><div><b>${E(T('التحقق بخطوتين مفعّل لحسابك', '2-Step Verification is enabled'))}</b><span>${E(c.verificationRequired
          ? T('يُطلب رمز تحقق عند تسجيل الدخول من جهاز غير موثوق.', 'A verification code is required when signing in on a device that isn’t trusted.')
          : T('لا يُطلب التحقق لحسابك حاليًا لأن التحقق غير مفروض على الموظفين.', 'Verification is not currently required for your account.'))}</span></div></div>`
      : `<div class="svs-status is-warn"><span class="svs-status-ic">${ICON.shield}</span><div><b>${E(T('لم تُضف أي طريقة تحقق بعد', 'No verification method added yet'))}</b><span>${E(T('أضف تطبيق المصادقة لحماية حسابك عند تسجيل الدخول من جهاز جديد.', 'Add an authenticator app to protect your account when signing in on a new device.'))}</span></div></div>`;
    const devices = (c.devices || []).map((d) => {
      const cur = d.id === c.currentDeviceId;
      return `<li class="svs-dev${cur ? ' is-current' : ''}" title="${E(T('صالح حتى ', 'Valid until ') + fmtDate(d.expiresAt, false))}"><span class="svs-dev-ic">${ICON.device}</span>
        <div class="svs-dev-main"><div class="svs-dev-name"><bdi>${E(d.browser && d.os ? T(`${d.browser} على ${d.os}`, `${d.browser} on ${d.os}`) : d.label)}</bdi>${cur ? `<span class="svs-tag">${E(T('هذا الجهاز', 'This device'))}</span>` : ''}</div>
        <div class="svs-dev-meta">${E(T('آخر استخدام', 'Last used'))} ${E(fmtDate(d.lastUsedAt))} · <bdi dir="ltr" class="sv-mono">${E(d.ip || '—')}</bdi></div></div>
        <button type="button" class="sv-btn is-small" data-rev="${E(d.id)}">${E(T('إزالة', 'Remove'))}</button></li>`;
    }).join('');
    host.innerHTML = `<div class="svs-card">
      ${status}
      ${isAdminAcct ? `<div class="svs-group">${E(T('كلمة المرور', 'Password'))}</div>
      ${row(ICON.key, E(T('كلمة مرور الحساب', 'Account password')), E(T('يتطلب تغييرها كلمة المرور الحالية ورمز تحقق، وتُنهى بعده جميع الجلسات.', 'Changing it requires the current password and a verification code; every session ends afterwards.')), '', `<button type="button" class="sv-btn is-small" id="svs-pw-change">${E(T('تغيير كلمة المرور', 'Change password'))}</button>`)}` : ''}
      <div class="svs-group">${E(T('طرق التحقق', 'Verification methods'))}</div>
      ${row(ICON.app, E(T('تطبيق المصادقة', 'Authenticator app')),
        E(c.totpEnabled
          ? T(`Google Authenticator · مفعّل منذ ${c.totpEnabledAt ? fmtDate(c.totpEnabledAt, false) : '—'}`, `Google Authenticator · enabled since ${c.totpEnabledAt ? fmtDate(c.totpEnabledAt, false) : '—'}`)
          : T('رمز مكوّن من 6 أرقام يُنشئه تطبيق Google Authenticator على هاتفك.', 'A 6-digit code generated by Google Authenticator on your phone.')),
        state(c.totpEnabled, T('مفعّل', 'Enabled'), T('غير مفعّل', 'Disabled')),
        c.totpEnabled
          ? `<button type="button" class="sv-btn is-small is-danger-ghost" data-a="totp-off">${E(T('تعطيل', 'Disable'))}</button>`
          : `<button type="button" class="sv-btn is-small is-primary" data-a="totp-on">${E(T('إعداد', 'Set up'))}</button>`)}
      ${c.totpEnabled ? row(ICON.key, E(T('رموز الاسترداد', 'Backup codes')),
        E(T('رموز تُستخدم مرة واحدة إذا تعذّر الوصول إلى هاتفك.', 'One-time codes for when you can’t reach your phone.')),
        `<span class="svs-state ${c.backupCodesLeft > 2 ? 'is-on' : 'is-warn'}">${E(T(`المتبقي ${c.backupCodesLeft}`, `${c.backupCodesLeft} left`))}</span>`,
        `<button type="button" class="sv-btn is-small" data-a="backup">${E(T('إنشاء رموز جديدة', 'Generate new codes'))}</button>`) : ''}
      ${isAdminAcct ? row(ICON.mail, E(T('بريد الأمان', 'Security email')),
        (c.securityEmail ? `<bdi dir="ltr" class="sv-mono">${E(maskMail(c.securityEmail))}</bdi>` : E(T('تُرسَل إليه رموز التحقق ورموز استعادة كلمة المرور وتنبيهات الأمان.', 'Receives verification codes, password reset codes and security alerts.'))),
        state(!!c.securityEmail, T('مؤكَّد', 'Verified'), T('غير مُضاف', 'Not added')),
        `<button type="button" class="sv-btn is-small" data-a="email">${E(c.securityEmail ? T('تغيير', 'Change') : T('إضافة', 'Add'))}</button>${c.securityEmail ? `<button type="button" class="sv-btn is-small is-danger-ghost" data-a="email-remove">${E(T('حذف', 'Remove'))}</button>` : ''}`,
        (c.mailConfigured ? '' : `<div class="svs-warn">${E(T('خدمة إرسال البريد غير مهيّأة على الخادم، ولن تُرسَل الرموز حتى تُهيّأ.', 'Email sending is not configured on the server; codes cannot be sent until it is.'))}</div>`)
          + '<div class="svs-inline" id="svs-email-form" hidden></div>') : ''}
      <div class="svs-group">${E(T('الأجهزة الموثوقة', 'Trusted devices'))} <span class="svs-count">${(c.devices || []).length}</span></div>
      <p class="svs-group-sub">${E(T('لا يُطلب رمز التحقق عند تسجيل الدخول من هذه الأجهزة، ويمكن استخدامها للموافقة على تسجيل الدخول من جهاز جديد.', 'These devices skip the verification code and can approve sign-ins from a new device.'))}</p>
      ${devices
        ? `<ul class="svs-devs">${devices}</ul><div class="svs-foot"><button type="button" class="sv-btn is-small is-danger-ghost" data-a="rev-all">${E(T('إزالة جميع الأجهزة الأخرى', 'Remove all other devices'))}</button></div>`
        : `<p class="svs-empty">${E(T('لا توجد أجهزة موثوقة. عند تسجيل الدخول، اختر «الوثوق بهذا الجهاز لمدة 30 يومًا» لإضافة الجهاز إلى هذه القائمة.', 'No trusted devices. When signing in, choose «Trust this device for 30 days» to add it here.'))}</p>`}
    </div>`;
    host.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => cardAction(b.dataset.a, hostId)));
    host.querySelector('#svs-pw-change')?.addEventListener('click', () => window.SouliaPassword?.openChangeOwn());
    host.querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', async () => {
      if (typeof showConfirm === 'function' && !(await showConfirm(T('سيُزال هذا الجهاز من الأجهزة الموثوقة، وسيُطلب رمز التحقق عند تسجيل الدخول منه مرة أخرى.', 'This device will be removed from your trusted devices and will need verification at the next sign-in.'), { title: T('إزالة جهاز موثوق', 'Remove trusted device'), danger: true, confirmLabel: T('إزالة', 'Remove') }))) return;
      b.disabled = true;
      try { await api('/auth/trusted-devices/' + encodeURIComponent(b.dataset.rev) + '/revoke', { method: 'POST', body: '{}' }); if (b.dataset.rev === c.currentDeviceId && currentUser) forgetDeviceToken(currentUser.username); renderSecurityCard(hostId, { force: true }); }
      catch (e) { b.disabled = false; toastMsg(e.message, true); }
    }));
  }

  function askPassword(title) {
    return new Promise((resolve) => {
      const html = `${headHtml(title, E(T('أدخل كلمة المرور الحالية للمتابعة.', 'Enter your current password to continue.')))}
        <label class="sv-label" for="ap-pass">${E(T('كلمة المرور الحالية', 'Current password'))}</label>
        <input id="ap-pass" class="sv-input" type="password" autocomplete="current-password" dir="ltr">
        <div class="sv-foot is-block">${btnHtml('', T('متابعة', 'Continue'), 'id="ap-ok"')}<button type="button" class="sv-link" id="ap-cancel">${E(T('إلغاء', 'Cancel'))}</button></div>`;
      const o = openOverlay('sv-ask', html, () => { closeOverlay(); resolve(null); });
      const p = o.querySelector('#ap-pass');
      const ok = () => { const v = p.value; if (!v) { p.focus(); return; } closeOverlay(); resolve(v); };
      o.querySelector('#ap-ok').addEventListener('click', ok);
      p.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      o.querySelector('#ap-cancel').addEventListener('click', () => { closeOverlay(); resolve(null); });
      setTimeout(() => p.focus(), 50);
    });
  }
  function askCode(title, hint) {
    return new Promise((resolve) => {
      const html = `${headHtml(title)}
        <p class="sv-hint">${E(hint)}</p>${otpHtml('ac-code')}
        <div class="sv-err" id="sv-err" role="alert" hidden></div>
        <div class="sv-foot is-block">${btnHtml('', T('متابعة', 'Continue'), 'id="ac-ok"')}<button type="button" class="sv-link" id="ac-cancel">${E(T('إلغاء', 'Cancel'))}</button></div>`;
      const o = openOverlay('sv-ask', html, () => { closeOverlay(); resolve(null); });
      const root = o.querySelector('#ac-code');
      const ok = () => {
        const v = otpValue(root);
        if (v.length !== 6) { setErr(T('أدخل الرمز المكوّن من 6 أرقام.', 'Enter the 6-digit code.')); root.classList.add('is-error'); return; }
        closeOverlay(); resolve(v);
      };
      otpBind(root, ok);
      o.querySelector('#ac-ok').addEventListener('click', ok);
      o.querySelector('#ac-cancel').addEventListener('click', () => { closeOverlay(); resolve(null); });
      setTimeout(() => otpBoxes(root)[0]?.focus(), 50);
    });
  }

  async function cardAction(a, hostId) {
    try {
      if (a === 'totp-on') {
        const r = await api('/auth/totp/setup', { method: 'POST', body: '{}' });
        const html = `${headHtml(T('إعداد التحقق بخطوتين', 'Set up 2-Step Verification'))}
          <div id="sv-panel">${setupHtml(r)}</div>
          <div class="sv-foot"><button type="button" class="sv-link" id="ts-cancel">${E(T('إلغاء', 'Cancel'))}</button></div>`;
        const o = openOverlay('sv-setup', html, closeOverlay);
        o.querySelector('#ts-cancel').addEventListener('click', closeOverlay);
        V = { err: '' }; // lets setErr/failed write into this dialog
        bindSetup(async (code) => {
          const res = await api('/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ token: code }) });
          V = null;
          if (typeof currentUser !== 'undefined' && currentUser) { currentUser.totpEnabled = true; try { localStorage.setItem('user', JSON.stringify(currentUser)); } catch (_) {} }
          toastMsg(T('تم تفعيل Google Authenticator.', 'Google Authenticator has been enabled.'));
          showBackupCodes(res.backupCodes || [], () => renderSecurityCard(hostId, { force: true }));
        });
        return;
      }
      if (a === 'totp-off') {
        const pw = await askPassword(T('تعطيل Google Authenticator', 'Disable Google Authenticator'));
        if (!pw) return;
        // With a verified security email, a code sent to it is required too (server-enforced).
        let su = '';
        if (card && card.securityEmail && card.mailConfigured) {
          su = await stepUp('totp-disable');
          if (!su) return;
        }
        await api('/auth/totp/disable', { method: 'POST', headers: devHeaders(), body: JSON.stringify({ password: pw, stepUp: su }) });
        if (typeof currentUser !== 'undefined' && currentUser) { currentUser.totpEnabled = false; try { localStorage.setItem('user', JSON.stringify(currentUser)); } catch (_) {} }
        toastMsg(T('تم تعطيل Google Authenticator، وأُلغيت الثقة بالأجهزة الأخرى.', 'Google Authenticator has been disabled, and other devices were removed.'));
        return renderSecurityCard(hostId, { force: true });
      }
      if (a === 'backup') {
        const code = await askCode(T('رموز احتياطية جديدة', 'New backup codes'), T('أدخل رمزًا من Google Authenticator. ستتوقف الرموز القديمة عن العمل.', 'Enter a Google Authenticator code. The old codes stop working.'));
        if (!code) return;
        const r = await api('/auth/totp/backup-codes', { method: 'POST', body: JSON.stringify({ code }) });
        return showBackupCodes(r.backupCodes || [], () => renderSecurityCard(hostId, { force: true }));
      }
      if (a === 'email') {
        let su = '';
        if (card && (card.totpEnabled || (card.securityEmail && card.mailConfigured))) {
          su = await stepUp('security-email');
          if (!su) return;
        }
        return emailForm(hostId, su);
      }
      if (a === 'email-remove') {
        const pw = await askPassword(T('حذف بريد التحقق', 'Remove security email'));
        if (!pw) return;
        let su = '';
        if (card && (card.totpEnabled || (card.securityEmail && card.mailConfigured))) {
          su = await stepUp('security-email');
          if (!su) return;
        }
        await api('/auth/security/email/remove', { method: 'POST', body: JSON.stringify({ password: pw, stepUp: su }) });
        toastMsg(T('تم حذف بريد التحقق', 'Security email removed'));
        return renderSecurityCard(hostId, { force: true });
      }
      if (a === 'rev-all') {
        if (typeof showConfirm === 'function' && !(await showConfirm(T('ستُزال جميع الأجهزة الموثوقة الأخرى، ويبقى هذا الجهاز موثوقًا.', 'Every other trusted device will be removed. This device stays trusted.'), { title: T('إزالة جميع الأجهزة الأخرى', 'Remove all other devices'), danger: true, confirmLabel: T('إزالة', 'Remove') }))) return;
        const r = await api('/auth/trusted-devices/revoke-all', { method: 'POST', headers: devHeaders(), body: '{}' });
        toastMsg(T(`أُلغيت الثقة بـ ${r.revoked || 0} جهاز`, `${r.revoked || 0} device(s) removed`));
        return renderSecurityCard(hostId, { force: true });
      }
    } catch (e) {
      toastMsg(e.message, true);
    }
  }

  function emailForm(hostId, stepUpToken = '') {
    const box = document.getElementById('svs-email-form');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<label class="sv-label" for="se-mail">${E(T('البريد الإلكتروني', 'Email address'))}</label>
      <input id="se-mail" class="sv-input" type="email" dir="ltr" autocomplete="email" value="${E(card?.emailPending || '')}" placeholder="name@example.com">
      <label class="sv-label" for="se-pass">${E(T('كلمة المرور الحالية', 'Current password'))}</label>
      <input id="se-pass" class="sv-input" type="password" dir="ltr" autocomplete="current-password">
      <div class="sv-err" id="se-err" role="alert" hidden></div>
      <div class="svs-actions"><button type="button" class="sv-btn is-primary" id="se-send">${E(T('إرسال رمز التأكيد', 'Send confirmation code'))}</button><button type="button" class="sv-btn is-ghost" id="se-cancel">${E(T('إلغاء', 'Cancel'))}</button></div>`;
    const err = (m) => { const el = box.querySelector('#se-err'); el.textContent = m || ''; el.hidden = !m; };
    box.querySelector('#se-cancel').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
    box.querySelector('#se-send').addEventListener('click', async (ev) => {
      const email = box.querySelector('#se-mail').value.trim(), password = box.querySelector('#se-pass').value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err(T('عنوان البريد غير صحيح', 'Invalid email address')); return; }
      if (!password) { err(T('أدخل كلمة المرور الحالية', 'Enter your current password')); return; }
      ev.target.disabled = true;
      try {
        const r = await api('/auth/security/email/request', { method: 'POST', body: JSON.stringify({ email, password, stepUp: stepUpToken }) });
        box.innerHTML = `<p class="sv-hint">${E(T('أرسلنا رمزًا إلى', 'We sent a code to'))} <bdi dir="ltr" class="sv-mono">${E(r.sentTo)}</bdi>. ${E(T('أدخله هنا لتأكيد البريد (صالح 10 دقائق).', 'Enter it to confirm (valid 10 minutes).'))}</p>
          ${otpHtml('se-code')}<div class="sv-err" id="se-err" role="alert" hidden></div>
          <div class="svs-actions"><button type="button" class="sv-btn is-primary" id="se-ok">${E(T('تأكيد', 'Confirm'))}</button><button type="button" class="sv-btn is-ghost" id="se-cancel2">${E(T('إلغاء', 'Cancel'))}</button></div>`;
        const code = box.querySelector('#se-code'), ok = box.querySelector('#se-ok');
        const run = async () => {
          const v = otpValue(code);
          if (v.length !== 6) { err(T('أدخل الرمز المكوّن من 6 أرقام.', 'Enter the 6-digit code.')); code.classList.add('is-error'); return; }
          if (ok.disabled) return;
          ok.disabled = true;
          try {
            await api('/auth/security/email/confirm', { method: 'POST', body: JSON.stringify({ code: v }) });
            toastMsg(T('تم تأكيد بريد التحقق', 'Security email confirmed'));
            renderSecurityCard(hostId, { force: true });
          } catch (e) { ok.disabled = false; err(errText(e)); otpClear(code, true); }
        };
        otpBind(code, run);
        code.addEventListener('input', () => err(''));
        ok.addEventListener('click', run);
        box.querySelector('#se-cancel2').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
        setTimeout(() => otpBoxes(code)[0]?.focus(), 50);
      } catch (e) { ev.target.disabled = false; err(errText(e)); }
    });
    setTimeout(() => box.querySelector('#se-mail').focus(), 50);
  }

  /** Users page: another admin resets an account's 2FA (system PIN). */
  async function adminReset2fa(userId, name) {
    if (typeof openModal !== 'function' || typeof pinBoxesHtml !== 'function') return;
    openModal(`<div class="sv-adm"><h3 class="modal-head" style="margin:0 0 8px">${E(T('إعادة ضبط التحقق بخطوتين', 'Reset 2-Step Verification'))}</h3>
      <p class="sv-sub">${E(T(`سيُعطَّل Google Authenticator لحساب «${name}» وتُحذف رموزه الاحتياطية وتُلغى الثقة بكل أجهزته. يبقى بريد التحقق كما هو. استخدمه عند فقد الهاتف.`, `Google Authenticator for «${name}» will be disabled, its backup codes deleted and every trusted device removed. The security email stays. Use when the phone is lost.`))}</p>
      <div style="margin:14px 0 6px;font-size:.85rem;color:var(--muted)">${E(T('الرقم السري للنظام', 'System PIN'))}</div>
      ${pinBoxesHtml('sv-adm-pin', { start: true })}
      <div class="sv-err" id="sv-adm-err" role="alert" hidden></div>
      <div style="display:flex;gap:8px;margin-top:16px"><button type="button" class="btn btn-primary" id="sv-adm-ok" style="flex:1;background:var(--red);border-color:var(--red)">${E(T('إعادة الضبط', 'Reset'))}</button><button type="button" class="btn btn-outline" onclick="closeModal()" style="flex:1">${E(T('إلغاء', 'Cancel'))}</button></div></div>`, 'max-width:440px');
    const okBtn = document.getElementById('sv-adm-ok');
    okBtn.addEventListener('click', async () => {
      const pin = document.getElementById('sv-adm-pin')?.value || '';
      if (pin.length !== 4) { if (typeof _pinState === 'function') _pinState('sv-adm-pin', 'err'); return; }
      okBtn.disabled = true;
      try {
        await api('/auth/security/users/' + encodeURIComponent(userId) + '/reset-2fa', { method: 'POST', body: JSON.stringify({ pin }) });
        if (typeof _pinState === 'function') await _pinState('sv-adm-pin', 'ok');
        if (typeof closeModal === 'function') closeModal();
        toastMsg(T('تمت إعادة ضبط التحقق — سيُعدّه عند دخوله القادم', 'Verification reset — set it up again at the next sign-in'));
      } catch (e) {
        okBtn.disabled = false;
        if (e.code === 'PIN_WRONG' && typeof _pinState === 'function') _pinState('sv-adm-pin', 'err');
        const el = document.getElementById('sv-adm-err'); if (el) { el.textContent = e.message; el.hidden = false; }
      }
    });
    setTimeout(() => document.getElementById('sv-adm-pin')?.focus(), 60);
  }

  window.SouliaAuth = {
    verify, forgotPassword, deviceTokenFor, saveDeviceToken, forgetDeviceToken, currentDeviceToken,
    renderSecurityCard, openApproval: (id) => checkApprovals(id), checkApprovals, adminReset2fa, stepUp,
    loginText, loginError, applyLoginLang, solvePow, captchaToken, unlockStart, openLoginAlert: (id) => checkLoginAlerts(id),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initLoginLang); else initLoginLang();
})();
