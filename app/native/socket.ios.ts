import type { SocketConnection, SocketHeader, SocketListener } from './socket'
declare const FaceclawSocket: any
export function openSocket(url: string, listener: SocketListener, header?: SocketHeader): SocketConnection {
  const native = FaceclawSocket.alloc().initWithURLHeaderNameHeaderValue(url, header?.name ?? null, header?.value ?? null)
  let ended = false
  const close = () => { if (ended) return; ended = true; clearInterval(timer); native.close() }
  const timer = setInterval(() => {
    for (const event of JSON.parse(native.takeEvents())) {
      if (ended) break
      if (event.kind === 'open') listener.onOpen()
      else if (event.kind === 'text') listener.onTextMessage(event.text)
      else { close(); if (event.kind === 'closed') listener.onClosed(event.code, event.text); else listener.onFailure(event.text) }
    }
  }, 25)
  // NSURLSession queues every send; a failed one surfaces as an error event.
  return {
    sendText: text => { if (!ended) native.sendText(text); return !ended },
    sendBinary: bytes => {
      if (ended) return false
      const copy = bytes.slice()
      native.sendData(NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength))
      return true
    },
    close,
  }
}
