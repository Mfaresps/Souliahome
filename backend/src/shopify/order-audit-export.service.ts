import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import puppeteer, { Browser } from 'puppeteer';
import { AuditResult } from './order-audit.service';
import { BRAND, BRAND_ARGB, BRAND_FONT_STACK, SOULIA_LOGO_SVG } from '../shared/brand.constants';

@Injectable()
export class OrderAuditExportService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderAuditExportService.name);
  private browserPromise: Promise<Browser> | null = null;

  async onModuleDestroy(): Promise<void> {
    if (this.browserPromise) {
      try {
        const browser = await this.browserPromise;
        await browser.close();
      } catch (e) {
        this.logger.warn(`تعذر إغلاق puppeteer: ${(e as Error).message}`);
      }
    }
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      /* ⚠ Same rule as ReportsExportService: in the Alpine image Puppeteer's own
         Chromium is glibc-linked and cannot run on musl, so the Dockerfile
         installs the distro build and points PUPPETEER_EXECUTABLE_PATH at it.
         Unset locally, `undefined` is the default and the bundled browser is used. */
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
      this.browserPromise = puppeteer
        .launch({
          headless: true,
          executablePath,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
        })
        .catch((err) => {
          this.browserPromise = null;
          throw err;
        });
    }
    return this.browserPromise;
  }

  // ── Excel ─────────────────────────────────────────────────────────────────
  async buildExcel(r: AuditResult): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SOULIA';
    wb.created = new Date();
    wb.views = [{ rightToLeft: true } as unknown as ExcelJS.WorkbookView];

    // Sheet 1 — Summary KPIs
    const summary = wb.addWorksheet('الملخص', { views: [{ rightToLeft: true }] });
    summary.columns = [
      { header: 'المؤشر', key: 'k', width: 32 },
      { header: 'القيمة', key: 'v', width: 24 },
    ];
    styleHeader(summary);

    const summaryRows: Array<[string, string | number]> = [
      ['النطاق المفحوص', `#${r.from} → #${r.to}`],
      ['الأوردرات المتوقعة', r.sequence.expectedCount],
      ['الأوردرات المسجلة', r.sequence.registeredCount],
      ['الأوردرات المفقودة', r.sequence.missingCount],
      ['نسبة المزامنة', `${r.sequence.syncRate}%`],
      ['الأوردرات الملغاة', r.sequence.cancelledCount],
      ['بانتظار الموافقة', r.sequence.pendingCount],
      ['—', ''],
      ['إجمالي المبيعات', r.financials.totalSales],
      ['إجمالي تكلفة المنتجات', r.financials.totalProductCost],
      ['إجمالي تكلفة الشحن', r.financials.totalShippingCost],
      ['إجمالي الربح', r.financials.totalProfit],
      ['متوسط قيمة الأوردر', r.financials.avgOrderValue],
      ['هامش الربح', `${r.financials.profitMargin}%`],
      ['—', ''],
      ['متوسط تكلفة الشحن للأوردر', r.shipping.avgShippingCost],
      [
        'أعلى أوردر شحناً',
        r.shipping.highestOrder
          ? `#${r.shipping.highestOrder.orderNumber} — ${r.shipping.highestOrder.cost}`
          : '—',
      ],
      ['—', ''],
      [
        'أول أوردر',
        r.dateRange.firstOrder
          ? `#${r.dateRange.firstOrder.orderNumber} — ${r.dateRange.firstOrder.date} ${r.dateRange.firstOrder.time}`
          : '—',
      ],
      [
        'آخر أوردر',
        r.dateRange.lastOrder
          ? `#${r.dateRange.lastOrder.orderNumber} — ${r.dateRange.lastOrder.date} ${r.dateRange.lastOrder.time}`
          : '—',
      ],
      ['عدد الأيام', r.dateRange.durationDays],
      ['متوسط الأوردرات يومياً', r.dateRange.ordersPerDay],
      ['متوسط المبيعات يومياً', r.dateRange.salesPerDay],
    ];
    summaryRows.forEach(([k, v]) => summary.addRow({ k, v }));
    summary.getColumn('v').numFmt = NUM_FMT;
    summary.getColumn('k').font = { name: XL_FONT, size: 10, bold: true };
    styleBody(summary);
    summary.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];

    // Sheet 2 — Missing orders
    const missing = wb.addWorksheet('الأوردرات المفقودة', { views: [{ rightToLeft: true }] });
    missing.columns = [
      { header: 'رقم الأوردر', key: 'num', width: 14 },
      { header: 'موجود في Shopify', key: 'mirror', width: 18 },
      { header: 'تاريخ Shopify', key: 'date', width: 22 },
      { header: 'العميل', key: 'client', width: 24 },
      { header: 'القيمة', key: 'total', width: 14 },
      { header: 'السبب', key: 'reason', width: 46 },
      { header: 'تمت المراجعة', key: 'reviewed', width: 14 },
      { header: 'ملاحظة التحقيق', key: 'note', width: 40 },
    ];
    styleHeader(missing);
    r.missingOrders.forEach((m) =>
      missing.addRow({
        num: `#${m.orderNumber}`,
        mirror: m.existsInShopifyMirror ? 'نعم' : 'لا',
        date: xlDate(m.shopifyCreatedAt),
        client: m.client || '—',
        total: m.total || 0,
        reason: m.reason,
        reviewed: m.reviewed ? 'نعم' : 'لا',
        note: m.note || '',
      }),
    );
    missing.getColumn('total').numFmt = NUM_FMT;
    // Latin digits in the date mask too — Excel would otherwise render it per locale.
    missing.getColumn('date').numFmt = 'yyyy-mm-dd hh:mm';
    styleBody(missing);
    missing.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
    missing.autoFilter = { from: 'A1', to: 'H1' };

    // Sheet 3 — Full order detail
    const detail = wb.addWorksheet('تفاصيل الأوردرات', { views: [{ rightToLeft: true }] });
    detail.columns = [
      { header: 'رقم الأوردر', key: 'num', width: 13 },
      { header: 'تاريخ الإنشاء', key: 'date', width: 22 },
      { header: 'العميل', key: 'client', width: 22 },
      { header: 'الهاتف', key: 'phone', width: 16 },
      { header: 'حالة الأوردر', key: 'status', width: 16 },
      { header: 'حالة الدفع', key: 'pay', width: 14 },
      { header: 'المنتجات', key: 'products', width: 40 },
      { header: 'إجمالي الأوردر', key: 'total', width: 15 },
      { header: 'تكلفة المنتجات', key: 'cost', width: 15 },
      { header: 'تكلفة الشحن', key: 'ship', width: 14 },
      { header: 'صافي الربح', key: 'profit', width: 14 },
      { header: 'مسجل في سوليا', key: 'reg', width: 15 },
      { header: 'حالة المزامنة', key: 'sync', width: 16 },
    ];
    styleHeader(detail);
    r.rows.forEach((row) =>
      detail.addRow({
        num: `#${row.orderNumber}`,
        date: xlDate(row.shopifyCreatedAt),
        client: row.client || '—',
        phone: row.phone || '—',
        status: row.orderStatus || '—',
        pay: row.paymentStatus || '—',
        products: row.productsLabel || '—',
        total: row.orderTotal,
        cost: Math.round(row.productCost),
        ship: row.shippingCost,
        profit: Math.round(row.netProfit),
        reg: row.registered ? 'نعم' : 'لا',
        sync: row.syncLabel,
      }),
    );
    ['total', 'cost', 'ship', 'profit'].forEach((k) => (detail.getColumn(k).numFmt = NUM_FMT));
    detail.getColumn('date').numFmt = 'yyyy-mm-dd hh:mm';
    styleBody(detail);
    detail.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
    detail.autoFilter = { from: 'A1', to: 'M1' };

    // Sheet 4 — Shipping companies
    const ship = wb.addWorksheet('تحليل الشحن', { views: [{ rightToLeft: true }] });
    ship.columns = [
      { header: 'شركة الشحن', key: 'name', width: 26 },
      { header: 'عدد الأوردرات', key: 'orders', width: 16 },
      { header: 'إجمالي التكلفة', key: 'total', width: 18 },
      { header: 'متوسط التكلفة', key: 'avg', width: 18 },
    ];
    styleHeader(ship);
    r.shipping.companies.forEach((c) =>
      ship.addRow({ name: c.name, orders: c.orders, total: c.totalCost, avg: c.avgCost }),
    );
    ['total', 'avg'].forEach((k) => (ship.getColumn(k).numFmt = NUM_FMT));
    ship.getColumn('orders').numFmt = '#,##0';
    styleBody(ship);
    ship.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  async buildPdf(r: AuditResult): Promise<Buffer> {
    const html = renderAuditHtml(r);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.emulateMediaType('print');
      /* ⚠ The sheet links Cairo from Google Fonts, so an offline container has a
         request that never settles — `networkidle0` sat here for the whole
         timeout and then THREW, failing every export over a cosmetic font.
         Measured: 15s timeout vs ~0.5s here. The logo is inlined, so it does not
         depend on the network at all. */
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page
        .evaluate(
          () =>
            // Bounded: fonts.ready does not settle while a linked stylesheet is
            // in flight, so it needs its own ceiling.
            new Promise<void>((resolve) => {
              const done = () => resolve();
              setTimeout(done, 3000);
              (document as unknown as { fonts: FontFaceSet }).fonts.ready.then(done, done);
            }),
        )
        .catch(() => undefined);
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '14mm', bottom: '14mm', left: '10mm', right: '10mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/** The app font, named for Excel. See the note in reports-export.service.ts. */
const XL_FONT = 'Cairo';

/** Excel's number mask — fixed, so the digit shape cannot follow the reader's locale. */
const NUM_FMT = '#,##0';

/** ⚠ Always an explicit locale: a bare toLocaleString() follows the SERVER's, and
 *  'ar-EG' emits Arabic-Indic digits. */
const NUM_LOCALE = 'en-US';

/** `ج` was a single glyph reading as a letter beside Latin digits; the app's own
 *  `fmtJ` uses EGP, so the exports match it. */
const CURRENCY = 'EGP';

function styleHeader(ws: ExcelJS.Worksheet): void {
  const row = ws.getRow(1);
  row.font = { name: XL_FONT, bold: true, size: 11, color: { argb: BRAND_ARGB.white } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ARGB.primary } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 24;
  row.border = { bottom: { style: 'thin', color: { argb: BRAND_ARGB.accent } } };
}

/**
 * Body rows: app font + the brand tint as the zebra stripe.
 * ⚠ Call AFTER every row is added — it walks the sheet as it currently stands.
 */
function styleBody(ws: ExcelJS.Worksheet): void {
  ws.eachRow((row, n) => {
    if (n === 1) return;
    row.font = { name: XL_FONT, size: 10, color: { argb: BRAND_ARGB.ink } };
    row.alignment = { vertical: 'middle' };
    if (n % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ARGB.pale } };
    }
    row.border = { bottom: { style: 'hair', color: { argb: BRAND_ARGB.line } } };
  });
}

/** A money figure: Latin digits, separators, currency suffix. */
function fmt(n: number | undefined): string {
  return `${(Number(n) || 0).toLocaleString(NUM_LOCALE)} ${CURRENCY}`;
}

/** A plain count — no currency. Using `fmt` for one prints a stray 'EGP'. */
function fmtN(n: number | undefined): string {
  return (Number(n) || 0).toLocaleString(NUM_LOCALE);
}

/**
 * A Shopify timestamp for a spreadsheet cell.
 *
 * ⚠ `shopifyCreatedAt` is a raw ISO string ('2026-08-14T09:00:00Z'). Written
 * through, Excel stores it as TEXT — so the column cannot be sorted by date or
 * filtered by month, which is most of why anyone opens this sheet. It is
 * converted to a real Date; the caller sets the display mask.
 */
function xlDate(v: string | undefined): Date | string {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d;
}

/**
 * The report timestamp.
 * ⚠ Replaces `toLocaleString('ar-EG')`, which renders the date AND clock in
 * Arabic-Indic digits. `-u-nu-latn` pins the numbering system to Latin while
 * keeping Arabic month names and ordering. Do not drop it.
 */
function auditGeneratedAt(iso: string | Date): string {
  return new Date(iso).toLocaleString('ar-EG-u-nu-latn', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAuditHtml(r: AuditResult): string {
  /* ⚠ Colour is semantic here, and the ONE red is load-bearing: «المفقودة» is the
     number this whole report exists to surface. The old set painted all four in
     unrelated hues (#0066cc/#10b981/#ef4444/#f59e0b) from no palette in the
     product, which buried the one figure that matters among three equals. */
  const kpis = [
    { label: 'الأوردرات المتوقعة', value: fmtN(r.sequence.expectedCount), color: BRAND.primary },
    { label: 'الأوردرات المسجلة', value: fmtN(r.sequence.registeredCount), color: BRAND.accent },
    { label: 'الأوردرات المفقودة', value: fmtN(r.sequence.missingCount), color: BRAND.red },
    { label: 'نسبة المزامنة', value: `${r.sequence.syncRate}%`, color: BRAND.primary },
  ]
    .map(
      (k) => `<div class="kpi" style="border-top:3px solid ${k.color}">
        <div class="kpi-l">${k.label}</div>
        <div class="kpi-v" style="color:${k.color}">${k.value}</div>
      </div>`,
    )
    .join('');

  const finCards = [
    { label: 'إجمالي المبيعات', value: fmt(r.financials.totalSales) },
    { label: 'تكلفة المنتجات', value: fmt(r.financials.totalProductCost) },
    { label: 'تكلفة الشحن', value: fmt(r.financials.totalShippingCost) },
    { label: 'إجمالي الربح', value: fmt(r.financials.totalProfit) },
    { label: 'متوسط قيمة الأوردر', value: fmt(r.financials.avgOrderValue) },
    { label: 'هامش الربح', value: `${r.financials.profitMargin}%` },
  ]
    .map(
      (c) => `<div class="fin"><div class="fin-l">${c.label}</div><div class="fin-v">${c.value}</div></div>`,
    )
    .join('');

  const missingChips = r.missingOrders.length
    ? r.missingOrders.map((m) => `<span class="chip">#${escapeHtml(m.orderNumber)}</span>`).join('')
    : '<span class="ok">لا توجد أوردرات مفقودة — التسلسل مكتمل ✅</span>';

  const shipRows = r.shipping.companies
    .map(
      (c) => `<tr>
      <td class="name">${escapeHtml(c.name)}</td>
      <td class="num">${fmtN(c.orders)}</td>
      <td class="num">${fmt(c.totalCost)}</td>
      <td class="num">${fmt(c.avgCost)}</td>
    </tr>`,
    )
    .join('');

  const detailRows = r.rows
    .slice(0, 400)
    .map(
      (row) => `<tr class="${row.registered ? '' : 'miss'}">
      <td>#${escapeHtml(row.orderNumber)}</td>
      <td>${escapeHtml((row.shopifyCreatedAt || '—').slice(0, 10))}</td>
      <td class="name">${escapeHtml(row.client || '—')}</td>
      <td>${escapeHtml(row.orderStatus || '—')}</td>
      <td class="num">${fmt(row.orderTotal)}</td>
      <td class="num">${fmt(row.productCost)}</td>
      <td class="num">${fmt(row.shippingCost)}</td>
      <td class="num ${row.netProfit >= 0 ? 'pos' : 'neg'}">${fmt(row.netProfit)}</td>
      <td>${escapeHtml(row.syncLabel)}</td>
    </tr>`,
    )
    .join('');

  const first = r.dateRange.firstOrder;
  const last = r.dateRange.lastOrder;

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>Order Range Audit</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  @page{size:A4 portrait}
  *{box-sizing:border-box}
  /* ⚠ Declare the ground. page.pdf() runs with printBackground:true and paints
     whatever body declares — an undeclared background is TRANSPARENT, not white,
     so any dark-backed viewer shows through and the light rows become unreadable. */
  body{font-family:${BRAND_FONT_STACK};background:#fff;margin:0;padding:0;color:${BRAND.ink};font-size:11px}

  /* ── Header ─────────────────────────────────────────────────────────────*/
  .hdr{display:flex;justify-content:space-between;align-items:flex-end;
       border-bottom:2.5px solid ${BRAND.primary};padding-bottom:11px;margin-bottom:14px}
  /* The wordmark is an inline <svg> whose single fill is 'currentColor'.
     ⚠ Cap the width as well as the height — the viewBox is ~3.5:1, so a height
     alone lets it run to the trim edge and clip its last glyph. */
  .brand-logo{color:${BRAND.primary};display:block}
  .brand-logo svg{height:28px;width:auto;max-width:140px;display:block}
  h1{font-size:17px;margin:6px 0 0;color:${BRAND.primary};font-weight:800;letter-spacing:.2px}
  .h1-ar{font-size:10.5px;color:${BRAND.muted};font-weight:600;margin-top:2px}
  .scope{background:${BRAND.pale};color:${BRAND.primary};border:1px solid ${BRAND.line};
         border-radius:6px;padding:7px 12px;font-weight:700;font-size:10.5px;text-align:center}
  .scope .scope-n{font-variant-numeric:tabular-nums;direction:ltr;display:inline-block}
  .scope-when{display:block;color:${BRAND.muted};font-weight:600;font-size:9px;margin-top:3px}

  h2{font-size:13px;margin:18px 0 8px;padding-bottom:5px;
     border-bottom:2px solid ${BRAND.accent};color:${BRAND.primary};font-weight:700}
  .sub{color:${BRAND.muted};font-size:11px;margin-bottom:14px}
  .kpis{display:flex;gap:8px;margin-bottom:6px}
  .kpi{flex:1;background:${BRAND.surface};border:1px solid ${BRAND.line};border-radius:6px;padding:9px;text-align:center}
  .kpi-l{color:${BRAND.muted};font-size:9.5px;margin-bottom:3px;font-weight:600}
  .kpi-v{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
  .fins{display:flex;flex-wrap:wrap;gap:8px}
  .fin{flex:1 1 30%;background:${BRAND.surface};border:1px solid ${BRAND.line};border-radius:6px;padding:8px 10px}
  .fin-l{color:${BRAND.muted};font-size:9.5px;font-weight:600}
  .fin-v{font-size:13px;font-weight:700;color:${BRAND.ink};margin-top:2px;font-variant-numeric:tabular-nums}
  .chip{display:inline-block;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;border-radius:5px;padding:3px 8px;margin:2px;font-weight:700;font-size:10.5px}
  .ok{color:${BRAND.accent};font-weight:700}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  /* Repeat the header on every sheet — the detail table runs to 400 rows and
     headerless columns on page 2 cannot be identified. */
  thead{display:table-header-group}
  tr{page-break-inside:avoid}
  th{background:${BRAND.primary};color:#fff;padding:7px 5px;text-align:right;font-size:10px;font-weight:700}
  td{padding:5px;border-bottom:1px solid ${BRAND.line};font-size:10px}
  tr:nth-child(even) td{background:${BRAND.surface}}
  /* A missing order must stay visibly red even on an even (tinted) row, so this
     comes after the zebra rule and wins on source order. */
  tr.miss td{background:#fef2f2}
  /* ⚠ 'direction:ltr' is what keeps '1,679' from re-ordering inside an RTL row.
     Never "fix" a mis-rendered figure by reversing the string. */
  .num{text-align:left;direction:ltr;font-variant-numeric:tabular-nums}
  .name{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pos{color:${BRAND.accent};font-weight:700}.neg{color:${BRAND.red};font-weight:700}
  .dates{display:flex;gap:8px}
  .dbox{flex:1;background:${BRAND.surface};border:1px solid ${BRAND.line};border-radius:6px;padding:9px}
  .foot{margin-top:16px;color:${BRAND.muted};font-size:9px;text-align:center;border-top:1px solid ${BRAND.line};padding-top:7px}
</style></head><body>
  <div class="hdr">
    <div>
      <div class="brand-logo">${SOULIA_LOGO_SVG}</div>
      <h1>Order Range Audit</h1>
      <div class="h1-ar">تقرير تدقيق نطاق الأوردرات</div>
    </div>
    <div class="scope">
      <span class="scope-n">#${r.from} → #${r.to}</span>
      <span class="scope-when">${escapeHtml(auditGeneratedAt(r.generatedAt))}</span>
    </div>
  </div>

  <div class="kpis">${kpis}</div>

  <h2>الأوردرات المفقودة (${r.missingOrders.length})</h2>
  <div>${missingChips}</div>

  <h2>التحليل المالي</h2>
  <div class="fins">${finCards}</div>

  <h2>تحليل الشحن</h2>
  <div class="fins">
    <div class="fin"><div class="fin-l">إجمالي تكلفة الشحن</div><div class="fin-v">${fmt(r.shipping.totalShippingCost)}</div></div>
    <div class="fin"><div class="fin-l">متوسط التكلفة للأوردر</div><div class="fin-v">${fmt(r.shipping.avgShippingCost)}</div></div>
    <div class="fin"><div class="fin-l">أعلى أوردر شحناً</div><div class="fin-v">${
      r.shipping.highestOrder
        ? `#${escapeHtml(r.shipping.highestOrder.orderNumber)} — ${fmt(r.shipping.highestOrder.cost)}`
        : '—'
    }</div></div>
  </div>
  ${
    shipRows
      ? `<table><thead><tr><th>شركة الشحن</th><th>عدد الأوردرات</th><th>إجمالي التكلفة</th><th>متوسط التكلفة</th></tr></thead><tbody>${shipRows}</tbody></table>`
      : ''
  }

  <h2>تحليل الفترة الزمنية</h2>
  <div class="dates">
    <div class="dbox"><div class="fin-l">أول أوردر</div><div class="fin-v">${
      first ? `#${escapeHtml(first.orderNumber)} — ${first.date} ${first.time}` : '—'
    }</div></div>
    <div class="dbox"><div class="fin-l">آخر أوردر</div><div class="fin-v">${
      last ? `#${escapeHtml(last.orderNumber)} — ${last.date} ${last.time}` : '—'
    }</div></div>
  </div>
  <div class="fins" style="margin-top:8px">
    <div class="fin"><div class="fin-l">عدد الأيام</div><div class="fin-v">${fmtN(r.dateRange.durationDays)}</div></div>
    <div class="fin"><div class="fin-l">متوسط الأوردرات يومياً</div><div class="fin-v">${fmtN(r.dateRange.ordersPerDay)}</div></div>
    <div class="fin"><div class="fin-l">متوسط المبيعات يومياً</div><div class="fin-v">${fmt(r.dateRange.salesPerDay)}</div></div>
  </div>

  <h2>تفاصيل الأوردرات</h2>
  <table>
    <thead><tr>
      <th>رقم</th><th>التاريخ</th><th>العميل</th><th>الحالة</th>
      <th>الإجمالي</th><th>التكلفة</th><th>الشحن</th><th>الربح</th><th>المزامنة</th>
    </tr></thead>
    <tbody>${detailRows}</tbody>
  </table>
  ${r.rows.length > 400 ? `<div class="sub" style="margin-top:6px">تم عرض أول 400 أوردر من ${fmtN(r.rows.length)} — استخدم تصدير Excel للتفاصيل الكاملة</div>` : ''}

  <div class="foot">SOULIA Warehouse Management System &nbsp;•&nbsp; Order Range Audit</div>
</body></html>`;
}
