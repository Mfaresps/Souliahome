/* DesignMe date-range-picker HTML component, adapted from the MIT-licensed
   installed source for application state. Calendar build, range preview,
   keyboard movement and preset selection retain the DesignMe implementation. */
(function () {
  'use strict';
  const instances = new Map();
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
  const parse = s => /^\d{4}-\d\d-\d\d$/.test(s || '') ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : null;
  const key = d => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const day = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const safe = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const lang = () => document.documentElement.lang === 'en' ? 'en' : 'ar';
  const labels = () => lang() === 'ar' ? { from:'من', to:'إلى', clear:'مسح', apply:'تطبيق', applied:'تم التطبيق', pickStart:'اختر تاريخ البداية', pickEnd:'اختر تاريخ النهاية', anyStart:'بدون بداية', anyEnd:'بدون نهاية', day:'يوم', days:'أيام', range:'فترة التاريخ', open:'تصفية بالتاريخ', previous:'الشهر السابق', next:'الشهر التالي', today:'اليوم', yesterday:'أمس', last3:'آخر 3 أيام', last7:'آخر 7 أيام', last30:'آخر 30 يومًا', quarter:'هذا الربع', quarters:'الأرباع', back:'رجوع', thisMonth:'هذا الشهر', lastMonth:'الشهر الماضي', last90:'آخر 90 يومًا' } : { from:'From', to:'To', clear:'Clear', apply:'Apply', applied:'Applied', pickStart:'Pick a start date', pickEnd:'Pick an end date', anyStart:'Any start', anyEnd:'Any end', day:'day', days:'days', range:'Date range', open:'Filter by date', previous:'Previous month', next:'Next month', today:'Today', yesterday:'Yesterday', last3:'Last 3 days', last7:'Last 7 days', last30:'Last 30 days', quarter:'This quarter', quarters:'Quarters', back:'Back', thisMonth:'This month', lastMonth:'Last month', last90:'Last 90 days' };
  const presets = {
    today:t => [t,t], yesterday:t => [day(t,-1),day(t,-1)], last3:t => [day(t,-2),t], last7:t => [day(t,-6),t], last30:t => [day(t,-29),t], last90:t => [day(t,-89),t],
    quarter:t => [new Date(t.getFullYear(), Math.floor(t.getMonth()/3)*3,1),t], thisMonth:t => [new Date(t.getFullYear(),t.getMonth(),1),t], lastMonth:t => [new Date(t.getFullYear(),t.getMonth()-1,1),new Date(t.getFullYear(),t.getMonth(),0)]
  };
  function mount(root, options) {
    const q = s => root.querySelector(s), qa = s => [...root.querySelectorAll(s)];
    const today = () => { const value = options.today ? options.today() : new Date(); const n = typeof value === 'string' ? parse(value) : value; return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
    const maxDate = () => { const current = iso(today()); return options.max && options.max < current ? options.max : current; };
    const allowed = d => !!d && iso(d) <= maxDate();
    let A = null, B = null, hover = null, cursor = null, base = null, appliedTimer;
    const l = labels(), locale = lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
    const ids = options.presets || ['last7','last30','quarter'];
    const completedQuarters = Array.from({length:4}, (_,i) => {
      const t=today(), start=new Date(t.getFullYear(),Math.floor(t.getMonth()/3)*3-(i+1)*3,1);
      return {from:iso(start),to:iso(new Date(start.getFullYear(),start.getMonth()+3,0)),label:`Q${Math.floor(start.getMonth()/3)+1} ${start.getFullYear()}`};
    });
    root.classList.add('soulia-drx');
    root.classList.remove('drx-quarter-enter','drx-calendar-enter');
    root.dir = document.documentElement.dir || 'rtl';
    root.innerHTML = `<div class="drx panel"><div class="drx-side">${ids.map(id => `<button type="button" class="drx-p" data-p="${safe(id)}">${safe(l[id] || id)}</button>`).join('')}</div><div class="drx-main"><div class="drx-top"><div class="drx-in"><span class="muted">${l.from}</span><b class="drx-a">—</b></div><span class="drx-direction" aria-hidden="true">${lang()==='ar'?'←':'→'}</span><div class="drx-in"><span class="muted">${l.to}</span><b class="drx-b">—</b></div><span class="drx-n muted"></span></div><div class="drx-nav"><button type="button" class="drx-prev" aria-label="${l.previous}">‹</button><button type="button" class="drx-next" aria-label="${l.next}">›</button></div><div class="drx-cals"><div class="drx-cal" data-o="0"></div><div class="drx-cal" data-o="1"></div></div><div class="drx-f">${options.allowPartial?`<button type="button" class="drx-open-start">${l.anyStart}</button><button type="button" class="drx-open-end">${l.anyEnd}</button>`:''}<button type="button" class="drx-clr">${l.clear}</button><button type="button" class="drx-ok" disabled>${l.apply}</button></div></div></div>`;
    q('.drx-side').insertAdjacentHTML('beforeend',`<button type="button" class="drx-quarter-open" aria-label="${l.quarters}" aria-expanded="false">${l.quarters}<span aria-hidden="true">${lang()==='ar'?'←':'→'}</span></button>`);
    root.insertAdjacentHTML('beforeend',`<div class="drx-quarter-screen" hidden><div class="drx-quarter-head"><button type="button" class="drx-quarter-back" aria-label="${l.back}">${lang()==='ar'?'→':'←'}</button><strong>${l.quarters}</strong></div><div class="drx-quarter-list">${completedQuarters.map(({from,to,label})=>`<button type="button" class="drx-quarter-item" data-from="${from}" data-to="${to}" aria-pressed="false"><bdi dir="ltr">${label}</bdi></button>`).join('')}</div></div>`);
    const fmt = d => d ? d.toLocaleDateString(locale, { year:'numeric', month:'short', day:'numeric' }) : '—';
    const visible = d => !!d && (d.getFullYear() === base.getFullYear() && d.getMonth() === base.getMonth() || d.getFullYear() === new Date(base.getFullYear(),base.getMonth()+1,1).getFullYear() && d.getMonth() === new Date(base.getFullYear(),base.getMonth()+1,1).getMonth());
    function build() {
      qa('.drx-cal').forEach(cal => {
        const mo = new Date(base.getFullYear(),base.getMonth() + +cal.dataset.o,1), offset = (mo.getDay() + 6) % 7, count = new Date(mo.getFullYear(),mo.getMonth()+1,0).getDate();
        const weekdays = Array.from({length:7},(_,i) => new Date(2024,0,1+i).toLocaleDateString(locale,{weekday:'narrow'}));
        let h = `<h5>${safe(mo.toLocaleDateString(locale,{month:'long',year:'numeric'}))}</h5><div class="drx-g">${weekdays.map(w => `<span class="w">${safe(w)}</span>`).join('')}`;
        for (let i=0;i<offset;i++) h += '<span class="drx-d e"></span>';
        for (let i=1;i<=count;i++) { const d = new Date(mo.getFullYear(),mo.getMonth(),i); h += `<button type="button" class="drx-d" data-date="${iso(d)}" aria-label="${safe(fmt(d))}"${allowed(d)?'':' disabled'}>${i}</button>`; }
        cal.innerHTML = h + '</div>';
      });
      qa('.drx-d[data-date]').forEach(b => { b.onclick = () => { if (!b.disabled) click(parse(b.dataset.date)); }; b.onmouseenter = () => { if (A && !B && !b.disabled) { hover = parse(b.dataset.date); deco(); } }; });
      deco();
    }
    function deco() {
      const reach = B || hover, ka = A && key(A), kb = B && key(B), kr = reach && key(reach);
      qa('.drx-d[data-date]').forEach(b => { const k = +b.dataset.date.replaceAll('-',''); let cl='drx-d';
        if (A && k === ka) cl += ' a' + (reach && kr > k ? ' ra' : '');
        if (B && k === kb) cl += ' b rb';
        if (A && reach && k > ka && k < kr) cl += B ? ' in' : ' hv';
        if (!B && hover && A && k === kr && k > ka) cl += ' hv';
        b.className = cl; b.setAttribute('aria-pressed',String(!!(A && k===ka || B && k===kb)));
      });
      const days=qa('.drx-d[data-date]'), tab=[cursor,B,A,today()].map(d => d && days.find(b => b.dataset.date===iso(d))).find(Boolean) || days[0];
      days.forEach(b => b.tabIndex = b===tab ? 0 : -1);
      q('.drx-a').textContent=fmt(A); q('.drx-b').textContent=fmt(B);
      q('.drx-in').classList.toggle('on',!A); qa('.drx-in')[1].classList.toggle('on',!!A&&!B);
      const n=A&&B ? Math.round((Date.UTC(B.getFullYear(),B.getMonth(),B.getDate())-Date.UTC(A.getFullYear(),A.getMonth(),A.getDate()))/864e5)+1 : 0;
      q('.drx-n').textContent=n ? `${n} ${n===1?l.day:l.days}` : B?l.anyStart:A?l.pickEnd:l.pickStart;
      q('.drx-ok').disabled=(options.allowPartial?!(A||B):!(A&&B)) || !!(A&&!allowed(A) || B&&!allowed(B));
      qa('.drx-p').forEach(p => { const range=presets[p.dataset.p]?.(today()); p.disabled=!!(range&&!allowed(range[1])); p.classList.toggle('on',!!(range&&A&&B&&iso(A)===iso(range[0])&&iso(B)===iso(range[1]))); p.setAttribute('aria-pressed',String(p.classList.contains('on'))); });
      qa('.drx-quarter-item').forEach(b => { b.disabled=b.dataset.to>maxDate(); const selected=!!(A&&B&&iso(A)===b.dataset.from&&iso(B)===b.dataset.to); b.classList.toggle('on',selected); b.setAttribute('aria-pressed',String(selected)); });
    }
    function set(from,to) { A=parse(from); B=parse(to); hover=cursor=null; const d=B||A||today(); base=new Date(d.getFullYear(),d.getMonth()-(window.innerWidth<=500?0:1),1); build(); }
    function click(d) { if (!allowed(d)) return; if (!A||B||key(d)<key(A)) { A=d; B=null; } else B=d; hover=null; deco(); }
    qa('.drx-p').forEach(p => p.onclick=() => { const range=presets[p.dataset.p]?.(today()); if (!range||!allowed(range[1])) return; A=range[0]; B=range[1]; hover=null; base=new Date(B.getFullYear(),B.getMonth()-(window.innerWidth<=500?0:1),1); build(); });
    const showQuarterScreen = show => {
      q('.drx').hidden=show;
      q('.drx-quarter-screen').hidden=!show;
      root.classList.toggle('drx-quarter-enter',show);
      root.classList.toggle('drx-calendar-enter',!show);
      q('.drx-quarter-open').setAttribute('aria-expanded',String(show));
      options.onLayoutChange?.();
      if (show) q('.drx-quarter-back').focus({preventScroll:true});
    };
    q('.drx-quarter-open').onclick=() => showQuarterScreen(true);
    q('.drx-quarter-back').onclick=() => { showQuarterScreen(false); q('.drx-quarter-open').focus({preventScroll:true}); };
    q('.drx-quarter-screen').onkeydown=e => {
      if (e.key==='Escape') { e.preventDefault(); e.stopPropagation(); q('.drx-quarter-back').click(); return; }
      if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const items=qa('.drx-quarter-item'), at=items.indexOf(document.activeElement);
      const next=e.key==='Home'?0:e.key==='End'?items.length-1:e.key==='ArrowDown'?Math.min(items.length-1,Math.max(0,at+1)):Math.max(0,at-1);
      items[next]?.focus({preventScroll:true});
    };
    qa('.drx-quarter-item').forEach(b => b.onclick=() => { if (b.dataset.to>maxDate()) return; A=parse(b.dataset.from); B=parse(b.dataset.to); hover=cursor=null; base=new Date(B.getFullYear(),B.getMonth()-(window.innerWidth<=500?0:1),1); build(); showQuarterScreen(false); q('.drx-ok').focus({preventScroll:true}); });
    q('.drx-clr').onclick=() => { A=B=hover=null; deco(); options.onClear?.(); };
    if (options.allowPartial) { q('.drx-open-start').onclick=() => { A=null;hover=null;deco(); }; q('.drx-open-end').onclick=() => { B=null;hover=null;deco(); }; }
    q('.drx-ok').onclick=() => { if ((!A&&!B)||(!options.allowPartial&&(!A||!B))||(A&&!allowed(A))||(B&&!allowed(B))) return; options.onApply?.(iso(A),iso(B)); q('.drx-ok').textContent=l.applied; clearTimeout(appliedTimer); appliedTimer=setTimeout(() => { if (root.isConnected) q('.drx-ok').textContent=l.apply; },1200); };
    q('.drx-prev').onclick=() => { base=new Date(base.getFullYear(),base.getMonth()-1,1); build(); };
    q('.drx-next').onclick=() => { base=new Date(base.getFullYear(),base.getMonth()+1,1); build(); };
    q('.drx-cals').onmouseleave=() => { if (hover) { hover=null; deco(); } };
    q('.drx-cals').onkeydown=e => { const b=e.target.closest('.drx-d[data-date]'); if (!b) return; const d=parse(b.dataset.date), wd=(d.getDay()+6)%7;
      const at=n=>day(d,n), mon=(y,m)=>new Date(y,m,Math.min(d.getDate(),new Date(y,m+1,0).getDate()));
      const n={ArrowLeft:at(-1),ArrowRight:at(1),ArrowUp:at(-7),ArrowDown:at(7),Home:at(-wd),End:at(6-wd),PageUp:e.shiftKey?mon(d.getFullYear()-1,d.getMonth()):mon(d.getFullYear(),d.getMonth()-1),PageDown:e.shiftKey?mon(d.getFullYear()+1,d.getMonth()):mon(d.getFullYear(),d.getMonth()+1)}[e.key];
      if (!n) return; e.preventDefault(); e.stopPropagation(); if (!allowed(n)) return; cursor=n; const m0=new Date(n.getFullYear(),n.getMonth(),1), last=new Date(base.getFullYear(),base.getMonth()+(window.innerWidth<=500?0:1),1);
      if (A&&!B&&n>A) hover=n; if (m0<base) {base=m0;build();} else if (m0>last) {base=new Date(m0.getFullYear(),m0.getMonth()-(window.innerWidth<=500?0:1),1);build();} else deco();
      q(`.drx-d[data-date="${iso(n)}"]`)?.focus({preventScroll:true});
    };
    set(options.from||'',options.to||'');
    return { set, destroy:() => clearTimeout(appliedTimer) };
  }
  const calendarIcon='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>';
  let portal=null, active=null;
  function close(refocus=false) {
    if (!active) return;
    const prior=active; active=null;
    portal.hidden=true; prior.api?.destroy();
    prior.anchor.setAttribute('aria-expanded','false');
    if (refocus && prior.anchor.isConnected) prior.anchor.focus({preventScroll:true});
  }
  function position() {
    if (!active) return;
    const rect=active.anchor.getBoundingClientRect(), vw=innerWidth, vh=innerHeight;
    if (!active.anchor.isConnected || rect.bottom<0 || rect.top>vh) { close(); return; }
    const inset=vw<=600?12:32, width=Math.min(690,vw-inset*2);
    portal.style.width=width+'px'; portal.style.maxHeight=Math.max(160,vh-inset*2)+'px';
    const centered=rect.left+(rect.width-width)/2;
    const left=vw<=920?(vw-width)/2:Math.max(inset,Math.min(vw-width-inset,centered));
    const height=portal.offsetHeight;
    const top=rect.bottom+8+height<=vh-inset ? rect.bottom+8 : rect.top-height-8>=inset ? rect.top-height-8 : Math.max(inset,Math.min(vh-height-inset,rect.bottom+8));
    portal.style.left=Math.round(left)+'px'; portal.style.top=Math.round(top)+'px';
  }
  function open(anchor,opts={}) {
    if (!anchor) return false;
    if (active?.anchor===anchor) { close(true); return false; }
    close();
    if (!portal) {
      portal=document.createElement('div'); portal.id='soulia-range-popover'; portal.className='soulia-range-popover';
      portal.setAttribute('role','dialog'); document.body.appendChild(portal);
    }
    portal.hidden=false; portal.style.visibility='hidden'; portal.setAttribute('aria-label',labels().range);
    active={anchor,api:null}; anchor.setAttribute('aria-expanded','true'); anchor.setAttribute('aria-controls',portal.id);
    active.api=mount(portal,{from:opts.from||'',to:opts.to||'',presets:opts.presets,today:opts.today,max:opts.max,
      allowPartial:opts.allowPartial!==false,onLayoutChange:position,
      onApply:(from,to)=>{opts.onApply?.(from,to);close(true);},
      onClear:()=>{opts.onClear?.();close(true);}});
    opts.onOpen?.(portal);
    position(); portal.style.visibility='visible';
    return true;
  }
  document.addEventListener('pointerdown',e=> { if (active && !portal.contains(e.target) && !active.anchor.contains(e.target)) close(); },true);
  document.addEventListener('keydown',e=> { if (active && e.key==='Escape') { e.preventDefault(); close(true); } });
  window.addEventListener('resize',position); window.addEventListener('scroll',position,true);
  function attach(fromSelector,toSelector,opts={}) {
    const from=document.querySelector(fromSelector),to=document.querySelector(toSelector);
    if (!from||!to||instances.has(from)) return false;
    const external=typeof opts.trigger==='string'?document.querySelector(opts.trigger):opts.trigger;
    if (opts.trigger && !external) return false;
    const box=external?null:document.createElement('span');
    if (box) box.className='soulia-range-control';
    const trigger=external||document.createElement('button');
    if (!external) { trigger.type='button'; trigger.className='soulia-range-trigger'; trigger.innerHTML=calendarIcon; trigger.setAttribute('aria-haspopup','dialog'); }
    else { trigger.classList.add('soulia-range-external'); trigger.setAttribute('aria-haspopup','dialog'); }
    let anchor=opts.anchor;
    if (!anchor && from.parentElement===to.parentElement && from.parentElement.querySelectorAll('input,select,button').length===2) anchor=from.parentElement;
    if (!anchor) { const a=from.closest('label'),b=to.closest('label'); if (a&&b&&a!==b&&a.parentElement===b.parentElement) { anchor=a; b.classList.add('soulia-range-replaced'); } }
    if (!anchor) { const a=from.parentElement,b=to.parentElement; if (a&&b&&a!==b&&a.tagName==='DIV'&&b.tagName==='DIV'&&a.parentElement===b.parentElement&&a.querySelectorAll('input,select,button').length===1&&b.querySelectorAll('input,select,button').length===1) { anchor=a; b.classList.add('soulia-range-replaced'); } }
    if (box) { box.appendChild(trigger); (anchor||from).before(box); }
    if (anchor) anchor.classList.add('soulia-range-replaced');
    const hidden=[from,to]; hidden.forEach(el=>el.classList.add('soulia-range-source'));
    function update() { const a=from.value,b=to.value; const label=labels().open+(a||b?`: ${a||'…'} — ${b||'…'}`:''); trigger.title=label; trigger.setAttribute('aria-label',label); trigger.classList.toggle('is-set',!!(a||b)); }
    function commit(a,b) { from.value=a; to.value=b; hidden.forEach(el=>el.classList.toggle('has-value',!!el.value)); if (opts.onCommit) opts.onCommit(a,b); else to.dispatchEvent(new Event('change',{bubbles:true})); update(); opts.afterCommit?.(); }
    trigger.onclick=() => { opts.beforeOpen?.(); update(); open(trigger,{from:from.value,to:to.value,presets:opts.presets,today:opts.today,max:opts.max||to.max||from.max,allowPartial:opts.allowPartial,onOpen:opts.onOpen,onApply:commit,onClear:()=>opts.onClear?opts.onClear():commit('','')}); };
    from.addEventListener('change',update); to.addEventListener('change',update);
    update(); instances.set(from,{update}); return true;
  }
  window.SouliaDateRange={attach,mount,open,close,presets,iso,parse,refresh:() => { instances.forEach((x,k)=> { if (!k.isConnected) instances.delete(k); else x.update(); }); }};
})();
