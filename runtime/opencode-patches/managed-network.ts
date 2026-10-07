import { Cause, Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"
import { makeToolOutcome, readToolError } from "./scikeel-outcome.mjs"

const BROKER = "http://172.31.240.1:4792"
const PROXY = "http://172.31.240.1:4794"
type Call = { sessionID: string; callID?: string; toolCallID?: string; abort?: AbortSignal }
const transientCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"])
export const isManaged = () => process.env.SCIKEEL_MANAGED_NETWORK_TOKEN !== undefined
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : NaN
  const date = Number.isFinite(seconds) ? seconds : Date.parse(value) - now
  if (!Number.isFinite(date)) return
  return Math.min(10000, Math.max(0, date))
}
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted()
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
  signal.addEventListener("abort", abort, { once: true })
})
async function boundedBody(response: Response, maximum: number, signal: AbortSignal) {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  const abort = () => { void reader?.cancel() }
  signal.addEventListener("abort", abort, { once: true })
  try {
    if (reader) for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximum) throw new Error("Response too large")
      chunks.push(value)
    }
    const result = new Uint8Array(bytes); let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  } finally { signal.removeEventListener("abort", abort); await reader?.cancel().catch(() => {}); reader?.releaseLock() }
}
export function managedClient(unmanaged: HttpClient.HttpClient, call: Call, tool: "webfetch" | "websearch", redirect: (url: string) => Effect.Effect<void, unknown>) {
  if (!isManaged()) return unmanaged
  return HttpClient.make((request, url, signal) => Effect.gen(function* () {
    const services = yield* Effect.context<never>()
    const response = yield* Effect.tryPromise({
      try: async () => {
        const token = process.env.SCIKEEL_MANAGED_NETWORK_TOKEN
        const callId = call.callID ?? call.toolCallID
        if (!token || !/^[a-f0-9]{64}$/.test(token) || !callId) throw new Error("Managed network configuration unavailable")
        let operation: { operationId: string; grant: string; expiresAt: number } | undefined
        let terminal: ReturnType<typeof makeToolOutcome> | undefined
        const bridge = async (path: string, body: object, abort: AbortSignal) => {
          const response = await fetch(BROKER + path, { method: "POST", proxy: "", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: abort })
          const bytes = await boundedBody(response, 8192, abort)
          const text = new TextDecoder().decode(bytes)
          if (!response.ok) { const outcome = readToolError(text); throw new Error(outcome ? JSON.stringify({ error: outcome }) : "Managed network unavailable") }
          return JSON.parse(text)
        }
        const lifetime = AbortSignal.any([signal, ...(call.abort ? [call.abort] : [])])
        let current = url, method = request.method
        const eligible = method === "GET" || method === "HEAD" || tool === "websearch" && method === "POST" && ["https://mcp.exa.ai", "https://search.parallel.ai"].includes(url.origin)
        const body = request.body._tag === "Uint8Array" ? Uint8Array.from(request.body.body).buffer : request.body._tag === "Raw" ? request.body.body as BodyInit : undefined
        if (!["Empty", "Uint8Array", "Raw"].includes(request.body._tag)) throw new Error("Unsupported managed network body")
        try {
          const state = await bridge("/collaboration", { sessionId: call.sessionID, action: "state" }, AbortSignal.any([lifetime, AbortSignal.timeout(5000)]))
          const proposal = { version: 1, action: "authorize", sessionId: call.sessionID, callId, tool, execution: state.state.execution }
          const validate = (value: typeof operation) => {
            if (!value || !/^op_[A-Za-z0-9_-]+$/.test(value.operationId) || !/^[a-f0-9]{64}$/.test(value.grant) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 120000) throw new Error("Invalid network authorization")
            return value
          }
          operation = validate(await bridge("/network", { ...proposal, origins: [current.origin] }, AbortSignal.any([lifetime, AbortSignal.timeout(5000)])))
          let deadline = operation.expiresAt
          let active = AbortSignal.any([lifetime, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
          let redirects = 0, attempts = 0
          for (;;) {
            active.throwIfAborted()
            try {
              const result = await fetch(current, { method, headers: request.headers, body: method === "GET" || method === "HEAD" ? undefined : body,
                redirect: "manual", proxy: { url: PROXY, headers: { "Proxy-Authorization": `Bearer ${operation.grant}` } }, signal: active })
              if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.has("location")) {
                const next = new URL(result.headers.get("location")!, current); await result.body?.cancel()
                if (++redirects > 5 || !["http:", "https:"].includes(next.protocol) || next.username || next.password || next.port) throw new Error("Redirect destination denied")
                if (next.origin !== current.origin) {
                  await Effect.runPromise(redirect(next.href).pipe(
                    Effect.tapCause(cause => Effect.sync(() => {
                      const error = Cause.squash(cause)
                      if (["PermissionRejectedError", "PermissionCorrectedError", "PermissionDeniedError"].includes((error as { _tag?: string })?._tag ?? ""))
                        terminal = makeToolOutcome("tool_permission_denied", { source: "runtime", status: 403, correlationId: callId })
                    })), Effect.provide(services)), { signal: active })
                  operation = validate(await bridge("/network", { ...proposal, operationId: operation.operationId, origins: [next.origin] }, active))
                  if (operation.expiresAt > deadline) throw new Error("Network deadline changed")
                  deadline = operation.expiresAt
                  active = AbortSignal.any([lifetime, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
                }
                if (result.status === 303) method = "GET"
                current = next; continue
              }
              const bytes = await boundedBody(result, tool === "webfetch" ? 5 * 1024 ** 2 : 2 * 1024 ** 2, active)
              if (eligible && [429, 502, 503, 504].includes(result.status) && attempts < 2) {
                const delay = retryAfter(result.headers.get("retry-after")) ?? (attempts + 1) * 1000
                if (delay < deadline - Date.now()) { attempts++; await wait(delay, active); continue }
              }
              if (!result.ok) terminal = makeToolOutcome("network_upstream_refused", { source: "upstream", status: result.status, correlationId: callId, details: { attempts: attempts + 1 } })
              // Buffered under the same deadline; parsers receive exactly the bounded original bytes.
              return new Response(bytes, { status: result.status, statusText: result.statusText, headers: result.headers })
            } catch (error) {
              active.throwIfAborted()
              const failure = error as { code?: string }
              if (!eligible || !transientCodes.has(failure.code ?? "") || attempts >= 2) throw error
              const delay = (attempts + 1) * 1000
              if (delay >= deadline - Date.now()) throw error
              attempts++; await wait(delay, active)
            }
          }
        } catch (error) {
          const observed = readToolError((error as Error)?.message)
          if (!observed && !terminal) terminal = makeToolOutcome(operation && Date.now() >= operation.expiresAt ? "network_timeout" : "tool_internal_error", { source: "runtime", status: 502, correlationId: callId })
          throw new Error(JSON.stringify({ error: observed ?? terminal }))
        } finally {
          if (operation) {
            await bridge("/network", { version: 1, action: lifetime.aborted ? "cancel" : "complete", operationId: operation.operationId, ...(terminal ? { outcome: terminal } : {}) }, AbortSignal.timeout(2000)).catch(() => {})
          }
        }
      },
      catch: cause => new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause }) }),
    })
    return HttpClientResponse.fromWeb(request, response)
  }))
}
