#!/usr/bin/env node
'use strict';
// Standalone index inspection/application. Never starts Nest, seeds data or loads .env.
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Inventory unit index migration (default: read-only inspection)\n' +
      'node scripts/inventory-unit-indexes.cjs --uri-env SOULIA_AUDIT_MONGODB_URI --db <database> [--apply]\n' +
      '--apply creates only the new tracking indexes/collections. It does not create units or migrate documents.\n' +
      'Use a read-only account for inspection; schema permissions are required for explicit application.\n');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--uri-env', '--db', '--apply'].includes(key) || Object.hasOwn(options, key)) throw new Error('Invalid arguments');
    if (key === '--apply') options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing argument');
      options[key] = value;
    }
  }
  if (!options['--db'] || !options['--uri-env'] || !process.env[options['--uri-env']]) throw new Error('Explicit connection required');
  const localRequire = createRequire(path.resolve(__dirname, '../backend/package.json'));
  // Use the application's build; ts-node is not installed in this checkout.
  // Refuse stale schema output rather than silently applying an older index plan.
  for (const name of ['inventory-unit-index.migration', 'inventory-unit.constants', 'inventory-unit-integrity',
    'schemas/inventory-unit.schema', 'schemas/inventory-unit-event.schema', 'schemas/inventory-unit-operation.schema']) {
    const source = path.resolve(__dirname, '../backend/src/inventory-units', name + '.ts');
    const built = path.resolve(__dirname, '../backend/dist/inventory-units', name + '.js');
    if (!fs.existsSync(built) || fs.statSync(built).mtimeMs < fs.statSync(source).mtimeMs) {
      throw new Error('Build backend before index inspection/migration');
    }
  }
  const mongoose = localRequire('mongoose');
  const { migrateInventoryUnitIndexes } = require('../backend/dist/inventory-units/inventory-unit-index.migration.js');
  const connection = mongoose.createConnection(process.env[options['--uri-env']], {
    dbName: options['--db'], autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000,
  });
  try {
    await connection.asPromise();
    process.stdout.write(JSON.stringify(await migrateInventoryUnitIndexes(connection.db, options['--apply'] === true), null, 2) + '\n');
  } finally { await connection.close(); }
}
main().catch(() => {
  process.stderr.write('Index inspection/migration incomplete. Build backend first; then check connection permissions, index conflicts and duplicate keys. No document migration was requested.\n');
  process.exitCode = 1;
});
