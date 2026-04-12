const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Proxy /api requests to backend FIRST
app.use('/api/', createProxyMiddleware({
  target: 'https://api.soulia.com',
  changeOrigin: true,
  pathRewrite: {
    '^/api': '/api'
  },
  ws: true,
  logLevel: 'debug',
  onError: (err, req, res) => {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Backend connection failed' });
  }
}));

// Then serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Finally fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔗 Proxy: /api -> https://api.soulia.com`);
});
