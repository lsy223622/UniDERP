const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{test}=require('node:test');
function environment(){
 const all=[],writes=[],pending=[];
 const element=(tag,text)=>{const e={tagName:tag.toUpperCase(),value:'',checked:false,disabled:false,hidden:false,isConnected:true,children:[],handlers:{},attrs:{},append(...nodes){this.children.push(...nodes);},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},addEventListener(k,v){(this.handlers[k]??=[]).push(v);},focus(){},dispatch(event){return Promise.all((this.handlers[event]||[]).map(f=>f({preventDefault(){}})));}};if(text!==undefined)e.textContent=String(text);all.push(e);return e;};
 const context=vm.createContext({el:element,msg:(key,...args)=>({key,args,toString(){return key+':'+args.join(',');}}),setText:(e,v)=>e.textContent=String(v),setLocalizedAttribute:(e,k,v)=>e.setAttribute(k,String(v)),copyText:value=>{writes.push(value);return new Promise(resolve=>pending.push(resolve));}});
 for(const path of ['vendor/jsonc-parser.js','derp-policy.js'])vm.runInContext(fs.readFileSync('internal/control/ui/'+path,'utf8'),context);
 const app=fs.readFileSync('internal/control/ui/app.js','utf8'),start=app.indexOf('function policyMergeTool('),end=app.indexOf('async function tailnets(',start);
 if(start>=0)vm.runInContext(app.slice(start,end),context);
 const parent=element('section'),tool=context.policyMergeTool?.(parent),source=all.find(e=>e.name==='policy-source'),omit=all.find(e=>e.name==='policy-omit'),keep=all.find(e=>e.name==='policy-keep'),output=all.find(e=>e.name==='policy-result'),copy=all.find(e=>e.textContent?.startsWith('policyMerge.copy:')),form=all.find(e=>e.tagName==='FORM');
 let confirmations=0;context.$=()=>({querySelectorAll:()=>[form]});context.confirm=()=>{confirmations++;return false;};
 vm.runInContext(app.slice(app.indexOf('function canDiscardEdits('),app.indexOf('function button(')),context);
 return {tool,source,omit,keep,output,copy,form,writes,pending,all,canDiscard:()=>context.canDiscardEdits(),confirmations:()=>confirmations};
}
const map={Regions:{900:{RegionID:900,RegionCode:'fixture',Nodes:[{RegionID:900,Name:'test',HostName:'fixture.example.test'}]}}};

test('source omit preference is read, generation remains local and editing invalidates copy',async()=>{
 const env=environment();assert.ok(env.tool);env.tool.setMap(map);
 env.source.value='// keep\n{"grants":[],"derpMap":{"OmitDefaultRegions":true}}';await env.source.dispatch('input');
 assert.equal(env.omit.checked,true);assert.equal(env.keep.checked,true);assert.equal(env.form.dirty,true);assert.equal(env.copy.disabled,true);
 await env.form.dispatch('submit');assert.equal(env.copy.disabled,false);assert.ok(env.output.value.startsWith('// keep\n'));assert.equal(env.output.readOnly,true);
 assert.equal(env.canDiscard(),false);assert.equal(env.confirmations(),1);assert.ok(env.source.value.startsWith('// keep'));
 const generated=env.output.value;const copyPending=env.copy.dispatch('click');assert.deepEqual(env.writes,[generated]);
 env.source.value='{"grants":[]}';await env.source.dispatch('input');assert.equal(env.omit.checked,false);assert.equal(env.output.value,'');assert.equal(env.copy.disabled,true);
 env.pending[0]();await copyPending;assert.equal(env.copy.disabled,true);
 await env.form.dispatch('submit');env.keep.checked=false;await env.keep.dispatch('change');assert.equal(env.output.value,'');assert.equal(env.copy.disabled,true);
 await env.form.dispatch('submit');env.omit.checked=true;await env.omit.dispatch('change');assert.equal(env.copy.disabled,true);
});

test('map snapshots are immutable and refresh invalidates results while preserving drafts',async()=>{
 const env=environment(),input=JSON.parse(JSON.stringify(map));env.tool.setMap(input);input.Regions[900].Nodes[0].HostName='mutated.test';
 env.source.value='{"groups":{"group:test":["example@test.invalid"]}}';await env.source.dispatch('input');await env.form.dispatch('submit');
 assert.ok(env.output.value.includes('fixture.example.test'));assert.ok(!env.output.value.includes('mutated.test'));
 const draft=env.source.value;env.tool.setMap(null);assert.equal(env.source.value,draft);assert.equal(env.output.value,'');assert.equal(env.copy.disabled,true);assert.equal(env.form.dirty,true);
 env.tool.setMap({Regions:{}});await env.form.dispatch('submit');assert.ok(!env.output.value.includes('fixture.example.test'));
});

test('invalid or ambiguous source never retains an old result or exposes source text in errors',async()=>{
 const env=environment();env.tool.setMap(map);env.source.value='{"grants":[]}';await env.source.dispatch('input');await env.form.dispatch('submit');assert.ok(env.output.value);
 for(const source of ['', '{"SENSITIVE-FIXTURE":', '{"derpMap":{},"DERPMAP":{}}']){
  env.source.value=source;await env.source.dispatch('input');await env.form.dispatch('submit');assert.equal(env.output.value,'');assert.equal(env.copy.disabled,true);
  assert.ok(env.all.filter(e=>e.attrs.role==='alert').some(e=>!e.hidden));assert.ok(!env.all.some(e=>e.textContent?.includes('SENSITIVE-FIXTURE')));
 }
});
