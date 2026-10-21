const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('frontend/public/index.html','utf8');
const start = source.indexOf('const _apiPendingReads = new Map();');
const end = source.indexOf('async function _apiRequest(',start);
const wait = () => new Promise(resolve=>setTimeout(resolve,5));

(async () => {
  let token='first',calls=0,version=1,fail=false;
  const context = vm.createContext({Headers,structuredClone,localStorage:{getItem:()=>token},_apiRequest:async (_path,options={})=>{
    calls++; const readVersion=version; await wait();
    if (fail) throw new Error('preview failure');
    if (options.method==='POST') version++;
    return [{version:readVersion,nested:{value:1}}];
  }});
  vm.runInContext(source.slice(start,end),context);
  const api = context.api;
  const [first,second] = await Promise.all([api('/preview'),api('/preview')]);
  assert.equal(calls,1);
  first[0].nested.value=42;
  assert.equal(second[0].nested.value,1,'Consumers must not mutate one another');
  await api('/preview');assert.equal(calls,2,'Completed results must not be cached');
  const pending = api('/preview');
  const write = api('/preview',{method:'POST'});
  const afterWriteStarted = api('/preview');
  await Promise.all([pending,write,afterWriteStarted]);
  assert.equal(calls,5,'Reads on either side of a write must remain separate');
  const fresh=await api('/preview');assert.equal(fresh[0].version,2);
  const beforeTokenChange=api('/preview');token='second';
  await Promise.all([beforeTokenChange,api('/preview')]);assert.equal(calls,8);
  await Promise.all([api('/preview',{headers:{'X-Scope':'one'}}),api('/preview',{headers:{'X-Scope':'two'}})]);
  assert.equal(calls,10);
  const controller = new AbortController();
  await Promise.all([api('/preview',{signal:controller.signal}),api('/preview',{signal:controller.signal})]);
  assert.equal(calls,12,'Caller-controlled requests remain independent');
  fail=true;
  const rejected=await Promise.allSettled([api('/failure'),api('/failure')]);
  assert(rejected.every(result=>result.status==='rejected'));assert.equal(calls,13);
  fail=false;await api('/failure');assert.equal(calls,14,'Failed reads must be retryable');

  const normalizeStart=source.indexOf('const _searchTextCache = new Map();');
  const normalizeEnd=source.indexOf('\n}',source.indexOf('function normalizeUiSearch',normalizeStart))+2;
  vm.runInContext(source.slice(normalizeStart,normalizeEnd),context);
  const expected=value=>String(value||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0610-\u061A]/g,'').replace(/[\u0622\u0623\u0625]/g,'\u0627').replace(/\u0649/g,'\u064A').replace(/\u0640/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  for (const value of ['أَحْمَد','  Chair  SKU-123  ','إيــصال','ＡＢＣ',null,0,'','قيمة'.repeat(200)]) {
    assert.equal(context.normalizeUiSearch(value),expected(value));
    assert.equal(context.normalizeUiSearch(value),expected(value));
  }
  for (let index=0;index<5000;index++) context.normalizeUiSearch('preview '+index);
  assert.equal(vm.runInContext('_searchTextCache.size',context),4096);
  console.log('PASS: concurrent reads share one request, independent results, no stale cache after writes, token/header isolation, failure retry, unchanged Arabic search and bounded memory.');
})().catch(error=>{console.error(error);process.exitCode=1;});
