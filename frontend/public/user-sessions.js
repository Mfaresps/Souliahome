/* «الجلسات والأجهزة» — sign-in sessions per account (Nov 27, 2026).
   Admin panel on the Users page: each account with its open sessions (devices), its last
   sign-in and a login history; any session can be ended («إنهاء الجلسة») or every device of an
   account signed out («خروج من كل الأجهزة»). The server (auth/user-sessions.service.ts) refuses
   an ended session's token, so the device is signed out on its next request or at once over
   the socket (`session:ended`).
   ⚠ Never route the logout call through api(): api() signs out on a 401, which would call it again. */
(function () {
  'use strict';
  const L = () => (typeof currentLang !== 'undefined' && currentLang === 'en' ? 'en' : 'ar');
  const T = (ar, en) => (L() === 'en' ? en : ar);
  const E = (v) => (typeof esc === 'function' ? esc(v) : String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const admin = () => typeof isAdmin === 'function' && isAdmin();

  const S = {
    data: null,          // overview
    loadedAt: 0,
    loading: null,
    error: '',
    tab: 'users',        // users | history
    q: '',
    filter: 'all',       // all | open | online
    open: new Set(),     // expanded account ids
    hist: { userId: '', status: '', page: 1, data: null, loading: false, error: '' },
    busy: new Set(),
    refreshTimer: null,
    showAll: false,      // «عرض كل المستخدمين»
  };

  // ── formatting ────────────────────────────────────────────────────────────
  const loc = () => (L() === 'en' ? 'en-US' : 'ar-EG-u-nu-latn');
  function ago(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!t) return '—';
    const s = Math.round((Date.now() - t) / 1000);
    const fut = s < 0, a = Math.abs(s);
    let v;
    if (a < 45) return fut ? T('خلال لحظات', 'in a moment') : T('الآن', 'just now');
    if (a < 3600) v = [Math.round(a / 60), T('دقيقة', 'min')];
    else if (a < 86400) v = [Math.round(a / 3600), T('ساعة', 'h')];
    else v = [Math.round(a / 86400), T('يوم', 'd')];
    if (L() === 'en') return fut ? `in ${v[0]}${v[1] === 'min' ? ' min' : v[1]}` : `${v[0]}${v[1] === 'min' ? ' min' : v[1]} ago`;
    return fut ? `بعد ${v[0]} ${v[1]}` : `قبل ${v[0]} ${v[1]}`;
  }
  function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString(loc(), { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' });
  }
  function duration(a, b) {
    const ms = new Date(b || Date.now()).getTime() - new Date(a).getTime();
    if (!(ms > 0)) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return T(`${m} دقيقة`, `${m} min`);
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 48) return r ? T(`${h} س ${r} د`, `${h}h ${r}m`) : T(`${h} ساعة`, `${h}h`);
    return T(`${Math.round(h / 24)} يوم`, `${Math.round(h / 24)} days`);
  }
  function place(s) {
    const l = s && s.location;
    // The server labels private addresses «محلي / شبكة داخلية» (geo-lookup.util.ts).
    if (l && l.city === 'محلي' && l.country === 'شبكة داخلية') return T('محلي، شبكة داخلية', 'Local network');
    const txt = l ? [l.city, l.country].filter(Boolean).join(L() === 'en' ? ', ' : '، ') : '';
    return txt || T('موقع غير معروف', 'Unknown location');
  }
  const DEVICE_EN = { 'كمبيوتر': 'Computer', 'موبايل': 'Phone', 'تابلت': 'Tablet', 'متصفح': 'Browser' };
  const dev = (v) => (L() === 'en' ? DEVICE_EN[v] || v : v) || '—';
  function deviceLine(s) {
    const b = dev(s.browser || ''), o = s.os || '';
    if (b && o) return T(`${b} على ${o}`, `${b} on ${o}`);
    return b || o || dev(s.device) || '—';
  }
  function methodLabel(m) {
    return m === 'totp' ? T('تحقق بخطوتين', '2-step code')
      : m === 'trusted-device' ? T('جهاز موثوق', 'Trusted device')
      : m === 'email' ? T('رمز عبر البريد', 'Email code')
      : m === 'approval' ? T('بموافقة من جهاز موثوق', 'Approved on a trusted device')
      : m === 'backup' ? T('رمز احتياطي', 'Backup code')
      : T('كلمة المرور', 'Password');
  }
  function roleLabel(r) {
    return r === 'admin' ? T('مدير', 'Admin') : r === 'viewer' ? T('مشاهد', 'Viewer') : T('موظف', 'Staff');
  }
  function statusChip(s) {
    if (s.status === 'active') return `<span class="uss-chip is-ok">${T('نشطة', 'Active')}</span>`;
    if (s.status === 'logged-out') return `<span class="uss-chip">${T('تسجيل خروج', 'Signed out')}</span>`;
    if (s.status === 'expired') return `<span class="uss-chip">${T('انتهت صلاحيتها', 'Expired')}</span>`;
    const by = s.endedBy && s.endedBy.name ? ` · <bdi>${E(s.endedBy.name)}</bdi>` : '';
    const what = s.endReason === 'revoked-all' ? T('خروج من كل الأجهزة', 'Signed out everywhere') : T('أُنهيت', 'Ended');
    return `<span class="uss-chip is-bad">${what}${by}</span>`;
  }

  // ── icons ─────────────────────────────────────────────────────────────────
  const SVG = (p, w = 16) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const IC = {
    laptop: SVG('<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>', 18),
    phone: SVG('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>', 18),
    tablet: SVG('<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M11 18.5h2"/>', 18),
    pin: SVG('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0116 0z"/><circle cx="12" cy="10" r="2.6"/>', 14),
    clock: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 14),
    login: SVG('<path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>', 14),
    out: SVG('<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>', 14),
    chev: SVG('<path d="M6 9l6 6 6-6"/>', 16),
    refresh: SVG('<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>', 14),
    shield: SVG('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 18),
    hist: SVG('<path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>', 14),
    search: SVG('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', 14),
  };
  const devIcon = (d) => (d === 'موبايل' ? IC.phone : d === 'تابلت' ? IC.tablet : IC.laptop);

  // ── data ──────────────────────────────────────────────────────────────────
  function load(force) {
    if (!admin()) return Promise.resolve();
    if (S.loading) return S.loading;
    if (!force && S.data && Date.now() - S.loadedAt < 20000) { render(); return Promise.resolve(); }
    if (!S.data) render();
    S.loading = api('/auth/sessions/overview', { background: true })
      .then((d) => { S.data = d; S.error = ''; S.loadedAt = Date.now(); })
      .catch((e) => { S.error = (e && e.message) || T('تعذّر تحميل الجلسات', 'Could not load sessions'); })
      .finally(() => { S.loading = null; render(); });
    return S.loading;
  }
  function loadHistory() {
    const h = S.hist;
    h.loading = true; h.error = ''; renderBody();
    const qs = new URLSearchParams({ page: String(h.page), limit: '10' });
    if (h.userId) qs.set('userId', h.userId);
    if (h.status) qs.set('status', h.status);
    return api('/auth/sessions?' + qs.toString(), { background: true })
      .then((d) => { h.data = d; })
      .catch((e) => { h.error = (e && e.message) || T('تعذّر تحميل السجل', 'Could not load the history'); })
      .finally(() => { h.loading = false; renderBody(); });
  }

  // ── render ────────────────────────────────────────────────────────────────
  function root() { return document.getElementById('active-sessions'); }

  function render() {
    const el = root();
    if (!el) return;
    if (!admin()) { el.innerHTML = ''; return; }
    if (!el.querySelector('.uss')) {
      el.innerHTML = `<section class="uss" aria-labelledby="uss-title">
        <header class="uss-head">
          <span class="uss-head-ic">${IC.shield}</span>
          <div class="uss-head-txt"><h3 id="uss-title">${T('الجلسات والأجهزة', 'Sessions & devices')}</h3>
            <p id="uss-stats"></p></div>
          <button type="button" class="uss-btn uss-refresh" data-act="refresh" title="${T('تحديث', 'Refresh')}" aria-label="${T('تحديث', 'Refresh')}">${IC.refresh}</button>
        </header>
        <div class="uss-bar">
          <nav class="uss-tabs" role="tablist">
            <button type="button" role="tab" data-tab="users">${T('حسب المستخدم', 'By user')}</button>
            <button type="button" role="tab" data-tab="history">${T('سجل الدخول', 'Sign-in history')}</button>
          </nav>
          <div class="uss-tools" id="uss-tools"></div>
        </div>
        <div class="uss-body" id="uss-body" aria-live="polite"></div>
      </section>`;
      // ⚠ Bound once: relabel() (a language switch) rebuilds this markup, and binding again would
      // run every action twice — e.g. «إنهاء الجلسة» would send two revokes.
      if (!el._ussBound) {
        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('change', onChange);
        el._ussBound = true;
      }
      drawTools();
    }
    el.querySelectorAll('.uss-tabs [data-tab]').forEach((b) => {
      const on = b.dataset.tab === S.tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    el.querySelector('.uss-refresh')?.classList.toggle('is-busy', !!S.loading);
    renderStats();
    renderBody();
  }

  function renderStats() {
    const box = document.getElementById('uss-stats');
    if (!box) return;
    const t = S.data && S.data.totals;
    // One quiet line instead of four tiles (owner, Nov 27: compact layout).
    if (!t) { box.textContent = S.error ? '' : T('جارٍ التحميل…', 'Loading…'); return; }
    const cell = (v, label, cls = '') => `<span class="uss-stat ${cls}"><b>${v}</b> ${label}</span>`;
    box.innerHTML = cell(t.activeSessions, T('جلسة مفتوحة', 'open sessions'))
      + cell(t.signedInUsers, T('مستخدم مسجّل', 'signed-in users'))
      + cell(t.onlineSessions, T('متصلة الآن', 'online now'), t.onlineSessions ? 'is-live' : '')
      + cell(t.newDevices24h, T('جهاز جديد خلال 24 ساعة', 'new devices (24h)'), t.newDevices24h ? 'is-warn' : '');
    box.title = box.textContent.replace(/\s+/g, ' ').trim();
  }

  function drawTools() {
    const box = document.getElementById('uss-tools');
    if (!box) return;
    if (S.tab === 'users') {
      const opt = (k, label) => `<option value="${k}"${S.filter === k ? ' selected' : ''}>${label}</option>`;
      box.innerHTML = `<label class="uss-search">${IC.search}<input type="search" id="uss-q" placeholder="${T('بحث عن مستخدم...', 'Search users...')}" value="${E(S.q)}" autocomplete="off"></label>
        <select id="uss-filter" aria-label="${T('تصفية', 'Filter')}">${opt('all', T('كل المستخدمين', 'All users'))}${opt('open', T('لديه جلسات مفتوحة', 'Has open sessions'))}${opt('online', T('متصل الآن', 'Online now'))}</select>`;
    } else {
      const accounts = (S.data && S.data.accounts) || [];
      const opts = accounts.slice().sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username))
        .map((a) => `<option value="${E(a.userId)}"${S.hist.userId === a.userId ? ' selected' : ''}>${E(a.name || a.username)}</option>`).join('');
      const st = [['', T('كل الحالات', 'All states')], ['active', T('نشطة', 'Active')], ['logged-out', T('تسجيل خروج', 'Signed out')],
        ['revoked', T('أُنهيت', 'Ended')], ['expired', T('انتهت صلاحيتها', 'Expired')], ['new-device', T('جهاز جديد', 'New device')]]
        .map(([v, l]) => `<option value="${v}"${S.hist.status === v ? ' selected' : ''}>${l}</option>`).join('');
      box.innerHTML = `<select id="uss-h-user" aria-label="${T('المستخدم', 'User')}"><option value="">${T('كل المستخدمين', 'All users')}</option>${opts}</select>
        <select id="uss-h-status" aria-label="${T('الحالة', 'State')}">${st}</select>`;
    }
  }

  function renderBody() {
    const body = document.getElementById('uss-body');
    if (!body) return;
    if (S.tab === 'history') { body.innerHTML = historyHtml(); return; }
    if (!S.data) {
      body.innerHTML = S.error
        ? `<div class="uss-state is-err">${E(S.error)} <button type="button" class="uss-link" data-act="refresh">${T('إعادة المحاولة', 'Retry')}</button></div>`
        : '<div class="uss-sk"></div><div class="uss-sk"></div><div class="uss-sk"></div>';
      return;
    }
    const q = (S.q || '').trim().toLowerCase();
    // A reply without an account list must not take the whole Users page down (renderUsers calls load()).
    let list = (Array.isArray(S.data.accounts) ? S.data.accounts : []).slice();
    if (q) list = list.filter((a) => [a.name, a.username, a.jobTitle].some((v) => String(v || '').toLowerCase().includes(q)));
    if (S.filter === 'open') list = list.filter((a) => a.activeCount > 0 || legacyOf(a.userId).length);
    if (S.filter === 'online') list = list.filter((a) => a.online);
    list.sort((a, b) => (b.online - a.online) || (b.activeCount - a.activeCount)
      || (new Date(b.lastLoginAt || 0) - new Date(a.lastLoginAt || 0)));
    if (!list.length) {
      body.innerHTML = `<div class="uss-state">${q || S.filter !== 'all' ? T('لا يوجد مستخدم يطابق البحث أو التصفية', 'No user matches the search or filter') : T('لا يوجد مستخدمون', 'No users')}</div>`;
      return;
    }
    // The first 8 accounts (online / with open sessions first); the rest behind «عرض الكل» — no long scroll.
    // A search, a filter or an account opened from elsewhere (focusUser) shows every match.
    const cut = !S.showAll && !q && S.filter === 'all' && list.length > ACCT_PREVIEW;
    const shown = cut ? list.filter((a, i) => i < ACCT_PREVIEW || S.open.has(a.userId)) : list;
    const more = list.length > ACCT_PREVIEW && !q && S.filter === 'all'
      ? `<button type="button" class="uss-more" data-act="show-all">${S.showAll ? T('عرض أقل', 'Show less') : T(`عرض كل المستخدمين (${list.length})`, `Show all users (${list.length})`)}</button>` : '';
    body.innerHTML = `<div class="uss-accts">${shown.map(accountHtml).join('')}</div>${more}`;
  }
  const ACCT_PREVIEW = 8;

  function legacyOf(userId) {
    return ((S.data && S.data.legacySockets) || []).filter((s) => s.userId === userId);
  }

  function accountHtml(a) {
    const open = S.open.has(a.userId);
    const legacy = legacyOf(a.userId);
    const me = typeof currentUser !== 'undefined' && currentUser && String(currentUser.id || currentUser._id || '') === a.userId;
    const avatar = typeof userAvatarHtml === 'function'
      ? userAvatarHtml({ _id: a.userId, name: a.name, username: a.username, avatar: a.avatar }, 26)
      : `<span class="uss-ini">${E((a.name || a.username || '?').slice(0, 2))}</span>`;
    // ONE line per account (owner, Nov 27): name · presence · last sign-in · open sessions — the role,
    // job title and the full last-sign-in details are in the tooltips.
    const presence = a.online
      ? `<span class="uss-pres is-on"><i></i>${T('متصل الآن', 'Online now')}</span>`
      : `<span class="uss-pres"><i></i>${a.lastSeen ? ago(a.lastSeen) : T('غير متصل', 'Offline')}</span>`;
    const ll = a.lastLogin;
    const lastTitle = ll ? `${T('آخر دخول', 'Last sign-in')}: ${when(ll.createdAt)} · ${deviceLine(ll)} · ${place(ll)}${ll.ip ? ' · ' + ll.ip : ''}`
      : a.lastLoginAt ? `${T('آخر دخول', 'Last sign-in')}: ${when(a.lastLoginAt)}` : T('لم يسجّل الدخول بعد', 'Never signed in');
    const lastLine = ll
      ? `${IC.login}<span>${ago(ll.createdAt)} · <bdi>${E(deviceLine(ll))}</bdi> · ${E(place(ll))}</span>`
      : a.lastLoginAt
        ? `${IC.login}<span>${ago(a.lastLoginAt)}</span>`
        : `${IC.login}<span>${T('لم يسجّل الدخول بعد', 'Never signed in')}</span>`;
    const count = a.activeCount + legacy.length;
    const countChip = count
      ? `<span class="uss-count${a.onlineCount ? ' is-live' : ''}" title="${T('جلسات مفتوحة · أجهزة مختلفة', 'Open sessions · distinct devices')}"><b>${count}</b> ${count === 1 ? T('جلسة', 'session') : T('جلسات', 'sessions')}${a.deviceCount > 1 ? ` · ${a.deviceCount} ${T('أجهزة', 'devices')}` : ''}</span>`
      : `<span class="uss-count is-zero">${T('لا جلسات', 'No sessions')}</span>`;
    const canAll = count > 0;
    const allLabel = me ? T('خروج من الأجهزة الأخرى', 'Sign out other devices') : T('خروج من كل الأجهزة', 'Sign out everywhere');
    const subTitle = `@${a.username} · ${roleLabel(a.role)}${a.jobTitle ? ' · ' + (typeof jobTitleLabel === 'function' ? jobTitleLabel(a.jobTitle) : a.jobTitle) : ''}`;
    return `<article class="uss-acct${open ? ' is-open' : ''}${a.isActive ? '' : ' is-disabled'}" data-user="${E(a.userId)}">
      <div class="uss-acct-row">
        <button type="button" class="uss-acct-main" data-act="toggle" aria-expanded="${open}">
          <span class="uss-av">${avatar}${a.online ? '<i class="uss-av-dot"></i>' : ''}</span>
          <span class="uss-name" title="${E(subTitle)}"><bdi>${E(a.name || a.username)}</bdi><bdi class="uss-handle">@${E(a.username)}</bdi>${me ? `<span class="uss-tag">${T('أنت', 'You')}</span>` : ''}${a.isActive ? '' : `<span class="uss-tag is-bad">${T('معطّل', 'Disabled')}</span>`}</span>
          ${presence}
          <span class="uss-last" title="${E(lastTitle)}">${lastLine}</span>
          ${countChip}
          <span class="uss-chev">${IC.chev}</span>
        </button>
        ${canAll ? `<button type="button" class="uss-btn is-danger uss-all" data-act="revoke-all" title="${allLabel}" aria-label="${allLabel}" ${S.busy.has('all:' + a.userId) ? 'disabled' : ''}>${IC.out}</button>` : ''}
      </div>
      ${open ? panelHtml(a, legacy) : ''}
    </article>`;
  }

  function panelHtml(a, legacy) {
    const cards = a.sessions.map(sessionCardHtml).join('') + legacy.map(legacyCardHtml).join('');
    const foot = `<div class="uss-panel-foot">
      <span>${T('عدد مرات الدخول المسجلة', 'Recorded sign-ins')}: <b>${a.loginCount}</b> · ${T('أجهزة مختلفة استُخدمت', 'Distinct devices used')}: <b>${a.knownDevices}</b></span>
      <button type="button" class="uss-link" data-act="history-of">${IC.hist}<span>${T('سجل دخول هذا المستخدم', "This user's sign-in history")}</span></button></div>`;
    return `<div class="uss-panel">${cards ? `<div class="uss-sess">${cards}</div>` : `<div class="uss-state">${T('لا توجد جلسات مفتوحة لهذا المستخدم الآن.', 'This user has no open sessions now.')}</div>`}${foot}</div>`;
  }

  // One line per open session (device · method · place · started · last active), details in the tooltip.
  function sessionCardHtml(s) {
    const tags = [];
    if (s.current) tags.push(`<span class="uss-tag is-me">${T('هذا الجهاز', 'This device')}</span>`);
    if (s.online) tags.push(`<span class="uss-tag is-live"><i></i>${T('مفتوح الآن', 'Open now')}</span>`);
    if (s.newDevice) tags.push(`<span class="uss-tag is-warn" title="${T('أول دخول لهذا الحساب من هذا النوع من الأجهزة والمتصفح', 'First sign-in of this account from this kind of device and browser')}">${T('جهاز جديد', 'New device')}</span>`);
    const busy = S.busy.has('s:' + s.id);
    const btn = s.current
      ? `<span class="uss-cur" title="${T('هذه جلستك الحالية — استخدم «تسجيل الخروج»', 'This is your current session — use Sign out')}">${T('جلستك', 'Yours')}</span>`
      : `<button type="button" class="uss-btn is-danger is-sm" data-act="revoke" data-sid="${E(s.id)}" ${busy ? 'disabled' : ''}>${busy ? T('جارٍ الإنهاء…', 'Ending…') : T('إنهاء', 'End')}</button>`;
    const title = `${deviceLine(s)} · ${dev(s.device)} · ${methodLabel(s.method)} — ${T('المكان', 'Place')}: ${place(s)} · ${s.ip || '—'} — ${T('بدأت', 'Signed in')}: ${when(s.createdAt)} — ${T('آخر نشاط', 'Last active')}: ${ago(s.lastSeenAt)} — ${T('تنتهي', 'Expires')}: ${when(s.expiresAt)}`;
    return `<div class="uss-srow${s.current ? ' is-current' : ''}" title="${E(title)}">
      <span class="uss-dev">${devIcon(s.device)}</span>
      <span class="uss-sdev"><bdi>${E(deviceLine(s))}</bdi><small>${methodLabel(s.method)}</small></span>
      <span class="uss-splace">${E(place(s))} · <bdi class="uss-ip">${E(s.ip || '—')}</bdi></span>
      <span class="uss-stime">${ago(s.createdAt)}<small>${T('آخر نشاط', 'active')} ${ago(s.lastSeenAt)}</small></span>
      <span class="uss-tags">${tags.join('')}</span>
      ${btn}
    </div>`;
  }

  function legacyCardHtml(s) {
    const note = T('دخول قبل تفعيل سجل الجلسات — يُنهى بزر «خروج من كل الأجهزة» فقط، أو ينتهي وحده عند انتهاء صلاحية الدخول.', 'Signed in before session history began — ended only with «Sign out everywhere», or by itself when the sign-in expires.');
    return `<div class="uss-srow is-legacy" title="${E(note)}">
      <span class="uss-dev">${devIcon(s.device)}</span>
      <span class="uss-sdev"><bdi>${E(deviceLine(s))}</bdi><small>${T('قبل سجل الجلسات', 'before session history')}</small></span>
      <span class="uss-splace">${E(place(s))} · <bdi class="uss-ip">${E(s.ip || '—')}</bdi></span>
      <span class="uss-stime">${ago(s.lastActivity || s.connectedAt)}</span>
      <span class="uss-tags"><span class="uss-tag is-live"><i></i>${T('مفتوح الآن', 'Open now')}</span></span>
      <span></span>
    </div>`;
  }

  function historyHtml() {
    const h = S.hist;
    if (h.loading && !h.data) return '<div class="uss-sk"></div><div class="uss-sk"></div>';
    if (h.error) return `<div class="uss-state is-err">${E(h.error)} <button type="button" class="uss-link" data-act="history-reload">${T('إعادة المحاولة', 'Retry')}</button></div>`;
    const d = h.data;
    if (!d) return '';
    if (!d.rows.length) {
      return `<div class="uss-state">${h.userId || h.status ? T('لا توجد عمليات دخول تطابق التصفية', 'No sign-ins match the filter') : T('لم تُسجَّل أي عملية دخول بعد', 'No sign-ins recorded yet')}</div>`;
    }
    const rows = d.rows.map((s) => `<tr class="${s.current ? 'is-current' : ''}">
        <td data-l="${T('المستخدم', 'User')}"><b><bdi>${E(s.name || s.username)}</bdi></b><small><bdi>@${E(s.username)}</bdi></small></td>
        <td data-l="${T('وقت الدخول', 'Signed in')}">${when(s.createdAt)}<small>${ago(s.createdAt)}</small></td>
        <td data-l="${T('الجهاز', 'Device')}"><span class="uss-td-dev">${devIcon(s.device)}<span><bdi>${E(deviceLine(s))}</bdi><small>${E(dev(s.device))}${s.newDevice ? ` · <em class="uss-new">${T('جهاز جديد', 'New device')}</em>` : ''}</small></span></span></td>
        <td data-l="${T('المكان', 'Place')}">${E(place(s))}<small><bdi class="uss-ip">${E(s.ip || '—')}</bdi></small></td>
        <td data-l="${T('الطريقة', 'Method')}">${methodLabel(s.method)}</td>
        <td data-l="${T('الحالة', 'State')}">${statusChip(s)}${s.current ? `<small>${T('هذا الجهاز', 'This device')}</small>` : ''}</td>
        <td data-l="${T('المدة', 'Duration')}">${duration(s.createdAt, s.endedAt || (s.status === 'expired' ? s.expiresAt : (s.status === 'active' ? null : s.lastSeenAt)))}</td>
        <td class="uss-td-act">${s.status === 'active' && !s.current ? `<button type="button" class="uss-btn is-danger is-sm" data-act="revoke" data-sid="${E(s.id)}" ${S.busy.has('s:' + s.id) ? 'disabled' : ''}>${T('إنهاء', 'End')}</button>` : ''}</td>
      </tr>`).join('');
    const pager = d.pages > 1 ? `<div class="uss-pager">
        <button type="button" class="uss-btn" data-act="page" data-p="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>${T('السابق', 'Previous')}</button>
        <span>${T(`صفحة ${d.page} من ${d.pages}`, `Page ${d.page} of ${d.pages}`)} · ${d.total} ${T('عملية دخول', 'sign-ins')}</span>
        <button type="button" class="uss-btn" data-act="page" data-p="${d.page + 1}" ${d.page >= d.pages ? 'disabled' : ''}>${T('التالي', 'Next')}</button></div>`
      : `<div class="uss-pager"><span>${d.total} ${T('عملية دخول', 'sign-ins')}</span></div>`;
    const keep = S.data && S.data.retentionDays ? `<p class="uss-note">${T(`يُحتفظ بسجل الدخول ${S.data.retentionDays} يومًا.`, `Sign-in history is kept for ${S.data.retentionDays} days.`)}</p>` : '';
    return `<div class="uss-hist${h.loading ? ' is-loading' : ''}"><table class="uss-table"><thead><tr>
      <th>${T('المستخدم', 'User')}</th><th>${T('وقت الدخول', 'Signed in')}</th><th>${T('الجهاز', 'Device')}</th><th>${T('المكان', 'Place')}</th>
      <th>${T('الطريقة', 'Method')}</th><th>${T('الحالة', 'State')}</th><th>${T('المدة', 'Duration')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${pager}${keep}`;
  }

  // ── actions ───────────────────────────────────────────────────────────────
  function findSession(sid) {
    for (const a of (S.data && S.data.accounts) || []) {
      const s = a.sessions.find((x) => x.id === sid);
      if (s) return s;
    }
    return ((S.hist.data && S.hist.data.rows) || []).find((x) => x.id === sid) || null;
  }

  async function revoke(sid) {
    const s = findSession(sid);
    const who = s ? s.name || s.username : '';
    const ok = await showConfirm(T('سيُسجَّل خروج هذا الجهاز فورًا، وسيحتاج إلى تسجيل الدخول مرة أخرى.', 'This device will be signed out immediately and will need to sign in again.'), {
      title: T('إنهاء الجلسة', 'End session'), icon: 'warn', danger: true, confirmLabel: T('إنهاء الجلسة', 'End session'),
      rows: s ? [[T('المستخدم', 'User'), who], [T('الجهاز', 'Device'), deviceLine(s)], [T('المكان', 'Place'), `${place(s)} · ${s.ip || '—'}`], [T('بدأت', 'Signed in'), when(s.createdAt)]] : [],
    });
    if (!ok) return;
    S.busy.add('s:' + sid); renderBody();
    try {
      await api(`/auth/sessions/${encodeURIComponent(sid)}/revoke`, { method: 'POST', body: '{}' });
      toast(T('تم إنهاء الجلسة', 'Session ended'));
    } catch (e) {
      toast((e && e.message) || T('تعذّر إنهاء الجلسة', 'Could not end the session'), true);
    } finally {
      S.busy.delete('s:' + sid);
      await load(true);
      if (S.tab === 'history') loadHistory();
    }
  }

  async function revokeAll(userId) {
    const a = ((S.data && S.data.accounts) || []).find((x) => x.userId === userId);
    if (!a) return;
    const me = typeof currentUser !== 'undefined' && currentUser && String(currentUser.id || currentUser._id || '') === userId;
    const n = a.activeCount + legacyOf(userId).length;
    const ok = await showConfirm(me
      ? T('سيُسجَّل خروجك من كل أجهزتك الأخرى، ويبقى هذا الجهاز مسجّلًا.', 'You will be signed out of all your other devices; this device stays signed in.')
      : T(`سيُسجَّل خروج «${a.name || a.username}» من كل الأجهزة فورًا، وسيحتاج إلى تسجيل الدخول مرة أخرى على أي جهاز.`, `"${a.name || a.username}" will be signed out of every device immediately and must sign in again.`), {
      title: me ? T('خروج من الأجهزة الأخرى', 'Sign out other devices') : T('خروج من كل الأجهزة', 'Sign out everywhere'),
      icon: 'warn', danger: true, confirmLabel: T('تسجيل الخروج', 'Sign out'),
      rows: [[T('الجلسات المفتوحة', 'Open sessions'), String(n)], [T('المتصلة الآن', 'Open now'), String(a.onlineCount)]],
    });
    if (!ok) return;
    S.busy.add('all:' + userId); renderBody();
    try {
      const r = await api(`/auth/sessions/user/${encodeURIComponent(userId)}/revoke-all`, { method: 'POST', body: '{}' });
      toast(T(`تم إنهاء ${r.ended || 0} جلسة`, `${r.ended || 0} session(s) ended`));
    } catch (e) {
      toast((e && e.message) || T('تعذّر تسجيل الخروج', 'Could not sign out'), true);
    } finally {
      S.busy.delete('all:' + userId);
      await load(true);
    }
  }

  function setTab(tab) {
    S.tab = tab === 'history' ? 'history' : 'users';
    drawTools();
    render();
    if (S.tab === 'history' && !S.hist.data && !S.hist.loading) loadHistory();
  }

  function onClick(e) {
    const tabBtn = e.target.closest('.uss-tabs [data-tab]');
    if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
    const f = e.target.closest('[data-filter]');
    if (f) { S.filter = f.dataset.filter; drawTools(); renderBody(); return; }
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const acct = b.closest('[data-user]');
    const userId = acct ? acct.dataset.user : '';
    switch (b.dataset.act) {
      case 'refresh': load(true); if (S.tab === 'history') loadHistory(); break;
      case 'toggle': S.open.has(userId) ? S.open.delete(userId) : S.open.add(userId); renderBody(); break;
      case 'revoke': revoke(b.dataset.sid); break;
      case 'revoke-all': revokeAll(userId); break;
      case 'history-of': S.hist.userId = userId; S.hist.status = ''; S.hist.page = 1; S.hist.data = null; setTab('history'); break;
      case 'history-reload': loadHistory(); break;
      case 'page': S.hist.page = Math.max(1, Number(b.dataset.p) || 1); loadHistory(); break;
      case 'show-all': S.showAll = !S.showAll; renderBody(); break;
    }
  }
  function onInput(e) {
    if (e.target.id === 'uss-q') { S.q = e.target.value; renderBody(); }
  }
  function onChange(e) {
    if (e.target.id === 'uss-filter') { S.filter = e.target.value; renderBody(); }
    if (e.target.id === 'uss-h-user') { S.hist.userId = e.target.value; S.hist.page = 1; loadHistory(); }
    if (e.target.id === 'uss-h-status') { S.hist.status = e.target.value; S.hist.page = 1; loadHistory(); }
  }

  // ── signed out by the server ──────────────────────────────────────────────
  /* The server sends one Arabic sentence (backend user-sessions.util.ts `endedMessage`).
     It is read here for its kind and the name of who ended it, and the dialog writes its own
     text in the system language. ⚠ Keep the keywords in step with `endedMessage`; an unknown
     sentence falls back to the generic «session ended». */
  function endedKind(message) {
    const s = String(message || '');
    const by = (s.match(/بواسطة\s+(.+?)\s+—/) || [])[1] || '';
    if (s.includes('كل الأجهزة')) return { kind: 'all', by };
    if (s.includes('تسجيل الخروج من هذه الجلسة')) return { kind: 'logout', by: '' };
    if (s.includes('إنهاء جلستك')) return { kind: 'revoked', by };
    return { kind: 'ended', by: '' };
  }
  function endedText({ kind, by }) {
    const who = by ? `<bdi>${E(by)}</bdi>` : '';
    switch (kind) {
      case 'revoked': return {
        title: T('تم إنهاء الجلسة', 'Session ended'),
        body: who ? T(`أنهى ${who} جلستك على هذا الجهاز.`, `${who} ended your session on this device.`)
                  : T('أُنهيت جلستك على هذا الجهاز.', 'Your session on this device was ended.') };
      case 'all': return {
        title: T('تم تسجيل الخروج من جميع الأجهزة', 'Signed out of all devices'),
        body: who ? T(`سجّل ${who} خروج حسابك من جميع الأجهزة.`, `${who} signed your account out of all devices.`)
                  : T('تم تسجيل خروج حسابك من جميع الأجهزة.', 'Your account was signed out of all devices.') };
      case 'logout': return {
        title: T('تم تسجيل الخروج', 'Signed out'),
        body: T('تم تسجيل الخروج من هذه الجلسة.', 'You have been signed out of this session.') };
      default: return {
        title: T('انتهت صلاحية الجلسة', 'Session expired'),
        body: T('انتهت صلاحية جلستك على هذا الجهاز.', 'Your session on this device has expired.') };
    }
  }
  function showEnded(message) {
    document.getElementById('uss-ended')?.remove();
    const { title, body } = endedText(endedKind(message));
    const d = document.createElement('div');
    d.id = 'uss-ended';
    d.dir = L() === 'en' ? 'ltr' : 'rtl';
    d.setAttribute('role', 'alertdialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-labelledby', 'uss-ended-title');
    d.setAttribute('aria-describedby', 'uss-ended-msg');
    d.innerHTML = `<div class="uss-ended-card"><span class="uss-ended-ic">${IC.out}</span>
      <h2 id="uss-ended-title">${E(title)}</h2>
      <p id="uss-ended-msg">${body}<br>${E(T('يُرجى تسجيل الدخول مرة أخرى للمتابعة.', 'Please sign in again to continue.'))}</p>
      <button type="button" class="uss-btn is-primary">${E(T('تسجيل الدخول', 'Sign in'))}</button></div>`;
    d.querySelector('button').addEventListener('click', () => {
      d.remove();
      document.getElementById('login-user')?.focus();
    });
    document.body.appendChild(d);
    d.querySelector('button').focus();
  }

  /** Tells the server this device signed out. Plain fetch — never api() (see header). */
  function notifyLogout(token) {
    if (!token) return;
    try {
      fetch((typeof API_BASE !== 'undefined' ? API_BASE : '/api') + '/auth/logout', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: '{}',
      }).catch(() => {});
    } catch (_) { /* signing out never waits for this */ }
  }

  /** Presence changed (socket) — refresh the panel, at most every 3 s, only while it is shown. */
  function onPresence() {
    if (!admin() || typeof currentPage === 'undefined' || currentPage !== 'users') return;
    if (S.refreshTimer) return;
    S.refreshTimer = setTimeout(() => { S.refreshTimer = null; load(true); }, Math.max(0, 3000 - (Date.now() - S.loadedAt)));
  }

  /** Opens the panel on one account (from the users table menu). */
  function focusUser(userId) {
    if (!admin()) return;
    S.tab = 'users'; S.q = ''; S.filter = 'all'; S.open.add(String(userId));
    drawTools(); render();
    load(true).then(() => {
      const el = document.querySelector(`.uss-acct[data-user="${CSS.escape(String(userId))}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('is-flash'); setTimeout(() => el.classList.remove('is-flash'), 1600); }
    });
  }

  /** The session id inside the stored token ('' for an old token or none). */
  function currentSid() {
    try {
      const t = localStorage.getItem('token') || '';
      const part = t.split('.')[1];
      if (!part) return '';
      return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).sid || '';
    } catch (_) { return ''; }
  }

  window.SouliaSessions = { load, render, onPresence, focusUser, showEnded, notifyLogout, currentSid, relabel: () => { const el = root(); if (el) el.innerHTML = ''; render(); } };
})();
