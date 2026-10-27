(function () {
  'use strict';
  const queue = new Map(), seen = new Set();
  let owner = '', timer, request = null, audio, soundPending = false, lastSound = -Infinity, host, revision = 0, activeKeys = new Set();
  const account = () => String(currentUser?._id || currentUser?.id || currentUser?.userId || '');
  const en = () => currentLang === 'en';
  const storageKey = () => 'soulia-followup-reminders:' + owner;
  const muteKey = () => 'soulia-followup-sound:' + owner;
  const muted = () => { try { return localStorage.getItem(muteKey()) === 'off'; } catch (_) { return false; } };
  function reset() {
    clearTimeout(timer); request = null; queue.clear(); seen.clear(); owner = account();
    revision++; activeKeys.clear(); lastSound = -Infinity;
    host?.remove(); host = null;
  }
  function syncOwner() { if (owner !== account()) reset(); return owner; }
  function valid(row) {
    return owner && String(row.responsibleId || '') === owner && !row.cancelled && !row.orderOutcome &&
      !row.settled && !_fuIsSettled(row) && (row._id || row.id) && Number.isFinite(Date.parse(row.deferredUntil || ''));
  }
  const keyOf = row => String(row._id || row.id) + ':' + new Date(row.deferredUntil).toISOString();
  function claim(key) {
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem(storageKey()) || '[]'); if (!Array.isArray(stored)) stored = []; } catch (_) {}
    if (seen.has(key) || stored.includes(key)) return false;
    seen.add(key);
    try { localStorage.setItem(storageKey(), JSON.stringify([...stored, key].slice(-500))); } catch (_) {}
    return true;
  }
  async function ensureAudio() {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return false;
      if (!audio || audio.state === 'closed') audio = new Context();
      if (audio.state === 'suspended') await audio.resume();
      return audio.state === 'running';
    } catch (_) { return false; }
  }
  // Two ascending three-note phrases: distinct from order bells and comment chimes.
  async function sound(force = false) {
    if (soundPending || muted() || (!force && Date.now() - lastSound < 4000)) return;
    soundPending = true;
    const user = owner;
    try {
      if (!await ensureAudio() || user !== account() || muted() || (!force && !queue.size)) return;
      lastSound = Date.now();
      const at = audio.currentTime;
      [0, 0.85].forEach(offset => [660, 880, 1100].forEach((frequency, index) => {
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        const start = at + offset + index * 0.19;
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
        oscillator.connect(gain); gain.connect(audio.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start); oscillator.stop(start + 0.42);
      }));
    } catch (_) { /* Keep the visual reminder usable when device audio is unavailable. */ }
    finally { soundPending = false; }
  }
  function render() {
    if (!queue.size) { host?.remove(); host = null; return; }
    if (!host) { host = document.createElement('aside'); host.className = 'fu-reminder'; document.body.append(host); }
    const [key, row] = queue.entries().next().value;
    const enableSound = muted() || audio?.state !== 'running';
    host.dir = en() ? 'ltr' : 'rtl';
    const at = new Intl.DateTimeFormat(en() ? 'en-GB' : 'ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(row.deferredUntil));
    host.innerHTML = `<div class="fu-reminder-heading"><span class="fu-reminder-bell" aria-hidden="true">⏰</span><div role="alert"><strong>${en() ? 'Time to follow up' : 'حان موعد المتابعة'}</strong><small>${en() ? 'Contact the customer now' : 'تواصل مع العميل الآن'}</small></div><button type="button" data-dismiss aria-label="${en() ? 'Dismiss reminder' : 'إخفاء التذكير'}">×</button></div>
      <p class="fu-reminder-order"><bdi>#${escHtml(row.orderRef || row.ticketNo || '')}</bdi> <span dir="auto">${escHtml(row.clientName || '')}</span></p>
      <p class="fu-reminder-reason">${escHtml(typeof myDeferReasonLabel === 'function' ? myDeferReasonLabel(row.deferReason) : '')}</p>
      <p class="fu-reminder-time"><bdi>${escHtml(at)}</bdi> · ${en() ? 'Cairo time' : 'بتوقيت القاهرة'}</p>
      ${queue.size > 1 ? `<p class="fu-reminder-count">${en() ? `${queue.size} follow-ups need your attention` : `عندك ${queue.size} متابعات حان موعدها`}</p>` : ''}
      <div class="fu-reminder-actions"><button type="button" class="btn btn-primary" data-open>${en() ? 'Open follow-up' : 'فتح المتابعة'}</button><button type="button" class="btn btn-outline" data-sound aria-pressed="${!muted()}">${muted() ? (en() ? 'Enable sound' : 'تشغيل الصوت') : audio?.state === 'running' ? (en() ? 'Mute sound' : 'كتم الصوت') : (en() ? 'Enable reminder sound' : 'تفعيل صوت التذكير')}</button></div>`;
    host.querySelector('[data-dismiss]').onclick = () => { queue.delete(key); render(); };
    host.querySelector('[data-open]').onclick = async event => {
      await openMyFollowUpTrail(String(row._id || row.id), '', event.currentTarget);
      if (String(fuCommentTargetId || '') === String(row._id || row.id)) { queue.delete(key); render(); }
    };
    host.querySelector('[data-sound]').onclick = async () => {
      const enable = enableSound;
      try { localStorage.setItem(muteKey(), enable ? 'on' : 'off'); } catch (_) {}
      if (enable) await sound(true);
      render();
    };
  }
  async function notify(row) {
    syncOwner();
    if (!valid(row) || Date.parse(row.deferredUntil) > Date.now()) return false;
    const user = owner, key = keyOf(row), version = revision;
    const show = () => {
      if (user !== account() || (version !== revision && !activeKeys.has(key)) || !claim(key)) return false;
      queue.set(key, row); render(); void sound();
      if (!muted()) { try { navigator.vibrate?.([180, 90, 180, 90, 320]); } catch (_) {} }
      return true;
    };
    // Serialize claims across tabs so one appointment cannot play several chimes.
    if (navigator.locks?.request) return navigator.locks.request('followup-reminder:' + user, show);
    return show();
  }
  function sync(rows) {
    syncOwner(); clearTimeout(timer);
    if (!owner || !Array.isArray(rows)) return;
    const active = rows.filter(valid), keys = new Set(active.map(keyOf));
    revision++; activeKeys = keys;
    let changed = false;
    for (const key of queue.keys()) if (!keys.has(key)) { queue.delete(key); changed = true; }
    if (changed) render();
    const now = Date.now();
    active.filter(row => Date.parse(row.deferredUntil) <= now).forEach(row => { void notify(row); });
    const future = active.map(row => Date.parse(row.deferredUntil)).filter(at => at > now);
    if (future.length) timer = setTimeout(refresh, Math.min(2147483647, Math.max(1, Math.min(...future) - now + 30)));
  }
  async function refresh() {
    const user = syncOwner();
    if (!user || !_canAccessPage('followups') || request) return;
    const task = api('/followups'); request = task;
    try { const rows = await task; if (user === account()) sync(rows); }
    catch (_) { /* The socket and next poll retry without discarding visible reminders. */ }
    finally { if (request === task) request = null; }
  }
  window.souliaFollowUpReminder = { notify, sync, refresh, reset };
  // Unlock browser audio during a real user gesture; visual reminders work without it.
  const unlock = () => { if (syncOwner() && !muted()) void ensureAudio(); };
  document.addEventListener('pointerdown', unlock, { passive: true });
  document.addEventListener('keydown', unlock);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('focus', refresh);
  setInterval(refresh, 60000);
  void refresh();
})();
