import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import puppeteer, { Browser } from 'puppeteer';
import { AuditResult } from './order-audit.service';

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
        date: m.shopifyCreatedAt || '—',
        client: m.client || '—',
        total: m.total || 0,
        reason: m.reason,
        reviewed: m.reviewed ? 'نعم' : 'لا',
        note: m.note || '',
      }),
    );

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
        date: row.shopifyCreatedAt || '—',
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

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  async buildPdf(r: AuditResult): Promise<Buffer> {
    const html = renderAuditHtml(r);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
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

function styleHeader(ws: ExcelJS.Worksheet): void {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16A34A' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 22;
}

function fmt(n: number | undefined): string {
  return (Number(n) || 0).toLocaleString('en-US') + ' ج';
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAuditHtml(r: AuditResult): string {
  const kpis = [
    { label: 'الأوردرات المتوقعة', value: String(r.sequence.expectedCount), color: '#0066cc' },
    { label: 'الأوردرات المسجلة', value: String(r.sequence.registeredCount), color: '#10b981' },
    { label: 'الأوردرات المفقودة', value: String(r.sequence.missingCount), color: '#ef4444' },
    { label: 'نسبة المزامنة', value: `${r.sequence.syncRate}%`, color: '#f59e0b' },
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
      <td class="num">${c.orders}</td>
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
<style>
  *{box-sizing:border-box}
  body{font-family:"Segoe UI",Tahoma,Arial,sans-serif;margin:0;padding:0;color:#1f2937;font-size:11px}
  h1{font-size:19px;margin:0 0 4px}
  h2{font-size:13px;margin:18px 0 8px;padding-bottom:5px;border-bottom:2px solid #16a34a;color:#111827}
  .sub{color:#6b7280;font-size:11px;margin-bottom:14px}
  .kpis{display:flex;gap:8px;margin-bottom:6px}
  .kpi{flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:9px;text-align:center}
  .kpi-l{color:#6b7280;font-size:9.5px;margin-bottom:3px}
  .kpi-v{font-size:17px;font-weight:700}
  .fins{display:flex;flex-wrap:wrap;gap:8px}
  .fin{flex:1 1 30%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px 10px}
  .fin-l{color:#6b7280;font-size:9.5px}
  .fin-v{font-size:13px;font-weight:700;color:#111827;margin-top:2px}
  .chip{display:inline-block;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;border-radius:5px;padding:3px 8px;margin:2px;font-weight:700;font-size:10.5px}
  .ok{color:#059669;font-weight:700}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th{background:#16a34a;color:#fff;padding:6px 5px;text-align:right;font-size:10px}
  td{padding:5px;border-bottom:1px solid #eef2f7;font-size:10px}
  tr.miss td{background:#fef2f2}
  .num{text-align:left;direction:ltr;font-variant-numeric:tabular-nums}
  .name{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pos{color:#059669}.neg{color:#dc2626}
  .dates{display:flex;gap:8px}
  .dbox{flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:9px}
  .foot{margin-top:16px;color:#9ca3af;font-size:9px;text-align:center;border-top:1px solid #e5e7eb;padding-top:7px}
</style></head><body>
  <h1>تقرير تدقيق نطاق الأوردرات</h1>
  <div class="sub">النطاق: #${r.from} → #${r.to} &nbsp;•&nbsp; تاريخ التقرير: ${new Date(r.generatedAt).toLocaleString('ar-EG')}</div>

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
    <div class="fin"><div class="fin-l">عدد الأيام</div><div class="fin-v">${r.dateRange.durationDays}</div></div>
    <div class="fin"><div class="fin-l">متوسط الأوردرات يومياً</div><div class="fin-v">${r.dateRange.ordersPerDay}</div></div>
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
  ${r.rows.length > 400 ? `<div class="sub" style="margin-top:6px">تم عرض أول 400 أوردر من ${r.rows.length} — استخدم تصدير Excel للتفاصيل الكاملة</div>` : ''}

  <div class="foot">SOULIA — نظام إدارة المخازن &nbsp;•&nbsp; تقرير تدقيق الأوردرات</div>
</body></html>`;
}
