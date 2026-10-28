// Constrained repair for the approved local item changes on #2830.
// Default stages an editable draft only. Commit is a separate --commit invocation.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { ShopifySyncApiService } = require('../../dist/shopify/sync/sync-api.service');
const { ShopifyAdminService } = require('../../dist/shopify/shopify-admin.service');
const { digest } = require('../../dist/shopify/sync/sync-plan');
const env = require('dotenv').parse(fs.readFileSync(path.resolve(__dirname, '../../.env')));
if (!/^mongodb:\/\/127\.0\.0\.1:27018\/soulia(?:\?|$)/.test(env.MONGODB_URI || '')) throw Error('Local database required');
const directory = path.resolve(__dirname, '../../../artifacts/shopify-2830'); fs.mkdirSync(directory, { recursive: true });
const draftFile = path.join(directory, 'draft.json');
const orderId = '7213632618797';
const calculated = `id originalOrder { id } totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 100) { nodes { id sku title quantity originalUnitPriceSet { shopMoney { amount currencyCode } } } pageInfo { hasNextPage } }
  addedLineItems(first: 100) { nodes { id sku title quantity originalUnitPriceSet { shopMoney { amount currencyCode } } } pageInfo { hasNextPage } }`;
const target = tx => ({ total: tx.total, shipCost: tx.shipCost, discount: tx.discount,
  items: tx.items.map(i => [i.code, i.qty, i.price]).sort((a,b)=>a[0].localeCompare(b[0])) });
(async () => {
  const db = await mongoose.createConnection(env.MONGODB_URI).asPromise();
  try {
    const tx = await db.collection('transactions').findOne({ ref: '2830', shopifyOrderId: orderId });
    assert.deepEqual(target(tx), { total: 3410, shipCost: 120, discount: 120,
      items: [['Code 17',1,890],['Code 30',1,450],['Code 37',1,750],['Code 42',6,220]] });
    const order = await db.collection('shopifyorders').findOne({ shopifyId: orderId });
    const approval = [...order.editHistory].reverse().find(e => e.approvedBy && e.after?.total === 3410);
    assert(approval && approval.after.items.some(i => i.code === 'Code 42' && i.qty === 6));
    const settings = await db.collection('settings').findOne({});
    const provider = { getShopifyConfig: async () => ({ storeName: settings.shopifyStoreName,
      clientId: settings.shopifyClientId, clientSecret: settings.shopifyClientSecret, accessToken: settings.shopifyAccessToken }) };
    const api = new ShopifySyncApiService(provider);
    const connection = await api.connection(); assert.equal(connection.domain, 'tscxpn-ze.myshopify.com');
    assert(connection.scopes.includes('write_order_edits'));
    const remote = await api.read(orderId, connection.shopId);
    assert.equal(remote.displayFinancialStatus, 'PENDING'); assert.equal(remote.displayFulfillmentStatus, 'UNFULFILLED');
    assert.equal(remote.currentTotalPriceSet.shopMoney.amount, '3820.0'); assert.equal(remote.fulfillments.length, 0);
    const run = async (query, vars) => {
      const data = await api.query(query, vars, true); const payload = Object.values(data)[0];
      if (payload.userErrors?.length) throw Error(JSON.stringify(payload.userErrors));
      return payload;
    };
    if (process.argv.includes('--commit')) {
      const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
      assert(draft.verified && !draft.committed && !draft.commitStartedAt, 'Do not repeat an attempted commit');
      assert.equal(draft.orderId, orderId); assert.equal(draft.shopId, connection.shopId);
      assert.equal(draft.localHash, digest(target(tx))); assert.equal(draft.remoteHash, digest(remote));
      const current = await api.query(`query($id:ID!){node(id:$id){... on CalculatedOrder{${calculated}}}}`, { id:draft.calculatedId });
      assert.deepEqual(current.node, draft.calculated, 'The draft changed after verification');
      draft.commitStartedAt = new Date().toISOString(); fs.writeFileSync(draftFile, JSON.stringify(draft,null,2));
      await run('mutation($id:ID!){orderEditCommit(id:$id,notifyCustomer:false,staffNote:"Soulia ERP: approved item changes for order 2830. Code 42: six individual pieces equal one six-piece set. Payment unchanged."){order{id}userErrors{field message}}}', { id:draft.calculatedId });
      draft.committed = true; fs.writeFileSync(draftFile, JSON.stringify(draft,null,2));
      const after = await api.read(orderId, connection.shopId);
      assert.equal(Number(after.currentTotalPriceSet.shopMoney.amount), 3410);
      assert.equal(after.displayFinancialStatus, remote.displayFinancialStatus); assert.deepEqual(after.transactions, remote.transactions);
      const fresh = await new ShopifyAdminService(provider).getOrder(orderId);
      assert(fresh.success && fresh.order); assert.equal(Number(fresh.order.current_total_price), 3410);
      const lines = fresh.order.line_items.filter(l => l.current_quantity > 0);
      assert.deepEqual(lines.map(l => [l.sku,l.current_quantity,Number(l.price)]).sort((a,b)=>a[0].localeCompare(b[0])),
        [['Code 17',1,890],['Code 30',1,450],['Code 37',1,750],['Code 42',1,1320]]);
      const pack = lines.find(l => l.sku === 'Code 42'); assert(/6\s*pieces/i.test(pack.title));
      const latest = await db.collection('transactions').findOne({ _id:tx._id }); assert.equal(digest(target(latest)), draft.localHash);
      const identity = await api.identity();
      const reconciliation = { ...identity, shopId:connection.shopId, transactionId:String(tx._id), orderId,
        localHash:draft.localHash, verifiedAt:new Date(), approvedLocalEditAt:approval.editedAt,
        unitMappings:[{ lineId:String(pack.id),sku:'Code 42',localQty:6,remoteQty:1,localUnitPrice:22000,remoteUnitPrice:132000 }] };
      const session = await db.startSession();
      try { await session.withTransaction(async () => {
        await db.collection('shopifysyncreconciliations').updateOne({ ...identity, transactionId:String(tx._id), orderId }, { $set:reconciliation }, { upsert:true, session });
        await db.collection('shopifyorders').updateOne({ _id:order._id, shopifyId:orderId }, { $set:{ rawData:fresh.order } }, { session });
      }); } finally { await session.endSession(); }
      const report = { ref:'2830', committed:true, oldTotal:3820, newTotal:3410, payment:after.displayFinancialStatus,
        financialTransactionsUnchanged:true, unitMappings:reconciliation.unitMappings,
        fulfillmentOrders:after.fulfillmentOrders.nodes.map(f => ({id:f.id,status:f.status,lines:f.lineItems.nodes})) };
      fs.writeFileSync(path.join(directory,'reconciled.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
      return;
    }
    if (fs.existsSync(draftFile)) throw Error('Draft already recorded; inspect it before continuing.');
    const begin = await run(`mutation($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { ${calculated} } userErrors { field message } } }`, { id: remote.id });
    const draft = { shopId: connection.shopId, transactionId: String(tx._id), orderId, localHash: digest(target(tx)),
      remoteHash: digest(remote), calculatedId: begin.calculatedOrder.id, startedAt: new Date().toISOString(), steps: [], committed: false };
    const save = () => fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2)); save();
    const removed = begin.calculatedOrder.lineItems.nodes.filter(l => l.sku === 'Code 33'); assert.equal(removed.length, 1);
    let result = await run(`mutation($id:ID!,$line:ID!){ orderEditSetQuantity(id:$id,lineItemId:$line,quantity:0,restock:true){ calculatedOrder { ${calculated} } userErrors {field message} } }`, { id: draft.calculatedId, line: removed[0].id });
    draft.steps.push('Removed unfulfilled Code 33, restock true'); save();
    for (const addition of [{ sku: 'Code 30', id: '52205464584493', price: 450 }, { sku: 'Code 42', id: '51999647269165', price: 1320 }]) {
      result = await run(`mutation($id:ID!,$variant:ID!){ orderEditAddVariant(id:$id,variantId:$variant,quantity:1,allowDuplicates:false){ calculatedLineItem { id sku title quantity originalUnitPriceSet { shopMoney { amount currencyCode } } } calculatedOrder { ${calculated} } userErrors {field message} } }`, { id: draft.calculatedId, variant: 'gid://shopify/ProductVariant/' + addition.id });
      assert.equal(result.calculatedLineItem.sku, addition.sku); assert.equal(Number(result.calculatedLineItem.originalUnitPriceSet.shopMoney.amount), addition.price);
      draft.steps.push({ added: addition.sku, quantity: 1, price: addition.price }); save();
    }
    const final = result.calculatedOrder;
    assert.equal(final.totalPriceSet.shopMoney.currencyCode, 'EGP'); assert.equal(Number(final.totalPriceSet.shopMoney.amount), tx.total);
    assert(!final.lineItems.pageInfo.hasNextPage && !final.addedLineItems.pageInfo.hasNextPage);
    const lines = [...final.lineItems.nodes, ...final.addedLineItems.nodes].filter(l => l.quantity > 0);
    assert.deepEqual(lines.map(l => [l.sku,l.quantity,Number(l.originalUnitPriceSet.shopMoney.amount)]).sort((a,b)=>a[0].localeCompare(b[0])),
      [['Code 17',1,890],['Code 30',1,450],['Code 37',1,750],['Code 42',1,1320]]);
    draft.verified = true; draft.calculated = final; save();
    console.log(JSON.stringify({ draftVerified: true, committed: false, oldTotal: 3820, newTotal: 3410,
      items: lines.map(l => ({ sku:l.sku,quantity:l.quantity,price:l.originalUnitPriceSet.shopMoney.amount })),
      unitConversion: 'Code 42: 6 local pieces = one Shopify six-piece set', payment: 'unchanged' }, null, 2));
  } finally { await db.close(); }
})().catch(e => { console.error(e.message); process.exitCode=1; });
