// Isolated fake-data visual regression; requires Playwright and Chrome.
// Set PLAYWRIGHT_MODULE to an existing Playwright module path if not installed locally.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createPreviewServer } = require('./preview-account-tools');
(async () => {
  const server = createPreviewServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { if(!localStorage.getItem('codex-navo-app-locale'))localStorage.setItem('codex-navo-app-locale','zh-CN'); });
    await page.route('**/api/codex-launch-options', route => route.fulfill({ contentType:'application/json', body:JSON.stringify({ok:true,data:{languages:[{id:'zh-CN',label:'简体中文'},{id:'en-US',label:'English'}],defaultLanguage:'zh-CN',projects:Array.from({length:28},(_,i)=>({id:`p${i}`,label:`项目 ${i+1} · Preview workspace`,roots:[`C:/Example/project-${i}`],threads:Array.from({length:3},(_,j)=>({id:`t${i}-${j}`,title:`任务 ${j+1} · Example conversation`,cwd:`C:/Example/project-${i}`,sizeBytes:102400}))})),threadCount:84,oversizedThreadCount:0}}) }));
    await page.goto(`http://127.0.0.1:${server.address().port}/?fixture=network-mixed`); await page.locator('.account-card').first().waitFor();
    await page.locator('[data-sidebar-section="language"]').click();
    await page.locator('#app-theme-trigger').click();
    await page.locator('#app-theme-menu [data-settings-value="dark"]').click();
    await page.evaluate(() => { openCodexLaunchDialog(); }); await page.locator('.codex-launch-dialog').waitFor();
    const area=page.locator('.launch-dialog-content'), box=await page.locator('.launch-project-head').first().boundingBox();
    const before=await area.evaluate(e=>({top:e.scrollTop,height:e.clientHeight,total:e.scrollHeight}));
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,400);await page.waitForTimeout(250);
    const after=await area.evaluate(e=>e.scrollTop);
    if(after <= before.top) throw Error('Mouse wheel did not scroll project selection');
    console.log(JSON.stringify({wheelBefore:before,wheelAfter:after}));
    const out=path.resolve('.tmp/theme-ui');fs.mkdirSync(out,{recursive:true});
    await page.screenshot({path:path.join(out,'launch-before.png')});
    await page.locator('[data-launch-cancel]').click();
    const audit = async name => {
      await page.screenshot({path:path.join(out,`${name}.png`),fullPage:!(await page.locator('dialog[open]').count())});
      return page.evaluate(() => {
        const rgb = s => (s.match(/[\d.]+/g)||[]).map(Number);
        const lum = c => c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
        const visible = el => el.checkVisibility() && !el.closest('[hidden]');
        const result=[],seen=new Set();
        for(const el of document.querySelectorAll('body *')){
          if(!visible(el))continue;
          const style=getComputedStyle(el),rect=el.getBoundingClientRect(),bg=rgb(style.backgroundColor);
          const key=el.tagName+'.'+el.className;
          if(bg.length>=3 && (bg[3]??1)>.8 && lum(bg)>.5 && rect.width>40 && rect.height>12 && !seen.has(key+'bg')) {result.push({type:'light-bg',element:key,bg:style.backgroundColor});seen.add(key+'bg');}
          if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()) || el.closest('button:disabled,input:disabled,select:disabled,textarea:disabled'))continue;
          let ancestor=el,background;
          while(ancestor){const b=rgb(getComputedStyle(ancestor).backgroundColor);if(b.length>=3&&(b[3]??1)>.9){background=b;break}ancestor=ancestor.parentElement;}
          if(!background)background=[10,17,27];
          const c=rgb(style.color),a=lum(c),b=lum(background),contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
          if(contrast<4.5&&!seen.has(key+style.color)){result.push({type:'contrast',element:key,text:el.textContent.trim().slice(0,48),color:style.color,ratio:+contrast.toFixed(2)});seen.add(key+style.color);}
        }
        return result;
      });
    };
    const reports={};
    for(const section of ['accounts','network','authorization','sessions','notifications','reverse-proxy','wake','language']){
      await page.locator(`[data-sidebar-section="${section}"]`).click();await page.waitForTimeout(180);
      reports[section]=await audit(section);
    }
    await page.locator('[data-sidebar-section="accounts"]').click();
    await page.locator('#add-account').click();reports.add=await audit('add-account');await page.keyboard.press('Escape');
    await page.locator('#navo-model-tools').click();reports.models=await audit('models');await page.keyboard.press('Escape');
    await page.locator('[data-tool="reset-credits"]').last().click();await page.waitForTimeout(200);reports.credits=await audit('credits');await page.keyboard.press('Escape');
    await page.evaluate(()=>{editApiKey();});await page.locator('.api-editor-dialog[open]').waitFor();reports.apiEditor=await audit('api-editor');await page.keyboard.press('Escape');
    await page.evaluate(()=>{openApiSecretDialog('navo_FAKE_PREVIEW_ONLY_DELETED');});reports.secret=await audit('secret');await page.keyboard.press('Escape');
    await page.evaluate(()=>{openAccountNetwork(state.accounts.at(-1));});reports.accountNetwork=await audit('account-network');await page.keyboard.press('Escape');
    await page.locator('[data-view="grid"]').click();await page.setViewportSize({width:1000,height:700});reports.grid=await audit('grid-narrow');
    await page.locator('[data-sidebar-section="language"]').click();
    const choose=async(value)=>{await page.locator('#app-theme-trigger').click();await page.locator(`#app-theme-menu [data-settings-value="${value}"]`).click();};
    const theme=()=>page.evaluate(()=>document.documentElement.dataset.theme);
    await page.emulateMedia({colorScheme:'light'});await choose('system');if(await theme()!=='light')throw Error('System light failed');
    await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(100);if(await theme()!=='dark')throw Error('Live system dark failed');
    await choose('light');await page.emulateMedia({colorScheme:'dark'});if(await theme()!=='light')throw Error('Explicit light failed');
    await choose('dark');await page.reload();await page.locator('.account-card').first().waitFor();if(await theme()!=='dark')throw Error('Persist dark failed');
    await page.evaluate(()=>localStorage.setItem('codex-navo-app-locale','en-US'));await page.reload();await page.locator('.account-card').first().waitFor();
    await page.locator('[data-sidebar-section="language"]').click();reports.english=await audit('english');
    if(!/Dark mode/.test(await page.locator('#app-theme-trigger').innerText()))throw Error('English theme label failed');
    fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify(reports,null,2));
    console.log(JSON.stringify(reports));
    console.log(JSON.stringify({errors}));
    if(errors.length || Object.values(reports).some(items=>items.length)) throw Error('Visual regression found page errors or unadapted theme elements; inspect .tmp/theme-ui');
  } finally { await browser.close();await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
