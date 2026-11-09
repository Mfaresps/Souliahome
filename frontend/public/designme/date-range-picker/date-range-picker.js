DM.def('date-range-picker', (r, c) => {
  r.innerHTML = r.innerHTML.replace('{right}', I('right','xs'));
  const TODAY = new Date(2026, 9, 19); let base = new Date(2026, 8, 1), A = null, B = null, hov = null, cursor = null;
  const cals = $$('.drx-cal', r), ok = $('.drx-ok', r);
  const key = d => d.getFullYear() * 1e4 + d.getMonth() * 100 + d.getDate();
  const fmt = d => d ? d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '–';
  /* From and To crossfade to the days picked, and always end on the latest ones: a pick that lands while the last one
     is still fading in (picking the same end again, two quick clicks, Enter twice) writes its day when the fade does */
  const put = (el, t) => { el._to = t; if (el._t || el.textContent === t) return; el.classList.add('sw', 'out');
    el._t = setTimeout(() => { el._t = 0; el.textContent = el._to; el.classList.remove('out'); }, REDUCE ? 0 : 170); };
  /* the days are built once per month view; selection and hover only change their classes */
  function build(){
    cals.forEach(cal => { const mo = new Date(base.getFullYear(), base.getMonth() + +cal.dataset.o, 1); const pad = (mo.getDay() + 6) % 7, days = new Date(mo.getFullYear(), mo.getMonth() + 1, 0).getDate();
      let h = `<h5>${mo.toLocaleDateString('en-US', { month:'long', year:'numeric' })}</h5><div class="drx-g">${['M','T','W','T','F','S','S'].map(w => `<span class="w">${w}</span>`).join('')}`;
      for (let i = 0; i < pad; i++) h += '<span class="drx-d e"></span>';
      for (let d = 1; d <= days; d++){ const dt = new Date(mo.getFullYear(), mo.getMonth(), d); h += `<button class="drx-d" data-t="${dt.getTime()}" data-k="${key(dt)}">${d}</button>`; }
      cal.innerHTML = h + '</div>'; });
    $$('.drx-d[data-t]', r).forEach(b => { b.onclick = () => click(new Date(+b.dataset.t)); b.onmouseenter = () => { if (A && !B){ hov = new Date(+b.dataset.t); deco(); } }; });
    deco();
  }
  function deco(){
    const end = B || hov, ka = A && key(A), kb = B && key(B), ke = end && key(end);
    $$('.drx-d[data-t]', r).forEach(b => { const k = +b.dataset.k; let cl = 'drx-d';
      if (A && k === ka) cl += ' a' + (end && ke > k ? ' ra' : '');
      if (B && k === kb) cl += ' b rb';
      if (A && end && k > ka && k < ke) cl += B ? ' in' : ' hv';
      if (!B && hov && A && k === ke && k > ka) cl += ' hv';
      if (b.className !== cl) b.className = cl; });
    // one day takes Tab: the one the arrows last reached, or the end, the start, today or the first day on show
    const days = $$('.drx-d[data-t]', r), on = [cursor, B, A, TODAY].map(d => d && days.find(b => +b.dataset.k === key(d))).find(Boolean) || days[0];
    days.forEach(b => { const t = b === on ? '0' : '-1'; if (b.getAttribute('tabindex') !== t) b.setAttribute('tabindex', t); });
    put($('.drx-a', r), fmt(A)); put($('.drx-b', r), fmt(B));
    const ins = $$('.drx-in', r); ins[0].classList.toggle('on', !A); ins[1].classList.toggle('on', !!A && !B);
    const n = A && B ? Math.round((B - A) / 864e5) + 1 : 0;
    $('.drx-n', r).textContent = n ? n + (n === 1 ? ' day' : ' days') : A ? 'Pick an end date' : 'Pick a start date';
    ok.disabled = !(A && B);
  }
  function click(d){ $$('.drx-p', r).forEach(x => x.classList.remove('on')); if (!A || B || d < A){ A = d; B = null; hov = null; } else { B = d; hov = null; } deco(); }
  $$('.drx-p', r).forEach(p => p.onclick = () => { $$('.drx-p', r).forEach(x => x.classList.toggle('on', x === p)); const v = p.dataset.p; B = new Date(TODAY);
    A = new Date(TODAY); if (v === '7') A.setDate(A.getDate() - 6); else if (v === '30') A.setDate(A.getDate() - 29); else if (v === 'q') A = new Date(2026, 9, 1); else A = new Date(2026, 8, 18);
    const nb = new Date(B.getFullYear(), B.getMonth() - 1, 1); hov = null; if (+nb !== +base){ base = nb; build(); } else deco(); stagger($$('.drx-d.in, .drx-d.a, .drx-d.b', r), 8); });
  $('.drx-clr', r).onclick = () => { A = B = hov = null; $$('.drx-p', r).forEach(x => x.classList.remove('on')); deco(); };
  ok.onclick = () => { ok.innerHTML = I('check','xs') + 'Applied'; c.later(1200, () => ok.textContent = 'Apply'); };
  c.on($('.drx-cals', r), 'mouseleave', () => { if (hov){ hov = null; deco(); } });
  // the keyboard in the calendars: the arrows move a day or a week, Home and End go to the start and end of the week, Page Up
  // and Page Down move a month, or a year with Shift, and the months on show follow; Enter or Space picks the day. While the
  // end is open, the range follows the focus as it does the pointer
  c.on($('.drx-cals', r), 'keydown', e => {
    const b = e.target.closest('.drx-d[data-t]'); if (!b) return;
    const d = new Date(+b.dataset.t), wd = (d.getDay() + 6) % 7, at = n => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    const mon = (y, mo) => new Date(y, mo, Math.min(d.getDate(), new Date(y, mo + 1, 0).getDate()));
    const n = { ArrowLeft:at(-1), ArrowRight:at(1), ArrowUp:at(-7), ArrowDown:at(7), Home:at(-wd), End:at(6 - wd),
      PageUp:e.shiftKey ? mon(d.getFullYear() - 1, d.getMonth()) : mon(d.getFullYear(), d.getMonth() - 1),
      PageDown:e.shiftKey ? mon(d.getFullYear() + 1, d.getMonth()) : mon(d.getFullYear(), d.getMonth() + 1) }[e.key];
    if (!n) return; e.preventDefault(); cursor = n;
    const m0 = new Date(n.getFullYear(), n.getMonth(), 1), last = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    if (A && !B && n > A) hov = n;
    if (m0 < base){ base = m0; build(); } else if (m0 > last){ base = new Date(m0.getFullYear(), m0.getMonth() - 1, 1); build(); } else deco();
    const to = $(`.drx-d[data-k="${key(n)}"]`, r); if (to) to.focus({ preventScroll:true });
  });
  build();
  c.later(900, () => $('.drx-p[data-p="sp"]', r).click());
});
