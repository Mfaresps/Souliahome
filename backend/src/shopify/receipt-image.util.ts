import sharp from 'sharp';

/** Vodafone's teal amount, isolated without black labels, fees, phone numbers or status icons. */
export async function receiptTealAmount(input: Buffer): Promise<Buffer | null> {
  const region = await receiptOcrRegion(input);
  const { data, info } = await sharp(region).resize({ width: 480, withoutEnlargement: true })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const {width, height, channels} = info;
  const rows: Array<{left:number;right:number;count:number}> = [];
  for(let y=0;y<height;y++) {
    let left=width,right=0,count=0;
    for(let x=0;x<width;x++) {
      const at=(y*width+x)*channels, r=data[at],g=data[at+1],b=data[at+2];
      if(g>50 && b>55 && r<g*.7 && r<b*.7 && b>g*.6 && b<g*1.7) {
        count++;left=Math.min(left,x);right=Math.max(right,x);
      }
    }
    rows.push({left,right,count});
  }
  let best:{left:number;right:number;top:number;bottom:number;count:number}|null=null;
  for(let y=Math.floor(height*.15);y<height*.62;y++) {
    if(rows[y].count<3) continue;
    let left=width,right=0,count=0;const top=y;
    while(y<height*.62 && rows.slice(y,y+3).some(row=>row.count>=3)) {
      left=Math.min(left,rows[y].left);right=Math.max(right,rows[y].right);count+=rows[y].count;y++;
    }
    const bottom=y-1,w=right-left+1,h=bottom-top+1;
    if(count<40 || w<width*.1 || w>width*.7 || h<height*.01 || h>height*.12) continue;
    if(!best || count>best.count) best={left,right,top,bottom,count};
  }
  if(!best) return null;
  // Build a binary mask from the selected ink, so pale backgrounds and neighbouring labels vanish.
  const pad=12,w=best.right-best.left+1+pad*2,h=best.bottom-best.top+1+pad*2;
  const mask=Buffer.alloc(w*h,255);
  for(let y=best.top;y<=best.bottom;y++) for(let x=best.left;x<=best.right;x++) {
    const at=(y*width+x)*channels,r=data[at],g=data[at+1],b=data[at+2];
    if(g>50 && b>55 && r<g*.7 && r<b*.7 && b>g*.6 && b<g*1.7) mask[(y-best.top+pad)*w+x-best.left+pad]=0;
  }
  return sharp(mask,{raw:{width:w,height:h,channels:1}}).resize({height:180}).png().toBuffer();
}

/** Isolate a light receipt over a dimmed chat for OCR only. Never changes the stored image. */
export async function receiptOcrRegion(input: Buffer): Promise<Buffer> {
  const oriented = await sharp(input).rotate().png().toBuffer();
  const meta = await sharp(oriented).metadata();
  const { data, info } = await sharp(oriented)
    .resize({ width: 256, height: 512, fit: 'inside', withoutEnlargement: true })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) {
    const rgb = [data[p * channels], data[p * channels + 1], data[p * channels + 2]];
    if (Math.min(...rgb) >= 185 && Math.max(...rgb) - Math.min(...rgb) < 45) mask[p] = 1;
  }
  // Connected background pixels outline the card even when text and logos punch holes in it.
  const queue = new Int32Array(mask.length);
  let best: { left: number; top: number; right: number; bottom: number; count: number } | null = null;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    let head = 0, tail = 1;
    queue[0] = p; mask[p] = 0;
    let left = width, right = 0, top = height, bottom = 0;
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1,
        y > 0 ? at - width : -1, y < height - 1 ? at + width : -1]) {
        if (next >= 0 && mask[next]) { mask[next] = 0; queue[tail++] = next; }
      }
    }
    const w = right - left + 1, h = bottom - top + 1;
    if (w < width * .22 || h < height * .25 || tail / (w * h) < .65) continue;
    if (left > width * .55 || right < width * .45 || top > height * .55 || bottom < height * .35) continue;
    if (!best || tail > best.count) best = { left, top, right, bottom, count: tail };
  }
  // Full-screen receipts and dark wallet dialogs keep the existing whole-image pipeline.
  if (!best || (best.right - best.left + 1) * (best.bottom - best.top + 1) > width * height * .9) return oriented;
  const sx = (meta.width || width) / width, sy = (meta.height || height) / height;
  const left = Math.max(0, Math.floor((best.left - 2) * sx));
  const top = Math.max(0, Math.floor((best.top - 2) * sy));
  const right = Math.min(meta.width || width, Math.ceil((best.right + 3) * sx));
  const bottom = Math.min(meta.height || height, Math.ceil((best.bottom + 3) * sy));
  return sharp(oriented).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
}
