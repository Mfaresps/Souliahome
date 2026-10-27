import { SearchService } from '../../src/search/search.service';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

function fixture(rows: any[]) {
  const service: any = Object.create(SearchService.prototype);
  const query: any = {};
  for (const method of ['select', 'sort', 'limit', 'lean']) query[method] = jest.fn(() => query);
  query.exec = jest.fn().mockResolvedValue(rows);
  service.shopifyOrderModel = { find: jest.fn(() => query) };
  service.topN = (items: any[]) => items;
  service.scoreFields = () => 0;
  service.typePrior = () => 0;
  return { service, query };
}
describe('Search payload contains the authoritative order stage', () => {
  it('returns the invoice dates for orders found by reference', async () => {
    const row = { _id: 't1', ref: '2880', transactionDate: '2026-10-19', date: '2026-10-27T01:50:00Z', createdAt: '2026-10-27T01:50:00Z' };
    const { service, query } = fixture([row]);
    service.transactionModel = service.shopifyOrderModel;
    const [result] = await service.searchOrdersByRef('2880', {});
    expect(query.select.mock.calls[0][0]).toContain('transactionDate date');
    expect(result).toMatchObject({ transactionDate: row.transactionDate, date: row.date, createdAt: row.createdAt });
  });
  it.each(['ar', 'en'])('shows the invoice business date in %s, including unloaded orders', lang => {
    const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
    const source = html.slice(html.indexOf('function _gsOrderDate('), html.indexOf('function renderSearchDropdown()', html.indexOf('function _gsOrderDate(')));
    const context = { transactions: [] as any[], currentLang: lang };
    const format = runInNewContext(source + '\n_gsOrderDate', context);
    const item = { id: 't1', transactionDate: '2026-10-19', date: '2026-10-20T01:50:00Z', createdAt: '2026-10-27T01:50:00Z' };
    expect(format(item)).toContain('19');
    expect(format(item)).not.toContain('27');
    expect(format({ ...item, transactionDate: '' })).toContain('20');
    expect(format({ ...item, transactionDate: '', date: '' })).toContain('27');
    context.transactions.push({ ...item, _id: 't1', transactionDate: '2026-10-18' });
    expect(format(item)).toContain('18');
    expect(format({ id: 'empty' })).toBe('');
  });
  it.each([
    [{ status: 'pending' }, false, 'بانتظار تأكيد العميل'],
    [{ status: 'pending', shipWithoutDeposit: true }, true, 'مؤكّد · بانتظار التجهيز'],
    [{ status: 'pending', depositReceipts: [{ status: 'معتمد', amount: 400 }] }, true, 'مؤكّد · بانتظار التجهيز'],
    [{ status: 'pending', depositReceipts: [{ status: 'معلق', amount: 400 }] }, false, 'بانتظار تأكيد العميل'],
    [{ status: 'pending', cancelled: true, shipWithoutDeposit: true }, true, 'ملغي'],
    [{ status: 'rejected', shipWithoutDeposit: true }, true, 'مرفوض'],
  ])('transfers the approved confirmation signal without receipt details: %j', async (row, approved, label) => {
    const { service, query } = fixture([{ _id: 's1', ref: '2950', ...row }]);
    const [result] = await service.searchShopifyOrdersByRef('2950', {});
    expect(query.select.mock.calls[0][0]).toContain('depositReceipts shipWithoutDeposit');
    expect(result.orderState).toEqual({ status: row.status, cancelled: !!(row as any).cancelled, confirmationApproved: approved });
    expect(result.shopifyStatus).toBe(label);
    expect(result.orderState).not.toHaveProperty('depositReceipts');
  });
  it('keeps carrier and shipment data for transactions not loaded in the browser', () => {
    const { service } = fixture([]);
    const result = service.orderItem({ _id: 't1', type: 'مبيعات', prepChecked: true, pickupStatus: 'Ready',
      shipCo: 'Bosta', carrierCode: 'bosta', bostaOrderId: 'b1', bostaStatus: 'CREATED' }, 1);
    expect(result.orderState).toMatchObject({ pickupStatus: 'Ready', shipCo: 'Bosta', carrierCode: 'bosta',
      hasShipment: true, bostaStatus: 'CREATED', prepChecked: true });
  });
});
