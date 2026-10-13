/* Warehouse pickup requests are separate from shipment creation. */
let _bostaPickupForm = null;
let _bostaPickupBusy = false;
let _bostaPickupRequests = [];
const _bpCheck = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
function _bpSetRequests(requests) { _bostaPickupRequests = requests || []; }
async function refreshBostaPickupRequests() {
  const preview = await api('/shipping/pickup-preview');
  _bpSetRequests(preview.requests);
  return preview;
}
function bostaPickupCardBadge(orders) {
  const covered = orders.map(o => _bostaPickupRequests.find(r => ['created', 'pending'].includes(r.status) && (r.orderIds || []).includes(String(o._id)))).filter(Boolean);
  if (!covered.length) return '';
  const pending = covered.some(r => r.status === 'pending');
  const label = pending ? _bpText('طلب استلام قيد التأكيد', 'Pickup awaiting confirmation') : _bpText('تم طلب الاستلام', 'Pickup requested');
  const detail = [...new Set(covered.map(r => `${r.scheduledDate} · ${r.requestedBy || _bpText('غير مسجل', 'Not recorded')}`))].join(' / ');
  return `<span class="bp-card-badge ${pending ? 'bp-pending' : ''}" title="${escHtml(detail)}">${pending ? '◷' : _bpCheck}${esc(label)}${covered.length < orders.length ? ` (${covered.length}/${orders.length})` : ''}</span>`;
}
function _bpHistory(requests) {
  return `<details class="bp-history" ${requests.length ? 'open' : ''}><summary>${_bpText('طلبات الاستلام', 'Pickup requests')} <span>${requests.length}</span></summary><div class="bp-history-list">${requests.length ? requests.map(r => {
    const created = r.status === 'created';
    const label = created ? _bpText('تم طلب الاستلام', 'Pickup requested') : r.status === 'rejected' ? _bpText('رُفض الطلب', 'Request rejected') : _bpText('قيد التأكيد — راجع بوسطة قبل إعادة المحاولة', 'Awaiting confirmation — check Bosta before retrying');
    return `<article class="bp-history-item"><div class="bp-history-heading"><bdi>${esc(r.scheduledDate)}</bdi><span class="bp-card-badge ${created ? '' : 'bp-pending'}">${created ? _bpCheck : '◷'}${esc(label)}</span></div><p>${esc(String(r.numberOfParcels))} ${_bpText('طرد', 'parcels')} · ${_bpText('أرسل الطلب:', 'Requested by:')} <bdi>${esc(r.requestedBy || _bpText('غير مسجل', 'Not recorded'))}</bdi></p>${r.createdAt ? `<p class="text-muted">${_bpText('وقت الإرسال:', 'Sent at:')} <bdi>${esc(new Intl.DateTimeFormat(currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(r.createdAt)))}</bdi></p>` : ''}${r.bostaPickupId ? `<p class="text-muted">${_bpText('رقم الطلب:', 'Request ID:')} <bdi>${esc(r.bostaPickupId)}</bdi></p>` : ''}</article>`;
  }).join('') : `<p class="text-muted">${_bpText('لا توجد طلبات استلام مسجلة.', 'No pickup requests recorded.')}</p>`}</div></details>`;
}
function _bpText(ar, en) { return currentLang === 'en' ? en : ar; }
function _bpReason(reason) {
  const labels = {
    friday: ['الجمعة إجازة', 'Friday off'], holiday: ['إجازة بوسطة', 'Bosta holiday'],
    cutoff: ['انتهى وقت طلب اليوم', 'Same-day cutoff passed'], duplicate: ['يوجد طلب استلام', 'Pickup already requested'],
    uncertain: ['راجع طلبًا سابقًا في بوسطة', 'Check previous request in Bosta'],
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
  qs('#bp-schedule-hint').textContent = _bpText(`طلب استلام نفس اليوم قبل ${schedule.cutoffTime} بتوقيت القاهرة. الجمعة والإجازات المسجلة غير متاحة. المواعيد للـ30 يومًا القادمة، والتأكيد النهائي من بوسطة.`, `Same-day requests before ${schedule.cutoffTime} Cairo time. Fridays and recorded holidays are unavailable. Dates cover the next 30 days; Bosta confirms final availability.`);
  const submit = qs('#bosta-pickup-form button[type="submit"]');
  if (submit) submit.disabled = _bostaPickupBusy || !available.length;
  if (!available.length) qs('#bp-error').textContent = _bpText('لا يوجد موعد متاح خلال 30 يومًا — راجع بوسطة أو إعدادات الإجازات.', 'No dates available within 30 days — check Bosta or the holiday settings.');
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
  if (_bostaPickupForm) _bostaPickupForm.schedule = null;
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
    const [previewResult, locationsResult] = await Promise.allSettled([api('/shipping/pickup-preview'), api('/shipping/pickup-locations')]);
    if (previewResult.status === 'rejected') throw previewResult.reason;
    const preview = previewResult.value;
    const locations = locationsResult.status === 'fulfilled' ? locationsResult.value : [];
    _bostaPickupForm = { preview, locations };
    _bpSetRequests(preview.requests);
    if (typeof renderPickupBoard === 'function') renderPickupBoard();
    const requests = _bpHistory(preview.requests || []);
    const canRequest = preview.orders.length > 0 && locations.length > 0;
    openModal(`<div class="bp-dialog"><h3>${_bpText('طلب استلام من بوسطة', 'Request Bosta pickup')}</h3>
      <div class="bp-count"><span>${_bpText('الطرود الجاهزة لطلب الاستلام', 'Parcels ready for pickup request')}</span> <strong dir="ltr">${preview.numberOfParcels}</strong></div>
      <p class="text-muted" style="font-size:.8rem">${_bpText('أوردر واحد = طرد واحد. العدد لا يتأثر بفلاتر البحث، ويستبعد ما تم طلب استلامه بالفعل.', 'One order = one parcel. Search filters do not affect the count; orders already scheduled are excluded.')}</p>
      ${!preview.orders.length ? `<p class="bp-empty">${_bpText('لا توجد شحنات جديدة تحتاج طلب استلام. يمكنك مراجعة الطلبات المسجلة أدناه.', 'No new shipments need a pickup request. Review recorded requests below.')}</p>` : ''}
      ${locationsResult.status === 'rejected' ? `<p role="alert">${_bpText('تعذر تحميل مخازن بوسطة:', 'Could not load Bosta warehouses:')} ${esc(locationsResult.reason.message)}</p>` : !locations.length ? `<p>${_bpText('أضف مخزن استلام في حساب بوسطة أولًا.', 'Add a pickup location in your Bosta account first.')}</p>` : ''}
      ${canRequest ? `<form id="bosta-pickup-form" onsubmit="event.preventDefault();submitBostaPickup(this)">
        <div class="form-group"><label for="bp-location">${_bpText('مخزن الاستلام', 'Pickup warehouse')}</label><select id="bp-location" required onchange="_bpLocationChanged()">${locations.map(l => `<option value="${escHtml(l.id)}">${esc(l.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label for="bp-date">${_bpText('تاريخ الاستلام', 'Pickup date')}</label><select id="bp-date" required aria-describedby="bp-schedule-hint"></select><p id="bp-schedule-hint" class="text-muted" style="font-size:.8rem"></p></div>
        <div class="form-group"><label for="bp-name">${_bpText('اسم مسؤول التسليم', 'Contact name')}</label><input id="bp-name" required maxlength="100" autocomplete="name"></div>
        <div class="form-group"><label for="bp-phone">${_bpText('رقم مسؤول التسليم', 'Contact phone')}</label><input id="bp-phone" type="tel" dir="ltr" required placeholder="01xxxxxxxxx" autocomplete="tel"></div>
        <p id="bp-error" role="alert" style="color:var(--red)"></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="submit" class="btn btn-primary">${_bpText('تأكيد طلب الاستلام', 'Confirm pickup request')}</button><button type="button" class="btn btn-outline" onclick="closeModal()">${_bpText('إلغاء', 'Cancel')}</button></div>
      </form>` : ''}${requests}${!canRequest ? `<button type="button" class="btn btn-outline" onclick="closeModal()">${_bpText('إغلاق', 'Close')}</button>` : ''}</div>`, 'width:560px;max-width:calc(100vw - 32px)');
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
  form.querySelectorAll('button, input, select').forEach(b => b.disabled = true);
  error.textContent = '';
  try {
    if (!await _bpRefreshSchedule()) return;
    if (!qs('#bp-date') || qs('#bp-date').value !== date || qs('#bp-location').value !== body.businessLocationId) {
      error.textContent = _bpText('تغير الموعد أو المخزن — راجع الاختيار قبل التأكيد.', 'The date or warehouse changed — review before confirming.'); return;
    }
    const result = await api('/shipping/pickups', { method: 'POST', body: JSON.stringify(body) });
    if (result.success !== true) throw new Error(_bpText('لم يتم تأكيد طلب الاستلام.', 'Pickup request was not confirmed.'));
    _bpSetRequests([{ ...result, status: 'created', orderIds: body.orderIds }, ..._bostaPickupRequests]);
    if (typeof renderPickupBoard === 'function') renderPickupBoard();
    _bostaPickupForm = null;
    openModal(`<div class="bp-dialog bp-success" role="status"><div class="bp-success-icon">${_bpCheck}</div><h3>${_bpText('تم طلب الاستلام من بوسطة بنجاح', 'Bosta pickup requested successfully')}</h3><p><bdi>${esc(result.scheduledDate)}</bdi> · ${esc(String(result.numberOfParcels))} ${_bpText('طرد', 'parcels')}</p><p class="text-muted">${_bpText('سيظهر الطلب في سجل طلبات الاستلام، وتم وضع علامة على الأوردرات المشمولة. الشحنات تظل جاهزة حتى تؤكد بوسطة استلام المندوب لها.', 'The request is recorded and included orders are marked. Shipments stay ready until Bosta confirms courier collection.')}</p><div class="bp-actions"><button type="button" class="btn btn-primary" onclick="closeModal()">${_bpText('تم', 'Done')}</button><button type="button" class="btn btn-outline" onclick="openBostaPickup(this)">${_bpText('عرض طلبات الاستلام', 'View pickup requests')}</button></div></div>`, 'width:480px;max-width:calc(100vw - 32px)');
    refreshBostaPickupRequests().then(() => { if (typeof renderPickupBoard === 'function') renderPickupBoard(); }).catch(() => {});
  } catch (e) {
    let message = e.pickupReason ? _bpReason(e.pickupReason) : e.message;
    try {
      const unchanged = await _bpRefreshSchedule();
      if (!unchanged) message += _bpText(' — راجع الموعد المقترح ثم أكد مجددًا.', ' — review the suggested date and confirm again.');
    } catch (_) { message += _bpText(' — تعذر تحديث المواعيد؛ أعد فتح النافذة.', ' — dates could not be refreshed; reopen the dialog.'); if (_bostaPickupForm) _bostaPickupForm.schedule = null; }
    error.textContent = message;
    refreshBostaPickupRequests().then(() => { if (typeof renderPickupBoard === 'function') renderPickupBoard(); }).catch(() => {});
  }
  finally {
    _bostaPickupBusy = false;
    form.querySelectorAll('button, input, select').forEach(b => b.disabled = false);
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
  card.innerHTML = `<h3>${_bpText('مواعيد استلام بوسطة', 'Bosta pickup scheduling')}</h3>
    <form onsubmit="event.preventDefault();saveBostaPickupPolicy(this)">
      <div class="form-group"><label for="bp-cutoff-setting">${_bpText('آخر وقت لطلب استلام نفس اليوم — بتوقيت القاهرة', 'Same-day request cutoff — Cairo time')}</label><input id="bp-cutoff-setting" type="time" required value="${escHtml(settings.bostaPickupCutoffTime || '16:00')}"></div>
      <div class="form-group"><label for="bp-holidays-setting">${_bpText('إجازات بوسطة المعلنة — تاريخ YYYY-MM-DD في كل سطر', 'Announced Bosta holidays — one YYYY-MM-DD date per line')}</label><textarea id="bp-holidays-setting" dir="ltr" rows="4" placeholder="YYYY-MM-DD">${esc((settings.bostaPickupHolidayDates || []).join('\n'))}</textarea></div>
      <p class="text-muted" style="font-size:.8rem">${_bpText('الجمعة مستبعدة تلقائيًا. أضف فقط الإجازات التي أعلنتها بوسطة، وعدّل وقت الإغلاق إذا اختلف موعد حسابك أو مواعيد رمضان.', 'Fridays are excluded automatically. Add holidays announced by Bosta; adjust the cutoff for your account or Ramadan hours.')}</p>
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
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(values) }); Object.assign(settings, values); toast(_bpText('تم حفظ مواعيد استلام بوسطة', 'Bosta pickup schedule saved')); }
  catch (e) { error.textContent = e.message; }
  finally { button.disabled = false; }
}
