import { depositFromShopifyNote } from '../../src/shopify/shopify-note-deposit.util';

describe('Shopify note deposit', () => {
  it.each([
    ['ديبوزت: 500 فودافون كاش', 500, 'فودافون كاش'],
    ['تم دفع عربون ٥٠٠ عن طريق انستاباي', 500, 'Instapay'],
    ['Paid 250 deposit by bank transfer', 250, 'تحويل بنكي'],
    ['مقدم ۳۰۰', 300, ''],
    ['ديبوزت 1,000', 1000, ''],
  ])('reads an explicit paid amount from %s', (note, amount, method) => {
    expect(depositFromShopifyNote(note)).toEqual({ amount, method });
  });

  it.each([
    'Without deposit \n طلبت ٣ مرات',
    'بدون ديبوزت 500',
    'العنوان 500 شارع النصر',
    'ديبوزت 500 وعربون 300',
    'ديبوزت 0',
    'ديبوزت -500',
    'تم رد عربون 500',
  ])('does not invent a paid deposit from %s', note => {
    expect(depositFromShopifyNote(note)).toBeNull();
  });
});
