const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { WindowMotion, FrameRequest, DURATION_MS, FRAME_INTERVAL_MS } = require('./index');
const compact = { x: 259, y: 149, width: 288, height: 44 }, expanded = { x: 0, y: 0, width: 571, height: 447 };
test('Android and JavaScript share the approved geometry and content timing fixtures', () => {
 const rows = fs.readFileSync(path.join(__dirname, '../sdk/src/test/resources/window-motion-v1.csv'), 'utf8').trim().split('\n').slice(1);
 for (const row of rows) {
  const [closing, elapsed, x, y, width, height, body, done] = row.split(',').map(Number);
  const motion = new WindowMotion(closing ? expanded : compact, closing ? compact : expanded, !!closing);
  let frame = motion.sample(1000); if (elapsed) frame = motion.sample(1000 + elapsed);
  assert.deepEqual(frame.rect, { x, y, width, height }); assert.equal(frame.bodyVisible, !!body); assert.equal(frame.done, !!done);
 }
 assert.equal(DURATION_MS, 360); assert.equal(FRAME_INTERVAL_MS, 40);
});
test('a stalled renderer skips obsolete progress but delivers the final state once', () => {
 const motion = new WindowMotion(compact, expanded); motion.sample(1000);
 const final = motion.sample(9000); assert.equal(final.done, true); assert.deepEqual(final.rect, expanded); assert.equal(motion.sample(9040), null);
});
test('Back reverses from the last drawn rectangle and clears body immediately', () => {
 const motion = new WindowMotion(compact, expanded); motion.sample(1000); const visible = motion.sample(1324);
 assert.equal(visible.bodyVisible, true); motion.retarget(compact, true);
 const firstClose = motion.sample(5000); assert.deepEqual(firstClose.rect, visible.rect); assert.equal(firstClose.bodyVisible, false);
 assert.deepEqual(motion.sample(5360).rect, compact);
});
test('cancelled transitions cannot emit stale content and returned rectangles cannot mutate state', () => {
 const motion = new WindowMotion(compact, expanded); const first = motion.sample(1); first.rect.x = 999;
 motion.retarget(compact, true); assert.notEqual(motion.sample(2).rect.x, 999); motion.cancel(); assert.equal(motion.sample(3), null);
});
test('frame requests keep only one callback and render the latest state; cancellation rejects late callbacks', () => {
 const pending = [], rendered = []; let state = 0;
 const frames = new FrameRequest(() => rendered.push(state), callback => { pending.push(callback); return pending.length; }, () => {});
 for (state = 0; state < 40; state++) frames.request(); assert.equal(pending.length, 1);
 pending.shift()(); assert.deepEqual(rendered, [40]); frames.request(); const stale = pending.shift(); frames.cancel(); frames.request(); stale(); assert.deepEqual(rendered, [40]); pending.shift()(); assert.deepEqual(rendered, [40, 40]);
});

test('driver skips delayed ticks, emits terminal state, and lets callbacks cancel or reverse safely', () => {
 const {WindowAnimator}=require('./index');let now=0,id=0;const pending=new Map(),frames=[];
 const animator=new WindowAnimator(frame=>frames.push(frame),{now:()=>now,schedule:(fn,delay)=>{pending.set(++id,{fn,delay});return id;},unschedule:key=>pending.delete(key)});
 animator.start(compact,expanded);assert.equal(pending.size,1);assert.equal([...pending.values()][0].delay,40);
 now=200;let tick=[...pending.values()][0].fn;pending.clear();tick();assert.equal(frames.length,2);assert.equal(pending.size,1);
 const visible=frames.at(-1).rect;animator.retarget(compact,true);assert.deepEqual(frames.at(-1).rect,visible);assert.equal(frames.at(-1).bodyVisible,false);
 now=1000;tick=[...pending.values()][0].fn;pending.clear();tick();assert.equal(frames.at(-1).done,true);assert.equal(pending.size,0);
 let calls=0;const cancelling=new WindowAnimator(()=>{calls++;cancelling.cancel();},{now:()=>now,schedule:()=>assert.fail('Cancelled callback must not schedule')});
 cancelling.start(compact,expanded);assert.equal(calls,1);assert.equal(cancelling.isRunning(),false);
});
