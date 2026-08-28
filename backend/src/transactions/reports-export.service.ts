import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import puppeteer, { Browser } from 'puppeteer';
import { BRAND, BRAND_ARGB, BRAND_FONT_STACK, SOULIA_LOGO_SVG } from '../shared/brand.constants';

interface ReportShape {
  totalSales?: number;
  totalPurchases?: number;
  totalDeposit?: number;
  totalRemaining?: number;
  grossProfit?: number;
  netProfit?: number;
  expenseTotal?: number;
  totalShipping?: number;
  totalShipLoss?: number;
  totalReturns?: number;
  returnCount?: number;
  transactionCount?: number;
  orderCount?: number;
  avgOrderValue?: number;
  bestSellingProduct?: { name: string; qty: number; revenue: number } | null;
  productProfits?: Array<{ name: string; qty: number; rev: number; cost: number; profit: number }>;
  topCustomers?: Array<{ name: string; orders: number; revenue: number }>;
  series?: Array<{ date: string; sales: number; purchases: number; orders: number }>;
  from?: string;
  to?: string;
}

/**
 * The face Excel is asked to use.
 *
 * ⚠ Excel resolves a font by NAME against what the reader's machine has — it
 * cannot be embedded from here. 'Cairo' is the app font (`--font-app`) and is a
 * free Google font, so a machine that has it gets the real thing; everything
 * else falls back through Excel's own substitution, which is why the cells are
 * explicitly styled rather than left on the Calibri default that renders
 * Arabic in a face the product never uses.
 */
const XL_FONT = 'Cairo';

@Injectable()
export class ReportsExportService implements OnModuleDestroy {
  private readonly logger = new Logger(ReportsExportService.name);
  private browserPromise: Promise<Browser> | null = null;

  async onModuleDestroy(): Promise<void> {
    if (this.browserPromise) {
      try {
        const browser = await this.browserPromise;
        await browser.close();
      } catch (e) {
        this.logger.warn(`Failed to close puppeteer browser: ${(e as Error).message}`);
      }
    }
  }

  /** Lazy-init a single shared headless browser so PDF generation reuses the process. */
  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      /* ⚠ In the Alpine image Puppeteer's own bundled Chromium is glibc-linked and
         cannot run on musl, so the Dockerfile installs the distro build and sets
         PUPPETEER_EXECUTABLE_PATH at it. Left unset (local dev on Windows/macOS),
         `executablePath: undefined` is exactly the default and Puppeteer uses the
         browser it downloaded — so this one line covers both environments. */
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

  async buildExcel(report: ReportShape): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SOULIA';
    wb.created = new Date();
    wb.views = [{ rightToLeft: true } as unknown as ExcelJS.WorkbookView];

    const periodLabel = formatPeriodLabel(report.from, report.to);
    const summary = wb.addWorksheet('الملخص', { views: [{ rightToLeft: true }] });
    summary.columns = [
      { header: 'المؤشر', key: 'k', width: 28 },
      { header: 'القيمة', key: 'v', width: 22 },
    ];
    styleHeader(summary);

    const rows: Array<[string, number | string]> = [
      ['الفترة', periodLabel],
      ['عدد المعاملات', report.transactionCount ?? 0],
      ['عدد فواتير المبيعات', report.orderCount ?? 0],
      ['إجمالي المبيعات', report.totalSales ?? 0],
      ['إجمالي المشتريات', report.totalPurchases ?? 0],
      ['متوسط قيمة الفاتورة', report.avgOrderValue ?? 0],
      ['الربح الإجمالي', report.grossProfit ?? 0],
      ['المصاريف', report.expenseTotal ?? 0],
      ['الربح الصافي', report.netProfit ?? 0],
      ['المحصل من العملاء', report.totalDeposit ?? 0],
      ['المتبقي على العملاء', report.totalRemaining ?? 0],
      ['الشحن المحصل', report.totalShipping ?? 0],
      ['فرق الشحن', report.totalShipLoss ?? 0],
      ['عدد المرتجعات', report.returnCount ?? 0],
      ['إجمالي المرتجعات', report.totalReturns ?? 0],
      [
        'الأكثر مبيعاً',
        report.bestSellingProduct
          ? `${report.bestSellingProduct.name} (${report.bestSellingProduct.qty})`
          : '—',
      ],
    ];
    rows.forEach(([k, v]) => summary.addRow({ k, v }));
    // English digits with thousands separators — the report is read as figures,
    // and Excel's own locale would otherwise decide the digit shape per machine.
    summary.getColumn('v').numFmt = NUM_FMT;
    summary.getColumn('k').font = { name: XL_FONT, size: 10, bold: true };
    styleBody(summary);
    summary.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];

    const products = wb.addWorksheet('الأصناف', { views: [{ rightToLeft: true }] });
    products.columns = [
      { header: '#', key: 'i', width: 6 },
      { header: 'الصنف', key: 'name', width: 30 },
      { header: 'الكمية', key: 'qty', width: 10 },
      { header: 'الإيراد', key: 'rev', width: 14 },
      { header: 'التكلفة', key: 'cost', width: 14 },
      { header: 'الربح', key: 'profit', width: 14 },
      { header: 'الهامش %', key: 'margin', width: 10 },
    ];
    styleHeader(products);
    (report.productProfits || []).forEach((p, idx) => {
      const margin = p.rev > 0 ? Number(((p.profit / p.rev) * 100).toFixed(1)) : 0;
      products.addRow({
        i: idx + 1,
        name: p.name,
        qty: p.qty,
        rev: p.rev,
        cost: p.cost,
        profit: p.profit,
        margin,
      });
    });
    ['rev', 'cost', 'profit'].forEach((k) => (products.getColumn(k).numFmt = NUM_FMT));
    products.getColumn('qty').numFmt = '#,##0';
    products.getColumn('margin').numFmt = '0.0"%"';
    styleBody(products);
    products.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
    products.autoFilter = { from: 'A1', to: 'G1' };

    const customers = wb.addWorksheet('العملاء', { views: [{ rightToLeft: true }] });
    customers.columns = [
      { header: '#', key: 'i', width: 6 },
      { header: 'العميل', key: 'name', width: 30 },
      { header: 'عدد الفواتير', key: 'orders', width: 14 },
      { header: 'الإيراد', key: 'revenue', width: 16 },
    ];
    styleHeader(customers);
    (report.topCustomers || []).forEach((c, idx) =>
      customers.addRow({ i: idx + 1, name: c.name, orders: c.orders, revenue: c.revenue }),
    );
    customers.getColumn('revenue').numFmt = NUM_FMT;
    customers.getColumn('orders').numFmt = '#,##0';
    styleBody(customers);
    customers.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];

    if (report.series && report.series.length) {
      const trend = wb.addWorksheet('التدفق اليومي', { views: [{ rightToLeft: true }] });
      trend.columns = [
        { header: 'التاريخ', key: 'date', width: 14 },
        { header: 'الفواتير', key: 'orders', width: 12 },
        { header: 'المبيعات', key: 'sales', width: 16 },
        { header: 'المشتريات', key: 'purchases', width: 16 },
      ];
      styleHeader(trend);
      report.series.forEach((s) =>
        trend.addRow({ date: s.date, orders: s.orders, sales: s.sales, purchases: s.purchases }),
      );
      ['sales', 'purchases'].forEach((k) => (trend.getColumn(k).numFmt = NUM_FMT));
      trend.getColumn('orders').numFmt = '#,##0';
      styleBody(trend);
      trend.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
    }

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async buildPdf(report: ReportShape): Promise<Buffer> {
    const html = renderReportHtml(report);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.emulateMediaType('print');
      /* ⚠ The sheet links Cairo from Google Fonts, so an offline container has
         one request that can never settle. `networkidle0` would then sit here
         for the full timeout on EVERY export and finally throw — turning a
         cosmetic font fallback into a hard failure. `domcontentloaded` returns
         as soon as the markup is parsed; the short wait below gives the font a
         chance to arrive when the network IS there, and is simply spent when it
         is not. The logo does not depend on either: it is inlined. */
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page
        .evaluate(
          () =>
            // Bounded: `fonts.ready` does not settle while a linked stylesheet is
            // still in flight, so it needs its own ceiling rather than inheriting
            // the 30s page timeout.
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
        margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/**
 * Header band for a sheet: SOULIA's own deep green, not the generic `#16a34a`
 * that was here before and appears nowhere in the product.
 *
 * The font is named explicitly because ExcelJS otherwise leaves the cells on
 * the workbook default (Calibri), which renders Arabic in a face the app never
 * uses. `BRAND_FONT` is the app's Cairo with a Latin fallback Excel can resolve.
 */
function styleHeader(ws: ExcelJS.Worksheet): void {
  const row = ws.getRow(1);
  row.font = { name: XL_FONT, bold: true, size: 11, color: { argb: BRAND_ARGB.white } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ARGB.primary } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 24;
  row.border = { bottom: { style: 'thin', color: { argb: BRAND_ARGB.accent } } };
}

/**
 * Body rows: the app font, and the brand's pale tint as the zebra stripe.
 *
 * ⚠ Call this AFTER every row has been added — it walks the sheet as it stands,
 * so styling a sheet that is still being filled leaves the later rows unstyled.
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

/**
 * Every number in a generated document is formatted through here or `fmtN`.
 *
 * ⚠ ALWAYS pass an explicit 'en-US' locale. `toLocaleString()` with no locale
 * follows the SERVER's, and `'ar-EG'` emits Arabic-Indic digits (٠-٩) — the
 * recurring trap in this codebase (see the invoice and the archive export). The
 * figures on this report are meant to be read and re-keyed, so they are Latin
 * digits everywhere, on both the Arabic and the English side of the sheet.
 */
const NUM_LOCALE = 'en-US';

/** Excel's own number mask. Same reasoning: it must not follow the reader's locale. */
const NUM_FMT = '#,##0';

/** The currency, written out. `ج` is a single glyph that reads as a letter beside
 *  Latin digits and does not survive a copy-paste into a spreadsheet; the app's
 *  own `fmtJ` uses `EGP`, so the exports now match it. */
const CURRENCY = 'EGP';

function formatPeriodLabel(from?: string, to?: string): string {
  if (!from && !to) return 'كل الفترات';
  if (from && to) return `${from} → ${to}`;
  if (from) return `من ${from}`;
  return `حتى ${to}`;
}

/** A money figure: Latin digits, thousands separators, currency suffix. */
function fmt(n: number | undefined): string {
  const v = Number(n) || 0;
  return `${v.toLocaleString(NUM_LOCALE)} ${CURRENCY}`;
}

/** A plain count — no currency. Using `fmt` for one prints a stray 'EGP'. */
function fmtN(n: number | undefined): string {
  return (Number(n) || 0).toLocaleString(NUM_LOCALE);
}

/**
 * The generation timestamp on the footer.
 *
 * ⚠ This replaced a bare `new Date().toLocaleString('ar-EG')`, which renders
 * BOTH the date and the clock in Arabic-Indic digits (٢٨/٠٨/٢٠٢٦) — the same
 * trap documented for the invoice and the archive export. `-u-nu-latn` is the
 * Unicode extension that pins the numbering system to Latin while keeping the
 * Arabic month names and ordering. Do not drop it.
 */
function generatedAt(): string {
  return new Date().toLocaleString('ar-EG-u-nu-latn', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderReportHtml(r: ReportShape): string {
  const period = formatPeriodLabel(r.from, r.to);
  const best = r.bestSellingProduct
    ? `${escapeHtml(r.bestSellingProduct.name)} <span class="muted">— ${fmtN(r.bestSellingProduct.qty)} قطعة</span>`
    : '—';
  const productRows = (r.productProfits || [])
    .slice(0, 25)
    .map((p, i) => {
      const margin = p.rev > 0 ? ((p.profit / p.rev) * 100).toFixed(1) : '0.0';
      return `<tr>
        <td>${i + 1}</td>
        <td class="name">${escapeHtml(p.name)}</td>
        <td class="num">${fmtN(p.qty)}</td>
        <td class="num">${fmt(p.rev)}</td>
        <td class="num">${fmt(p.cost)}</td>
        <td class="num pos">${fmt(p.profit)}</td>
        <td class="num">${margin}%</td>
      </tr>`;
    })
    .join('');
  const customerRows = (r.topCustomers || [])
    .slice(0, 10)
    .map(
      (c, i) => `<tr>
        <td>${i + 1}</td>
        <td class="name">${escapeHtml(c.name)}</td>
        <td class="num">${fmtN(c.orders)}</td>
        <td class="num">${fmt(c.revenue)}</td>
      </tr>`,
    )
    .join('');

  /* ── KPI palette ──────────────────────────────────────────────────────
     Eight cards previously carried eight unrelated hues (#10b981, #6d28d9,
     #0891b2, #f59e0b …) drawn from no palette in the product — so the sheet
     read as a rainbow and nothing about the colour meant anything.

     Colour here is SEMANTIC, matching the reports page: the brand green is the
     default and carries the figures that are simply "the business", while the
     three that describe money leaving or owed keep a distinct accent. Money in
     and money out must never share a hue on a financial sheet. */
  const kpiCards = [
    { label: 'إجمالي المبيعات', value: fmt(r.totalSales), color: BRAND.primary },
    { label: 'الربح الصافي', value: fmt(r.netProfit), color: BRAND.accent },
    { label: 'عدد الفواتير', value: fmtN(r.orderCount), color: BRAND.primary },
    { label: 'متوسط الفاتورة', value: fmt(r.avgOrderValue), color: BRAND.primary },
    { label: 'إجمالي المشتريات', value: fmt(r.totalPurchases), color: BRAND.blue },
    { label: 'المصاريف', value: fmt(r.expenseTotal), color: BRAND.red },
    { label: 'المرتجعات', value: `${fmtN(r.returnCount)} • ${fmt(r.totalReturns)}`, color: BRAND.orange },
    { label: 'المتبقي على العملاء', value: fmt(r.totalRemaining), color: BRAND.orange },
  ]
    .map(
      (k) => `<div class="kpi" style="border-top:3px solid ${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value" style="color:${k.color}">${k.value}</div>
    </div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>تقرير الأداء</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  /* ── A4 geometry ──────────────────────────────────────────────────────
     page.pdf() supplies the margins, so @page only declares the sheet. */
  @page { size: A4 portrait; }
  * { box-sizing: border-box; }

  /* The app's own font. Cairo is --font-app in index.html; the link above
     fetches it when the container has network, and the stack falls through to
     a real Arabic face otherwise — Chromium ships none of its own. */
  /* ⚠ State the ground explicitly. page.pdf() runs with printBackground:true, so
     it paints whatever the body declares — and an undeclared background is
     TRANSPARENT, not white. Any viewer or compositor with a dark backdrop then
     shows the sheet through it and the light zebra rows become unreadable. */
  body { font-family:${BRAND_FONT_STACK}; background:#fff; color:${BRAND.ink};
         margin:0; padding:0; font-size:12px; line-height:1.45; }

  /* ── Latin digits, everywhere ─────────────────────────────────────────
     Belt and braces for the figures: every number is already formatted with an
     explicit 'en-US' locale in JS, and this keeps a font's own Arabic-Indic
     substitution from re-shaping them at render. */
  .num, .kpi-value, td.num, .period, .footer { font-variant-numeric: tabular-nums; }

  /* ── Header ───────────────────────────────────────────────────────────*/
  .header { display:flex; justify-content:space-between; align-items:flex-end;
            border-bottom:2.5px solid ${BRAND.primary}; padding-bottom:12px; margin-bottom:18px; }
  /* The wordmark is an inline <svg> whose single fill is 'currentColor', so this
     one declaration paints it. Sized by height — the viewBox is 2000x576. */
  /* ⚠ Cap the WIDTH as well as the height. The viewBox is 2000x576 (~3.5:1), so
     a height alone lets the wordmark run to the trim edge and clip — it lost its
     last glyph before this. max-width keeps it inside the header's own column. */
  .brand-logo { color:${BRAND.primary}; display:block; }
  .brand-logo svg { height:30px; width:auto; max-width:150px; display:block; }
  .subtitle { color:${BRAND.muted}; font-size:11px; margin-top:5px; font-weight:600; }
  .period { background:${BRAND.pale}; color:${BRAND.primary}; padding:7px 13px;
            border-radius:6px; font-weight:700; font-size:11px; border:1px solid ${BRAND.line}; }

  h2 { font-size:14px; margin:18px 0 8px; color:${BRAND.primary};
       border-right:4px solid ${BRAND.accent}; padding-right:9px; font-weight:700; }

  /* ── KPI grid ─────────────────────────────────────────────────────────*/
  .kpi-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin-bottom:6px; }
  .kpi { background:${BRAND.surface}; border:1px solid ${BRAND.line};
         border-radius:8px; padding:10px 12px; }
  .kpi-label { font-size:10px; color:${BRAND.muted}; margin-bottom:4px; font-weight:600; }
  .kpi-value { font-size:14px; font-weight:700; }

  .best-card { background:${BRAND.pale}; border:1px solid ${BRAND.line}; border-radius:8px;
               padding:12px 16px; margin:10px 0 6px; display:flex;
               justify-content:space-between; align-items:center; }
  .best-card .label { color:${BRAND.primary}; font-weight:700; font-size:11px; }
  .best-card .value { font-size:13px; font-weight:700; color:${BRAND.ink}; }

  /* ── Tables ───────────────────────────────────────────────────────────*/
  table { width:100%; border-collapse:collapse; font-size:11px; }
  /* Repeat the header on every sheet — a long product table spills onto page 2,
     and headerless rows there cannot be identified. Same rule as the invoice. */
  thead { display:table-header-group; }
  tr { page-break-inside:avoid; }
  th { background:${BRAND.primary}; color:#fff; text-align:right; padding:8px;
       font-weight:700; font-size:10.5px; }
  td { padding:6px 8px; border-bottom:1px solid ${BRAND.line}; }
  tr:nth-child(even) td { background:${BRAND.surface}; }
  /* ⚠ 'direction:ltr' on the cell is what keeps '1,679' from re-ordering inside
     an RTL row. Never "fix" a mis-rendered figure by reversing the string. */
  td.num { text-align:left; direction:ltr; font-variant-numeric: tabular-nums; }
  td.pos { color:${BRAND.accent}; font-weight:700; }
  td.name { font-weight:600; }
  .muted { color:${BRAND.muted}; font-weight:400; }
  .footer { margin-top:18px; padding-top:8px; border-top:1px solid ${BRAND.line};
            color:${BRAND.muted}; font-size:10px; text-align:center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand-logo">${SOULIA_LOGO_SVG}</div>
      <div class="subtitle">تقرير الأداء المالي والمبيعات</div>
    </div>
    <div class="period">الفترة: ${escapeHtml(period)}</div>
  </div>

  <div class="kpi-grid">${kpiCards}</div>

  <div class="best-card">
    <div class="label">🏆 المنتج الأكثر مبيعاً</div>
    <div class="value">${best}</div>
  </div>

  <h2>تحليل الأصناف (أعلى 25)</h2>
  <table>
    <thead><tr>
      <th>#</th><th>الصنف</th><th>الكمية</th><th>الإيراد</th><th>التكلفة</th><th>الربح</th><th>الهامش</th>
    </tr></thead>
    <tbody>${productRows || '<tr><td colspan="7" style="text-align:center;color:#94a3b8">لا توجد بيانات</td></tr>'}</tbody>
  </table>

  <h2>أكثر العملاء (أعلى 10)</h2>
  <table>
    <thead><tr>
      <th>#</th><th>العميل</th><th>عدد الفواتير</th><th>الإيراد</th>
    </tr></thead>
    <tbody>${customerRows || '<tr><td colspan="4" style="text-align:center;color:#94a3b8">لا توجد بيانات</td></tr>'}</tbody>
  </table>

  <div class="footer">
    تم إنشاء التقرير في ${escapeHtml(generatedAt())} — SOULIA Warehouse Management System
  </div>
</body>
</html>`;
}
