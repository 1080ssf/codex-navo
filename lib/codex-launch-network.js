const { setTomlSectionValue } = require('./codex-launch-view');
const PROXY_KEYS = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy','NODE_USE_ENV_PROXY'];

function splitInlineTable(value) {
  const entries=[];let start=0,quote='',escape=false,depth=0;
  for(let index=0;index<value.length;index++) {
    const char=value[index];
    if(quote) {
      if(escape)escape=false;
      else if(quote==='"' && char==='\\')escape=true;
      else if(char===quote)quote='';
    } else if(char==='"'||char==="'")quote=char;
    else if(char==='{'||char==='[')depth++;
    else if(char==='}'||char===']')depth--;
    else if(char===',' && depth===0){entries.push(value.slice(start,index).trim());start=index+1;}
  }
  if(quote||depth!==0)throw new Error('无法安全更新临时任务代理配置');
  entries.push(value.slice(start).trim());return entries.filter(Boolean);
}

function withTaskProxy(source, environment) {
  const lines=String(source||'').split(/\r?\n/);let section='';
  for(let index=0;index<lines.length;index++) {
    const header=lines[index].trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if(header)section=header[1].trim();
    if(section==='shell_environment_policy' && /^\s*set\s*=/.test(lines[index])) {
      const inline=lines[index].match(/^\s*set\s*=\s*\{(.*)\}\s*(?:#.*)?$/);
      if(!inline)throw new Error('无法安全更新临时任务代理配置');
      const entries=splitInlineTable(inline[1]).filter(entry=>!PROXY_KEYS.includes(entry.split('=')[0].trim().replace(/^['"]|['"]$/g,'')));
      for(const key of PROXY_KEYS)entries.push(`${key} = ${JSON.stringify(String(environment[key]||''))}`);
      lines[index]=`set = { ${entries.join(', ')} }`;return lines.join('\n');
    }
  }
  let result=source;
  for(const key of PROXY_KEYS)result=setTomlSectionValue(result,'shell_environment_policy.set',key,JSON.stringify(String(environment[key]||'')));
  return result;
}

function removeTaskProxy(source) {
  let section='';return String(source||'').split(/\r?\n/).filter(line=>{
    const header=line.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/);if(header)section=header[1].trim();
    return section!=='shell_environment_policy.set'||!PROXY_KEYS.includes(line.split('=')[0].trim());
  }).join('\n');
}

module.exports={withTaskProxy,removeTaskProxy};
