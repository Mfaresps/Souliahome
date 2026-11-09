// Generated from designme.dev by scripts/sync.mjs. Edit the site, then sync.
// @ts-nocheck: the core's own script, as it runs on designme.dev
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
/* ---------- touch: tap areas that never overlap ----------
   On a touch screen every control has a clear tap area of at least 40px square around it (the @media (pointer:coarse) block
   in the CSS, which marks it --dm-hit). Where two controls sit closer than that, their areas shrink towards the gap between
   them, each to half of it, so they meet halfway and a tap always lands on the control nearest to it; next to a field, which
   has no area of its own, a control can take the whole gap. The areas on screen are fitted again, a few times a second at
   most, as the page scrolls, resizes or changes. Nothing runs with a mouse */
const fitHits = window.dmFitHits || (() => {
  const CTRL = 'button,a[href],summary,label,input:not([type="hidden"]),select,textarea,[contenteditable="true"],[role="button"],[role="switch"],[role="checkbox"],[role="radio"],[role="tab"],[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="slider"]';
  const MIN = 40, coarse = matchMedia('(pointer:coarse)'), seen = new WeakMap();
  // whether a control has a tap area (and so can grow), read once per class
  const grows = el => { const k = (el.getAttribute('class') || '') + '|' + (el.getAttribute('role') || ''), s = seen.get(el);
    if (s && s.k === k) return s.v;
    const v = ['::before', '::after'].some(w => getComputedStyle(el, w).getPropertyValue('--dm-hit').trim() === '1'); seen.set(el, { k, v }); return v; };
  function fit(){
    q = 0; last = performance.now(); if (!coarse.matches) return;
    const H = innerHeight, on = [];
    for (const el of document.querySelectorAll(CTRL)){
      const r = el.getBoundingClientRect(); if (!r.width || !r.height || r.bottom < -80 || r.top > H + 80) continue;
      // a control that isn't drawn (in a closed <details>, under visibility:hidden) neither grows nor stands in the way
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty:true })) continue;
      const g = grows(el); on.push({ el, r, g, x:g ? Math.max(0, (MIN - r.width) / 2) : 0, y:g ? Math.max(0, (MIN - r.height) / 2) : 0 });
    }
    for (const a of on){
      if (!a.g) continue;
      let ex = a.x, ey = a.y;
      if (ex || ey) for (const b of on){
        if (b === a || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const gx = Math.max(b.r.left - a.r.right, a.r.left - b.r.right), gy = Math.max(b.r.top - a.r.bottom, a.r.top - b.r.bottom);
        if ((gx < 0 && gy < 0) || gx >= ex + b.x || gy >= ey + b.y) continue;
        const part = (gap, other) => Math.max(0, other ? gap / 2 : gap);
        if (gy < 0 || (gx >= 0 && gx >= gy)) ex = Math.min(ex, part(gx, b.x)); else ey = Math.min(ey, part(gy, b.y));
      }
      const w = ex < a.x ? Math.round(a.r.width + 2 * ex) + 'px' : '', h = ey < a.y ? Math.round(a.r.height + 2 * ey) + 'px' : '';
      if (a.el.style.getPropertyValue('--dm-hit-w') !== w) w ? a.el.style.setProperty('--dm-hit-w', w) : a.el.style.removeProperty('--dm-hit-w');
      if (a.el.style.getPropertyValue('--dm-hit-h') !== h) h ? a.el.style.setProperty('--dm-hit-h', h) : a.el.style.removeProperty('--dm-hit-h');
    }
  }
  let q = 0, last = -1e9, started = false;
  const queue = () => { if (!q) q = setTimeout(() => requestAnimationFrame(fit), Math.max(16, 150 - (performance.now() - last))); };
  const start = () => {
    if (started || !coarse.matches) return; started = true;
    addEventListener('scroll', queue, { passive:true, capture:true }); addEventListener('resize', queue);
    new MutationObserver(queue).observe(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['class', 'hidden', 'open', 'aria-expanded', 'aria-checked', 'aria-pressed', 'aria-selected'] });
    queue();
  };
  start(); if (coarse.addEventListener) coarse.addEventListener('change', start);
  window.dmFitHits = fit; return fit;
})();
}
export {};
