import sharp from 'sharp';
import { ARABIC_RECEIPT_DIGITS } from '../../src/shopify/receipt-digit-templates';
import { readArabicTealAmount } from '../../src/shopify/receipt-digit.util';

async function ink(digits:string):Promise<Buffer> {
  let left=10;const overlays=[];
  for(const digit of digits) {
    const t=ARABIC_RECEIPT_DIGITS.find(t=>t.digit===digit)!;
    const h=Math.round(t.relativeHeight*100),w=Math.round(t.aspect*h);
    const input=await sharp(Buffer.from(Array.from(t.pixels,p=>p==='1'?0:255)),{raw:{width:16,height:24,channels:1}})
      .resize(w,h,{fit:'fill'}).png().toBuffer();
    overlays.push({input,left,top:110-h});left+=w+12;
  }
  return sharp({create:{width:left+10,height:130,channels:3,background:'#fff'}}).composite(overlays).png().toBuffer();
}
describe('strict stylised Arabic digit fallback',()=>{
  it.each(['1270','400'])('recognises the learned numeric font at another size (%s)',async digits=>{
    expect(await readArabicTealAmount(await ink(digits))).toBe(Number(digits));
  });
  it('rejects leading-zero interpretations',async()=>{
    expect(await readArabicTealAmount(await ink('0400'))).toBeNull();
  });
  it('rejects empty images',async()=>{
    const image=await sharp({create:{width:150,height:80,channels:3,background:'#fff'}}).png().toBuffer();
    expect(await readArabicTealAmount(image)).toBeNull();
  });
});
