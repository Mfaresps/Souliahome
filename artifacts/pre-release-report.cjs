const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'frontend/public');
let checked = 0;
const syntaxFailures = [];
const check = (source, filename) => {
  try { new vm.Script(source, { filename }); checked++; }
  catch (error) { syntaxFailures.push({ filename, message: error.message }); }
};
for (const file of fs.readdirSync(publicDir).filter(name => name.endsWith('.js'))) {
  check(fs.readFileSync(path.join(publicDir, file), 'utf8'), file);
}
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (match[1].trim()) check(match[1], 'index.html inline');
}
const missingAssets = [];
for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))(?:\?[^"']*)?["']/gi)) {
  if (/^(?:https?:|\/\/)/.test(match[1])) continue;
  if (!fs.existsSync(path.join(publicDir, match[1].replace(/^\//, '')))) missingAssets.push(match[1]);
}
const results = {};
for (const name of ['unit', 'integration', 'maintenance', 'deposit', 'core-retry']) {
  const file = path.join(__dirname, `pre-release-${name}-results.json`);
  if (!fs.existsSync(file)) { results[name] = { completed: false }; continue; }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  results[name] = {
    completed: true, success: data.success,
    suites: { passed: data.numPassedTestSuites, failed: data.numFailedTestSuites, total: data.numTotalTestSuites },
    tests: { passed: data.numPassedTests, failed: data.numFailedTests, total: data.numTotalTests },
    failedSuites: data.testResults.filter(suite => suite.status === 'failed').map(suite => path.basename(suite.name)),
  };
}
const report = {
  generatedAt: new Date().toISOString(), decision: 'HOLD_RELEASE',
  scope: 'Local build, disposable database tests, browser checks and deployment source review. No live deployment or live business writes.',
  build: 'passed', localHealth: 'GET /api/health returned status ok',
  localStartup: 'passed: login appeared, splash dismissed, no page JavaScript errors',
  frontend: { checkedScripts: checked, syntaxFailures, missingAssets },
  results, overlappingTestRuns: true,
  fixes: [
    'Added warehouses and warehousetransfers to backup and coordinated restore section.',
    'Protected pack identities and warehouse transfer history from partial maintenance; added four regression tests.',
    'Added production config.js with same-origin API routing; development already serves the same configuration dynamically.',
  ],
  blockers: [
    'Checked-in docker-compose Mongo service has no replica set configuration; tracking writes require transactions. Actual production topology remains unverified.',
    'Required tracking index migration is explicit and is not performed by current deployment pipeline. Production indexes remain unverified.',
    'Required new backend/frontend files are untracked in Git; deployment must include a reviewed committed release.',
    'Test runs are not fully passing; fixtures have missing dependencies and browser checks require further triage. See individual result files.',
  ],
  integrations: {
    shopify: 'Local mocked configuration/webhook/token tests passed; actual live credentials, webhook delivery and scopes not verified.',
    bosta: 'Actual live credentials, webhook delivery and shipment creation not verified.',
    cloudflareR2: 'Local backup tests passed; live upload, download and restore not verified. Did not execute write-based connection test.',
  },
  beforeRelease: [
    'Inspect production Mongo topology and indexes with read-only access, then plan any required migration and rollback.',
    'Resolve failing test coverage and rerun relevant suites on the final release commit.',
    'Verify external integrations against staging, including shipment/webhook and backup restore workflows.',
    'Take and verify a full production backup; deploy only the reviewed commit after release blockers are resolved.',
  ],
};
fs.writeFileSync(path.join(__dirname, 'pre-release-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ decision: report.decision, frontend: report.frontend, results }, null, 2));
