const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{test}=require('node:test');
function environment(languages,saved){
 const listeners={},storage=new Map(saved?[['uniderp-language',saved]]:[]),root={lang:''};
 const document={documentElement:root,querySelectorAll:()=>[],createTextNode:value=>({nodeType:3,textContent:value,isConnected:true})};
 const context=vm.createContext({document,navigator:{languages},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},window:{addEventListener:(event,callback)=>listeners[event]=callback},Intl,console});
 for(const path of ['locales/zh-CN.js','locales/en.js','i18n.js'])vm.runInContext(fs.readFileSync('internal/control/ui/'+path,'utf8'),context);
 return {context,root,storage,listeners,run:code=>vm.runInContext(code,context)};
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
 const env=environment(['en']);env.run("const input={value:'unsaved secret',disabled:true,isConnected:true,attrs:{},setAttribute(k,v){this.attrs[k]=v;}}; const label={textContent:'',isConnected:true}; setText(label,msg('ui.saveConfiguration')); setLocalizedAttribute(input,'aria-label',msg('ui.saveConfiguration')); let calls=0; window.fetch=()=>calls++;");
 env.run("setLanguage('zh-CN')");assert.equal(env.run('label.textContent'),'保存配置');assert.equal(env.run("input.attrs['aria-label']"),'保存配置');assert.equal(env.run('input.value'),'unsaved secret');assert.equal(env.run('input.disabled'),true);assert.equal(env.run('calls'),0);
 env.run("setText(label,msg('busy.saving')); setLanguage('en')");assert.equal(env.run('label.textContent'),'Saving…');
});
test('catalogs have matching interpolation and unknown keys fail validation',()=>{
 const env=environment(['en']);env.run("validateTranslations();");assert.throws(()=>env.run("msg('missing.translation').toString()"),/missing.translation/);
});

test('nested messages, plurals and timestamps follow the selected language while raw data stays intact',()=>{
 const env=environment(['en']);
 assert.equal(env.run("String(msg('nodes.count',1))"),'1 node');assert.equal(env.run("String(msg('nodes.count',2))"),'2 nodes');
 env.run("const raw='tskey-client-raw-中文'; const value=joinText(raw,' · ',msg('ui.saveConfiguration')); const date=localizedTime('2026-10-11T01:00:00Z');");
 assert.equal(env.run('String(value)'),'tskey-client-raw-中文 · Save configuration');const english=env.run('String(date)');
 env.run("setLanguage('zh-CN')");assert.equal(env.run('String(value)'),'tskey-client-raw-中文 · 保存配置');assert.notEqual(env.run('String(date)'),english);assert.equal(env.run('String(localizedTime(0,true))'),'尚无观测');
});

test('updating a label retains its input and the actual button handler submits only once during language changes',async()=>{
 const env=environment(['en']);
 env.run(`document.createElement=tag=>({nodeType:1,tagName:tag.toUpperCase(),isConnected:true,childNodes:[],handlers:{},prepend(node){this.childNodes.unshift(node);},addEventListener(event,handler){this.handlers[event]=handler;}});
 const control={value:'unsaved password',disabled:false};const label=document.createElement('label');setText(label,msg('ui.saveConfiguration'));label.childNodes.push(control);setLanguage('zh-CN');`);
 assert.equal(env.run('label.childNodes[1]===control'),true);assert.equal(env.run('control.value'),'unsaved password');
 const app=fs.readFileSync('internal/control/ui/app.js','utf8');env.run(app.slice(0,app.indexOf('function page(')));
 env.run("let submits=0,finish;const testButton=button(msg('ui.saveConfiguration'),()=>{submits++;return new Promise(resolve=>finish=resolve);});const pending=testButton.handlers.click();setLanguage('en');");
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
