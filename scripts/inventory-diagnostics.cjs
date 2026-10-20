#!/usr/bin/env node
'use strict';

// Phase 1 only. No Nest bootstrap, Mongoose models, index creation, or database writes.
// Live mode requires an explicitly supplied URI environment variable and database name.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const FIELDS = {
  products: ['code', 'openingBalance', 'isActive', 'buyPrice', 'sellPrice'],
  transactions: ['type', 'ref', 'cancelled', 'archived', 'items', 'pickupStatus', 'prepChecked',
    'bostaStatus', 'bostaShippingStatus', 'shippedAt', 'deliveredAt', 'externalFulfillment',
    'failedDelivery', 'notes', 'supplierId', 'shopifyOrderId', 'date', 'total', 'deposit',
    'remaining', 'creditApplied', 'payStatus'],
  inventorymovements: ['productId', 'productCode', 'sourceType', 'sourceTransactionId', 'qtyDelta', 'createdAt'],
  shopifyorders: ['shopifyId', 'status', 'cancelled', 'items', 'total', 'deposit', 'remaining'],
  purchaseorders: ['status', 'linkedTransactionId', 'items', 'supplierId'],
  returnrequests: ['status', 'originalTransactionId', 'returnTxId', 'items', 'total', 'reversedAt'],
  supplierreturnorders: ['status', 'linkedTransactionId', 'items', 'total', 'settlement', 'reversal'],
  vaultentries: ['amount', 'seg', 'status', 'idempotencyKey'],
  supplierledgerentries: ['supplierId', 'amount', 'runningBalance', 'reversed', 'entryType'],
  settings: ['vaultCash', 'vaultVodafone', 'vaultInstapay', 'vaultBank', 'vaultBalance'],
};
const trim = value => String(value ?? '').trim();
const id = value => trim(value?.$oid ?? value);
const active = row => row.cancelled !== true && row.archived !== true;
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const increment = (map, key, amount) => map.set(key, (map.get(key) || 0) + amount);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    if (typeof value.toHexString === 'function') return value.toHexString();
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function project(name, row) {
  return Object.fromEntries(['_id', ...FIELDS[name]].filter(key => row[key] !== undefined)
    .map(key => [key, row[key]]));
}

function classify(tx) {
  const legacyReturn = tx.type === 'مشتريات' && (/-RET$/i.test(trim(tx.ref)) ||
    String(tx.notes || '').includes('مرتجع معتمد (طلب كان معلقاً)') ||
    String(tx.notes || '').startsWith('استبدال — مرتجع:'));
  if (tx.type === 'مشتريات' && !legacyReturn) return 'purchases';
  if (legacyReturn || ['مرتجع', 'مرتجع مبيعات'].includes(tx.type)) return 'returns';
  if (['مبيعات', 'مرتجع مشتريات'].includes(tx.type)) return 'outbound';
  return null;
}

function analyze(input, evidence = {}) {
  const source = input.data || input;
  const data = {};
  for (const name of Object.keys(FIELDS)) {
    if (source[name] !== undefined && !Array.isArray(source[name])) throw new Error(`Invalid collection: ${name}`);
    data[name] = (source[name] || []).map(row => project(name, row));
  }
  const missingCollections = Object.keys(FIELDS).filter(name => !Object.hasOwn(source, name));
  const issues = {};
  function issue(kind, detail) {
    issues[kind] ||= { count: 0, samples: [] };
    issues[kind].count++;
    if (issues[kind].samples.length < 20) issues[kind].samples.push(detail);
  }
  const byCode = new Map(), byId = new Map();
  for (const p of data.products) {
    const code = trim(p.code);
    byId.set(id(p._id), p);
    if (!code || typeof p.code !== 'string') issue('missingOrInvalidSku', { productId: id(p._id) });
    if (code !== p.code) issue('skuWhitespace', { productId: id(p._id), code });
    if (!numeric(p.openingBalance ?? 0) || !Number.isInteger(p.openingBalance ?? 0) || (p.openingBalance ?? 0) < 0) {
      issue('invalidOpeningBalance', { productId: id(p._id), code });
    }
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(p);
  }
  for (const [kind, normalize] of [
    ['duplicateExactSku', value => String(value ?? '')],
    ['duplicateTrimmedSku', trim],
    // Advisory only: the application is currently case-sensitive. Do not merge these.
    ['caseFoldSkuCollision', value => trim(value).toUpperCase()],
  ]) {
    const groups = new Map();
    for (const p of data.products) {
      const key = normalize(p.code);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id(p._id));
    }
    for (const [code, productIds] of groups) if (productIds.length > 1) issue(kind, { code, productIds });
  }
  const totals = new Map(), adjustments = new Map(), unshippedDemand = new Map();
  let invalidActiveItems = false;
  const invalidCodes = new Set();
  function inspectLine(line, context) {
    const code = trim(line.code ?? line.productCode);
    const candidates = byCode.get(code) || [];
    if (!code || !candidates.length) issue('orphanedLineSku', { ...context, code });
    if (line.productId) {
      const product = byId.get(id(line.productId));
      if (!product || trim(product.code) !== code) issue('productIdSkuMismatch', { ...context, code, productId: id(line.productId) });
    }
    if (!numeric(line.qty) || !Number.isInteger(line.qty) || line.qty <= 0) {
      issue('invalidUnitQuantity', { ...context, code, qty: line.qty });
    }
    return code;
  }
  for (const tx of data.transactions) {
    const txId = id(tx._id), kind = classify(tx), isActive = active(tx);
    if (!Array.isArray(tx.items)) {
      issue('invalidTransactionItems', { txId, active: isActive });
      if (isActive) invalidActiveItems = true;
      continue;
    }
    const uncertain = !!(tx.externalFulfillment || tx.failedDelivery);
    const pendingPhysical = tx.type === 'مبيعات' && isActive &&
      !tx.shippedAt && !tx.deliveredAt && !uncertain &&
      ['', 'Pending', 'Preparing', 'Ready', 'Picked-Up'].includes(tx.pickupStatus || '') &&
      !['Shipped', 'Delivered', 'PickedUp', 'InTransit', 'OutForDelivery', 'Returned'].includes(tx.bostaShippingStatus) &&
      !['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'LOST'].includes(tx.bostaStatus);
    if (tx.type === 'مبيعات' && isActive && !pendingPhysical && !tx.deliveredAt) {
      issue('physicalSaleDispositionNeedsReview', { txId, pickupStatus: tx.pickupStatus || '' });
    }
    tx.items.forEach((line, index) => {
      const code = inspectLine(line, { collection: 'transactions', id: txId, index, active: isActive });
      if (!isActive || !kind) return;
      if (!numeric(line.qty)) { invalidCodes.add(code); return; }
      if (!totals.has(code)) totals.set(code, { purchases: 0, returns: 0, outbound: 0 });
      const soundQty = trim(line.condition) === 'تالف' ? 0 : line.qty;
      totals.get(code)[kind] += kind === 'returns' ? soundQty : line.qty;
      if (pendingPhysical) increment(unshippedDemand, code, line.qty);
      if (kind === 'returns' && line.condition && !['سليم', 'تالف'].includes(trim(line.condition))) {
        issue('unknownReturnCondition', { txId, index, code });
      }
    });
  }
  for (const movement of data.inventorymovements) {
    if (movement.sourceType !== 'manual-adjustment') continue;
    const code = trim(movement.productCode);
    if (!code || !byCode.has(code)) issue('orphanedManualAdjustment', { id: id(movement._id), code });
    if (movement.productId && trim(byId.get(id(movement.productId))?.code) !== code) {
      issue('manualAdjustmentProductMismatch', { id: id(movement._id), code });
    }
    if (!numeric(movement.qtyDelta) || !Number.isInteger(movement.qtyDelta)) {
      issue('invalidAdjustmentQuantity', { id: id(movement._id), code });
      if (!numeric(movement.qtyDelta)) invalidCodes.add(code);
    }
    increment(adjustments, code, Number(movement.qtyDelta) || 0);
  }
  for (const name of ['shopifyorders', 'purchaseorders', 'returnrequests', 'supplierreturnorders']) {
    for (const row of data[name]) {
      const isPendingShopify = name === 'shopifyorders' && row.status === 'pending' && row.cancelled !== true;
      for (const [index, line] of (Array.isArray(row.items) ? row.items : []).entries()) {
        inspectLine(line, { collection: name, id: id(row._id), index });
        if (isPendingShopify && (!line.productId || line.code === 'SHOPIFY')) {
          issue('unlinkedPendingShopifyLine', { id: id(row._id), index, code: line.code || '' });
        }
      }
    }
  }
  const stock = data.products.map(p => {
    const code = trim(p.code), sums = totals.get(code) || { purchases: 0, returns: 0, outbound: 0 };
    const opening = Math.max(0, Math.floor(Number(p.openingBalance) || 0));
    const adjustmentQty = adjustments.get(code) || 0;
    // Numeric-only data mirrors getInventory/getAvailableQtyByProductCode. Refuse to certify malformed data.
    const incomplete = ['products', 'transactions', 'inventorymovements'].some(name => missingCollections.includes(name)) ||
      invalidActiveItems ||
      !numeric(p.openingBalance ?? 0);
    const available = incomplete || invalidCodes.has(code) ? null : opening + sums.purchases + sums.returns - sums.outbound + adjustmentQty;
    if (available !== null && (available < 0 || !Number.isInteger(available))) issue('invalidDerivedStock', { code, available });
    return { productId: id(p._id), code, opening, ...sums, adjustments: adjustmentQty,
      derivedAvailable: available, unshippedSaleDemandCandidate: unshippedDemand.get(code) || 0 };
  }).sort((a, b) => a.code.localeCompare(b.code) || a.productId.localeCompare(b.productId));
  const fingerprints = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name,
    createHash('sha256').update(JSON.stringify(rows.map(canonical)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex')]));
  return {
    reportVersion: 1, generatedAt: new Date().toISOString(), evidence,
    enforcementReady: false,
    limitations: [
      'Diagnostics only; this report never authorizes migration or enables enforcement.',
      'Sequential reads are not a point-in-time snapshot. A frozen cutover and physical count are required.',
      'Offline input has no verified live indexes/topology. Missing collections are not evidence of zero records.',
      'Unshipped demand is a review candidate, not proof of physical possession or a unit-creation instruction.',
      'Fingerprints cover projected fields only; they are not a backup or a full accounting reconciliation.',
      'SKU case folding is advisory only. Existing matching remains trimmed and case-sensitive.',
    ],
    missingCollections, counts: Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])),
    fingerprints, issues, stock,
    receivedPurchaseOrdersWithoutInvoice: data.purchaseorders.filter(p => p.status === 'مستلم' && !p.linkedTransactionId).length,
  };
}

async function readDatabase(db) {
  const startedAt = new Date().toISOString();
  const hello = await db.command({ hello: 1 });
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const data = {}, indexes = {};
  for (const name of Object.keys(FIELDS)) {
    if (!names.has(name)) continue;
    const collection = db.collection(name);
    data[name] = await collection.find({}, {
      projection: Object.fromEntries(['_id', ...FIELDS[name]].map(key => [key, 1])),
      maxTimeMS: 30000,
    }).toArray();
    indexes[name] = (await collection.listIndexes({ maxTimeMS: 30000 }).toArray()).map(index => ({
      name: index.name, key: index.key, unique: !!index.unique,
      sparse: !!index.sparse, partialFilterExpression: index.partialFilterExpression,
      collation: index.collation,
    }));
  }
  const topology = hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replica-set' : 'standalone';
  const uniqueProductCodeIndex = (indexes.products || []).some(index => index.unique &&
    Object.keys(index.key).length === 1 && index.key.code === 1 && !index.sparse && !index.partialFilterExpression);
  return { data, evidence: { mode: 'live-read-only', startedAt, finishedAt: new Date().toISOString(),
    topology, maxWireVersion: hello.maxWireVersion, sessionsAdvertised: hello.logicalSessionTimeoutMinutes != null,
    transactions: 'not exercised; topology evidence alone is insufficient', uniqueProductCodeIndex, indexes } };
}

function parseArgs(args) {
  if (args.includes('--help')) return { help: true };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--snapshot', '--db', '--uri-env'].includes(key) || !value || value.startsWith('--') || options[key]) {
      throw new Error('Invalid arguments; run with --help');
    }
    options[key] = value;
  }
  if (options['--snapshot']) {
    if (options['--db'] || options['--uri-env']) throw new Error('Choose snapshot OR live mode');
  } else if (!options['--db'] || !options['--uri-env']) {
    throw new Error('Live mode requires --db and --uri-env; no application configuration is loaded');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Read-only inventory/SKU diagnostics. Run from repository root:\n' +
      '  node scripts/inventory-diagnostics.cjs --snapshot <existing-backup.json>\n' +
      '  node scripts/inventory-diagnostics.cjs --uri-env SOULIA_AUDIT_MONGODB_URI --db <database>\n' +
      'Use a MongoDB read-role account; provision it outside this script. URI is never an argument or output.\n' +
      'No .env loading, application startup, writes, repairs, index creation, or transactions.\n' +
      'Output: JSON on stdout. Exit 0 = completed (may contain issues), 1 = incomplete/error.\n' +
      'Bounded samples omit customer details; review SKU/financial metadata locally before sharing.\n' +
      'Collections are read sequentially into memory: use a controlled snapshot for large datasets.\n' +
      'enforcementReady is always false; physical reconciliation and approval are separate.\n');
    return;
  }
  let report;
  if (options['--snapshot']) {
    report = analyze(JSON.parse(fs.readFileSync(options['--snapshot'], 'utf8')), { mode: 'offline-unverified' });
  } else {
    const uri = process.env[options['--uri-env']];
    if (!uri) throw new Error('The explicitly named URI environment variable is empty');
    const backendRequire = createRequire(path.resolve(__dirname, '../backend/package.json'));
    const { MongoClient } = backendRequire('mongoose').mongo;
    const client = new MongoClient(uri, { appName: 'SouliaPhase1ReadOnlyAudit',
      serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 35000,
      maxPoolSize: 1, retryWrites: false, readPreference: 'primary', readConcern: { level: 'majority' } });
    try {
      await client.connect();
      const result = await readDatabase(client.db(options['--db']));
      report = analyze(result.data, result.evidence);
    } finally { await client.close(); }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) main().catch(() => {
  // Driver errors can include credentials, hosts, or document values. Do not echo them.
  process.stderr.write('Diagnostics incomplete. Check arguments, input format, read permissions, and connectivity. No database changes requested.\n');
  process.exitCode = 1;
});
module.exports = { analyze, classify, readDatabase, parseArgs, FIELDS };
