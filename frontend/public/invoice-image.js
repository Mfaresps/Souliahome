/* Compact receipts rendered directly to PNG; no print window or remote renderer. */
async function buildCompactInvoiceCanvas(tx, preview = false) {
  await document.fonts.ready;
  const en = currentLang === 'en';
  const label = (ar, english) => en ? english : ar;
  const money = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value) || 0) + ' EGP';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const width = 720, margin = 38, rows = [];
  const font = (size, bold) => `${bold ? 700 : 400} ${size}px Cairo, Arial, sans-serif`;
  // Measure first, then allocate precisely enough space for wrapped Arabic names.
  function wrap(value, maxWidth, size = 20, bold = false) {
    ctx.font = font(size, bold);
    const lines = [], words = String(value ?? '').split(/\s+/);
    let line = '';
    for (const word of words) {
      if (ctx.measureText(line ? line + ' ' + word : word).width <= maxWidth) {
        line = line ? line + ' ' + word : word;
        continue;
      }
      if (line) { lines.push(line); line = ''; }
      for (const ch of word) {
        if (line && ctx.measureText(line + ch).width > maxWidth) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : ['—'];
  }
  function text(value, size = 20, bold = false, color = '#203c30') {
    const lines = wrap(value, width - margin * 2, size, bold);
    rows.push({ kind: 'text', lines, size, bold, color, height: lines.length * (size + 12) + 8 });
  }
  function pair(key, value, bold = false) {
    const lines = wrap(key, 390, 20, bold);
    rows.push({ kind: 'pair', lines, value, size: 20, bold, height: lines.length * 32 + 8 });
  }
  const divider = () => rows.push({ kind: 'divider', height: 22 });
  text(settings.companyLegalName || 'SOULIA', 30, true, '#00633c');
  text((preview ? label('معاينة — ', 'Preview — ') : '') + label('فاتورة مختصرة', 'Invoice summary'), 24, true);
  text('#' + String(tx.ref || tx._id || '').replace(/^#+/, ''), 20, true);
  const date = String(tx.date || tx.createdAt || '').slice(0, 10);
  if (date) text(label('التاريخ: ', 'Date: ') + date, 18);
  if (tx.cancelled || (typeof isStatusCancelled === 'function' && isStatusCancelled(tx.payStatus))) {
    text(label('ملغاة', 'Cancelled'), 22, true, '#b42318');
  }
  divider();
  text(tx.client || label('بدون اسم', 'Unnamed customer'), 22, true);
  if (tx.phone) text(tx.phone, 18);
  if (tx.shippingAddress) text(tx.shippingAddress, 18);
  divider();
  for (const item of tx.items || []) {
    text(item.name || item.code || '—', 20, true);
    pair(`${label('الكمية', 'Qty')}: ${Number(item.qty) || 0} × ${money(item.price)}`,
      money(item.total ?? ((Number(item.qty) || 0) * (Number(item.price) || 0))));
  }
  if (!(tx.items || []).length) text(label('لا توجد أصناف مسجلة', 'No items recorded'), 18);
  divider();
  pair(label('إجمالي الأصناف', 'Items subtotal'), money((tx.items || []).reduce((sum, item) => sum + Number(item.total ?? ((Number(item.qty) || 0) * (Number(item.price) || 0))), 0)));
  if (Number(tx.shipCost)) pair(label('الشحن', 'Shipping'), money(tx.shipCost));
  if (Number(tx.discount)) pair(label('الخصم', 'Discount'), '−' + money(tx.discount));
  pair(label('الإجمالي', 'Total'), money(tx.total), true);
  const remaining = Math.max(0, Number(tx.remaining) || 0);
  const purchase = tx.type === 'مشتريات';
  const returned = ['مرتجع', 'مرتجع مبيعات', 'مرتجع مشتريات'].includes(tx.type);
  if (returned) {
    pair(label('نوع المستند', 'Document type'), tx.type);
  } else {
    const paid = purchase ? Math.max(0, (Number(tx.total) || 0) - remaining)
      : (typeof isMovExchangeSale === 'function' && isMovExchangeSale(tx) && remaining > 0 ? remaining : Math.max(0, Number(tx.deposit) || 0));
    pair(label('المدفوع', 'Paid'), money(paid));
    if (!tx.cancelled && !(typeof isStatusCancelled === 'function' && isStatusCancelled(tx.payStatus))) {
      pair(label('المتبقي', 'Remaining'), money(remaining), true);
    }
  }
  const height = rows.reduce((sum, row) => sum + row.height, margin * 2);
  if (height > 14000) throw new Error(label('الفاتورة طويلة جداً لإنشاء صورة واحدة', 'Invoice is too long for one image'));
  canvas.width = width * 2;
  canvas.height = height * 2;
  ctx.scale(2, 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'top';
  let y = margin;
  for (const row of rows) {
    if (row.kind === 'divider') {
      ctx.strokeStyle = '#dfe8e2';
      ctx.beginPath(); ctx.moveTo(margin, y + 8); ctx.lineTo(width - margin, y + 8); ctx.stroke();
    } else {
      ctx.font = font(row.size, row.bold);
      ctx.fillStyle = row.color || '#203c30';
      ctx.direction = en ? 'ltr' : 'rtl';
      ctx.textAlign = en ? 'left' : 'right';
      row.lines.forEach((line, i) => ctx.fillText(line, en ? margin : width - margin, y + i * (row.size + 12)));
      if (row.kind === 'pair') {
        ctx.direction = 'ltr'; ctx.textAlign = en ? 'right' : 'left';
        ctx.fillText(row.value, en ? width - margin : margin, y, 220);
      }
    }
    y += row.height;
  }
  return canvas;
}

async function exportInvoiceImage(source, id, action) {
  const en = currentLang === 'en';
  const fail = message => { toast(message, true); return null; };
  let tx;
  if (source === 'shopify') {
    const order = _spOrderById(id);
    if (!order) return fail(t('spOrderNotFound'));
    tx = _spPeekPrintTx(order);
    tx.ref = order.ref;
    tx.cancelled = order.cancelled;
  } else {
    tx = transactions.find(entry => String(entry._id) === String(id));
    if (!tx) return fail(en ? 'Invoice not found' : 'الفاتورة غير موجودة');
  }
  if (tx.purchaseDetailsHidden) return fail(en ? 'Purchase details are restricted to admins' : 'تفاصيل الشراء متاحة للمدير فقط');
  const copy = action === 'copy';
  if (copy && (!window.isSecureContext || !navigator.clipboard?.write || !window.ClipboardItem)) {
    return fail(en ? 'Image copying is unavailable here. Use Download invoice image.' : 'نسخ الصور غير متاح هنا. استخدم تحميل صورة الفاتورة.');
  }
  const blobPromise = buildCompactInvoiceCanvas(tx, source === 'shopify').then(canvas => new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG generation failed')), 'image/png');
  }));
  try {
    if (copy) {
      // Start clipboard.write in the click event, before awaiting fonts/rendering (Safari).
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      toast(en ? 'Invoice image copied' : 'تم نسخ صورة الفاتورة');
    } else {
      const url = URL.createObjectURL(await blobPromise);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${String(tx.ref || id).replace(/[^\p{L}\p{N}_-]/gu, '_')}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(en ? 'Invoice image downloaded' : 'تم تحميل صورة الفاتورة');
    }
  } catch (error) {
    fail(copy ? (en ? 'Could not copy image. Use Download invoice image.' : 'تعذّر نسخ الصورة. استخدم تحميل صورة الفاتورة.')
      : (en ? 'Could not create invoice image' : 'تعذّر إنشاء صورة الفاتورة'));
  } finally {
    // A rejected clipboard write may leave the asynchronous rendering promise unconsumed.
    blobPromise.catch(() => {});
  }
}
