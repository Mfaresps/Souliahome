/* «دعوة موظف» — invite a new employee by email (Nov 28, 2026). window.SouliaInvites
 * The admin picks the address, the role (required) and an optional job title; the server emails a
 * link (/join/<token>) and returns it too, so it can be sent by hand. Pending invitations are listed
 * on the Users page (#users-invites-wrap) with copy / re-send / cancel. */
(function () {
  'use strict';
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const T = (ar, enText) => (en() ? enText : ar);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (m, bad) => { if (typeof toast === 'function') toast(m, bad); };
  const admin = () => typeof isAdmin === 'function' && isAdmin();
  const locale = () => (en() ? 'en-GB' : 'ar-EG-u-nu-latn');
  const when = (d) => { try { return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(d)); } catch { return ''; } };
  const errMsg = (e) => {
    const code = e?.data?.code || e?.code || '';
    const map = {
      EMAIL_TAKEN: 'This email is linked to another account.', INVITE_EXISTS: 'An invitation is still open for this email. Re-send it or cancel it.',
      EMAIL_INVALID: 'The email address is not valid.', ROLE_REQUIRED: 'Choose the employee’s role.', ROLE_NOT_INVITABLE: 'Admin accounts are not invited. Create them from «Add user».',
      INVITE_RATE_LIMITED: 'Too many invitations. Try again later.', INVITE_NOT_FOUND: 'The invitation no longer exists.',
    };
    return (en() && map[code]) || e?.message || T('تعذّر تنفيذ الطلب.', 'The request failed.');
  };

  const ICON = {
    mail: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z"/><polyline points="22 6 12 13 2 6"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };

  // ─── Copy (works on plain-http LAN, where navigator.clipboard is missing) ───
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }

  // ─── The window ──────────────────────────────────────────────────────────
  let dlg = null;
  function dialog() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'uinv-dlg'; dlg.id = 'uinv-dialog';
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      // Escape with a dropdown open closes the dropdown only.
      if (typeof _pmSelOpen !== 'undefined' && _pmSelOpen) { if (typeof _pmSelClose === 'function') _pmSelClose(); return; }
      close();
    });
    document.body.appendChild(dlg);
    return dlg;
  }
  function close() {
    if (typeof _pmSelOpen !== 'undefined' && _pmSelOpen && typeof _pmSelClose === 'function') _pmSelClose();
    if (dlg?.open) dlg.close();
  }

  function roleOptions(roles) {
    const R = window.SouliaRBAC;
    const list = (roles || []).filter((r) => r.slug !== 'super-admin' && r.slug !== 'admin');
    return `<option value="">${esc(T('— اختر الدور —', '— Choose a role —'))}</option>` + list.map((r) =>
      `<option value="${esc(r.slug)}">${esc(R?.roleName ? R.roleName(r) : r.name)}</option>`).join('');
  }
  function jobOptions() {
    const groups = typeof JOB_TITLE_GROUPS !== 'undefined' ? JOB_TITLE_GROUPS : [];
    return `<option value="">${esc(T('— بدون —', '— None —'))}</option>` + groups.map((g) =>
      `<optgroup label="${esc(en() ? g.en : g.ar)}">${g.items.map((i) => `<option value="${esc(i.value)}">${esc(en() ? i.value : i.ar)}</option>`).join('')}</optgroup>`).join('');
  }

  async function open() {
    if (!admin()) return;
    const d = dialog();
    d.innerHTML = `<div class="uinv-card"><div class="uinv-loading"><span class="uinv-spin"></span></div></div>`;
    if (!d.open) d.showModal();
    let roles = [];
    try { roles = await window.SouliaRBAC?.ensure() || []; } catch { /* shown below */ }
    renderForm(roles);
  }

  function renderForm(roles, keep = {}) {
    const d = dialog();
    d.innerHTML = `<form class="uinv-card" id="uinv-form" novalidate>
      <header class="uinv-head">
        <span class="uinv-ic">${ICON.mail}</span>
        <div><h2>${esc(T('دعوة موظف جديد', 'Invite a new employee'))}</h2>
        <p>${esc(T('يصل إلى الموظف رابط على بريده الإلكتروني لينشئ حسابه بنفسه.', 'The employee gets a link by email and creates the account themselves.'))}</p></div>
        <button type="button" class="uinv-x" data-close aria-label="${esc(T('إغلاق', 'Close'))}">${ICON.x}</button>
      </header>
      <div class="uinv-body">
        <label class="uinv-field"><span>${esc(T('البريد الإلكتروني', 'Email'))} <b>*</b></span>
          <input id="uinv-email" type="email" dir="ltr" autocomplete="off" placeholder="name@example.com" value="${esc(keep.email || '')}"></label>
        <label class="uinv-field"><span>${esc(T('الدور', 'Role'))} <b>*</b></span>
          <select id="uinv-role">${roleOptions(roles)}</select>
          <small>${esc(T('يحدد صلاحيات الموظف، ويظهر له في رسالة الدعوة.', 'Sets the employee’s permissions; shown to them in the invitation.'))}</small></label>
        <label class="uinv-field"><span>${esc(T('المسمى الوظيفي', 'Job title'))} <i>${esc(T('(اختياري)', '(optional)'))}</i></span>
          <select id="uinv-job">${jobOptions()}</select></label>
        <p class="uinv-err" id="uinv-err" role="alert" hidden></p>
      </div>
      <footer class="uinv-foot">
        <button type="button" class="btn btn-outline" data-close>${esc(T('إلغاء', 'Cancel'))}</button>
        <button type="submit" class="btn btn-primary" id="uinv-send">${ICON.send}<span>${esc(T('إرسال الدعوة', 'Send invitation'))}</span></button>
      </footer>
    </form>`;
    if (keep.role) d.querySelector('#uinv-role').value = keep.role;
    if (keep.job) d.querySelector('#uinv-job').value = keep.job;
    // The app's own dropdown (searchable, styled, opens inside the dialog's top layer) — never the OS list.
    if (typeof _pmEnhanceSelects === 'function') _pmEnhanceSelects(d);
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    d.querySelector('#uinv-form').addEventListener('submit', (e) => { e.preventDefault(); submit(roles); });
    setTimeout(() => d.querySelector('#uinv-email')?.focus(), 30);
  }

  function showErr(msg, focus) {
    const el = dlg?.querySelector('#uinv-err');
    if (el) { el.textContent = msg; el.hidden = !msg; }
    if (focus) dlg?.querySelector(focus)?.focus();
  }

  async function submit(roles) {
    const d = dialog();
    const email = d.querySelector('#uinv-email').value.trim();
    const roleId = d.querySelector('#uinv-role').value;
    const job = d.querySelector('#uinv-job').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showErr(T('عنوان البريد الإلكتروني غير صحيح.', 'The email address is not valid.'), '#uinv-email');
    if (!roleId) return showErr(T('اختر دور الموظف.', 'Choose the employee’s role.'), '#uinv-role');
    showErr('');
    const btn = d.querySelector('#uinv-send');
    btn.disabled = true; btn.classList.add('is-busy');
    const role = (roles || []).find((r) => r.slug === roleId);
    const jobItem = typeof JOB_TITLE_MAP !== 'undefined' ? JOB_TITLE_MAP[job] : null;
    try {
      const res = await api('/invitations', { method: 'POST', body: JSON.stringify({
        email, roleId, jobTitle: job, origin: location.origin,
        roleLabel: window.SouliaRBAC?.roleNameAr ? window.SouliaRBAC.roleNameAr(role) : (role?.name || ''),
        jobTitleLabel: jobItem?.ar || job,
      }) });
      renderResult(res, roles);
      load();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('is-busy');
      const code = e?.data?.code || e?.code || '';
      showErr(errMsg(e), code === 'EMAIL_TAKEN' || code === 'INVITE_EXISTS' || code === 'EMAIL_INVALID' ? '#uinv-email' : null);
    }
  }

  function linkBox(link) {
    return `<div class="uinv-link"><input readonly dir="ltr" value="${esc(link)}" aria-label="${esc(T('رابط الدعوة', 'Invitation link'))}" onfocus="this.select()">
      <button type="button" class="btn btn-outline" data-copy="${esc(link)}">${ICON.copy}<span>${esc(T('نسخ الرابط', 'Copy link'))}</span></button></div>`;
  }

  function renderResult(res, roles) {
    const d = dialog();
    const sent = !!res?.mail?.sent;
    const inv = res?.invite || {};
    d.innerHTML = `<div class="uinv-card">
      <div class="uinv-result">
        <span class="uinv-big ${sent ? 'is-ok' : 'is-warn'}">${sent ? ICON.check : ICON.warn}</span>
        <h2>${esc(sent ? T('أُرسلت الدعوة', 'Invitation sent') : T('أُنشئت الدعوة', 'Invitation created'))}</h2>
        <p>${sent ? T(`أُرسلت الدعوة إلى <bdi dir="ltr">${esc(inv.email)}</bdi> بدور <b>${esc(inv.roleName)}</b>.`, `Sent to <bdi dir="ltr">${esc(inv.email)}</bdi> as <b>${esc(inv.roleName)}</b>.`)
          : esc(res?.mail?.message || T('تعذّر إرسال البريد. انسخ الرابط وأرسله إلى الموظف بنفسك.', 'The email could not be sent. Copy the link and send it to the employee yourself.'))}</p>
      </div>
      <div class="uinv-body">
        <label class="uinv-field"><span>${esc(T('رابط الدعوة', 'Invitation link'))}</span>${linkBox(res.link)}</label>
        <p class="uinv-note">${esc(T(`الرابط صالح حتى ${when(inv.expiresAt)}، ويُستخدم مرة واحدة.`, `Valid until ${when(inv.expiresAt)}; it works once.`))}
          ${sent ? esc(T(' إذا لم تصل الرسالة، فاطلب من الموظف مراجعة مجلد الرسائل غير المرغوب فيها (Spam).', ' If it does not arrive, ask the employee to check the Spam folder.')) : ''}</p>
      </div>
      <footer class="uinv-foot">
        <button type="button" class="btn btn-outline" data-again>${esc(T('دعوة موظف آخر', 'Invite another'))}</button>
        <button type="button" class="btn btn-primary" data-close>${esc(T('تم', 'Done'))}</button>
      </footer></div>`;
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    d.querySelector('[data-again]').addEventListener('click', () => renderForm(roles));
    bindCopy(d);
    d.querySelector('[data-close].btn-primary')?.focus();
  }

  function bindCopy(root) {
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await copy(b.dataset.copy);
      say(ok ? T('نُسخ رابط الدعوة', 'Invitation link copied') : T('تعذّر النسخ. انسخ الرابط يدويًا.', 'Could not copy. Copy the link by hand.'), !ok);
    }));
  }

  // ─── Pending list on the Users page ──────────────────────────────────────
  let rows = null; let loadedAt = 0; let loading = null;
  function load(opts = {}) {
    if (!admin()) return Promise.resolve();
    if (opts.ifStale && rows && Date.now() - loadedAt < 20_000) { paint(); return Promise.resolve(); }
    if (loading) return loading;
    // Roles too, so each row names its role in the page language (the stored name is the Arabic one for the email).
    loading = Promise.all([api('/invitations'), window.SouliaRBAC?.ensure?.().catch(() => null)]).then(([r]) => { rows = Array.isArray(r) ? r : []; loadedAt = Date.now(); paint(); })
      .catch(() => { /* the section stays as it was */ }).finally(() => { loading = null; });
    return loading;
  }

  function leftText(inv) {
    if (inv.state === 'expired') return { cls: 'is-bad', text: T('انتهت صلاحيتها', 'Expired') };
    const h = Math.max(0, (new Date(inv.expiresAt).getTime() - Date.now()) / 3600_000);
    if (h < 1) return { cls: 'is-warn', text: T('تنتهي خلال أقل من ساعة', 'Expires within an hour') };
    if (h < 24) return { cls: 'is-warn', text: T(`تنتهي خلال ${Math.ceil(h)} ساعة`, `Expires in ${Math.ceil(h)} h`) };
    const days = Math.ceil(h / 24);
    return { cls: 'is-info', text: T(days === 2 ? 'تنتهي خلال يومين' : days === 1 ? 'تنتهي خلال يوم' : `تنتهي خلال ${days} أيام`, `Expires in ${days} day${days > 1 ? 's' : ''}`) };
  }

  function paint() {
    const wrap = document.getElementById('users-invites-wrap');
    const btn = document.getElementById('users-invite-btn');
    if (btn) btn.hidden = !admin();
    if (!wrap) return;
    const list = (rows || []);
    wrap.hidden = !admin() || !list.length;
    if (wrap.hidden) return;
    wrap.querySelector('#users-invites-count').textContent = String(list.length);
    const job = (v) => (typeof jobTitleLabel === 'function' ? jobTitleLabel(v) : v);
    const R = window.SouliaRBAC;
    const roleTxt = (inv) => { const r = R?.find?.(inv.roleId); return r && R.roleName ? R.roleName(r) : inv.roleName; };
    wrap.querySelector('#users-invites-list').innerHTML = list.map((inv) => {
      const left = leftText(inv);
      const mailBad = inv.mail && inv.mail.sent === false;
      return `<div class="uinv-row" data-id="${esc(inv.id)}">
        <span class="uinv-row-ic">${ICON.mail}</span>
        <div class="uinv-row-who">
          <bdi dir="ltr" class="uinv-row-mail" title="${esc(inv.email)}">${esc(inv.email)}</bdi>
          <span class="uinv-row-meta">${esc(roleTxt(inv))}${inv.jobTitle ? ' · ' + esc(job(inv.jobTitle)) : ''} · ${esc(T('بواسطة', 'by'))} ${esc(inv.invitedBy?.name || '')}</span>
        </div>
        <span class="ux-chip ${left.cls}" title="${esc(when(inv.expiresAt))}">${esc(left.text)}</span>
        ${mailBad ? `<span class="ux-chip is-warn" title="${esc(inv.mail.message || '')}">${esc(T('لم يُرسل البريد', 'Email not sent'))}</span>` : ''}
        <div class="uinv-row-act">
          ${inv.link && inv.state === 'pending' ? `<button type="button" class="ux-btn" data-copy="${esc(inv.link)}" title="${esc(T('نسخ الرابط', 'Copy link'))}">${ICON.copy}<span class="uinv-hide-sm">${esc(T('نسخ الرابط', 'Copy link'))}</span></button>` : ''}
          <button type="button" class="ux-btn" data-resend="${esc(inv.id)}">${esc(T('إعادة الإرسال', 'Re-send'))}</button>
          <button type="button" class="ux-btn is-danger" data-cancel="${esc(inv.id)}">${esc(T('إلغاء الدعوة', 'Cancel'))}</button>
        </div>
      </div>`;
    }).join('');
    bindCopy(wrap);
    wrap.querySelectorAll('[data-resend]').forEach((b) => b.addEventListener('click', () => resend(b.dataset.resend, b)));
    wrap.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => cancel(b.dataset.cancel)));
  }

  async function resend(id, btn) {
    btn.disabled = true;
    try {
      const r = await api(`/invitations/${encodeURIComponent(id)}/resend`, { method: 'POST', body: JSON.stringify({ origin: location.origin }) });
      say(r?.mail?.sent ? T('أُعيد إرسال الدعوة، وصارت صالحة 72 ساعة من الآن.', 'Invitation re-sent; valid for 72 hours from now.')
        : (r?.mail?.message || T('تجدّدت صلاحية الدعوة، لكن لم يُرسل البريد. انسخ الرابط.', 'Renewed, but the email was not sent. Copy the link.')), !r?.mail?.sent);
      await load();
    } catch (e) { say(errMsg(e), true); btn.disabled = false; }
  }

  async function cancel(id) {
    const inv = (rows || []).find((r) => r.id === id);
    const ok = typeof showConfirm === 'function' ? await showConfirm(
      T(`سيتوقف رابط الدعوة المرسل إلى ${inv?.email || ''} عن العمل.`, `The link sent to ${inv?.email || ''} will stop working.`),
      { title: T('إلغاء الدعوة', 'Cancel invitation'), danger: true, confirmLabel: T('إلغاء الدعوة', 'Cancel invitation'), cancelLabel: T('رجوع', 'Back') }) : true;
    if (!ok) return;
    try { await api(`/invitations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); say(T('أُلغيت الدعوة', 'Invitation cancelled')); await load(); }
    catch (e) { say(errMsg(e), true); }
  }

  function bindSocket(sock) {
    if (!sock || sock._uinvBound) return;
    sock._uinvBound = true;
    sock.on('users:invites-changed', () => {
      loadedAt = 0;
      if (typeof currentPage !== 'undefined' && currentPage === 'users') load();
    });
  }

  window.SouliaInvites = { open, load, paint, bindSocket };
})();
