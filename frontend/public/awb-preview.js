/* Read-only label viewer. Printing continues through the existing confirmed print flow. */
let _awbPreviewActive = null;
function closeAwbPreview() {
  const state = _awbPreviewActive;
  if (!state) return;
  _awbPreviewActive = null;
  state.closed = true;
  state.host.remove();
  if (state.url) URL.revokeObjectURL(state.url);
  document.body.style.overflow = state.overflow;
  if (state.focus?.isConnected) state.focus.focus();
}
async function previewBostaAwb(id) {
  if (!_requirePageAccess('pickup-orders')) return;
  const order = _awbOrderCopies(id).find(row => row.bostaOrderId);
  if (!order) return toast(currentLang === 'en' ? 'A shipping label is not available yet.' : 'البوليصة غير متاحة قبل إنشاء الشحنة.', true);
  const focus = _awbPreviewActive?.focus || document.activeElement;
  closeAwbPreview();
  const en = currentLang === 'en';
  const host = document.createElement('div');
  host.id = 'awb-preview'; host.className = 'awb-preview';
  host.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="awb-preview-title" dir="${en ? 'ltr' : 'rtl'}">
    <header><div><h3 id="awb-preview-title">${en ? 'Shipping label preview' : 'معاينة البوليصة'} <bdi>#${esc(order.ref || '—')}</bdi></h3><small>${esc(order.client || '')}${order.bostaTrackingNumber ? ' · ' + esc(order.bostaTrackingNumber) : ''}</small></div>
    <button type="button" class="btn btn-outline" data-awb-close aria-label="${en ? 'Close' : 'إغلاق'}">×</button></header>
    <div class="awb-preview-tools"><label>${en ? 'Zoom' : 'التكبير'} <input type="range" min="70" max="160" value="100" step="10" aria-label="${en ? 'Zoom' : 'التكبير'}"></label>
      <a class="btn btn-outline" data-awb-download hidden>${en ? 'Download PDF' : 'تحميل PDF'}</a>
      <button type="button" class="btn btn-primary" data-awb-print disabled>${en ? 'Print label' : 'طباعة البوليصة'}</button></div>
    <div class="awb-preview-pages" aria-busy="true"><p role="status">${en ? 'Loading shipping label…' : 'جارٍ تحميل البوليصة…'}</p></div>
  </section>`;
  const state = {host, focus, overflow:document.body.style.overflow, closed:false, url:null};
  _awbPreviewActive = state;
  document.body.appendChild(host); document.body.style.overflow = 'hidden';
  host.querySelector('[data-awb-close]').onclick = closeAwbPreview;
  host.onclick = event => { if (event.target === host) closeAwbPreview(); };
  const pages = host.querySelector('.awb-preview-pages');
  host.querySelector('input').oninput = event => pages.style.setProperty('--awb-zoom', Number(event.target.value) / 100);
  host.querySelector('[data-awb-print]').onclick = async event => {
    event.currentTarget.disabled = true;
    closeAwbPreview();
    await printBostaAwb(id);
  };
  host.querySelector('[data-awb-close]').focus();
  let doc;
  try {
    const [bytes, pdfjs] = await Promise.all([_awbFetchBytes(id), _awbLoadPdfJs()]);
    if (state.closed) return;
    state.url = URL.createObjectURL(new Blob([bytes], {type:'application/pdf'}));
    const download = host.querySelector('[data-awb-download]');
    download.href = state.url; download.download = `Bosta-${order.bostaTrackingNumber || order.ref || 'label'}.pdf`; download.hidden = false;
    doc = await pdfjs.getDocument(_awbWorker ? {data:bytes.slice(),worker:_awbWorker} : {data:bytes.slice()}).promise;
    if (state.closed) return;
    pages.replaceChildren();
    for (let n = 1; n <= doc.numPages; n++) {
      if (state.closed) return;
      const page = await doc.getPage(n), viewport = page.getViewport({scale:2});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.setAttribute('role','img'); canvas.setAttribute('aria-label', (en ? 'Label page ' : 'صفحة البوليصة ') + n);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      if (state.closed) return;
      pages.appendChild(canvas);
    }
    host.querySelector('[data-awb-print]').disabled = false;
  } catch (error) {
    if (!state.closed) {
      pages.replaceChildren();
      const message = document.createElement('p'); message.setAttribute('role','alert');
      message.textContent = (en ? 'Could not load the label: ' : 'تعذّر تحميل البوليصة: ') + (error.message || '');
      const retry = document.createElement('button'); retry.className = 'btn btn-outline';
      retry.textContent = en ? 'Retry' : 'إعادة المحاولة'; retry.onclick = () => previewBostaAwb(id);
      pages.append(message,retry);
    }
  } finally {
    pages.setAttribute('aria-busy','false');
    if (doc) await doc.destroy();
  }
}
window.addEventListener('keydown', event => {
  const state = _awbPreviewActive;
  if (!state) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeAwbPreview(); }
  if (event.key === 'Tab') {
    const buttons = [...state.host.querySelectorAll('button:not(:disabled),a[href]:not([hidden]),input')];
    const first = buttons[0], last = buttons[buttons.length-1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}, true);
