import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext, Script } from 'vm';
const source = readFileSync(resolve(__dirname, '../../../frontend/public/failed-delivery-identities.js'), 'utf8');
function fixture() {
  const select = { value: '' }, input = { checked: false }, button = { hidden: true };
  const row = { dataset: { fdiPiece: '0' }, querySelector: (tag: string) => ({ select, input, button }[tag]) };
  const host = { isConnected: true, textContent: '', innerHTML: '', querySelectorAll: () => [row], querySelector: () => row };
  const c: any = { currentLang: 'en', document: { getElementById: () => host }, window: {},
    api: jest.fn(async () => ({ receiptIdentities: [{ unitId: 'unit-one', barcode: 'SU-ONE' }] })) };
  runInNewContext(source, c);
  return { c, select, input, host, ui: c.window.FailedDeliveryIdentities };
}
it('blocks closing while identities are loading or any piece lacks physical confirmation', async () => {
  const { ui, input, select } = fixture();
  expect(() => ui.collect('sale')).toThrow();
  await ui.load('sale');
  expect(() => ui.collect('sale')).toThrow();
  select.value = 'intact';
  expect(() => ui.collect('sale')).toThrow();
  input.checked = true;
  expect(ui.collect('sale')).toEqual([{ unitId: 'unit-one', labelState: 'intact', labelAttached: true }]);
  expect(() => ui.collect('another-sale')).toThrow();
});
it('requires a print request before accepting attachment of an obscured label', async () => {
  const { ui, input, select } = fixture(); await ui.load('sale');
  select.value = 'reprinted'; input.checked = true;
  expect(() => ui.collect('sale')).toThrow('print obscured identities');
});
it('returns untracked products without label confirmation or printing', async () => {
  const { ui, c, host } = fixture();
  c.api.mockResolvedValue({ receiptIdentities: [] });
  await expect(ui.collectForReturn('sale')).resolves.toEqual([]);
  expect(host.textContent).toContain('without labels or printing');
});
it('checks the server and accepts untracked returns even if the label panel is absent', async () => {
  const { ui, c } = fixture();
  c.document.getElementById = () => null;
  c.api.mockResolvedValue({ receiptIdentities: [] });
  await expect(ui.collectForReturn('sale')).resolves.toEqual([]);
  expect(c.api).toHaveBeenCalled();
});
it('does not bypass tracked pieces when the label panel is absent', async () => {
  const { ui, c } = fixture();
  c.document.getElementById = () => null;
  await expect(ui.collectForReturn('sale')).rejects.toThrow('Reopen this window');
});
it('does not interpret an API failure as an untracked order', async () => {
  const { ui, c } = fixture();
  c.document.getElementById = () => null;
  c.api.mockRejectedValue(new Error('Network unavailable'));
  await expect(ui.collectForReturn('sale')).rejects.toThrow('Network unavailable');
});
it('parses the modified inline application scripts', () => {
  const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=|application\/ld\+json|application\/json/i.test(match[1])) expect(() => new Script(match[2])).not.toThrow();
  }
});
