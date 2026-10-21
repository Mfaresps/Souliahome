/* Uses saved R2 settings without printing credentials or customer data.
 * Default: checks only DNS/TLS. --write-test creates and deletes one unique diagnostic object.
 */
const path=require('node:path'),https=require('node:https'),crypto=require('node:crypto');
require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
const mongoose=require('mongoose');
const {r2PutObject,r2DeleteObject,normalizeR2AccountId}=require('../dist/shared/r2-uploader.util');
const safeError=error=>({code:String(error?.code||error?.name||'ERROR'),causes:Array.from(error?.errors||[]).map(item=>String(item.code||item.name||'ERROR'))});
(async()=>{
  const db=await mongoose.createConnection(process.env.MONGODB_URI,{serverSelectionTimeoutMS:5000}).asPromise();
  let cfg;
  try{
    const settings=await db.collection('settings').findOne({}, {projection:{r2AccountId:1,r2AccessKeyId:1,r2SecretAccessKey:1,r2Bucket:1}});
    cfg={accountId:settings?.r2AccountId||process.env.R2_ACCOUNT_ID||'',accessKeyId:settings?.r2AccessKeyId||process.env.R2_ACCESS_KEY_ID||'',secretAccessKey:settings?.r2SecretAccessKey||process.env.R2_SECRET_ACCESS_KEY||'',bucket:settings?.r2Bucket||'soulia-backups'};
    for(const key of Object.keys(cfg))cfg[key]=String(cfg[key]).trim();
  }finally{await db.close();}
  if(!cfg.accountId||!cfg.accessKeyId||!cfg.secretAccessKey)throw new Error('R2 settings are incomplete');
  console.log(JSON.stringify({configured:true,node:process.version,proxyConfigured:!!(process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy)}));
  const probe=family=>new Promise(resolve=>{
    let timer;
    const done=result=>{clearTimeout(timer);resolve(result);};
    const req=https.request({hostname:normalizeR2AccountId(cfg.accountId)+'.r2.cloudflarestorage.com',path:'/',method:'HEAD',...(family?{family}:{})},res=>{res.resume();done({family:family||'auto',status:res.statusCode,connected:true});});
    req.on('error',error=>done({family:family||'auto',connected:false,...safeError(error)}));
    timer=setTimeout(()=>{done({family:family||'auto',connected:false,code:'DEADLINE'});req.destroy();},8000);req.end();
  });
  for(const family of [0,4])console.log(JSON.stringify(await probe(family)));
  if(process.argv.includes('--write-test')){
    const key='_soulia_diagnostics/receipt-storage-'+Date.now()+'-'+crypto.randomBytes(5).toString('hex')+'.txt';
    const uploaded=await r2PutObject(cfg,key,Buffer.from('SOULIA storage connectivity test'),'text/plain',15000);
    console.log(JSON.stringify({operation:'temporary-upload',...uploaded}));
    if(uploaded.ok)console.log(JSON.stringify({operation:'temporary-delete',...await r2DeleteObject(cfg,key)}));
  }
})().catch(error=>{console.error(JSON.stringify({failure:safeError(error)}));process.exitCode=1;});
