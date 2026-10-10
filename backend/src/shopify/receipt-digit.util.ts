import sharp from 'sharp';
import { ARABIC_RECEIPT_DIGITS } from './receipt-digit-templates';

export interface ReceiptDigitShape { pixels: string; aspect: number; relativeHeight: number }

/** Split the isolated amount ink into glyphs; no screenshot identity or customer fields. */
export async function receiptDigitShapes(image: Buffer): Promise<ReceiptDigitShape[]> {
  const {data,info}=await sharp(image).grayscale().raw().toBuffer({resolveWithObject:true});
  const groups:Array<{left:number;right:number;top:number;bottom:number}>=[];
  for(let x=0;x<info.width;x++) {
    if(!Array.from({length:info.height},(_,y)=>data[y*info.width+x]).some(v=>v<128)) continue;
    const left=x;let top=info.height,bottom=0;
    while(x<info.width && Array.from({length:info.height},(_,y)=>data[y*info.width+x]).some(v=>v<128)) {
      for(let y=0;y<info.height;y++) if(data[y*info.width+x]<128) {top=Math.min(top,y);bottom=Math.max(bottom,y);}
      x++;
    }
    groups.push({left,right:x-1,top,bottom});
  }
  const maxHeight=Math.max(...groups.map(g=>g.bottom-g.top+1));
  return Promise.all(groups.map(async g=>{
    const width=g.right-g.left+1,height=g.bottom-g.top+1;
    const pixels=await sharp(image).extract({left:g.left,top:g.top,width,height}).grayscale()
      .resize(16,24,{fit:'fill'}).raw().toBuffer();
    return {pixels:Array.from(pixels,v=>v<128?'1':'0').join(''),aspect:width/height,relativeHeight:height/maxHeight};
  }));
}

/** Strict template fallback for the stylised Arabic digits Tesseract confuses with letters. */
export async function readArabicTealAmount(image: Buffer): Promise<number | null> {
  const shapes=await receiptDigitShapes(image);
  if(shapes.length<2 || shapes.length>7) return null;
  let digits='';
  for(const shape of shapes) {
    const ranked=ARABIC_RECEIPT_DIGITS.map(t=>({digit:t.digit,
      error:Array.from(shape.pixels,(p,i)=>p===t.pixels[i]?0:1).reduce<number>((sum,v)=>sum+v,0)/384
        +Math.abs(shape.aspect-t.aspect)*.15+Math.abs(shape.relativeHeight-t.relativeHeight)*.2,
    })).sort((a,b)=>a.error-b.error);
    const first=ranked[0],other=ranked.find(t=>t.digit!==first.digit);
    if(!first || first.error>.13 || (other && other.error-first.error<.045)) return null;
    digits+=first.digit;
  }
  if(digits.startsWith('0')) return null;
  const amount=Number(digits);
  return amount<=1_000_000?amount:null;
}
