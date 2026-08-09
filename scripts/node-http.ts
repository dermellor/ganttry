// Node's `http` types on one side, Fetch on the other.
//
// Two Node runtimes speak to the shared HTTP layer (`scripts/db/http.ts`): the
// Vite dev middleware and the self-hosted server (`scripts/serve.ts`). Both need
// the same translation, so it lives here rather than twice.
//
// Node-only by design — it imports `node:http` types and must never end up in
// the Deno edge bundle, which speaks Fetch natively and needs no adapter.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** `IncomingMessage` → Fetch `Request`, body included for the methods that have one. */
export async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  // The host header is what makes an absolute URL; `new URL` needs one, and the
  // handler only ever reads the path and the query from it.
  const base = `http://${req.headers.host ?? 'localhost'}`;
  return new Request(new URL(req.url ?? '/', base), {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

/** Write a Fetch `Response` back onto a Node `ServerResponse`. */
export async function writeResponse(res: ServerResponse, out: Response): Promise<void> {
  const body = Buffer.from(await out.arrayBuffer());
  const headers: Record<string, string> = {};
  out.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // Set explicitly: the body was buffered, so the length is known, and leaving
  // it to chunked encoding would hide a truncated write.
  headers['Content-Length'] = String(body.byteLength);
  res.writeHead(out.status, headers);
  res.end(body);
}
