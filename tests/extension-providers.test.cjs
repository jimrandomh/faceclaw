const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function setup() {
 const module={exports:{}},events=[],requests=[];let accept=true,resolve,reject,progress,cancelled=false,fallbacks=0;
 const platform={feature:()=>({component:"app"}),provider(feature,data,onProgress){requests.push({feature,data});progress=onProgress;if(!accept)return null;return {requestId:'request',promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),cancel(){cancelled=true;reject(new Error('cancel'));},event(){return true;}};}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/apps/external/extension-providers.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,require:name=>name==='./extension-platform'?{extensionPlatform:()=>platform}:{},Uint8Array});
 const callbacks={onTextDelta:(...v)=>events.push(['text',...v]),onToolActivity:v=>events.push(['activity',v]),onTurnDone:v=>events.push(['done',v]),onError:v=>events.push(['error',v])};
 return {api:module.exports,events,requests,start:()=>module.exports.sendExtensionAssistant('prompt',callbacks,()=>{fallbacks++;return {cancel(){}};}),accept:v=>accept=v,resolve:v=>resolve(v),reject:()=>reject(new Error('disconnected')),progress:v=>progress(v),fallbacks:()=>fallbacks,cancelled:()=>cancelled};
}
test('assistant never retries or selects fallback after an unknown dispatch outcome',async()=>{
 const h=setup();h.start();h.reject();await new Promise(setImmediate);assert.equal(h.fallbacks(),0);assert.equal(h.events[0][0],'error');
});
test('assistant only falls back when dispatch did not occur',async()=>{
 const h=setup();h.start();h.resolve({error:'unavailable',dispatched:false});await new Promise(setImmediate);assert.equal(h.fallbacks(),1);
 const h2=setup();h2.accept(false);h2.start();assert.equal(h2.fallbacks(),1);
 const h3=setup();h3.start();h3.resolve({error:'timeout',dispatched:true});await new Promise(setImmediate);assert.equal(h3.fallbacks(),0);
});
test('cancelled assistant drops late streamed text and terminal replies',async()=>{
 const h=setup();const handle=h.start();handle.cancel();h.progress({text:'Late private text'});h.resolve({text:'Late',stopReason:'end_turn'});await new Promise(setImmediate);assert.equal(h.cancelled(),true);assert.equal(h.events.length,0);
});

test('launcher folder tools use one selected provider and validate inputs before dispatch',async()=>{
 const h=setup();const pending=h.api.routeLauncherFolderTool('apps.move_to_folder',{app_id:'calculator',folder:'Games'},['calculator'],40);assert.equal(h.requests[0].feature,'ui.launcher');assert.equal(h.requests[0].data.operation,'folder-tool');h.resolve({ok:true,content:'Moved'});assert.equal((await pending).ok,true);
 const invalid=setup();assert.equal((await invalid.api.routeLauncherFolderTool('apps.move_to_folder',{app_id:'unknown',folder:'Games'},['calculator'],40)).ok,false);assert.equal(invalid.requests.length,0);
 const unknown=setup();const waiting=unknown.api.routeLauncherFolderTool('apps.disband_folder',{folder:'Games'},[],40);unknown.reject();assert.match((await waiting).error,/unknown/);assert.equal(unknown.requests.length,1);
 const malformed=setup();const result=malformed.api.routeLauncherFolderTool('apps.list_folders',{},[],40);malformed.resolve({ok:'true',content:'Unexpected'});assert.equal((await result).ok,false);
});
