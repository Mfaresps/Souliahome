/* Let long order tables use the remaining desktop viewport; short views keep natural height. */
(() => {
  let active=null, box=null, frame=0;
  const root=document.documentElement;
  const observer=new ResizeObserver(schedule);
  function release() {
    root.classList.remove('ui-table-locked','sp-page-locked');
    if(box){box.classList.remove('ui-viewport-table');box.style.removeProperty('--ui-table-room');}
    box=null;
  }
  function fit() {
    const page=document.querySelector('#main>.page.active');
    if(active!==page){observer.disconnect();release();active=page;
      if(page){observer.observe(page);page.querySelectorAll('.sp-sticky-head,.cs-sticky-head,.mov-unified-panel,#shopify-pagination,#mov-pagination').forEach(el=>observer.observe(el));}
    }
    const selector=page?.id==='page-shopify-orders'?'#shopify-orders-table-wrap .sp-table-scroll':page?.id==='page-movements'?'#mov-table-wrap .ent-table-scroll':page?.id==='page-complaints'?'#fu-orders-section .fu-table-wrap>.overflow-x,#cmp-complaints-section .cmp-table-wrap>.overflow-x':null;
    const target=selector?[...page.querySelectorAll(selector)].find(el=>el.getClientRects().length):null;
    if(innerWidth<=768||!target){release();return;}
    if(box!==target){release();box=target;}
    // Include everything below the table (pagination, page padding and main gutter).
    const rect=box.getBoundingClientRect(), pageRect=page.getBoundingClientRect();
    const below=pageRect.bottom-rect.bottom+(parseFloat(getComputedStyle(document.getElementById('main')).paddingBottom)||0);
    const room=Math.floor(innerHeight-(rect.top+scrollY)-below-2);
    const canFit=room>=200;
    root.classList.toggle('ui-table-locked',canFit);
    root.classList.toggle('sp-page-locked',canFit&&page.id==='page-shopify-orders');
    box.classList.toggle('ui-viewport-table',canFit);
    box.style.setProperty('--ui-table-room',Math.max(200,room)+'px');
    if(page.id==='page-shopify-orders'){
      page.style.setProperty('--sp-table-max',Math.max(200,room)+'px');
      page.style.setProperty('--sp-table-overscroll',canFit?'contain':'auto');
    }
    if(canFit&&scrollY)window.scrollTo({top:0,behavior:'instant'});
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;fit();});}
  new MutationObserver(records=>{
    if(records.some(record=>record.type==='childList'||record.target.classList.contains('page')))schedule();
  }).observe(document.getElementById('main'),{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});
  window.addEventListener('resize',schedule);
  window.SouliaTableViewport={fit,schedule};schedule();
})();
