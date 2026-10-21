const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('../frontend/node_modules/express');
const { createStaticResponder } = require('../frontend/lib/static-response.cjs');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soulia-static-test-'));
  const original = '<!doctype html><title>Preview</title>' + 'public application markup '.repeat(3000);
  await fs.writeFile(path.join(directory,'index.html'), original);
  await fs.writeFile(path.join(directory,'sample.js'), 'window.sample=true;'.repeat(3000));
  const app = express();
  const files = createStaticResponder(directory);
  app.get('/', files.shell);
  app.get(/\.js$/, files.asset);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const request = (url='/', headers={}, method='GET') => new Promise((resolve,reject) => {
    const req = http.request({host:'127.0.0.1',port:server.address().port,path:url,headers,method},res => {
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject); req.end();
  });
  try {
    for (const encoding of ['identity','gzip','br']) {
      const response = await request('/', {'Accept-Encoding':encoding});
      assert.equal(response.status,200);
      const decoded = encoding==='br' ? zlib.brotliDecompressSync(response.body) : encoding==='gzip' ? zlib.gunzipSync(response.body) : response.body;
      assert.equal(decoded.toString(),original);
      assert.match(response.headers['cache-control'],/no-cache.*must-revalidate/);
      const reused = await request('/',{'Accept-Encoding':encoding,'If-None-Match':response.headers.etag});
      assert.equal(reused.status,304); assert.equal(reused.body.length,0);
    }
    const identity = await request('/');
    const gzipResponse = await request('/',{'Accept-Encoding':'gzip'});
    assert(gzipResponse.body.length<identity.body.length/10);
    const head = await request('/',{'Accept-Encoding':'gzip'},'HEAD');
    assert.equal(head.status,200);assert.equal(head.body.length,0);
    const negotiated = await request('/',{'Accept-Encoding':'gzip;q=0, br;q=0, identity;q=1'});
    assert.equal(negotiated.headers['content-encoding'],undefined);
    const denied = await request('/',{'Accept-Encoding':'gzip;q=0, br;q=0, identity;q=0'});
    assert.equal(denied.status,406);
    const javascript = await request('/sample.js',{'Accept-Encoding':'gzip'});
    assert.equal(javascript.headers['content-encoding'],'gzip');
    const shared = await Promise.all(Array.from({length:12},()=>request('/sample.js',{'Accept-Encoding':'br'})));
    assert(shared.every(response=>response.status===200 && zlib.brotliDecompressSync(response.body).toString()==='window.sample=true;'.repeat(3000)));
    await fs.writeFile(path.join(directory,'index.html'),original+'new release');
    const changed = await request('/',{'If-None-Match':identity.headers.etag});
    assert.equal(changed.status,200);assert.notEqual(changed.headers.etag,identity.headers.etag);
    assert.equal(changed.body.toString(),original+'new release');
    assert.equal((await request('/missing.js')).status,404);
    assert.equal((await request('/..%2fprivate.js')).status,404);
    console.log('PASS: lossless gzip/Brotli, 304 reuse, new-release invalidation, concurrent reads, HEAD, quality negotiation and path protection.');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test directory');
    await fs.rm(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
