// Local, read-only OCR evaluation. Images and customer data are never uploaded.
// Usage: node test/manual/receipt-ocr.cjs <image ...>
const fs = require('fs');
const path = require('path');
const os = require('os');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
    experimentalDecorators: true, esModuleInterop: true,
  }}).outputText, filename);
};
process.env.NODE_ENV = 'test';
process.env.OCR_CACHE_DIR ||= path.join(os.tmpdir(), 'soulia-receipt-ocr-cache');
fs.mkdirSync(process.env.OCR_CACHE_DIR, { recursive: true });
const { DepositReceiptOcrService } = require('../../src/shopify/deposit-receipt-ocr.service.ts');
(async () => {
  const service = new DepositReceiptOcrService();
  try {
    for (const file of process.argv.slice(2)) {
      const result = await service.read(fs.readFileSync(file));
      // Deliberately omit sender, recipient, transfer reference and OCR text.
      console.log(JSON.stringify({ file: path.basename(file), amount: result.amount,
        method: result.method, confident: result.confident, ran: result.ran, ms: result.ms }));
    }
  } finally { await service.onModuleDestroy(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
