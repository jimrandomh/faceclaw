const assert = require('node:assert/strict');

// Independent firmware-format decoder for reconstruction tests (not app code).
function applyDisplayPayload(base, payload, width = 640, height = 480) {
  const mode = payload[0];
  if (mode === 28) return base;
  if (mode === 26) {
    const word = i => payload[i] | payload[i+1] << 8;
    let pos=3, out=base;
    for(let n=0;n<word(1);n++) {
      const length=word(pos);pos+=2;const call=payload.subarray(pos,pos+length);pos+=length;
      assert.equal(call[0],1);assert.equal(call[1],0);
      let legacy;
      if(call[2]===0) legacy=Uint8Array.from([3,...call.subarray(3,7),0,0,...call.subarray(7)]);
      else { assert.deepEqual([...call.subarray(3,11)],[0,0,0,0,width&255,width>>8,height&255,height>>8]);legacy=Uint8Array.from([6,...call.subarray(11)]); }
      out=applyDisplayPayload(out,legacy,width,height);
    }
    assert.equal(pos,payload.length);return out;
  }
  assert.ok(mode === 3 || mode === 6);
  const [left, top, w, h] = mode === 3
    ? [payload[1] * 4, payload[2] * 2, payload[3] * 4, payload[4] * 2] : [0, 0, width, height];
  assert.ok(w > 0 && h > 0 && left + w <= width && top + h <= height);
  const tokens = payload.subarray(mode === 3 ? 7 : 1);
  const pixels = [];
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++], color = token & 15;
    let count = token >>> 4;
    if (!count) { count = tokens[i++]; if (!count) { count = tokens[i] | (tokens[i + 1] << 8); i += 2; } }
    assert.ok(count > 0 && pixels.length + count <= w * h);
    for (let n = 0; n < count; n++) pixels.push(color);
  }
  assert.equal(pixels.length, w * h);
  const out = base.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2)
    out[(top + y) * (width / 2) + (left + x) / 2] = (pixels[y * w + x] << 4) | pixels[y * w + x + 1];
  return out;
}
module.exports = { applyDisplayPayload };
