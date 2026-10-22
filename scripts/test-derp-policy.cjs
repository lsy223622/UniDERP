const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{test}=require('node:test');
const context=vm.createContext({});
for(const file of ['vendor/jsonc-parser.js','derp-policy.js'])if(fs.existsSync('internal/control/ui/'+file))vm.runInContext(fs.readFileSync('internal/control/ui/'+file,'utf8'),context);
const merge=(source,map,options={})=>context.DerpPolicy.merge(source,map,{keepCustom:true,...options});
const read=source=>context.DerpPolicy.readPolicy(source);
const region=(id,host='new.example.test')=>({RegionID:id,RegionCode:'uniderp-'+id,Nodes:[{Name:'relay',RegionID:id,HostName:host},{Name:'second',RegionID:id,HostName:host}]});
const map=(...ids)=>({Regions:Object.fromEntries(ids.map(id=>[id,region(id)]))});
const json=source=>JSON.parse(source);
const error=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('preserves all unrelated HuJSON source, comments, escaped strings and large numeric literals',()=>{
 const source='// policy\r\n{\r\n\t"grants": [{"src":["*"], "dst":["tag:web"], "ip":["443"]}], // access\r\n\t"unknown": {"counter":900719925474099312345, "url":"https://example.test//path", "quote":"\\\"/*keep*/"},\r\n}\r\n';
 const result=merge(source,map(900));
 assert.ok(result.text.includes(source.slice(0,source.lastIndexOf('}'))));
 assert.ok(result.text.endsWith('\r\n'));
 assert.equal(read(result.text).omitDefaultRegions,false);
 assert.equal(result.summary.added,1);
 assert.equal(result.summary.renumbered,0);
 assert.ok(result.text.includes('900719925474099312345'));
});

test('reads omit state and preserves unrelated derpMap text while applying either option',()=>{
 for(const omit of [true,false])for(const keep of [true,false]){
  const original={grants:[],derpMap:{OmitDefaultRegions:!omit,Unknown:900719925,Regions:{1:null,2:region(2,'official-override.test'),900:region(900,'old.test'),905:null,1100:region(1100,'outside.test')}}};
  const result=json(merge(JSON.stringify(original),map(901),{omitDefaultRegions:omit,keepCustom:keep}).text);
  assert.equal(result.derpMap.OmitDefaultRegions,omit);assert.equal(result.derpMap.Unknown,900719925);
  assert.equal(900 in result.derpMap.Regions,keep);assert.equal(result.derpMap.Regions[905],null);
  assert.equal(result.derpMap.Regions[1],null);assert.deepEqual(result.derpMap.Regions[2],original.derpMap.Regions[2]);assert.ok(result.derpMap.Regions[1100]);assert.ok(result.derpMap.Regions[901]);
 }
 assert.equal(read('{"derpMap":{"OmitDefaultRegions":true}}').omitDefaultRegions,true);
 assert.equal(read('{"grants":[]}').omitDefaultRegions,false);
 assert.equal(json(merge('{"grants":[]}',map(900)).text).derpMap.OmitDefaultRegions,false);
});

test('deduplicates same-ID semantic objects without rounding numeric extensions',()=>{
 const r=region(900);const reordered={Nodes:r.Nodes,RegionCode:r.RegionCode,RegionID:900};
 const result=merge(JSON.stringify({grants:[],derpMap:{Regions:{900:reordered}}}),map(900));
 assert.equal(result.summary.identical,1);assert.equal(result.summary.added,0);assert.equal(result.summary.renumbered,0);
 const large='{"grants":[],"derpMap":{"Regions":{"900":'+JSON.stringify(r).replace('"RegionID":900','"Cost":9007199254740993,"RegionID":900')+'}}}';
 const different=map(900);different.Regions[900].Cost=9007199254740992;
 assert.equal(merge(large,different).summary.renumbered,1);
 const wrongID=region(901);wrongID.RegionCode='uniderp-900';
 const malformed=merge(JSON.stringify({grants:[],derpMap:{Regions:{900:wrongID}}}),map(900));
 assert.equal(malformed.summary.added,1);assert.equal(malformed.summary.identical,0);
 const containers=map(900);containers.Regions[900].Extra=[];const old=region(900);old.Extra={};
 const distinct=merge(JSON.stringify({grants:[],derpMap:{Regions:{900:old}}}),containers);
 assert.equal(distinct.summary.identical,0);assert.equal(distinct.summary.renumbered,1);
 const otherID=region(901);otherID.RegionCode='uniderp-900';
 const collision=merge(JSON.stringify({grants:[],derpMap:{Regions:{900:region(900,'old.test'),901:otherID}}}),map(900));
 assert.equal(collision.summary.added,1);assert.equal(collision.summary.renumbered,1);
 assert.equal(json(collision.text).derpMap.Regions[902].RegionID,902);
});

test('reserves incoming free IDs before allocating collisions, skips nulls, updates all node IDs and wraps',()=>{
 const source=JSON.stringify({grants:[],derpMap:{Regions:{900:region(900,'old.test'),902:null,999:region(999,'last.test')}}});
 const result=merge(source,map(900,901,999));const regions=json(result.text).derpMap.Regions;
 assert.equal(regions[901].RegionCode,'uniderp-901');assert.equal(regions[903].RegionCode,'uniderp-900');assert.equal(regions[904].RegionCode,'uniderp-999');
 for(const id of [903,904])for(const node of regions[id].Nodes)assert.equal(node.RegionID,id);
 assert.equal(regions[902],null);assert.equal(result.summary.renumbered,2);
 assert.equal(merge(source,map(900,901,999)).text,result.text);
 const wrap=json(merge('{"grants":[],"derpMap":{"Regions":{"999":null}}}',map(999)).text);
 assert.equal(wrap.derpMap.Regions[900].RegionID,900);
});

test('all reserved IDs occupied fails atomically; explicit replacement frees object entries only',()=>{
 const regions=Object.fromEntries(Array.from({length:100},(_,i)=>[900+i,region(900+i,'old.test')]));
 const source=JSON.stringify({grants:[],derpMap:{Regions:regions}});
 error(()=>merge(source,map(900)),'full');
 assert.deepEqual(Object.keys(json(merge(source,map(900),{keepCustom:false}).text).derpMap.Regions),['900']);
 regions[901]=null;
 assert.equal(json(merge(JSON.stringify({grants:[],derpMap:{Regions:regions}}),map(901),{keepCustom:false}).text).derpMap.Regions[902].RegionID,902);
});

test('target structure ambiguity and fragments are rejected without attempting policy semantic validation',()=>{
 error(()=>read('  '),'empty');
 for(const source of ['{"grants":[],oops}', '{"grants":[]}garbage','{"grants":[],"x":"bad\n"}'])error(()=>read(source),'syntax');
 for(const source of ['[]','null','{"Regions":{}}','{"OmitDefaultRegions":false}'])error(()=>read(source),'policy');
 for(const source of ['{"derpMap":null}','{"derpMap":{"Regions":[]}}','{"derpMap":{"OmitDefaultRegions":1}}','{"derpMap":{"Regions":{"900":false}}}'])error(()=>read(source),'structure');
 for(const source of ['{"derpMap":{},"derpMap":{}}','{"DerpMap":{}}','{"derpMap":{},"DERPMAP":{}}','{"derpMap":{"Regions":{},"regions":{}}}','{"derpMap":{"Regions":{"900":null,"900":null}}}','{"derpMap":{"OmitDefaultRegions":false,"omitdefaultregions":true}}'])error(()=>read(source),'ambiguous');
 assert.ok(merge('{"futurePolicyKey": {"__proto__": "safe"}}',map(900)).text.includes('"__proto__": "safe"'));
 assert.equal(merge('{}',{Regions:{}}).summary.added,0);
});

test('local edit boundaries remain valid with comments, removals and trailing commas',()=>{
 for(const contents of ['', '"900":{},', '"900":{},"901":null', '"901":null,"900":{}', '"900":{},"902":{},"901":null,', '"900":{}, /*comment*/ "901":null, //last\n']){
  const source='/*before*/ {"ssh":[], "derpMap": { /*keep map*/ "Unknown":999999999999999999999, "Regions":{'+contents+'}},"tests":[]} //end';
  const result=merge(source,map(903),{keepCustom:false});
  assert.ok(result.text.includes('"Unknown":999999999999999999999'));assert.ok(result.text.includes('/*keep map*/'));assert.ok(result.text.endsWith('//end'));
  assert.equal(read(result.text).omitDefaultRegions,false);
 }
});
