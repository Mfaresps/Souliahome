const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const dir=path.join(__dirname,'assets');
const crops={
 'detail-head':['order-detail',0,0,1008,250],
 'packing-note':['order-detail',18,558,972,214],
 'followup-card':['order-detail',18,264,972,282],
 'order-counts':['overview',0,0,940,436],
 'expense-card':['expenses',27,1140,938,254],
 'account-controls':['expenses',53,878,886,110],
 'supplier-card':['suppliers',26,720,940,252],
 'supplier-tabs':['suppliers',26,302,940,82],
 'team-cards':['team',24,680,944,700],
 'permission-cards':['permissions',20,450,936,900],
 'label-controls':['dispatch-card',180,350,390,90],
 'delivery-status':['delivered-card',770,15,195,65],
 'transit-status':['dispatch-card',770,15,195,65],
 'stock-detail':['order-items',90,90,700,210],
 'report-top':['reports',25,120,926,575],
 'report-bottom':['reports',65,910,845,240],
 'history-card':['history',26,570,940,440]
};
(async()=>{
 for(const [name,[source,left,top,width,height]] of Object.entries(crops)){
  const m=await sharp(path.join(dir,source+'.png')).metadata();
  if(top+height>m.height||left+width>m.width)throw Error('Invalid crop '+name);
  await sharp(path.join(dir,source+'.png')).extract({left,top,width,height}).png().toFile(path.join(dir,name+'.png'));
 }
 await sharp(path.join(dir,'confirmation-summary.png')).extend({top:24,bottom:24,left:24,right:24,background:'#fff'}).png().toFile(path.join(dir,'confirmation-summary-panel.png'));
 await sharp(path.join(dir,'logo.svg'),{density:1200}).resize(400,400).png().toFile(path.join(dir,'logo.png'));
 const timeline=require('./timeline.json');let at=0;const cues=[];
 for(const scene of timeline){if(scene.start!==at)throw Error('Scene start '+scene.id);let sum=0;for(const shot of scene.shots){cues.push({scene:scene.id,start:at+sum,end:at+sum+shot.duration,title:shot.title.join(' '),layout:shot.layout});sum+=shot.duration;}if(sum!==scene.duration)throw Error('Scene duration '+scene.id);at+=sum;}
 if(at!==90||timeline.length!==12)throw Error('Timeline must contain 12 scenes / 90 seconds');
 fs.writeFileSync(path.join(__dirname,'cues.json'),JSON.stringify(cues,null,2));
 const tc=n=>{const ms=Math.round(n*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`};
 fs.writeFileSync(path.join(dir,'captions.srt'),cues.map((c,i)=>`${i+1}\n${tc(c.start)} --> ${tc(c.end)}\n${c.title}\n`).join('\n'));
 const files=fs.readdirSync(dir).filter(f=>f.endsWith('.png'));const cells=[];
 for(let i=0;i<files.length;i++){cells.push({input:await sharp(path.join(dir,files[i])).resize({width:216,height:345,fit:'contain',background:'#dce6df'}).png().toBuffer(),left:i%7*240,top:Math.floor(i/7)*390+30});cells.push({input:Buffer.from(`<svg width="240" height="30"><text x="2" y="22" fill="white" font-size="17">${files[i]}</text></svg>`),left:i%7*240,top:Math.floor(i/7)*390});}
 await sharp({create:{width:1680,height:Math.ceil(files.length/7)*390,channels:3,background:'#113c2c'}}).composite(cells).png().toFile(path.join(__dirname,'review/captures.png'));
 console.log(`${cues.length} editorial beats, 12 scenes, 2700 frames. Assets prepared.`);
})().catch(e=>{console.error(e);process.exit(1)});
