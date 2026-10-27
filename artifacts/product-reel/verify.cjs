const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process'),sharp=require('sharp'),ffmpeg=require('ffmpeg-static'),puppeteer=require('../../backend/node_modules/puppeteer');
const root=__dirname,video=path.join(root,'Soulia-One-System-90s.mp4'),timeline=require('./timeline.json');
(async()=>{
const dir=path.join(root,'review');fs.mkdirSync(dir,{recursive:true});let at=0,shots=[];
for(let i=0;i<timeline.length;i++){const s=timeline[i];for(const [kind,t] of [['start',at+.7],['middle',at+s.duration*.7]]){const f=path.join(dir,`${String(i+1).padStart(2,'0')}-${kind}.jpg`);const r=spawnSync(ffmpeg,['-y','-ss',String(t),'-i',video,'-frames:v','1','-q:v','2',f],{windowsHide:true});if(r.status!==0)throw Error(r.stderr.toString());shots.push(f);}at+=s.duration;}
const cells=[];for(let i=0;i<shots.length;i++)cells.push({input:await sharp(shots[i]).resize(216,384).png().toBuffer(),left:i%6*216,top:Math.floor(i/6)*384});
await sharp({create:{width:1296,height:Math.ceil(shots.length/6)*384,channels:3,background:'#182f24'}}).composite(cells).png().toFile(path.join(dir,'film-contact-sheet.png'));
const browser=await puppeteer.launch({headless:true,pipe:true}),page=await browser.newPage();await page.goto('file:///'+video.replaceAll('\\','/'));await page.waitForSelector('video');
const metadata=await page.$eval('video',async v=>{v.pause();await new Promise((resolve,reject)=>{if(v.readyState>=1)return resolve();v.onloadedmetadata=resolve;v.onerror=()=>reject(Error('Cannot load MP4'));});const states=[];for(const t of [0.01,7,13,24,32,41,50,58,67,75,83,89.8]){v.currentTime=t;await new Promise(r=>v.addEventListener('seeked',r,{once:true}));states.push({time:v.currentTime,readyState:v.readyState});}return {duration:v.duration,width:v.videoWidth,height:v.videoHeight,seeks:states};});
if(metadata.duration!==90||metadata.width!==1080||metadata.height!==1920)throw Error(JSON.stringify(metadata));
const decode=fs.readFileSync(path.join(root,'decode-check.txt'),'utf8');
const frames=Number([...decode.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]);
if(frames!==2700||!decode.includes('30 fps'))throw Error('Frame count or frame rate failed');
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify({...metadata,decodedFrames:frames,fps:30,scenes:11,fullDecode:'passed; see decode-check.txt',audio:'Silent by design',visualSamples:shots.length},null,2));await browser.close();console.log(JSON.stringify(metadata));
})();
