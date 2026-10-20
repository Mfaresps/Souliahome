/* Shopify orders — period KPIs (today / yesterday / last 3 or 7 days / custom dates)
   and a shareable report image.
   Read-only: every figure is counted from `_shopifyOrders` + `followUps`, already in memory,
   with the SAME rules the table uses (`_spHasDepositRecorded`, `_spShipsWithoutDeposit`,
   `_spFollowUpsFor`, `_fuIsSettled`). Nothing here writes or changes an order.

   ⚠ Each order lands in exactly ONE bucket, first match wins:
     cancelled → confirmed → follow-up (an open follow-up and nothing else) → open (no action yet).
   «Confirmed» has two halves, counted apart and shown as a split: with a deposit (approved or
   in review) and WITHOUT one (marked «Ship without deposit», or already recorded with none).
   ⚠ An order shipping without a deposit IS confirmed — the owner's rule (Oct 13, 2026).
   So the buckets always add up to «الأوردرات الواردة»; «open» is stated, never dropped.

   ⚠ The strip has its OWN period. It does not follow the table's search / date / filters —
   it answers "how did today go", not "what is on screen". The period is named beside it. */

let _spkPeriod = 'today';
let _spkFilter = '';
function _spkSetFilter(key) {
  if (key && !['received','confirmed','followup','cancelled','rate'].includes(key)) return;
  _spkFilter = key && _spkFilter !== key ? key : '';
  shopifyPage = 1;
  if (_spkFilter && typeof switchShopifyTab === 'function') switchShopifyTab('all');
  else if (typeof renderShopifyOrders === 'function') renderShopifyOrders();
  else _spkRender();
}
function _spkMatchesOrder(order) {
  if (!_spkFilter) return true;
  const range = _spkRange(_spkPeriod), ms = _spkOrderMs(order);
  if (!(ms >= range.from.getTime() && ms < range.to.getTime())) return false;
  const bucket = _spkBucket(order);
  if (_spkFilter === 'received') return true;
  if (_spkFilter === 'confirmed' || _spkFilter === 'rate') return bucket === 'deposit' || bucket === 'nodep';
  return bucket === _spkFilter;
}
let _spkCustomFrom = '', _spkCustomTo = '', _spkDraftFrom = '', _spkDraftTo = '';
/* The period picker is a calendar icon beside «Report» that opens a small menu
   (Oct 14, 2026 — the five-tab strip + the custom-dates bar took two rows). Its open
   state lives here so a live re-render of the strip does not snap it shut. */
let _spkMenuOpen = false;
/* Hidden / shown survives a reload, per user (same key scheme as the column prefs —
   one shared PC is used by several employees). */
const SPK_HIDDEN_KEY = 'soulia_sp_kpi_hidden';
function _spkHidden() {
  try { return localStorage.getItem(_colsPrefKey(SPK_HIDDEN_KEY)) === '1'; } catch (_) { return false; }
}
function _spkToggle() {
  const hide = !_spkHidden();
  try {
    if (hide) localStorage.setItem(_colsPrefKey(SPK_HIDDEN_KEY), '1');
    else localStorage.removeItem(_colsPrefKey(SPK_HIDDEN_KEY));
  } catch (_) {}
  _spkRender();
}
function _spkSyncToggle(hidden) {
  const b = document.getElementById('sp-kpi-toggle');
  if (!b) return;
  const label = _spkT(hidden ? 'show' : 'hide');
  b.title = label;
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-pressed', String(!hidden));
  b.classList.toggle('is-off', hidden);
}
let _spkState = 'ready';   /* 'loading' | 'error' | 'ready' */

const _SPK_L = {
  title: ['ملخص الأوردرات', 'Orders summary'],
  today: ['اليوم', 'Today'], yesterday: ['أمس', 'Yesterday'], week: ['آخر 7 أيام', 'Last 7 days'],
  three: ['آخر 3 أيام', 'Last 3 days'], custom: ['فترة مخصصة', 'Custom range'],
  from: ['من', 'From'], to: ['إلى', 'To'], apply: ['تطبيق', 'Apply'],
  invalidRange: ['اختر تاريخين صحيحين، بداية الفترة قبل نهايتها أو في نفس اليوم، وحتى اليوم.', 'Choose valid dates, with the start on or before the end, up to today.'],
  received: ['الأوردرات الواردة', 'Received orders'],
  confirmed: ['مؤكد', 'Confirmed'],
  deposit: ['بعربون', 'With deposit'], nodep: ['بدون عربون', 'Without deposit'],
  ofWhich: ['منها', 'of which'],
  followup: ['متابعة', 'Follow-up'], followupSub: ['متابعة مفتوحة', 'Open follow-up'],
  cancelled: ['ملغي', 'Cancelled'],
  rate: ['نسبة التأكيد', 'Confirmation rate'],
  rateHint: ['المؤكد (بعربون أو بدون) ÷ الأوردرات الواردة', 'Confirmed (with or without deposit) ÷ Received orders'],
  of: ['من', 'of'],
  open: ['لم يُتخذ فيها إجراء بعد', 'with no action yet'],
  vsToday: ['عن نفس الوقت أمس', 'vs same time yesterday'],
  vsYesterday: ['عن أول أمس', 'vs the day before'],
  vsWeek: ['عن الـ7 أيام السابقة', 'vs previous 7 days'],
  vsThree: ['عن الـ3 أيام السابقة', 'vs previous 3 days'], vsCustom: ['عن الفترة السابقة بنفس المدة', 'vs previous period of the same length'],
  noChange: ['بدون تغيير', 'no change'],
  report: ['تقرير', 'Report'], reportTitle: ['تقرير الأوردرات', 'Orders report'],
  dailyReport: ['تقرير الأوردرات اليومي', 'Daily Orders Report'],
  weeklyReport: ['تقرير الأوردرات — آخر 7 أيام', 'Orders Report — Last 7 Days'],
  threeReport: ['تقرير الأوردرات — آخر 3 أيام', 'Orders Report — Last 3 Days'],
  date: ['التاريخ', 'Date'], period: ['الفترة', 'Period'],
  download: ['تحميل الصورة', 'Download image'], share: ['مشاركة', 'Share'], copy: ['نسخ النص', 'Copy text'],
  copied: ['تم نسخ التقرير', 'Report copied'], copyFail: ['تعذّر النسخ', 'Could not copy'],
  downloaded: ['تم تحميل التقرير', 'Report downloaded'],
  drawFail: ['تعذّر إنشاء الصورة', 'Could not create the image'],
  loadFail: ['تعذّر تحميل الأوردرات', 'Could not load orders'],
  fuFail: ['المتابعات لم تُحمَّل — قد يقلّ عدد «متابعة»', 'Follow-ups did not load — «Follow-up» may be undercounted'],
  generated: ['أُنشئ', 'Generated'],
  close: ['إغلاق', 'Close'],
  hide: ['إخفاء الملخص', 'Hide summary'], show: ['عرض الملخص', 'Show summary'],
  pickPeriod: ['الفترة', 'Period'],
};
function _spkT(k) { const v = _SPK_L[k]; return v ? v[currentLang === 'en' ? 1 : 0] : k; }
function _spkEsc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _spkN(n) { return Number(n || 0).toLocaleString('en-US'); }

/* ── Periods ── local calendar days, the same boundary the table's date filter uses. */
function _spkRange(period) {
  if (period === 'custom' && _spkCustomFrom && _spkCustomTo) {
    const from = _spkParseDate(_spkCustomFrom), last = _spkParseDate(_spkCustomTo);
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    const days = (Date.UTC(last.getFullYear(), last.getMonth(), last.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000 + 1;
    return { from, to, days };
  }
  const n = new Date();
  const y = n.getFullYear(), m = n.getMonth(), d = n.getDate();
  const start = period === 'yesterday' ? -1 : period === 'week' ? -6 : period === 'three' ? -2 : 0;
  const days = period === 'week' ? 7 : period === 'three' ? 3 : 1;
  /* new Date(y, m, d + k) rather than ms arithmetic — a DST change makes a day 23/25h. */
  return { from: new Date(y, m, d + start), to: new Date(y, m, d + start + days), days };
}
function _spkYmd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function _spkParseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return _spkYmd(date) === value ? date : null;
}
function _spkNamedDate(value) {
  const d = _spkParseDate(value);
  return d ? d.toLocaleDateString(_spkLoc(), { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}
function _spkDateDraft(which, value) {
  if (which === 'from') _spkDraftFrom = value; else _spkDraftTo = value;
  const hint = document.getElementById(`spk-${which}-named`);
  if (hint) hint.textContent = _spkNamedDate(value);
}
function _spkApplyDates(event) {
  event.preventDefault();
  const from = document.getElementById('spk-from').value, to = document.getElementById('spk-to').value;
  if (!_spkParseDate(from) || !_spkParseDate(to) || from > to || to > _spkYmd(new Date())) {
    document.getElementById('spk-date-error').textContent = _spkT('invalidRange');
    return;
  }
  _spkCustomFrom = _spkDraftFrom = from; _spkCustomTo = _spkDraftTo = to;
  _spkCloseMenu(true);
  if (_spkFilter && typeof renderShopifyOrders === 'function') { shopifyPage = 1; renderShopifyOrders(); }
}
function _spkDateControls() {
  if (_spkPeriod !== 'custom' || !_spkMenuOpen) return '';
  const field = (key, value) => `<label class="spk-date-field"><span>${_spkEsc(_spkT(key))}</span>
    <input type="date" id="spk-${key}" value="${_spkEsc(value)}" max="${_spkYmd(new Date())}" required oninput="_spkDateDraft('${key}',this.value)" aria-describedby="spk-${key}-named spk-date-error">
    <span class="spk-date-named" id="spk-${key}-named">${_spkEsc(_spkNamedDate(value))}</span></label>`;
  return `<form class="spk-date-filter" onsubmit="_spkApplyDates(event)">${field('from', _spkDraftFrom)}${field('to', _spkDraftTo)}
    <button type="submit" class="spk-report-btn">${_spkEsc(_spkT('apply'))}</button><span class="spk-date-error" id="spk-date-error" role="alert"></span></form>`;
}
function _spkOrderMs(o) { return new Date(o.shopifyCreatedAt || o.createdAt || 0).getTime(); }

function _spkBucket(o) {
  if (o.cancelled || o.status === 'rejected') return 'cancelled';
  if (_spHasDepositRecorded(o)) return 'deposit';
  if (_spShipsWithoutDeposit(o) || (o.status && o.status !== 'pending')) return 'nodep';
  if (_spFollowUpsFor(o).some(f => !_fuIsSettled(f))) return 'followup';
  return 'open';
}

function _spkCount(fromMs, toMs) {
  const s = { received: 0, deposit: 0, nodep: 0, followup: 0, cancelled: 0, open: 0 };
  for (const o of (Array.isArray(_shopifyOrders) ? _shopifyOrders : [])) {
    const ms = _spkOrderMs(o);
    if (!(ms >= fromMs && ms < toMs)) continue;
    s.received++;
    s[_spkBucket(o)]++;
  }
  s.confirmed = s.deposit + s.nodep;
  /* Cancelled stays in the denominator — a cancellation is exactly the order that was not confirmed. */
  s.rate = s.received ? Math.round(s.confirmed / s.received * 100) : null;
  return s;
}

function _spkStats(period) {
  const r = _spkRange(period);
  const s = _spkCount(r.from.getTime(), r.to.getTime());
  /* ⚠ The comparison window is cut at the same clock time: today at 11:00 against ALL of
     yesterday would read as a drop every morning. prev = [from − days, min(to, now) − days). */
  const shift = (ms) => { const x = new Date(ms); x.setDate(x.getDate() - r.days); return x.getTime(); };
  const prevTo = shift(Math.min(r.to.getTime(), Date.now()));
  const prev = _spkCount(shift(r.from.getTime()), prevTo);
  return Object.assign(s, { period, from: r.from, to: r.to, days: r.days, prevReceived: prev.received });
}

/* ── Formatting ── */
function _spkLoc() { return currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn'; }
function _spkRangeLabel(s) {
  const last = new Date(s.to.getTime() - 1);
  if (s.days === 1) return s.from.toLocaleDateString(_spkLoc(), { weekday: 'long', day: 'numeric', month: 'long' });
  const options = { day: 'numeric', month: 'long', ...(s.from.getFullYear() !== last.getFullYear() || s.from.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) };
  const a = s.from.toLocaleDateString(_spkLoc(), options);
  const b = last.toLocaleDateString(_spkLoc(), options);
  return `${a} – ${b}`;
}
/* d/m/yyyy — the shape the team already writes reports in («3/10/2026»). */
function _spkDmy(d) { return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; }
function _spkReportDate(s) {
  if (s.days === 1) return _spkDmy(s.from);
  return `${_spkDmy(s.from)} – ${_spkDmy(new Date(s.to.getTime() - 1))}`;
}
function _spkDeltaText(s) {
  const d = s.received - s.prevReceived;
  const vs = _spkT(({ today: 'vsToday', yesterday: 'vsYesterday', three: 'vsThree', week: 'vsWeek', custom: 'vsCustom' })[s.period || _spkPeriod]);
  if (!d) return `${_spkT('noChange')} ${vs}`;
  return `<bdi class="spk-delta-n">${d > 0 ? '+' : '−'}${_spkN(Math.abs(d))}</bdi> ${vs}`;
}

const _SPK_ICO = {
  received: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>',
  confirmed: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  followup: '<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z"/>',
  cancelled: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  rate: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  report: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
};
function _spkIco(k, size) { return `<svg viewBox="0 0 24 24" width="${size || 15}" height="${size || 15}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${_SPK_ICO[k]}</svg>`; }

/* ── The strip ── */
function _spkRender(state) {
  if (state) _spkState = state;
  const host = document.getElementById('sp-kpi');
  if (!host) return;
  const hidden = _spkHidden();
  _spkSyncToggle(hidden);
  host.hidden = hidden;
  if (hidden) { host.innerHTML = ''; return; }
  const seg = _spkPeriodHtml();

  if (_spkState === 'loading' && !(_shopifyOrders || []).length) {
    host.innerHTML = `<div class="spk-head"><div class="spk-actions">${seg}</div></div>
      <div class="spk-grid" aria-busy="true">${['received','confirmed','followup','cancelled','rate'].map(key => `<div class="spk-tile is-skel is-${key}"><span></span><span></span></div>`).join('')}</div>`;
    return;
  }
  if (_spkState === 'error' && !(_shopifyOrders || []).length) {
    host.innerHTML = `<div class="spk-head"><span class="spk-warn">${_spkEsc(_spkT('loadFail'))}</span>
      <div class="spk-actions">${seg}</div></div>`;
    return;
  }

  const s = _spkStats(_spkPeriod);
  const tile = (key, value, sub, attrs, inner) => `
    <button type="button" class="spk-tile is-${key}${_spkFilter === key ? ' is-active' : ''}" aria-pressed="${_spkFilter === key}" onclick="_spkSetFilter('${key}')"${attrs || ''}>
      <div class="spk-tile-top"><span class="spk-lbl">${_spkEsc(_spkT(key))}</span><span class="spk-ic">${_spkIco(key)}</span></div>
      <div class="spk-val"><bdi>${value}</bdi></div>
      ${sub ? `<div class="spk-sub">${sub}</div>` : ''}${inner || ''}
    </button>`;
  const rateVal = s.rate == null ? '—' : `${s.rate}%`;
  const rateSub = s.received
    ? `<bdi>${_spkN(s.confirmed)}</bdi> ${_spkEsc(_spkT('of'))} <bdi>${_spkN(s.received)}</bdi>`
    : '';
  const fuWarn = (typeof loadFailed === 'function' && loadFailed('followups'))
    ? `<span class="spk-warn">${_spkEsc(_spkT('fuFail'))}</span>` : '';
  const openNote = s.open
    ? `<span class="spk-open"><bdi>${_spkN(s.open)}</bdi> ${_spkEsc(_spkT('open'))}</span>` : '';

  host.innerHTML = `
    <div class="spk-head">
      <span class="spk-range">${_spkPeriod === 'custom' ? '' : `<b>${_spkEsc(_spkT(_spkPeriod))}</b> · `}${_spkEsc(_spkRangeLabel(s))}</span>
      ${openNote}${fuWarn}
      <div class="spk-actions">
        ${seg}
        <button type="button" class="spk-report-btn" onclick="_spkOpenReport()" title="${_spkEsc(_spkT('reportTitle'))}">
          ${_spkIco('report', 14)}<span>${_spkEsc(_spkT('report'))}</span>
        </button>
      </div>
    </div>
    <div class="spk-grid">
      ${tile('received', _spkN(s.received), _spkDeltaText(s))}
      ${tile('confirmed', _spkN(s.confirmed),
        `<bdi>${_spkN(s.deposit)}</bdi> ${_spkEsc(_spkT('deposit'))} · <bdi>${_spkN(s.nodep)}</bdi> ${_spkEsc(_spkT('nodep'))}`,
        /* The split also lives in title — the sub-line is hidden on phones. */
        ` title="${_spkEsc(`${_spkT('deposit')}: ${s.deposit} · ${_spkT('nodep')}: ${s.nodep}`)}"`)}
      ${tile('followup', _spkN(s.followup), _spkEsc(_spkT('followupSub')))}
      ${tile('cancelled', _spkN(s.cancelled), '')}
      ${tile('rate', rateVal, rateSub, ` title="${_spkEsc(_spkT('rateHint'))}"`,
        /* A share of one total — a single-hue meter, not a categorical colour. */
        `<div class="spk-meter" aria-hidden="true"><i style="width:${s.rate || 0}%"></i></div>`)}
    </div>`;
}

const _SPK_PERIODS = ['today', 'yesterday', 'three', 'week', 'custom'];
/* Calendar icon button + its menu. The period is NAMED in .spk-range at the start of the
   row, so the button itself can stay an icon; its title / aria-label state it too. */
function _spkPeriodHtml() {
  const cur = _spkT(_spkPeriod);
  const items = _SPK_PERIODS.map(p => `
    <button type="button" role="menuitemradio" aria-checked="${p === _spkPeriod}" class="spk-pm-item${p === _spkPeriod ? ' is-on' : ''}" onclick="_spkSetPeriod('${p}')">
      <span>${_spkEsc(_spkT(p))}</span>${p === _spkPeriod ? _spkIco('check', 14) : ''}</button>`).join('');
  return `<div class="spk-period">
    <button type="button" class="spk-icon-btn${_spkMenuOpen ? ' is-open' : ''}${_spkPeriod !== 'today' ? ' is-set' : ''}" id="spk-period-btn"
      aria-haspopup="menu" aria-expanded="${_spkMenuOpen}" aria-controls="spk-period-menu" onclick="_spkToggleMenu()" onkeydown="_spkMenuKey(event)"
      title="${_spkEsc(_spkT('pickPeriod') + ': ' + cur)}" aria-label="${_spkEsc(_spkT('pickPeriod') + ': ' + cur)}">${_spkIco('calendar', 16)}</button>
    ${_spkMenuOpen ? `<div class="spk-pmenu" id="spk-period-menu" role="menu" aria-label="${_spkEsc(_spkT('pickPeriod'))}" onkeydown="_spkMenuKey(event)">
      ${items}${_spkDateControls()}</div>` : ''}
  </div>`;
}
function _spkToggleMenu() {
  if (_spkMenuOpen) { _spkCloseMenu(true); return; }
  _spkMenuOpen = true;
  _spkRender();
  const on = document.querySelector('#spk-period-menu .spk-pm-item.is-on') || document.querySelector('#spk-period-menu .spk-pm-item');
  if (on) on.focus();
}
function _spkCloseMenu(refocus) {
  if (!_spkMenuOpen) return;
  _spkMenuOpen = false;
  _spkRender();
  if (refocus) document.getElementById('spk-period-btn')?.focus();
}
/* Up/Down walk the items, Escape closes and returns focus to the button. Keys typed in
   the date fields are left alone (only Escape is taken there). */
function _spkMenuKey(e) {
  if (e.key === 'Escape' && _spkMenuOpen) { e.preventDefault(); e.stopPropagation(); _spkCloseMenu(true); return; }
  if (e.target.tagName === 'INPUT') return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  if (!_spkMenuOpen) { _spkToggleMenu(); return; }
  const items = [...document.querySelectorAll('#spk-period-menu .spk-pm-item')];
  const i = items.indexOf(document.activeElement);
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  if (next) next.focus();
}
/* A click anywhere outside the picker closes it. Bound once; inert while closed. */
document.addEventListener('mousedown', e => {
  if (_spkMenuOpen && !(e.target.closest && e.target.closest('.spk-period'))) _spkCloseMenu(false);
}, true);

function _spkSetPeriod(p) {
  if (!_SPK_PERIODS.includes(p)) return;
  if (p === 'custom' && !_spkCustomFrom) {
    const range = _spkRange(_spkPeriod);
    _spkCustomFrom = _spkDraftFrom = _spkYmd(range.from);
    _spkCustomTo = _spkDraftTo = _spkYmd(new Date(range.to.getTime() - 1));
  }
  _spkPeriod = p;
  /* A named period applies at once and closes the menu; «Custom range» keeps it open
     on its date fields, which apply with their own button. */
  /* ⚠ Always re-render here — _spkCloseMenu() returns early when the menu is already
     closed, so routing a closed-menu call through it left the old period's figures. */
  const wasOpen = _spkMenuOpen;
  if (p !== 'custom') _spkMenuOpen = false;
  _spkRender();
  if (p === 'custom') { const f = document.getElementById('spk-from'); if (f) f.focus(); }
  else if (wasOpen) document.getElementById('spk-period-btn')?.focus();
  if (_spkFilter && typeof renderShopifyOrders === 'function') { shopifyPage = 1; renderShopifyOrders(); }
}

/* ── Report: text + image ── */
function _spkReportTitle(s) {
  return _spkT(s.days === 1 ? 'dailyReport' : s.period === 'week' ? 'weeklyReport' : s.period === 'three' ? 'threeReport' : 'reportTitle');
}
function _spkReportText(s) {
  const en = currentLang === 'en';
  const title = _spkReportTitle(s);
  const lines = [
    `📦 ${title}`,
    `📅 ${_spkT(s.days === 1 ? 'date' : 'period')}: ${_spkReportDate(s)}`,
    '',
    `📥 ${_spkT('received')}: ${s.received}`,
    '',
    `✅ ${_spkT('confirmed')}: ${s.confirmed}`,
    `   💰 ${_spkT('deposit')}: ${s.deposit}`,
    `   ⏳ ${_spkT('nodep')}: ${s.nodep}`,
    `🔄 ${_spkT('followup')}: ${s.followup}`,
    `❌ ${_spkT('cancelled')}: ${s.cancelled}`,
  ];
  if (s.open) lines.push(`⏸ ${en ? 'No action yet' : 'بدون إجراء بعد'}: ${s.open}`);
  lines.push('', `📊 ${_spkT('rate')}: ${s.rate == null ? '—' : s.rate + '%'}`);
  return lines.join('\n');
}

let _spkLogoImg = null;
function _spkLoadLogo() {
  if (_spkLogoImg) return _spkLogoImg;
  _spkLogoImg = new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = '/soulia-logo.svg';
  });
  return _spkLogoImg;
}

async function _spkDrawReport(s) {
  const rtl = currentLang !== 'en';
  const FONT = rtl ? "'Cairo','Inter',sans-serif" : "'Inter','Cairo',sans-serif";
  try {
    await Promise.all(['400', '600', '700'].map(w => document.fonts.load(`${w} 40px Cairo`).catch(() => {})));
    await Promise.all(['400', '600', '700'].map(w => document.fonts.load(`${w} 40px Inter`).catch(() => {})));
  } catch (_) {}
  const logo = await _spkLoadLogo();

  const W = 1080, P = 72, GAP = 24;
  const TILE_H = 196, REC_H = 210, RATE_H = 216;
  const hasOpen = s.open > 0;
  const H = P + 64 + 34 + 66 + 46 + 40 + REC_H + GAP + TILE_H * 2 + GAP + GAP + RATE_H + (hasOpen ? 56 : 0) + 52 + 30 + P;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.direction = rtl ? 'rtl' : 'ltr';
  /* Logical x from the START edge → real canvas x. Rects pass their width. */
  const X = (lx, w) => rtl ? W - lx - (w || 0) : lx;
  const font = (wt, px) => { x.font = `${wt} ${px}px ${FONT}`; };
  const text = (str, lx, y, align) => { x.textAlign = align || 'start'; x.fillText(str, X(lx), y); };
  const rrect = (lx, y, w, h, r, fill, stroke) => {
    x.beginPath(); x.roundRect(X(lx, w), y, w, h, r);
    if (fill) { x.fillStyle = fill; x.fill(); }
    if (stroke) { x.strokeStyle = stroke; x.lineWidth = 2; x.stroke(); }
  };

  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  x.textBaseline = 'alphabetic';

  let y = P;
  /* Brand row: logo + SOULIA at the start, the period chip at the end. */
  if (logo) x.drawImage(logo, X(P, 64), y, 64, 64);
  x.fillStyle = '#00311e'; font(700, 30);
  text('SOULIA', P + (logo ? 82 : 0), y + 43);
  y += 64 + 34;

  const title = _spkReportTitle(s);
  x.fillStyle = '#0f1f16'; font(700, 54);
  text(title, P, y + 50);
  y += 66;
  x.fillStyle = '#6b8c78'; font(400, 30);
  text(`${_spkT(s.days === 1 ? 'date' : 'period')}: ${_spkReportDate(s)}`, P, y + 30);
  y += 46 + 40;

  /* Received — the lead figure. */
  rrect(P, y, W - P * 2, REC_H, 28, '#f3f6f4');
  x.fillStyle = '#4b6356'; font(600, 32);
  text(_spkT('received'), P + 40, y + 70);
  x.fillStyle = '#0f1f16'; font(700, 104);
  text(_spkN(s.received), P + 40, y + 178);
  y += REC_H + GAP;

  /* Status tiles — semantic tints only. Confirmed takes the full row and carries its split
     (with / without deposit) on the end side; follow-up and cancelled share the next row. */
  const tones = { confirmed: ['#ecfdf3', '#067647'], followup: ['#eff6ff', '#1d4ed8'], cancelled: ['#fef2f2', '#b42318'] };
  const statusTile = (k, lx, ty, tw) => {
    rrect(lx, ty, tw, TILE_H, 24, tones[k][0]);
    x.fillStyle = tones[k][1];
    x.beginPath(); x.arc(X(lx + 52), ty + 58, 11, 0, Math.PI * 2); x.fill();
    font(600, 30);
    text(_spkT(k), lx + 80, ty + 69);
    font(700, 78);
    text(_spkN(s[k]), lx + 40, ty + 166);
  };
  const full = W - P * 2;
  statusTile('confirmed', P, y, full);
  x.fillStyle = '#067647'; font(400, 28);
  text(`${_spkT('deposit')}: ${s.deposit}`, P + full - 40, y + 112, 'end');
  text(`${_spkT('nodep')}: ${s.nodep}`, P + full - 40, y + 160, 'end');
  y += TILE_H + GAP;
  const tw = (full - GAP) / 2;
  statusTile('followup', P, y, tw);
  statusTile('cancelled', P + tw + GAP, y, tw);
  y += TILE_H + GAP + GAP;

  /* Confirmation rate with its meter. */
  rrect(P, y, W - P * 2, RATE_H, 28, '#ffffff', '#d8e4dd');
  x.fillStyle = '#4b6356'; font(600, 32);
  text(_spkT('rate'), P + 40, y + 66);
  x.fillStyle = '#0f1f16'; font(700, 84);
  text(s.rate == null ? '—' : `${s.rate}%`, W - P - 40, y + 98, 'end');
  const mx = P + 40, mw = W - P * 2 - 80, my = y + 140;
  rrect(mx, my, mw, 16, 8, '#e8f5ee');
  if (s.rate) rrect(mx, my, Math.max(16, mw * s.rate / 100), 16, 8, '#2d7a4f');
  x.fillStyle = '#6b8c78'; font(400, 26);
  text(`${_spkT('confirmed')} ${s.confirmed} ${_spkT('of')} ${s.received}`, P + 40, y + 196);
  y += RATE_H;

  if (hasOpen) {
    x.fillStyle = '#6b8c78'; font(400, 28);
    text(`${s.open} ${_spkT('open')}`, P, y + 46);
    y += 56;
  }

  y += 52;
  x.strokeStyle = '#e5ece8'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(P, y - 22); x.lineTo(W - P, y - 22); x.stroke();
  const n = new Date();
  const hm = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  x.fillStyle = '#94a39a'; font(400, 24);
  text(`${_spkT('generated')} ${_spkDmy(n)} · ${hm}`, P, y + 16);
  text('SOULIA', W - P, y + 16, 'end');
  return c;
}

let _spkRepCanvas = null, _spkRepStats = null;

async function _spkOpenReport() {
  const s = _spkStats(_spkPeriod);
  _spkRepStats = s; _spkRepCanvas = null;
  const canShareFiles = !!(navigator.canShare && navigator.share);
  openModal(`
    <div class="modal-head">
      <h3 style="margin:0">${_spkEsc(_spkT('reportTitle'))} · <span class="spk-rep-period">${_spkEsc(_spkT(_spkPeriod))}</span></h3>
      <button class="modal-x" type="button" onclick="closeModal()" aria-label="${_spkEsc(_spkT('close'))}">&times;</button>
    </div>
    <div class="spk-rep-prev" id="spk-rep-prev"><div class="spk-rep-skel"></div></div>
    <div class="spk-rep-actions">
      <button type="button" class="btn btn-primary" id="spk-rep-dl" onclick="_spkDownload()" disabled>${_spkEsc(_spkT('download'))}</button>
      ${canShareFiles ? `<button type="button" class="btn btn-outline" id="spk-rep-share" onclick="_spkShare()" disabled hidden>${_spkEsc(_spkT('share'))}</button>` : ''}
      <button type="button" class="btn btn-outline" onclick="_spkCopyText()">${_spkEsc(_spkT('copy'))}</button>
    </div>`, 'max-width:460px');
  try {
    const c = await _spkDrawReport(s);
    if (_spkRepStats !== s) return;            /* a newer report replaced this one */
    _spkRepCanvas = c;
    const prev = document.getElementById('spk-rep-prev');
    if (prev) prev.innerHTML = `<img src="${c.toDataURL('image/png')}" alt="${_spkEsc(_spkT('reportTitle'))}">`;
    const dl = document.getElementById('spk-rep-dl'); if (dl) dl.disabled = false;
    const sh = document.getElementById('spk-rep-share');
    if (sh) {
      const probe = new File([new Blob([''], { type: 'image/png' })], 'r.png', { type: 'image/png' });
      if (navigator.canShare({ files: [probe] })) { sh.hidden = false; sh.disabled = false; }
    }
  } catch (e) {
    console.error('report draw failed', e);
    const prev = document.getElementById('spk-rep-prev');
    if (prev) prev.innerHTML = `<div class="spk-warn" style="padding:24px">${_spkEsc(_spkT('drawFail'))}</div>`;
  }
}

function _spkFileName() {
  const s = _spkRepStats, d = s ? s.from : new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const period = s?.period || _spkPeriod;
  const prefix = period === 'week' ? '7d-' : period === 'three' ? '3d-' : '';
  const end = period === 'custom' && s ? '-to-' + _spkYmd(new Date(s.to.getTime() - 1)) : '';
  return `soulia-orders-${prefix}${ymd}${end}.png`;
}
function _spkBlob() {
  return new Promise((res, rej) => _spkRepCanvas ? _spkRepCanvas.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/png') : rej(new Error('no canvas')));
}
async function _spkDownload() {
  try {
    const b = await _spkBlob();
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url; a.download = _spkFileName();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(_spkT('downloaded'));
  } catch (_) { toast(_spkT('drawFail'), true); }
}
async function _spkShare() {
  try {
    const b = await _spkBlob();
    const f = new File([b], _spkFileName(), { type: 'image/png' });
    await navigator.share({ files: [f], text: _spkReportText(_spkRepStats) });
  } catch (e) { if (e && e.name !== 'AbortError') toast(_spkT('drawFail'), true); }
}
async function _spkCopyText() {
  const s = _spkRepStats || _spkStats(_spkPeriod);
  const ok = await _copyTextWithFallback(_spkReportText(s));
  toast(_spkT(ok ? 'copied' : 'copyFail'), !ok);
}
