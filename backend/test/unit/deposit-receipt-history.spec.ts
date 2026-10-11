import { depositHistory, receiptSender } from '../../src/shopify/deposit-receipt-history.util';
import { parseReceiptText, mergeReceiptPasses } from '../../src/shopify/deposit-receipt-parser.util';

const now = new Date('2026-10-11T22:30:00Z'); // Cairo: 12 October, after midnight.
const row = (id: string, date: string, extra = {}) => ({ id, submittedAt: date, submittedBy: 'Staff', amount: 500, method: 'Instapay', status: 'معتمد', ...extra });
const orders = [{ _id: 'o1', ref: '2771', client: 'Customer', depositReceipts: [
  row('r1', '2026-10-11T22:00:00Z', { senderHandle: 'sender@instapay', reviewedBy: 'Manager' }),
  row('r2', '2026-10-11T12:00:00Z', { status: 'معلق', method: 'كاش', amount: 200 }),
  row('draft', '', { status: 'مسودة' }),
] }];
describe('deposit receipt history', () => {
  it('uses Cairo calendar days for today and yesterday', () => {
    expect(depositHistory(orders, [], [], { period: 'today' }, now).rows.map(r => r.id)).toEqual(['r1']);
    expect(depositHistory(orders, [], [], { period: 'yesterday' }, now).rows.map(r => r.id)).toEqual(['r2']);
  });
  it('deduplicates original receipts, transaction snapshots and payment ledger copies', () => {
    const tx = { _id: 't1', depositReceipts: [row('r1', '2026-10-11T22:00:00Z')], deposits: [{ id: 'r1', receiptId: 'r1', amount: 500, date: now.toISOString() }] };
    const result = depositHistory(orders, [tx], [{ state: 'consumed', receipt: row('r1', now.toISOString()) }], {}, now);
    expect(result.total).toBe(2); expect(result.summary.totalAmount).toBe(700);
    expect(result.rows[0].reviewedBy).toBe('Manager');
  });
  it('filters sender, vault, amount, employee, status and date together', () => {
    expect(depositHistory(orders, [], [], { sender: 'SENDER@', method: 'Instapay', min: '500', max: '500', search: 'Manager', status: 'معتمد', from: '2026-10-12', to: '2026-10-12' }, now).total).toBe(1);
    expect(depositHistory(orders, [], [], { sender: 'other' }, now).total).toBe(0);
  });
  it('includes manual sales and receipt-free registered deposits without inventing an approver', () => {
    const tx = { _id: 't1', ref: '3000', deposits: [{ id: 'p1', date: now.toISOString(), amount: 100, method: 'كاش', by: 'Employee' }] };
    const result = depositHistory([], [tx], [{ state: 'withdrawn', receipt: row('withdrawn', now.toISOString()) }], {}, now);
    expect(result.total).toBe(2); expect(result.rows.find(r => r.source === 'transaction').reviewedBy).toBe('');
    expect(result.rows.find(r => r.id === 'withdrawn')).toMatchObject({ status: 'مسحوب', imageDeleted: true });
  });
  it('paginates with stable ordering and computes totals across all matching pages', () => {
    const result = depositHistory([{ depositReceipts: Array.from({length: 30}, (_, i) => row(String(i), now.toISOString())) }], [], [], { page: '2' }, now);
    expect(result.rows).toHaveLength(5); expect(result.total).toBe(30); expect(result.summary.totalAmount).toBe(15000);
    expect(depositHistory(orders, [], [], { page: '999' }, now).page).toBe(1);
  });
  it.each([{ min: 'NaN' }, { min: '-1' }, { min: '5', max: '1' }, { from: '2026-02-30' }, { from: '2026-10-12', to: '2026-10-11' }])('rejects invalid financial filters %j', query => {
    expect(() => depositHistory(orders, [], [], query as any)).toThrow();
  });
  it('does not return storage keys or raw OCR content', () => {
    const result = depositHistory([{ depositReceipts: [row('r', now.toISOString(), { imageKey: 'private/key', ocr: { rawText: 'private' } })] }], [], [], {}, now);
    expect(result.rows[0]).not.toHaveProperty('imageKey'); expect(result.rows[0]).not.toHaveProperty('ocr');
  });
  it('reflects refunded manual deposits and later vault corrections without duplicating receipts', () => {
    const refund = depositHistory([], [{ cancelled: true, depositReceipts: [row('r', now.toISOString())] }], [], {}, now);
    expect(refund.rows[0].status).toBe('مُسترد');
    const correction = depositHistory(orders, [{ depositReceipts: [row('r1', now.toISOString(), {method:'كاش'})] }], [], {method:'كاش'}, now);
    expect(correction.rows.find(r => r.id === 'r1').method).toBe('كاش');
    expect(correction.total).toBe(2);
  });
  it('validates sender addresses and supports corrections and deliberate clearing', () => {
    expect(receiptSender({ senderHandle: ' Sender@Instapay ' }, {})).toMatchObject({senderName:'', senderHandle:'sender@instapay',senderPhone:''});
    expect(receiptSender({ senderName: '', senderHandle: '' }, { ocr: { senderHandle: 'old@instapay' } }).senderHandle).toBe('');
    expect(() => receiptSender({ senderHandle: 'not-an-address' }, {})).toThrow();
  });
});

describe('sender OCR extraction', () => {
  it.each([
    ['من\n01210542987\nإلى\n01008835575', '01210542987'],
    ['من 01021646494\nإلى 01008835575', '01021646494'],
    ['01210542987 من\n01008835575 إلى', '01210542987'],
    ['01210542987\nمن\nMohamed F *****\n01008835575\nإلى', '01210542987'],
    ['From\n٠١٠٢١٦٤٦٤٩٤\nTo\n٠١٠٠٨٨٣٥٥٧٥', '01021646494'],
    ['From\n+20 102 164 6494\nTo\n01008835575', '01021646494'],
  ])('extracts the labelled sender phone only: %s', (text, phone) => {
    expect(parseReceiptText(text).senderPhone).toBe(phone);
  });
  it('never guesses a sender from a recipient, chat background or masked number', () => {
    expect(parseReceiptText('01008835575\nإلى\n01210542987')).not.toHaveProperty('senderPhone');
    expect(parseReceiptText('Chat\n01210542987')).not.toHaveProperty('senderPhone');
    expect(parseReceiptText('من\n01021****94\nإلى\n01008835575')).not.toHaveProperty('senderPhone');
  });
  it('leaves differing sender phone passes and ambiguous sender/recipient blocks blank', () => {
    expect(mergeReceiptPasses([parseReceiptText('من\n01021646494\nإلى'),parseReceiptText('من\n01210542987\nإلى')])).not.toHaveProperty('senderPhone');
    expect(parseReceiptText('من\n01021646494\nRecipient\n01210542987\nإلى')).not.toHaveProperty('senderName');
  });
  it('searches sender phones using Arabic digits or international prefixes', () => {
    const sample=[{depositReceipts:[row('phone',now.toISOString(),{senderPhone:'01021646494'})]}];
    for(const sender of ['+20 1021646494','٠١٠٢١٦٤٦٤٩٤','216464'])expect(depositHistory(sample,[],[],{sender},now).total).toBe(1);
    expect(receiptSender({senderPhone:'+20 1021646494'},{}).senderPhone).toBe('01021646494');
    expect(()=>receiptSender({senderPhone:'01021****94'},{})).toThrow();
    const cleared=[{depositReceipts:[row('clear',now.toISOString(),{senderPhone:'',ocr:{senderPhone:'01021646494'}})]}];
    expect(depositHistory(cleared,[],[],{sender:'01021646494'},now).total).toBe(0);
  });
  it('reads only the sender section and stops before recipient details', () => {
    expect(parseReceiptText('chat@instapay\nFrom\nSender Name\nsender@instapay\nACCOUNT XXX0180\nTo\nrecipient@instapay')).toMatchObject({senderName:'Sender Name',senderHandle:'sender@instapay'});
    expect(parseReceiptText('من\nsender@instapay\nإلى المحفظة الإلكترونية\nRecipient')).toMatchObject({senderHandle:'sender@instapay'});
  });
  it('does not guess from arbitrary handles or a recipient', () => {
    expect(parseReceiptText('To\nrecipient@instapay')).not.toHaveProperty('senderHandle');
    expect(parseReceiptText('chat@instapay')).not.toHaveProperty('senderHandle');
  });
  it('leaves conflicting OCR sender readings for manual confirmation', () => {
    const first=parseReceiptText('From\na@instapay\nTo\nWallet'), second=parseReceiptText('From\nb@instapay\nTo\nWallet');
    expect(mergeReceiptPasses([first,second])).not.toHaveProperty('senderHandle');
  });
});
