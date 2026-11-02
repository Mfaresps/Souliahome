// Synthetic CPU benchmark only; never connects to application data.
// Optional first argument: path to a saved pre-change transactions.service.ts.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { runInNewContext } = require('vm');
const ts = require('../backend/node_modules/typescript');
const root = path.resolve(__dirname, '..');
const file = 'backend/src/transactions/transactions.service.ts';
const before = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : execFileSync('git', ['show', 'HEAD:' + file], { cwd: root, encoding: 'utf8' });
const after = fs.readFileSync(path.join(root, file), 'utf8');
const methods = ['getInventory', 'transactionAddsSupplierPurchases', 'transactionAddsReturnToStock', 'returnedItemQtyForStock', 'isApprovedReturnInboundNotes', 'isCustomerReturnToStockType'];
function service(source, products, transactions) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'TransactionsService');
  const body = cls.members.filter(node => node.name && methods.includes(node.name.getText(ast))).map(node => node.getText(ast)).join('\n');
  const js = ts.transpileModule('class InventoryBenchmark {' + body + '}\nInventoryBenchmark;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const Model = runInNewContext(js, { MAIN_WAREHOUSE: 'MAIN', warehouseCode: value => !value || value === 'main' ? 'MAIN' : value, legacyReceiptLocations: async () => new Map() });
  const instance = new Model();
  const query = { select: () => query, lean: () => query, exec: async () => transactions };
  instance.productsService = { findAll: async () => products };
  instance.transactionModel = { find: () => query, db: { collection: () => ({ find: () => ({ toArray: async () => [] }) }) } };
  instance.inventoryMovementsService = { getManualAdjustmentQtyByProductCode: async () => new Map(), getManualAdjustmentWarehouseRows: async () => [] };
  return instance;
}
(async () => {
  const products = Array.from({ length: 800 }, (_, i) => ({ _id: String(i), code: 'P' + i, openingBalance: 1000, minStock: 10 }));
  const transactions = Array.from({ length: 18000 }, (_, i) => ({ _id: String(i), type: ['مبيعات', 'مشتريات', 'مرتجع', 'مرتجع مشتريات'][i % 4], ref: String(i), date: '2026-10-01',
    items: Array.from({ length: 3 }, (_, j) => ({ code: 'P' + ((i * 7 + j) % products.length), qty: 2, condition: i % 11 === 0 ? 'تالف' : '' })) }));
  const oldService = service(before, products, transactions), newService = service(after, products, transactions);
  const oldRows = await oldService.getInventory(), newRows = await newService.getInventory();
  assert.deepEqual(JSON.parse(JSON.stringify(newRows)), JSON.parse(JSON.stringify(oldRows)));
  async function median(instance) {
    const times = [];
    for (let i = 0; i < 3; i++) { const start = performance.now(); await instance.getInventory(); times.push(performance.now() - start); }
    return times.sort((a, b) => a - b)[1];
  }
  const beforeMs = await median(oldService), afterMs = await median(newService);
  const result = { scope: 'Synthetic inventory calculation only, excludes database and network latency', products: products.length, transactions: transactions.length, lines: transactions.length * 3,
    identicalResults: true, beforeMs: +beforeMs.toFixed(1), afterMs: +afterMs.toFixed(1), speedup: +(beforeMs / afterMs).toFixed(1) };
  fs.mkdirSync(path.join(__dirname, 'shopify-bulk-performance'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'shopify-bulk-performance/benchmark.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
