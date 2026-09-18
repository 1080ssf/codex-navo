const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectNewestCli, parseCliVersion, discoverCliCandidates, createCliResolver, runHidden } = require('../lib/codex-cli-selection');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-cli-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = relative => { const filename = path.join(root, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, 'fixture'); return filename; };
  return { root, file };
}

test('CLI selection uses the newest working version rather than npm priority or file date', () => {
  const versions = { npm: [0, 144, 5], desktop: [0, 153, 4], old: [0, 99, 9] };
  assert.equal(selectNewestCli(['npm', 'desktop', 'old'], (file) => versions[file]), 'desktop');
  assert.equal(selectNewestCli(['desktop', 'npm'], (file) => file === 'npm' ? [1, 0, 0] : versions[file]), 'npm');
});

test('CLI selection skips broken binaries and reports when none work', () => {
  assert.equal(selectNewestCli(['broken', 'working'], (file) => {
    if (file === 'broken') throw new Error('blocked');
    return [0, 153, 4];
  }), 'working');
  assert.throws(() => selectNewestCli(['broken'], () => null), /No working stable/);
});

test('version parser accepts stderr and build metadata but identifies prereleases', () => {
  assert.equal(parseCliVersion('', 'codex-cli 0.153.4\r\n').stable, true);
  assert.equal(parseCliVersion('codex-cli 1.2.3+build.4').version, '1.2.3+build.4');
  assert.equal(parseCliVersion('codex-cli 1.2.3-alpha.7').stable, false);
  assert.equal(parseCliVersion('codex-cli 1.2.3oops'), null);
  assert.equal(parseCliVersion('unrelated 1.2.3'), null);
});

test('discovery covers custom npm prefix, both architectures, managed, PATH and desktop without executing shims', async t => {
  const { root, file } = fixture(t);
  const standalone = file('profile/.local/bin/codex.exe');
  const onPath = file('tools/codex.exe'); file('tools/codex.cmd');
  const npm = file('custom/node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/codex/codex.exe');
  const hoisted = file('custom/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const managed = file('local/OpenAI/Codex/bin/hash/codex.exe');
  const desktop = file('desktop/resources/codex.exe');
  const rows = await discoverCliCandidates({ environment: { PATH: path.join(root, 'tools'), USERPROFILE: path.join(root,'profile'), LOCALAPPDATA: path.join(root,'local'), NPM_CONFIG_PREFIX: path.join(root,'custom') }, desktopCandidates: async()=>[desktop] });
  assert.deepEqual(new Set(rows.map(row=>row.path)),new Set([standalone,onPath,npm,hoisted,managed,desktop]));
  assert.equal(rows.some(row=>row.path.endsWith('.cmd')),false);
});

test('resolver coalesces checks, bounds concurrency and chooses numeric newest stable version', async t => {
  const {file}=fixture(t); const paths=['old','broken','latest','preview'].map(name=>file(`${name}.exe`));
  let calls=0,active=0,maximum=0;
  const resolver=createCliResolver({discover:async()=>paths.map(file=>({path:file,source:'fixture'})),run:async(exe)=>{
    calls++;active++;maximum=Math.max(maximum,active); await new Promise(resolve=>setTimeout(resolve,5));active--;
    if(exe===paths[1]) return {code:'timeout',exitCode:null};
    return {exitCode:0,stdout:`codex-cli ${exe===paths[0]?'0.9.9':exe===paths[2]?'1.0.0':'9.0.0-alpha.1'}`};
  }});
  const results=await Promise.all([resolver.resolve(),resolver.resolve(),resolver.inspect()]);
  assert.equal(results[0],paths[2]);assert.equal(results[1],paths[2]);assert.equal(calls,4);assert.ok(maximum<=3);
  assert.equal(results[2].candidates[1].status,'timeout');assert.equal(results[2].candidates[3].status,'prerelease');
  await resolver.resolve(); assert.equal(calls,4);
});

test('failed candidates are cached and explicit paths use the same version validation', async t => {
  const {file}=fixture(t);const exe=file('cli.exe');let calls=0,time=1;
  const resolver=createCliResolver({now:()=>time,probeProtocol:async()=>({ok:false,code:'protocol_failed'}),discover:async()=>[{path:exe,source:'configured',explicit:true}],run:async()=>{calls++;return {exitCode:0,stdout:'codex-cli 1.2.3-alpha.1'};}});
  await assert.rejects(resolver.resolve({configured:exe}),/协议验证失败/);await assert.rejects(resolver.resolve({configured:exe}),/协议验证失败/);
  assert.equal(calls,1);time+=16000;await resolver.inspect({configured:exe});assert.equal(calls,2);
  await resolver.inspect({configured:exe,force:true});assert.equal(calls,3);
});

test('the reported alpha plus EPERM scenario recovers only after an isolated protocol handshake', async t => {
  const {file}=fixture(t); const alpha=file('alpha.exe'), desktop=file('desktop.exe'); let probes=0;
  const resolver=createCliResolver({ discover:async()=>[{path:alpha,source:'managed'},{path:desktop,source:'desktop'}],
    run:async file=>file===alpha?{exitCode:0,stdout:'codex-cli 0.154.0-alpha.6.2'}:{code:'EPERM',exitCode:null},
    probeProtocol:async file=>{assert.equal(file,alpha);probes++;return {ok:true,durationMs:15};} });
  assert.equal(await resolver.resolve(),alpha);
  assert.equal(resolver.snapshot().selected.protocolVerified,true);
  assert.equal(resolver.snapshot().selected.stable,false);
  assert.equal(resolver.snapshot().candidates[1].processErrorCode,'EPERM');
  await resolver.resolve();assert.equal(probes,1);
  assert.equal(await resolver.resolve({configured:alpha}),alpha);
  assert.equal(resolver.snapshot().selected.source,'configured');
  assert.equal(resolver.snapshot().selected.explicit,true);
});

test('Navo-managed stable installs are discovered but incomplete staging directories are ignored', async t => {
  const {root,file}=fixture(t);
  const stable=file('runtime/stable-1.2.3-id/codex.exe');file('runtime/.install-incomplete/codex.exe');
  file('runtime/stable-1.2.3-id/ready.json');file('runtime/stable-2.0.0-unverified/codex.exe');
  const rows=await discoverCliCandidates({managedRoot:path.join(root,'runtime'),environment:{},desktopCandidates:async()=>[]});
  assert.deepEqual(rows.map(row=>row.path),[stable]);assert.equal(rows[0].source,'navo');
});

test('a stable candidate takes priority over a previously handshake-verified preview', async t => {
  const {file}=fixture(t);const alpha=file('alpha.exe'),stable=file('stable.exe');let foundStable=false,time=0,probes=0;
  const resolver=createCliResolver({now:()=>time,discover:async()=>[alpha,...foundStable?[stable]:[]].map(path=>({path,source:'fixture'})),
    run:async file=>({exitCode:0,stdout:`codex-cli ${file===alpha?'9.0.0-alpha.1':'1.2.3'}`}),
    probeProtocol:async()=>{probes++;return {ok:true};} });
  assert.equal(await resolver.resolve(),alpha);foundStable=true;time=31000;
  assert.equal(await resolver.resolve(),stable);assert.equal(probes,1);
});

test('version probing is nonblocking, time bounded and reports process errors without raw output', async () => {
  const start=Date.now();let ticked=false;const timer=setTimeout(()=>{ticked=true;},10);
  const result=await runHidden(process.execPath,['-e','setTimeout(()=>{},10000)'],100);
  clearTimeout(timer);assert.equal(result.code,'timeout');assert.equal(ticked,true);assert.ok(Date.now()-start<3000);
  const missing=await runHidden(path.join(os.tmpdir(),'nonexistent-navocli.exe'),['--version'],100);
  assert.equal(missing.exitCode,null);assert.ok(missing.code);
});

test('a stalled discovery reaches a terminal diagnostic without late probes', async () => {
  let finish, calls=0;
  const resolver=createCliResolver({totalTimeoutMs:40,discover:()=>new Promise(resolve=>{finish=resolve;}),run:async()=>{calls++;}});
  const result=await resolver.inspect();
  assert.equal(result.status,'unavailable');assert.equal(result.discoveryStatus,'timeout');
  finish([]);await Promise.resolve();assert.equal(calls,0);
});

test('updating a CLI in place invalidates the successful selection snapshot', async t => {
  const {file}=fixture(t);const exe=file('cli.exe');let calls=0;
  const resolver=createCliResolver({discover:async()=>[{path:exe,source:'fixture'}],run:async()=>({exitCode:0,stdout:`codex-cli 1.2.${++calls}`})});
  await resolver.resolve();fs.appendFileSync(exe,'new version bytes');await resolver.resolve();
  assert.equal(calls,2);assert.equal(resolver.snapshot().selected.version,'1.2.2');
});

test('concurrent checks with different explicit settings never return another configured CLI', async t => {
  const {file}=fixture(t);const a=file('a.exe'),b=file('b.exe');
  const resolver=createCliResolver({discover:async options=>[{path:options.configured,source:'configured',explicit:true}],run:async()=>{await new Promise(resolve=>setTimeout(resolve,5));return {exitCode:0,stdout:'codex-cli 1.2.3'};}});
  const result=await Promise.all([resolver.resolve({configured:a}),resolver.resolve({configured:b})]);
  assert.deepEqual(result,[a,b]);
});

test('configured discovery does not touch unrelated PATH, npm or desktop locations', async t => {
  const { file, root } = fixture(t);
  const exe = file('configured.exe');
  let statCalls = 0, desktopCalls = 0;
  t.mock.method(fs.promises, 'stat', async () => { statCalls++; return new Promise(() => {}); });
  const rows = await discoverCliCandidates({ configured: exe,
    environment: { PATH: path.join(root, 'unused-path'), NPM_CONFIG_PREFIX: path.join(root, 'unused-prefix') },
    desktopCandidates: async () => { desktopCalls++; return new Promise(() => {}); } });
  assert.deepEqual(rows, [{ path: exe, source: 'configured', explicit: true }]);
  assert.equal(statCalls, 0);
  assert.equal(desktopCalls, 0);
});

test('an explicit resolver bypasses unrelated discovery and still checks the file and stable version', async t => {
  const { file } = fixture(t);
  const exe = file('configured.exe');
  let discoveryCalls = 0, statCalls = 0, probes = 0;
  const resolver = createCliResolver({ totalTimeoutMs: 300,
    discover: () => { discoveryCalls++; return new Promise(() => {}); },
    stat: async target => { statCalls++; assert.equal(target, exe); return fs.promises.stat(target); },
    run: async target => { probes++; assert.equal(target, exe); return { exitCode: 0, stdout: 'codex-cli 1.2.3' }; } });
  assert.equal(await resolver.resolve({ configured: exe }), exe);
  assert.equal(discoveryCalls, 0);
  assert.equal(statCalls, 2, 'candidate validation plus selected-file recheck');
  assert.equal(probes, 1);
});

test('stalled candidate stat has a distinct bounded diagnostic and cannot start a late probe', async t => {
  const { file } = fixture(t);
  const stalled = file('stalled.exe'), working = file('working.exe');
  let finish, probes = [];
  const resolver = createCliResolver({ statTimeoutMs: 20, totalTimeoutMs: 500,
    discover: async () => [stalled, working].map(filename => ({ path: filename, source: 'fixture' })),
    stat: target => target === stalled ? new Promise(resolve => { finish = resolve; }) : fs.promises.stat(target),
    run: async target => { probes.push(target); return { exitCode: 0, stdout: 'codex-cli 1.2.3' }; } });
  const result = await resolver.inspect();
  assert.equal(result.selected.path, working);
  assert.equal(result.candidates[0].status, 'stat_timeout');
  assert.deepEqual(probes, [working]);
  finish(await fs.promises.stat(stalled));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(probes, [working]);
  assert.equal(resolver.snapshot(), result);
});

test('candidate file reads stop starting after the overall inspection budget is exhausted', async t => {
  const { file } = fixture(t);
  const paths = Array.from({ length: 8 }, (_, index) => file(`candidate-${index}.exe`));
  let statCalls = 0, probes = 0;
  const started = Date.now();
  const resolver = createCliResolver({ statTimeoutMs: 30, totalTimeoutMs: 45,
    discover: async () => paths.map(filename => ({ path: filename, source: 'fixture' })),
    stat: () => { statCalls++; return new Promise(() => {}); }, run: async () => { probes++; } });
  const result = await resolver.inspect();
  assert.equal(result.status, 'unavailable');
  assert.ok(result.candidates.some(row => row.status === 'stat_timeout'));
  assert.ok(result.candidates.some(row => row.status === 'budget_exhausted'));
  assert.ok(statCalls <= 6, 'no further file reads after two batches consume the total budget');
  assert.equal(probes, 0);
  assert.ok(Date.now() - started < 1500, 'a stalled filesystem must not leave inspection pending');
});

test('a cached selection whose stat stalls fails promptly and can recover on a forced check', async t => {
  const { file } = fixture(t);
  const exe = file('cached.exe');
  let blocked = false, finish, probes = 0;
  const resolver = createCliResolver({ statTimeoutMs: 20, totalTimeoutMs: 500,
    discover: async () => [{ path: exe, source: 'fixture' }],
    stat: target => blocked ? new Promise(resolve => { finish = resolve; }) : fs.promises.stat(target),
    run: async () => { probes++; return { exitCode: 0, stdout: 'codex-cli 1.2.3' }; } });
  assert.equal((await resolver.inspect()).status, 'ready');
  blocked = true;
  await assert.rejects(resolver.resolve(), error => {
    assert.equal(error.code, 'CODEX_CLI_UNAVAILABLE');
    assert.match(error.message, /文件状态读取超时/);
    assert.equal(error.diagnostics.candidates[0].status, 'stat_timeout');
    return true;
  });
  assert.equal(probes, 1, 'a timed-out selected-file recheck does not retry or start generation');
  finish(await fs.promises.stat(exe));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolver.snapshot().selected, null);
  blocked = false;
  assert.equal(await resolver.resolve({ force: true }), exe);
  assert.equal(probes, 2);
});

test('a timed-out recheck cannot overwrite diagnostics for a newer configured path', async t => {
  const { file } = fixture(t);
  const a = file('configured-a.exe'), b = file('configured-b.exe');
  let aCalls = 0, enterRecheck;
  const entered = new Promise(resolve => { enterRecheck = resolve; });
  const resolver = createCliResolver({ statTimeoutMs: 80, totalTimeoutMs: 1000,
    stat: target => {
      if (target === a && ++aCalls === 2) { enterRecheck(); return new Promise(() => {}); }
      return fs.promises.stat(target);
    }, run: async () => ({ exitCode: 0, stdout: 'codex-cli 1.2.3' }) });
  const failedA = assert.rejects(resolver.resolve({ configured: a }), error => error.diagnostics.candidates[0].status === 'stat_timeout');
  await entered;
  assert.equal(await resolver.resolve({ configured: b }), b);
  await failedA;
  assert.equal(resolver.snapshot().status, 'ready');
  assert.equal(resolver.snapshot().selected.path, b);
});

test('a stalled PATH entry does not discard another valid automatically discovered CLI', async t => {
  const { root, file } = fixture(t);
  const bad = path.join(root, 'stalled-path');
  const good = file('working-path/codex.exe');
  const probes = [];
  const resolver = createCliResolver({ discoveryTimeoutMs: 200, sourceTimeoutMs: 80, statTimeoutMs: 40, totalTimeoutMs: 1000,
    discover: options => discoverCliCandidates({ ...options,
      environment: { PATH: [bad, path.dirname(good)].join(path.delimiter) }, desktopCandidates: async () => [] }),
    stat: target => target.startsWith(bad + path.sep) ? new Promise(() => {}) : fs.promises.stat(target),
    run: async target => { probes.push(target); return { exitCode: 0, stdout: 'codex-cli 1.2.3' }; } });
  const result = await resolver.inspect();
  assert.equal(result.status, 'ready');
  assert.equal(result.selected.path, good);
  assert.equal(result.selected.source, 'path');
  assert.ok(result.discoveryIssues.some(issue => issue.source === 'path' && issue.status === 'stat_timeout'));
  assert.deepEqual(probes, [good]);
});

test('a stalled desktop package query does not discard an available PATH CLI', async t => {
  const { file } = fixture(t);
  const good = file('tools/codex.exe');
  const resolver = createCliResolver({ discoveryTimeoutMs: 250, sourceTimeoutMs: 50, statTimeoutMs: 40, totalTimeoutMs: 1000,
    discover: options => discoverCliCandidates({ ...options, environment: { PATH: path.dirname(good) },
      desktopCandidates: () => new Promise(() => {}) }),
    run: async () => ({ exitCode: 0, stdout: 'codex-cli 1.2.3' }) });
  const result = await resolver.inspect();
  assert.equal(result.selected.path, good);
  assert.ok(result.discoveryIssues.some(issue => issue.source === 'desktop' && issue.status === 'timeout'));
});

test('a found managed executable survives a stalled directory enumeration in its own source', async t => {
  const { root, file } = fixture(t);
  const good = file('local/OpenAI/Codex/bin/codex.exe');
  const published = [], issues = [];
  const rows = await discoverCliCandidates({ environment: { LOCALAPPDATA: path.join(root, 'local') },
    timeoutMs: 200, sourceTimeoutMs: 100, fileTimeoutMs: 30, desktopCandidates: async () => [],
    readdir: () => new Promise(() => {}), onCandidate: row => published.push(row.path), onIssue: issue => issues.push(issue) });
  assert.deepEqual(rows.map(row => row.path), [good]);
  assert.deepEqual(published, [good]);
  assert.ok(issues.some(issue => issue.source === 'managed' && issue.status === 'stat_timeout'));
});

test('a slow npm source has its own deadline instead of multiplying every file timeout', async t => {
  const { root } = fixture(t);
  const prefix = path.join(root, 'npm');
  const base = path.join(prefix, 'node_modules', '@openai');
  const good = path.join(root, 'profile', '.local', 'bin', 'codex.exe');
  let npmReads = 0;
  const issues = [];
  const rows = await discoverCliCandidates({ environment: { NPM_CONFIG_PREFIX: prefix, USERPROFILE: path.join(root, 'profile') },
    timeoutMs: 200, sourceTimeoutMs: 45, fileTimeoutMs: 30, desktopCandidates: async () => [],
    stat: async target => {
      if (target === base) return { isDirectory: () => true };
      if (target === good) return { isFile: () => true };
      npmReads++;
      return new Promise(() => {});
    }, onIssue: issue => issues.push(issue) });
  assert.deepEqual(rows.map(row => row.path), [good]);
  assert.ok(npmReads <= 2, 'the 45ms source deadline must stop the remaining npm layout probes');
  assert.ok(issues.some(issue => issue.source === 'npm' && issue.status === 'stat_timeout'));
});

test('partial discovery findings are validated after the discovery budget and late results are ignored', async t => {
  const { file } = fixture(t);
  const good = file('found.exe'), late = file('late.exe');
  let publish, finish;
  const probes = [];
  const resolver = createCliResolver({ discoveryTimeoutMs: 30, totalTimeoutMs: 400, timeoutMs: 100, statTimeoutMs: 50,
    discover: options => {
      publish = options.onCandidate;
      publish({ path: good, source: 'fixture' });
      return new Promise(resolve => { finish = resolve; });
    }, run: async (target, _args, remainingMs) => {
      assert.ok(remainingMs > 0, 'discovery must leave a version-probe budget');
      probes.push(target);
      return { exitCode: 0, stdout: 'codex-cli 1.2.3' };
    } });
  const result = await resolver.inspect();
  assert.equal(result.selected.path, good);
  assert.equal(result.discoveryStatus, 'timeout');
  publish({ path: late, source: 'late' });
  finish([{ path: late, source: 'late' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolver.snapshot(), result);
  assert.deepEqual(result.candidates.map(row => row.path), [good]);
  assert.deepEqual(probes, [good]);
});

test('source concurrency is capped while completion order cannot change source attribution', async t => {
  const { root } = fixture(t);
  const directories = [path.join(root, 'desktop', 'resources'), ...Array.from({ length: 10 }, (_, index) => path.join(root, `tools-${index}`))];
  let active = 0, maximum = 0;
  const rows = await discoverCliCandidates({ environment: { PATH: directories.join(path.delimiter) },
    desktopExecutable: path.join(root, 'desktop', 'Codex.exe'), desktopCandidates: async () => [],
    concurrency: 3, timeoutMs: 1000, sourceTimeoutMs: 100, fileTimeoutMs: 80,
    stat: async target => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, target.includes('tools-0') ? 15 : 2));
      active--;
      return { isFile: () => target.endsWith('codex.exe'), isDirectory: () => false };
    } });
  assert.ok(maximum <= 3);
  assert.ok(maximum > 1, 'independent sources should run in parallel');
  assert.deepEqual(rows.map(row => row.path), directories.map(directory => path.join(directory, 'codex.exe')));
  assert.ok(rows.every(row => row.source === 'path'), 'PATH keeps its original attribution even if desktop found the duplicate first');
});

test('the total discovery cutoff keeps a known local candidate even when many PATH reads remain stalled', async t => {
  const { root } = fixture(t);
  const good = path.join(root, 'local', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  const paths = Array.from({ length: 20 }, (_, index) => path.join(root, `stalled-${index}`));
  let reads = 0;
  const resolver = createCliResolver({ discoveryTimeoutMs: 40, sourceTimeoutMs: 500, statTimeoutMs: 300, totalTimeoutMs: 500,
    discover: options => discoverCliCandidates({ ...options, environment: { PATH: paths.join(path.delimiter), LOCALAPPDATA: path.join(root, 'local') },
      desktopCandidates: async () => [], readdir: async () => [] }),
    stat: async target => {
      reads++;
      if (target === good) return { isFile: () => true, size: 10, mtimeMs: 1 };
      return new Promise(() => {});
    }, run: async () => ({ exitCode: 0, stdout: 'codex-cli 1.2.3' }) });
  const result = await resolver.inspect();
  assert.equal(result.status, 'ready');
  assert.equal(result.selected.path, good);
  assert.equal(result.discoveryStatus, 'timeout');
  assert.ok(reads < paths.length, 'an exhausted discovery budget must not launch every queued PATH read');
});
