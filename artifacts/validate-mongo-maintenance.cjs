const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2] || 'Jenkins.mongo-maintenance.groovy';
const text = fs.readFileSync(file, 'utf8');
const match = text.match(/sh '''([\s\S]*?)'''/);
if (!match) throw Error('Missing maintenance shell');
// Groovy single/triple-single strings interpret these escapes before invoking sh.
const shell = match[1].replace(/\\([\\nrt'"])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
let javascriptBlocks = 0;
for (const match of shell.matchAll(/<<'JS'\n([\s\S]*?)\nJS/g)) {
  new vm.Script(match[1]); javascriptBlocks++;
}
for (const match of shell.matchAll(/node -e '([^']+)'/g)) {
  new vm.Script(match[1]); javascriptBlocks++;
}
const expected = file.includes('override-check') ? 1 : 7;
if (javascriptBlocks !== expected) throw Error(`Unexpected JavaScript block count: ${javascriptBlocks}`);
const output = file.includes('override-check') ? 'artifacts/mongo-override-check.sh' : 'artifacts/mongo-maintenance-reviewed.sh';
fs.writeFileSync(output, shell);
console.log(`Parsed ${javascriptBlocks} embedded JavaScript blocks; extracted shell for bash -n.`);
