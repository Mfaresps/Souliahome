import sharp from 'sharp';
import { parseScreenClock, screenClockCrops } from '../../src/shopify/receipt-screen-time.util';
import { depositHistory, receiptSender } from '../../src/shopify/deposit-receipt-history.util';

describe('screenshot status bar clock', () => {
  it.each([['9:06','09:06'],['٤:٠٦','04:06'],['23：59','23:59'],['45% 9:06','09:06']])('normalizes %s without inferring a date or AM/PM', (text, expected) => {
    expect(parseScreenClock(text)).toBe(expected);
  });
  it.each(['45% 4G 0.00KB/s','25:10','13:55:09','09:06 04:07','2026-09-17','1008835575'])('leaves ambiguous or invalid clock text blank: %s', text => {
    expect(parseScreenClock(text)).toBeNull();
  });
  it('crops a nested customer screenshot instead of the outer chat status bar', async () => {
    const inner=await sharp({create:{width:300,height:700,channels:3,background:'#606060'}}).png().toBuffer();
    const image=await sharp({create:{width:720,height:1600,channels:3,background:'#151515'}}).composite([{input:inner,left:210,top:430}]).png().toBuffer();
    const result=await screenClockCrops(image);
    expect(result.source).toBe('embedded-status-bar');expect(result.crops).toHaveLength(2);
  });
  it('keeps a full-screen screenshot separate from receipt-card OCR', async () => {
    const image=await sharp({create:{width:720,height:1600,channels:3,background:'#aaa'}}).png().toBuffer();
    expect((await screenClockCrops(image)).source).toBe('screen-status-bar');
  });
  it('never changes Registered on or invents the screenshot date', () => {
    const submittedAt='2026-10-11T12:00:00Z';
    const result=depositHistory([{depositReceipts:[{id:'r1',status:'معتمد',submittedAt,amount:500,ocr:{screenshotTime:'09:06',screenshotTimeSource:'screen-status-bar'}}]}],[],[],{});
    expect(result.rows[0]).toMatchObject({submittedAt:new Date(submittedAt).toISOString(),screenshotTime:'09:06'});
    expect(result.rows[0]).not.toHaveProperty('screenshotDate');
    expect(depositHistory([{depositReceipts:[{id:'r1',submittedAt,ocr:{screenshotTime:'09:06'}}]}],[],[],{screenshotTime:'10:00'}).total).toBe(0);
    expect(receiptSender({screenshotTime:'04:06'},{ocr:{screenshotTime:'09:06'}})).toMatchObject({screenshotTime:'04:06',screenshotTimeSource:'reviewed'});
    expect(()=>receiptSender({screenshotTime:'25:00'},{})).toThrow();
  });
});
