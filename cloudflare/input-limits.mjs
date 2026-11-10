// SPDX-License-Identifier: GPL-3.0-or-later
export const MAX_REQUEST_BODY_BYTES = 64 * 1024
export const MAX_STORED_SOURCE_PAYLOAD_BYTES = 16 * 1024
export const ANONYMOUS_ADMISSIONS_PER_DAY = 32

export class SourceLimitError extends Error {}

export function assertSourcePayloadSize(payload) {
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_STORED_SOURCE_PAYLOAD_BYTES) {
    throw new SourceLimitError(`Source payload exceeds the ${MAX_STORED_SOURCE_PAYLOAD_BYTES / 1024} KiB storage limit, including encryption overhead.`)
  }
}

export async function boundedRequest(request) {
  const oversized = () => Response.json(
    { error: "payload_too_large", detail: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES / 1024} KiB limit.` },
    { status: 413, headers: { "cache-control": "private, no-store" } },
  )
  if (!request.body) return request
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BODY_BYTES) {
    void request.body.cancel().catch(() => {})
    return oversized()
  }
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REQUEST_BODY_BYTES) {
        void reader.cancel().catch(() => {})
        return oversized()
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new Request(request, { body, duplex: "half" })
}
