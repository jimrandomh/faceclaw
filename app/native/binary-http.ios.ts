import { Http } from '@nativescript/core';
import { withUserAgent } from '../util/http';
import type { BinaryPostResponse, BinaryResponse } from './binary-http';

/**
 * Bulk NSData -> ArrayBuffer; bypass fetch's Blob/FileReader copies.
 *
 * toArrayBuffer() is interop.bufferFromData, which in @nativescript/ios 9.0.3
 * views the NSData's bytes without retaining it: once the response is
 * collected, the buffer is dangling (a store EHPK was saved as 41 MB of
 * zeros). Copy while the response is still alive.
 */
export async function downloadBinary(url: string, timeoutMs: number): Promise<BinaryResponse> {
  const response = await Http.request({ url, method: 'GET', headers: withUserAgent(), timeout: timeoutMs });
  const length = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
  return { status: response.statusCode, bytes: new Uint8Array(response.content.toArrayBuffer()).slice(), contentLength: Number(length ?? 0) };
}

/** POST a binary body and read the response as text; NativeScript hands an ArrayBuffer to NSURLRequest as one NSData. */
export async function postBinary(url: string, body: ArrayBuffer, headers: Record<string, string>, timeoutMs: number): Promise<BinaryPostResponse> {
  const response = await Http.request({ url, method: 'POST', headers: withUserAgent(headers), content: body, timeout: timeoutMs });
  return { status: response.statusCode, text: response.content ? String(response.content.toString()) : '' };
}
