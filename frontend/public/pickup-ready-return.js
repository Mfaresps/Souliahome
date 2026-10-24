const _puReadyReturnBusy = new Set();
function _puReadyReturnButtonsHtml(order) {
  if (!_puDailyAwaitingPickup(order)) return '';
  const en = currentLang === 'en', id = esc(String(order._id));
  const busy = _puReadyReturnBusy.size ? 'disabled aria-busy="true"' : '';
  return `<button type="button" class="pw-abtn is-warn" data-ready-return="${id}" data-return-mode="pending" ${busy}
    onclick="pucoRestoreFromReady(this.dataset.readyReturn)" title="${en ? 'Cancel preparation and remove scanned piece identities from this invoice' : 'إلغاء التحضير وإزالة أكواد القطع الممسوحة من الفاتورة'}">↩ ${en ? 'Return to Pending' : 'إرجاع للمعلّق'}</button>
    <button type="button" class="pw-abtn is-go" data-ready-return="${id}" data-return-mode="preparing" ${busy}
    onclick="pucoReturnReadyToPrep(this.dataset.readyReturn)" title="${en ? 'Keep preparation and scanned piece identities' : 'الاحتفاظ بالتحضير وهوية القطع الممسوحة'}">↩ ${en ? 'Return to Preparing' : 'إرجاع للتحضير'}</button>`;
}
function _puChooseReturnPrepGroup(order, groups) {
  const en = currentLang === 'en', host = document.createElement('div');
  host.className = 'pu-return-target'; host.id = 'pu-return-target';
  const focus = document.activeElement, overflow = document.body.style.overflow;
  host.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="pu-return-target-title" dir="${en ? 'ltr' : 'rtl'}">
    <h3 id="pu-return-target-title">${en ? 'Return to Preparing' : 'إرجاع للتحضير'} <bdi>#${esc(order.ref || '—')}</bdi></h3>
    <p>${en ? 'Preparation checks, scanned pieces and Piece identity will be preserved.' : 'سيتم الاحتفاظ بحالة التحضير والقطع الممسوحة وبيانات Piece identity كما هي.'}</p>
    <label>${en ? 'Choose a preparation group' : 'اختر مجموعة التحضير'}<select id="pu-return-prep-select">
      ${groups.length ? `<option value="" disabled selected>${en ? 'Choose a group…' : 'اختر المجموعة…'}</option>` : ''}
      ${groups.map(group => `<option value="${esc(group.prepRef)}">${esc(group.prepRef)} · ${group.orders.length} ${en ? 'orders' : 'أوردر'}${group.note ? ' · '+esc(group.note) : ''}</option>`).join('')}
      <option value="__new__">${en ? 'New preparation group' : 'مجموعة تحضير جديدة'}</option></select></label>
    <button type="button" class="btn btn-outline pu-return-create" data-return-create aria-pressed="${!groups.length}">＋ ${en ? 'New preparation group' : 'مجموعة تحضير جديدة'}</button>
    <footer><button type="button" class="btn btn-outline" data-return-cancel>${en ? 'Cancel' : 'إلغاء'}</button>
      <button type="button" class="btn btn-primary" data-return-confirm ${groups.length ? 'disabled' : ''}>${en ? 'Return and keep preparation' : 'إرجاع مع الاحتفاظ بالتحضير'}</button></footer>
  </section>`;
  document.body.appendChild(host); document.body.style.overflow = 'hidden';
  const select = host.querySelector('select'), confirm = host.querySelector('[data-return-confirm]');
  const create = host.querySelector('[data-return-create]');
  select.onchange = () => {
    confirm.disabled = !select.value;
    create.setAttribute('aria-pressed', String(select.value === '__new__'));
  };
  create.onclick = () => { select.value = '__new__'; select.onchange(); };
  return new Promise(resolve => {
    const finish = target => {
      host.remove(); document.body.style.overflow = overflow;
      window.removeEventListener('keydown', key, true);
      if (focus?.isConnected) focus.focus();
      resolve(target);
    };
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(null); }
      if (event.key === 'Tab') {
        const controls = [...host.querySelectorAll('button:not(:disabled),select')], first = controls[0], last = controls[controls.length-1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    host.querySelector('[data-return-cancel]').onclick = () => finish(null);
    host.onclick = event => { if (event.target === host) finish(null); };
    confirm.onclick = () => {
      const selected = groups.find(group => group.prepRef === select.value);
      if (!select.value) return;
      finish(selected ? {prepRef:selected.prepRef,joinExisting:true,group:selected} : {prepRef:_genPrepRef(),joinExisting:false});
    };
    (select || host.querySelector('[data-return-cancel]')).focus();
  });
}
async function _puReturnReadyOrder(orderId, mode) {
  if (_puReadyReturnBusy.size || !['pending','preparing'].includes(mode)) return;
  const order = _pickupOrders.find(row => String(row._id) === String(orderId));
  if (!order || !['Ready','Picked-Up'].includes(order.pickupStatus) || !_puDailyAwaitingPickup(order)) return;
  const sourceRef = order.pickupRef || `noref-${order._id}`, en = currentLang === 'en';
  _puReadyReturnBusy.add(String(orderId));
  const buttons = busy => qsa('[data-ready-return]').forEach(button => { button.disabled = busy; button.setAttribute('aria-busy',String(busy)); });
  buttons(true);
  let submitted = false;
  try {
    let target = null;
    if (mode === 'pending') {
      const confirmed = await _puConfirm(en
        ? `Return order #${order.ref || orderId} to Pending? Preparation will be cancelled and scanned piece identities removed from this invoice.`
        : `إرجاع الأوردر #${order.ref || orderId} للمعلّق؟ سيتم إلغاء تحضيره وإزالة أكواد القطع الممسوحة المرتبطة بهذه الفاتورة.`,
        en ? 'Cancel preparation' : 'إلغاء التحضير والإرجاع للمعلّق', en ? 'Return to Pending' : 'إرجاع للمعلّق', '#dc2626');
      if (!confirmed) return;
    } else {
      target = await _puChooseReturnPrepGroup(order, _puPrepGroups.filter(group => group.orders.length));
      if (!target) return;
    }
    submitted = true;
    const body = {ids:[String(order._id)],sourceRef};
    if (target) Object.assign(body,{prepRef:target.prepRef,joinExisting:target.joinExisting,
      note:target.group?.note || order.client || '',shipCo:target.group?.shipCo || order.shipCo || ''});
    const result = await api(mode === 'pending' ? '/transactions/pickup-orders/undo' : '/transactions/pickup-orders/return-to-preparing',
      {method:'POST',body:JSON.stringify(body)});
    if (result.updated !== 1) throw new Error(en ? 'The order changed. Refresh and try again.' : 'تغيّرت حالة الأوردر. حدّث القائمة وحاول مرة أخرى.');
    _puApplyRealtimeEvent(mode === 'pending'
      ? {ids:[String(order._id)],action:'undo',scansReset:true}
      : {ids:[String(order._id)],action:'preparing',preparationPreserved:true,pickupRef:target.prepRef,pickupDate:null,pickupBy:null});
    await loadPickupOrders();
    const group = _pucoGetGroup();
    if (group?.orders.length) {
      if (String(_pwSelId) === String(orderId)) _pwSelId = String(group.orders[0]._id);
      _pucoRenderOrders(group); _pucoUpdateProgress(group);
    } else closePuCardOrdersModal();
    toast(en ? 'Order returned successfully' : 'تم إرجاع الأوردر بنجاح');
  } catch (error) {
    toast(error.message, true);
    if (submitted) await loadPickupOrders().catch(() => {});
  } finally {
    _puReadyReturnBusy.clear(); buttons(false);
  }
}
