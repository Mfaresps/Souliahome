/* «أداء الباقات» — bundle analytics (Nov 14, 2026).
 *
 * Two kinds of bundle, counted from the sales already in memory (`transactions`, like the price
 * offers report — no request):
 *  • Shopify bundles — lines carrying `bundleGroupId`, named by the sale's `bundleSnapshot`.
 *  • «الباقات الذكية» — `tx.appliedBundles`, written by the server when a sale is saved
 *    (backend shared/smart-bundle.util.ts). ⚠ Tracking starts with that change (owner's decision):
 *    an invoice without the field is never counted, and none is guessed from its discount code.
 *
 * Revenue is at the line price, before the invoice discount (same rule as «أداء عروض السعر").
 * Cost is the cost frozen on the line (mirror of backend lineUnitCost), else the card price.
 * Cancelled sales are left out. Cost / profit / margin are shown only to admin or
 * purchase-edit-price — the app's rule for cost figures.
 */
(function () {
  'use strict';
  const L = (ar, en) => (typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar);
  const FROZEN = ['legacy-frozen', 'sale-snapshot', 'return-original']; // ⚠ = LINE_COST_SOURCES
  const canSeeCost = () => (typeof isAdmin === 'function' && isAdmin()) || (typeof hasPerm === 'function' && hasPerm('purchase-edit-price'));
  const dayOf = (t) => String(t.date || t.createdAt || '').slice(0, 10);
  const r2 = (n) => Math.round(n * 100) / 100;

  function lineCost(it) {
    const qty = Number(it.qty) || 0;
    const frozen = FROZEN.includes(it.costSource) && Number.isFinite(Number(it.unitCost)) && Number(it.unitCost) >= 0 ? Number(it.unitCost) : null;
    if (frozen !== null) return { cost: frozen * qty, known: true };
    const p = (typeof products !== 'undefined' ? products : []).find((x) => (it.productId && x._id === it.productId) || (it.code && x.code === it.code));
    const card = Number(p?.buyPrice);
    return card > 0 ? { cost: card * qty, known: true } : { cost: 0, known: false };
  }
  function listPriceOf(it) {
    let list = Number(it.listPrice);
    if (!(list > 0)) {
      const p = (typeof products !== 'undefined' ? products : []).find((x) => (it.productId && x._id === it.productId) || (it.code && x.code === it.code));
      list = Number(p?.sellPrice) || 0;
    }
    return Math.max(list, Number(it.price) || 0);
  }

  /** All sales in the period (not cancelled). */
  function salesIn(from, to) {
    return (typeof transactions !== 'undefined' ? transactions : []).filter((t) => t && t.type === 'مبيعات' && !t.cancelled && Array.isArray(t.items)
      && (!from || dayOf(t) >= from) && (!to || dayOf(t) <= to));
  }

  /** A Shopify bundle's identity across orders: its Shopify product, else its title, else its contents. */
  function bundleKey(group, parts) {
    if (group?.productId) return 'p:' + group.productId;
    const title = String(group?.title || '').trim();
    if (title) return 't:' + title.toLowerCase();
    return 'c:' + parts.map((p) => String(p.code || p.name || '')).sort().join('+');
  }

  function compute(from, to) {
    const txs = salesIn(from, to);
    const shop = new Map();
    const stat = (key, title) => {
      if (!shop.has(key)) shop.set(key, { key, title, invoices: new Set(), txIds: [], bundles: 0, revenue: 0, listValue: 0, cost: 0, costMissing: 0, broken: new Set(), codes: new Set(), names: new Map() });
      return shop.get(key);
    };
    // codes sold OUTSIDE any bundle in the period — for the "sold separately" margin
    const loose = new Map();
    for (const t of txs) {
      const groups = new Map((t.bundleSnapshot?.groups || []).map((g) => [String(g.groupId), g]));
      const byGroup = new Map();
      for (const it of t.items) {
        const g = it.bundleGroupId ? String(it.bundleGroupId) : '';
        if (g) { if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(it); continue; }
        // A part that left a bundle after confirmation counts as a broken bundle, not as a
        // separate sale — it would skew the "sold separately" comparison.
        if (it.brokenFrom) {
          const grp = groups.get(String(it.brokenFrom));
          if (grp) stat(bundleKey(grp, grp.components || []), grp.title || '').broken.add(String(t._id));
          continue;
        }
        const code = String(it.code || '');
        if (!code) continue;
        const c = lineCost(it);
        const l = loose.get(code) || { revenue: 0, cost: 0, missing: 0 };
        l.revenue += (Number(it.price) || 0) * (Number(it.qty) || 0);
        l.cost += c.cost; if (!c.known) l.missing++;
        loose.set(code, l);
      }
      for (const [g, parts] of byGroup) {
        const grp = groups.get(g) || null;
        const title = String(grp?.title || '').trim();
        const s = stat(bundleKey(grp, parts), title);
        if (!s.title && title) s.title = title;
        if (!s.invoices.has(String(t._id))) { s.invoices.add(String(t._id)); s.txIds.push(t._id); }
        s.bundles += Number(grp?.quantity) > 0 ? Number(grp.quantity) : 1;
        for (const it of parts) {
          const qty = Number(it.qty) || 0;
          s.revenue += (Number(it.price) || 0) * qty;
          s.listValue += listPriceOf(it) * qty;
          const c = lineCost(it);
          s.cost += c.cost; if (!c.known) s.costMissing++;
          if (it.code) { s.codes.add(String(it.code)); s.names.set(String(it.code), it.name || it.code); }
        }
      }
    }
    const shopify = [...shop.values()].map((s) => {
      let lr = 0, lc = 0, lm = 0;
      s.codes.forEach((c) => { const l = loose.get(c); if (l) { lr += l.revenue; lc += l.cost; lm += l.missing; } });
      const profit = s.revenue - s.cost;
      return {
        key: s.key,
        title: s.title || [...s.names.values()].join(' + '),
        components: [...s.names.entries()].map(([code, name]) => ({ code, name })),
        invoices: s.invoices.size, txIds: s.txIds, bundles: s.bundles,
        revenue: r2(s.revenue), listValue: r2(s.listValue), saved: r2(Math.max(0, s.listValue - s.revenue)),
        cost: r2(s.cost), costMissing: s.costMissing, profit: r2(profit),
        margin: s.revenue > 0 ? profit / s.revenue * 100 : null,
        looseMargin: lr > 0 && !lm ? (lr - lc) / lr * 100 : null,
        broken: s.broken.size,
      };
    }).filter((r) => r.invoices > 0 || r.broken > 0)
      .sort((a, b) => b.invoices - a.invoices || b.revenue - a.revenue);

    // smart bundles — only invoices saved since tracking began
    const smart = new Map();
    let trackedSince = '';
    let tracked = 0;
    for (const t of txs) {
      if (!Array.isArray(t.appliedBundles)) continue;
      tracked++;
      const at = String(t.createdAt || t.date || '');
      if (at && (!trackedSince || at < trackedSince)) trackedSince = at;
      for (const ab of t.appliedBundles) {
        const id = String(ab.id || '');
        if (!id) continue;
        const s = smart.get(id) || { id, name: ab.name || '', invoices: new Set(), txIds: [], full: 0, partial: 0, revenue: 0, discount: 0 };
        if (!s.invoices.has(String(t._id))) { s.invoices.add(String(t._id)); s.txIds.push(t._id); }
        if (ab.kind === 'partial') s.partial++; else s.full++;
        s.discount += Number(ab.discount) || 0;
        const pids = new Set((ab.productIds || []).map(String));
        for (const it of t.items) if (pids.has(String(it.productId || ''))) s.revenue += (Number(it.price) || 0) * (Number(it.qty) || 0);
        smart.set(id, s);
      }
    }
    // tracking started even if nothing in this period: any sale ever stored with the field
    if (!trackedSince) {
      for (const t of (typeof transactions !== 'undefined' ? transactions : [])) {
        if (!Array.isArray(t?.appliedBundles)) continue;
        const at = String(t.createdAt || t.date || '');
        if (at && (!trackedSince || at < trackedSince)) trackedSince = at;
      }
    }
    return {
      shopify,
      smart: [...smart.values()].map((s) => ({ ...s, invoices: s.invoices.size, revenue: r2(s.revenue), discount: r2(s.discount) })),
      tracked, trackedSince,
    };
  }

  // ── shared bits of markup ───────────────────────────────────────────────────────────────
  const money = (v) => `<bdi>${fmtJ(Number(v) || 0)}</bdi>`;
  const pctText = (v) => (v == null ? '—' : `<bdi dir="ltr">${(Math.round(v * 10) / 10).toFixed(1)}%</bdi>`);
  function gapHtml(margin, loose) {
    if (margin == null || loose == null) return '';
    const d = Math.round((margin - loose) * 10) / 10;
    if (Math.abs(d) < 0.05) return `<small class="ba-gap">${esc(L('نفس هامش البيع المنفرد', 'same as sold separately'))}</small>`;
    return `<small class="ba-gap ${d < 0 ? 'is-down' : 'is-up'}">${esc(d < 0 ? L('أقل من البيع المنفرد بـ', 'below separate sales by') : L('أعلى من البيع المنفرد بـ', 'above separate sales by'))} <bdi dir="ltr">${Math.abs(d).toFixed(1)}</bdi> ${esc(L('نقطة', 'pts'))}</small>`;
  }
  const BDL_ICO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg>';

  // rows drawn last, so a click on a row can open its invoices
  const lastRows = new Map();
  /** Shopify bundles table. opts.clickable → rows open the invoices window. */
  function shopifyTableHtml(rows, opts = {}) {
    rows.forEach((r) => lastRows.set('s:' + r.key, { title: r.title, txIds: r.txIds }));
    const cost = canSeeCost();
    const th = [L('الباقة', 'Bundle'), L('مرات البيع', 'Times sold'), L('الإيراد', 'Revenue'), L('التوفير للعميل', 'Customer saving'),
      ...(cost ? [L('التكلفة', 'Cost'), L('الربح', 'Profit'), L('الهامش', 'Margin')] : []), L('فُكّت', 'Broken')];
    const body = rows.map((r) => {
      const comps = r.components.slice(0, 4).map((c) => `<span class="ba-chip"><bdi>${esc(c.code)}</bdi></span>`).join('') + (r.components.length > 4 ? `<span class="ba-chip is-more">+${fmtN(r.components.length - 4)}</span>` : '');
      return `<tr${opts.clickable ? ` class="ba-row" tabindex="0" data-ba-open="${escHtml(r.key)}" title="${escHtml(L('عرض الفواتير', 'Show invoices'))}"` : ''}>
        <td><div class="ba-name"><span class="ba-ic">${BDL_ICO}</span><bdi dir="auto">${esc(r.title || L('باقة بدون اسم', 'Unnamed bundle'))}</bdi></div><div class="ba-chips">${comps}</div></td>
        <td class="ba-c"><b>${fmtN(r.invoices)}</b> <small>${esc(L('فاتورة', r.invoices === 1 ? 'invoice' : 'invoices'))}</small>${r.bundles !== r.invoices ? `<small class="ba-sub">${fmtN(r.bundles)} ${esc(L('باقة', 'bundles'))}</small>` : ''}</td>
        <td class="ba-num">${money(r.revenue)}</td>
        <td class="ba-num ba-saved">${r.saved > 0 ? `− ${money(r.saved)}` : '—'}${r.listValue > 0 && r.saved > 0 ? `<small class="ba-sub">${pctText(r.saved / r.listValue * 100)} ${esc(L('من السعر العادي', 'of list'))}</small>` : ''}</td>
        ${cost ? `<td class="ba-num">${money(r.cost)}${r.costMissing ? `<small class="ba-sub is-warn">${esc(L(`${fmtN(r.costMissing)} سطر بدون تكلفة`, `${fmtN(r.costMissing)} line(s) without cost`))}</small>` : ''}</td>
        <td class="ba-num ${r.profit < 0 ? 'is-neg' : ''}">${money(r.profit)}</td>
        <td class="ba-num">${pctText(r.margin)}${gapHtml(r.margin, r.looseMargin)}</td>` : ''}
        <td class="ba-c">${r.broken ? `<span class="ba-broken" title="${escHtml(L('طلبات اتعدّلت بعد التأكيد وخرجت من الباقة', 'Orders edited after confirmation that left the bundle'))}">${fmtN(r.broken)}</span>` : '<span class="ba-muted">—</span>'}</td>
      </tr>`;
    }).join('');
    return `<div class="ba-wrap"><table class="ba-tbl"><thead><tr>${th.map((h, i) => `<th class="${i === 0 ? '' : i === 1 || i === th.length - 1 ? 'ba-c' : 'ba-num'}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function smartTableHtml(rows, opts = {}) {
    rows.forEach((r) => lastRows.set('b:' + r.id, { title: r.name, txIds: r.txIds }));
    const known = new Map(((typeof settings !== 'undefined' && settings?.discountBundles) || []).map((b) => [String(b.id), b]));
    const body = rows.map((r) => {
      const b = known.get(r.id);
      return `<tr${opts.clickable ? ` class="ba-row" tabindex="0" data-ba-smart="${escHtml(r.id)}"` : ''}>
        <td><div class="ba-name"><bdi dir="auto">${esc(b?.name || r.name || L('باقة محذوفة', 'Deleted bundle'))}</bdi></div></td>
        <td class="ba-c"><b>${fmtN(r.invoices)}</b> <small>${esc(L('فاتورة', r.invoices === 1 ? 'invoice' : 'invoices'))}</small>${r.partial ? `<small class="ba-sub">${esc(L(`${fmtN(r.full)} كاملة · ${fmtN(r.partial)} جزئية`, `${fmtN(r.full)} full · ${fmtN(r.partial)} partial`))}</small>` : ''}</td>
        <td class="ba-num">${money(r.revenue)}</td>
        <td class="ba-num ba-saved">${r.discount > 0 ? `− ${money(r.discount)}` : '—'}</td>
      </tr>`;
    }).join('');
    return `<div class="ba-wrap"><table class="ba-tbl"><thead><tr><th>${esc(L('الباقة', 'Bundle'))}</th><th class="ba-c">${esc(L('مرات الاستخدام', 'Times used'))}</th><th class="ba-num">${esc(L('مبيعات منتجاتها', 'Sales of its products'))}</th><th class="ba-num">${esc(L('خصم الباقة', 'Bundle discount'))}</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  const fmtDay = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(L('ar-EG-u-nu-latn', 'en-GB'), { day: 'numeric', month: 'short', year: 'numeric' });
  };
  function trackedNote(data) {
    return data.trackedSince
      ? L(`الباقات الذكية تُحتسب من ${fmtDay(data.trackedSince)} — الفواتير الأقدم لا تحمل اسم الباقة.`, `Smart bundles are counted from ${fmtDay(data.trackedSince)} — older invoices do not record the bundle.`)
      : L('بدأ تتبّع الباقات الذكية — ستظهر هنا الفواتير الجديدة التي تُطبَّق عليها باقة.', 'Smart-bundle tracking has started — new invoices that use a bundle will show here.');
  }

  // ── Reports card ─────────────────────────────────────────────────────────────────────────
  function renderReport(from, to) {
    const host = typeof qs === 'function' ? qs('#rep-bundles-section') : null;
    if (!host) return;
    const data = compute(from, to);
    const totRev = data.shopify.reduce((a, r) => a + r.revenue, 0);
    const totInv = data.shopify.reduce((a, r) => a + r.invoices, 0);
    const head = `<div class="ba-head"><div class="ba-title"><span class="ba-ic">${BDL_ICO}</span><h3>${esc(L('أداء الباقات', 'Bundle performance'))}</h3></div>
      ${data.shopify.length ? `<span class="ba-sum">${esc(L(`${fmtN(totInv)} فاتورة بباقات Shopify — الإيراد:`, `${fmtN(totInv)} invoice(s) with Shopify bundles — revenue:`))} ${money(totRev)}</span>` : ''}</div>`;
    const shopSec = `<h4 class="ba-h4">${esc(L('باقات Shopify', 'Shopify bundles'))}</h4>` + (data.shopify.length
      ? shopifyTableHtml(data.shopify)
      : `<div class="ba-empty">${esc(L('لا مبيعات بباقات Shopify في هذه الفترة.', 'No Shopify bundle sales in this period.'))}</div>`);
    const smartSec = `<h4 class="ba-h4">${esc(L('الباقات الذكية', 'Smart bundles'))}</h4><p class="ba-note">${esc(trackedNote(data))}</p>` + (data.smart.length
      ? smartTableHtml(data.smart)
      : `<div class="ba-empty">${esc(L('لا فواتير بباقة ذكية في هذه الفترة.', 'No invoices with a smart bundle in this period.'))}</div>`);
    host.innerHTML = head + shopSec + smartSec
      + `<div class="ba-note">${esc(L('الإيراد بسعر السطر قبل خصم الفاتورة، والفواتير الملغاة غير محسوبة. التوفير = السعر العادي للقطع ناقص سعرها في الباقة. «فُكّت» = طلبات عُدّلت بعد التأكيد وخرجت من الباقة.', 'Revenue is at the line price, before the invoice discount; cancelled invoices are not counted. Saving = the pieces\' normal price minus their price in the bundle. «Broken» = orders edited after confirmation that left the bundle.'))}</div>`;
  }

  // ── invoices window (used by the Promotions tab) ─────────────────────────────────────────
  function openInvoices(title, txIds) {
    const all = typeof transactions !== 'undefined' ? transactions : [];
    const rows = txIds.map((id) => all.find((t) => String(t._id) === String(id))).filter(Boolean)
      .sort((a, b) => dayOf(b).localeCompare(dayOf(a)));
    const body = rows.map((t) => `<tr class="ba-row" tabindex="0" data-ba-tx="${escHtml(String(t._id))}">
      <td><bdi class="ba-ref">#${esc(t.ref || '')}</bdi></td><td><bdi>${esc(fmtDay(t.date || t.createdAt))}</bdi></td>
      <td dir="auto">${esc(t.client || '')}</td><td class="ba-num">${money(t.total)}</td></tr>`).join('');
    openModal(`<div class="ba-dlg" data-ba-root>
      <div class="ba-dlg-head"><div><div class="ba-dlg-title"><span class="ba-ic">${BDL_ICO}</span><bdi dir="auto">${esc(title)}</bdi></div>
      <div class="ba-dlg-sub">${esc(L(`${fmtN(rows.length)} فاتورة`, `${fmtN(rows.length)} invoice(s)`))}</div></div>
      <button type="button" class="modal-x" data-ba-close aria-label="${escHtml(L('إغلاق', 'Close'))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
      <div class="ba-dlg-body">${rows.length ? `<table class="ba-tbl"><thead><tr><th>${esc(L('الفاتورة', 'Invoice'))}</th><th>${esc(L('التاريخ', 'Date'))}</th><th>${esc(L('العميل', 'Customer'))}</th><th class="ba-num">${esc(L('الإجمالي', 'Total'))}</th></tr></thead><tbody>${body}</tbody></table>` : `<div class="ba-empty">${esc(L('لا فواتير.', 'No invoices.'))}</div>`}</div>
    </div>`, 'max-width:640px;padding:0;overflow:hidden');
  }
  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-ba-close]');
    if (close) { closeModal(); return; }
    const tx = e.target.closest('[data-ba-tx]');
    if (tx) { closeModal(); if (typeof openOrderView === 'function') openOrderView(tx.dataset.baTx); return; }
    const row = e.target.closest('[data-ba-open],[data-ba-smart]');
    if (row) {
      const hit = row.dataset.baOpen != null ? lastRows.get('s:' + row.dataset.baOpen) : lastRows.get('b:' + row.dataset.baSmart);
      if (hit) openInvoices(hit.title || L('باقة', 'Bundle'), hit.txIds || []);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tx = e.target.closest && e.target.closest('[data-ba-tx],[data-ba-open],[data-ba-smart]');
    if (tx) { e.preventDefault(); tx.click(); }
  });

  window.SouliaBundleStats = { compute, renderReport, shopifyTableHtml, smartTableHtml, openInvoices, trackedNote, canSeeCost };
})();
