'use strict';

// Read-only release gate. Never starts Nest, seeds data, builds indexes or rewrites stock.
async function inspect(connection, inspectIndexes) {
  const hello = await connection.db.admin().command({ hello: 1 });
  const transactionsSupported = !!(hello.setName || hello.msg === 'isdbgrid') &&
    hello.logicalSessionTimeoutMinutes != null && hello.maxWireVersion >= 8;
  const blockers = [];
  if (!transactionsSupported) blockers.push('MongoDB replica set or mongos with transaction support required');
  const indexes = await inspectIndexes(connection.db, false);
  if (indexes.collections.some(row => !row.exists || row.missing.length)) blockers.push('Explicit tracking index migration required');
  return { writesReady: blockers.length === 0, transactionsSupported, indexes, blockers };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const mongoose = require('mongoose');
  const { migrateInventoryUnitIndexes } = require('../dist/inventory-units/inventory-unit-index.migration.js');
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000,
  });
  try {
    await connection.asPromise();
    const result = await inspect(connection, migrateInventoryUnitIndexes);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.writesReady) process.exitCode = 1;
  } finally { await connection.close(); }
}

module.exports = { inspect };
if (require.main === module) main().catch(() => {
  // Driver errors may contain connection strings. Keep credentials out of CI logs.
  process.stderr.write('Inventory readiness failed: verify MongoDB access, topology and tracking indexes. Live application containers were not replaced by this check.\n');
  process.exitCode = 1;
});
