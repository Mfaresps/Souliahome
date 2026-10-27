// Isolated, deterministic 2,700-frame composition. No application changes.
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const sharp=require('sharp'),ffmpeg=require('ffmpeg-static');
const root=__dirname,assets=path.join(root,'assets'),clips=path.join(root,'clips');
const timeline=require('./timeline.json'); fs.mkdirSync(clips,{recursive:true});
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
function run(args){return new Promise((resolve,reject)=>{const p=spawn(ffmpeg,args,{windowsHide:true});let log='';p.stderr.on('data',d=>log=(log+d).slice(-8000));p.on('exit',n=>n?reject(Error(log)):resolve(log));});}
async function panel(file,crop=0){
 const buf=await sharp(path.join(assets,file+'.png')).resize({width:940}).png().toBuffer();const m=await sharp(buf).metadata();
 const height=Math.min(m.height,1040),top=Math.round((m.height-height)*crop);
 const piece=await sharp(buf).extract({left:0,top,width:940,height}).png().toBuffer();
 return sharp({create:{width:940,height:1040,channels:4,background:'#edf2ef'}}).composite([{input:piece,left:0,top:Math.round((1040-height)/2)}]).png().toBuffer();
}
async function build(i,s){
 const label=String(i+1).padStart(2,'0');
 const svg=`<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x2="0.8" y2="1"><stop stop-color="#102d24"/><stop offset="1" stop-color="#071911"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#bg)"/><g font-family="Segoe UI, Arial, sans-serif"><text x="72" y="100" font-size="30" letter-spacing="5" fill="#c3d8cd">SOULIA</text><text x="1008" y="100" text-anchor="end" font-size="23" fill="#a9bdb2">PRODUCT FILM / ${label}</text><path d="M72 145H1008" stroke="#385449"/><text x="72" y="211" font-size="23" letter-spacing="3" fill="#9dceb3">${esc(s.chapter)}</text>${s.title.map((l,j)=>`<text x="68" y="${306+j*80}" font-size="${l.length>21?59:66}" font-weight="650" letter-spacing="-2" fill="#f5faf6">${esc(l)}</text>`).join('')}<text x="72" y="454" font-size="27" fill="#b7cabe">${esc(s.caption)}</text><rect x="62" y="544" width="956" height="1056" rx="20" fill="#365649"/><text x="72" y="1680" font-size="26" fill="#d4e3d9">${esc(s.detail)}</text><text x="72" y="1770" font-size="22" fill="#9eb6a8">ACTUAL APPLICATION UI · DEMO DATA</text><text x="72" y="1810" font-size="20" fill="#829e8c">Illustrative offline workflow · No live service actions</text><path d="M72 1855H1008" stroke="#365144" stroke-width="3"/></g></svg>`;
 await sharp(Buffer.from(svg)).png().toFile(path.join(assets,`base-${label}.png`));
 for(let j=0;j<2;j++){
  let image=sharp(await panel(s.shots[j],s.crops?.[j]||0));
  if(s.end&&j===1){
   const logo=await sharp(path.join(assets,'logo.svg')).resize(260,260).png().toBuffer();
   const lockup=Buffer.from('<svg width="940" height="1040"><rect width="940" height="1040" fill="#f1f5f1"/><text x="470" y="700" text-anchor="middle" font-family="Segoe UI, Arial" font-size="65" letter-spacing="12" fill="#163e2e">SOULIA</text></svg>');
   image=sharp(lockup).composite([{input:logo,left:340,top:340}]);
  }
  await image.png().toFile(path.join(assets,`panel-${label}-${j}.png`));
 }
 const d=s.duration,n=d*30,half=d*.49,fade=.55;
 const filter=`[1:v]zoompan=z='1+0.018*on/${n}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=940x1040:fps=30,format=rgba,fade=t=in:st=0:d=0.65:alpha=1[p1];[2:v]zoompan=z='1.018-0.018*on/${n}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=940x1040:fps=30,format=rgba,fade=t=in:st=${half}:d=${fade}:alpha=1[p2];[0:v][p1]overlay=x=70:y='552+24*exp(-3*t)'[b];[b][p2]overlay=x=70:y='552+16*max(0,1-(t-${half})/0.7)'[c];[c]drawbox=x=72:y=1853:w=${Math.round(936*(i+1)/11)}:h=4:color=0x99d0ad:t=fill,fade=t=in:st=0:d=0.3,fade=t=out:st=${d-.25}:d=0.25,format=yuv420p[v]`;
 await run(['-y','-loop','1','-framerate','30','-i',path.join(assets,`base-${label}.png`),'-loop','1','-framerate','30','-i',path.join(assets,`panel-${label}-0.png`),'-loop','1','-framerate','30','-i',path.join(assets,`panel-${label}-1.png`),'-filter_complex',filter,'-map','[v]','-frames:v',String(n),'-c:v','libx264','-preset','fast','-crf','19','-threads','4',path.join(clips,label+'.mp4')]);
 console.log('Rendered scene '+label+' / 11 ('+d+'s)');
}
(async()=>{
 if(timeline.reduce((n,s)=>n+s.duration,0)!==90)throw Error('Timeline must be exactly 90s');
 const selected=process.argv.find(a=>a.startsWith('--scene='));
 for(let i=0;i<timeline.length;i++)if(!selected||selected.split('=')[1].split(',').map(Number).includes(i+1))await build(i,timeline[i]);
 fs.writeFileSync(path.join(clips,'concat.txt'),timeline.map((_,i)=>`file '${String(i+1).padStart(2,'0')}.mp4'`).join('\n'));
 await run(['-y','-f','concat','-safe','0','-i',path.join(clips,'concat.txt'),'-c','copy','-movflags','+faststart',path.join(root,'Soulia-One-System-90s.mp4')]);
 const log=await run(['-i',path.join(root,'Soulia-One-System-90s.mp4'),'-f','null','-']);fs.writeFileSync(path.join(root,'decode-check.txt'),log);
 console.log('Final MP4 rendered and fully decoded.');
})().catch(e=>{console.error(e);process.exit(1)});
