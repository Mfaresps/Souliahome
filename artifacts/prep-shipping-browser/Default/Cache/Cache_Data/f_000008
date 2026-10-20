/* ════════════════════════════════════════════════════════════════
   Staff announcements (Settings ← الإعلانات → «رسائل للموظفين»)

   Composer (admin)  → POST /announcements  → stored once (requestKey)
                     → socket «announcement:new» {id} to each recipient
                     → Web Push via the existing queue (type «announcement»)
   Recipient         → GET /announcements/mine on boot / on the socket ping
                     → popup until «تم الاطلاع» (POST /:id/ack)
                     → «لاحقاً» hides it for this session only; it returns next open,
                       and is always listed in مركز الإشعارات ← الإعلانات.

   ⚠ ANN_CATEGORIES is a hand-kept mirror of backend announcement.constants.ts.
     `code` is the stored value — never rename one.
   ⚠ The socket payload carries only the id; content is fetched from /mine, which
     the server scopes to the caller. Never put the message in a broadcast.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const ANN_CATEGORIES = [
    { code: 'announcement', emoji: '📢', ar: 'إعلان عام', en: 'Announcement' },
    { code: 'important', emoji: '⚠️', ar: 'تنبيه مهم', en: 'Important Notice' },
    { code: 'holiday', emoji: '🎉', ar: 'تهنئة بمناسبة', en: 'Holiday Greeting' },
    { code: 'work-update', emoji: '📋', ar: 'تحديث بخصوص العمل', en: 'Work Update' },
    { code: 'appreciation', emoji: '🏆', ar: 'شكر وتقدير', en: 'Appreciation' },
    { code: 'motivation', emoji: '🎯', ar: 'رسالة تحفيزية', en: 'Motivation' },
    { code: 'reminder', emoji: '📌', ar: 'تذكير', en: 'Reminder' },
    { code: 'custom', emoji: '✏️', ar: 'رسالة مخصصة', en: 'Custom Message' },
  ];
  const english = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const text = (ar, en) => english() ? en : ar;
  const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cat = code => ANN_CATEGORIES.find(c => c.code === code) || ANN_CATEGORIES[0];
  const catLabel = c => english() ? c.en : c.ar;
  const loggedIn = () => typeof currentUser !== 'undefined' && !!currentUser && !!localStorage.getItem('token');
  const admin = () => loggedIn() && currentUser.role === 'admin';
  const myId = () => (typeof _myUserId === 'function' ? _myUserId() : String(currentUser?._id || currentUser?.userId || ''));
  const fmtNum = n => new Intl.NumberFormat('en-US').format(n);
  const SVG = {
    mega: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };
  function when(iso) {
    if (!iso) return '';
    try { if (typeof _timeAgo === 'function') return _timeAgo(iso); } catch (_) {}
    return fullDate(iso);
  }
  function fullDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(english() ? 'en-GB' : 'ar-EG-u-nu-latn', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function userById(id) { return (typeof users !== 'undefined' && Array.isArray(users)) ? users.find(u => String(u._id) === String(id)) : null; }
  function avatar(id, name, size) {
    const u = userById(id) || { _id: id, name };
    return typeof userAvatarHtml === 'function' ? userAvatarHtml(u, size, true) : '';
  }
  function refreshBell() { try { if (typeof buildNotifications === 'function') buildNotifications(); } catch (_) {} }

  /* ── Recipient inbox ─────────────────────────────────────────── */
  const state = { token: '', mine: [], loaded: false, loading: null, dismissed: new Set() };
  function setMine(rows) {
    state.mine = Array.isArray(rows) ? rows : [];
    state.loaded = true;
    window.souliaAnnUnread = state.mine.filter(a => !a.ackAt).length;
    refreshBell();
    if (typeof _ncTab !== 'undefined' && document.querySelector('#nc-overlay.active')) {
      try { _renderNcTabBar(); if (_ncTab === 'announcements') _renderNcContent(); } catch (_) {}
    }
  }
  function loadMine() {
    if (!loggedIn()) return Promise.resolve(state.mine);
    if (state.loading) return state.loading;
    state.loading = api('/announcements/mine').then(rows => { setMine(rows); return state.mine; })
      // A failed fetch keeps what we had — it must not read as «no announcements».
      .catch(() => state.mine)
      .finally(() => { state.loading = null; });
    return state.loading;
  }

  let dlg = null, queue = [], qPos = 0, single = false, busy = false, pendingShow = false;
  function ensureDialog() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'an-dlg';
    dlg.setAttribute('aria-labelledby', 'an-dlg-title');
    dlg.addEventListener('cancel', e => { e.preventDefault(); later(); });
    dlg.addEventListener('click', e => { if (e.target === dlg) later(); });
    document.body.append(dlg);
    return dlg;
  }
  // Another dialog, a confirm, or a form the user is typing into: wait, don't interrupt.
  function blocked() {
    return document.hidden ||
      !!document.querySelector('dialog[open]:not(.an-dlg),#soulia-modal-overlay.active,#modal-overlay.active,#inv-detail-overlay.active') ||
      (document.getElementById('login-page') && getComputedStyle(document.getElementById('login-page')).display !== 'none');
  }
  function maybeShow() {
    if (!loggedIn() || !window.souliaPushAppReady || (dlg && dlg.open)) return;
    const unread = state.mine.filter(a => !a.ackAt && !state.dismissed.has(a.id));
    if (!unread.length) { pendingShow = false; return; }
    if (blocked()) { pendingShow = true; return; }
    pendingShow = false;
    // Oldest first: a backlog reads in the order it was written.
    queue = unread.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    qPos = 0; single = false;
    renderDialog();
    ensureDialog().showModal();
  }
  function renderDialog() {
    const d = ensureDialog();
    const a = queue[qPos];
    if (!a) return;
    const c = cat(a.category);
    d.dir = english() ? 'ltr' : 'rtl'; d.lang = english() ? 'en' : 'ar';
    const multi = !single && queue.length > 1;
    const sub = multi ? text(`${fmtNum(queue.length)} إعلانات لم تطّلع عليها`, `${fmtNum(queue.length)} unread announcements`) : text('رسالة من الإدارة', 'A message from management');
    const isLast = qPos >= queue.length - 1;
    // The <dialog> is a full-screen transparent layer; the visible box is .an-dlg-card.
    d.innerHTML = `<div class="an-dlg-card">
      <div class="an-dlg-head">
        <div class="an-dlg-icon">${SVG.mega}</div>
        <div style="flex:1;min-width:0">
          <div class="an-dlg-title" id="an-dlg-title">${escH(text('إعلان من SOULIA', 'SOULIA Announcement'))}</div>
          <div class="an-dlg-sub">${escH(sub)}</div>
        </div>
        <button type="button" class="an-dlg-x" data-an="later" aria-label="${escH(text('إغلاق', 'Close'))}">${SVG.close}</button>
      </div>
      <div class="an-dlg-body">
        <span class="an-chip${c.code === 'important' ? ' is-important' : ''}"><span aria-hidden="true">${c.emoji}</span>${escH(catLabel(c))}</span>
        <div class="an-dlg-msg" dir="auto">${escH(a.message)}</div>
        <div class="an-dlg-meta">${avatar(a.createdById, a.createdByName, 22)}<span><b>${escH(a.createdByName || text('الإدارة', 'Management'))}</b> · <span title="${escH(fullDate(a.createdAt))}">${escH(when(a.createdAt))}</span></span></div>
      </div>
      <div class="an-dlg-foot">
        ${multi ? `<span class="an-dlg-pos">${escH(text(`${fmtNum(qPos + 1)} من ${fmtNum(queue.length)}`, `${fmtNum(qPos + 1)} of ${fmtNum(queue.length)}`))}</span>` : ''}
        ${a.ackAt
          ? `<span class="an-dlg-read">${SVG.check}${escH(text('تم الاطلاع', 'Acknowledged'))} · ${escH(fullDate(a.ackAt))}</span>
             <button type="button" class="btn btn-outline btn-sm" data-an="close">${escH(text('إغلاق', 'Close'))}</button>`
          : `<button type="button" class="btn btn-outline btn-sm" data-an="later">${escH(text('لاحقاً', 'Later'))}</button>
             <button type="button" class="btn btn-primary btn-sm an-dlg-done" data-an="ack">${SVG.check}<span>${escH(isLast || single ? text('تم الاطلاع', 'Got it') : text('تم الاطلاع · التالي', 'Got it · Next'))}</span></button>`}
      </div>
    </div>`;
    d.querySelectorAll('[data-an]').forEach(b => b.addEventListener('click', () => {
      const act = b.dataset.an;
      if (act === 'ack') ack(b); else if (act === 'close') closeDialog(); else later();
    }));
    setTimeout(() => d.querySelector('[data-an="ack"],[data-an="close"]')?.focus(), 30);
  }
  function closeDialog() { if (dlg?.open) dlg.close(); busy = false; }
  function later() {
    if (busy) return;
    // Not acknowledged: hidden for this session only, back on the next open.
    queue.forEach(a => { if (!a.ackAt) state.dismissed.add(a.id); });
    closeDialog();
  }
  async function ack(btn) {
    if (busy) return;
    const a = queue[qPos];
    if (!a) return;
    busy = true; btn.disabled = true;
    try {
      const res = await api('/announcements/' + encodeURIComponent(a.id) + '/ack', { method: 'POST' });
      a.ackAt = res?.ackAt || new Date().toISOString();
      const row = state.mine.find(x => x.id === a.id); if (row) row.ackAt = a.ackAt;
      setMine(state.mine);
      busy = false;
      if (!single && qPos < queue.length - 1) { qPos++; renderDialog(); } else closeDialog();
    } catch (error) {
      busy = false; btn.disabled = false;
      if (typeof toast === 'function') toast(text('تعذر تسجيل الاطلاع — حاول مرة أخرى', 'Could not record that — please try again') + (error?.message ? ' · ' + error.message : ''), true);
    }
  }
  function openOne(a) {
    if (!a) return false;
    if (dlg?.open) dlg.close();
    queue = [a]; qPos = 0; single = true;
    renderDialog();
    ensureDialog().showModal();
    return true;
  }
  // Used by push-navigation.js when a push notification is tapped.
  window.souliaOpenAnnouncement = async function (id) {
    await loadMine();
    if (!state.mine.some(a => a.id === id)) { state.loaded = false; await loadMine(); }
    return openOne(state.mine.find(a => a.id === id));
  };

  /* ── مركز الإشعارات ← الإعلانات ─────────────────────────────── */
  window.souliaAnnNcTab = function () {
    if (!loggedIn()) return null;
    loadMine();
    return { key: 'announcements', label: text('الإعلانات', 'Announcements'), icon: SVG.mega.replace('<svg ', '<svg width="15" height="15" '), count: state.mine.filter(a => !a.ackAt).length };
  };
  window.souliaRenderNcAnnouncements = function (main) {
    const subtitle = document.getElementById('nc-subtitle');
    const unread = state.mine.filter(a => !a.ackAt).length;
    if (subtitle) subtitle.textContent = state.mine.length
      ? text(`${fmtNum(state.mine.length)} إعلان`, `${fmtNum(state.mine.length)} announcements`) + (unread ? text(` — ${fmtNum(unread)} لم تُقرأ`, ` — ${fmtNum(unread)} unread`) : '')
      : text('لا توجد إعلانات', 'No announcements');
    if (!state.mine.length) {
      main.innerHTML = `<div class="nc-empty-state"><div class="nc-empty-icon" style="opacity:.25">${SVG.mega.replace('<svg ', '<svg width="40" height="40" ')}</div><div class="nc-empty-text">${escH(state.loaded ? text('لم تصلك إعلانات من الإدارة بعد', 'No announcements from management yet') : text('جارٍ التحميل…', 'Loading…'))}</div></div>`;
      return;
    }
    main.innerHTML = state.mine.map(a => {
      const c = cat(a.category);
      return `<button type="button" class="an-nc-item" data-an-id="${escH(a.id)}">
        <span class="an-nc-dot${a.ackAt ? ' is-read' : ''}" aria-hidden="true"></span>
        <span class="an-nc-emo" aria-hidden="true">${c.emoji}</span>
        <span class="an-nc-main">
          <span class="an-nc-cat">${escH(catLabel(c))}${a.ackAt ? '' : ' · ' + escH(text('جديد', 'New'))}</span>
          <span class="an-nc-text" dir="auto">${escH(a.message)}</span>
          <span class="an-nc-meta" style="display:block">${escH(a.createdByName || '')} · <span title="${escH(fullDate(a.createdAt))}">${escH(when(a.createdAt))}</span></span>
        </span>
      </button>`;
    }).join('');
    main.querySelectorAll('[data-an-id]').forEach(el => el.addEventListener('click', () => {
      const a = state.mine.find(x => x.id === el.dataset.anId);
      if (typeof closeNotifCenter === 'function') closeNotifCenter();
      openOne(a);
    }));
  };

  /* ── Composer (admin) ───────────────────────────────────────── */
  const form = { category: 'announcement', audience: 'all', selected: new Set(), search: '', requestKey: '', sending: false, when: 'now', sendAt: '' };
  let cfg = null, history = null, historyFailed = false, composerLang = '', composerToken = '', historyTimer = null;
  const historyPageSize = 5;
  let historyPage = 1;
  const newKey = () => (crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  // <input type="datetime-local"> speaks the browser's local wall-clock time; the server gets ISO.
  const pad = n => String(n).padStart(2, '0');
  const localInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function scheduleBounds() {
    const lead = (cfg?.scheduleMinLeadMinutes || 2) + 1;
    return { min: new Date(Date.now() + lead * 60000), max: new Date(Date.now() + (cfg?.scheduleMaxDays || 60) * 86400000) };
  }
  function defaultSendAt() {
    // The next round half-hour at least 15 minutes out — a sensible first suggestion.
    const d = new Date(Date.now() + 15 * 60000); d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
    return localInput(d);
  }
  function activeStaff() {
    const list = (typeof users !== 'undefined' && Array.isArray(users)) ? users : [];
    return list.filter(u => u && u._id && u.isActive !== false && ['admin', 'staff', 'viewer'].includes(u.role || 'staff') && String(u._id) !== myId());
  }
  async function loadComposerData() {
    try { cfg = await api('/announcements/config'); } catch (_) { cfg = cfg || { maxLength: 500, minMaxLength: 50, hardMaxLength: 2000 }; }
    if (typeof users !== 'undefined' && (!Array.isArray(users) || !users.length || users.some(u => u.isActive === undefined && u.role === undefined))) {
      try { users = await api('/users'); } catch (_) {}
    }
    await loadHistory();
  }
  async function loadHistory() {
    try { history = await api('/announcements'); historyFailed = false; }
    catch (_) { historyFailed = true; }
    renderHistory();
  }
  function renderComposer() {
    const host = document.getElementById('an-composer');
    const label = document.getElementById('an-section-label');
    if (!host) return;
    host.hidden = !admin(); if (label) label.hidden = !admin();
    if (!admin()) return;
    composerLang = english() ? 'en' : 'ar';
    const max = cfg?.maxLength || 500;
    const all = activeStaff();
    if (label) label.querySelector('span').textContent = text('رسائل للموظفين', 'Messages to staff');
    host.innerHTML = `
      <div class="stg-card-title">
        <div class="stg-card-title-icon">${SVG.mega}</div>
        <div class="stg-card-title-text">
          <strong>${escH(text('إرسال إعلان للموظفين', 'Send an announcement'))}</strong>
          <span>${escH(text('يظهر داخل النظام لكل مستلم حتى يؤكد الاطلاع، ويصل إشعاراً فورياً على الهاتف لمن فعّل الإشعارات.', 'Shown inside SOULIA until each recipient acknowledges it, and pushed instantly to phones with notifications enabled.'))}</span>
        </div>
      </div>
      <div class="an-field">
        <div class="an-field-head"><span class="an-label" id="an-type-lbl">${escH(text('نوع الرسالة', 'Message type'))}</span></div>
        <div class="an-types" role="radiogroup" aria-labelledby="an-type-lbl">
          ${ANN_CATEGORIES.map(c => `<label class="an-type"><input type="radio" name="an-type" value="${c.code}"${form.category === c.code ? ' checked' : ''}><span class="an-emo" aria-hidden="true">${c.emoji}</span><span class="an-type-txt">${escH(catLabel(c))}</span></label>`).join('')}
        </div>
      </div>
      <div class="an-field">
        <div class="an-field-head"><span class="an-label">${escH(text('المستلمون', 'Recipients'))}</span></div>
        <div class="an-seg" role="tablist">
          <button type="button" data-aud="all" class="${form.audience === 'all' ? 'is-on' : ''}" aria-pressed="${form.audience === 'all'}">${escH(text('كل الموظفين', 'All employees'))} <bdi>(${fmtNum(all.length)})</bdi></button>
          <button type="button" data-aud="selected" class="${form.audience === 'selected' ? 'is-on' : ''}" aria-pressed="${form.audience === 'selected'}">${escH(text('موظفون محددون', 'Specific employees'))}</button>
        </div>
        <div class="an-people" id="an-people"${form.audience === 'selected' ? '' : ' hidden'}>
          <div class="an-people-bar">
            <input type="search" id="an-people-q" placeholder="${escH(text('بحث بالاسم أو الوظيفة…', 'Search by name or role…'))}" value="${escH(form.search)}" autocomplete="off">
            <span class="an-people-count" id="an-people-count"></span>
            <button type="button" class="an-link" id="an-people-toggle"></button>
          </div>
          <div class="an-people-list" id="an-people-list"></div>
        </div>
      </div>
      <div class="an-field">
        <div class="an-field-head"><label class="an-label" for="an-msg">${escH(text('نص الرسالة', 'Message'))}</label><span class="an-hint">${escH(text('تظهر كما كُتبت، مع الأسطر الجديدة', 'Shown exactly as written, line breaks included'))}</span></div>
        <textarea id="an-msg" class="an-msg" dir="auto" maxlength="${max}" rows="5" placeholder="${escH(text('اكتب رسالتك للفريق…', 'Write your message to the team…'))}"></textarea>
        <div class="an-msg-foot">
          <span class="an-limit" id="an-limit-view">${escH(text('الحد الأقصى', 'Limit'))} <bdi>${fmtNum(max)}</bdi> ${escH(text('حرف', 'characters'))} · <button type="button" class="an-link" id="an-limit-edit">${escH(text('تغيير', 'Change'))}</button></span>
          <span class="an-limit" id="an-limit-form" hidden><input type="number" id="an-limit-input" min="${cfg?.minMaxLength || 50}" max="${cfg?.hardMaxLength || 2000}" value="${max}"><button type="button" class="an-link" id="an-limit-save">${escH(text('حفظ', 'Save'))}</button><button type="button" class="an-link" id="an-limit-cancel" style="color:var(--muted)">${escH(text('إلغاء', 'Cancel'))}</button></span>
          <span class="an-counter" id="an-counter" aria-live="polite"></span>
        </div>
      </div>
      <div class="an-field">
        <div class="an-field-head"><span class="an-label">${escH(text('وقت الإرسال', 'When to send'))}</span></div>
        <div class="an-when">
          <div class="an-seg">
            <button type="button" data-when="now" class="${form.when === 'now' ? 'is-on' : ''}" aria-pressed="${form.when === 'now'}">${escH(text('الآن', 'Now'))}</button>
            <button type="button" data-when="later" class="${form.when === 'later' ? 'is-on' : ''}" aria-pressed="${form.when === 'later'}">${escH(text('جدولة لوقت لاحق', 'Schedule for later'))}</button>
          </div>
          <span class="an-when-pick" id="an-when-pick"${form.when === 'later' ? '' : ' hidden'}>
            <input type="datetime-local" id="an-send-at" aria-label="${escH(text('موعد الإرسال', 'Send time'))}" value="${escH(form.sendAt || '')}" min="${localInput(scheduleBounds().min)}" max="${localInput(scheduleBounds().max)}">
          </span>
        </div>
        <div class="an-hint" id="an-when-hint" style="margin-top:6px"${form.when === 'later' ? '' : ' hidden'}>${escH(text('يصل للموظفين في هذا الموعد: يظهر داخل النظام ويُرسل إشعار الهاتف وقتها. يمكنك إلغاؤه قبل موعده من السجل بالأسفل.', 'Delivered at this time: shown in SOULIA and pushed to phones then. You can cancel it before then from the list below.'))}</div>
      </div>
      <div class="an-err" id="an-err" role="alert"></div>
      <div class="an-actions">
        <span class="an-summary" id="an-summary"></span>
        <button type="button" class="btn btn-primary an-send" id="an-send">${SVG.send}<span id="an-send-lbl"></span></button>
      </div>
      <div class="an-hist">
        <div class="an-hist-head"><span class="an-label">${escH(text('الإعلانات المرسلة', 'Sent announcements'))}</span><button type="button" class="an-link" id="an-hist-reload">${escH(text('تحديث', 'Refresh'))}</button></div>
        <div id="an-hist-body"><div class="an-skel"></div><div class="an-skel"></div></div>
      </div>`;
    const msg = host.querySelector('#an-msg');
    if (form.draft) msg.value = form.draft.slice(0, max);
    host.querySelectorAll('input[name="an-type"]').forEach(r => r.addEventListener('change', () => { form.category = r.value; form.requestKey = ''; summary(); }));
    host.querySelectorAll('[data-aud]').forEach(b => b.addEventListener('click', () => {
      form.audience = b.dataset.aud; form.requestKey = '';
      host.querySelectorAll('[data-aud]').forEach(x => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      host.querySelector('#an-people').hidden = form.audience !== 'selected';
      if (form.audience === 'selected') host.querySelector('#an-people-q').focus();
      setErr(''); summary();
    }));
    host.querySelector('#an-people-q').addEventListener('input', e => { form.search = e.target.value; renderPeople(); });
    host.querySelector('#an-people-toggle').addEventListener('click', () => {
      const visible = filteredPeople();
      const allOn = visible.length && visible.every(u => form.selected.has(String(u._id)));
      visible.forEach(u => allOn ? form.selected.delete(String(u._id)) : form.selected.add(String(u._id)));
      form.requestKey = ''; renderPeople(); summary();
    });
    msg.addEventListener('input', () => { form.draft = msg.value; form.requestKey = ''; msg.classList.remove('is-err'); setErr(''); counter(); });
    host.querySelector('#an-limit-edit').addEventListener('click', () => { host.querySelector('#an-limit-view').hidden = true; host.querySelector('#an-limit-form').hidden = false; host.querySelector('#an-limit-input').focus(); });
    host.querySelector('#an-limit-cancel').addEventListener('click', () => { host.querySelector('#an-limit-view').hidden = false; host.querySelector('#an-limit-form').hidden = true; });
    host.querySelector('#an-limit-save').addEventListener('click', saveLimit);
    host.querySelectorAll('[data-when]').forEach(b => b.addEventListener('click', () => {
      form.when = b.dataset.when; form.requestKey = '';
      host.querySelectorAll('[data-when]').forEach(x => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      host.querySelector('#an-when-pick').hidden = form.when !== 'later';
      host.querySelector('#an-when-hint').hidden = form.when !== 'later';
      if (form.when === 'later') {
        const input = host.querySelector('#an-send-at');
        const bounds = scheduleBounds(); input.min = localInput(bounds.min); input.max = localInput(bounds.max);
        if (!input.value) { input.value = defaultSendAt(); form.sendAt = input.value; }
        input.focus();
      }
      setErr(''); summary();
    }));
    host.querySelector('#an-send-at').addEventListener('input', e => { form.sendAt = e.target.value; form.requestKey = ''; setErr(''); summary(); });
    host.querySelector('#an-send').addEventListener('click', send);
    host.querySelector('#an-hist-reload').addEventListener('click', loadHistory);
    renderPeople(); counter(); summary(); renderHistory();
  }
  function filteredPeople() {
    const q = (typeof _gsNorm === 'function' ? _gsNorm(form.search) : form.search.trim().toLowerCase());
    const norm = s => typeof _gsNorm === 'function' ? _gsNorm(s) : String(s || '').toLowerCase();
    return activeStaff().filter(u => !q || norm([u.name, u.username, u.jobTitle, typeof jobTitleLabel === 'function' ? jobTitleLabel(u.jobTitle) : ''].join(' ')).includes(q))
      .sort((a, b) => String(a.name || a.username).localeCompare(String(b.name || b.username), 'ar'));
  }
  function renderPeople() {
    const list = document.getElementById('an-people-list');
    if (!list) return;
    const rows = filteredPeople();
    list.innerHTML = rows.length ? rows.map(u => {
      const id = String(u._id);
      const role = { admin: text('مدير', 'Admin'), staff: text('موظف', 'Staff'), viewer: text('مشاهد', 'Viewer') }[u.role] || '';
      const job = u.jobTitle ? (typeof jobTitleLabel === 'function' ? jobTitleLabel(u.jobTitle) : u.jobTitle) : '';
      return `<label class="an-person"><input type="checkbox" value="${escH(id)}"${form.selected.has(id) ? ' checked' : ''}><span class="an-check">${SVG.check}</span>${avatar(id, u.name || u.username, 28)}<span class="an-person-txt"><span class="an-person-name">${escH(u.name || u.username)}</span><span class="an-person-sub">${escH([job, role].filter(Boolean).join(' · '))}</span></span></label>`;
    }).join('') : `<div class="an-people-empty">${escH(activeStaff().length ? text('لا يوجد موظف بهذا الاسم', 'No employee matches') : text('لا يوجد موظفون نشطون', 'No active employees'))}</div>`;
    list.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
      cb.checked ? form.selected.add(cb.value) : form.selected.delete(cb.value);
      form.requestKey = ''; setErr(''); peopleBar(); summary();
    }));
    peopleBar();
  }
  function peopleBar() {
    // Selection survives a search; only active employees count.
    const live = new Set(activeStaff().map(u => String(u._id)));
    [...form.selected].forEach(id => { if (!live.has(id)) form.selected.delete(id); });
    const c = document.getElementById('an-people-count');
    if (c) c.textContent = text(`${fmtNum(form.selected.size)} محدد`, `${fmtNum(form.selected.size)} selected`);
    const t = document.getElementById('an-people-toggle');
    const visible = filteredPeople();
    if (t) { t.textContent = visible.length && visible.every(u => form.selected.has(String(u._id))) ? text('إلغاء التحديد', 'Clear') : text('تحديد الكل', 'Select all'); t.hidden = !visible.length; }
  }
  function counter() {
    const el = document.getElementById('an-counter');
    const msg = document.getElementById('an-msg');
    if (!el || !msg) return;
    const max = cfg?.maxLength || 500, n = msg.value.length;
    el.textContent = `${fmtNum(n)} / ${fmtNum(max)}`;
    el.classList.toggle('is-near', n >= max * 0.9 && n < max);
    el.classList.toggle('is-full', n >= max);
  }
  function recipientCount() { return form.audience === 'all' ? activeStaff().length : form.selected.size; }
  function audienceText() {
    if (form.audience === 'all') return text(`كل الموظفين (${fmtNum(activeStaff().length)})`, `All employees (${fmtNum(activeStaff().length)})`);
    if (form.selected.size === 1) { const u = userById([...form.selected][0]); return u?.name || u?.username || text('موظف واحد', 'One employee'); }
    return text(`${fmtNum(form.selected.size)} موظفين`, `${fmtNum(form.selected.size)} employees`);
  }
  function summary() {
    const el = document.getElementById('an-summary');
    if (!el) return;
    const n = recipientCount();
    const at = form.when === 'later' && form.sendAt ? new Date(form.sendAt) : null;
    const whenTxt = at && !isNaN(at) ? text(` · في ${fullDate(at)}`, ` · on ${fullDate(at)}`) : '';
    el.textContent = n ? text(`سيصل إلى: ${audienceText()}`, `Goes to: ${audienceText()}`) + whenTxt : '';
    const lbl = document.getElementById('an-send-lbl');
    if (lbl) lbl.textContent = form.when === 'later' ? text('جدولة الإعلان', 'Schedule announcement') : text('إرسال الإعلان', 'Send announcement');
  }
  function setErr(msg) { const el = document.getElementById('an-err'); if (el) el.textContent = msg || ''; }
  async function saveLimit() {
    const input = document.getElementById('an-limit-input');
    const v = Number(input.value);
    const lo = cfg?.minMaxLength || 50, hi = cfg?.hardMaxLength || 2000;
    if (!Number.isInteger(v) || v < lo || v > hi) { setErr(text(`الحد يجب أن يكون بين ${lo} و ${hi}`, `The limit must be between ${lo} and ${hi}`)); input.focus(); return; }
    try {
      cfg = await api('/announcements/config', { method: 'PATCH', body: JSON.stringify({ maxLength: v }) });
      if (typeof toast === 'function') toast(text('تم حفظ الحد الأقصى للرسالة', 'Message limit saved'));
      renderComposer();
    } catch (e) { setErr(e.message); }
  }
  async function send() {
    if (form.sending) return;
    const msgEl = document.getElementById('an-msg');
    const message = (msgEl?.value || '').trim();
    const max = cfg?.maxLength || 500;
    if (!message) { msgEl.classList.add('is-err'); msgEl.focus(); setErr(text('اكتب نص الرسالة أولاً', 'Write the message first')); return; }
    if (message.length > max) { msgEl.classList.add('is-err'); msgEl.focus(); setErr(text(`الرسالة أطول من ${max} حرفاً`, `The message is longer than ${max} characters`)); return; }
    if (form.audience === 'selected' && !form.selected.size) { setErr(text('اختر موظفاً واحداً على الأقل', 'Choose at least one employee')); document.getElementById('an-people-q')?.focus(); return; }
    if (!recipientCount()) { setErr(text('لا يوجد موظفون نشطون لإرسال الإعلان إليهم', 'There are no active employees to send to')); return; }
    let sendAt = null;
    if (form.when === 'later') {
      const at = form.sendAt ? new Date(form.sendAt) : null;
      const input = document.getElementById('an-send-at');
      const maxDays = cfg?.scheduleMaxDays || 60;
      if (!at || isNaN(at)) { setErr(text('اختر موعد الإرسال', 'Choose when to send it')); input?.focus(); return; }
      if (at < new Date(Date.now() + (cfg?.scheduleMinLeadMinutes || 2) * 60000)) { setErr(text('الموعد يجب أن يكون بعد دقيقتين على الأقل من الآن، أو اختر «الآن»', 'Pick a time at least two minutes from now, or choose “Now”')); input?.focus(); return; }
      if (at > scheduleBounds().max) { setErr(text(`لا يمكن الجدولة لأكثر من ${maxDays} يوماً`, `You can schedule up to ${maxDays} days ahead`)); input?.focus(); return; }
      sendAt = at.toISOString();
    }
    setErr('');
    const c = cat(form.category);
    const excerpt = message.length > 220 ? message.slice(0, 220) + '…' : message;
    const ok = await showConfirm(
      `<div dir="auto" style="white-space:pre-wrap;overflow-wrap:anywhere;text-align:start;padding:10px 12px;border-radius:10px;background:var(--bg-alt);font-size:.84rem;line-height:1.75">${escH(excerpt)}</div>`,
      { title: sendAt ? text('جدولة الإعلان؟', 'Schedule this announcement?') : text('إرسال الإعلان؟', 'Send this announcement?'), icon: 'info',
        rows: [[text('النوع', 'Type'), `${c.emoji} ${catLabel(c)}`], [text('المستلمون', 'Recipients'), audienceText()],
          [text('الموعد', 'When'), sendAt ? fullDate(sendAt) : text('الآن', 'Now')],
          [text('الطول', 'Length'), text(`${fmtNum(message.length)} حرف`, `${fmtNum(message.length)} characters`)]],
        confirmLabel: sendAt ? text('جدولة', 'Schedule') : text('إرسال', 'Send') });
    if (!ok) return;
    if (!form.requestKey) form.requestKey = newKey();
    const btn = document.getElementById('an-send');
    form.sending = true; btn?.classList.add('is-busy'); btn?.setAttribute('aria-busy', 'true');
    try {
      const res = await api('/announcements', { method: 'POST', body: JSON.stringify({
        category: form.category, message, audience: form.audience,
        recipientIds: form.audience === 'selected' ? [...form.selected] : undefined, requestKey: form.requestKey, sendAt: sendAt || undefined,
      }) });
      if (typeof toast === 'function') toast(res?.duplicate
        ? text('هذا الإعلان أُرسل بالفعل', 'This announcement was already sent')
        : res?.status === 'scheduled'
          ? text(`تمت جدولة الإعلان، يُرسل ${fullDate(res.sendAt)}`, `Scheduled, goes out ${fullDate(res.sendAt)}`)
          : text(`تم إرسال الإعلان إلى ${fmtNum(res?.recipientCount || 0)} موظف`, `Announcement sent to ${fmtNum(res?.recipientCount || 0)} employees`));
      form.draft = ''; form.requestKey = ''; if (msgEl) msgEl.value = '';
      // Back to «الآن»: the next message should not inherit this one's schedule by accident.
      if (form.when === 'later') { form.when = 'now'; form.sendAt = ''; renderComposer(); }
      counter();
      if (res?.id) { history = [res, ...(history || []).filter(h => h.id !== res.id)]; historyPage = 1; renderHistory(); }
    } catch (e) {
      // The key is kept: a retry of the same content cannot create a second announcement.
      setErr(e.message || text('تعذر الإرسال', 'Could not send'));
    } finally {
      form.sending = false; btn?.classList.remove('is-busy'); btn?.removeAttribute('aria-busy');
    }
  }
  function renderHistory() {
    const body = document.getElementById('an-hist-body');
    if (!body) return;
    if (historyFailed && !history) { body.innerHTML = `<div class="an-empty">${escH(text('تعذر تحميل الإعلانات المرسلة.', 'Could not load sent announcements.'))} <button type="button" class="an-link" id="an-hist-retry">${escH(text('إعادة المحاولة', 'Retry'))}</button></div>`; body.querySelector('#an-hist-retry').onclick = loadHistory; return; }
    if (!history) return;
    if (!history.length) { body.innerHTML = `<div class="an-empty">${escH(text('لم يتم إرسال أي إعلان بعد.', 'No announcements sent yet.'))}</div>`; return; }
    const open = new Set([...body.querySelectorAll('details[open]')].map(d => d.dataset.id));
    const pages = Math.ceil(history.length / historyPageSize);
    historyPage = Math.max(1, Math.min(historyPage, pages));
    const start = (historyPage - 1) * historyPageSize;
    body.innerHTML = `<div class="an-hist-list">${history.slice(start, start + historyPageSize).map(h => {
      const c = cat(h.category);
      const pct = h.recipientCount ? Math.round(h.ackCount / h.recipientCount * 100) : 0;
      const aud = h.audience === 'all' ? text('كل الموظفين', 'All employees') : (h.recipientCount === 1 ? (h.recipients?.[0]?.name || '') : text(`${fmtNum(h.recipientCount)} موظفين`, `${fmtNum(h.recipientCount)} employees`));
      const rcp = (h.recipients || []).slice().sort((a, b) => (a.ackAt ? 1 : 0) - (b.ackAt ? 1 : 0));
      const st = h.status || 'sent';
      // Not delivered (yet): the right column states the plan instead of a read count.
      const chip = (cls, label, sub) => `<span class="an-hist-read"><span class="an-st ${cls}">${escH(label)}</span>${sub ? `<small style="display:block;margin-top:4px">${escH(sub)}</small>` : ''}</span>`;
      const side = st === 'scheduled' ? chip('is-sched', text('مجدول', 'Scheduled'), fullDate(h.sendAt))
        : st === 'sending' ? chip('is-sched', text('جارٍ الإرسال', 'Sending'))
        : st === 'cancelled' ? chip('is-off', text('أُلغي', 'Cancelled'))
        : st === 'failed' ? chip('is-bad', text('لم يُرسل', 'Not sent'))
        : `<span class="an-hist-read"><b><bdi>${fmtNum(h.ackCount)} / ${fmtNum(h.recipientCount)}</bdi></b><small>${escH(text('اطّلعوا', 'acknowledged'))}</small><span class="an-meter" aria-hidden="true"><i style="width:${pct}%"></i></span></span>`;
      const at = st === 'sent' ? (h.sentAt || h.createdAt) : h.createdAt;
      const atTxt = st === 'sent' ? when(at) : text('أُنشئ ', 'created ') + when(at);
      const skipped = h.skippedCount ? ' · ' + text(`تُخطّي ${fmtNum(h.skippedCount)} (حساب معطّل)`, `${fmtNum(h.skippedCount)} skipped (inactive)`) : '';
      return `<details class="an-hist-item" data-id="${escH(h.id)}"${open.has(h.id) ? ' open' : ''}>
        <summary>
          <span class="an-hist-emo" aria-hidden="true">${c.emoji}</span>
          <span class="an-hist-main"><span class="an-hist-cat">${escH(catLabel(c))}</span><span class="an-hist-text" dir="auto">${escH(h.message)}</span>
            <span class="an-hist-meta" style="display:block">${escH(aud)} · ${escH(h.createdByName || '')} · <span title="${escH(fullDate(at))}">${escH(atTxt)}</span>${escH(skipped)}</span></span>
          ${side}
        </summary>
        <div class="an-hist-message" dir="auto">${escH(h.message)}</div>
        ${st === 'scheduled' ? `<div class="an-hist-body"><span class="an-hint">${escH(text(`يصل إلى ${fmtNum(h.recipientCount)} موظف في موعده.`, `Reaches ${fmtNum(h.recipientCount)} employees at that time.`))}</span><button type="button" class="an-link" data-cancel="${escH(h.id)}" style="margin-inline-start:auto;color:var(--red)">${escH(text('إلغاء الجدولة', 'Cancel'))}</button></div>` : ''}
        ${st === 'failed' && h.failReason ? `<div class="an-hist-body"><span class="an-hint">${escH(h.failReason)}</span></div>` : ''}
        <div class="an-hist-body"${st === 'sent' ? '' : ' hidden'}>${rcp.map(r => `<span class="an-rcp${r.ackAt ? ' is-read' : ''}" title="${escH(r.ackAt ? text('اطّلع ', 'Read ') + fullDate(r.ackAt) : text('لم يطّلع بعد', 'Not yet read'))}"><i></i>${escH(r.name || '—')}</span>`).join('')}</div>
      </details>`;
    }).join('')}</div>
      <nav class="an-hist-pages" aria-label="${escH(text('صفحات الإعلانات المرسلة', 'Sent announcement pages'))}">
        <span class="an-hint">${escH(text(`${fmtNum(start + 1)}–${fmtNum(Math.min(start + historyPageSize, history.length))} من ${fmtNum(history.length)}`, `${fmtNum(start + 1)}–${fmtNum(Math.min(start + historyPageSize, history.length))} of ${fmtNum(history.length)}`))}</span>
        <div class="an-hist-page-actions">
          <button type="button" class="an-link" data-history-page="${historyPage - 1}"${historyPage === 1 ? ' disabled' : ''}>${escH(text('السابق', 'Previous'))}</button>
          <span class="an-hint" aria-live="polite">${escH(text(`صفحة ${fmtNum(historyPage)} من ${fmtNum(pages)}`, `Page ${fmtNum(historyPage)} of ${fmtNum(pages)}`))}</span>
          <button type="button" class="an-link" data-history-page="${historyPage + 1}"${historyPage === pages ? ' disabled' : ''}>${escH(text('التالي', 'Next'))}</button>
        </div>
      </nav>`;
    body.querySelectorAll('[data-history-page]').forEach(btn => btn.addEventListener('click', () => {
      historyPage = Number(btn.dataset.historyPage);
      renderHistory();
      body.querySelector('.an-hist-list').scrollTop = 0;
      body.querySelector(`[data-history-page="${historyPage === 1 ? historyPage + 1 : historyPage - 1}"]`)?.focus({ preventScroll: true });
    }));
    body.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); cancelScheduled(b.dataset.cancel, b); }));
  }
  async function cancelScheduled(id, btn) {
    const h = (history || []).find(x => x.id === id);
    const ok = await showConfirm(escH(text('لن يُرسل هذا الإعلان، ولا يمكن التراجع عن الإلغاء.', 'This announcement will not be sent. This cannot be undone.')),
      { title: text('إلغاء الإعلان المجدول؟', 'Cancel the scheduled announcement?'), icon: 'warn', danger: true,
        rows: h ? [[text('الموعد', 'When'), fullDate(h.sendAt)]] : [], confirmLabel: text('إلغاء الجدولة', 'Cancel it'), cancelLabel: text('رجوع', 'Back') });
    if (!ok) return;
    btn.disabled = true;
    try {
      const row = await api('/announcements/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
      history = (history || []).map(x => x.id === id ? row : x);
      renderHistory();
      if (typeof toast === 'function') toast(text('تم إلغاء الإعلان المجدول', 'Scheduled announcement cancelled'));
    } catch (e) {
      btn.disabled = false;
      if (typeof toast === 'function') toast(e.message, true);
      loadHistory();
    }
  }

  /* ── Lifecycle: one interval, the same pattern as notification-settings.js ── */
  function bindSocket() {
    if (typeof socket === 'undefined' || !socket || socket.__annBound) return;
    socket.__annBound = true;
    socket.on('announcement:new', () => {
      state.loaded = false;
      loadMine().then(() => {
        maybeShow();
        if (pendingShow && typeof toast === 'function') toast(text('📢 وصلك إعلان جديد من الإدارة', '📢 New announcement from management'));
      });
    });
    socket.on('announcement:read', () => {
      if (!admin() || !document.getElementById('an-hist-body')) return;
      clearTimeout(historyTimer); historyTimer = setTimeout(loadHistory, 800);
    });
  }
  function tick() {
    const token = localStorage.getItem('token') || '';
    if (token !== state.token) {
      // Account switch: nothing from the previous account may survive.
      state.token = token; state.mine = []; state.loaded = false; state.dismissed = new Set();
      window.souliaAnnUnread = 0; history = null; historyPage = 1; cfg = null; composerToken = ''; form.selected = new Set(); form.draft = '';
      if (dlg?.open) dlg.close();
    }
    if (!loggedIn() || !window.souliaPushAppReady) return;
    bindSocket();
    if (!state.loaded) loadMine().then(maybeShow);
    else if (pendingShow) maybeShow();
    const host = document.getElementById('an-composer');
    if (host && admin() && (composerToken !== token || composerLang !== (english() ? 'en' : 'ar'))) {
      const first = composerToken !== token;
      composerToken = token;
      // Render once the data is in — a second render would reset whatever the admin had
      // started typing or the inline error they were reading.
      if (first) {
        host.hidden = false; const l = document.getElementById('an-section-label'); if (l) l.hidden = false;
        host.innerHTML = '<div class="an-skel"></div><div class="an-skel" style="height:120px"></div>';
        loadComposerData().then(renderComposer);
      } else renderComposer();
    } else if (host && !admin() && !host.hidden) { host.hidden = true; const l = document.getElementById('an-section-label'); if (l) l.hidden = true; }
  }
  setInterval(tick, 1500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && loggedIn()) { state.loaded = false; tick(); } });
})();
