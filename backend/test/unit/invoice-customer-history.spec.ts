import * as fs from 'fs';
import * as path from 'path';

export {};

const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
const keyStart = source.indexOf('function _spPhoneKey(');
const phoneKey = source.slice(keyStart, source.indexOf('\n}', keyStart) + 2);
const historyBlocks = [...source.matchAll(/let _custHistory = \[\];[\s\S]*?const _custOrderCount = _custHistory.length;/g)];
if (keyStart < 0 || historyBlocks.length !== 2) throw new Error('Missing invoice customer history implementation');

const sale = (id: string, phone: string, extra: any = {}) => ({
  _id: id, phone, client: 'Customer', type: 'مبيعات', transactionDate: '2026-10-13', ...extra,
});

describe.each(historyBlocks.map((match, index) => [index === 0 ? 'invoice modal' : 'order page', match[0]]))('%s customer history', (_view, block) => {
  const history = new Function('tx', 'transactions', 'isPurchase', 'isReturn', 'isSupplierReturn', `
    ${phoneKey}
    ${block}
    return _custHistory;
  `) as (tx: any, transactions: any[], isPurchase?: boolean, isReturn?: boolean, isSupplierReturn?: boolean) => any[];

  it.each(['+201114701237', '201114701237', '00201114701237', '+20 111 470 1237', '1114701237'])('matches %s with the local phone in both directions', phone => {
    const local = sale('local', '01114701237');
    const international = sale('international', phone, { client: 'Different spelling' });
    expect(history(local, [local, international]).map(tx => tx._id)).toEqual(['international']);
    expect(history(international, [local, international]).map(tx => tx._id)).toEqual(['local']);
  });

  it('excludes the current order, other numbers, purchases and returns', () => {
    const current = sale('current', '+201114701237');
    const previous = sale('previous', '01114701237');
    expect(history(current, [current, previous, sale('other', '01114701238'),
      sale('purchase', '01114701237', { type: 'مشتريات' }),
      sale('return', '01114701237', { type: 'مرتجع' }),
    ]).map(tx => tx._id)).toEqual(['previous']);
  });

  it('keeps name matching when both orders have no phone', () => {
    const current = sale('current', '', { client: ' Customer ' });
    expect(history(current, [current, sale('previous', '', { client: 'CUSTOMER' })]).map(tx => tx._id)).toEqual(['previous']);
  });

  it('does not show sales history on a purchase or return', () => {
    const current = sale('current', '+201114701237');
    const orders = [sale('previous', '01114701237')];
    expect(history(current, orders, true)).toEqual([]);
    expect(history(current, orders, false, true)).toEqual([]);
  });
});
