const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{test}=require('node:test');
function environment(languages,saved){
 const listeners={},storage=new Map(saved?[['uniderp-language',saved]]:[]),root={lang:''};let mutations;
 const document={documentElement:root,querySelectorAll:()=>[],createTextNode:value=>({nodeType:3,textContent:value,isConnected:true,childNodes:[]})};
 const context=vm.createContext({document,MutationObserver:class{constructor(callback){mutations=callback;}observe(){}},navigator:{languages},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},window:{addEventListener:(event,callback)=>listeners[event]=callback},Intl,console});
 for(const path of ['locales/zh-CN.js','locales/en.js','i18n.js'])vm.runInContext(fs.readFileSync('internal/control/ui/'+path,'utf8'),context);
 return {context,root,storage,listeners,removed:node=>mutations?.([{removedNodes:[node]}]),run:code=>vm.runInContext(code,context)};
}
test('automatic language follows the first supported preference with English fallback',()=>{
 for(const [languages,expected]of [[['fr','zh-TW','en'],'zh-CN'],[['en-GB','zh-CN'],'en'],[['ja'],'en'],[[],'en']])assert.equal(environment(languages).root.lang,expected);
});
test('manual preference persists and automatic mode responds to languagechange',()=>{
 const env=environment(['en'],'zh-CN');assert.equal(env.root.lang,'zh-CN');env.run("setLanguage('en')");assert.equal(env.storage.get('uniderp-language'),'en');
 env.run("setLanguage('auto'); navigator.languages=['zh-HK']");env.listeners.languagechange();assert.equal(env.root.lang,'zh-CN');
 env.run("setLanguage('en'); navigator.languages=['zh-CN']");env.listeners.languagechange();assert.equal(env.root.lang,'en');
});
test('changing language updates text and attributes without replacing controls or running actions',()=>{
 const env=environment(['en']);env.run("const input={value:'unsaved secret',disabled:true,isConnected:true,attrs:{},setAttribute(k,v){this.attrs[k]=v;}}; const label={textContent:'',isConnected:true}; setText(label,msg('settings.saveConfiguration')); setLocalizedAttribute(input,'aria-label',msg('settings.saveConfiguration')); let calls=0; window.fetch=()=>calls++;");
 env.run("setLanguage('zh-CN')");assert.equal(env.run('label.textContent'),'保存配置');assert.equal(env.run("input.attrs['aria-label']"),'保存配置');assert.equal(env.run('input.value'),'unsaved secret');assert.equal(env.run('input.disabled'),true);assert.equal(env.run('calls'),0);
 env.run("setText(label,msg('busy.saving')); setLanguage('en')");assert.equal(env.run('label.textContent'),'Saving…');
});

test('removing form and preview subtrees releases bindings without changing language',()=>{
 const env=environment(['en']);
 env.run(`const retained={textContent:'',isConnected:true,childNodes:[],setAttribute(){}};setText(retained,msg('settings.saveConfiguration'));setLocalizedAttribute(retained,'title',msg('settings.saveConfiguration'));`);
 for(let i=0;i<100;i++){
  const subtree=env.run(`(()=>{const input={isConnected:false,value:'unsaved password',childNodes:[],setAttribute(){}};const label={nodeType:1,isConnected:false,childNodes:[input],prepend(node){this.childNodes.unshift(node);}};setText(label,msg('auth.password'));setLocalizedAttribute(input,'aria-label',msg('auth.password'));return {isConnected:false,childNodes:[label]};})()`);
  env.removed(subtree);
  assert.equal(env.run('textBindings.size'),1);assert.equal(env.run('attributeBindings.size'),1);
 }
 env.removed(env.run('({isConnected:false,childNodes:[retained]})'));
 assert.equal(env.run('textBindings.size'),1);assert.equal(env.run('attributeBindings.size'),1);
 env.run("setLanguage('zh-CN')");assert.equal(env.run('retained.textContent'),'保存配置');
 env.run('retained.isConnected=false');env.removed(env.run('retained'));
 assert.equal(env.run('textBindings.size'),0);assert.equal(env.run('attributeBindings.size'),0);
});

test('settling a removed form does not retain its password controls again',async()=>{
 const app=fs.readFileSync('internal/control/ui/app.js','utf8');
 for(const failure of [false,true]){
  const env=environment(['en']);
  env.run(`document.createElement=tag=>({nodeType:1,tagName:tag.toUpperCase(),isConnected:true,childNodes:[],handlers:{},prepend(node){node.parentNode=this;this.childNodes.unshift(node);},append(node){node.parentNode=this;this.childNodes.push(node);},addEventListener(event,handler){this.handlers[event]=handler;},querySelectorAll(){return [];},querySelector(){return null;},setAttribute(){},get elements(){return this.childNodes.filter(n=>['INPUT','BUTTON'].includes(n.tagName));}});`);
  env.run(app.slice(app.indexOf('function el('),app.indexOf('function page(')));
  env.run(app.slice(app.indexOf('function form('),app.indexOf('function table(')));
  env.context.removeForm=f=>{const pending=[f];while(pending.length){const node=pending.pop();node.isConnected=false;pending.push(...node.childNodes);}env.removed(f);};
  env.run(`let pageGeneration=0,finish;function notice(){}async function render(){removeForm(testForm);return true;}class FormData{}
   const parent=document.createElement('section'),testForm=form(parent,msg('settings.saveConfiguration'),()=>new Promise((resolve,reject)=>finish=${failure?'reject':'resolve'}));
   const password=document.createElement('input');password.name='password';password.type='password';password.value='unsaved password';testForm.append(password);done(testForm);
   const pending=testForm.handlers.submit({preventDefault(){}});`);
  if(failure)env.run('removeForm(testForm)');
  env.run(failure?"finish(new Error('Save failed'))":'finish()');await env.run('pending');
  assert.equal(env.run('textBindings.size'),0);assert.equal(env.run('attributeBindings.size'),0);
  assert.equal(env.run('password.value'),'unsaved password');
 }
});

test('late enrollment and QoS status responses do not bind closed details',async()=>{
 const source=fs.readFileSync('internal/control/ui/app.js','utf8');
 const callbacks=source.split('\n').filter(line=>line.includes('limitedRefresh(c,async()=>'));
 assert.equal(callbacks.length,2);
 for(const line of callbacks){
  const env=environment(['en']);
  env.run(source.slice(source.indexOf('function el('),source.indexOf('function page(')));
  env.run(`document.createElement=()=>({textContent:'',isConnected:false,childNodes:[],setAttribute(){}});const c={isConnected:false,childNodes:[],querySelector(){return null;},append(target){this.childNodes.push(target);}};
   const expiry={textContent:'',isConnected:false,childNodes:[]};const node={id:'test-node'},n=node,e={expires_at:'2099-01-01T00:00:00Z'};let finish;function api(){return new Promise(resolve=>finish=resolve);}`);
  env.run('const read='+line.slice(line.indexOf('async()=>'),line.lastIndexOf(');'))+';const pending=read();');
  env.run("finish({state:'registered',desired_revision:1,applied_revision:1})");await env.run('pending');
  assert.equal(env.run('textBindings.size'),0);assert.equal(env.run('attributeBindings.size'),0);assert.equal(env.run('c.childNodes.length'),0);
 }
});
test('catalogs have matching interpolation and unknown keys fail validation',()=>{
 const env=environment(['en']);env.run("validateTranslations();");assert.throws(()=>env.run("msg('missing.translation').toString()"),/missing.translation/);
 for(const file of ['app.js','i18n.js','index.html']){
  const source=fs.readFileSync('internal/control/ui/'+file,'utf8');
  for(const match of source.matchAll(/(?:msg\(['"]|data-i18n(?:-aria-label|-title)?=")([a-zA-Z]+\.[a-zA-Z0-9]+)['"]/g))assert.doesNotThrow(()=>env.run('String(msg('+JSON.stringify(match[1])+'))'),file+': '+match[1]);
 }
});

test('nested messages, plurals and timestamps follow the selected language while raw data stays intact',()=>{
 const env=environment(['en']);
 assert.equal(env.run("String(msg('nodes.count',1))"),'1 node');assert.equal(env.run("String(msg('nodes.count',2))"),'2 nodes');
 env.run("const raw='tskey-client-raw-中文'; const value=joinText(raw,' · ',msg('settings.saveConfiguration')); const date=localizedTime('2026-10-11T01:00:00Z');");
 assert.equal(env.run('String(value)'),'tskey-client-raw-中文 · Save configuration');const english=env.run('String(date)');
 env.run("setLanguage('zh-CN')");assert.equal(env.run('String(value)'),'tskey-client-raw-中文 · 保存配置');assert.notEqual(env.run('String(date)'),english);assert.equal(env.run('String(localizedTime(0,true))'),'尚无观测');
});

test('updating a label retains its input and the actual button handler submits only once during language changes',async()=>{
 const env=environment(['en']);
 env.run(`document.createElement=tag=>({nodeType:1,tagName:tag.toUpperCase(),isConnected:true,childNodes:[],handlers:{},prepend(node){this.childNodes.unshift(node);},addEventListener(event,handler){this.handlers[event]=handler;}});
 const control={value:'unsaved password',disabled:false};const label=document.createElement('label');setText(label,msg('settings.saveConfiguration'));label.childNodes.push(control);setLanguage('zh-CN');`);
 assert.equal(env.run('label.childNodes[1]===control'),true);assert.equal(env.run('control.value'),'unsaved password');
 const app=fs.readFileSync('internal/control/ui/app.js','utf8');env.run(app.slice(0,app.indexOf('function page(')));
 env.run("let submits=0,finish;const testButton=button(msg('settings.saveConfiguration'),()=>{submits++;return new Promise(resolve=>finish=resolve);});const pending=testButton.handlers.click();setLanguage('en');");
 assert.equal(env.run('testButton.disabled'),true);assert.equal(env.run('String(getText(testButton))'),'Saving…');assert.equal(env.run('submits'),1);
 env.run("setLanguage('zh-CN')");assert.equal(env.run('String(getText(testButton))'),'正在保存…');env.run('finish()');await env.run('pending');
 assert.equal(env.run('testButton.disabled'),false);assert.equal(env.run('String(getText(testButton))'),'保存配置');assert.equal(env.run('submits'),1);
 assert.equal([...env.storage.keys()].join(','),'uniderp-language');
});

test('choosing a language keeps the account popover and expanded options open',()=>{
 const env=environment(['en']),app=fs.readFileSync('internal/control/ui/app.js','utf8');
 env.run(app.slice(app.indexOf('function configureMenu('),app.indexOf('function more(')));
 env.run(`const details={open:true},handlers={},trigger={setAttribute(){}};
 const menu={hiddenCalls:0,setAttribute(){},querySelectorAll(selector){return selector==='details'?[details]:[];},addEventListener(event,handler){handlers[event]=handler;},hidePopover(){this.hiddenCalls++;handlers.toggle({newState:'closed'});}};
 configureMenu(trigger,menu);handlers.click({target:{closest(selector){return selector==='button,a'||selector==='[data-language-choice]'?{}:null;}}});`);
 assert.equal(env.run('menu.hiddenCalls'),0);assert.equal(env.run('details.open'),true);
 env.run("handlers.click({target:{closest(selector){return selector==='button,a'?{}:null;}}})");assert.equal(env.run('menu.hiddenCalls'),1);
});
