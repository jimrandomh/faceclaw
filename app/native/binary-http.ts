import { fetchWithUserAgent } from '../util/http';
export type BinaryResponse = { status: number; bytes: Uint8Array; contentLength: number };
export async function downloadBinary(url: string, timeoutMs: number): Promise<BinaryResponse> {
  let timer: ReturnType<typeof setTimeout>;
  const request = async () => {
    const response = await fetchWithUserAgent(url);
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()),
      contentLength: Number(response.headers.get('Content-Length') ?? 0) };
  };
  try {
    return await Promise.race([request(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Download timed out.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer!); }
}
