/* Original procedural score: 120 BPM, 4/4, D minor; no third-party samples. */
const fs=require('node:fs'),path=require('node:path');
const SR=48000,DURATION=90,N=SR*DURATION,L=new Float32Array(N),R=new Float32Array(N);
const pi=Math.PI,beat=.5;
let seed=0x51a17;function noise(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/2147483648-1;}
const hz=m=>440*2**((m-69)/12);
function add(start,dur,fn,amp=1,pan=0){const offset=Math.round(start*SR),len=Math.min(Math.round(dur*SR),N-offset),pl=Math.sqrt((1-pan)/2),pr=Math.sqrt((1+pan)/2);for(let j=Math.max(0,-offset);j<len;j++){const x=fn(j/SR,j)*amp;L[offset+j]+=x*pl;R[offset+j]+=x*pr;}}
function pluck(t,f){return (Math.sin(2*pi*f*t)+.32*Math.sin(2*pi*f*2*t)+.1*Math.sin(2*pi*f*3*t))*Math.exp(-t*8)*Math.min(1,t*400);}
const chords=[[50,57,62,65],[46,53,58,62],[41,48,53,57],[48,55,60,64]];
for(let b=0;b<180;b++){
 const t=b*beat,section=t<5?.5:t>=86?.25:t>=77?1.05:t>=68?.72:1;
 const root=chords[Math.floor(b/8)%4][0];
 if(t<88.5)add(t,.38,x=>Math.sin(2*pi*(48*x+45*.035*(1-Math.exp(-x/.035))))*Math.exp(-x*12)+noise()*.06*Math.exp(-x*180),.46*section);
 if(b%2===1&&t<86)add(t,.20,x=>(noise()*.6+Math.sin(2*pi*180*x)*.4)*Math.exp(-x*24)*Math.min(1,x*700),.14*section);
 for(let k=0;k<2;k++)if(t<86)add(t+k*.25,.085,x=>noise()*Math.exp(-x*70)*Math.min(1,x*1500),.038*section,k?-.25:.25);
 if(t>=5&&t<86){const f=hz(root-12);add(t+.025,.44,x=>(Math.sin(2*pi*f*x)+.19*Math.sin(2*pi*f*2*x))*Math.min(1,x*100)*Math.exp(-x*4),.28*section);}
 if(b%8===0){const c=chords[Math.floor(b/8)%4];c.forEach((note,i)=>add(t,4.2,x=>{const env=Math.min(1,x/.5)*Math.min(1,(4.2-x)/1.1);const side=.66+.34*Math.min(1,(x%.5)*4);return (Math.sin(2*pi*hz(note+12)*x)+.18*Math.sin(2*pi*hz(note+12)*1.003*x))*env*side;},.035*section,[-.65,-.25,.25,.65][i]));}
 for(let k=0;k<4;k++){const chord=chords[Math.floor(b/8)%4],note=chord[[0,2,1,3][(b+k)%4]]+12+(b%8>=6?12:0);if(t<88)add(t+k*.125,.65,x=>pluck(x,hz(note)),(t<5?.055:.072)*section,Math.sin((b*4+k)*.9)*.6);}
}
// Editorial accents align with the exact timeline; restrained UI ticks and soft sweeps.
const timeline=require('./timeline.json');let at=0;
for(const scene of timeline){
 add(scene.start,.65,x=>noise()*Math.sin(pi*Math.min(1,x/.65))*Math.exp(-x*5),.055);
 for(const shot of scene.shots){add(at,.065,x=>Math.sin(2*pi*(1700-900*x)*x)*Math.exp(-x*85),.055,.2);at+=shot.duration;}
}
for(const time of [17,36.5,48,50]){add(time,.5,x=>pluck(x,hz(81)),.10,-.15);add(time+.09,.45,x=>pluck(x,hz(86)),.065,.15);}
// Resolved final chord at 88s, with a clean musical tail to the final frame.
[50,57,62,65,74].forEach((note,i)=>add(88,2,x=>pluck(x,hz(note))*.8+Math.sin(2*pi*hz(note)*x)*Math.exp(-x*2)*.2,.12,i*.3-.6));
const delay=Math.round(.375*SR);for(let i=N-1;i>=delay;i--){L[i]+=R[i-delay]*.13;R[i]+=L[i-delay]*.13;}
let peak=0,sum=0;for(let i=0;i<N;i++){const fade=Math.min(1,i/(SR*.025),(N-1-i)/(SR*.12));L[i]=Math.tanh(L[i]*1.25)*fade;R[i]=Math.tanh(R[i]*1.25)*fade;peak=Math.max(peak,Math.abs(L[i]),Math.abs(R[i]));}
const gain=.88/peak,buf=Buffer.alloc(44+N*4);buf.write('RIFF',0);buf.writeUInt32LE(36+N*4,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(2,22);buf.writeUInt32LE(SR,24);buf.writeUInt32LE(SR*4,28);buf.writeUInt16LE(4,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(N*4,40);
for(let i=0;i<N;i++){const l=L[i]*gain,r=R[i]*gain;sum+=(l*l+r*r)/2;buf.writeInt16LE(Math.round(l*32767),44+i*4);buf.writeInt16LE(Math.round(r*32767),46+i*4);}
fs.writeFileSync(path.join(__dirname,'assets/soundtrack.wav'),buf);
fs.writeFileSync(path.join(__dirname,'audio-audit.json'),JSON.stringify({duration:DURATION,sampleRate:SR,channels:2,bpm:120,peakDbfs:20*Math.log10(.88),rmsDbfs:10*Math.log10(sum/N),original:true,thirdPartySamples:false,transitionCues:41},null,2));
console.log('Original 90-second stereo score rendered.');
