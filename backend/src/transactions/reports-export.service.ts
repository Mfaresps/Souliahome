import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import puppeteer, { Browser } from 'puppeteer';

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
      this.browserPromise = puppeteer
        .launch({
          headless: true,
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
    summary.getRow(1).font = { bold: true };
    summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16A34A' } };
    summary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    const rows: Array<[string, number | string]> = [
      ['الفترة', periodLabel],
      ['عدد الحركات', report.transactionCount ?? 0],
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
    summary.getColumn('v').numFmt = '#,##0';

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
    ['rev', 'cost', 'profit'].forEach((k) => (products.getColumn(k).numFmt = '#,##0'));
    products.getColumn('margin').numFmt = '0.0"%"';

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
    customers.getColumn('revenue').numFmt = '#,##0';

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
      ['sales', 'purchases'].forEach((k) => (trend.getColumn(k).numFmt = '#,##0'));
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
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
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

function styleHeader(ws: ExcelJS.Worksheet): void {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16A34A' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 22;
}

function formatPeriodLabel(from?: string, to?: string): string {
  if (!from && !to) return 'كل الفترات';
  if (from && to) return `${from} → ${to}`;
  if (from) return `من ${from}`;
  return `حتى ${to}`;
}

function fmt(n: number | undefined): string {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US') + ' ج';
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
    ? `${escapeHtml(r.bestSellingProduct.name)} <span class="muted">— ${r.bestSellingProduct.qty} قطعة</span>`
    : '—';
  const productRows = (r.productProfits || [])
    .slice(0, 25)
    .map((p, i) => {
      const margin = p.rev > 0 ? ((p.profit / p.rev) * 100).toFixed(1) : '0.0';
      return `<tr>
        <td>${i + 1}</td>
        <td class="name">${escapeHtml(p.name)}</td>
        <td class="num">${p.qty.toLocaleString('en-US')}</td>
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
        <td class="num">${c.orders}</td>
        <td class="num">${fmt(c.revenue)}</td>
      </tr>`,
    )
    .join('');

  const kpiCards = [
    { label: 'إجمالي المبيعات', value: fmt(r.totalSales), color: '#10b981' },
    { label: 'الربح الصافي', value: fmt(r.netProfit), color: '#6d28d9' },
    { label: 'عدد الفواتير', value: String(r.orderCount ?? 0), color: '#0066cc' },
    { label: 'متوسط الفاتورة', value: fmt(r.avgOrderValue), color: '#0891b2' },
    { label: 'إجمالي المشتريات', value: fmt(r.totalPurchases), color: '#1565c0' },
    { label: 'المصاريف', value: fmt(r.expenseTotal), color: '#dc2626' },
    { label: 'المرتجعات', value: `${r.returnCount ?? 0} • ${fmt(r.totalReturns)}`, color: '#ea580c' },
    { label: 'المتبقي على العملاء', value: fmt(r.totalRemaining), color: '#f59e0b' },
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
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Tahoma", "Cairo", Arial, sans-serif; color:#0f172a; margin:0; padding:0; font-size:12px; }
  .header { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid #16a34a; padding-bottom:10px; margin-bottom:18px; }
  .brand { font-size:22px; font-weight:800; color:#16a34a; letter-spacing:.5px; }
  .subtitle { color:#64748b; font-size:11px; margin-top:2px; }
  .period { background:#f0fdf4; color:#15803d; padding:6px 12px; border-radius:6px; font-weight:600; font-size:11px; }
  h2 { font-size:14px; margin:18px 0 8px; color:#0f172a; border-right:4px solid #16a34a; padding-right:8px; }
  .kpi-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin-bottom:6px; }
  .kpi { background:#f8fafc; border-radius:8px; padding:10px 12px; }
  .kpi-label { font-size:10px; color:#64748b; margin-bottom:4px; }
  .kpi-value { font-size:14px; font-weight:700; }
  .best-card { background:linear-gradient(135deg,#f0fdf4,#dcfce7); border:1px solid #bbf7d0; border-radius:8px; padding:12px 16px; margin:10px 0 6px; display:flex; justify-content:space-between; align-items:center; }
  .best-card .label { color:#15803d; font-weight:600; font-size:11px; }
  .best-card .value { font-size:13px; font-weight:700; color:#0f172a; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { background:#16a34a; color:#fff; text-align:right; padding:7px 8px; font-weight:600; }
  td { padding:6px 8px; border-bottom:1px solid #e2e8f0; }
  tr:nth-child(even) td { background:#f8fafc; }
  td.num { text-align:left; direction:ltr; font-variant-numeric: tabular-nums; }
  td.pos { color:#16a34a; font-weight:600; }
  td.name { font-weight:600; }
  .muted { color:#64748b; font-weight:400; }
  .footer { margin-top:18px; padding-top:8px; border-top:1px solid #e2e8f0; color:#64748b; font-size:10px; text-align:center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">SOULIA</div>
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
    تم إنشاء التقرير في ${new Date().toLocaleString('ar-EG')} — SOULIA Warehouse Management System
  </div>
</body>
</html>`;
}
