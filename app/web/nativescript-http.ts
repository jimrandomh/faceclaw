/** @nativescript/core/http over fetch: only what binary-http and fetchTextWithUserAgent's callers use. */
export type HttpRequestOptions = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  content?: string | ArrayBuffer | Uint8Array | null;
  timeout?: number;
  dontFollowRedirects?: boolean;
};

export async function request(options: HttpRequestOptions) {
  const controller = new AbortController();
  const timer = options.timeout ? setTimeout(() => controller.abort(), options.timeout) : null;
  try {
    const response = await fetch(options.url, {
      method: options.method ?? "GET",
      headers: withoutUserAgent(options.headers),
      body: (options.content ?? undefined) as BodyInit | undefined,
      redirect: options.dontFollowRedirects ? "manual" : "follow",
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    return {
      statusCode: response.status,
      headers,
      content: {
        raw: body,
        toArrayBuffer: () => body,
        toString: () => new TextDecoder().decode(body),
        toJSON: () => JSON.parse(new TextDecoder().decode(body)),
      },
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** A custom User-Agent makes some browsers preflight, which most APIs refuse. */
function withoutUserAgent(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== "user-agent") result[name] = value;
  }
  return result;
}
