export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const MAX_BODY_BYTES = 4096;

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/**
 * Small JSON bodies only; anything else is a client error, never a crash. The body is streamed and abandoned at the
 * cap, so a client that omits or lies about Content-Length can't make the Worker buffer a large upload.
 */
export async function readJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");

  const chunks: Uint8Array[] = [];
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "body_too_large");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Discord snowflakes: 17-20 digits. */
export const isSnowflake = (value: unknown): value is string => typeof value === "string" && /^\d{17,20}$/.test(value);
