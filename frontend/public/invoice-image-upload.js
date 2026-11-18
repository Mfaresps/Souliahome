/* Supplier invoice photos («فواتير المورد»): upload an image to the server, which compresses it
   (≤180 KB, legible) and keeps it on Cloudflare R2 — same rule as deposit receipts. The returned
   URL goes into the row's existing link input, so every save path reads it exactly like a pasted
   link. Used by the new purchase form, the invoice edit window, the PO conversion form and the
   expense form (single attachment, purpose 'expense').
   ⚠ A save must wait for uploads in flight: InvoiceImageUpload.busy(listSelector). */
(function () {
  'use strict';
  const MAX_BYTES = 12 * 1024 * 1024;
  const OURS = '/api/invoice-images/';
  const ar = () => (typeof currentLang === 'undefined' || currentLang !== 'en');
  const tx = (a, e) => (ar() ? a : e);
  const say = (msg, bad) => { if (typeof toast === 'function') toast(msg, bad); };

  /** Phone photos (3–8 MB) shrink to ≤1600 px JPEG before upload; the server compresses again. */
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size < 600 * 1024) { bmp.close && bmp.close(); return file; }
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      return blob && blob.size < file.size ? blob : file;
    } catch (_) { return file; }
  }

  function isOurs(url) { return String(url || '').includes(OURS); }

  /** Writes an uploaded URL into a row: value + attribute (CSS hides the link field for ours). */
  function setUrl(input, url) {
    input.value = url;
    input.setAttribute('value', url);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function rowParts(row) {
    return {
      input: row.querySelector('input[type=url]'),
      preview: row.querySelector('[class$="img-preview"]'),
    };
  }

  /** opts.purpose: 'purchase' (default) | 'expense'. opts.single: the row is a fixed field (the
   *  expense attachment) — a failure restores it instead of removing it, and the card can be cleared. */
  async function uploadOne(file, addRow, opts = {}) {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || '') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '')) {
      say(tx(`«${file.name}» ليس صورة — استخدم JPEG أو PNG أو WebP`, `"${file.name}" is not an image — use JPEG, PNG or WebP`), true);
      return;
    }
    if (file.size > MAX_BYTES) { say(tx('حجم الصورة أكبر من 12 ميجابايت', 'The image is larger than 12 MB'), true); return; }
    const row = addRow('');
    if (!row) return;
    const { input, preview } = rowParts(row);
    const prevValue = input ? input.value : '', prevPreview = preview ? preview.innerHTML : '';
    row.classList.add('inv-up-busy');
    if (input) input.setAttribute('value', OURS + 'pending');
    const local = URL.createObjectURL(file);
    if (preview) {
      preview.innerHTML = `<div class="inv-up-card"><img src="${local}" alt=""><div class="inv-up-meta"><b>${tx('جارٍ رفع الصورة…', 'Uploading photo…')}</b><span class="inv-up-bar"><i style="width:4%"></i></span></div></div>`;
    }
    const bar = preview && preview.querySelector('.inv-up-bar i');
    try {
      const small = await shrink(file);
      const fd = new FormData();
      fd.append('file', small, (file.name || 'invoice').replace(/\.\w+$/, '') + '.jpg');
      if (opts.purpose) fd.append('purpose', opts.purpose);
      const res = await api('/invoice-images', {
        method: 'POST', body: fd,
        onUploadProgress: (f) => { if (bar) bar.style.width = Math.max(4, Math.round(f * 100)) + '%'; },
      });
      if (!res || !res.url) throw new Error(tx('لم يُرجع الخادم رابط الصورة', 'The server returned no image link'));
      const url = location.origin + res.url;
      row.classList.remove('inv-up-busy');
      if (input) setUrl(input, url);
      if (preview) {
        preview.innerHTML = `<div class="inv-up-card is-done"><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${tx('فاتورة المورد', 'Supplier invoice')}"></a>`
          + `<div class="inv-up-meta"><b>${opts.purpose === 'expense' ? tx('صورة المرفق', 'Attachment photo') : tx('صورة الفاتورة', 'Invoice photo')}</b><span>${Math.max(1, Math.round((res.bytes || 0) / 1024))} KB${res.storage === 'r2' ? ' · Cloudflare R2' : ''}</span></div>`
          + (opts.single ? `<button type="button" class="inv-up-clear" title="${tx('إزالة الصورة', 'Remove photo')}" aria-label="${tx('إزالة الصورة', 'Remove photo')}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>` : '')
          + `</div>`;
        const clear = preview.querySelector('.inv-up-clear');
        if (clear && input) clear.addEventListener('click', () => { setUrl(input, ''); input.removeAttribute('value'); preview.innerHTML = ''; });
      }
    } catch (e) {
      if (opts.single) {
        row.classList.remove('inv-up-busy');
        if (input) { input.value = prevValue; if (prevValue) input.setAttribute('value', prevValue); else input.removeAttribute('value'); }
        if (preview) preview.innerHTML = prevPreview;
      } else row.remove();
      say(tx('تعذّر رفع صورة الفاتورة: ', 'Could not upload the invoice photo: ') + (e && e.message ? e.message : ''), true);
    } finally {
      setTimeout(() => URL.revokeObjectURL(local), 4000);
    }
  }

  /** Opens the file picker (several photos at once, the camera on phones). */
  function pick(addRow, opts = {}) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
    input.multiple = !opts.single;
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.remove();
      for (const f of files) await uploadOne(f, addRow, opts);
    });
    document.body.appendChild(input);
    input.click();
  }

  function busy(listSelector) {
    // The container itself is the row for a single attachment (the expense form).
    return !!document.querySelector(`${listSelector}.inv-up-busy, ${listSelector} .inv-up-busy`);
  }

  /** Message for a save attempted while a photo is still uploading. */
  function busyMessage() {
    return tx('انتظر حتى يكتمل رفع صورة الفاتورة', 'Wait until the invoice photo finishes uploading');
  }

  window.InvoiceImageUpload = { pick, busy, busyMessage, isOurs, uploadOne };
})();
