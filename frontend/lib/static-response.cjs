const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

// Cache public files only. Every request checks the file version before reuse.
function createStaticResponder(publicDirectory) {
  const root = path.resolve(publicDirectory);
  const entries = new Map();
  let bytes = 0;
  const limit = 48 * 1024 * 1024;

  function trim() {
    for (const [file, entry] of entries) {
      if (bytes <= limit && entries.size <= 128) break;
      entries.delete(file);
      bytes -= entry.bytes;
    }
  }

  async function send(req, res, next, filename) {
    try {
      const file = path.resolve(root, filename);
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return next();
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return next();
      const stamp = `${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}`;
      res.type(path.extname(file));
      res.set('Cache-Control', 'public, no-cache, must-revalidate');
      res.set('ETag', `W/"${stamp}"`);
      res.set('Last-Modified', stat.mtime.toUTCString());
      res.vary('Accept-Encoding');
      // HEAD probes and unchanged reloads must not read/compress the application.
      if (req.fresh) return res.status(304).end();
      if (req.method === 'HEAD') return res.end();
      const encoding = req.acceptsEncodings('br', 'gzip', 'identity');
      if (!encoding) return res.status(406).end();
      let entry = entries.get(file);
      if (!entry || entry.stamp !== stamp) {
        if (entry) bytes -= entry.bytes;
        entry = { stamp, bytes: 0, variants: new Map() };
        entries.set(file, entry);
      }
      if (!entry.variants.has(encoding)) {
        if (!entry.variants.has('identity')) {
          entry.variants.set('identity', fs.readFile(file).then(buffer => {
            if (entries.get(file) === entry) { entry.bytes += buffer.length; bytes += buffer.length; trim(); }
            return buffer;
          }));
        }
        if (encoding !== 'identity') entry.variants.set(encoding, entry.variants.get('identity').then(async raw => {
          const buffer = encoding === 'br'
            ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
            : await gzip(raw, { level: 6 });
          if (entries.get(file) === entry) { entry.bytes += buffer.length; bytes += buffer.length; trim(); }
          return buffer;
        }));
      }
      const body = await entry.variants.get(encoding);
      if (encoding !== 'identity') res.set('Content-Encoding', encoding);
      res.set('Content-Length', String(body.length));
      res.end(body);
    } catch (error) {
      // A failed read must be retryable; never retain a rejected promise.
      const file = path.resolve(root, filename);
      const entry = entries.get(file);
      if (entry) { bytes -= entry.bytes; entries.delete(file); }
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return next();
      next(error);
    }
  }

  return {
    shell: (req, res, next) => send(req, res, next, 'index.html'),
    asset: (req, res, next) => {
      let filename;
      try { filename = decodeURIComponent(req.path).replace(/^\/+/, ''); }
      catch (_) { return res.status(400).end(); }
      return send(req, res, next, filename);
    },
  };
}

module.exports = { createStaticResponder };
