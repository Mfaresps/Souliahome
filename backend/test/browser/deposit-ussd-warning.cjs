const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} is missing`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const warning = new Function(`
  const t = key => ({spDepAwaitingSend:'الصورة لا تؤكد إتمام التحويل. ارفع إيصال التنفيذ أو أكمل لمراجعة المدير.'})[key] || key;
  const tf = () => '';
  ${fn('_spReceiptWarningText')}
  ${fn('_spReceiptHasImageWarning')}
  return { message: _spReceiptWarningText({code:'awaiting-send'}), hasWarning: _spReceiptHasImageWarning({warnings:[{code:'awaiting-send'}]}) };
`)();
assert.match(warning.message, /لا تؤكد إتمام التحويل/);
assert.equal(warning.hasWarning, true);
console.log('PASS USSD send confirmation shows the manual-review warning');
