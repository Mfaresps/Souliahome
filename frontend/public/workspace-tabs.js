/* Shared horizontal tabs. Existing click handlers continue to own routes and data. */
(() => {
  const selector = [
    '#sp-subnav', '#page-movements > .mov-tab-bar', '#page-inventory .mov-tab-bar',
    '#page-products .prod-tabs', '#sup-tabs', '#sp-tab-bar', '#page-expenses .exp-tab-bar',
    '#page-csp .csp-header-actions', '#page-complaints .cs-main-tabs', '#cmp-status-tabs',
    '#page-approvals > .section-tab-bar', '#page-reports .rep-section-tabs',
    '#vault-tabs', '.users-workspace-tabs', '#page-barcodes .iu-tabs', '#stg-provider-tabs',
    '#tx-type-selector', '#page-shopify-orders .perf-period-tabs'
  ].join(',');
  const instances = new Map();
  let serial = 0, pending = false;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const set = (el, name, value) => { if (el.getAttribute(name) !== String(value)) el.setAttribute(name, value); };
  const panelIds = {
    'mov-tab-list':'mov-panel-list', 'mov-tab-archive':'mov-panel-archive', 'mov-tab-collections':'mov-panel-collections',
    'inv-tab-list':'inv-panel-list', 'inv-tab-log':'inv-panel-log',
    'prod-tab-items':'prod-pane-items', 'prod-tab-drafts':'prod-pane-drafts',
    'sup-tab-cards':'sup-panel-cards', 'sup-tab-payments':'sup-panel-payments',
    'main-tab-fu':'fu-orders-section', 'main-tab-cmp':'cmp-complaints-section',
    'csp-tab-browse-btn':'csp-tab-browse', 'csp-tab-manage-btn':'csp-tab-manage',
    'appr-tab-approvals-btn':'appr-tab-approvals-content', 'appr-tab-hub-btn':'appr-tab-hub-content', 'appr-tab-otp-btn':'appr-tab-otp-content'
  };
  function panels(button) {
    return (button.getAttribute('aria-controls') || '').split(/\s+/).map(id => document.getElementById(id)).filter(Boolean);
  }
  function selected(button) {
    if (button.id.startsWith('main-tab-')) return panels(button).some(el => el.style.display !== 'none');
    if (button.closest('.users-workspace-tabs,#stg-provider-tabs')) return button.getAttribute('aria-selected') === 'true';
    return button.classList.contains('active') || button.classList.contains('is-on') || button.getAttribute('aria-selected') === 'true' && !button.classList.contains('ui-tab');
  }
  function buttons(bar) { return [...bar.children].filter(el => el.tagName === 'BUTTON'); }
  function available(bar) { return buttons(bar).filter(el => !el.hidden && !el.disabled && el.style.display !== 'none' && getComputedStyle(el).display !== 'none'); }
  function reveal(bar, button) {
    if (!button || !bar.clientWidth) return;
    const a=button.getBoundingClientRect(), b=bar.getBoundingClientRect();
    const left = a.left < b.left + 3 ? a.left-b.left-3 : a.right > b.right-3 ? a.right-b.right+3 : 0;
    if (left) bar.scrollBy({left,behavior:reduced()?'instant':'smooth'});
  }
  function sync(instance) {
    const {bar,shell,previous,next} = instance;
    instance.display=bar.style.display;
    const tabs = available(bar);
    // A lone Orders destination is already named in the page breadcrumb.
    shell.hidden=bar.hidden||bar.style.display==='none'||bar.id==='sp-subnav'&&tabs.length<2;
    const current = tabs.find(selected) || tabs[0];
    buttons(bar).forEach(button => {
      const active=button===current;
      button.classList.toggle('ui-tab-selected',active);
      set(button,instance.filter?'aria-pressed':'aria-selected',active);
      if (instance.focused !== document.activeElement || !tabs.includes(instance.focused)) button.tabIndex=active?0:-1;
      if (!instance.filter) panels(button).forEach(panel=>{set(panel,'role','tabpanel');set(panel,'aria-labelledby',button.id);});
    });
    // Measure available space without removing the arrows: widening a scrolled
    // track temporarily clamps its scroll position and can clip the last tab.
    const trackBorder=bar.offsetWidth-bar.clientWidth;
    const overflow=bar.clientWidth>0 && bar.scrollWidth+trackBorder>shell.clientWidth+1;
    shell.classList.toggle('ui-tabs-overflow',overflow);
    const index=tabs.indexOf(current);
    previous.disabled=index<=0;next.disabled=index<0||index===tabs.length-1;
    if (current && bar.clientWidth) {
      const a=current.getBoundingClientRect(), b=bar.getBoundingClientRect();
      bar.style.setProperty('--ui-tab-x',`${a.left-b.left+bar.scrollLeft-bar.clientLeft}px`);
      bar.style.setProperty('--ui-tab-width',`${a.width}px`);
      if (!bar.classList.contains('ui-tabs-ready')) requestAnimationFrame(()=>bar.classList.add('ui-tabs-ready'));
      if (current!==instance.selected) {
        if (instance.selected && bar.id!=='sp-subnav' && !reduced()) {
          instance.animations.forEach(animation=>animation.cancel());instance.animations=[];
          if (!instance.filter) panels(current).filter(panel=>panel.getClientRects().length).forEach(panel=>{
            instance.animations.push(panel.animate([{opacity:.45,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:160,easing:'cubic-bezier(.2,.8,.2,1)'}));
          });
        }
        instance.selected=current;
        reveal(bar,current);
      } else if (instance.reveal) reveal(bar,current);
      instance.reveal=false;
    }
  }
  function mount(bar) {
    if (instances.has(bar) || !bar.closest('#main > .page')) return;
    const filter=bar.matches('#cmp-status-tabs,.exp-tab-bar,#tx-type-selector,.perf-period-tabs');
    let shell, previous, next;
    if (bar.id==='sp-subnav') {
      shell=bar.parentElement;previous=document.getElementById('sp-tab-previous');next=document.getElementById('sp-tab-next');
    } else {
      shell=document.createElement('div');shell.className='ui-tabs-shell';
      bar.before(shell);shell.append(bar);
      previous=document.createElement('button');next=document.createElement('button');
      [previous,next].forEach((button,index)=>{
        button.type='button';button.className='ui-tabs-step';button.dataset.uiStep=index?'next':'previous';
        button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="'+(index?'m9 6 6 6-6 6':'m15 6-6 6 6 6')+'"/></svg>';
      });
      shell.prepend(previous);shell.append(next);
    }
    shell.classList.add('ui-tabs-shell');bar.classList.add('ui-tabs');
    if (!bar.id) bar.id='workspace-tabs-'+(++serial);
    set(bar,'role',filter?'toolbar':'tablist');set(bar,'aria-orientation','horizontal');
    if (!bar.hasAttribute('aria-label') && !bar.hasAttribute('aria-labelledby')) {
      const label=bar.closest('.page')?.querySelector('.page-title')?.textContent.trim() || (document.documentElement.lang==='ar'?'أقسام الصفحة':'Page sections');
      set(bar,'aria-label',label);
    }
    buttons(bar).forEach((button,index)=>{
      if (!button.id) button.id=bar.id+'-tab-'+index;
      const control=panelIds[button.id] || (button.id.startsWith('sp-tab-btn-')?'sp-panel-'+button.id.slice(11):button.dataset.repTab?'rep-panel-'+button.dataset.repTab:button.dataset.vview?'vault-tab-'+(button.dataset.vview==='log'?'overview':button.dataset.vview):'');
      if (control) set(button,'aria-controls',control);
      button.type='button';set(button,'role',filter?'button':'tab');
    });
    const instance={bar,shell,previous,next,filter,selected:null,focused:null,animations:[],reveal:true};
    instances.set(bar,instance);
    if (bar.id!=='sp-subnav') [previous,next].forEach((button,index)=>{
      button.addEventListener('click',()=>{
        const tabs=available(bar), selectedIndex=tabs.indexOf(instance.selected), target=tabs[selectedIndex+(index?1:-1)];
        if (target) {target.click();target.focus({preventScroll:true});reveal(bar,target);}
      });
    });
    bar.addEventListener('keydown',event=>{
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      const tabs=available(bar),index=tabs.indexOf(event.target);if(index<0)return;
      event.preventDefault();event.stopPropagation();
      const direction=getComputedStyle(bar).direction==='rtl'?-1:1;
      const step=event.key==='ArrowRight'?direction:-direction;
      const target=tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+step+tabs.length)%tabs.length];
      tabs.forEach(tab=>tab.tabIndex=tab===target?0:-1);instance.focused=target;
      target.focus({preventScroll:true});reveal(bar,target);
    });
    bar.addEventListener('click',()=>{instance.focused=null;schedule();});
    const observer=new MutationObserver(records=>{
      if (records.some(record=>record.type==='childList'||record.type==='characterData'||record.target!==bar&&record.attributeName!=='tabindex'||record.target===bar&&(record.attributeName==='hidden'||bar.style.display!==instance.display))) schedule();
    });
    observer.observe(bar,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','hidden','disabled','style','aria-selected']});
    const resize=new ResizeObserver(()=>{instance.reveal=true;schedule();});resize.observe(shell);
    buttons(bar).forEach(button=>resize.observe(button));
    instance.observer=observer;instance.resize=resize;
    sync(instance);
    buttons(bar).forEach(button=>button.classList.add('ui-tab'));
  }
  function scan() {
    document.querySelectorAll(selector).forEach(mount);
    instances.forEach((instance,bar)=>{
      if (!bar.isConnected) {instance.observer.disconnect();instance.resize.disconnect();instance.animations.forEach(a=>a.cancel());instances.delete(bar);}
    });
  }
  function schedule() {
    if(pending)return;pending=true;
    requestAnimationFrame(()=>{pending=false;scan();instances.forEach(sync);});
  }
  window.SouliaTabs={refresh:schedule,enhance:mount,reveal};
  new MutationObserver(records=>{
    if(records.some(record=>record.type==='childList'&&[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1)||record.type==='attributes'&&record.target.classList.contains('page')))schedule();
  }).observe(document.getElementById('main'),{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',schedule);
  scan();
})();
