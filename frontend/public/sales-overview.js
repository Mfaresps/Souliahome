/* SPDX-License-Identifier: MIT */
/* Fast monthly sales overview. The browser receives daily buckets, never order records. */
(() => {
  'use strict';
  const host = () => document.getElementById('dash-sales-overview');
  const q = id => document.getElementById(id);
  const labels = () => currentLang === 'en' ? {
    eyebrow: 'SALES OVERVIEW', note: 'Orders received in the selected month',
    orders: 'Total orders', revenue: 'Total revenue', confirmed: 'Confirmed orders', average: 'Average order value',
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
    orders: 'إجمالي الطلبات', revenue: 'إجمالي المبيعات', confirmed: 'الطلبات المؤكدة', average: 'متوسط قيمة الطلب',
    chart: 'الطلبات يومًا بيوم', chartNote: 'كل أيام الشهر · اضغط أو مرّر أو ركّز على النقطة لمعرفة الطلبات والإيراد',
    today: 'اليوم', received: 'طلب', oneOrder: 'طلب', dailyRevenue: 'المبيعات', scroll: 'اسحب لرؤية جميع أيام الشهر',
    timezone: 'الأيام حسب توقيت القاهرة', financial: 'المبيعات بدون الشحن وبعد المرتجعات المعتمدة',
    prev: 'الشهر السابق', next: 'الشهر التالي', previousYear: 'السنة السابقة', nextYear: 'السنة التالية', choose: 'اختر الشهر والسنة',
    error: 'تعذر تحميل ملخص المبيعات.', retry: 'إعادة المحاولة', noData: 'لا توجد طلبات لهذا الشهر بعد',
    compare: 'قارن شهرين', stopCompare: 'إغلاق المقارنة', compareWith: 'مقارنة مع',
    difference: 'الفرق', partial: 'أرقام الشهر الحالي حتى اليوم',
    lineStyle: 'خط', areaStyle: 'مساحة', chartStyle: 'نمط الرسم', showSeries: 'إظهار', hideSeries: 'إخفاء',
  };
  const locale = () => currentLang === 'en' ? 'en-US' : 'ar-EG-u-nu-latn';
  const count = n => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Number(n) || 0);
  const money = n => `EGP ${new Intl.NumberFormat(locale(), { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(n) || 0)}`;
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cairoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const monthName = key => new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T12:00:00Z`));
  const dayName = key => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
  const state = { month: '', compareMonth: '', comparing: false, visible: [true, true], chartStyle: 'line', chartSignature: '', data: null, compareData: null, token: '', error: false, run: 0, cache: new Map(), pending: new Map() };
  let monthPopup = null, pickerYear = 0, pickerTarget = 'primary';
  const pickerTrigger = () => q(pickerTarget === 'compare' ? 'so-compare-trigger' : 'so-month-trigger');
  const previousMonth = key => {
    const [year, month] = key.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 2, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const comparisonDefault = key => previousMonth(key) >= '2000-01' ? previousMonth(key) : '2000-02';

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
    const selected = pickerTarget === 'compare' ? state.compareMonth : state.month;
    monthPopup.dir = currentLang === 'en' ? 'ltr' : 'rtl';
    monthPopup.setAttribute('aria-label', labels().choose);
    monthPopup.innerHTML = `<div class="so-month-head"><button type="button" data-year-step="-1" aria-label="${labels().previousYear}"${pickerYear <= 2000 ? ' disabled' : ''}>‹</button><strong>${pickerYear}</strong><button type="button" data-year-step="1" aria-label="${labels().nextYear}"${pickerYear >= maxYear ? ' disabled' : ''}>›</button></div><div class="so-month-grid">${names.map((name, index) => {
      const key = `${pickerYear}-${String(index + 1).padStart(2, '0')}`;
      return `<button type="button" data-month="${key}" aria-label="${monthName(key)}" aria-pressed="${key === selected}" class="${key === selected ? 'is-selected' : ''}"${key > maxMonth || (pickerTarget === 'compare' && key === state.month) ? ' disabled' : ''}>${escapeHtml(name)}</button>`;
    }).join('')}</div>`;
    positionMonthPicker();
  }
  function toggleMonthPicker(target = 'primary') {
    if (monthPopup && !monthPopup.hidden) {
      if (pickerTarget === target) { closeMonthPicker(true); return; }
      closeMonthPicker();
    }
    pickerTarget = target;
    if (!monthPopup) {
      monthPopup = document.createElement('div');
      monthPopup.className = 'so-month-popover';
      monthPopup.id = 'so-month-popover';
      monthPopup.setAttribute('role', 'dialog');
      document.body.append(monthPopup);
      monthPopup.addEventListener('click', event => {
        const yearButton = event.target.closest('[data-year-step]');
        if (yearButton && !yearButton.disabled) { pickerYear += Number(yearButton.dataset.yearStep); renderMonthPicker(); const next = monthPopup.querySelector(`[data-year-step="${yearButton.dataset.yearStep}"]`); (next?.disabled ? monthPopup.querySelector('.so-month-grid button:not(:disabled)') : next)?.focus({ preventScroll: true }); return; }
        const monthButton = event.target.closest('[data-month]');
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
    } else {
      state.month = key;
      if (state.comparing && state.compareMonth === key) state.compareMonth = comparisonDefault(key);
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
    q('so-note').textContent = state.comparing ? `${monthName(state.month)} / ${monthName(state.compareMonth)}` : l.note;
    q('so-chart-title').textContent = l.chart;
    q('so-chart-note').textContent = l.chartNote;
    q('so-chart-style').setAttribute('aria-label', l.chartStyle);
    q('so-chart-style').querySelectorAll('[data-chart-style]').forEach(button => {
      const style = button.dataset.chartStyle;
      button.textContent = style === 'area' ? l.areaStyle : l.lineStyle;
      button.setAttribute('aria-pressed', String(state.chartStyle === style));
    });
    const partial = [state.month, state.comparing ? state.compareMonth : ''].includes(cairoToday().slice(0, 7));
    q('so-chart-foot').innerHTML = `<span>${l.timezone}</span><span>${l.financial}</span>${partial && state.comparing ? `<span>${l.partial}</span>` : ''}<span class="so-scroll-hint">${l.scroll}</span>`;
    q('so-month').value = state.month;
    q('so-month').setAttribute('aria-label', l.choose);
    q('so-month-label').textContent = monthName(state.month);
    q('so-month-trigger').setAttribute('aria-label', l.choose);
    q('so-month-trigger').title = l.choose;
    q('so-compare-toggle').textContent = state.comparing ? l.stopCompare : l.compare;
    q('so-compare-toggle').setAttribute('aria-pressed', String(state.comparing));
    q('so-compare-trigger').hidden = !state.comparing;
    q('so-compare-trigger').setAttribute('aria-label', `${l.compareWith}: ${state.compareMonth ? monthName(state.compareMonth) : ''}`);
    if (state.compareMonth) q('so-compare-label').textContent = monthName(state.compareMonth);
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
  }
  function showError() {
    const el = q('so-error');
    el.hidden = !state.error;
    if (state.error) el.innerHTML = `${labels().error}<button type="button" id="so-retry">${labels().retry}</button>`;
  }
  function renderMetrics(data, comparison) {
    const l = labels();
    const metrics = [
      [l.orders, 'totalOrders', false],
      [l.revenue, 'totalRevenue', true],
      [l.confirmed, 'confirmedOrders', false],
      [l.average, 'averageOrderValue', true],
    ];
    q('so-metrics').innerHTML = metrics.map(([label, key, currency], index) => {
      const primary = Number(data[key]) || 0;
      const value = currency ? money(primary) : count(primary);
      let detail = '';
      if (comparison) {
        const other = Number(comparison[key]) || 0;
        const delta = primary - other;
        const difference = `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${currency ? money(Math.abs(delta)) : count(Math.abs(delta))}`;
        const percent = other ? ` (${delta > 0 ? '+' : delta < 0 ? '−' : ''}${count(Math.abs(delta / other * 100))}%)` : '';
        const tone = index === 3 ? 'is-neutral' : delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : 'is-neutral';
        detail = `<div class="so-metric-compare"><span>${escapeHtml(monthName(comparison.month))}: ${escapeHtml(currency ? money(other) : count(other))}</span><strong class="so-delta ${tone}" aria-label="${escapeHtml(l.difference)} ${escapeHtml(difference + percent)}">${escapeHtml(difference + percent)}</strong></div>`;
      }
      return `<div class="so-metric"><span class="so-metric-label">${escapeHtml(label)}</span><bdi class="so-metric-value" title="${escapeHtml(value)}">${escapeHtml(value)}</bdi>${detail}</div>`;
    }).join('');
    const today = data.days.find(row => row.date === data.today);
    q('so-today').hidden = !today;
    if (today) q('so-today').textContent = `${l.today}: ${count(today.orders)} ${l.received}`;
    const legend = q('so-legend');
    legend.hidden = !comparison;
    if (comparison) legend.innerHTML = [data, comparison].map((item, index) => {
      const visible = state.visible[index];
      const name = monthName(item.month);
      return `<button type="button" class="so-series-toggle${visible ? '' : ' is-muted'}" data-series-toggle="${index}" aria-pressed="${visible}" aria-label="${escapeHtml(`${visible ? l.hideSeries : l.showSeries} ${name}`)}"><i class="so-legend-mark${index ? ' is-compare' : ''}" aria-hidden="true"></i><span>${escapeHtml(name)}</span></button>`;
    }).join('');
  }
  function niceTop(max) {
    if (max <= 4) return 4;
    const rough = max / 4;
    const power = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 5, 10].find(n => n * power >= rough) * power;
    return step * 4;
  }
  function mountTooltip(canvas) {
    const tip = canvas.querySelector('#so-tip');
    const style = getComputedStyle(canvas);
    for (const name of ['--ds-text', '--ds-surface', '--ds-accent', '--so-compare']) tip.style.setProperty(name, style.getPropertyValue(name));
    document.body.append(tip);
    return tip;
  }
  function placeTooltip(tip, point) {
    const rect = point.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.max(half + 12, Math.min(innerWidth - half - 12, rect.left + rect.width / 2))}px`;
    if (rect.top - tip.offsetHeight - 12 < 12) {
      tip.style.top = `${rect.bottom + 12}px`;
      tip.style.transform = 'translate(-50%, 0)';
    } else {
      tip.style.top = `${rect.top - 12}px`;
      tip.style.transform = 'translate(-50%, -100%)';
    }
  }
  function showGuide(canvas, point) {
    const guide = canvas.querySelector('.so-hover-line');
    if (!guide) return;
    guide.setAttribute('x1', point.getAttribute('cx'));
    guide.setAttribute('x2', point.getAttribute('cx'));
    guide.hidden = false;
  }
  function hideGuide(canvas) { const guide = canvas.querySelector('.so-hover-line'); if (guide) guide.hidden = true; }
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
    svg.addEventListener('pointerleave', () => { hoveredDay = -1; hideTip(); });
  }
  function renderChart(data, animate) {
    const canvas = q('so-chart-canvas');
    const rows = Array.isArray(data.days) ? data.days : [];
    if (!rows.length) { canvas.textContent = labels().noData; return; }
    const today = cairoToday();
    const lastVisible = data.month === today.slice(0, 7) ? today : data.month > today.slice(0, 7) ? '' : '9999-12-31';
    const plotted = rows.map(row => row.date <= lastVisible ? Number(row.orders) || 0 : null);
    const width = Math.max(canvas.clientWidth || 700, 700), height = canvas.clientHeight || 330;
    const left = 48, right = 16, top = 25, bottom = 37;
    const chartW = width - left - right, chartH = height - top - bottom, base = top + chartH;
    const max = niceTop(Math.max(0, ...plotted.filter(n => n !== null)));
    const x = i => left + i * chartW / Math.max(1, rows.length - 1);
    const y = n => top + (1 - n / max) * chartH;
    const visible = plotted.map((n, i) => n === null ? null : { x: x(i), y: y(n), i }).filter(Boolean);
    let path = visible.length ? `M ${visible[0].x} ${visible[0].y}` : '';
    for (let i = 1; i < visible.length; i++) {
      const a = visible[i - 1], b = visible[i], mid = (a.x + b.x) / 2;
      path += ` C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`;
    }
    const area = visible.length ? `${path} L ${visible[visible.length - 1].x} ${base} L ${visible[0].x} ${base} Z` : '';
    const grids = Array.from({ length: 5 }, (_, i) => {
      const value = max - i * max / 4, lineY = y(value);
      return `<line class="so-grid-line" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"/><text class="so-axis-label" x="${left - 9}" y="${lineY + 4}" text-anchor="end">${escapeHtml(count(value))}</text>`;
    }).join('');
    const ticks = rows.map((row, i) => (i === 0 || i === rows.length - 1 || (i + 1) % 5 === 0)
      ? `<text class="so-axis-label" x="${x(i)}" y="${height - 10}" text-anchor="middle">${i + 1}</text>` : '').join('');
    const todayIndex = rows.findIndex(row => row.date === data.today);
    const todayLine = todayIndex >= 0 ? `<line class="so-today-line" x1="${x(todayIndex)}" y1="${top}" x2="${x(todayIndex)}" y2="${base}"/>` : '';
    const points = visible.map(p => {
      const row = rows[p.i];
      const label = `${dayName(row.date)}: ${count(row.orders)} ${labels().received}, ${labels().dailyRevenue} ${money(row.revenue)}`;
      return `<circle class="so-point${row.date === data.today ? ' is-today' : ''}" data-day="${p.i}" cx="${p.x}" cy="${p.y}" r="4" tabindex="0" role="button" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title></circle>`;
    }).join('');
    q('so-tip')?.remove();
    canvas.innerHTML = `<svg class="so-chart-svg${animate ? ' is-animating' : ''}" viewBox="0 0 ${width} ${height}" aria-label="${escapeHtml(labels().chart)}" role="img">${grids}${ticks}<line class="so-hover-line" y1="${top}" y2="${base}" hidden/><g class="so-series" data-series="0">${todayLine}${state.chartStyle === 'area' && area ? `<path class="so-area" d="${area}"/>` : ''}${path ? `<path class="so-line" d="${path}"/>` : ''}${points}</g></svg><div class="so-tip" id="so-tip" role="tooltip" hidden></div>`;
    if (!visible.length) {
      const empty = document.createElement('div'); empty.className = 'so-chart-empty'; empty.textContent = labels().noData;
      canvas.append(empty);
    }
    const tip = mountTooltip(canvas);
    const showTip = point => {
      const i = Number(point.dataset.day), row = rows[i];
      if (!row) return;
      canvas.querySelectorAll('.so-point.is-active').forEach(node => node.classList.remove('is-active'));
      point.classList.add('is-active');
      showGuide(canvas, point);
      tip.innerHTML = `<strong>${escapeHtml(dayName(row.date))}</strong><span>${labels().orders}: ${escapeHtml(count(row.orders))}</span><br><span>${labels().dailyRevenue}: ${escapeHtml(money(row.revenue))}</span>`;
      tip.style.direction = currentLang === 'en' ? 'ltr' : 'rtl';
      tip.hidden = false;
      placeTooltip(tip, point);
    };
    const hideTip = () => { tip.hidden = true; hideGuide(canvas); canvas.querySelectorAll('.so-point.is-active').forEach(node => node.classList.remove('is-active')); };
    canvas.querySelectorAll('.so-point').forEach(point => {
      point.addEventListener('pointerenter', () => showTip(point));
      point.addEventListener('focus', () => showTip(point));
      point.addEventListener('blur', hideTip);
      point.addEventListener('click', () => showTip(point));
    });
    bindPlotHover(canvas.querySelector('svg'), { width, left, top, base, dayCount: rows.length,
      pointFor: day => canvas.querySelector(`.so-point[data-day="${day}"]`), showTip, hideTip });
  }
  function renderComparisonChart(primary, comparison, animate) {
    const canvas = q('so-chart-canvas');
    const today = cairoToday();
    const series = [primary, comparison].map(data => {
      const end = data.month === today.slice(0, 7) ? today : '9999-12-31';
      return data.days.map(row => row.date <= end ? row : null);
    });
    const dayCount = Math.max(primary.days.length, comparison.days.length);
    const width = Math.max(canvas.clientWidth || 700, 700), height = canvas.clientHeight || 330;
    const left = 48, right = 16, top = 25, bottom = 37;
    const chartW = width - left - right, chartH = height - top - bottom, base = top + chartH;
    const max = niceTop(Math.max(0, ...series.flatMap((rows, index) => state.visible[index] ? rows : []).filter(Boolean).map(row => Number(row.orders) || 0)));
    const x = index => left + index * chartW / Math.max(1, dayCount - 1);
    const y = orders => top + (1 - (Number(orders) || 0) / max) * chartH;
    const pathFor = rows => {
      const points = rows.map((row, index) => row ? { x: x(index), y: y(row.orders) } : null).filter(Boolean);
      let path = points.length ? `M ${points[0].x} ${points[0].y}` : '';
      for (let index = 1; index < points.length; index++) {
        const before = points[index - 1], after = points[index], middle = (before.x + after.x) / 2;
        path += ` C ${middle} ${before.y}, ${middle} ${after.y}, ${after.x} ${after.y}`;
      }
      return { path, points };
    };
    const [first, second] = series.map(pathFor);
    const grids = Array.from({ length: 5 }, (_, index) => {
      const value = max - index * max / 4, lineY = y(value);
      return `<line class="so-grid-line" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"/><text class="so-axis-label" x="${left - 9}" y="${lineY + 4}" text-anchor="end">${escapeHtml(count(value))}</text>`;
    }).join('');
    const ticks = Array.from({ length: dayCount }, (_, index) => (index === 0 || index === dayCount - 1 || (index + 1) % 5 === 0)
      ? `<text class="so-axis-label" x="${x(index)}" y="${height - 10}" text-anchor="middle">${index + 1}</text>` : '').join('');
    const todayIndex = primary.days.findIndex(row => row.date === primary.today);
    const todayLine = todayIndex >= 0 ? `<line class="so-today-line" x1="${x(todayIndex)}" y1="${top}" x2="${x(todayIndex)}" y2="${base}"/>` : '';
    const area = first.points.length ? `${first.path} L ${first.points.at(-1).x} ${base} L ${first.points[0].x} ${base} Z` : '';
    const points = series.map((rows, seriesIndex) => rows.map((row, index) => {
      if (!row) return '';
      const label = `${dayName(row.date)}: ${count(row.orders)} ${labels().received}, ${labels().dailyRevenue} ${money(row.revenue)}`;
      return `<circle class="so-point${seriesIndex ? ' is-compare' : ''}${row.date === primary.today ? ' is-today' : ''}" data-series="${seriesIndex}" data-day="${index}" cx="${x(index)}" cy="${y(row.orders)}" r="4" tabindex="0" role="button" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title></circle>`;
    }).join(''));
    q('so-tip')?.remove();
    canvas.innerHTML = `<svg class="so-chart-svg${animate ? ' is-animating' : ''}" viewBox="0 0 ${width} ${height}" aria-label="${escapeHtml(labels().chart)}: ${escapeHtml(monthName(primary.month))}, ${escapeHtml(monthName(comparison.month))}" role="img">${grids}${ticks}<line class="so-hover-line" y1="${top}" y2="${base}" hidden/><g class="so-series" data-series="0"${state.visible[0] ? '' : ' hidden'}>${todayLine}${state.chartStyle === 'area' && area ? `<path class="so-area" d="${area}"/>` : ''}${first.path ? `<path class="so-line" d="${first.path}"/>` : ''}${points[0]}</g><g class="so-series is-compare" data-series="1"${state.visible[1] ? '' : ' hidden'}>${second.path ? `<path class="so-line is-compare" d="${second.path}"/>` : ''}${points[1]}</g></svg><div class="so-tip" id="so-tip" role="tooltip" hidden></div>`;
    const tip = mountTooltip(canvas);
    const showTip = point => {
      const index = Number(point.dataset.day), activeRow = series[Number(point.dataset.series)][index];
      if (!activeRow) return;
      canvas.querySelectorAll('.so-point.is-active').forEach(node => node.classList.remove('is-active'));
      point.classList.add('is-active');
      showGuide(canvas, point);
      const lines = [primary, comparison].map((data, seriesIndex) => {
        if (!state.visible[seriesIndex]) return '';
        const row = series[seriesIndex][index];
        return `<span class="so-tip-series${seriesIndex ? ' is-compare' : ''}">${escapeHtml(monthName(data.month))}: ${row ? `${escapeHtml(count(row.orders))} ${row.orders === 1 ? labels().oneOrder : labels().received} · ${escapeHtml(money(row.revenue))}` : '—'}</span>`;
      });
      const firstRow = series[0][index], secondRow = series[1][index];
      const delta = state.visible.every(Boolean) && firstRow && secondRow ? `<span class="so-tip-difference">${labels().difference}: ${escapeHtml((firstRow.orders - secondRow.orders > 0 ? '+' : '') + count(firstRow.orders - secondRow.orders))} ${labels().received} · ${escapeHtml(money(firstRow.revenue - secondRow.revenue))}</span>` : '';
      tip.innerHTML = `<strong>${escapeHtml(String(index + 1))}</strong>${lines.join('')}${delta}`;
      tip.style.direction = currentLang === 'en' ? 'ltr' : 'rtl';
      tip.hidden = false;
      placeTooltip(tip, point);
    };
    const hideTip = () => { tip.hidden = true; hideGuide(canvas); canvas.querySelectorAll('.so-point.is-active').forEach(node => node.classList.remove('is-active')); };
    canvas.querySelectorAll('.so-point').forEach(point => {
      point.addEventListener('pointerenter', () => showTip(point));
      point.addEventListener('focus', () => showTip(point));
      point.addEventListener('blur', hideTip);
      point.addEventListener('click', () => showTip(point));
    });
    bindPlotHover(canvas.querySelector('svg'), { width, left, top, base, dayCount,
      pointFor: day => canvas.querySelector(`.so-series[data-series="${state.visible[0] ? 0 : 1}"] .so-point[data-day="${day}"]`), showTip, hideTip });
  }
  function render() {
    if (!host() || host().hidden || !state.month) return;
    state.lastLang = currentLang;
    staticText(); showError();
    if (!state.data || state.data.month !== state.month) { skeleton(); return; }
    const comparison = state.comparing && state.compareData?.month === state.compareMonth ? state.compareData : null;
    // Cascade Reveal only when the figures replace the skeleton — not on language or comparison redraws.
    const arriving = !!q('so-metrics')?.querySelector('.so-skeleton');
    renderMetrics(state.data, comparison);
    if (arriving) window.souliaCascade?.(q('so-metrics'), { count: '.so-metric-value' });
    const signature = `${state.month}|${comparison ? comparison.month : ''}`;
    const animate = signature !== state.chartSignature;
    state.chartSignature = signature;
    if (comparison) renderComparisonChart(state.data, comparison, animate);
    else renderChart(state.data, animate);
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
      state.data = null; state.compareData = null;
    }
    if (!state.month) setMonth(cairoToday().slice(0, 7));
    if (state.comparing && !state.compareMonth) state.compareMonth = comparisonDefault(state.month);
    host().hidden = false;
    const selected = state.month, compareKey = state.comparing ? state.compareMonth : '';
    const primaryCache = state.cache.get(selected);
    const compareCache = compareKey ? state.cache.get(compareKey) : null;
    const keepPaint = !!(force && primaryCache && state.data?.month === selected
      && (!compareKey || compareCache) && state.lastLang === currentLang
      && q('so-metrics')?.querySelector('.so-metric-value'));
    state.data = keepPaint ? primaryCache.data : force ? null : primaryCache?.data || (state.data?.month === selected ? state.data : null);
    state.compareData = keepPaint ? compareCache?.data || null
      : force ? null : compareCache?.data || (state.compareData?.month === compareKey ? state.compareData : null);
    state.error = false;
    const run = ++state.run;
    host().classList.toggle('is-revalidating', keepPaint);
    host().setAttribute('aria-busy', String(keepPaint));
    if (!keepPaint) render();
    const needsPrimary = force || !primaryCache || Date.now() - primaryCache.at >= 30000;
    const needsCompare = compareKey && (force || !compareCache || Date.now() - compareCache.at >= 30000);
    if (!needsPrimary && !needsCompare) return state.data;
    host().classList.add('is-loading');
    try {
      const [primary, comparison] = await Promise.all([
        fetchMonth(selected, force, token),
        compareKey ? fetchMonth(compareKey, force, token) : Promise.resolve(null),
      ]);
      if (run === state.run && token === state.token && selected === state.month && compareKey === (state.comparing ? state.compareMonth : '')) {
        const unchanged = keepPaint && JSON.stringify(primary) === JSON.stringify(primaryCache.data)
          && (!compareKey || JSON.stringify(comparison) === JSON.stringify(compareCache.data));
        state.data = primary; state.compareData = comparison; state.error = false;
        if (!unchanged) render(); else showError();
        host().classList.remove('is-revalidating');
        host().setAttribute('aria-busy', 'false');
      }
      return primary;
    } catch (error) {
      if (run === state.run) {
        state.data = force ? null : state.cache.get(selected)?.data || state.data;
        state.compareData = force ? null : (compareKey ? state.cache.get(compareKey)?.data || state.compareData : null);
        state.error = true;
        if (keepPaint) showError(); else render();
        host().setAttribute('aria-busy', 'false');
      }
      throw error;
    } finally {
      if (run === state.run) host().classList.remove('is-loading');
    }
  }
  function hide() { closeMonthPicker(); q('so-tip')?.remove(); if (host()) host().hidden = true; state.run++; }
  function toggleComparison() {
    closeMonthPicker();
    state.comparing = !state.comparing;
    state.visible = [true, true];
    if (state.comparing && (!state.compareMonth || state.compareMonth === state.month)) state.compareMonth = comparisonDefault(state.month);
    if (state.comparing) load().catch(() => {});
    else { state.run++; host().classList.remove('is-loading'); render(); }
  }
  document.addEventListener('click', event => {
    const seriesButton = event.target.closest('#so-legend [data-series-toggle]');
    const styleButton = event.target.closest('#so-chart-style [data-chart-style]');
    if (seriesButton) {
      const index = Number(seriesButton.dataset.seriesToggle);
      if (state.visible[index] && !state.visible[1 - index]) return;
      state.visible[index] = !state.visible[index];
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
    clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 100);
  });
  window.addEventListener('scroll', positionMonthPicker, true);
  window.salesOverview = { load, hide, render };
})();
