/* Present existing account, theme and language controls as one compact account card. */
(() => {
  const menu=document.getElementById('profile-menu'),trigger=document.getElementById('profile-trigger');
  if(!menu||!trigger)return;
  const get=id=>document.getElementById(id);
  const setText=(el,value)=>{if(el&&el.textContent!==value)el.textContent=value;};
  const set=(el,key,value)=>{if(el&&el.getAttribute(key)!==String(value))el.setAttribute(key,value);};
  const english=()=>typeof currentLang!=='undefined'&&currentLang==='en';
  function position(){
    if(!menu.classList.contains('open'))return;
    const r=trigger.getBoundingClientRect(),header=get('header').getBoundingClientRect(),view=window.visualViewport;
    const x=view?.offsetLeft||0,y=view?.offsetTop||0,w=Math.min(view?.width||innerWidth,document.documentElement.clientWidth),h=view?.height||innerHeight,edge=12,gap=8;
    const width=Math.min(320,w-edge*2),below=Math.max(r.bottom,header.bottom)+gap;
    const belowSpace=y+h-edge-below,aboveSpace=r.top-y-edge-gap;
    const up=belowSpace<Math.min(menu.scrollHeight,260)&&aboveSpace>belowSpace;
    menu.style.width=width+'px';menu.style.maxHeight=Math.max(80,up?aboveSpace:belowSpace)+'px';
    menu.style.right='auto';menu.style.bottom='auto';
    menu.style.left=Math.max(x+edge,Math.min(getComputedStyle(trigger).direction==='rtl'?r.left:r.right-width,x+w-width-edge))+'px';
    menu.style.top=Math.max(y+edge,up?r.top-menu.offsetHeight-gap:below)+'px';
  }
  function sync(){
    const user=typeof currentUser!=='undefined'?currentUser:null,en=english();
    const name=user?.name||user?.username||'';
    setText(get('pm-user-name'),name);set(get('pm-user-name'),'title',name);
    const email=user?.email|| (user?.username?'@'+user.username:'');
    setText(get('pm-user-email'),email);get('pm-user-email').hidden=!email;
    const title=user?(typeof userTitleLabel==='function'?userTitleLabel(user):get('header-jobtitle')?.textContent||''):'';
    setText(get('pm-user-jobtitle'),title);get('pm-user-jobtitle').hidden=!title;
    const avatar=get('header-avatar'),copy=get('pm-avatar');
    if(avatar&&copy&&copy.dataset.source!==avatar.innerHTML){copy.replaceChildren(...[...avatar.childNodes].map(node=>node.cloneNode(true)));copy.dataset.source=avatar.innerHTML;}
    const presence=get('header-presence'),dot=get('pm-presence');
    dot.classList.toggle('is-online',presence?.classList.contains('is-online')||false);
    set(dot,'aria-label',presence?.getAttribute('aria-label')||(en?'Offline':'غير متصل'));
    set(dot,'title',dot.getAttribute('aria-label'));
    setText(menu.querySelector('[data-account-label="account"]'),en?'My account':'حسابي');
    setText(menu.querySelector('[data-account-label="store"]'),en?'Store':'المتجر');
    set(get('pm-store'),'aria-label',en?'Store — opens in a new tab':'المتجر — يفتح في تبويب جديد');
    set(get('pm-store'),'title','SOULIA.STORE');
    set(menu.querySelector('.pm-social-links'),'aria-label',en?'Souliahome official pages':'صفحات Souliahome الرسمية');
    menu.querySelectorAll('[data-social]').forEach(link=>{
      const label=en?`Souliahome official ${link.dataset.social} page`:`صفحة Souliahome الرسمية على ${link.dataset.social}`;
      set(link,'title',label);
      set(link,'aria-label',label+(en?' — opens in a new tab':' — تفتح في تبويب جديد'));
    });
    set(get('pm-theme'),'aria-checked',String(document.body.classList.contains('dark-mode')));
    for(const lang of ['en','ar'])set(get('pm-lang-'+lang),'aria-checked',String((en?'en':'ar')===lang));
    position();
  }
  let scheduled=false;
  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;sync();});}
  const observer=new MutationObserver(schedule);
  for(const id of ['header-avatar','header-name','header-jobtitle','header-presence']){
    const source=get(id);if(source)observer.observe(source,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','aria-label','src']});
  }
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['lang','dir']});
  new MutationObserver(schedule).observe(document.body,{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',position);
  window.visualViewport?.addEventListener('resize',position);
  window.visualViewport?.addEventListener('scroll',position);
  document.addEventListener('scroll',event=>{if(!menu.contains(event.target))position();},true);
  window.SouliaAccountMenu={sync,position};sync();
})();
