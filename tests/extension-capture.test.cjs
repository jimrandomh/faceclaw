const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), ts=require('typescript');
function setup() {
 const module={exports:{}}, calls=[], captures=[], refinements=[]; let allowed=true,ownAllowed=true,locked=false,screenOn=true,now=100000,key="host-private-test-key";
 const shell={isScreenOn:()=>screenOn,canShowExtensionOverlay:()=>true,startExternalAppCapture(...args){ captures.push(args); return {finish(){calls.push({type:'finish'});},cancel(){args[3]('cancelled');}}; }};
 const imports={'@nativescript/core':{},'../../ui/shell/shell':{shell},'../../native/anthropic':{refineHostDictation(options){refinements.push(options);return {cancel(){calls.push({type:'backend-cancel'});}};}},'../../ui/dashboard-settings':{anthropicApiKeySetting:{get:()=>key}},'./extension-policy':require('../.test-build/app/apps/external/extension-policy.js')};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/apps/external/platform.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,require:name=>imports[name]||{},Date:{now:()=>now},global:{isAndroid:false},setTimeout,clearTimeout});
 const platform=Object.create(module.exports.ExternalAppPlatform.prototype),state={window:{windowId:'window'},ready:true,visible:true,lastInput:now};
 platform.extensions={onNativeEvent:()=>false,clearOwnNotifications:()=>{}};platform.windows=new Map([['app',state]]);platform.options={isLocked:()=>locked};
 platform.native={allows:()=>allowed,isExtensionGranted:()=>ownAllowed,send:(_,type,json)=>calls.push({type,data:JSON.parse(json)})};
 const data={requestId:'capture-id',label:'Draft',ownTranscription:true};
 return {platform,state,calls,captures,refinements,data,key:v=>key=v,begin:()=>platform.onEvent('app','capture-dictation',data),advance:n=>now+=n,allowed:v=>allowed=v,own:v=>ownAllowed=v,lock:v=>locked=v,screen:v=>screenOn=v};
}
test('capture needs visible fresh dictation grant and separate own transcription grant',()=>{
 for(const deny of [h=>h.advance(5001),h=>h.allowed(false),h=>h.own(false),h=>h.lock(true),h=>h.screen(false),h=>h.state.visible=false,h=>h.data.requestId='a'.repeat(129),h=>h.data.ownTranscription='true']){
  const h=setup();deny(h);h.begin();assert.equal(h.captures.length,0);assert.equal(h.calls[0].type,'capture-dictation-closed');
 }
 const h=setup();h.begin();assert.equal(h.state.lastInput,0);assert.equal(h.state.reviewPurpose,'capture');assert.equal(h.captures[0][5].component,'app');assert.equal(h.captures[0][5].captureId,'capture-id');
});
test('raw capture output is draft-purpose only and revocation invalidates callbacks',()=>{
 const h=setup();h.begin();h.captures[0][1]({text:'Authoritative final',isFinal:true});
 assert.equal(h.calls[0].type,'capture-dictation-transcript');assert.equal(h.calls[0].data.purpose,'capture');assert.equal(h.calls[0].data.confirmed,undefined);
 h.own(false);h.captures[0][1]({text:'Revoked',isFinal:true});assert.equal(h.calls.length,1);
});
test('capture cancellation and finish are isolated from search and reviewed-send requests',()=>{
 const h=setup();h.begin();h.platform.onEvent('app','cancel-search-dictation',{requestId:'capture-id'});assert.equal(h.state.reviewPurpose,'capture');
 h.platform.onEvent('app','finish-capture-dictation',{requestId:'wrong'});assert.equal(h.calls.length,0);
 h.platform.onEvent('app','finish-capture-dictation',{requestId:'capture-id'});assert.equal(h.calls[0].type,'finish');
 h.platform.onEvent('app','cancel-capture-dictation',{requestId:'capture-id'});assert.equal(h.state.reviewId,undefined);assert.equal(h.calls[1].type,'capture-dictation-closed');
 h.captures[0][1]({text:'Late',isFinal:true});assert.equal(h.calls.length,2);
});

test('host refinement requires an owning visible grant and one fresh gesture or exact completed capture',()=>{
 const request={requestId:'refine-id',original:'Draft',followup:'Add this'};
 for(const deny of [h=>h.advance(5001),h=>h.allowed(false),h=>h.lock(true),h=>h.screen(false),h=>h.state.visible=false,h=>h.key(''),h=>h.state.cancelReview=()=>{}]) {
  const h=setup();deny(h);h.platform.onEvent('app','host-refinement',request);assert.equal(h.refinements.length,0);assert.equal(h.calls[0].type,'host-refinement-rejected');
 }
 const h=setup();h.begin();h.captures[0][1]({text:'Add this',isFinal:true});h.captures[0][3]('complete');h.advance(6000);
 h.platform.onEvent('app','host-refinement',{...request,followup:'Different'});assert.equal(h.refinements.length,0);
 h.platform.onEvent('app','host-refinement',request);assert.equal(h.refinements.length,1);assert.equal(h.state.completedCapture,undefined);
 h.refinements[0].onDone('Draft plus this');assert.equal(h.calls.at(-1).type,'host-refinement-result');assert.equal(h.calls.at(-1).data.text,'Draft plus this');assert.equal(JSON.stringify(h.calls).includes('host-private-test-key'),false);
 h.platform.onEvent('app','host-refinement',request);assert.equal(h.refinements.length,1);
});
test('capture cancellation, stale transcript and revoked ownership cannot authorize host refinement',()=>{
 for(const invalidate of [h=>h.captures[0][3]('cancelled'),h=>{h.captures[0][3]('complete');h.advance(30001);},h=>{h.captures[0][3]('complete');h.platform.cancelOwnedWork(h.state); }]) {
  const h=setup();h.begin();h.captures[0][1]({text:'Add this',isFinal:true});invalidate(h);h.platform.onEvent('app','host-refinement',{requestId:'refine-id',original:'Draft',followup:'Add this'});assert.equal(h.refinements.length,0);
 }
 const h=setup();h.platform.onEvent('app','host-refinement',{requestId:'refine-id',original:'Draft',followup:'Add this'});h.allowed(false);h.refinements[0].onDone('Sensitive result');assert.equal(h.calls.at(-1).type,'host-refinement-rejected');
});
test('host refinement cancels only owned request and ignores late backend output',()=>{
 const h=setup();h.platform.onEvent('app','host-refinement',{requestId:'refine-id',original:'Draft',followup:'Add this'});
 h.platform.onEvent('app','cancel-host-refinement',{requestId:'wrong'});assert.ok(h.state.refinement);
 h.platform.onEvent('app','cancel-host-refinement',{requestId:'refine-id'});assert.equal(h.state.refinement,undefined);assert.equal(h.calls.at(-1).type,'backend-cancel');
 const count=h.calls.length;h.refinements[0].onDone('Late');assert.equal(h.calls.length,count);
});
test('self-open cannot address another component or interrupt locked, sleeping or protected UI',()=>{
 for(const deny of [h=>h.lock(true),h=>h.screen(false),h=>h.state.protected=true]) {const h=setup();h.platform.open=(...args)=>h.calls.push({type:'open',args});deny(h);h.platform.onEvent('app','request-open-window',{target:'thread',component:'other'});assert.equal(h.calls.length,0);}
 const h=setup();h.platform.open=(...args)=>h.calls.push({type:'open',args});h.platform.onEvent('app','request-open-window',{target:'thread',component:'other'});assert.deepEqual(h.calls[0].args,['app','thread']);assert.equal(h.state.lastInput,0);
});
