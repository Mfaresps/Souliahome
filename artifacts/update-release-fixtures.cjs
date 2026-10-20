const fs = require('node:fs');
const replacements = {
  'backend/test/integration/inventory-scanning-ui.spec.ts': [['Unit validated', 'Piece identified']],
  'backend/test/integration/inventory-unit-ui.spec.ts': [['Unit validated', 'Piece identified'], ['.iu-card input', '[data-unit-id]']],
  'backend/test/integration/inventory-unit-backend.spec.ts': [["warehouseCode: 'Main'", "warehouseCode: 'MAIN'"], ["warehouseCode: 'Main shelf'", "warehouseCode: 'MAIN'"]],
};
for (const [file, changes] of Object.entries(replacements)) {
  let source = fs.readFileSync(file, 'utf8');
  for (const [before, after] of changes) source = source.split(before).join(after);
  fs.writeFileSync(file, source);
}
