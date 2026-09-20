declare const com: any
export type SocketListener = { onOpen(): void; onTextMessage(message: string): void; onClosed(code: number, reason: string): void; onFailure(message: string): void }
export function openSocket(url: string, listener: SocketListener): { sendText(text: string): void; close(code: number, reason: string): void } {
  const proxy = new com.faceclaw.app.FaceclawWebSocketListener(listener)
  const native = new com.faceclaw.app.FaceclawWebSocket(url, proxy, null, null)
  const connection = { listenerProxy: proxy, sendText: (text: string) => native.sendText(text),
    close: (code: number, reason: string) => native.close(code, reason) }
  return connection
}
