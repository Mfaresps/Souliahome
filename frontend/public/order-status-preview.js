/* One on-demand illustration for the transaction status under the pointer. */
(function () {
  'use strict';
  const selector = '[data-state-preview]';
  let active, popup, openTimer, closeTimer, observer;
  const packageShape = '<rect width="22" height="20" rx="3" fill="#d8aa70" stroke="#a87640"/><path d="M9 0h5v8l-2.5-1.5L9 8z" fill="#f8e6c7"/><text class="osp-box-brand" x="11" y="15" text-anchor="middle" direction="ltr">soulia</text>';
  const parcel = `<g transform="translate(97 66) scale(1.8)">${packageShape}</g>`;
  const ground = '<path d="M28 110h184" stroke="currentColor" opacity=".14" stroke-width="2" stroke-linecap="round"/>';
  const house = '<path d="M151 58l27-23 28 23v51h-55z" fill="#e2e8de" stroke="#8a9d87" stroke-width="1.5"/><path d="m145 61 33-29 34 29" fill="none" stroke="#708b77" stroke-width="3" stroke-linecap="round"/><rect x="169" y="78" width="18" height="31" rx="2" fill="#9bb6a5"/><circle cx="182" cy="94" r="1.5" fill="#f7f4e5"/><rect x="170" y="56" width="15" height="12" rx="2" fill="#f7faf6"/>';
  const clock = '<circle cx="160" cy="78" r="22" fill="#fff8e8" stroke="#bba071" stroke-width="2"/><path d="M160 78v-13" class="osp-clock-hand" fill="none" stroke="#9c7d48" stroke-width="2.5" stroke-linecap="round"/><path d="m160 78 8 4" fill="none" stroke="#9c7d48" stroke-width="2.5" stroke-linecap="round"/>';
  const check = '<circle cx="159" cy="56" r="20" fill="#56826a"/><path class="osp-check-draw" d="m149 56 7 7 13-14" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
  const clipboard = '<rect x="73" y="29" width="69" height="78" rx="7" fill="#f7f8f6" stroke="#8c9caf" stroke-width="1.5"/><rect x="92" y="23" width="32" height="13" rx="4" fill="#b0c1d3"/><path d="M88 52h34M88 65h27M88 78h34M88 91h20" stroke="#b1c2d0" stroke-width="3" stroke-linecap="round"/>';
  const truck = `<g class="osp-truck"><rect x="62" y="51" width="82" height="46" rx="5" fill="#d7e7eb" stroke="#729aa5" stroke-width="1.5"/><path d="M144 65h25l18 18v14h-43z" fill="#8fb8bb" stroke="#608a91" stroke-width="1.5"/><path d="M151 71h15l10 12h-25z" fill="#eef8f7"/><path d="M76 66h38M76 73h27" stroke="#a5c4cf" stroke-width="3" stroke-linecap="round"/><path d="M60 98h129" stroke="#60818a" stroke-width="3"/><g class="osp-wheel"><circle cx="82" cy="100" r="10" fill="#4d6570"/><circle cx="82" cy="100" r="4" fill="#dae5e8"/><path d="M82 93v3m0 8v3m-7-7h3m8 0h3" stroke="#a3b9bf" stroke-width="1.5"/></g><g class="osp-wheel"><circle cx="168" cy="100" r="10" fill="#4d6570"/><circle cx="168" cy="100" r="4" fill="#dae5e8"/><path d="M168 93v3m0 8v3m-7-7h3m8 0h3" stroke="#a3b9bf" stroke-width="1.5"/></g></g>`;
  const warning = '<g class="osp-alert"><path d="m159 34 22 38a4 4 0 0 1-3 6h-38a4 4 0 0 1-3-6z" fill="#f4d69a" stroke="#bd944e" stroke-width="1.5"/><path d="M159 48v13m0 7v1" stroke="#916821" stroke-width="3" stroke-linecap="round"/></g>';
  const scenes = {
    waiting: `${ground}${clipboard}${clock}`,
    confirmed: `${ground}${clipboard}${check}`,
    transit: `<g class="osp-scenery" fill="none" stroke="#a7c7cf" stroke-width="2" opacity=".65"><path d="M16 40h30m-22 0a8 8 0 0 1 16 0M174 29h40m-29 0a9 9 0 0 1 18 0"/></g><path d="M0 114h240" stroke="#a7bfc5" stroke-width="2"/><path class="osp-road" d="M-48 120h336" stroke="#b4cbd2" stroke-width="2" stroke-dasharray="18 18"/>${truck}<path class="osp-speed" d="M30 70h20M23 81h23M35 92h13" stroke="#83b5bd" stroke-width="2" stroke-linecap="round"/>`,
    pickup: `${ground}<path d="M28 61l29-22 28 22v48H28z" fill="#e0e9e9" stroke="#94adb0"/><path d="M41 109V70h31v39m-31-26h31m-31 9h31" fill="none" stroke="#94adb0"/>${parcel}<path d="M155 42h25v38h-25z" fill="#c1d5d4" stroke="#739b98" stroke-width="1.5"/><path d="M160 50h15v15h-15z" fill="#f2f9f6"/><path class="osp-scan" d="M91 66h51" stroke="#70ac93" stroke-width="3" stroke-linecap="round"/><path d="m160 72 4 4 9-10" fill="none" stroke="#477c63" stroke-width="2"/>`,
    delivery: `${ground}${house}<path d="M35 104h106" stroke="#a4c3b5" stroke-width="2" stroke-dasharray="4 6"/><g class="osp-to-door"><g transform="translate(80 80) scale(1.35)">${packageShape}</g></g><g class="osp-pin"><path d="M104 27a13 13 0 0 0-13 13c0 10 13 22 13 22s13-12 13-22a13 13 0 0 0-13-13" fill="#6c9b88"/><circle cx="104" cy="40" r="5" fill="#f1f8f4"/></g>`,
    delivered: `${ground}<path d="M72 110V50l31-22 30 22v60" fill="#e2ece2" stroke="#a5bba6" stroke-width="1.5"/><path d="M91 109V64h25v45" fill="#bfd5c1"/>${parcel}${check}<g class="osp-confetti" fill="none" stroke-width="3" stroke-linecap="round"><path d="m66 42-3-6m117 53 6 2m-16-67 3-6" stroke="#90b29c"/><path d="m55 72-5 2m83-56 1-6m53 47 5-2" stroke="#d5b880"/></g>`,
    postponed: `${ground}<rect x="66" y="34" width="85" height="70" rx="7" fill="#fcf9ef" stroke="#b7a47f" stroke-width="1.5"/><path d="M66 50h85" stroke="#b7a47f"/><path d="M86 27v13m43-13v13" stroke="#ab9570" stroke-width="4" stroke-linecap="round"/><path d="M81 64h8m11 0h8m-27 13h8m11 0h8m-27 13h8" stroke="#d0c5ad" stroke-width="4" stroke-linecap="round"/>${clock}`,
    attempt: `${ground}${house}<g transform="translate(-29 0)">${parcel}</g>${warning}<path class="osp-knock" d="m201 75 7-4m-6 14h9m-10 9 7 4" fill="none" stroke="#bd944e" stroke-width="2" stroke-linecap="round"/>`,
    failed: `${ground}${parcel}${warning}<path d="M57 100V61m-8 0h16" stroke="#c69c8b" stroke-width="3" stroke-linecap="round"/><path class="osp-stop-route" d="M35 111h39" fill="none" stroke="#c69c8b" stroke-width="2" stroke-dasharray="4 5"/>`,
    returned: `${ground}<path d="M33 57l32-22 32 22v52H33z" fill="#e6e3ed" stroke="#a49ab5" stroke-width="1.5"/><path d="M49 109V70h32v39m-32-25h32m-32 10h32" fill="none" stroke="#a49ab5"/><path class="osp-return-arrow" d="M186 59V44a10 10 0 0 0-10-10h-58m9-8-9 8 9 8" fill="none" stroke="#a293b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><g class="osp-return-parcel"><g transform="translate(146 79) scale(1.4)">${packageShape}</g></g>`,
    cancelled: `${ground}${parcel}<path d="M37 109h43m70 0h52" stroke="#c7aaaa" stroke-width="2" stroke-dasharray="4 6"/><g class="osp-cancel-mark"><circle cx="160" cy="54" r="21" fill="#ead1cc" stroke="#c18e83" stroke-width="1.5"/><path d="m152 46 16 16m0-16-16 16" stroke="#a56559" stroke-width="3" stroke-linecap="round"/></g>`,
    Preparing: `<ellipse cx="159" cy="117" rx="57" ry="4" fill="currentColor" opacity=".08"/>
      <path d="M32 93h69" stroke="#b7c6d6" stroke-width="2" stroke-linecap="round"/>
      <path d="M119 65q43-9 86 0l-6 47q-36 8-74 0z" fill="#b7c9dd" stroke="#839bb7" stroke-width="1.3"/>
      <ellipse cx="162" cy="65" rx="42" ry="5" fill="#69829d"/>
      <g class="osp-prep-scanner"><path d="m25 25 24 10-5 13-24-10z" fill="#657d91" stroke="#4c647a" stroke-width="1.3"/><path d="m24 39-6 15 8 4 9-15" fill="#8da5b8" stroke="#4c647a" stroke-width="1.3"/><path d="m44 37-3 7" stroke="#b8e8d4" stroke-width="3" stroke-linecap="round"/><circle cx="29" cy="32" r="2" fill="#a8d8bd"/></g>
      <g class="osp-prep-transfer">
        <rect x="48" y="53" width="42" height="34" rx="4" fill="#ddba89" stroke="#ae8656" stroke-width="1.4"/>
        <path d="M64 53h10v6l-5-2-5 2z" fill="#f6e4c6"/>
        <text class="osp-box-brand osp-box-brand-prep" x="69" y="66" text-anchor="middle" direction="ltr">soulia</text>
        <rect x="55" y="68" width="26" height="13" rx="2" fill="#fffaf0"/>
        <path d="M59 71v7m3-7v7m3-7v7m4-7v7m2-7v7m4-7v7m3-7v7" stroke="#6f685b" stroke-width="1.2"/>
        <g class="osp-prep-hand">
          <path d="m97 28-16 8q-6 1-10 6l-12 10q-3 3 0 5t6-1l8-6-4 10q-1 4 3 5t6-3l5-9q8-1 11-9l10-5z" fill="#e5b390" stroke="#b98567" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="m77 42-8 7m13-4-7 8" fill="none" stroke="#c28f70" stroke-width="1.1" stroke-linecap="round"/>
          <path d="m96 24 16 5-7 16-13-8z" fill="#91abc4" stroke="#718da9" stroke-width="1.2"/><path d="m96 34 11 5" stroke="#d9e6f2" stroke-width="2"/>
        </g>
      </g>
      <g class="osp-prep-beam"><path d="m44 42 11 30h28z" fill="#8bcab0" opacity=".18"/><path class="osp-prep-laser" d="M54 68h29" stroke="#5baf8c" stroke-width="2" stroke-linecap="round"/></g>
      <path d="M119 66q43 9 86 0l-6 46q-36 8-74 0z" fill="#e0e9f3" stroke="#839bb7" stroke-width="1.3"/>
      <path d="m125 76 5 30 5 3m63-33-4 30-5 3" fill="none" stroke="#c2d1e2" stroke-width="1.2" stroke-linecap="round"/>
      <path class="osp-prep-flap" d="M120 65h84l-7 15q-35 4-70 0z" fill="#c4d4e5" stroke="#839bb7" stroke-width="1.1"/>
      <text class="osp-prep-brand" x="162" y="94" text-anchor="middle" direction="ltr">SOULIA</text>
      <path d="M148 103h28" stroke="#b6c7da" stroke-width="1" stroke-linecap="round"/>
      <g class="osp-prep-done"><circle cx="205" cy="105" r="10" fill="#56826a"/><path d="m200 105 3 3 6-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`,
    Ready: `<path d="M23 110h195" stroke="currentColor" opacity=".12" stroke-width="2" stroke-linecap="round"/>
      <g transform="translate(34 87) scale(1.09)">${packageShape}</g>
      <g transform="translate(39 65)">${packageShape}</g>
      <path d="M83 99h92V48H88a5 5 0 0 0-5 5z" fill="#ede2bf" stroke="#a28f54" stroke-width="1.5"/>
      <path d="M175 65h20l17 19v15h-37z" fill="#c2d4c7" stroke="#6e8b79" stroke-width="1.5"/>
      <path d="M182 71h10l10 12h-20z" fill="#f1f7f5" stroke="#6e8b79"/>
      <path d="M207 90h5M180 88h5" stroke="#6e8b79" stroke-width="2"/>
      <rect x="84" y="56" width="32" height="42" rx="2" fill="#746e59"/>
      <path d="M62 104l23-6" stroke="#a28f54" stroke-width="3" stroke-linecap="round"/>
      <g class="osp-parcel osp-parcel-one" transform="translate(92 75)">${packageShape}</g>
      <g class="osp-parcel osp-parcel-two" transform="translate(92 75)">${packageShape}</g>
      <g class="osp-parcel osp-parcel-three" transform="translate(92 75)">${packageShape}</g>
      <path d="M116 54h55v42h-55z" fill="#ede2bf"/><path d="M126 69h29M126 75h22" stroke="#c5b681" stroke-width="3" stroke-linecap="round"/>
      <path d="M83 99h129" stroke="#6e796d" stroke-width="3"/>
      <g fill="#48534d" stroke="#fff" stroke-width="2"><circle cx="103" cy="103" r="8"/><circle cx="195" cy="103" r="8"/></g>
      <g fill="#c8d0cb"><circle cx="103" cy="103" r="3"/><circle cx="195" cy="103" r="3"/></g>`
  };

  function close() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    observer?.disconnect();
    if (active) {
      if (active.dataset.statePreview !== 'header') active.setAttribute('aria-expanded', 'false');
      active.removeAttribute('aria-describedby');
    }
    popup?.remove();
    popup = active = null;
  }
  function laterClose() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 180);
  }
  function position() {
    if (!active?.isConnected || !active.getClientRects().length) return close();
    const rect = active.getBoundingClientRect(), box = popup.getBoundingClientRect();
    const margin = 10, gap = 10;
    const left = Math.max(margin, Math.min(innerWidth - box.width - margin, rect.left + (rect.width - box.width) / 2));
    const top = rect.top >= box.height + gap + margin ? rect.top - box.height - gap : rect.bottom + gap;
    popup.style.left = `${left}px`;
    popup.style.top = `${Math.max(margin, Math.min(innerHeight - box.height - margin, top))}px`;
  }
  function show(badge) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (active === badge || !badge.isConnected) return;
    close();
    const state = badge.dataset.orderState;
    const scene = badge.dataset.previewScene;
    if (!scenes[scene]) return;
    active = badge;
    const en = !/[\u0600-\u06ff]/.test(badge.dataset.previewLabel);
    popup = document.createElement('div');
    popup.id = 'order-status-preview';
    popup.className = 'order-status-preview';
    popup.dataset.state = state;
    popup.dataset.scene = scene;
    popup.dir = en ? 'ltr' : 'rtl';
    popup.lang = en ? 'en' : 'ar';
    popup.setAttribute('role', 'tooltip');
    popup.innerHTML = `<div class="osp-scene"><svg viewBox="0 0 240 128" aria-hidden="true">${scenes[scene]}</svg></div><div class="osp-copy"><strong></strong><p></p></div>`;
    popup.querySelector('strong').textContent = badge.dataset.previewLabel;
    popup.querySelector('p').textContent = badge.dataset.previewDescription;
    if (badge.dataset.previewNote) {
      const note = document.createElement('p');
      note.className = 'osp-note';
      note.textContent = badge.dataset.previewNote;
      popup.querySelector('.osp-copy').append(note);
    }
    document.body.append(popup);
    if (badge.dataset.statePreview !== 'header') badge.setAttribute('aria-expanded', 'true');
    badge.setAttribute('aria-describedby', popup.id);
    popup.addEventListener('pointerenter', () => clearTimeout(closeTimer));
    popup.addEventListener('pointerleave', laterClose);
    position();
    // Only observe while open, so table redraws cannot leave a stale preview.
    observer = new MutationObserver(() => {
      if (!active?.isConnected || !active.getClientRects().length) close();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const badge = event.target.closest(selector);
    if (!badge || badge.contains(event.relatedTarget)) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (active && active !== badge) close();
    openTimer = setTimeout(() => show(badge), 280);
  });
  document.addEventListener('pointerout', event => {
    const badge = event.target.closest(selector);
    if (badge && !badge.contains(event.relatedTarget)) laterClose();
  });
  document.addEventListener('focusin', event => {
    const badge = event.target.closest(selector);
    if (badge?.matches(':focus-visible')) show(badge);
  });
  document.addEventListener('focusout', event => {
    if (event.target.closest(selector)) laterClose();
  });
  document.addEventListener('click', event => {
    const badge = event.target.closest(selector);
    if (badge) {
      if (badge.dataset.statePreview === 'header') { close(); return; }
      event.preventDefault();
      event.stopPropagation();
      active === badge ? close() : show(badge);
    } else if (!popup?.contains(event.target)) close();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
    const badge = event.target.closest(selector);
    if (badge && ['Enter', ' '].includes(event.key)) {
      if (badge.dataset.statePreview === 'header') {
        if (event.target !== badge) return;
        event.preventDefault();
        close();
        badge.click();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      active === badge ? close() : show(badge);
    }
  }, true);
  document.addEventListener('scroll', close, true);
  document.addEventListener('dragstart', close, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  window.SouliaStatusPreview = {
    attachHeader(header, meta) {
      const detail = window.SouliaOrderStatus.preview(meta);
      if (!detail) return;
      Object.assign(header.dataset, { statePreview: 'header', orderState: meta.key,
        previewScene: detail.scene, previewDescription: meta.description || detail.description,
        previewLabel: meta.label, previewNote: meta.note || '' });
      header.removeAttribute('title');
      const button = header.closest('button');
      if (button) {
        button.addEventListener('focus', () => { if (button.matches(':focus-visible')) show(header); });
        button.addEventListener('blur', laterClose);
      } else {
        header.tabIndex = 0;
        header.setAttribute('role', 'button');
      }
    }
  };
})();
