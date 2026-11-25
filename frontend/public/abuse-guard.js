/* Tampering protection, page side (Nov 25, 2026). Server: backend/src/abuse-guard/.
   · SouliaAbuse.suspended(payload) — full-screen «تم إيقاف حسابك مؤقتًا» (from a 423 reply or the
     `account:suspended` socket event); counts down and closes itself when the suspension ends.
   · SouliaAbuse.restored()          — an admin lifted it (`account:restored`).
   · SouliaAbuse.warn(message)       — amber warning bar (`abuse:warning`, 8 s). */
(function () {
  'use strict';
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const tr = (a, e) => (en() ? e : a);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  let box = null, timer = null, current = null;

  function left(until) {
    const ms = new Date(until).getTime() - Date.now();
    if (ms <= 0) return '';
    const m = Math.ceil(ms / 60000);
    if (m < 60) return en() ? `${m} min` : `${m} دقيقة`;
    const h = Math.floor(m / 60), r = m % 60;
    return en() ? `${h} h ${r} min` : `${h} ساعة${r ? ' و' + r + ' دقيقة' : ''}`;
  }

  function suspended(p) {
    p = p || {};
    if (typeof isAdmin === 'function' && isAdmin()) return;
    current = p;
    // ⚠ Built ONCE. While suspended, every background request returns 423 and calls this again;
    // rebuilding the card each time re-created the button under the mouse — it flickered.
    // Later calls only update the two lines of text, and only when they change.
    if (!box) {
      box = document.createElement('div');
      box.className = 'ag-overlay'; box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true');
      box.dir = en() ? 'ltr' : 'rtl';
      box.innerHTML = `<div class="ag-card">
        <div class="ag-ico">${LOCK}</div>
        <h2>${tr('تم إيقاف حسابك مؤقتًا', 'Your account is temporarily suspended')}</h2>
        <p class="ag-reason"></p>
        <p class="ag-time"></p>
        <p class="ag-note">${tr('أُبلغ المدير بالأمر. إذا كان ذلك خطأ فتواصل معه.', 'A manager has been notified. If this is a mistake, contact them.')}</p>
        <button type="button" class="btn btn-outline btn-sm" data-ag-logout>${tr('تسجيل الخروج', 'Sign out')}</button>
      </div>`;
      box.querySelector('[data-ag-logout]').onclick = () => { if (typeof doLogout === 'function') doLogout(); hide(); };
      document.body.append(box);
      timer = setInterval(paint, 30000);
    }
    paint();
  }

  /* Updates only the reason and the time left; never touches the button. */
  function paint() {
    if (!box || !current) return;
    const p = current;
    const remaining = p.until ? left(p.until) : '';
    if (p.until && !remaining) { restored(true); return; }
    const reasonHtml = `${esc(tr('السبب', 'Reason'))}: <b>${esc(p.reason || tr('نشاط غير معتاد', 'unusual activity'))}</b>`;
    const timeHtml = p.untilLifted || !p.until
      ? esc(tr('يستمر الإيقاف حتى يرفعه المدير.', 'It stays until a manager lifts it.'))
      : esc(tr('ينتهي الإيقاف تلقائيًا بعد ', 'It ends automatically in ')) + `<b>${esc(remaining)}</b>`;
    const reasonEl = box.querySelector('.ag-reason'), timeEl = box.querySelector('.ag-time');
    if (reasonEl.innerHTML !== reasonHtml) reasonEl.innerHTML = reasonHtml;
    if (timeEl.innerHTML !== timeHtml) timeEl.innerHTML = timeHtml;
  }

  function hide() { clearInterval(timer); timer = null; box?.remove(); box = null; current = null; }

  function restored(byTime) {
    if (!box) return;
    hide();
    if (typeof toast === 'function') toast(byTime ? tr('انتهى الإيقاف المؤقت', 'The suspension has ended') : tr('رفع المدير الإيقاف عن حسابك', 'A manager lifted your suspension'));
  }

  function warn(message) {
    const bar = document.createElement('div');
    bar.className = 'ag-warn'; bar.setAttribute('role', 'alert'); bar.dir = en() ? 'ltr' : 'rtl';
    bar.innerHTML = `<span class="ag-warn-ico" aria-hidden="true">!</span><span>${esc(message)}</span>`;
    document.body.append(bar);
    setTimeout(() => bar.classList.add('is-out'), 8000);
    setTimeout(() => bar.remove(), 8600);
  }

  window.SouliaAbuse = { suspended, restored: () => restored(false), warn, hide };
})();
