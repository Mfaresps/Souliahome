import sharp from 'sharp';
import { toLatinDigits } from '../shared/digits.util';

/** A clock reading only: no date, timezone or AM/PM is inferred from a mobile status bar. */
export function parseScreenClock(text: string): string | null {
  const normalized = toLatinDigits(text).replace(/[\u200e\u200f\u061c]/g, '');
  const matches = [...normalized.matchAll(/(?<!\d)([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?!\d|\s*[:：])/g)];
  const values = [...new Set(matches.map(m => `${m[1].padStart(2,'0')}:${m[2]}`))];
  return values.length === 1 ? values[0] : null;
}

/** Find a tall, bright inner screenshot over a dimmed chat before reading its own status bar. */
export async function screenClockCrops(input: Buffer): Promise<{ crops: Buffer[]; source: 'screen-status-bar' | 'embedded-status-bar' }> {
  const oriented = await sharp(input).rotate().png().toBuffer();
  const meta = await sharp(oriented).metadata();
  const {data,info}=await sharp(oriented).resize({width:180,height:400,fit:'inside'}).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  const {width,height,channels}=info, mask=new Uint8Array(width*height), queue=new Int32Array(width*height);
  for(let p=0;p<mask.length;p++){
    const rgb=[data[p*channels],data[p*channels+1],data[p*channels+2]];
    if(Math.min(...rgb)>=48 && Math.max(...rgb)-Math.min(...rgb)<40)mask[p]=1;
  }
  let best: {left:number;top:number;right:number;bottom:number;count:number}|null=null;
  for(let p=0;p<mask.length;p++){
    if(!mask[p])continue;let head=0,tail=1;queue[0]=p;mask[p]=0;
    let left=width,right=0,top=height,bottom=0;
    while(head<tail){const at=queue[head++],x=at%width,y=Math.floor(at/width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(const next of [x>0?at-1:-1,x<width-1?at+1:-1,y>0?at-width:-1,y<height-1?at+width:-1])if(next>=0&&mask[next]){mask[next]=0;queue[tail++]=next;}
    }
    const w=right-left+1,h=bottom-top+1;
    if(left<width*.09||right>width*.91||top<height*.1||w<width*.25||h<height*.3||h/w<1.55||tail/(w*h)<.65)continue;
    if(!best||tail>best.count)best={left,top,right,bottom,count:tail};
  }
  const sx=meta.width!/width,sy=meta.height!/height;
  const bounds=best?{left:Math.floor(best.left*sx),top:Math.floor(best.top*sy),width:Math.floor((best.right-best.left+1)*sx),height:Math.floor((best.bottom-best.top+1)*sy)}:{left:0,top:0,width:meta.width!,height:meta.height!};
  const stripHeight=Math.max(1,Math.min(bounds.height,Math.ceil(bounds.height*.045)));
  const edgeWidth=Math.max(1,Math.floor(bounds.width*.18));
  const crops:Buffer[]=[];
  for(const left of [bounds.left,bounds.left+bounds.width-edgeWidth]){
    const crop=sharp(oriented).extract({left,top:bounds.top,width:edgeWidth,height:stripHeight}).grayscale().resize({height:180}).normalise();
    crops.push(await crop.clone().png().toBuffer());
  }
  return {crops,source:best?'embedded-status-bar':'screen-status-bar'};
}
