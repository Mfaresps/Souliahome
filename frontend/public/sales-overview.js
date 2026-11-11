/* SPDX-License-Identifier: MIT */
/* Fast monthly sales overview. The browser receives daily buckets, never order records. */
(() => {
  'use strict';
  const host = () => document.getElementById('dash-sales-overview');
  const q = id => document.getElementById(id);
  const labels = () => currentLang === 'en' ? {
    eyebrow: 'SALES OVERVIEW', note: 'Orders received in the selected month',
    orders: 'Total orders', revenue: 'Net sales', confirmed: 'Confirmed orders', average: 'Average order value',
    chart: 'Daily orders', chartNote: 'Every day of the month · tap, hover or focus a point for orders and revenue',
    today: 'Today', received: 'orders', oneOrder: 'order', dailyRevenue: 'Revenue', scroll: 'Scroll to see every day',
    timezone: 'Days follow Cairo time', financial: 'Revenue excludes shipping and approved returns',
    prev: 'Previous month', next: 'Next month', previousYear: 'Previous year', nextYear: 'Next year', choose: 'Choose month and year',
    error: 'Sales overview could not load.', retry: 'Retry', noData: 'No orders yet for this month',
    compare: 'Compare months', stopCompare: 'Close comparison', compareWith: 'Compare with',
    difference: 'Difference', partial: 'Current month figures are month to date',
    lineStyle: 'Line', areaStyle: 'Area', chartStyle: 'Chart style', showSeries: 'Show', hideSeries: 'Hide',
  } : {
    eyebrow: 'ملخص المبيعات', note: 'الطلبات الواردة خلال الشهر المحدد',
    orders: 'إجمالي الطلبات', revenue: 'صافي المبيعات', confirmed: 'الطلبات المؤكدة', average: 'متوسط قيمة الطلب',
    chart: 'الطلبات يومًا بيوم', chartNote: 'كل أيام الشهر · اضغط أو مرّر أو ركّز على النقطة لمعرفة الطلبات والإيراد',
    today: 'اليوم', received: 'طلب', oneOrder: 'طلب', dailyRevenue: 'المبيعات', scroll: 'اسحب لرؤية جميع أيام الشهر',
    timezone: 'الأيام حسب توقيت القاهرة', financial: 'المبيعات بدون الشحن وبعد المرتجعات المعتمدة',
    prev: 'الشهر السابق', next: 'الشهر التالي', previousYear: 'السنة السابقة', nextYear: 'السنة التالية', choose: 'اختر الشهر والسنة',
    error: 'تعذر تحميل ملخص المبيعات.', retry: 'إعادة المحاولة', noData: 'لا توجد طلبات لهذا الشهر بعد',
    compare: 'قارن شهور', stopCompare: 'إغلاق المقارنة', compareWith: 'مقارنة مع',
    difference: 'الفرق', partial: 'أرقام الشهر الحالي حتى اليوم',
    lineStyle: 'خط', areaStyle: 'مساحة', chartStyle: 'نمط الرسم', showSeries: 'إظهار', hideSeries: 'إخفاء',
  };
  const locale = () => currentLang === 'en' ? 'en-US' : 'ar-EG-u-nu-latn';
  const count = n => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Number(n) || 0);
  const money = n => `EGP ${new Intl.NumberFormat(locale(), { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(n) || 0)}`;
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cairoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const monthName = key => new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T12:00:00Z`));
  const tinyWeekday = key => (currentLang === 'en' ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] : ['أح', 'إث', 'ثل', 'أر', 'خم', 'جم', 'سب'])[new Date(`${key}T12:00:00Z`).getUTCDay()];
  const dayName = key => `${tinyWeekday(key)} · ${new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`))}`;
  const shortDate = key => new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
  const chartLabels = () => currentLang === 'en' ? {
    peak: 'Peak', hotspot: 'Unusual activity', insight: 'Smart Insight', missing: 'No data',
    future: 'Upcoming', outside: 'No calendar date', partial: 'Today · in progress', soFar: 'so far',
    zeroBase: 'N/A · previous count is zero', unavailable: 'Comparison unavailable', comparisonError: 'Comparison data could not load.',
    note: 'Daily orders · same calendar day comparison',
    singleNote: 'Daily orders for the selected month',
    apply: 'Apply', months: 'months', selection: 'Select comparison months',
    direction: 'Each month has its own colour', revenue: 'Revenue', confirmedValue: 'Confirmed value',
    valueNote: 'Revenue: all received orders, including shipping and cancellations · Confirmed value: active confirmed orders',
  } : {
    peak: 'الأعلى', hotspot: 'نشاط استثنائي', insight: 'رؤية ذكية', missing: 'بيانات غير متاحة',
    future: 'يوم قادم', outside: 'لا يوجد هذا اليوم', partial: 'اليوم · غير مكتمل', soFar: 'حتى الآن',
    zeroBase: 'غير متاح · العدد السابق صفر', unavailable: 'المقارنة غير متاحة', comparisonError: 'تعذر تحميل بيانات المقارنة.',
    note: 'الطلبات اليومية · مقارنة نفس اليوم من الشهر',
    singleNote: 'الطلبات اليومية للشهر المحدد',
    apply: 'تطبيق', months: 'شهور', selection: 'اختر شهور المقارنة',
    direction: 'لكل شهر لون ثابت', revenue: 'قيمة المستقبَل', confirmedValue: 'قيمة المؤكد',
    valueNote: 'قيمة المستقبَل تشمل الشحن وكل الحالات، بما فيها الإلغاء · قيمة المؤكد للطلبات المؤكدة النشطة',
  };
  const state = { month: '', compareMonth: '', compareMonths: [], comparisons: [], comparing: false, visible: [true, true], chartStyle: 'area', chartSignature: '', data: null, compareData: null, token: '', error: false, run: 0, cache: new Map(), pending: new Map() };
  let monthPopup = null, pickerYear = 0, pickerTarget = 'primary', draftMonths = new Set();
  const pickerTrigger = () => q(pickerTarget === 'compare' ? 'so-compare-trigger' : 'so-month-trigger');
  const previousMonth = key => {
    const [year, month] = key.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 2, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const comparisonDefault = key => previousMonth(key) >= '2000-01' ? previousMonth(key) : '2000-02';
  const comparisonKeys = () => state.comparing ? state.compareMonths.filter(key => key !== state.month) : [];
  const seriesVisible = index => state.visible[index] !== false;
  const monthColourSlots = new Map();
  const seriesColor = (index, tooltip = false) => {
    const key = [state.month, ...comparisonKeys()][index];
    if (!monthColourSlots.has(key)) monthColourSlots.set(key, monthColourSlots.size);
    const slot = monthColourSlots.get(key);
    if (slot < 6) return `var(--so-${tooltip ? 'tip-' : ''}month-${slot})`;
    return `hsl(${(slot * 137.508) % 360} 38% var(--so-${tooltip ? 'tip-' : ''}month-lightness))`;
  };
  const seriesDash = index => ['7 5', '2 5', '9 4 2 4', '12 5'][(index - 1) % 4];

  function closeMonthPicker(refocus = false) {
    if (!monthPopup || monthPopup.hidden) return;
    monthPopup.hidden = true;
    pickerTrigger()?.setAttribute('aria-expanded', 'false');
    if (refocus) pickerTrigger()?.focus({ preventScroll: true });
  }
  function positionMonthPicker() {
    if (!monthPopup || monthPopup.hidden) return;
    const trigger = pickerTrigger();
    if (!trigger?.isConnected || host()?.hidden) { closeMonthPicker(); return; }
    const rect = trigger.getBoundingClientRect(), width = monthPopup.offsetWidth, height = monthPopup.offsetHeight;
    if (rect.bottom < 0 || rect.top > innerHeight) { closeMonthPicker(); return; }
    const inset = innerWidth <= 600 ? 18 : 24;
    const left = innerWidth <= 600 ? (innerWidth - width) / 2 : Math.max(inset, Math.min(innerWidth - width - inset, rect.left + (rect.width - width) / 2));
    const top = rect.bottom + 8 + height <= innerHeight - inset ? rect.bottom + 8 : rect.top - height - 8 >= inset ? rect.top - height - 8 : Math.max(inset, Math.min(innerHeight - height - inset, rect.bottom + 8));
    monthPopup.style.left = `${Math.round(left)}px`;
    monthPopup.style.top = `${Math.round(top)}px`;
  }
  function renderMonthPicker() {
    const maxMonth = cairoToday().slice(0, 7), maxYear = Number(maxMonth.slice(0, 4));
    const names = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(locale(), { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, i, 1))));
    const selected = pickerTarget === 'compare' ? '' : state.month;
    monthPopup.dir = currentLang === 'en' ? 'ltr' : 'rtl';
    monthPopup.setAttribute('aria-label', pickerTarget === 'compare' ? chartLabels().selection : labels().choose);
    monthPopup.innerHTML = `<div class="so-month-head"><button type="button" data-year-step="-1" aria-label="${labels().previousYear}"${pickerYear <= 2000 ? ' disabled' : ''}>‹</button><strong>${pickerYear}</strong><button type="button" data-year-step="1" aria-label="${labels().nextYear}"${pickerYear >= maxYear ? ' disabled' : ''}>›</button></div><div class="so-month-grid">${names.map((name, index) => {
      const key = `${pickerYear}-${String(index + 1).padStart(2, '0')}`;
      const chosen = pickerTarget === 'compare' ? draftMonths.has(key) : key === selected;
      return `<button type="button" data-month="${key}" aria-label="${monthName(key)}" aria-pressed="${chosen}" class="${chosen ? 'is-selected' : ''}"${key > maxMonth || (pickerTarget === 'compare' && key === state.month) ? ' disabled' : ''}>${escapeHtml(name)}</button>`;
    }).join('')}</div>${pickerTarget === 'compare' ? `<div class="so-month-selection">${[...draftMonths].sort().reverse().map(key => `<button type="button" data-remove-month="${key}" aria-label="${escapeHtml(`${labels().hideSeries} ${monthName(key)}`)}">${escapeHtml(monthName(key))} ×</button>`).join('')}</div><div class="so-month-apply"><span>${draftMonths.size} ${chartLabels().months}</span><button type="button" id="so-apply-months"${draftMonths.size ? '' : ' disabled'}>${chartLabels().apply}</button></div>` : ''}`;
    positionMonthPicker();
  }
  function toggleMonthPicker(target = 'primary') {
    if (monthPopup && !monthPopup.hidden) {
      if (pickerTarget === target) { closeMonthPicker(true); return; }
      closeMonthPicker();
    }
    pickerTarget = target;
    if (target === 'compare') draftMonths = new Set(state.compareMonths);
    if (!monthPopup) {
      monthPopup = document.createElement('div');
      monthPopup.className = 'so-month-popover';
      monthPopup.id = 'so-month-popover';
      monthPopup.setAttribute('role', 'dialog');
      document.body.append(monthPopup);
      monthPopup.addEventListener('click', event => {
        if (event.target.closest('#so-apply-months')) {
          const keys = [...draftMonths].filter(key => key !== state.month).sort().reverse();
          if (!keys.length) return;
          state.compareMonths = keys; state.compareMonth = keys[0]; state.visible = Array(keys.length + 1).fill(true);
          closeMonthPicker(true); load().catch(() => {}); return;
        }
        const remove = event.target.closest('[data-remove-month]');
        if (remove) {
          draftMonths.delete(remove.dataset.removeMonth); renderMonthPicker();
          (monthPopup.querySelector('[data-remove-month]') || monthPopup.querySelector('.so-month-grid button:not(:disabled)'))?.focus({ preventScroll: true }); return;
        }
        const yearButton = event.target.closest('[data-year-step]');
        if (yearButton && !yearButton.disabled) { pickerYear += Number(yearButton.dataset.yearStep); renderMonthPicker(); const next = monthPopup.querySelector(`[data-year-step="${yearButton.dataset.yearStep}"]`); (next?.disabled ? monthPopup.querySelector('.so-month-grid button:not(:disabled)') : next)?.focus({ preventScroll: true }); return; }
        const monthButton = event.target.closest('[data-month]');
        if (monthButton && !monthButton.disabled && pickerTarget === 'compare') {
          const key = monthButton.dataset.month;
          if (draftMonths.has(key)) draftMonths.delete(key); else draftMonths.add(key);
          renderMonthPicker(); monthPopup.querySelector(`[data-month="${key}"]`)?.focus({ preventScroll: true }); return;
        }
        if (monthButton && !monthButton.disabled && setMonth(monthButton.dataset.month, pickerTarget)) { closeMonthPicker(true); load().catch(() => {}); }
      });
    }
    const dashboardStyle = getComputedStyle(host());
    for (const name of ['--ds-surface', '--ds-bg', '--ds-border', '--ds-text', '--ds-accent']) monthPopup.style.setProperty(name, dashboardStyle.getPropertyValue(name));
    pickerYear = Number((pickerTarget === 'compare' ? state.compareMonth : state.month).slice(0, 4));
    monthPopup.hidden = false;
    pickerTrigger().setAttribute('aria-expanded', 'true');
    renderMonthPicker();
    (monthPopup.querySelector('.so-month-grid .is-selected') || monthPopup.querySelector('.so-month-grid button:not(:disabled)'))?.focus({ preventScroll: true });
  }

  function setMonth(key, target = 'primary') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return false;
    const year = Number(key.slice(0, 4));
    if (year < 2000 || key > cairoToday().slice(0, 7)) return false;
    if (target === 'compare') {
      if (key === state.month) return false;
      state.compareMonth = key;
      state.compareMonths = [key];
    } else {
      state.month = key;
      if (state.comparing && state.compareMonth === key) state.compareMonth = comparisonDefault(key);
      if (state.comparing) {
        state.compareMonths = state.compareMonths.filter(month => month !== key);
        if (!state.compareMonths.length) state.compareMonths = [comparisonDefault(key)];
        state.compareMonth = state.compareMonths[0];
        state.visible = Array(state.compareMonths.length + 1).fill(true);
      }
    }
    return true;
  }
  function shift(delta) {
    const [year, month] = state.month.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    const key = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    if (setMonth(key)) load({ force: false }).catch(() => {});
  }
  function staticText() {
    const l = labels();
    q('so-eyebrow').textContent = l.eyebrow;
    q('so-title').textContent = monthName(state.month);
    q('so-note').textContent = l.note;
    q('so-chart-title').textContent = l.chart;
    q('so-chart-note').textContent = state.comparing ? `${chartLabels().note} · ${chartLabels().direction}` : chartLabels().singleNote;
    q('so-chart-style').setAttribute('aria-label', l.chartStyle);
    q('so-chart-style').querySelectorAll('[data-chart-style]').forEach(button => {
      const style = button.dataset.chartStyle;
      button.textContent = style === 'area' ? l.areaStyle : l.lineStyle;
      button.setAttribute('aria-pressed', String(state.chartStyle === style));
    });
    const partial = [state.month, ...comparisonKeys()].includes(cairoToday().slice(0, 7));
    q('so-chart-foot').innerHTML = `<span>${l.timezone}</span><span>${chartLabels().valueNote}</span>${partial ? `<span>${l.partial}</span>` : ''}<span class="so-scroll-hint">${l.scroll}</span>`;
    q('so-month').value = state.month;
    q('so-month').setAttribute('aria-label', l.choose);
    q('so-month-label').textContent = monthName(state.month);
    q('so-month-trigger').setAttribute('aria-label', l.choose);
    q('so-month-trigger').title = l.choose;
    q('so-compare-toggle').textContent = state.comparing ? l.stopCompare : l.compare;
    q('so-compare-toggle').setAttribute('aria-pressed', String(state.comparing));
    q('so-compare-trigger').hidden = !state.comparing;
    q('so-compare-trigger').setAttribute('aria-label', `${l.compareWith}: ${state.compareMonths.map(monthName).join(', ')}`);
    if (state.compareMonth) q('so-compare-label').textContent = state.compareMonths.length > 1 ? `${state.compareMonths.length} ${chartLabels().months}` : monthName(state.compareMonth);
    q('so-prev').setAttribute('aria-label', l.prev);
    q('so-next').setAttribute('aria-label', l.next);
    q('so-prev').title = l.prev;
    q('so-next').title = l.next;
    q('so-prev').disabled = state.month === '2000-01';
    q('so-next').disabled = state.month >= cairoToday().slice(0, 7);
    host().setAttribute('aria-label', l.eyebrow);
    if (monthPopup && !monthPopup.hidden) renderMonthPicker();
  }
  function skeleton() {
    const l = labels();
    q('so-metrics').innerHTML = [l.orders, l.revenue, l.confirmed, l.average].map(label =>
      `<div class="so-metric"><span class="so-metric-label">${label}</span><span class="so-skeleton" aria-hidden="true"></span></div>`).join('');
    q('so-chart-canvas').replaceChildren();
    q('so-tip')?.remove();
    q('so-today').hidden = true;
    q('so-legend').hidden = true;
    if (q('so-insight')) q('so-insight').hidden = true;
  }
  function showError() {
    const el = q('so-error');
    el.hidden = !state.error;
    if (state.error) el.innerHTML = `${state.data?.month === state.month ? chartLabels().comparisonError : labels().error}<button type="button" id="so-retry">${labels().retry}</button>`;
  }
  function renderMetrics(data, comparison) {
    const l = labels();
    const metrics = [
      [l.orders, 'totalOrders', false],
      [l.revenue, 'totalRevenue', true],
      [l.confirmed, 'confirmedOrders', false],
      [l.average, 'averageOrderValue', true],
    ];
    q('so-metrics').innerHTML = metrics.map(([label, key, currency]) => {
      const primary = Number(data[key]) || 0;
      const value = currency ? money(primary) : count(primary);
      let detail = '';
      if (comparison) {
        const other = Number(comparison[key]) || 0;
        const delta = primary - other;
        const difference = `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${currency ? money(Math.abs(delta)) : count(Math.abs(delta))}`;
        const percent = other ? ` (${delta > 0 ? '+' : delta < 0 ? '−' : ''}${count(Math.abs(delta / other * 100))}%)` : '';
        const tone = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : 'is-neutral';
        detail = `<div class="so-metric-compare"><span>${escapeHtml(monthName(comparison.month))}: ${escapeHtml(currency ? money(other) : count(other))}</span><strong class="so-delta ${tone}" aria-label="${escapeHtml(l.difference)} ${escapeHtml(difference + percent)}">${escapeHtml(difference + percent)}</strong></div>`;
      }
      return `<div class="so-metric"><span class="so-metric-label">${escapeHtml(label)}</span><bdi class="so-metric-value" title="${escapeHtml(value)}">${escapeHtml(value)}</bdi>${detail}</div>`;
    }).join('');
    const today = data.days.find(row => row.date === data.today);
    q('so-today').hidden = !today;
    if (today) q('so-today').textContent = `${l.today}: ${count(today.orders)} ${l.received}`;
  }
  function renderLegend(data, chartComparisons) {
    const l = labels();
    const legend = q('so-legend');
    const keys = [data.month, ...comparisonKeys()];
    legend.hidden = keys.length < 2;
    if (legend.hidden) { legend.replaceChildren(); delete legend.dataset.signature; return; }
    const signature = `${keys.join('|')}|${currentLang}`;
    if (legend.dataset.signature !== signature) {
      legend.dataset.signature = signature;
      legend.innerHTML = keys.map((key, index) => {
      const visible = seriesVisible(index), name = monthName(key);
      return `<button type="button" class="so-series-toggle${visible ? '' : ' is-muted'}" data-series-toggle="${index}" aria-pressed="${visible}" aria-label="${escapeHtml(`${visible ? l.hideSeries : l.showSeries} ${name}`)}" style="--so-series:${seriesColor(index)}"><i class="so-legend-mark${index ? ' is-compare' : ''}" aria-hidden="true"></i><span>${escapeHtml(name)}</span></button>`;
      }).join('');
    } else legend.querySelectorAll('[data-series-toggle]').forEach((button, index) => {
      const visible = seriesVisible(index);
      button.classList.toggle('is-muted', !visible);
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', `${visible ? l.hideSeries : l.showSeries} ${monthName(keys[index])}`);
    });
  }
  function niceTop(max) {
    if (max <= 4) return 4;
    const rough = max * 1.1 / 4;
    const power = 10 ** Math.floor(Math.log10(rough));
    const step = Math.ceil([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(n => n * power >= rough) * power);
    return step * 4;
  }
  function mountTooltip(canvas) {
    const tip = canvas.querySelector('#so-tip');
    const style = getComputedStyle(canvas);
    const colours = Array.from({ length: 6 }, (_, index) => [`--so-month-${index}`, `--so-tip-month-${index}`]).flat();
    for (const name of ['--ds-text', '--ds-surface', '--ds-accent', '--so-compare', '--so-month-lightness', '--so-tip-month-lightness', ...colours])
      tip.style.setProperty(name, style.getPropertyValue(name));
    document.body.append(tip);
    return tip;
  }
  function placeTooltip(tip, point) {
    const rect = point.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.max(half + 12, Math.min(innerWidth - half - 12, rect.left + rect.width / 2))}px`;
    const above = rect.top - tip.offsetHeight - 12;
    const top = above >= 12 ? above : rect.bottom + 12;
    tip.style.top = `${Math.max(12, Math.min(innerHeight - tip.offsetHeight - 12, top))}px`;
    tip.style.transform = 'translate(-50%, 0)';
  }
  function showGuide(canvas, point) {
    const guide = canvas.querySelector('.so-hover-line');
    if (!guide) return;
    guide.setAttribute('x1', point.getAttribute('cx'));
    guide.setAttribute('x2', point.getAttribute('cx'));
    guide.removeAttribute('hidden');
  }
  function hideGuide(canvas) { canvas.querySelector('.so-hover-line')?.setAttribute('hidden', ''); }
  function bindPlotHover(svg, { width, left, top, base, dayCount, pointFor, showTip, hideTip }) {
    let hoveredDay = -1;
    svg.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch') return;
      const rect = svg.getBoundingClientRect();
      const px = (event.clientX - rect.left) * width / rect.width;
      const py = (event.clientY - rect.top) * Number(svg.viewBox.baseVal.height) / rect.height;
      if (px < left - 8 || px > width - 8 || py < top || py > base) {
        if (hoveredDay !== -1) { hoveredDay = -1; hideTip(); }
        return;
      }
      const day = Math.max(0, Math.min(dayCount - 1, Math.round((px - left) * (dayCount - 1) / (width - left - 16))));
      if (day === hoveredDay) return;
      const point = pointFor(day);
      if (!point) { hoveredDay = -1; hideTip(); return; }
      hoveredDay = day;
      showTip(point);
    });
    svg.addEventListener('pointerleave', event => { hoveredDay = -1; if (!event.relatedTarget?.closest?.('#so-tip')) hideTip(); });
  }
  let chartModel = null;
  function modelFor(primary, comparisons) {
    const today = cairoToday();
    const keys = comparisonKeys(), signature = `${keys.join('|')}|${state.visible.join(',')}`;
    if (chartModel?.primary === primary && chartModel.signature === signature && chartModel.today === today
      && comparisons.every((data, index) => chartModel.comparisons[index] === data)) return chartModel;
    const first = dailyOrdersAnalysis.calendar(primary, today);
    const others = comparisons.map((data, index) => dailyOrdersAnalysis.calendar(data || { month: keys[index], days: [] }, today));
    const baseline = comparisons.findIndex((data, index) => data && seriesVisible(index + 1));
    chartModel = { primary, comparisons, signature, baseline, today, series: [first, ...others],
      ...dailyOrdersAnalysis.analyze(first, others[baseline] || [], today) };
    return chartModel;
  }
  function insightText(insight, primary, comparison) {
    if (!insight) return '';
    const en = currentLang === 'en';
    const percent = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(Math.abs(insight.change || 0));
    if (insight.type === 'comparison') return en
      ? `${monthName(primary.month)} recorded ${percent}% ${insight.change > 0 ? 'more' : 'fewer'} orders than ${monthName(comparison.month)} across ${insight.days} comparable completed days.`
      : `طلبات ${monthName(primary.month)} ${insight.change > 0 ? 'أعلى' : 'أقل'} بنسبة ${percent}% من ${monthName(comparison.month)} عبر ${insight.days} يومًا مكتملًا قابلًا للمقارنة.`;
    if (insight.type === 'weekday') {
      const weekday = new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + insight.weekday)));
      return en ? `${weekday} has the ${insight.strong ? 'highest' : 'lowest'} average daily orders in ${monthName(primary.month)}.`
        : `يوم ${weekday} يسجل ${insight.strong ? 'أعلى' : 'أقل'} متوسط للطلبات اليومية في ${monthName(primary.month)}.`;
    }
    if (insight.type === 'hotspot') return en
      ? `${shortDate(insight.row.date)} recorded unusually high activity: ${count(insight.row.orders)} orders compared with the usual daily pattern.`
      : `نشاط استثنائي يوم ${shortDate(insight.row.date)}: ${count(insight.row.orders)} طلب مقارنة بالنمط اليومي المعتاد.`;
    return en ? `Orders ${insight.change > 0 ? 'increased' : 'decreased'} ${percent}% during ${shortDate(insight.from)}–${shortDate(insight.to)} versus the preceding seven days.`
      : `${insight.change > 0 ? 'ارتفعت' : 'انخفضت'} الطلبات بنسبة ${percent}% خلال ${shortDate(insight.from)}–${shortDate(insight.to)} مقارنة بالأيام السبعة السابقة.`;
  }
  function renderComparisonChart(primary, comparisons, animate) {
    const canvas = q('so-chart-canvas'), model = modelFor(primary, comparisons), l = chartLabels();
    const { series, today } = model;
    const width = Math.max(canvas.clientWidth || 900, 900), height = canvas.clientHeight || 330;
    canvas._plotSize = `${width}|${height}|${q('so-chart-scroll').clientWidth}`;
    q('so-chart-foot').classList.toggle('is-scrollable', width > q('so-chart-scroll').clientWidth + 1);
    const left = 48, right = 16, top = 42, bottom = 49, base = height - bottom;
    const chartW = width - left - right, chartH = base - top;
    const max = niceTop(Math.max(0, ...series.flatMap((rows, index) => seriesVisible(index) ? rows : []).filter(row => row.status === 'available').map(row => row.orders)));
    const x = index => left + index * chartW / 30;
    const y = orders => top + (1 - orders / max) * chartH;
    const pathsFor = rows => {
      const segments = [];
      rows.forEach((row, index) => {
        if (row.status !== 'available') return;
        if (!index || rows[index - 1].status !== 'available') segments.push([]);
        segments.at(-1).push({ x: x(index), y: y(row.orders) });
      });
      return segments.map(points => {
        let path = `M ${points[0].x} ${points[0].y}`;
        const changes = [];
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i], middle = (a.x + b.x) / 2;
          const curve = `C ${middle} ${a.y}, ${middle} ${b.y}, ${b.x} ${b.y}`;
          path += ` ${curve}`;
          changes.push({ path: `M ${a.x} ${a.y} ${curve}`, direction: b.y < a.y ? 'up' : b.y > a.y ? 'down' : 'flat' });
        }
        return { path, changes, area: `${path} L ${points.at(-1).x} ${base} L ${points[0].x} ${base} Z` };
      });
    };
    const grids = Array.from({ length: 5 }, (_, index) => {
      const value = max - index * max / 4, lineY = y(value);
      return `<line class="so-grid-line" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"/><text class="so-axis-label" x="${left - 9}" y="${lineY + 4}" text-anchor="end">${escapeHtml(count(value))}</text>`;
    }).join('');
    const ticks = Array.from({ length: 31 }, (_, index) => `<text class="so-axis-label so-day-label" x="${x(index)}" y="${height - 25}" text-anchor="middle">${index + 1}</text>${series[0][index].status !== 'outside' ? `<text class="so-axis-label so-weekday-label" x="${x(index)}" y="${height - 9}" text-anchor="middle">${tinyWeekday(series[0][index].date)}</text>` : ''}`).join('');
    const annotations = new Map();
    if (model.peak) annotations.set(model.peak.day, 'peak');
    model.hotspots.forEach(row => { if (!annotations.has(row.day)) annotations.set(row.day, 'hotspot'); });
    const occupied = [];
    const annotationLabels = [model.peak].filter(Boolean).map(row => {
      const kind = annotations.get(row.day), px = x(row.day - 1), py = y(row.orders);
      const lx = Math.max(left + 72, Math.min(width - right - 72, px));
      let ly = Math.max(14, py - 35);
      if (occupied.some(box => Math.abs(box.x - lx) < 150 && Math.abs(box.y - ly) < 38)) ly = Math.min(base - 24, py + 26);
      occupied.push({ x: lx, y: ly });
      return `<g class="so-annotation is-${kind}" aria-hidden="true"><line x1="${px}" y1="${py + (ly > py ? 8 : -8)}" x2="${lx}" y2="${ly + (ly > py ? -12 : 18)}"/><text x="${lx}" y="${ly}" text-anchor="middle">${escapeHtml(l[kind])}${row.date === today ? ` · ${l.soFar}` : ''}<tspan class="so-annotation-detail" x="${lx}" dy="15">${escapeHtml(shortDate(row.date))} · ${escapeHtml(count(row.orders))} ${labels().received}</tspan></text></g>`;
    }).join('');
    const plots = series.map((rows, seriesIndex) => {
      const compare = seriesIndex ? ' is-compare' : '';
      const paths = pathsFor(rows).map(({ path, area, changes }) => `${!seriesIndex && state.chartStyle === 'area' ? `<path class="so-area" d="${area}"/>` : ''}${seriesIndex ? `<path class="so-line${compare}" style="stroke-dasharray:${seriesDash(seriesIndex)}" d="${path}"/>` : changes.map(segment => `<path class="so-line is-${segment.direction}" d="${segment.path}"/>`).join('')}`).join('');
      const points = rows.map((row, index) => {
        if (row.status !== 'available') return '';
        const kind = !seriesIndex ? annotations.get(row.day) : '';
        const label = `${dayName(row.date)}: ${count(row.orders)} ${labels().received}${kind ? ` · ${l[kind]}` : ''}`;
        const ring = !seriesIndex && model.hotspots.includes(row) ? `<circle class="so-hotspot-ring" cx="${x(index)}" cy="${y(row.orders)}" r="9"/>` : '';
        const direction = !seriesIndex && rows[index - 1]?.status === 'available' ? row.orders < rows[index - 1].orders ? 'down' : 'up' : '';
        const earlierVisible = series.slice(0, seriesIndex).some((items, i) => seriesVisible(i) && items[index]?.status === 'available');
        return `${ring}<circle class="so-point${compare}${direction ? ` is-${direction}` : ''}${kind ? ` is-${kind}` : ''}${row.date === today ? ' is-today' : ''}" data-series="${seriesIndex}" data-day="${index}" cx="${x(index)}" cy="${y(row.orders)}" r="${kind ? 5 : 2.6}" tabindex="${earlierVisible ? -1 : 0}" role="button" aria-describedby="so-tip" aria-label="${escapeHtml(label)}"/>`;
      }).join('');
      const todayRow = rows.find(row => row.date === today && row.status === 'available');
      const todayLine = !seriesIndex && todayRow ? `<line class="so-today-line" x1="${x(todayRow.day - 1)}" y1="${top}" x2="${x(todayRow.day - 1)}" y2="${base}"/>` : '';
      return `<g class="so-series${compare}" style="--so-series:${seriesColor(seriesIndex)}" data-series="${seriesIndex}"${seriesVisible(seriesIndex) ? '' : ' hidden'}>${todayLine}${paths}${points}${!seriesIndex ? annotationLabels : ''}</g>`;
    }).join('');
    const targets = Array.from({ length: 31 }, (_, index) => {
      const hasPoint = series.some((rows, i) => seriesVisible(i) && rows[index]?.status === 'available');
      const status = series.find((rows, i) => seriesVisible(i))?.[index]?.status || 'missing';
      return `<rect class="so-day-target" data-day="${index}" x="${x(index) - 12}" y="${top}" width="24" height="${chartH}" cx="${x(index)}" cy="${base}" tabindex="${hasPoint ? -1 : 0}" role="button" aria-describedby="so-tip" aria-label="${escapeHtml(`${index + 1} · ${monthName(primary.month)} · ${l[status] || labels().chart}`)}"/>`;
    }).join('');
    q('so-tip')?.remove();
    canvas.innerHTML = `<svg class="so-chart-svg${animate ? ' is-animating' : ''}" viewBox="0 0 ${width} ${height}" aria-label="${escapeHtml(labels().chart)}: ${escapeHtml([primary.month, ...comparisonKeys()].map(monthName).join(', '))}" role="group" style="--so-primary:${seriesColor(0)}"><defs><linearGradient id="so-area-fade" gradientUnits="userSpaceOnUse" x1="0" y1="${top}" x2="0" y2="${base}"><stop class="so-area-stop" offset="0" stop-opacity=".20"/><stop class="so-area-stop" offset=".65" stop-opacity=".06"/><stop class="so-area-stop" offset="1" stop-opacity="0"/></linearGradient></defs>${grids}${ticks}${targets}<line class="so-hover-line" y1="${top}" y2="${base}" hidden/>${plots}</svg><div class="so-tip" id="so-tip" role="tooltip" hidden></div>`;
    if (!series.some((rows, index) => seriesVisible(index) && rows.some(row => row.status === 'available'))) {
      const empty = document.createElement('div'); empty.className = 'so-chart-empty'; empty.textContent = l.missing;
      canvas.append(empty);
    }
    const insight = q('so-insight');
    const message = seriesVisible(0) ? insightText(model.insight, primary, comparisons[model.baseline]) : '';
    insight.hidden = !message;
    insight.innerHTML = message ? `<strong>${l.insight}</strong><span>${escapeHtml(message)}</span>` : '';
    const tip = mountTooltip(canvas);
    let tipAnchor = null;
    tip.addEventListener('pointerleave', () => { if (!canvas.contains(document.activeElement)) canvas._hideTip?.(); });
    const pointFor = day => canvas.querySelector(`.so-series:not([hidden]) .so-point[data-day="${day}"]`) || canvas.querySelector(`.so-day-target[data-day="${day}"]`);
    const showTip = point => {
      const index = Number(point.dataset.day);
      tipAnchor = point;
      canvas.querySelectorAll('.is-active').forEach(node => node.classList.remove('is-active'));
      point.classList.add('is-active');
      canvas.querySelectorAll(`.so-series:not([hidden]) .so-point[data-day="${index}"]`).forEach(node => node.classList.add('is-active'));
      showGuide(canvas, point);
      const active = series[Number(point.dataset.series) || 0][index];
      const heading = active?.status !== 'outside' ? active.date : series.map(rows => rows[index]).find(row => row?.status !== 'outside')?.date;
      const lines = [primary, ...comparisons].map((data, seriesIndex) => {
        if (!seriesVisible(seriesIndex)) return '';
        const colour = `--so-series:${seriesColor(seriesIndex)};--so-series-ink:${seriesColor(seriesIndex, true)}`;
        if (!data) return `<span class="so-tip-series is-compare" style="${colour}"><span class="so-tip-month">${escapeHtml(monthName(comparisonKeys()[seriesIndex - 1]))}</span><small>${l.unavailable}</small></span>`;
        const row = series[seriesIndex][index];
        const value = row.status === 'available' ? `<span class="so-tip-orders"><bdi class="so-tip-order-count">${escapeHtml(count(row.orders))}</bdi> <span>${row.orders === 1 ? labels().oneOrder : labels().received}</span></span>` : `<span class="so-tip-no-count">— · ${l[row.status]}</span>`;
        const values = row.status === 'available' ? `<small>${l.revenue}: <bdi>${row.receivedValue === null ? '—' : escapeHtml(money(row.receivedValue))}</bdi></small><small>${l.confirmedValue}: <bdi>${row.confirmedValue === null ? '—' : escapeHtml(money(row.confirmedValue))}</bdi>${row.confirmedOrders === null ? '' : ` · ${count(row.confirmedOrders)} ${labels().received}`}</small>` : '';
        const delta = seriesIndex && seriesVisible(0) ? dailyOrdersAnalysis.difference(series[0][index], row) : null;
        const percent = delta?.percent === null ? l.zeroBase : delta ? `${delta.percent > 0 ? '+' : ''}${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(delta.percent)}%` : '—';
        const change = delta ? `${delta.orders > 0 ? '+' : ''}${count(delta.orders)} ${labels().received} · ${percent}` : '—';
        const tone = delta?.orders > 0 ? 'is-up' : delta?.orders < 0 ? 'is-down' : 'is-neutral';
        const difference = seriesIndex && seriesVisible(0) ? `<small class="so-tip-difference so-delta ${tone}">${labels().difference}: ${escapeHtml(change)}</small>` : '';
        return `<span class="so-tip-series${seriesIndex ? ' is-compare' : ''}" style="${colour}"><span class="so-tip-row-head"><span class="so-tip-month">${escapeHtml(monthName(data.month))}:</span> ${value}</span>${values}${row.date === today ? `<small>${l.partial}</small>` : ''}${difference}</span>`;
      });
      tip.innerHTML = `<strong>${escapeHtml(heading ? dayName(heading) : String(index + 1))}</strong>${lines.join('')}`;
      tip.style.direction = currentLang === 'en' ? 'ltr' : 'rtl';
      tip.hidden = false;
      placeTooltip(tip, point);
    };
    const hideTip = () => { tip.hidden = true; tipAnchor = null; hideGuide(canvas); canvas.querySelectorAll('.is-active').forEach(node => node.classList.remove('is-active')); };
    const svg = canvas.querySelector('svg');
    svg.addEventListener('focusin', event => { if (event.target.matches('[data-day]')) { event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); showTip(event.target); } });
    svg.addEventListener('focusout', hideTip);
    svg.addEventListener('click', event => {
      const point = event.target.closest('[data-day]');
      if (point) { showTip(pointFor(Number(point.dataset.day))); return; }
      const rect = svg.getBoundingClientRect(), px = (event.clientX - rect.left) * width / rect.width;
      const py = (event.clientY - rect.top) * height / rect.height;
      if (px >= left && px <= width - right && py >= top && py <= base)
        showTip(pointFor(Math.max(0, Math.min(30, Math.round((px - left) * 30 / chartW)))));
    });
    svg.addEventListener('keydown', event => {
      if (event.key === 'Escape') { hideTip(); return; }
      const day = Number(event.target.dataset.day);
      if (!Number.isInteger(day)) return;
      if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        pointFor(event.key === 'Home' ? 0 : event.key === 'End' ? 30 : Math.max(0, Math.min(30, day + (event.key === 'ArrowRight' ? 1 : -1))))?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showTip(event.target); }
    });
    bindPlotHover(svg, { width, left, top, base, dayCount: 31, pointFor, showTip, hideTip: () => {
      const focused = svg.querySelector('[data-day]:focus');
      if (focused && !tip.hidden) showTip(focused);
      else hideTip();
    } });
    // Body-mounted tooltips must not linger when their point scrolls out of view.
    const reposition = () => {
      const point = tipAnchor;
      if (tip.hidden || !point) return;
      const rect = point.getBoundingClientRect(), viewport = q('so-chart-scroll').getBoundingClientRect();
      if (rect.right < viewport.left || rect.left > viewport.right || rect.bottom < 0 || rect.top > innerHeight) hideTip();
      else placeTooltip(tip, point);
    };
    q('so-chart-scroll').onscroll = reposition;
    canvas._repositionTip = reposition;
    canvas._hideTip = hideTip;
  }
  let metricsPaint = null;
  function render() {
    if (!host() || host().hidden || !state.month) return;
    state.lastLang = currentLang;
    staticText(); showError();
    if (!state.data || state.data.month !== state.month) { skeleton(); return; }
    const keys = comparisonKeys();
    const chartComparisons = keys.map(key => state.comparisons.find(data => data?.month === key) || null);
    const chartComparison = chartComparisons[0] || null;
    const comparison = state.comparing ? chartComparison : null;
    // Cascade Reveal only when the figures replace the skeleton — not on language or comparison redraws.
    const arriving = !!q('so-metrics')?.querySelector('.so-skeleton');
    if (arriving || metricsPaint?.data !== state.data || metricsPaint?.comparison !== comparison || metricsPaint?.lang !== currentLang) {
      renderMetrics(state.data, comparison);
      metricsPaint = { data: state.data, comparison, lang: currentLang };
    }
    renderLegend(state.data, chartComparisons);
    if (arriving) window.souliaCascade?.(q('so-metrics'), { count: '.so-metric-value' });
    const signature = `${state.month}|${keys.join('|')}`;
    const animate = signature !== state.chartSignature;
    state.chartSignature = signature;
    renderComparisonChart(state.data, chartComparisons, animate);
  }
  function fetchMonth(key, force, token) {
    const cached = state.cache.get(key);
    if (!force && cached && Date.now() - cached.at < 30000) return Promise.resolve(cached.data);
    const revision = typeof _apiWriteRevision === 'number' ? _apiWriteRevision : 0;
    const pending = state.pending.get(key);
    if (pending?.revision === revision) return pending.promise;
    const [year, month] = key.split('-');
    const promise = api(`/transactions/sales-overview?year=${year}&month=${Number(month)}`)
      .then(data => {
        if (!data || data.month !== key || !Array.isArray(data.days)) throw new Error('Invalid sales overview');
        if (token === state.token && revision === (typeof _apiWriteRevision === 'number' ? _apiWriteRevision : 0))
          state.cache.set(key, { data, at: Date.now() });
        return data;
      })
      .finally(() => {
        if (state.pending.get(key)?.promise === promise) state.pending.delete(key);
      });
    state.pending.set(key, { revision, promise });
    return promise;
  }
  async function load({ force = false } = {}) {
    if (!host() || !isAdmin()) return;
    if (host().classList.contains('is-revalidating')) force = true;
    const token = localStorage.getItem('token') || '';
    if (state.token !== token) {
      state.token = token; state.cache.clear(); state.pending.clear();
      state.data = null; state.compareData = null; state.comparisons = [];
    }
    if (!state.month) setMonth(cairoToday().slice(0, 7));
    if (state.comparing && !state.compareMonths.length) {
      state.compareMonth = comparisonDefault(state.month); state.compareMonths = [state.compareMonth];
    }
    host().hidden = false;
    const selected = state.month, keys = comparisonKeys(), selection = keys.join('|');
    const primaryCache = state.cache.get(selected);
    const compareCaches = keys.map(key => state.cache.get(key));
    const keepPaint = !!(force && primaryCache && state.data?.month === selected
      && compareCaches.every(Boolean) && state.lastLang === currentLang
      && q('so-metrics')?.querySelector('.so-metric-value'));
    state.data = keepPaint ? primaryCache.data : force ? null : primaryCache?.data || (state.data?.month === selected ? state.data : null);
    state.comparisons = keys.map((key, index) => keepPaint ? compareCaches[index]?.data || null
      : force ? null : compareCaches[index]?.data || state.comparisons.find(data => data?.month === key) || null);
    state.compareData = state.comparisons[0] || null;
    state.error = false;
    const run = ++state.run;
    host().classList.toggle('is-revalidating', keepPaint);
    host().setAttribute('aria-busy', String(keepPaint));
    if (!keepPaint) render();
    const needsPrimary = force || !primaryCache || Date.now() - primaryCache.at >= 30000;
    const needsCompare = compareCaches.some(cached => force || !cached || Date.now() - cached.at >= 30000);
    if (!needsPrimary && !needsCompare) { host().classList.remove('is-loading'); return state.data; }
    host().classList.add('is-loading');
    try {
      const requested = [selected, ...keys], results = Array(requested.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < requested.length) {
          const index = cursor++;
          try { results[index] = { status: 'fulfilled', value: await fetchMonth(requested[index], force, token) }; }
          catch (reason) { results[index] = { status: 'rejected', reason }; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, requested.length) }, worker));
      const [primaryResult, ...comparisonResults] = results;
      if (primaryResult.status === 'rejected') throw primaryResult.reason;
      const primary = primaryResult.value;
      const comparisons = comparisonResults.map(result => result.status === 'fulfilled' ? result.value : null);
      if (run === state.run && token === state.token && selected === state.month && selection === comparisonKeys().join('|')) {
        const unchanged = keepPaint && JSON.stringify(primary) === JSON.stringify(primaryCache.data)
          && comparisons.every((data, index) => JSON.stringify(data) === JSON.stringify(compareCaches[index]?.data));
        state.data = primary; state.comparisons = comparisons; state.compareData = comparisons[0] || null;
        state.error = comparisonResults.some(result => result.status === 'rejected');
        if (!unchanged) render(); else showError();
        host().classList.remove('is-revalidating');
        host().setAttribute('aria-busy', 'false');
      }
      return primary;
    } catch (error) {
      if (run === state.run) {
        state.data = force ? null : state.cache.get(selected)?.data || state.data;
        state.comparisons = keys.map(key => force ? null : state.cache.get(key)?.data || null);
        state.compareData = state.comparisons[0] || null;
        state.error = true;
        if (keepPaint) showError(); else render();
        host().setAttribute('aria-busy', 'false');
      }
      throw error;
    } finally {
      if (run === state.run) { host().classList.remove('is-loading', 'is-revalidating'); host().setAttribute('aria-busy', 'false'); }
    }
  }
  function hide() { closeMonthPicker(); q('so-tip')?.remove(); if (host()) host().hidden = true; state.run++; }
  function toggleComparison() {
    closeMonthPicker();
    state.comparing = !state.comparing;
    state.visible = [true, true];
    if (state.comparing) {
      state.compareMonths = state.compareMonths.filter(key => key !== state.month);
      if (!state.compareMonths.length) state.compareMonths = [comparisonDefault(state.month)];
      state.compareMonth = state.compareMonths[0];
    }
    state.visible = Array(comparisonKeys().length + 1).fill(true);
    load().catch(() => {});
  }
  document.addEventListener('click', event => {
    const seriesButton = event.target.closest('#so-legend [data-series-toggle]');
    const styleButton = event.target.closest('#so-chart-style [data-chart-style]');
    if (seriesButton) {
      const index = Number(seriesButton.dataset.seriesToggle);
      if (seriesVisible(index) && !Array.from({ length: comparisonKeys().length + 1 }, (_, i) => i !== index && seriesVisible(i)).some(Boolean)) return;
      state.visible[index] = !seriesVisible(index);
      render();
    }
    else if (styleButton) {
      const style = styleButton.dataset.chartStyle;
      if (style !== 'line' && style !== 'area') return;
      state.chartStyle = style;
      render();
    }
    else if (event.target.closest('#so-prev')) shift(-1);
    else if (event.target.closest('#so-next')) shift(1);
    else if (event.target.closest('#so-month-trigger')) toggleMonthPicker('primary');
    else if (event.target.closest('#so-compare-trigger')) toggleMonthPicker('compare');
    else if (event.target.closest('#so-compare-toggle')) toggleComparison();
    else if (event.target.closest('#so-retry')) load({ force: true }).catch(() => {});
  });
  document.addEventListener('pointerdown', event => {
    if (monthPopup && !monthPopup.hidden && !monthPopup.contains(event.target) && !q('so-month-trigger')?.contains(event.target) && !q('so-compare-trigger')?.contains(event.target)) closeMonthPicker();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && monthPopup && !monthPopup.hidden) { event.preventDefault(); closeMonthPicker(true); } });
  document.addEventListener('change', event => {
    if (event.target.id === 'so-month') {
      if (setMonth(event.target.value)) load().catch(() => {});
      else event.target.value = state.month;
    }
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    positionMonthPicker();
    if (host()?.hidden || !state.data) return;
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
      const canvas = q('so-chart-canvas');
      const size = `${Math.max(canvas.clientWidth || 900, 900)}|${canvas.clientHeight || 330}|${q('so-chart-scroll').clientWidth}`;
      if (canvas._plotSize !== size) render();
      else canvas._repositionTip?.();
    }, 100);
  });
  window.addEventListener('scroll', () => { positionMonthPicker(); q('so-chart-canvas')?._repositionTip?.(); }, true);
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#so-chart-canvas, #so-tip')) q('so-chart-canvas')?._hideTip?.(); });
  window.salesOverview = { load, hide, render };
})();
