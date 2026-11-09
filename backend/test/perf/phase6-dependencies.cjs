// Conservative inventory of bindings in the Shopify tail that earlier code can call.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const opener = /<script>\r?\nconst qs =/.exec(html);
const start = opener?.index ?? -1;
const end = html.indexOf('</script>', start);
const source = html.slice(start + (opener?.[0].indexOf('>') || 0) + 1, end);
const marker = '// ===================== Shopify Orders =====================';
const cut = source.indexOf(marker);
if (start < 0 || end < 0 || cut < 0) throw new Error('Source boundary changed');
const prefix = source.slice(0, cut);
const tail = source.slice(cut);
const file = ts.createSourceFile('shopify.js', tail, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const bindings = [];
for (const statement of file.statements) {
  if (ts.isFunctionDeclaration(statement) && statement.name) bindings.push({ kind: 'function', name: statement.name.text });
  if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
    if (ts.isIdentifier(declaration.name)) bindings.push({ kind: 'variable', name: declaration.name.text });
}
const referenced = bindings.filter(({ name }) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(prefix));
console.log(JSON.stringify({ coreBytes: Buffer.byteLength(prefix), tailBytes: Buffer.byteLength(tail),
  bindings: bindings.length, earlierReferences: referenced }, null, 2));
