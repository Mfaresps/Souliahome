/* Soft 2 core: mounting, replay, motion helpers, tooltips, popovers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
/* reduced motion, read live: REDUCE follows the device's setting as it changes, so turning it on or off mid-visit takes
   effect at once, without a reload. Turning it on also finishes what a script is animating in the components right now */
let REDUCE = false;
{
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const set = () => {
    REDUCE = mq.matches; if (!REDUCE || !document.getAnimations) return;
    for (const a of document.getAnimations()){
      const t = a.effect && a.effect.target;
      if (a instanceof CSSAnimation || a instanceof CSSTransition || !t || !t.closest || !t.closest('[data-c],.v2,.stage-in')) continue;
      try { a.finish(); } catch(e){ a.cancel(); }
    }
  };
  set();
  if (mq.addEventListener) mq.addEventListener('change', set); else mq.addListener(set);
}
const I = (n, c = 's') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;
const AV = (n, bg) => `<span class="av" style="background:${bg}${/^var\(--dm-av-[a-z]\)$/.test(bg) ? ';color:' + bg.replace(')', '-ink)') : ''}">${n}</span>`;
/* official brand marks for the services this page names */
const BRAND = {"google": "<svg class=\"brand\" aria-hidden=\"true\" viewBox=\"0 0 128 128\"><path fill=\"#e33629\" d=\"M44.59 4.21a64 64 0 0142.61.37 61.22 61.22 0 0120.35 12.62c-2 2.14-4.11 4.14-6.15 6.22Q95.58 29.23 89.77 35a34.28 34.28 0 00-13.64-8 37.17 37.17 0 00-37.46 9.74 39.25 39.25 0 00-9.18 14.91L8.76 35.6A63.53 63.53 0 0144.59 4.21z\"/><path fill=\"#f8bd00\" d=\"M3.26 51.5a62.93 62.93 0 015.5-15.9l20.73 16.09a38.31 38.31 0 000 24.63q-10.36 8-20.73 16.08a63.33 63.33 0 01-5.5-40.9z\"/><path fill=\"#587dbd\" d=\"M65.27 52.15h59.52a74.33 74.33 0 01-1.61 33.58 57.44 57.44 0 01-16 26.26c-6.69-5.22-13.41-10.4-20.1-15.62a29.72 29.72 0 0012.66-19.54H65.27c-.01-8.22 0-16.45 0-24.68z\"/><path fill=\"#319f43\" d=\"M8.75 92.4q10.37-8 20.73-16.08A39.3 39.3 0 0044 95.74a37.16 37.16 0 0014.08 6.08 41.29 41.29 0 0015.1 0 36.16 36.16 0 0013.93-5.5c6.69 5.22 13.41 10.4 20.1 15.62a57.13 57.13 0 01-25.9 13.47 67.6 67.6 0 01-32.36-.35 63 63 0 01-23-11.59A63.73 63.73 0 018.75 92.4z\"/></svg>", "github": "<svg class=\"brand\" aria-hidden=\"true\" viewBox=\"0 0 24 24\"><path fill=\"currentColor\" d=\"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12\"/></svg>", "figma": "<svg class=\"brand\" aria-hidden=\"true\" viewBox=\"0 0 128 128\"><path fill=\"#0acf83\" d=\"M45.5 129c11.9 0 21.5-9.6 21.5-21.5V86H45.5C33.6 86 24 95.6 24 107.5S33.6 129 45.5 129zm0 0\"/><path fill=\"#a259ff\" d=\"M24 64.5C24 52.6 33.6 43 45.5 43H67v43H45.5C33.6 86 24 76.4 24 64.5zm0 0\"/><path fill=\"#f24e1e\" d=\"M24 21.5C24 9.6 33.6 0 45.5 0H67v43H45.5C33.6 43 24 33.4 24 21.5zm0 0\"/><path fill=\"#ff7262\" d=\"M67 0h21.5C100.4 0 110 9.6 110 21.5S100.4 43 88.5 43H67zm0 0\"/><path fill=\"#1abcfe\" d=\"M110 64.5c0 11.9-9.6 21.5-21.5 21.5S67 76.4 67 64.5 76.6 43 88.5 43 110 52.6 110 64.5zm0 0\"/></svg>", "slack": "<svg class=\"brand\" aria-hidden=\"true\" viewBox=\"0 0 128 128\"><path d=\"M27.255 80.719c0 7.33-5.978 13.317-13.309 13.317C6.616 94.036.63 88.049.63 80.719s5.987-13.317 13.317-13.317h13.309zm6.709 0c0-7.33 5.987-13.317 13.317-13.317s13.317 5.986 13.317 13.317v33.335c0 7.33-5.986 13.317-13.317 13.317-7.33 0-13.317-5.987-13.317-13.317zm0 0\" fill=\"#de1c59\"/><path d=\"M47.281 27.255c-7.33 0-13.317-5.978-13.317-13.309C33.964 6.616 39.951.63 47.281.63s13.317 5.987 13.317 13.317v13.309zm0 6.709c7.33 0 13.317 5.987 13.317 13.317s-5.986 13.317-13.317 13.317H13.946C6.616 60.598.63 54.612.63 47.281c0-7.33 5.987-13.317 13.317-13.317zm0 0\" fill=\"#35c5f0\"/><path d=\"M100.745 47.281c0-7.33 5.978-13.317 13.309-13.317 7.33 0 13.317 5.987 13.317 13.317s-5.987 13.317-13.317 13.317h-13.309zm-6.709 0c0 7.33-5.987 13.317-13.317 13.317s-13.317-5.986-13.317-13.317V13.946C67.402 6.616 73.388.63 80.719.63c7.33 0 13.317 5.987 13.317 13.317zm0 0\" fill=\"#2eb57d\"/><path d=\"M80.719 100.745c7.33 0 13.317 5.978 13.317 13.309 0 7.33-5.987 13.317-13.317 13.317s-13.317-5.987-13.317-13.317v-13.309zm0-6.709c-7.33 0-13.317-5.987-13.317-13.317s5.986-13.317 13.317-13.317h33.335c7.33 0 13.317 5.986 13.317 13.317 0 7.33-5.987 13.317-13.317 13.317zm0 0\" fill=\"#ebb02e\"/></svg>", "notion": "<svg class=\"brand\" aria-hidden=\"true\" viewBox=\"0 0 24 24\"><path fill=\"currentColor\" d=\"M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z\"/></svg>", "linear": "<svg class=\"brand\" aria-hidden=\"true\" viewBox=\"0 0 24 24\"><path fill=\"#5e6ad2\" d=\"M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z\"/></svg>", "gmail": "<svg class=\"brand\" aria-hidden=\"true\" viewBox=\"52 42 88 66\"><path fill=\"#4285f4\" d=\"M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6\"/><path fill=\"#34a853\" d=\"M120 108h14c3.32 0 6-2.69 6-6V59l-20 15\"/><path fill=\"#fbbc04\" d=\"M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2\"/><path fill=\"#ea4335\" d=\"M72 74V48l24 18 24-18v26L96 92\"/><path fill=\"#c5221f\" d=\"M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2\"/></svg>", "drive": "<svg class=\"brand\" aria-hidden=\"true\" viewBox=\"0 0 87.3 78\"><path fill=\"#0066da\" d=\"m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z\"/><path fill=\"#00ac47\" d=\"m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z\"/><path fill=\"#ea4335\" d=\"m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z\"/><path fill=\"#00832d\" d=\"m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z\"/><path fill=\"#2684fc\" d=\"m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z\"/><path fill=\"#ffba00\" d=\"m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z\"/></svg>"};
/* country flags, drawn as images so each one keeps its own ids */
const FLAG = cc => `<img class="flag" alt="" src="data:image/svg+xml,${encodeURIComponent(FLAGS[cc].replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" '))}">`;
const FLAGS = {"US": "<svg viewBox=\"0 0 640 480\"> <path fill=\"#bd3d44\" d=\"M0 0h640v480H0\"/> <path stroke=\"#fff\" stroke-width=\"37\" d=\"M0 55.3h640M0 129h640M0 203h640M0 277h640M0 351h640M0 425h640\"/> <path fill=\"#192f5d\" d=\"M0 0h364.8v258.5H0\"/> <marker id=\"us-a\" markerHeight=\"30\" markerWidth=\"30\"> <path fill=\"#fff\" d=\"m14 0 9 27L0 10h28L5 27z\"/> </marker> <path fill=\"none\" marker-mid=\"url(#us-a)\" d=\"m0 0 16 11h61 61 61 61 60L47 37h61 61 60 61L16 63h61 61 61 61 60L47 89h61 61 60 61L16 115h61 61 61 61 60L47 141h61 61 60 61L16 166h61 61 61 61 60L47 192h61 61 60 61L16 218h61 61 61 61 60z\"/> </svg>", "GB": "<svg viewBox=\"0 0 640 480\"> <path fill=\"#012169\" d=\"M0 0h640v480H0z\"/> <path fill=\"#FFF\" d=\"m75 0 244 181L562 0h78v62L400 241l240 178v61h-80L320 301 81 480H0v-60l239-178L0 64V0z\"/> <path fill=\"#C8102E\" d=\"m424 281 216 159v40L369 281zm-184 20 6 35L54 480H0zM640 0v3L391 191l2-44L590 0zM0 0l239 176h-60L0 42z\"/> <path fill=\"#FFF\" d=\"M241 0v480h160V0zM0 160v160h640V160z\"/> <path fill=\"#C8102E\" d=\"M0 193v96h640v-96zM273 0v480h96V0z\"/> </svg>", "DE": "<svg viewBox=\"0 0 640 480\"> <path fill=\"#fc0\" d=\"M0 320h640v160H0z\"/> <path fill=\"#000001\" d=\"M0 0h640v160H0z\"/> <path fill=\"red\" d=\"M0 160h640v160H0z\"/> </svg>", "FR": "<svg viewBox=\"0 0 640 480\"> <path fill=\"#fff\" d=\"M0 0h640v480H0z\"/> <path fill=\"#000091\" d=\"M0 0h213.3v480H0z\"/> <path fill=\"#e1000f\" d=\"M426.7 0H640v480H426.7z\"/> </svg>", "NL": "<svg viewBox=\"0 0 640 480\"> <path fill=\"#ae1c28\" d=\"M0 0h640v160H0z\"/> <path fill=\"#fff\" d=\"M0 160h640v160H0z\"/> <path fill=\"#21468b\" d=\"M0 320h640v160H0z\"/> </svg>", "IE": "<svg viewBox=\"0 0 640 480\"> <g fill-rule=\"evenodd\" stroke-width=\"1pt\"> <path fill=\"#fff\" d=\"M0 0h640v480H0z\"/> <path fill=\"#009A49\" d=\"M0 0h213.3v480H0z\"/> <path fill=\"#FF7900\" d=\"M426.7 0H640v480H426.7z\"/> </g> </svg>", "IT": "<svg viewBox=\"0 0 640 480\"> <g fill-rule=\"evenodd\" stroke-width=\"1pt\"> <path fill=\"#fff\" d=\"M0 0h640v480H0z\"/> <path fill=\"#009246\" d=\"M0 0h213.3v480H0z\"/> <path fill=\"#ce2b37\" d=\"M426.7 0H640v480H426.7z\"/> </g> </svg>", "JP": "<svg viewBox=\"0 0 640 480\"> <defs> <clipPath id=\"jp-a\"> <path fill-opacity=\".7\" d=\"M-88 32h640v480H-88z\"/> </clipPath> </defs> <g fill-rule=\"evenodd\" stroke-width=\"1pt\" clip-path=\"url(#jp-a)\" transform=\"translate(88 -32)\"> <path fill=\"#fff\" d=\"M-128 32h720v480h-720z\"/> <circle cx=\"523.1\" cy=\"344.1\" r=\"194.9\" fill=\"#bc002d\" transform=\"translate(-168.4 8.6)scale(.76554)\"/> </g> </svg>", "CA": "<svg viewBox=\"0 0 640 480\"> <path fill=\"#fff\" d=\"M150.1 0h339.7v480H150z\"/> <path fill=\"#d52b1e\" d=\"M-19.7 0h169.8v480H-19.7zm509.5 0h169.8v480H489.9zM201 232l-13.3 4.4 61.4 54c4.7 13.7-1.6 17.8-5.6 25l66.6-8.4-1.6 67 13.9-.3-3.1-66.6 66.7 8c-4.1-8.7-7.8-13.3-4-27.2l61.3-51-10.7-4c-8.8-6.8 3.8-32.6 5.6-48.9 0 0-35.7 12.3-38 5.8l-9.2-17.5-32.6 35.8c-3.5.9-5-.5-5.9-3.5l15-74.8-23.8 13.4c-2 .9-4 .1-5.2-2.2l-23-46-23.6 47.8c-1.8 1.7-3.6 1.9-5 .7L264 130.8l13.7 74.1c-1.1 3-3.7 3.8-6.7 2.2l-31.2-35.3c-4 6.5-6.8 17.1-12.2 19.5-5.4 2.3-23.5-4.5-35.6-7 4.2 14.8 17 39.6 9 47.7\"/> </svg>", "SE": "<svg viewBox=\"0 0 640 480\"> <path fill=\"#005293\" d=\"M0 0h640v480H0z\"/> <path fill=\"#fecb00\" d=\"M176 0v192H0v96h176v192h96V288h368v-96H272V0z\"/> </svg>", "AU": "<svg viewBox=\"0 0 640 480\"> <path fill=\"#00008B\" d=\"M0 0h640v480H0z\"/> <path fill=\"#fff\" d=\"m37.5 0 122 90.5L281 0h39v31l-120 89.5 120 89V240h-40l-120-89.5L40.5 240H0v-30l119.5-89L0 32V0z\"/> <path fill=\"red\" d=\"M212 140.5 320 220v20l-135.5-99.5zm-92 10 3 17.5-96 72H0zM320 0v1.5l-124.5 94 1-22L295 0zM0 0l119.5 88h-30L0 21z\"/> <path fill=\"#fff\" d=\"M120.5 0v240h80V0zM0 80v80h320V80z\"/> <path fill=\"red\" d=\"M0 96.5v48h320v-48zM136.5 0v240h48V0z\"/> <path fill=\"#fff\" d=\"m527 396.7-20.5 2.6 2.2 20.5-14.8-14.4-14.7 14.5 2-20.5-20.5-2.4 17.3-11.2-10.9-17.5 19.6 6.5 6.9-19.5 7.1 19.4 19.5-6.7-10.7 17.6zm-3.7-117.2 2.7-13-9.8-9 13.2-1.5 5.5-12.1 5.5 12.1 13.2 1.5-9.8 9 2.7 13-11.6-6.6zm-104.1-60-20.3 2.2 1.8 20.3-14.4-14.5-14.8 14.1 2.4-20.3-20.2-2.7 17.3-10.8-10.5-17.5 19.3 6.8L387 178l6.7 19.3 19.4-6.3-10.9 17.3 17.1 11.2ZM623 186.7l-20.9 2.7 2.3 20.9-15.1-14.7-15 14.8 2.1-21-20.9-2.4 17.7-11.5-11.1-17.9 20 6.7 7-19.8 7.2 19.8 19.9-6.9-11 18zm-96.1-83.5-20.7 2.3 1.9 20.8-14.7-14.8-15.1 14.4 2.4-20.7-20.7-2.8 17.7-11L467 73.5l19.7 6.9 7.3-19.5 6.8 19.7 19.8-6.5-11.1 17.6zM234 385.7l-45.8 5.4 4.6 45.9-32.8-32.4-33 32.2 4.9-45.9-45.8-5.8 38.9-24.8-24-39.4 43.6 15 15.8-43.4 15.5 43.5 43.7-14.7-24.3 39.2 38.8 25.1Z\"/> </svg>", "ES": "<svg viewBox=\"0 0 640 480\"><path fill=\"#AA151B\" d=\"M0 0h640v480H0z\"/><path fill=\"#F1BF00\" d=\"M0 120h640v240H0z\"/></svg>"};

/* every running demo gets a controller, so Replay can cancel it cleanly */
function ctl(up){
  const c = { dead:false, t:[], iv:[], rafs:[], offs:[], q:[], kids:[] };
  /* a mouse resting on a component holds its demo where it is (c.held, kept by DM.mount), so the demo never moves what the
     visitor is about to click: whatever falls due waits until the pointer leaves, then the demo carries on from there. Once
     the visitor has taken over there is no demo left to hold. A controller made inside a demo holds with the one it is in */
  if (up) up.kids.push(c);
  c.hold = () => (!!c.held && !c.mine) || (!!up && up.hold());
  const gate = c.gate = fn => { if (c.hold()) c.q.push(fn); else fn(); };
  c.release = () => { c.q.splice(0).forEach(f => f()); c.kids.forEach(k => k.release()); };
  c.wait = ms => new Promise((res, rej) => { c.t.push(setTimeout(() => gate(() => c.dead ? rej('stop') : res()), REDUCE ? Math.min(ms, 40) : ms)); });
  c.every = (ms, fn) => { const id = setInterval(() => { if (!c.dead && !c.hold()) fn(); }, ms); c.iv.push(id); return id; };
  c.later = (ms, fn) => { c.t.push(setTimeout(() => gate(() => { if (!c.dead) fn(); }), ms)); };
  // a frame loop does its work only while its component is on screen (c.seen, kept by DM.mount) and not held; otherwise it waits
  c.loop = fn => { const f = t => { if (c.dead) return; if (c.seen !== false && !c.hold() && fn(t) === false) return; c.rafs.push(requestAnimationFrame(f)); }; c.rafs.push(requestAnimationFrame(f)); };
  c.on = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); c.offs.push(() => el.removeEventListener(ev, fn, o)); };
  c.stop = () => { c.dead = true; c.t.forEach(clearTimeout); c.iv.forEach(clearInterval); c.rafs.forEach(cancelAnimationFrame); c.offs.forEach(f => f()); };
  c.run = async fn => { try { await fn(); } catch(e) { if (e !== 'stop') console.error(e); } };
  /* a preview's story: a person and the agent take turns on a grid of half-second beats. s.beat(n) waits n beats,
     s.tap(el) moves a pointer to el and presses it, s.point(el) rests the pointer on el (showing its tooltip), s.away()
     puts the pointer down. The visitor takes over with their first real click or key, and the story stops where it is.
     s.until(f) waits until f() is true. At the end it holds the final state for two seconds, then plays again from the
     start while the card is on screen.
     With reduced motion the pointer jumps instead of gliding, and the story plays once */
  /* the visitor takes over: c.mine turns true at their first real click, key, focus or typing inside the component
     (DM.mount listens), and stays true until Animate or Replay mounts it again. What a demo does by itself, as the person
     in it, stops there; what the visitor sets off keeps working. c.taken(fn) runs fn at that moment, or at once if it has
     passed, so a demo can take back what it was halfway through (the letters it had typed) */
  let mine = false; const taken = [];
  Object.defineProperty(c, 'mine', { get:() => mine, set:v => { if (!v || mine) return; mine = true; taken.splice(0).forEach(f => { try { f(); } catch(e){ console.error(e); } }); c.release(); } });
  c.taken = fn => { if (mine) fn(); else taken.push(fn); };
  // a demo's own steps: c.step(ms) waits like c.wait and stops the demo once the visitor has taken over; c.auto(ms, fn)
  // does fn later, as the person in the demo, unless the visitor has taken over by then
  c.step = ms => mine ? Promise.reject('stop') : c.wait(ms).then(() => { if (mine) throw 'stop'; });
  c.auto = (ms, fn) => c.later(ms, () => { if (!mine) fn(); });
  // a demo typing into a field, as the person in it would: text a letter at a time, or a list of pieces one at a time, and
  // each() after every change. If the visitor takes over while it types, what it typed goes and the field is theirs again.
  // clear empties the field first (taking over puts back what was there); keep leaves that undo armed once the typing is
  // done, for text the demo is about to send, until the field changes
  const typeIn = async (el, text, wait, { each = () => {}, clear = false, keep = false } = {}) => {
    const was = el.value; let typed = '', last = null;
    c.taken(() => { if (last !== null && el.isConnected && el.value === last){ el.value = was; each(); } });
    if (clear){ el.value = ''; each(); last = el.value; }
    for (const p of typeof text === 'string' ? [...text] : text){ await wait(); typed += p; el.value = (clear ? '' : was) + typed; each(); last = el.value; }
    if (!keep) last = null;
  };
  c.type = (el, text, o = {}) => typeIn(el, text, () => c.step(typeof o.ms === 'function' ? o.ms() : o.ms ?? 40), o);
  c.story = fn => c.run(async () => {
    const st = c.st; let hand = null, tipped = null;
    const check = () => { if (c.mine || c.dead) throw 'stop'; };
    const sleep = ms => new Promise((res, rej) => { c.t.push(setTimeout(() => gate(() => c.dead ? rej('stop') : res()), ms)); });
    const unTip = () => { if (tipped){ tipped.dispatchEvent(new PointerEvent('pointerout', { bubbles:true })); tipped = null; } };
    const s = {
      beat: async (n = 1) => { check(); await sleep(n * 500); check(); },
      point: async (el, tip = true) => {
        check(); unTip();
        if (!hand){ hand = html('<span class="hand" aria-hidden="true"><svg viewBox="0 0 18 18"><path d="M3 2l11.5 6.1-5 1.5-2.4 5z"/></svg></span>'); if (getComputedStyle(st).position === 'static') st.style.position = 'relative'; st.appendChild(hand); }
        const h = hand.parentElement.getBoundingClientRect(), b = el.getBoundingClientRect();
        const x = b.left - h.left + Math.min(b.width * .62, b.width - 10), y = b.top - h.top + b.height * .58;
        if (!hand.classList.contains('on')){ hand.style.transition = 'none'; hand.style.transform = `translate(${x + 26}px,${y + 30}px)`; void hand.offsetWidth; hand.style.transition = ''; hand.classList.add('on'); }
        hand.style.transform = `translate(${x}px,${y}px)`;
        await sleep(REDUCE ? 0 : 420); check();
        if (tip && el.closest('[data-tip]')){ tipped = el.closest('[data-tip]'); tipped.dispatchEvent(new PointerEvent('pointerover', { bubbles:true })); }
      },
      tap: async el => {
        await s.point(el, false); hand.classList.remove('down'); void hand.offsetWidth; hand.classList.add('down');
        // a label is pressed through its control: clicking the label itself would focus the control, and the page would
        // scroll to it while the visitor reads somewhere else. Whatever the press does, the page stays where it is
        await sleep(160); check(); const y = scrollY, x = scrollX; (el.matches('label') && el.control ? el.control : el).click(); if (scrollY !== y || scrollX !== x) scrollTo(x, y);
        c.later(340, () => hand && hand.classList.remove('down'));
      },
      away: () => { unTip(); if (hand) hand.classList.remove('on', 'down'); },
      until: async f => { while (!f()){ check(); await sleep(100); } check(); },
      // types into a field, n beats for each letter or piece; taking over takes the typing back (see c.type)
      type: (el, text, o = {}) => typeIn(el, text, () => s.beat(o.n ?? .1), o)
    };
    // only a card plays a story; a component placed inside another (as in Agent harness) waits for its host
    if (!c.card) return;
    try { await fn(s); } finally { if (c.mine || c.dead) s.away(); }
    s.away();
    if (REDUCE) return;
    await s.beat(4);
    DM.again(c.card);
  });
  return c;
}
/* blur crossfade for text that changes */
function swap(el, html, isHTML){
  if (!el) return;
  // the newest call wins: a write still on its way is compared first, and a newer value replaces it rather than landing
  // before it. Swapping back to what is on screen cancels the pending write and lets the text fade back in
  const p = el._sw;
  if (p){ if (p.v === html && p.h === !!isHTML) return; clearTimeout(p.t); el._sw = null; }
  const cur = isHTML ? el.innerHTML : el.textContent; if (cur === html){ if (p) el.classList.remove('out'); return; }
  el.classList.add('sw'); el.classList.add('out');
  const s = el._sw = { v:html, h:!!isHTML, t:setTimeout(() => { if (el._sw !== s) return; el._sw = null; isHTML ? el.innerHTML = html : el.textContent = html; el.classList.remove('out'); }, REDUCE ? 0 : 170) };
}
function tween(from, to, ms, step, ease = t => 1 - Math.pow(1 - t, 3)){
  return new Promise(res => { const t0 = performance.now(); const f = t => { const p = Math.max(0, Math.min(1, (t - t0) / (REDUCE ? 1 : ms))); step(from + (to - from) * ease(p), p); p < 1 ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
}
function enter(el, delay = 0){ if (!el) return el; el.classList.remove('enter'); void el.offsetWidth; el.style.animationDelay = delay + 'ms'; el.classList.add('enter'); return el; }
function stagger(els, step = 60, base = 0){ els.forEach((e, i) => enter(e, base + i * step)); }
/* a component that swaps what it shows for a shorter end state (a confirmation, a summary) keeps the height it had, so it
   stays centred in its stage instead of shrinking to the top of it; .held centres the end state inside that height.
   release() lets it size to its content again, for Start over and the like */
function hold(el){ if (!el) return el; el.style.minHeight = Math.ceil(el.getBoundingClientRect().height) + 'px'; el.classList.add('held'); return el; }
function release(el){ if (el){ el.style.minHeight = ''; el.classList.remove('held'); } return el; }
/* centre(): keeps a field centred in the room its stage keeps for it, and glides it up as its list opens, so the field
   and the list sit centred together. showing() is the height on show once things settle; the glide runs at the speed
   folds and lists open with, so the two move as one */
function centre(c, el, showing, watch = []){
  // the room is the stage you see, whichever page the component is on: the homepage card keeps space for the open list
  // above and below, a component page centres the component in its own stage
  const room = el.closest('.stage-inner') || el.closest('.stage-in') || el.parentElement;
  const place = () => {
    if (!room.clientHeight) return;
    const rs = getComputedStyle(room), rr = room.getBoundingClientRect(), pt = parseFloat(rs.paddingTop) || 0, pb = parseFloat(rs.paddingBottom) || 0;
    const now = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42, top = el.getBoundingClientRect().top - now - rr.top;
    // where the top goes so what is showing sits centred, but never above the stage's own padding
    const want = pt + (room.clientHeight - pt - pb - showing()) / 2;
    el.style.setProperty('--dm-gy', Math.round(Math.max(pt, want) - top) + 'px');
  };
  el.classList.add('glide'); el.style.transition = 'none'; place();
  requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = ''; }));
  const ro = new ResizeObserver(place); [room, el, ...watch].forEach(n => ro.observe(n)); c.offs.push(() => ro.disconnect());
  return place;
}
/* carousel(): the parts around a native scroll-snap track (Carousel, both its types). The track scrolls by itself, so
   a swipe, a trackpad and the browser's own scrolling all work; this only keeps the rest in step with it:
   - its stops: where each slide snaps (start or centre, from the slide's scroll-snap-align), with slides that share one
     (narrow slides near the end) folded into a single stop, so no dot or arrow press ever goes nowhere
   - the arrows (disabled at the first and last stop), the dots (one per stop, the current one aria-current) and the keys on the
     track: Left and Right go a stop, Home and End to the ends, scrolling smoothly, or jumping with reduced motion
   - a mouse can drag the track like a finger; the click a drag ends with is swallowed
   - .in on each slide that is at least 70% in view (the CSS brings it into focus), and say(i) once the track settles on the
     stop that starts with slide i, for a polite live region
   o: { prev, next, dots, dot:i => label, say:i => {}, key:e => {} (other keys on the track) }. Returns { go, at, measure } */
function carousel(c, tr, o = {}){
  const { prev, next, dots } = o, S = () => [...tr.children];
  let stops = [], at = 0, settleT = 0, raf = 0, drag = null, dragged = false;
  const max = () => Math.max(0, tr.scrollWidth - tr.clientWidth);
  function measure(){
    const cs = getComputedStyle(tr), pad = parseFloat(cs.scrollPaddingLeft) || 0, w = tr.clientWidth, m = max();
    const out = [];
    S().forEach((s, i) => {
      const mid = getComputedStyle(s).scrollSnapAlign.includes('center');
      const x = Math.round(Math.max(0, Math.min(m, mid ? s.offsetLeft + s.offsetWidth / 2 - w / 2 : s.offsetLeft - pad)));
      if (!out.length || Math.abs(x - out[out.length - 1].x) > 2) out.push({ x, i });
    });
    const grew = !dots || dots.children.length !== Math.max(out.length, 1); stops = out.length ? out : [{ x:0, i:0 }];
    if (dots) dots.hidden = stops.length < 2;
    if (dots && grew){
      dots.innerHTML = stops.map(s => `<button type="button" aria-label="${o.dot ? o.dot(s.i) : `Show slide ${s.i + 1}`}"></button>`).join('');
      $$('button', dots).forEach((b, j) => b.onclick = () => go(j));
    }
    at = Math.min(at, stops.length - 1); mark();
  }
  function mark(){
    if (prev) prev.disabled = at === 0;
    if (next) next.disabled = at === stops.length - 1;
    if (dots) $$('button', dots).forEach((b, j) => b.setAttribute('aria-current', j === at));
  }
  // the stop nearest the scroll position; at the far end it is always the last one
  const near = () => { const x = tr.scrollLeft; if (x >= max() - 2) return stops.length - 1; let best = 0; stops.forEach((s, j) => { if (Math.abs(s.x - x) < Math.abs(stops[best].x - x)) best = j; }); return best; };
  function go(j){
    at = Math.max(0, Math.min(stops.length - 1, j)); mark();
    if (Math.abs(tr.scrollLeft - stops[at].x) < 2){ settle(); return; }
    tr.scrollTo({ left:stops[at].x, behavior:REDUCE ? 'auto' : 'smooth' });
  }
  function settle(){ tr.classList.remove('drag'); if (o.say) o.say(stops[at].i); }
  c.on(tr, 'scroll', () => {
    cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (drag) return; const j = near(); if (j !== at){ at = j; mark(); } });
    clearTimeout(settleT); settleT = setTimeout(() => { if (!drag && !c.dead) settle(); }, 160);
  }, { passive:true });
  c.offs.push(() => { clearTimeout(settleT); cancelAnimationFrame(raf); });
  c.on(tr, 'keydown', e => {
    if (e.target !== tr) return;
    const to = { ArrowLeft:at - 1, ArrowRight:at + 1, Home:0, End:stops.length - 1 }[e.key];
    if (to != null){ e.preventDefault(); go(to); } else if (o.key) o.key(e);
  });
  if (prev) prev.onclick = () => go(at - 1);
  if (next) next.onclick = () => go(at + 1);
  // a mouse drags the track like a finger would; the snap waits until the track has glided to the stop it lands on
  c.on(tr, 'pointerdown', e => { if (e.pointerType !== 'mouse' || e.button || e.target.closest('button,a,input,textarea,select,label')) return; drag = { x:e.clientX, l:tr.scrollLeft, from:at, on:false }; });
  c.on(tr, 'pointermove', e => {
    if (!drag) return; const dx = e.clientX - drag.x;
    if (!drag.on){ if (Math.abs(dx) < 5) return; drag.on = true; tr.classList.add('drag'); try { tr.setPointerCapture(e.pointerId); } catch(err){} }
    tr.scrollLeft = drag.l - dx;
  });
  const drop = e => {
    const d = drag; drag = null; if (!d || !d.on) return;
    const dx = e.clientX - d.x; let j = near(); if (j === d.from && Math.abs(dx) > 40) j += dx < 0 ? 1 : -1;
    dragged = true; setTimeout(() => { dragged = false; }, 0); go(j);
  };
  c.on(tr, 'pointerup', drop); c.on(tr, 'pointercancel', drop);
  c.on(tr, 'click', e => { if (dragged){ e.preventDefault(); e.stopPropagation(); } }, true);
  // a slide comes into focus once most of it is in view
  if ('IntersectionObserver' in window){
    const io = new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle('in', e.isIntersecting && e.intersectionRatio >= .69)), { root:tr, threshold:[0, .7, 1] });
    S().forEach(s => io.observe(s)); c.offs.push(() => io.disconnect());
  } else S().forEach(s => s.classList.add('in'));
  const ro = new ResizeObserver(() => measure()); ro.observe(tr); c.offs.push(() => ro.disconnect());
  measure();
  return { go, measure, get at(){ return at; }, get stop(){ return stops[at]; } };
}
/* entrance: when a component mounts, its container rises into place and its parts follow one after another.
   Soft rises out of a blur; Blueprint wipes down and ticks its parts in, in short hard beats. Each animation only
   names where it starts, so it ends on whatever the element's own styles say, and leaves nothing behind */
const REVEAL = {
  soft:{ root:[{ opacity:0, transform:'translateY(14px)' }], rootMs:820, part:[{ opacity:0, filter:'blur(6px)', transform:'translateY(8px)' }], partMs:760, first:110, step:65, max:620, ease:'cubic-bezier(.16,1,.3,1)' },
  bp:{ root:[{ opacity:0, clipPath:'inset(0 0 100% 0)' }, { opacity:1, clipPath:'inset(0 0 0% 0)', offset:.35 }, { clipPath:'inset(0 0 0% 0)' }], rootMs:520, part:[{ opacity:0, transform:'translateY(4px)' }], partMs:320, first:160, step:45, max:420, ease:'cubic-bezier(.65,0,.25,1)' }
};
function revealParts(root){
  const shown = el => { if (el.matches('template,script,style,.pop,.demo,[hidden],[aria-hidden="true"]:empty')) return false; const cs = getComputedStyle(el); if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute' || +cs.opacity === 0) return false; const b = el.getBoundingClientRect(); return b.width > 2 && b.height > 2; };
  // go down through single wrappers to the first level that has several parts
  let el = root, parts = [];
  for (let d = 0; d < 4; d++){ parts = [...el.children].filter(shown); if (parts.length !== 1) break; el = parts[0]; }
  // a long list in the middle (rows, cards, lines) cascades row by row instead of rising as one block
  const H = root.getBoundingClientRect().height || 1;
  parts = parts.flatMap(p => { const kids = [...p.children].filter(shown); return kids.length >= 3 && p.getBoundingClientRect().height > H * .35 ? kids : [p]; });
  return parts.slice(0, 16);
}
function reveal(st){
  if (REDUCE || !st.animate) return;
  const M = REVEAL[getComputedStyle(st).getPropertyValue('--dm-motion').trim()] || REVEAL.soft;
  [...st.children].filter(el => !el.matches('template,script,style')).forEach(root => {
    const go = (el, kf, ms, delay) => { const [first, ...rest] = kf;
      // a rise is added to the element's own transform, so a centred or rotated part keeps its place
      const { transform, ...look } = first;
      // a lone keyframe would be read as the end, so the start is pinned at 0
      if (Object.keys(look).length) el.animate([{ offset:0, ...look }, ...rest], { duration:ms, delay, easing:M.ease, fill:'backwards' });
      if (transform) el.animate([{ transform }, { transform:'none' }], { duration:ms, delay, easing:M.ease, fill:'backwards', composite:'add' }); };
    // a component can ask for less: data-reveal="flat" moves only its container, "none" skips the entrance
    const how = root.dataset.reveal; if (how === 'none') return;
    go(root, M.root, M.rootMs, 0);
    if (how !== 'flat') revealParts(root).forEach((p, i) => go(p, M.part, M.partMs, Math.min(M.first + i * M.step, M.max)));
  });
}
function html(str){ const t = document.createElement('template'); t.innerHTML = str.trim(); return t.content.firstElementChild; }
/* sliding knob for segmented controls */
function seg(el, onChange){
  let knob = $('.knob', el); if (!knob){ knob = document.createElement('span'); knob.className = 'knob'; el.prepend(knob); }
  const place = () => { const b = $('[aria-pressed="true"]', el); if (!b) return; knob.style.left = b.offsetLeft + 'px'; knob.style.width = b.offsetWidth + 'px'; };
  $$('button', el).forEach(b => b.addEventListener('click', () => { if (b.disabled) return; $$('button', el).forEach(x => x.setAttribute('aria-pressed', x === b)); place(); onChange && onChange(b.dataset.v ?? b.textContent.trim(), b); }));
  // the first placing is instant: a switch drawn again (a design picked, the component remounted) shows its pick where it
  // is, and only a pick made on it slides the knob (owner, 4 Nov)
  requestAnimationFrame(() => { knob.style.transition = 'none'; place(); void knob.offsetWidth; knob.style.transition = ''; });
  new ResizeObserver(place).observe(el); return { place };
}

/* when the visitor last pressed a key or a pointer: a focus that comes with one (a Tab into a component) is theirs, and a
   focus a script gives is not */
let lastInput = -1e9;
['pointerdown', 'keydown'].forEach(t => addEventListener(t, e => { if (e.isTrusted) lastInput = e.timeStamp; }, true));
// a pick on a design switch is noted as it happens (a person's click or key, or the homepage's footer tabs), so the mount it
// leads to swaps the design in place
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('.dm>.demo .seg2 button'); if (!b) return; const card = b.closest('.comp, [data-c]'); if (card) card._dmPick = performance.now(); }, true);
const DM = {
  defs:{},
  // agents at work: their demos keep playing while a mouse rests on them, instead of holding (see mount)
  PLAYS:new Set(['status-pill','step-loader','thinking','reasoning-trail','agent-lanes','agent-run-timeline','trace-view','agent-tree','run-queue','terminal-stream','browser-session','action-log','attachment-tray','progress','web-search','agent-phases','thinking-states']),
  def(id, fn){ this.defs[id] = fn; },
  /* the markup a card starts from: its <template>, or, when the markup is written out in its stage, what the stage holds
     before it first mounts, kept as a template so Replay starts from it again */
  tpl(card){
    let t = $('template', card); if (t) return t;
    const st = $('.stage-in', card); if (!st) return null;
    t = document.createElement('template'); t.innerHTML = st.innerHTML; card.appendChild(t); return t;
  },
  mount(card, again){
    const id = card.dataset.c, st = $('.stage-in', card), tpl = DM.tpl(card);
    if (card._c) card._c.stop();
    if (openPop && card.contains(openPop.pop)) closePops();
    st.innerHTML = ''; st.append(tpl.content.cloneNode(true));
    const c = ctl(); card._c = c; c.card = card; c.st = st;
    // a mouse over the component holds its demo; leaving lets it carry on (see ctl). Touch has no hover, so it never holds.
    // An agent at work (DM.PLAYS) keeps working under the pointer, the way a real one would (owner, 3 Nov)
    c.on(st, 'pointerenter', e => { if (e.pointerType === 'mouse' && !DM.PLAYS.has(id)) c.held = true; });
    c.on(st, 'pointerleave', () => { if (c.held){ c.held = false; c.release(); } });
    // whether the component is on screen or near it, so frame loops and canvases rest while it is far away
    if ('IntersectionObserver' in window){ const io = new IntersectionObserver(e => { c.seen = e[e.length - 1].isIntersecting; }, { rootMargin:'200px 0px' }); io.observe(st); c.offs.push(() => io.disconnect()); }
    // the visitor's first real click, key, typing or focus in the component stops its demo (c.mine)
    const mine = e => { if (e.isTrusted) c.mine = true; };
    ['pointerdown', 'keydown', 'input', 'click'].forEach(t => c.on(st, t, mine, true));
    c.on(st, 'focusin', e => { if (e.isTrusted && e.timeStamp - lastInput < 100) c.mine = true; }, true);
    try { this.defs[id] && this.defs[id](st, c, card); } catch(e){ console.error(id, e); }
    // a design picked with the switch under the component swaps in place: the new design fades in where it stands, without
    // the entrance a first visit gets, so picking one never reads as the page reloading (owner, 4 Nov)
    const swapped = card._dmPick && performance.now() - card._dmPick < 600; card._dmPick = 0;
    if (swapped){ const m = $('.dm>.dm-main', st); if (m && !REDUCE) m.animate([{ opacity:0 }, { opacity:1 }], { duration:260, easing:'ease-out' }); }
    else if (!again) reveal(st);
  },
  /* a story starts again once its card is on screen, the tab is open and no pointer rests on it: the finished run
     fades out and a fresh one fades in, without the entrance */
  again(card){
    const c = card._c; if (!c || c.dead) return;
    const ready = () => { const b = card.getBoundingClientRect(); return !document.hidden && b.bottom > innerHeight * .15 && b.top < innerHeight * .85 && !card.matches(':hover'); };
    let gone = false;
    const go = () => {
      if (gone || card._c !== c || c.dead || c.mine || !ready()) return;
      gone = true; io.disconnect();
      const st = $('.stage-in', card), out = st.animate([{ opacity:1 }, { opacity:0 }], { duration:320, easing:'ease-out', fill:'forwards' });
      out.finished.then(() => { if (card._c === c && !c.dead && !c.mine){ DM.mount(card, true); st.animate([{ opacity:0 }, { opacity:1 }], { duration:320, easing:'ease-out' }); } out.cancel(); }).catch(() => {});
    };
    const io = new IntersectionObserver(go, { threshold:[0, .25, .5, 1] }); io.observe(card); c.offs.push(() => io.disconnect());
    c.on(document, 'visibilitychange', go); c.on(card, 'pointerleave', go);
  }
};

/* ---------- tooltips: any element with data-tip ---------- */
// it is out of the accessibility tree while it shows nothing, so screen readers never meet an empty tooltip
const tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role','tooltip'); tip.setAttribute('aria-hidden','true');
// tipNext is the trigger whose tip is on its way, so moving across its own icon and padding doesn't start the wait again
let tipT = 0, tipFor = null, tipNext = null;
// a trigger whose menu is open shows its menu, not its tip
const menuOpen = el => el.getAttribute('aria-expanded') === 'true' && (el.hasAttribute('data-pop') || (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false'));
// a tip goes when its trigger does: removed, hidden, or its menu opened
// only a change that could touch the trigger is checked (an attribute on it or around it, or a removal that takes it), so a
// demo rewriting its text many times a second elsewhere never forces the page to lay itself out again
const tipWatch = new MutationObserver(ms => { if (!tipFor) return;
  const near = ms.some(m => m.type === 'attributes' ? m.target.contains(tipFor) : [...m.removedNodes].some(n => n === tipFor || (n.contains && n.contains(tipFor))));
  if (near && (!tipFor.isConnected || menuOpen(tipFor) || !tipFor.getClientRects().length)) hideTip(true); });
function showTip(el){
  if (!el.isConnected || !el.dataset.tip || menuOpen(el)) return;
  tipFor = el; const k = el.dataset.tipK;
  tipWatch.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['aria-expanded', 'hidden'] });
  tip.innerHTML = el.dataset.tip.replace(/</g,'&lt;') + (k ? `<span class="kbd">${k}</span>` : '');
  tip.style.left = '0px'; tip.style.top = '0px'; tip.classList.add('show'); tip.removeAttribute('aria-hidden');
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  // it stays inside the component's stage when it fits there, so on a phone it never runs past the card's edge
  const st = el.closest('.stage-in'), sb = st && st.parentElement.getBoundingClientRect();
  const lo = sb && sb.width >= w + 16 ? Math.max(8, sb.left + 8) : 8, hi = sb && sb.width >= w + 16 ? Math.min(innerWidth, sb.right) - w - 8 : innerWidth - w - 8;
  let x = r.left + r.width / 2 - w / 2; x = Math.max(lo, Math.min(hi, x));
  // above the trigger, or below when there is no room; data-tip-at="below" asks for below first, for a trigger that has
  // a header just above it the tip would cover
  const below = el.dataset.tipAt === 'below';
  let y = below ? r.bottom + 8 : r.top - h - 8; if (below ? y + h > innerHeight - 8 : y < 8) y = below ? r.top - h - 8 : r.bottom + 8;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
// when the last tip hid, so moving straight on to the next one shows it at once
let tipHid = -1e9;
// a demo playing on its own (a timer, or a click it makes) never takes away the tip, or the tip on its way, of the control
// the visitor is pointing at, in its own card or another: they would see the label vanish, or never come, under the
// pointer. Their own clicks and moves, and a trigger that changes its tip (force), still hide it
function hideTip(force){
  const on = tipFor || tipNext, ev = window.event;
  if (!force && on && on.isConnected && on.matches(':hover') && !(ev && ev.isTrusted)) return;
  clearTimeout(tipT); tipFor = null; tipNext = null; tipWatch.disconnect(); if (tip.classList.contains('show')) tipHid = performance.now(); tip.classList.remove('show'); tip.setAttribute('aria-hidden','true'); }
document.addEventListener('pointerover', e => { const el = e.target.closest('[data-tip]'); if (!el || el === tipFor) return; if (el === tipNext) return; clearTimeout(tipT); tipNext = el; tipT = setTimeout(() => { tipNext = null; showTip(el); }, tip.classList.contains('show') || performance.now() - tipHid < 120 ? 0 : 380); });
document.addEventListener('pointerout', e => { const el = e.target.closest('[data-tip]'); if (el && !el.contains(e.relatedTarget)) hideTip(); });
document.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);
addEventListener('scroll', hideTip, { passive:true });
/* copy feedback: write to the clipboard, flash a check, say so in a tooltip, then settle back */
function copied(btn, text, label = 'Copied to clipboard'){
  try { navigator.clipboard.writeText(text || '').catch(() => {}); } catch(e){}
  const use = btn.querySelector('use');
  const st = btn._cp || (btn._cp = { tip: btn.dataset.tip, href: use && use.getAttribute('href') });
  clearTimeout(st.t);
  if (use) use.setAttribute('href', '#i-check');
  btn.classList.add('copied'); btn.dataset.tip = label; showTip(btn);
  st.t = setTimeout(() => {
    if (use) use.setAttribute('href', st.href);
    btn.classList.remove('copied');
    if (st.tip === undefined) delete btn.dataset.tip; else btn.dataset.tip = st.tip;
    if (tipFor === btn) hideTip(true);
  }, 1600);
}

/* ---------- popovers: data-pop="#id" opens the element inside the same component ---------- */
let openPop = null;
// closing hands the focus back to the popover's button when it was inside, so a pick or Tab never drops it on the page; while
// it fades out it is inert, and after that hidden (CSS)
function closePops(){ if (!openPop) return; const { pop:p, btn } = openPop, back = p.contains(document.activeElement); p.classList.remove('open'); p.inert = true; btn.setAttribute('aria-expanded','false'); openPop = null; if (back && btn.isConnected) btn.focus({ preventScroll:true }); setTimeout(() => { p.inert = false; if (!p.classList.contains('open')){ p.style.left = '0px'; p.style.top = '0px'; } }, 300); }
function placePop(btn, pop){
  const host = pop.offsetParent || pop.parentElement; const hr = host.getBoundingClientRect(), br = btn.getBoundingClientRect();
  const up = btn.dataset.popPos === 'up' || (btn.dataset.popPos !== 'down' && br.bottom + pop.offsetHeight + 12 > innerHeight && br.top - pop.offsetHeight > 12);
  let x = br.left - hr.left; if (btn.dataset.popAlign === 'end') x = br.right - hr.left - pop.offsetWidth;
  const cb = (btn.closest('.card') || document.body).getBoundingClientRect(), lo = Math.max(0, cb.left) + 8, hi = Math.min(innerWidth, cb.right) - 8;
  x = Math.max(lo - hr.left, Math.min(x, hi - hr.left - pop.offsetWidth));
  pop.style.left = x + 'px';
  pop.style.top = up ? (br.top - hr.top - pop.offsetHeight - 6) + 'px' : (br.bottom - hr.top + 6) + 'px';
  pop.style.setProperty('--dm-origin', (up ? 'bottom ' : 'top ') + (btn.dataset.popAlign === 'end' ? 'right' : 'left'));
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-pop]');
  if (btn){
    const scope = btn.closest('.stage-in') || document; const pop = $(btn.dataset.pop, scope); if (!pop) return;
    // Enter or Space on the button of a menu the demo has open takes it over, with the focus on its first item; otherwise
    // the button closes its open popover
    if (openPop && openPop.pop === pop){ if (e.isTrusted && !e.detail && !openPop.mine && isMenu(pop)){ openPop.mine = true; popFocus(pop, 'first'); return; } closePops(); return; }
    // a demo in another card never closes a popover the visitor has open
    if (!e.isTrusted && openPop && openPop.mine && !openPop.pop.closest('.card').contains(btn)) return;
    closePops(); hideTip(); placePop(btn, pop); pop.inert = false; pop.classList.add('open'); btn.setAttribute('aria-expanded','true'); openPop = { pop, btn, mine:e.isTrusted };
    // opened with Enter or Space (a real click with no pointer), a menu takes the focus on its picked item, or its first
    if (e.isTrusted && !e.detail) popFocus(pop, 'first');
    return;
  }
  /* a demo clicking inside its own card must not close another card's open popover, nor one the visitor opened */
  const near = openPop && (e.isTrusted || (!openPop.mine && openPop.pop.closest('.card').contains(e.target)));
  if (openPop && !openPop.pop.contains(e.target)){ if (near) closePops(); }
  else if (openPop && e.target.closest('[data-close]')) setTimeout(closePops, 120);
});
/* Escape shuts the open popover, before anything inside gets the key, and the focus goes back to its button when it was
   in the popover. Pressing it is the visitor's own doing, so the component's demo stops there */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !openPop) return;
  const { pop, btn } = openPop, back = pop.contains(document.activeElement), card = pop.closest('.card');
  if (e.isTrusted && card && card._c) card._c.mine = true;
  // one Escape closes one thing: the popover, not also the panel or list it opened from
  if (back || document.activeElement === btn) e.stopPropagation();
  closePops(); if (back && btn.isConnected) btn.focus({ preventScroll:true });
}, true);
// a real resize closes the open popover; the page's own resize events (a card's layout settling) leave it open
addEventListener('resize', e => { if (e.isTrusted) closePops(); });
/* the keyboard in a popover menu, the WAI-ARIA menu button pattern: Enter, Space or the down arrow on its button opens it with
   the focus on the picked item or the first (the up arrow, on the last); up and down move through the items and wrap at the
   ends (left and right too, in a grid like an emoji picker, where up and down move a row); Home and End go to the first and
   last; Enter or Space picks; Tab closes it and moves on. Escape is above. A popover that is a dialog or a form (a calendar,
   a new schedule) leaves the focus to its component */
const isMenu = pop => /^(menu|listbox)$/.test(pop.getAttribute('role') || '');
const popItems = pop => $$('button,[role^="menuitem"],[role="option"]', pop).filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length && !el.closest('[hidden]'));
function popFocus(pop, where){
  if (!isMenu(pop)) return;
  const it = popItems(pop), on = it.find(x => x.getAttribute('aria-checked') === 'true' || x.getAttribute('aria-selected') === 'true');
  const to = where === 'last' ? it[it.length - 1] : on || it[0]; if (to) to.focus({ preventScroll:true });
}
function popStep(items, el, key){
  const n = items.length, i = items.indexOf(el); if (!n) return null;
  if (key === 'Home') return items[0]; if (key === 'End') return items[n - 1];
  const top = items[0].getBoundingClientRect().top, cols = items.filter(x => Math.abs(x.getBoundingClientRect().top - top) < 2).length, grid = cols > 1 && cols < n;
  const d = { ArrowDown:grid ? cols : 1, ArrowUp:grid ? -cols : -1, ArrowRight:grid || cols === n ? 1 : 0, ArrowLeft:grid || cols === n ? -1 : 0 }[key];
  if (!d) return null;
  if (i < 0) return d > 0 ? items[0] : items[n - 1];
  return items[((i + d) % n + n) % n];
}
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key, t = e.target;
  const btn = t.closest && t.closest('[data-pop]');
  if (btn && (k === 'ArrowDown' || k === 'ArrowUp')){
    const pop = $(btn.dataset.pop, btn.closest('.stage-in') || document); if (!pop || !isMenu(pop)) return;
    e.preventDefault();
    if (!(openPop && openPop.pop === pop)) btn.click();
    if (openPop && openPop.pop === pop) openPop.mine = true;
    popFocus(pop, k === 'ArrowUp' ? 'last' : 'first');
    return;
  }
  if (!openPop || !openPop.pop.contains(t) || !isMenu(openPop.pop)) return;
  if (k === 'Tab'){ openPop.btn.focus({ preventScroll:true }); closePops(); return; }
  // a field in a menu (a search, a web address) keeps its own keys
  if (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable) return;
  const to = popStep(popItems(openPop.pop), document.activeElement, k);
  if (to){ e.preventDefault(); $$('.hl', openPop.pop).forEach(x => x.classList.remove('hl')); to.focus({ preventScroll:true }); }
});

/* ---------- touch: tap areas that never overlap ----------
   On a touch screen every control has a clear tap area of at least 40px square around it (the @media (pointer:coarse) block
   in the CSS, which marks it --dm-hit). Where two controls sit closer than that, their areas shrink towards the gap between
   them, each to half of it, so they meet halfway and a tap always lands on the control nearest to it; next to a field, which
   has no area of its own, a control can take the whole gap. The areas on screen are fitted again, a few times a second at
   most, as the page scrolls, resizes or changes. Nothing runs with a mouse */
const fitHits = window.dmFitHits || (() => {
  const CTRL = 'button,a[href],summary,label,input:not([type="hidden"]),select,textarea,[contenteditable="true"],[role="button"],[role="switch"],[role="checkbox"],[role="radio"],[role="tab"],[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="slider"]';
  const MIN = 40, coarse = matchMedia('(pointer:coarse)'), seen = new WeakMap();
  // whether a control has a tap area (and so can grow), read once per class
  const grows = el => { const k = (el.getAttribute('class') || '') + '|' + (el.getAttribute('role') || ''), s = seen.get(el);
    if (s && s.k === k) return s.v;
    const v = ['::before', '::after'].some(w => getComputedStyle(el, w).getPropertyValue('--dm-hit').trim() === '1'); seen.set(el, { k, v }); return v; };
  function fit(){
    q = 0; last = performance.now(); if (!coarse.matches) return;
    const H = innerHeight, on = [];
    for (const el of document.querySelectorAll(CTRL)){
      const r = el.getBoundingClientRect(); if (!r.width || !r.height || r.bottom < -80 || r.top > H + 80) continue;
      // a control that isn't drawn (in a closed <details>, under visibility:hidden) neither grows nor stands in the way
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty:true })) continue;
      const g = grows(el); on.push({ el, r, g, x:g ? Math.max(0, (MIN - r.width) / 2) : 0, y:g ? Math.max(0, (MIN - r.height) / 2) : 0 });
    }
    for (const a of on){
      if (!a.g) continue;
      let ex = a.x, ey = a.y;
      if (ex || ey) for (const b of on){
        if (b === a || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const gx = Math.max(b.r.left - a.r.right, a.r.left - b.r.right), gy = Math.max(b.r.top - a.r.bottom, a.r.top - b.r.bottom);
        if ((gx < 0 && gy < 0) || gx >= ex + b.x || gy >= ey + b.y) continue;
        const part = (gap, other) => Math.max(0, other ? gap / 2 : gap);
        if (gy < 0 || (gx >= 0 && gx >= gy)) ex = Math.min(ex, part(gx, b.x)); else ey = Math.min(ey, part(gy, b.y));
      }
      const w = ex < a.x ? Math.round(a.r.width + 2 * ex) + 'px' : '', h = ey < a.y ? Math.round(a.r.height + 2 * ey) + 'px' : '';
      if (a.el.style.getPropertyValue('--dm-hit-w') !== w) w ? a.el.style.setProperty('--dm-hit-w', w) : a.el.style.removeProperty('--dm-hit-w');
      if (a.el.style.getPropertyValue('--dm-hit-h') !== h) h ? a.el.style.setProperty('--dm-hit-h', h) : a.el.style.removeProperty('--dm-hit-h');
    }
  }
  let q = 0, last = -1e9, started = false;
  const queue = () => { if (!q) q = setTimeout(() => requestAnimationFrame(fit), Math.max(16, 150 - (performance.now() - last))); };
  const start = () => {
    if (started || !coarse.matches) return; started = true;
    addEventListener('scroll', queue, { passive:true, capture:true }); addEventListener('resize', queue);
    new MutationObserver(queue).observe(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['class', 'hidden', 'open', 'aria-expanded', 'aria-checked', 'aria-pressed', 'aria-selected'] });
    queue();
  };
  start(); if (coarse.addEventListener) coarse.addEventListener('change', start);
  window.dmFitHits = fit; return fit;
})();

/* ---------- icons: the sprite every <use href="#i-..."> points at ---------- */
const SPRITE = "<svg xmlns=\"http://www.w3.org/2000/svg\" style=\"position:absolute;width:0;height:0;overflow:hidden\" aria-hidden=\"true\">\n<symbol id=\"i-minus\" viewBox=\"0 0 24 24\"><path d=\"M5 12h14\"/></symbol>\n<symbol id=\"i-plus\" viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></symbol>\n<symbol id=\"i-x\" viewBox=\"0 0 24 24\"><path d=\"M6 6l12 12M18 6 6 18\"/></symbol>\n<symbol id=\"i-check\" viewBox=\"0 0 24 24\"><path d=\"m5 12.5 4.5 4.5L19 7.5\"/></symbol>\n<symbol id=\"i-chev-r\" viewBox=\"0 0 24 24\"><path d=\"m9 6 6 6-6 6\"/></symbol>\n<symbol id=\"i-chev-l\" viewBox=\"0 0 24 24\"><path d=\"m15 6-6 6 6 6\"/></symbol>\n<symbol id=\"i-chev-d\" viewBox=\"0 0 24 24\"><path d=\"m6 9 6 6 6-6\"/></symbol>\n<symbol id=\"i-chev-u\" viewBox=\"0 0 24 24\"><path d=\"m6 15 6-6 6 6\"/></symbol>\n<symbol id=\"i-unfold\" viewBox=\"0 0 24 24\"><path d=\"m8 9.5 4-4 4 4M8 14.5l4 4 4-4\"/></symbol>\n<symbol id=\"i-crumb\" viewBox=\"0 0 24 24\"><path d=\"M14.5 5 9.5 19\"/></symbol>\n<symbol id=\"i-up\" viewBox=\"0 0 24 24\"><path d=\"M12 19V5M6 11l6-6 6 6\"/></symbol>\n<symbol id=\"i-right\" viewBox=\"0 0 24 24\"><path d=\"M5 12h14M13 6l6 6-6 6\"/></symbol>\n<symbol id=\"i-search\" viewBox=\"0 0 24 24\"><circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"m20 20-4-4\"/></symbol>\n<symbol id=\"i-folder\" viewBox=\"0 0 24 24\"><path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/></symbol>\n<symbol id=\"i-laptop\" viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"5\" width=\"16\" height=\"11\" rx=\"1.5\"/><path d=\"M2 19h20\"/></symbol>\n<symbol id=\"i-cloud\" viewBox=\"0 0 24 24\"><path d=\"M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.25 4.25 0 0 0 7 18z\"/></symbol>\n<symbol id=\"i-mic\" viewBox=\"0 0 24 24\"><rect x=\"9\" y=\"3\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5 11a7 7 0 0 0 14 0M12 18v3\"/></symbol>\n<symbol id=\"i-file\" viewBox=\"0 0 24 24\"><path d=\"M6 3h8l4 4v14H6z\"/><path d=\"M14 3v4h4\"/></symbol>\n<symbol id=\"i-file-text\" viewBox=\"0 0 24 24\"><path d=\"M6 3h8l4 4v14H6z\"/><path d=\"M14 3v4h4M9 13h6M9 16.5h6\"/></symbol>\n<symbol id=\"i-image\" viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"2\"/><circle cx=\"9\" cy=\"10\" r=\"1.6\"/><path d=\"m4 17 5-4.5 4 3.5 3-2.5 4.5 3.5\"/></symbol>\n<symbol id=\"i-clip\" viewBox=\"0 0 24 24\"><path d=\"m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.8 16.9a1.7 1.7 0 0 1-2.4-2.4L14.5 7.4\"/></symbol>\n<symbol id=\"i-at\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3.6\"/><path d=\"M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 6.9\"/></symbol>\n<symbol id=\"i-slash\" viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"4\"/><path d=\"m14.5 7.5-5 9\"/></symbol>\n<symbol id=\"i-spark\" viewBox=\"0 0 24 24\"><path d=\"M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5zM18.5 15c.3 2 1 2.7 3 3-2 .3-2.7 1-3 3-.3-2-1-2.7-3-3 2-.3 2.7-1 3-3z\"/></symbol>\n<symbol id=\"i-bolt\" viewBox=\"0 0 24 24\"><path d=\"M13 3 5 13.5h6L10 21l8-10.5h-6z\"/></symbol>\n<symbol id=\"i-pr\" viewBox=\"0 0 24 24\"><circle cx=\"6\" cy=\"6\" r=\"2.2\"/><circle cx=\"6\" cy=\"18\" r=\"2.2\"/><circle cx=\"18\" cy=\"18\" r=\"2.2\"/><path d=\"M6 8.2v7.6M18 15.8V9a3 3 0 0 0-3-3h-4m2-2-2 2 2 2\"/></symbol>\n<symbol id=\"i-merge\" viewBox=\"0 0 24 24\"><circle cx=\"6\" cy=\"6\" r=\"2.2\"/><circle cx=\"6\" cy=\"18\" r=\"2.2\"/><circle cx=\"18\" cy=\"12\" r=\"2.2\"/><path d=\"M6 8.2v7.6M7.6 7.6c1.5 3 4.5 4.4 8.2 4.4\"/></symbol>\n<symbol id=\"i-branch\" viewBox=\"0 0 24 24\"><circle cx=\"6\" cy=\"6\" r=\"2.2\"/><circle cx=\"6\" cy=\"18\" r=\"2.2\"/><circle cx=\"18\" cy=\"7\" r=\"2.2\"/><path d=\"M6 8.2v7.6M18 9.2c0 4.5-6 3.6-11 7\"/></symbol>\n<symbol id=\"i-warn\" viewBox=\"0 0 24 24\"><path d=\"M12 4 2.8 19.5h18.4z\"/><path d=\"M12 10v4M12 17v.01\"/></symbol>\n<symbol id=\"i-info\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 11v5M12 8v.01\"/></symbol>\n<symbol id=\"i-alert\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7.5V13M12 16.5v.01\"/></symbol>\n<symbol id=\"i-ok\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"m8.2 12.3 2.6 2.6 5-5.2\"/></symbol>\n<symbol id=\"i-clock\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/></symbol>\n<symbol id=\"i-play\" viewBox=\"0 0 24 24\"><path d=\"M7 5v14l12-7z\"/></symbol>\n<symbol id=\"i-pause\" viewBox=\"0 0 24 24\"><path d=\"M8 5v14M16 5v14\"/></symbol>\n<symbol id=\"i-stop\" viewBox=\"0 0 24 24\"><rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/></symbol>\n<symbol id=\"i-refresh\" viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5\"/></symbol>\n<symbol id=\"i-copy\" viewBox=\"0 0 24 24\"><rect x=\"8.5\" y=\"8.5\" width=\"11\" height=\"11\" rx=\"2\"/><path d=\"M15.5 8.5V6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2\"/></symbol>\n<symbol id=\"i-ext\" viewBox=\"0 0 24 24\"><path d=\"M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4\"/></symbol>\n<symbol id=\"i-link\" viewBox=\"0 0 24 24\"><path d=\"M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1\"/></symbol>\n<symbol id=\"i-eye\" viewBox=\"0 0 24 24\"><path d=\"M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></symbol>\n<symbol id=\"i-lock\" viewBox=\"0 0 24 24\"><rect x=\"5\" y=\"10.5\" width=\"14\" height=\"10\" rx=\"2\"/><path d=\"M8 10.5V8a4 4 0 0 1 8 0v2.5\"/></symbol>\n<symbol id=\"i-shield\" viewBox=\"0 0 24 24\"><path d=\"M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z\"/></symbol>\n<symbol id=\"i-user\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"8.5\" r=\"3.8\"/><path d=\"M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5\"/></symbol>\n<symbol id=\"i-users\" viewBox=\"0 0 24 24\"><circle cx=\"9\" cy=\"8.5\" r=\"3.5\"/><path d=\"M2.8 19.5c1-3.3 3.4-5 6.2-5s5.2 1.7 6.2 5M16 5.2a3.4 3.4 0 0 1 0 6.6M17.6 14.6c1.8.6 3 2.2 3.6 4.9\"/></symbol>\n<symbol id=\"i-bell\" viewBox=\"0 0 24 24\"><path d=\"M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2.2 2.2 0 0 0 4 0\"/></symbol>\n<symbol id=\"i-cal\" viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/></symbol>\n<symbol id=\"i-gear\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7\"/></symbol>\n<symbol id=\"i-sliders\" viewBox=\"0 0 24 24\"><path d=\"M4 7h10M18 7h2M4 17h4M12 17h8\"/><circle cx=\"16\" cy=\"7\" r=\"2\"/><circle cx=\"10\" cy=\"17\" r=\"2\"/></symbol>\n<symbol id=\"i-trash\" viewBox=\"0 0 24 24\"><path d=\"M4.5 7h15M10 4h4M6.5 7l1 13h9l1-13M10 11v5M14 11v5\"/></symbol>\n<symbol id=\"i-edit\" viewBox=\"0 0 24 24\"><path d=\"M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z\"/><path d=\"m13.5 6.5 4 4\"/></symbol>\n<symbol id=\"i-more\" viewBox=\"0 0 24 24\"><circle cx=\"6\" cy=\"12\" r=\"1.2\"/><circle cx=\"12\" cy=\"12\" r=\"1.2\"/><circle cx=\"18\" cy=\"12\" r=\"1.2\"/></symbol>\n<symbol id=\"i-up-thumb\" viewBox=\"0 0 24 24\"><path d=\"M7.5 10.5V20H5a1.5 1.5 0 0 1-1.5-1.5V12A1.5 1.5 0 0 1 5 10.5zM7.5 10.5 11 3.5a2.2 2.2 0 0 1 2.4 2.6L13 9.5h5.3a2 2 0 0 1 2 2.4l-1.3 6.3a2.2 2.2 0 0 1-2.2 1.8H7.5\"/></symbol>\n<symbol id=\"i-down-thumb\" viewBox=\"0 0 24 24\"><path d=\"M16.5 13.5V4H19a1.5 1.5 0 0 1 1.5 1.5V12a1.5 1.5 0 0 1-1.5 1.5zM16.5 13.5 13 20.5a2.2 2.2 0 0 1-2.4-2.6l.4-3.4H5.7a2 2 0 0 1-2-2.4L5 5.8A2.2 2.2 0 0 1 7.2 4h9.3\"/></symbol>\n<symbol id=\"i-term\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"4.5\" width=\"18\" height=\"15\" rx=\"2\"/><path d=\"m7 10 3 2.5L7 15M12.5 15.5H17\"/></symbol>\n<symbol id=\"i-code\" viewBox=\"0 0 24 24\"><path d=\"m8 7-5 5 5 5M16 7l5 5-5 5\"/></symbol>\n<symbol id=\"i-globe\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18\"/></symbol>\n<symbol id=\"i-db\" viewBox=\"0 0 24 24\"><ellipse cx=\"12\" cy=\"6\" rx=\"7.5\" ry=\"2.8\"/><path d=\"M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8\"/></symbol>\n<symbol id=\"i-table\" viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"2\"/><path d=\"M3.5 9.5h17M3.5 14.5h17M10 9.5v10\"/></symbol>\n<symbol id=\"i-chart\" viewBox=\"0 0 24 24\"><path d=\"M4 4v16h16\"/><path d=\"m7.5 14 3.5-4 3 2.5 5-6\"/></symbol>\n<symbol id=\"i-bars\" viewBox=\"0 0 24 24\"><path d=\"M6 20V11M12 20V5M18 20v-6\"/></symbol>\n<symbol id=\"i-layers\" viewBox=\"0 0 24 24\"><path d=\"m12 3.5 9 4.8-9 4.8-9-4.8z\"/><path d=\"m3 12.3 9 4.8 9-4.8M3 16.3l9 4.8 9-4.8\"/></symbol>\n<symbol id=\"i-grid\" viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"4\" width=\"6.5\" height=\"6.5\" rx=\"1.5\"/><rect x=\"13.5\" y=\"4\" width=\"6.5\" height=\"6.5\" rx=\"1.5\"/><rect x=\"4\" y=\"13.5\" width=\"6.5\" height=\"6.5\" rx=\"1.5\"/><rect x=\"13.5\" y=\"13.5\" width=\"6.5\" height=\"6.5\" rx=\"1.5\"/></symbol>\n<symbol id=\"i-list\" viewBox=\"0 0 24 24\"><path d=\"M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01\"/></symbol>\n<symbol id=\"i-filter\" viewBox=\"0 0 24 24\"><path d=\"M4 5h16l-6 7.5V19l-4 1.5v-8z\"/></symbol>\n<symbol id=\"i-sort\" viewBox=\"0 0 24 24\"><path d=\"M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5\"/></symbol>\n<symbol id=\"i-pin\" viewBox=\"0 0 24 24\"><path d=\"M9 4h6l-1 5 3.5 3.5v1.5h-11v-1.5L10 9zM12 14v6\"/></symbol>\n<symbol id=\"i-star\" viewBox=\"0 0 24 24\"><path d=\"m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z\"/></symbol>\n<symbol id=\"i-bookmark\" viewBox=\"0 0 24 24\"><path d=\"M6.5 4h11v16.5L12 16.5l-5.5 4z\"/></symbol>\n<symbol id=\"i-send\" viewBox=\"0 0 24 24\"><path d=\"M21 3 10 14M21 3l-6.5 18-4.5-7-7-4.5z\"/></symbol>\n<symbol id=\"i-mail\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"m3.5 6.5 8.5 6.5 8.5-6.5\"/></symbol>\n<symbol id=\"i-home\" viewBox=\"0 0 24 24\"><path d=\"M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z\"/></symbol>\n<symbol id=\"i-cmd\" viewBox=\"0 0 24 24\"><path d=\"M9 6.5V17.5M15 6.5V17.5M6.5 9H17.5M6.5 15H17.5\"/><path d=\"M9 9H6.5A2.5 2.5 0 1 1 9 6.5zM15 9h2.5A2.5 2.5 0 1 0 15 6.5zM9 15H6.5A2.5 2.5 0 1 0 9 17.5zM15 15h2.5a2.5 2.5 0 1 1-2.5 2.5z\"/></symbol>\n<symbol id=\"i-cpu\" viewBox=\"0 0 24 24\"><rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/><rect x=\"9.5\" y=\"9.5\" width=\"5\" height=\"5\" rx=\"1\"/><path d=\"M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3\"/></symbol>\n<symbol id=\"i-coins\" viewBox=\"0 0 24 24\"><ellipse cx=\"9\" cy=\"7\" rx=\"5.5\" ry=\"2.5\"/><path d=\"M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7\"/><path d=\"M9.5 15.8c.9 1 2.9 1.7 5 1.7 3 0 5.5-1.1 5.5-2.5v-4c0-1.2-1.8-2.2-4.3-2.4\"/></symbol>\n<symbol id=\"i-gauge\" viewBox=\"0 0 24 24\"><path d=\"M4.5 17.5a8.5 8.5 0 1 1 15 0\"/><path d=\"m12 13 4-4\"/><circle cx=\"12\" cy=\"13\" r=\"1.2\"/></symbol>\n<symbol id=\"i-flag\" viewBox=\"0 0 24 24\"><path d=\"M5 21V4.5h11l-2 4 2 4H5\"/></symbol>\n<symbol id=\"i-wand\" viewBox=\"0 0 24 24\"><path d=\"m4 20 11-11M13 7l4 4M16 3v2.5M19.5 6.5H22M19 3.5l-1.5 1.5\"/></symbol>\n<symbol id=\"i-book\" viewBox=\"0 0 24 24\"><path d=\"M4 5.5A1.5 1.5 0 0 1 5.5 4H12v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H12v16h6.5a1.5 1.5 0 0 0 1.5-1.5z\"/></symbol>\n<symbol id=\"i-down\" viewBox=\"0 0 24 24\"><path d=\"M12 4v12M6.5 11 12 16.5 17.5 11M5 20h14\"/></symbol>\n<symbol id=\"i-upload\" viewBox=\"0 0 24 24\"><path d=\"M12 16V4M6.5 9 12 3.5 17.5 9M5 20h14\"/></symbol>\n<symbol id=\"i-monitor\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"12.5\" rx=\"2\"/><path d=\"M8.5 20.5h7M12 16.5v4\"/></symbol>\n<symbol id=\"i-grip\" viewBox=\"0 0 24 24\"><circle cx=\"9\" cy=\"6.5\" r=\"1\"/><circle cx=\"15\" cy=\"6.5\" r=\"1\"/><circle cx=\"9\" cy=\"12\" r=\"1\"/><circle cx=\"15\" cy=\"12\" r=\"1\"/><circle cx=\"9\" cy=\"17.5\" r=\"1\"/><circle cx=\"15\" cy=\"17.5\" r=\"1\"/></symbol>\n<symbol id=\"i-figma\" viewBox=\"0 0 24 24\"><path d=\"M9 3h3v6H9a3 3 0 0 1 0-6zM12 3h3a3 3 0 0 1 0 6h-3zM9 9h3v6H9a3 3 0 0 1 0-6zM15 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM9 15h3v3a3 3 0 1 1-3-3z\"/></symbol>\n<symbol id=\"i-react\" viewBox=\"0 0 24 24\"><ellipse cx=\"12\" cy=\"12\" rx=\"9\" ry=\"3.6\"/><ellipse cx=\"12\" cy=\"12\" rx=\"9\" ry=\"3.6\" transform=\"rotate(60 12 12)\"/><ellipse cx=\"12\" cy=\"12\" rx=\"9\" ry=\"3.6\" transform=\"rotate(120 12 12)\"/></symbol>\n<symbol id=\"i-undo\" viewBox=\"0 0 24 24\"><path d=\"M9 14 4 9l5-5\"/><path d=\"M4 9h10.5a5.5 5.5 0 0 1 0 11H11\"/></symbol>\n<symbol id=\"i-redo\" viewBox=\"0 0 24 24\"><path d=\"m15 14 5-5-5-5\"/><path d=\"M20 9H9.5a5.5 5.5 0 0 0 0 11H13\"/></symbol>\n<symbol id=\"i-bold\" viewBox=\"0 0 24 24\"><path d=\"M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z\"/></symbol>\n<symbol id=\"i-italic\" viewBox=\"0 0 24 24\"><path d=\"M10 5h8M6 19h8M14.5 5l-5 14\"/></symbol>\n<symbol id=\"i-heading\" viewBox=\"0 0 24 24\"><path d=\"M6 5v14M17 5v14M6 12h11\"/></symbol>\n<symbol id=\"i-list-ol\" viewBox=\"0 0 24 24\"><path d=\"M10.5 6.5H20M10.5 12H20M10.5 17.5H20M4.5 5l1.5-1v5M4 14.2c.3-.7.9-1 1.5-1 .8 0 1.5.5 1.5 1.3 0 1.2-3 2.1-3 3.5h3\"/></symbol>\n<symbol id=\"i-quote\" viewBox=\"0 0 24 24\"><path d=\"M10 6.5c-2.9.9-4.5 3.2-4.5 6.5v4h4v-4H6M18.5 6.5c-2.9.9-4.5 3.2-4.5 6.5v4h4v-4h-3.5\"/></symbol>\n<symbol id=\"i-cursor\" viewBox=\"0 0 24 24\"><path d=\"M6.5 4v13.6l3.7-3.5 2.4 5.5 2.3-1-2.4-5.4h5.3z\"/></symbol>\n<symbol id=\"i-hand\" viewBox=\"0 0 24 24\"><path d=\"M8.2 13V7.6a1.25 1.25 0 0 1 2.5 0v4.2M10.7 11.6V5.6a1.25 1.25 0 0 1 2.5 0v6M13.2 11.6V6.6a1.25 1.25 0 0 1 2.5 0v5.2M15.7 12V9a1.25 1.25 0 0 1 2.5 0v5c0 3.6-2.5 6-5.8 6-2.2 0-3.7-.9-5-2.7l-2.3-3.3a1.3 1.3 0 0 1 2.1-1.6l1 1.3\"/></symbol>\n<symbol id=\"i-lasso\" viewBox=\"0 0 24 24\"><path d=\"M12 4.5c4.4 0 8 2.5 8 5.5s-3.6 5.5-8 5.5-8-2.5-8-5.5 3.6-5.5 8-5.5z\"/><path d=\"M7.6 14.6c-1 1.2-.7 2.9.8 3.3 1.3.3 1.6 1.5.6 2.6\"/></symbol>\n<symbol id=\"i-comment\" viewBox=\"0 0 24 24\"><path d=\"M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H11l-4.2 3.3V16H5.5A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5z\"/></symbol>\n<symbol id=\"i-fit\" viewBox=\"0 0 24 24\"><path d=\"M4 8.5v-3A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3\"/><rect x=\"8.5\" y=\"9\" width=\"7\" height=\"6\" rx=\"1\"/></symbol>\n<symbol id=\"i-history\" viewBox=\"0 0 24 24\"><path d=\"M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 7.5V12l3 2\"/></symbol>\n<symbol id=\"i-brain\" viewBox=\"0 0 24 24\"><path d=\"M9.5 4.5a2.5 2.5 0 0 0-2.5 2.5 3 3 0 0 0-2.2 5 3 3 0 0 0 1.7 5A3 3 0 0 0 12 18V6.5a2 2 0 0 0-2.5-2zM14.5 4.5A2.5 2.5 0 0 1 17 7a3 3 0 0 1 2.2 5 3 3 0 0 1-1.7 5A3 3 0 0 1 12 18\"/></symbol>\n<symbol id=\"i-dollar\" viewBox=\"0 0 24 24\"><path d=\"M12 3v18M16.5 7.5c-.6-1.6-2.3-2.5-4.5-2.5-2.5 0-4.3 1.2-4.3 3.2 0 4.6 9 2.4 9 7.2 0 2-1.9 3.4-4.7 3.4-2.4 0-4.2-1-4.8-2.8\"/></symbol>\n<symbol id=\"i-heart\" viewBox=\"0 0 24 24\"><path d=\"M12 20s-7.5-4.5-7.5-10A4.3 4.3 0 0 1 12 7.5 4.3 4.3 0 0 1 19.5 10c0 5.5-7.5 10-7.5 10z\"/></symbol>\n<symbol id=\"i-smile\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5v.01M15 9.5v.01\"/></symbol>\n<symbol id=\"i-hash\" viewBox=\"0 0 24 24\"><path d=\"M9 4 7.5 20M16.5 4 15 20M4.5 9h15M4 15h15\"/></symbol>\n<symbol id=\"i-panel\" viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"2\"/><path d=\"M9 4.5v15\"/></symbol>\n<symbol id=\"i-max\" viewBox=\"0 0 24 24\"><path d=\"M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5\"/></symbol>\n<symbol id=\"i-wave\" viewBox=\"0 0 24 24\"><path d=\"M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4\"/></symbol>\n<symbol id=\"i-vol\" viewBox=\"0 0 24 24\"><path d=\"M5 9.5h3.5L13 5v14l-4.5-4.5H5zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11\"/></symbol>\n<symbol id=\"i-target\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><circle cx=\"12\" cy=\"12\" r=\"4.5\"/><circle cx=\"12\" cy=\"12\" r=\".8\"/></symbol>\n<symbol id=\"i-rocket\" viewBox=\"0 0 24 24\"><path d=\"M5 15c-1.5 1-2 3.5-2 6 2.5 0 5-.5 6-2M14.5 4.5c3-1.3 5.4-1.2 5.4-1.2s.1 2.4-1.2 5.4c-1.3 3-4.7 6.6-8.2 8.5l-3.2-3.2c1.9-3.5 5.5-6.9 7.2-9.5z\"/><circle cx=\"15\" cy=\"9\" r=\"1.5\"/></symbol>\n<symbol id=\"i-palette\" viewBox=\"0 0 24 24\"><path d=\"M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 1.8-1 1.4-2-.5-1.2.3-2.5 1.6-2.5h2a3.5 3.5 0 0 0 3.5-3.5c0-5-3.8-9-8.5-9z\"/><circle cx=\"7.8\" cy=\"11\" r=\"1\"/><circle cx=\"10.5\" cy=\"7.3\" r=\"1\"/><circle cx=\"15\" cy=\"7.5\" r=\"1\"/></symbol>\n<symbol id=\"i-moon\" viewBox=\"0 0 24 24\"><path d=\"M19.5 14.2A7.8 7.8 0 0 1 9.8 4.5a7.8 7.8 0 1 0 9.7 9.7z\"/></symbol>\n<symbol id=\"i-keyboard\" viewBox=\"0 0 24 24\"><rect x=\"2.5\" y=\"6\" width=\"19\" height=\"12\" rx=\"2\"/><path d=\"M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8\"/></symbol>\n<symbol id=\"i-logout\" viewBox=\"0 0 24 24\"><path d=\"M14 4.5H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7M10.5 12H20M16.5 8.5 20 12l-3.5 3.5\"/></symbol>\n</svg>";
/* ---------- mount: every card (a [data-c] with its .stage-in) starts its component when it scrolls into view ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('i-check')) document.body.insertAdjacentHTML('afterbegin', SPRITE);
  document.body.appendChild(tip);
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting){ io.unobserve(en.target); DM.mount(en.target); } }), { threshold:.25 });
  // a menu item inside a component can carry a data-c of its own (a colour), so only a card with a stage counts
  $$('[data-c]').filter(card => $(':scope > .stage-in', card)).forEach(card => io.observe(card));
});
