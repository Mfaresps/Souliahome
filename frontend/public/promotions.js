/* ═══════════════════════════════════════════════════════════════════════════════════════
   «العروض والخصومات» — #page-promotions (Nov 12, 2026)

   Moved out of Settings ← العروض into its own page under الأصناف. Five tabs:
     offers  — every price offer on every product (GET /products/offers/all): start now,
               stop, cancel, edit, relaunch, bulk stop, and a new-offer dialog with a product picker.
     codes   — settings.discountCodes        bundles — settings.discountBundles
     tags    — masterTags                    audit   — GET /promotions/audit (persisted)

   Rules this file keeps:
   - The write paths for codes, bundles and tags are the existing functions in index.html
     (openAddDiscountCodeModal, toggleBundleActive, addMasterTag, …). They call
     renderDiscountCodes() / renderDiscountBundles() / renderTagMgmt() after a write, and those
     now delegate to Promotions.refresh(). One write path, never two.
   - Permissions: promoPerm(area) in index.html. An action the user may not perform stays
     visible but disabled with a reason (same convention as the supplier account page); the audit
     tab is hidden without promotions-audit, since it names employees.
   - Every click goes through data-act delegation. Codes, bundle and tag names are typed by
     people and neither esc() nor escHtml() escapes a single quote, so none of them is ever put
     inside an inline onclick string.
   - The filter inputs are drawn once per tab; typing redraws only the table (#pr-tbl), so the
     search box never loses focus mid-word.
   ═══════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const en = () => currentLang === 'en';
  const L = (ar, enText) => (en() ? enText : ar);
  const TABS = ['offers', 'codes', 'bundles', 'shopify', 'tags', 'audit'];
  const PAGE_SIZE = 50;

  const S = {
    tab: 'offers',
    offers: { status: 'idle', rows: [], today: '' },
    audit: { status: 'idle', rows: [], total: 0, truncated: false, page: 1 },
    f: {
      offers: { q: '', status: 'live' },
      codes: { q: '', status: '', type: '' },
      bundles: { q: '', status: '' },
      shopify: { q: '', period: '90' },
      tags: { q: '' },
      audit: { q: '', kind: '', group: '' },
    },
    sel: new Set(),
    busy: false,
    mounted: false,
  };

  // ── small helpers ────────────────────────────────────────────────────────────────────────
  const root = () => qs('#promo-root');
  const today = () => S.offers.today || todayLocalISO();
  const attr = (v) => escHtml(v == null ? '' : String(v));
  const dayNum = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : NaN; };
  const daysBetween = (a, b) => Math.round(dayNum(b) - dayNum(a));
  const addDays = (d, n) => { const x = new Date((dayNum(d) + n) * 864e5); return x.toISOString().slice(0, 10); };
  const norm = (v) => String(v || '').toLowerCase().replace(/[ً-ٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىئ]/g, 'ي');
  const matches = (q, ...fields) => { const n = norm(q).trim(); return !n || fields.some((f) => norm(f).includes(n)); };
  const pct = (price, base) => (base > 0 ? Math.round((1 - price / base) * 1000) / 10 : 0);
  const money = (v) => `<bdi class="pr-num">${fmtJ(Number(v) || 0)}</bdi>`;
  const ICO = {
    tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 15 6-6"/><circle cx="9.5" cy="9.5" r="1"/><circle cx="14.5" cy="14.5" r="1"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2a3 3 0 0 0 0 6v2.5"/><path d="M20 17v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a3 3 0 0 0 0-6"/></svg>',
    bundle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>',
    tags: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H4v5l9 9 5-5Z"/><path d="m14 5 6 6-4 4"/><circle cx="7" cy="8" r="1"/></svg>',
    audit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l11-7Z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3"/></svg>',
    list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    box: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };
  const lockTitle = () => L('تحتاج صلاحية لتنفيذ هذا الإجراء — اطلبها من المدير', 'You need permission for this action — ask a manager');
  const lockAttr = (allowed) => (allowed ? '' : ` disabled title="${attr(lockTitle())}"`);

  function thumb(url, name) {
    const safe = typeof sanitizeUrl === 'function' ? sanitizeUrl(url) : '';
    const initials = esc(String(name || '?').trim().slice(0, 2));
    return `<span class="pr-thumb" aria-hidden="true"><span class="pr-thumb-ph">${initials}</span>${safe ? `<img src="${attr(safe)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
  }
  function productImage(p, fallback) {
    if (p && typeof _pwItemImgUrl === 'function') {
      try { return _pwItemImgUrl({ productId: p._id, code: p.code, name: p.name, imageUrl: p.imageUrl }) || fallback || ''; } catch (_) { /* fall through */ }
    }
    return (p && p.imageUrl) || fallback || '';
  }

  // ── data ─────────────────────────────────────────────────────────────────────────────────
  async function loadOffers() {
    S.offers.status = S.offers.rows.length ? 'refreshing' : 'loading';
    try {
      const res = await api('/products/offers/all');
      S.offers.rows = Array.isArray(res?.rows) ? res.rows : [];
      S.offers.today = res?.today || todayLocalISO();
      S.offers.status = 'ready';
      // Keep the in-memory products in step, so the sale form and the product page price by
      // the same offers this page shows.
      const byProduct = new Map();
      S.offers.rows.forEach(({ status, productId, productName, productCode, productImage: _img, basePrice, ...o }) => {
        if (!byProduct.has(productId)) byProduct.set(productId, []);
        byProduct.get(productId).push(o);
      });
      (products || []).forEach((p) => { if (byProduct.has(p._id)) p.priceOffers = byProduct.get(p._id); else if (p.priceOffers?.length) p.priceOffers = []; });
      const live = new Set(S.offers.rows.filter((o) => o.status === 'active' || o.status === 'upcoming').map((o) => o.id));
      [...S.sel].forEach((id) => { if (!live.has(id)) S.sel.delete(id); });
    } catch (e) {
      S.offers.status = 'error';
      S.offers.error = e?.message || '';
    }
  }
  async function loadAudit() {
    if (!promoPerm('audit')) return;
    S.audit.status = S.audit.rows.length ? 'refreshing' : 'loading';
    if (S.tab === 'audit') drawTable();
    try {
      const res = await api('/promotions/audit?limit=2000');
      S.audit.rows = Array.isArray(res?.rows) ? res.rows : [];
      S.audit.total = Number(res?.total) || S.audit.rows.length;
      S.audit.truncated = !!res?.truncated;
      S.audit.status = 'ready';
    } catch (e) {
      S.audit.status = 'error';
    }
  }
  async function refreshReference() {
    // Codes, bundles and tags were loaded at boot; another session may have changed them since.
    const [codes, bundles, tags] = await Promise.all([
      api('/settings/discount-codes').catch(() => null),
      api('/settings/discount-bundles').catch(() => null),
      api('/tags').catch(() => null),
    ]);
    if (Array.isArray(codes)) settings.discountCodes = codes;
    if (Array.isArray(bundles)) settings.discountBundles = bundles;
    if (Array.isArray(tags)) { if (typeof _setMasterTags === 'function') _setMasterTags(tags); else masterTags = tags; }
  }

  // ── derived figures ──────────────────────────────────────────────────────────────────────
  function offerUsage() {
    const map = new Map();
    (transactions || []).forEach((tx) => {
      if (tx.type !== 'مبيعات' || tx.cancelled || !Array.isArray(tx.items)) return;
      tx.items.forEach((it) => {
        const off = typeof _lineOfferOf === 'function' ? _lineOfferOf(it) : null;
        if (!off || !off.id) return;
        const qty = Number(it.qty) || 0, price = Number(it.price) || 0;
        const u = map.get(off.id) || { invoices: new Set(), qty: 0, saved: 0 };
        u.invoices.add(tx._id); u.qty += qty; u.saved += Math.max(0, (off.list - price) * qty);
        map.set(off.id, u);
      });
    });
    return map;
  }
  function monthSaved() {
    const ym = today().slice(0, 7);
    let saved = 0; const inv = new Set();
    (transactions || []).forEach((tx) => {
      if (tx.type !== 'مبيعات' || tx.cancelled || !Array.isArray(tx.items)) return;
      if (String(tx.date || tx.createdAt || '').slice(0, 7) !== ym) return;
      tx.items.forEach((it) => {
        const off = typeof _lineOfferOf === 'function' ? _lineOfferOf(it) : null;
        if (!off) return;
        saved += Math.max(0, (off.list - (Number(it.price) || 0)) * (Number(it.qty) || 0));
        inv.add(tx._id);
      });
    });
    return { saved: Math.round(saved * 100) / 100, invoices: inv.size };
  }
  function codeState(c, now = new Date()) {
    if (_codeExpired(c.endDate, now)) return 'expired';
    if (!c.active) return 'off';
    if (_codeNotStarted(c.startDate, now)) return 'upcoming';
    return 'active';
  }
  function tagUsage() {
    const counts = new Map();
    (transactions || []).forEach((tx) => (tx.tags || []).forEach((name) => counts.set(name, (counts.get(name) || 0) + 1)));
    return counts;
  }

  // ── shell ────────────────────────────────────────────────────────────────────────────────
  function tabMeta() {
    const offers = S.offers.rows.filter((o) => o.status === 'active').length;
    const codes = (settings.discountCodes || []).length;
    const bundles = (settings.discountBundles || []).length;
    return [
      { id: 'offers', icon: ICO.tag, label: L('عروض الأسعار', 'Price offers'), n: (S.offers.status === 'loading' || S.offers.status === 'idle') ? null : offers, nTitle: L('سارية الآن', 'running now') },
      { id: 'codes', icon: ICO.code, label: L('أكواد الخصم', 'Discount codes'), n: codes },
      { id: 'bundles', icon: ICO.bundle, label: L('الباقات الذكية', 'Smart bundles'), n: bundles },
      { id: 'shopify', icon: ICO.bundle, label: L('باقات Shopify', 'Shopify bundles'), n: window.SouliaBundleStats ? window.SouliaBundleStats.compute('', '').shopify.length : null, nTitle: L('باقات بيعت', 'bundles sold') },
      { id: 'tags', icon: ICO.tags, label: L('إدارة TAGs', 'Manage tags'), n: (masterTags || []).length },
      ...(promoPerm('audit') ? [{ id: 'audit', icon: ICO.audit, label: L('سجل المراجعة', 'Audit log'), n: null }] : []),
    ];
  }
  function primaryAction() {
    if (S.tab === 'offers') return { act: 'offer-new', label: L('عرض سعر جديد', 'New price offer'), ok: promoPerm('offers') };
    if (S.tab === 'codes') return { act: 'code-new', label: L('كود خصم جديد', 'New discount code'), ok: promoPerm('codes') };
    if (S.tab === 'bundles') return { act: 'bundle-new', label: L('باقة جديدة', 'New bundle'), ok: promoPerm('bundles') };
    return null;
  }

  function shellHtml() {
    const pa = primaryAction();
    return `<div class="pr-page">
      <header class="pr-head">
        <div class="pr-head-text">
          <nav class="pr-crumb" aria-label="${attr(L('مسار الصفحة', 'Breadcrumb'))}"><a href="#products" data-act="go-products">${esc(L('الأصناف', 'Products'))}</a><span aria-hidden="true">/</span><span>${esc(L('العروض والخصومات', 'Promotions'))}</span></nav>
          <h2 class="page-title">${esc(L('العروض والخصومات', 'Promotions'))}</h2>
          <p class="page-subtitle">${esc(L('عروض أسعار الأصناف، أكواد الخصم، الباقات الذكية والتاجات — تشغيلها وإيقافها ومراجعتها من مكان واحد.', 'Product price offers, discount codes, smart bundles and tags — run, stop and review them in one place.'))}</p>
        </div>
        <div class="pr-head-act">
          <button type="button" class="pr-btn pr-btn-icon" data-act="reload" title="${attr(L('تحديث', 'Refresh'))}" aria-label="${attr(L('تحديث', 'Refresh'))}">${ICO.refresh}</button>
          ${pa ? `<button type="button" class="pr-btn pr-btn-primary" data-act="${pa.act}"${lockAttr(pa.ok)}>${ICO.plus}<span>${esc(pa.label)}</span></button>` : ''}
        </div>
      </header>
      <section class="pr-sum" id="pr-sum" aria-label="${attr(L('ملخص', 'Summary'))}">${summaryHtml()}</section>
      <div class="pr-tabs" role="tablist" id="pr-tabs">${tabsHtml()}</div>
      <section class="pr-panel" id="pr-panel" role="tabpanel">${panelHtml()}</section>
    </div>`;
  }
  function tabsHtml() {
    return tabMeta().map((tb) => `<button type="button" role="tab" class="pr-tab${S.tab === tb.id ? ' is-on' : ''}" aria-selected="${S.tab === tb.id}" data-act="tab" data-tab="${tb.id}">${tb.icon}<span>${esc(tb.label)}</span>${tb.n != null ? `<span class="pr-tab-n"${tb.nTitle ? ` title="${attr(tb.nTitle)}"` : ''}>${fmtN(tb.n)}</span>` : ''}</button>`).join('');
  }
  function summaryHtml() {
    const loading = S.offers.status === 'loading' || S.offers.status === 'idle';
    const running = S.offers.rows.filter((o) => o.status === 'active').length;
    const upcoming = S.offers.rows.filter((o) => o.status === 'upcoming').length;
    const codes = settings.discountCodes || [];
    const activeCodes = codes.filter((c) => codeState(c) === 'active').length;
    const bundles = settings.discountBundles || [];
    const activeBundles = bundles.filter((b) => b.active).length;
    const ms = monthSaved();
    const item = (tab, label, val, sub) => `<button type="button" class="pr-sum-item" data-act="tab" data-tab="${tab}"><span class="pr-sum-label">${esc(label)}</span><span class="pr-sum-val">${val}</span><span class="pr-sum-sub">${sub}</span></button>`;
    return [
      item('offers', L('عروض سارية الآن', 'Offers running now'), loading ? '<span class="pr-skel-line"></span>' : fmtN(running),
        loading ? '&nbsp;' : esc(upcoming ? L(`${fmtN(upcoming)} قادمة`, `${fmtN(upcoming)} upcoming`) : L('لا عروض قادمة', 'none upcoming'))),
      item('codes', L('أكواد خصم مفعّلة', 'Active discount codes'), fmtN(activeCodes), esc(L(`من ${fmtN(codes.length)} كود`, `of ${fmtN(codes.length)} codes`))),
      item('bundles', L('باقات مفعّلة', 'Active bundles'), fmtN(activeBundles), esc(L(`من ${fmtN(bundles.length)} باقة`, `of ${fmtN(bundles.length)} bundles`))),
      item('offers', L('تخفيض العروض هذا الشهر', 'Offer markdown this month'), money(ms.saved),
        esc(ms.invoices ? L(`على ${fmtN(ms.invoices)} فاتورة`, `across ${fmtN(ms.invoices)} invoice(s)`) : L('لا مبيعات بسعر عرض بعد', 'no sales at an offer yet'))),
    ].join('');
  }

  // ── panels: toolbar drawn once, table redrawn on every filter change ─────────────────────
  function searchBox(tab, ph) {
    return `<label class="pr-search">${ICO.search}<input type="search" data-filter="${tab}.q" value="${attr(S.f[tab].q)}" placeholder="${attr(ph)}" aria-label="${attr(ph)}"></label>`;
  }
  function seg(tab, key, opts) {
    const cur = S.f[tab][key];
    return `<div class="pr-seg" role="radiogroup">${opts.map(([v, label]) => `<button type="button" role="radio" aria-checked="${cur === v}" class="${cur === v ? 'is-on' : ''}" data-act="seg" data-key="${tab}.${key}" data-val="${attr(v)}">${esc(label)}</button>`).join('')}</div>`;
  }
  function panelHtml() {
    const tab = S.tab;
    let tools = '';
    if (tab === 'offers') {
      tools = `${searchBox('offers', L('ابحث بالصنف أو الكود أو اسم العرض…', 'Search product, code or offer name…'))}
        ${seg('offers', 'status', [['live', L('السارية والقادمة', 'Running & upcoming')], ['active', L('سارية', 'Running')], ['upcoming', L('قادمة', 'Upcoming')], ['ended', L('منتهية', 'Ended')], ['all', L('الكل', 'All')]])}`;
    } else if (tab === 'codes') {
      tools = `${searchBox('codes', L('ابحث بالكود أو الوصف…', 'Search code or description…'))}
        ${seg('codes', 'status', [['', L('الكل', 'All')], ['active', L('مفعّل', 'Active')], ['upcoming', L('لم يبدأ', 'Scheduled')], ['off', L('معطّل', 'Disabled')], ['expired', L('منتهي', 'Expired')]])}
        ${seg('codes', 'type', [['', L('كل الأنواع', 'All types')], ['percent', L('نسبة %', 'Percent')], ['fixed', L('مبلغ ثابت', 'Fixed')]])}`;
    } else if (tab === 'bundles') {
      tools = `${searchBox('bundles', L('ابحث باسم الباقة أو منتج فيها…', 'Search bundle or a product in it…'))}
        ${seg('bundles', 'status', [['', L('الكل', 'All')], ['on', L('مفعّلة', 'Active')], ['off', L('معطّلة', 'Disabled')]])}`;
    } else if (tab === 'shopify') {
      tools = `${searchBox('shopify', L('ابحث باسم الباقة أو كود منتج فيها…', 'Search bundle or a product code…'))}
        ${seg('shopify', 'period', [['30', L('آخر 30 يوماً', 'Last 30 days')], ['90', L('آخر 90 يوماً', 'Last 90 days')], ['all', L('الكل', 'All time')]])}`;
    } else if (tab === 'tags') {
      tools = `${searchBox('tags', L('ابحث عن تاج أو تصنيف…', 'Search tags or categories…'))}`;
    } else if (tab === 'audit') {
      tools = `${searchBox('audit', L('ابحث بالموظف أو الكود أو الباقة…', 'Search employee, code or bundle…'))}
        ${seg('audit', 'group', [['', L('كل الأحداث', 'All events')], ['usage', L('استخدام في البيع', 'Used in sales')], ['manage', L('إدارة', 'Management')]])}
        ${seg('audit', 'kind', [['', L('الكل', 'All')], ['bundle', L('باقات', 'Bundles')], ['code', L('أكواد', 'Codes')], ['offer', L('عروض', 'Offers')], ['tag', L('تاجات', 'Tags')]])}
        ${isAdmin() ? `<button type="button" class="pr-btn pr-btn-ghost pr-tools-end" data-act="audit-clear">${esc(L('مسح السجل', 'Clear log'))}</button>` : ''}`;
    }
    const intro = {
      offers: L('سعر مؤقت للصنف خلال فترة محددة. لا يتغير السعر الأساسي، وتحتفظ المبيعات التي تمت بسعر العرض به بعد إيقافه.', 'A temporary product price for a period. The base price never changes, and sales made at the offer keep it after the offer stops.'),
      codes: L('أكواد يكتبها الموظف أو العميل في الفاتورة. الاستخدام محسوب من الفواتير الفعلية غير الملغاة.', 'Codes entered on an invoice. Usage is counted from real, non-cancelled invoices.'),
      bundles: L('ربط منتجات بكود خصم يُقترح تلقائياً عند اختيارها في فاتورة البيع — كاملة أو جزئية.', 'Link products to a discount code suggested automatically when they are picked on a sale — full or partial.'),
      shopify: L('الباقات التي يبيعها Shopify كمنتج واحد ثم يقسّمها على منتجاتها. الأرقام من الفواتير المؤكدة غير الملغاة، والإيراد بسعر السطر قبل خصم الفاتورة. اضغط على باقة لعرض فواتيرها.', 'Bundles Shopify sells as one product and splits into its products. Figures come from confirmed, non-cancelled invoices; revenue is at the line price before the invoice discount. Click a bundle to see its invoices.'),
      tags: L('قائمة التاجات التي تُضاف إلى المعاملات والطلبات. حذف التاج لا يزيله من المعاملات السابقة.', 'The tags put on transactions and orders. Deleting one keeps it on past transactions.'),
      audit: L('كل محاولة خصم بباقة من نموذج البيع، وكل تعديل على العروض والأكواد والباقات والتاجات — مع اسم الموظف والوقت.', 'Every bundle-discount attempt from the sale form, and every change to offers, codes, bundles and tags — with employee and time.'),
    }[tab];
    const extra = tab === 'tags' ? tagAddHtml() : '';
    return `<p class="pr-intro">${esc(intro)}</p>
      <div class="pr-card">
        <div class="pr-tools">${tools}<span class="pr-count" id="pr-count" aria-live="polite"></span></div>
        ${extra}
        <div id="pr-bulk"></div>
        <div id="pr-tbl"></div>
      </div>`;
  }

  // ── tables ───────────────────────────────────────────────────────────────────────────────
  function drawTable() {
    const host = qs('#pr-tbl');
    if (!host) return;
    const fn = { offers: offersTable, codes: codesTable, bundles: bundlesTable, shopify: shopifyBundlesTable, tags: tagsTable, audit: auditTable }[S.tab];
    const { html, shown, total } = fn();
    host.innerHTML = html;
    const cnt = qs('#pr-count');
    if (cnt) cnt.textContent = total == null ? '' : (shown === total ? L(`${fmtN(total)} سطر`, `${fmtN(total)} rows`) : L(`${fmtN(shown)} من ${fmtN(total)}`, `${fmtN(shown)} of ${fmtN(total)}`));
    drawBulk();
  }
  const emptyRow = (cols, msg, reset) => `<div class="pr-empty"><p>${esc(msg)}</p>${reset ? `<button type="button" class="pr-btn pr-btn-ghost" data-act="reset-filters">${esc(L('مسح الفلاتر', 'Clear filters'))}</button>` : ''}</div>`;
  const statePill = (key, label) => `<span class="pr-pill is-${key}">${esc(label)}</span>`;

  // offers
  const OFFER_STATUS = { active: ['ساري', 'Running'], upcoming: ['قادم', 'Upcoming'], ended: ['منتهي', 'Ended'], cancelled: ['ملغي', 'Cancelled'] };
  function offerWhen(o) {
    const t0 = today();
    if (o.status === 'active') {
      const end = o.to;
      const left = daysBetween(t0, end);
      return left <= 0 ? L('اليوم آخر أيامه', 'Last day today') : L(`يتبقى ${fmtN(left + 1)} يوم`, `${fmtN(left + 1)} days left`);
    }
    if (o.status === 'upcoming') {
      const d = daysBetween(t0, o.from);
      return d === 1 ? L('يبدأ غداً', 'Starts tomorrow') : L(`يبدأ بعد ${fmtN(d)} يوم`, `Starts in ${fmtN(d)} days`);
    }
    if (o.status === 'cancelled') return L('أُلغي قبل أن يبدأ', 'Cancelled before it started');
    if (o.endedOn) return L(`أُوقف في ${_psDate(o.endedOn)}`, `Stopped ${_psDate(o.endedOn)}`);
    return L(`انتهى في ${_psDate(o.to)}`, `Ended ${_psDate(o.to)}`);
  }
  function filteredOffers() {
    const f = S.f.offers;
    const rows = S.offers.rows.filter((o) => {
      if (f.status === 'live' && !(o.status === 'active' || o.status === 'upcoming')) return false;
      if (f.status === 'active' && o.status !== 'active') return false;
      if (f.status === 'upcoming' && o.status !== 'upcoming') return false;
      if (f.status === 'ended' && !(o.status === 'ended' || o.status === 'cancelled')) return false;
      return matches(f.q, o.productName, o.productCode, o.reason, o.by);
    });
    return rows;
  }
  function offersTable() {
    const st = S.offers.status;
    if (st === 'loading' || st === 'idle') return { html: skeleton(6), shown: null, total: null };
    if (st === 'error') return { html: `<div class="pr-empty is-error"><p>${esc(L('تعذّر تحميل العروض.', 'Could not load the offers.'))}</p>${S.offers.error ? `<p class="pr-sub" dir="auto">${esc(S.offers.error)}</p>` : ''}<button type="button" class="pr-btn pr-btn-ghost" data-act="reload">${esc(L('إعادة المحاولة', 'Retry'))}</button></div>`, shown: null, total: null };
    const all = S.offers.rows;
    const rows = filteredOffers();
    if (!all.length) return { html: `<div class="pr-empty"><span class="pr-empty-ico">${ICO.tag}</span><p>${esc(L('لا توجد عروض أسعار بعد.', 'No price offers yet.'))}</p>${promoPerm('offers') ? `<button type="button" class="pr-btn pr-btn-primary" data-act="offer-new">${ICO.plus}<span>${esc(L('أول عرض سعر', 'First price offer'))}</span></button>` : ''}</div>`, shown: 0, total: 0 };
    const filtered = S.f.offers.q || S.f.offers.status !== 'all';
    if (!rows.length) {
      const msg = S.f.offers.status === 'live' && !S.f.offers.q ? L('لا يوجد عرض سارٍ أو قادم حالياً.', 'No offer is running or upcoming right now.') : L('لا توجد عروض تطابق الفلتر.', 'No offers match the filter.');
      return { html: emptyRow(8, msg, filtered), shown: 0, total: all.length };
    }
    const canEdit = promoPerm('offers');
    const usage = offerUsage();
    const liveRows = rows.filter((o) => o.status === 'active' || o.status === 'upcoming');
    const allSel = liveRows.length && liveRows.every((o) => S.sel.has(o.id));
    const body = rows.map((o) => {
      const live = o.status === 'active' || o.status === 'upcoming';
      const p = (products || []).find((x) => x._id === o.productId);
      const off = pct(o.price, o.basePrice);
      const u = usage.get(o.id);
      const [sAr, sEn] = OFFER_STATUS[o.status] || OFFER_STATUS.ended;
      let actions = '';
      if (o.status === 'active') {
        actions = `<button type="button" class="pr-btn pr-btn-sm pr-btn-stop" data-act="offer-stop" data-id="${attr(o.id)}"${lockAttr(canEdit)}>${ICO.stop}<span>${esc(L('إيقاف', 'Stop'))}</span></button>
          <button type="button" class="pr-iconbtn" data-act="offer-edit" data-id="${attr(o.id)}" aria-label="${attr(L('تعديل العرض', 'Edit offer'))}" title="${attr(canEdit ? L('تعديل', 'Edit') : lockTitle())}"${canEdit ? '' : ' disabled'}>${ICO.edit}</button>`;
      } else if (o.status === 'upcoming') {
        actions = `<button type="button" class="pr-btn pr-btn-sm pr-btn-go" data-act="offer-start" data-id="${attr(o.id)}"${lockAttr(canEdit)}>${ICO.play}<span>${esc(L('تفعيل الآن', 'Start now'))}</span></button>
          <button type="button" class="pr-iconbtn" data-act="offer-edit" data-id="${attr(o.id)}" aria-label="${attr(L('تعديل العرض', 'Edit offer'))}" title="${attr(canEdit ? L('تعديل', 'Edit') : lockTitle())}"${canEdit ? '' : ' disabled'}>${ICO.edit}</button>
          <button type="button" class="pr-iconbtn is-danger" data-act="offer-stop" data-id="${attr(o.id)}" aria-label="${attr(L('إلغاء العرض', 'Cancel offer'))}" title="${attr(canEdit ? L('إلغاء العرض', 'Cancel offer') : lockTitle())}"${canEdit ? '' : ' disabled'}>${ICO.close}</button>`;
      } else {
        actions = `<button type="button" class="pr-btn pr-btn-sm pr-btn-ghost" data-act="offer-reuse" data-id="${attr(o.id)}"${lockAttr(canEdit && !!p)}>${ICO.redo}<span>${esc(L('إعادة تشغيله', 'Run again'))}</span></button>`;
      }
      return `<tr class="${live ? '' : 'is-past'}${S.sel.has(o.id) ? ' is-sel' : ''}">
        <td class="pr-c-check">${live && canEdit ? `<input type="checkbox" class="pr-check" data-act="sel" data-id="${attr(o.id)}" ${S.sel.has(o.id) ? 'checked' : ''} aria-label="${attr(L('تحديد', 'Select'))}">` : ''}</td>
        <td data-label="${attr(L('الصنف', 'Product'))}"><div class="pr-prod">${thumb(productImage(p, o.productImage), o.productName)}<div class="pr-prod-txt"><a href="#product/${attr(o.productId)}" class="pr-prod-name" data-act="open-product" data-id="${attr(o.productId)}" dir="auto">${esc(o.productName || '—')}</a>${o.productCode ? `<bdi class="pr-mono">${esc(o.productCode)}</bdi>` : ''}</div></div></td>
        <td data-label="${attr(L('العرض', 'Offer'))}"><div class="pr-offer-name">${_offerTagHtml(o.reason || L('عرض', 'Offer'))}</div>${o.by ? `<div class="pr-sub">${esc(L('بواسطة', 'by'))} ${esc(o.by)}${o.editedBy ? ` · ${esc(L('عدّله', 'edited by'))} ${esc(o.editedBy)}` : ''}</div>` : ''}</td>
        <td data-label="${attr(L('السعر', 'Price'))}" class="pr-c-price"><div class="pr-price"><bdi class="pr-price-now">${fmtJ(o.price)}</bdi><s class="pr-price-was"><bdi>${fmtJ(o.basePrice)}</bdi></s></div>${off > 0 ? `<span class="pr-off"><bdi dir="ltr">−${fmtN(off)}%</bdi></span>` : ''}</td>
        <td data-label="${attr(L('الفترة', 'Period'))}"><div class="pr-range"><bdi>${esc(_psDate(o.from))}</bdi><span aria-hidden="true">${en() ? '→' : '←'}</span><bdi>${esc(_psDate(o.to))}</bdi></div><div class="pr-sub${o.status === 'active' && daysBetween(today(), o.to) <= 1 ? ' is-warn' : ''}">${esc(offerWhen(o))}</div></td>
        <td data-label="${attr(L('الاستخدام', 'Usage'))}" class="pr-c-num">${u ? `<div class="pr-strong">${esc(L(`${fmtN(u.invoices.size)} فاتورة`, `${fmtN(u.invoices.size)} invoice(s)`))}</div><div class="pr-sub">${esc(L(`${fmtN(u.qty)} قطعة · توفير`, `${fmtN(u.qty)} pcs · saved`))} ${money(u.saved)}</div>` : `<span class="pr-muted">${esc(L('لم يُستخدم بعد', 'Not used yet'))}</span>`}</td>
        <td data-label="${attr(L('الحالة', 'Status'))}">${statePill(o.status, L(sAr, sEn))}</td>
        <td class="pr-c-act"><div class="pr-actions">${actions}</div></td>
      </tr>`;
    }).join('');
    const head = `<thead><tr>
      <th class="pr-c-check">${canEdit && liveRows.length ? `<input type="checkbox" class="pr-check" data-act="sel-all" ${allSel ? 'checked' : ''} aria-label="${attr(L('تحديد كل العروض السارية والقادمة', 'Select all running and upcoming offers'))}">` : ''}</th>
      <th>${esc(L('الصنف', 'Product'))}</th><th>${esc(L('العرض', 'Offer'))}</th><th class="pr-c-price">${esc(L('السعر', 'Price'))}</th>
      <th>${esc(L('الفترة', 'Period'))}</th><th class="pr-c-num">${esc(L('الاستخدام', 'Usage'))}</th><th>${esc(L('الحالة', 'Status'))}</th><th class="pr-c-act"><span class="pr-sr">${esc(L('إجراءات', 'Actions'))}</span></th>
    </tr></thead>`;
    return { html: `<div class="pr-tbl-wrap"><table class="pr-table pr-t-offers">${head}<tbody>${body}</tbody></table></div>`, shown: rows.length, total: all.length };
  }
  function drawBulk() {
    const host = qs('#pr-bulk');
    if (!host) return;
    if (S.tab !== 'offers' || !S.sel.size) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="pr-bulk" role="region" aria-label="${attr(L('إجراءات على المحدد', 'Bulk actions'))}">
      <span><strong>${fmtN(S.sel.size)}</strong> ${esc(L('عرض محدد', 'offer(s) selected'))}</span>
      <button type="button" class="pr-btn pr-btn-sm pr-btn-stop" data-act="bulk-stop"${S.busy ? ' disabled' : ''}>${ICO.stop}<span>${esc(L('إيقاف / إلغاء المحدد', 'Stop / cancel selected'))}</span></button>
      <button type="button" class="pr-btn pr-btn-sm pr-btn-ghost" data-act="sel-clear">${esc(L('إلغاء التحديد', 'Clear selection'))}</button>
    </div>`;
  }

  // codes
  const CODE_STATE = { active: ['مفعّل', 'Active'], upcoming: ['لم يبدأ', 'Scheduled'], off: ['معطّل', 'Disabled'], expired: ['منتهي', 'Expired'] };
  function codesTable() {
    const all = settings.discountCodes || [];
    const f = S.f.codes;
    const now = new Date();
    const rows = all.filter((c) => (!f.type || c.type === f.type) && (!f.status || codeState(c, now) === f.status) && matches(f.q, c.code, c.description));
    if (!all.length) return { html: `<div class="pr-empty"><span class="pr-empty-ico">${ICO.code}</span><p>${esc(L('لا توجد أكواد خصم بعد.', 'No discount codes yet.'))}</p></div>`, shown: 0, total: 0 };
    if (!rows.length) return { html: emptyRow(7, L('لا توجد أكواد تطابق الفلتر.', 'No codes match the filter.'), true), shown: 0, total: all.length };
    const can = promoPerm('codes');
    const body = rows.map((c) => {
      const st = codeState(c, now);
      const lu = _liveCodeUsage(c.id, c.code);
      const val = c.type === 'percent' ? `<bdi dir="ltr">${fmtN(c.value)}%</bdi>` : money(c.value);
      const s0 = c.startDate ? _psDate(String(c.startDate).slice(0, 10)) : '';
      const e0 = c.endDate ? _psDate(String(c.endDate).slice(0, 10)) : '';
      let left = '';
      if (c.endDate && st === 'active') {
        const d = daysBetween(todayLocalISO(), String(c.endDate).slice(0, 10));
        left = d <= 0 ? L('اليوم آخر أيامه', 'Last day today') : L(`يتبقى ${fmtN(d + 1)} يوم`, `${fmtN(d + 1)} days left`);
      }
      const [aAr, aEn] = CODE_STATE[st];
      return `<tr class="${st === 'expired' || st === 'off' ? 'is-past' : ''}">
        <td data-label="${attr(L('الكود', 'Code'))}">${discBadgeHtml(c.value || 1, c.code, 0, { noClick: true, codeType: c.type })}${c.description ? `<div class="pr-sub" dir="auto">${esc(c.description)}</div>` : ''}</td>
        <td data-label="${attr(L('الخصم', 'Discount'))}" class="pr-c-price"><div class="pr-strong">${val}</div><div class="pr-sub">${esc(c.type === 'percent' ? L('نسبة من الأصناف', 'Percent of items') : L('مبلغ ثابت', 'Fixed amount'))}</div></td>
        <td data-label="${attr(L('الصلاحية', 'Validity'))}">${s0 || e0 ? `<div class="pr-range"><bdi>${esc(s0 || L('من الآن', 'now'))}</bdi><span aria-hidden="true">${en() ? '→' : '←'}</span><bdi>${esc(e0 || L('بلا نهاية', 'no end'))}</bdi></div>` : `<span class="pr-muted">${esc(L('بلا تاريخ', 'No dates'))}</span>`}${left ? `<div class="pr-sub">${esc(left)}</div>` : ''}</td>
        <td data-label="${attr(L('الاستخدام', 'Usage'))}" class="pr-c-num">${lu.count ? `<button type="button" class="pr-link" data-act="code-usage" data-id="${attr(c.id)}"><span class="pr-strong">${esc(L(`${fmtN(lu.count)} مرة`, `${fmtN(lu.count)} time(s)`))}</span></button><div class="pr-sub">${esc(L('خصم', 'off'))} ${money(lu.totalDisc)}</div>` : `<span class="pr-muted">${esc(L('لم يُستخدم', 'Unused'))}</span>`}</td>
        <td data-label="${attr(L('الحالة', 'Status'))}">${statePill(st, L(aAr, aEn))}</td>
        <td data-label="${attr(L('مفعّل', 'Enabled'))}">${switchHtml('code-toggle', c.id, !!c.active, can, c.code)}</td>
        <td class="pr-c-act"><div class="pr-actions">
          <button type="button" class="pr-iconbtn" data-act="code-edit" data-id="${attr(c.id)}" aria-label="${attr(L('تعديل', 'Edit') + ' ' + c.code)}" title="${attr(can ? L('تعديل', 'Edit') : lockTitle())}"${can ? '' : ' disabled'}>${ICO.edit}</button>
          <button type="button" class="pr-iconbtn is-danger" data-act="code-delete" data-id="${attr(c.id)}" aria-label="${attr(L('حذف', 'Delete') + ' ' + c.code)}" title="${attr(can ? L('حذف', 'Delete') : lockTitle())}"${can ? '' : ' disabled'}>${ICO.trash}</button>
        </div></td>
      </tr>`;
    }).join('');
    const head = `<thead><tr><th>${esc(L('الكود', 'Code'))}</th><th class="pr-c-price">${esc(L('الخصم', 'Discount'))}</th><th>${esc(L('الصلاحية', 'Validity'))}</th><th class="pr-c-num">${esc(L('الاستخدام', 'Usage'))}</th><th>${esc(L('الحالة', 'Status'))}</th><th>${esc(L('مفعّل', 'Enabled'))}</th><th class="pr-c-act"><span class="pr-sr">${esc(L('إجراءات', 'Actions'))}</span></th></tr></thead>`;
    return { html: `<div class="pr-tbl-wrap"><table class="pr-table pr-t-codes">${head}<tbody>${body}</tbody></table></div>`, shown: rows.length, total: all.length };
  }
  function switchHtml(act, id, on, allowed, name) {
    return `<button type="button" role="switch" class="pr-switch${on ? ' is-on' : ''}" aria-checked="${on}" aria-label="${attr((on ? L('مفعّل: ', 'Enabled: ') : L('معطّل: ', 'Disabled: ')) + (name || ''))}" data-act="${act}" data-id="${attr(id)}"${allowed ? '' : ` disabled title="${attr(lockTitle())}"`}><span></span></button>`;
  }

  // bundles
  function bundlesTable() {
    const all = settings.discountBundles || [];
    const codes = settings.discountCodes || [];
    const f = S.f.bundles;
    const nameOf = (pid) => (products || []).find((x) => x._id === pid)?.name || pid;
    const rows = all.filter((b) => (!f.status || (f.status === 'on' ? b.active : !b.active))
      && matches(f.q, b.name, b.description, ...(b.productIds || []).map(nameOf)));
    if (!all.length) return { html: `<div class="pr-empty"><span class="pr-empty-ico">${ICO.bundle}</span><p>${esc(L('لا توجد باقات خصم — أضف باقة لربط منتجات بكود خصم تلقائي.', 'No bundles yet — add one to link products to an automatic discount code.'))}</p></div>`, shown: 0, total: 0 };
    if (!rows.length) return { html: emptyRow(8, L('لا توجد باقات تطابق الفلتر.', 'No bundles match the filter.'), true), shown: 0, total: all.length };
    const can = promoPerm('bundles');
    const BS = window.SouliaBundleStats;
    const usage = BS ? BS.compute('', '') : null;
    const useOf = new Map((usage?.smart || []).map((u) => [String(u.id), u]));
    if (BS && usage) BS.smartTableHtml(usage.smart); // remembers the rows so a usage click opens the invoices
    const body = rows.map((b) => {
      const code = codes.find((c) => c.id === b.discountCodeId);
      const partial = b.partialDiscountCodeId ? codes.find((c) => c.id === b.partialDiscountCodeId) : null;
      const names = (b.productIds || []).map(nameOf);
      const chips = names.slice(0, 3).map((n) => `<span class="pr-chip" dir="auto">${esc(n)}</span>`).join('') + (names.length > 3 ? `<span class="pr-chip is-more" title="${attr(names.slice(3).join('، '))}">+${fmtN(names.length - 3)}</span>` : '');
      const codeOff = code && codeState(code) !== 'active';
      return `<tr class="${b.active ? '' : 'is-past'}">
        <td data-label="${attr(L('الباقة', 'Bundle'))}"><div class="pr-strong" dir="auto">${esc(b.name)}</div>${b.description ? `<div class="pr-sub" dir="auto">${esc(b.description)}</div>` : ''}</td>
        <td data-label="${attr(L('المنتجات', 'Products'))}"><div class="pr-chips">${chips || `<span class="pr-muted">—</span>`}</div><div class="pr-sub">${esc(L(`${fmtN(names.length)} منتج`, `${fmtN(names.length)} product(s)`))}</div></td>
        <td data-label="${attr(L('كود الخصم', 'Discount code'))}">${code ? `${discBadgeHtml(code.value || 1, code.code, 0, { noClick: true, codeType: code.type })}<div class="pr-sub">${code.type === 'percent' ? `<bdi dir="ltr">${fmtN(code.value)}%</bdi>` : money(code.value)}${codeOff ? ` · <span class="is-warn">${esc(L('الكود غير مفعّل', 'code not active'))}</span>` : ''}</div>` : `<span class="pr-muted is-warn">${esc(L('بدون كود', 'No code'))}</span>`}${partial ? `<div class="pr-sub">${esc(L('جزئي:', 'Partial:'))} <bdi class="pr-mono">${esc(partial.code)}</bdi></div>` : ''}</td>
        <td data-label="${attr(L('جزئي', 'Partial'))}" class="pr-c-mid">${b.allowPartial ? `<span class="pr-yes">${esc(L('نعم', 'Yes'))}</span>` : `<span class="pr-muted">${esc(L('لا', 'No'))}</span>`}</td>
        <td data-label="${attr(L('الحد الأدنى', 'Min qty'))}" class="pr-c-mid"><bdi class="pr-strong">${fmtN(b.minQty || 1)}</bdi></td>
        <td data-label="${attr(L('الأولوية', 'Priority'))}" class="pr-c-mid"><bdi class="pr-strong">${fmtN(b.priority || 1)}</bdi></td>
        <td data-label="${attr(L('الاستخدام', 'Usage'))}" class="pr-c-mid">${(() => { const u = useOf.get(String(b.id)); return u
          ? `<button type="button" class="pr-linkbtn" data-ba-smart="${attr(b.id)}" title="${attr(L('عرض الفواتير', 'Show invoices'))}"><b>${fmtN(u.invoices)}</b> ${esc(L('فاتورة', u.invoices === 1 ? 'invoice' : 'invoices'))}</button>${u.discount > 0 ? `<div class="pr-sub">− ${money(u.discount)}</div>` : ''}`
          : `<span class="pr-muted">0</span>`; })()}</td>
        <td data-label="${attr(L('مفعّلة', 'Enabled'))}">${switchHtml('bundle-toggle', b.id, !!b.active, can, b.name)}</td>
        <td class="pr-c-act"><div class="pr-actions">
          <button type="button" class="pr-iconbtn" data-act="bundle-edit" data-id="${attr(b.id)}" aria-label="${attr(L('تعديل', 'Edit') + ' ' + b.name)}" title="${attr(can ? L('تعديل', 'Edit') : lockTitle())}"${can ? '' : ' disabled'}>${ICO.edit}</button>
          <button type="button" class="pr-iconbtn is-danger" data-act="bundle-delete" data-id="${attr(b.id)}" aria-label="${attr(L('حذف', 'Delete') + ' ' + b.name)}" title="${attr(can ? L('حذف', 'Delete') : lockTitle())}"${can ? '' : ' disabled'}>${ICO.trash}</button>
        </div></td>
      </tr>`;
    }).join('');
    const head = `<thead><tr><th>${esc(L('الباقة', 'Bundle'))}</th><th>${esc(L('المنتجات', 'Products'))}</th><th>${esc(L('كود الخصم', 'Discount code'))}</th><th class="pr-c-mid">${esc(L('جزئي', 'Partial'))}</th><th class="pr-c-mid" title="${attr(L('الحد الأدنى للكمية لتفعيل الاقتراح', 'Minimum quantity to trigger the suggestion'))}">${esc(L('الحد الأدنى', 'Min qty'))}</th><th class="pr-c-mid">${esc(L('الأولوية', 'Priority'))}</th><th class="pr-c-mid" title="${attr(L('فواتير طُبّقت عليها الباقة منذ بدء التتبّع', 'Invoices that used the bundle since tracking began'))}">${esc(L('الاستخدام', 'Usage'))}</th><th>${esc(L('مفعّلة', 'Enabled'))}</th><th class="pr-c-act"><span class="pr-sr">${esc(L('إجراءات', 'Actions'))}</span></th></tr></thead>`;
    const tracked = usage ? `<p class="pr-intro pr-track-note">${esc(BS.trackedNote(usage))}</p>` : '';
    return { html: `${tracked}<div class="pr-tbl-wrap"><table class="pr-table pr-t-bundles">${head}<tbody>${body}</tbody></table></div>`, shown: rows.length, total: all.length };
  }

  // Shopify bundles — bundle-analytics.js computes; this tab filters and draws.
  function shopifyBundlesTable() {
    const BS = window.SouliaBundleStats;
    if (!BS) return { html: '', shown: 0, total: 0 };
    const f = S.f.shopify;
    const from = (!f.period || f.period === 'all') ? '' : addDays(today(), -(Number(f.period) - 1));
    const all = BS.compute(from, '').shopify;
    const rows = all.filter((r) => matches(f.q, r.title, ...r.components.map((c) => c.code), ...r.components.map((c) => c.name)));
    if (!all.length) return { html: `<div class="pr-empty"><span class="pr-empty-ico">${ICO.bundle}</span><p>${esc(L('لا مبيعات بباقات Shopify في هذه الفترة.', 'No Shopify bundle sales in this period.'))}</p></div>`, shown: 0, total: 0 };
    if (!rows.length) return { html: emptyRow(6, L('لا توجد باقات تطابق البحث.', 'No bundles match the search.'), true), shown: 0, total: all.length };
    return { html: BS.shopifyTableHtml(rows, { clickable: true }), shown: rows.length, total: all.length };
  }

  // tags
  const TAG_CAT_EN = { operational: 'Operational', risk: 'Risk', system: 'System' };
  const tagCatLabel = (k) => (k ? (en() ? TAG_CAT_EN[k] : TAG_CATEGORY_LABELS[k]) || k : L('بلا تصنيف', 'Uncategorised'));
  function catOptions(sel) {
    return ['', 'operational', 'risk', 'system'].map((k) => `<option value="${k}"${(sel || '') === k ? ' selected' : ''}>${esc(tagCatLabel(k))}</option>`).join('');
  }
  function tagAddHtml() {
    const can = promoPerm('tags');
    return `<div class="pr-tagadd${can ? '' : ' is-locked'}"${can ? '' : ` title="${attr(lockTitle())}"`}>
      <span class="pr-tagadd-label">${esc(L('تاج جديد', 'New tag'))}</span>
      <input type="text" id="new-master-tag-name" maxlength="20" placeholder="${attr(L('اسم التاج', 'Tag name'))}" aria-label="${attr(L('اسم التاج', 'Tag name'))}"${can ? '' : ' disabled'}>
      <select id="new-master-tag-category" aria-label="${attr(L('التصنيف', 'Category'))}"${can ? '' : ' disabled'}>${catOptions('')}</select>
      <label class="pr-color" title="${attr(L('اللون', 'Colour'))}"><input type="color" id="new-master-tag-bg" value="#3b82f6" aria-label="${attr(L('لون التاج', 'Tag colour'))}"${can ? '' : ' disabled'}></label>
      <button type="button" class="pr-btn pr-btn-primary pr-btn-sm" onclick="addMasterTag()"${can ? '' : ' disabled'}>${ICO.plus}<span>${esc(L('إضافة', 'Add'))}</span></button>
    </div>`;
  }
  function tagsTable() {
    const all = (masterTags || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
    const rows = all.filter((tg) => matches(S.f.tags.q, tg.name, tagCatLabel(tg.category), tg.category));
    if (!all.length) return { html: `<div class="pr-empty"><span class="pr-empty-ico">${ICO.tags}</span><p>${esc(L('لا توجد تاجات بعد.', 'No tags yet.'))}</p></div>`, shown: 0, total: 0 };
    if (!rows.length) return { html: emptyRow(5, L('لا توجد تاجات مطابقة.', 'No matching tags.'), true), shown: 0, total: all.length };
    const can = promoPerm('tags');
    const usage = tagUsage();
    const body = rows.map((tg) => {
      const n = usage.get(tg.name) || 0;
      return `<tr>
        <td data-label="${attr(L('التاج', 'Tag'))}"><span class="tx-tag" style="--tag-c:${attr(tg.bg || '#64748b')}">${esc(tg.name)}</span></td>
        <td data-label="${attr(L('التصنيف', 'Category'))}"><select class="pr-select" data-act="tag-cat" data-id="${attr(tg._id)}" aria-label="${attr(L('تصنيف', 'Category') + ': ' + tg.name)}"${can ? '' : ` disabled title="${attr(lockTitle())}"`}>${catOptions(tg.category)}</select></td>
        <td data-label="${attr(L('اللون', 'Colour'))}"><label class="pr-color"><input type="color" value="${attr(/^#[0-9a-f]{6}$/i.test(tg.bg || '') ? tg.bg : '#64748b')}" data-act="tag-color" data-id="${attr(tg._id)}" aria-label="${attr(L('لون', 'Colour') + ': ' + tg.name)}"${can ? '' : ' disabled'}></label></td>
        <td data-label="${attr(L('الاستخدام', 'Usage'))}" class="pr-c-num">${n ? `<span class="pr-strong">${esc(L(`${fmtN(n)} معاملة`, `${fmtN(n)} transaction(s)`))}</span>` : `<span class="pr-muted">${esc(L('غير مستخدم', 'Unused'))}</span>`}</td>
        <td class="pr-c-act"><div class="pr-actions"><button type="button" class="pr-iconbtn is-danger" data-act="tag-delete" data-id="${attr(tg._id)}" aria-label="${attr(L('حذف التاج', 'Delete tag') + ' ' + tg.name)}" title="${attr(can ? L('حذف', 'Delete') : lockTitle())}"${can ? '' : ' disabled'}>${ICO.trash}</button></div></td>
      </tr>`;
    }).join('');
    const head = `<thead><tr><th>${esc(L('التاج', 'Tag'))}</th><th>${esc(L('التصنيف', 'Category'))}</th><th>${esc(L('اللون', 'Colour'))}</th><th class="pr-c-num">${esc(L('الاستخدام', 'Usage'))}</th><th class="pr-c-act"><span class="pr-sr">${esc(L('إجراءات', 'Actions'))}</span></th></tr></thead>`;
    return { html: `<div class="pr-tbl-wrap"><table class="pr-table pr-t-tags">${head}<tbody>${body}</tbody></table></div>`, shown: rows.length, total: all.length };
  }

  // audit
  const AUDIT_ACTION = {
    applied: ['تطبيق خصم', 'Applied', 'ok'], removed: ['إزالة', 'Removed', 'neutral'], denied: ['مرفوض', 'Denied', 'bad'],
    approved: ['موافقة', 'Approved', 'info'], pending_approval: ['بانتظار موافقة', 'Awaiting approval', 'warn'],
    created: ['إنشاء', 'Created', 'info'], updated: ['تعديل', 'Edited', 'neutral'], enabled: ['تفعيل', 'Enabled', 'ok'],
    disabled: ['تعطيل', 'Disabled', 'warn'], deleted: ['حذف', 'Deleted', 'bad'], started: ['بدء الآن', 'Started now', 'ok'],
    stopped: ['إيقاف', 'Stopped', 'warn'], cancelled: ['إلغاء', 'Cancelled', 'bad'], cleared: ['مسح السجل', 'Log cleared', 'bad'],
    'removed-from-invoice': ['إزالة من فاتورة', 'Removed from invoice', 'warn'],
  };
  const USAGE = new Set(['applied', 'removed', 'denied', 'approved', 'pending_approval']);
  const AUDIT_KIND = { bundle: ['باقة', 'Bundle'], code: ['كود', 'Code'], offer: ['عرض سعر', 'Price offer'], tag: ['تاج', 'Tag'], log: ['السجل', 'Log'] };
  function auditTable() {
    const st = S.audit.status;
    if (st === 'loading' || st === 'idle') return { html: skeleton(8), shown: null, total: null };
    if (st === 'error') return { html: `<div class="pr-empty is-error"><p>${esc(L('تعذّر تحميل سجل المراجعة.', 'Could not load the audit log.'))}</p><button type="button" class="pr-btn pr-btn-ghost" data-act="audit-reload">${esc(L('إعادة المحاولة', 'Retry'))}</button></div>`, shown: null, total: null };
    const f = S.f.audit;
    const all = S.audit.rows;
    const rows = all.filter((r) => (!f.kind || r.kind === f.kind)
      && (!f.group || (f.group === 'usage' ? USAGE.has(r.action) : !USAGE.has(r.action)))
      && matches(f.q, r.employee, r.label, r.ref, r.reason, r.txRef));
    if (!all.length) return { html: `<div class="pr-empty"><span class="pr-empty-ico">${ICO.audit}</span><p>${esc(L('لا يوجد سجل بعد — ستظهر هنا محاولات الخصم وكل تعديل على العروض.', 'Nothing logged yet — discount attempts and every promotions change will appear here.'))}</p></div>`, shown: 0, total: 0 };
    if (!rows.length) return { html: emptyRow(7, L('لا توجد أحداث تطابق الفلتر.', 'No events match the filter.'), true), shown: 0, total: all.length };
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (S.audit.page > pages) S.audit.page = pages;
    const slice = rows.slice((S.audit.page - 1) * PAGE_SIZE, S.audit.page * PAGE_SIZE);
    const loc = en() ? 'en-GB' : 'ar-EG-u-nu-latn';
    const body = slice.map((r) => {
      const d = new Date(r.at);
      const when = isNaN(d) ? '—' : d.toLocaleString(loc, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      const full = isNaN(d) ? '' : d.toLocaleString(loc);
      const [aAr, aEn, tone] = AUDIT_ACTION[r.action] || [r.action, r.action, 'neutral'];
      const [kAr, kEn] = AUDIT_KIND[r.kind] || [r.kind, r.kind];
      return `<tr>
        <td data-label="${attr(L('الوقت', 'Time'))}" class="pr-nowrap"><bdi title="${attr(full)}">${esc(when)}</bdi></td>
        <td data-label="${attr(L('الموظف', 'Employee'))}"><span class="pr-strong" dir="auto">${esc(r.employee || '—')}</span></td>
        <td data-label="${attr(L('الإجراء', 'Action'))}"><span class="pr-pill is-tone-${tone}">${esc(L(aAr, aEn))}</span></td>
        <td data-label="${attr(L('النوع', 'Type'))}"><span class="pr-muted">${esc(L(kAr, kEn))}</span></td>
        <td data-label="${attr(L('العنصر', 'Item'))}"><span dir="auto">${esc(r.label || r.ref || '—')}</span>${r.txRef ? `<div class="pr-sub">#<bdi>${esc(r.txRef)}</bdi></div>` : ''}</td>
        <td data-label="${attr(L('المبلغ', 'Amount'))}" class="pr-c-num">${r.amount > 0 ? money(r.amount) : '<span class="pr-muted">—</span>'}</td>
        <td data-label="${attr(L('ملاحظة', 'Note'))}"><span class="pr-sub" dir="auto">${esc(r.reason || '')}</span></td>
      </tr>`;
    }).join('');
    const head = `<thead><tr><th>${esc(L('الوقت', 'Time'))}</th><th>${esc(L('الموظف', 'Employee'))}</th><th>${esc(L('الإجراء', 'Action'))}</th><th>${esc(L('النوع', 'Type'))}</th><th>${esc(L('العنصر', 'Item'))}</th><th class="pr-c-num">${esc(L('المبلغ', 'Amount'))}</th><th>${esc(L('ملاحظة', 'Note'))}</th></tr></thead>`;
    const pager = pages > 1 ? `<div class="pr-pager"><button type="button" class="pr-btn pr-btn-sm pr-btn-ghost" data-act="page" data-dir="-1"${S.audit.page <= 1 ? ' disabled' : ''}>${esc(L('السابق', 'Previous'))}</button><span>${esc(L(`صفحة ${fmtN(S.audit.page)} من ${fmtN(pages)}`, `Page ${fmtN(S.audit.page)} of ${fmtN(pages)}`))}</span><button type="button" class="pr-btn pr-btn-sm pr-btn-ghost" data-act="page" data-dir="1"${S.audit.page >= pages ? ' disabled' : ''}>${esc(L('التالي', 'Next'))}</button></div>` : '';
    const trunc = S.audit.truncated ? `<p class="pr-note">${esc(L(`تُعرض أحدث ${fmtN(all.length)} حدث من ${fmtN(S.audit.total)}.`, `Showing the latest ${fmtN(all.length)} of ${fmtN(S.audit.total)} events.`))}</p>` : '';
    return { html: `<div class="pr-tbl-wrap"><table class="pr-table pr-t-audit">${head}<tbody>${body}</tbody></table></div>${pager}${trunc}`, shown: rows.length, total: all.length };
  }

  function skeleton(n) {
    return `<div class="pr-skel" aria-busy="true" aria-label="${attr(L('جارٍ التحميل', 'Loading'))}">${Array.from({ length: n }, () => '<div class="pr-skel-row"><span></span><span></span><span></span><span></span></div>').join('')}</div>`;
  }

  // ── render entry points ──────────────────────────────────────────────────────────────────
  function render() {
    const host = root();
    if (!host) return;
    if (!promoPerm('view')) { host.innerHTML = ''; return; }
    if (S.tab === 'audit' && !promoPerm('audit')) S.tab = 'offers';
    host.innerHTML = shellHtml();
    drawTable();
  }
  function redrawChrome() {
    const sum = qs('#pr-sum'); if (sum) sum.innerHTML = summaryHtml();
    const tabs = qs('#pr-tabs'); if (tabs) tabs.innerHTML = tabsHtml();
  }
  /** Called after a write anywhere (the old render* names delegate here). */
  async function refresh(section, opts = {}) {
    if (typeof currentPage === 'undefined' || currentPage !== 'promotions' || !root()?.firstChild) return;
    if (opts.reload && (section === 'offers' || section === 'all')) await loadOffers();
    if (opts.reload && section === 'audit') await loadAudit();
    redrawChrome();
    if (section === 'all' || section === S.tab) drawTable();
  }
  function setTab(tab, push = true) {
    if (!TABS.includes(tab) || (tab === 'audit' && !promoPerm('audit'))) tab = 'offers';
    S.tab = tab;
    const panel = qs('#pr-panel');
    if (!panel) return render();
    qsa('#pr-tabs .pr-tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on); });
    // the primary action follows the tab
    const act = qs('.pr-head-act');
    if (act) {
      const pa = primaryAction();
      act.querySelector('.pr-btn-primary')?.remove();
      if (pa) act.insertAdjacentHTML('beforeend', `<button type="button" class="pr-btn pr-btn-primary" data-act="${pa.act}"${lockAttr(pa.ok)}>${ICO.plus}<span>${esc(pa.label)}</span></button>`);
    }
    panel.innerHTML = panelHtml();
    drawTable();
    if (tab === 'audit' && (S.audit.status === 'idle' || S.audit.status === 'error')) loadAudit().then(() => { if (S.tab === 'audit') drawTable(); });
    try { localStorage.setItem(typeof _colsPrefKey === 'function' ? _colsPrefKey('soulia_promo_tab') : 'soulia_promo_tab', tab); } catch (_) { /* per-user convenience only */ }
    if (push) {
      const h = tab === 'offers' ? '#promotions' : '#promotions/' + tab;
      if (location.hash !== h) history.replaceState(history.state, '', h);
    }
  }
  async function enter() {
    if (!promoPerm('view')) { if (typeof navigateTo === 'function') navigateTo(findFirstAllowedPage()); return; }
    const sub = location.hash.slice(1).split('/')[1];
    let saved = '';
    try { saved = localStorage.getItem(typeof _colsPrefKey === 'function' ? _colsPrefKey('soulia_promo_tab') : 'soulia_promo_tab') || ''; } catch (_) { /* ignore */ }
    S.tab = TABS.includes(sub) ? sub : (TABS.includes(saved) ? saved : 'offers');
    if (S.tab === 'audit' && !promoPerm('audit')) S.tab = 'offers';
    S.sel.clear();
    S.audit.status = 'idle';
    render();
    bind();
    await Promise.all([loadOffers(), refreshReference()]);
    if (currentPage !== 'promotions') return;
    redrawChrome();
    drawTable();
    if (S.tab === 'audit') { await loadAudit(); if (S.tab === 'audit') drawTable(); }
  }

  // ── actions ──────────────────────────────────────────────────────────────────────────────
  const offerById = (id) => S.offers.rows.find((o) => o.id === id);
  async function stopOffer(o, { silent } = {}) {
    await api('/products/' + encodeURIComponent(o.productId) + '/offers/' + encodeURIComponent(o.id) + '/end', { method: 'POST' });
    if (!silent) toast(o.status === 'upcoming' ? L('تم إلغاء العرض', 'Offer cancelled') : L('تم إيقاف العرض — تحتفظ المبيعات السابقة بسعره', 'Offer stopped — sales already made keep its price'));
  }
  async function onStop(id) {
    const o = offerById(id);
    if (!o || !requirePromoPerm('offers')) return;
    const upcoming = o.status === 'upcoming';
    const ok = await showConfirm(
      upcoming ? L(`لم يبدأ عرض «${o.reason || ''}» على ${o.productName} بعد — سيُلغى ولن يُطبَّق.`, `"${o.reason || ''}" on ${o.productName} has not started — it will be cancelled and never apply.`)
        : L(`يعود سعر ${o.productName} إلى ${fmtN(o.basePrice)} اعتباراً من اليوم، وتحتفظ المبيعات التي تمت بسعر العرض (${fmtN(o.price)}) بسعرها.`, `${o.productName} returns to ${fmtN(o.basePrice)} from today. Sales already made at the offer price (${fmtN(o.price)}) keep it.`),
      { title: upcoming ? L('إلغاء العرض', 'Cancel offer') : L('إيقاف العرض', 'Stop offer'), icon: 'warn', danger: true, confirmLabel: upcoming ? L('إلغاء العرض', 'Cancel offer') : L('إيقاف', 'Stop'), cancelLabel: L('رجوع', 'Back') });
    if (!ok) return;
    try { await stopOffer(o); } catch (e) { toast(e?.message || L('تعذّر الحفظ', 'Could not save'), true); }
    S.sel.delete(id);
    await loadOffers(); redrawChrome(); drawTable();
  }
  async function onStart(id) {
    const o = offerById(id);
    if (!o || o.status !== 'upcoming' || !requirePromoPerm('offers')) return;
    const ok = await showConfirm(L(`سيبدأ العرض اليوم بدلاً من ${_psDate(o.from)}، وينتهي في ${_psDate(o.to)} كما هو. سعر ${o.productName} في المبيعات الجديدة: ${fmtN(o.price)} بدلاً من ${fmtN(o.basePrice)}.`, `The offer starts today instead of ${_psDate(o.from)} and still ends ${_psDate(o.to)}. ${o.productName} sells at ${fmtN(o.price)} instead of ${fmtN(o.basePrice)} on new sales.`),
      { title: L('تفعيل العرض الآن', 'Start the offer now'), icon: 'info', confirmLabel: L('تفعيل الآن', 'Start now'), cancelLabel: L('رجوع', 'Back') });
    if (!ok) return;
    try {
      await api('/products/' + encodeURIComponent(o.productId) + '/offers/' + encodeURIComponent(o.id), { method: 'PATCH', body: JSON.stringify({ from: today() }) });
      toast(L('العرض ساري اعتباراً من اليوم', 'The offer is running from today'));
    } catch (e) { toast(e?.message || L('تعذّر الحفظ', 'Could not save'), true); }
    await loadOffers(); redrawChrome(); drawTable();
  }
  async function onBulkStop() {
    if (!requirePromoPerm('offers') || S.busy) return;
    const list = [...S.sel].map(offerById).filter((o) => o && (o.status === 'active' || o.status === 'upcoming'));
    if (!list.length) return;
    const running = list.filter((o) => o.status === 'active').length, upcoming = list.length - running;
    const ok = await showConfirm(L(`سيتوقف ${fmtN(running)} عرض ساري اعتباراً من اليوم${upcoming ? `، وسيُلغى ${fmtN(upcoming)} عرض قادم` : ''}. تحتفظ المبيعات السابقة بأسعار العروض.`, `${fmtN(running)} running offer(s) stop today${upcoming ? ` and ${fmtN(upcoming)} upcoming offer(s) are cancelled` : ''}. Sales already made keep their offer price.`),
      { title: L('إيقاف العروض المحددة', 'Stop selected offers'), icon: 'warn', danger: true, confirmLabel: L(`إيقاف ${fmtN(list.length)}`, `Stop ${fmtN(list.length)}`), cancelLabel: L('رجوع', 'Back'), lockDismiss: true });
    if (!ok) return;
    S.busy = true; drawBulk();
    const failed = [];
    for (const o of list) {
      try { await stopOffer(o, { silent: true }); S.sel.delete(o.id); } catch (e) { failed.push(`${o.productName}: ${e?.message || ''}`); }
    }
    S.busy = false;
    if (failed.length) toast(L(`أُوقف ${fmtN(list.length - failed.length)} وتعذّر إيقاف ${fmtN(failed.length)} — ${failed[0]}`, `${fmtN(list.length - failed.length)} stopped, ${fmtN(failed.length)} failed — ${failed[0]}`), true);
    else toast(L(`تم إيقاف ${fmtN(list.length)} عرض`, `${fmtN(list.length)} offer(s) stopped`));
    await loadOffers(); redrawChrome(); drawTable();
  }

  // ── offer dialog: new / edit / run again ─────────────────────────────────────────────────
  let OF = null;
  const DURATIONS = [[3, ['٣ أيام', '3 days']], [7, ['أسبوع', '1 week']], [14, ['أسبوعين', '2 weeks']], [30, ['شهر', '1 month']]];
  const PCTS = [10, 15, 20, 25, 30, 40];
  function openOfferDialog(init) {
    if (!requirePromoPerm('offers')) return;
    OF = { id: '', productId: '', price: '', from: today(), to: '', reason: '', started: false, q: '', busy: false, ...init };
    openModal(`<div class="pr-dlg" id="pr-dlg" role="dialog" aria-modal="true" aria-labelledby="pr-dlg-title"></div>`, 'max-width:640px;padding:0;overflow:hidden;max-height:none', { lockDismiss: true });
    drawOfferDialog();
    setTimeout(() => (OF.productId ? (OF.reason ? qs('#pr-of-price') : qs('#pr-of-reason')) : qs('#pr-of-q'))?.focus(), 40);
  }
  function ofProduct() { return (products || []).find((p) => p._id === OF.productId) || null; }
  function liveOfferOn(p) {
    return S.offers.rows.filter((o) => o.productId === p._id && (o.status === 'active' || o.status === 'upcoming') && o.id !== OF.id);
  }
  function productPickerHtml() {
    const q = OF.q.trim();
    const list = (products || []).filter((p) => p.isActive !== false && Number(p.sellPrice) > 0 && matches(q, p.name, p.code)).slice(0, q ? 12 : 8);
    return `<label class="pr-search pr-search-lg">${ICO.search}<input type="search" id="pr-of-q" value="${attr(OF.q)}" placeholder="${attr(L('ابحث عن الصنف بالاسم أو الكود…', 'Search product by name or code…'))}" aria-label="${attr(L('ابحث عن الصنف', 'Search product'))}" autocomplete="off"></label>
      <div class="pr-pick" role="listbox" aria-label="${attr(L('الأصناف', 'Products'))}">${list.length ? list.map((p) => {
        const live = liveOfferOn(p);
        return `<button type="button" role="option" class="pr-pick-row" data-act="of-pick" data-id="${attr(p._id)}">${thumb(productImage(p), p.name)}<span class="pr-pick-txt"><span class="pr-pick-name" dir="auto">${esc(p.name)}</span><bdi class="pr-mono">${esc(p.code || '')}</bdi></span><span class="pr-pick-side">${money(p.sellPrice)}${live.length ? `<span class="pr-pill is-${live[0].status}">${esc(live[0].status === 'active' ? L('عليه عرض سارٍ', 'On offer') : L('عرض قادم', 'Offer upcoming'))}</span>` : ''}</span></button>`;
      }).join('') : `<p class="pr-pick-empty">${esc(L('لا توجد أصناف مطابقة.', 'No matching products.'))}</p>`}</div>`;
  }
  function drawOfferDialog() {
    const host = qs('#pr-dlg');
    if (!host || !OF) return;
    const p = ofProduct();
    const base = Number(p?.sellPrice) || 0;
    const title = OF.id ? L('تعديل عرض السعر', 'Edit price offer') : L('عرض سعر جديد', 'New price offer');
    const others = p ? liveOfferOn(p) : [];
    const productBlock = p
      ? `<div class="pr-dlg-prod">${thumb(productImage(p), p.name)}<div class="pr-prod-txt"><span class="pr-strong" dir="auto">${esc(p.name)}</span><span class="pr-sub"><bdi class="pr-mono">${esc(p.code || '')}</bdi> · ${esc(L('السعر الأساسي', 'Base price'))} ${money(base)}</span></div>${OF.id ? '' : `<button type="button" class="pr-btn pr-btn-sm pr-btn-ghost" data-act="of-change">${esc(L('تغيير', 'Change'))}</button>`}</div>
         ${others.length ? `<p class="pr-dlg-warn">${esc(L(`يوجد على الصنف عرض ${others[0].status === 'active' ? 'سارٍ' : 'قادم'} من ${_psDate(others[0].from)} إلى ${_psDate(others[0].to)} — يجب أن يكون العرض الجديد في أيام أخرى.`, `It already has an ${others[0].status === 'active' ? 'running' : 'upcoming'} offer ${_psDate(others[0].from)} – ${_psDate(others[0].to)} — the new one must use other days.`))}</p>` : ''}`
      : productPickerHtml();
    const priceN = Number(OF.price);
    const off = priceN > 0 && base > 0 && priceN < base ? pct(priceN, base) : 0;
    const t0 = today();
    const form = p ? `
      <div class="pr-field">
        <span class="pr-label">${esc(L('اسم العرض', 'Offer name'))}</span>
        <div class="pr-reasons">${PO_REASONS.map((k) => `<button type="button" class="pr-chipbtn${OF.reason === t(k) ? ' is-on' : ''}" data-act="of-reason" data-key="${k}">${esc(t(k))}</button>`).join('')}</div>
        <input type="text" id="pr-of-reason" maxlength="200" value="${attr(OF.reason)}" placeholder="${attr(L('مثلاً: عرض نهاية الموسم', 'e.g. End of season'))}" aria-label="${attr(L('اسم العرض', 'Offer name'))}">
      </div>
      <div class="pr-field">
        <span class="pr-label">${esc(L('سعر العرض', 'Offer price'))}</span>
        <div class="pr-pricebox"><input type="number" id="pr-of-price" min="0" step="0.01" inputmode="decimal" value="${attr(OF.price)}" placeholder="${attr(L(`أقل من ${fmtN(base)}`, `Below ${fmtN(base)}`))}" aria-label="${attr(L('سعر العرض', 'Offer price'))}"><span class="pr-pricebox-off" id="pr-of-off">${off ? `<bdi dir="ltr">−${fmtN(off)}%</bdi>` : ''}</span></div>
        <div class="pr-quick" aria-label="${attr(L('خصم سريع', 'Quick discount'))}">${PCTS.map((v) => `<button type="button" class="pr-chipbtn" data-act="of-pct" data-val="${v}"><bdi dir="ltr">−${v}%</bdi></button>`).join('')}</div>
      </div>
      <div class="pr-field pr-dates">
        <label><span class="pr-label">${esc(L('من', 'From'))}</span><span class="dmy-date" data-dmy="${attr(_dmyText(OF.from))}"><input type="date" id="pr-of-from" class="sdp-input${OF.from ? ' has-value' : ''}" value="${attr(OF.from)}" min="${attr(OF.started ? OF.from : t0)}"${OF.started ? ' disabled' : ''}></span></label>
        <label><span class="pr-label">${esc(L('إلى', 'To'))}</span><span class="dmy-date" data-dmy="${attr(_dmyText(OF.to))}"><input type="date" id="pr-of-to" class="sdp-input${OF.to ? ' has-value' : ''}" value="${attr(OF.to)}" min="${attr(OF.from && OF.from > t0 ? OF.from : t0)}"></span></label>
        <div class="pr-quick">${DURATIONS.map(([n, [a, b]]) => `<button type="button" class="pr-chipbtn" data-act="of-dur" data-val="${n}">${esc(L(a, b))}</button>`).join('')}</div>
      </div>
      ${OF.started ? `<p class="pr-note">${esc(L('بدأ العرض بالفعل، فلا يمكن تغيير تاريخ بدايته — إذ بيعت بسعره أيام سابقة.', 'The offer has started, so its start is fixed — its past days were sold at its price.'))}</p>` : ''}
      <div class="pr-preview" id="pr-of-preview">${previewText(base)}</div>
      <div class="pr-err" id="pr-of-err" role="alert"></div>` : '';
    host.innerHTML = `<header class="pr-dlg-head"><h3 id="pr-dlg-title">${esc(title)}</h3><button type="button" class="pr-iconbtn" data-act="of-close" aria-label="${attr(L('إغلاق', 'Close'))}">${ICO.close}</button></header>
      <div class="pr-dlg-body">${productBlock}${form}</div>
      <footer class="pr-dlg-foot"><button type="button" class="pr-btn pr-btn-ghost" data-act="of-close">${esc(L('إلغاء', 'Cancel'))}</button><button type="button" class="pr-btn pr-btn-primary" data-act="of-save"${p && !OF.busy ? '' : ' disabled'}>${esc(OF.id ? L('حفظ التعديل', 'Save changes') : L('تشغيل العرض', 'Start offer'))}</button></footer>`;
  }
  function previewText(base) {
    const price = Number(OF.price);
    if (!(price > 0) || !OF.to) return esc(L('اختر السعر والتاريخ لعرض ملخص العرض.', 'Pick a price and dates to see the summary.'));
    if (base > 0 && price >= base) return `<span class="is-warn">${esc(L(`يجب أن يكون سعر العرض أقل من ${fmtN(base)}`, `The offer price must be below ${fmtN(base)}`))}</span>`;
    const days = daysBetween(OF.from, OF.to) + 1;
    return L(`سيُباع الصنف بسعر ${'@@P@@'} بدلاً من ${'@@B@@'} لمدة ${fmtN(days)} يوم (${_psDate(OF.from)} – ${_psDate(OF.to)}).`, `Sells at @@P@@ instead of @@B@@ for ${fmtN(days)} day(s) (${_psDate(OF.from)} – ${_psDate(OF.to)}).`)
      .split('@@P@@').map(esc).join(`<strong>${money(price)}</strong>`).replace(esc('@@B@@'), `<s>${money(base)}</s>`);
  }
  function syncOfferInputs() {
    if (!OF) return;
    const r = qs('#pr-of-reason'), pr = qs('#pr-of-price'), fr = qs('#pr-of-from'), to = qs('#pr-of-to');
    if (r) OF.reason = r.value;
    if (pr) OF.price = pr.value;
    if (fr && !OF.started) OF.from = fr.value;
    if (to) OF.to = to.value;
  }
  function liveOfferUpdate() {
    syncOfferInputs();
    const base = Number(ofProduct()?.sellPrice) || 0;
    const price = Number(OF.price);
    const offEl = qs('#pr-of-off');
    if (offEl) offEl.innerHTML = price > 0 && base > 0 && price < base ? `<bdi dir="ltr">−${fmtN(pct(price, base))}%</bdi>` : '';
    const pv = qs('#pr-of-preview'); if (pv) pv.innerHTML = previewText(base);
    const toEl = qs('#pr-of-to');
    if (toEl && OF.from) {
      toEl.min = OF.from > today() ? OF.from : today();
      if (toEl.value && toEl.value < toEl.min) { toEl.value = ''; OF.to = ''; toEl.classList.remove('has-value'); if (toEl.parentElement) toEl.parentElement.dataset.dmy = ''; }
    }
    qsa('#pr-dlg [data-act="of-reason"]').forEach((b) => b.classList.toggle('is-on', b.textContent.trim() === String(OF.reason).trim()));
  }
  async function saveOffer() {
    if (!OF || OF.busy || !requirePromoPerm('offers')) return;
    syncOfferInputs();
    const p = ofProduct();
    const err = (m) => { const el = qs('#pr-of-err'); if (el) el.textContent = m; };
    const price = Number(OF.price), reason = String(OF.reason || '').trim();
    if (!p) return err(L('اختر الصنف', 'Pick a product'));
    if (reason.length < 2) { qs('#pr-of-reason')?.focus(); return err(L('اكتب اسم العرض', 'Name the offer')); }
    if (!(price > 0)) { qs('#pr-of-price')?.focus(); return err(L('اكتب سعر العرض', 'Enter the offer price')); }
    if (!(price < Number(p.sellPrice))) { qs('#pr-of-price')?.focus(); return err(L(`يجب أن يكون سعر العرض أقل من ${fmtN(p.sellPrice)}`, `The offer price must be below ${fmtN(p.sellPrice)}`)); }
    if (!OF.from || !OF.to || OF.from > OF.to) { qs('#pr-of-to')?.focus(); return err(L('تواريخ العرض غير صحيحة — يجب أن يكون تاريخ البداية قبل تاريخ النهاية أو مساوياً له', 'Invalid dates — "From" must be on or before "To"')); }
    if (OF.to < today()) return err(L('تاريخ نهاية العرض في الماضي', 'The end date is in the past'));
    OF.busy = true;
    const btn = qs('#pr-dlg [data-act="of-save"]'); if (btn) btn.disabled = true;
    try {
      const url = '/products/' + encodeURIComponent(p._id) + '/offers' + (OF.id ? '/' + encodeURIComponent(OF.id) : '');
      const body = OF.id ? { price, to: OF.to, reason, ...(OF.started ? {} : { from: OF.from }) } : { price, from: OF.from, to: OF.to, reason };
      await api(url, { method: OF.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      toast(OF.id ? L('تم تعديل العرض', 'Offer updated') : L('تم إنشاء العرض', 'Offer created'));
      OF = null;
      closeModal();
      await loadOffers(); redrawChrome(); drawTable();
    } catch (e) {
      OF.busy = false;
      if (btn) btn.disabled = false;
      err(e?.message || L('تعذّر الحفظ', 'Could not save'));
    }
  }

  // ── event delegation ─────────────────────────────────────────────────────────────────────
  function setFilter(path, val) {
    const [tab, key] = path.split('.');
    if (!S.f[tab]) return;
    S.f[tab][key] = val;
    if (tab === 'audit') S.audit.page = 1;
    if (tab === 'offers' && key === 'status') S.sel.clear();
  }
  async function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act, id = el.dataset.id;
    // Inputs handled by change/input; checkboxes come through here as clicks.
    switch (act) {
      case 'tab': setTab(el.dataset.tab); break;
      case 'reload':
        el.classList.add('is-busy');
        await Promise.all([loadOffers(), refreshReference(), S.tab === 'audit' ? loadAudit() : null]);
        el.classList.remove('is-busy');
        redrawChrome(); drawTable();
        break;
      case 'go-products': e.preventDefault(); navigateTo('products'); break;
      case 'open-product': e.preventDefault(); if (typeof openProductPage === 'function') openProductPage(id); else navigateTo('products'); break;
      case 'seg': setFilter(el.dataset.key, el.dataset.val);
        el.parentElement.querySelectorAll('button').forEach((b) => { const on = b === el; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', on); });
        drawTable(); break;
      case 'reset-filters': {
        const keep = S.tab === 'offers' ? { q: '', status: 'all' } : Object.fromEntries(Object.keys(S.f[S.tab]).map((k) => [k, '']));
        S.f[S.tab] = keep; S.audit.page = 1;
        qs('#pr-panel').innerHTML = panelHtml(); drawTable(); break;
      }
      case 'sel': if (el.checked) S.sel.add(id); else S.sel.delete(id); el.closest('tr')?.classList.toggle('is-sel', el.checked); drawBulk();
        { const all = qs('#pr-tbl [data-act="sel-all"]'); if (all) { const live = filteredOffers().filter((o) => o.status === 'active' || o.status === 'upcoming'); all.checked = live.every((o) => S.sel.has(o.id)); } }
        break;
      case 'sel-all': { const live = filteredOffers().filter((o) => o.status === 'active' || o.status === 'upcoming'); live.forEach((o) => (el.checked ? S.sel.add(o.id) : S.sel.delete(o.id))); drawTable(); break; }
      case 'sel-clear': S.sel.clear(); drawTable(); break;
      case 'bulk-stop': onBulkStop(); break;
      case 'offer-new': openOfferDialog({}); break;
      case 'offer-stop': onStop(id); break;
      case 'offer-start': onStart(id); break;
      case 'offer-edit': { const o = offerById(id); if (o) openOfferDialog({ id: o.id, productId: o.productId, price: o.price, from: o.from, to: o.to, reason: o.reason || '', started: o.status === 'active' }); break; }
      case 'offer-reuse': { const o = offerById(id); if (o) openOfferDialog({ productId: o.productId, price: o.price, reason: o.reason || '' }); setTimeout(() => qs('#pr-of-to')?.focus(), 60); break; }
      case 'code-new': if (requirePromoPerm('codes')) openAddDiscountCodeModal(); break;
      case 'code-edit': openEditDiscountCodeModal(id); break;
      case 'code-toggle': { const c = (settings.discountCodes || []).find((x) => x.id === id); if (c) await toggleDiscountCodeActive(id, !c.active); break; }
      case 'code-delete': { const c = (settings.discountCodes || []).find((x) => x.id === id); if (c) await deleteDiscountCode(id, c.code); break; }
      case 'code-usage': showCodeUsageHistory(id); break;
      case 'bundle-new': if (requirePromoPerm('bundles')) openAddBundleModal(); break;
      case 'bundle-edit': openEditBundleModal(id); break;
      case 'bundle-toggle': { const b = (settings.discountBundles || []).find((x) => x.id === id); if (b) await toggleBundleActive(id, !b.active); break; }
      case 'bundle-delete': { const b = (settings.discountBundles || []).find((x) => x.id === id); if (b) await deleteDiscountBundle(id, b.name); break; }
      case 'tag-delete': { const tg = (masterTags || []).find((x) => String(x._id) === String(id)); if (tg) await deleteMasterTag(id, tg.name); break; }
      case 'audit-clear': await _clearBundleAuditLog(); break;
      case 'audit-reload': await loadAudit(); drawTable(); break;
      case 'page': S.audit.page = Math.max(1, S.audit.page + Number(el.dataset.dir)); drawTable(); qs('#pr-tbl')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); break;
      default: break;
    }
  }
  function onDialogClick(e) {
    const el = e.target.closest('#pr-dlg [data-act]');
    if (!el || el.disabled || !OF) return;
    const act = el.dataset.act;
    if (act === 'of-close') { OF = null; closeModal(); return; }
    if (act === 'of-save') { saveOffer(); return; }
    syncOfferInputs();
    if (act === 'of-pick') { OF.productId = el.dataset.id; drawOfferDialog(); setTimeout(() => qs('#pr-of-reason')?.focus(), 30); return; }
    if (act === 'of-change') { OF.productId = ''; drawOfferDialog(); setTimeout(() => qs('#pr-of-q')?.focus(), 30); return; }
    if (act === 'of-reason') { OF.reason = t(el.dataset.key); const r = qs('#pr-of-reason'); if (r) r.value = OF.reason; liveOfferUpdate(); qs('#pr-of-price')?.focus(); return; }
    if (act === 'of-pct') {
      const base = Number(ofProduct()?.sellPrice) || 0;
      OF.price = String(Math.round(base * (1 - Number(el.dataset.val) / 100) * 100) / 100);
      const pr = qs('#pr-of-price'); if (pr) pr.value = OF.price;
      liveOfferUpdate(); return;
    }
    if (act === 'of-dur') {
      const start = OF.from || today();
      OF.to = addDays(start, Number(el.dataset.val) - 1);
      const to = qs('#pr-of-to');
      if (to) { to.value = OF.to; to.classList.add('has-value'); if (to.parentElement?.classList.contains('dmy-date')) to.parentElement.dataset.dmy = _dmyText(OF.to); }
      liveOfferUpdate(); return;
    }
  }
  function onInput(e) {
    const f = e.target.dataset?.filter;
    if (f && e.target.closest('#promo-root')) { setFilter(f, e.target.value); drawTable(); return; }
    if (e.target.id === 'pr-of-q' && OF) {
      OF.q = e.target.value;
      const pick = qs('#pr-dlg .pr-pick');
      if (pick) { const tmp = document.createElement('div'); tmp.innerHTML = productPickerHtml(); pick.replaceWith(tmp.querySelector('.pr-pick')); }
      return;
    }
    if (e.target.closest?.('#pr-dlg')) liveOfferUpdate();
  }
  async function onChange(e) {
    const el = e.target;
    if (!el.closest) return;
    if (el.closest('#pr-dlg')) { liveOfferUpdate(); return; }
    if (!el.closest('#promo-root')) return;
    if (el.dataset.act === 'tag-cat') { await setMasterTagCategory(el.dataset.id, el.value); redrawChrome(); }
    else if (el.dataset.act === 'tag-color') await setTagColor(el.dataset.id, el.value);
  }
  async function setTagColor(id, bg) {
    if (!requirePromoPerm('tags')) return;
    try {
      const updated = await api('/tags/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ bg }) });
      const i = (masterTags || []).findIndex((tg) => String(tg._id) === String(id));
      if (i !== -1) masterTags[i] = updated;
      if (typeof _rebuildTagFilterRow === 'function') _rebuildTagFilterRow();
      toast(L('تم تحديث لون التاج', 'Tag colour updated'));
      drawTable();
    } catch (err) { toast((err?.message || ''), true); drawTable(); }
  }
  function onKey(e) {
    if (e.key === 'Enter' && e.target.id === 'new-master-tag-name') { e.preventDefault(); addMasterTag(); }
    if (e.key === 'Enter' && e.target.closest?.('#pr-dlg') && e.target.tagName === 'INPUT' && e.target.id !== 'pr-of-q') { e.preventDefault(); saveOffer(); }
  }
  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', (e) => {
      if (e.target.closest?.('#pr-dlg')) return onDialogClick(e);
      if (e.target.closest?.('#promo-root')) onClick(e);
    });
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey);
  }

  window.Promotions = { enter, render, refresh, tab: setTab, openOffer: openOfferDialog };
})();
