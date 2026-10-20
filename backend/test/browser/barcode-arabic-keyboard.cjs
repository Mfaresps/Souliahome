const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const page = await browser.newPage();
    await page.setContent('<input data-scan-input><input id="pw-order-scan"><input id="pw-scan-demo-a"><input id="global-search"><input id="iu-query"><input id="ip-search">');
    await page.addScriptTag({path:path.resolve(__dirname,'../../../frontend/public/barcode-input.js')});
    const result = await page.evaluate(() => {
      const keys = {A:'\u0650',B:'\u0644\u0622',C:'}',D:']',E:'\u064f',F:'[',S:'\u064d',U:'\u2018',P:'\u061b',K:'\u060c'};
      const arabic = value => [...value].map(char => keys[char] || char).join('');
      const codes = ['SU-ABCDEF0123456789ABCDEF01','PK-FEDCBA9876543210FEDCBA98','PK-123456789012345678901234','PK-000001-8','U-0000-0237-8'];
      const results=[];
      for(const code of codes) {
        results.push([BarcodeInput.normalize(arabic(code)),code]);
        results.push([BarcodeInput.normalize(']Q3'+arabic(code)),code]);
        results.push([BarcodeInput.normalize(']\u064e3'+arabic(code)),code]);
        for(const input of document.querySelectorAll('input')) {
          input.value=arabic(code);input.dispatchEvent(new Event('input',{bubbles:true}));
          results.push([BarcodeInput.normalize(input.value),code]);
          input.value='';input.focus();
          for(const char of code) {
            const event=new KeyboardEvent('keydown',{key:keys[char]||char,code:/[A-Z]/.test(char)?'Key'+char:char==='-'?'Minus':'Digit'+char,shiftKey:/[A-Z]/.test(char),bubbles:true,cancelable:true});
            if(input.dispatchEvent(event)) {
              input.setRangeText(keys[char]||char,input.value.length,input.value.length,'end');
              input.dispatchEvent(new Event('input',{bubbles:true}));
            }
          }
          results.push([input.value,code]);
        }
      }
      const name='\u0641\u0627\u0637\u0645\u0629 \u062d\u0633\u0646';
      const search=document.querySelector('#global-search');search.value=name;search.dispatchEvent(new Event('input',{bubbles:true}));
      results.push([search.value,name]);
      results.push([BarcodeInput.normalize('\u0639-\u0660\u0660\u0660\u0660-\u0660\u0662\u0663\u0667-\u0668'),'U-0000-0237-8']);
      return results;
    });
    for(const [actual,expected] of result) assert.equal(actual,expected);
    console.log(`PASS: ${result.length} Arabic Windows keyboard, paste, scanner prefix, unit/pack codes and normal Arabic text checks.`);
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
