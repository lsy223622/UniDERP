'use strict';
var DerpPolicy=(()=>{
 function fail(code){throw Object.assign(new Error(code),{code});}
 function parse(text){const errors=[],root=JSONC.parseTree(text,errors,{allowTrailingComma:true});if(errors.length||!root)fail('syntax');return root;}
 function property(object,name){
  const matches=object.children.filter(p=>p.children[0].value.toLowerCase()===name.toLowerCase());
  if(matches.length>1||matches.some(p=>p.children[0].value!==name))fail('ambiguous');
  return matches[0]?.children[1];
 }
 function regionEntries(node){
  if(!node)return [];
  if(node.type!=='object')fail('structure');
  const seen=new Set();return node.children.map(p=>{
   const key=p.children[0].value,id=Number(key),value=p.children[1];
   if(!/^(0|[1-9][0-9]*)$/.test(key)||!Number.isSafeInteger(id))fail('structure');
   if(seen.has(id))fail('ambiguous');seen.add(id);
   if(!['object','null'].includes(value.type))fail('structure');
   return {id,value,property:p};
  });
 }
 function readPolicy(text){
  if(!text.trim())fail('empty');
  const root=parse(text);if(root.type!=='object')fail('policy');
  if(root.children.some(p=>['regions','omitdefaultregions'].includes(p.children[0].value.toLowerCase())))fail('policy');
  const derp=property(root,'derpMap');if(derp&&derp.type!=='object')fail('structure');
  const regions=derp&&property(derp,'Regions'),omit=derp&&property(derp,'OmitDefaultRegions');
  if(omit&&omit.type!=='boolean')fail('structure');
  return {root,derp,regions,entries:regionEntries(regions),omit,omitDefaultRegions:omit?.value||false};
 }
 function numeric(text){
  let [coefficient,exponent='0']=text.toLowerCase().split('e'),negative=coefficient[0]==='-';if(negative)coefficient=coefficient.slice(1);
  const fraction=coefficient.split('.')[1]?.length||0;let power=BigInt(exponent)-BigInt(fraction),digits=coefficient.replace('.','').replace(/^0+/,'');
  if(!digits)return '0';while(digits.endsWith('0')){digits=digits.slice(0,-1);power++;}return (negative?'-':'')+digits+'e'+power;
 }
 function semantic(node,text,normalizeIDs=false,path=[]){
  if(node.type==='number')return 'n'+numeric(text.slice(node.offset,node.offset+node.length));
  if(node.type==='object'){
   const names=new Set(),parts=node.children.map(p=>{
    const name=p.children[0].value;if(names.has(name))fail('ambiguous');names.add(name);
    const id=normalizeIDs&&name==='RegionID'&&(path.length===0||(path.length===2&&path[0]==='Nodes'));
    return [name,id?'n0':semantic(p.children[1],text,normalizeIDs,[...path,name])];
   });parts.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);return JSON.stringify(parts);
  }
  if(node.type==='array')return '['+node.children.map((n,i)=>semantic(n,text,normalizeIDs,[...path,i])).join(',')+']';
  return node.type+JSON.stringify(node.value);
 }
 function apply(text,edits){for(const e of edits.map((e,index)=>({...e,index})).sort((a,b)=>b.offset-a.offset||b.index-a.index))text=text.slice(0,e.offset)+e.text+text.slice(e.offset+e.length);return text;}
 function commaAfter(text,node){const scanner=JSONC.createScanner(text,true);scanner.setPosition(node.offset+node.length);return scanner.scan()===5?scanner.getTokenOffset():null;}
 function indentAt(text,offset){return /^[\t ]*/.exec(text.slice(text.lastIndexOf('\n',offset-1)+1,offset))[0];}
 function append(text,node,properties){
  if(!properties.length)return text;
  const eol=text.includes('\r\n')?'\r\n':'\n',base=indentAt(text,node.offset),first=node.children[0],indent=first?indentAt(text,first.offset):base+(text.includes('\n\t')?'\t':'  '),padding=indent.length>base.length?indent:base+'  ';
  const edits=[],last=node.children.at(-1);if(last&&commaAfter(text,last)===null)edits.push({offset:last.offset+last.length,length:0,text:','});
  edits.push({offset:node.offset+node.length-1,length:0,text:eol+properties.map(([key,value])=>padding+JSON.stringify(key)+': '+value).join(','+eol)+eol+base});
  return apply(text,edits);
 }
 function merge(source,map,{keepCustom=true,omitDefaultRegions}={}){
  const policy=readPolicy(source);if(omitDefaultRegions===undefined)omitDefaultRegions=policy.omitDefaultRegions;
  if(typeof omitDefaultRegions!=='boolean'||typeof keepCustom!=='boolean')fail('structure');
  const incomingText=JSON.stringify(map),incoming=parse(incomingText);if(incoming.type!=='object')fail('map');
  const incomingRegions=property(incoming,'Regions');if(!incomingRegions)fail('map');
  const added=regionEntries(incomingRegions).sort((a,b)=>a.id-b.id);
  for(const entry of added){
   if(entry.id<900||entry.id>999||entry.value.type!=='object')fail('map');
   const id=property(entry.value,'RegionID'),nodes=property(entry.value,'Nodes');
   if(id?.value!==entry.id||nodes?.type!=='array')fail('map');
   for(const node of nodes.children)if(node.type!=='object'||property(node,'RegionID')?.value!==entry.id)fail('map');
  }
  const retained=policy.entries.filter(e=>keepCustom||e.value.type==='null'||e.id<900||e.id>999),occupied=new Map(retained.map(e=>[e.id,e]));
  const summary={added:0,retained:retained.length,identical:0,renumbered:0},pending=[],insert=[];
  for(const entry of added){
   const existing=occupied.get(entry.id);
   if(!existing){occupied.set(entry.id,entry);insert.push({...entry,target:entry.id});continue;}
   if(semantic(existing.value,source)===semantic(entry.value,incomingText)){summary.identical++;continue;}
   pending.push(entry);
  }
  for(const entry of pending){
   // Recognize an earlier renumbered copy by content, never by its name or prefix.
   if(retained.some(e=>e.id>=900&&e.id<=999&&e.value.type==='object'&&semantic(e.value,source,true)===semantic(entry.value,incomingText,true))){summary.identical++;continue;}
   let target=entry.id;do{target=target===999?900:target+1;if(!occupied.has(target))break;}while(target!==entry.id);
   if(occupied.has(target))fail('full');occupied.set(target,entry);insert.push({...entry,target});summary.renumbered++;
  }
  summary.added=insert.length;
  const additions=insert.sort((a,b)=>a.target-b.target).map(e=>{
   const value=JSON.parse(incomingText.slice(e.value.offset,e.value.offset+e.value.length));value.RegionID=e.target;for(const node of value.Nodes)node.RegionID=e.target;
   return [String(e.target),JSON.stringify(value,null,2)];
  });
  let text=source;
  if(!policy.derp){
   const value={OmitDefaultRegions:omitDefaultRegions,Regions:Object.fromEntries(additions.map(([key,value])=>[key,JSON.parse(value)]))};
   text=append(text,policy.root,[['derpMap',JSON.stringify(value,null,2)]]);
  }else{
   const edits=[];
   for(const entry of policy.entries)if(!retained.includes(entry)){
    const p=entry.property;edits.push({offset:p.offset,length:p.length,text:''});const comma=commaAfter(text,p);if(comma!==null)edits.push({offset:comma,length:1,text:''});
   }
   if(policy.omit&&policy.omit.value!==omitDefaultRegions)edits.push({offset:policy.omit.offset,length:policy.omit.length,text:String(omitDefaultRegions)});
   text=apply(text,edits);let current=readPolicy(text);
   if(current.regions)text=append(text,current.regions,additions);
   else text=append(text,current.derp,[['Regions','{'+additions.map(([key,value])=>JSON.stringify(key)+':'+value).join(',')+'}']]);
   current=readPolicy(text);if(!current.omit)text=append(text,current.derp,[['OmitDefaultRegions',String(omitDefaultRegions)]]);
  }
  readPolicy(text);return {text,summary};
 }
 return {readPolicy,merge};
})();
