(function () {
  'use strict';
  let productSort = 'orders';
  let expanded = false;
  let lastReport, lastFilters;
  const l = (ar, en) => currentLang === 'en' ? en : ar;
  const pct = (count, total) => total ? Math.round(count / total * 1000) / 10 : 0;
  const number = value => `<bdi>${fmtN(value || 0)}</bdi>`;
  const percent = value => `<bdi>${fmtN(value || 0)}%</bdi>`;
  const meter = value => `<span class="cxra-meter" aria-hidden="true"><i style="width:${Math.min(100, Math.max(0, value))}%"></i></span>`;

  function render(report, filters = {}) {
    const host = document.getElementById('cxr-analysis');
    if (!host) return;
    lastReport = report; lastFilters = filters;
    const signature = JSON.stringify([filters.stage, filters.reason, currentLang, productSort, expanded]);
    if (host._report === report && host.dataset.signature === signature) return;
    host._report = report; host.dataset.signature = signature;
    const matches = row => (!filters.stage || row.stage === filters.stage) && (!filters.reason || row.code === filters.reason);
    const buckets = (report.breakdown || []).filter(matches);
    const reasonMap = new Map();
    for (const row of buckets) {
      const reason = reasonMap.get(row.code) || { code: row.code, count: 0, shopifyCount: 0, transactionCount: 0, lostValue: 0 };
      reason.count += row.count;
      reason[row.stage === 'shopify' ? 'shopifyCount' : 'transactionCount'] += row.count;
      reason.lostValue += row.lostValue;
      reasonMap.set(row.code, reason);
    }
    const reasons = (report.breakdown ? [...reasonMap.values()] : report.reasons || []).sort((a,b) => b.count - a.count || a.code.localeCompare(b.code));
    const total = reasons.reduce((sum,row) => sum + row.count, 0);
    const late = reasons.reduce((sum,row) => sum + row.transactionCount, 0);
    const coverage = (report.productCoverage || []).filter(matches).reduce((sum,row) => {
      for (const key of Object.keys(sum)) sum[key] += row[key] || 0;
      return sum;
    }, { orders: 0, missingOrders: 0, partialOrders: 0, excludedOrders: 0 });
    const products = (report.products || []).map(product => {
      const counts = product.breakdown.filter(matches).reduce((sum,row) => ({ orderCount: sum.orderCount + row.orderCount, quantity: sum.quantity + row.quantity }), { orderCount: 0, quantity: 0 });
      return { ...product, ...counts };
    }).filter(product => product.orderCount > 0).sort((a,b) => productSort === 'units'
      ? b.quantity - a.quantity || b.orderCount - a.orderCount || a.key.localeCompare(b.key)
      : b.orderCount - a.orderCount || b.quantity - a.quantity || a.key.localeCompare(b.key));
    const top = reasons[0];
    const groups = CANCEL_REASON_GROUPS.map(group => {
      const members = reasons.filter(reason => (CANCEL_REASONS.find(def => def.code === reason.code)?.group || 'other') === group.key);
      return { key: group.key, count: members.reduce((sum,row) => sum + row.count, 0) };
    }).filter(group => group.count).sort((a,b) => b.count - a.count);
    const units = products.reduce((sum,product) => sum + product.quantity, 0);
    const topProduct = [...products].sort((a,b) => b.orderCount - a.orderCount || b.quantity - a.quantity || a.key.localeCompare(b.key))[0];
    host.innerHTML = `
      <div class="cxra-insights">
        <article><span>${l('السبب الأكثر تكرارًا','Most frequent reason')}</span><strong>${top ? esc(cancelReasonLabel(top.code)) : '—'}</strong><small>${top ? `${number(top.count)} ${l('طلب','orders')} · ${percent(pct(top.count,total))} ${l('من الإلغاءات المحددة','of selected cancellations')}` : esc(t('cxrNoMatch'))}</small></article>
        <article><span>${l('المنتج الأكثر إلغاءً','Most cancelled product')}</span><strong>${topProduct ? esc(topProduct.name) : '—'}</strong><small>${topProduct ? `${number(topProduct.orderCount)} ${l('طلب ملغى','cancelled orders')} · ${number(topProduct.quantity)} ${l('قطعة','units')}` : l('لا توجد بنود منتجات صالحة للتحليل','No usable product lines')}</small></article>
        <article><span>${l('الإلغاء بعد التسجيل','Cancelled after entry')}</span><strong>${percent(pct(late,total))}</strong><small>${number(late)} ${l('من','of')} ${number(total)} ${l('طلب ملغى محدد','selected cancelled orders')}</small></article>
      </div>
      <div class="cxra-grid">
        <section class="cxr-card cxra-reasons">
          <div class="cxra-heading"><div><h3>${esc(t('cxrTitle'))}</h3><p>${l('مرتب حسب عدد الطلبات؛ الشريط يوضح النسبة من الإلغاءات المحددة.','Ranked by order count; bars show share of selected cancellations.')}</p></div><span class="cxra-total">${number(total)} ${l('طلب','orders')}</span></div>
          <p class="cxra-mobile-hint">${l('اسحب الجدول أفقيًا لعرض باقي الأعمدة','Scroll horizontally to see all columns')}</p><div class="cxra-scroll" tabindex="0" role="region" aria-label="${esc(t('cxrTitle'))}"><table class="cxra-table cxra-reason-table"><thead><tr><th scope="col">${l('السبب / النسبة','Reason / share')}</th><th scope="col">${l('الطلبات','Orders')}</th><th scope="col">${esc(t('cxrStageShopify'))}</th><th scope="col">${esc(t('cxrStageTx'))}</th><th scope="col">${l('قيمة الإلغاءات','Cancelled value')}</th></tr></thead><tbody>${reasons.map(reason => `<tr><td><strong>${cancelReasonReportHtml(reason.code)}</strong><div class="cxra-share">${meter(pct(reason.count,total))}<small>${percent(pct(reason.count,total))}</small></div></td><td class="cxra-emphasis">${number(reason.count)}</td><td>${number(reason.shopifyCount)}</td><td>${number(reason.transactionCount)}</td><td>${fmtJ(reason.lostValue)}</td></tr>`).join('') || `<tr><td colspan="5" class="cxra-empty">${esc(t('cxrNoMatch'))}</td></tr>`}</tbody></table></div>
          ${groups.length ? `<div class="cxra-categories"><h4>${esc(t('cxrGroupsTitle'))}</h4><div>${groups.map(group => `<article><span>${esc(cancelGroupLabel(group.key))}</span><b>${number(group.count)} <small>· ${percent(pct(group.count,total))}</small></b>${meter(pct(group.count,total))}</article>`).join('')}</div></div>` : ''}
        </section>
        <section class="cxr-card cxra-products">
          <div class="cxra-heading"><div><h3>${l('أكثر المنتجات إلغاءً','Most cancelled products')}</h3><p>${l('عدد الطلبات الملغاة التي تحتوي على المنتج، وإجمالي قطعه.','Cancelled orders containing each product, and its total units.')}</p></div></div>
          <div class="cxra-product-tools"><span>${number(products.length)} ${l('منتج','products')} · ${number(units)} ${l('قطعة','units')}</span><label>${l('الترتيب','Sort')} <select data-cxra-sort><option value="orders" ${productSort==='orders'?'selected':''}>${l('عدد الطلبات','Order count')}</option><option value="units" ${productSort==='units'?'selected':''}>${l('عدد القطع','Unit count')}</option></select></label></div>
          <div class="cxra-scroll" tabindex="0" role="region" aria-label="${l('ترتيب المنتجات الملغاة','Cancelled product ranking')}"><table class="cxra-table cxra-product-table"><thead><tr><th scope="col">#</th><th scope="col">${l('المنتج','Product')}</th><th scope="col">${l('طلبات ملغاة','Cancelled orders')}</th><th scope="col">${l('القطع','Units')}</th></tr></thead><tbody>${products.slice(0,expanded?products.length:10).map((product,index) => `<tr><td><span class="cxra-rank">${number(index+1)}</span></td><td><strong dir="auto">${esc(product.name)}</strong>${product.code?`<small class="cxra-sku"><bdi>${esc(product.code)}</bdi></small>`:''}${meter(pct(productSort==='units'?product.quantity:product.orderCount,productSort==='units'?products[0].quantity:products[0].orderCount))}</td><td class="cxra-emphasis">${number(product.orderCount)}</td><td>${number(product.quantity)}</td></tr>`).join('') || `<tr><td colspan="4" class="cxra-empty">${l('لا توجد بيانات منتجات قابلة للتحليل ضمن الاختيار الحالي.','No usable product data for this selection.')}</td></tr>`}</tbody></table></div>
          ${products.length>10?`<button type="button" class="cxra-more" data-cxra-more>${expanded?l('عرض أول 10 منتجات','Show top 10'):l('عرض كل المنتجات','Show all products')} (${number(products.length)})</button>`:''}
          <div class="cxra-note">${l('يُحسب المنتج مرة واحدة لكل طلب، وتُجمع جميع قطعه. قد يضم الطلب عدة منتجات، لذلك لا يُجمع عدد الطلبات بين المنتجات.','Each product counts once per order; all its units are summed. Orders may contain several products, so product order counts are not additive.')}</div>
          ${coverage.missingOrders||coverage.partialOrders||coverage.excludedOrders?`<div class="cxra-coverage">${coverage.missingOrders?`${number(coverage.missingOrders)} ${l('طلب بدون بيانات منتجات صالحة.','orders without usable product data.')} `:''}${coverage.partialOrders?`${number(coverage.partialOrders)} ${l('طلب ببيانات منتجات غير مكتملة؛ احتُسبت البنود الصالحة فقط.','orders with incomplete product data; only valid lines counted.')} `:''}${coverage.excludedOrders?`${number(coverage.excludedOrders)} ${l('معاملة غير بيعية مستبعدة من ترتيب المنتجات.','non-sales transactions excluded from product ranking.')}`:''}</div>`:''}
        </section>
      </div>`;
    host.querySelector('[data-cxra-sort]').onchange = event => { productSort = event.target.value; render(lastReport,lastFilters); };
    host.querySelector('[data-cxra-more]')?.addEventListener('click', () => { expanded = !expanded; render(lastReport,lastFilters); });
  }
  window.CancellationAnalytics = { render };
})();
