// One-order operation authorized in this conversation. Defaults to read-only.
// Credentials stay in memory; audit files contain no customer contact details.
const fs = require('node:fs');
const path = require('node:path');
const backend = path.resolve(__dirname, '../../backend');
require(path.join(backend, 'node_modules/dotenv')).config({ path: path.join(backend, '.env'), quiet: true });
const mongoose = require(path.join(backend, 'node_modules/mongoose'));
const { createShopifyTokenProvider } = require(path.join(backend, 'scripts/shopify-token.cjs'));
const APPLY = process.argv.includes('--apply');
const orderId = 'gid://shopify/Order/7219642466605';
const lineId = 'gid://shopify/LineItem/17198752956717';
const tracking = '6417585352';
const deliveredAt = '2026-10-25T10:00:11.340Z';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
function ensure(condition, message) { if (!condition) throw new Error(message); }
function audit(name, value) {
  fs.writeFileSync(path.join(__dirname, `${runId}-${name}.json`), JSON.stringify(value, null, 2));
}
const snapshotQuery = `query Review($id: ID!) {
  shop { myshopifyDomain }
  order(id: $id) {
    id name cancelledAt displayFinancialStatus displayFulfillmentStatus
    lineItems(first: 50) { nodes { id name quantity currentQuantity unfulfilledQuantity } pageInfo { hasNextPage } }
    fulfillments {
      id status displayStatus deliveredAt trackingInfo { company number url }
      fulfillmentLineItems(first: 50) { nodes { quantity lineItem { id } } pageInfo { hasNextPage } }
      events(first: 50, reverse: true) { nodes { id status happenedAt } pageInfo { hasNextPage } }
    }
    fulfillmentOrders(first: 50) {
      nodes { id status supportedActions { action }
        lineItems(first: 50) { nodes { id remainingQuantity totalQuantity lineItem { id } } pageInfo { hasNextPage } }
      } pageInfo { hasNextPage }
    }
  }
}`;
let stage = 'local validation';
async function main() {
  const uri = process.env.MONGODB_URI || '';
  ensure(/^mongodb:\/\/(?:127\.0\.0\.1|localhost):27018\//.test(uri), 'Expected local database');
  const db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  let settings, tx;
  try {
    settings = await db.collection('settings').findOne({}, { projection: { shopifyStoreName: 1, shopifyAccessToken: 1, shopifyClientId: 1, shopifyClientSecret: 1 } }) || {};
    const matches = await db.collection('transactions').find({ ref: '2882', shopifyOrderId: '7219642466605' }, {
      projection: { ref: 1, shopifyOrderId: 1, cancelled: 1, bostaStatus: 1, bostaTrackingNumber: 1, deliveredAt: 1, 'items.qty': 1, 'items.code': 1 },
    }).toArray();
    ensure(matches.length === 1, 'Expected exactly one local transaction');
    tx = matches[0];
  } finally { await db.close(); }
  ensure(!tx.cancelled && tx.bostaStatus === 'DELIVERED', 'Local delivery state changed');
  ensure(tx.bostaTrackingNumber === tracking && new Date(tx.deliveredAt).toISOString() === deliveredAt, 'Local tracking or delivery time changed');
  ensure(tx.items.length === 1 && tx.items[0].qty === 1 && tx.items[0].code === 'Code 40', 'Local items changed');
  const cfg = {
    storeName: settings.shopifyStoreName || process.env.SHOPIFY_STORE_NAME || '',
    accessToken: settings.shopifyAccessToken || process.env.SHOPIFY_ACCESS_TOKEN || '',
    clientId: settings.shopifyClientId || process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: settings.shopifyClientSecret || process.env.SHOPIFY_CLIENT_SECRET || '',
  };
  ensure(['soulia-2', 'tscxpn-ze'].includes(cfg.storeName), 'Unexpected store configuration');
  stage = 'authentication';
  const token = await createShopifyTokenProvider().getToken(cfg);
  async function graphql(query, variables) {
    // Mutations are never retried automatically. Reruns inspect remote state first.
    const res = await fetch(`https://${cfg.storeName}.myshopify.com/admin/api/2026-10/graphql.json`, {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    ensure(res.ok, `Shopify HTTP ${res.status}`);
    const result = await res.json();
    if (result.errors) {
      audit('graphql-errors', result.errors.map(e => ({ message: e.message })));
      throw new Error('Shopify GraphQL error; inspect audit');
    }
    return result.data;
  }
  async function snapshot() {
    const data = await graphql(snapshotQuery, { id: orderId });
    ensure(data.shop.myshopifyDomain === 'tscxpn-ze.myshopify.com', 'Unexpected canonical store');
    ensure(data.order?.id === orderId && data.order.name === '#2882', 'Order identity mismatch');
    return data.order;
  }
  stage = 'remote preflight';
  let order = await snapshot();
  audit('before', { local: tx, remote: order, apply: APPLY });
  ensure(!order.cancelledAt && order.displayFinancialStatus === 'PENDING', 'Order payment/cancellation state changed');
  ensure(!order.lineItems.pageInfo.hasNextPage && order.lineItems.nodes.length === 1, 'Unexpected remote items');
  const item = order.lineItems.nodes[0];
  ensure(item.id === lineId && item.currentQuantity === 1 && item.quantity === 1, 'Remote quantity changed');
  ensure(!order.fulfillmentOrders.pageInfo.hasNextPage, 'Additional fulfillment orders need review');
  ensure(order.fulfillments.length <= 1, 'Multiple fulfillments need review');
  let fulfillment = order.fulfillments[0];
  if (fulfillment) {
    ensure(fulfillment.status === 'SUCCESS' && fulfillment.trackingInfo.some(t => t.number === tracking), 'Existing fulfillment needs review');
    const lines = fulfillment.fulfillmentLineItems;
    ensure(!lines.pageInfo.hasNextPage && lines.nodes.length === 1 && lines.nodes[0].lineItem.id === lineId && lines.nodes[0].quantity === 1, 'Existing fulfillment items differ');
  } else {
    ensure(order.displayFulfillmentStatus === 'UNFULFILLED' && item.unfulfilledQuantity === 1, 'Unexpected fulfillment state');
    const fos = order.fulfillmentOrders.nodes;
    ensure(fos.length === 1, 'Expected exactly one fulfillment order');
    const fo = fos[0];
    ensure(fo.status === 'OPEN' && fo.supportedActions.some(a => a.action === 'CREATE_FULFILLMENT'), 'Fulfillment not permitted');
    ensure(!fo.lineItems.pageInfo.hasNextPage && fo.lineItems.nodes.length === 1, 'Unexpected fulfillment order items');
    const fol = fo.lineItems.nodes[0];
    ensure(fol.lineItem.id === lineId && fol.remainingQuantity === 1, 'Fulfillment quantity changed');
    const input = {
      notifyCustomer: false,
      trackingInfo: { company: 'Bosta', number: tracking, url: `https://bosta.co/tracking/${tracking}` },
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: [{ id: fol.id, quantity: 1 }] }],
    };
    audit('fulfillment-request', input);
    if (!APPLY) { console.log('Read-only preflight passed: create fulfillment then delivery event for #2882.'); return; }
    stage = 'fulfillment creation';
    const data = await graphql(`mutation Create($input: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $input) { fulfillment { id } userErrors { field message } }
    }`, { input });
    audit('fulfillment-response', data);
    ensure(!data.fulfillmentCreate.userErrors.length && data.fulfillmentCreate.fulfillment?.id, 'Fulfillment creation rejected; inspect audit');
    console.log('Created fulfillment: ' + data.fulfillmentCreate.fulfillment.id);
    order = await snapshot();
    fulfillment = order.fulfillments.find(f => f.id === data.fulfillmentCreate.fulfillment.id);
    ensure(fulfillment, 'Created fulfillment not visible; inspect before retrying');
  }
  ensure(!fulfillment.events.pageInfo.hasNextPage, 'More delivery events need review');
  const delivered = fulfillment.events.nodes.filter(e => e.status === 'DELIVERED');
  if (delivered.length) {
    ensure(delivered.length === 1 && Math.abs(Date.parse(delivered[0].happenedAt) - Date.parse(deliveredAt)) < 1000, 'Existing delivery time differs');
  } else {
    const input = { fulfillmentId: fulfillment.id, status: 'DELIVERED', happenedAt: deliveredAt, message: 'Historical delivery synchronized from Soulia ERP (order #2882).' };
    audit('delivery-request', input);
    if (!APPLY) { console.log('Read-only preflight passed: add delivery event to existing fulfillment.'); return; }
    stage = 'delivery event creation';
    const data = await graphql(`mutation Deliver($input: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $input) { fulfillmentEvent { id status happenedAt } userErrors { field message } }
    }`, { input });
    audit('delivery-response', data);
    ensure(!data.fulfillmentEventCreate.userErrors.length && data.fulfillmentEventCreate.fulfillmentEvent?.id, 'Delivery event rejected; inspect audit');
    console.log('Created delivery event: ' + data.fulfillmentEventCreate.fulfillmentEvent.id);
  }
  stage = 'final verification';
  const after = await snapshot();
  audit('after', after);
  const finalFulfillment = after.fulfillments.find(f => f.id === fulfillment.id);
  ensure(after.displayFulfillmentStatus === 'FULFILLED' && after.displayFinancialStatus === 'PENDING', 'Final order status needs review');
  ensure(after.fulfillments.length === 1 && finalFulfillment?.displayStatus === 'DELIVERED', 'Final delivery status needs review');
  ensure(finalFulfillment.trackingInfo.some(t => t.number === tracking), 'Tracking verification failed');
  ensure(finalFulfillment.events.nodes.filter(e => e.status === 'DELIVERED').length === 1, 'Delivery event count needs review');
  ensure(Math.abs(Date.parse(finalFulfillment.deliveredAt) - Date.parse(deliveredAt)) < 1000, 'Delivered timestamp verification failed');
  console.log(JSON.stringify({ order: after.name, fulfillment: after.displayFulfillmentStatus, delivery: finalFulfillment.displayStatus, deliveredAt: finalFulfillment.deliveredAt, tracking, financialStatus: after.displayFinancialStatus, fulfillmentId: finalFulfillment.id, shipmentNotificationRequested: false }, null, 2));
}
main().catch(error => {
  // Network and credential errors may embed sensitive values; only stage is printed.
  console.error(`Stopped during ${stage}. No automatic mutation retry. Inspect this run's audit files before continuing.`);
  if (!['authentication'].includes(stage) && !/fetch|network|timeout/i.test(error.message)) console.error(error.message);
  process.exitCode = 1;
});
