const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');

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
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

// Serve runtime config to the frontend
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.__ENV__ = { API_BASE_URL: "${API_BASE_URL}" };`);
});

// Proxy /api requests to backend
app.use('/api/', createProxyMiddleware({
  target: API_BASE_URL,
  changeOrigin: true,
  ws: true,
  onError: (err, req, res) => {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Backend connection failed' });
  }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔗 Proxy: /api -> ${API_BASE_URL}`);
});
