export type BinaryResponse = { status: number; bytes: Uint8Array; contentLength: number };
export type BinaryPostResponse = { status: number; text: string };

export async function downloadBinary(url: string, timeoutMs: number): Promise<BinaryResponse> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, bytes, contentLength: Number(response.headers.get("content-length") ?? 0) };
}

export async function postBinary(url: string, body: ArrayBuffer, headers: Record<string, string>, timeoutMs: number): Promise<BinaryPostResponse> {
  const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, text: await response.text() };
}
