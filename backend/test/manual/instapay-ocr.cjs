// Local evaluation; original receipts and extracted personal fields stay on this machine.
// node test/manual/instapay-ocr.cjs <directory> [--expected <private-manifest.json>]
// Manifest: { "filename.jpeg": { "amount": 500, "senderHandle": "...", "reference": "...", "dateText": "..." } }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true, esModuleInterop: true },
}).outputText, filename);
process.env.NODE_ENV = 'test';
const { DepositReceiptOcrService } = require('../../src/shopify/deposit-receipt-ocr.service.ts');

(async () => {
  const directory = process.argv[2];
  if (!directory) throw new Error('Provide a local receipt directory');
  const expectedFlag = process.argv.indexOf('--expected');
  const expected = expectedFlag < 0 ? null : JSON.parse(fs.readFileSync(process.argv[expectedFlag + 1], 'utf8'));
  const files = fs.readdirSync(directory).filter(f => /\.(?:jpe?g|png|webp)$/i.test(f)).sort();
  const service = new DepositReceiptOcrService(), seen = new Map(), results = [];
  let mismatches = 0;
  try {
    for (const file of files) {
      const input = fs.readFileSync(path.join(directory, file));
      const hash = crypto.createHash('sha256').update(input).digest('hex');
      const duplicate = seen.has(hash);
      const result = duplicate ? seen.get(hash) : await service.read(input);
      seen.set(hash, result);
      if (!duplicate) results.push(result);
      const differences = expected ? Object.entries(expected[file] || {}).filter(([key, value]) => result[key] !== value).map(([key]) => key) : [];
      if (expected && !expected[file]) differences.push('missing manifest entry');
      mismatches += differences.length;
      // Field availability and failed field names only; do not print addresses, ids or OCR text.
      console.log(JSON.stringify({ file, duplicate, ran: result.ran, amount: result.amount != null,
        sender: !!result.senderHandle, reference: !!result.reference, date: !!result.dateText, ms: result.ms,
        ...(expected ? { differences } : {}) }));
    }
  } finally { await service.onModuleDestroy(); }
  const times = results.map(r => r.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ files: files.length, unique: seen.size, duplicates: files.length - seen.size,
    meanMs: Math.round(times.reduce((sum, ms) => sum + ms, 0) / (times.length || 1)),
    medianMs: times.length ? times[Math.floor(times.length / 2)] : 0,
    ...(expected ? { mismatches } : {}) }));
  if (mismatches || results.some(r => !r.ran)) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
