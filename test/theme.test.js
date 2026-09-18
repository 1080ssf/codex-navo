const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const early=fs.readFileSync(path.join(__dirname,'../public/theme-init.js'),'utf8');
for(const [saved,system,expected] of [['dark',false,'dark'],['light',true,'light'],['system',true,'dark'],['system',false,'light'],['bad',true,'light'],[null,true,'light']]){
  test(`first-paint theme: ${saved}, system dark=${system}`,()=>{
    const dataset={};
    vm.runInNewContext(early,{document:{documentElement:{dataset}},localStorage:{getItem:()=>saved},window:{matchMedia:()=>({matches:system})}});
    assert.equal(dataset.theme,expected);
  });
}
test('blocked localStorage still renders a usable light default',()=>{
  const dataset={};vm.runInNewContext(early,{document:{documentElement:{dataset}},localStorage:{getItem(){throw new Error('denied');}}});
  assert.equal(dataset.theme,'light');
});
