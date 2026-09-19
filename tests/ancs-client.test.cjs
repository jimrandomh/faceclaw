const test = require('node:test')
const assert = require('node:assert/strict')
const { AncsClient } = require('../.test-build/app/g2/ancs-client.js')
const le = n => [n&255,n>>>8&255,n>>>16&255,n>>>24]
function setup(t, token=123, maxWrite=20) {
  const sent=[], changed=[]
  const client=new AncsClient(async b=>sent.push([...b]), (...args)=>changed.push(args))
  t.after(()=>client.stop()); client.start(token,maxWrite)
  let seq=0
  const frame=(kind,bytes,flags=3,sequence=seq++,nonce=token)=>new Uint8Array([65,78,1,kind,...le(nonce),sequence&255,sequence>>8,flags,...bytes])
  const feed=(kind,bytes)=> {
    if (!bytes.length) return client.receive(frame(kind,[]))
    for(let i=0;i<bytes.length;i+=9) client.receive(frame(kind,bytes.slice(i,i+9),(i===0?1:0)|(i+9>=bytes.length?2:0)))
  }
  const source=(uid,event=0,flags=0)=>feed(1,[event,flags,1,1,...le(uid)])
  const attr=(id,text)=> {const b=[...Buffer.from(text)];return [id,b.length&255,b.length>>8,...b]}
  const details=(uid,title='Hello',body='Private message',appId='com.example')=>feed(2,[0,...le(uid),...attr(0,appId),...attr(1,title),...attr(3,body)])
  const metadata=(uid,{subtitle='',size='',date='',positive='',negative=''}={})=>feed(2,[0,...le(uid),...attr(2,subtitle),...attr(4,size),...attr(5,date),...attr(6,positive),...attr(7,negative)])
  const appName=(appId,name)=>feed(2,[1,...Buffer.from(appId),0,...attr(0,name)])
  const deliver=(uid,appId='com.example',meta={})=> {
    source(uid);feed(3,[]);details(uid,'Hello','Private message',appId);feed(3,[]);metadata(uid,meta)
  }
  const restart=()=>{seq=0;client.start(token,maxWrite);feed(0,[0]);feed(0,[1])}
  feed(0,[0]); feed(0,[1])
  return {client,sent,changed,frame,feed,source,attr,details,metadata,appName,deliver,restart}
}
test('receives fragmented UTF-8 notifications; pre-existing and modified items do not pop up',t=>{
 const x=setup(t); x.source(7); x.feed(3,[]); x.details(7,'Hi 👓','Message café')
 x.feed(3,[]);x.metadata(7)
 assert.equal(x.client.read()[0].text,'Message café');assert.deepEqual(x.changed.at(-1),['ancs:123:7',true])
 x.source(7,1);x.feed(3,[]);x.details(7,'Updated');x.feed(3,[]);x.metadata(7);assert.equal(x.changed.at(-1)[1],false)
 x.source(8,0,4);x.feed(3,[]);x.details(8);x.feed(3,[]);x.metadata(8);assert.equal(x.changed.at(-1)[1],false)
 assert.ok(x.sent.every(p=>p.length<=20))
})
test('removal during retrieval cannot resurrect notification',t=>{
 const x=setup(t);x.source(7);x.source(7,2);x.details(7);x.feed(3,[])
 assert.deepEqual(x.client.read(),[])
})
test('modification during retrieval ignores old text then retrieves new revision',t=>{
 const x=setup(t);x.source(7);x.source(7,1);x.details(7,'Old');x.feed(3,[])
 assert.deepEqual(x.client.read(),[]);x.feed(3,[]);x.details(7,'New');assert.equal(x.client.read()[0].title,'New')
})
test('disconnect, reused UID and delayed old-token packets cannot expose old content',t=>{
 const x=setup(t);x.source(7);x.feed(3,[]);x.details(7);const key=x.client.read()[0].key
 x.client.stop();assert.deepEqual(x.client.read(),[]);assert.equal(x.client.action(key,1),false)
 x.client.start(456);x.client.receive(x.frame(1,[0,0,1,1,...le(7)],3,0,123));assert.deepEqual(x.client.read(),[])
 assert.equal(x.client.state,'starting')
})
test('sequence gaps and oversized attributes fail closed and erase partial state',t=>{
 const x=setup(t);x.source(7);x.client.receive(x.frame(2,[0,...le(7),0,255,255],3,33));assert.equal(x.client.state,'unavailable');assert.deepEqual(x.client.read(),[])
})
test('attribute overflow is rejected without allocation from untrusted lengths',t=>{
 const x=setup(t);x.source(7);x.feed(2,[0,...le(7),0,255,255]);assert.equal(x.client.state,'unavailable')
})
test('actions use supplied labels; local Dismiss never sends negative action',t=>{
 const x=setup(t);x.source(7,0,24);x.details(7);x.feed(3,[])
 assert.deepEqual(x.sent.at(-1).slice(8),[0,...le(7),2,128,0,4,5,6,7]);x.feed(3,[])
 x.metadata(7,{positive:'Accept',negative:'Decline'})
 const n=x.client.read()[0];assert.deepEqual(n.actions.map(a=>a.title),['Accept','Decline'])
 assert.equal(x.client.action(n.key,0),true);assert.deepEqual(x.sent.at(-1).slice(8),[2,...le(7),0]);x.feed(3,[])
 const count=x.sent.length;assert.equal(x.client.dismiss(n.key),true);assert.equal(x.sent.length,count)
})
test('does not start next CP transaction before previous write response',t=>{
 const x=setup(t);x.source(1);x.source(2);x.details(1);assert.equal(x.sent.length,2)
 x.feed(3,[]);assert.equal(x.sent.length,3)
})
test('active notifications and pending work are bounded',t=>{
 const x=setup(t);for(let i=0;i<150;i++) x.source(i)
 assert.ok(x.client.sources.size<=128);assert.ok(x.client.queue.length<=128)
})

test('stop during retry uses the firmware token actually sent, not the next attempt token',t=>{
 const x=setup(t);x.client.receive(x.frame(1,[0,0,1,1,...le(7)],3,99))
 assert.equal(x.client.state,'unavailable');assert.deepEqual([...x.client.stopCommand().slice(4)],le(123))
})
test('malformed UTF-8 preserves the valid text prefix',t=>{
 const x=setup(t);x.source(7);x.feed(3,[])
 x.feed(2,[0,...le(7),...x.attr(0,'com.example'),...x.attr(1,'Hello'),3,3,0,65,66,0xc3])
 assert.equal(x.client.read()[0].text,'AB�')
})

test('startup diagnostics distinguish missing reply from an incomplete subscription', t => {
 t.mock.timers.enable({apis:['setTimeout']})
 const logs=[]; const client=new AncsClient(async()=>{},()=>{},message=>logs.push(message))
 t.after(()=>client.stop());client.start(123)
 t.mock.timers.tick(10000)
 assert.equal(client.state,'unavailable');assert.match(client.statusMessage,/No notification relay response/)
 t.mock.timers.tick(5000)
 client.receive(new Uint8Array([65,78,1,0,...le(124),0,0,3,0]))
 t.mock.timers.tick(10000)
 assert.equal(client.state,'unavailable');assert.match(client.statusMessage,/did not finish subscribing/)
 assert.ok(logs.some(message=>message.includes('accepted notification relay START')))
})

test('relay errors have a distinct message and clear any displayed content', t => {
 const x=setup(t);x.source(7);x.feed(3,[]);x.details(7)
 x.feed(0,[2]);assert.equal(x.client.state,'unavailable')
 assert.match(x.client.statusMessage,/reported a notification relay error/)
 assert.deepEqual(x.client.read(),[])
})

test('requests every notification attribute and uses the app display name for the first popup',t=>{
 const x=setup(t,123,185), id='net.superblock.Pushover'
 x.deliver(7,id,{subtitle:'A subtitle',size:'1024',date:'20260919T123456'})
 assert.deepEqual(x.sent[1].slice(8),[0,...le(7),0,1,128,0,3,0,2])
 assert.deepEqual(x.sent[2].slice(8),[0,...le(7),2,128,0,4,5,6,7])
 assert.deepEqual(x.sent.at(-1).slice(8),[1,...Buffer.from(id),0,0])
 assert.equal(x.client.read()[0].appName,'Pushover')
 assert.equal(x.changed.some(([,popup])=>popup),false)
 // Fragment the actual ANCS Data Source response, including the app ID and UTF-8.
 x.feed(3,[])
 for (const byte of [1,...Buffer.from(id),0,...x.attr(0,'Pushover — 通知')]) x.feed(2,[byte])
 const n=x.client.read()[0]
 assert.equal(n.appName,'Pushover — 通知');assert.equal(n.packageName,id)
 assert.equal(n.subText,'A subtitle');assert.equal(n.messageSize,1024)
 assert.equal(n.when,new Date(2026,8,19,12,34,56).getTime())
 assert.deepEqual(x.changed.at(-1),['ancs:123:7',true])
 assert.equal(x.client.state,'ready')
})

test('app names are cached per session and a name update does not trigger another popup',t=>{
 const x=setup(t,123,185), id='com.example'
 x.deliver(1,id);x.appName(id,'Example App')
 assert.equal(x.changed.filter(([,popup])=>popup).length,1)
 const count=x.sent.length
 x.source(2);assert.equal(x.sent.length,count) // Still waiting for app CP acknowledgement.
 x.feed(3,[]);x.feed(3,[]);x.details(2);x.feed(3,[]);x.metadata(2)
 assert.equal(x.sent.filter(p=>p[8]===1).length,1)
 assert.ok(x.client.read().every(n=>n.appName==='Example App'))
 assert.equal(x.changed.filter(([,popup])=>popup).length,2)
 x.restart();x.deliver(1,id)
 assert.equal(x.client.read()[0].appName,'example')
 assert.equal(x.sent.filter(p=>p[8]===1).length,2)
 x.feed(3,[]);x.appName(id,'New Session Name')
 assert.equal(x.client.read()[0].appName,'New Session Name')
})

test('missing display names use and cache the final bundle-ID component',t=>{
 for(const name of ['', '   ', 'net.superblock.Pushover']) {
  const x=setup(t,123,185), id='net.superblock.Pushover'
  x.deliver(1,id);x.feed(3,[]);x.appName(id,name)
  assert.equal(x.client.read()[0].appName,'Pushover')
  x.deliver(2,id)
  assert.equal(x.sent.filter(p=>p[8]===1).length,1)
 }
})

test('minimum MTU and relay command limit fall back without sending an oversized app request',t=>{
 for(const [maxWrite,id,expected,canRequest] of [
  [20,'net.superblock.Pushover','Pushover',false],
  [20,'com.short','short',true],
  [80,'a'.repeat(67)+'.X','X',true],
  [185,'a'.repeat(68)+'.X','X',false],
  [185,'','Unknown app',false],
  [185,'com.bad\0id','bad\0id',false],
 ]) {
  const x=setup(t,123,maxWrite);x.deliver(1,id)
  assert.equal(x.client.read()[0].appName,expected)
  assert.equal(x.sent.some(p=>p[8]===1),canRequest)
  assert.ok(x.sent.every(p=>p.length<=Math.min(maxWrite,80)))
  if(!canRequest) assert.deepEqual(x.changed.at(-1),['ancs:123:1',true])
 }
})

test('app response must match the requested identifier and reject malformed attributes',t=>{
 for(const response of [
  x=>[1,...Buffer.from('com.wrong'),0,...x.attr(0,'Wrong')],
  x=>[1,...Buffer.from('com.example'),0,0,1,2],
  x=>[1,...Buffer.from('com.example'),0,...x.attr(1,'Wrong attribute')],
  x=>[1,...Buffer.from('com.exampleX')],
 ]) {
  const x=setup(t,123,185);x.deliver(1);x.feed(2,response(x))
  assert.equal(x.client.state,'unavailable');assert.deepEqual(x.client.read(),[])
 }
})

test('removal or modification during app lookup cannot resurrect or pop up a stale notification',t=>{
 for(const event of [1,2]) {
  const x=setup(t,123,185);x.deliver(1);x.source(1,event)
  x.appName('com.example','Example App');x.feed(3,[])
  assert.equal(x.changed.some(([,popup])=>popup),false)
  if(event===2) assert.deepEqual(x.client.read(),[])
  else {
   x.feed(3,[]);x.details(1,'Updated');x.feed(3,[]);x.metadata(1)
   assert.equal(x.client.read()[0].title,'Updated')
   assert.equal(x.client.read()[0].appName,'Example App')
   assert.equal(x.changed.at(-1)[1],false)
  }
 }
})

test('missing or invalid date and message size preserve arrival time and omit invalid size',t=>{
 for(const [date,size] of [['',''],['20260230T123456','oops'],['20260919T256100','9007199254740992']]) {
  const x=setup(t);x.deliver(1,'com.example',{date,size})
  const n=x.client.read()[0]
  assert.equal(n.when,n.postTime);assert.equal(n.messageSize,undefined)
 }
})
