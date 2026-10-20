// Reproducible local camera bundle for the existing static nginx deployment.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules/@zxing/browser');
if (JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version !== '0.2.1') throw new Error('Unexpected ZXing version');
const target = path.join(root, 'public/vendor');
fs.mkdirSync(target, { recursive: true });
for (const [from, to] of [['umd/zxing-browser.min.js', 'zxing-browser-0.2.1.min.js'], ['LICENSE', 'zxing-browser-LICENSE.txt']]) fs.copyFileSync(path.join(source, from), path.join(target, to));
// The standalone UMD includes @zxing/library code under Apache-2.0.
fs.copyFileSync(path.join(root, 'node_modules/@zxing/library/LICENSE'), path.join(target, 'zxing-library-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'node_modules/ts-custom-error/LICENSE'), path.join(target, 'ts-custom-error-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'node_modules/@zxing/text-encoding/LICENSE.md'), path.join(target, 'zxing-text-encoding-LICENSE.txt'));
