const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createStaticResponder } = require('./lib/static-response.cjs');

// Load .env manually (no extra dependencies)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...rest] = line.trim().split('=');
    if (key && rest.length) process.env[key] = rest.join('=');
  });
}

const app = express();
const PORT = process.env.PORT || 8080;
const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:4000';
const publicFiles = createStaticResponder(path.join(__dirname, 'public'));

// Serve runtime config to the frontend
// Browser uses relative /api paths so requests go through this proxy — never expose the internal backend URL
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.__ENV__ = { API_BASE_URL: "" };`);
});

// Deploy marker — the running app polls this to detect a new build and force a refresh.
// In production nginx serves the copy baked into the image at build time (see Dockerfile);
// here in dev we derive it from index.html's mtime so editing the file bumps the version
// and the update dialog can be exercised locally without a Docker build.
app.get('/version.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  let build = 'dev';
  try {
    // Math.floor, not `| 0` — mtimeMs exceeds 32 bits and bitwise ops would wrap it negative.
    build = String(Math.floor(fs.statSync(path.join(__dirname, 'public', 'index.html')).mtimeMs));
  } catch (_) {}
  res.json({ version: `1.0.${build}`, build });
});

// Revalidate on every visit: an unchanged shell returns 304 with no body, while
// a new release is fetched immediately. Compressed public files are reused in memory.
app.get(['/', '/index.html'], publicFiles.shell);

// Proxy /api requests to backend
const apiProxy = createProxyMiddleware({
  target: API_BASE_URL,
  changeOrigin: true,
  ws: true,
  onError: (err, req, res) => {
    console.error('Proxy error:', err.message);
    if (res && res.status) res.status(502).json({ error: 'Backend connection failed' });
  }
});
app.use('/api', apiProxy);

// Proxy Socket.IO to backend (HTTP polling + WebSocket upgrade)
const socketProxy = createProxyMiddleware({
  target: API_BASE_URL,
  changeOrigin: true,
  ws: true,
  onError: (err) => {
    console.error('Socket.IO proxy error:', err.message);
  }
});
app.use('/socket.io/', socketProxy);

// Short customer-facing survey link — same domain, no query string, no page name exposed
app.get('/s/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'survey.html'));
});

// Serve static files.
// Assets are referenced by a fixed path (/soulia-logo.svg keeps its name when its contents
// change), so without an explicit header the browser applies heuristic caching and keeps
// serving the old file for weeks after a replacement ships. Mirrors the `no-cache` rule in
// nginx.conf — keep the two in agreement, or dev and production disagree about staleness.
// "no-cache" still caches; it just forces revalidation, so an unchanged asset costs a 304.
const REVALIDATE_ASSET = /\.(svg|png|jpg|jpeg|gif|ico|webp|woff2?|ttf|eot)$/i;
app.get(/\.(js|css|svg)$/i, publicFiles.asset);
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (REVALIDATE_ASSET.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// SPA fallback
app.get('*', publicFiles.shell);

// Create HTTP server explicitly so we can attach WebSocket upgrade handler
const server = http.createServer(app);

// Forward WebSocket upgrades (for Socket.IO) to backend
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/socket.io/')) {
    socketProxy.upgrade(req, socket, head);
  } else if (req.url && req.url.startsWith('/api/')) {
    apiProxy.upgrade(req, socket, head);
  }
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔗 Proxy: /api -> ${API_BASE_URL}`);
  console.log(`🔗 Socket.IO proxy: /socket.io -> ${API_BASE_URL}`);
});
