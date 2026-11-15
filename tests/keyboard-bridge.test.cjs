const test = require('node:test')
const assert = require('node:assert/strict')
const { HidKeys, parseReportMap, reportKeys } = require('../.test-build/app/g2/keyboard/hid.js')
const {
  KeyboardRecords, keyboardControl, le16, u16, parseKeyboardAdvert, mergeKeyboardAdverts,
  parseKeyboardAddress, formatKeyboardAddress,
} = require('../.test-build/app/g2/keyboard/protocol.js')
const { KeyboardClient, KeyboardClientError, attributeUuid } = require('../.test-build/app/g2/keyboard/client.js')
const { KeyboardBridge } = require('../.test-build/app/g2/keyboard/bridge.js')

// The HID vectors and the simulated HOGP keyboard follow g2flash demos/keyboard.test.ts.
const boot = Uint8Array.from([
  0x05,1,0x09,6,0xa1,1,0x05,7,0x19,0xe0,0x29,0xe7,0x15,0,0x25,1,0x75,1,0x95,8,0x81,2,
  0x75,8,0x95,1,0x81,1,0x95,6,0x75,8,0x15,0,0x25,0x65,0x05,7,0x19,0,0x29,0x65,0x81,0,0xc0,
])
const numbered = Uint8Array.from([
  ...boot.slice(0, 6), 0x85,1,...boot.slice(6, -1),
  0x85,2,0x05,0x0c,0x15,0,0x25,1,0x75,1,0x95,3,0x09,0xe9,0x09,0xea,0x09,0xe2,0x81,2,
  0x75,5,0x95,1,0x81,1,0xc0,
])
function frame(kind, seq, epoch, request, code, handle, data, offset = 0, total = data.length) {
  const p = new Uint8Array(24 + data.length), v = new DataView(p.buffer)
  p.set([75,66,1,kind]); v.setUint32(4,seq,true); v.setUint16(8,epoch,true); v.setUint16(10,request,true)
  v.setUint16(12,code,true); v.setUint16(14,handle,true); v.setUint16(16,total,true); v.setUint16(18,offset,true)
  v.setUint32(20,1234,true); p.set(data,24); return p
}
const flush = () => new Promise(resolve => setImmediate(resolve))
async function settle(rounds = 20) { for (let i = 0; i < rounds; i++) await flush() }

test('boot array, modifiers, release, repeats and rollover', () => {
  const r = parseReportMap(boot).get(0), keys = new HidKeys()
  assert.deepEqual(keys.update(12,r,Uint8Array.of(2,0,4,0,0,0,0,0)), [
    {page:7,usage:0xe1,down:true},{page:7,usage:4,down:true},
  ])
  assert.deepEqual(keys.update(12,r,Uint8Array.of(2,0,4,0,0,0,0,0)), [])
  assert.throws(() => keys.update(12,r,Uint8Array.of(0,0,1,1,1,1,1,1)), /rollover/)
  assert.deepEqual(keys.reset().map(k => k.down), [false,false])
  assert.throws(() => reportKeys(r,Uint8Array.of(0)), /length/)
})
test('HOGP report IDs are out of band, with consumer keys', () => {
  const maps = parseReportMap(numbered)
  assert.deepEqual(reportKeys(maps.get(1),Uint8Array.of(0,0,5,0,0,0,0,0)), [{page:7,usage:5}])
  assert.deepEqual(reportKeys(maps.get(2),Uint8Array.of(5)), [{page:12,usage:0xe9},{page:12,usage:0xe2}])
  assert.throws(() => reportKeys(maps.get(2),Uint8Array.of(2,5)), /length/)
})
test('NKRO bitmap with non-byte-aligned fields and report union', () => {
  const map = Uint8Array.of(5,7,0x19,4,0x29,19,0x15,0,0x25,1,0x75,1,0x95,16,0x81,2)
  const r = parseReportMap(map).get(0), keys = new HidKeys()
  assert.deepEqual(reportKeys(r,Uint8Array.of(0x81,0x80)), [{page:7,usage:4},{page:7,usage:11},{page:7,usage:19}])
  assert.equal(keys.update(10,r,Uint8Array.of(1,0)).length, 1)
  assert.deepEqual(keys.update(11,r,Uint8Array.of(1,0)), [])
  assert.deepEqual(keys.update(10,r,Uint8Array.of(0,0)), [])
  assert.deepEqual(keys.update(11,r,Uint8Array.of(0,0)), [{page:7,usage:4,down:false}])
})
test('array values index usages relative to logical minimum', () => {
  const r = parseReportMap(Uint8Array.of(5,7,0x19,4,0x29,6,0x15,1,0x25,3,0x75,8,0x95,1,0x81,0)).get(0)
  assert.deepEqual(reportKeys(r,Uint8Array.of(2)), [{page:7,usage:5}])
  assert.deepEqual(reportKeys(r,Uint8Array.of(0)), [])
})
test('descriptor resource bounds and malformed items', () => {
  for (const data of [new Uint8Array(),new Uint8Array(513),Uint8Array.of(0xfe),Uint8Array.of(0x75),
    Uint8Array.of(0xb4),Uint8Array.of(0xc0),Uint8Array.of(0x85,0),Uint8Array.of(0x75,33,0x95,1,0x81,2),
    Uint8Array.of(0x75,32,0x96,0,2,0x81,2),Uint8Array.of(0xa1,1)]) assert.throws(() => parseReportMap(data))
  // Deterministic malformed corpus; parsing must be bounded and never hang.
  let seed = 1
  for (let i = 0; i < 1000; i++) {
    const data = Uint8Array.from({length:i%128+1}, () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed>>>24 })
    try { parseReportMap(data) } catch (e) { assert.ok(e instanceof Error) }
  }
})

test('control records, UUIDs and addresses', () => {
  assert.deepEqual([...keyboardControl(4,0x1234,0x5678,[1,2,3,4,5,6,7])], [75,66,1,4,0x34,0x12,0x78,0x56,1,2,3,4,5,6,7])
  assert.throws(() => keyboardControl(13,1,1))
  assert.throws(() => keyboardControl(11,1,1,new Array(73).fill(0)))
  assert.equal(attributeUuid(Uint8Array.of(0xfb,0x34,0x9b,0x5f,0x80,0,0,0x80,0,0x10,0,0,0x12,0x18,0,0)), 0x1812)
  const address = parseKeyboardAddress('AA:bb:cc:dd:ee:01')
  assert.deepEqual([...address], [1,0xee,0xdd,0xcc,0xbb,0xaa])
  assert.equal(formatKeyboardAddress(address), 'aa:bb:cc:dd:ee:01')
  assert.equal(parseKeyboardAddress('aa:bb:cc:dd:ee'), null)
  assert.equal(parseKeyboardAddress('aa:bb:cc:dd:ee:gg'), null)
})
test('fragments, duplicate delivery, gaps, epochs and sequence wrap', () => {
  let gaps = 0; const stream = new KeyboardRecords(() => gaps++)
  const data = Uint8Array.from({length:200}, (_,i) => i)
  assert.equal(stream.push(frame(3,0xffffffff,1,0,13,33,data.slice(0,96),0,200)), undefined)
  assert.equal(stream.push(frame(3,0xffffffff,1,0,13,33,data.slice(96,192),96,200)), undefined)
  assert.deepEqual(stream.push(frame(3,0xffffffff,1,0,13,33,data.slice(192),192,200)).data, data)
  const status = frame(1,0,1,0,0,0,new Uint8Array(10))
  assert.equal(stream.push(status).sequence, 0)
  assert.equal(stream.push(status), undefined); assert.equal(gaps, 1)
  stream.push(frame(1,2,1,0,0,0,new Uint8Array(10))); assert.equal(gaps, 2)
  assert.equal(stream.push(status), undefined); assert.equal(gaps, 2)
  stream.push(frame(1,3,2,0,0,0,new Uint8Array(10))); assert.equal(gaps, 3)
})
test('missing or mismatched fragments never emit partial input', () => {
  let gaps = 0; const stream = new KeyboardRecords(() => gaps++)
  stream.push(frame(3,1,1,0,13,10,new Uint8Array(96),0,100))
  assert.equal(stream.push(frame(3,1,1,0,13,11,new Uint8Array(4),96,100)), undefined)
  assert.equal(gaps, 2)
  assert.equal(stream.push(frame(3,1,1,0,13,10,new Uint8Array(4),96,100)), undefined)
  assert.equal(stream.push(new Uint8Array(513)), undefined)
  // Another protocol version is not ours to decode.
  const future = frame(1,5,1,0,0,0,new Uint8Array(10)); future[2] = 2
  assert.equal(stream.push(future), undefined)
})
test('adverts: name from the scan response, HID from the service list or the appearance', () => {
  const body = (ad, rssi = -60) => Uint8Array.from([1, 6,5,4,3,2,1, rssi & 255, 0, ad.length, ...ad])
  const services = parseKeyboardAdvert(body([2,1,6, 3,3,0x12,0x18]))
  assert.deepEqual(services, { addressType: 1, address: '01:02:03:04:05:06', rssi: -60, name: '', hid: true })
  const named = parseKeyboardAdvert(body([5,9,0x4b,0x33,0x38,0x30], -48))
  assert.equal(named.name, 'K380'); assert.equal(named.hid, false)
  assert.deepEqual(mergeKeyboardAdverts(services, named), { ...services, name: 'K380', rssi: -48 })
  assert.equal(parseKeyboardAdvert(body([3,0x19,0xc1,0x03])).hid, true)
  assert.equal(parseKeyboardAdvert(body([3,0x19,0x41,0x03])).hid, false)
  assert.equal(parseKeyboardAdvert(Uint8Array.of(1,2,3)), null)
  // A truncated AD structure ends the parse without reading past the body.
  assert.equal(parseKeyboardAdvert(body([9,9,0x41])).name, '')
})

/**
 * The firmware bridge and a HOGP keyboard behind it, as far as the phone can
 * tell: answers control records with the records the real one sends.
 */
function fakeGlasses(deliver) {
  const attrs = new Map()
  const add = (h, uuid, bytes) => attrs.set(h, { uuid, value: Uint8Array.from(bytes) })
  const mockMap = Uint8Array.from([...numbered.slice(0,-1),0x85,3,0x05,6,0x09,0x20,0x15,0,0x25,100,0x75,8,0x95,1,0x81,2,0xc0])
  add(1,0x2800,[1,0x18]); add(2,0x2803,[0x20,3,0,5,0x2a]); add(3,0x2a05,[]); add(4,0x2902,[0,0])
  add(20,0x2800,[0x12,0x18])
  add(21,0x2803,[2,22,0,0x4b,0x2a]); add(22,0x2a4b,mockMap); add(23,0x2907,[0x19,0x2a])
  add(24,0x2803,[6,25,0,0x4e,0x2a]); add(25,0x2a4e,[1])
  add(26,0x2803,[0x12,27,0,0x4d,0x2a]); add(27,0x2a4d,[]); add(28,0x2902,[0,0]); add(29,0x2908,[1,1])
  add(30,0x2803,[0x12,31,0,0x4d,0x2a]); add(31,0x2a4d,[]); add(32,0x2902,[0,0]); add(33,0x2908,[2,1])
  add(40,0x2800,[0x0f,0x18]); add(41,0x2803,[0x12,42,0,0x19,0x2a]); add(42,0x2a19,[100]); add(43,0x2902,[0,0]); add(44,0x2908,[3,1])
  const g = {
    seq: 0, epoch: 0, enabled: 0, conn: 0, connected: 0, encrypted: 0, scanning: 0,
    ops: [], writes: [], watches: [], adverts: [], pins: [], compares: [],
    reachable: true, bonded: false, pairing: 'just-works', up: true,
    // The keyboard's attribute table, and how its stack answers a direct read
    // of a characteristic declaration: 'full', 'short' (the properties byte
    // alone) or 'refused'.
    attrs, add, declarations: 'full',
  }
  g.emit = (kind, request, code, handle, data = []) =>
    deliver(frame(kind, ++g.seq, g.epoch, request, code, handle, Uint8Array.from(data)))
  g.status = (request = 0, code = 0) =>
    g.emit(1, request, code, 0, [g.enabled, g.conn, g.connected, g.encrypted, g.scanning, 0, 0,0,0,0])
  g.dm = (event, status = 0, data = []) => g.emit(4, 0, event | (status << 8), 0, data)
  g.close = () => { if (!g.conn) return; g.conn = g.connected = g.encrypted = 0; g.watches = []; g.dm(0x28); g.status() }
  g.encrypt = () => { g.encrypted = 1; g.dm(0x2c); g.status() }
  g.input = (handle, bytes) => g.emit(3, 0, 13, handle, bytes)
  g.send = (record) => {
    if (!g.up) return false
    const op = record[3], req = u16(record,4), epoch = u16(record,6), h = record.length >= 10 ? u16(record,8) : 0
    g.ops.push(op)
    if (op !== 0 && op !== 1 && epoch !== g.epoch) { g.status(req, 4); return true }
    if (op === 0) g.status(req)
    else if (op === 1) { g.enabled = 1; g.status(req) }
    else if (op === 2) { g.enabled = 0; g.status(req); g.close() }
    else if (op === 3) {
      if (g.conn) { g.status(req, 3); return true }
      g.scanning = 1; g.status(req)
      for (const advert of g.adverts) g.emit(5, 0, 0, 0, advert)
      g.scanning = 0; g.status()
    } else if (op === 4) {
      if (g.conn) { g.status(req, 3); return true }
      g.epoch = (g.epoch + 1) & 0xffff; g.conn = 3; g.status(req)
      if (!g.reachable) return true
      g.connected = 1; g.dm(0x27); g.status()
      if (g.bonded) g.encrypt()
    } else if (op === 5) { g.status(req); g.close() }
    else if (op === 6) {
      if (!g.connected) { g.status(req, 6); return true }
      g.status(req)
      if (g.pairing === 'just-works') { g.dm(0x2a); g.encrypt() }
      else if (g.pairing === 'display') g.dm(0x2e, 0, [0, 1])
      else if (g.pairing === 'entry') g.dm(0x2e, 0, [0, 0])
      else if (g.pairing === 'compare') g.dm(0x35, 0, [0x40, 0xe2, 0x01, 0])
      else if (g.pairing === 'fail') { g.dm(0x2b, 5); g.close() }
    } else if (op === 7) {
      g.pins.push(record[8] | (record[9] << 8) | (record[10] << 16)); g.status(req); g.dm(0x2a); g.encrypt()
    } else if (op === 8) {
      g.compares.push(record[8]); g.status(req)
      if (record[8]) { g.dm(0x2a); g.encrypt() } else { g.dm(0x2b, 4); g.close() }
    } else if (op === 9) {
      const batch = [...attrs].filter(([handle]) => handle >= h).slice(0,4)
      g.emit(2, req, batch.length ? 2 : (10<<8)|2, h, batch.length ? [1, ...batch.flatMap(([handle,a]) => [...le16(handle), ...le16(a.uuid)])] : [])
    } else if (op === 10) {
      const attr = attrs.get(h), offset = u16(record,10)
      if (attr.uuid === 0x2803 && g.declarations === 'refused') { g.emit(2, req, (2<<8)|5, h); return true }
      const data = attr.uuid === 0x2803 && g.declarations === 'short' ? attr.value.slice(0,1) : attr.value
      g.emit(2, req, offset >= data.length ? (7<<8)|6 : offset ? 6 : 5, h, data.slice(offset, offset+20))
    } else if (op === 11) { g.writes.push(h); g.emit(2, req, record[10] ? 10 : 9, h) }
    else if (op === 12) { g.watches = Array.from({length:record[8]}, (_,i) => u16(record,9+2*i)); g.status(req) }
    else throw new Error(`Unexpected op ${op}`)
    return true
  }
  return g
}

test('client: HOGP discovery, long Report Map, subscriptions, typing and loss recovery', async () => {
  const events = []
  let client
  const g = fakeGlasses(payload => client.accept(payload))
  client = new KeyboardClient(g.send, { keys: e => events.push(...e) })
  await client.enable(); await client.connect(1, new Uint8Array(6)); const config = await client.configure()
  // The battery level (an external report) is found, but it can't carry a
  // key, so it isn't subscribed: only the two key reports and Service Changed.
  assert.deepEqual(g.watches, [27,31,3]); assert.deepEqual(g.writes, [25,4,28,32])
  assert.deepEqual(config.reports.map(r => r.id), [1,2,3]); assert.deepEqual(config.watched, [27,31])
  assert.deepEqual(config.reports.map(r => r.properties), [0x12,0x12,0x12])
  g.input(27, [0,0,4,0,0,0,0,0]); g.input(31, [1])
  assert.deepEqual(events.map(e => [e.usage,e.down]), [[4,true],[0xe9,true]])
  g.seq++ // a release lost in the firmware queue or on the way to the phone
  g.status()
  assert.deepEqual(events.slice(-2).map(e => e.down), [false,false])
  // Another client on the same connection can take over with the mapping.
  const restored = new KeyboardClient(() => true, { keys: e => events.push(...e) })
  restored.restore(config); restored.accept(frame(3, g.seq + 1, g.epoch, 0, 13, 27, Uint8Array.of(0,0,5,0,0,0,0,0)))
  assert.deepEqual([events.at(-1).usage, events.at(-1).down], [5, true]); restored.lostPhoneLink()
  assert.deepEqual([events.at(-1).usage, events.at(-1).down], [5, false])
  // Service Changed voids the handles: no more keys until configure() runs again.
  g.emit(3, 0, 14, 3, [1,0,255,255])
  const count = events.length; g.input(27, [0,0,6,0,0,0,0,0])
  assert.equal(events.length, count)
  client.close(); restored.close()
})
// A pointer's report, as a keyboard with a built-in trackpad adds: buttons and relative X/Y.
const mouseCollection = [0x05,1,0x09,2,0xa1,1,0x85,4,0x09,1,0xa1,0,0x05,9,0x19,1,0x29,3,0x15,0,0x25,1,0x75,1,0x95,3,0x81,2,
  0x75,5,0x95,1,0x81,1,0x05,1,0x09,0x30,0x09,0x31,0x15,0x81,0x25,0x7f,0x75,8,0x95,2,0x81,6,0xc0,0xc0]
/** Turn the fake into a keyboard with a trackpad, whose battery level has no Report Reference. */
function makeCombo(g) {
  g.add(22, 0x2a4b, [...g.attrs.get(22).value, ...mouseCollection])
  g.add(34,0x2803,[0x12,35,0,0x4d,0x2a]); g.add(35,0x2a4d,[]); g.add(36,0x2902,[0,0]); g.add(37,0x2908,[4,1])
  g.attrs.delete(44)
  const sorted = [...g.attrs].sort((a, b) => a[0] - b[0])
  g.attrs.clear(); for (const [handle, attr] of sorted) g.attrs.set(handle, attr)
}
for (const declarations of ['short', 'refused']) {
  test(`client: a keyboard with a trackpad whose stack answers declaration reads ${declarations} still types`, async () => {
    const events = [], logs = []
    let client
    const g = fakeGlasses(payload => client.accept(payload))
    makeCombo(g); g.declarations = declarations
    client = new KeyboardClient(g.send, { keys: e => events.push(...e), log: line => logs.push(line) })
    await client.enable(); await client.connect(1, new Uint8Array(6)); const config = await client.configure()
    // Keys and media keys are subscribed; the pointer and the battery are not.
    assert.deepEqual(config.watched, [27,31]); assert.deepEqual(g.watches, [27,31,3]); assert.deepEqual(g.writes, [25,4,28,32])
    assert.deepEqual(config.reports.map(r => [r.handle, r.id]), [[27,1],[31,2],[35,4]])
    assert.deepEqual(config.reports.map(r => r.properties), declarations === 'short' ? [0x12,0x12,0x12] : [undefined,undefined,undefined])
    g.input(27, [0,0,4,0,0,0,0,0])
    assert.deepEqual(events.map(e => [e.usage,e.down]), [[4,true]])
    // What was skipped, and why, is in the log; so is the table it came from.
    assert.ok(logs.some(line => /^gatt 1=2800 2=2803 /.test(line)), logs.join('\n'))
    assert.ok(logs.some(line => /report 42 skipped: no Report Reference/.test(line)), logs.join('\n'))
    assert.ok(logs.some(line => /report 35 \(id 4\) carries no keys/.test(line)), logs.join('\n'))
    assert.ok(logs.some(line => line.startsWith('report map 22: 0501')))
    client.close()
  })
}
test('client: one unusable report is skipped, and a device with no key report is refused with the reasons', async () => {
  let client
  const g = fakeGlasses(payload => client.accept(payload))
  client = new KeyboardClient(g.send)
  g.add(29, 0x2908, [1])               // a Report Reference of the wrong length
  await client.enable(); await client.connect(1, new Uint8Array(6))
  assert.deepEqual((await client.configure()).watched, [31])
  g.add(33, 0x2908, [9,1])             // and one naming a report the map doesn't have
  await assert.rejects(client.configure(), /No usable keyboard input report \(27: Report Reference 29 is 01; 31: input report id 9 is not in the Report Map\)/)
  assert.equal(client.configuration, undefined)
  // Not a HID device at all.
  g.add(20, 0x2800, [0x0f,0x18])
  await assert.rejects(client.configure(), /no HID service/)
  client.close()
})
test('client: the link dropping during setup ends it, rather than being skipped over', async () => {
  let client
  const g = fakeGlasses(payload => client.accept(payload))
  client = new KeyboardClient(g.send)
  await client.enable(); await client.connect(1, new Uint8Array(6))
  const send = g.send
  g.send = (record) => {
    // The keyboard goes away as the first Report Reference is read.
    if (record[3] === 10 && u16(record, 8) === 29) { g.close(); return true }
    return send(record)
  }
  client = new KeyboardClient(record => g.send(record))
  await client.query()
  await assert.rejects(client.configure(), /stream gap|link changed/)
  client.close()
})
test('client: an unreachable keyboard fails the connect when the glasses give up, not by timeout', async () => {
  let client
  const g = fakeGlasses(payload => client.accept(payload)); g.reachable = false
  client = new KeyboardClient(g.send)
  await client.enable()
  const pending = client.connect(1, new Uint8Array(6))
  await settle(); g.close()
  await assert.rejects(pending, /didn't answer/)
  client.close()
})
test('client: firmware errors carry their code, and a dead link rejects at once', async () => {
  let client
  const g = fakeGlasses(payload => client.accept(payload))
  client = new KeyboardClient(g.send)
  await client.enable(); await client.connect(1, new Uint8Array(6))
  await assert.rejects(client.command(4, [1,0,0,0,0,0,0]), e => e instanceof KeyboardClientError && e.code === 3)
  g.up = false
  await assert.rejects(client.query(), /aren't ready/)
  client.close()
  await assert.rejects(client.query(), /closed/)
})

function bridgeSetup(saved = null) {
  const host = { keys: [], gone: 0, changes: 0, logs: [], prompts: [], saved, reconnect: true }
  let bridge
  const g = fakeGlasses(payload => bridge.accept(payload))
  bridge = new KeyboardBridge({
    send: g.send,
    loadSaved: () => host.saved,
    storeSaved: value => { host.saved = value },
    onKeys: events => host.keys.push(...events),
    onKeyboardGone: () => { host.gone++ },
    onChanged: () => {
      host.changes++
      const pairing = bridge.snapshot().pairing
      if (pairing && host.prompts.at(-1) !== pairing) host.prompts.push(pairing)
    },
    log: line => host.logs.push(line),
    randomPasskey: () => 123456,
    shouldReconnect: () => host.reconnect,
  })
  return { bridge, g, host }
}
const K380 = { address: 'aa:bb:cc:dd:ee:01', addressType: 1, name: 'K380' }
const advertOf = (lastByte, ad) => [1, lastByte,0xee,0xdd,0xcc,0xbb,0xaa, 0xc4, 0, ad.length, ...ad]

test('bridge: scan, pick, pair by typing the displayed passkey, type, forget', async () => {
  const { bridge, g, host } = bridgeSetup()
  assert.equal(bridge.snapshot().state, 'unavailable')
  await assert.rejects(bridge.scan(), /Connect to G2 glasses/)
  bridge.linkReady()
  g.adverts = [
    advertOf(2, [2,1,6]),                       // some other device
    advertOf(1, [2,1,6, 3,3,0x12,0x18]),        // the keyboard's advertisement
    advertOf(1, [5,9,0x4b,0x33,0x38,0x30]),     // and its scan response, with the name
  ]
  const found = await bridge.scan()
  assert.deepEqual(found.map(a => [a.address, a.name, a.hid]), [[K380.address,'K380',true],['aa:bb:cc:dd:ee:02','',false]])
  assert.equal(bridge.snapshot().state, 'idle')

  g.pairing = 'display'
  await bridge.connect(K380)
  // The passkey went up for the user to type, and to the glasses as the answer.
  assert.deepEqual(host.prompts, [{ kind: 'display', pin: 123456 }])
  assert.deepEqual(g.pins, [123456])
  assert.equal(bridge.snapshot().state, 'connected'); assert.equal(bridge.snapshot().pairing, null)
  assert.deepEqual(host.saved, K380); assert.ok(bridge.isConnected())

  g.input(27, [2,0,4,0,0,0,0,0])
  assert.deepEqual(host.keys.map(k => [k.usage, k.down]), [[0xe1,true],[4,true]])
  await bridge.forget()
  assert.equal(host.saved, null); assert.equal(host.gone, 1); assert.equal(g.conn, 0); assert.equal(g.enabled, 0)
  assert.equal(bridge.snapshot().state, 'idle')
  bridge.linkLost()
})
test('bridge: numeric comparison waits for the answer; declining fails the pairing', async () => {
  const { bridge, g } = bridgeSetup()
  bridge.linkReady(); g.pairing = 'compare'
  const pending = bridge.connect(K380)
  await settle()
  assert.deepEqual(bridge.snapshot().pairing, { kind: 'compare', value: 123456 })
  assert.equal(bridge.snapshot().state, 'pairing')
  await bridge.answerCompare(false)
  await assert.rejects(pending, /Pairing with the keyboard failed/)
  assert.equal(bridge.snapshot().state, 'error'); assert.deepEqual(g.compares, [0])
  await assert.rejects(bridge.answerCompare(true), /No pairing comparison/)
  bridge.linkLost()
})
test('bridge: a keyboard that shows a code is paired with the code typed in', async () => {
  const { bridge, g } = bridgeSetup()
  bridge.linkReady(); g.pairing = 'entry'
  const pending = bridge.connect(K380)
  await settle()
  assert.deepEqual(bridge.snapshot().pairing, { kind: 'entry' })
  await bridge.answerPasskey(42)
  await pending
  assert.deepEqual(g.pins, [42]); assert.equal(bridge.snapshot().state, 'connected')
  bridge.linkLost()
})
test('bridge: the remembered keyboard comes back with the link, and again after it drops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, g, host } = bridgeSetup(K380)
  g.bonded = true
  bridge.linkReady()
  assert.equal(bridge.snapshot().waiting, true)
  t.mock.timers.tick(1000); await settle()
  assert.equal(bridge.snapshot().state, 'connected'); assert.equal(g.connected, 1)

  // The keyboard goes to sleep: held keys are dropped, and it is looked for again.
  g.input(27, [0,0,4,0,0,0,0,0])
  g.close(); await settle()
  assert.equal(host.gone, 1); assert.equal(bridge.snapshot().state, 'idle'); assert.equal(bridge.snapshot().waiting, true)
  g.reachable = false
  t.mock.timers.tick(2000); await settle()
  assert.equal(bridge.snapshot().state, 'connecting')
  g.close(); await settle()
  // Asleep is the ordinary case, not an error in front of the user.
  assert.equal(bridge.snapshot().state, 'idle'); assert.equal(bridge.snapshot().error, '')
  g.reachable = true
  t.mock.timers.tick(2000); await settle()
  assert.equal(bridge.snapshot().state, 'connected')

  // Disconnecting by hand stops the retries until asked again.
  await bridge.disconnect()
  assert.equal(bridge.snapshot().waiting, false); assert.equal(g.enabled, 0)
  t.mock.timers.tick(60000); await settle()
  assert.equal(bridge.snapshot().state, 'idle'); assert.equal(g.connected, 0)
  bridge.linkLost()
})
test('bridge: the glasses kept the keyboard through a phone-side drop, so only discovery is redone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, g, host } = bridgeSetup(K380)
  g.bonded = true
  bridge.linkReady(); t.mock.timers.tick(1000); await settle()
  assert.equal(bridge.snapshot().state, 'connected')
  const epoch = g.epoch
  bridge.linkLost()
  assert.equal(bridge.snapshot().state, 'unavailable'); assert.equal(host.gone, 1)
  g.ops.length = 0
  bridge.linkReady(); t.mock.timers.tick(1000); await settle()
  assert.equal(bridge.snapshot().state, 'connected')
  assert.equal(g.epoch, epoch, 'no reconnect of the keyboard itself')
  assert.ok(!g.ops.includes(4) && !g.ops.includes(2))
  g.input(27, [0,0,7,0,0,0,0,0])
  assert.deepEqual([host.keys.at(-1).usage, host.keys.at(-1).down], [7, true])
  bridge.linkLost()
})
test('bridge: a scan started by hand takes over from an attempt in flight, and nothing retries while charging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, g, host } = bridgeSetup(K380)
  g.reachable = false
  bridge.linkReady(); t.mock.timers.tick(1000); await settle()
  assert.equal(bridge.snapshot().state, 'connecting'); assert.equal(g.conn, 3)
  g.adverts = [advertOf(1, [3,3,0x12,0x18])]
  const scan = bridge.scan()
  await settle(); t.mock.timers.tick(200); await settle()
  assert.equal((await scan).length, 1)
  assert.equal(g.conn, 0, 'the pending connection was released first')
  assert.equal(bridge.snapshot().state, 'idle'); assert.equal(bridge.snapshot().busy, false)

  // Reconnecting waits for the glasses to be in use.
  host.reconnect = false
  bridge.linkLost(); bridge.linkReady(); g.ops.length = 0
  t.mock.timers.tick(1000); await settle()
  t.mock.timers.tick(120000); await settle()
  assert.deepEqual(g.ops, [])
  // A bridge left enabled by an attempt is switched off for the wait, so the
  // firmware's timer and its once-a-second status stop.
  host.reconnect = true; g.reachable = false
  bridge.retryNow(); t.mock.timers.tick(0); await settle()
  assert.equal(g.enabled, 1); assert.equal(bridge.snapshot().state, 'connecting')
  g.close(); await settle()
  host.reconnect = false
  t.mock.timers.tick(2000); await settle()
  assert.equal(g.enabled, 0)
  g.ops.length = 0
  t.mock.timers.tick(120000); await settle()
  assert.deepEqual(g.ops, [])
  // The display woke: no waiting out the rest of the backoff.
  host.reconnect = true; g.reachable = true; g.bonded = true
  bridge.retryNow()
  t.mock.timers.tick(0); await settle()
  assert.equal(bridge.snapshot().state, 'connected')
  // With the keyboard in use, or none remembered, there is nothing to retry.
  g.ops.length = 0
  bridge.retryNow(); t.mock.timers.tick(0); await settle()
  assert.deepEqual(g.ops, [])
  bridge.linkLost()
})
test('bridge: leaving on purpose tells the glasses to let the keyboard go', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, g } = bridgeSetup(K380)
  g.bonded = true
  bridge.linkReady(); t.mock.timers.tick(1000); await settle()
  assert.equal(g.connected, 1)
  bridge.linkClosing(); bridge.linkLost()
  assert.equal(g.enabled, 0); assert.equal(g.conn, 0)
  // With no keyboard in use there is nothing to say.
  const idle = bridgeSetup()
  idle.bridge.linkReady(); idle.bridge.linkClosing(); idle.bridge.linkLost()
  assert.deepEqual(idle.g.ops, [])
})
test('bridge: a keyboard forgotten while the glasses were away is released when they return', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, g, host } = bridgeSetup(K380)
  g.bonded = true
  bridge.linkReady(); t.mock.timers.tick(1000); await settle()
  assert.equal(g.connected, 1)
  bridge.linkLost()
  await bridge.forget()
  assert.equal(host.saved, null); assert.equal(g.connected, 1, 'out of reach, so still attached')
  bridge.linkReady(); await settle()
  assert.equal(g.enabled, 0); assert.equal(g.conn, 0)
  t.mock.timers.tick(60000); await settle()
  assert.equal(bridge.snapshot().state, 'idle'); assert.equal(bridge.snapshot().waiting, false)
  bridge.linkLost()
})
