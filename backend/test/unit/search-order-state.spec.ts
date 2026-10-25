import { SearchService } from '../../src/search/search.service';

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
