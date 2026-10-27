/* Deterministic browser composition. Times are in seconds; every export frame is explicit. */
const canvas=document.getElementById('film'),ctx=canvas.getContext('2d',{alpha:false});
const W=1080,H=1920,INK='#103d31',CREAM='#f3f4ea',MINT='#d4e8ab',MUTED='#8ca99a';
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const ease=v=>1-Math.pow(1-clamp(v),3),smooth=v=>{v=clamp(v);return v*v*(3-2*v)};
const mix=(a,b,v)=>a+(b-a)*v;
let timeline,images={},currentTheme;
function box(x,y,w,h,r=24,fill){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill();}}
function text(s,x,y,size=32,color=INK,weight=500,align='left'){
 ctx.font=`${weight} ${size}px "Segoe UI", Arial, sans-serif`;ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillStyle=color;ctx.fillText(s,x,y);
}
function rule(x1,y1,x2,y2,color,width=2,p=1){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(mix(x1,x2,p),mix(y1,y2,p));ctx.lineWidth=width;ctx.strokeStyle=color;ctx.lineCap='round';ctx.stroke();}
function dot(x,y,r,color){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();}
function pill(s,x,y,fill=MINT,color=INK){ctx.font='600 25px "Segoe UI"';const w=ctx.measureText(s).width+42;box(x,y,w,48,24,fill);text(s,x+21,y+33,25,color,600);return w;}
function headline(lines,age,{x=74,y=310,size=102,color=currentTheme.fg}={}){
 lines.forEach((line,i)=>{
  const e=ease((age-i*.07)/.42);ctx.save();ctx.beginPath();ctx.rect(x-3,y+i*size*1.03-size,955,size*1.1);ctx.clip();
  let f=size;ctx.font=`750 ${f}px "Segoe UI"`;while(ctx.measureText(line).width>935){f-=1;ctx.font=`750 ${f}px "Segoe UI"`;}
  ctx.globalAlpha=e; text(line,x,y+i*size*1.03+(1-e)*size,f,color,750);ctx.restore();
 });
}
function card(name,x,y,w,age,{delay=0,h,angle=0,from='right',pan=0,shadow=true,zoom=1+Math.max(0,age)*.006}={}){
 const img=images[name];if(!img)throw Error('Missing image '+name);
 const e=ease((age-delay)/.55);if(e<=0)return;
 const natural=w*img.height/img.width;h=h??natural;
 ctx.save();ctx.globalAlpha=clamp((age-delay)/.2);
 ctx.translate(x+w/2+(from==='left'?-1:from==='right'?1:0)*(1-e)*180,y+h/2+(1-e)*(from==='up'?-130:90));
 ctx.rotate((angle+(1-e)*(from==='left'?-2:2))*Math.PI/180);ctx.scale(mix(.93,1,e)*zoom,mix(.93,1,e)*zoom);
 if(shadow){ctx.shadowColor='rgba(0,28,20,.16)';ctx.shadowBlur=28;ctx.shadowOffsetY=18;box(-w/2,-h/2,w,h,22,'#fff');ctx.shadowColor='transparent';}
 ctx.save();box(-w/2,-h/2,w,h,22);ctx.clip();ctx.fillStyle='#f7faf8';ctx.fillRect(-w/2,-h/2,w,h);
 const scale=Math.max(w/img.width,h/img.height);const dw=img.width*scale,dh=img.height*scale;
 const overflow=Math.max(0,dh-h);ctx.drawImage(img,-dw/2,-h/2-overflow*clamp(pan),dw,dh);ctx.restore();
 box(-w/2,-h/2,w,h,22);ctx.strokeStyle='rgba(122,153,136,.32)';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();
}
function connection(y1,y2,age,x=540){const e=smooth(age/.65);rule(x,y1,x,y2,currentTheme.dark?'#527867':'#acc0b1',3);rule(x,y1,x,y2,currentTheme.accent,5,e);dot(x,mix(y1,y2,e),7,currentTheme.accent);}
function cursor(x,y,age,delay=.7){const p=age-delay;if(p<0||p>.8)return;ctx.save();ctx.globalAlpha=1-clamp((p-.5)/.3);ctx.translate(x+(1-ease(p/.3))*50,y+(1-ease(p/.3))*50);ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,38);ctx.lineTo(10,28);ctx.lineTo(23,48);ctx.lineTo(31,43);ctx.lineTo(18,23);ctx.lineTo(32,22);ctx.closePath();ctx.fillStyle=INK;ctx.fill();ctx.strokeStyle=CREAM;ctx.lineWidth=3;ctx.stroke();if(p>.25){ctx.beginPath();ctx.arc(0,0,8+(p-.25)*70,0,Math.PI*2);ctx.strokeStyle='#759b68';ctx.lineWidth=3;ctx.stroke();}ctx.restore();}
function base(scene,t,dark){currentTheme={dark,fg:dark?CREAM:INK,muted:dark?'#a6c0b2':'#547465',accent:dark?MINT:'#367c57'};ctx.fillStyle=dark?'#0c3027':CREAM;ctx.fillRect(0,0,W,H);
 const g=ctx.createRadialGradient(800,1000,0,800,1000,1000);g.addColorStop(0,dark?'rgba(68,105,75,.18)':'rgba(206,224,201,.6)');g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
 // A single architectural spine links modules; no decorative particle field.
 rule(38,185,38,1700,dark?'#244b3b':'#d8dfcf',1);rule(1042,185,1042,1700,dark?'#244b3b':'#d8dfcf',1);
 text('SOULIA',74,112,30,currentTheme.fg,750);text('FROM ORDER TO DELIVERY',1004,111,20,currentTheme.muted,600,'right');
 rule(74,153,1006,153,currentTheme.muted,1,.25+.75*clamp(t/.8));
 text(String(scene.id).padStart(2,'0')+' / '+scene.chapter,74,211,22,currentTheme.muted,600);
}
function footer(scene,shot,t,age){
 const e=ease((age-.15)/.45);ctx.save();ctx.globalAlpha=e;text(shot.label,74,1600+(1-e)*20,28,currentTheme.fg,550);ctx.restore();
 const labels=scene.id<=8?['ORDER','CONFIRM','ASSIGN','STOCK','PACK','SHIP','DELIVER']:['FINANCE','TEAM','REPORTS','CONNECTED'];
 const active=scene.id<=8?Math.max(0,scene.id-2):scene.id-9;
 labels.forEach((l,i)=>{const x=74+i*(932/(labels.length-1));dot(x,1680,4,i<=active?currentTheme.accent:currentTheme.muted);if(i<labels.length-1)rule(x+8,1680,x+932/(labels.length-1)-8,1680,currentTheme.muted,1);text(l,x,1720,labels.length>4?17:20,currentTheme.muted,600,i===0?'left':i===labels.length-1?'right':'center');});
 text('ACTUAL APPLICATION UI  /  DEMO DATA',74,1814,22,currentTheme.muted,500);
 text('Offline illustration · No live service actions',74,1852,20,currentTheme.muted,400);
 rule(74,1882,1006,1882,currentTheme.dark?'#355b49':'#c8d6c3',3);rule(74,1882,1006,1882,currentTheme.accent,4,t/90);
}
const scenes={
 hook(s,a){
  const e=ease(a/.9);const positions=[[80,690,800,-5],[-110,1040,800,3],[340,1330,760,-3]];
  s.assets.forEach((n,i)=>{const [x,y,w,r]=positions[i];card(n,x+(1-e)*(i%2?450:-450),y,w,a,{delay:i*.08,angle:r*(1-e*.55),h:i===0?260:240,pan:.1,zoom:1+a*.015});});
  headline(s.title,a,{size:116,y:326});
  pill('DEMO-1001',74,1490,MINT,INK);
 },
 connect(s,a){
  headline(s.title,a,{size:108});
  connection(710,1430,a-.15,142);
  s.assets.forEach((n,i)=>card(n,182+i*20,660+i*265,780,a,{delay:.15+i*.16,h:220,from:i%2?'right':'left',pan:.2}));
 },
 stack(s,a){headline(s.title,a);let y=s.title.length>2?650:615;const max=860/s.assets.length-30;s.assets.forEach((n,i)=>{const im=images[n],h=Math.min(max,880*im.height/im.width);card(n,100+(i%2?-12:12),y,880,a,{delay:i*.13,h,pan:clamp(a/s.duration)*.12,from:i%2?'right':'left'});if(i<s.assets.length-1)connection(y+h+8,y+h+65,a-.2-i*.13);y+=h+72;});},
 focus(s,a){headline(s.title,a);const n=s.assets[0],im=images[n];const height=Math.min(820,920*im.height/im.width);let y=650;
  card(n,80,y,920,a,{h:height,from:'up',pan:clamp(a/s.duration)*.1,zoom:1+.012*clamp(a/s.duration)});
  if(s.assets[1]){const h=Math.min(320,880*images[s.assets[1]].height/images[s.assets[1]].width);const secondY=Math.min(1480-h,y+height+85);connection(y+height+10,secondY-8,a-.25);card(s.assets[1],100,secondY,880,a,{delay:.3,h,from:'left'});}
 },
 status(s,a){headline(s.title,a);pill(s.title[0]==='JOURNEY'?'DELIVERED':'CONFIRMED',74,530);card(s.assets[0],80,675,920,a,{delay:.1});connection(1150,1270,a-.2);if(s.assets[1])card(s.assets[1],120,1270,840,a,{delay:.3,h:240});},
 handoff(s,a){headline(s.title,a);const p=smooth((a-.45)/.9);card(s.assets[0],mix(80,190,p),mix(650,810,p),mix(920,700,p),a,{h:240*(1-p*.24),angle:mix(-3,0,p)});connection(1020,1190,a-.45);card(s.assets[1],80,1140,920,a,{delay:.35,h:360,from:'left'});},
 products(s,a){headline(s.title,a);card(s.assets[0],68,660,455,a,{angle:-1.5,delay:0});card(s.assets[1],557,770,455,a,{angle:1.5,delay:.18});pill('DEMO-1001 / MATCHED PRODUCTS',74,1455);},
 scan(s,a){headline(s.title,a,{size:150,y:340});card(s.assets[0],80,630,920,a,{h:530});const p=smooth((a-.35)/.9);if(a<1.5){rule(115,665+p*450,960,665+p*450,'rgba(53,125,87,.72)',4);}
  connection(1190,1280,a-.4);card(s.assets[1],80,1300,920,a,{delay:.4});pill('2 PIECES / VERIFIED IN DEMO',74,1460);},
 dispatch(s,a){headline(s.title,a,{size:100});card(s.assets[0],80,720,920,a,{from:'left',angle:1-ease(a/.8)});rule(95,1280,985,1280,currentTheme.accent,4,smooth((a-.4)/1.1));dot(mix(95,985,smooth((a-.4)/1.1)),1280,11,currentTheme.accent);pill('DEMO-TRACK',74,1400);},
 tracking(s,a){headline(s.title,a,{size:120});card(s.assets[0],80,740,920,a,{from:'left'});const delivered=s.assets[0]==='delivered-card';const y=1380;rule(120,y,960,y,currentTheme.muted,3);rule(120,y,delivered?960:540,y,currentTheme.accent,6,smooth(a/1.3));[120,540,960].forEach((x,i)=>{dot(x,y,14,i===2&&!delivered?currentTheme.muted:currentTheme.accent);text(['DISPATCH','IN TRANSIT','DELIVERED'][i],x,y+58,22,currentTheme.fg,600,i===0?'left':i===2?'right':'center')});card(delivered?'delivery-status':'transit-status',610,1210,370,a,{delay:.7,h:124});},
 report(s,a){headline(s.title,a);card(s.assets[0],90,590,900,a,{from:'left'});card(s.assets[1],100,1230,880,a,{delay:.25,from:'right'});},
 metrics(s,a){headline(s.title,a);card(s.assets[0],80,625,920,a);card(s.assets[1],100,1155,880,a,{delay:.25});text(String(Math.round(ease((a-.2)/.6))),82,1460,116,currentTheme.fg,700);text('DEMO ORDER IN THIS REPORT',200,1440,28,currentTheme.muted,600);},
 converge(s,a){headline(s.title,a,{size:98});const p=smooth(a/1.6);s.assets.forEach((n,i)=>{const col=i%2,row=Math.floor(i/2);const x=80+col*480,y=650+row*260;card(n,mix(col?-300:1000,x,p),mix(1450-row*450,y,p),440,a,{delay:i*.055,h:215,angle:(1-p)*(col?12:-12)});});connection(1430,1510,a,540);},
 dashboard(s,a){headline(s.title,a,{size:104});card('dashboard',80,555,920,a,{h:910,pan:.05+a*.02,from:'up',zoom:1+a*.008});if(s.assets[1])card(s.assets[1],180,1240,800,a,{delay:.35,h:250,angle:-1});},
 brand(s,a){
  const p=ease(a/.7);box(402,450+(1-p)*70,276,276,66,CREAM);ctx.drawImage(images.logo,442,490+(1-p)*70,196,196);
  text('SOULIA',540,880,100,currentTheme.fg,700,'center');rule(340,954,740,954,currentTheme.accent,2,p);
  headline(s.title,a,{x:74,y:1120,size:100});text('FROM ORDER TO DELIVERY.',74,1430,32,currentTheme.muted,550);
 }
};
window.drawFrame=function(frame){
 const t=clamp(frame,0,2699)/30;const scene=timeline.find(s=>t>=s.start&&t<s.start+s.duration)||timeline.at(-1);let pos=scene.start,shot=scene.shots.at(-1);for(const sh of scene.shots){if(t<pos+sh.duration){shot=sh;break;}pos+=sh.duration;}const age=t-pos;
 const dark=['hook','connect','handoff','scan','dispatch','tracking','converge','brand'].includes(shot.layout);
 base(scene,t,dark);scenes[shot.layout](shot,age);footer(scene,shot,t,age);
 // Nine-frame masked edge wipe, on the beat; content never fades to black.
 if(age<.23&&frame>0){const q=1-ease(age/.23);ctx.fillStyle=dark?CREAM:INK;ctx.fillRect(1080-1080*q,0,1080*q,1920);}
 document.getElementById('time').textContent=`${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;
};
window.ready=(async()=>{timeline=await(await fetch('timeline.json')).json();const names=new Set(['logo','delivery-status','transit-status',...timeline.flatMap(s=>s.shots.flatMap(sh=>sh.assets))]);await Promise.all([...names].map(async name=>{const im=new Image();im.src='assets/'+name+'.png';await im.decode();images[name]=im;}));await document.fonts.ready;drawFrame(0);return true;})();
let playing=false,origin=0,frame=0;const scrub=document.getElementById('scrub');const audio=new Audio('assets/soundtrack.wav');
document.getElementById('play').onclick=async()=>{await ready;playing=!playing;document.getElementById('play').textContent=playing?'Pause':'Play';if(playing){origin=performance.now()-frame/30*1000;audio.currentTime=frame/30;audio.play().catch(()=>{});requestAnimationFrame(tick);}else audio.pause();};
function tick(now){if(!playing)return;frame=Math.min(2699,Math.floor((now-origin)*.03));drawFrame(frame);scrub.value=frame;if(frame>=2699){playing=false;audio.pause();document.getElementById('play').textContent='Play';}else requestAnimationFrame(tick);}
scrub.oninput=async()=>{await ready;frame=+scrub.value;origin=performance.now()-frame/30*1000;audio.currentTime=frame/30;drawFrame(frame);};
