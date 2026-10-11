'use strict';
const languageCatalogs={'zh-CN':messagesZh,en:messagesEn};
let languagePreference='auto';
try{const saved=localStorage.getItem('uniderp-language');if(['auto','zh-CN','en'].includes(saved))languagePreference=saved;}catch{}
function automaticLanguage(){for(const value of navigator.languages||[]){if(/^zh(?:-|$)/i.test(value))return 'zh-CN';if(/^en(?:-|$)/i.test(value))return 'en';}return 'en';}
let language=languagePreference==='auto'?automaticLanguage():languagePreference;
class LocalizedText{
 constructor(read,key){this.read=read;this.key=key;}
 toString(){return this.read();}
 toLowerCase(){return String(this).toLowerCase();}
}
function msg(key,...args){
 if(!Object.hasOwn(languageCatalogs.en,key)||!Object.hasOwn(languageCatalogs['zh-CN'],key))throw new Error('Missing translation: '+key);
 return new LocalizedText(()=>languageCatalogs[language][key].replace(/\{(\d+)(?:\|([^|{}]+)\|([^|{}]+))?\}/g,(_,index,singular,plural)=>singular===undefined?String(args[index]??''):Number(args[index])===1?singular:plural),key);
}
function joinText(...parts){return new LocalizedText(()=>parts.map(String).join(''));}
function localizedError(message){const error=new Error(String(message));error.localizedMessage=message;return error;}
function errorText(error){return error.localizedMessage||error.message;}
const textBindings=new Map(),attributeBindings=new Map();
function setText(target,value){
 let binding=textBindings.get(target);
 if(!binding){let node=target;if(target.nodeType===1){node=[...target.childNodes].find(n=>n.nodeType===3&&n.textContent.trim());if(!node){node=document.createTextNode('');target.prepend(node);}}binding={node};textBindings.set(target,binding);}
 binding.value=value;binding.node.textContent=String(value??'');
}
function getText(target){return textBindings.get(target)?.value??target.textContent;}
function setLocalizedAttribute(target,name,value){let attributes=attributeBindings.get(target);if(!attributes){attributes=new Map();attributeBindings.set(target,attributes);}attributes.set(name,value);target.setAttribute(name,String(value));}
function applyLanguage(){
 document.documentElement.lang=language;
 for(const [target,binding]of textBindings){if(!target.isConnected){textBindings.delete(target);continue;}binding.node.textContent=String(binding.value??'');}
 for(const [target,attributes]of attributeBindings){if(!target.isConnected){attributeBindings.delete(target);continue;}for(const [name,value]of attributes)target.setAttribute(name,String(value));}
 document.querySelectorAll('[data-language-choice]').forEach(choice=>choice.setAttribute('aria-checked',String(choice.dataset.languageChoice===languagePreference)));
 document.querySelectorAll('[data-language-select]').forEach(select=>select.value=languagePreference);
}
function setLanguage(preference){languagePreference=preference;try{localStorage.setItem('uniderp-language',preference);}catch{}language=preference==='auto'?automaticLanguage():preference;applyLanguage();}
function initializeLanguage(){
 document.querySelectorAll('[data-i18n]').forEach(target=>setText(target,msg(target.dataset.i18n)));
 for(const attribute of ['aria-label','title'])document.querySelectorAll('[data-i18n-'+attribute+']').forEach(target=>setLocalizedAttribute(target,attribute,msg(target.getAttribute('data-i18n-'+attribute))));
 document.querySelectorAll('[data-language-choice]').forEach(choice=>choice.addEventListener('click',()=>setLanguage(choice.dataset.languageChoice)));
 document.querySelectorAll('[data-language-select]').forEach(select=>select.addEventListener('change',()=>setLanguage(select.value)));
 applyLanguage();
}
function localizedTime(value,relative=false){
 const date=new Date(typeof value==='number'?value*1000:value);
 if(!value||value==='0001-01-01T00:00:00Z'||!Number.isFinite(date.getTime()))return msg('common.noObservationYet');
 return new LocalizedText(()=>{if(!relative)return date.toLocaleString(language,{timeZoneName:'short'});const seconds=Math.round((date-Date.now())/1000),amount=Math.abs(seconds),unit=amount<60?'second':amount<3600?'minute':amount<86400?'hour':'day',divisor={second:1,minute:60,hour:3600,day:86400}[unit];return new Intl.RelativeTimeFormat(language,{numeric:'auto'}).format(Math.round(seconds/divisor),unit);});
}
function validateTranslations(){
 const keys=Object.keys(messagesEn),signature=value=>[...new Set([...value.matchAll(/\{(\d+)(?:\|[^{}]+)?\}/g)].map(match=>match[1]))].sort().join(',');
 if(keys.length!==Object.keys(messagesZh).length)throw new Error('Catalog key counts differ');
 for(const key of keys)if(!Object.hasOwn(messagesZh,key)||signature(messagesEn[key])!==signature(messagesZh[key]))throw new Error('Translation placeholders differ: '+key);
}
window.addEventListener('languagechange',()=>{if(languagePreference==='auto'){language=automaticLanguage();applyLanguage();}});
applyLanguage();
