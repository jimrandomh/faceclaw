const test = require('node:test')
const assert = require('node:assert/strict')
const { AncsClient } = require('../.test-build/app/g2/ancs-client.js')
const le = n => [n&255,n>>>8&255,n>>>16&255,n>>>24]
function setup(t, token=123) {
  const sent=[], changed=[]
  const client=new AncsClient(async b=>sent.push([...b]), (...args)=>changed.push(args))
  t.after(()=>client.stop()); client.start(token)
  let seq=0
  const frame=(kind,bytes,flags=3,sequence=seq++,nonce=token)=>new Uint8Array([65,78,1,kind,...le(nonce),sequence&255,sequence>>8,flags,...bytes])
  const feed=(kind,bytes)=> {
    if (!bytes.length) return client.receive(frame(kind,[]))
    for(let i=0;i<bytes.length;i+=9) client.receive(frame(kind,bytes.slice(i,i+9),(i===0?1:0)|(i+9>=bytes.length?2:0)))
  }
  const source=(uid,event=0,flags=0)=>feed(1,[event,flags,1,1,...le(uid)])
  const attr=(id,text)=> {const b=[...Buffer.from(text)];return [id,b.length&255,b.length>>8,...b]}
  const details=(uid,title='Hello',body='Private message')=>feed(2,[0,...le(uid),...attr(0,'com.example'),...attr(1,title),...attr(3,body)])
  feed(0,[0]); feed(0,[1])
  return {client,sent,changed,frame,feed,source,attr,details}
}
test('receives fragmented UTF-8 notifications; pre-existing and modified items do not pop up',t=>{
 const x=setup(t); x.source(7); x.feed(3,[]); x.details(7,'Hi 👓','Message café')
 assert.equal(x.client.read()[0].text,'Message café');assert.deepEqual(x.changed.at(-1),['ancs:123:7',true])
 x.source(7,1);x.feed(3,[]);x.details(7,'Updated');assert.equal(x.changed.at(-1)[1],false)
 x.source(8,0,4);x.feed(3,[]);x.details(8);assert.equal(x.changed.at(-1)[1],false)
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
 assert.deepEqual(x.sent.at(-1).slice(8),[0,...le(7),6,7]);x.feed(3,[])
 x.feed(2,[0,...le(7),...x.attr(6,'Accept'),...x.attr(7,'Decline')])
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
