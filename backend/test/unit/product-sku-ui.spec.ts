import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';

const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(body => body.includes('async function saveProduct('))!;
const tree = ts.createSourceFile('product-ui.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function shipped(name: string): string {
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!fn) throw new Error(`Missing shipped function ${name}`);
  return fn.getText(tree);
}
function ui() {
  const values: Record<string, any> = {
    '#pm-name': { value: 'Changed name' }, '#pm-code': { value: 'INJECTED' },
    '#pm-opening': { value: '5' }, '#pm-sell': { value: '90' }, '#pm-buy': { value: '20' },
    '#pm-min': { value: '2' }, '#pm-size-standard': { value: 'Large' }, '#pm-code-hint': {},
  };
  const context: any = {
    qs: (key: string) => values[key], document: { querySelector: () => null },
    products: [{ _id: 'a'.repeat(24), code: 'ORIGINAL', name: 'Original' }],
    isAdmin: () => true, hasPerm: () => true, toast: jest.fn(), t: (key: string) => key,
    _pmSelectedColors: ['Red'], _pmSelectedFeatures: ['Waterproof'], _pmExtraImages: [], _pmEditingId: '',
    _pmSlugPreview: () => 'ALBA-001', _doSaveProduct: jest.fn(async () => {}),
    _doRequestProductEdit: jest.fn(async () => {}),
  };
  vm.createContext(context);
  vm.runInContext(['saveProduct', '_pmToggleLock', 'generateProductCodePreview'].map(shipped).join('\n'), context);
  return { context, values };
}

describe('Shipped product form SKU compatibility', () => {
  it('saves other editable fields without transmitting an existing SKU, even after DOM tampering', async () => {
    const { context } = ui();
    await context.saveProduct('a'.repeat(24));
    const [id, body] = context._doSaveProduct.mock.calls[0];
    expect(id).toBe('a'.repeat(24));
    expect(body).not.toHaveProperty('code');
    expect(body).toMatchObject({ name: 'Changed name', colors: ['Red'], size: 'Large', sellPrice: 90, buyPrice: 20, openingBalance: 5 });
  });
  it('keeps the ordinary staff edit-request workflow without asking for SKU authority', async () => {
    const { context } = ui(); context.isAdmin = () => false; context.hasPerm = () => false;
    await context.saveProduct('a'.repeat(24));
    expect(context._doRequestProductEdit).toHaveBeenCalled();
    expect(context._doRequestProductEdit.mock.calls[0][1]).not.toHaveProperty('code');
  });
  it('does not unlock or regenerate the SKU on an existing product', () => {
    const { context, values } = ui(); context._pmEditingId = 'a'.repeat(24);
    context._pmToggleLock('code'); context.generateProductCodePreview();
    expect(values['#pm-code'].value).toBe('INJECTED'); // No change by either command.
    expect(shipped('openProductModal')).not.toContain("_pmToggleLock('code')");
  });
  it('keeps generation as a preview so the backend chooses the actual unique suffix', () => {
    const { context, values } = ui(); context.generateProductCodePreview();
    expect(values['#pm-code'].value).toBe('');
    expect(values['#pm-code'].placeholder).toBe('ALBA-001');
    expect(values['#pm-code-hint'].textContent).toBe('pmSkuGeneratedOnSave');
  });
  it('blocks creation without SKU authority before any write', async () => {
    const { context } = ui(); context.hasPerm = () => false;
    await context.saveProduct();
    expect(context._doSaveProduct).not.toHaveBeenCalled(); expect(context.toast).toHaveBeenCalledWith('pmSkuPermission', true);
  });
});
