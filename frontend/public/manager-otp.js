/* Manager code for a record edit — «تعديل بكود المدير» (Nov 25, 2026).
   SouliaManagerOtp.ask({entity, id, label, fields, summary}) → Promise<otpId | null>.
   Asks the server for a code (POST /discount-otp/record-edit-request — it notifies every admin),
   shows the 4-box entry (pinBoxesHtml, Arabic digits accepted), verifies it
   (POST /discount-otp/validate) and resolves with the verified otpId. The SAVE sends that id; the
   server spends it once and only for the fields named here (consumeRecordEditOtp).
   Cancel / Escape resolves null — nothing is saved. Native <dialog>: above every window. */
(function () {
  'use strict';
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const tr = (a, e) => (en() ? e : a);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let open = false;

  async function request(args) {
    return api('/discount-otp/record-edit-request', { method: 'POST', body: JSON.stringify(args) });
  }

  async function ask(args) {
    if (open) return null;
    let res;
    try { res = await request(args); }
    catch (e) { if (typeof toast === 'function') toast(tr('تعذّر طلب كود المدير: ', 'Could not request a manager code: ') + (e?.message || ''), true); return null; }
    open = true;
    return new Promise(resolve => {
      let otpId = res.otpId, finished = false, busy = false;
      const d = document.createElement('dialog');
      d.className = 'mgr-otp';
      d.dir = en() ? 'ltr' : 'rtl';
      const entry = typeof pinBoxesHtml === 'function'
        ? pinBoxesHtml('mgr-otp-input', { label: tr('كود المدير', 'Manager code'), ok: tr('تم التحقق', 'Verified'), autocomplete: 'one-time-code', enter: '_mgrOtpEnter' })
        : '<input id="mgr-otp-input" inputmode="numeric" maxlength="4" autocomplete="one-time-code">';
      d.innerHTML = `<div class="mgr-otp-card">
        <h3 class="mgr-otp-title">${tr('يتطلب الحفظ كود المدير', 'Saving needs a manager code')}</h3>
        <p class="mgr-otp-lead">${tr('أُرسل طلب إلى المديرين. أدخل الكود المكوّن من 4 أرقام الذي يعطيك إياه المدير.', 'A request was sent to the managers. Enter the 4-digit code they give you.')}</p>
        <div class="mgr-otp-what"><b>${esc(args.label || '—')}</b><span>${esc(tr('التعديلات', 'Changes'))}: ${esc(args.summary || (args.fields || []).join(', '))}</span></div>
        <div class="mgr-otp-entry">${entry}</div>
        <div class="mgr-otp-msg" role="alert" aria-live="polite"></div>
        <div class="mgr-otp-foot">
          <button type="button" class="mgr-otp-link" data-act="resend">${tr('طلب كود جديد', 'Request a new code')}</button>
          <span class="mgr-otp-gap"></span>
          <button type="button" class="btn btn-outline btn-sm" data-act="cancel">${tr('إلغاء', 'Cancel')}</button>
          <button type="button" class="btn btn-primary btn-sm" data-act="ok">${tr('تحقق واحفظ', 'Verify and save')}</button>
        </div></div>`;
      document.body.append(d);
      const msg = d.querySelector('.mgr-otp-msg');
      const input = () => d.querySelector('#mgr-otp-input');
      const say = (text, ok) => { msg.textContent = text || ''; msg.classList.toggle('is-ok', !!ok); };
      const finish = value => {
        if (finished) return; finished = true; open = false;
        try { d.close(); } catch (_) {}
        d.remove(); delete window._mgrOtpEnter; resolve(value);
      };
      async function submit() {
        if (busy) return;
        const raw = String(input()?.value || '').replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).trim();
        if (!/^\d{4}$/.test(raw)) { say(tr('أدخل 4 أرقام', 'Enter 4 digits')); input()?.focus(); return; }
        busy = true; d.querySelector('[data-act="ok"]').disabled = true;
        try {
          const r = await api('/discount-otp/validate', { method: 'POST', body: JSON.stringify({ otpId, otp: raw }) });
          if (r && r.valid) { say(tr('✓ تم التحقق — جارٍ الحفظ', '✓ Verified — saving'), true); setTimeout(() => finish(otpId), 250); return; }
          say((r && r.message) || tr('الكود غير صحيح', 'Wrong code'));
          if (input()) { input().value = ''; input().dispatchEvent(new Event('input')); input().focus(); }
        } catch (e) { say(e?.message || tr('تعذّر التحقق', 'Could not verify')); }
        finally { busy = false; const b = d.querySelector('[data-act="ok"]'); if (b) b.disabled = false; }
      }
      window._mgrOtpEnter = submit;
      d.addEventListener('click', async e => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'cancel') finish(null);
        else if (b.dataset.act === 'ok') submit();
        else if (b.dataset.act === 'resend') {
          try { const r = await request(args); otpId = r.otpId; say(tr('أُرسل طلب كود جديد للمديرين', 'A new code was requested'), true); }
          catch (err) { say(err?.message || tr('تعذّر طلب كود جديد', 'Could not request a new code')); }
        }
      });
      d.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
      d.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('#mgr-otp-input, .pinbx')) { e.preventDefault(); submit(); } });
      d.showModal();
      setTimeout(() => input()?.focus(), 60);
    });
  }

  window.SouliaManagerOtp = { ask };
})();
