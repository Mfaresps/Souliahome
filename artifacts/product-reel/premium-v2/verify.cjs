const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ffmpeg=require('ffmpeg-static'),sharp=require('sharp'),puppeteer=require('../../../backend/node_modules/puppeteer');
const root=__dirname,video=path.join(root,'Soulia-From-Order-to-Delivery-90s.mp4'),cues=require('./cues.json'),timeline=require('./timeline.json');
function run(args){return new Promise((resolve,reject)=>{const p=spawn(ffmpeg,args,{windowsHide:true});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',c=>c?reject(Error(err)):resolve({out,err}));});}
(async()=>{
 assert.equal(timeline.length,12);assert.equal(timeline.reduce((n,s)=>n+s.duration,0),90);assert.equal(cues.length,41);
 assert.ok(cues.every(c=>c.end-c.start>=1&&c.end-c.start<=3));
 assert.deepEqual(timeline.map(s=>s.start),[0,5,12,19,25,32,39,46,52,60,68,77]);
 const audit=require('./capture-audit.json');assert.equal(audit.errors.length,0);assert.ok(audit.shots.find(s=>s.name==='order-card').text.includes('Unconfirmed'));
 assert.match(audit.shots.find(s=>s.name==='scan-after').text,/2\nScanned\n0\nRemaining/);
 assert.ok(audit.shots.find(s=>s.name==='delivered-card').text.includes('Delivered'));
 const decoded=await run(['-hide_banner','-i',video,'-map','0:v:0','-map','0:a:0','-progress','pipe:1','-f','null','-']);
 fs.writeFileSync(path.join(root,'decode-check.txt'),decoded.err+'\n'+decoded.out);
 const decodedFrames=Number([...decoded.out.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]);assert.equal(decodedFrames,2700);
 assert.match(decoded.err,/1080x1920/);assert.match(decoded.err,/30 fps/);assert.match(decoded.err,/Audio: aac.*48000 Hz, stereo/);
 const loudness=await run(['-hide_banner','-i',video,'-vn','-af','ebur128=peak=true','-f','null','-']);fs.writeFileSync(path.join(root,'audio-measurements.txt'),loudness.err);
 const I=Number([...loudness.err.matchAll(/I:\s*(-?[\d.]+) LUFS/g)].at(-1)?.[1]),peak=Number([...loudness.err.matchAll(/Peak:\s*(-?[\d.]+) dBFS/g)].at(-1)?.[1]);assert.ok(I>-24&&I<-8);assert.ok(peak<0);
 const review=path.join(root,'review/encoded');fs.mkdirSync(review,{recursive:true});const cells=[];
 for(let i=0;i<cues.length;i++){
  const c=cues[i],at=c.start+Math.min(1.2,(c.end-c.start)*.6),file=path.join(review,String(i+1).padStart(2,'0')+'.jpg');
  await run(['-y','-ss',String(at),'-i',video,'-frames:v','1','-q:v','2',file]);
  cells.push({input:await sharp(file).resize(216,384).png().toBuffer(),left:i%7*216,top:Math.floor(i/7)*414+30});
  cells.push({input:Buffer.from(`<svg width="216" height="30"><text x="5" y="22" fill="white" font-size="17">${at.toFixed(1)}s / Scene ${c.scene}</text></svg>`),left:i%7*216,top:Math.floor(i/7)*414});
 }
 await sharp({create:{width:1512,height:Math.ceil(cues.length/7)*414,channels:3,background:'#113c2c'}}).composite(cells).png().toFile(path.join(root,'review/encoded-contact-sheet.png'));
 const browser=await puppeteer.launch({headless:true,pipe:true});let metadata;
 try{const page=await browser.newPage();await page.goto('file:///'+video.replaceAll('\\','/'));await page.waitForSelector('video');
  metadata=await page.$eval('video',async(v,boundaries)=>{v.pause();if(v.readyState<1)await new Promise((r,j)=>{v.onloadedmetadata=r;v.onerror=()=>j(Error('MP4 did not load'));});const seeks=[];for(const t of boundaries){v.currentTime=t;await new Promise(r=>v.addEventListener('seeked',r,{once:true}));seeks.push({time:v.currentTime,readyState:v.readyState});}v.muted=true;v.currentTime=89.5;await v.play();await new Promise((r,j)=>{v.onended=r;v.onerror=()=>j(Error('Playback failed'));setTimeout(()=>j(Error('Playback timeout')),6000);});return {duration:v.duration,width:v.videoWidth,height:v.videoHeight,seeks,playedToEnd:v.ended};},[.01,...cues.slice(1).map(c=>c.start),89.966]);
 }finally{await browser.close();}
 assert.equal(metadata.duration,90);assert.equal(metadata.width,1080);assert.equal(metadata.height,1920);assert.ok(metadata.playedToEnd);
 const checks={...metadata,decodedFrames,fps:30,scenes:12,editorialBeats:41,maxBeatDuration:Math.max(...cues.map(c=>c.end-c.start)),audio:{codec:'AAC',sampleRate:48000,channels:2,lufs:I,truePeakDbfs:peak},fullDecode:'passed',captureErrors:audit.errors,encodedVisualSamples:41,sizeBytes:fs.statSync(video).size};
 fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
