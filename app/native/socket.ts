import { toJavaBytes } from './cloud-stt'

declare const com: any
export type SocketListener = { onOpen(): void; onTextMessage(message: string): void; onClosed(code: number, reason: string): void; onFailure(message: string): void }
/** One extra handshake header, e.g. an API key. */
export type SocketHeader = { name: string; value: string }
export type SocketConnection = {
  /** False when the frame was refused outright; later failures arrive via onFailure. */
  sendText(text: string): boolean
  sendBinary(bytes: Uint8Array): boolean
  close(code: number, reason: string): void
}
export function openSocket(url: string, listener: SocketListener, header?: SocketHeader): SocketConnection {
  const proxy = new com.faceclaw.app.FaceclawWebSocketListener(listener)
  const native = new com.faceclaw.app.FaceclawWebSocket(url, proxy, header?.name ?? null, header?.value ?? null)
  const connection = { listenerProxy: proxy, sendText: (text: string) => native.sendText(text) !== false,
    sendBinary: (bytes: Uint8Array) => native.sendBinary(toJavaBytes(bytes)) !== false,
    close: (code: number, reason: string) => native.close(code, reason) }
  return connection
}
