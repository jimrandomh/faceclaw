const test = require('node:test');
const assert = require('node:assert/strict');
const { DrawExpression: E, ExprOp, varint, DrawBytes, evaluate } = require('../.test-build/app/graphics/draw-expression.js');
const { DrawOp, SCREEN, encodeDisplayList, readDisplayList, paintDisplayList } = require('../.test-build/app/graphics/display-list.js');
const { GrayImage } = require('../.test-build/app/graphics/image.js');
const { encodePresentation } = require('../.test-build/app/graphics/presentation-wire.js');
// Also consumed by FrameDisplayListTest.kt: bridge bytes, not independently rebuilt native calls.
const MENU = '077e0000000300020002000200022a00000096000000010002000200ffffffff0200080000ff24017e30020000000001812c8001812c1611010017328001812c16103001812c3023414031ff24017c30020000000001812c8001812c1611010017328001812c16103001812c302341403102000200010001030400000000000000001f';
const MULTI = '0744000000030002000400010002000000000000000002000200010000ff010001006003000400000000000000001f0200000100000001000100020002feffffff7f00010001007f00';

test('extended integers agree with firmware widths and sign extension', () => {
  const vectors = [[63,'3f'],[-64,'40'],[64,'8040'],[-65,'bfbf'],[8191,'9fff'],[-8192,'a000'],[8192,'c02000'],[-8193,'dfdfff'],[1048575,'cfffff'],[-1048576,'d00000'],[1048576,'e0100000'],[-1048577,'efefffff'],[134217727,'e7ffffff'],[-134217728,'e8000000'],[134217728,'f008000000'],[2147483647,'f07fffffff'],[-2147483648,'f080000000']];
  for (const [value, hex] of vectors) {
    assert.equal(Buffer.from(varint(value)).toString('hex'), hex);
    assert.equal(new DrawBytes(Buffer.from(hex, 'hex')).variable(), value);
  }
  for (const n of [0,127,128,16383,16384,2097151,2097152,268435455,268435456,4294967295]) assert.equal(new DrawBytes(Uint8Array.from(varint(n,false))).variable(false), n);
  assert.throws(() => E.i32(2147483648));
  assert.throws(() => E.f32(Infinity));
});

test('typed expressions follow i32/f32 arithmetic, easing, time and error semantics', () => {
  assert.equal(evaluate(E.i32(2147483647).add(E.i32(1)),0).value, -2147483648);
  assert.equal(evaluate(E.i32(7).neg().div(E.i32(2)),0).value, -3);
  assert.equal(evaluate(E.i32(-2147483648).div(E.i32(-1)),0).value, -2147483648);
  assert.equal(evaluate(E.f32(1.5).mul(E.f32(2)).toInt(),0).value, 3);
  for (let op = ExprOp.SMOOTHSTEP; op <= ExprOp.EASE_IN_OUT_CUBIC; op++) {
    assert.equal(evaluate(E.f32(0).ease(op),0).value, 0);
    assert.equal(evaluate(E.f32(1).ease(op),0).value, 1);
  }
  assert.deepEqual(evaluate(E.i32(300).time(),0,150), {value:150,pending:true});
  assert.deepEqual(evaluate(E.i32(300).time(),0,300), {value:300,pending:false});
  assert.deepEqual(evaluate(E.i32(300).time().div(E.i32(0)),0,150), {value:0,pending:false});
  assert.deepEqual(evaluate(E.decode(Uint8Array.of(ExprOp.IADD)),0), {value:0,pending:false});
  // Delayed timelines: a later start holds at 0, an earlier one continues, a finished one is constant.
  const pct = (d, delay, elapsed) => evaluate(E.progress(d, delay).mul(E.f32(100)).toInt(), elapsed).value;
  assert.deepEqual([pct(200, 100, 50), pct(200, 100, 200), pct(200, -50, 0), pct(200, -50, 150), pct(200, -300, 0)], [0, 50, 25, 100, 100]);
  assert.equal(Buffer.from(E.progress(300, 0).code).toString('hex'), Buffer.from(E.progress(300).code).toString('hex'));
});

test('menu authors the golden generic list and stable timeline identity', () => {
  const original = Date.now; Date.now = () => 1150;
  try {
    const image = new GrayImage(8,4);
    image.drawMenuSelection(new GrayImage(2,2,255),3,2,16,48,1,2,{dx:-2,dy:-4,startedAt:1000,token:42,durationMs:300});
    assert.equal(Buffer.from(encodePresentation(image.draws[0])).toString('hex'), MENU);
    const before = image.fingerprint(); Date.now = () => 1250;
    assert.equal(image.fingerprint(), before, 'wall time does not change frame identity');
    const decoded = readDisplayList(Buffer.from(MENU,'hex'),0,1150).placed;
    const y = decoded.displayList.calls[0].y;
    assert.deepEqual(evaluate(y,150,0), {value:-2,pending:true});
    assert.deepEqual(evaluate(y,150,150), {value:0,pending:false});
    assert.deepEqual(evaluate(y,300,0), {value:0,pending:false});
  } finally { Date.now = original; }
});

test('local resources, relative placement, stereo and screen restoration round-trip', () => {
  const list = { resources:[{width:2,height:1,pixels:Uint8Array.of(0,255)},{width:1,height:1,pixels:Uint8Array.of(96)}], calls:[
    {op:DrawOp.IMAGE,resource:0,x:0,y:0,transparent:true},
    {op:DrawOp.RECT_COPY,resource:1,x:0,y:0,width:1,height:1,dx:2,dy:0},
    {op:DrawOp.RECT_COPY,resource:SCREEN,x:-1,y:0,width:1,height:1,dx:-1,dy:0,depth:-2},
  ] };
  const bytes = encodeDisplayList({displayList:list,x:3,y:2,width:4,height:1,depth:2});
  assert.equal(Buffer.from(bytes).toString('hex'), MULTI);
  const {placed,end} = readDisplayList(bytes,0);
  assert.equal(end,bytes.length);
  for (const right of [false,true]) {
    const screen = new Uint8Array(64).fill(32), output = screen.slice();
    paintDisplayList(output,screen,8,8,placed,right);
    assert.equal(output[2*8+(right?3:5)],240);
    assert.equal(output[2*8+(right?4:6)],96);
    assert.equal(output[2*8+2],32);
  }
  for (let i=0;i<bytes.length;i++) assert.throws(() => readDisplayList(bytes.slice(0,i),0));
  const invalid = {...list, calls:[{op:DrawOp.IMAGE,resource:2,x:0,y:0,transparent:true}]};
  assert.throws(() => encodeDisplayList({displayList:invalid,x:0,y:0,width:4,height:1,depth:0}));
});

test('frame submission supports resource-free lists and plain PRESENT-relative time', () => {
  const image = new GrayImage(8,8);
  image.drawDisplayList({resources:[],calls:[{op:DrawOp.ROUNDED_RECT,x:E.i32(4).time(),y:0,width:2,height:2,radius:0,background:15,border:16}]},0,0,8,8);
  const bytes = encodePresentation(image.draws[0]);
  const {placed} = readDisplayList(bytes,0,1000);
  const output = new Uint8Array(64), screen = output.slice();
  paintDisplayList(output,screen,8,8,placed,false,1002);
  assert.equal(output[2],240); assert.equal(output[0],0);
});

// Also consumed by FrameDisplayListTest.kt, with 0xbeef / 0xcafebabe replaced by
// the font and image ids it registers: a clipped clear, a clipped rounded rect,
// and replayed glyph + icon draws clipped while sliding up. REPLAY_PIXELS is
// what the list paints over a nibble-1 screen, 16x8 at 4 bits per pixel.
const REPLAY = '0780000000020003000800040000070000006400000000000300890000000000000600040002880000010001000200020000000400030000000510a00000000000000600040000ff2502000080c002000000000180c8800180c8161101001732800180c81610300180c830234031020000efbe4100000000000000ff01bebafeca04000100';
const REPLAY_PIXELS = '11111111111111111111111111111111111111111111111111fff28f111111111125522211111111112552221111111111222222111111111111111111111111';

function replayList() {
  // 'A' is 3x2 ink one row below a 4px line top; the icon is 2x2.
  const font = { fingerprintId: 9001, atlasKey: 'stub-font', ascent: 3, lineHeight: 4 };
  const glyph = { encoding: 65, bbxWidth: 3, bbxHeight: 2, bbxX: 0, bbxY: 0, bitmapRows: [0xa0, 0xe0] };
  const icon = new GrayImage(2, 2); icon.pixels.set([255, 0, 128, 255]);
  const source = new GrayImage(8, 4);
  source.drawGlyph(font, glyph, 0, 0, 255);
  source.drawImage(icon, 4, 1);
  const records = Uint8Array.from([0, 0xef, 0xbe, 65, 0, 0, 0, 0, 0, 0, 0, 255, 1, 0xbe, 0xba, 0xfe, 0xca, 4, 0, 1, 0]);
  const clip = { x: 0, y: 0, width: 6, height: 4 };
  return { x: 2, y: 3, width: 8, height: 4, depth: 0, displayList: { resources: [], timeline: { token: 7, startedAt: 1000 }, calls: [
    { op: DrawOp.CLEAR, color: 2, clip },
    { op: DrawOp.ROUNDED_RECT, x: 0, y: 0, width: 4, height: 3, radius: 0, background: 5, border: 16, clip: { x: 1, y: 1, width: 2, height: 2 } },
    { op: DrawOp.DRAWS, x: 0, y: E.progress(200).lerp(E.f32(-4), E.f32(0)).toInt(), records, count: 2, source, clip },
  ] } };
}

test('clipped clears, rects and replayed draws encode, decode and paint', () => {
  const placed = replayList();
  const hex = Buffer.from(encodeDisplayList(placed, 1100)).toString('hex');
  const output = new Uint8Array(16 * 8).fill(16);
  paintDisplayList(output, output.slice(), 16, 8, placed, false, 1100);
  const nibbles = Array.from(output, (v) => (Math.min(15, (v + 8) >> 4)).toString(16)).join('');
  assert.equal(hex, REPLAY);
  assert.equal(nibbles, REPLAY_PIXELS);
  const decoded = readDisplayList(Buffer.from(REPLAY, 'hex'), 0, 1100).placed;
  const [clear, rect, draws] = decoded.displayList.calls;
  assert.deepEqual([clear.op, clear.color, clear.clip], [DrawOp.CLEAR, 2, { x: 0, y: 0, width: 6, height: 4 }]);
  assert.deepEqual(rect.clip, { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(draws.count, 2);
  assert.deepEqual(Array.from(draws.records), Array.from(placed.displayList.calls[2].records));
  assert.equal(draws.source, undefined, 'decoded draws have no software source');
  assert.throws(() => readDisplayList(Buffer.from(REPLAY.replace('01bebafeca', '05bebafeca'), 'hex'), 0, 1100), /draw record/);
});
