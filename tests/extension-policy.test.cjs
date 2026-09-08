const test=require('node:test');
const assert=require('node:assert/strict');
const {ExtensionToolCalls,NotificationLeases}=require('../.test-build/app/apps/external/extension-policy.js');
test('tool calls expire and cannot replay under a fresh action envelope',()=>{
 const calls=new ExtensionToolCalls(), request={callId:'call-1',name:'host.notifications.list',arguments:{},issuedAt:1000,expiresAt:2000};
 assert.equal(calls.admit('owner',request,1500),true);
 assert.equal(calls.admit('owner',request,1500),false);
 assert.equal(calls.admit('other',request,1500),true);
 assert.equal(calls.admit('owner',{...request,callId:'expired'},2001),false);
 assert.equal(calls.admit('owner',{...request,callId:'future',issuedAt:100000},1500),false);
 assert.equal(calls.admit('owner',{...request,callId:'array',arguments:[]},1500),false);
});
test('notification leases reject foreign owners, changed epochs, stale content and APK tool actions',()=>{
 let counter=0; const leases=new NotificationLeases(()=>`opaque-${++counter}`), notification={key:'private-native-key',postTime:100}, apk={key:'apk:foreign:private-token',postTime:101};
 const entries=leases.update('owner',1,[notification,apk]);
 assert.equal(leases.resolve('owner',1,entries[0].id,100,[notification]),notification);
 assert.equal(leases.resolve('other',1,entries[0].id,100,[notification]),undefined);
 assert.equal(leases.resolve('owner',2,entries[0].id,100,[notification]),undefined);
 assert.equal(leases.resolve('owner',1,entries[0].id,100,[{...notification,postTime:102}]),undefined);
 assert.equal(leases.resolve('owner',1,entries[1].id,101,[apk],true),undefined);
 assert.equal(leases.update('owner',1,[notification])[0].id,entries[0].id);
 assert.equal(leases.resolve('owner',1,entries[1].id,101,[apk]),undefined);
});
