// Build the browser shell from the editable, self-contained public/index.html.
// Keeping the source inline preserves existing source-level browser fixtures;
// the served copy gives HTML, CSS, and JavaScript independent caches.
const fs = require('node:fs');
const path = require('node:path');

const frontendDir = path.resolve(__dirname, '..');
const sourcePath = path.join(frontendDir, 'public', 'index.html');
const outputDir = path.join(frontendDir, 'runtime');
const version = '20261109-deposit-noimage';

function writeIfChanged(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content)
    fs.writeFileSync(file, content, 'utf8');
}

function extractBlock(html, opener, closer, fileName, replacement) {
  const matches = [...html.matchAll(new RegExp(opener.source, 'g'))];
  if (matches.length !== 1) throw new Error(`Expected one ${fileName} block`);
  const begin = matches[0].index;
  const contentStart = begin + matches[0][0].indexOf('>') + 1;
  const end = html.indexOf(closer, contentStart);
  if (end < 0) throw new Error(`Missing closing tag for ${fileName}`);
  writeIfChanged(path.join(outputDir, fileName), html.slice(contentStart, end));
  return html.slice(0, begin) + replacement + html.slice(end + closer.length);
}

function splitAppScript(html) {
  const opener = /<script>\r?\nconst qs =/.exec(html);
  if (!opener) throw new Error('Missing application script');
  const begin = opener.index;
  const contentStart = begin + opener[0].indexOf('>') + 1;
  const end = html.indexOf('</script>', contentStart);
  const content = html.slice(contentStart, end);
  const marker = '// ===================== Shopify Orders =====================';
  const boundary = content.indexOf(marker);
  if (boundary < 0 || content.indexOf(marker, boundary + 1) >= 0) throw new Error('Expected one Shopify route boundary');
  let route = content.slice(boundary);
  const shared = [
    'let _shopifyOrders = [];', "let _shopifyTab = 'pending';", 'let _spMyFollowUpScope = null;',
    "let _shopifyStatusFilter = '';", "let _spColumnStatusFilter = '';",
    'let _shopifyDateFilter = { from: null, to: null };', 'let _shopifySelectedIds = new Set();',
    "let _spSubnavTab = 'orders';", 'let _spServerEnabled = false;', 'let _spServerResponse = null;',
    'let _spStarOnly = false;', 'let _spPeekId = null;', 'let _spFuFetchedAt = 0;',
  ];
  for (const declaration of shared) {
    if (route.split(declaration).length !== 2) throw new Error(`Missing shared Shopify binding: ${declaration}`);
    route = route.replace(declaration, '');
  }
  let prefix = content.slice(0, boundary);
  // These renderers are only entered from invoice/Follow-ups interactions.
  // Extract complete top-level declarations using the following declaration as
  // a boundary; the editable source retains the original inline definitions.
  const extractFunction = (name, next, library) => {
    const start = `function ${name}(`;
    const stop = next.startsWith('async ') ? `${next}(` : `function ${next}(`;
    const at = prefix.indexOf(start);
    const end = prefix.indexOf(stop, at + start.length);
    if (at < 0 || end < 0 || prefix.indexOf(start, at + start.length) >= 0)
      throw new Error(`Expected one ${name} declaration before ${next}`);
    const body = prefix.slice(at, end);
    prefix = prefix.slice(0, at) + (library ?
      `function ${name}(...args) { const bridge = ${name}; return window.souliaLibraryReady('${library}').then(ready => { if (!ready || window.${name} === bridge) throw new Error('${library} unavailable'); return window.${name}(...args); }); }\n\n`
      : '') + prefix.slice(end);
    return body;
  };
  const invoiceParts = [
    extractFunction('showInvoiceDetail', '_buildTxPermalink', 'invoiceViews'),
    extractFunction('renderInvoiceViewPage', '_movementsNavLabel', 'invoiceViews'),
    extractFunction('buildOrderTimelineSection', 'buildPaymentTimelineSection', null),
  ];
  const followupsPart = extractFunction('renderFollowUps', 'async function updateFuStatus', 'followupsView');
  writeIfChanged(path.join(outputDir, 'invoice-views-route.js'), invoiceParts.join('\n'));
  writeIfChanged(path.join(outputDir, 'followups-view-route.js'), followupsPart);
  // Transaction form language refresh calls this pure icon helper on startup.
  // Keep it in core so that one small SVG cannot trigger the whole Orders chunk.
  const iconStart = route.indexOf('function _spDepIcon(name) {');
  const iconClose = /\r?\n}\r?\n/g;
  iconClose.lastIndex = iconStart;
  const iconEndMatch = iconClose.exec(route);
  if (iconStart < 0 || !iconEndMatch) throw new Error('Missing shared deposit icon helper');
  const iconEnd = iconEndMatch.index + iconEndMatch[0].length;
  const sharedIcon = route.slice(iconStart, iconEnd);
  route = route.slice(0, iconStart) + route.slice(iconEnd);
  // Classic scripts share global function bindings. These small bridges keep
  // older inline handlers and socket callbacks safe until the route arrives.
  const routeFunctions = [...route.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)]
    .map(match => match[1]).filter(name => new RegExp(`\\b${name}\\b`).test(prefix));
  const bridgeNames = [...new Set(routeFunctions)];
  const bridges = bridgeNames.map(name =>
    `function ${name}(...args) { return window.souliaLibraryReady('shopifyOrders').then(ready => { if (!ready || window.${name} === window.__SOULIA_SHOPIFY_BRIDGES__.${name}) throw new Error('Shopify Orders module unavailable'); return window.${name}(...args); }); }`).join('\n');
  const bridgeRegistry = `window.__SOULIA_SHOPIFY_BRIDGES__ = { ${bridgeNames.map(name => `${name}: window.${name}`).join(', ')} };`;
  writeIfChanged(path.join(outputDir, 'app-core.js'), prefix + '\n' + shared.join('\n') + '\n' + sharedIcon + '\n' + bridges + '\n' + bridgeRegistry + '\n');
  writeIfChanged(path.join(outputDir, 'shopify-orders-route.js'), route + '\nwindow.__SOULIA_SHOPIFY_LOADED__ = true;\n');
  return html.slice(0, begin) + `<script>window.__SOULIA_SPLIT_SHOPIFY__=true;</script>\n<script src="/app-core.js?v=${version}"></script>`
    + html.slice(end + '</script>'.length);
}

function buildRuntime() {
  let html = fs.readFileSync(sourcePath, 'utf8');
  html = extractBlock(html, /<style>\r?\n\*,\*::before,\*::after/, '</style>', 'app-core.css',
    `<link rel="stylesheet" href="/app-core.css?v=${version}">`);
  html = splitAppScript(html);
  const invoiceScript = '<script src="/invoice-image.js?v=20261029-purchase-access"></script>';
  if (html.indexOf(invoiceScript) < 0 || html.indexOf(invoiceScript) !== html.lastIndexOf(invoiceScript))
    throw new Error('Expected one invoice image script');
  html = html.replace(invoiceScript, '');
  for (const script of [
    '<script src="/shopify-kpis.js?v=20261109-cascade"></script>',
    '<script src="/deposit-history.js?v=20261109-noimage"></script>',
    '<script src="/shopify-edit-approvals.js?v=20261103-compact-order-mark"></script>',
  ]) {
    if (html.indexOf(script) < 0 || html.indexOf(script) !== html.lastIndexOf(script))
      throw new Error(`Expected one route script: ${script}`);
    html = html.replace(script, '');
  }
  const settingsScript = '<script src="/shopify-settings.js?v=20261020-connection-status"></script>';
  if (html.indexOf(settingsScript) < 0 || html.indexOf(settingsScript) !== html.lastIndexOf(settingsScript))
    throw new Error('Expected one Settings integrations script');
  html = html.replace(settingsScript, '');

  const open = '<div class="page" id="page-settings">';
  const close = '</div><!-- /page-settings -->';
  const begin = html.indexOf(open);
  if (begin < 0 || html.indexOf(open, begin + 1) >= 0) throw new Error('Expected one Settings page');
  const contentStart = begin + open.length;
  const end = html.indexOf(close, contentStart);
  if (end < 0) throw new Error('Missing Settings closing marker');
  const panel = '<section id="notification-settings" class="settings-card" hidden></section>';
  const settingsContent = html.slice(contentStart, end);
  if (!settingsContent.includes(panel)) throw new Error('Missing push preferences panel');
  const fragment = settingsContent.replace(panel, '<div id="notification-settings-slot"></div>');
  writeIfChanged(path.join(outputDir, 'fragments', 'settings.html'), fragment);
  const shellPanel = '<div id="notification-settings-home" hidden>' + panel + '</div>';
  html = html.slice(0, contentStart) + '\r\n<!-- Settings content loads on first visit. -->\r\n'
    + close + '\r\n' + shellPanel + html.slice(end + close.length);
  if (!html.includes(shellPanel)) throw new Error('Missing push preferences shell panel');
  writeIfChanged(path.join(outputDir, 'index.html'), html);
  return { sourceBytes: Buffer.byteLength(fs.readFileSync(sourcePath)),
    runtimeBytes: Buffer.byteLength(html) };
}

if (require.main === module) console.log(JSON.stringify(buildRuntime()));
module.exports = { buildRuntime };
