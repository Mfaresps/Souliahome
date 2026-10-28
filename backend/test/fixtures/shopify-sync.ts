export function syncFixture() {
  const tx: any = { _id: '507f1f77bcf86cd799439011', ref: '2882', shopifyOrderId: '7219642466605',
    total: 870, deposit: 400, remaining: 470, bostaOriginalCod: 470, bostaStatus: 'DELIVERED',
    bostaTrackingNumber: '6417585352', deliveredAt: new Date('2026-10-25T10:00:11.340Z'),
    bostaRawResponse: { state: 45, timeStamp: '2026-10-25T10:00:11.340Z', type: 'SEND' },
    items: [{ shopifyName: 'Blanket', code: 'B-1', qty: 1 }] };
  const order: any = { shopifyId: tx.shopifyOrderId, rawData: { line_items: [{ id: '123', title: 'Blanket', sku: 'B-1', quantity: 1 }] } };
  const pageInfo = { hasNextPage: false };
  const remote: any = { id: `gid://shopify/Order/${tx.shopifyOrderId}`, name: '#2882', createdAt: '2026-10-19T00:00:00Z',
    cancelledAt: null, displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED', canMarkAsPaid: true,
    currentTotalPriceSet: { shopMoney: { amount: '870.00', currencyCode: 'EGP' } },
    totalOutstandingSet: { shopMoney: { amount: '870.00', currencyCode: 'EGP' } },
    totalRefundedSet: { shopMoney: { amount: '0.00', currencyCode: 'EGP' } },
    transactions: [], erpStatus: null,
    lineItems: { nodes: [{ id: 'gid://shopify/LineItem/123', currentQuantity: 1 }], pageInfo }, fulfillments: [],
    fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', supportedActions: [{ action: 'CREATE_FULFILLMENT' }],
      lineItems: { nodes: [{ id: 'gid://shopify/FulfillmentOrderLineItem/1', remainingQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/123' } }], pageInfo } }], pageInfo } };
  return { tx, order, remote };
}
export function applyFixtureAction(remote: any, action: any) {
  if (action.kind === 'fulfill') {
    remote.fulfillments.push({ id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS',
      trackingInfo: action.input.trackingInfo ? [{ number: action.input.trackingInfo.number }] : [],
      fulfillmentLineItems: { nodes: [{ quantity: 1, lineItem: { id: 'gid://shopify/LineItem/123' } }], pageInfo: { hasNextPage: false } },
      events: { nodes: [], pageInfo: { hasNextPage: false } } });
    remote.fulfillmentOrders.nodes[0].status = 'CLOSED';
  }
  if (action.kind === 'event') remote.fulfillments[0].events.nodes.push({ id: String(Date.now()), ...action.input });
  if (action.kind === 'tracking') remote.fulfillments[0].trackingInfo = [{ number: action.input.tracking }];
  if (action.kind === 'metadata') remote.erpStatus = { value: action.input.value, compareDigest: 'saved-digest' };
  if (action.kind === 'payment') { remote.displayFinancialStatus = 'PAID'; remote.totalOutstandingSet.shopMoney.amount = '0.00'; }
}
