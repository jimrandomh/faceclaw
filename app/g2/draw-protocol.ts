/** Adapter for raster-only senders; optimized legacy layouts remain internal to the phone. */
export function drawMessages(payload: Uint8Array, width = 640, height = 480): Uint8Array[] {
  const word = (v: number) => [v & 255, (v >>> 8) & 255]
  const mode = payload[0] & 127
  let calls: Uint8Array[]
  if (mode === 8) {
    const output: Uint8Array[] = []; let p=2
    for(let i=0;i<payload[1];i++) { const n=payload[p] | payload[p+1]<<8; p+=2; output.push(...drawMessages(payload.subarray(p,p+n),width,height));p+=n }
    return output
  } else if (mode === 3) calls=[new Uint8Array([1,0,0,...payload.subarray(1,5),...payload.subarray(7)])]
  else if(mode === 6) calls=[new Uint8Array([1,0,1,0,0,0,0,...word(width),...word(height),...payload.subarray(1)])]
  else throw new Error(`Unsupported raster draw ${mode}`)
  return calls.map(call => new Uint8Array([26,1,0,...word(call.length),...call]))
}
