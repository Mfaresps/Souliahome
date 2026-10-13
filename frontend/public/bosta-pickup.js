/* Warehouse pickup requests are separate from shipment creation. */
let _bostaPickupForm = null;
let _bostaPickupBusy = false;
function _bpText(ar, en) { return currentLang === 'en' ? en : ar; }
function _bpReason(reason) {
  const labels = {
    friday: ['الجمعة إجازة', 'Friday off'], holiday: ['إجازة بوسطا', 'Bosta holiday'],
    cutoff: ['انتهى وقت طلب اليوم', 'Same-day cutoff passed'], duplicate: ['يوجد طلب استلام', 'Pickup already requested'],
    uncertain: ['راجع طلبًا سابقًا في بوسطا', 'Check previous request in Bosta'],
    past: ['تاريخ مضى', 'Past date'], invalid: ['تاريخ غير صحيح', 'Invalid date'],
  };
  return labels[reason] ? _bpText(...labels[reason]) : '';
}
function _bpRenderDates(schedule, previous) {
  const select = qs('#bp-date');
  const available = schedule.dates.filter(d => !d.reason);
  select.innerHTML = schedule.dates.map(d => {
    const label = new Intl.DateTimeFormat(currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d.date + 'T12:00:00Z'));
    return `<option value="${d.date}" ${d.reason ? 'disabled' : ''}>${esc(label)}${d.reason ? ' · ' + esc(_bpReason(d.reason)) : ''}</option>`;
  }).join('');
  select.value = available.some(d => d.date === previous) ? previous : schedule.earliestDate;
  qs('#bp-schedule-hint').textContent = _bpText(`طلب استلام نفس اليوم قبل ${schedule.cutoffTime} بتوقيت القاهرة. الجمعة والإجازات المسجلة غير متاحة. المواعيد للـ30 يومًا القادمة، والتأكيد النهائي من بوسطا.`, `Same-day requests before ${schedule.cutoffTime} Cairo time. Fridays and recorded holidays are unavailable. Dates cover the next 30 days; Bosta confirms final availability.`);
  const submit = qs('#bosta-pickup-form button[type="submit"]');
  if (submit) submit.disabled = _bostaPickupBusy || !available.length;
  if (!available.length) qs('#bp-error').textContent = _bpText('لا يوجد موعد متاح خلال 30 يومًا — راجع بوسطا أو إعدادات الإجازات.', 'No dates available within 30 days — check Bosta or the holiday settings.');
  return !previous || select.value === previous;
}
async function _bpRefreshSchedule() {
  const state = _bostaPickupForm;
  const location = qs('#bp-location')?.value;
  if (!state || !location || !qs('#bp-date')) return false;
  const previous = qs('#bp-date').value;
  const sequence = state.scheduleSequence = (state.scheduleSequence || 0) + 1;
  const schedule = await api('/shipping/pickup-schedule?businessLocationId=' + encodeURIComponent(location));
  if (state !== _bostaPickupForm || sequence !== state.scheduleSequence || location !== qs('#bp-location')?.value || !qs('#bp-date')) return false;
  state.schedule = schedule;
  const unchanged = _bpRenderDates(schedule, previous);
  if (!unchanged) qs('#bp-error').textContent = _bpText('الموعد السابق لم يعد متاحًا. تم اقتراح أقرب موعد؛ راجعه ثم أكد الطلب.', 'The previous date is unavailable. Review the suggested next date before confirming.');
  return unchanged && !!schedule.earliestDate;
}
async function _bpLocationChanged() {
  _bpFillContact();
  const button = qs('#bosta-pickup-form button[type="submit"]');
  if (button) button.disabled = true;
  try { await _bpRefreshSchedule(); }
  catch (e) { if (qs('#bp-error')) qs('#bp-error').textContent = e.message; }
}
async function openBostaPickup(button) {
  if (_bostaPickupBusy) return;
  _bostaPickupBusy = true;
  if (button) button.disabled = true;
  try {
    const [preview, locations] = await Promise.all([api('/shipping/pickup-preview'), api('/shipping/pickup-locations')]);
    _bostaPickupForm = { preview, locations };
    const requests = (preview.requests || []).map(r => `<p style="font-size:.8rem"><bdi>${esc(r.scheduledDate)}</bdi> · ${esc(String(r.numberOfParcels))} ${_bpText('طرد', 'parcels')} · ${r.status === 'created' ? _bpText('تم طلب الاستلام', 'Pickup requested') : _bpText('راجع نتيجة الطلب في بوسطا قبل إعادة المحاولة', 'Check the request in Bosta before retrying')}</p>`).join('');
    const canRequest = preview.orders.length > 0 && locations.length > 0;
    openModal(`<h3>${_bpText('طلب استلام من بوسطا', 'Request Bosta pickup')}</h3>
      ${requests}
      <p>${_bpText('عدد الطرود من كل أوردرات بوسطا الجاهزة:', 'Parcels from all ready Bosta orders:')} <strong dir="ltr">${preview.numberOfParcels}</strong></p>
      <p class="text-muted" style="font-size:.8rem">${_bpText('أوردر واحد = طرد واحد. العدد لا يتأثر بفلاتر البحث، ويستبعد ما تم طلب استلامه بالفعل.', 'One order = one parcel. Search filters do not affect the count; orders already scheduled are excluded.')}</p>
      ${!preview.orders.length ? `<p>${_bpText('لا توجد شحنات جديدة جاهزة للاستلام. أرسل الأوردرات الجاهزة إلى بوسطا أولًا.', 'No new shipments ready for pickup. Send ready orders to Bosta first.')}</p>` : ''}
      ${!locations.length ? `<p>${_bpText('أضف مخزن استلام في حساب بوسطا أولًا.', 'Add a pickup location in your Bosta account first.')}</p>` : ''}
      ${canRequest ? `<form id="bosta-pickup-form" onsubmit="event.preventDefault();submitBostaPickup(this)">
        <div class="form-group"><label for="bp-location">${_bpText('مخزن الاستلام', 'Pickup warehouse')}</label><select id="bp-location" required onchange="_bpLocationChanged()">${locations.map(l => `<option value="${escHtml(l.id)}">${esc(l.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label for="bp-date">${_bpText('تاريخ الاستلام', 'Pickup date')}</label><select id="bp-date" required aria-describedby="bp-schedule-hint"></select><p id="bp-schedule-hint" class="text-muted" style="font-size:.8rem"></p></div>
        <div class="form-group"><label for="bp-name">${_bpText('اسم مسؤول التسليم', 'Contact name')}</label><input id="bp-name" required maxlength="100" autocomplete="name"></div>
        <div class="form-group"><label for="bp-phone">${_bpText('رقم مسؤول التسليم', 'Contact phone')}</label><input id="bp-phone" type="tel" dir="ltr" required placeholder="01xxxxxxxxx" autocomplete="tel"></div>
        <p id="bp-error" role="alert" style="color:var(--red)"></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="submit" class="btn btn-primary">${_bpText('تأكيد طلب الاستلام', 'Confirm pickup request')}</button><button type="button" class="btn btn-outline" onclick="closeModal()">${_bpText('إلغاء', 'Cancel')}</button></div>
      </form>` : `<button class="btn btn-outline" onclick="closeModal()">${_bpText('إغلاق', 'Close')}</button>`}`, 'max-width:460px');
    if (canRequest) { _bpFillContact(); await _bpRefreshSchedule(); }
  } catch (e) { toast(e.message, true); }
  finally {
    _bostaPickupBusy = false;
    if (button) button.disabled = false;
    const submit = qs('#bosta-pickup-form button[type="submit"]');
    if (submit) submit.disabled = !_bostaPickupForm?.schedule?.earliestDate;
  }
}
function _bpFillContact() {
  const location = _bostaPickupForm?.locations.find(l => l.id === qs('#bp-location')?.value);
  if (!location) return;
  qs('#bp-name').value = location.contactName || '';
  qs('#bp-phone').value = location.contactPhone || '';
}
async function submitBostaPickup(form) {
  if (_bostaPickupBusy || !_bostaPickupForm || !form.reportValidity()) return;
  const date = qs('#bp-date').value;
  const error = qs('#bp-error');
  const choice = _bostaPickupForm.schedule?.dates.find(d => d.date === date);
  if (!choice || choice.reason) { error.textContent = _bpReason(choice?.reason || 'invalid'); return; }
  const phone = qs('#bp-phone').value.replace(/[\s()-]/g, '');
  if (!/^(?:\+20|0020|20|0)1[0125]\d{8}$/.test(phone)) {
    error.textContent = _bpText('أدخل رقم موبايل مصري صحيح لمسؤول التسليم.', 'Enter a valid Egyptian mobile number for the contact.'); return;
  }
  const body = { scheduledDate: date, businessLocationId: qs('#bp-location').value,
    contactName: qs('#bp-name').value.trim(), contactPhone: phone,
    orderIds: _bostaPickupForm.preview.orders.map(o => o.id) };
  _bostaPickupBusy = true;
  form.querySelectorAll('button').forEach(b => b.disabled = true);
  error.textContent = '';
  try {
    if (!await _bpRefreshSchedule()) return;
    if (!qs('#bp-date') || qs('#bp-date').value !== date || qs('#bp-location').value !== body.businessLocationId) {
      error.textContent = _bpText('تغير الموعد أو المخزن — راجع الاختيار قبل التأكيد.', 'The date or warehouse changed — review before confirming.'); return;
    }
    const result = await api('/shipping/pickups', { method: 'POST', body: JSON.stringify(body) });
    _bostaPickupForm = null;
    openModal(`<h3>${_bpText('تم طلب الاستلام من بوسطا', 'Bosta pickup requested')}</h3><p><bdi>${esc(result.scheduledDate)}</bdi> · ${esc(String(result.numberOfParcels))} ${_bpText('طرد', 'parcels')}</p><p class="text-muted">${_bpText('الشحنات تظل جاهزة حتى يؤكد بوسطا استلام المندوب لها.', 'Shipments stay ready until Bosta confirms courier collection.')}</p><button type="button" class="btn btn-primary" onclick="closeModal()">${_bpText('تم', 'Done')}</button>`, 'max-width:460px');
  } catch (e) {
    let message = e.pickupReason ? _bpReason(e.pickupReason) : e.message;
    try {
      const unchanged = await _bpRefreshSchedule();
      if (!unchanged) message += _bpText(' — راجع الموعد المقترح ثم أكد مجددًا.', ' — review the suggested date and confirm again.');
    } catch (_) { message += _bpText(' — تعذر تحديث المواعيد؛ أعد فتح النافذة.', ' — dates could not be refreshed; reopen the dialog.'); _bostaPickupForm.schedule = null; }
    error.textContent = message;
  }
  finally {
    _bostaPickupBusy = false;
    form.querySelectorAll('button').forEach(b => b.disabled = false);
    const submit = form.querySelector('button[type="submit"]');
    if (submit && _bostaPickupForm) submit.disabled = !_bostaPickupForm.schedule?.earliestDate;
  }
}

setInterval(() => {
  if (!_bostaPickupBusy && qs('#bp-date') && !document.hidden) _bpRefreshSchedule().catch(e => {
    if (qs('#bp-error')) qs('#bp-error').textContent = e.message;
    const submit = qs('#bosta-pickup-form button[type="submit"]');
    if (submit) submit.disabled = true;
  });
}, 60000);

function renderBostaPickupPolicy() {
  const card = qs('#stg-bosta-pickup-policy');
  if (!card) return;
  card.style.display = isAdmin() ? '' : 'none';
  if (!isAdmin()) return;
  card.innerHTML = `<h3>${_bpText('مواعيد استلام بوسطا', 'Bosta pickup scheduling')}</h3>
    <form onsubmit="event.preventDefault();saveBostaPickupPolicy(this)">
      <div class="form-group"><label for="bp-cutoff-setting">${_bpText('آخر وقت لطلب استلام نفس اليوم — بتوقيت القاهرة', 'Same-day request cutoff — Cairo time')}</label><input id="bp-cutoff-setting" type="time" required value="${escHtml(settings.bostaPickupCutoffTime || '16:00')}"></div>
      <div class="form-group"><label for="bp-holidays-setting">${_bpText('إجازات بوسطا المعلنة — تاريخ YYYY-MM-DD في كل سطر', 'Announced Bosta holidays — one YYYY-MM-DD date per line')}</label><textarea id="bp-holidays-setting" dir="ltr" rows="4" placeholder="YYYY-MM-DD">${esc((settings.bostaPickupHolidayDates || []).join('\n'))}</textarea></div>
      <p class="text-muted" style="font-size:.8rem">${_bpText('الجمعة مستبعدة تلقائيًا. أضف فقط الإجازات التي أعلنها بوسطا، وعدّل وقت الإغلاق إذا اختلف موعد حسابك أو مواعيد رمضان.', 'Fridays are excluded automatically. Add holidays announced by Bosta; adjust the cutoff for your account or Ramadan hours.')}</p>
      <p role="alert" id="bp-policy-error" style="color:var(--red)"></p><button type="submit" class="btn btn-primary btn-sm">${_bpText('حفظ المواعيد', 'Save schedule')}</button>
    </form>`;
}
async function saveBostaPickupPolicy(form) {
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const error = qs('#bp-policy-error'); error.textContent = '';
  const holidayDates = [...new Set(qs('#bp-holidays-setting').value.split(/[\s,،]+/).filter(Boolean))];
  if (holidayDates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(new Date(date + 'T00:00:00Z').getTime()) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date)) {
    error.textContent = _bpText('أدخل تواريخ صحيحة بصيغة YYYY-MM-DD.', 'Enter valid YYYY-MM-DD dates.'); return;
  }
  const values = { bostaPickupCutoffTime: qs('#bp-cutoff-setting').value, bostaPickupHolidayDates: holidayDates };
  button.disabled = true;
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(values) }); Object.assign(settings, values); toast(_bpText('تم حفظ مواعيد استلام بوسطا', 'Bosta pickup schedule saved')); }
  catch (e) { error.textContent = e.message; }
  finally { button.disabled = false; }
}
