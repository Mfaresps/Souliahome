// Read-only TypeScript AST inventory of the generated classic-script core.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const target = path.resolve(__dirname, '../../../frontend/runtime/app-core.js');
const source = fs.readFileSync(target, 'utf8');
const tree = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const rows = [];
const declared = new Map();
for (const statement of tree.statements) {
  const names = [];
  if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);
  if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations)
    if (ts.isIdentifier(d.name)) names.push(d.name.text);
  if (ts.isClassDeclaration(statement) && statement.name) names.push(statement.name.text);
  const start = statement.getStart(tree), end = statement.end;
  const row = { names, kind: ts.SyntaxKind[statement.kind], bytes: Buffer.byteLength(source.slice(start, end)),
    line: tree.getLineAndCharacterOfPosition(start).line + 1 };
  rows.push(row);
  for (const name of names) declared.set(name, [...(declared.get(name) || []), row.line]);
}
const duplicates = [...declared].filter(([, lines]) => lines.length > 1)
  .map(([name, lines]) => ({ name, lines }));
const buckets = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000, Infinity].slice(1).map((limit, i, arr) => {
  const low = i === 0 ? 0 : arr[i - 1];
  const members = rows.filter(r => r.bytes >= low * 1024 && r.bytes < limit * 1024);
  return { kb: `${low}-${limit}`, statements: members.length, bytes: members.reduce((sum, r) => sum + r.bytes, 0) };
});
console.log(JSON.stringify({ bytes: Buffer.byteLength(source), statements: rows.length,
  top: [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 40), buckets, duplicates }, null, 2));
