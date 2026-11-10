import { FollowUpsService } from '../../src/followups/followups.service';

describe('Shopify invoice follow-up lookup', () => {
  const rows = [
    { _id: 'by-id', shopifyOrderId: 'shopify-3080', orderRef: 'other' },
    { _id: 'by-ref', orderRef: '  ##AB.3080  ' },
    { _id: 'unrelated', orderRef: 'ABX3080' },
    { _id: 'suffix', orderRef: 'AB.30800' },
  ];
  function fixture() {
    const lean = jest.fn();
    const sort = jest.fn(() => ({ lean }));
    const find = jest.fn((query: any) => {
      lean.mockResolvedValue(rows.filter(row => query.$or.some((part: any) =>
        part.shopifyOrderId ? row.shopifyOrderId === part.shopifyOrderId : part.orderRef.test(row.orderRef))));
      return { sort };
    });
    const service = new FollowUpsService({ find } as any, {} as any, {} as any, {} as any);
    return { service, find, sort };
  }
  it('fetches only linked tickets, retaining legacy references and literal punctuation', async () => {
    const { service, find, sort } = fixture();
    expect(await service.findForShopifyOrder(' shopify-3080 ', ' #ab.3080 '))
      .toEqual([rows[0], rows[1]]);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0].$or).toHaveLength(2);
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
  });
  it('supports reference-only and id-only lookups without broadening the query', async () => {
    const { service } = fixture();
    expect(await service.findForShopifyOrder('', 'AB.3080')).toEqual([rows[1]]);
    expect(await service.findForShopifyOrder('shopify-3080', '')).toEqual([rows[0]]);
  });
  it('never queries the collection for an empty lookup', async () => {
    const { service, find } = fixture();
    expect(await service.findForShopifyOrder(' ', ' ### ')).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
