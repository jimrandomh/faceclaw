export type SocketListener = { onOpen(): void; onTextMessage(message: string): void; onClosed(code: number, reason: string): void; onFailure(message: string): void };
export type SocketHeader = { name: string; value: string };
export type SocketConnection = { sendText(text: string): boolean; sendBinary(bytes: Uint8Array): boolean; close(code: number, reason: string): void };

/** Browser WebSockets can't set handshake headers, so a header-authenticated server can't be reached from here. */
export function openSocket(url: string, listener: SocketListener, header?: SocketHeader): SocketConnection {
  if (header) {
    setTimeout(() => listener.onFailure("The browser demo can't send this connection's sign-in header."), 0);
    return { sendText: () => false, sendBinary: () => false, close: () => {} };
  }
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let ended = false;
  socket.onopen = () => listener.onOpen();
  socket.onmessage = (event) => { if (typeof event.data === "string") listener.onTextMessage(event.data); };
  socket.onerror = () => { if (!ended) { ended = true; listener.onFailure(`Could not connect to ${url}`); } };
  socket.onclose = (event) => { if (!ended) { ended = true; listener.onClosed(event.code, event.reason); } };
  return {
    sendText: (text) => { if (socket.readyState !== WebSocket.OPEN) return false; socket.send(text); return true; },
    sendBinary: (bytes) => { if (socket.readyState !== WebSocket.OPEN) return false; socket.send(bytes.slice()); return true; },
    close: (code, reason) => { ended = true; socket.close(code >= 3000 || code === 1000 ? code : 1000, reason); },
  };
}
