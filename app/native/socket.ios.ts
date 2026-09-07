export type SocketListener = { onOpen(): void; onTextMessage(message: string): void; onClosed(code: number, reason: string): void; onFailure(message: string): void }
declare const FaceclawSocket: any
export function openSocket(url: string, listener: SocketListener): { sendText(text: string): void; close(code: number, reason: string): void } {
  const native = FaceclawSocket.alloc().initWithURL(url)
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
  return { sendText: text => { if (!ended) native.sendText(text) }, close }
}
