/* Named logo library and public appearance. Credentials remain in the existing api() helper. */
(function () {
  'use strict';
  const CACHE = 'soulia_branding_v1';
  const SLOTS = ['splash', 'header', 'tab'];
  const UUID = /^[a-f0-9-]{36}$/i;
  const original = slot => slot === 'tab' ? '/favicon.png' : '/soulia-logo.svg';
  const empty = () => ({ splash: null, header: null, tab: null });
  const state = { public: { selection: empty(), logos: [] }, logos: [], draft: empty(), loaded: false, loading: false,
    dirty: false, busy: false, file: null, uploadName: '', message: '', error: false, lastRefresh: 0 };
  const text = (ar, en) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const url = (id, slot) => `/api/branding/logos/${id}/${slot === 'tab' ? 'icon' : 'image'}`;
  const byId = id => state.logos.find(logo => logo.id === id);
  const admin = () => typeof isAdmin === 'function' && isAdmin();

  function normalize(snapshot) {
    const logos = (Array.isArray(snapshot?.logos) ? snapshot.logos : []).filter(logo => typeof logo?.id === 'string' && UUID.test(logo.id))
      .map(logo => ({ id: logo.id, name: String(logo.name || '').slice(0, 80), width: Number(logo.width) || 0, height: Number(logo.height) || 0, bytes: Number(logo.bytes) || 0 }));
    const selection = empty();
    SLOTS.forEach(slot => { const id = snapshot?.selection?.[slot]; if (logos.some(logo => logo.id === id)) selection[slot] = id; });
    return { logos, selection };
  }

  function applyImages() {
    const groups = { splash: '#splash-screen .splash-logo,.lfp-logo', header: '#header .logo img,.shell-brand-home img' };
    Object.entries(groups).forEach(([slot, selector]) => {
      const id = state.public.selection[slot];
      document.querySelectorAll(selector).forEach(img => {
        const src = id ? url(id, slot) : original(slot);
        if (img.dataset.failedBrandUrl === src) return;
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
        img.classList.toggle('soulia-custom-brand', !!id);
        if (!img.dataset.brandFallbackBound) {
          img.dataset.brandFallbackBound = '1';
          img.addEventListener('error', () => {
            if (!img.classList.contains('soulia-custom-brand')) return;
            img.dataset.failedBrandUrl = img.getAttribute('src');
            img.classList.remove('soulia-custom-brand');
            img.src = original(slot);
          });
        }
      });
    });
    const icon = state.public.selection.tab;
    document.querySelectorAll('link[rel="icon"],link[rel="shortcut icon"]').forEach(link => {
      const src = icon ? url(icon, 'tab') : original('tab');
      if (link.getAttribute('href') !== src) link.setAttribute('href', src);
      link.type = 'image/png';
      if (icon) link.setAttribute('sizes', '64x64'); else link.removeAttribute('sizes');
    });
  }

  function apply(snapshot, saveCache = true) {
    state.public = normalize(snapshot);
    if (!state.dirty) state.draft = { ...state.public.selection };
    applyImages();
    if (saveCache) { try { localStorage.setItem(CACHE, JSON.stringify(state.public)); } catch (_) {} }
  }

  async function refresh() {
    state.lastRefresh = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/api/branding', { cache: 'no-store', signal: controller.signal });
      if (response.ok) apply(await response.json());
    } catch (_) { /* Cached logos and the original artwork remain available offline. */ }
    finally { clearTimeout(timer); }
  }

  function feedback(message, error = false) {
    state.message = message; state.error = error;
    const host = document.getElementById('brand-feedback');
    if (host) { host.textContent = message; host.dataset.error = String(error); }
  }

  function preview(slot) {
    const img = document.getElementById('brand-preview-' + slot);
    if (!img) return;
    const id = state.draft[slot];
    img.src = id ? url(id, slot) : original(slot);
    img.classList.toggle('brand-preview-original', !id);
    img.alt = byId(id)?.name || text('الشعار الأصلي', 'Original logo');
  }

  function panel() {
    const host = document.getElementById('stg-branding-card');
    if (!host) return;
    host.hidden = !admin();
    if (!admin()) return;
    const titles = { splash: text('شاشة البداية', 'Startup screen'), header: text('الهيدر', 'Header'), tab: text('أيقونة التبويب', 'Browser tab') };
    const hints = { splash: text('تظهر أيضاً في شاشة تسجيل الدخول.', 'Also used on the sign-in screen.'), header: text('الهيدر والقائمة الجانبية.', 'Header and sidebar.'), tab: text('نسخة مربعة بحجم 64 × 64 بكسل.', 'A square 64 × 64 pixel icon.') };
    const options = `<option value="">${text('الشعار الأصلي', 'Original logo')}</option>` + state.logos.map(logo => `<option value="${logo.id}">${escape(logo.name)}</option>`).join('');
    host.dataset.brandLanguage = text('ar', 'en');
    host.innerHTML = `<div class="stg-card-title"><div class="stg-card-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 8"/></svg></div><div class="stg-card-title-text"><strong>${text('شعارات النظام', 'System logos')}</strong><span>${text('اختر شعاراً لكل موضع واحتفظ بكل الشعارات السابقة في المكتبة.', 'Choose a logo for each location. Previous logos stay in your library.')}</span></div></div>
      <div class="brand-slots">${SLOTS.map(slot => `<div class="brand-slot"><label for="brand-select-${slot}">${titles[slot]}</label><div class="brand-preview brand-preview-${slot}"><img id="brand-preview-${slot}" alt=""></div><select id="brand-select-${slot}" ${!state.loaded || state.busy ? 'disabled' : ''}>${options}</select><small>${hints[slot]}</small></div>`).join('')}</div>
      <div class="brand-selection-actions"><button type="button" id="brand-save-selection" class="btn btn-primary btn-sm" ${!state.dirty || state.busy ? 'disabled' : ''}>${text('حفظ اختيارات الشعارات', 'Save logo choices')}</button><small>${text('لن يُحذف الشعار السابق عند تغييره.', 'Changing a logo keeps the previous image.')}</small></div>
      <form id="brand-upload-form" class="brand-upload-form"><div><h4>${text('رفع شعار جديد', 'Upload a new logo')}</h4><p>${text('PNG، SVG، WebP، JPG · حتى 2 MB · من 16 إلى 4096 بكسل لكل ضلع.', 'PNG, SVG, WebP, JPG · Up to 2 MB · 16–4096 pixels per side.')}</p><p>${text('يفضل شعار واضح بخلفية شفافة. تُحفظ نسخة محسّنة لا تتجاوز 1024 × 1024 دون تشويه الأبعاد.', 'A clear logo with a transparent background works best. An optimized copy is saved within 1024 × 1024 while preserving proportions.')}</p></div><div class="brand-upload-fields"><label for="brand-upload-name">${text('اسم الشعار', 'Logo name')}<input id="brand-upload-name" type="text" maxlength="80" required value="${escape(state.uploadName)}" placeholder="${text('مثال: شعار الصيف', 'Example: Summer logo')}" ${state.busy ? 'disabled' : ''}></label><label for="brand-upload-file">${text('الصورة', 'Image')}<input id="brand-upload-file" type="file" accept=".png,.svg,.webp,.jpg,.jpeg,image/png,image/svg+xml,image/webp,image/jpeg" ${state.busy ? 'disabled' : ''}></label><button class="btn btn-primary btn-sm" type="submit" ${state.busy || !state.loaded ? 'disabled' : ''}>${text('رفع وحفظ بالمكتبة', 'Upload to library')}</button></div><small id="brand-file-name">${escape(state.file?.name || '')}</small></form>
      <div class="brand-library-heading"><h4>${text('مكتبة الشعارات', 'Logo library')} <span>${state.logos.length}</span></h4><button type="button" id="brand-refresh-library" class="btn btn-outline btn-sm" ${state.loading || state.busy ? 'disabled' : ''}>${text('تحديث', 'Refresh')}</button></div>
      <div class="brand-library">${state.logos.map(logo => `<article class="brand-library-item"><div class="brand-library-image"><img src="${url(logo.id, 'splash')}" alt="${escape(logo.name)}" loading="lazy"></div><label for="brand-name-${logo.id}">${text('اسم الشعار', 'Logo name')}<input id="brand-name-${logo.id}" value="${escape(logo.name)}" maxlength="80" ${state.busy ? 'disabled' : ''}></label><div class="brand-library-meta"><small dir="ltr">${logo.width} × ${logo.height} · ${Math.ceil(logo.bytes / 1024)} KB</small><button type="button" class="btn btn-outline btn-sm" data-brand-rename="${logo.id}" ${state.busy ? 'disabled' : ''}>${text('حفظ الاسم', 'Save name')}</button></div></article>`).join('') || `<p class="brand-library-empty">${state.loading ? text('جارٍ تحميل المكتبة…', 'Loading the library…') : text('لا توجد شعارات مرفوعة بعد. الشعار الأصلي متاح دائماً.', 'No uploaded logos yet. The original logo is always available.')}</p>`}</div>
      <p id="brand-feedback" role="status" data-error="${state.error}">${escape(state.message)}</p>`;
    SLOTS.forEach(slot => {
      const select = document.getElementById('brand-select-' + slot);
      select.value = state.draft[slot] || '';
      preview(slot);
      select.addEventListener('change', () => { state.draft[slot] = select.value || null; state.dirty = true; preview(slot); document.getElementById('brand-save-selection').disabled = false; feedback(text('تغييرات غير محفوظة؛ اضغط حفظ الاختيارات لتطبيقها.', 'Unsaved changes. Save your logo choices to apply them.')); });
    });
    document.getElementById('brand-upload-name').addEventListener('input', event => { state.uploadName = event.target.value; });
    document.getElementById('brand-upload-file').addEventListener('change', event => { state.file = event.target.files?.[0] || null; document.getElementById('brand-file-name').textContent = state.file?.name || ''; });
    document.getElementById('brand-upload-form').addEventListener('submit', upload);
    document.getElementById('brand-save-selection').addEventListener('click', saveSelection);
    document.getElementById('brand-refresh-library').addEventListener('click', loadLibrary);
    host.querySelectorAll('[data-brand-rename]').forEach(button => button.addEventListener('click', () => rename(button.dataset.brandRename)));
  }

  async function loadLibrary() {
    if (!admin() || state.loading || state.busy) return;
    state.loading = true; state.message = ''; state.error = false; panel();
    try {
      const result = normalize(await api('/branding/library'));
      state.logos = result.logos; state.loaded = true;
      if (!state.dirty) state.draft = { ...result.selection };
    } catch (error) { feedback(error.message || text('تعذّر تحميل المكتبة.', 'Unable to load the library.'), true); }
    finally { state.loading = false; panel(); }
  }

  async function upload(event) {
    event.preventDefault();
    if (!admin() || state.busy) return;
    const name = state.uploadName.trim();
    if (!name || !state.file) return feedback(text('اكتب اسم الشعار واختر صورته.', 'Enter a logo name and choose its image.'), true);
    if (state.file.size > 2 * 1024 * 1024 || !/\.(png|svg|webp|jpe?g)$/i.test(state.file.name)) return feedback(text('اختر PNG أو SVG أو WebP أو JPG بحجم لا يزيد عن 2 MB.', 'Choose PNG, SVG, WebP or JPG up to 2 MB.'), true);
    const data = new FormData(); data.append('name', name); data.append('file', state.file);
    state.busy = true; panel();
    try {
      const result = await api('/branding/logos', { method: 'POST', body: data });
      const logo = normalize({ logos: [result] }).logos[0];
      if (!logo) throw new Error(text('تعذّر حفظ الشعار.', 'Unable to save the logo.'));
      state.logos.unshift(logo); state.file = null; state.uploadName = '';
      feedback(text('حُفظ الشعار في المكتبة. اختر موضعه ثم احفظ الاختيارات.', 'Logo saved to the library. Choose where to use it, then save your choices.'));
    } catch (error) { feedback(error.message || text('تعذّر رفع الصورة.', 'Unable to upload the image.'), true); }
    finally { state.busy = false; panel(); }
  }

  async function saveSelection() {
    if (!admin() || state.busy || !state.dirty) return;
    state.busy = true; panel();
    try {
      const result = await api('/branding/selection', { method: 'PUT', body: JSON.stringify(state.draft) });
      state.dirty = false; apply(result);
      feedback(text('تم حفظ الشعارات وتطبيقها.', 'Logos saved and applied.'));
    } catch (error) { feedback(error.message || text('تعذّر حفظ الاختيارات.', 'Unable to save logo choices.'), true); }
    finally { state.busy = false; panel(); }
  }

  async function rename(id) {
    if (!admin() || state.busy) return;
    const name = document.getElementById('brand-name-' + id)?.value.trim();
    if (!name) return feedback(text('اسم الشعار مطلوب.', 'A logo name is required.'), true);
    state.busy = true; panel();
    try {
      const logo = await api('/branding/logos/' + id, { method: 'PATCH', body: JSON.stringify({ name }) });
      const existing = byId(id); if (existing) existing.name = String(logo.name).slice(0, 80);
      feedback(text('تم حفظ اسم الشعار.', 'Logo name saved.'));
    } catch (error) { feedback(error.message, true); }
    finally { state.busy = false; panel(); }
  }

  function renderSettings() {
    const host = document.getElementById('stg-branding-card');
    if (!host) return;
    host.hidden = !admin();
    if (!admin()) return;
    if (!host.children.length || host.dataset.brandLanguage !== text('ar', 'en')) panel();
    if (!state.loaded && !state.loading) loadLibrary();
  }

  window.SouliaBranding = { apply, refresh, renderSettings };
  try { const cached = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (cached) apply(cached, false); } catch (_) {}
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; applyImages(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', applyImages);
  window.addEventListener('storage', event => { if (event.key === CACHE && event.newValue) { try { apply(JSON.parse(event.newValue), false); } catch (_) {} } });
  window.addEventListener('focus', () => { if (Date.now() - state.lastRefresh > 30000) refresh(); });
  refresh();
})();
