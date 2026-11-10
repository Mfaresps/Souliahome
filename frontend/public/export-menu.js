/* Keep secondary export actions together without replacing their handlers or permission state. */
(() => {
  const main=document.getElementById('main');
  if(!main)return;
  const menus=new Set();let serial=0,pending=false,opened=null;
  const english=()=>typeof currentLang!=='undefined'?currentLang==='en':document.documentElement.lang==='en';
  const text=(en,ar)=>english()?en:ar;
  const assign=(el,name,value)=>{if(el.getAttribute(name)!==String(value))el.setAttribute(name,value);};
  const available=menu=>[...menu.panel.children].filter(button=>!button.hidden&&getComputedStyle(button).display!=='none'&&getComputedStyle(button).visibility!=='hidden');
  const choices=menu=>available(menu).filter(button=>!button.disabled);
  function close(focus=false){
    if(!opened)return;
    const menu=opened;opened=null;
    if(menu.native&&menu.panel.matches(':popover-open'))menu.panel.hidePopover();
    menu.panel.classList.remove('is-open');
    if(!menu.native)menu.root.append(menu.panel);
    assign(menu.trigger,'aria-expanded','false');
    if(focus&&menu.trigger.isConnected)menu.trigger.focus({preventScroll:true});
  }
  function position(menu){
    const r=menu.trigger.getBoundingClientRect(),view=window.visualViewport;
    const x=view?.offsetLeft||0,y=view?.offsetTop||0,w=view?.width||innerWidth,h=view?.height||innerHeight;
    const edge=12,gap=6,width=Math.min(220,w-edge*2);
    menu.panel.style.width=width+'px';
    menu.panel.style.maxHeight=Math.max(44,h-edge*2)+'px';
    const height=menu.panel.getBoundingClientRect().height,rtl=getComputedStyle(menu.trigger).direction==='rtl';
    menu.panel.style.left=Math.max(x+edge,Math.min(rtl?r.left:r.right-width,x+w-width-edge))+'px';
    menu.panel.style.top=Math.max(y+edge,Math.min(r.bottom+gap+height<=y+h-edge?r.bottom+gap:r.top-height-gap,y+h-height-edge))+'px';
  }
  function open(menu,last=false){
    if(opened===menu){close(true);return;}
    close();sync(menu);
    const items=choices(menu);if(!items.length)return;
    opened=menu;
    menu.panel.dir=getComputedStyle(menu.trigger).direction;
    if(menu.native)menu.panel.showPopover();else document.body.append(menu.panel);
    menu.panel.classList.add('is-open');
    assign(menu.trigger,'aria-expanded','true');position(menu);
    items[last?items.length-1:0].focus({preventScroll:true});
  }
  function sync(menu){
    const label=text('Export options','خيارات التصدير');
    assign(menu.trigger,'aria-label',label);assign(menu.trigger,'title',label);
    for(const button of menu.panel.children){
      if(!button.textContent.trim()){
        const span=document.createElement('span');span.className='ui-export-label';
        span.dataset.i18n=(button.getAttribute('onclick')||'').includes('openArchiveExport')?'xpBtn':'exportExcel';button.append(span);
      }
      const span=button.querySelector('.ui-export-label');
      if(span){const label=span.dataset.i18n==='xpBtn'?text('Full Archive','نسخة كاملة'):text('Export Excel','تصدير Excel');if(span.textContent!==label)span.textContent=label;}
      button.tabIndex=-1;assign(button,'role','menuitem');
    }
    const hidden=!available(menu).length;
    if(menu.root.hidden!==hidden)menu.root.hidden=hidden;
    const disabled=!choices(menu).length;if(menu.trigger.disabled!==disabled)menu.trigger.disabled=disabled;
    if(opened===menu&&(hidden||!menu.trigger.getClientRects().length))close();
  }
  function create(parent,buttons){
    let menu=[...menus].find(menu=>menu.root.parentElement===parent);
    if(!menu){
      const root=document.createElement('div');root.className='ui-export-menu';
      const trigger=document.createElement('button');trigger.type='button';trigger.className='btn btn-outline btn-sm ui-export-trigger';trigger.id='export-menu-trigger-'+(++serial);
      trigger.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
      assign(trigger,'aria-haspopup','menu');assign(trigger,'aria-expanded','false');
      const panel=document.createElement('div');panel.className='ui-export-panel';panel.id='export-menu-'+serial;
      assign(panel,'role','menu');assign(panel,'aria-labelledby',trigger.id);assign(trigger,'aria-controls',panel.id);
      const native=typeof panel.showPopover==='function';if(native)panel.setAttribute('popover','manual');
      buttons[0].before(root);root.append(trigger,panel);
      menu={root,trigger,panel,native};menus.add(menu);
      trigger.addEventListener('click',()=>open(menu));
      trigger.addEventListener('keydown',event=>{
        if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(opened===menu)choices(menu).at(event.key==='ArrowUp'?-1:0)?.focus();else open(menu,event.key==='ArrowUp');}
      });
      // Close before the original handler runs, so dialogs and approval prompts own focus.
      panel.addEventListener('click',event=>{if(event.target.closest('button'))close(true);},true);
      panel.addEventListener('keydown',event=>{
        const items=choices(menu),index=items.indexOf(document.activeElement);
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
          event.preventDefault();event.stopPropagation();
          items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
        }
      });
    }
    menu.panel.append(...buttons);sync(menu);
  }
  function scan(){
    const groups=new Map();
    main.querySelectorAll('button[onclick*="Excel"],button[onclick*="openArchiveExport"]').forEach(button=>{
      const handler=button.getAttribute('onclick')||'';
      if(!/\b(?:openArchiveExport|_?export[A-Za-z]*Excel)\s*\(/.test(handler)||/exportSelected/i.test(handler)||button.closest('details,[role="menu"],.ui-export-panel,.mov-more-menu,.pu-action-menu'))return;
      const parent=button.parentElement;if(!groups.has(parent))groups.set(parent,[]);groups.get(parent).push(button);
    });
    groups.forEach((buttons,parent)=>create(parent,buttons));
    for(const menu of menus){if(!menu.root.isConnected){if(opened===menu)close();menus.delete(menu);}else sync(menu);}
  }
  function schedule(){if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;scan();});}
  document.addEventListener('pointerdown',event=>{if(opened&&!opened.root.contains(event.target)&&!opened.panel.contains(event.target))close();});
  document.addEventListener('keydown',event=>{
    if(!opened)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
    else if(event.key==='Tab')close(true);
  },true);
  document.addEventListener('scroll',event=>{if(opened&&!opened.panel.contains(event.target))position(opened);},true);
  window.addEventListener('resize',()=>{if(opened)position(opened);});
  window.visualViewport?.addEventListener('resize',()=>{if(opened)position(opened);});
  new MutationObserver(records=>{
    if(records.some(record=>record.type==='childList'||record.target.matches?.('button,.page,#vault-content')))schedule();
  }).observe(main,{subtree:true,childList:true,attributes:true,attributeFilter:['style','hidden','disabled','class','data-vview']});
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['lang','dir']});
  window.SouliaExportMenus={refresh:schedule,close};scan();
})();
