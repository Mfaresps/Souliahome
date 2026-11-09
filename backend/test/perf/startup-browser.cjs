// Read-only, repeatable browser startup profile. API calls are mocked and writes never reach the server.
const puppeteer = require('puppeteer');
const fs = require('node:fs');
const path = require('node:path');

const label = process.argv[2] || 'profile';
const runs = Number(process.argv[3] || 3);
const route = process.argv[4] || '/';
const origin = process.env.STARTUP_BASE_URL || 'http://127.0.0.1:8080';
const htmlPath = process.env.STARTUP_HTML_PATH
  ? path.resolve(process.env.STARTUP_HTML_PATH)
  : path.resolve(__dirname, '../../../frontend/public/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const encodedBytes = value => Buffer.byteLength(value);
const styles = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)];
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
const sizeBreakdown = {
  inlineStyleBytes: styles.reduce((sum, match) => sum + encodedBytes(match[0]), 0),
  inlineScriptBytes: scripts.reduce((sum, match) => sum + encodedBytes(match[0]), 0),
  largestInlineScriptBytes: Math.max(0, ...scripts.map(match => encodedBytes(match[0]))),
};

async function one(browser) {
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();
  await cdp.send('Performance.enable');
  const errors = [];
  const apiPaths = {};
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('token', 'startup-perf-test');
    localStorage.setItem('user', JSON.stringify({ name: 'Profile', role: 'admin', perms: [] }));
    window.__startupPerf = { longTasks: [], lcp: 0, interactive: 0 };
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__startupPerf.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__startupPerf.lcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) {}
    const watch = () => {
      if (!window.__startupPerf.interactive && window.souliaPushAppReady === true
          && document.querySelector('#app')?.style.display === 'block'
          && !document.querySelector('#splash-screen')
          && document.querySelector('.page.active')) window.__startupPerf.interactive = performance.now();
      if (!window.__startupPerf.interactive) requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return request.continue();
    apiPaths[pathname] = (apiPaths[pathname] || 0) + 1;
    let body = '[]';
    if (pathname === '/api/auth/me') body = JSON.stringify({ name: 'Profile', role: 'admin', perms: [] });
    if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') body = '{}';
    if (pathname === '/api/transactions/startup-overview') body = JSON.stringify({ rows: [], activeCount: 0 });
    if (pathname === '/api/warehouse-layout') body = JSON.stringify({ warehouses: [], locations: [], labelSizes: [] });
    return request.respond({ status: 200, contentType: 'application/json', body });
  });
  await page.goto(origin + route, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__startupPerf?.interactive > 0, { timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 300));
  const result = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0;
    const interactive = window.__startupPerf.interactive;
    const longTasks = window.__startupPerf.longTasks;
    const pageNodes = [...document.querySelectorAll('.page[id]')].map(element => ({
      id: element.id, nodes: element.getElementsByTagName('*').length + 1,
      allNodes: (() => { const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL); let count = 0;
        while (walker.nextNode()) count++; return count + 1; })(),
      htmlBytes: new TextEncoder().encode(element.outerHTML).length,
      active: element.classList.contains('active'),
    })).sort((a, b) => b.nodes - a.nodes);
    return {
      route: location.hash || '/', activePage: document.querySelector('.page.active')?.id,
      domContentLoadedMs: nav.domContentLoadedEventEnd,
      fcpMs: fcp, lcpMs: window.__startupPerf.lcp,
      interactiveMs: interactive,
      mainThreadLongTaskMs: Math.round(longTasks.filter(task => task.start < interactive)
        .reduce((sum, task) => sum + task.duration, 0)),
      totalBlockingMs: Math.round(longTasks.filter(task => task.start >= fcp && task.start < interactive)
        .reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0)),
      longTasks: longTasks.filter(task => task.start < interactive).length,
      domNodes: document.getElementsByTagName('*').length,
      allDomNodes: (() => { const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL); let count = 0;
        while (walker.nextNode()) count++; return count + 1; })(),
      hiddenPageNodes: pageNodes.filter(p => !p.active).reduce((sum, p) => sum + p.nodes, 0),
      hiddenPageAllNodes: pageNodes.filter(p => !p.active).reduce((sum, p) => sum + p.allNodes, 0),
      topPages: pageNodes.slice(0, 12),
    };
  });
  const chromeMetrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
    .map(metric => [metric.name, metric.value]));
  result.scriptDurationMs = Math.round((chromeMetrics.ScriptDuration || 0) * 1000);
  result.layoutDurationMs = Math.round((chromeMetrics.LayoutDuration || 0) * 1000);
  result.styleDurationMs = Math.round((chromeMetrics.RecalcStyleDuration || 0) * 1000);
  result.chromeNodeCount = chromeMetrics.Nodes || 0;
  await page.close();
  return { ...result, errors, apiPaths };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--disable-background-networking'] });
  try {
    const results = [];
    for (let i = 0; i < runs; i++) results.push(await one(browser));
    const metrics = ['domContentLoadedMs', 'fcpMs', 'lcpMs', 'interactiveMs',
      'mainThreadLongTaskMs', 'totalBlockingMs', 'domNodes', 'allDomNodes',
      'hiddenPageNodes', 'hiddenPageAllNodes', 'scriptDurationMs',
      'layoutDurationMs', 'styleDurationMs', 'chromeNodeCount'];
    const median = Object.fromEntries(metrics.map(key => [key, [...results.map(r => r[key])]
      .sort((a, b) => a - b)[Math.floor(results.length / 2)]]));
    console.log(JSON.stringify({ label, route, htmlBytes: fs.statSync(htmlPath).size, sizeBreakdown, median,
      runs: results, topPages: results[0].topPages }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
