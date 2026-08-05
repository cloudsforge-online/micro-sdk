/**
 * The outbound HTTP path. Every request the SDK makes goes through `Transport.call`.
 *
 * Its behaviour is modelled on `runtime/packages/http` — the estate's own client — because a third
 * party's client should fail the same way ours does, and because the two rules that file states
 * are the two most expensive ones to get wrong:
 *
 *   1. **Only idempotent requests are retried.** A POST is retried ONLY when it carries an
 *      idempotency key. Retrying a POST that debits a wallet is how a user gets charged twice.
 *   2. **A deadline is absolute, not per-attempt.** Retries spend the same budget as the first
 *      attempt, so `deadlineMs` is a real ceiling on wall-clock time rather than a per-hop one
 *      that a three-hop call multiplies by three.
 *
 * And a third that `HttpError.peerDecided` (`runtime/packages/http/src/index.ts:49`) encodes:
 * **a 4xx is never retried.** The peer decided; asking again produces the same answer and spends
 * the budget the caller might have wanted for something that could succeed. The exceptions are the
 * four 4xx codes that mean "later", not "no" — 408, 425, 429 and, with a `Retry-After`, nothing
 * else.
 *
 * ## Two deliberate differences from the internal client
 *
 * - **No circuit breaker.** A breaker is right for a service making thousands of calls a second to
 *   a peer on the same network; it is wrong for a library embedded in somebody else's process,
 *   where a per-instance breaker opened by one bad minute would silently fail requests a user is
 *   watching, and the caller has no dashboard to see it on. Bounded retries and a hard deadline do
 *   the same job without a hidden state machine.
 * - **`redirect: 'error'` rather than `'manual'`.** A public API that answers a redirect is a
 *   misconfiguration, and following one would re-send the `Authorization` header to whatever host
 *   the `Location` names. That is a credential-exfiltration primitive reachable by anyone who can
 *   answer a request.
 */

import {
  ApiError,
  AuthError,
  TimeoutError,
  TransportError,
  UsageError,
  parseErrorBody,
} from './errors.ts'
import { anonymous, type Credential } from './credentials.ts'
import { assertValidKey, deriveKey } from './idempotency.ts'
import { fillPath, type RouteSpec } from './routes.ts'

/** Statuses worth another attempt. Everything else in the 4xx range is the peer deciding. */
const RETRIABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504])

/** Methods that are idempotent by definition, and are therefore retriable without a key. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])

export interface RequestEvent {
  readonly route: string
  readonly method: string
  readonly path: string
  readonly status: number | null
  readonly attempt: number
  readonly durationMs: number
  readonly outcome: 'ok' | 'peer_error' | 'server_error' | 'timeout' | 'transport_error'
  readonly requestId: string | undefined
}

export interface TransportOptions {
  /** The public API origin. `https://api.cloudsforge.online` in production. */
  readonly baseUrl: string
  readonly credential?: Credential
  /**
   * Prefixed to every route path.
   *
   * Exists because the gateway mapping for the public API is NOT yet defined — see the README.
   * Services own the paths in `routes.ts`; if the gateway ever mounts them under a prefix, this is
   * the one place that changes, and it changes without an SDK release.
   */
  readonly pathPrefix?: string
  /** Absolute wall-clock ceiling across all attempts. */
  readonly deadlineMs?: number
  /** Retries AFTER the first attempt. 2 means at most three attempts. */
  readonly retries?: number
  /** Sent on every request. `authorization` is not settable here — use a credential. */
  readonly headers?: Readonly<Record<string, string>>
  /** Appended to the SDK's own `user-agent`, so an operator can see whose integration is calling. */
  readonly userAgent?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** Deterministic jitter for tests. Returns 0..1. */
  readonly random?: () => number
  /** Called once per attempt, success or failure. For a caller's own logging. */
  readonly onRequest?: (event: RequestEvent) => void
}

export interface CallOptions {
  readonly params?: Readonly<Record<string, string>>
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  readonly body?: unknown
  readonly deadlineMs?: number
  readonly retries?: number
  readonly signal?: AbortSignal
  /**
   * Overrides the derived key on a route whose service requires one.
   *
   * Pass this when two operations legitimately have identical bodies — two separate transfers of
   * the same amount to the same person, which the derived key would otherwise collapse into one.
   */
  readonly idempotencyKey?: string
  /** W3C trace context, forwarded verbatim so a caller's trace joins ours. */
  readonly traceparent?: string
}

/** Read from package.json at build time is not possible in a .ts source; kept in step by a test. */
export const SDK_VERSION = '0.2.0'

export class Transport {
  readonly #baseUrl: string
  readonly #prefix: string
  readonly #credential: Credential
  readonly #deadlineMs: number
  readonly #retries: number
  readonly #headers: Readonly<Record<string, string>>
  readonly #userAgent: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #random: () => number
  readonly #onRequest: ((event: RequestEvent) => void) | undefined

  constructor(options: TransportOptions) {
    if (!/^https?:\/\//i.test(options.baseUrl)) {
      throw new UsageError(`baseUrl must be an http(s) URL (got ${JSON.stringify(options.baseUrl)})`)
    }
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#prefix = (options.pathPrefix ?? '').replace(/\/+$/, '')
    this.#credential = options.credential ?? anonymous()
    this.#deadlineMs = options.deadlineMs ?? 15_000
    this.#retries = options.retries ?? 2
    if (this.#deadlineMs <= 0) throw new UsageError('deadlineMs must be positive')
    if (this.#retries < 0) throw new UsageError('retries must not be negative')

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const lower = name.toLowerCase()
      // A header here would shadow the credential silently, and a caller who set it would think
      // the credential was in use when it was not.
      if (lower === 'authorization') {
        throw new UsageError('set authorization with a credential, not with a default header')
      }
      headers[lower] = value
    }
    this.#headers = Object.freeze(headers)
    this.#userAgent = options.userAgent
      ? `cloudsforge-sdk/${SDK_VERSION} ${options.userAgent}`
      : `cloudsforge-sdk/${SDK_VERSION}`
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? (() => Date.now())
    this.#sleep = options.sleep ?? defaultSleep
    this.#random = options.random ?? Math.random
    this.#onRequest = options.onRequest
  }

  /**
   * Perform one route.
   *
   * The generic is the caller's claim about the response shape, not a validated one. The SDK does
   * not schema-check responses: the public API is additive-only by policy
   * (`docs/ecosystem/11-data-and-contract-strategy.md:307`), and a client that rejected an
   * unrecognised field would turn every additive change into an outage for anyone who had not
   * upgraded. Unknown fields pass through.
   */
  async call<T>(name: string, route: RouteSpec, options: CallOptions = {}): Promise<T> {
    const path = this.#prefix + fillPath(route.path, options.params)
    const url = this.#buildUrl(path, options.query)
    const deadlineMs = options.deadlineMs ?? this.#deadlineMs
    const expiresAt = this.#now() + deadlineMs

    const idempotencyKey = this.#idempotencyKeyFor(name, route, options)
    const retriable = IDEMPOTENT_METHODS.has(route.method) || idempotencyKey !== undefined
    const maxAttempts = retriable ? 1 + (options.retries ?? this.#retries) : 1

    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remaining = expiresAt - this.#now()
      if (remaining <= 0) break

      const startedAt = this.#now()
      try {
        const result = await this.#attempt<T>(url, path, route, options, idempotencyKey, remaining)
        this.#emit({
          route: name,
          method: route.method,
          path,
          status: result.status,
          attempt,
          durationMs: this.#now() - startedAt,
          outcome: 'ok',
          requestId: result.requestId,
        })
        return result.value
      } catch (err) {
        lastError = err
        this.#emit({
          route: name,
          method: route.method,
          path,
          status: err instanceof ApiError ? err.status : null,
          attempt,
          durationMs: this.#now() - startedAt,
          outcome: classify(err),
          requestId: err instanceof ApiError ? err.requestId : undefined,
        })

        // The peer decided. Asking again gets the same answer.
        if (err instanceof ApiError && err.peerDecided && !RETRIABLE_STATUS.has(err.status)) throw err
        // A usage or auth fault is ours, not the network's, and no amount of retrying fixes it.
        if (err instanceof UsageError || err instanceof AuthError) throw err
        // The caller gave up. Not our business to keep trying on their behalf.
        if (options.signal?.aborted) throw err
        if (attempt === maxAttempts) break

        const backoff = this.#backoff(attempt, err)
        if (this.#now() + backoff >= expiresAt) break
        await this.#sleep(backoff)
      }
    }
    throw lastError ?? new TimeoutError(route.method, path, deadlineMs)
  }

  /**
   * Whether a route's service will refuse the request without an `Idempotency-Key`, and what key
   * to send.
   *
   * A key is sent on every mutating route, not only the ones that demand it: a key the service
   * ignores costs a header, and a key the service wanted and did not get costs a 400 — or worse,
   * on a route that accepts a missing one, a duplicate operation.
   */
  #idempotencyKeyFor(name: string, route: RouteSpec, options: CallOptions): string | undefined {
    if (options.idempotencyKey !== undefined) {
      if (IDEMPOTENT_METHODS.has(route.method) && route.idempotency === 'none') {
        throw new UsageError(`${name} is a ${route.method}; it takes no idempotency key`)
      }
      assertValidKey(options.idempotencyKey)
      return options.idempotencyKey
    }
    if (route.method !== 'POST') return undefined
    // Derived from the route and the body, so every attempt at one operation carries one key —
    // and so `correlationId`-shaped fields cannot make a retry look like a new operation.
    return deriveKey(name, options.body ?? {})
  }

  async #attempt<T>(
    url: string,
    path: string,
    route: RouteSpec,
    options: CallOptions,
    idempotencyKey: string | undefined,
    remainingMs: number,
  ): Promise<{ value: T; status: number; requestId: string | undefined }> {
    // `AbortSignal.any` rather than a manual listener: a caller signal that is ALREADY aborted when
    // the attempt begins must still abort the request, and a listener registered on an aborted
    // signal never fires. That left the request hanging until its own deadline in the internal
    // client, which is the bug its comment at index.ts:300 records.
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)))
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted')

    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.#userAgent,
      ...this.#headers,
    }
    if (route.auth !== 'none') {
      const token = await this.#credential.token({ signal })
      if (token) headers['authorization'] = `Bearer ${token}`
    }
    if (options.traceparent) headers['traceparent'] = options.traceparent
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    // Tells the peer how long it has, so it can fail fast rather than finish work nobody will read.
    headers['x-deadline-ms'] = String(Math.max(0, Math.floor(remainingMs)))

    let payload: string | undefined
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }

    let response: Response
    try {
      response = await this.#fetch(url, {
        method: route.method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal,
        redirect: 'error',
      })
    } catch (err) {
      if (timeoutSignal.aborted && !options.signal?.aborted) {
        throw new TimeoutError(route.method, path, remainingMs)
      }
      if (options.signal?.aborted) throw err
      throw new TransportError(route.method, path, err)
    }

    const text = await response.text()
    const headerRequestId = response.headers.get('x-request-id') ?? undefined

    if (!response.ok) {
      const parsed = parseErrorBody(text)
      throw new ApiError({
        status: response.status,
        code: parsed.code,
        message: parsed.message,
        method: route.method,
        path,
        body: text.slice(0, 2_000),
        // The body first: the service puts it there deliberately, and a gateway can strip or
        // rewrite a header on the way out while leaving the body alone.
        requestId: parsed.requestId ?? headerRequestId,
        retryAfterMs: retryAfterMsOf(response.headers.get('retry-after')),
      })
    }

    if (response.status === 204 || text.length === 0) {
      return { value: undefined as T, status: response.status, requestId: headerRequestId }
    }
    try {
      return { value: JSON.parse(text) as T, status: response.status, requestId: headerRequestId }
    } catch {
      throw new ApiError({
        status: response.status,
        code: 'bad_response',
        message: `expected JSON, got ${text.slice(0, 200)}`,
        method: route.method,
        path,
        body: text.slice(0, 2_000),
        requestId: headerRequestId,
      })
    }
  }

  /**
   * Exponential with full jitter: 200ms, 400ms, 800ms … each randomised across [0, cap].
   *
   * Full jitter rather than a fixed schedule because every client retrying at the same offsets is
   * a thundering herd aimed at a peer that is already unwell. A `Retry-After` overrides it: the
   * peer knows better than the formula.
   */
  #backoff(attempt: number, err: unknown): number {
    if (err instanceof ApiError && err.retryAfterMs !== undefined) {
      return Math.min(err.retryAfterMs, 30_000)
    }
    const cap = Math.min(200 * 2 ** (attempt - 1), 4_000)
    return Math.floor(cap * this.#random())
  }

  #buildUrl(path: string, query: CallOptions['query']): string {
    const url = new URL(this.#baseUrl + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  #emit(event: RequestEvent): void {
    this.#onRequest?.(event)
  }
}

function classify(err: unknown): RequestEvent['outcome'] {
  if (err instanceof TimeoutError) return 'timeout'
  if (err instanceof ApiError) return err.peerDecided ? 'peer_error' : 'server_error'
  return 'transport_error'
}

/** RFC 9110 §10.2.3: delay-seconds or an HTTP-date. Both are in use in the wild. */
function retryAfterMsOf(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}

/**
 * The backoff between attempts. **The timer is deliberately NOT unref'd.**
 *
 * `runtime/packages/http` unrefs its equivalent, and that is right there: it runs inside a server
 * process that always has an open listener keeping the loop alive, so an unref'd timer costs
 * nothing and stops a lingering retry holding a shutdown open.
 *
 * Here the opposite is true. This library runs inside somebody else's process — a CLI invocation, a
 * serverless handler, a script — and an unref'd timer is not a handle the runtime waits for. With
 * nothing else pending, the loop drains during the backoff, the retry never fires, and the promise
 * the caller is awaiting simply never settles. Node reports it as "Promise resolution is still
 * pending but the event loop has already resolved"; a user reports it as "it exits and prints
 * nothing, but only sometimes". Caught by CI on a loaded runner, where the timing that hides it
 * locally does not hold.
 *
 * A retry in flight is work the process must stay alive for. `deadlineMs` is what bounds it.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
