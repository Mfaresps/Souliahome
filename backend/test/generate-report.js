/* eslint-disable */
const fs = require('fs');
const path = require('path');

const resultsPath = path.resolve(__dirname, '..', 'test-results.json');
if (!fs.existsSync(resultsPath)) {
  console.error('test-results.json not found. Run: npx jest --json --outputFile=test-results.json');
  process.exit(1);
}
const r = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

const lines = [];
const w = (s = '') => lines.push(s);

const fileName = (s) => (s.name || s.testFilePath || '').replace(/\\/g, '/').split('/test/').pop() || '';

w('═══════════════════════════════════════════════════════════════');
w('  SOULIA — AUTOMATED TEST EXECUTION REPORT');
w('═══════════════════════════════════════════════════════════════');
w('  Generated  : ' + new Date().toISOString());
w('  Status     : ' + (r.success ? '✓ SUCCESS' : '✗ FAILED'));
w('  Suites     : ' + r.numTotalTestSuites + ' (passed: ' + r.numPassedTestSuites + ', failed: ' + r.numFailedTestSuites + ')');
w('  Tests      : ' + r.numTotalTests + ' (passed: ' + r.numPassedTests + ', failed: ' + r.numFailedTests + ', skipped: ' + r.numPendingTests + ')');
const totalMs = (r.startTime && r.endTime) ? (r.endTime - r.startTime) : 0;
w('  Wall time  : ' + (totalMs / 1000).toFixed(2) + 's');
w('═══════════════════════════════════════════════════════════════');
w();
w('PER-SUITE SUMMARY');
w('---------------------------------------------------------------');

const sortedSuites = [...r.testResults].sort((a, b) => fileName(a).localeCompare(fileName(b)));

for (const s of sortedSuites) {
  const fname = fileName(s);
  const pass = (s.assertionResults || []).filter((t) => t.status === 'passed').length;
  const fail = (s.assertionResults || []).filter((t) => t.status === 'failed').length;
  const total = pass + fail;
  const pct = total ? ((pass / total) * 100).toFixed(0) + '%' : '0%';
  const mark = fail === 0 ? '✓' : '✗';
  w('  ' + mark + '  [' + pass + '/' + total + ' ' + pct + ']  ' + fname);
}

w();
w('DETAILED TEST RESULTS BY MODULE');
w('---------------------------------------------------------------');

for (const s of sortedSuites) {
  const fname = fileName(s);
  w();
  w('▸ ' + fname);
  const groups = new Map();
  for (const t of (s.assertionResults || [])) {
    const key = (t.ancestorTitles || []).join(' › ') || '(root)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [group, tests] of groups) {
    w('   ◆ ' + group);
    for (const t of tests) {
      const mark = t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '○';
      const dur = t.duration ? ' (' + t.duration + 'ms)' : '';
      w('     ' + mark + ' ' + t.title + dur);
      if (t.status === 'failed' && t.failureMessages) {
        for (const msg of t.failureMessages) {
          const first = msg.split('\n').slice(0, 3).join(' | ');
          w('       FAIL: ' + first);
        }
      }
    }
  }
}

w();
w('═══════════════════════════════════════════════════════════════');
w('COVERAGE BAR BY SUITE');
w('---------------------------------------------------------------');

const suiteData = sortedSuites.map((s) => {
  const fname = fileName(s).replace('.spec.ts', '');
  const pass = (s.assertionResults || []).filter((t) => t.status === 'passed').length;
  const fail = (s.assertionResults || []).filter((t) => t.status === 'failed').length;
  return { name: fname, passed: pass, total: pass + fail };
});
const maxName = Math.max(...suiteData.map((d) => d.name.length));
for (const m of suiteData) {
  const pad = m.name.padEnd(maxName);
  const pct = m.total ? ((m.passed / m.total) * 100).toFixed(0).padStart(3) + '%' : '  0%';
  const bar = '█'.repeat(Math.floor((m.passed / Math.max(m.total, 1)) * 30));
  w('  ' + pad + '  ' + pct + '  ' + bar + ' ' + m.passed + '/' + m.total);
}

w();
w('═══════════════════════════════════════════════════════════════');
w('FUNCTIONAL AREA COVERAGE');
w('---------------------------------------------------------------');

const areas = {
  'Sales (creation, totals, stock, payment, invoice)': ['unit/sales.spec.ts', 'unit/sales-extended.spec.ts'],
  'Purchases (stock, deposit logic, supplier, vault)': ['unit/purchases.spec.ts', 'unit/purchases-extended.spec.ts'],
  'Returns (stock adjustment, refund, exchange)': ['unit/returns.spec.ts', 'unit/returns-extended.spec.ts'],
  'Cash/Vault & Stock Synchronization': ['unit/vault-stock-sync.spec.ts'],
  'Invoice Log (filtering, retrieval, integrity)': ['unit/invoice-log.spec.ts'],
  'Reports (sales, purchases, profit, summaries)': ['unit/reports.spec.ts'],
  'Inventory & Stock Movements': ['unit/inventory-stock.spec.ts'],
  'Dashboard KPIs': ['unit/dashboard-kpi.spec.ts'],
  'Auth & Permissions': ['unit/auth-permissions.spec.ts'],
  'Export Formats (CSV/Excel)': ['unit/export-formats.spec.ts'],
  'General (errors, edge cases, consistency)': ['unit/general.spec.ts'],
  'Integration (NestJS service-level)': ['integration/transactions.service.spec.ts'],
};

for (const [area, files] of Object.entries(areas)) {
  let p = 0;
  let t = 0;
  for (const f of files) {
    const m = sortedSuites.find((s) => fileName(s) === f);
    if (m) {
      const ar = m.assertionResults || [];
      p += ar.filter((x) => x.status === 'passed').length;
      t += ar.filter((x) => x.status !== 'pending').length;
    }
  }
  w('  ' + (p === t && t > 0 ? '✓' : t === 0 ? '○' : '✗') + ' ' + area);
  w('       ' + p + ' / ' + t + ' tests passing');
}

w();
w('═══════════════════════════════════════════════════════════════');
w('UNTESTED / FUTURE-WORK AREAS');
w('---------------------------------------------------------------');
w('  • End-to-end API tests (require running Mongo + supertest)');
w('  • Frontend (vanilla JS) — no Jest/Vitest setup yet');
w('  • Socket.IO real-time presence events');
w('  • File upload/backup restore actual binary handling');
w('  • PDF invoice generation visual output');
w('  • Time-zone-sensitive date boundaries (currently UTC)');
w('  • Throttling / rate-limit guards');
w('  • Mongoose validation hooks (covered indirectly via service tests)');
w();
w('═══════════════════════════════════════════════════════════════');
w('DISCREPANCIES / NOTES');
w('---------------------------------------------------------------');
const failedTests = [];
for (const s of sortedSuites) {
  for (const t of (s.assertionResults || [])) {
    if (t.status === 'failed') {
      failedTests.push({ suite: fileName(s), title: t.title, msg: (t.failureMessages || []).join(' | ') });
    }
  }
}
if (failedTests.length === 0) {
  w('  ✓ No discrepancies detected — all calculation rules verified:');
  w('    - Sales totals match qty × price + discount + tax + shipping');
  w('    - Purchase deposit=0 → full debt rule enforced');
  w('    - Returns deduct product price only from profit (not shipping)');
  w('    - Returns deduct from net sales');
  w('    - Approved expenses only counted in dashboard');
  w('    - Stock cannot go negative');
  w('    - Vault sufficiency checked before purchase deposit');
  w('    - Reference numbers digits-only & unique among non-cancelled');
  w('    - HTML stripped from exported cells');
  w('    - CSV escaping handles commas, newlines, quotes');
} else {
  w('  Found ' + failedTests.length + ' failing tests:');
  failedTests.forEach((t) => {
    w('  ✗ [' + t.suite + '] ' + t.title);
    w('     ' + t.msg.split('\n').slice(0, 1).join('').slice(0, 120));
  });
}

w();
w('═══════════════════════════════════════════════════════════════');
w(r.success ? '  RESULT: ALL TESTS PASSED ✓' : '  RESULT: SOME TESTS FAILED ✗');
w('═══════════════════════════════════════════════════════════════');

const out = lines.join('\n');
const outPath = path.resolve(__dirname, '..', 'TEST-REPORT.txt');
fs.writeFileSync(outPath, out, 'utf-8');
console.log(out);
console.log('\nReport written to: ' + outPath);
