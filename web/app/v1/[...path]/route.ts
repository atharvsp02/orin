import type { NextRequest } from "next/server"

export const dynamic = "force-dynamic"

const MAX_BODY_BYTES = 3 * 1024 * 1024
const API_ORIGIN = new URL(process.env.ORIN_API_ORIGIN ?? "https://bot-production-b076.up.railway.app")
const REQUEST_HEADERS = ["accept", "content-type", "cookie", "origin", "referer", "user-agent", "x-request-id"]
const RESPONSE_HEADERS = [
  "cache-control",
  "content-security-policy",
  "content-disposition",
  "content-type",
  "location",
  "retry-after",
  "vary",
  "www-authenticate",
  "x-ratelimit-remaining",
  "x-content-type-options",
  "x-frame-options",
]

if (!["http:", "https:"].includes(API_ORIGIN.protocol)) throw new Error("ORIN_API_ORIGIN must use HTTP or HTTPS")

async function boundedBody(request: NextRequest): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return undefined
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RangeError("request body is too large")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new RangeError("request body is too large")
    }
    chunks.push(value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params
  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/")
  const target = new URL(`/v1/${encodedPath}${request.nextUrl.search}`, API_ORIGIN)
  const headers = new Headers()
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set("x-forwarded-host", request.headers.get("host") ?? request.nextUrl.host)
  headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""))
  let body: ArrayBuffer | undefined
  try {
    body = await boundedBody(request)
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ error: error.message }, { status: 413 })
    throw error
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  })
  const responseHeaders = new Headers()
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append("set-cookie", cookie)
  responseHeaders.set("cache-control", "private, no-store, max-age=0")
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
export const OPTIONS = proxy
