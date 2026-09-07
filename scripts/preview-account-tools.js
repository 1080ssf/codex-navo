// Isolated UI fixture: no production settings, credentials, upstream or writes.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'public');
const quota = { planType: 'plus', windows: [
  { label: '5 小时额度', windowDurationMins: 300, remainingPercent: 95, resetsAt: Date.now()/1000+10000 },
  { label: 'Weekly', windowDurationMins: 10080, remainingPercent: 24, resetsAt: Date.now()/1000+450000 },
], resetCredits: { availableCount: 2, credits: [{ id: 'fixture-credit', status: 'available', title: 'Codex reset', description: 'Local preview only', expiresAt: '2026-10-01T00:00:00Z' }] } };
const accounts = [
  ...Array.from({ length: 3 }, (_, i) => ({ id: `preview-long-${i}`, label: `long-account-name-for-layout-check-${i}@example.test`, quota, enabled: true })),
  { id: 'preview-regular', label: 'demo-account@example.test', quota, codexInitialized: true, enabled: true,
    planExpiresAt: '2026-09-20T00:00:00Z', network: { mode: 'proxy', label: '美国 VPS · 演示线路' } },
  { id: 'preview-temporary', label: 'Temporary preview', accountKind: 'relay', quota: { ...quota, planType: 'self_serve_business_prolite' },
    codexInitialized: true, enabled: true, planExpiryStatus: 'credential_unavailable', network: { mode: 'direct' } },
];
const usage = { totals: { inputTokens: 200000000, cachedInputTokens: 192000000, outputTokens: 600000, totalTokens: 200600000,
  requests: 1600, pricedRequests: 100, unpricedRequests: 1500, estimatedCostUsd: 12 }, accounts: {} };
const apiService = { keys: [{ id: 'preview-key', name: 'API preview', enabled: true, accountIds: accounts.map(a=>a.id),
  modelAllowlist: [], backingAccounts: accounts, quota: { remainingPercent: 59 }, network: { mode: 'direct' }, usage: {} }], providers: [], config: { enabled: true, port: 18300 } };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
  if (url.pathname === '/api/bootstrap') return json({ accounts, apiService, usage, operators: ['preview'], mockLaunch: true, appVersion: 'preview', networkSettings: { sources: [] } });
  if (url.pathname === '/api/usage') return json(usage);
  if (url.pathname === '/api/api-service') return json(apiService);
  if (url.pathname.endsWith('/reset-credits')) return json({ credits: quota.resetCredits, quota, operation: null });
  if (url.pathname.endsWith('/consume')) { res.statusCode = 403; return json({ error: 'Preview never redeems credits' }); }
  if (url.pathname === '/api/model-diagnostics/catalog') return json(accounts.map(account=>({targetId:account.id,models:[{id:'gpt-6-astra',accountId:account.id}]})));
  if (url.pathname.startsWith('/api/')) return json({});
  const file = path.resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.statusCode=404; return res.end(); }
  res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(0, '127.0.0.1', function () { console.log(`Preview http://127.0.0.1:${this.address().port}`); });
