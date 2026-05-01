const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');
const http = require('http');

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

// Serve runtime config to the frontend
// Browser uses relative /api paths so requests go through this proxy — never expose the internal backend URL
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.__ENV__ = { API_BASE_URL: "" };`);
});

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
app.use('/api/', apiProxy);

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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
