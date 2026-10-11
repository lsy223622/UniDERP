'use strict';
initializeLanguage();
let actor, csrf, serverRole;
let pageGeneration=0,detailGeneration=0,currentPage='',refreshTimer;
let resourceScope='mine', userNames=new Map(),visibleNodes=new Map();
const $ = id => document.getElementById(id);
function notice(message, error = false) { const n = $('notice'); setText(n,message); n.classList.toggle('error',error); n.hidden = false; clearTimeout(notice.timer); if(!error)notice.timer = setTimeout(() => n.hidden = true,7000); }
async function api(path,method='GET',body) {
  const generation=pageGeneration;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let r;try{r=await fetch('/api/v1'+path,{method,headers,credentials:'same-origin',body:body===undefined?undefined:JSON.stringify(body)});}catch(e){if(e.name==='AbortError')throw e;throw localizedError(msg('errors.network'));}
  const result = await r.json().catch(() => ({}));
  if(generation!==pageGeneration)throw new DOMException('Page changed','AbortError');
  if (!r.ok) { const e = localizedError(({invalid_hostname:msg("errors.enterAHostnameSuchAsDerpExampleComWithout"),certificate_required:msg("errors.uploadTheCertificateChainAndPrivateKeyBeforeApplying"),certificate_invalid:msg("errors.theCertificateChainAndPrivateKeyDoNotMatch"),certificate_hostname_mismatch:msg("errors.theCertificateDoesNotMatchTheSavedPublicDERP")})[result.code]||({400:msg("errors.checkTheHighlightedFieldsAndTryAgain"),401:msg("errors.signInAgain"),403:msg("errors.youDoNotHavePermissionToPerformThisAction"),409:msg("errors.theStateHasChangedRefreshAndTryAgain"),429:msg("errors.tooManyRequestsTryAgainShortly"),503:msg("errors.theIdentitySourceIsUnavailableCheckTheTailnetID")})[r.status] || msg("errors.requestFailedCheckTheResourceStatusAndTryAgain")); e.status=r.status;e.code=result.code;e.field=result.field; throw e; }
  return result;
}
function el(tag,text,className) { const e=document.createElement(tag); if(text!==undefined)setText(e,text); if(className)e.className=className; return e; }
function processingLabel(label){const key=label?.key||'';for(const [action,busy]of [['join','joining'],['apply','applying'],['verify','verifying'],['save','saving'],['copy','copying'],['register','registering'],['issue','registering'],['refresh','loading'],['read','loading']])if(key.toLowerCase().includes(action))return msg('busy.'+busy);return msg('busy.working');}
function persistentError(parent,message,retry){parent.querySelector('.persistent-error')?.remove();const box=el('div',undefined,'persistent-error');box.setAttribute('role','alert');box.append(el('p',message));if(retry)box.append(button(msg("common.retry"),retry));parent.append(box);}
function canDiscardEdits(root=$('content')){if(!root||![...root.querySelectorAll('form')].some(f=>f.dirty))return true;if(!confirm(msg("common.youHaveUnsavedChangesDiscardThemAndContinue")))return false;root.querySelectorAll('form').forEach(f=>f.dirty=false);return true;}
function button(label,run,className='quiet'){const b=el('button',label,className);b.type='button';b.addEventListener('click',async()=>{const original=getText(b),processing=processingLabel(original);b.disabled=true;setText(b,processing);try{await run();}catch(e){if(e.name!=='AbortError'&&b.isConnected){persistentError(b.closest('form,.detail-body,.card')||$('content'),errorText(e));}}finally{b.disabled=false;if(b.isConnected&&getText(b)===processing)setText(b,original);}});return b;}
function page(title,hint) { $('content').replaceChildren(el('h1',title),el('p',hint,'muted'),el('p',msg("busy.loading"),'page-loading muted')); }
function card(title,parent=$('content')) { const c=el('section',undefined,'card');c.append(el('h2',title));parent.append(c);return c; }
function pageLocation(hash,role){
 const [name,query='']=hash.replace(/^#/,'').split('?'),source=new URLSearchParams(query),params=new URLSearchParams();
 for(const key of ['node','q','state','scope','tailnet'])if(source.has(key))params.set(key,source.get(key));
 if(params.has('node')&&!/^[a-f0-9]{64}$/.test(params.get('node')))params.delete('node');
 if(params.has('scope'))params.set('scope',role==='admin'&&params.get('scope')==='all'?'all':'mine');
 return {name,params};
}
function pageParams(){return pageLocation(location.hash,actor.role).params;}
function updatePageParams(changes,refresh=false){
 const params=pageParams();for(const [key,value]of Object.entries(changes)){if(value)params.set(key,value);else params.delete(key);}
 const hash='#'+currentPage+(params.size?'?'+params.toString():'');
 if(hash===location.hash)return;if(refresh)location.hash=hash;else history.pushState(null,'',hash);
}
function detailCard(title,id){
 if(!canDiscardEdits($('node-detail')))throw new DOMException('Keep edits','AbortError');++detailGeneration;
 const nodeID=id.match(/^(?:state|qos|ports|domain|enrollment|request)-([a-f0-9]{64})$/)?.[1],entry=visibleNodes.get(nodeID);
 if(entry&&['nodes','directory'].includes(currentPage)){
  let root=$('node-detail');
  if(!root||root.dataset.node!==nodeID){
   const trigger=document.activeElement;if(root)root.closest('.node-detail-row')?.remove()||root.remove();root=card(entry.node.display_name);root.id='node-detail';root.dataset.node=nodeID;root.classList.add('node-detail');if(actor.role==='admin'&&entry.editable&&entry.node.owner_id!==actor.id)root.append(el('p',managedLabel(entry.node.owner_id),'badge'));
   const anchor=document.querySelector('[data-node-id="'+nodeID+'"]');if(anchor?.tagName==='TR'){const row=el('tr',undefined,'node-detail-row'),cell=el('td');cell.colSpan=anchor.children.length;cell.append(root);row.append(cell);anchor.after(row);}else if(anchor)anchor.after(root);
   root.prepend(button(msg("common.closeDetails"),()=>{if(!canDiscardEdits(root))return;++detailGeneration;const row=root.closest('.node-detail-row');if(row)row.remove();else root.remove();updatePageParams({node:null});if(trigger?.isConnected)trigger.focus();else anchor?.querySelector('button')?.focus();}));
   const nav=actions(button(msg("nav.overview"),()=>openNode(entry.node)),button(msg("grants.accessGrants"),()=>nodeGrants(entry.node)),button(msg("bandwidth.bandwidthRules2"),()=>entry.summary&&!entry.editable?sharedNodeInfo(entry):qos(entry.node,entry.editable)),...(entry.editable?[button(msg("nodes.enrollmentAndMaintenance2"),()=>nodeMaintenance(entry.node))]:[]));nav.classList.add('detail-tabs');root.append(nav,el('div',undefined,'detail-body'));
  }
  updatePageParams({node:nodeID});const body=root.querySelector('.detail-body');body.replaceChildren();body.id=id;const heading=el('h3',title);heading.tabIndex=-1;body.append(heading);heading.focus();root.scrollIntoView({behavior:'smooth',block:'nearest'});return body;
 }
 document.getElementById(id)?.remove();const trigger=document.activeElement,c=card(title);c.id=id;
 c.prepend(button(msg("common.closeDetails"),()=>{c.remove();if(trigger?.isConnected)trigger.focus();}));const heading=c.querySelector('h2');heading.tabIndex=-1;heading.focus();c.scrollIntoView({behavior:'smooth',block:'start'});return c;
}
async function openNode(n){const entry=visibleNodes.get(n.id);if(entry?.summary&&!entry.editable)return sharedNodeInfo(entry);return nodeState(n);}
function sharedNodeInfo(entry){const s=entry.summary,c=detailCard(msg("nodes.overview2",entry.node.display_name),'state-'+entry.node.id);c.append(el('p',msg("nodes.provider2",entry.node.domain,s.provider),'muted'));ruleSummary(c,s.qos);const figure=el('div',undefined,'qos-preview');c.append(figure);qosFigure(figure,s.qos,{tailnet_caps_unknown:true});probeTable(c,s.probes,s.node);return c;}
async function nodeGrants(n){const ticket=++detailGeneration,grants=await api('/grants');if(ticket!==detailGeneration)return;const c=detailCard(msg("grants.accessGrants2",n.display_name),'state-'+n.id),incoming=n.owner_id===actor.id||actor.role==='admin';table(c,['Tailnet',msg("grants.accessStatus"),msg("grants.nextStep")],grants.filter(g=>g.node_id===n.id).map(g=>[g.tailnet_name,actions(status(g.state),el('p',grantGuidance(g,incoming),'muted')),el('a',incoming?msg("grants.viewIncomingRequests"):msg("grants.viewMyAccessGrants"))]));c.querySelectorAll('a').forEach(a=>a.href='#'+(incoming?'requests':'grants')+'?q='+encodeURIComponent(n.display_name)+(actor.role==='admin'&&n.owner_id!==actor.id?'&scope=all':''));}

function nodeMaintenance(n){const c=detailCard(msg("nodes.enrollmentAndMaintenance",n.display_name),'state-'+n.id);c.append(el('p',msg("nodes.updateTheDERPMapAfterChangingEnrollmentHostnamesOr"),'muted'));c.append(actions(button(msg("nodes.publicPorts"),()=>nodePorts(n)),button(msg("nodes.hostname"),()=>changeDomain(n)),button(n.state==='pending'?msg("nodes.enrollmentCode"):msg("nodes.reissueEnrollmentCode"),()=>enrollment(n)),button(msg("nodes.deleteNode"),()=>deleteNode(n),'danger')));}
async function scopeSelector(){
 if(actor.role!=='admin')return;
 const users=await api('/users');userNames=new Map(users.map(u=>[u.id,u.username]));
 const row=el('div',undefined,'row scope-selector'),input=select(row,'scope',msg("common.resourceScope"),[['mine',msg("common.mine")],['all',msg("common.all")]]);input.value=resourceScope;
 input.addEventListener('change',()=>{updatePageParams({scope:input.value,node:null},true);});$('content').append(row);
}
function managedLabel(owner){return owner!==actor.id?msg("common.managingOnBehalfOf",userNames.get(owner)||owner.slice(0,8)):'';}
function nextActions({actor,serverRole,local,nodes,tailnets,grants}){
 if(serverRole==='member')return [{title:local.pending_apply?msg("overview.applyLocalSettings"):!local.joined?msg("settings.joinAnExistingCluster"):msg("overview.viewControllerConnectionAndPermissions"),href:local.pending_apply?'local':'member',path:msg("nav.localNode2")}];
 const actions=[],ownTailnets=tailnets.filter(t=>t.owner_id===actor.id),ownNodes=nodes.filter(n=>n.owner_id===actor.id);
 if(actor.role==='admin'||actor.role==='provider'){
  const incoming=grants.filter(g=>g.node_owner_id===actor.id&&g.state==='requested');
  if(incoming.length)actions.push({title:msg("overview.approve",incoming.length),href:'requests',path:msg("overview.provideNodes")});
  if(!ownNodes.length)actions.push({title:msg("overview.addAStandaloneDERPNode"),href:'nodes',path:msg("overview.provideNodes")});
  else if(ownNodes.some(n=>n.state==='pending'))actions.push({title:msg("overview.viewEnrollmentDetailsToConnectAMemberNode"),href:'nodes',path:msg("overview.provideNodes")});
  if(actor.role==='admin'&&local&&!local.joined)actions.push({title:local.pending_apply?msg("overview.applyBuiltInNodeSettingsOptional"):msg("overview.registerTheBuiltInNodeOptional"),href:local.pending_apply?'local':'member',path:msg("overview.provideNodes")});
 }
 const own=grants.filter(g=>g.tailnet_owner_id===actor.id);
 if(!ownTailnets.length)actions.push({title:msg("overview.connectYourTailnet"),href:'tailnets',path:msg("overview.useDERP")});
 else if(own.some(g=>g.state==='owner_approved'))actions.push({title:msg("overview.confirmAccessApprovedByTheProvider"),href:'grants',path:msg("overview.useDERP")});
 else if(own.some(g=>g.state==='requested'))actions.push({title:msg("overview.viewRequestsAwaitingProviderApproval"),href:'grants',path:msg("overview.useDERP")});
 else if(!own.some(g=>g.state==='active'))actions.push({title:msg("overview.chooseANodeForYourTailnet"),href:'directory',path:msg("overview.useDERP")});
 else actions.push({title:msg("overview.copyTheDERPMapAndMergeItIntoYour"),href:'tailnets',path:msg("overview.useDERP")});
 return actions;
}
async function copyText(text){try{await navigator.clipboard.writeText(text);notice(msg("common.copied"));}catch{notice(msg("common.copyFailedSelectTheTextAndCopyItManually"),true);}}
function limitedRefresh(parent,read){
 const generation=pageGeneration,started=Date.now(),message=el('p',msg("common.checksEvery5SecondsForUpTo2Minutes"),'muted');parent.append(message);
 const refresh=async()=>{
  if(generation!==pageGeneration||document.hidden||!parent.isConnected)return;
  try{const pending=await read();if(generation!==pageGeneration||!parent.isConnected)return;
   if(!pending){setText(message,msg("common.statusUpdated",time(new Date().toISOString())));return;}
   if(Date.now()-started>=120000){setText(message,msg("common.automaticChecksFinishedRefreshManuallyForNewStatus"));parent.append(button(msg("common.refreshStatus"),refresh));return;}
   refreshTimer=setTimeout(refresh,5000);
  }catch(e){if(e.name==='AbortError'||generation!==pageGeneration||!parent.isConnected)return;setText(message,msg("common.couldNotReadStatusRefreshToTryAgain"));parent.append(button(msg("common.refreshStatus"),refresh));}
 };refreshTimer=setTimeout(refresh,5000);
}
function field(form,name,label,type='text',required=true,value='') { const l=el('label',label);const input=el('input');input.name=name;input.type=type;input.required=required;input.value=value;if(name==='domain'||name==='hostname'){input.placeholder='derp.example.com';l.append(el('small',msg("nodes.enterAHostnameWithoutASchemePortOrPath"),'muted'));}l.append(input);form.append(l);return input; }
function select(form,name,label,items) { const l=el('label',label);const input=el('select');input.name=name;for(const [value,text] of items){const o=el('option',text);o.value=value;input.append(o);}l.append(input);form.append(l);return input; }
function form(parent,submit,run){
 const f=el('form');parent.append(f);const b=el('button',submit),edit=el('p',msg("common.unsavedChanges"),'edit-state muted');edit.hidden=true;b.type='submit';f.append(edit);
 const ordinary=()=>[...f.elements].filter(input=>input.name&&!['password','file','submit'].includes(input.type));
 f.addEventListener('input',()=>{if(f.initialValues){f.dirty=ordinary().some(input=>f.initialValues.get(input.name)!==input.value);edit.hidden=!f.dirty;}});
 f.addEventListener('change',()=>{if(f.initialValues){f.dirty=ordinary().some(input=>f.initialValues.get(input.name)!==input.value);edit.hidden=!f.dirty;}});
 f.addEventListener('submit',async e=>{e.preventDefault();const generation=pageGeneration,original=getText(b),data=new FormData(f),controls=[...f.elements].filter(input=>input!==b).map(input=>[input,input.disabled]);controls.forEach(([input])=>input.disabled=true);b.disabled=true;setText(b,processingLabel(original));f.querySelectorAll('.field-error,.persistent-error').forEach(n=>n.remove());f.querySelectorAll('[aria-invalid]').forEach(n=>n.removeAttribute('aria-invalid'));
  try{const after=await run(data,f);if(generation!==pageGeneration||!f.isConnected)return;f.dirty=false;edit.hidden=true;f.initialValues=new Map(ordinary().map(input=>[input.name,input.value]));notice(f.successMessage||msg("common.saved"));if(await render({preserveScroll:true})&&typeof after==='function')await after();}
  catch(err){if(err.name==='AbortError'||generation!==pageGeneration||!f.isConnected)return;controls.forEach(([input,disabled])=>input.disabled=disabled);const input=err.field&&f.elements.namedItem(err.field);if(input){input.setAttribute('aria-invalid','true');input.after(el('small',errorText(err),'field-error'));input.focus();}persistentError(f,errorText(err));}
  finally{controls.forEach(([input,disabled])=>input.disabled=disabled);b.disabled=false;if(b.isConnected)setText(b,original);}
 });f.submitButton=b;return f;
}
function done(f){f.append(f.submitButton);f.initialValues=new Map([...f.elements].filter(input=>input.name&&!['password','file','submit'].includes(input.type)).map(input=>[input.name,input.value]));return f;}
function table(parent,head,rows) { const wrap=el('div',undefined,'table-wrap'),t=el('table',undefined,'business-table'),tr=el('tr');for(const text of head)tr.append(el('th',text));const h=el('thead');h.append(tr);t.append(h);const body=el('tbody');for(const row of rows){const r=el('tr');for(const [i,value] of row.entries()){const c=el('td');setLocalizedAttribute(c,'data-label',head[i]);c.append(value instanceof Node?value:el('span',value));r.append(c);}body.append(r);}t.append(body);wrap.append(t);parent.append(wrap);if(!rows.length)parent.append(el('p',msg("common.noRecordsYet"),'muted')); }
let menuSequence=0;
function configureMenu(trigger,menu){
 trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');menu.setAttribute('role','menu');
 menu.querySelectorAll('button,a,summary').forEach(item=>{if(!item.hasAttribute('role'))item.setAttribute('role','menuitem');});
 menu.addEventListener('toggle',e=>{
  const open=e.newState==='open';trigger.setAttribute('aria-expanded',String(open));if(!open){menu.querySelectorAll('details').forEach(d=>d.open=false);return;}
  const rect=trigger.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
  const above=rect.bottom+height+4>innerHeight;
  menu.style.left=Math.max(8,Math.min(rect.right-width,innerWidth-width-8))+'px';
  menu.style.top=above?'auto':Math.max(8,rect.bottom+4)+'px';
  menu.style.bottom=above?Math.max(8,innerHeight-rect.top+4)+'px':'auto';
  menu.style.transformOrigin=above?'bottom right':'top right';
  menu.querySelector('button:not([hidden]),a:not([hidden])')?.focus();
 });
 menu.addEventListener('click',e=>{if(e.target.closest('button,a')&&!e.target.closest('[data-language-choice]'))menu.hidePopover();});
 menu.addEventListener('keydown',e=>{
  const items=[...menu.querySelectorAll('button:not(:disabled):not([hidden]),a:not([hidden]),summary')].filter(item=>item.tagName==='SUMMARY'||!item.closest('details')||item.closest('details').open);let index=items.indexOf(document.activeElement);
  if(e.key==='ArrowDown')index=(index+1)%items.length;
  else if(e.key==='ArrowUp')index=(index-1+items.length)%items.length;
  else if(e.key==='Home')index=0;else if(e.key==='End')index=items.length-1;else return;
  e.preventDefault();items[index]?.focus();
 });
}
function more(...items){const wrap=el('span'),trigger=el('button',undefined,'more-menu'),menu=el('div',undefined,'more-options');trigger.type='button';setLocalizedAttribute(trigger,'aria-label',msg("common.moreActions"));trigger.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01"/></svg>';menu.id='action-menu-'+(++menuSequence);menu.setAttribute('popover','auto');trigger.setAttribute('popovertarget',menu.id);menu.append(...items);configureMenu(trigger,menu);wrap.append(trigger,menu);return wrap;}
function actions(...items){const r=el('div',undefined,'row');r.append(...items);return r;}
function time(value){return localizedTime(value);}
function observedTime(value){const absolute=time(value),relative=localizedTime(value,true),result=el('time',relative),date=new Date(typeof value==='number'?value*1000:value);if(value&&value!=='0001-01-01T00:00:00Z'&&Number.isFinite(date.getTime()))result.dateTime=date.toISOString();setLocalizedAttribute(result,'title',absolute);setLocalizedAttribute(result,'aria-label',joinText(relative,' · ',absolute));return result;}
function bytes(value){const text=el('span');setLocalizedAttribute(text,'title',msg("units.bytes",String(value)));setText(text,value>=1048576?(value/1048576).toFixed(2)+' MiB':value>=1024?(value/1024).toFixed(2)+' KiB':value+' B');return text;}
function shortIdentity(id,name){const details=el('details',undefined,'identity');details.append(el('summary',name||id.slice(0,8)+'…'),el('code',id),button(msg("common.copyFullID"),()=>copyText(id)));return details;}
async function visibleTailnetNames(){const [tailnets,grants]=await Promise.all([api('/tailnets'),api('/grants')]);const names=new Map(grants.map(g=>[g.tailnet_id,g.tailnet_name+' · '+g.applicant]));for(const t of tailnets)if(!names.has(t.id))names.set(t.id,t.display_name);return {tailnets,names};}
function reportedBudget(parent,state){
 const r=state.report;
 if(r&&r.revision!==state.desired_revision)parent.append(el('p',msg("bandwidth.rulesAreUpdatingTheLatestNodeReportIsShown"),'badge warn'));
 table(parent,[msg("bandwidth.nodeReportField"),msg("bandwidth.value"),msg("common.source")],[
  [msg("bandwidth.localBandwidthCeiling2"),r?.local_max_budget_bps===undefined?msg("bandwidth.noNodeReportYet"):r.local_max_budget_bps===0?msg("bandwidth.noAdditionalLimit"):r.local_max_budget_bps/1000000+' Mbps',r?msg("bandwidth.sampledAt2",time(r.observed_at)):msg("bandwidth.noNodeReportYet")],
  [msg("bandwidth.effectiveBandwidthBudget3"),r?.effective_budget_bps===undefined?msg("bandwidth.noNodeReportYet"):r.effective_budget_bps/1000000+' Mbps',r?msg("bandwidth.revision3",r.revision):msg("bandwidth.noNodeReportYet")]
 ]);
}
function status(value){const names={pending:msg("nodes.pendingEnrollment"),domain_pending:msg("nodes.awaitingHostnameVerification"),registered:msg("nodes.registered"),ready:msg("nodes.reportedReady"),offline:msg("nodes.offline"),identity_conflict:msg("nodes.identityConflict"),requested:msg("grants.awaitingProviderApproval2"),owner_approved:msg("grants.awaitingApplicantConfirmation"),active:msg("common.active2"),revoked:msg("grants.revoked"),left:msg("grants.left"),rejected:msg("grants.rejected"),cancelled:msg("grants.cancelled"),expired:msg("grants.expired"),valid:msg("common.valid"),invalid:msg("tailnets.invalidCredentials"),missing:msg("common.notConfigured3"),paused:msg("common.paused"),unavailable:msg("tailnets.identitySourceUnavailable")};return el('span',names[value]||value||msg("common.noStatusYet"),'badge '+(['ready','active','valid'].includes(value)?'good':['identity_conflict','invalid','revoked'].includes(value)?'bad':'warn'));}
function secretFields(f){const input=field(f,'client_secret','OAuth Client Secret · ','password');input.autocomplete='new-password';const link=el('a',msg("tailnets.oauthDocumentation"));link.href='https://tailscale.com/docs/features/oauth-clients';link.target='_blank';link.rel='noopener noreferrer';input.before(link,el('span',msg("tailnets.requiresOnlyDevicesCoreRead"),'muted'));return input;}
function filterNodes(items,params){const q=(params.get('q')||'').toLowerCase(),state=params.get('state');return items.filter(n=>(n.display_name+' '+n.domain).toLowerCase().includes(q)&&(!state||state==='all'||(state==='paused'?!n.enabled:n.state===state)));}
function listFilters(kind){const c=el('form',undefined,'list-filters row'),params=pageParams();const search=field(c,'q',kind==='grant'?msg("grants.searchNodesTailnetsOrOwners"):msg("nodes.searchNodeNamesOrHostnames"),'search',false,params.get('q')||'');
 const states=kind==='grant'?[['',msg("common.all")],['pending',msg("grants.needsMyAction")],['active',msg("common.active")],['ended',msg("grants.ended")]]:[['',msg("common.allStates")],['pending',msg("nodes.pendingEnrollment")],['registered',msg("nodes.registered")],['ready',msg("nodes.reportedReady")],['offline',msg("nodes.controllerContactTimedOut")],['paused',msg("common.paused")],['identity_conflict',msg("nodes.identityConflict")]];const state=select(c,'state',msg("common.filterByStatus"),states);state.value=params.get('state')||'';
 const submit=el('button',msg("common.filter"));submit.type='submit';c.append(submit);c.addEventListener('submit',e=>{e.preventDefault();updatePageParams({q:search.value.trim(),state:state.value,node:null},true);});state.addEventListener('change',()=>updatePageParams({q:search.value.trim(),state:state.value,node:null},true));$('content').append(c);
}
function listEmpty(parent,hasResources,message){const filtered=pageParams().get('q')||(pageParams().get('state')&&pageParams().get('state')!=='pending');parent.append(el('p',filtered?msg("common.noRecordsMatchTheseFilters"):message,'muted'));if(filtered)parent.append(button(msg("common.clearFilters"),()=>updatePageParams({q:null,state:null},true)));}
function addFormCard(title,hasResources){const c=el('details',undefined,'card add-form');c.open=!hasResources;c.append(el('summary',title));c.addEventListener('toggle',()=>{if(c.open)c.querySelector('input')?.focus();});$('content').append(c);return c;}
function directoryAction(g){return g?.state==='requested'?'wait':g?.state==='owner_approved'?'confirm':g?.state==='active'?'view':'request';}
async function tailnets(){
  page(msg("nav.myTailnets"),msg("tailnets.connectATailnetUsingItsStableIDAndA"));
  await scopeSelector();
  const [allItems,retention,nodes,grants]=await Promise.all([api('/tailnets'),api('/settings/retention'),api('/relays'),api('/grants')]);
  const items=allItems.filter(t=>actor.role!=='admin'||resourceScope==='all'||t.owner_id===actor.id);
  const summaries=await Promise.all(nodes.map(n=>api('/nodes/'+n.id+'/summary'))),relays=new Map(summaries.map(s=>[s.node.id,s]));
  const available=grants.filter(g=>g.state==='active');
  for(const t of items){
    const entries=(t.enabled?available.filter(g=>g.tailnet_id===t.id):[]).map(g=>({grant:g,relay:relays.get(g.node_id)})).filter(x=>x.relay);
    const c=el('section',undefined,'card resource-card');
    const header=el('div',undefined,'resource-header'),disclosure=el('details',undefined,'resource-disclosure'),summary=el('summary');
    summary.append(el('strong',t.display_name),el('code',t.api_id),el('span',msg("tailnets.available2",entries.length),'badge'));
    if(actor.role==='admin'&&t.owner_id!==actor.id)summary.append(el('span',managedLabel(t.owner_id),'badge'));
    const details=el('div',undefined,'resource-details'),facts=el('div',undefined,'resource-facts');
    facts.append(actions(status(t.enabled?'active':'paused'),status(t.credential_status)),el('span',t.last_identity_success?msg("tailnets.identityRefreshedCachedUntil",time(t.last_identity_success),time(t.last_identity_success+retention.identity_seconds)):msg("tailnets.noCompleteIdentityRefreshYet"),'muted'));
    details.append(facts);
    table(details,[msg("tailnets.derpNodeProvider"),msg("nodes.hostnamePublicPorts"),msg("tailnets.nodeStatusAccessDeadline")],entries.map(({grant,relay})=>[
      actions(el('span',relay.node.display_name),el('span',msg("nodes.provider",relay.provider),'muted')),
      el('code',relay.node.domain+' · DERP TCP '+relay.node.derp_port+' / STUN UDP '+relay.node.stun_port),
      actions(status(relay.node.state),el('span',grant.explicit_until==='0001-01-01T00:00:00Z'?msg("grants.noAdditionalDeadline"):time(grant.explicit_until)))
    ]));
    disclosure.append(summary,details);
    const mapPanel=el('div',undefined,'resource-map');mapPanel.hidden=true;
    const mapOutput=el('textarea');mapOutput.readOnly=true;mapOutput.setAttribute('aria-label',t.display_name+' DERP map JSON');mapOutput.spellcheck=false;
    mapPanel.append(el('h3','DERP map'),mapOutput);
    const mapMeta=el('p',undefined,'muted'),mapControls=actions(button(msg("tailnets.copyJSON"),()=>copyText(mapOutput.value)),button(msg("tailnets.downloadJSON"),()=>{
      const url=URL.createObjectURL(new Blob([mapOutput.value],{type:'application/json'})),link=el('a');link.href=url;link.download='uniderp-'+t.id+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }));
    const instructions=el('ol');for(const text of [msg("tailnets.openAccessControlsInTheTailscaleAdminConsole"),msg("tailnets.mergeThisJSONIntoTheTopLevelDerpMapField"),msg("tailnets.checkForConflictingRegionIDsAndPreserveExistingRegions"),msg("tailnets.saveThePolicyThenCheckTheDERPConnectionWith")])instructions.append(el('li',text));
    const docs=el('a',msg("tailnets.tailscaleCustomDERPDocumentation"));docs.href='https://tailscale.com/docs/reference/derp-servers/custom-derp-servers';docs.target='_blank';docs.rel='noopener noreferrer';
    const empty=el('div');mapPanel.append(mapMeta,mapControls,instructions,docs,empty);
    mapPanel.id='tailnet-map-'+t.id;
    const controls=el('div',undefined,'resource-actions');
    const mapToggle=button(msg("tailnets.showDERPMap"),async()=>{
      if(!mapPanel.hidden){mapPanel.hidden=true;setText(mapToggle,msg("tailnets.showDERPMap"));mapToggle.setAttribute('aria-expanded','false');return;}
      const result=await api('/tailnets/'+t.id+'/derpmap');mapOutput.value=JSON.stringify(result,null,2);const count=Object.values(result.Regions||{}).reduce((sum,r)=>sum+(r.Nodes?.length||0),0);setText(mapMeta,msg("tailnets.readAt",count,time(new Date().toISOString())));empty.replaceChildren();
      if(!count){const related=grants.filter(g=>g.tailnet_id===t.id),waiting=related.some(g=>g.state==='requested'),confirming=related.some(g=>g.state==='owner_approved');empty.append(el('p',!t.enabled?msg("tailnets.thisTailnetIsPausedNoMapIsAvailable"):confirming?msg("tailnets.theProviderHasApprovedAccessConfirmToContinue"):waiting?msg("tailnets.awaitingProviderApproval"):msg("tailnets.noActiveGrantsCurrentlyHaveValidDevicePermissions"),'muted'));const link=el('a',confirming?msg("grants.confirmAccess"):waiting?msg("tailnets.viewRequest"):msg("tailnets.chooseANode"));link.href=confirming||waiting?'#grants':'#directory';empty.append(link);}
      mapPanel.hidden=false;setText(mapToggle,msg("tailnets.hideDERPMap"));mapToggle.setAttribute('aria-expanded','true');
    });
    mapToggle.setAttribute('aria-controls',mapPanel.id);mapToggle.setAttribute('aria-expanded','false');controls.append(mapToggle);
    controls.append(more(button(msg("tailnets.replaceCredentials"),()=>credential(t)),button(t.enabled?msg("common.pause"):msg("common.enable"),async()=>{await api('/tailnets/'+t.id+'/enabled','POST',{enabled:!t.enabled});await render();}),button(msg("tailnets.deleteCredentials"),async()=>{if(!confirm(msg("tailnets.deleteOAuthCredentialsForThisRevokesItsDevicePermissions",t.display_name)))return;await api('/tailnets/'+t.id+'/credential','DELETE');await render();},'danger'),button(msg("tailnets.deleteTailnet"),async()=>{if(!confirm(msg("tailnets.deleteAllRelatedGrantsWillEndOfflineNodesRetain",t.display_name)))return;await api('/tailnets/'+t.id,'DELETE');await render();},'danger'),...(actor.role==='admin'?[button(msg("tailnets.transfer2"),()=>transfer(t))]:[])));
    header.append(disclosure,controls);c.append(header,mapPanel);$('content').append(c);
  }
  if(!items.length)$('content').append(el('p',msg("tailnets.noTailnetsConnectedYet"),'muted'));
  const f=form(addFormCard(msg("tailnets.connectTailnet"),items.length),msg("tailnets.verifyAndConnect"),async(data,f)=>{const body={display_name:data.get('name'),api_id:data.get('api_id'),credential:{client_secret:data.get('client_secret')}};f.elements.client_secret.value='';await api('/tailnets','POST',body);});
  field(f,'name',msg("common.displayName"));field(f,'api_id',msg("tailnets.tailnetIDTheTIdentifierInGeneralSettings")).autocomplete='off';secretFields(f);done(f);
}
async function transfer(t){
  const users=await api('/users'),c=card(msg("tailnets.transfer",t.display_name));
  const f=form(c,msg("tailnets.transferOwnership"),data=>api('/tailnets/'+t.id+'/transfer','POST',{owner_id:data.get('owner')}));
  select(f,'owner',msg("tailnets.newOwner"),users.filter(u=>u.enabled).map(u=>[u.id,u.username]));done(f);
}
async function credential(t){const c=card(msg("tailnets.replaceCredentialsFor",t.display_name));const f=form(c,msg("tailnets.verifyAndReplace"),async(data,f)=>{const body={client_secret:data.get('client_secret')};f.elements.client_secret.value='';await api('/tailnets/'+t.id+'/credential','POST',body);});secretFields(f);done(f);c.scrollIntoView({behavior:'smooth'});}
async function nodes(){
  page(actor.role==='admin'?msg("nav.nodeManagement"):msg("nav.myNodes"),msg("nodes.manageEnrollmentPublicPortsAccessAndBandwidthRulesPausing"));
  await scopeSelector();
  const allItems=(await api('/nodes')).filter(n=>actor.role!=='admin'||resourceScope==='all'||n.owner_id===actor.id),items=filterNodes(allItems,pageParams()),local=actor.role==='admin'?await api('/local/status'):null;
  if(local&&!local.joined)$('content').append(button(msg("nodes.registerTheBuiltInNode"),async()=>{await api('/local/register','POST',{display_name:local.saved.hostname||'主控内置节点'});await render();},'primary'));
  listFilters('node');for(const n of allItems)visibleNodes.set(n.id,{node:n,editable:true});
  const list=card(msg("nodes.derpNodes"));
  const nodeActions=n=>actions(button(msg("common.status"),()=>nodeState(n)),...(n.state!=='pending'?[button(msg("nodes.rules"),()=>qos(n,true))]:[]),...(local?.node_id===n.id?[button(msg("nodes.localManagement"),()=>{location.hash='member';})]:[]),more(button(msg("nodes.publicPorts"),()=>nodePorts(n)),button(n.state==='pending'?msg("nodes.enrollmentCode"):msg("nodes.reissueEnrollmentCode"),()=>enrollment(n)),button(n.enabled?msg("common.pause"):msg("common.enable"),async()=>{await api('/nodes/'+n.id+'/enabled','POST',{enabled:!n.enabled});await render();}),...(n.state!=='pending'?[button(msg("nodes.hostname"),()=>changeDomain(n))]:[]),button(msg("nodes.deleteNode"),()=>deleteNode(n),'danger')));
  if(!items.length)listEmpty(list,allItems.length,allItems.length?msg("nodes.noNodesToShow"):msg("nodes.addAndEnrollYourFirstDERPNode"));else table(list,[msg("nodes.name"),msg("nodes.hostnamePublicPorts"),msg("common.status"),msg("nodes.lastHeartbeat4"),msg("common.actions")],items.map(n=>[
    actions(button(n.display_name,()=>openNode(n),'resource-name'),...(actor.role==='admin'&&n.owner_id!==actor.id?[el('span',managedLabel(n.owner_id),'badge')]:[]),...(local?.node_id===n.id?[el('span',msg("nodes.builtInNode"),'badge')]:[])),el('code',n.domain+' · DERP TCP '+n.derp_port+' / STUN UDP '+n.stun_port),actions(status(n.state),...(!n.enabled?[status('paused')]:[])),observedTime(n.last_heartbeat),
    nodeActions(n)
  ]));
  list.querySelectorAll('tbody tr').forEach((r,i)=>r.dataset.nodeId=items[i].id);
  if(items.some(n=>n.state==='pending'||n.state==='registered'))limitedRefresh(list,async()=>{const fresh=await api('/nodes');if(!list.isConnected)return false;let pending=false;for(const [i,n]of items.entries()){const updated=fresh.find(x=>x.id===n.id);if(!updated)continue;const row=list.querySelectorAll('tbody tr[data-node-id]')[i];const stateChanged=n.state!==updated.state||n.enabled!==updated.enabled;Object.assign(n,updated);row.children[2].replaceChildren(status(n.state),...(!n.enabled?[status('paused')]:[]));row.children[3].replaceChildren(observedTime(n.last_heartbeat));if(stateChanged)row.children[4].replaceChildren(nodeActions(n));if(updated.state==='pending'||updated.state==='registered')pending=true;}return pending;});
  const f=form(addFormCard(msg("nodes.addDERPNode"),allItems.length),msg("nodes.createNodeAndIssueCode"),async data=>{const result=await api('/nodes','POST',{display_name:data.get('name'),domain:data.get('domain').trim(),derp_port:Number(data.get('derp_port')),stun_port:Number(data.get('stun_port'))});return()=>showEnrollment(result.enrollment,result.node);});field(f,'name',msg("common.displayName"));field(f,'domain',msg("nodes.publicDERPHostname"));publicPortFields(f,{derp_port:443,stun_port:3478});done(f);
}
function publicPortFields(f,n) {
  for(const [name,label] of [['derp_port',msg("nodes.publicDERPTCPPort")],['stun_port',msg("nodes.publicSTUNUDPPort")]]){const input=field(f,name,label,'number',true,n[name]);input.min='1';input.max='65535';input.step='1';}
}
async function nodePorts(n) {
  const c=detailCard(msg("nodes.publicPorts2",n.display_name),'ports-'+n.id);
  c.append(el('p',msg("nodes.enterTheHostMappedOrProxyPortsClientsUse"),'muted'));
  const f=form(c,msg("nodes.savePublicPorts"),data=>api('/nodes/'+n.id+'/ports','POST',{derp_port:Number(data.get('derp_port')),stun_port:Number(data.get('stun_port'))}));
  publicPortFields(f,n);done(f);c.scrollIntoView({behavior:'smooth'});
}
async function changeDomain(n){
  const c=detailCard(msg("nodes.changeHostname",n.display_name),'domain-'+n.id);
  c.append(el('p',msg("nodes.configureDNSTLSAndForwardingForTheNewHostname"),'muted'));
  const f=form(c,msg("nodes.pauseAndVerifyHostname"),async data=>{
    await api('/nodes/'+n.id+'/enabled','POST',{enabled:false});
    const state=await api('/nodes/'+n.id+'/status');
    if(state.control_stream_open && state.applied_revision!==state.desired_revision)throw localizedError(msg("nodes.pausedWaitForTheEmptyPolicyToBeApplied"));
    await api('/nodes/'+n.id+'/domain','POST',{domain:data.get('domain')});
  });field(f,'domain',msg("nodes.newPublicDERPHostname"),'text',true,n.domain);done(f);
}
async function deleteNode(n){
  if(!confirm(msg("nodes.deleteThisRevokesItsClusterIdentityAndEnrollmentCode",n.display_name)))return;
  if(n.state!=='pending'){
    await api('/nodes/'+n.id+'/enabled','POST',{enabled:false});
    const state=await api('/nodes/'+n.id+'/status');
    if(state.control_stream_open && state.applied_revision!==state.desired_revision){await render();notice(msg("nodes.nodePausedWaitForTheEmptyPolicyToBe"),true);return;}
  }
  await api('/nodes/'+n.id,'DELETE');await render();
}
function showEnrollment(e,node){
 const c=detailCard(msg("nodes.enrollmentDetails",node?.display_name||msg("nodes.node")),'enrollment-'+(node?.id||'new')),address=location.origin;
 c.append(el('p',msg("common.controllerHTTPSAddress")),el('pre',address),el('p',msg("nodes.oneTimeEnrollmentCodeExpires",time(e.expires_at))),el('pre',e.code));
 const steps=el('ol');for(const text of [msg("nodes.signInAsTheMemberNodeSLocalAdministrator"),msg("nodes.openLocalNodeJoinAnExistingCluster"),msg("nodes.pasteTheControllerHTTPSAddressAndEnrollmentCodeReturn")])steps.append(el('li',text));c.append(steps);
 c.append(actions(button(msg("nodes.copyAddress"),()=>copyText(address)),button(msg("nodes.copyEnrollmentCode"),()=>copyText(e.code)),button(msg("nodes.copyEnrollmentDetails"),()=>copyText('主控 HTTPS 地址：'+address+'\n一次性注册码：'+e.code+'\n有效期：'+new Date(e.expires_at).toLocaleString(undefined,{timeZoneName:'short'})))));
 const expiry=el('p',undefined,'muted');c.append(expiry);
 if(node)limitedRefresh(c,async()=>{const updated=await api('/nodes/'+node.id);if(!c.isConnected)return false;Object.assign(node,updated);setText(expiry,Date.now()>=new Date(e.expires_at).getTime()?msg("nodes.enrollmentCodeExpiredGenerateANewOne"):msg("nodes.nodeStatus",updated.state==='pending'?msg("nodes.waitingForTheMemberNodeToJoin"):msg("nodes.registeredViewObservations")));if(Date.now()>=new Date(e.expires_at).getTime()){c.append(button(msg("nodes.generateAgain"),()=>enrollment(node)));return false;}return updated.state==='pending';});
}
async function enrollment(n){n=await api('/nodes/'+n.id);if(n.state!=='pending'&&!confirm(msg("nodes.reissueTheCodeForThisReleasesTheCurrentInstance",n.display_name)))return;const e=await api('/nodes/'+n.id+'/enrollment','POST',{});if(await render({preserveScroll:true}))showEnrollment(e,n);}
function probeTable(parent,probes,node) {
  table(parent,[msg("nodes.controllerEndpointCheck"),msg("nodes.result"),msg("nodes.checkedAt")],['derp','stun'].map(name=>[name==='derp'?'HTTPS DERP '+node.domain+':'+node.derp_port:'UDP STUN '+node.domain+':'+node.stun_port,probes?.[name]?.state==='ok'?msg("nodes.successful"):probes?.[name]?.state==='failed'?msg("nodes.failed"):msg("nodes.notChecked"),time(probes?.[name]?.observed_at)]));

}
function ruleSummary(parent,q) {
  const total=q.owner_weight+q.shared_weight;
  table(parent,[msg("bandwidth.budgetGroup"),msg("bandwidth.shareUnderContention"),msg("bandwidth.hardLimit")],[
    [msg("bandwidth.rxTXMbpsEach",q.budget_bps/1000000),msg("bandwidth.meteredByPayloadBytes"),msg("bandwidth.eachDirectionUsesTheTotalBudget")],
    [msg("bandwidth.ownerGroup"),msg("bandwidth.weight2",(q.owner_weight/total*100).toFixed(1),q.owner_weight),msg("bandwidth.totalBudget")],
    [msg("bandwidth.sharedGroup"),msg("bandwidth.weight2",(q.shared_weight/total*100).toFixed(1),q.shared_weight),q.shared_max_bps?(q.shared_max_bps/1000000)+' Mbps':msg("bandwidth.noAdditionalLimit2")]
  ]);
  parent.append(el('p',msg("bandwidth.whenBothGroupsNeedBandwidthWeightsSetTheirShares"),'muted'));
}
async function nodeState(n) {
  const ticket=++detailGeneration,[s,{names}]=await Promise.all([api('/nodes/'+n.id+'/status'),visibleTailnetNames()]);if(ticket!==detailGeneration)return;const c=detailCard(msg("nodes.status2",n.display_name),'state-'+n.id);
 const facts=nodeFacts(s);table(c,[msg("nodes.statusArea"),msg("nodes.controllerRecord2")],[[msg("nodes.devicePermissions"),facts.identity],[msg("nodes.controllerConnection"),facts.connection],[msg("nodes.policyApplication"),facts.application],[msg("nodes.nodeReport"),facts.report]]);
  reportedBudget(c,s);
  c.append(actions(status(s.node.state),...(!s.node.enabled?[status('paused')]:[]),button(msg("nodes.refreshObservations"),()=>nodeState(n))));
  table(c,[msg("nodes.configurationStage"),msg("nodes.revision2"),msg("common.source")],[
    [msg("nodes.desiredConfiguration"),s.desired_revision,msg("nodes.currentControllerPolicy")],
    [msg("nodes.receivedByNode"),s.received_revision,msg("nodes.nodeAcknowledgmentAfterPersistence")],
    [msg("nodes.appliedByNode"),s.applied_revision,msg("nodes.nodeAcknowledgmentAfterDerperApplication")]
  ]);
  if(s.desired_revision>s.applied_revision)c.append(el('p',msg("nodes.waitingForTheNodeToApplyChangesOfflineNodes"),'muted'));
  table(c,[msg("nodes.controllerRecord"),msg("nodes.statusTime")],[
    [msg("nodes.controlStream"),s.control_stream_open?msg("nodes.connected"):msg("nodes.disconnected")],
    [msg("nodes.lastHeartbeat3"),observedTime(s.node.last_heartbeat)],
    [msg("nodes.hostnameVerified"),time(s.domain_verified_at)],
    [msg("nodes.latestApplicationError"),s.node.last_error||msg("nodes.noRecordedErrors")],
    [msg("nodes.permissionStateAtLastApplicationAcknowledgment"),s.reported_usable?msg("nodes.permissionsAvailableAtThatTime"):msg("nodes.noPermissionsAtThatTime")],
    [msg("nodes.currentAccessDeadlines"),s.policy_has_live_keys?msg("nodes.unexpiredDevicePermissions"):msg("nodes.noUnexpiredDevicePermissions")]
  ]);
  table(c,['Tailnet',msg("nodes.validDevices"),msg("nodes.completeIdentityRefresh2"),msg("nodes.identityCacheDeadline"),msg("nodes.controllerContactDeadline"),msg("nodes.explicitAccessDeadline")],s.grants.map(g=>[shortIdentity(g.tailnet_id,names.get(g.tailnet_id)),g.valid_keys,observedTime(g.last_identity_success),time(g.identity_until),time(g.control_until),g.explicit_until==='0001-01-01T00:00:00Z'?msg("grants.noAdditionalDeadline"):time(g.explicit_until)]));
  if(s.node.state==='identity_conflict'&&(actor.role==='admin'||n.owner_id===actor.id)){
    c.append(el('p',msg("nodes.stopOtherInstancesOnTheHostThenSelectThe"),'muted'));
    const f=form(c,msg("nodes.recoverASingleInstance"),data=>api('/nodes/'+n.id+'/recover','POST',{instance_id:data.get('instance')}));
    field(f,'instance',msg("nodes.instanceIDToKeep"),'text',true,s.instance_id||'');done(f);
  }
  c.append(el('h2',msg("nodes.nodeRuntimeReport")));
  if(s.report) {
    table(c,[msg("nodes.sampledAt"),msg("nodes.receivedByController"),msg("nodes.sampledRevision"),msg("nodes.sampledPermissionState")],[[observedTime(s.report.observed_at),observedTime(s.reported_at),s.report.revision,s.report.usable?msg("nodes.permissionsAvailable"):msg("nodes.noPermissions")]]);
    if(s.report.active_connections!==undefined)c.append(el('p',msg("nodes.activeDERPConnectionsAtSampling",s.report.active_connections)));
    const rates=new Map(s.traffic_rates.map(r=>[r.tailnet_id,r]));
    table(c,['Tailnet',msg("bandwidth.cumulativeRXTXPayload"),msg("nodes.averageRXTXMbps"),msg("nodes.sampleInterval"),msg("bandwidth.queuedPayload")],s.report.traffic.map(t=>{const r=rates.get(t.tailnet_id);return[shortIdentity(t.tailnet_id,names.get(t.tailnet_id)),actions(bytes(t.rx_payload_bytes),el('span','/'),bytes(t.tx_payload_bytes)),r?(r.rx_bits_per_second/1000000).toFixed(3)+' / '+(r.tx_bits_per_second/1000000).toFixed(3):msg("nodes.waitingForTwoConsecutiveSamples"),r?msg("time.seconds",r.interval_seconds.toFixed(1)):'—',bytes(t.queued_payload_bytes)];}));
    c.append(el('p',msg("nodes.countersStartWithEachTailnetInTheCurrentDerper"),'muted'));
  } else c.append(el('p',msg("nodes.noRuntimeReportFromTheCurrentNodeInstanceYet"),'muted'));
  c.append(el('h2',msg("nodes.controllerEndpointChecks")));probeTable(c,s.probes,s.node);
  if((actor.role==='admin'||n.owner_id===actor.id)&&['registered','ready','offline'].includes(s.node.state))c.append(button(msg("nodes.checkEndpointsNow"),async()=>{await api('/nodes/'+n.id+'/probe','POST',{});await nodeState(n);}));
  c.scrollIntoView({behavior:'smooth'});
}
async function directory(){
  page(msg("nav.nodeList"),msg("nodes.chooseDERPNodesForYourTailnetYourOwnNodes"));
  if(actor.role==='admin')userNames=new Map((await api('/users')).map(u=>[u.id,u.username]));
  const [nodes,tailnets,grants]=await Promise.all([api('/relays'),api('/tailnets'),api('/grants')]);
  const summaries=await Promise.all(nodes.map(n=>api('/nodes/'+n.id+'/summary'))),active=grants.filter(g=>g.state==='active');for(const s of summaries)visibleNodes.set(s.node.id,{node:s.node,summary:s,editable:actor.role==='admin'||s.node.owner_id===actor.id});
  listFilters('node');const choices=tailnets.filter(t=>actor.role==='admin'||t.owner_id===actor.id).sort((a,b)=>Number(b.owner_id===actor.id)-Number(a.owner_id===actor.id)),context=el('div',undefined,'directory-context'),input=select(context,'tailnet',msg("nodes.tailnetForThisAction"),[['',msg("tailnets.chooseATailnet")],...choices.map(t=>[t.id,t.display_name])]);input.value=choices.find(t=>t.id===pageParams().get('tailnet'))?.id||choices.find(t=>t.owner_id===actor.id)?.id||'';const selected=choices.find(t=>t.id===input.value);input.addEventListener('change',()=>updatePageParams({tailnet:input.value,node:null},true));if(selected)context.append(el('p',selected.owner_id!==actor.id?managedLabel(selected.owner_id):msg("nodes.using",selected.display_name),'muted'));else{const link=el('a',choices.length?msg("nodes.chooseATailnetForThisAction"):msg("nodes.connectYourTailnetFirst2"));link.href='#tailnets';context.append(link);}$('content').append(context);const matching=new Set(filterNodes(nodes,pageParams()).map(n=>n.id));
  const renderGroup=(title,items)=>{
    const group=el('details',undefined,'card resource-group');group.open=true;
    const heading=el('summary');heading.append(el('strong',title),el('span',msg("nodes.count",items.length),'muted'));
    const list=el('div',undefined,'resource-nodes');
    for(const s of items){
      const n=s.node;visibleNodes.set(n.id,{node:n,summary:s,editable:actor.role==='admin'||n.owner_id===actor.id});const usable=active.filter(g=>g.node_id===n.id),nodeCard=el('section',undefined,'resource-card node-card'),header=el('div',undefined,'resource-header'),disclosure=el('details',undefined,'resource-disclosure'),summary=el('summary');
      summary.append(button(n.display_name,()=>openNode(n),'resource-name'),el('span',msg("nodes.provider",s.provider),'muted'),el('span',msg("nodes.available",usable.length),'badge'));
      const details=el('div',undefined,'resource-details');
      details.append(el('p',n.domain+' · DERP TCP '+n.derp_port+' / STUN UDP '+n.stun_port,'muted'),actions(status(n.state),el('span',msg("nodes.lastHeartbeat2",time(n.last_heartbeat)),'muted')));
      table(details,['Tailnet',msg("nodes.accessDeadlineStatus")],usable.map(g=>[
        actions(el('span',g.tailnet_name),el('code',g.tailnet_id)),
        actions(status(g.state),el('span',g.explicit_until==='0001-01-01T00:00:00Z'?msg("grants.noAdditionalDeadline"):time(g.explicit_until)))
      ]));
      disclosure.append(summary,details);
      const controls=el('div',undefined,'resource-actions');
      const grant=selected&&grants.find(g=>g.node_id===n.id&&g.tailnet_id===selected.id),action=directoryAction(grant);if(selected){controls.append(action==='confirm'?button(msg("grants.confirmAccess"),async()=>{await api('/grants/'+grant.id+'/actions','POST',{expected_revision:grant.revision,action:'confirm'});await render({preserveScroll:true});},'primary'):action==='request'?button(msg("grants.requestAccess"),()=>request(n,tailnets,selected.id),'primary'):button(action==='wait'?msg("nodes.viewPendingRequest"):msg("nodes.viewAccessGrant"),()=>{location.hash='#grants?tailnet='+encodeURIComponent(selected.id)+(actor.role==='admin'&&selected.owner_id!==actor.id?'&scope=all':'');}));details.prepend(el('p',grant?grantGuidance(grant,false):msg("nodes.thisTailnetHasNotRequestedAccessToTheNode"),'muted'));}controls.append(button(msg("nodes.rulesAndEndpointChecks"),()=>sharedNodeInfo(visibleNodes.get(n.id))));
      header.append(disclosure,controls);nodeCard.append(header);nodeCard.dataset.nodeId=n.id;list.append(nodeCard);
    }
    if(!items.length)listEmpty(list,nodes.length,msg("nodes.noAvailableNodesInThisGroup"));
    group.append(heading,list);$('content').append(group);
  };
  renderGroup(msg("nodes.yourNodes"),summaries.filter(s=>s.node.owner_id===actor.id&&matching.has(s.node.id)));
  renderGroup(msg("nodes.otherProvidersNodes"),summaries.filter(s=>s.node.owner_id!==actor.id&&matching.has(s.node.id)));
}
async function request(n,tailnets,selectedID){if(!tailnets.length)throw localizedError(msg("grants.connectYourTailnetFirst"));const c=detailCard(msg("grants.requestAccessTo",n.display_name),'request-'+n.id);const f=form(c,msg("grants.requestNodeAccess"),async data=>{const existing=await api('/grants');const g=existing.find(g=>g.node_id===n.id&&g.tailnet_id===data.get('tailnet'));await api('/grants','POST',{node_id:n.id,tailnet_id:data.get('tailnet'),expected_revision:g?.revision||0,explicit_until:data.get('until')?new Date(data.get('until')).toISOString():'0001-01-01T00:00:00Z'});});const choices=tailnets.filter(t=>actor.role==='admin'||t.owner_id===actor.id),input=select(f,'tailnet',msg("grants.tailnetToUse"),[['',msg("tailnets.chooseATailnet")],...choices.map(t=>[t.id,msg("grants.owner3",t.display_name,userNames.get(t.owner_id)||(t.owner_id===actor.id?actor.username:t.owner_id.slice(0,8)))])]);input.required=true;input.value=choices.find(t=>t.id===selectedID)?.id||choices.find(t=>t.owner_id===actor.id)?.id||'';const selected=choices.find(t=>t.id===input.value);if(selected&&selected.owner_id!==actor.id)c.append(el('p',managedLabel(selected.owner_id),'managed-context badge'));input.addEventListener('change',()=>{let context=c.querySelector('.managed-context');if(context)context.remove();const selected=choices.find(t=>t.id===input.value);if(selected&&selected.owner_id!==actor.id)c.append(el('p',managedLabel(selected.owner_id),'managed-context badge'));});field(f,'until',msg("grants.accessDeadlineOptional"),'datetime-local',false);done(f);c.scrollIntoView({behavior:'smooth'});}
function grantNeedsAction(g,incoming,user){return incoming?g.state==='requested'&&g.node_owner_id===user.id:g.state==='owner_approved'&&g.tailnet_owner_id===user.id;}
function grantGuidance(g,incoming){
 if(g.state==='requested')return incoming?msg("grants.awaitingProviderApprovalApproveOrRejectThisRequest"):msg("grants.awaitingProviderApprovalYouWillThenNeedToConfirm");
 if(g.state==='owner_approved')return incoming?msg("grants.approvedAwaitingConfirmationFromTailnetOwner",g.applicant):msg("grants.awaitingTailnetOwnerConfirmationToActivateAccess");
 if(g.state==='active')return msg("grants.accessIsActive");
 return ({revoked:msg("grants.accessRevokedTheTailnetOwnerCanRequestItAgain"),rejected:msg("grants.requestRejectedTheTailnetOwnerCanRequestAccessAgain"),expired:msg("grants.accessExpiredRequestItAgainWithANewDeadline"),cancelled:msg("grants.requestCancelledTheTailnetOwnerCanRequestAccessAgain")})[g.state]||msg("grants.viewTheCurrentAccessStatus");
}
function nodeFacts(s){return {
 identity:s.policy_has_live_keys?msg("nodes.unexpiredDevicePermissionsInTheControllerRecord"):msg("nodes.noUnexpiredDevicePermissionsInTheControllerRecord"),
 connection:s.control_stream_open?msg("nodes.controlStreamConnected"):msg("nodes.controlStreamDisconnectedCachedPermissionsKeepTheirOriginalDeadlines"),
 application:s.applied_revision===s.desired_revision?msg("nodes.nodeReportsDesiredRevisionApplied",s.applied_revision):msg("nodes.waitingForApplicationDesiredReceivedApplied",s.desired_revision,s.received_revision,s.applied_revision),
 report:s.report?msg("nodes.latestReportRevisionSampled",s.report.revision,time(s.report.observed_at),s.report.revision!==s.desired_revision?msg("nodes.differsFromTheDesiredRevision"):''):msg("nodes.noNodeRuntimeReportYet")
};}
async function grants(incoming=false){
  page(incoming?msg("grants.incomingAccessRequests"):msg("nav.nodeAccessGrants"),incoming?msg("grants.approveRequestsToUseYourDERPNodesTheTailnet"):msg("grants.viewTheNodesYourTailnetsUseYourOwnNodes"));
  await scopeSelector();listFilters('grant');const allItems=(await api('/grants')).filter(g=>(actor.role==='admin'&&resourceScope==='all')||(incoming?g.node_owner_id:g.tailnet_owner_id)===actor.id),params=pageParams(),query=(params.get('q')||'').toLowerCase(),filter=params.get('state'),items=allItems.filter(g=>(!params.get('tailnet')||g.tailnet_id===params.get('tailnet'))&&(g.node_name+' '+g.tailnet_name+' '+g.applicant).toLowerCase().includes(query)&&(!filter||filter==='all'||filter==='pending'&&grantNeedsAction(g,incoming,actor)||filter==='active'&&g.state==='active'||filter==='ended'&&['revoked','rejected','expired','cancelled'].includes(g.state)));
  const list=card(incoming?msg("grants.incomingRequests2"):msg("grants.tailnetNodeAccess"));if(!items.length){listEmpty(list,allItems.length,filter==='pending'?msg("grants.noRequestsNeedYourAction"):allItems.length?msg("grants.noAccessGrantsToShow"):incoming?msg("grants.noIncomingRequestsYet"):msg("grants.chooseANodeForYourTailnetFromTheNode"));return;}
  table(list,[msg("nodes.derpNodes"),msg("grants.tailnet"),msg("grants.accessStatusNextStep"),msg("grants.deadlineRevision"),msg("common.actions")],items.map(g=>{
    const owner=incoming&&(actor.role==='admin'||g.node_owner_id===actor.id),applicant=!incoming&&(actor.role==='admin'||g.tailnet_owner_id===actor.id),available=[];
    if(g.state==='requested'){if(owner)available.push(['approve',msg("grants.approveRequest")],['reject',msg("grants.rejectRequest")]);if(applicant)available.push(['cancel',msg("grants.cancelRequest")]);}
    if(g.state==='owner_approved'){if(applicant)available.push(['confirm',msg("grants.confirmAccess")],['cancel',msg("grants.cancelRequest")]);if(owner)available.push(['revoke',msg("grants.revokeAccess")]);}
    if(g.state==='active'){if(owner)available.push(['revoke',msg("grants.revokeAccess")]);if(applicant)available.push(['leave',msg("grants.stopUsing")]);}
    return[actions(el('span',g.node_name),...(actor.role==='admin'&&incoming&&g.node_owner_id!==actor.id?[el('span',managedLabel(g.node_owner_id),'badge')]:[])),actions(el('span',g.tailnet_name),el('span',msg("grants.owner2",g.applicant))),actions(status(g.state),el('p',grantGuidance(g,incoming),'muted')),msg("grants.revision",g.explicit_until==='0001-01-01T00:00:00Z'?msg("grants.noAdditionalDeadline"):time(g.explicit_until),g.revision),actions(...(g.state==='active'&&!incoming?[button(msg("grants.viewDERPMap"),()=>{location.hash='#tailnets';})]:[]),...(applicant&&['revoked','rejected','expired','cancelled'].includes(g.state)?[button(msg("grants.requestAgain"),async()=>request({id:g.node_id,display_name:g.node_name},await api('/tailnets'),g.tailnet_id))]:[]),...available.map(([action,label])=>button(label,async()=>{if(['revoke','leave'].includes(action)&&!confirm(msg("grants.forOnThisTailnetWillNoLongerBeAble",label,g.tailnet_name,g.node_name)))return;await api('/grants/'+g.id+'/actions','POST',{expected_revision:g.revision,action});await render();})),...(['requested','owner_approved','active'].includes(g.state)?[more(button(msg("bandwidth.bandwidthRules2"),()=>qos({id:g.node_id,display_name:g.node_name},false)),button(msg("grants.runtimeStatus"),()=>nodeState({id:g.node_id,display_name:g.node_name,owner_id:g.node_owner_id})))]:[]))];
  }));
}
async function requests(){return grants(true);}
function qosIllustration(q,state){
 const total=q.owner_weight+q.shared_weight;if(!Number.isFinite(total)||q.owner_weight<=0||q.shared_weight<=0||!Number.isFinite(q.budget_bps)||q.budget_bps<=0)return null;
 const r=state.report,current=r&&r.revision===state.desired_revision&&state.applied_revision===state.desired_revision&&Number.isFinite(r.effective_budget_bps),budget=(current?r.effective_budget_bps:q.budget_bps)/1000000,ownerRatio=q.owner_weight/total;
 return {budget,ownerRatio,owner:budget*ownerRatio,shared:budget*(1-ownerRatio),source:current?'report':'input',hasCaps:q.shared_max_bps>0||q.tailnets.some(t=>t.max_bps>0),capsUnknown:!!state.tailnet_caps_unknown};
}
function qosFigure(parent,q,state,names=new Map()){
 parent.replaceChildren();const model=qosIllustration(q,state);if(!model){parent.append(el('p',msg("bandwidth.enterAValidBudgetAndTwoPositiveWeightsTo"),'muted'));return;}
 const caption=el('p',model.source==='report'?msg("bandwidth.allocationUsingTheReportedEffectiveBudgetOfMbpsAnd",model.budget):msg("bandwidth.allocationUsingTheEnteredControllerBudgetOfMbps",model.budget),'muted');parent.append(caption);
 const bar=el('div',undefined,'qos-ratio'),own=el('span',msg("bandwidth.owner",(model.ownerRatio*100).toFixed(1))),shared=el('span',msg("bandwidth.shared",((1-model.ownerRatio)*100).toFixed(1)));own.style.flexBasis=model.ownerRatio*100+'%';shared.style.flexBasis=(1-model.ownerRatio)*100+'%';bar.append(own,shared);setLocalizedAttribute(bar,'aria-label',msg("bandwidth.weightsOwnerShared",q.owner_weight,q.shared_weight));parent.append(bar);
 const suffix=model.hasCaps||model.capsUnknown?msg("bandwidth.beforeAdditionalHardLimits"):msg("bandwidth.noAdditionalGroupOrTailnetLimits");const rows=[[msg("bandwidth.bothGroupsNeedBandwidth"),msg("bandwidth.approximatelyMbps",model.owner.toFixed(2),model.shared.toFixed(2),suffix)],[msg("bandwidth.onlyTheOwnerGroupNeedsBandwidth"),msg("bandwidth.idleCapacityAvailableBudgetMbps",model.budget,suffix)],[msg("bandwidth.onlyTheSharedGroupNeedsBandwidth"),msg("bandwidth.idleCapacityAvailableBudgetMbps",model.budget,suffix)]];table(parent,[msg("bandwidth.demand"),msg("bandwidth.allocationExample")],rows);if(model.capsUnknown)parent.append(el('p',msg("bandwidth.onlyVisibleLimitsAreListedBelow"),'muted'));
 if(model.hasCaps){const caps=[...(q.shared_max_bps?[[msg("bandwidth.sharedGroup"),q.shared_max_bps/1000000+' Mbps']]:[]),...q.tailnets.filter(t=>t.max_bps>0).map(t=>[names.get(t.tailnet_id)||t.tailnet_id.slice(0,8)+'…',t.max_bps/1000000+' Mbps'])];table(parent,[msg("bandwidth.activeHardLimits"),msg("bandwidth.limit")],caps);parent.append(el('p',msg("bandwidth.hardLimitsAlsoCapBorrowedCapacity"),'muted'));}

}
async function qos(n,editable){
 const ticket=++detailGeneration;const [q,state,{tailnets,names}]=await Promise.all([api('/nodes/'+n.id+'/qos'),api('/nodes/'+n.id+'/status'),visibleTailnetNames()]);
 if(ticket!==detailGeneration)return;
 const c=detailCard(msg("bandwidth.bandwidthRules",n.display_name),'qos-'+n.id);
 if(actor.role==='admin'&&n.owner_id!==actor.id&&n.owner_id)c.append(el('p',managedLabel(n.owner_id),'badge'));
 c.append(el('p',msg("bandwidth.controllerBudgetMbpsDesiredRevision",q.budget_bps/1000000,state.desired_revision)));reportedBudget(c,state);ruleSummary(c,q);
 c.append(el('p',msg("bandwidth.onlyTheProviderSTailnetsMayJoinTheOwner"),'muted'));
 if(!editable){const figure=el('div',undefined,'qos-preview');c.append(figure);qosFigure(figure,q,{...state,tailnet_caps_unknown:true},names);table(c,[msg("bandwidth.yourTailnets"),msg("bandwidth.group"),msg("bandwidth.weightWithinGroup"),msg("bandwidth.hardLimit")],q.tailnets.map(r=>[shortIdentity(r.tailnet_id,names.get(r.tailnet_id)),r.group==='owner'?msg("bandwidth.ownerGroup"):msg("bandwidth.sharedGroup"),r.weight,r.max_bps?r.max_bps/1000000+' Mbps':msg("bandwidth.noAdditionalLimit")]));return;}
 const own=new Set(tailnets.filter(t=>t.owner_id===n.owner_id).map(t=>t.id));
 const f=form(c,msg("bandwidth.saveAndDistributeRules"),async data=>{
  const body={budget_bps:Math.round(Number(data.get('budget'))*1000000),owner_weight:Number(data.get('owner')),shared_weight:Number(data.get('shared')),shared_max_bps:Math.round(Number(data.get('shared_max')||0)*1000000),tailnets:q.tailnets.map((r,i)=>({tailnet_id:r.tailnet_id,group:data.get('group'+i),weight:Number(data.get('weight'+i)),max_bps:Math.round(Number(data.get('max'+i)||0)*1000000)}))};
  await api('/nodes/'+n.id+'/qos','POST',body);return()=>qos(n,true);
 });f.successMessage=msg("bandwidth.rulesSavedWaitingForTheNodeToReportApplication");
 for(const [name,label,value]of [['budget',msg("bandwidth.controllerBudgetMbps"),q.budget_bps/1000000],['owner',msg("bandwidth.ownerGroupWeight"),q.owner_weight],['shared',msg("bandwidth.sharedGroupWeight"),q.shared_weight],['shared_max',msg("bandwidth.sharedGroupLimitMbps0ForNoAdditionalLimit"),q.shared_max_bps/1000000]]){
  const input=field(f,name,label,'number',true,value);input.min=['owner','shared'].includes(name)?'1':name==='shared_max'?'0':'0.000008';input.step=['owner','shared'].includes(name)?'1':'any';
 }
 const preview=el('div',undefined,'qos-preview');f.append(preview);const update=()=>qosFigure(preview,{...q,budget_bps:Number(f.elements.budget.value)*1000000,owner_weight:Number(f.elements.owner.value),shared_weight:Number(f.elements.shared.value),shared_max_bps:Number(f.elements.shared_max.value)*1000000,tailnets:q.tailnets.map((r,i)=>({...r,max_bps:f.elements['max'+i]?Number(f.elements['max'+i].value)*1000000:r.max_bps}))},state,names);f.addEventListener('input',update);f.addEventListener('change',update);
 q.tailnets.forEach((r,i)=>{const h=el('h3');h.append(shortIdentity(r.tailnet_id,names.get(r.tailnet_id)));f.append(h);const group=select(f,'group'+i,msg("bandwidth.group"),own.has(r.tailnet_id)?[['owner',msg("bandwidth.ownerGroup")],['shared',msg("bandwidth.sharedGroup")]]:[['shared',msg("bandwidth.sharedGroup")]]);group.value=r.group;const weight=field(f,'weight'+i,msg("bandwidth.tailnetWeight"),'number',true,r.weight);weight.min='1';weight.step='1';const max=field(f,'max'+i,msg("bandwidth.tailnetLimitMbps0ForNoAdditionalLimit"),'number',true,r.max_bps/1000000);max.min='0';max.step='any';});done(f);update();
 if(state.desired_revision!==state.applied_revision)limitedRefresh(c,async()=>{const fresh=await api('/nodes/'+n.id+'/status');if(!c.isConnected)return false;const message=c.querySelector('.application-observation')||el('p',undefined,'application-observation');setText(message,fresh.applied_revision===fresh.desired_revision?msg("bandwidth.nodeReportsRevisionApplied",fresh.applied_revision):msg("bandwidth.waitingForDistributionApplicationDesiredReceivedApplied",fresh.desired_revision,fresh.received_revision,fresh.applied_revision));c.append(message);return fresh.desired_revision!==fresh.applied_revision;});
}
async function account(){page(msg("nav.myAccount"),msg("accounts.changingYourPasswordEndsExistingSessionsSignInAgain"));const f=form(card(msg("accounts.changePassword")),msg("accounts.updatePassword"),async(data,f)=>{const password=data.get('password');f.elements.password.value='';await api('/users/'+actor.id+'/password','POST',{password});await session();});const input=field(f,'password',msg("accounts.newPassword1272Bytes"),'password');input.autocomplete='new-password';done(f);}
const roleNames={admin:msg("auth.controllerAdministrator"),provider:msg("auth.nodeProvider"),member:msg("auth.member")};
async function users(){
 page(msg("nav.accountManagement"),msg("accounts.providersManageTheirNodesAndTailnetsMembersManageTheir"));
 const items=await api('/users');
 table(card(msg("accounts.controllerAccounts")),[msg("accounts.username"),msg("common.role"),msg("common.status"),msg("common.actions")],items.map(u=>[u.username,roleNames[u.role],u.enabled?msg("common.enable"):msg("common.pause"),actions(...(u.role==='admin'?[]:[button(msg("accounts.changeRole"),()=>userRole(u))]),more(button(u.enabled?msg("common.pause"):msg("common.enable"),async()=>{await api('/users/'+u.id+'/enabled','POST',{enabled:!u.enabled});await render();}),button(msg("accounts.resetPassword"),()=>password(u))))]));
 const f=form(card(msg("accounts.createAccount")),msg("accounts.createAccount"),async(data,f)=>{const body={username:data.get('username'),password:data.get('password'),role:data.get('role')};f.elements.password.value='';await api('/users','POST',body);});
 field(f,'username',msg("accounts.username"));select(f,'role',msg("accounts.accountRole"),[['member',msg("auth.member")],['provider',msg("auth.nodeProvider")]]);field(f,'password',msg("accounts.initialPassword1272Bytes"),'password');done(f);
}
async function userRole(u){const c=card(msg("accounts.changeRoleFor",u.username));c.append(el('p',msg("accounts.thisAccountMustSignInAgainAfterARole"),'muted'));const f=form(c,msg("accounts.saveRole"),data=>api('/users/'+u.id+'/role','POST',{role:data.get('role')}));const input=select(f,'role',msg("accounts.accountRole"),[['member',msg("auth.member")],['provider',msg("auth.nodeProvider")]]);input.value=u.role;done(f);c.scrollIntoView({behavior:'smooth'});}
async function password(u){const f=form(card(msg("accounts.resetPasswordFor",u.username)),msg("accounts.resetPassword"),async(data,f)=>{const password=data.get('password');f.elements.password.value='';await api('/users/'+u.id+'/password','POST',{password});});field(f,'password',msg("accounts.newPassword"),'password');done(f);f.scrollIntoView({behavior:'smooth'});}
async function settings(){
 page(msg("nav.clusterSettings"),msg("settings.identityAndControllerContactHaveSeparateRetentionPeriodsFailed"));const q=await api('/settings/retention');const f=form(card(msg("settings.offlineRetention")),msg("settings.saveRetentionPeriods"),data=>api('/settings/retention','POST',{identity_seconds:Number(data.get('identity')),control_seconds:Number(data.get('control'))}));
 for(const [name,label,value]of [['identity',msg("settings.identityCacheRetentionSeconds"),q.identity_seconds],['control',msg("settings.controllerContactRetentionSeconds"),q.control_seconds]]){const input=field(f,name,label,'number',true,value),hint=el('small',undefined,'muted');input.after(hint);const update=()=>{const seconds=Number(input.value);setText(hint,seconds%86400===0?msg("time.days",seconds/86400):seconds%3600===0?msg("time.hours",seconds/3600):msg("time.secondsHours",seconds,seconds/3600));};input.addEventListener('input',update);update();}done(f);
}
async function events(){
 page(msg("nav.eventsAndAudit"),msg("events.filtersApplyToTheLatest200VisibleRecordsRecords"));
 const [events,audit,nodes,tailnets,grants]=await Promise.all([api('/events'),api('/audit'),api('/nodes'),api('/tailnets'),api('/grants')]);
 const resources=new Map();for(const n of nodes)resources.set('node:'+n.id,{name:n.display_name,href:'nodes'});for(const t of tailnets)resources.set('tailnet:'+t.id,{name:t.display_name,href:'tailnets'});for(const g of grants)resources.set('grant:'+g.id,{name:msg("events.sUses",g.applicant,g.tailnet_name,g.node_name),href:g.node_owner_id===actor.id?'requests':'grants'});
 const actionNames={'grant.request':msg("grants.requestAccess"),'grant.approve':msg("grants.approveRequest"),'grant.confirm':msg("grants.confirmAccess"),'grant.cancel':msg("grants.cancelRequest"),'grant.reject':msg("grants.rejectRequest"),'grant.revoke':msg("grants.revokeAccess"),'grant.leave':msg("grants.stopUsing"),'node.create':msg("events.createNode"),'node.enroll':msg("events.enrollNode"),'node.qos':msg("events.updateBandwidthRules"),'node.enabled':msg("events.changeNodeEnabledState"),'node.delete':msg("nodes.deleteNode"),'node.domain.change':msg("events.changeNodeHostname"),'node.domain.verify':msg("events.verifyNodeHostname"),'node.ports.change':msg("events.changePublicPorts"),'node.probe':msg("events.checkNodeEndpoints"),'node.recover':msg("nodes.recoverASingleInstance"),'node.identity_conflict':msg("events.nodeIdentityConflictDetected"),'enrollment.issue':msg("events.issueEnrollmentCode"),'tailnet.create':msg("tailnets.connectTailnet"),'tailnet.enabled':msg("events.changeTailnetEnabledState"),'tailnet.delete':msg("tailnets.deleteTailnet"),'tailnet.transfer':msg("events.transferTailnet"),'credential.replace':msg("events.replaceOAuthCredentials"),'credential.delete':msg("events.deleteOAuthCredentials"),'retention.update':msg("events.changeRetentionPeriods"),'user.create':msg("accounts.createAccount"),'user.role':msg("events.changeAccountRole"),'user.enabled':msg("events.changeAccountEnabledState"),'user.password':msg("events.updateAccountPassword")};
 const resource=(type,id)=>resources.get(type+':'+id)?.name||joinText(joinText(joinText({node:msg("nodes.node"),tailnet:'Tailnet',grant:msg("grants.accessGrants"),user:msg("events.account"),cluster:msg("events.cluster")}[type]||type,' '),id.slice(0,8)),'…');
 const eventMessage=e=>({identity_conflict:msg(e.resource_type==='node'?'events.nodeIdentityConflict':'events.identityConflict'),identity_unavailable:msg('events.identityUnavailable'),authorization_expired:msg('events.authorizationExpired'),policy_apply_failed:msg('events.policyApplyFailed')})[e.kind]||e.message;
 table(card(msg("events.events")),[msg("events.time"),msg("events.resource"),msg("events.event"),msg("common.status")],events.map(e=>[observedTime(e.created_at),shortIdentity(e.resource_id,resource(e.resource_type,e.resource_id)),e.kind==='policy_apply_failed'?actions(el('span',eventMessage(e)),el('code',e.message)):eventMessage(e),e.resolved_at?msg("events.resolvedRecoveredAt",time(e.resolved_at)):msg("events.needsAttention")]));
 const c=card(msg("events.auditLog")),filters=el('div',undefined,'forms');c.append(filters);const user=field(filters,'actor',msg("events.filterByActor"),'search',false),action=field(filters,'action',msg("events.filterByAction"),'search',false),target=field(filters,'resource',msg("events.filterByResource"),'search',false),count=el('p',undefined,'muted'),result=el('div');c.append(count,result);
 const update=()=>{const items=audit.filter(a=>(a.actor_username||a.actor_id).toLowerCase().includes(user.value.toLowerCase())&&(actionNames[a.action]||a.action).toLowerCase().includes(action.value.toLowerCase())&&(resource(a.resource_type,a.resource_id)+' '+a.resource_id).toLowerCase().includes(target.value.toLowerCase()));setText(count,msg("events.showingOfRecordsLatest200VisibleRecords",items.length,audit.length));result.replaceChildren();table(result,[msg("events.time"),msg("events.actualActorAction"),msg("events.resource"),msg("events.details")],items.map(a=>{
  const name=resource(a.resource_type,a.resource_id),item=resources.get(a.resource_type+':'+a.resource_id),r=item?el('a',name):el('span',name);if(item)r.href='#'+item.href+(a.resource_type==='node'?'?node='+a.resource_id:'');
  const details=el('details',undefined,'identity');details.append(el('summary',msg("events.codeAndFullID")),el('code',a.action),el('code',a.resource_id),button(msg("events.copyDetails"),()=>copyText(a.action+'\n'+a.resource_id)));
  return [time(a.created_at),joinText(a.actor_username||a.actor_id,' ',actionNames[a.action]||a.action),r,details];
 }));};[user,action,target].forEach(input=>input.addEventListener('input',update));update();
}
function localState(s) {
 const c=card(msg("settings.localRuntimeStatus"));
 table(c,[msg("settings.field"),msg("common.status")],[[msg("common.role"),s.role==='setup'?msg("settings.awaitingInitialSetup"):s.role==='controller'?msg("nav.controller"):msg("settings.memberNode")],[msg("settings.clusterConnection"),s.joined?(s.control.connected?msg("settings.connectedToController"):msg("settings.registeredControllerDisconnected")):msg("settings.notJoined")],[msg("settings.relayPermissions"),s.control.usable?msg("settings.validPermissionsAvailable"):msg("settings.noValidPermissions")],[msg("settings.receivedAppliedPolicy"),s.control.received_revision+' / '+s.control.applied_revision],[msg("settings.controllerBandwidthBudget"),s.policy_budget_bps?s.policy_budget_bps/1000000+' Mbps':msg("settings.noPolicyYet")],[msg("settings.localBandwidthCeiling"),s.active.max_budget_bps?s.active.max_budget_bps/1000000+' Mbps':msg("bandwidth.noAdditionalLimit")],[msg("settings.effectiveBandwidthBudget2"),s.effective_budget_bps?s.effective_budget_bps/1000000+' Mbps':msg("settings.notApplied")]]);
 if(s.pending_apply||s.apply_error){const link=el('a',s.apply_error?msg("settings.localSettingsFailedToApplyCheckSettingsAndCertificates"):msg("settings.savedLocalSettingsAwaitingApplication"));link.href='#local';c.append(link);}
 table(c,[msg("settings.lastControllerContact"),msg("settings.trafficSampledAt"),msg("settings.activeDERPConnections")],[[observedTime(s.control.last_contact),observedTime(s.control.traffic_observed_at),s.control.active_connections]]);
 if(s.control.traffic?.length)table(c,['Tailnet',msg("bandwidth.cumulativeRXTXPayload"),msg("bandwidth.queuedPayload")],s.control.traffic.map(t=>[shortIdentity(t.tailnet_id),actions(bytes(t.rx_payload_bytes),el('span','/'),bytes(t.tx_payload_bytes)),bytes(t.queued_payload_bytes)]));
 return c;
}

function localApplication(s){
 const c=card(msg("settings.configurationApplication"));c.append(el('p',s.apply_error?msg("settings.applicationFailedCheckSettingsAndCertificates"):s.pending_apply?msg("settings.savedConfigurationAwaitingApplication"):msg("settings.savedAndRunningConfigurationsMatch"),s.apply_error?'error':'muted'));
 const fields=[['role',msg("common.role")],['hostname',msg("nodes.publicDERPHostname")],['derp_listen',msg("settings.derpTCPListener")],['stun_listen',msg("settings.stunUDPListener")],['tls_mode',msg("settings.tlsMode")],['cert_mode',msg("settings.certificateMode")],['derp_port',msg("nodes.publicDERPTCPPort")],['stun_port',msg("nodes.publicSTUNUDPPort")],['max_budget_bps',msg("settings.localBandwidthCeilingMbps")],['logging_level',msg("settings.logLevel")]];
 const differences=fields.filter(([key])=>s.saved[key]!==s.active[key]);
 if(differences.length)table(c,[msg("settings.pendingField"),msg("settings.runningConfiguration"),msg("settings.savedConfiguration")],differences.map(([key,label])=>[label,key==='max_budget_bps'?s.active[key]/1000000+' Mbps':String(s.active[key]),key==='max_budget_bps'?s.saved[key]/1000000+' Mbps':String(s.saved[key])]));
 const link=el('a',msg("settings.viewLocalConnectionAndRuntimeStatus"));link.href='#member';c.append(link);return c;
}

function localConfigForm(s,role,initial=false) {
 const c=card(role==='controller'?msg("settings.builtInDERPNodeConfiguration"):msg("settings.localDERPNodeConfiguration"));
 const q=s.saved;
 c.append(el('p',msg("settings.publicPortsAreClientEndpointsListenerAddressesAreThe"),'muted'));
 const read=data=>({role,hostname:data.get('hostname'),derp_listen:data.get('derp_listen'),stun_listen:data.get('stun_listen'),tls_mode:data.get('tls_mode'),cert_mode:data.get('cert_mode'),derp_port:Number(data.get('derp_port')),stun_port:Number(data.get('stun_port')),max_budget_bps:Math.round(Number(data.get('limit'))*1000000),logging_level:data.get('logging_level')});
 const f=form(c,initial?msg("settings.saveInitialSettings2"):msg("settings.saveConfiguration"),async data=>{
  const settings=read(data);settings.hostname=settings.hostname.trim();await api('/local/settings','POST',settings);
  if(initial&&!(settings.tls_mode==='passthrough'&&settings.cert_mode==='manual')){await api('/local/apply','POST',{});if(!f.isConnected)return;f.dirty=false;history.replaceState(null,'','#member');await session();}
 });
 f.successMessage=msg("settings.configurationSavedApplyItToUpdateTheRunningConfiguration");
 field(f,'hostname',msg("nodes.publicDERPHostname"),'text',true,q.hostname);
 const advanced=el('details',undefined,'state-disclosure');advanced.append(el('summary',msg("settings.advancedListenersAndLogging")));f.append(advanced);field(advanced,'derp_listen',msg("settings.derpTCPListenerAddress"),'text',true,q.derp_listen);field(advanced,'stun_listen',msg("settings.stunUDPListenerAddress"),'text',true,q.stun_listen);
 const tls=select(f,'tls_mode',msg("settings.tlsMode"),[['external',msg("settings.externalProxyTerminatesHTTPS")],['passthrough',msg("settings.passthroughRelayProvidesTLS")]]);tls.value=q.tls_mode;
 const cert=select(f,'cert_mode',msg("settings.certificateMode"),[['none',msg("settings.providedByProxy")],['manual',msg("settings.uploadCertificate2")],['letsencrypt','Let’s Encrypt']]);cert.value=q.cert_mode;
 tls.addEventListener('change',()=>cert.value=tls.value==='external'?'none':'manual');
 publicPortFields(f,q);
 const limit=field(f,'limit',msg("settings.localDERPBandwidthCeilingMbps0ForNoAdditional"),'number',true,q.max_budget_bps/1000000);limit.min='0';limit.step='any';
 c.append(el('p',msg("settings.theLocalCeilingIsStoredIndependentlyEachRXTX"),'muted'));
 const logging=select(advanced,'logging_level',msg("settings.logLevel"),[['info','info'],['warn','warn'],['error','error'],['debug','debug']]);logging.value=q.logging_level;
 done(f);
 const steps=el('p',initial?msg("settings.manualTLSSaveSettingsSaveMatchingCertificateApplySettings"):msg("settings.saveSettingsAndCertificatesThenApplyCertificatesAreChecked"),'steps');c.prepend(steps);
 const certCard=card(msg("settings.uploadCertificate"));
 certCard.id='manual-certificate';
 const certificateNames={not_required:msg("settings.noLocalManualCertificateNeeded"),missing:msg("settings.certificateOrPrivateKeyNotSaved"),invalid:msg("settings.invalidCertificateChainOrPrivateKey"),hostname_mismatch:msg("settings.certificateDoesNotMatchTheSavedHostname"),ready:msg("settings.certificateReady")};
 certCard.append(el('p',joinText(certificateNames[s.certificate?.state]||msg("settings.noCertificateStatusYet"),s.certificate?.state==='ready'?msg("settings.expires",s.certificate.hostname,time(s.certificate.not_after)):''),'muted'));
 certCard.append(el('p',msg("settings.uploadAPEMCertificateChainAndPrivateKeyMatching"),'muted'));
 const upload=form(certCard,msg("settings.saveCertificate"),async(data,f)=>{const certificate=f.elements.certificate.files[0],key=f.elements.private_key.files[0];if(!certificate||!key)throw localizedError(msg("settings.chooseACertificateChainAndPrivateKeyFile"));await api('/local/certificate','POST',{certificate:await certificate.text(),private_key:await key.text()});f.reset();});
 field(upload,'certificate',msg("settings.pemCertificateChain"),'file');field(upload,'private_key',msg("settings.pemPrivateKey"),'file');done(upload);
 upload.successMessage=msg("settings.certificateSavedNotAppliedYet");
 const apply=button(msg("settings.applySavedSettings"),async()=>{await api('/local/apply','POST',{});await session();notice(s.joined?msg("settings.localSettingsApplied"):msg("settings.settingsAppliedEnrollOrJoinFromLocalNode"));if(initial)location.hash='member';});
 apply.disabled=initial&&s.saved.role==='setup';c.append(apply);const updateApply=()=>apply.disabled=f.dirty||(initial&&s.saved.role==='setup');f.addEventListener('input',updateApply);f.addEventListener('change',updateApply);
 const updateCertificate=()=>{const manual=tls.value==='passthrough'&&cert.value==='manual';cert.closest('label').hidden=tls.value==='external';certCard.hidden=!manual;steps.hidden=!manual;setText(f.submitButton,initial?(manual?msg("settings.saveInitialSettings"):msg("settings.saveAndApplyInitialSettings")):msg("settings.saveConfiguration"));};
 tls.addEventListener('change',updateCertificate);cert.addEventListener('change',updateCertificate);updateCertificate();
}

async function bootstrap(){
 const s=await api('/local/status');
 page(msg("nav.initialSetup"),msg("settings.chooseThisInstanceSRoleEachInstanceHasIts"));
 const chooser=card(msg("settings.chooseRole"));
 chooser.append(actions(button(msg("settings.configureAsController"),()=>{document.querySelectorAll('#content .card').forEach(c=>{if(c!==chooser)c.remove();});localConfigForm(s,'controller',true);}),button(msg("settings.joinAnExistingCluster"),()=>{document.querySelectorAll('#content .card').forEach(c=>{if(c!==chooser)c.remove();});localConfigForm(s,'member',true);})));
 if(s.saved.role!=='setup')localConfigForm(s,s.saved.role,true);
 const extra=el('details',undefined,'state-disclosure');extra.append(el('summary',msg("settings.viewSavedConfiguration")));$('content').append(extra);extra.append(el('p',msg("settings.localRoleHostname",s.saved.role,s.saved.hostname||msg("settings.notConfigured2")),'muted'));
}

async function localSettings(){page(msg("nav.localSettings2"),msg("settings.saveThenApplySeparatelyApplyingRestartsTheLocalRelay"));const s=await api('/local/status');localApplication(s);localConfigForm(s,s.role);}

async function member(){
 const controller=serverRole==='controller';
 page(controller?msg("nodes.builtInNode"):msg("nav.localNode2"),controller?msg("settings.manageTheDERPNodeRunningWithTheControllerUnregistering"):msg("settings.manageThisNodeSClusterConnectionAndLocalConfiguration"));
 const s=await api('/local/status'),c=localState(s);
 c.append(button(msg("nav.localSettings2"),()=>{location.hash='local';}));
 if(s.qos){const rules=card(msg("settings.controllerBandwidthRules"));ruleSummary(rules,s.qos);table(rules,['Tailnet',msg("bandwidth.group"),msg("settings.weight"),msg("bandwidth.hardLimit")],s.qos.tailnets.map(t=>[shortIdentity(t.tailnet_id),t.group==='owner'?msg("bandwidth.ownerGroup"):msg("bandwidth.sharedGroup"),t.weight,t.max_bps?t.max_bps/1000000+' Mbps':msg("bandwidth.noAdditionalLimit")]));}
 if(s.joined){table(c,[msg("settings.controllerAddress"),msg("settings.clusterID"),msg("settings.nodeID")],[[s.controller_url,s.cluster_id,s.node_id]]);c.append(button(controller?msg("settings.unregisterLocalNode"):msg("settings.leaveCluster"),async()=>{if(!confirm(controller?msg("settings.unregisterThisClosesLocalDERPConnectionsAndClearsDevice",s.active.hostname):msg("settings.leaveThisClosesLocalDERPConnectionsAndClearsDevice",s.active.hostname)))return;const result=await api('/local/leave','POST',{});await render();notice(controller?msg("settings.localNodeUnregistered"):result.released?msg("settings.leftClusterControllerReleasedTheNode"):msg("settings.leftLocallyTheControllerHasNotConfirmedReleaseReissue"));},'danger'));}
 else if(controller)c.append(button(msg("settings.registerLocalNode"),async()=>{await api('/local/register','POST',{display_name:s.saved.hostname||'主控内置节点'});await render();},'primary'));
 else {const f=form(card(msg("settings.joinAnExistingCluster")),msg("settings.verifyAndJoin"),async(data,f)=>{const body={controller_url:data.get('controller_url'),enrollment_code:data.get('enrollment_code')};f.elements.enrollment_code.value='';await api('/local/join','POST',body);});field(f,'controller_url',msg("common.controllerHTTPSAddress"),'url',true,s.controller_url);const code=field(f,'enrollment_code',msg("settings.oneTimeEnrollmentCode"),'password');code.autocomplete='off';done(f);}
}

async function overview(){
 const localOnly=serverRole==='member',admin=actor.role==='admin';
 page(msg("nav.overview"),localOnly?msg("overview.thisNodeSClusterConnectionBandwidthAndRuntimeStatus"):msg("overview.manageSharedDERPRelaysNodesTailnetsAndAccess"));
 const generation=pageGeneration,reads=await Promise.allSettled([
  localOnly?[]:api(actor.role==='member'?'/relays':'/nodes'),localOnly?[]:api('/tailnets'),localOnly?[]:api('/grants'),admin?api('/local/status'):null
 ]);if(generation!==pageGeneration)return;
 const [allNodes,allTailnets,allGrants,local]=reads.map((r,i)=>r.status==='fulfilled'?r.value:i===3?null:[]),failed=i=>reads[i].status==='rejected';
 if(admin&&!localOnly){try{await scopeSelector();}catch(e){if(e.name==='AbortError')return;persistentError($('content'),errorText(e),render);}}
 const global=admin&&resourceScope==='all',nodeItems=allNodes.filter(n=>!admin||global||n.owner_id===actor.id),tailnetItems=allTailnets.filter(t=>!admin||global||t.owner_id===actor.id),grantItems=allGrants.filter(g=>!admin||global||g.node_owner_id===actor.id||g.tailnet_owner_id===actor.id);
 if(!reads.some(r=>r.status==='rejected')){const next=card(msg("grants.nextStep"));for(const action of nextActions({actor,serverRole,local,nodes:allNodes,tailnets:allTailnets,grants:allGrants})){const link=el('a',action.title);link.href='#'+action.href;next.append(actions(el('span',action.path,'badge'),link));}}
 const root=el('div',undefined,'overview'),hero=el('section',undefined,'overview-hero'+(localOnly||allNodes.length||allTailnets.length?' compact':'')),intro=el('div');
 intro.append(el('p',localOnly?'DERP NODE':'UNIDERP CONTROL','eyebrow'),el('h2',localOnly?(local?.active.hostname||msg("overview.localDERPNode")):msg("overview.manageAndShareDERPRelays")),el('p',localOnly?msg("overview.localCeilingsAndControllerRulesJointlyDetermineRelayBandwidth"):msg("overview.viewAccessRequestsNodeStatusAndTailnetIdentitySources"),'muted'),el('span',joinText(actor.username+' · ',localOnly?msg("auth.nodeAdministrator"):roleNames[actor.role]),'badge'));
 const art=el('div',undefined,'overview-network');art.setAttribute('aria-hidden','true');
 art.innerHTML='<svg viewBox="0 0 260 140"><path class="network-line" d="M44 42 130 70 218 32M44 108 130 70 218 110"/><circle class="network-halo" cx="130" cy="70" r="36"/><rect class="network-core" x="108" y="48" width="44" height="44" rx="12"/><path class="network-glyph" d="M121 62h18M121 70h18M121 78h10"/><circle class="network-peer" cx="44" cy="42" r="11"/><circle class="network-peer" cx="44" cy="108" r="11"/><circle class="network-peer" cx="218" cy="32" r="11"/><circle class="network-peer" cx="218" cy="110" r="11"/></svg>';
 hero.append(intro,art);root.append(hero);$('content').append(root);
 const metrics=el('div',undefined,'overview-metrics');root.append(metrics);
 const metric=(title,value,hint,href)=>{const c=el('a',undefined,'overview-metric');c.href='#'+href;c.append(el('span',title,'muted'),el('strong',value),el('small',hint));metrics.append(c);};
 const panel=(title,href,label)=>{const c=el('section',undefined,'overview-panel'),head=el('div',undefined,'row space'),link=el('a',label);link.href='#'+href;head.append(el('h2',title),link);c.append(head);return c;};
 const item=(parent,title,detail,badge,href)=>{const r=el('div',undefined,'overview-item'),text=el('div'),heading=el('strong',title);if(href){const link=el('a');link.href='#'+href;link.append(heading);text.append(link);}else text.append(heading);const sub=el('small');sub.append(detail instanceof Node?detail:el('span',detail));text.append(sub);r.append(text);if(badge)r.append(badge);parent.append(r);};
 const budget=value=>value?value/1000000+' Mbps':msg("settings.noPolicyYet");
 const localPanel=()=>{
  const c=panel(localOnly?msg("overview.clusterAndLocalNode"):msg("nodes.builtInNode"),'member',msg("overview.manageLocalNode"));
  item(c,local.active.hostname||msg("overview.hostnameNotConfigured"),local.joined?msg("overview.enrolledInCluster"):msg("overview.notEnrolledInCluster"),el('span',local.joined?(local.control.connected?msg("settings.connectedToController"):msg("overview.controllerDisconnected")):msg("overview.notEnrolled"),'badge '+(local.control.connected?'good':'warn')));
  item(c,msg("settings.relayPermissions"),local.control.usable?msg("overview.validDevicePermissionsAvailable"):msg("overview.noValidDevicePermissions"),status(local.control.usable?'valid':'missing'));
  item(c,msg("overview.policyRevision"),msg("overview.receivedApplied",local.control.received_revision,local.control.applied_revision));
  item(c,msg("settings.lastControllerContact"),observedTime(local.control.last_contact));
  if(local.apply_error)c.append(el('p',msg("overview.localSettingsHaveNotAppliedSuccessfullyCheckSettings"),'error'));return c;
 };
 const grid=el('div',undefined,'overview-panels');root.append(grid);
 if(localOnly&&!local){const c=panel(msg("overview.clusterAndLocalNode"),'member',msg("overview.localNode"));persistentError(c,msg("overview.couldNotReadLocalStatusTryAgain"),render);grid.append(c);}
 else if(localOnly){
  metric(msg("overview.effectiveBandwidthBudget"),budget(local.effective_budget_bps),msg("overview.separateRXAndTXBudgets"),'member');
  metric(msg("settings.localBandwidthCeiling"),local.active.max_budget_bps?budget(local.active.max_budget_bps):msg("bandwidth.noAdditionalLimit"),msg("overview.independentOfControllerRules"),'local');
  metric(msg("overview.controllerBudget"),budget(local.policy_budget_bps),msg("overview.cappedByTheLocalCeiling"),'member');
  metric(msg("settings.activeDERPConnections"),local.control.active_connections,msg("overview.latestSample",time(local.control.traffic_observed_at)),'member');
  grid.append(localPanel());const c=panel(msg("overview.nodeConfiguration"),'local',msg("overview.localSettings"));
  item(c,msg("settings.tlsMode"),local.active.tls_mode);item(c,msg("nodes.publicPorts"),'DERP TCP '+local.active.derp_port+' · STUN UDP '+local.active.stun_port);
  item(c,msg("settings.controllerAddress"),local.controller_url||msg("overview.notConfigured"));item(c,msg("settings.configurationApplication"),local.pending_apply?msg("overview.savedAwaitingApplication"):local.apply_error?msg("overview.applicationFailed"):msg("overview.applied"));grid.append(c);
 }else{
  const pending=grantItems.filter(g=>g.state==='requested'||g.state==='owner_approved');
  metric(actor.role==='member'?msg("overview.availableDERPNodes"):admin?msg("overview.clusterDERPNodes"):msg("overview.myDERPNodes"),failed(0)?msg("overview.unknown"):nodeItems.length,failed(0)?msg("overview.couldNotReadNodes"):msg("overview.enabled",nodeItems.filter(n=>n.enabled).length),actor.role==='member'?'directory':'nodes');
  metric(admin?msg("overview.tailnetIdentitySources"):msg("nav.myTailnets"),failed(1)?msg("overview.unknown"):tailnetItems.length,failed(1)?msg("overview.couldNotReadTailnets"):msg("overview.enabledWithValidCredentials",tailnetItems.filter(t=>t.enabled&&t.credential_status==='valid').length),'tailnets');
  metric(global?msg("overview.allActiveGrants"):msg("overview.myActiveGrants"),failed(2)?msg("overview.unknown"):grantItems.filter(g=>g.state==='active'&&(global||g.tailnet_owner_id===actor.id)).length,global?msg("overview.clusterNodeSharing"):msg("overview.myTailnetsUsingSharedNodes"),'grants');
  if(actor.role==='provider')metric(msg("overview.awaitingMyApproval"),failed(2)?msg("overview.unknown"):grantItems.filter(g=>g.state==='requested'&&g.node_owner_id===actor.id).length,msg("overview.requestsReceivedByMyNodes"),'requests');
  metric(global?msg("overview.allGrantsAwaitingConfirmation"):msg("overview.awaitingMyConfirmation"),failed(2)?msg("overview.unknown"):pending.filter(g=>g.state==='owner_approved'&&(global||g.tailnet_owner_id===actor.id)).length,msg("overview.providerApprovedApplicantConfirmationNeeded"),'grants');
  const nodesPanel=panel(actor.role==='member'?msg("overview.availableDERPNodes"):admin?msg("overview.clusterNodes"):msg("nav.myNodes"),actor.role==='member'?'directory':'nodes',msg("overview.viewNodes"));
  for(const n of nodeItems.slice(0,4))item(nodesPanel,n.display_name,actions(el('span',msg("overview.lastHeartbeat",n.domain)),observedTime(n.last_heartbeat)),status(n.enabled?n.state:'paused'));
  if(failed(0))persistentError(nodesPanel,msg("overview.couldNotReadNodesTryAgain"),render);else if(!nodeItems.length)nodesPanel.append(el('p',msg("overview.noNodesYet"),'muted'));grid.append(nodesPanel);
  const tailnetPanel=panel(admin?msg("overview.tailnetIdentitySources"):msg("nav.myTailnets"),'tailnets',msg("overview.manageTailnets"));
  for(const t of tailnetItems.slice(0,4))item(tailnetPanel,t.display_name,actions(el('span',msg("overview.completeIdentityRefresh")),observedTime(t.last_identity_success)),status(t.enabled?t.credential_status:'paused'));
  if(failed(1))persistentError(tailnetPanel,msg("overview.couldNotReadTailnetsTryAgain"),render);else if(!tailnetItems.length)tailnetPanel.append(el('p',msg("overview.connectATailnetToChooseItsDERPNodes"),'muted'));grid.append(tailnetPanel);
  const grantsPanel=panel(msg("grants.accessGrants"),'grants',msg("overview.viewGrants"));
  for(const g of [...pending,...grantItems.filter(g=>g.state==='active')].slice(0,4))item(grantsPanel,g.tailnet_name+' → '+g.node_name,msg("overview.grantRevision",g.revision),status(g.state),g.node_owner_id===actor.id&&g.tailnet_owner_id!==actor.id?'requests':'grants');
  if(failed(2))persistentError(grantsPanel,msg("overview.couldNotReadAccessGrantsTryAgain"),render);else if(!pending.length&&!grantItems.some(g=>g.state==='active'))grantsPanel.append(el('p',msg("overview.noPendingOrActiveAccessGrants"),'muted'));grid.append(grantsPanel);
  if(local)grid.append(localPanel());else if(failed(3)){const c=panel(msg("nodes.builtInNode"),'member',msg("overview.manageLocalNode"));persistentError(c,msg("overview.couldNotReadLocalStatusTryAgain"),render);grid.append(c);}
 }
 const foot=el('div',undefined,'overview-foot row space');foot.append(el('small',msg("overview.readAtControllerAndLocalRecords",time(new Date().toISOString())),'muted'),button(msg("overview.refreshOverview"),render));root.append(foot);
}

function positionNavMarker(){
 const links=document.querySelector('.navigation-links'),marker=links.querySelector('.nav-marker'),active=links.querySelector('a[aria-current="page"]');
 const group=active?.closest('[data-nav-group]');
 if(!group||!group.open){marker.hidden=true;return;}
 const holder=group.querySelector('summary'),target=active.getBoundingClientRect().top-holder.getBoundingClientRect().top+8;
 if(marker.parentElement!==holder||marker.hidden){
  const from=marker.hidden?target:marker.getBoundingClientRect().top-holder.getBoundingClientRect().top;
  marker.style.transition='none';holder.append(marker);marker.style.transform='translateY('+from+'px)';marker.hidden=false;marker.getBoundingClientRect();marker.style.transition='';
 }
 marker.style.transform='translateY('+target+'px)';
}

const views={overview,tailnets,nodes,directory,grants,requests,account,users,settings,events,bootstrap,local:localSettings,member};
async function render(options={}){
 if(!actor||!canDiscardEdits())return false;
 ++detailGeneration;const generation=++pageGeneration,scrollY=window.scrollY;clearTimeout(refreshTimer);
 const address=pageLocation(location.hash,actor.role);let name=address.name,allowed;visibleNodes=new Map();resourceScope=address.params.get('scope')||'mine';
 if(serverRole==='setup')allowed=actor.role==='admin'?['bootstrap','account']:['account'];
 else if(serverRole==='member')allowed=actor.role==='admin'?['overview','member','local','account']:['account'];
 else {
  allowed=['overview','tailnets','directory','grants','account'];
  if(actor.role==='admin'||actor.role==='provider')allowed.push('nodes','requests');
  if(actor.role==='admin')allowed.push('member','local','users','settings','events');
 }
 if(!allowed.includes(name))name=allowed[0];
 if(name!==address.name)history.replaceState(null,'','#'+name);else if(location.hash!=='#'+name+(address.params.size?'?'+address.params.toString():''))history.replaceState(null,'','#'+name+(address.params.size?'?'+address.params.toString():''));
 const changed=currentPage!==name;currentPage=name;
 $('content').classList.toggle('wide',['overview','tailnets','nodes','directory','grants','requests','users','events'].includes(name));
 document.querySelectorAll('.navigation-links a,#account-menu a').forEach(a=>{a.hidden=!allowed.includes(a.hash.slice(1));if(a.hash==='#nodes')setText(a,actor.role==='admin'?msg("nav.nodeManagement"):msg("nav.myNodes"));a.setAttribute('aria-current',a.hash==='#'+name?'page':'false');});
 document.querySelectorAll('[data-nav-group]').forEach(group=>{group.hidden=!Array.from(group.querySelectorAll('a')).some(a=>!a.hidden);if(group.querySelector('a[aria-current="page"]'))group.open=true;});
 positionNavMarker();
 document.body.classList.remove('nav-open');$('nav-toggle').setAttribute('aria-expanded','false');
 try{await views[name]();if(generation!==pageGeneration)return;if(serverRole==='controller'&&(actor.role==='admin'||actor.role==='provider')){const grants=await api('/grants');const link=document.querySelector('a[href="#requests"]'),count=grants.filter(g=>g.node_owner_id===actor.id&&g.state==='requested').length;setText(link,msg("nav.incomingRequests",count?' · '+count:''));}const selected=address.params.get('node');if(selected&&['nodes','directory'].includes(name)){const entry=visibleNodes.get(selected);if(entry)await openNode(entry.node);else{const c=card(msg("nodes.cannotOpenNode"));c.append(el('p',msg("nodes.thisNodeIsNotVisibleHasBeenDeletedOr"),'muted'),button(msg("nodes.backToList"),()=>updatePageParams({node:null},true)));}}if(generation!==pageGeneration)return;if(options.preserveScroll&&!changed)window.scrollTo(0,scrollY);else window.scrollTo(0,0);if(options.focusResource)document.getElementById(options.focusResource)?.focus();return generation===pageGeneration;}catch(e){if(e.name==='AbortError')return;persistentError($('content'),errorText(e),()=>render());if(e.status===401)await session();}finally{if(generation===pageGeneration)$('content').querySelectorAll('.page-loading').forEach(n=>n.remove());}
}
async function session(){try{const result=await api('/session');actor=result.actor;csrf=result.csrf_token;serverRole=result.server_role;}catch(e){actor=csrf=serverRole=undefined;}const logged=!!actor;let needsSetup=false;if(!logged){try{needsSetup=(await api('/setup')).required;}catch(e){notice(errorText(e),true);}}document.body.classList.toggle('logged-in',logged);$('setup').hidden=logged||!needsSetup;$('login').hidden=logged||needsSetup;$('workspace').hidden=!logged;$('account').hidden=!logged;if(!logged)$('content').replaceChildren();if(logged){setText($('account-avatar'),actor.username.slice(0,2).toUpperCase());setText($('account-name'),actor.username);setText($('account-role'),actor.role==='admin'&&serverRole!=='controller'?msg("auth.nodeAdministrator"):roleNames[actor.role]);await render();}}
$('setup-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;const data=new FormData(f);const body={username:data.get('username'),password:data.get('password')};if(body.password!==data.get('password_confirm')){notice(msg("auth.passwordsDoNotMatch"),true);return;}f.elements.password.value=f.elements.password_confirm.value='';const b=f.querySelector('button');b.disabled=true;try{await api('/setup','POST',body);await session();}catch(err){notice(errorText(err),true);if(err.status===409)await session();}finally{b.disabled=false;}});
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;const data=new FormData(f);const body={username:data.get('username'),password:data.get('password')};f.elements.password.value='';const b=f.querySelector('button');b.disabled=true;try{await api('/login','POST',body);resourceScope='mine';userNames=new Map();const address=pageLocation(location.hash,'member');address.params.delete('scope');address.params.delete('node');history.replaceState(null,'','#'+address.name+(address.params.size?'?'+address.params.toString():''));await session();}catch(err){notice(errorText(err),true);}finally{b.disabled=false;}});
$('logout').addEventListener('click',async()=>{try{await api('/logout','POST',{});++pageGeneration;clearTimeout(refreshTimer);actor=csrf=undefined;$('content').replaceChildren();await session();}catch(e){notice(errorText(e),true);}});
$('nav-toggle').addEventListener('click',()=>{const expanded=document.body.classList.toggle('nav-open');$('nav-toggle').setAttribute('aria-expanded',String(expanded));});
configureMenu($('account-toggle'),$('account-menu'));
document.querySelectorAll('[data-theme-choice]').forEach(choice=>choice.addEventListener('click',()=>setTheme(choice.dataset.themeChoice)));
applyTheme();
document.addEventListener('click',e=>{if(document.body.classList.contains('nav-open')&&!e.target.closest('#navigation,#nav-toggle')){document.body.classList.remove('nav-open');$('nav-toggle').setAttribute('aria-expanded','false');}});
window.addEventListener('hashchange',e=>{if(!canDiscardEdits()){history.replaceState(null,'',e.oldURL);return;}render();});
window.addEventListener('beforeunload',e=>{if([...$('content').querySelectorAll('form')].some(f=>f.dirty)){e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(refreshTimer);});
window.addEventListener('resize',positionNavMarker);
document.querySelectorAll('[data-nav-group]').forEach(group=>{group.addEventListener('toggle',positionNavMarker);group.addEventListener('transitionend',positionNavMarker);});
session();
