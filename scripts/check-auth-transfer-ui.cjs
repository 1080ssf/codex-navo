// Isolated browser regression: synthetic accounts and intercepted exports only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createPreviewServer } = require('./preview-account-tools');

(async () => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const out = path.resolve('verification/auth-transfer-ui');
  fs.mkdirSync(out, { recursive: true });
  const reports = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Reject any request not addressed to our disposable fixture server.
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('codex-navo-app-locale', 'zh-CN'));
    await page.route('**/api/bootstrap', async route => {
      const json = await (await route.fetch()).json();
      json.data.accounts = json.data.accounts.map(a => ({ ...a, codexInitialized: true }));
      await route.fulfill({ json });
    });
    await page.goto(base);
    await page.locator('.account-card').first().waitFor();
    await page.locator('#add-account').click();
    assert.deepEqual(await page.locator('[name="loginMethod"]').evaluateAll(nodes => nodes.map(n => n.value)), ['official', 'package-import']);
    await page.locator('[name="loginMethod"][value="package-import"]').check();
    assert.ok(await page.locator('#account-import-panel').isVisible());
    await page.screenshot({ path: path.join(out, 'add-package-zh.png') });
    await page.keyboard.press('Escape');
    await page.locator('[data-sidebar-section="authorization"]').click();
    assert.equal(await page.locator('#import-auth-package').count(), 0);
    const checks = page.locator('#export-account input[type="checkbox"]');
    assert.equal(await checks.count(), 5);
    await checks.first().check();
    await page.locator('#export-account-search').fill('Temporary');
    assert.equal(await checks.count(), 1);
    await page.locator('#export-select-all').click();
    assert.match(await page.locator('#export-selection-count').innerText(), /2/);
    await page.locator('#export-account-search').fill('');
    assert.equal(await page.locator('#export-account input:checked').count(), 2);
    await checks.first().focus();
    await page.evaluate(() => refresh());
    assert.equal(await page.locator('#export-account input:checked').count(), 2);
    assert.equal(await page.evaluate(() => document.activeElement?.value), 'preview-long-0');
    let requests = 0, release;
    await page.route('**/api/accounts/export-auth', async route => {
      requests++;
      assert.equal(route.request().postDataJSON().accountIds.length, 2);
      await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: { ok: true, data: { fileName: 'preview-only.json', package: { fixture: true }, count: 2, format: 'cpa' } } });
    });
    await page.locator('#export-format').selectOption('cpa');
    await page.locator('#export-auth-package').click();
    await page.waitForFunction(() => state.exportingPackage);
    await page.evaluate(() => renderHealthCenter());
    assert.ok(await page.locator('#export-auth-package').isDisabled());
    // Wait for the intercepted request to arrive, without any upstream call.
    for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(requests, 1);
    release();
    await page.waitForFunction(() => !state.exportingPackage);
    await page.locator('#export-select-none').click();
    assert.ok(await page.locator('#export-auth-package').isDisabled());
    for (const locale of ['zh-CN', 'en-US']) {
      for (const theme of ['light', 'dark']) {
        for (const width of [1366, 900]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(({ locale, theme }) => {
            state.appLocale = locale; state.appTheme = theme;
            applyTheme(); renderHealthCenter(); if (locale === 'en-US') translateUi();
          }, { locale, theme });
          await page.locator('.package-center').scrollIntoViewIfNeeded();
          const overflow = await page.evaluate(() => [...document.querySelectorAll('.package-panel, .package-export-layout, .package-account-list, .package-account-row')]
            .filter(el => el.scrollWidth > el.clientWidth + 2).map(el => el.className));
          assert.deepEqual(overflow, []);
          const dimensions = await checks.first().evaluate(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }));
          assert.ok(dimensions.w <= 18 && dimensions.h <= 18);
          await page.locator('.package-center').screenshot({ path: path.join(out, `export-${locale}-${theme}-${width}.png`) });
          reports.push({ locale, theme, width, overflow, checkbox: dimensions });
        }
      }
    }
    for (const count of [1, 0]) {
      await page.evaluate(count => { state.accounts = state.accounts.slice(0, count); renderHealthCenter(); }, count);
      assert.equal(await checks.count(), count);
      await page.locator('.package-center').screenshot({ path: path.join(out, `export-${count}-accounts.png`) });
    }
    assert.ok(await page.locator('#export-select-all').isDisabled());
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ reports, errors, exportRequests: requests }, null, 2));
    console.log(JSON.stringify({ passed: true, variants: reports.length, errors, exportRequests: requests, screenshots: out }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
