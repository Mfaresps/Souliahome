/* Normalize physical scanner keys only in dedicated barcode inputs. */
(function () {
  'use strict';
  const arabicKeys = {
    'ض':'q','ص':'w','ث':'e','ق':'r','ف':'t','غ':'y','ع':'u','ه':'i','خ':'o','ح':'p',
    'ش':'a','س':'s','ي':'d','ب':'f','ل':'g','ا':'h','ت':'j','ن':'k','م':'l',
    'ئ':'z','ء':'x','ؤ':'c','ر':'v','ى':'n','ة':'m',
    'ٍ':'S','‘':'U','ِ':'A','ً':'W','ُ':'E','ٌ':'R',
    '}':'C',']':'D','[':'F','،':'K','؛':'P'
  };
  function normalize(value) {
    if (typeof value !== 'string') return value;
    // Text fallback also handles pasted codes; never rewrite arbitrary product names/SKUs.
    const candidate = value.normalize('NFKC').trim().replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g, '').replace(/^\][A-Za-z\u0600-\u06ff]\d/, '')
      .replace(/[٠-٩۰-۹]/g, char => String(char.charCodeAt(0) - (char <= '٩' ? 0x660 : 0x6f0)))
      .replace(/لآ/g, 'B').replace(/لا/g, 'b').replace(/./gu, char => arabicKeys[char] || char);
    const pack = candidate.replace(/^PK/i, '').replace(/[-\s]/g, '');
    if (/^PK/i.test(candidate) && /^\d{7}$/.test(pack)) return `PK-${pack.slice(0,6)}-${pack[6]}`;
    if (/^(?:(?:SU|PK)-[A-F\d]{24}|[A-F\d]{24}|U-?\d{4}-?\d{4}-?\d|\d{9})$/i.test(candidate)) return candidate.toUpperCase();
    return value;
  }
  function key(event) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return event.key;
    if (/^Key[A-Z]$/.test(event.code || '')) return event.shiftKey ? event.code.slice(3) : event.code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(event.code || '') && !event.shiftKey) return event.code.slice(5);
    if (/^Numpad\d$/.test(event.code || '') && /^\d$/.test(event.key)) return event.code.slice(6);
    if (event.code === 'Minus' && !event.shiftKey) return '-';
    return event.key;
  }
  document.addEventListener('keydown', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-scan-input], [data-scan-filter], [data-supplier-return-scan], #pw-order-scan, input[id^="pw-scan-"]') || input.disabled || input.readOnly) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented) return;
    const latin = key(event);
    if (latin.length !== 1 || latin === event.key || !/^[A-Za-z\d-]$/.test(latin)) return;
    event.preventDefault();
    input.setRangeText(latin, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, true);
  // Search fields also accept scans, while ordinary Arabic names remain unchanged.
  document.addEventListener('input', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-scan-input], [data-scan-filter], [data-supplier-return-scan], #pw-order-scan, input[id^="pw-scan-"], #global-search, #iu-query, #ip-search') || input.disabled || input.readOnly || event.isComposing) return;
    const normalized = normalize(input.value);
    // A long legacy PK code can begin with seven digits; finish reading before choosing its format.
    if (/^PK-\d{6}-\d$/.test(normalized) && !/-[0-9٠-٩۰-۹]{6}-[0-9٠-٩۰-۹]$/.test(input.value)) return;
    if (normalized !== input.value) input.value = normalized;
  }, true);

  function mountUnitCode(input) {
    if (input.dataset.unitCodeMounted || !input.parentElement) return;
    input.dataset.unitCodeMounted = 'true';
    const initial = input.value || '';
    const wrap = document.createElement('div'); wrap.className = 'bm-code-entry';
    const sourceWrap = document.createElement('div'); sourceWrap.className = 'bm-code-raw'; sourceWrap.hidden = true;
    input.parentElement.insertBefore(wrap, input);
    wrap.append(sourceWrap); sourceWrap.append(input);
    const group = document.createElement('div'); group.className = 'bm-code-slots'; group.setAttribute('role','group');
    group.setAttribute('aria-label', document.documentElement.dir === 'rtl' ? 'كود القطعة U' : 'Unit code U');
    const prefix = document.createElement('span'); prefix.className = 'bm-code-prefix'; prefix.textContent = 'U-'; prefix.setAttribute('aria-hidden','true');
    const slots = [];
    for (let i=0;i<9;i++) {
      if (i === 4 || i === 8) { const dash = document.createElement('span'); dash.className='bm-code-dash'; dash.textContent='-'; dash.setAttribute('aria-hidden','true'); group.append(dash); }
      const cell = document.createElement('input'); cell.type='text'; cell.inputMode='numeric'; cell.autocomplete='off'; cell.maxLength=1;
      cell.pattern='[0-9]'; cell.className='bm-code-cell'; cell.setAttribute('aria-label', document.documentElement.dir === 'rtl' ? `الخانة ${i+1} من 9` : `Digit ${i+1} of 9`);
      cell.dataset.unitCodeCell=String(i); slots.push(cell); group.append(cell);
    }
    group.prepend(prefix);
    const toggle = document.createElement('button'); toggle.type='button'; toggle.className='bm-code-toggle';
    const hint = document.createElement('small'); hint.className='bm-code-hint'; hint.setAttribute('aria-live','polite');
    wrap.append(group,toggle,hint);
    const cells = Array(9).fill('');
    let mode='unit';
    const arabic = () => document.documentElement.dir === 'rtl';
    const modeLabel = () => { toggle.textContent = mode === 'unit' ? (arabic() ? 'باركود كامل / باك' : 'Full barcode / pack') : (arabic() ? 'كود القطعة U' : 'Unit code U'); toggle.setAttribute('aria-pressed',String(mode==='raw')); hint.dataset.level='help'; hint.textContent=mode==='unit'?(arabic()?'U ثابت · أدخل 9 أرقام، آخرها رقم التحقق.':'U is fixed · enter 9 digits; the last is the check digit.'):(arabic()?'أدخل الباركود أو كود الباك كما هو.':'Enter the full barcode or pack code as printed.'); };
    const sync = () => {
      const digits=cells.join('');
      input.value = digits.length === 9 ? `U-${digits.slice(0,4)}-${digits.slice(4,8)}-${digits[8]}` : (digits ? 'U-'+digits : '');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    };
    const showRaw = value => {
      mode='raw'; group.hidden=true; sourceWrap.hidden=false; toggle.dataset.mode='raw'; modeLabel();
      if (value !== undefined) input.value=value;
      input.required=input.dataset.unitCodeRequired === 'true'; input.tabIndex=0; input.removeAttribute('aria-hidden');
      input.focus(); input.setSelectionRange(input.value.length,input.value.length);
    };
    const showUnit = () => {
      const v=input.value.trim().toUpperCase().replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>String(c.charCodeAt(0)-(c<='\u0669'?0x660:0x6f0)));
      const match=/^(?:U-?)?([0-9\s-]{0,20})$/.exec(v);
      if (!match) { hint.dataset.level='error'; hint.textContent=arabic()?'هذا ليس كود U؛ استخدم إدخال الباركود الكامل.':'This is not a U code. Use full barcode entry.'; return; }
      const digits=match[1].replace(/[\s-]/g,''); if(digits.length>9){hint.dataset.level='error';hint.textContent=arabic()?'كود U يتكون من 9 أرقام.':'A U code has 9 digits.';return;}
      cells.fill(''); [...digits].forEach((d,i)=>cells[i]=d); slots.forEach((cell,i)=>cell.value=cells[i]);
      mode='unit'; sourceWrap.hidden=true; group.hidden=false; toggle.dataset.mode='unit'; modeLabel();
      input.required=false; input.tabIndex=-1; input.setAttribute('aria-hidden','true'); sync(); (slots.find(cell=>!cell.value)||slots[8]).focus();
    };
    const addDigit = (index, digit) => {
      if (!/^\d$/.test(digit)) return false;
      cells[index]=digit; slots[index].value=digit; sync();
      const next=slots.slice(index+1).find(cell=>!cell.value); if(next) next.focus();
      return true;
    };
    const paste = (text,index) => {
      const v=String(text||'').trim().toUpperCase();
      const match=/^(?:U-?)?([0-9\u0660-\u0669\u06f0-\u06f9\s-]+)$/.exec(v);
      if(!match){showRaw(v);return;}
      const digits=match[1].replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>String(c.charCodeAt(0)-(c<='\u0669'?0x660:0x6f0))).replace(/[\s-]/g,'');
      if(digits.length>9||index+digits.length>9){showRaw(v);return;}
      cells.fill(''); [...digits].forEach((d,i)=>cells[index+i]=d); slots.forEach((cell,i)=>cell.value=cells[i]); sync();
      (slots[index+digits.length]||slots[8]).focus();
    };
    slots.forEach((cell,index)=>{
      cell.addEventListener('input',()=>{const value=cell.value;if(value===''){cells[index]='';sync();return;}if(!/^\d$/.test(value)){cell.value='';showRaw(cells.join('')+value);return;}cells[index]=value;sync();if(index<8)slots[index+1].focus();});
      cell.addEventListener('keydown',event=>{
        const keyValue=key(event);
        if(['Enter','Tab'].includes(event.key)&&(input.matches('[data-scan-input],[data-supplier-return-scan]')||input.id==='sale-scan-code')){
          event.preventDefault();event.stopPropagation();
          if(input.id==='pw-order-scan'&&event.key==='Enter')input.form?.requestSubmit();
          else input.dispatchEvent(new KeyboardEvent('keydown',{key:event.key,code:event.code,bubbles:true,cancelable:true}));
          return;
        }
        if(event.key==='Backspace'&&!cell.value&&index>0){event.preventDefault();cells[index-1]='';slots[index-1].value='';sync();slots[index-1].focus();return;}
        if(event.key==='ArrowLeft'&&index>0){event.preventDefault();slots[index-1].focus();return;}
        if(event.key==='ArrowRight'&&index<8){event.preventDefault();slots[index+1].focus();return;}
        if(event.key==='-'||keyValue==='-'){event.preventDefault();const filled=cells.findIndex(d=>!d);slots[filled<0?8:filled<4?0:filled<8?4:8].focus();return;}
        if(index===0&&(keyValue==='u'||keyValue==='U')){event.preventDefault();return;}
        if(keyValue.length===1&&!/^\d$/.test(keyValue)){event.preventDefault();showRaw(cells.join('')+keyValue);return;}
        if(index===8&&/^\d$/.test(keyValue)){event.preventDefault();showRaw(cells.join('')+keyValue);return;}
        if(keyValue!==event.key&&/^\d$/.test(keyValue)){event.preventDefault();addDigit(index,keyValue);}
      });
      cell.addEventListener('paste',event=>{event.preventDefault();paste(event.clipboardData?.getData('text'),index);});
    });
    toggle.addEventListener('click',()=>mode==='unit'?showRaw(input.value):showUnit());
    input.dataset.unitCodeRequired=String(input.required); input.required=false; input.tabIndex=-1; input.setAttribute('aria-hidden','true');
    input.classList.add('bm-code-native');
    input.addEventListener('focus',()=>{if(mode==='unit')(slots.find(cell=>!cell.value)||slots[8]).focus();});
    const form=input.closest('form');
      form?.addEventListener('submit',event=>{if(mode==='unit'&&cells.some(d=>!d)){event.preventDefault();event.stopImmediatePropagation();hint.dataset.level='error';hint.textContent=arabic()?'أكمل الأرقام التسعة أو اختر إدخال باركود كامل.':'Enter all 9 digits or switch to full barcode.';slots.find((_,i)=>!cells[i])?.focus();}},true);
    input.__unitCodeUi={clear(){cells.fill('');slots.forEach(cell=>cell.value='');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));if(mode==='unit')slots[0].focus();}};
    modeLabel();
    if(initial){
      const match=/^(?:U-?)?([0-9\s-]{1,20})$/i.exec(initial.trim());
      if(match){paste(initial,0);}else showRaw(initial);
    }
    if(document.activeElement===input&&mode==='unit') (slots.find(cell=>!cell.value)||slots[0]).focus();
    const observer=new MutationObserver(()=>{if(!input.isConnected){observer.disconnect();return;} if(input.disabled){slots.forEach(cell=>cell.disabled=true);toggle.disabled=true;}else{slots.forEach(cell=>cell.disabled=false);toggle.disabled=false;}});
    observer.observe(input,{attributes:true,attributeFilter:['disabled']});
  }
  function scan(root=document) { if(root.matches?.('[data-unit-code-entry]')) mountUnitCode(root); root.querySelectorAll?.('[data-unit-code-entry]').forEach(mountUnitCode); }
  scan(); new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType===1)scan(node);}))).observe(document.documentElement,{childList:true,subtree:true});
  window.BarcodeInput = { normalize, key, clear(input) { if(input?.__unitCodeUi) input.__unitCodeUi.clear(); else if(input) input.value=''; } };
  // Unlock audio during a real user gesture so the very first asynchronous scan result can sound.
  let audioContext, unlockPromise;
  function unlock() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return Promise.resolve(false);
      audioContext ||= new Ctx();
      if (audioContext.state === 'running') return Promise.resolve(true);
      unlockPromise ||= audioContext.resume().then(() => audioContext.state === 'running').catch(() => false).finally(() => { unlockPromise = null; });
      return unlockPromise;
    } catch { return Promise.resolve(false); }
  }
  ['pointerdown','keydown','touchstart'].forEach(type => document.addEventListener(type, unlock, {capture:true, passive:true}));
  window.BarcodeScanSound = {
    unlock,
    async play(kind) {
      try {
        if (!await unlock() || !audioContext || audioContext.state !== 'running') return;
        const ctx = audioContext, start = ctx.currentTime + 0.015;
        const tone = (freq, offset, duration, shape, volume) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain();
          osc.type = shape; osc.frequency.setValueAtTime(freq, start + offset);
          gain.gain.setValueAtTime(0.0001, start + offset);
          gain.gain.exponentialRampToValueAtTime(volume, start + offset + 0.009);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
          osc.connect(gain).connect(ctx.destination); osc.start(start + offset); osc.stop(start + offset + duration + 0.02);
        };
        if (kind === 'success' || kind === 'ok') {
          tone(880, 0, 0.13, 'sine', 0.34); tone(1320, 0.075, 0.18, 'sine', 0.3);
        } else if (kind === 'duplicate' || kind === 'warn') {
          tone(520, 0, 0.11, 'triangle', 0.42); tone(520, 0.15, 0.11, 'triangle', 0.42);
        } else {
          tone(330, 0, 0.14, 'square', 0.3); tone(245, 0.17, 0.17, 'square', 0.3);
        }
      } catch { /* Feedback audio must never interrupt scanning. */ }
    }
  };
})();
