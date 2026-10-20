'use strict';
// Offline tests only. No application boot, database connection, or file writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { analyze, classify, readDatabase, parseArgs, FIELDS } = require('./inventory-diagnostics.cjs');

function fixture() {
  return { ...Object.fromEntries(Object.keys(FIELDS).map(name => [name, []])),
    products: [{ _id: 'p1', code: 'A', openingBalance: 10, buyPrice: 20 }] };
}
const tx = (type, qty, extra = {}) => ({ _id: 't1', type, items: [{ code: 'A', qty }], ...extra });

test('stock mirrors purchase/sale/return/supplier-return timing and manual adjustments', () => {
  const data = fixture();
  data.transactions = [tx('مشتريات', 5), tx('مبيعات', 3), tx('مرتجع', 2), tx('مرتجع مشتريات', 1)];
  data.inventorymovements = [
    { productCode: 'A', sourceType: 'manual-adjustment', qtyDelta: -2 },
    { productCode: 'A', sourceType: 'transaction-create', qtyDelta: 999 },
  ];
  assert.equal(analyze(data).stock[0].derivedAvailable, 11);
});

test('damaged returns do not re-enter stock; cancelled and archived rows are excluded', () => {
  const data = fixture();
  data.transactions = [tx('مرتجع', 2, { items: [{ code: 'A', qty: 2, condition: 'تالف' }] }),
    tx('مبيعات', 9, { cancelled: true }), tx('مشتريات', 30, { archived: true })];
  assert.equal(analyze(data).stock[0].derivedAvailable, 10);
});

test('legacy return classification preserves the exact existing suffix/notes rules', () => {
  assert.equal(classify(tx('مشتريات', 1, { ref: '12-RET' })), 'returns');
  assert.equal(classify(tx('مشتريات', 1, { ref: '12-RET-2' })), 'purchases');
  assert.equal(classify(tx('مشتريات', 1, { notes: 'استبدال — مرتجع: A' })), 'returns');
});

test('exact, trimmed, case-fold, missing SKUs and ID conflicts are distinct', () => {
  const data = fixture();
  data.products.push({ _id: 'p2', code: 'A', openingBalance: 0 },
    { _id: 'p3', code: ' A ', openingBalance: 0 }, { _id: 'p4', code: 'a', openingBalance: 0 },
    { _id: 'p5', code: '', openingBalance: 0 });
  data.transactions = [tx('مبيعات', 1, { items: [{ code: 'A', qty: 1, productId: 'p4' }] })];
  const { issues } = analyze(data);
  for (const name of ['duplicateExactSku', 'duplicateTrimmedSku', 'caseFoldSkuCollision', 'missingOrInvalidSku', 'productIdSkuMismatch']) {
    assert.equal(issues[name].count, 1, name);
  }
});

test('case-fold candidates do not change existing case-sensitive stock matching', () => {
  const data = fixture();
  data.transactions = [tx('مبيعات', 1, { items: [{ code: 'a', qty: 1 }] })];
  const report = analyze(data);
  assert.equal(report.stock[0].derivedAvailable, 10);
  assert.equal(report.issues.orphanedLineSku.count, 1);
});

test('non-numeric stock is withheld; fractions and negative balances are reported', () => {
  const data = fixture();
  data.transactions = [tx('مبيعات', '2')];
  assert.equal(analyze(data).stock[0].derivedAvailable, null);
  data.transactions = [tx('مبيعات', 10.5)];
  const report = analyze(data);
  assert.equal(report.issues.invalidUnitQuantity.count, 1);
  assert.equal(report.issues.invalidDerivedStock.count, 1);
});

test('renamed or deleted products cannot hide detached manual adjustments', () => {
  const data = fixture();
  data.inventorymovements = [{ _id: 'm1', productId: 'p1', productCode: 'OLD', sourceType: 'manual-adjustment', qtyDelta: 2 }];
  const report = analyze(data);
  assert.equal(report.issues.orphanedManualAdjustment.count, 1);
  assert.equal(report.issues.manualAdjustmentProductMismatch.count, 1);
  assert.equal(report.stock[0].derivedAvailable, 10);
});

test('outstanding sales are already deducted; physical candidates never add to availability', () => {
  const data = fixture();
  data.transactions = [tx('مبيعات', 3, { pickupStatus: 'Preparing' }),
    tx('مبيعات', 2, { pickupStatus: 'Ready', bostaStatus: 'IN_TRANSIT' })];
  const report = analyze(data);
  assert.equal(report.stock[0].derivedAvailable, 5);
  assert.equal(report.stock[0].unshippedSaleDemandCandidate, 3);
  assert.equal(report.enforcementReady, false);
});

test('received PO is excluded from stock until linked purchase exists', () => {
  const data = fixture();
  data.purchaseorders = [{ _id: 'po', status: 'مستلم', items: [{ productCode: 'A', qty: 5 }] }];
  const report = analyze(data);
  assert.equal(report.receivedPurchaseOrdersWithoutInvoice, 1);
  assert.equal(report.stock[0].derivedAvailable, 10);
});

test('pending Shopify placeholders are reported without inventing a product', () => {
  const data = fixture();
  data.shopifyorders = [{ _id: 's1', status: 'pending', items: [{ code: 'SHOPIFY', qty: 2 }] }];
  assert.equal(analyze(data).issues.unlinkedPendingShopifyLine.count, 1);
});

test('missing collections are explicit; offline backup format works; malformed input fails', () => {
  assert.equal(analyze({ products: fixture().products }).stock[0].derivedAvailable, null);
  assert.equal(analyze({ data: fixture() }).stock[0].derivedAvailable, 10);
  assert.throws(() => analyze({ products: {} }));
});

test('fingerprints are order-independent; private customer fields are neither printed nor hashed', () => {
  const data = fixture();
  data.transactions = [tx('مبيعات', 1), tx('مشتريات', 2, { _id: 't2' })];
  const before = analyze(data);
  data.transactions.reverse();
  data.transactions[0].phone = 'PRIVATE-PHONE';
  const after = analyze(data);
  assert.deepEqual(before.fingerprints, after.fingerprints);
  assert.ok(!JSON.stringify(after).includes('PRIVATE-PHONE'));
  data.transactions[0].total = 5;
  assert.notEqual(analyze(data).fingerprints.transactions, before.fingerprints.transactions);
});

test('live reader uses only read operations and reports standalone/index evidence', async () => {
  const calls = [];
  const result = await readDatabase({
    command: async value => { calls.push(value); assert.deepEqual(value, { hello: 1 }); return { maxWireVersion: 21 }; },
    listCollections: () => ({ toArray: async () => [{ name: 'products' }] }),
    collection: name => ({
      find: (filter, options) => { calls.push({ name, filter }); assert.equal(options.maxTimeMS, 30000); return { toArray: async () => [] }; },
      listIndexes: () => ({ toArray: async () => [{ name: 'code_1', key: { code: 1 }, unique: true }] }),
    }),
  });
  assert.equal(result.evidence.topology, 'standalone');
  assert.equal(result.evidence.uniqueProductCodeIndex, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(result.data), ['products']);
});

test('CLI cannot implicitly load production configuration or combine input modes', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--db', 'soulia']));
  assert.throws(() => parseArgs(['--snapshot', 'backup.json', '--db', 'soulia']));
  assert.throws(() => parseArgs(['--uri', 'secret']));
  assert.deepEqual(parseArgs(['--uri-env', 'READ_URI', '--db', 'scratch']), { '--uri-env': 'READ_URI', '--db': 'scratch' });
});

test('diagnostic arithmetic agrees with the actual shipped getInventory method', async () => {
  // Extract actual methods with the TS parser so a change to production stock logic breaks this test.
  const backendRequire = createRequire(path.resolve(__dirname, '../backend/package.json'));
  const ts = backendRequire('typescript');
  const file = fs.readFileSync(path.resolve(__dirname, '../backend/src/transactions/transactions.service.ts'), 'utf8');
  const tree = ts.createSourceFile('service.ts', file, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'TransactionsService');
  const wanted = ['getInventory', 'transactionAddsSupplierPurchases', 'transactionAddsReturnToStock',
    'isApprovedReturnInboundNotes', 'isCustomerReturnToStockType', 'returnedItemQtyForStock'];
  const methods = cls.members.filter(node => wanted.includes(node.name?.getText(tree)));
  assert.equal(methods.length, wanted.length);
  const js = ts.transpileModule(`class StockOracle { ${methods.map(node => node.getText(tree)).join('\n')} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;
  const Oracle = new Function(js + '; return StockOracle;')();
  const data = fixture();
  data.transactions = [tx('مشتريات', 5), tx('مبيعات', 3), tx('مرتجع', 2),
    tx('مرتجع', 4, { items: [{ code: 'A', qty: 4, condition: 'تالف' }] }),
    tx('مشتريات', 3, { ref: '10-RET' }), tx('مرتجع مشتريات', 2), tx('مبيعات', 5, { cancelled: true })];
  data.inventorymovements = [{ productCode: 'A', sourceType: 'manual-adjustment', qtyDelta: -1 }];
  const service = new Oracle();
  service.productsService = { findAll: async () => data.products };
  service.transactionModel = { find: () => ({ exec: async () => data.transactions.filter(row => row.cancelled !== true && row.archived !== true) }) };
  service.inventoryMovementsService = { getManualAdjustmentQtyByProductCode: async () => new Map([['A', -1]]) };
  assert.equal(analyze(data).stock[0].derivedAvailable, (await service.getInventory())[0].current);
});
