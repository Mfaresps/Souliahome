const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{once}=require('node:events');
const puppeteer=require('../../../backend/node_modules/puppeteer'),ffmpeg=require('ffmpeg-static'),sharp=require('sharp'),serve=require('./server.cjs');
const root=__dirname,timeline=require('./timeline.json'),clips=path.join(root,'clips');fs.mkdirSync(clips,{recursive:true});
function launch(args){const proc=spawn(ffmpeg,args,{windowsHide:true,stdio:['pipe','ignore','pipe']});let log='';proc.stderr.on('data',d=>{log=(log+d).slice(-12000)});const done=new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('close',code=>code?reject(Error(log)):resolve(log));});return {proc,done};}
async function run(args){const {proc,done}=launch(args);proc.stdin.end();return done;}
(async()=>{
 const {server,url}=await serve(),browser=await puppeteer.launch({headless:true,pipe:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 try{
  if(process.argv.includes('--preview')){
   const page=await browser.newPage();await page.goto(url);await page.evaluate(()=>ready);const cells=[];const cues=require('./cues.json');
   for(let i=0;i<cues.length;i++){const c=cues[i],time=c.start+Math.min(1.1,(c.end-c.start)*.6),data=await page.evaluate(f=>{drawFrame(f);return document.getElementById('film').toDataURL('image/png').split(',')[1];},Math.round(time*30));const buffer=Buffer.from(data,'base64');fs.writeFileSync(path.join(root,'review',`beat-${String(i+1).padStart(2,'0')}.png`),buffer);cells.push({input:await sharp(buffer).resize(216,384).png().toBuffer(),left:i%7*216,top:Math.floor(i/7)*414+30});cells.push({input:Buffer.from(`<svg width="216" height="30"><text x="5" y="22" fill="white" font-size="17">${String(time.toFixed(1))}s / Scene ${c.scene}</text></svg>`),left:i%7*216,top:Math.floor(i/7)*414});}
   await sharp({create:{width:1512,height:Math.ceil(cues.length/7)*414,channels:3,background:'#133a2d'}}).composite(cells).png().toFile(path.join(root,'review/storyboard.png'));console.log('41-beat storyboard saved.');return;
  }
  const select=process.argv.find(a=>a.startsWith('--scene='))?.split('=')[1].split(',').map(Number);let next=0;
  const queue=timeline.filter(s=>!select||select.includes(s.id));
  async function worker(id){const page=await browser.newPage();page.on('pageerror',e=>{throw e});await page.goto(url);await page.evaluate(()=>ready);
   while(next<queue.length){const s=queue[next++],file=path.join(clips,String(s.id).padStart(2,'0')+'.mp4');console.log(`Rendering scene ${s.id}, ${s.duration*30} frames (worker ${id})`);
    const {proc,done}=launch(['-y','-f','image2pipe','-framerate','30','-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-r','30','-frames:v',String(s.duration*30),'-threads','2','-video_track_timescale','15360',file]);let failed;done.catch(e=>{failed=e});
    for(let f=0;f<s.duration*30;f++){if(failed)throw failed;const data=await page.evaluate(frame=>{drawFrame(frame);return document.getElementById('film').toDataURL('image/jpeg',.95).split(',')[1];},s.start*30+f);if(!proc.stdin.write(Buffer.from(data,'base64')))await once(proc.stdin,'drain');if(f>0&&f%90===0)console.log(`Scene ${s.id}: ${f}/${s.duration*30}`);}
    proc.stdin.end();await done;console.log(`Scene ${s.id} complete.`);
   }await page.close();}
  // Keep the canvas page foregrounded: Chromium can defer image decoding in
  // background tabs even with timer throttling disabled. One page is deterministic.
  await worker(1);
  fs.writeFileSync(path.join(clips,'concat.txt'),timeline.map(s=>`file '${String(s.id).padStart(2,'0')}.mp4'`).join('\n'));
  await run(['-y','-f','concat','-safe','0','-i',path.join(clips,'concat.txt'),'-i',path.join(root,'assets/soundtrack.wav'),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','256k','-ar','48000','-t','90','-movflags','+faststart',path.join(root,'Soulia-From-Order-to-Delivery-90s.mp4')]);
  console.log('Complete MP4 exported.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
