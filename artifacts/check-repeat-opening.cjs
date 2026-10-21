const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('../backend/node_modules/puppeteer');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'soulia-repeat-opening-'));
  const browser = await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:profile});
  try {
    const page = await browser.newPage();
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    await page.emulateCPUThrottling(4);
    const session = await page.createCDPSession();
    await session.send('Network.enable');
    await session.send('Network.setBlockedURLs',{urls:['*fonts.googleapis.com*','*fonts.gstatic.com*']});
    await session.send('Network.emulateNetworkConditions',{offline:false,latency:80,downloadThroughput:256*1024,uploadThroughput:128*1024,connectionType:'cellular3g'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const rounds=[];
    for (const mode of ['first','repeat']) {
      if (mode==='repeat') await page.goto('about:blank');
      await page.goto('http://localhost:8080/',{waitUntil:'domcontentloaded',timeout:60000});
      await page.waitForFunction(()=>!document.getElementById('splash-screen')&&getComputedStyle(document.getElementById('login-page')).display==='flex');
      const measurement=await page.evaluate(()=>{
        const navigation=performance.getEntriesByType('navigation')[0];
        return {readyMs:Math.round(performance.now()),shellTransferBytes:navigation.transferSize,shellEncodedBytes:navigation.encodedBodySize,shellDecodedBytes:navigation.decodedBodySize};
      });
      rounds.push(measurement);console.log(JSON.stringify({mode,mobileCpuSlowdown:4,network:'2 Mbps, 80 ms latency',...measurement}));
    }
    assert(rounds[0].shellTransferBytes>100000);
    assert(rounds[1].shellTransferBytes<1000,'An unchanged shell must be validated without downloading its body');
    assert.deepEqual(errors,[]);
  } finally {
    await browser.close();
    if(path.dirname(path.resolve(profile))!==path.resolve(os.tmpdir()))throw new Error('Unexpected browser profile path');
    fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
