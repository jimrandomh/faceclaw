declare const com: any;
declare const java: any;

export type BinaryResponse = { status: number; bytes: Uint8Array; contentLength: number };
export type BinaryPostResponse = { status: number; text: string };

let nextDownloadSerial = 0;

/**
 * GET a binary body. Not fetch(): NativeScript's polyfill copies the Java
 * byte[] into JS one bridge call per byte (http-request's toArrayBuffer), which
 * for a 43MB EvenHub package pinned the main thread for ~20s and then ran the
 * process out of native memory. FaceclawFileDownload streams the body to a
 * cache file instead, and readBinaryFile copies it back in bulk.
 */
export function downloadBinary(url: string, timeoutMs: number): Promise<BinaryResponse> {
  // Required lazily so Node tests can load this module's importers.
  const { appCacheDirPath, readBinaryFile } = require("./file-access") as typeof import("./file-access");
  const path = `${appCacheDirPath()}/binary-download-${Date.now()}-${nextDownloadSerial++}`;
  const remove = () => { try { new java.io.File(path).delete(); } catch { /* best effort */ } };
  return new Promise((resolve, reject) => {
    const listener = new com.faceclaw.app.FaceclawFileDownloadListener({
      onDone: (status: number, contentLength: number) => {
        try {
          const ok = status >= 200 && status < 300;
          const bytes = ok ? readBinaryFile(path) : new Uint8Array(0);
          if (!bytes) reject(new Error("Could not read the downloaded file."));
          else resolve({ status, bytes, contentLength: Math.max(0, Number(contentLength)) });
        } finally { remove(); }
      },
      onFailure: (message: string) => {
        remove();
        reject(new Error(/timeout|timed out/i.test(String(message)) ? "Download timed out." : `Download failed: ${message}`));
      },
    });
    new com.faceclaw.app.FaceclawFileDownload(url, path, timeoutMs, listener).start();
  });
}

/**
 * POST a binary body and read the response as text. Not NativeScript's http
 * module: it hands an ArrayBuffer body to Java one bridge call per byte
 * (ByteBuffer.wrap(Array.from(...))), which for a ~1MB WAV upload stalls the
 * main thread. FaceclawBinaryPost takes it as one direct-buffer copy instead.
 */
export function postBinary(url: string, body: ArrayBuffer, headers: Record<string, string>, timeoutMs: number): Promise<BinaryPostResponse> {
  // Required lazily so Node tests can load this module's importers.
  const { copyToJavaByteBuffer } = require("./java-direct-buffer") as typeof import("./java-direct-buffer");
  const entries = Object.entries(headers);
  const nativeHeaders = Array.create("java.lang.String", entries.length * 2);
  entries.forEach(([name, value], index) => { nativeHeaders[index * 2] = name; nativeHeaders[index * 2 + 1] = value; });
  return new Promise((resolve, reject) => {
    const listener = new com.faceclaw.app.FaceclawBinaryPostListener({
      onResponse: (status: number, text: string | null) => resolve({ status, text: String(text ?? "") }),
      onFailure: (message: string | null) => reject(new Error(String(message ?? "Request failed."))),
    });
    // The User-Agent comes from the okhttp client's interceptor.
    new com.faceclaw.app.FaceclawBinaryPost(url, copyToJavaByteBuffer(new Uint8Array(body)), nativeHeaders, timeoutMs, listener).start();
  });
}
