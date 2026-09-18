const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { downloadInRanges, retryDownload, selectDownloadRoute } = require('../lib/update-download');

function fixture(t, override = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-ranges-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789');
  const requests = [];
  const source = async (_url, options) => {
    const [,a,b] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const start = Number(a), end = Number(b); requests.push([start,end]);
    await new Promise(resolve => setTimeout(resolve, 2));
    return new Response(data.subarray(start,end+1), {status:206,headers:{etag:'"v1"','content-range':`bytes ${start}-${end}/${data.length}`}});
  };
  return { root, data, requests, source, options: {url:'https://example.test/package',destination:path.join(root,'test.msix'),
    minSize:1,chunkSize:8,concurrency:3,fetch:source,wait:async()=>{},...override} };
}

test('parallel ranges produce exact package bytes and verified complete cache avoids network', async t => {
  const f=fixture(t);const progress=[];
  const result=await downloadInRanges({...f.options,onProgress:p=>progress.push(p)});
  assert.deepEqual(fs.readFileSync(result.path),f.data);
  assert.equal(result.sha256,crypto.createHash('sha256').update(f.data).digest('hex'));
  assert.equal(progress.at(-1).bytesDownloaded,f.data.length);
  assert.equal(fs.readdirSync(f.root).some(n=>n.includes('.part')),false);
  const calls=f.requests.length;await downloadInRanges(f.options);assert.equal(f.requests.length,calls);
});

test('range failure retries only that chunk and keeps the same If-Range identity', async t => {
  const f=fixture(t);let failures=0;
  const fetch=async(url,options)=>{
    if(options.headers.Range==='bytes=8-15' && !failures++){assert.equal(options.headers['If-Range'],'"v1"');throw new Error('ECONNRESET');}
    return f.source(url,options);
  };
  assert.deepEqual(fs.readFileSync((await downloadInRanges({...f.options,fetch})).path),f.data);
  assert.equal(failures,2);
});

test('completed parts survive cancellation and are hash-checked before resuming', async t => {
  const f=fixture(t);const controller=new AbortController();
  await assert.rejects(downloadInRanges({...f.options,concurrency:1,signal:controller.signal,fetch:async(url,options)=>{
    if(options.headers.Range==='bytes=8-15'){controller.abort(new Error('cancelled'));throw controller.signal.reason;}
    return f.source(url,options);
  }}),/cancelled/);
  assert.equal(fs.existsSync(f.options.destination),false);
  const part=fs.readdirSync(f.root).find(name=>name.endsWith('.0.part'));
  assert.ok(part, 'first completed chunk is persisted');
  fs.writeFileSync(path.join(f.root,part),'corrupt!');
  await downloadInRanges(f.options);
  assert.deepEqual(fs.readFileSync(f.options.destination),f.data);
  assert.equal(f.requests.filter(([start,end])=>start===0&&end===7).length,2,'corrupt cache must be downloaded again');
});

test('good completed chunks are reused after an interrupted transfer', async t => {
  const f=fixture(t);const controller=new AbortController();
  await assert.rejects(downloadInRanges({...f.options,concurrency:1,signal:controller.signal,fetch:async(url,options)=>{
    if(options.headers.Range==='bytes=8-15'){controller.abort(new Error('cancelled'));throw controller.signal.reason;}
    return f.source(url,options);
  }}),/cancelled/);
  await downloadInRanges(f.options);
  assert.equal(f.requests.filter(([start,end])=>start===0&&end===7).length,1);
});

test('a server ignoring Range falls back without buffering its full package', async t => {
  const f=fixture(t);let cancelled=false;
  const fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}));
  assert.equal(await downloadInRanges({...f.options,fetch}),null);assert.equal(cancelled,true);
  assert.equal(fs.existsSync(f.options.destination),false);
});

test('changed ETag, offsets, or size never assemble a mixed package', async t => {
  for(const change of ['etag','range','size']){
    const f=fixture(t);
    const fetch=async(url,options)=>{
      const r=await f.source(url,options);
      if(options.headers.Range!=='bytes=0-0'){
        if(change==='etag')r.headers.set('etag','"different"');
        if(change==='range')r.headers.set('content-range','bytes 1-8/36');
        if(change==='size')r.headers.set('content-range',r.headers.get('content-range').replace('/36','/37'));
      }
      return r;
    };
    assert.equal(await downloadInRanges({...f.options,fetch}),null);
    assert.equal(fs.existsSync(f.options.destination),false);
  }
});

test('transient failures are bounded and disk/auth/integrity errors are never retried', async()=>{
  let attempts=0;const retries=[];
  await assert.rejects(retryDownload(()=>{attempts++;throw new Error('ECONNRESET');},{wait:async()=>{},onRetry:n=>retries.push(n)}),/ECONNRESET/);
  assert.equal(attempts,3);assert.deepEqual(retries,[2,3]);
  for(const error of [Object.assign(new Error('HTTP 403'),{status:403}),new Error('ENOSPC'),new Error('checksum mismatch')]){
    let calls=0;await assert.rejects(retryDownload(()=>{calls++;throw error;}));assert.equal(calls,1);
  }
});

test('electron updater HTTP errors use statusCode or its download status message', () => {
  const { retryableDownload } = require('../lib/update-download');
  assert.equal(retryableDownload({statusCode:503}),true);
  assert.equal(retryableDownload(new Error('Cannot download package, status 502: Bad Gateway')),true);
  assert.equal(retryableDownload({statusCode:404}),false);
});

test('cancel interrupts retry backoff without another request', async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(retryDownload(()=>{calls++;throw new Error('ECONNRESET');},{signal:controller.signal,onRetry:()=>controller.abort(new Error('cancelled'))}),/cancelled/);
  assert.equal(calls,1);
});

test('route selection measures actual bytes, not just open sockets', async()=>{
  const slow=async()=>{await new Promise(r=>setTimeout(r,30));return new Response('abcd');};
  const fast=async()=>new Response('abcd');
  const best=await selectDownloadRoute([{id:'proxy',fetch:slow},{id:'direct',fetch:fast}],'https://example.test/package',{sampleBytes:4});
  assert.equal(best.id,'direct');
  assert.equal(await selectDownloadRoute([{id:'direct',fetch:async()=>new Response('',{status:403})}],'https://example.test/package'),null);
});
