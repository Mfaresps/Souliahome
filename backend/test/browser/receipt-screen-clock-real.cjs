const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {createWorker}=require('tesseract.js');
const {screenClockCrops,parseScreenClock}=require('../../dist/shopify/receipt-screen-time.util');
(async()=>{
 const worker=await createWorker('eng',1,{cachePath:path.resolve(__dirname,'../../tessdata-cache')});
 try{
  await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'0123456789٠١٢٣٤٥٦٧٨٩:：'});
  const files=process.argv.slice(2);assert(files.length,'Pass screenshot file paths');
  for(const file of files){
   const {crops,source}=await screenClockCrops(fs.readFileSync(file));const readings=[];
   for(const crop of crops){const {data}=await worker.recognize(crop);readings.push({text:data.text.trim(),clock:parseScreenClock(data.text)});}
   console.log(JSON.stringify({file:path.basename(file),source,readings}));
  }
 }finally{await worker.terminate();}
})().catch(e=>{console.error(e);process.exitCode=1;});
