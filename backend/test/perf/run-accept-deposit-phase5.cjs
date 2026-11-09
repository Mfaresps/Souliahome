/* Run only against a fresh, throwaway database. Never reuse the application's DB name. */
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const source = process.env.MONGODB_URI;
if (!source) throw new Error('MONGODB_URI is required for isolated measurements');
const uri = new URL(source);
const name = `soulia_test_deposit_receipts_phase5_${process.pid}_${randomUUID().slice(0, 8)}`;
uri.pathname = '/' + name;
if (!/^soulia_test_deposit_receipts_phase5_[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Unsafe test database name');
const jest = require.resolve('jest/bin/jest');
const args = process.argv.slice(2);
const suite = args.includes('--integration') ? '../integration/shopify-deposit-receipts.service.spec.ts' : 'accept-deposit-phase5.spec.ts';
const result = spawnSync(process.execPath, [jest, '--runInBand', '--runTestsByPath',
  path.resolve(__dirname, suite), ...args.filter(arg => arg !== '--integration')], {
  cwd: path.resolve(__dirname, '../..'),
  env: { ...process.env, TEST_MONGODB_URI: uri.toString() },
  stdio: 'inherit',
});
process.exit(result.status == null ? 1 : result.status);
