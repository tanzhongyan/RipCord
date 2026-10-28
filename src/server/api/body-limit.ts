export const MAX_BODY_BYTES = 1_000_000;

/**
 * Buffer the request body up to `maxBytes`. Returns a request with the buffered body, or null
 * when the body is larger. Checks Content-Length first, then counts streamed bytes.
 */
export async function limitBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Request | null> {
  if (!req.body) return req;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Request(req, { body: new Blob(chunks as BlobPart[]) });
}
