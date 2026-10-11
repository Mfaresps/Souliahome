import { BadRequestException } from '@nestjs/common';
import { normalizeReceiptPhone } from './receipt-phone.util';

export function receiptSender(body: any, receipt: any) {
  const senderName = String(body.senderName ?? receipt.senderName ?? receipt.ocr?.senderName ?? '').trim();
  const senderHandle = String(body.senderHandle ?? receipt.senderHandle ?? receipt.ocr?.senderHandle ?? '').replace(/\s/g, '').toLowerCase();
  const rawPhone = body.senderPhone ?? receipt.senderPhone ?? receipt.ocr?.senderPhone ?? '';
  const senderPhone = normalizeReceiptPhone(rawPhone);
  if (String(rawPhone).trim() && !senderPhone) throw new BadRequestException('راجع رقم هاتف المرسل: أدخل رقم محمول مصري كامل');
  if (senderName.length > 120 || senderHandle.length > 120 || (senderHandle && !/^[a-z0-9._+-]+@instapay$/.test(senderHandle))) {
    throw new BadRequestException('راجع اسم المحوّل وعنوان InstaPay');
  }
  const screenshotTime = String(body.screenshotTime ?? receipt.screenshotTime ?? receipt.ocr?.screenshotTime ?? '').trim();
  if (screenshotTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(screenshotTime)) throw new BadRequestException('راجع وقت الشاشة بصيغة HH:mm');
  const screenshotTimeSource = body.screenshotTime != null && screenshotTime !== receipt.ocr?.screenshotTime ? 'reviewed' : (receipt.screenshotTimeSource || receipt.ocr?.screenshotTimeSource || '');
  return { senderName, senderHandle, senderPhone, screenshotTime, screenshotTimeSource };
}

const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** One row per receipt, preferring the original review record over transaction copies. */
export function depositHistory(orders: any[], transactions: any[], manual: any[], query: Record<string, string>, now = new Date()) {
  const records = new Map<string, any>();
  function add(parent: any, r: any, source: string, status?: string) {
    if (!r?.id || r.status === 'مسودة' || !r.submittedAt || records.has(r.id)) return;
    const date = new Date(r.submittedAt);
    if (!Number.isFinite(date.getTime())) return;
    records.set(r.id, { id: r.id, source, orderId: String(parent._id || ''), orderNumber: String(parent.ref || parent.orderNumber || ''),
      client: String(parent.client || parent.customerName || ''), status: status || r.status || 'معتمد', amount: Number(r.amount) || 0,
      method: String(r.method || ''), submittedAt: date.toISOString(), submittedDay: day(date), submittedBy: String(r.submittedBy || ''),
      reviewedAt: String(r.reviewedAt || ''), reviewedBy: String(r.reviewedBy || ''),
      senderName: String(r.senderName ?? r.ocr?.senderName ?? ''), senderHandle: String(r.senderHandle ?? r.ocr?.senderHandle ?? ''),
      senderPhone: normalizeReceiptPhone(r.senderPhone ?? r.ocr?.senderPhone ?? ''),
      screenshotTime: String(r.screenshotTime ?? r.ocr?.screenshotTime ?? ''),
      screenshotTimeSource: String(r.screenshotTimeSource || r.ocr?.screenshotTimeSource || ''),
      reference: String(r.ocr?.reference || ''), imageDeleted: !!r.imageDeleted, vaultTxNo: String(r.vaultTxNo || '') });
  }
  orders.forEach(o => (o.depositReceipts || []).forEach((r: any) => add(o, r, 'shopify')));
  transactions.forEach(t => (t.depositReceipts || []).forEach((r: any) => {
    const original = records.get(r.id);
    if (original) {
      // The sale may contain an administrator's later correction of the booked vault.
      if (original.status === 'معتمد' && r.method) original.method = r.method;
      return;
    }
    const reversed = t.cancelled || (t.deposits || []).some((d: any) => (d.receiptId === r.id || d.id === r.id) && d.reversed);
    add(t, r, 'transaction', reversed ? 'مُسترد' : undefined);
  }));
  transactions.forEach(t => (t.deposits || []).forEach((d: any, index: number) => {
    // Receipt-backed ledger rows are copies of the same transfer, not another deposit.
    if (d.receiptId || d.source === 'deposit-receipt' || records.has(d.id) || Number(d.amount) <= 0) return;
    add(t, { id: `deposit:${t._id}:${d.id || index}`, amount: d.amount, method: d.method,
      submittedAt: d.date, submittedBy: d.by, status: d.reversed || t.cancelled ? 'مُسترد' : 'معتمد', imageDeleted: true,
      senderName: d.senderName, senderHandle: d.senderHandle, senderPhone: d.senderPhone, vaultTxNo: d.vaultTxNo }, 'transaction');
  }));
  manual.filter(m => m.state !== 'draft').forEach(m => add({ ...m, _id: m.transactionId || '', ref: m.ref },
    { ...m.receipt, imageDeleted: m.state === 'withdrawn' || m.receipt?.imageDeleted }, 'manual', m.state === 'withdrawn' ? 'مسحوب' : m.state === 'consumed' ? 'معتمد' : 'معلق'));
  const periods = ['all', 'today', 'yesterday', 'custom'];
  if (!periods.includes(query.period || 'all')) throw new BadRequestException('فترة غير صالحة');
  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(new Date(s).getTime()) && new Date(s).toISOString().slice(0, 10) === s;
  let from = query.from || '', to = query.to || '';
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) throw new BadRequestException('راجع نطاق التاريخ');
  if (query.period === 'today') from = to = day(now);
  if (query.period === 'yesterday') {
    const previous = new Date(day(now) + 'T12:00:00Z'); previous.setUTCDate(previous.getUTCDate() - 1); from = to = previous.toISOString().slice(0, 10);
  }
  const amount = (key: string) => {
    if (query[key] == null || query[key] === '') return null;
    const n = Number(query[key]);
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException('المبلغ يجب أن يكون رقمًا موجبًا');
    return n;
  };
  const min = amount('min'), max = amount('max');
  if (min != null && max != null && min > max) throw new BadRequestException('راجع نطاق المبلغ');
  const sender = String(query.sender || '').trim().toLowerCase().slice(0, 120);
  const phoneSearch = normalizeReceiptPhone(sender) || sender.replace(/[\s()+-]/g, '').replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
  if(query.screenshotTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(query.screenshotTime)) throw new BadRequestException('راجع وقت الشاشة');
  const search = String(query.search || '').trim().toLowerCase().slice(0, 120);
  const rows = [...records.values()].filter(r => (!from || r.submittedDay >= from) && (!to || r.submittedDay <= to)
    && (!query.method || r.method === query.method) && (!query.status || r.status === query.status)
    && (!query.screenshotTime || r.screenshotTime === query.screenshotTime)
    && (min == null || r.amount >= min) && (max == null || r.amount <= max)
    && (!sender || `${r.senderName} ${r.senderHandle}`.toLowerCase().includes(sender) || (!!r.senderPhone && r.senderPhone.includes(phoneSearch)))
    && (!search || `${r.orderNumber} ${r.client} ${r.submittedBy} ${r.reviewedBy} ${r.reference}`.toLowerCase().includes(search)))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id));
  const pageSize = 25, pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(query.page) || 1)));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, pages,
    summary: { totalAmount: Math.round(rows.reduce((sum, r) => sum + r.amount, 0) * 100) / 100,
      pending: rows.filter(r => r.status === 'معلق').length, approved: rows.filter(r => r.status === 'معتمد').length } };
}
